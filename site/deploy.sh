#!/usr/bin/env bash
# Fast-iteration deploy: local build, prebuilt push to Cloudflare Pages (~seconds).
# Needs CLOUDFLARE_API_TOKEN with Pages:Edit (env or ~/.config/doca/deploy.env).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f ~/.config/doca/deploy.env ] && set -a && . ~/.config/doca/deploy.env && set +a
bun site/build.mjs
bunx wrangler pages deploy site/dist --project-name doca --commit-dirty=true
