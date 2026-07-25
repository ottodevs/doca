# Plimsoll — design rationale

Full illustrated dossier: ask Otto for the shared link. This is the terse in-repo version.

## Narrative

Aqua solved custody: you promise liquidity, you never deposit it. Promises can exceed the wallet
by design, and the whitepaper's fix (§3) is a human docking positions by hand. Plimsoll turns that
chore into a product: budgets keep every promise honest, a Harbormaster keeps them honest while
you sleep.

## The name is the design system

The Plimsoll line is the mark on a ship's hull: load past it and you sink. Every visual maps to a
protocol primitive — nothing is decorative:

| On screen | Means | Protocol reality |
|---|---|---|
| Vessel card | One strategy | An Aqua-backed SwapVM order |
| Rising water | Budget consumed | Virtual balance drain vs budget |
| Dashed load line | Auto-dock threshold | Waterline fraction in `InventorySkewProvider` |
| SAFE / TIGHT / DOCKING | State at a glance | Remaining-budget bands |
| Surcharge badge | Price defending itself | Dynamic fee, opcode 30, quadratic past the kink |
| Harbormaster | Autopilot persona | Agent calling `dock` + `ship` |
| Storm vignette | Intervention in flight | Rebalance transaction |

## The journey is the UI

Mentor's explicit ranking: UX > user journey > legitimate use case > contracts. The rail across
the top advances as the user acts:

1. **Wallet** — recognition. Idle balances + one attributed fact (1inch's July research).
2. **Put to work** — safe leverage. Presets = one human decision. "Price rules, not a deposit."
3. **Live market** — watching it work. Water rises, surcharge wakes on the drained side only.
4. **Protected** — the punch. Storm → event strip: docked → re-shipped. Invariant stays green.
5. **Walk away** — the receipt. Markets, fills, protections, 0 deposits · 0 to unwind.

The remembered line: **"Wallet balance changed. Your quotes repaired themselves."**

## Process

v1 rebuilt the app around the journey; then an independent vision critique (GPT-5.6) over the real
screenshots vs our own review. 9 decisions accepted (event strip, hero metric, labelled metaphor,
chips, receipt, storm, solid surfaces, type scale, rail rename), 1 rejected with cause (the $1.6B
stat stays — it is 1inch's own commissioned research, so it is attributed inline, not deleted).

## Seams

- `web/src/lib/plimsoll.ts` exports everything (read/ship/dock/fill + wallet connect). The LP
  console mounts beside the journey without touching `App.tsx`.
- Wallet mode: injected wallet = maker, signs every ship/dock; fork seeding for empty accounts.
