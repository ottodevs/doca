// SPDX-License-Identifier: MIT
//
// Beefy CLM-style Position Performance chart.
// Two lines on one USD axis: Position Value vs HOLD Value.
import { useEffect, useMemo, useState } from "react";
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
    type PnlSample,
    type SpotHour,
} from "./lib/pnl";

type Props = {
    hours: SpotHour[];
    bases: PositionBasisLive[];
    live: LiveStrategy[];
    /** Real Base Uniswap USDC/WETH (HOLD). */
    spot: number | null;
    /** Local fork implied USDC/WETH (Position). */
    forkSpot: number | null;
    priceError: string | null;
};

const GRID = "#363b63";
const AXIS = "#363b63";
const POS = "#5c70d6";
const HOLD = "#999cb3";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RANGES = [
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

function ChartTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload as PnlSample | undefined;
    if (!row) return null;
    return (
        <div className="pnl-tooltip">
            <div className="pnl-tooltip-time">{new Date(row.at).toLocaleString()}</div>
            <div className="pnl-tooltip-row">
                <span>Position value</span>
                <strong style={{ color: POS }}>{fmtUsd(row.positionUsdc)}</strong>
            </div>
            <div className="pnl-tooltip-row">
                <span>HOLD value</span>
                <strong style={{ color: HOLD }}>{fmtUsd(row.holdUsdc)}</strong>
            </div>
            <div className="pnl-tooltip-row">
                <span>vs HOLD</span>
                <strong className={row.pnlUsdc >= 0 ? "good" : "bad"}>{fmtUsd(row.pnlUsdc, true)}</strong>
            </div>
            <div className="pnl-tooltip-row">
                <span>Base spot</span>
                <strong>${row.spot.toFixed(2)}</strong>
            </div>
            {row.forkSpot != null && (
                <div className="pnl-tooltip-row">
                    <span>Fork spot</span>
                    <strong>${row.forkSpot.toFixed(2)}</strong>
                </div>
            )}
        </div>
    );
}

