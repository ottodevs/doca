// Exercises the exact functions the UI calls, against the anvil fork of Base.
import {
    readWallet, readStrategy, start, dock, marketFill, spendWeth,
    PRESETS, fmtWeth, fmtUsdc, fmtPct, fmtFee,
} from "../src/lib/plimsoll";

const w0 = await readWallet();
console.log(`wallet: ${fmtWeth(w0.weth)} WETH / ${fmtUsdc(w0.usdc)} USDC`);

const preset = PRESETS[1]!;
console.log(`\nstart: ${preset.label} (${preset.count} places, factor ${preset.promiseFactor})`);
let strategies = await start(preset, w0);
const promised = strategies.reduce((a, s) => a + s.promisedWeth, 0n);
console.log(`  promised ${fmtWeth(promised)} WETH = ${(Number(promised) / Number(w0.weth)).toFixed(2)}x wallet`);
console.log(`  budgeted ${fmtWeth(strategies.reduce((a, s) => a + s.budgetWeth, 0n))} WETH`);

console.log("\nmarket flow, 12 fills round robin:");
let failed = 0;
for (let i = 0; i < 12; i++) {
    const t = strategies[i % strategies.length]!;
    const r = await marketFill(t, 300_000_000n);
    if (!r.ok) { failed++; console.log(`  fill ${i + 1} not honored: ${r.reason}`); }
}
strategies = await Promise.all(strategies.map(readStrategy));
for (const s of strategies) {
    console.log(`  ${s.hash.slice(0, 12)}  budget ${fmtPct(s.remaining)}%  ${fmtWeth(s.wethLeft)} WETH  surcharge ${fmtFee(s.surchargeBps)}%`);
}
console.log(`  fills not honored: ${failed}`);

console.log("\nspending 0.25 WETH from the same wallet while it earns");
await spendWeth(250_000_000_000_000_000n);
const w1 = await readWallet();
console.log(`  wallet now ${fmtWeth(w1.weth)} WETH / ${fmtUsdc(w1.usdc)} USDC`);

console.log("\nstop: docking everything");
for (const s of strategies) await dock(s);
const w2 = await readWallet();
console.log(`  available immediately: ${fmtWeth(w2.weth)} WETH / ${fmtUsdc(w2.usdc)} USDC`);
