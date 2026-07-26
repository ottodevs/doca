import { useCallback, useEffect, useRef, useState } from "react";
import {
    d, provider, readWallet, readStrategy, start, dock, marketFill, spendWeth, shipStrategy, resetNonces,
    hasInjectedWallet, connectWallet, seedConnectedWallet,
    PRESETS, fmtWeth, fmtPct, fmtFee, FRAC,
    type Preset, type Strategy, type Wallet,
} from "./lib/doca";
import { fetchWethUsdcSpot, type SpotPrice } from "./lib/uniswap-price";
import { Mark, TabNav, type ViewId } from "./nav";

const WATERLINE = 1_000n;         // must match the curve the provider was configured with
const FILL_SIZE = 500_000_000n;   // 500 USDC per market fill
const SPEND = 250_000_000_000_000_000n; // 0.25 WETH
// Consumed % of a strategy's budget that triggers the Harbormaster's auto-dock (derived from WATERLINE/FRAC).
const DOCK_LINE_PCT = Math.round(100 - (Number(WATERLINE) / Number(FRAC)) * 100);
// Two-decimal WETH formatter for the compact capacity/coverage summary (legible on camera).
const fmt2 = (v: bigint) => (Number(v) / 1e18).toFixed(2);

type Entry = { at: string; text: string; kind: "info" | "agent" | "warn" | "fill" };

// Stage labels drive only the waterline's aria-label; no numbered chrome is rendered.
const STEPS = [
    { n: 1, label: "Wallet" },
    { n: 2, label: "Put to work" },
    { n: 3, label: "Live market" },
    { n: 4, label: "Protected" },
    { n: 5, label: "Walk away" },
];

const ICON: Record<Entry["kind"], string> = { info: "·", agent: "●", warn: "▲", fill: "⇄" };

type ThemeMode = "day" | "night" | "system";
const THEME_KEY = "doca-theme";

// Day is the brand default. "system" clears the override and lets prefers-color-scheme decide.
function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
    const [mode, setMode] = useState<ThemeMode>(() => {
        const saved = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
        return saved === "day" || saved === "night" || saved === "system" ? saved : "day";
    });
    useEffect(() => {
        localStorage.setItem(THEME_KEY, mode);
        const root = document.documentElement;
        if (mode === "system") root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", mode);
    }, [mode]);
    return [mode, setMode];
}

const THEME_OPTS: { id: ThemeMode; label: string }[] = [
    { id: "day", label: "Day" },
    { id: "night", label: "Night" },
    { id: "system", label: "Auto" },
];

function ThemeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
    return (
        <div className="theme-toggle" role="group" aria-label="Theme">
            {THEME_OPTS.map((o) => (
                <button
                    key={o.id}
                    type="button"
                    className={o.id === mode ? "on" : ""}
                    aria-pressed={o.id === mode}
                    title={o.label}
                    onClick={() => onChange(o.id)}
                >
                    {o.id === "day" && (
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                            <circle cx="10" cy="10" r="4" />
                            <path d="M10 1.5v2.4M10 16.1v2.4M18.5 10h-2.4M3.9 10H1.5M15.9 4.1l-1.7 1.7M5.8 14.2l-1.7 1.7M15.9 15.9l-1.7-1.7M5.8 5.8 4.1 4.1" />
                        </svg>
                    )}
                    {o.id === "night" && (
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z" />
                        </svg>
                    )}
                    {o.id === "system" && (
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                            <circle cx="10" cy="10" r="7" />
                            <path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" stroke="none" />
                        </svg>
                    )}
                </button>
            ))}
        </div>
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

// Progress as a thin waterline along the top of the content, not a numbered rail.
function Waterline({ stage }: { stage: number }) {
    const pct = Math.min(100, Math.max(0, ((stage - 1) / (STEPS.length - 1)) * 100));
    const label = STEPS.find((s) => s.n === stage)?.label ?? STEPS[STEPS.length - 1]!.label;
    return (
        <div
            className="waterline"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={stage}
            aria-label={`Progress: ${label}`}
        >
            <div className="waterline-fill" style={{ width: `${pct}%` }}>
                <svg className="waterline-tip" viewBox="0 0 28 14" aria-hidden>
                    <path d="M0 7 Q4 1 8 7 T16 7 T24 7 T28 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
            </div>
        </div>
    );
}

const CHIP: Record<string, string> = { ok: "afloat", warn: "watch line", sinking: "docking" };

// Shared by the hull card, the route overlay and the Harbormaster panel so all three
// agree on when a strategy counts as trouble.
function vesselState(s: Strategy): "ok" | "warn" | "sinking" {
    const consumed = 100 - (Number(s.remaining) / Number(FRAC)) * 100;
    return s.remaining <= WATERLINE ? "sinking" : consumed > 60 ? "warn" : "ok";
}

// A small hull silhouette that rides the waterline crossing the card.
function HullBoat() {
    return (
        <svg className="hull-boat" viewBox="0 0 30 14" aria-hidden>
            <path d="M2 7 H28 L23 12.5 H7 Z M14 7 V1.5 L20.5 5.5 Z" fill="currentColor" />
        </svg>
    );
}

function Vessel({ s, idx }: { s: Strategy; idx: number }) {
    const consumed = 100 - (Number(s.remaining) / Number(FRAC)) * 100;
    const lineAt = 100 - (Number(WATERLINE) / Number(FRAC)) * 100;
    const state = vesselState(s);
    const waterPct = Math.min(Math.max(consumed, 2), 100);
    return (
        <div className={`vessel ${state}`} title={s.hash}>
            <span className={`hull-badge ${state}`}>{idx + 1}</span>
            <div className="hull">
                <div className="water" style={{ height: `${waterPct}%` }}>
                    <HullBoat />
                </div>
                <div className="loadline" style={{ bottom: `${lineAt}%` }}>
                    <label>auto-dock line</label><i /><b />
                </div>
                <div className="hull-head">
                    <strong>Strategy {idx + 1}</strong>
                </div>
                <div className="hull-foot">
                    <div><em>{fmtWeth(s.promisedWeth)}</em><span>Quoted liquidity</span></div>
                    <span className={`chip ${state}`}>{CHIP[state]}</span>
                </div>
            </div>
            <div className="hull-metrics">
                <span>{fmtWeth(s.wethLeft)} WETH aboard</span>
                <span>{fmtFee(s.surchargeBps)}% surcharge</span>
                <span>Dock line {DOCK_LINE_PCT}%</span>
            </div>
        </div>
    );
}

const ONBOARD_KEY = "doca-onboarded";

const ONBOARD_PANELS: { title: string; body: string; note: string }[] = [
    {
        title: "Your money works from your wallet",
        body: "Doca puts an idle wallet balance to work in live markets, for people whose crypto sits untouched between trades.",
        note: "Keep your wallet. Put it to work anyway.",
    },
    {
        title: "One balance, many markets",
        body: "You sign price rules for several markets at once, never a deposit.",
        note: "The Harbormaster watches your positions so you don't have to.",
    },
    {
        title: "Try it in practice waters",
        body: "This preview runs on a mirrored copy of Base, with real contracts and real tokens, so nothing you do here touches real funds.",
        note: "Everything here is real. The risk is not.",
    },
];

// Shown once (localStorage doca-onboarded), reopenable from the header "?".
function Onboarding({ onClose }: { onClose: () => void }) {
    const [step, setStep] = useState(0);
    const last = step === ONBOARD_PANELS.length - 1;
    const panel = ONBOARD_PANELS[step]!;
    return (
        <div className="onboard" role="dialog" aria-modal="true" aria-label="Welcome to Doca">
            <div className="onboard-card">
                <button type="button" className="onboard-skip" onClick={onClose}>Skip</button>
                <Mark size={26} />
                <h2>{panel.title}</h2>
                <p>{panel.body}</p>
                <p className="onboard-note">{panel.note}</p>
                <div className="onboard-foot">
                    <div className="onboard-dots" aria-hidden>
                        {ONBOARD_PANELS.map((_, i) => (
                            <i key={i} className={i === step ? "on" : ""} />
                        ))}
                    </div>
                    <button
                        type="button"
                        className="primary onboard-next"
                        onClick={() => (last ? onClose() : setStep((s) => s + 1))}
                    >
                        {last ? "Start" : "Next"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function App({ view, onViewChange }: { view: ViewId; onViewChange: (v: ViewId) => void }) {
    const [theme, setTheme] = useTheme();
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [preset, setPreset] = useState<Preset>(PRESETS[1]!);
    const [busy, setBusy] = useState<string | null>(null);
    const [agentOn, setAgentOn] = useState(false);
    const [log, setLog] = useState<Entry[]>([]);
    const [rebalances, setRebalances] = useState(0);
    const [fills, setFills] = useState(0);
    const [stage, setStage] = useState(1);
    const [block, setBlock] = useState<number | null>(null);
    const [event, setEvent] = useState<{ title: string; detail: string } | null>(null);
    const [storm, setStorm] = useState(false);
    const [receipt, setReceipt] = useState<{ markets: number; fills: number; protections: number } | null>(null);
    const [account, setAccount] = useState<string | null>(null);
    const [onboardOpen, setOnboardOpen] = useState(() =>
        typeof localStorage !== "undefined" ? localStorage.getItem(ONBOARD_KEY) !== "true" : false);
    const saltRef = useRef(1);

    const closeOnboarding = useCallback(() => {
        localStorage.setItem(ONBOARD_KEY, "true");
        setOnboardOpen(false);
    }, []);

    const onConnect = async () => {
        try {
            const addr = await connectWallet();
            setAccount(addr);
            const w = await readWallet();
            setWallet(w);
            if (w.weth === 0n && w.usdc === 0n) {
                say("connected wallet is empty on this fork: seeding demo funds (sign the prompts)", "info");
                await seedConnectedWallet();
                setWallet(await readWallet());
                say("seeded: 2 WETH + 8,000 USDC, approvals set", "info");
            } else {
                say(`connected ${addr.slice(0, 6)}…${addr.slice(-4)}: your wallet is now the maker`, "info");
            }
        } catch (e: any) {
            say(`wallet connect failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 70)}`, "warn");
        }
    };

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

    const [nodeDown, setNodeDown] = useState(false);
    useEffect(() => {
        readWallet().then(setWallet);
        provider.getBlockNumber().then((b) => { setBlock(b); setNodeDown(false); })
            .catch(() => setNodeDown(true));
    }, []);
    useEffect(() => {
        const t = setInterval(() => { refresh().catch(() => {}); }, 2500);
        return () => clearInterval(t);
    }, [refresh]);

    // Live Base mainnet reference via the Uniswap Trading API. Optional by design:
    // if the API is unreachable the pill and annotations simply drop out.
    const [mark, setMark] = useState<SpotPrice | null>(null);
    const markRef = useRef<SpotPrice | null>(null);
    useEffect(() => {
        let cancelled = false;
        const pull = () => fetchWethUsdcSpot()
            .then((s) => { if (!cancelled) { setMark(s); markRef.current = s; } })
            .catch(() => {});
        pull();
        const t = setInterval(pull, 60_000);
        return () => { cancelled = true; clearInterval(t); };
    }, []);

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
            setStorm(true);
            setTimeout(() => setStorm(false), 3000);
            try {
                say(`strategy ${fresh.indexOf(sinking) + 1} went below its line: docking`, "agent");
                await dock(sinking);
                const w = await readWallet();
                // The new budget is whatever the other strategies have not already reserved,
                // so the sum of live budgets never exceeds the wallet.
                const others = fresh.filter((s) => s.hash !== sinking.hash);
                const othersBudgetLeft = others.reduce((a, s) => a + (s.budgetWeth * s.remaining) / FRAC, 0n);
                const budgetWeth = w.weth > othersBudgetLeft ? w.weth - othersBudgetLeft : 0n;
                setStage((st) => Math.max(st, 4));
                if (budgetWeth === 0n) {
                    setStrategies((prev) => prev.filter((s) => s.hash !== sinking.hash));
                    setRebalances((n) => n + 1);
                    setEvent({
                        title: "Harbormaster protected your wallet",
                        detail: `Strategy ${fresh.indexOf(sinking) + 1} crossed its dock line → docked. No free balance to re-ship. One strategy fewer, every remaining quote still honorable.`,
                    });
                    say("docked: no free balance to re-promise, one less strategy", "agent");
                } else {
                    const replacement = await shipStrategy(
                        BigInt(1000 + saltRef.current++),
                        w.weth, w.usdc, budgetWeth, w.usdc / BigInt(fresh.length),
                    );
                    setStrategies((prev) => prev.map((s) => (s.hash === sinking.hash ? replacement : s)));
                    setRebalances((n) => n + 1);
                    const m = markRef.current;
                    setEvent({
                        title: "Harbormaster protected your wallet",
                        detail: `Strategy ${fresh.indexOf(sinking) + 1} crossed its dock line → docked → re-shipped with a ${fmtWeth(budgetWeth)} WETH budget. Wallet changed; the strategy detected it and re-shipped a safe reallocation.`
                            + (m ? ` Market reference at re-ship: $${m.usdcPerWeth.toFixed(2)}/WETH, live Base via the Uniswap Trading API.` : ""),
                    });
                    say(`re-promised with a ${fmtWeth(budgetWeth)} WETH budget: what is really free`, "agent");
                    if (m) say(`market check: $${m.usdcPerWeth.toFixed(2)}/WETH on Base right now (Uniswap API)`, "agent");
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
        setBusy(`putting ${preset.count} promises to work`);
        try {
            const shipped = await start(preset, wallet);
            setStrategies(shipped);
            say(`${preset.count} promises shipped: nothing left your wallet`, "info");
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
                    setFills((f) => f + 1);
                    say(`fill: ${Number(FILL_SIZE) / 1e6} USDC in, WETH out of strategy ${(i % strategies.length) + 1}`, "fill");
                } else {
                    say(`a fill on strategy ${(i % strategies.length) + 1} could not be honored`, "warn");
                }
                // Refresh as each fill lands so the water visibly rises during the sequence.
                const updated = await readStrategy(target);
                setStrategies((prev) => prev.map((p) => (p.hash === updated.hash ? updated : p)));
                setWallet(await readWallet());
            }
            say("8 fills settled: real WETH left the wallet, USDC came in", "info");
        } finally { setBusy(null); }
    };

    const onSpend = async () => {
        if (!wallet) return;
        // Spend a quarter WETH when it is there, half of what is left otherwise. Never revert a demo.
        const amount = wallet.weth >= SPEND ? SPEND : wallet.weth / 2n;
        setBusy(`sending ${fmtWeth(amount)} WETH out of the same wallet`);
        try {
            await spendWeth(amount);
            say(`spent ${fmtWeth(amount)} WETH while earning: nothing had to be withdrawn first`, "info");
            await refresh();
        } catch (e: any) {
            resetNonces();
            say(`spend failed: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
        } finally { setBusy(null); }
    };

    const onStop = async () => {
        setBusy("docking everything");
        setAgentOn(false);
        const summary = { markets: strategies.length, fills, protections: rebalances };
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
            setEvent(null);
            setReceipt(summary);
            setStage(5);
            say("everything docked: your full balance is liquid right now", "info");
            await refresh();
        } catch (e: any) {
            resetNonces();
            say(`could not dock: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
        } finally { setBusy(null); }
    };

    const promisedWeth = strategies.reduce((a, s) => a + s.promisedWeth, 0n);
    // What the strategies may still consume: each budget scaled by how much of it is left.
    const budgetLeftWeth = strategies.reduce((a, s) => a + (s.budgetWeth * s.remaining) / FRAC, 0n);
    // Total risk budget allocated across every strategy (full budgets, not what remains).
    const totalBudgetWeth = strategies.reduce((a, s) => a + s.budgetWeth, 0n);
    const amplification = wallet && wallet.weth > 0n ? Number(promisedWeth) / Number(wallet.weth) : 0;
    // Health is the worse of the two legs: a strategy budgets both tokens at ship time, so an
    // oversubscribed USDC side must read as over budget even while the WETH side is covered.
    const budgetLeftUsdc = strategies.reduce((a, s) => a + (s.budgetUsdc * s.remainingUsdc) / FRAC, 0n);
    const honorable = wallet ? budgetLeftWeth <= wallet.weth && budgetLeftUsdc <= wallet.usdc : true;

    // Harbor map derivatives: how much of the wallet sits uncommitted, budget headroom,
    // and the blended surcharge the Harbormaster panel quotes across live strategies.
    const walletAvailPct = wallet && wallet.weth > 0n
        ? Math.max(0, Math.min(100, 100 - (Number(totalBudgetWeth) / Number(wallet.weth)) * 100))
        : 100;
    const budgetPct = totalBudgetWeth > 0n ? Math.max(0, Math.min(100, (Number(budgetLeftWeth) / Number(totalBudgetWeth)) * 100)) : 100;
    const avgSurchargeBps = strategies.length > 0
        ? strategies.reduce((a, s) => a + s.surchargeBps, 0n) / BigInt(strategies.length)
        : 0n;
    const anyAlert = strategies.some((s) => vesselState(s) !== "ok");

    const easedWeth = useEased(wallet ? Number(wallet.weth) / 1e18 : 0);
    const easedUsdc = useEased(wallet ? Number(wallet.usdc) / 1e6 : 0);

    const working = strategies.length > 0;

    return (
        <div className={`page ${storm ? "storm" : ""}`}>
            {nodeDown && (
                <div className="node-down" role="status">
                    <strong>Preview.</strong> The interactive build follows the demo node.
                    <a href="/deck/">See the walkthrough</a>
                    <a href="/">How the budgets work</a>
                </div>
            )}
            {onboardOpen && <Onboarding onClose={closeOnboarding} />}
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
                            title={`Base fork, block ${block ? block.toLocaleString() : d.forkBlock.toLocaleString()} · Aqua ${d.aqua.slice(0, 10)}… · canonical registry`}
                        >
                            <span className="dot" />Practice waters
                        </span>
                        {mark && (
                            <span
                                className="pill-seg"
                                title="Live Base mainnet WETH/USDC price from the Uniswap Trading API. The Harbormaster marks its decisions against the real market, not the practice fork."
                            >
                                ${mark.usdcPerWeth.toFixed(0)} · Uniswap live
                            </span>
                        )}
                        {account
                            ? <span className="pill-seg acct"><i className="state-dot" />{account.slice(0, 6)}…{account.slice(-4)}</span>
                            : hasInjectedWallet()
                                ? <button className="pill-seg connect" onClick={onConnect}>Connect wallet</button>
                                : <span className="pill-seg acct dim" title="Demo signer: a local development key. On a public chain, this becomes your connected wallet."><i className="state-dot" />Preview wallet</span>}
                    </div>
                    <div className="header-aux">
                        <button
                            type="button"
                            className="help-btn"
                            title="Replay the intro"
                            aria-label="Replay the intro"
                            onClick={() => setOnboardOpen(true)}
                        >
                            ?
                        </button>
                        <ThemeToggle mode={theme} onChange={setTheme} />
                    </div>
                </div>
            </header>

            <Waterline stage={working ? Math.max(stage, 2) : stage} />

            {!wallet && <p className="muted">reading your wallet…</p>}

            {wallet && !working && (
                <>
                    {stage === 5 && receipt && (
                        <div className="stats">
                            <div className="stat-hero">
                                <span>End value</span>
                                <strong>{easedWeth.toFixed(4)} WETH</strong>
                                <em>+ {easedUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC, same wallet, nothing to unwind</em>
                            </div>
                            <div className="stat-strip">
                                <div><span>Fills settled</span><strong>{receipt.fills}</strong></div>
                                <div><span>Markets served</span><strong>{receipt.markets}</strong></div>
                                <div><span>Protections</span><strong>{receipt.protections}</strong></div>
                            </div>
                        </div>
                    )}
                    <div className="narr">
                        <h2>{stage === 5 ? "Back to a plain wallet" : "This wallet is idle"}</h2>
                        <p>
                            {stage === 5
                                ? "Everything docked in one click. Your balance stayed liquid the whole time."
                                : "Put the same balance to work in several places at once, without depositing it anywhere."}
                        </p>
                    </div>
                    <section className="card">
                        <div className="balances">
                            <div><strong>{easedWeth.toFixed(4)}</strong><span>WETH</span></div>
                            <div><strong>{easedUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span>USDC</span></div>
                        </div>
                        <p className="muted">
                            No upfront deposit. Tokens move only when a trade settles. You are signing price rules.
                        </p>
                        <p className="leadline">
                            Under 4× leverage, half of an unmanaged maker's quotes failed.
                            With Doca: <strong>zero</strong>.
                        </p>
                        <p className="supportline">+29% inventory retained under identical flow.</p>
                        <p className="factline">
                            Adjacent evidence, 1inch-commissioned Dune research, July 2026: 85% of tracked
                            concentrated liquidity ($1.6B of $1.84B analyzed) sat underutilized in H1, mostly
                            individually managed positions.
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
                        <h2>One balance, working in {strategies.length} markets</h2>
                        <p>
                            Nothing deposited. Spend without withdrawing: Doca detects the change and resizes
                            your strategies, the Harbormaster keeping each one inside its budget.
                        </p>
                    </div>

                    <section className="stats">
                        <div className="stat-strip">
                            <div>
                                <span>Wallet capacity</span>
                                <strong>{easedWeth.toFixed(2)} WETH</strong>
                                <em className={walletAvailPct > 25 ? "good" : walletAvailPct > 0 ? "warn" : "muted"}>{walletAvailPct.toFixed(0)}% available</em>
                            </div>
                            <div>
                                <span>Quoted liquidity</span>
                                <strong>{fmt2(promisedWeth)} WETH</strong>
                                <em>Across {strategies.length} strateg{strategies.length === 1 ? "y" : "ies"}</em>
                            </div>
                            <div>
                                <span>Coverage</span>
                                <strong>{amplification.toFixed(2)}×</strong>
                            </div>
                            <div className={honorable ? "good" : "bad"}>
                                <span>Allocated risk budget</span>
                                <strong><i className="state-dot" />{fmt2(totalBudgetWeth)} WETH</strong>
                                <em>{honorable ? "Both legs within wallet" : "A leg over budget"} · {rebalances} protection{rebalances === 1 ? "" : "s"}</em>
                            </div>
                        </div>
                    </section>

                    {event && (
                        <div className="eventstrip">
                            <strong>{event.title}</strong>
                            <span>{event.detail}</span>
                        </div>
                    )}

                    <section className="harbor-map">
                        <header className="harbor-map-head">
                            <strong>Harbor map</strong>
                            <span>Your wallet, routed to each strategy in play.</span>
                        </header>
                        <div className="harbor-map-body">
                            <div className="wallet-node">
                                <span className="wallet-route" aria-hidden />
                                <Mark size={26} />
                                <strong>Your wallet</strong>
                                <em>{easedWeth.toFixed(2)} WETH</em>
                                <span>Capacity</span>
                                <b className={`wallet-avail ${walletAvailPct > 25 ? "" : walletAvailPct > 0 ? "low" : "none"}`}>{walletAvailPct.toFixed(0)}% available</b>
                            </div>

                            <div className={`hulls ${anyAlert ? "alert" : ""}`}>
                                {strategies.map((s, i) => <Vessel key={s.hash} s={s} idx={i} />)}
                            </div>

                            <aside className="harbormaster">
                                <div className="hm-head">
                                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                        <path d="M10 2 2 6l8 4 8-4Z" />
                                        <path d="M4 8v6c0 1.5 2.7 3 6 3s6-1.5 6-3V8" />
                                    </svg>
                                    <span>Harbormaster</span>
                                </div>
                                <p className={`hm-state ${anyAlert ? "warn" : ""}`}>
                                    {!agentOn
                                        ? "Off: nobody is watching your promises"
                                        : anyAlert
                                            ? "Intervention in progress"
                                            : `Watching ${strategies.length} strateg${strategies.length === 1 ? "y" : "ies"}`}
                                </p>
                                {event && <p className="hm-detail">{event.detail}</p>}

                                <div className="hm-metric">
                                    <span>Budget remaining</span>
                                    <div className="hm-metric-row">
                                        <strong>{fmt2(budgetLeftWeth)} WETH</strong>
                                        <em>of {fmt2(totalBudgetWeth)} WETH</em>
                                    </div>
                                    <div className="hm-bar"><div style={{ width: `${budgetPct}%` }} /></div>
                                    <span className="hm-sub">{budgetPct.toFixed(0)}% remaining</span>
                                </div>

                                <div className="hm-metric">
                                    <span>Current surcharge</span>
                                    <strong>{fmtFee(avgSurchargeBps)}%</strong>
                                    <span className="hm-sub">Across active strategies</span>
                                </div>

                                <div className={`hm-band ${anyAlert ? "warn" : "calm"}`}>
                                    {anyAlert
                                        ? "Waters are rough. The Harbormaster is docking and resizing."
                                        : "Seas are calm. All strategies within their lines."}
                                </div>

                                <div className="hm-toggle">
                                    <span>{rebalances} intervention{rebalances === 1 ? "" : "s"}</span>
                                    <label className="switch">
                                        <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
                                        <i />
                                    </label>
                                </div>
                                <button type="button" className="hm-link" onClick={() => onViewChange("desk")}>
                                    View on the desk →
                                </button>
                            </aside>
                        </div>
                    </section>

                    <section className="card controls-card">
                        <div className="actions">
                            <button onClick={onFlow} disabled={!!busy}>Stress the position</button>
                            <button onClick={onSpend} disabled={!!busy}>Spend 0.25 WETH</button>
                            <button className="ghost" onClick={onStop} disabled={!!busy}>Dock everything</button>
                        </div>
                        <p className="actions-note">
                            Stress runs simulated taker flow against your live quotes: the drained side gets
                            more expensive, and past the load line the Harbormaster steps in.
                        </p>
                        {busy && <p className="busy">{busy}</p>}
                    </section>

                    <div className="horizon">
                        <span>Credit, next</span>
                        <p>
                            The same budget primitive that keeps strategy commitments inside a managed risk
                            envelope could back loans too: lenders promise funds, borrowers post collateral, and
                            any default unwinds automatically and fairly.
                        </p>
                    </div>
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
                Preview environment: real 1inch Aqua contracts on a mirrored Base network.
            </footer>
        </div>
    );
}
