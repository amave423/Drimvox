#!/usr/bin/env bash
# Installs Drimvox on Ubuntu as a systemd service and opens it in your tailnet over HTTPS.
# Run from the Drimvox folder: npm run server:install. Safe to run again after `git pull` to update.
#   DRIMVOX_PORT      port on 127.0.0.1 (4317)
#   DRIMVOX_DATA_DIR  data folder (~/.local/share/drimvox)
#   DRIMVOX_CHROMIUM  1 = install Chromium for visual checks without asking, 0 = skip
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${DRIMVOX_PORT:-4317}"
DATA="${DRIMVOX_DATA_DIR:-$HOME/.local/share/drimvox}"
RUN_AS="$(id -un)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your own user, not root: the service runs as that user and sudo is asked for when needed."
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "Node 24 or newer is needed (found: ${NODE:+$("$NODE" -v)}${NODE:-none}). See https://nodejs.org/en/download"
  exit 1
fi

say "Installing packages and building Drimvox"
npm install --no-audit --no-fund
npm run build -w @drimvox/web
npm run build -w @drimvox/server

NAME=""
if command -v tailscale >/dev/null 2>&1; then
  NAME="$(tailscale status --json 2>/dev/null | "$NODE" -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try { const j = JSON.parse(s); if (j.BackendState === "Running") process.stdout.write((j.Self.DNSName || "").replace(/\.$/, "")); } catch {}
    });' || true)"
fi
if [ -z "$NAME" ]; then
  echo "Tailscale is not installed or not logged in: Drimvox will be reachable only from this machine."
  echo "Install it (https://tailscale.com/download/linux), run 'sudo tailscale up', then run this script again."
fi

say "Writing the systemd service"
# The agents run git, npm, Claude Code and the like: the service gets the PATH of this shell.
sudo tee /etc/systemd/system/drimvox.service >/dev/null <<UNIT
[Unit]
Description=Drimvox: AI agents that write code under your review
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$ROOT
Environment="PATH=$PATH"
Environment="DRIMVOX_PORT=$PORT"
Environment="DRIMVOX_DATA_DIR=$DATA"
Environment="DRIMVOX_HOSTS=$NAME"
ExecStart=$NODE $ROOT/apps/server/dist/server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable drimvox >/dev/null
sudo systemctl restart drimvox

if [ -n "$NAME" ]; then
  say "Opening Drimvox in the tailnet over HTTPS"
  sudo tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
fi

CHROMIUM="${DRIMVOX_CHROMIUM:-}"
if [ -z "$CHROMIUM" ] && [ -t 0 ]; then
  read -r -p "Install Chromium so agents can look at the pages they build (about 300 MB)? [y/N] " answer
  [[ "$answer" =~ ^[YyДд] ]] && CHROMIUM=1 || CHROMIUM=0
fi
if [ "$CHROMIUM" = "1" ]; then
  say "Installing Chromium for visual checks"
  npx playwright install --with-deps chromium
fi

say "Waiting for Drimvox to start"
CODE=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    CODE="$(sudo journalctl -u drimvox -n 200 --no-pager 2>/dev/null | grep -o 'browser: [0-9]\{6\}' | tail -n 1 | grep -o '[0-9]\{6\}' || true)"
    break
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Drimvox did not start. See: sudo journalctl -u drimvox -n 50"
  exit 1
fi

say "Drimvox is running"
if [ -n "$NAME" ]; then echo "Open: https://$NAME"; else echo "Open: http://127.0.0.1:$PORT (on this machine)"; fi
if [ -n "$CODE" ]; then echo "Setup code for the first password: $CODE"; fi
echo "Logs: sudo journalctl -u drimvox -f    Stop: sudo systemctl stop drimvox"
