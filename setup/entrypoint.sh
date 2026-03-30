#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh — NanoClaw Web3 Agency bootstrap
# Orchestrates all setup steps then hands off to NanoClaw.
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
log "  agents-agency — Andy the Project Manager"
log "  Powered by NanoClaw"
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
# GitHub credentials — configure git + gh CLI if GITHUB_TOKEN is set
# ---------------------------------------------------------------------------
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  log "Configuring GitHub credentials..."
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null \
    || warn "gh auth login failed — gh CLI may not work correctly."
  log "GitHub credentials configured (git + gh CLI)."
else
  warn "GITHUB_TOKEN not set — private repo clones and PR creation will not work."
fi

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
# Launch NanoClaw
# NanoClaw's DATA_DIR, GROUPS_DIR, and STORE_DIR are relative to cwd.
# We run from /workspace/.agency so all state persists across restarts.
# ---------------------------------------------------------------------------
log "Starting NanoClaw (Andy the Project Manager)..."

# Ensure /workspace/.agency and uploads dir are writable by the agency user.
# On Windows/Docker Desktop, volume mounts can land as root-owned — this fixes
# any leftover root ownership so history, state, and uploads all work.
mkdir -p /workspace/.agency/uploads 2>/dev/null || true
chmod -R u+rwX /workspace/.agency 2>/dev/null || true
cd /app/nanoclaw

NANOCLAW_BIN="${APP_DIR}/nanoclaw/node_modules/.bin/tsx"
NANOCLAW_SRC="${APP_DIR}/nanoclaw/src/index.ts"

_shutdown() {
  log "Shutdown signal received — stopping NanoClaw PID ${BOT_PID}"
  kill -TERM "${BOT_PID}" 2>/dev/null
  wait "${BOT_PID}"
  exit 0
}

"${NANOCLAW_BIN}" "${NANOCLAW_SRC}" &
BOT_PID=$!
log "NanoClaw PID: ${BOT_PID}"
trap '_shutdown' TERM INT

wait ${BOT_PID}
EXIT_CODE=$?
log "NanoClaw exited with code: ${EXIT_CODE}"
exit ${EXIT_CODE}
