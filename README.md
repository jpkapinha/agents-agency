# agents-agency

**An autonomous AI development agency — talk to Andy the Project Manager in Discord, he handles the rest.**

[![Build & Push](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml/badge.svg)](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml)
[![GitHub Template](https://img.shields.io/badge/GitHub-Template-blue?logo=github)](https://github.com/jpkapinha/agents-agency/generate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://ghcr.io/jpkapinha/agents-agency)

---

## What is this?

A **GitHub Template** that gives you a complete autonomous Web3 development agency in one `docker compose up`.

You talk to **Andy**, the Project Manager, via Discord. Andy understands your requirements, turns them into a structured PRD for your approval, then delegates to specialist agents who write code, run tests, and deliver results — all without you micromanaging a single step.

Andy's team writes Solidity contracts, runs Foundry tests, builds React frontends, sets up CI/CD, audits for security risks, and opens pull requests. Each task is tracked on a live project board. After every build, the Tech Lead automatically runs the test suite and reports back. Every token spent is tracked and visible.

---

## How it works

```
You (Discord) ──► Andy (PM)
                    │
                    ├── create_prd        → structured PRD, sent to you for APPROVED
                    ├── consult_agent → Solidity Dev    (writes code, runs forge test, iterates)
                    ├── consult_agent → Tech Lead        (architecture + auto test gate after builds)
                    ├── consult_agent → Frontend Dev     (React/Next.js components)
                    ├── consult_agent → Backend Dev      (APIs, indexers, databases)
                    ├── consult_agent → DevOps           (Docker, CI/CD, deployments)
                    ├── consult_agent → Risk Manager     (security audit, runs slither/solhint)
                    ├── consult_agent → Solutions Arch   (system design, validates with builds)
                    └── hire_specialist → 187 external roles (UX, legal, data science, ...)
                                           └── writes report to /workspace/.agency/reports/
```

Each specialist runs an **agentic loop** (up to 20 rounds): reads files, writes code, runs commands, fixes errors — until the task is done or it needs a decision from you.

Andy keeps you informed with progress updates in Discord, reports token usage and cost after each task, and asks for your input only when a real decision is needed.

---

## Features

| Feature | Details |
|---|---|
| **PRD approval gate** | Andy generates a structured PRD before any dev work and waits for your APPROVED |
| **Automatic task board** | Every specialist task is logged as pending → in-progress → done/blocked in real time |
| **Test gate** | After every builder task, Tech Lead automatically runs the test suite and reports PASS/FAIL |
| **Cost tracking** | Token count + estimated USD shown after each task; ask Andy "how much have we spent?" |
| **Persistent memory** | Andy remembers tech stack choices, key decisions, and milestones across Docker restarts |
| Autonomous execution | Agents write code, run tests, iterate, and fix errors without hand-holding |
| Discord interface | Talk to Andy naturally — share PDFs, images, Google Drive links, GitHub repos, code snippets |
| Artifact delivery | Andy sends files (MD, PDF, specs, reports) as Discord attachments |
| GitHub integration | Andy clones repos, agents push code, open PRs via `gh` |
| Multiple repos | Track several GitHub repos per project; agents work across all of them |
| 187 specialists | Full agency-agents roster: UX, legal, marketing, data science, and more |
| Web3 toolchain | Foundry (forge, cast, anvil, chisel) + Hardhat pre-installed |
| Cost-optimized routing | kimi-k2.5 for routine roles, Claude for precision roles — configurable in `config/models.json` |
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
| `WEB3_SKILLS_REPO` | _(none)_ | SSH URL for a private web3-skills repo (see [Private Skills](#optional-private-web3-skills)) |
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

### Starting a project — PRD first

Before writing a single line of code, Andy generates a structured PRD and sends it to you for approval:

```
You:  @Andy build a staking protocol where users stake ETH and earn daily rewards

Andy: 📋 PRD ready for review [uploads prd.md as Discord attachment]

      **Decision needed:**
      Please review the PRD. Type APPROVED when ready to start development,
      or tell me what to change.

You:  APPROVED

Andy: On it — involving Solidity Dev and Risk Manager.
      🔧 Solidity Developer — Write staking contract with daily reward accrual...
      ⚙️ Solidity Developer [3] run_command `forge build`
      ⚙️ Solidity Developer [7] run_command `forge test`
      ✅ Solidity Developer — done (12,400 tokens, ~$0.04)
      🔍 Tech Lead — verifying tests…
      ✅ Tech Lead — PASS: 14/14 tests passing, no critical issues
```

### Sharing files with Andy

Andy handles everything a human colleague would send you:

```
You:  @Andy [attaches requirements.pdf]
Andy: (reads PDF, summarises it, asks if you want a PRD)

You:  @Andy here's the spec https://docs.google.com/...
Andy: (fetches the Google Doc, reads it, proceeds)

You:  @Andy [attaches screenshot of UI mockup]
Andy: (describes what he sees, asks relevant questions)
```

### Checking project status and costs

```
You:  @Andy what's the status?
Andy: (calls get_state, lists tasks done/in-progress/blocked)

You:  @Andy how much have we spent so far?
Andy: **Cost summary** (8 tasks, 94,300 tokens total, ~$0.38 estimated):
      • Write staking contract — kimi-k2.5 — 12,400 tokens — ~$0.04
      • Verify tests — claude-4.6-sonnet — 8,200 tokens — ~$0.12
      ...
```

### Receiving documents and artifacts

```
You:  @Andy write an architecture overview and send it as a PDF
Andy: [uploads architecture.pdf as Discord attachment]

You:  @Andy hire a UX designer to review the user flows
Andy: 🔍 Hiring UX designer…
      ✅ UX Designer — done
      (report saved to /workspace/.agency/reports/ux-designer-1234567890.md)
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

You:  1
Andy: On it — applying nonReentrant guard...
```

### Project memory across sessions

Andy remembers key decisions even after Docker restarts:

```
You:  @Andy remember we're using UUPS proxies and wagmi v2

Andy: (calls update_memory — stored permanently)

... (weeks later, after docker compose down && up) ...

You:  @Andy what's our tech stack?
Andy: Solidity 0.8.24, UUPS proxies, Next.js 14, wagmi v2 — as decided on [date].
```

---

## Model Routing

Configure which model each role uses in `config/models.json`. No code changes needed.

| Role | Default Model | Reasoning |
|---|---|---|
| Project Manager | `moonshotai/kimi-k2.5` | Cost-efficient orchestration |
| Product Manager | `moonshotai/kimi-k2.5` | Requirements and roadmap |
| Frontend Dev | `moonshotai/kimi-k2.5` | UI component generation |
| DevOps | `moonshotai/kimi-k2.5` | Infrastructure config |
| Tech Lead | `anthropic/claude-4.6-sonnet` | Code review + test execution |
| Backend Dev | `anthropic/claude-4.6-sonnet` | APIs and services |
| Solidity Dev | `anthropic/claude-4.6-sonnet` | Smart contract precision |
| Solutions Architect | `anthropic/claude-4.6-opus` | Architecture requires deep thinking |
| Risk Manager | `anthropic/claude-4.6-opus` | Security is high-stakes |

All models route through [OpenRouter](https://openrouter.ai/) — one key, all providers.

> **Cost tip**: kimi-k2.5 is ~20x cheaper than Claude Sonnet for routine tasks with no quality loss. Opus is reserved only for decisions where it matters.

---

## Repository Structure

```
agents-agency/
├── Dockerfile                    # Node 22 + Foundry + Hardhat + gh CLI + pandoc + poppler-utils
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
│   ├── bot.ts                    # Andy: PM loop, tool dispatch, PRD gate, cost tracking
│   ├── agents.ts                 # Core team + external specialist definitions and runner
│   ├── tools.ts                  # Agent tools: read/write files, run commands, git, read_pdf
│   ├── state.ts                  # Project state: tasks, decisions, blockers, repos, memory
│   └── package.json              # discord.js + tsx
├── project-data/                 # Your project's workspace (mounted at /workspace)
│   └── .agency/                  # Auto-created: state, history, PRD, costs, uploads
└── secrets/                      # Place git_deploy_key here for private skills (gitignored)
```

### Persistent storage

Everything in `project-data/` (mounted as `/workspace`) survives container restarts:

| Path | Contents |
|---|---|
| `/workspace/.agency/state.json` | Tasks, decisions, blockers, registered repos, project memory |
| `/workspace/.agency/history-{channelId}.json` | Andy's conversation history per channel (last 40 messages) |
| `/workspace/.agency/prd.md` | Latest PRD generated by Andy |
| `/workspace/.agency/costs.json` | Per-task token usage and estimated USD cost log |
| `/workspace/.agency/uploads/` | PDFs and files attached by you in Discord |
| `/workspace/.agency/reports/` | Analysis reports written by hired external specialists |
| `/workspace/{repo-name}/` | Cloned GitHub repositories |
| `/workspace/` | All files agents write (contracts, components, docs, etc.) |

---

## Agent Capabilities

### Tool access per role

| Tool | Builder roles | Advisor roles | External specialists |
|---|---|---|---|
| `read_file` | ✅ | ✅ | ✅ |
| `read_pdf` | ✅ | ✅ | — |
| `write_file` | ✅ | ✅ (Arch) | ✅ (reports only) |
| `list_files` | ✅ | ✅ | ✅ |
| `run_command` | ✅ | ✅ | — |
| `git_status` / `git_diff` | DevOps only | — | — |
| `git_commit` | DevOps only (with `[COMMIT APPROVED]`) | — | — |

**Builder roles** (write + execute): `solidity-dev`, `frontend-dev`, `backend-dev`, `devops`

**Advisor roles** (read + execute, no write except Arch): `tech-lead`, `solutions-architect`, `risk-manager`
- Tech Lead runs `forge test`, `npm test`, `tsc --noEmit` to verify work
- Risk Manager runs `slither`, `solhint`, `npm audit` for static analysis
- Solutions Architect runs builds to validate architecture decisions

**External specialists** (read + write reports): hired by Andy via `hire_specialist`. Output persisted to `/workspace/.agency/reports/`.

### Automatic test gate

After every `solidity-dev`, `frontend-dev`, or `backend-dev` task completes, Andy automatically dispatches **Tech Lead** to:
1. Identify what was built
2. Run the appropriate test suite (`forge test` / `npm test` / `tsc --noEmit`)
3. Return a verdict: **PASS** / **FAIL** / **NEEDS-TESTS**

If tests fail, the result is reported back with specific failures so you can decide whether to fix immediately or continue.

### What agents produce

- Smart contracts (`forge build`, `forge test`)
- Frontend components (React, Next.js, Tailwind)
- Backend services (Node.js, TypeScript, APIs)
- Infrastructure config (Docker, GitHub Actions)
- Architecture documents (`/workspace/.agency/architecture.md`)
- PDF reports (`pandoc doc.md -o doc.pdf`)
- GitHub pull requests (`gh pr create`)
- PRDs and specs (`/workspace/.agency/prd.md`)

---

## Cost Control

### Per-task visibility

After every specialist completes a task:
```
✅ Solidity Developer — done (12,400 tokens, ~$0.04)
```

### Session summary

Ask Andy at any time:
```
@Andy how much have we spent?
```

Andy calls `get_costs` and returns a breakdown:
```
Cost summary (8 tasks, 94,300 tokens total, ~$0.38 estimated):
• Write staking contract — kimi-k2.5 — 12,400 tokens — <$0.01
• Security audit — claude-4.6-opus — 31,200 tokens — ~$0.24
...
```

Costs are logged to `/workspace/.agency/costs.json` and persist across restarts.

### Budget tips

- Use `COST_WARNING_THRESHOLD_USD` in `.env` to get Discord alerts when session spend exceeds a threshold
- Advisor roles (Tech Lead, Risk Manager) use Claude for quality — keep Solidity dev tasks focused to limit their rounds
- kimi-k2.5 handles PM, Frontend, DevOps at a fraction of Claude's cost with no noticeable quality difference for those roles

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

The `secrets/` directory is gitignored — the key will never be committed.

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

*Built on [NanoClaw](https://github.com/msitarzewski/nanoclaw), [agency-agents](https://github.com/msitarzewski/agency-agents), and [OpenRouter](https://openrouter.ai/).*
