import { useCallback, useEffect, useRef, useState } from "react";
import {
    d, provider, readWallet, readStrategy, start, dock, marketFill, spendWeth, shipStrategy, resetNonces,
    PRESETS, fmtWeth, fmtPct, fmtFee, FRAC,
    type Preset, type Strategy, type Wallet,
} from "./lib/plimsoll";

const WATERLINE = 1_000n;         // must match the curve the provider was configured with
const FILL_SIZE = 500_000_000n;   // 500 USDC per market fill
const SPEND = 250_000_000_000_000_000n; // 0.25 WETH

type Entry = { at: string; text: string; kind: "info" | "agent" | "warn" | "fill" };

const STEPS = [
    { n: 1, label: "Idle wallet" },
    { n: 2, label: "Put to work" },
    { n: 3, label: "Live market" },
    { n: 4, label: "Spend freely" },
    { n: 5, label: "Walk away" },
];

const ICON: Record<Entry["kind"], string> = { info: "·", agent: "●", warn: "▲", fill: "⇄" };

// The Plimsoll mark: a circle crossed by the load line.
function Mark({ size = 30 }: { size?: number }) {
    return (
        <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="2.6" />
            <line x1="1" y1="16" x2="31" y2="16" stroke="currentColor" strokeWidth="2.6" />
        </svg>
    );
}

// Eases a displayed number toward its target so balances glide instead of jumping.
function useEased(target: number): number {
    const [shown, setShown] = useState(target);
    const shownRef = useRef(target);
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const cur = shownRef.current;
            const next = cur + (target - cur) * 0.16;
            if (Math.abs(next - target) < Math.max(Math.abs(target), 1) * 1e-5) {
                shownRef.current = target;
                setShown(target);
                return;
            }
            shownRef.current = next;
            setShown(next);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [target]);
    return shown;
}

function Rail({ stage }: { stage: number }) {
    return (
        <nav className="rail">
            {STEPS.map((s) => (
                <div key={s.n} className={`step ${s.n < stage ? "done" : ""} ${s.n === stage ? "now" : ""}`}>
                    <span className="num">{s.n < stage ? "✓" : s.n}</span>
                    <span className="lbl">{s.label}</span>
                </div>
            ))}
        </nav>
    );
}

function Vessel({ s, idx }: { s: Strategy; idx: number }) {
    const consumed = 100 - (Number(s.remaining) / Number(FRAC)) * 100;
    const lineAt = 100 - (Number(WATERLINE) / Number(FRAC)) * 100;
    const state = s.remaining <= WATERLINE ? "sinking" : consumed > 60 ? "warn" : "ok";
    return (
        <div className={`vessel ${state}`}>
            <div className="hull">
                <div className="water" style={{ height: `${Math.min(Math.max(consumed, 2), 100)}%` }} />
                <div className="loadline" style={{ bottom: `${lineAt}%` }}><i /><b /></div>
                <div className="hull-head">
                    <strong>Berth {idx + 1}</strong>
                    <code>{s.hash.slice(0, 10)}</code>
                </div>
                <div className="hull-foot">
                    <div><em>{fmtWeth(s.wethLeft)}</em><span>WETH aboard</span></div>
                    <div style={{ textAlign: "right" }}><em>{fmtPct(s.remaining)}%</em><span>budget left</span></div>
                </div>
            </div>
            <div className="feebadge">
                {state === "sinking" ? "below the load line" : `${fmtFee(s.surchargeBps)}% surcharge`}
            </div>
        </div>
    );
}

