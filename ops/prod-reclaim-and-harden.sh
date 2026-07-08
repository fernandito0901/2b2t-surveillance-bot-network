#!/bin/bash
# ops/prod-reclaim-and-harden.sh
# One-time production reclaim + hardening for the 2b2t Lightsail box.
# Everything here is REVERSIBLE and does NOT touch ZenithProxy tmux sessions or
# the 2b2t-app service. Run as: ssh admin@HOST 'sudo bash -s' < ops/prod-reclaim-and-harden.sh
# (or paste into a root shell). Review before running.
#
# Reverses:
#   mariadb/redis:  systemctl enable --now mariadb redis-server
#   stub:           mv /var/www/nodeapp/server.js.disabled /var/www/nodeapp/server.js
#   timers:         systemctl disable --now 2b2t-logrotate.timer 2b2t-backup.timer
set +e

echo "=== [1] Free RAM: disable mariadb + redis (unused by this project — deps are only express/ws/mineflayer/socks/chalk/dotenv) ==="
systemctl disable --now mariadb        2>&1 | tail -2
systemctl disable --now redis-server   2>&1 | tail -2

echo "=== [2] Kill the empty :80/:443 stub and neutralize it (won't relaunch on reboot) ==="
pkill -f '/var/www/nodeapp/server.js'; sleep 1
[ -f /var/www/nodeapp/server.js ] && mv /var/www/nodeapp/server.js /var/www/nodeapp/server.js.disabled && echo "stub neutralized"

echo "=== [3] Hourly logrotate for app.log (systemd logrotate.timer is daily → spam outran it) ==="
cat >/etc/systemd/system/2b2t-logrotate.service <<'UNIT'
[Unit]
Description=Rotate 2b2t app.log (hourly, size-capped)
[Service]
Type=oneshot
ExecStart=/usr/sbin/logrotate /etc/logrotate.d/2b2t-app
UNIT
cat >/etc/systemd/system/2b2t-logrotate.timer <<'UNIT'
[Unit]
Description=Hourly 2b2t app.log rotation
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now 2b2t-logrotate.timer 2>&1 | tail -1

echo "=== [4] Nightly on-box backup of small non-regenerable state (keeps newest 14) ==="
cat >/usr/local/bin/2b2t-backup.sh <<'BK'
#!/bin/bash
set -e
D=/home/admin/backups; mkdir -p "$D"
TS=$(date +%Y%m%d-%H%M%S)
cd /home/admin/2b2t
tar czf "$D/state-$TS.tgz" \
  data/accounts.json data/users.json data/settings.json data/groups.json \
  data/state.json data/spots.json data/proxies.txt data/.session_secret \
  data/activity data/metrics .env 2>/dev/null || true
ls -1t "$D"/state-*.tgz | tail -n +15 | xargs -r rm -f
BK
chmod +x /usr/local/bin/2b2t-backup.sh
mkdir -p /home/admin/backups && chown -R admin:admin /home/admin/backups
cat >/etc/systemd/system/2b2t-backup.service <<'UNIT'
[Unit]
Description=2b2t nightly state backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/2b2t-backup.sh
UNIT
cat >/etc/systemd/system/2b2t-backup.timer <<'UNIT'
[Unit]
Description=Nightly 2b2t state backup
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now 2b2t-backup.timer 2>&1 | tail -1
/usr/local/bin/2b2t-backup.sh && echo "first backup written"

echo "=== [5] Verify ==="
echo "--- ports 80/443/3306/6379 (should be freed) ---"; ss -tlnp 2>/dev/null | grep -E ":80 |:443 |:3306|:6379" || echo "  freed"
echo "--- our timers ---"; systemctl list-timers '2b2t-*' --no-pager 2>/dev/null | head -5
echo "--- backups ---"; ls -la /home/admin/backups/ | tail -3
echo "--- MEM AFTER ---"; free -h | head -2
echo "DONE. (TLS reverse proxy on the now-free :443 is a separate follow-up needing a domain decision.)"
