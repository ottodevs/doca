# Doca — Brand North Star

Single source of truth for every design agent and session tonight. If your output contradicts
this file, this file wins. If you improve on it, PR the change here first.

## Concept: Lisbon light over deep water

Doca is a **day-first** product — the single loudest break from DeFi's black-screen slop. Day is
a Lisbon summer morning on the docks; night is the Atlantic after dark. Same geometry, two lights.

## Palettes (tokens, not suggestions)

**Day ("Manhã")** — primary theme:
- ground `#f7f3ea` (warm limestone, not cream-AI-beige: cooler, mineral)
- surface `#ffffff` at 60% / paper `#efe9dc`
- ink `#1c2733` (harbor slate, never pure black)
- accent `#1f5fd6` (azulejo cobalt — THE brand color)
- support `#2aa198` (sea glass) · warn `#c97b2d` (terracotta, SPARINGLY — warnings only)
- danger `#c0392b` · positive `#1e8a5e`

**Night ("Madrugada")**:
- ground `#0d1626` (deep Atlantic indigo — NOT #000, NOT the old #05080d)
- surface `#141f33` · ink `#e9eef7`
- accent `#5b9cf5` (moonlit cobalt) · support `#37c2b4`
- lamps `#e8b34b` (harbor-lamp amber for highlights/CTAs' glow)

Theme switch: **day / night / system** control, `data-theme` attribute + `prefers-color-scheme`
fallback, tokens only — no component-level colors.

## Type

- Display: **Fraunces** (vendored via @fontsource) — warm, characterful, the azulejo-shop serif.
  Headlines only, tight leading, optical sizes.
- UI/body: **Schibsted Grotesk** (vendored) — fresh, not Inter, not Space Grotesk.
- Numerals/data: tabular-nums always; mono only for hashes.

## Motion

Tidal, not springy: long ease-outs (`cubic-bezier(0.22, 1, 0.36, 1)`), slow ambient water, GSAP
ScrollTrigger on the landing (vendored, no CDN), R3F/three only where it carries meaning (water).
`prefers-reduced-motion` kills all ambient motion, always.

## Voice & journey

- Guide, don't label: **no numbered rails, no "step 3/5" chrome**. Progress is a thin waterline
  that fills along the top edge. The interface accompanies; it never lectures.
- One idea per screen, one sentence per idea. No protocol prose in the UI.
- Never say "user journey/persona/happy path" in any user-facing surface — that is our internal
  scaffolding, invisible by definition.

## Numbers (which ones lead)

- LEAD: **"Under 4× leverage, half of an unmanaged maker's quotes failed. With Doca: zero."**
- LEAD: **"+29% inventory retained under identical flow."**
- SUPPORT (never headline): +1.99% realized price, $-figures.
- PROBLEM STAT: 85% / $1.6B idle (1inch's own research) — keep, attributed.

## Components — kill list

- ❌ left-border accent cards · ❌ uppercase-letterspaced labels everywhere · ❌ glow-on-everything
- ❌ 4-equal-tiles rows · ❌ numbered step circles · ❌ cyan-on-near-black defaults
- ✅ soft warm shadows (day), thin strokes (night) · ✅ one hero number per view
- ✅ state shown as water level + a small word, not chips shouting in caps

## Mark

The **D half-submerged at the waterline** stays as the core idea — refine toward "a floating
dock": rounded pontoon D, gentle reflection, subtle bob animation on hover. Assets in
`assets/brand/` (SVG first; every asset works on both themes).

## Centerpiece hierarchy (what the product is about)

1. **The Harbormaster** — ease: it watches so you don't.
2. **Vs a traditional AMM** — nothing deposited, spend any time, one balance many markets.
3. **The credit horizon** — lending/borrowing as a visible concept (teaser panel, "coming next"),
   powered by the same budget primitive. Concept only; no fake numbers.

Aligned with what 1inch expects from Aqua apps: sophisticated position, SwapVM depth, real
transfers in the demo, honest limitations.
