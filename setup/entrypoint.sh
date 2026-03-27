#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh — NanoClaw Web3 Agency bootstrap
# Orchestrates all setup steps then hands off to the NanoClaw process.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/app"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log()  { echo "[agency] $(date -u +%H:%M:%SZ)  $*"; }
warn() { echo "[agency] $(date -u +%H:%M:%SZ)  WARN  $*" >&2; }
die()  { echo "[agency] $(date -u +%H:%M:%SZ)  ERROR $*" >&2; exit 1; }

log "========================================================="
log "  Protofire NanoClaw Web3 Agency — starting up"
log "  Project: ${PROJECT_NAME:-unknown}"
log "========================================================="

# ---------------------------------------------------------------------------
# Validate required environment variables
# ---------------------------------------------------------------------------
REQUIRED_VARS=(
  OPENROUTER_API_KEY
  DISCORD_BOT_TOKEN
  DISCORD_GUILD_ID
  DISCORD_PM_CHANNEL_ID
)

for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    die "Required environment variable '${var}' is not set. Check your .env file."
  fi
done

log "Environment validation passed."

# ---------------------------------------------------------------------------
# Step 1: Install / update agency-agents role definitions
# ---------------------------------------------------------------------------
log "Step 1/3 — Installing agency-agents role definitions..."
"${SCRIPT_DIR}/install-agency-agents.sh"
log "Step 1/3 — Done."

# ---------------------------------------------------------------------------
# Step 2: Load private web3-skills
# ---------------------------------------------------------------------------
log "Step 2/3 — Loading Protofire web3-skills..."
"${SCRIPT_DIR}/load-web3-skills.sh"
log "Step 2/3 — Done."

# ---------------------------------------------------------------------------
# Step 3: Customize Project Manager for Discord
# ---------------------------------------------------------------------------
log "Step 3/3 — Configuring Project Manager Discord integration..."
"${SCRIPT_DIR}/customize-pm.sh"
log "Step 3/3 — Done."

# ---------------------------------------------------------------------------
# Apply model routing from config/models.json
# ---------------------------------------------------------------------------
log "Applying model routing from /app/config/models.json..."
if [[ -f "${APP_DIR}/nanoclaw/dist/configure-models.js" ]]; then
  node "${APP_DIR}/nanoclaw/dist/configure-models.js" \
    --config "${APP_DIR}/config/models.json" \
    || warn "Model configuration step returned non-zero — continuing anyway."
fi

# ---------------------------------------------------------------------------
# Register cost-tracking skill
# ---------------------------------------------------------------------------
log "Registering cost-tracking skill..."
if [[ -f "${APP_DIR}/skills/track-cost.ts" ]]; then
  ts-node "${APP_DIR}/skills/track-cost.ts" --register \
    || warn "Cost tracking skill registration failed — continuing without it."
fi

# ---------------------------------------------------------------------------
# Launch NanoClaw agency
# ---------------------------------------------------------------------------
log "Starting NanoClaw agency process..."

# FIX: Original assumed dist/index.js is pre-built, but NanoClaw ships only
#      TypeScript source — dist/ is never built in the image. Fall back to tsx.
# FIX: Use direct binary path (node_modules/.bin/tsx) instead of npx so that
#      SIGTERM is forwarded directly to the process, not swallowed by npx.
if [[ -f "${APP_DIR}/nanoclaw/dist/index.js" ]]; then
  NANOCLAW_CMD="node ${APP_DIR}/nanoclaw/dist/index.js"
elif [[ -f "${APP_DIR}/nanoclaw/src/index.ts" ]]; then
  log "dist/index.js not found — running via tsx (source mode)"
  NANOCLAW_CMD="${APP_DIR}/nanoclaw/node_modules/.bin/tsx ${APP_DIR}/nanoclaw/src/index.ts"
else
  die "NanoClaw entrypoint not found. Was the image built correctly?"
fi

log "Starting Discord bot (OpenRouter backend)..."
# FIX: NanoClaw requires an OneCLI service on port 10254 that is not included
#      in this image. skills/bot.ts is a self-contained Discord bot that calls
#      OpenRouter directly, providing equivalent interactive functionality.
BOT_CMD="${APP_DIR}/nanoclaw/node_modules/.bin/tsx ${APP_DIR}/skills/bot.ts"

_shutdown() {
  log "Shutdown signal received — stopping bot PID ${BOT_PID}"
  kill -TERM "${BOT_PID}" 2>/dev/null
  wait "${BOT_PID}"
  exit 0
}

${BOT_CMD} &
BOT_PID=$!
log "Bot PID: ${BOT_PID}"
trap '_shutdown' TERM INT

wait ${BOT_PID}
EXIT_CODE=$?
log "Bot exited with code: ${EXIT_CODE}"
exit ${EXIT_CODE}
