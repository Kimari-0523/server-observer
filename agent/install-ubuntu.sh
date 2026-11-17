#!/bin/bash
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { printf '%s\n' 'Run this installer as root.' >&2; exit 1; }
token=${1:-}
[[ $token =~ ^[A-Za-z0-9_-]{32,128}$ ]] || { printf '%s\n' 'Invalid one-time enrollment token.' >&2; exit 1; }
case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) printf '%s\n' 'Unsupported CPU architecture.' >&2; exit 1;; esac
for tool in curl tar xz sha256sum python3 make g++; do command -v "$tool" >/dev/null || { printf 'Missing required tool: %s\n' "$tool" >&2; exit 1; }; done
base=/opt/server-observer-agent
install -d -m 700 "$base" "$base/downloads" "$base/runtime"
cd "$base/downloads"
archive="node-v24.22.3-linux-$arch.tar.xz"
if [[ ! -x "$base/runtime/bin/node" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSLo "$archive" "https://nodejs.org/dist/v24.22.3/$archive"
  curl --proto '=https' --tlsv1.2 -fsSLo SHASUMS256.txt https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
  awk -v name="$archive" '$2==name {print}' SHASUMS256.txt > selected-sha256.txt
  test -s selected-sha256.txt
  sha256sum -c selected-sha256.txt
  tar -xJf "$archive" --strip-components=1 -C "$base/runtime"
fi
curl --proto '=https' --tlsv1.2 -fsSLo "$base/agent.mjs.new" __PUBLIC_ORIGIN__/downloads/agent.mjs
printf '%s  %s\n' '__AGENT_SHA256__' "$base/agent.mjs.new" | sha256sum -c -
install -m 600 "$base/agent.mjs.new" "$base/agent.mjs"
for file in addresses.mjs public-ip.mjs terminal-agent.mjs command-agent.mjs package.json package-lock.json; do
  curl --proto '=https' --tlsv1.2 -fsSLo "$base/$file" "__PUBLIC_ORIGIN__/downloads/$file"
done
export PATH="$base/runtime/bin:$PATH"
cd "$base"
node "$base/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund
node --input-type=module -e 'await import("node-pty")'
if [[ ! -e "$base/agent.json" ]]; then
  printf '{"backend":"__PUBLIC_ORIGIN__","enrollment_token":"%s","services":[]}\n' "$token" > "$base/agent.json"
  chmod 600 "$base/agent.json"
else
  MONITOR_SETUP_TOKEN="$token" node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const path='agent.json',current=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
if(!current.id){current.enrollment_token=process.env.MONITOR_SETUP_TOKEN;writeFileSync(path,JSON.stringify(current,null,2),{mode:0o600});}
JS
fi
cat > /etc/systemd/system/server-observer-agent.service <<'UNIT'
[Unit]
Description=Observer server monitoring agent
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=/opt/server-observer-agent
Environment=MONITOR_CONFIG=/opt/server-observer-agent/agent.json
ExecStart=/opt/server-observer-agent/runtime/bin/node /opt/server-observer-agent/agent.mjs
Restart=always
RestartSec=10
MemoryMax=128M
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable server-observer-agent
systemctl restart server-observer-agent
systemctl is-active server-observer-agent
printf '%s\n' 'Agent service started. Confirm first report in the monitoring dashboard.'
