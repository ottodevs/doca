#!/usr/bin/env bash
# Fast-iteration deploy: local build, prebuilt push to Cloudflare Pages (~seconds).
# Uses the wrangler OAuth session (`bunx wrangler login`) or CLOUDFLARE_API_TOKEN with Pages:Edit.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f ~/.config/doca/deploy.env ] && set -a && . ~/.config/doca/deploy.env && set +a
bun site/build.mjs
bunx wrangler pages deploy site/dist --project-name doca-finance --commit-dirty=true
