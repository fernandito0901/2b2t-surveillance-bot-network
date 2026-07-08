#!/bin/bash
# ops/watchdog.sh — system heartbeat for the 2b2t surveillance node.
#
# Checks the app service, the dashboard, and the ZenithProxy tmux sessions, and
# pings Discord ONLY on a state change (healthy→down, then down→recovered) using a
# flag file, so it never spams. Intended to run from cron every 5 minutes:
#   */5 * * * * /home/admin/2b2t/ops/watchdog.sh
set -u
export PATH=/usr/local/bin:/usr/bin:/bin
APP_DIR="/home/admin/2b2t"
FLAG="/tmp/2b2t-watchdog-down"
cd "$APP_DIR" 2>/dev/null || exit 0

# Source the Discord webhook the way the app does: data/settings.json
# (discordWebhookUrl) is canonical once it's edited in the dashboard, so prefer
# it and fall back to .env. settings.json is pretty-printed JSON, so a
# line-oriented sed pulls the value without a jq dependency.
WEBHOOK=$(sed -n 's/.*"discordWebhookUrl"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' data/settings.json 2>/dev/null | head -n1 | tr -d '\r')
[ -n "$WEBHOOK" ] || WEBHOOK=$(sed -n 's/^DISCORD_WEBHOOK_URL=//p' .env 2>/dev/null | tr -d '\r')

problem=""
systemctl is-active --quiet 2b2t-app || problem="app service is DOWN"
if [ -z "$problem" ]; then
  curl -fsS -m 8 -o /dev/null "http://127.0.0.1:3000/login.html" 2>/dev/null || problem="dashboard not responding"
fi
# Assert EVERY account's ZenithProxy session exists — losing 3 of 4 must not be
# silent — and name the missing one(s). The expected set is derived live from
# accounts.json (tmuxSession fields), so adding/removing an account on the
# dashboard keeps the watchdog honest with no manual edit here. Falls back to
# the last known fleet if the file is unreadable. grep -qx = exact line match.
expected=$(grep -o '"tmuxSession"[[:space:]]*:[[:space:]]*"[^"]*"' data/accounts.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$expected" ] || expected="zn zc zd z-southhighw"
tmux_names=$(tmux ls -F '#{session_name}' 2>/dev/null)
missing=""
for s in $expected; do
  printf '%s\n' "$tmux_names" | grep -qx "$s" || missing="${missing:+$missing, }$s"
done
if [ -n "$missing" ]; then
  problem="${problem:+$problem; }ZenithProxy session(s) DOWN: $missing"
fi

notify() {
  [ -n "$WEBHOOK" ] || return 0
  curl -fsS -m 8 -H "Content-Type: application/json" -d "$1" "$WEBHOOK" >/dev/null 2>&1
}

if [ -n "$problem" ]; then
  if [ ! -f "$FLAG" ]; then
    touch "$FLAG"
    notify "{\"content\":\"🔴 **2b2t node alert** — $problem ($(hostname))\"}"
  fi
else
  if [ -f "$FLAG" ]; then
    rm -f "$FLAG"
    notify "{\"content\":\"🟢 **2b2t node recovered** — app, dashboard & all proxy sessions healthy ($(hostname))\"}"
  fi
fi

# Low-memory early warning — alert once when available RAM drops below 150MB, so a
# slow leak is caught before it can OOM the bots. Separate flag from the up/down alert.
MEMFLAG="/tmp/2b2t-watchdog-lowmem"
avail=$(free -m | awk '/^Mem:/{print $7}')
if [ "${avail:-9999}" -lt 150 ]; then
  if [ ! -f "$MEMFLAG" ]; then
    touch "$MEMFLAG"
    notify "{\"content\":\"⚠️ **2b2t node low memory** — only ${avail}MB RAM available ($(hostname)). Bots may be at OOM risk; consider restarting the app (keeps the queue) or the box.\"}"
  fi
else
  rm -f "$MEMFLAG"
fi
