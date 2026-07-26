# Doca · Brand

Tokens, type and voice for every Doca surface. The rendered version lives at
[docs/brand.html](docs/brand.html).

## Concept: Lisbon light over deep water

Doca is a day-first product. Day is a Lisbon summer morning on the docks; night is the Atlantic
after dark. Same geometry, two lights.

## Palettes

**Day ("Manhã")**, the primary theme:

- ground `#f7f3ea` (warm limestone)
- surface `#ffffff` at 60% / paper `#efe9dc`
- ink `#1c2733` (harbor slate, never pure black)
- accent `#1f5fd6` (azulejo cobalt, the brand color)
- support `#2aa198` (sea glass) · warn `#c97b2d` (terracotta, warnings only)
- danger `#c0392b` · positive `#1e8a5e`

**Night ("Madrugada")**:

- ground `#0d1626` (deep Atlantic indigo, never `#000`)
- surface `#141f33` · ink `#e9eef7`
- accent `#5b9cf5` (moonlit cobalt) · support `#37c2b4`
- lamps `#e8b34b` (harbor-lamp amber, highlights only)

Theme switch: day / night control with a `prefers-color-scheme` fallback, tokens only. No
component-level colors.

## Type

- Display: **Fraunces** (vendored via @fontsource). Headlines only, tight leading.
- UI/body: **Schibsted Grotesk** (vendored).
- Numerals: tabular-nums always; mono only for hashes.

## Motion

Tidal, not springy: long ease-outs (`cubic-bezier(0.22, 1, 0.36, 1)`), motion only where it
carries meaning. `prefers-reduced-motion` disables all ambient motion, always.

## Voice

- Guide, don't label: no numbered rails, no "step 3 of 5" chrome. Progress is a thin waterline
  that fills along the top edge.
- One idea per screen, one sentence per idea. No protocol prose in the UI.
- State is shown as a water level plus a small word, not chips shouting in caps.
- Numbers that lead are measured ones; supporting figures stay supporting.

## Mark

The D half-submerged at the waterline: a floating dock. Rounded pontoon D, gentle reflection,
subtle bob on hover. Assets in `assets/brand/` (SVG first; every asset works on both themes).
The lighthouse appears in illustrations, never as the logo.
