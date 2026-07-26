import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import {
    d, readWallet, readLive, buildAndShip, dock, resetMakerNonce, loadShippedFromChain,
    feeFromPercent, percentFromFee, fmtWeth, fmtUsdc, shortHash, KIND_LABEL, friendlyError,
    freeWallet, assertFitsWallet, usdcForWethAtSpot, wethForUsdcAtSpot,
    tradeAgainst, fetchForkSpot, readTakerWallet, resetTakerNonce,
    hasInjectedWallet, connectWallet, seedConnectedWallet, session,
    type DraftStrategy, type LiveStrategy, type StrategyKind, type Wallet, type TradeSide,
} from "./lib/lp-desk";
import { fetchWethUsdcSpot } from "./lib/uniswap-price";
import {
    basisFromLive, dropBasis, loadPersistedBases, persistBases, reconcileBases,
    fetchPositionHistory, postPositionTick, sumHold, sumPosition,
    type PositionBasisLive, type PositionHistoryTick,
} from "./lib/pnl";
import PnlChart from "./PnlChart";
import { Mark, TabNav, type ViewId } from "./nav";
import { ConnectButton } from "thirdweb/react";
import { base } from "thirdweb/chains";
import { thirdwebClient, thirdwebWallets } from "./lib/thirdweb";

type FormState = {
    kind: StrategyKind;
    weth: string;
    usdc: string;
    feePercent: string;
    priceMin: string;
    priceMax: string;
    linearWidthA: string;
};

const DEFAULT_FORM: FormState = {
    kind: "xyc",
    weth: "0.25",
    usdc: "0", // filled from spot once known
    feePercent: "0.3",
    priceMin: "",
    priceMax: "",
    linearWidthA: "0.8",
};

function parseDraft(form: FormState, id: string): DraftStrategy {
    const promisedWeth = ethers.parseEther(form.weth || "0");
    const promisedUsdc = ethers.parseUnits(form.usdc || "0", 6);
    if (promisedWeth <= 0n || promisedUsdc <= 0n) {
        throw new Error("Amounts must be greater than zero");
    }
    const feeBpsIn = feeFromPercent(Number(form.feePercent));
    const draft: DraftStrategy = {
        id,
        kind: form.kind,
        promisedWeth,
        promisedUsdc,
        feeBpsIn,
    };
    if (form.kind === "concentrate") {
        draft.priceMinUsdc = Number(form.priceMin);
        draft.priceMaxUsdc = Number(form.priceMax);
        if (!(draft.priceMinUsdc! > 0) || !(draft.priceMaxUsdc! > draft.priceMinUsdc!)) {
            throw new Error("Concentrate needs 0 < min USDC/WETH < max");
        }
    }
    if (form.kind === "pegged") {
        draft.linearWidthA = Number(form.linearWidthA);
        if (!(draft.linearWidthA! >= 0)) throw new Error("Pegged A must be ≥ 0");
    }
    return draft;
}

