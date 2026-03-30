#!/usr/bin/env bash
# =============================================================================
# load-web3-skills.sh
# Securely clones the private protofire/web3-skills repository using the
# SSH deploy key injected via Docker secrets, then merges skills into NanoClaw.
# =============================================================================
set -euo pipefail

APP_DIR="/app"
WEB3_SKILLS_DIR="${APP_DIR}/web3-skills"
PATTERNS_DIR="${APP_DIR}/patterns"
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
# Copy patterns and good-practices docs into /app/patterns/
# Agents read these via read_file("/app/patterns/<file>").
# ---------------------------------------------------------------------------
mkdir -p "${PATTERNS_DIR}"

PATTERNS_SOURCE="${WEB3_SKILLS_DIR}/patterns"
if [[ -d "${PATTERNS_SOURCE}" ]]; then
  log "Copying Protofire patterns → ${PATTERNS_DIR}..."
  find "${PATTERNS_SOURCE}" -mindepth 1 -maxdepth 1 ! -name '.git' -exec cp -r {} "${PATTERNS_DIR}/" \;
  PATTERN_COUNT=$(find "${PATTERNS_SOURCE}" -not -path '*/.git/*' -type f | wc -l | tr -d ' ')
  log "Copied ${PATTERN_COUNT} pattern file(s)."
else
  # Fallback: treat the whole repo as patterns if no patterns/ subdir (exclude .git)
  log "No patterns/ subdirectory found — copying entire repo as patterns..."
  find "${WEB3_SKILLS_DIR}" -mindepth 1 -maxdepth 1 ! -name '.git' -exec cp -r {} "${PATTERNS_DIR}/" \;
fi

# ---------------------------------------------------------------------------
# Clean up SSH credentials from filesystem (key still in secret mount)
# ---------------------------------------------------------------------------
rm -f "${SSH_DIR}/web3_skills_deploy_key"
log "Deploy key removed from filesystem (still accessible via secret mount)."

log "web3-skills loading complete."
