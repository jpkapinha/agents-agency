# agents-agency

**An autonomous AI development agency — talk to Andy the Project Manager in Discord, he handles the rest.**

[![Build & Push](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml/badge.svg)](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml)
[![GitHub Template](https://img.shields.io/badge/GitHub-Template-blue?logo=github)](https://github.com/jpkapinha/agents-agency/generate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://ghcr.io/jpkapinha/agents-agency)

---

## What is this?

A **GitHub Template** that gives you a complete autonomous Web3 development agency in one `docker compose up`.

You talk to **Andy**, the Project Manager, via Discord. Andy understands your requirements, delegates to specialist agents, tracks progress, and delivers results — code committed to your GitHub repos, documents sent as Discord attachments, decisions escalated back to you when needed.

Everything happens autonomously in the background. Andy's team can write Solidity contracts, run Foundry tests, build React frontends, set up CI/CD, audit for security risks, and open pull requests — without you micromanaging a single step.

---

## How it works

```
You (Discord) ──► Andy (PM)
                    ├── consult_agent → Solidity Dev    (writes code, runs forge test, iterates)
                    ├── consult_agent → Tech Lead        (architecture review)
                    ├── consult_agent → Frontend Dev     (React/Next.js components)
                    ├── consult_agent → Backend Dev      (APIs, indexers, databases)
                    ├── consult_agent → DevOps           (Docker, CI/CD, deployments)
                    ├── consult_agent → Risk Manager     (security audit)
                    ├── consult_agent → Solutions Arch   (system design)
                    └── hire_specialist → 187 external roles (UX, legal, data science, ...)
```

Each specialist runs an **agentic loop** (up to 20 rounds): reads files, writes code, runs commands, fixes errors — until the task is done or it needs a decision from you.

Andy keeps you informed with progress updates in Discord and asks for your input only when a real decision is needed (architectural forks, before deploying, when genuinely blocked).

---

## Features

| Feature | Details |
|---|---|
| Autonomous execution | Agents write code, run tests, iterate, and fix errors without hand-holding |
| Discord interface | Talk to Andy naturally; he coordinates everything behind the scenes |
| Persistent memory | Andy remembers past conversations across restarts |
| Artifact delivery | Andy sends files (MD, PDF, specs, reports) as Discord attachments |
| GitHub integration | Andy clones repos, agents push code, open PRs via `gh` |
| Multiple repos | Track several GitHub repos per project; agents work across all of them |
| 187 specialists | Full agency-agents roster: UX, legal, marketing, data science, and more |
| Web3 toolchain | Foundry (forge, cast, anvil, chisel) + Hardhat pre-installed |
| Cost-optimized routing | Declarative model config per role in `config/models.json` |
| GitHub Actions CI | Auto-builds and pushes to `ghcr.io` on every push to `master` |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose)
- A [Discord bot token](https://discord.com/developers/applications)
- An [OpenRouter API key](https://openrouter.ai/)

### 1 — Create your project repo

Click **"Use this template"** on GitHub, or:

```bash
gh repo create my-web3-project \
  --template jpkapinha/agents-agency \
  --private \
  --clone
cd my-web3-project
```

### 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values (see [Environment Variables](#environment-variables) below).

### 3 — Launch

```bash
docker compose up -d
docker compose logs -f
```

Andy will connect to Discord within ~30 seconds. You'll see:

```
[bot] Discord connected as YourBot#1234
[bot] PM channel ready: #your-channel
```

### 4 — Talk to Andy

In your Discord PM channel:

```
@Andy hello, what can you do?
@Andy add the repo https://github.com/myorg/my-contracts
@Andy build an ERC-20 staking contract with a 30-day lockup period
@Andy run a security audit on the staking contract and send me the report
```

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | Your OpenRouter key. Get one at [openrouter.ai](https://openrouter.ai) |
| `DISCORD_BOT_TOKEN` | Your Discord bot token. See [Discord Setup](#discord-setup) |
| `DISCORD_GUILD_ID` | Your Discord server (guild) ID |
| `DISCORD_PM_CHANNEL_ID` | Channel ID where Andy posts updates and receives messages |
| `PROJECT_NAME` | Short name for this project, e.g. `acme-defi-protocol` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `GITHUB_TOKEN` | _(none)_ | GitHub personal access token. Required for private repo clones, `git push`, and `gh pr create`. Needs `repo` + `workflow` scopes. Create at [github.com/settings/tokens](https://github.com/settings/tokens) |
| `GITHUB_ORG` | `jpkapinha` | Your GitHub org/username, used in log messages |
| `COST_WARNING_THRESHOLD_USD` | `5` | Discord alert when session spend exceeds this amount |
| `WEB3_SKILLS_REPO` | _(protofire private)_ | SSH URL for a private web3-skills repo (see [Private Skills](#optional-private-web3-skills)) |
| `WEB3_SKILLS_BRANCH` | `main` | Branch to clone from the web3-skills repo |

---

## Discord Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Under **Bot** → **Add Bot** → copy the token → set `DISCORD_BOT_TOKEN`
3. Under **Bot** → **Privileged Gateway Intents** → enable **Message Content Intent**
4. Under **OAuth2 → URL Generator**: select scope `bot` + permissions `Send Messages`, `Read Message History`, `Attach Files`
5. Open the generated URL and add the bot to your server
6. Right-click your PM channel → **Copy Channel ID** → set `DISCORD_PM_CHANNEL_ID`
7. Right-click your server icon → **Copy Server ID** → set `DISCORD_GUILD_ID`

Andy responds to `@mention` or messages starting with `@andy`.

---

## Talking to Andy

### Starting a task

Andy acknowledges immediately and works in the background:

```
You: @Andy build an ERC-20 staking contract with 30-day lockup
Andy: On it.
Andy: ⚙️ Planning — involving Solidity Dev and Risk Manager
Andy: ⚙️ Solidity Developer: round 4, last action: run_command
Andy: Contract complete. 8/8 tests passing. Risk Manager found one medium issue...
```

### Adding GitHub repositories

Andy can work across multiple repos in the same project:

```
You: @Andy add our contracts repo https://github.com/myorg/contracts
Andy: Cloned contracts → /workspace/contracts. Ready to work in it.

You: @Andy add the frontend repo https://github.com/myorg/frontend
Andy: Cloned frontend → /workspace/frontend.
```

### Receiving documents

Andy delivers artifacts directly in Discord:

```
You: @Andy write an architecture overview and send it to me as a PDF
Andy: [uploads architecture.pdf as Discord attachment]
```

Agents can produce any file type. PDF generation uses `pandoc` (pre-installed).

### Interrupting and pivoting

Send a new message at any time to cancel the current task and redirect:

```
You: @Andy build a lending protocol
Andy: On it.
... (working) ...
You: @Andy actually, focus on the staking contract first
Andy: Noted — pivoting to your new request.
```

### Decisions

Andy asks for your input only when genuinely needed:

```
Andy: **Decision needed:**
      Reentrancy found in withdraw(). How should we fix it?

      Options:
      1. Add nonReentrant guard (OpenZeppelin)
      2. Redesign withdraw flow (checks-effects-interactions)
      3. Deprioritise — flag for audit

You: 1
Andy: On it — applying nonReentrant guard...
```

---

## Model Routing

Configure which model each role uses in `config/models.json`. No code changes needed.

| Role | Default Model | Reasoning |
|---|---|---|
| Project Manager | `anthropic/claude-4.6-sonnet` | Client-facing orchestration |
| Product Manager | `anthropic/claude-4.6-sonnet` | Requirements and roadmap |
| Solutions Architect | `anthropic/claude-4.6-opus` | Architecture decisions require deep thinking |
| Risk Manager | `anthropic/claude-4.6-opus` | Security is high-stakes |
| Tech Lead | `anthropic/claude-4.6-sonnet` | Code review and coordination |
| Frontend Dev | `anthropic/claude-4.6-sonnet` | React/Next.js development |
| Backend Dev | `anthropic/claude-4.6-sonnet` | APIs and services |
| DevOps | `anthropic/claude-4.6-sonnet` | Infrastructure |
| Solidity Dev | `anthropic/claude-4.6-sonnet` | Smart contract development |

All models route through [OpenRouter](https://openrouter.ai/) — one key, all providers.

---

## Repository Structure

```
agents-agency/
├── Dockerfile                    # Node 22 + Foundry + Hardhat + gh CLI + pandoc
├── docker-compose.yml            # Single-command launcher
├── versions.lock                 # Pinned versions for agency-agents
├── .env.example                  # Copy to .env and fill in
├── config/
│   └── models.json               # Model routing per agent role
├── setup/
│   ├── entrypoint.sh             # Bootstrap: agency-agents → git config → launch bot
│   ├── install-agency-agents.sh  # Clones msitarzewski/agency-agents (187 roles)
│   ├── load-web3-skills.sh       # Optional: SSH-clones private web3-skills repo
│   └── customize-pm.sh           # Validates Discord token format
├── skills/
│   ├── bot.ts                    # Andy: Discord client, PM agentic loop, tool dispatch
│   ├── agents.ts                 # Core team + external specialist definitions and runner
│   ├── tools.ts                  # Agent tools: read/write files, run commands, git
│   ├── state.ts                  # Project state: tasks, decisions, blockers, repos
│   ├── track-cost.ts             # Cost tracking (informational)
│   └── package.json              # discord.js + tsx
├── project-data/                 # Your project's workspace (mounted at /workspace)
│   └── .agency/                  # Auto-created: state.json, conversation history
└── secrets/                      # Place git_deploy_key here for private skills (gitignored)
```

### Persistent storage

Everything in `project-data/` (mounted as `/workspace`) survives container restarts:

| Path | Contents |
|---|---|
| `/workspace/.agency/state.json` | Tasks, decisions, blockers, registered repos |
| `/workspace/.agency/history-{channelId}.json` | Andy's conversation history per channel |
| `/workspace/{repo-name}/` | Cloned GitHub repositories |
| `/workspace/` | All files agents write (contracts, components, docs, etc.) |

---

## Agent Capabilities

### What agents can do

| Tool | Who has it | What it does |
|---|---|---|
| `read_file` | All agents | Read any file in `/workspace` |
| `write_file` | Builders only | Write/create files in `/workspace` |
| `list_files` | All agents | List files recursively |
| `run_command` | Builders only | Run shell commands (forge, npm, gh, pandoc, etc.) |
| `git_status` / `git_diff` | DevOps | Check repo state |
| `git_commit` | DevOps | Commit changes (only when Andy includes `[COMMIT APPROVED]`) |

**Builder roles** (can write and execute): `solidity-dev`, `frontend-dev`, `backend-dev`, `devops`

**Advisor roles** (read-only): `tech-lead`, `solutions-architect`, `risk-manager`

**External specialists** (187 roles, read-only): hired by Andy via `hire_specialist` for UX, legal, marketing, data science, technical writing, and more.

### What agents produce

- Smart contracts (`forge build`, `forge test`)
- Frontend components (React, Next.js, Tailwind)
- Backend services (Node.js, TypeScript, APIs)
- Infrastructure config (Docker, GitHub Actions)
- Architecture documents (`/workspace/.agency/architecture.md`)
- PDF reports (`pandoc doc.md -o doc.pdf`)
- GitHub pull requests (`gh pr create`)

---

## GitHub Integration

Add `GITHUB_TOKEN` to your `.env` to enable:

- **Private repo cloning** — `@Andy add the repo https://github.com/myorg/private-contracts`
- **Git push** — agents push branches after completing work
- **Pull request creation** — `run_command("gh pr create --title '...' --body '...'")` in devops tasks
- **Authenticated API calls** — `gh` CLI is pre-installed and authenticated at startup

The token is configured via git URL rewrite so it is **never exposed in child process environments** — agents run in a sanitised env and git auth is transparent.

**Required scopes:** `repo`, `workflow`

---

## Updating

To pull the latest agency-agents role definitions, simply rebuild:

```bash
docker compose build
docker compose up -d
```

The `install-agency-agents.sh` script re-clones `msitarzewski/agency-agents` at every startup, so role definitions always stay current without a rebuild.

To upgrade pinned versions, edit `versions.lock` and rebuild.

---

## Optional: Private Web3 Skills

If you have a private patterns repository (good practices, coding standards, internal tooling docs), you can load it at startup via SSH deploy key.

At startup, `load-web3-skills.sh` clones the repo and copies its `patterns/` subdirectory (or the full repo if no `patterns/` subdir exists) to `/app/patterns/` inside the container. All agents automatically receive a note about available patterns in their system prompt and can read them with `read_file("/app/patterns/<file>")` and `list_files("/app/patterns")`.

### 1. Generate a key pair

```bash
ssh-keygen -t ed25519 -C "agents-agency-deploy" -f ./web3-skills-key -N ""
```

### 2. Add the public key to GitHub

Go to your private repo → **Settings → Deploy keys → Add deploy key**. Paste `web3-skills-key.pub`. Read-only is sufficient.

### 3. Place the private key in `secrets/`

```bash
cp web3-skills-key secrets/git_deploy_key
chmod 600 secrets/git_deploy_key
rm web3-skills-key web3-skills-key.pub
```

### 4. Set the repo URL in `.env`

```env
WEB3_SKILLS_REPO=git@github.com:yourorg/web3-skills.git
WEB3_SKILLS_BRANCH=main   # optional, defaults to main
```

The `secrets/` directory is gitignored — the key will never be committed. The deploy key is also removed from the container filesystem after cloning (it remains accessible only via the Docker secret mount).

---

## Enabling as a GitHub Template

After creating your fork:

1. Go to **Settings → General**
2. Check **"Template repository"**

Your team can then click **"Use this template"** to spin up a new project instantly.

---

## Contributing

Issues and PRs welcome.

- Keep `versions.lock` updated when changing dependency references
- Test with `docker compose build && docker compose up -d` before opening a PR
- The agent role definitions live in [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) — open issues there for role improvements

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*Built on [agency-agents](https://github.com/msitarzewski/agency-agents) and [OpenRouter](https://openrouter.ai/).*
