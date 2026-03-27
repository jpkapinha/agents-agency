#!/usr/bin/env bash
# =============================================================================
# load-web3-skills.sh
# Securely clones the private protofire/web3-skills repository using the
# SSH deploy key injected via Docker secrets, then merges skills into NanoClaw.
# =============================================================================
set -euo pipefail

APP_DIR="/app"
WEB3_SKILLS_DIR="${APP_DIR}/web3-skills"
NANOCLAW_SKILLS_DIR="${APP_DIR}/nanoclaw/skills"
DEPLOY_KEY_PATH="/run/secrets/git_deploy_key"

log()  { echo "[load-web3-skills] $*"; }
warn() { echo "[load-web3-skills] WARN $*" >&2; }

REPO_URL="${WEB3_SKILLS_REPO:-git@github.com:protofire/web3-skills.git}"
BRANCH="${WEB3_SKILLS_BRANCH:-main}"

# ---------------------------------------------------------------------------
# Verify deploy key is available
# ---------------------------------------------------------------------------
if [[ ! -f "${DEPLOY_KEY_PATH}" ]]; then
  warn "SSH deploy key not found at ${DEPLOY_KEY_PATH}."
  warn "The private protofire/web3-skills repo will NOT be loaded."
  warn "See README.md → 'SSH Deploy Key Setup' for instructions."
  exit 0   # Non-fatal: agency runs without private skills
fi

# ---------------------------------------------------------------------------
# Configure SSH to use the deploy key
# ---------------------------------------------------------------------------
SSH_DIR="${HOME}/.ssh"
mkdir -p "${SSH_DIR}"
chmod 700 "${SSH_DIR}"

# Copy key (secrets are read-only bind mounts)
cp "${DEPLOY_KEY_PATH}" "${SSH_DIR}/web3_skills_deploy_key"
chmod 600 "${SSH_DIR}/web3_skills_deploy_key"

# SSH config: use deploy key exclusively for github.com
cat > "${SSH_DIR}/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${SSH_DIR}/web3_skills_deploy_key
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
EOF
chmod 600 "${SSH_DIR}/config"

log "SSH configured with deploy key."

# ---------------------------------------------------------------------------
# Clone or update web3-skills
# ---------------------------------------------------------------------------
if [[ -d "${WEB3_SKILLS_DIR}/.git" ]]; then
  log "Updating existing web3-skills clone (branch: ${BRANCH})..."
  git -C "${WEB3_SKILLS_DIR}" fetch origin "${BRANCH}"
  git -C "${WEB3_SKILLS_DIR}" reset --hard "origin/${BRANCH}"
else
  log "Cloning ${REPO_URL} (branch: ${BRANCH})..."
  GIT_SSH_COMMAND="ssh -F ${SSH_DIR}/config" \
    git clone --depth 1 --branch "${BRANCH}" \
      "${REPO_URL}" \
      "${WEB3_SKILLS_DIR}"
fi

log "web3-skills cloned successfully."

# ---------------------------------------------------------------------------
# Merge skills into NanoClaw
# ---------------------------------------------------------------------------
mkdir -p "${NANOCLAW_SKILLS_DIR}"

SKILLS_SOURCE="${WEB3_SKILLS_DIR}/skills"
if [[ -d "${SKILLS_SOURCE}" ]]; then
  log "Merging web3-skills/skills/ → nanoclaw/skills/..."
  cp -r "${SKILLS_SOURCE}/." "${NANOCLAW_SKILLS_DIR}/"
  SKILL_COUNT=$(find "${SKILLS_SOURCE}" -name "*.ts" -o -name "*.js" | wc -l | tr -d ' ')
  log "Merged ${SKILL_COUNT} skill file(s) from web3-skills."
else
  # Fallback: treat entire repo contents as skills directory
  log "No skills/ subdirectory found — merging entire repo as skills..."
  cp -r "${WEB3_SKILLS_DIR}/." "${NANOCLAW_SKILLS_DIR}/"
fi

# Copy patterns and good-practices docs if present
PATTERNS_SOURCE="${WEB3_SKILLS_DIR}/patterns"
if [[ -d "${PATTERNS_SOURCE}" ]]; then
  log "Copying Protofire patterns and good practices..."
  mkdir -p "${APP_DIR}/nanoclaw/patterns"
  cp -r "${PATTERNS_SOURCE}/." "${APP_DIR}/nanoclaw/patterns/"
fi

# ---------------------------------------------------------------------------
# Clean up SSH credentials from filesystem (key still in secret mount)
# ---------------------------------------------------------------------------
rm -f "${SSH_DIR}/web3_skills_deploy_key"
log "Deploy key removed from filesystem (still accessible via secret mount)."

log "web3-skills loading complete."
