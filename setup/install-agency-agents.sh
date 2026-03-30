#!/usr/bin/env bash
# =============================================================================
# install-agency-agents.sh
# Clones msitarzewski/agency-agents and merges role definitions into NanoClaw.
# =============================================================================
set -euo pipefail

APP_DIR="/app"
AGENCY_AGENTS_DIR="${APP_DIR}/agency-agents"
NANOCLAW_ROLES_DIR="${APP_DIR}/roles"
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

# FIX: agency-agents organises roles in domain subdirectories (engineering/,
#      design/, specialized/, etc.), not a single roles/ directory.
#      Find all .md files recursively and copy them flat into nanoclaw/roles/.
log "Merging role definitions from agency-agents → nanoclaw/roles/..."
MERGED=0
while IFS= read -r -d '' f; do
  dest="${NANOCLAW_ROLES_DIR}/$(basename "$f")"
  cp "$f" "$dest"
  MERGED=$((MERGED + 1))
done < <(find "${AGENCY_AGENTS_DIR}" -name "*.md" -not -name "README.md" -print0)
log "Merged ${MERGED} role file(s)."

log "agency-agents installation complete."
