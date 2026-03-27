#!/usr/bin/env bash
# =============================================================================
# customize-pm.sh
# Configures the Project Manager agent as the ONLY agent with Discord access.
# All other agents communicate internally only.
# =============================================================================
set -euo pipefail

APP_DIR="/app"
NANOCLAW_CONFIG_DIR="${APP_DIR}/nanoclaw/config"
PM_CONFIG_FILE="${NANOCLAW_CONFIG_DIR}/agents/project-manager.json"
COMMS_CONFIG_FILE="${NANOCLAW_CONFIG_DIR}/communications.json"

log()  { echo "[customize-pm] $*"; }
warn() { echo "[customize-pm] WARN $*" >&2; }

# ---------------------------------------------------------------------------
# Ensure NanoClaw config directory exists
# ---------------------------------------------------------------------------
mkdir -p "${NANOCLAW_CONFIG_DIR}/agents"

# ---------------------------------------------------------------------------
# Write Project Manager Discord configuration
# ---------------------------------------------------------------------------
log "Writing Project Manager agent config with Discord integration..."

cat > "${PM_CONFIG_FILE}" <<EOF
{
  "role": "project-manager",
  "model": "openrouter/anthropic/claude-4.6-opus",
  "human_interface": {
    "enabled": true,
    "channel": "discord",
    "discord": {
      "bot_token": "${DISCORD_BOT_TOKEN}",
      "guild_id": "${DISCORD_GUILD_ID}",
      "channel_id": "${DISCORD_PM_CHANNEL_ID}"
    }
  },
  "system_prompt_append": "You are the sole point of contact with the human client. Communicate all project updates, questions, and deliverables via Discord. Delegate all technical work to specialist agents internally. Be concise, professional, and proactive.",
  "internal_comms": true
}
EOF

log "Project Manager configured for Discord (channel: ${DISCORD_PM_CHANNEL_ID})."

# ---------------------------------------------------------------------------
# Write global communications config — disable Discord for all other agents
# ---------------------------------------------------------------------------
log "Disabling direct human comms for all non-PM agents..."

cat > "${COMMS_CONFIG_FILE}" <<EOF
{
  "human_interface": {
    "default": {
      "enabled": false,
      "reason": "All human communication is routed through the Project Manager via Discord."
    },
    "overrides": {
      "project-manager": {
        "enabled": true,
        "channel": "discord"
      }
    }
  },
  "internal_bus": {
    "type": "nanoclaw-internal",
    "broadcast_enabled": true
  }
}
EOF

log "Communications policy applied: only Project Manager has Discord access."

# ---------------------------------------------------------------------------
# Validate Discord bot token format (basic sanity check)
# ---------------------------------------------------------------------------
if [[ "${DISCORD_BOT_TOKEN}" =~ ^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}$ ]]; then
  log "Discord bot token format looks valid."
else
  warn "Discord bot token format may be incorrect. Verify at discord.com/developers/applications"
fi

log "Project Manager customization complete."
