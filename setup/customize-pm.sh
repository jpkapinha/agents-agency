#!/usr/bin/env bash
# =============================================================================
# customize-pm.sh
# Andy the PM is configured via environment variables consumed by bot.ts and
# NanoClaw. No additional config files are required at runtime.
#
# NanoClaw auto-registers the PM channel (DISCORD_PM_CHANNEL_ID) as the main
# group on first startup — see the patch applied in patch.cjs.
# =============================================================================
set -euo pipefail

log()  { echo "[customize-pm] $*"; }

log "Project Manager will connect to Discord channel: ${DISCORD_PM_CHANNEL_ID}"
log "Project: ${PROJECT_NAME:-unnamed}"
log "Andy's name: ${ASSISTANT_NAME:-Andy}"

# Validate Discord bot token format (basic sanity check)
if [[ "${DISCORD_BOT_TOKEN}" =~ ^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}$ ]]; then
  log "Discord bot token format looks valid."
else
  echo "[customize-pm] WARN Discord bot token format may be incorrect. Verify at discord.com/developers/applications" >&2
fi

log "Project Manager customization complete."
