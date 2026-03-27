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
RUN groupadd --gid 1001 agency \
    && useradd --uid 1001 --gid agency --shell /bin/bash --create-home agency

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
RUN npm install -g \
    hardhat \
    @nomicfoundation/hardhat-toolbox \
    typescript \
    ts-node \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Clone NanoClaw at pinned version
# ---------------------------------------------------------------------------
USER root
RUN NANOCLAW_REF=$(jq -r '.nanoclaw | split("@")[1]' /dev/stdin <<< '{"nanoclaw":"qwibitai/nanoclaw@v1.2.34"}') \
    && git clone --depth 1 --branch "${NANOCLAW_REF}" \
       https://github.com/qwibitai/nanoclaw.git /app/nanoclaw \
    && chown -R agency:agency /app/nanoclaw

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
# Workspace volume mount point
# ---------------------------------------------------------------------------
RUN mkdir -p /workspace && chown agency:agency /workspace

USER agency

VOLUME ["/workspace"]

ENTRYPOINT ["/app/setup/entrypoint.sh"]
