#!/bin/bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
command -v docker >/dev/null || { echo 'Install Docker Engine and Compose first, then rerun. No business services have been modified.' >&2; exit 1; }
docker compose version >/dev/null
if [[ ! -f .env ]]; then
  docker run --rm -it -v "$root:/setup" -w /setup node:24-bookworm-slim node scripts/setup.mjs self-hosted
fi
docker run --rm -v "$root:/setup" -w /setup node:24-bookworm-slim node scripts/build-assets.mjs
docker compose --project-name server-observer --env-file .env -f self-hosted/compose.yaml config --quiet
docker compose --project-name server-observer --env-file .env -f self-hosted/compose.yaml up -d --build observer
echo 'Backend started on 127.0.0.1:8788. See SELF_HOSTED.md for your existing reverse proxy or optional Caddy TLS profile.'
echo 'This script does not stop Docker, replace a reverse proxy, or restart business services.'
