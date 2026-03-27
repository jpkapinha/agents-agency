# =============================================================================
# jpkapinha/agents-agency
# Autonomous Web3 AI Agency — Andy the PM + specialist agents
# =============================================================================
FROM node:22-bookworm-slim AS base

LABEL org.opencontainers.image.source="https://github.com/jpkapinha/agents-agency"
LABEL org.opencontainers.image.description="Autonomous Web3 AI Agency — Andy the PM coordinates specialist agents"
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
    pandoc \
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

# Install GitHub CLI (gh) for PR creation and repo management
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
       https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
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
COPY --chown=agency:agency versions.lock /app/versions.lock
COPY --chown=agency:agency config/ /app/config/
COPY --chown=agency:agency setup/ /app/setup/
COPY --chown=agency:agency skills/ /app/skills/

# Make all setup scripts executable
RUN chmod +x /app/setup/*.sh

# ---------------------------------------------------------------------------
# Install skills dependencies (discord.js + tsx)
# ---------------------------------------------------------------------------
USER root
RUN cd /app/skills && npm install

# ---------------------------------------------------------------------------
# Pre-create runtime-writable directories
# ---------------------------------------------------------------------------
RUN mkdir -p /workspace /app/agency-agents /app/web3-skills \
    /app/roles /app/patterns

VOLUME ["/workspace"]

ENTRYPOINT ["/app/setup/entrypoint.sh"]