export default function PnlChart({ hours, bases, live, spot, forkSpot, priceError }: Props) {
    const hold = useMemo(() => sumHold(bases), [bases]);
    const position = useMemo(() => sumPosition(live), [live]);

    const tipReal: SpotHour | null = spot != null
        ? { at: Date.now(), usdcPerWeth: spot }
        : null;
    const tipFork: SpotHour | null = forkSpot != null
        ? { at: Date.now(), usdcPerWeth: forkSpot }
        : null;

    const series = useMemo(
        () => buildPnlSeries(hours, hold, position, tipReal, tipFork),
        [hours, hold, position, tipReal?.usdcPerWeth, tipFork?.usdcPerWeth],
    );

    const [stable, setStable] = useState<PnlSample[]>([]);
    useEffect(() => {
        setStable((prev) => (samplesEqual(prev, series) ? prev : series));
    }, [series]);

    // Prefer stable (avoids tip-timestamp flicker) but don't stay empty if series is ready.
    const plot = stable.length >= 2 ? stable : series;

    const [rangeId, setRangeId] = useState<RangeId>("all");
    const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[RANGES.length - 1]!;

    const end = plot.length ? plot[plot.length - 1]!.at : Date.now();
    const startAll = plot.length ? plot[0]!.at : end;
    const start = range.id === "all" ? startAll : Math.max(startAll, end - range.ms);

    const data = useMemo(() => {
        return plot
            .filter((s) => s.at >= start && s.at <= end)
            .map((s) => ({ ...s, t: s.at }));
    }, [plot, start, end]);

    const { min: yMin, max: yMax, ticks: yTicks } = useMemo(() => {
        const vals: number[] = [];
        for (const s of data) {
            vals.push(s.positionUsdc, s.holdUsdc);
        }
        return yDomain(vals);
    }, [data]);

    const xDomain = useMemo(() => [start, end] as [number, number], [start, end]);
    const yDomainMemo = useMemo(() => [yMin, yMax] as [number, number], [yMin, yMax]);
    const spanMs = end - start || range.ms;

    const depositWeth = bases.reduce((n, b) => n + b.weth, 0n);
    const depositUsdc = bases.reduce((n, b) => n + b.usdc, 0n);
    const liveWeth = live.reduce((n, s) => n + s.wethLeft, 0n);
    const liveUsdc = live.reduce((n, s) => n + s.usdcLeft, 0n);

    const latest = data[data.length - 1];
    const depositUsd = spot != null ? hold.weth * spot + hold.usdc : latest?.holdUsdc ?? 0;
    const markPos = forkSpot ?? spot;
    const nowUsd = markPos != null ? position.weth * markPos + position.usdc : latest?.positionUsdc ?? 0;
    const pnlUsd = nowUsd - depositUsd;
    const pnlClass = pnlUsd > 0.005 ? "good" : pnlUsd < -0.005 ? "bad" : "";

    const empty = data.length < 2;
    const noPosition = bases.length === 0;

    return (
        <section className="pnl-beefy">
            <div className="pnl-beefy-card-header">
                <h2 className="pnl-beefy-title">Position Performance</h2>
                <div className="pnl-beefy-spot muted">
                    {spot != null ? `HOLD $${spot.toFixed(2)}` : "HOLD —"}
                    {forkSpot != null ? ` · Position $${forkSpot.toFixed(2)}` : ""}
                    {hours.length ? ` · ${hours.length}h history` : ""}
                    {priceError ? ` · ${priceError}` : ""}
                </div>
            </div>

            <div className="pnl-beefy-stats">
                <div className="pnl-stat">
                    <div className="pnl-stat-label">At Deposit</div>
                    <div className="pnl-stat-row">
                        <span>{bases.length ? `${fmtWeth(depositWeth)} WETH` : "—"}</span>
                        <span className="pnl-stat-sub">{bases.length ? fmtUsd(depositUsd) : ""}</span>
                    </div>
                    <div className="pnl-stat-row">
                        <span>{bases.length ? `${fmtUsdc(depositUsdc)} USDC` : "—"}</span>
                    </div>
                </div>
                <div className="pnl-stat">
                    <div className="pnl-stat-label">Now</div>
                    <div className="pnl-stat-row">
                        <span>{live.length ? `${fmtWeth(liveWeth)} WETH` : "—"}</span>
                        <span className="pnl-stat-sub">{live.length ? fmtUsd(nowUsd) : ""}</span>
                    </div>
                    <div className="pnl-stat-row">
                        <span>{live.length ? `${fmtUsdc(liveUsdc)} USDC` : "—"}</span>
                    </div>
                </div>
                <div className="pnl-stat">
                    <div className="pnl-stat-label">Change</div>
                    <div className="pnl-stat-row">
                        <span className={pnlClass}>
                            {bases.length ? `${fmtUsd(pnlUsd, true)} PNL` : "—"}
                        </span>
                    </div>
                    <div className="pnl-stat-row pnl-stat-hold">
                        <span>{bases.length ? `${fmtUsd(depositUsd)} HOLD` : "—"}</span>
                    </div>
                </div>
            </div>

            <div className="pnl-beefy-graph">
                {noPosition ? (
                    <p className="pnl-nodata muted">Ship a strategy to start tracking Position vs HOLD.</p>
                ) : empty ? (
                    <p className="pnl-nodata muted">
                        Waiting for Uniswap hourly history
                        {hours.length === 0 ? " (subgraph refresh on the dev server)." : "…"}
                    </p>
                ) : (
                    <div className="pnl-rechart" style={{ width: "100%", height: 220 }}>
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
                                minTickGap={56}
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
                                type="monotone"
                                dataKey="positionUsdc"
                                name="Position"
                                stroke={POS}
                                strokeWidth={1.5}
                                dot={false}
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
                                onClick={() => setRangeId(r.id)}
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
