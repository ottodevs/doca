// SPDX-License-Identifier: MIT
//
// Beefy CLM-style Position Performance chart.
// Two lines on one USD axis: Position Value vs HOLD Value (same L1 spot).
import { useEffect, useMemo, useRef, useState } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { LiveStrategy } from "./lib/lp-desk";
import { fmtUsdc, fmtWeth } from "./lib/lp-desk";
import {
    WEEK_MS,
    buildPnlSeries,
    samplesEqual,
    sumHold,
    sumPosition,
    type PositionBasisLive,
    type PositionHistoryTick,
    type PnlSample,
    type SpotHour,
} from "./lib/pnl";

type Props = {
    ticks: PositionHistoryTick[];
    bases: PositionBasisLive[];
    live: LiveStrategy[];
    /** Real Base Uniswap USDC/WETH (both lines). */
    spot: number | null;
    /** Local fork implied USDC/WETH (header only). */
    forkSpot: number | null;
    priceError: string | null;
};

function cssVar(name: string, fallback: string): string {
    if (typeof document === "undefined") return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

/** Read the chart's theme colors fresh on every render (tokens can flip with data-theme). */
function chartColors() {
    return {
        grid: cssVar("--line", "#363b63"),
        axis: cssVar("--line", "#363b63"),
        pos: cssVar("--positive", "#1e8a5e"),
        hold: cssVar("--muted", "#63738a"),
    };
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RANGES = [
    { id: "1m", label: "1M", ms: MINUTE },
    { id: "10m", label: "10M", ms: 10 * MINUTE },
    { id: "1h", label: "1H", ms: HOUR },
    { id: "1d", label: "1D", ms: DAY },
    { id: "1w", label: "1W", ms: WEEK_MS },
    { id: "all", label: "ALL", ms: WEEK_MS },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

function fmtUsd(n: number, signed = false): string {
    const abs = Math.abs(n);
    const body = abs.toLocaleString(undefined, {
        maximumFractionDigits: abs >= 1000 ? 0 : 2,
        minimumFractionDigits: abs >= 1000 ? 0 : 2,
    });
    if (!signed) return n < 0 ? `-$${body}` : `$${body}`;
    if (n > 0.005) return `+$${body}`;
    if (n < -0.005) return `-$${body}`;
    return `$${body}`;
}

function fmtAxis(n: number): string {
    if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString()}`;
    return `$${n.toFixed(0)}`;
}

function fmtTime(ts: number, spanMs: number): string {
    const d = new Date(ts);
    if (spanMs <= 15 * MINUTE) {
        return d.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
    if (spanMs <= DAY * 1.5) {
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function yDomain(values: number[]): { min: number; max: number; ticks: number[] } {
    if (values.length === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (!(hi > lo)) {
        const pad = Math.max(Math.abs(hi) * 0.02, 1);
        lo -= pad;
        hi += pad;
    } else {
        const pad = (hi - lo) * 0.12;
        lo = Math.max(0, lo - pad);
        hi += pad;
    }
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
    return { min: lo, max: hi, ticks };
}

/** Samples in [start, end], with a carry-forward point at `start` so short windows aren't empty on the left. */
function windowSeries(plot: PnlSample[], start: number, end: number): (PnlSample & { t: number })[] {
    if (plot.length === 0) return [];

    let before: PnlSample | null = null;
    const inside: PnlSample[] = [];
    for (const s of plot) {
        if (s.at < start) before = s;
        else if (s.at <= end) inside.push(s);
    }

    const out: PnlSample[] = [];
    if (inside.length === 0) {
        const seed = before ?? plot[plot.length - 1]!;
        out.push({ ...seed, at: start });
        if (end > start) out.push({ ...seed, at: end });
    } else {
        if (inside[0]!.at > start) {
            const seed = before ?? inside[0]!;
            out.push({ ...seed, at: start });
        }
        out.push(...inside);
        const last = out[out.length - 1]!;
        if (last.at < end - 1_000) {
            out.push({ ...last, at: end });
        }
    }

    return out.map((s) => ({ ...s, t: s.at }));
}

function ChartTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload as PnlSample | undefined;
    if (!row) return null;
    const { pos, hold } = chartColors();
    return (
        <div className="pnl-tooltip">
            <div className="pnl-tooltip-time">{new Date(row.at).toLocaleString()}</div>
            <div className="pnl-tooltip-row">
                <span>Position value</span>
                <strong style={{ color: pos }}>{fmtUsd(row.positionUsdc)}</strong>
            </div>
            <div className="pnl-tooltip-row">
                <span>HOLD value</span>
                <strong style={{ color: hold }}>{fmtUsd(row.holdUsdc)}</strong>
            </div>
            <div className="pnl-tooltip-row">
                <span>vs HOLD</span>
                <strong className={row.pnlUsdc >= 0 ? "good" : "bad"}>{fmtUsd(row.pnlUsdc, true)}</strong>
            </div>
            {(row.wethLeft != null || row.usdcLeft != null) && (
                <div className="pnl-tooltip-row">
                    <span>Inventory</span>
                    <strong>
                        {(row.wethLeft ?? 0).toFixed(4)} WETH · {(row.usdcLeft ?? 0).toFixed(2)} USDC
                    </strong>
                </div>
            )}
            <div className="pnl-tooltip-row">
                <span>Base spot</span>
                <strong>${row.spot.toFixed(2)}</strong>
            </div>
        </div>
    );
}

export default function PnlChart({ ticks, bases, live, spot, forkSpot, priceError }: Props) {
    // Recomputed every render so a theme flip (data-theme) is picked up immediately;
    // recharts already re-renders this component on every data tick.
    const { grid: GRID, axis: AXIS, pos: POS, hold: HOLD } = chartColors();
    const hold = useMemo(() => sumHold(bases), [bases]);
    const position = useMemo(() => sumPosition(live), [live]);

    const tipReal: SpotHour | null = spot != null
        ? { at: Date.now(), usdcPerWeth: spot }
        : null;

    const series = useMemo(
        () => buildPnlSeries(ticks, hold, position, tipReal),
        [ticks, hold, position, tipReal?.usdcPerWeth],
    );

    const [stable, setStable] = useState<PnlSample[]>([]);
    useEffect(() => {
        setStable((prev) => (samplesEqual(prev, series) ? prev : series));
    }, [series]);

    // Prefer stable (avoids tip-timestamp flicker) but don't stay empty if series is ready.
    const plot = stable.length >= 2 ? stable : series;

    // Live demos default to 10M so ship/trade steps aren't crushed on a week axis.
    const [rangeId, setRangeId] = useState<RangeId>("10m");
    const [userPickedRange, setUserPickedRange] = useState(false);
    const lastShipRef = useRef<number>(0);

    useEffect(() => {
        if (userPickedRange) return;
        if (!(hold.since > 0)) return;
        // Fresh ship / new session → keep the live 10M view.
        if (hold.since !== lastShipRef.current) {
            lastShipRef.current = hold.since;
            setRangeId("10m");
        }
    }, [hold.since, userPickedRange]);

    const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[0]!;
    const liveWindow = range.id === "1m" || range.id === "10m" || range.id === "1h";

    const end = plot.length ? plot[plot.length - 1]!.at : Date.now();
    const startAll = plot.length ? plot[0]!.at : end;
    // Fixed-width windows (10M/1H/…) so live steps aren't crushed on a week axis.
    const start = range.id === "all" ? startAll : end - range.ms;

    const data = useMemo(
        () => windowSeries(plot, start, end),
        [plot, start, end],
    );

    const { min: yMin, max: yMax, ticks: yTicks } = useMemo(() => {
        const vals: number[] = [];
        for (const s of data) {
            vals.push(s.positionUsdc, s.holdUsdc);
        }
        return yDomain(vals);
    }, [data]);

    const xDomain = useMemo(() => [start, end] as [number, number], [start, end]);
    const yDomainMemo = useMemo(() => [yMin, yMax] as [number, number], [yMin, yMax]);
    const spanMs = Math.max(end - start, liveWindow ? range.ms : 1);

    const depositWeth = bases.reduce((n, b) => n + b.weth, 0n);
    const depositUsdc = bases.reduce((n, b) => n + b.usdc, 0n);
    const liveWeth = live.reduce((n, s) => n + s.wethLeft, 0n);
    const liveUsdc = live.reduce((n, s) => n + s.usdcLeft, 0n);

    // At Deposit: deposit inventory × spot nearest ship time (not window-start).
    const depositSample = plot.find((s) => s.at >= hold.since - 5_000)
        ?? data.find((s) => Math.abs(s.pnlUsdc) < 0.01)
        ?? data[0];
    const latest = data[data.length - 1];
    const depositUsd = depositSample?.holdUsdc
        ?? (spot != null ? hold.weth * spot + hold.usdc : 0);
    const nowUsd = latest?.positionUsdc
        ?? (spot != null ? position.weth * spot + position.usdc : 0);
    const pnlUsd = nowUsd - depositUsd;
    const pnlClass = pnlUsd > 0.005 ? "good" : pnlUsd < -0.005 ? "bad" : "";

    const empty = data.length < 2;
    const noPosition = bases.length === 0;
    const priceHours = new Set(
        ticks.filter((t) => t.usdcPerWeth > 0).map((t) => Math.floor(t.at / HOUR) * HOUR),
    ).size;
    const balanceTicks = ticks.filter((t) => (t.strategyCount ?? 0) > 0
        || (t.wethLeft ?? 0) > 0
        || (t.usdcLeft ?? 0) > 0).length;

    const posDot = liveWindow
        ? { r: 3, strokeWidth: 0, fill: POS }
        : false;

    return (
        <section className="pnl-beefy">
            <div className="pnl-beefy-card-header">
                <h2 className="pnl-beefy-title">Position Performance</h2>
                <div className="pnl-beefy-spot muted">
                    {spot != null ? `Base $${spot.toFixed(2)}` : "Base -"}
                    {forkSpot != null ? ` · Fork $${forkSpot.toFixed(2)}` : ""}
                    {liveWindow
                        ? ` · live ${range.label}`
                        : priceHours
                            ? ` · ${priceHours}h history`
                            : ""}
                    {balanceTicks ? ` · ${balanceTicks} inventory ticks` : ""}
                    {priceError ? ` · ${priceError}` : ""}
                </div>
            </div>

            <div className="pnl-beefy-stats">
                <div className="pnl-stat">
                    <div className="pnl-stat-label">At Deposit</div>
                    <div className="pnl-stat-row">
                        <span>{bases.length ? `${fmtWeth(depositWeth)} WETH` : "-"}</span>
                        <span className="pnl-stat-sub">{bases.length ? fmtUsd(depositUsd) : ""}</span>
                    </div>
                    <div className="pnl-stat-row">
                        <span>{bases.length ? `${fmtUsdc(depositUsdc)} USDC` : "-"}</span>
                    </div>
                </div>
                <div className="pnl-stat">
                    <div className="pnl-stat-label">Now</div>
                    <div className="pnl-stat-row">
                        <span>{live.length ? `${fmtWeth(liveWeth)} WETH` : "-"}</span>
                        <span className="pnl-stat-sub">{live.length ? fmtUsd(nowUsd) : ""}</span>
                    </div>
                    <div className="pnl-stat-row">
                        <span>{live.length ? `${fmtUsdc(liveUsdc)} USDC` : "-"}</span>
                    </div>
                </div>
                <div className="pnl-stat">
                    <div className="pnl-stat-label">Change</div>
                    <div className="pnl-stat-row">
                        <span className={pnlClass}>
                            {bases.length ? `${fmtUsd(pnlUsd, true)} PNL` : "-"}
                        </span>
                    </div>
                    <div className="pnl-stat-row pnl-stat-hold">
                        <span>{bases.length ? `${fmtUsd(nowUsd - pnlUsd)} HOLD` : "-"}</span>
                    </div>
                </div>
            </div>

            <div className="pnl-beefy-graph">
                {noPosition ? (
                    <p className="pnl-nodata muted">Ship a strategy to start tracking Position vs HOLD.</p>
                ) : empty ? (
                    <p className="pnl-nodata muted">Loading price history…</p>
                ) : (
                    <div className="pnl-rechart" style={{ width: "100%", height: liveWindow ? 260 : 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={data} margin={{ top: 16, right: 28, bottom: 4, left: 12 }}>
                            <CartesianGrid strokeDasharray="2 2" stroke={GRID} />
                            <XAxis
                                dataKey="t"
                                type="number"
                                domain={xDomain}
                                allowDataOverflow
                                tickFormatter={(ts: number) => fmtTime(ts, spanMs)}
                                stroke={AXIS}
                                tickMargin={8}
                                minTickGap={liveWindow ? 40 : 56}
                                fontSize={11}
                                scale="time"
                            />
                            <YAxis
                                yAxisId="usd"
                                orientation="right"
                                domain={yDomainMemo}
                                ticks={yTicks}
                                tickFormatter={fmtAxis}
                                stroke={POS}
                                strokeWidth={1.5}
                                mirror
                                width={58}
                                fontSize={11}
                                allowDataOverflow
                            />
                            <Tooltip content={<ChartTooltip />} />
                            <Line
                                yAxisId="usd"
                                type="monotone"
                                dataKey="holdUsdc"
                                name="HOLD"
                                stroke={HOLD}
                                strokeWidth={1.5}
                                dot={false}
                                isAnimationActive={false}
                            />
                            <Line
                                yAxisId="usd"
                                type={liveWindow ? "stepAfter" : "monotone"}
                                dataKey="positionUsdc"
                                name="Position"
                                stroke={POS}
                                strokeWidth={2}
                                dot={posDot}
                                activeDot={{ r: 4, fill: POS }}
                                isAnimationActive={false}
                            />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>

            {!noPosition && !empty && (
                <div className="pnl-beefy-footer">
                    <div className="pnl-legend">
                        <div className="pnl-legend-item">
                            <span className="pnl-legend-line" style={{ background: POS }} />
                            Position Value
                        </div>
                        <div className="pnl-legend-item">
                            <span className="pnl-legend-line" style={{ background: HOLD }} />
                            HOLD Value
                        </div>
                    </div>
                    <div className="pnl-periods" role="group" aria-label="Time range">
                        {RANGES.map((r) => (
                            <button
                                key={r.id}
                                type="button"
                                className={r.id === rangeId ? "on" : ""}
                                onClick={() => {
                                    setUserPickedRange(true);
                                    setRangeId(r.id);
                                }}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}
