# =============================================================================
# jpkapinha/agents-agency
# Production-ready NanoClaw Web3 Agency sandbox
# =============================================================================
FROM node:22-bookworm-slim AS base

LABEL org.opencontainers.image.source="https://github.com/jpkapinha/agents-agency"
LABEL org.opencontainers.image.description="NanoClaw Web3 Agency – agents-agency edition"
LABEL org.opencontainers.image.licenses="MIT"

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    openssh-client \
    gnupg \
    lsb-release \
    jq \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (socket passthrough – no daemon inside container)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
       https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Create non-root agency user
# ---------------------------------------------------------------------------
# FIX: Also add agency user to the docker group (gid 999) so it can access
#      the Docker socket when running without cap_drop:ALL
RUN groupadd --gid 999 docker 2>/dev/null || true \
    && groupadd --gid 1001 agency \
    && useradd --uid 1001 --gid agency --shell /bin/bash --create-home agency \
    && usermod -aG docker agency

WORKDIR /app

# ---------------------------------------------------------------------------
# Install Foundry (Forge, Cast, Anvil, Chisel)
# ---------------------------------------------------------------------------
USER agency
ENV PATH="/home/agency/.foundry/bin:$PATH"
RUN curl -L https://foundry.paradigm.xyz | bash \
    && /home/agency/.foundry/bin/foundryup

# ---------------------------------------------------------------------------
# Install Hardhat and global Node tooling
# ---------------------------------------------------------------------------
# FIX: Set npm prefix so global installs succeed as non-root user
#      (without this, npm install -g fails with EACCES on /usr/local/lib)
ENV NPM_CONFIG_PREFIX=/home/agency/.npm-global
ENV PATH="/home/agency/.npm-global/bin:${PATH}"
RUN npm install -g \
    hardhat \
    @nomicfoundation/hardhat-toolbox \
    typescript \
    ts-node \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Copy repo assets
# ---------------------------------------------------------------------------
# FIX: Copy versions.lock BEFORE cloning NanoClaw so the jq read in the
#      clone step finds the file (original had clone before copy)
COPY --chown=agency:agency versions.lock /app/versions.lock
COPY --chown=agency:agency config/ /app/config/
COPY --chown=agency:agency setup/ /app/setup/
COPY --chown=agency:agency skills/ /app/skills/

# Make all setup scripts executable
RUN chmod +x /app/setup/*.sh

# ---------------------------------------------------------------------------
# Clone & build NanoClaw (after versions.lock is available)
# ---------------------------------------------------------------------------
# FIX: Switch to root for clone — /app is root-owned and agency lacks write
#      permission; original used <<< here-string (bash-only, not POSIX sh)
#      and hard-coded the version instead of reading versions.lock
USER root
RUN NANOCLAW_REF=$(jq -r '.nanoclaw | split("@")[1]' /app/versions.lock) \
    && git clone --depth 1 --branch "${NANOCLAW_REF}" \
       https://github.com/qwibitai/nanoclaw.git /app/nanoclaw

# Pull in Discord channel from skill/discord branch
RUN curl -fsSL https://raw.githubusercontent.com/qwibitai/nanoclaw/skill/discord/src/channels/discord.ts \
       -o /app/nanoclaw/src/channels/discord.ts \
    && curl -fsSL https://raw.githubusercontent.com/qwibitai/nanoclaw/skill/discord/src/channels/index.ts \
       -o /app/nanoclaw/src/channels/index.ts

# FIX: Use plain `npm install` — original used --ignore-scripts which skips
#      the node-gyp build step, causing better-sqlite3 to fail at runtime
# FIX: Also install discord.js (required by skills/bot.ts)
RUN cd /app/nanoclaw && npm install && npm install discord.js@^14.18.0

# ---------------------------------------------------------------------------
# Pre-create runtime-writable directories
# ---------------------------------------------------------------------------
# FIX: Do NOT chown these to agency — entrypoint runs as root (required for
#      docker socket access with cap_drop:ALL which removes DAC_OVERRIDE)
RUN mkdir -p /workspace /app/agency-agents /app/web3-skills \
    /app/nanoclaw/config /app/nanoclaw/roles /app/nanoclaw/prompts \
    /app/nanoclaw/skills /app/nanoclaw/patterns

# FIX: Stay as root — docker socket is root:root 0660; cap_drop:ALL removes
#      DAC_OVERRIDE so even root group membership is insufficient without it
USER root

VOLUME ["/workspace"]

ENTRYPOINT ["/app/setup/entrypoint.sh"]
