#!/usr/bin/env bash
# =============================================================================
# customize-pm.sh
# Project Manager is configured entirely via skills/bot.ts and environment
# variables (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_PM_CHANNEL_ID,
# OPENROUTER_API_KEY, PROJECT_NAME). No additional config files needed.
# =============================================================================
set -euo pipefail

log()  { echo "[customize-pm] $*"; }

log "Project Manager is configured via skills/bot.ts — no extra config needed."
log "  Discord channel: ${DISCORD_PM_CHANNEL_ID}"
log "  Project: ${PROJECT_NAME:-unnamed}"

# Validate Discord bot token format (basic sanity check)
if [[ "${DISCORD_BOT_TOKEN}" =~ ^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}$ ]]; then
  log "Discord bot token format looks valid."
else
  echo "[customize-pm] WARN Discord bot token format may be incorrect. Verify at discord.com/developers/applications" >&2
fi

log "Project Manager customization complete."
