#!/bin/bash
set -euo pipefail
for tool in curl unzip sha256sum awk mktemp; do command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }; done
name=server-observer-self-hosted-v0.1.0.zip
origin=https://raw.githubusercontent.com/Kimari-0523/server-observer/main
destination=${OBSERVER_INSTALL_DIR:-"$PWD/server-observer-self-hosted"}
[[ ! -e "$destination" ]] || { echo 'Destination exists; choose a new OBSERVER_INSTALL_DIR. Nothing overwritten.' >&2; exit 1; }
temporary=$(mktemp -d)
trap 'rm -f "$temporary/$name" "$temporary/SHA256SUMS" "$temporary/selected.sha256"; rmdir "$temporary" 2>/dev/null || true' EXIT
curl --proto '=https' --tlsv1.2 -fsSLo "$temporary/$name" "$origin/$name"
curl --proto '=https' --tlsv1.2 -fsSLo "$temporary/SHA256SUMS" "$origin/SHA256SUMS"
awk -v file="$name" '$2==file { print }' "$temporary/SHA256SUMS" > "$temporary/selected.sha256"
[[ -s "$temporary/selected.sha256" ]]
(cd "$temporary" && sha256sum -c selected.sha256)
mkdir -p "$destination"
unzip -q "$temporary/$name" -d "$destination"
bash "$destination/self-hosted/install.sh" </dev/tty
