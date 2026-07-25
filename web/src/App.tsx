import { useCallback, useEffect, useRef, useState } from "react";
import {
    d, readWallet, readStrategy, start, dock, marketFill, spendWeth, shipStrategy,
    PRESETS, fmtWeth, fmtUsdc, fmtPct, fmtFee, FRAC,
    type Preset, type Strategy, type Wallet,
} from "./lib/plimsoll";

const WATERLINE = 1_000n;         // must match the curve the provider was configured with
const FILL_SIZE = 300_000_000n;   // 300 USDC per market fill
const SPEND = 250_000_000_000_000_000n; // 0.25 WETH

type Entry = { at: string; text: string; kind: "info" | "agent" | "warn" };

export default function App() {
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [preset, setPreset] = useState<Preset>(PRESETS[1]!);
    const [busy, setBusy] = useState<string | null>(null);
    const [agentOn, setAgentOn] = useState(false);
    const [log, setLog] = useState<Entry[]>([]);
    const [phantomsAvoided, setPhantomsAvoided] = useState(0);
    const saltRef = useRef(1);

    const say = useCallback((text: string, kind: Entry["kind"] = "info") => {
        const at = new Date().toLocaleTimeString();
        setLog((l) => [{ at, text, kind }, ...l].slice(0, 40));
    }, []);

    const refresh = useCallback(async () => {
        setWallet(await readWallet());
        if (strategies.length > 0) setStrategies(await Promise.all(strategies.map(readStrategy)));
    }, [strategies]);

    useEffect(() => { readWallet().then(setWallet); }, []);
    useEffect(() => {
        const t = setInterval(() => { refresh().catch(() => {}); }, 2500);
        return () => clearInterval(t);
    }, [refresh]);

    // The agent: docks anything under its waterline and re-promises against real balances.
    useEffect(() => {
        if (!agentOn || strategies.length === 0) return;
        const t = setInterval(async () => {
            const fresh = await Promise.all(strategies.map(readStrategy));
            const sinking = fresh.find((s) => s.remaining <= WATERLINE);
            if (!sinking) return;
            try {
                say(`strategy ${sinking.hash.slice(0, 10)} is under its waterline, docking`, "agent");
                await dock(sinking);
                const w = await readWallet();
                const budgetWeth = w.weth / BigInt(fresh.length);
                const budgetUsdc = w.usdc / BigInt(fresh.length);
                const replacement = await shipStrategy(
                    BigInt(1000 + saltRef.current++),
                    w.weth, w.usdc, budgetWeth, budgetUsdc,
                );
                setStrategies((prev) => prev.map((s) => (s.hash === sinking.hash ? replacement : s)));
                setPhantomsAvoided((n) => n + 1);
                say(`re-promised against real balances: ${fmtWeth(w.weth)} WETH available`, "agent");
            } catch (e: any) {
                say(`agent could not rebalance: ${String(e?.shortMessage ?? e).slice(0, 60)}`, "warn");
            }
        }, 3500);
        return () => clearInterval(t);
    }, [agentOn, strategies, say]);

    const onStart = async () => {
        if (!wallet) return;
        setBusy(`putting your balance to work in ${preset.count} places`);
        try {
            const shipped = await start(preset, wallet);
            setStrategies(shipped);
            say(`${preset.count} promises shipped through the canonical Aqua registry`);
            setAgentOn(true);
        } finally { setBusy(null); }
    };

    const onFlow = async () => {
        if (strategies.length === 0) return;
        setBusy("market flow trading against your balance");
        try {
            for (let i = 0; i < 8; i++) {
                const target = strategies[i % strategies.length]!;
                const r = await marketFill(target, FILL_SIZE);
                if (!r.ok) say(`a fill on ${target.hash.slice(0, 10)} could not be honored`, "warn");
            }
            say("8 fills went through, real WETH left the wallet and USDC came in");
            await refresh();
        } finally { setBusy(null); }
    };

    const onSpend = async () => {
        setBusy("sending 0.25 WETH out of the same wallet");
        try {
            await spendWeth(SPEND);
            say("spent 0.25 WETH while earning, nothing had to be withdrawn first");
            await refresh();
        } finally { setBusy(null); }
    };

    const onStop = async () => {
        setBusy("docking everything");
        try {
            for (const s of strategies) await dock(s);
            setStrategies([]);
            setAgentOn(false);
            say("everything docked, your full balance is available right now");
            await refresh();
        } finally { setBusy(null); }
    };

    const promisedWeth = strategies.reduce((a, s) => a + s.promisedWeth, 0n);
    const budgetedWeth = strategies.reduce((a, s) => a + s.budgetWeth, 0n);
    const amplification = wallet && wallet.weth > 0n ? Number(promisedWeth) / Number(wallet.weth) : 0;
    const honorable = wallet ? budgetedWeth <= wallet.weth : true;

    return (
        <div className="page">
            <header>
                <div>
                    <h1>Plimsoll</h1>
                    <p className="tag">Keep your wallet. Put it to work anyway.</p>
                </div>
                <div className="chain">
                    <span className="dot" /> Base fork · block {d.forkBlock.toLocaleString()}
                    <code>Aqua {d.aqua.slice(0, 10)}…</code>
                </div>
            </header>

            {!wallet && <p className="muted">reading your wallet…</p>}

            {wallet && strategies.length === 0 && (
                <section className="card">
                    <h2>Your wallet is idle</h2>
                    <div className="balances">
                        <div><strong>{fmtWeth(wallet.weth)}</strong><span>WETH</span></div>
                        <div><strong>{fmtUsdc(wallet.usdc)}</strong><span>USDC</span></div>
                    </div>
                    <p className="muted">
                        Nothing leaves this wallet. You are signing price rules, not a deposit.
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
                            </button>
                        ))}
                    </div>

                    <button className="primary" onClick={onStart} disabled={!!busy}>
                        {busy ?? "Start earning"}
                    </button>
                </section>
            )}

            {strategies.length > 0 && wallet && (
                <>
                    <section className="tiles">
                        <div className="tile">
                            <span>In your wallet</span>
                            <strong>{fmtWeth(wallet.weth)} WETH</strong>
                            <em>{fmtUsdc(wallet.usdc)} USDC</em>
                        </div>
                        <div className="tile">
                            <span>Promised to strategies</span>
                            <strong>{fmtWeth(promisedWeth)} WETH</strong>
                            <em>{amplification.toFixed(2)}× your balance</em>
                        </div>
                        <div className="tile">
                            <span>Budgeted</span>
                            <strong>{fmtWeth(budgetedWeth)} WETH</strong>
                            <em>{honorable ? "every promise can be honored" : "over budget"}</em>
                        </div>
                        <div className={`tile ${honorable ? "good" : "bad"}`}>
                            <span>Quotes you can honor</span>
                            <strong>{honorable ? "all of them" : "at risk"}</strong>
                            <em>{phantomsAvoided} rebalances by the agent</em>
                        </div>
                    </section>

                    <section className="card">
                        <div className="row">
                            <h2>Working in {strategies.length} places</h2>
                            <label className="toggle">
                                <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
                                agent
                            </label>
                        </div>

                        {strategies.map((s) => {
                            const pct = Number(s.remaining) / Number(FRAC) * 100;
                            const state = s.remaining <= WATERLINE ? "sinking" : pct < 40 ? "warn" : "ok";
                            return (
                                <div className={`strategy ${state}`} key={s.hash}>
                                    <code>{s.hash.slice(0, 14)}…</code>
                                    <div className="bar"><div style={{ width: `${Math.max(pct, 2)}%` }} /></div>
                                    <span className="pct">{fmtPct(s.remaining)}% budget left</span>
                                    <span className="left">{fmtWeth(s.wethLeft)} WETH in it</span>
                                    <span className="fee">{fmtFee(s.surchargeBps)}% surcharge</span>
                                </div>
                            );
                        })}

                        <div className="actions">
                            <button onClick={onFlow} disabled={!!busy}>Market flow</button>
                            <button onClick={onSpend} disabled={!!busy}>Spend 0.25 WETH</button>
                            <button className="ghost" onClick={onStop} disabled={!!busy}>Stop everything</button>
                        </div>
                        {busy && <p className="muted">{busy}…</p>}
                    </section>
                </>
            )}

            <section className="log">
                {log.map((e, i) => (
                    <div key={i} className={e.kind}>
                        <span>{e.at}</span> {e.text}
                    </div>
                ))}
            </section>

            <footer className="muted">
                Canonical 1inch Aqua registry, official SwapVM router code, real WETH and USDC on a fork of Base.
                Demo signs with a local development key; on a public chain this is a wallet connector.
            </footer>
        </div>
    );
}