export default function App() {
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [preset, setPreset] = useState<Preset>(PRESETS[1]!);
    const [busy, setBusy] = useState<string | null>(null);
    const [agentOn, setAgentOn] = useState(false);
    const [log, setLog] = useState<Entry[]>([]);
    const [rebalances, setRebalances] = useState(0);
    const [stage, setStage] = useState(1);
    const [block, setBlock] = useState<number | null>(null);
    const saltRef = useRef(1);

    const say = useCallback((text: string, kind: Entry["kind"] = "info") => {
        const at = new Date().toLocaleTimeString();
        setLog((l) => [{ at, text, kind }, ...l].slice(0, 40));
    }, []);

    const refresh = useCallback(async () => {
        setWallet(await readWallet());
        provider.getBlockNumber().then(setBlock).catch(() => {});
        if (strategies.length > 0) {
            const fresh = await Promise.all(strategies.map(readStrategy));
            // Functional update so an in-flight read never resurrects strategies docked meanwhile.
            setStrategies((prev) =>
                prev.length === 0 ? prev : prev.map((p) => fresh.find((f) => f.hash === p.hash) ?? p));
        }
    }, [strategies]);

    useEffect(() => {
        readWallet().then(setWallet);
        provider.getBlockNumber().then(setBlock).catch(() => {});
    }, []);
    useEffect(() => {
        const t = setInterval(() => { refresh().catch(() => {}); }, 2500);
        return () => clearInterval(t);
    }, [refresh]);

    // The harbormaster reads strategies through a ref: the interval must survive refresh cycles
    // (a state dependency would reset the 3.5s timer every 2.5s and it would never fire).
    const strategiesRef = useRef<Strategy[]>([]);
    useEffect(() => { strategiesRef.current = strategies; }, [strategies]);
    const agentBusyRef = useRef(false);

    // The harbormaster: docks anything under its load line and re-promises against real balances.
    useEffect(() => {
        if (!agentOn) return;
        const t = setInterval(async () => {
            if (agentBusyRef.current) return;
            const current = strategiesRef.current;
            if (current.length === 0) return;
            const fresh = await Promise.all(current.map(readStrategy));
            const sinking = fresh.find((s) => s.remaining <= WATERLINE);
            if (!sinking) return;
            agentBusyRef.current = true;
            try {
                say(`berth ${fresh.indexOf(sinking) + 1} went below its load line — docking`, "agent");
                await dock(sinking);
                const w = await readWallet();
                // The new budget is whatever the other berths have not already reserved,
                // so the sum of live budgets never exceeds the wallet.
                const others = fresh.filter((s) => s.hash !== sinking.hash);
                const othersBudgetLeft = others.reduce((a, s) => a + (s.budgetWeth * s.remaining) / FRAC, 0n);
                const budgetWeth = w.weth > othersBudgetLeft ? w.weth - othersBudgetLeft : 0n;
                if (budgetWeth === 0n) {
                    setStrategies((prev) => prev.filter((s) => s.hash !== sinking.hash));
                    setRebalances((n) => n + 1);
                    say("docked — no free balance to re-promise, one less berth", "agent");
                } else {
                    const replacement = await shipStrategy(
                        BigInt(1000 + saltRef.current++),
                        w.weth, w.usdc, budgetWeth, w.usdc / BigInt(fresh.length),
                    );
                    setStrategies((prev) => prev.map((s) => (s.hash === sinking.hash ? replacement : s)));
                    setRebalances((n) => n + 1);
                    say(`re-promised with a ${fmtWeth(budgetWeth)} WETH budget — what is really free`, "agent");
                }
            } catch (e: any) {
                resetNonces();
                say(`could not rebalance: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
            } finally {
                agentBusyRef.current = false;
            }
        }, 3500);
        return () => clearInterval(t);
    }, [agentOn, say]);

    const onStart = async () => {
        if (!wallet) return;
        setBusy(`shipping ${preset.count} promises through the canonical Aqua registry`);
        try {
            const shipped = await start(preset, wallet);
            setStrategies(shipped);
            say(`${preset.count} promises shipped — nothing left your wallet`, "info");
            setAgentOn(true);
            setStage(2);
        } finally { setBusy(null); }
    };

    const onFlow = async () => {
        if (strategies.length === 0) return;
        setBusy("market flow trading against your balance");
        setStage(3);
        try {
            for (let i = 0; i < 8; i++) {
                const target = strategies[i % strategies.length]!;
                const r = await marketFill(target, FILL_SIZE);
                if (r.ok) {
                    say(`fill: ${Number(FILL_SIZE) / 1e6} USDC in, WETH out of berth ${(i % strategies.length) + 1}`, "fill");
                } else {
                    say(`a fill on berth ${(i % strategies.length) + 1} could not be honored`, "warn");
                }
                // Refresh as each fill lands so the water visibly rises during the sequence.
                const updated = await readStrategy(target);
                setStrategies((prev) => prev.map((p) => (p.hash === updated.hash ? updated : p)));
                setWallet(await readWallet());
            }
            say("8 fills settled — real WETH left the wallet, USDC came in", "info");
        } finally { setBusy(null); }
    };

    const onSpend = async () => {
        if (!wallet) return;
        // Spend a quarter WETH when it is there, half of what is left otherwise — never revert a demo.
        const amount = wallet.weth >= SPEND ? SPEND : wallet.weth / 2n;
        setBusy(`sending ${fmtWeth(amount)} WETH out of the same wallet`);
        setStage(4);
        try {
            await spendWeth(amount);
            say(`spent ${fmtWeth(amount)} WETH while earning — nothing had to be withdrawn first`, "info");
            await refresh();
        } catch (e: any) {
            resetNonces();
            say(`spend failed: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
        } finally { setBusy(null); }
    };

    const onStop = async () => {
        setBusy("docking everything");
        setAgentOn(false);
        try {
            for (const s of strategies) {
                try {
                    await dock(s);
                } catch {
                    resetNonces();
                    await dock(s); // one retry after clearing the cached nonce
                }
            }
            setStrategies([]);
            setStage(5);
            say("everything docked — your full balance is liquid right now", "info");
            await refresh();
        } catch (e: any) {
            resetNonces();
            say(`could not dock: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
        } finally { setBusy(null); }
    };

    const promisedWeth = strategies.reduce((a, s) => a + s.promisedWeth, 0n);
    // What the berths may still consume: each budget scaled by how much of it is left.
    const budgetLeftWeth = strategies.reduce((a, s) => a + (s.budgetWeth * s.remaining) / FRAC, 0n);
    const amplification = wallet && wallet.weth > 0n ? Number(promisedWeth) / Number(wallet.weth) : 0;
    const honorable = wallet ? budgetLeftWeth <= wallet.weth : true;

    const easedWeth = useEased(wallet ? Number(wallet.weth) / 1e18 : 0);
    const easedUsdc = useEased(wallet ? Number(wallet.usdc) / 1e6 : 0);

    const working = strategies.length > 0;

    return (
        <div className="page">
            <header>
                <div className="brand">
                    <Mark />
                    <div>
                        <h1>Plimsoll</h1>
                        <p className="tagline">Keep your wallet. Put it to work anyway.</p>
                    </div>
                </div>
                <div className="chain">
                    <span><span className="dot" />Base fork · block {block ? block.toLocaleString() : d.forkBlock.toLocaleString()}</span><br />
                    <code>Aqua {d.aqua.slice(0, 10)}… · canonical registry</code>
                </div>
            </header>

            <Rail stage={working ? Math.max(stage, 2) : stage} />

            {!wallet && <p className="muted">reading your wallet…</p>}

            {wallet && !working && (
                <>
                    {stage === 5 && (
                        <div className="banner">
                            Journey complete — everything docked in one click.{" "}
                            <span>Your full balance was liquid the entire time; it just also worked.</span>
                        </div>
                    )}
                    <div className="narr">
                        <h2>{stage === 5 ? "Back to a plain wallet" : "This wallet is idle"}</h2>
                        <p>
                            {stage === 5
                                ? "Run it again with a different setting, or walk away — there is nothing to unwind, no positions to close, nothing custodied anywhere."
                                : "Nothing here earns. Put the same balance to work in several places at once — without depositing it anywhere."}
                        </p>
                    </div>
                    <section className="card">
                        <div className="balances">
                            <div><strong>{easedWeth.toFixed(4)}</strong><span>WETH</span></div>
                            <div><strong>{easedUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span>USDC</span></div>
                        </div>
                        <p className="muted">
                            Nothing leaves this wallet. You are signing price rules, not a deposit.
                        </p>
                        <p className="factline">
                            $1.6B of DeFi liquidity sits exactly like this — 85% of concentrated liquidity
                            was idle in H1 2026, most of it in wallets managed by people, not systems.
                        </p>

                        <div className="presets">
                            {PRESETS.map((p) => (
                                <button
                                    key={p.id}
                                    className={`preset ${preset.id === p.id ? "on" : ""}`}
                                    onClick={() => setPreset(p)}
                                >
                                    <strong>{p.label}</strong>
                                    <span>{p.hint}</span>
                                    <span className="berths">
                                        {Array.from({ length: p.count }, (_, i) => <i key={i} />)}
                                    </span>
                                </button>
                            ))}
                        </div>

                        <button className="primary" onClick={onStart} disabled={!!busy}>
                            {busy ?? (stage === 5 ? "Put it back to work" : "Put it to work")}
                        </button>
                    </section>
                </>
            )}

            {wallet && working && (
                <>
                    <div className="narr">
                        <h2>One balance, working in {strategies.length} places</h2>
                        <p>
                            Promises may exceed the wallet — that is Aqua's capital efficiency. Budgets may not —
                            that is what keeps every quote below honorable. When a berth goes under its load line,
                            the harbormaster docks it and re-promises what is really there.
                        </p>
                    </div>

                    <section className="tiles">
                        <div className="tile">
                            <span>In your wallet</span>
                            <strong>{easedWeth.toFixed(4)} WETH</strong>
                            <em>{easedUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</em>
                        </div>
                        <div className="tile">
                            <span>Promised</span>
                            <strong>{fmtWeth(promisedWeth)} WETH</strong>
                            <em>{amplification.toFixed(2)}× your balance</em>
                        </div>
                        <div className="tile">
                            <span>Budget left</span>
                            <strong>{fmtWeth(budgetLeftWeth)} WETH</strong>
                            <em>{honorable ? "never more than you hold" : "over budget"}</em>
                        </div>
                        <div className={`tile ${honorable ? "good" : "bad"}`}>
                            <span>Quotes you can honor</span>
                            <strong>{honorable ? "all of them" : "at risk"}</strong>
                            <em>{rebalances} rebalance{rebalances === 1 ? "" : "s"} by the harbormaster</em>
                        </div>
                    </section>

                    <section className="card">
                        <div className="vessels">
                            {strategies.map((s, i) => <Vessel key={s.hash} s={s} idx={i} />)}
                        </div>

                        <div className="harbor">
                            <span className={`beacon ${agentOn ? "on" : ""}`} />
                            <div className="harbor-txt">
                                <strong>Harbormaster</strong>
                                <span>
                                    {agentOn
                                        ? `watching ${strategies.length} berths — docks anything below its load line, re-promises against real balances`
                                        : "off — nobody is watching your promises"}
                                </span>
                            </div>
                            <span className="count">{rebalances} intervention{rebalances === 1 ? "" : "s"}</span>
                            <label className="switch">
                                <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
                                <i />
                            </label>
                        </div>

                        <div className="actions">
                            <button onClick={onFlow} disabled={!!busy}>Simulate market flow</button>
                            <button onClick={onSpend} disabled={!!busy}>Spend 0.25 WETH</button>
                            <button className="ghost" onClick={onStop} disabled={!!busy}>Dock everything</button>
                        </div>
                        {busy && <p className="busy">{busy}</p>}
                    </section>
                </>
            )}

            <section className="log">
                {log.map((e, i) => (
                    <div key={i} className={e.kind}>
                        <time>{e.at}</time> <i>{ICON[e.kind]}</i> {e.text}
                    </div>
                ))}
            </section>

            <footer>
                Canonical 1inch Aqua registry, official SwapVM router code, real WETH and USDC on a fork of Base.
                Demo signs with a local development key; on a public chain this is a wallet connector.
            </footer>
        </div>
    );
}
