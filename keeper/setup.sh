#!/usr/bin/env bash
# Installs and starts the Hook Catch keeper on a fresh Ubuntu server.
#   curl -fsSL https://raw.githubusercontent.com/Hook-Catch/hook-catch/main/keeper/setup.sh | bash
# Asks for the keeper wallet key once and stores it in /opt/hook-catch/keeper/.env (readable by root only).
set -euo pipefail
HOOKCATCH="${HOOKCATCH:-0xc2ab35c41022da338a4fe450444e20a41044bdd6}"

echo "[1/4] Installing system packages (1-3 minutes, please wait)..."
apt-get update -y -qq && apt-get install -y -qq curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null
fi
echo "[2/4] Installing pm2..."
command -v pm2 >/dev/null || npm install -g pm2 --silent

echo "[3/4] Downloading the keeper..."
mkdir -p /opt/hook-catch/keeper && cd /opt/hook-catch/keeper
# one self-contained file (the bot plus its libraries), so no npm install is needed
BUNDLE_REV=c425ef1469ba491dbea0e6f929c0e4f92dae51e8
if [ -s keeper.bundle.mjs ] && [ "$(wc -c < keeper.bundle.mjs)" -gt 400000 ] && [ "${REFRESH:-0}" != 1 ]; then
  echo "    already downloaded"
else
  for url in "https://cdn.jsdelivr.net/gh/Hook-Catch/hook-catch@$BUNDLE_REV/keeper/keeper.bundle.mjs"              "https://fastly.jsdelivr.net/gh/Hook-Catch/hook-catch@$BUNDLE_REV/keeper/keeper.bundle.mjs"              "https://raw.githubusercontent.com/Hook-Catch/hook-catch/$BUNDLE_REV/keeper/keeper.bundle.mjs"; do
    echo "    trying ${url%%/gh/*}${url##*.net}" | cut -c1-80
    if curl -fsSL --connect-timeout 15 -m 120 "$url" -o keeper.bundle.mjs.tmp && [ "$(wc -c < keeper.bundle.mjs.tmp)" -gt 400000 ]; then
      mv keeper.bundle.mjs.tmp keeper.bundle.mjs; break
    fi
  done
  [ -s keeper.bundle.mjs ] || { echo "    could not download the keeper from any mirror"; exit 1; }
  echo "    downloaded $(wc -c < keeper.bundle.mjs) bytes"
fi

echo "[4/4] Keeper wallet"
if [ ! -f .env ]; then
  echo
  read -rsp "Private key of the KEEPER wallet (a fresh wallet with a little ETH, not your main one): " KEY </dev/tty; echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]"')"; KEY="${KEY#0x}"
  if ! [[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "That is not an EVM private key: expected 64 characters of 0-9 and a-f, got ${#KEY} characters."
    echo "In Phantom, export the key of the Ethereum account (not Solana). Run: bash setup.sh"; exit 1
  fi
  umask 077 && printf 'KEEPER_KEY=0x%s\nHOOKCATCH=%s\n' "$KEY" "$HOOKCATCH" > .env
  unset KEY
fi

set -a && . ./.env && set +a
echo && echo "Dry run (nothing is sent):"
DRY_RUN=1 ONCE=1 timeout 90 node keeper.bundle.mjs || echo "    (dry run did not finish: check that the server can reach rpc.mainnet.chain.robinhood.com)"

pm2 delete hookcatch-keeper >/dev/null 2>&1 || true
pm2 start keeper.bundle.mjs --name hookcatch-keeper --update-env >/dev/null
pm2 save >/dev/null && pm2 startup systemd -u root --hp /root >/dev/null
echo && echo "Keeper is running. Logs: pm2 logs hookcatch-keeper   Stop: pm2 stop hookcatch-keeper"
