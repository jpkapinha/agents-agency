#!/usr/bin/env bash
# =============================================================================
# install-agency-agents.sh
# Clones msitarzewski/agency-agents and merges role definitions into NanoClaw.
# =============================================================================
set -euo pipefail

APP_DIR="/app"
AGENCY_AGENTS_DIR="${APP_DIR}/agency-agents"
NANOCLAW_ROLES_DIR="${APP_DIR}/nanoclaw/roles"
VERSIONS_LOCK="${APP_DIR}/versions.lock"

log() { echo "[install-agency-agents] $*"; }

# Read pinned ref from versions.lock
AGENCY_AGENTS_REF=$(jq -r '."agency-agents" | split("@")[1]' "${VERSIONS_LOCK}")
log "Pinned ref: ${AGENCY_AGENTS_REF}"

# ---------------------------------------------------------------------------
# Clone or update agency-agents
# ---------------------------------------------------------------------------
if [[ -d "${AGENCY_AGENTS_DIR}/.git" ]]; then
  log "Updating existing agency-agents clone..."
  git -C "${AGENCY_AGENTS_DIR}" fetch --depth 1 origin "${AGENCY_AGENTS_REF}"
  git -C "${AGENCY_AGENTS_DIR}" checkout FETCH_HEAD
else
  log "Cloning msitarzewski/agency-agents@${AGENCY_AGENTS_REF}..."
  git clone --depth 1 --branch "${AGENCY_AGENTS_REF}" \
    https://github.com/msitarzewski/agency-agents.git \
    "${AGENCY_AGENTS_DIR}" \
    2>/dev/null \
    || git clone --depth 1 \
         https://github.com/msitarzewski/agency-agents.git \
         "${AGENCY_AGENTS_DIR}"
fi

log "Cloned agency-agents successfully."

# ---------------------------------------------------------------------------
# Merge role definitions into NanoClaw
# ---------------------------------------------------------------------------
if [[ ! -d "${NANOCLAW_ROLES_DIR}" ]]; then
  log "NanoClaw roles directory not found, creating it..."
  mkdir -p "${NANOCLAW_ROLES_DIR}"
fi

# Copy role YAML/JSON definitions — NanoClaw picks them up at startup
ROLES_SOURCE="${AGENCY_AGENTS_DIR}/roles"
if [[ -d "${ROLES_SOURCE}" ]]; then
  log "Merging role definitions from agency-agents/roles/ → nanoclaw/roles/..."
  cp -r "${ROLES_SOURCE}/." "${NANOCLAW_ROLES_DIR}/"
  log "Merged $(ls "${ROLES_SOURCE}" | wc -l | tr -d ' ') role file(s)."
else
  log "No roles/ directory found in agency-agents — skipping merge."
fi

# Copy any agent prompts
PROMPTS_SOURCE="${AGENCY_AGENTS_DIR}/prompts"
NANOCLAW_PROMPTS_DIR="${APP_DIR}/nanoclaw/prompts"
if [[ -d "${PROMPTS_SOURCE}" ]]; then
  log "Merging agent prompts..."
  mkdir -p "${NANOCLAW_PROMPTS_DIR}"
  cp -r "${PROMPTS_SOURCE}/." "${NANOCLAW_PROMPTS_DIR}/"
fi

log "agency-agents installation complete."
