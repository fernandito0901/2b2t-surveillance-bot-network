#!/bin/bash
# ops/enable-https.sh — flip the dashboard to HTTPS on a subdomain, end to end.
#
# Run ON THE BOX once your DNS A record for the subdomain points at this
# host (DNS-only, not Cloudflare-proxied) and Lightsail allows inbound 80 + 443:
#
#   bash ~/2b2t/ops/enable-https.sh map.example.com
#
# What it does (all reversible):
#   1. Renders /etc/caddy/Caddyfile from ops/Caddyfile.template with the hostname,
#      so Caddy auto-issues + auto-renews a Let's Encrypt cert and proxies to :3000.
#   2. Hardens the Node app via ~/2b2t/.env:
#        DASHBOARD_HOST=127.0.0.1  (stop exposing :3000 to the internet — only
#                                   Caddy reaches it now)
#        TRUST_PROXY=true          (read the real client IP from Caddy's
#                                   X-Forwarded-For, so login-IP logging is accurate)
#        COOKIE_SECURE=true        (session cookie only sent over HTTPS)
#        DASHBOARD_ORIGINS=https://<domain>  (CSRF origin allowlist)
#   3. Reloads Caddy and restarts the app, then verifies the cert + a 200.
#
# To roll back: restore ops/Caddyfile.staging to /etc/caddy/Caddyfile, remove the
# four .env lines below, and restart both services.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="${APP_DIR:-/home/admin/2b2t}"
ENV_FILE="$APP_DIR/.env"

# A real hostname: labels of a-z0-9/hyphen, at least one dot, no scheme/paths.
if ! [[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; then
  echo "Usage: bash enable-https.sh <subdomain>   e.g. map.example.com" >&2
  echo "  (got: '${DOMAIN}')" >&2
  exit 1
fi

echo "=== [1/5] pre-flight: does $DOMAIN resolve to this box? ==="
PUB=$(curl -s -m 8 https://api.ipify.org || true)
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)
echo "  this box public IP : ${PUB:-unknown}"
echo "  $DOMAIN resolves to: ${RESOLVED:-<no DNS record yet>}"
if [ -n "$PUB" ] && [ -n "$RESOLVED" ] && [ "$PUB" != "$RESOLVED" ]; then
  echo "  WARNING: DNS does not point here (or is proxied). Let's Encrypt will fail" >&2
  echo "           until the A record points at $PUB, DNS-only. Continuing anyway;" >&2
  echo "           re-run once DNS is correct." >&2
fi

echo "=== [2/5] render Caddyfile for $DOMAIN ==="
TEMPLATE="$APP_DIR/ops/Caddyfile.template"
[ -f "$TEMPLATE" ] || { echo "missing $TEMPLATE" >&2; exit 1; }
sudo mkdir -p /var/log/caddy
sed "s/__DOMAIN__/${DOMAIN}/g" "$TEMPLATE" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "=== [3/5] harden app env ($ENV_FILE) ==="
touch "$ENV_FILE"
set_env() {  # upsert KEY=VALUE without duplicating lines
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_env DASHBOARD_HOST 127.0.0.1
set_env TRUST_PROXY true
set_env COOKIE_SECURE true
set_env DASHBOARD_ORIGINS "https://${DOMAIN}"

echo "=== [4/5] reload Caddy + restart app ==="
sudo systemctl reload caddy || sudo systemctl restart caddy
sudo systemctl restart 2b2t-app
sleep 4

echo "=== [5/5] verify ==="
echo -n "  local app (127.0.0.1:3000): "; curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/login.html || echo "unreachable"
echo -n "  https://$DOMAIN/login.html : "; curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://${DOMAIN}/login.html" || echo "not answering yet (cert may still be issuing — give it ~30s, re-check)"
echo "  cert:"; echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null | sed 's/^/    /' || echo "    (no cert yet — check DNS + Lightsail 443, then: sudo journalctl -u caddy -n 40)"
echo "DONE. If the cert didn't issue, it's almost always DNS not pointing here yet or Lightsail blocking 443."
