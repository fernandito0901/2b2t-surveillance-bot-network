# 2b2t Highway Surveillance — Architecture

A hands-off network of 2b2t accounts that hold positions on highways and log
passing players to a live dashboard. **No autonomy / pathfinding / travel** — the
operator drives each bot to its spot manually; the software handles presence,
queueing, monitoring, and notifications.

## Three layers

```
ZenithProxy (per account, in tmux)   ← holds the real 2b2t session: queue, anti-AFK,
        ▲                              auth. One instance per account, own port + proxy IP.
        │ mineflayer connects offline as a SPECTATOR
mineflayer monitor (shared IGN)      ← reads nearby-player entities, logs sightings.
        ▲
        │ reads tmux panes + serves dashboard
Node orchestrator (index.js)         ← the brain: poller + dashboard + notifier.
```

1. **ZenithProxy** (one per account) holds that account's 2b2t session. Runs in
   its own detached **tmux session** (`zn`, `zc`, …), decoupled from the Node app
   so restarts/deploys never re-queue it. `verifyUsers:false` so the offline
   monitor can attach; the operator's account is on the **control whitelist**
   (`whitelist add`) and the monitor IGN on the **spectator whitelist**
   (`spectator whitelist add`). Each account past the first egresses through its
   own SOCKS proxy — 2b2t rate-limits multiple accounts per IP.

2. **mineflayer monitor** — when a placed account is in-world, the orchestrator
   connects a mineflayer client *offline* to that account's ZenithProxy port as
   the shared monitor IGN (`MonitorBot`), in spectator mode. `PlayerMonitor` scans
   entities and logs sightings to the dashboard/activity/Discord.

3. **Node orchestrator** (`index.js`) is the single brain. It does NOT own the
   ZenithProxy processes — it **polls their tmux panes** (`_startExternalPoller`)
   for queue position / in-world / login state, and that poller is the single
   source of truth. It serves the dashboard, auto-provisions new accounts, and
   fires all Discord notifications.

## Account lifecycle

```
Add Account ─▶ auto-provision (free port + pool proxy + clone + tmux launch)
            ─▶ device-code login (poller surfaces code to dashboard + Discord)
            ─▶ queue (Discord pings at 250/100/50/10)
            ─▶ IN THE SERVER (Discord ping with drive port)
            ─▶ operator drives it to its spot (Minecraft 1.21.4)
            ─▶ clicks "Place" ─▶ monitor attaches, logs players
                                   (death → un-place + notify)
```

No auto-travel: an account spawns at 2b2t spawn and the operator drives it.

## Files

| File | Role |
|---|---|
| `index.js` | Orchestrator: provisioning, poller, notifications, dashboard wiring, settings, groups |
| `config.js` | Central config (env-overridable) |
| `state.js` | Bot status, placed flags, position, activity summary (persisted) |
| `bot/BotFactory.js` | Creates the offline mineflayer monitor (connects to a local ZenithProxy port) |
| `bot/BotStateMachine.js` | Monitor lifecycle: connect → monitor → disconnect |
| `bot/modules/PlayerMonitor.js` | Entity scan → sighting logs (attributed by account) |
| `logging/Logger.js` | System + per-bot activity logging |
| `logging/DiscordNotifier.js` | Discord webhook (login-required, detections, status) |
| `dashboard/server.js` | Express + WebSocket API |
| `dashboard/public/` | Map + bot status + coverage/groups + activity + settings UI |

## Key orchestrator methods

- `_provisionAndLaunch(id)` — clone template, assign free port + pool proxy, patch
  config (verifyUsers:false, render 6), launch in tmux with a crash-loop, seed
  control + spectator whitelists. Used by Add Account, Start, and Re-login.
- `_startExternalPoller()` — per-tick parse of each account's tmux pane → state +
  notifications. The single source of truth.
- `_launchBot(id)` — when a placed account is in-world, connect the mineflayer
  monitor to its port as the monitor IGN.
- `getSystemStatus()` — dashboard snapshot (bots, groups, monitor, activity).

## VPS / ops

- ZenithProxy instances run in tmux; **`zenith-fleet.service`** (systemd) recreates
  them on boot via `~/zenith/start-fleet.sh`; `autoConnect:true` reconnects them.
- The Node app runs as systemd **`2b2t-app`**.
- A reboot loses the 2b2t sessions (re-queue) but everything auto-recovers.

See the project memory (`vps-deployment`) for live host/ports/account state.

## Known limitations

- **Spectator entity relay is the core unverified assumption** — that a mineflayer
  *spectator* receives nearby-player entities through ZenithProxy. Test in-world.
- State is parsed from tmux pane text (regex) — robust enough but format-sensitive.
- `verifyUsers:false` + open ports means a spoofed offline username could connect;
  acceptable for now, riskier at scale.
- **Data model:** the live "where is a bot" model is **`accounts.json` + the
  `placed` flag** (`state.placedBots`). A sighting's `spotId` is *derived at
  runtime* as `account.username || account.id` — it is never stored. `spots.json`
  is fully dead (no readers); `groups.json` is only a cosmetic coverage overlay
  (empty in prod). Neither drives monitoring.
