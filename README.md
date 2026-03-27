# agents-agency

**A fully isolated, AI-powered Web3 development agency — spun up in under 30 seconds.**

[![Build & Push](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml/badge.svg)](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml)
[![GitHub Template](https://img.shields.io/badge/GitHub-Template-blue?logo=github)](https://github.com/jpkapinha/agents-agency/generate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://ghcr.io/jpkapinha/agents-agency)

---

## What is this?

This is a **GitHub Template repository** that gives any Protofire Project Manager a complete, production-ready AI development agency for Web3 projects — with a single command.

Every specialist agent (Product Manager, Tech Lead, Solutions Architect, Frontend Dev, Backend Dev, Solidity Dev, DevOps, Risk Manager) runs in its own **Docker MicroVM sandbox**, isolated from the host and from each other. The **Project Manager** is the only agent your team ever talks to — via Discord. Everything else happens autonomously behind the scenes.

Pre-loaded with:
- **[agency-agents](https://github.com/msitarzewski/agency-agents)** — battle-tested role definitions for the full agency
- **[protofire/web3-skills](https://github.com/protofire/web3-skills)** (private) — Protofire's proprietary patterns, good practices, and lessons learned from client projects
- **Foundry** + **Hardhat** — the two dominant smart contract development frameworks
- **Real-time cost tracking** — per-model spend logging with Discord alerts

---

## Features

| Feature | Details |
|---|---|
| One-command startup | `docker compose up -d` — ready in <30 seconds |
| MicroVM sandboxing | Every agent isolated; no agent can escape its container |
| Discord-first UX | PM talks to your team; all other agents work silently |
| Cost-optimized routing | Declarative model config — Opus for reasoning, Sonnet for coding, Grok for Solidity |
| Private skills loading | SSH deploy key for secure `protofire/web3-skills` access |
| Web3 toolchain | Foundry (forge, cast, anvil, chisel) + Hardhat pre-installed |
| GitHub Actions CI | Auto-builds and pushes to `ghcr.io` on every push to `main` |
| Dev Container | Open in VS Code / GitHub Codespaces with one click |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose on Linux)
- A [Discord bot token](https://discord.com/developers/applications) (takes ~5 minutes to set up)
- An [OpenRouter API key](https://openrouter.ai/) for model access

### Step 1 — Create your project repo from this template

Click **"Use this template"** on GitHub, or use the CLI:

```bash
gh repo create my-client-project \
  --template jpkapinha/agents-agency \
  --private \
  --clone
cd my-client-project
```

### Step 2 — Configure your environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
OPENROUTER_API_KEY=sk-or-v1-...        # Your OpenRouter key
DISCORD_BOT_TOKEN=...                   # Your Discord bot token
DISCORD_GUILD_ID=...                    # Your Discord server ID
DISCORD_PM_CHANNEL_ID=...              # Channel where PM posts updates
PROJECT_NAME=acme-defi-protocol        # Short name for this project
```

### Step 3 — (If using private web3-skills) Add your SSH deploy key

Place your read-only SSH deploy key in `secrets/git_deploy_key`:

```bash
# Paste or copy your private key into this file
nano secrets/git_deploy_key
chmod 600 secrets/git_deploy_key
```

> No deploy key? The agency still starts — it just won't load the private Protofire skills.
> See [SSH Deploy Key Setup](#ssh-deploy-key-setup) below.

### Step 4 — Launch the agency

```bash
docker compose up -d
```

That's it. Your Project Manager will post a "ready" message in your Discord channel within 30 seconds.

---

## Model Routing

Cost is controlled declaratively in `config/models.json`. You can change models per role without touching any code.

| Role | Model | Why |
|---|---|---|
| Project Manager | `claude-4.6-opus` | High-reasoning, client-facing quality |
| Solutions Architect | `claude-4.6-opus` | Architecture decisions require deep reasoning |
| Risk Manager | `claude-4.6-opus` | Security and risk analysis is high-stakes |
| Product Manager | `claude-4.6-sonnet` | Strong planning at lower cost |
| Tech Lead | `claude-4.6-sonnet` | Code review and technical coordination |
| Frontend Dev | `claude-4.6-sonnet` | UI/UX development |
| Backend Dev | `claude-4.6-sonnet` | API and service development |
| DevOps | `claude-4.6-sonnet` | Infrastructure and CI/CD |
| Solidity Dev | `grok-4.2` | Excellent on-chain reasoning and EVM expertise |

All models are routed through [OpenRouter](https://openrouter.ai/) — one API key, all models.

---

## Discord Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Under **Bot** → click **Add Bot** → copy the token → set `DISCORD_BOT_TOKEN`
3. Under **OAuth2 → URL Generator**: select `bot` scope + `Send Messages`, `Read Message History` permissions
4. Open the generated URL, add the bot to your server
5. Right-click your PM channel → **Copy Channel ID** → set `DISCORD_PM_CHANNEL_ID`
6. Right-click your server icon → **Copy Server ID** → set `DISCORD_GUILD_ID`

---

## SSH Deploy Key Setup

The `protofire/web3-skills` repository is private. Access it using a read-only SSH deploy key:

### 1. Generate a dedicated key pair

```bash
ssh-keygen -t ed25519 -C "agents-agency-deploy" -f ./web3-skills-deploy-key -N ""
```

This creates:
- `web3-skills-deploy-key` — private key (goes in `secrets/git_deploy_key`)
- `web3-skills-deploy-key.pub` — public key (added to GitHub)

### 2. Add the public key to the GitHub repository

Go to **github.com/protofire/web3-skills → Settings → Deploy keys → Add deploy key**

- Title: `nanoclaw-agency-[your-project-name]`
- Key: paste the contents of `web3-skills-deploy-key.pub`
- **Do NOT check** "Allow write access"

### 3. Place the private key in secrets/

```bash
cp web3-skills-deploy-key secrets/git_deploy_key
chmod 600 secrets/git_deploy_key
rm web3-skills-deploy-key web3-skills-deploy-key.pub
```

> The `secrets/git_deploy_key` file is in `.gitignore` — it will never be committed.

---

## Cost Tracking

The `skills/track-cost.ts` module logs per-call costs to stdout and fires a Discord warning when your session spend crosses `COST_WARNING_THRESHOLD_USD` (default: $5).

View live costs:

```bash
docker compose logs -f agency | grep cost-tracker
```

Example output:

```
[cost-tracker] solidity-dev (openrouter/xai/grok-4.2) in=1842 out=723 cost=$0.0198 | session_total=$0.1432
[cost-tracker] THRESHOLD EXCEEDED: ⚠️ Cost Warning — Project acme-defi has spent $5.03 USD this session
```

To change the threshold, update `COST_WARNING_THRESHOLD_USD` in your `.env`.

---

## Repository Structure

```
jpkapinha/agents-agency/
├── versions.lock              # Pinned versions for all dependencies
├── config/
│   └── models.json            # Declarative model routing per role
├── Dockerfile                 # Multi-stage build: Node 22 + Foundry + Hardhat + NanoClaw
├── docker-compose.yml         # Single-command agency launcher
├── .env.example               # Copy to .env and fill in your values
├── setup/
│   ├── entrypoint.sh          # Bootstrap orchestrator
│   ├── install-agency-agents.sh  # Clones msitarzewski/agency-agents
│   ├── load-web3-skills.sh    # SSH-clones protofire/web3-skills (private)
│   └── customize-pm.sh        # Wires PM to Discord, silences other agents
├── skills/
│   └── track-cost.ts          # Real-time cost tracking + Discord alerts
├── .github/
│   └── workflows/
│       └── build.yml          # CI: build + push to ghcr.io/jpkapinha/agents-agency
├── .devcontainer/
│   └── devcontainer.json      # VS Code / GitHub Codespaces config
├── project-data/              # Your project's code and files (mounted at /workspace)
└── secrets/                   # Place your git_deploy_key here (gitignored)
```

---

## Updating Pinned Versions

All external dependency versions are locked in `versions.lock`. To upgrade:

1. Edit `versions.lock` with the new version tags
2. Run `docker compose build --no-cache`
3. Test with `docker compose up`
4. Commit the updated `versions.lock`

---

## Enabling This as a GitHub Template

After creating the repository:

1. Go to **Settings → General**
2. Check **"Template repository"**
3. Your team can now use **"Use this template"** to spin up new projects instantly

---

## Contributing

Issues and PRs welcome. When contributing:

- Keep `versions.lock` up to date when changing dependency references
- Test with `docker compose build && docker compose up` before opening a PR
- The `protofire/web3-skills` skill library is maintained separately — open issues there for skill improvements

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*Built by [Protofire](https://protofire.io) using [NanoClaw](https://github.com/qwibitai/nanoclaw) and [agency-agents](https://github.com/msitarzewski/agency-agents).*