export default function LpDesk({ view, onViewChange }: { view: ViewId; onViewChange: (v: ViewId) => void }) {
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [form, setForm] = useState<FormState>(DEFAULT_FORM);
    const [ratioLocked, setRatioLocked] = useState(true);
    const [drafts, setDrafts] = useState<DraftStrategy[]>([]);
    const [live, setLive] = useState<LiveStrategy[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [bases, setBases] = useState<PositionBasisLive[]>([]);
    const [ticks, setTicks] = useState<PositionHistoryTick[]>([]);
    const [spot, setSpot] = useState<number | null>(null);
    const spotRef = useRef<number | null>(null);
    const [forkSpot, setForkSpot] = useState<number | null>(null);
    const [priceError, setPriceError] = useState<string | null>(null);
    const [loadingChain, setLoadingChain] = useState(true);
    const [takerWallet, setTakerWallet] = useState<Wallet | null>(null);
    const [tradeHash, setTradeHash] = useState<string>("");
    const [tradeSide, setTradeSide] = useState<TradeSide>("buyWeth");
    const [tradeAmount, setTradeAmount] = useState("100");
    const [confirmDockHash, setConfirmDockHash] = useState<string | null>(null);
    const [account, setAccount] = useState<string | null>(
        () => (session.mode === "wallet" ? session.maker : null),
    );
    const seededFormRef = useRef(false);
    const confirmDockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (confirmDockTimerRef.current) clearTimeout(confirmDockTimerRef.current);
        };
    }, []);

    const refreshWallet = useCallback(async () => {
        const [maker, taker] = await Promise.all([readWallet(), readTakerWallet()]);
        setWallet(maker);
        setTakerWallet(taker);
    }, []);

    const liveRef = useRef(live);
    liveRef.current = live;
    const basesRef = useRef(bases);
    basesRef.current = bases;

    const refreshHistory = useCallback(async () => {
        const next = await fetchPositionHistory();
        setTicks((prev) => {
            if (prev.length === next.length
                && prev[0]?.at === next[0]?.at
                && prev[prev.length - 1]?.at === next[next.length - 1]?.at
                && prev[prev.length - 1]?.wethLeft === next[next.length - 1]?.wethLeft
                && prev[prev.length - 1]?.usdcLeft === next[next.length - 1]?.usdcLeft
                && prev[prev.length - 1]?.usdcPerWeth === next[next.length - 1]?.usdcPerWeth) {
                return prev;
            }
            return next;
        });
        return next;
    }, []);

    const recordPositionTick = useCallback(async (
        strategies?: LiveStrategy[],
        basesNow?: PositionBasisLive[],
        usdcPerWeth?: number | null,
    ) => {
        const liveNow = strategies ?? liveRef.current;
        const basesUse = basesNow ?? basesRef.current;
        const px = usdcPerWeth ?? spotRef.current;
        if (liveNow.length === 0 || px == null || !(px > 0)) return false;
        const pos = sumPosition(liveNow);
        const hold = sumHold(basesUse);
        const ok = await postPositionTick({
            usdcPerWeth: px,
            wethLeft: pos.weth,
            usdcLeft: pos.usdc,
            holdWeth: hold.weth,
            holdUsdc: hold.usdc,
            strategyCount: liveNow.length,
        });
        if (ok) await refreshHistory();
        return ok;
    }, [refreshHistory]);

    const refreshLive = useCallback(async () => {
        const current = liveRef.current;
        if (current.length === 0) return;
        const next = await Promise.all(current.map((s) => readLive(s)));
        setLive(next);
        liveRef.current = next;
        return next;
    }, []);

    const refreshForkSpot = useCallback(async (strategies?: LiveStrategy[]) => {
        const liveNow = strategies ?? liveRef.current;
        if (liveNow.length === 0) {
            setForkSpot(null);
            return null;
        }
        try {
            const f = await fetchForkSpot(liveNow);
            setForkSpot(f.usdcPerWeth);
            return f;
        } catch {
            setForkSpot(null);
            return null;
        }
    }, []);

    const refreshSpot = useCallback(async (strategies?: LiveStrategy[]) => {
        const liveNow = strategies ?? liveRef.current;
        try {
            const s = await fetchWethUsdcSpot();
            setSpot(s.usdcPerWeth);
            spotRef.current = s.usdcPerWeth;
            setPriceError(null);
            const nextBases = reconcileBases(liveNow, basesRef.current);
            basesRef.current = nextBases;
            setBases(nextBases);
            persistBases(nextBases);
            await refreshForkSpot(liveNow);
            return s;
        } catch (e: any) {
            setPriceError(String(e?.message ?? e).slice(0, 160));
            // Still reconcile bases without a live Base spot.
            const nextBases = reconcileBases(liveNow, basesRef.current);
            basesRef.current = nextBases;
            setBases(nextBases);
            persistBases(nextBases);
            await refreshForkSpot(liveNow);
            return null;
        }
    }, [refreshForkSpot]);

    // Seed balanced amounts + concentrate band once we know spot.
    useEffect(() => {
        if (spot == null || seededFormRef.current) return;
        seededFormRef.current = true;
        const wethAmt = 0.25;
        setForm((f) => ({
            ...f,
            weth: String(wethAmt),
            usdc: usdcForWethAtSpot(wethAmt, spot),
            priceMin: f.priceMin || String(Math.round(spot * 0.8)),
            priceMax: f.priceMax || String(Math.round(spot * 1.2)),
        }));
    }, [spot]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const persisted = loadPersistedBases();
                if (!cancelled) {
                    basesRef.current = persisted;
                    setBases(persisted);
                }
                await Promise.all([refreshWallet(), refreshHistory()]);
                const fromChain = await loadShippedFromChain();
                if (cancelled) return;
                liveRef.current = fromChain;
                setLive(fromChain);
                const spotNow = await fetchWethUsdcSpot().catch((e) => {
                    setPriceError(String(e?.message ?? e).slice(0, 160));
                    return null;
                });
                if (cancelled) return;
                if (spotNow) {
                    setSpot(spotNow.usdcPerWeth);
                    spotRef.current = spotNow.usdcPerWeth;
                }
                const nextBases = reconcileBases(fromChain, basesRef.current);
                basesRef.current = nextBases;
                setBases(nextBases);
                persistBases(nextBases);
                if (fromChain.length) {
                    setTradeHash((h) => h || fromChain[0]!.hash);
                    await refreshForkSpot(fromChain);
                    if (spotNow) await recordPositionTick(fromChain, nextBases, spotNow.usdcPerWeth);
                }
            } catch (e: any) {
                if (!cancelled) setError(friendlyError(e));
            } finally {
                if (!cancelled) setLoadingChain(false);
            }
        })();
        return () => { cancelled = true; };
    }, [refreshWallet, refreshHistory, refreshForkSpot, recordPositionTick]);

    useEffect(() => {
        if (live.length === 0) return;
        const tick = async () => {
            try {
                const next = await refreshLive();
                if (next) {
                    const s = await refreshSpot(next);
                    await recordPositionTick(next, basesRef.current, s?.usdcPerWeth ?? spotRef.current);
                }
            } catch { /* ignore */ }
        };
        void tick();
        const t = setInterval(tick, 30_000);
        return () => clearInterval(t);
    }, [live.length, refreshLive, refreshSpot, recordPositionTick]);

    useEffect(() => {
        const t = setInterval(() => { void refreshHistory(); }, 5 * 60_000);
        return () => clearInterval(t);
    }, [refreshHistory]);

    const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
        setForm((f) => {
            const next = { ...f, [key]: value };
            if (!ratioLocked || spot == null) return next;
            if (key === "weth") {
                const w = Number(value);
                if (Number.isFinite(w) && w > 0) next.usdc = usdcForWethAtSpot(w, spot);
            }
            if (key === "usdc") {
                const u = Number(value);
                if (Number.isFinite(u) && u > 0) next.weth = wethForUsdcAtSpot(u, spot);
            }
            return next;
        });
    };

    const onAddDraft = () => {
        setError(null);
        try {
            const draft = parseDraft(form, `d-${Date.now()}-${drafts.length}`);
            if (!wallet) throw new Error("Wallet not loaded");
            assertFitsWallet(draft, freeWallet(wallet, drafts));
            setDrafts((ds) => [...ds, draft]);
        } catch (e: any) {
            setError(String(e?.message ?? e));
        }
    };

    const onShipOne = async (draft: DraftStrategy) => {
        setBusy(true);
        setError(null);
        try {
            const shipped = await buildAndShip(draft);
            const nextLive = [...liveRef.current.filter((x) => x.hash !== shipped.hash), shipped];
            setLive(nextLive);
            liveRef.current = nextLive;
            const nextBases = [...basesRef.current, basisFromLive(shipped)];
            basesRef.current = nextBases;
            setBases(nextBases);
            persistBases(nextBases);
            setDrafts((ds) => ds.filter((d) => d.id !== draft.id));
            setTradeHash((h) => h || shipped.hash);
            await refreshWallet();
            const s = await refreshSpot(nextLive);
            await recordPositionTick(nextLive, nextBases, s?.usdcPerWeth ?? spotRef.current);
        } catch (e: any) {
            resetMakerNonce();
            setError(friendlyError(e));
        } finally {
            setBusy(false);
        }
    };

    const onShipAll = async () => {
        if (drafts.length === 0) return;
        setBusy(true);
        setError(null);
        const remaining: DraftStrategy[] = [];
        const shipped: LiveStrategy[] = [];
        const newBases: PositionBasisLive[] = [];
        try {
            for (let i = 0; i < drafts.length; i++) {
                const draft = drafts[i]!;
                try {
                    const s = await buildAndShip(draft, BigInt(Date.now() % 1_000_000_000 + i));
                    shipped.push(s);
                    newBases.push(basisFromLive(s));
                } catch (e: any) {
                    resetMakerNonce();
                    remaining.push(draft, ...drafts.slice(i + 1));
                    setError(friendlyError(e));
                    break;
                }
            }
            const nextLive = [...liveRef.current, ...shipped];
            liveRef.current = nextLive;
            setLive(nextLive);
            if (newBases.length) {
                const nextBases = [...basesRef.current, ...newBases];
                basesRef.current = nextBases;
                setBases(nextBases);
                persistBases(nextBases);
            }
            setDrafts(remaining);
            if (shipped[0]) setTradeHash((h) => h || shipped[0]!.hash);
            await refreshWallet();
            if (shipped.length) {
                const s = await refreshSpot(nextLive);
                await recordPositionTick(nextLive, basesRef.current, s?.usdcPerWeth ?? spotRef.current);
            }
        } finally {
            setBusy(false);
        }
    };

    const onDock = async (s: LiveStrategy) => {
        setBusy(true);
        setError(null);
        try {
            await dock(s);
            const nextLive = liveRef.current.filter((x) => x.hash !== s.hash);
            liveRef.current = nextLive;
            setLive(nextLive);
            const nextBases = dropBasis(basesRef.current, s.hash);
            basesRef.current = nextBases;
            setBases(nextBases);
            persistBases(nextBases);
            if (tradeHash === s.hash) setTradeHash(nextLive[0]?.hash ?? "");
            await refreshWallet();
            if (nextLive.length) await refreshSpot(nextLive);
            else setForkSpot(null);
        } catch (e: any) {
            resetMakerNonce();
            setError(friendlyError(e));
        } finally {
            setBusy(false);
        }
    };

    /** Docking is an irreversible tx: first click arms a 4s confirm window, second click fires it. */
    const onDockClick = (s: LiveStrategy) => {
        if (confirmDockHash === s.hash) {
            if (confirmDockTimerRef.current) clearTimeout(confirmDockTimerRef.current);
            confirmDockTimerRef.current = null;
            setConfirmDockHash(null);
            void onDock(s);
            return;
        }
        if (confirmDockTimerRef.current) clearTimeout(confirmDockTimerRef.current);
        setConfirmDockHash(s.hash);
        confirmDockTimerRef.current = setTimeout(() => {
            setConfirmDockHash(null);
            confirmDockTimerRef.current = null;
        }, 4000);
    };

    const onTrade = async () => {
        const target = live.find((s) => s.hash === tradeHash) ?? live[0];
        if (!target) {
            setError("Ship a strategy before trading");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await tradeAgainst(target, tradeSide, tradeAmount);
            if (!result.ok) {
                setError(result.reason ?? "Trade failed");
                // Selection pointed at a strategy that's already docked elsewhere: drop it
                // from the live list instead of leaving a dead option selected.
                if (result.stale) {
                    const next = liveRef.current.filter((x) => x.hash !== target.hash);
                    liveRef.current = next;
                    setLive(next);
                    if (tradeHash === target.hash) setTradeHash(next[0]?.hash ?? "");
                }
                return;
            }
            const next = await refreshLive();
            await refreshWallet();
            const liveNow = next ?? liveRef.current;
            const s = await refreshSpot(liveNow);
            await recordPositionTick(liveNow, basesRef.current, s?.usdcPerWeth ?? spotRef.current);
        } catch (e: any) {
            resetTakerNonce();
            setError(friendlyError(e));
        } finally {
            setBusy(false);
        }
    };

    const onRefreshWallet = async () => {
        setBusy(true);
        setError(null);
        try {
            await refreshWallet();
        } catch (e: any) {
            setError(friendlyError(e));
        } finally {
            setBusy(false);
        }
    };

    const onRefreshLive = async () => {
        setBusy(true);
        setError(null);
        try {
            await refreshLive();
        } catch (e: any) {
            setError(friendlyError(e));
        } finally {
            setBusy(false);
        }
    };

    const reloadForMaker = useCallback(async () => {
        setLoadingChain(true);
        setDrafts([]);
        setLive([]);
        liveRef.current = [];
        setForkSpot(null);
        setTradeHash("");
        try {
            const persisted = loadPersistedBases();
            basesRef.current = persisted;
            setBases(persisted);
            await Promise.all([refreshWallet(), refreshHistory()]);
            const fromChain = await loadShippedFromChain();
            liveRef.current = fromChain;
            setLive(fromChain);
            const spotNow = await fetchWethUsdcSpot().catch((e) => {
                setPriceError(String(e?.message ?? e).slice(0, 160));
                return null;
            });
            if (spotNow) {
                setSpot(spotNow.usdcPerWeth);
                spotRef.current = spotNow.usdcPerWeth;
            }
            const nextBases = reconcileBases(fromChain, basesRef.current);
            basesRef.current = nextBases;
            setBases(nextBases);
            persistBases(nextBases);
            if (fromChain.length) {
                setTradeHash(fromChain[0]!.hash);
                await refreshForkSpot(fromChain);
                if (spotNow) await recordPositionTick(fromChain, nextBases, spotNow.usdcPerWeth);
            }
        } catch (e: any) {
            setError(String(e?.shortMessage ?? e?.message ?? e).slice(0, 200));
        } finally {
            setLoadingChain(false);
        }
    }, [refreshWallet, refreshHistory, refreshForkSpot, recordPositionTick]);

    const onConnect = async () => {
        setBusy(true);
        setError(null);
        try {
            const addr = await connectWallet();
            setAccount(addr);
            let w = await readWallet();
            if (w.weth === 0n && w.usdc === 0n) {
                await seedConnectedWallet();
                w = await readWallet();
            }
            setWallet(w);
            await reloadForMaker();
        } catch (e: any) {
            setError(String(e?.shortMessage ?? e?.message ?? e).slice(0, 200));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="page desk">
            <header className="app-header">
                <div className="brand">
                    <Mark />
                    <h1>Doca</h1>
                </div>

                <TabNav view={view} onChange={onViewChange} />

                <div className="header-right">
                    <div className="header-group">
                        <span
                            className="pill-seg"
                            title={`Base fork · chain ${d.chainId} · Aqua ${d.aqua.slice(0, 10)}… · ship & trade on the local fork`}
                        >
                            <span className="dot" />Practice waters
                        </span>
                        {account
                            ? <span className="pill-seg acct"><i className="state-dot" />{account.slice(0, 6)}…{account.slice(-4)}</span>
                            : hasInjectedWallet()
                                ? <button type="button" className="pill-seg connect" onClick={onConnect} disabled={busy}>Connect wallet</button>
                                : thirdwebClient
                                    ? (
                                        <span className="pill-seg thirdweb-seg">
                                            <ConnectButton
                                                client={thirdwebClient}
                                                wallets={thirdwebWallets}
                                                chain={base}
                                                theme="light"
                                                connectButton={{ label: "Sign in", className: "thirdweb-connect-btn" }}
                                            />
                                        </span>
                                    )
                                    : <span className="pill-seg acct dim" title="Demo signer: a local development key. On a public chain, this becomes your connected wallet."><i className="state-dot" />Preview wallet</span>}
                    </div>
                </div>
            </header>

            <div className="narr desk-narr">
                <h2>LP Desk</h2>
                <p>The professional view of the same harbor: positions, fills and value, marked to the live market.</p>
            </div>

            <PnlChart
                ticks={ticks}
                bases={bases}
                live={live}
                spot={spot}
                forkSpot={forkSpot}
                priceError={priceError}
            />

            <section className="card">
                <div className="row">
                    <div>
                        <div className="muted">Wallet · free after drafts</div>
                        <div className="balances" style={{ margin: "6px 0 0" }}>
                            <div>
                                <strong>{wallet ? fmtWeth(wallet.weth) : "-"}</strong>
                                <span>WETH</span>
                                {wallet && drafts.length > 0 && (
                                    <span className="muted" style={{ marginLeft: 6 }}>
                                        ({fmtWeth(freeWallet(wallet, drafts).weth)} free)
                                    </span>
                                )}
                            </div>
                            <div>
                                <strong>{wallet ? fmtUsdc(wallet.usdc) : "-"}</strong>
                                <span>USDC</span>
                                {wallet && drafts.length > 0 && (
                                    <span className="muted" style={{ marginLeft: 6 }}>
                                        ({fmtUsdc(freeWallet(wallet, drafts).usdc)} free)
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <button type="button" className="ghost" disabled={busy} onClick={onRefreshWallet}>
                        Refresh
                    </button>
                </div>
            </section>

            <section className="card">
                <div className="row">
                    <h2 className="desk-h" style={{ margin: 0 }}>Add strategy</h2>
                    <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <input
                            type="checkbox"
                            checked={ratioLocked}
                            onChange={(e) => setRatioLocked(e.target.checked)}
                        />
                        Lock 50/50 at spot{spot != null ? ` ($${spot.toFixed(0)})` : ""}
                    </label>
                </div>
                <div className="desk-form" style={{ marginTop: 14 }}>
                    <label>
                        Kind
                        <select value={form.kind} onChange={(e) => setField("kind", e.target.value as StrategyKind)}>
                            <option value="xyc">Even spread (full range)</option>
                            <option value="concentrate">Focused range</option>
                            <option value="pegged">Pegged pair</option>
                        </select>
                    </label>
                    <label>
                        WETH amount
                        <input value={form.weth} onChange={(e) => setField("weth", e.target.value)} inputMode="decimal" />
                    </label>
                    <label>
                        USDC amount
                        <input value={form.usdc} onChange={(e) => setField("usdc", e.target.value)} inputMode="decimal" />
                    </label>
                    <label>
                        Fee %
                        <input value={form.feePercent} onChange={(e) => setField("feePercent", e.target.value)} inputMode="decimal" />
                    </label>
                    {form.kind === "concentrate" && (
                        <>
                            <label>
                                Min USDC / WETH
                                <input value={form.priceMin} onChange={(e) => setField("priceMin", e.target.value)} inputMode="decimal" />
                            </label>
                            <label>
                                Max USDC / WETH
                                <input value={form.priceMax} onChange={(e) => setField("priceMax", e.target.value)} inputMode="decimal" />
                            </label>
                        </>
                    )}
                    {form.kind === "pegged" && (
                        <label>
                            Peg tightness
                            <input value={form.linearWidthA} onChange={(e) => setField("linearWidthA", e.target.value)} inputMode="decimal" />
                        </label>
                    )}
                </div>
                <div className="actions">
                    <button type="button" className="primary" style={{ width: "auto" }} disabled={busy} onClick={onAddDraft}>
                        Add to draft
                    </button>
                </div>
            </section>

            <section className="card">
                <div className="row">
                    <h2 className="desk-h">Draft ({drafts.length})</h2>
                    <button type="button" className="primary" style={{ width: "auto" }} disabled={busy || drafts.length === 0} onClick={onShipAll}>
                        Ship all
                    </button>
                </div>
                {drafts.length === 0 ? (
                    <p className="muted">No drafts yet. Add one or more strategies above.</p>
                ) : (
                    <div className="desk-table-wrap"><table className="desk-table">
                        <thead>
                            <tr>
                                <th>Kind</th>
                                <th>WETH</th>
                                <th>USDC</th>
                                <th>Fee</th>
                                <th>Params</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {drafts.map((draft) => (
                                <tr key={draft.id}>
                                    <td>{KIND_LABEL[draft.kind]}</td>
                                    <td>{fmtWeth(draft.promisedWeth)}</td>
                                    <td>{fmtUsdc(draft.promisedUsdc)}</td>
                                    <td>{percentFromFee(draft.feeBpsIn)}%</td>
                                    <td className="muted">
                                        {draft.kind === "concentrate" && `${draft.priceMinUsdc}-${draft.priceMaxUsdc}`}
                                        {draft.kind === "pegged" && `A=${draft.linearWidthA}`}
                                        {draft.kind === "xyc" && "full range"}
                                    </td>
                                    <td className="desk-actions">
                                        <button type="button" disabled={busy} onClick={() => onShipOne(draft)}>Ship</button>
                                        <button type="button" className="ghost" disabled={busy} onClick={() => setDrafts((ds) => ds.filter((x) => x.id !== draft.id))}>
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table></div>
                )}
            </section>

            <section className="card">
                <div className="row">
                    <h2 className="desk-h">Live ({live.length})</h2>
                    <button type="button" className="ghost" disabled={busy || live.length === 0} onClick={onRefreshLive}>
                        Refresh balances
                    </button>
                </div>
                {live.length === 0 ? (
                    <p className="muted">
                        {loadingChain
                            ? "Loading strategies from Aqua…"
                            : "No active strategies on-chain. Ship one above."}
                    </p>
                ) : (
                    <div className="desk-table-wrap"><table className="desk-table">
                        <thead>
                            <tr>
                                <th>Kind</th>
                                <th>Hash</th>
                                <th>WETH left</th>
                                <th>USDC left</th>
                                <th>Promised</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {live.map((s) => (
                                <tr key={s.hash}>
                                    <td>{s.label}</td>
                                    <td><code>{shortHash(s.hash)}</code></td>
                                    <td>{fmtWeth(s.wethLeft)}</td>
                                    <td>{fmtUsdc(s.usdcLeft)}</td>
                                    <td className="muted">{fmtWeth(s.promisedWeth)} / {fmtUsdc(s.promisedUsdc)}</td>
                                    <td>
                                        <button
                                            type="button"
                                            className={confirmDockHash === s.hash ? "danger" : ""}
                                            disabled={busy}
                                            onClick={() => onDockClick(s)}
                                        >
                                            {confirmDockHash === s.hash ? "Confirm dock" : "Dock"}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table></div>
                )}
            </section>

            <section className="card testing-card">
                <div className="row">
                    <h2 className="desk-h" style={{ margin: 0 }}>Testing</h2>
                    <div className="muted" style={{ fontSize: 12 }}>
                        Cheat wallet {d.taker.slice(0, 8)}…
                        {takerWallet
                            ? ` · ${fmtWeth(takerWallet.weth)} WETH · ${fmtUsdc(takerWallet.usdc)} USDC`
                            : ""}
                    </div>
                </div>
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                    Test a trade: the anvil taker fills against your strategy on the fork (no MetaMask), same flow as Harbor.
                </p>
                <div className="desk-form" style={{ marginTop: 14 }}>
                    <label className="desk-form-wide">
                        Strategy
                        <select
                            value={tradeHash || live[0]?.hash || ""}
                            onChange={(e) => setTradeHash(e.target.value)}
                            disabled={live.length === 0}
                        >
                            {live.length === 0 && <option value="">No live strategies</option>}
                            {live.map((s) => (
                                <option key={s.hash} value={s.hash} title={`${s.label} · ${s.hash}`}>
                                    {s.label} · {shortHash(s.hash)} · {fmtWeth(s.wethLeft)}/{fmtUsdc(s.usdcLeft)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Side
                        <select
                            value={tradeSide}
                            onChange={(e) => {
                                const side = e.target.value as TradeSide;
                                setTradeSide(side);
                                setTradeAmount(side === "buyWeth" ? "100" : "0.02");
                            }}
                        >
                            <option value="buyWeth">Buy WETH (pay USDC)</option>
                            <option value="sellWeth">Sell WETH (pay WETH)</option>
                        </select>
                    </label>
                    <label>
                        {tradeSide === "buyWeth" ? "USDC in" : "WETH in"}
                        <input
                            value={tradeAmount}
                            onChange={(e) => setTradeAmount(e.target.value)}
                            inputMode="decimal"
                            disabled={live.length === 0}
                        />
                    </label>
                </div>
                <div className="actions">
                    <button
                        type="button"
                        className="primary"
                        style={{ width: "auto" }}
                        disabled={busy || live.length === 0}
                        onClick={onTrade}
                    >
                        Execute trade
                    </button>
                    {forkSpot != null && (
                        <span className="muted" style={{ alignSelf: "center", fontSize: 13 }}>
                            Fork spot ${forkSpot.toFixed(2)}
                            {spot != null ? ` · Base $${spot.toFixed(2)}` : ""}
                        </span>
                    )}
                </div>
            </section>

            {error && <p className="desk-error">{error}</p>}
            {busy && <p className="busy">Working</p>}

            <footer>
                Demo trades run on a private test copy of Base mainnet.
            </footer>
        </div>
    );
}
