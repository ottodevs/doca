# Headless keeper scaffold (not wired in)

This directory is a skeleton for a future headless Harbormaster keeper
(observe / decide / execute). Nothing here runs in the demo and nothing
imports it: the live keeper is the browser loop in `web/src/App.tsx`,
which watches waterlines and signs dock / re-ship with the maker's own
signer. The write path here intentionally stops at TODO stubs.
