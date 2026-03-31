# agents-agency

**An autonomous AI development agency — talk to Andy the Project Manager in Discord, he handles the rest.**

[![Build & Push](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml/badge.svg)](https://github.com/jpkapinha/agents-agency/actions/workflows/build.yml)
[![GitHub Template](https://img.shields.io/badge/GitHub-Template-blue?logo=github)](https://github.com/jpkapinha/agents-agency/generate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://ghcr.io/jpkapinha/agents-agency)

---

## What is this?

A **GitHub Template** that gives you a complete autonomous Web3 development agency in one `docker compose up`.

You talk to **Andy**, the Project Manager, via Discord. Andy understands your requirements, turns them into a structured PRD for your approval, then delegates to specialist agents who write code, run tests, verify deliverables, and deliver results — all without you micromanaging a single step.

Andy's team writes Solidity contracts, runs Foundry tests, builds React frontends, sets up CI/CD, audits for security risks, and opens pull requests. Each task is tracked on a live board. After every build, a dedicated QA Verifier independently checks that files actually exist, then Tech Lead runs the test suite. Every token spent is tracked and visible.

---

## How it works

```
You (Discord) ──► Andy (PM)
                    │
                    ├── create_prd         → structured PRD + backlog, sent for APPROVED
                    ├── consult_agent → Solidity Dev      (writes, forge test, iterates — up to 120 rounds)
                    ├── consult_agent → Tech Lead          (architecture + auto test gate after builds)
                    ├── consult_agent → Frontend Dev       (React/Next.js components)
                    ├── consult_agent → Backend Dev        (APIs, indexers, databases)
                    ├── consult_agent → DevOps             (Docker, CI/CD, deployments)
                    ├── consult_agent → Risk Manager       (security audit, runs slither/solhint)
                    ├── consult_agent → Solutions Arch     (system design, validates with builds)
                    ├── consult_agent → QA Verifier        (auto-runs after every agent — verifies files exist)
                    └── hire_specialist → 187 external roles (UX, legal, data science, ...)
```

Each specialist runs an **agentic loop** (up to 40 rounds per segment × 3 auto-continuation segments = **120 effective rounds**): reads files, writes code, runs commands, fixes errors — until the task is done or it needs a decision from you. Agents work in the background; Andy stays responsive throughout.

---

## Features

| Feature | Details |
|---|---|
| **PRD + artifact approval gate** | Andy generates a PRD and backlog before any dev work; waits for APPROVED |
| **Shared artifacts folder** | All project docs live in `project-data/.agency/artifacts/` — edit with any text editor, Andy reads your changes before dispatching agents |
| **Pivot / realign flow** | Mid-development change requests trigger a structured change plan (editable), client approval, then targeted re-dispatch |
| **QA Verifier** | Independent read-only agent that runs after every task and verifies files actually exist and aren't stubs; auto-retries the agent once if anything is missing |
| **Agent auto-continuation** | Agents auto-resume across up to 3 segments (120 effective rounds) without human intervention — complex tasks complete fully |
| **Background execution** | Agents run fully in the background; Andy stays conversational and responsive while work happens |
| **Automatic test gate** | After every builder task, Tech Lead runs the test suite and reports PASS / FAIL / NEEDS-TESTS |
| **Model profiles** | Switch between `testing` (all kimi-k2.5, near-zero cost) and `production` (Opus/Sonnet per role) at any time; choice persists across restarts |
| **Cost tracking** | Token count + estimated USD shown after each task; ask Andy "how much have we spent?" |
| **Persistent memory** | Andy remembers tech stack, key decisions, and milestones across Docker restarts |
| Autonomous execution | Agents write code, run tests, iterate, and fix errors without hand-holding |
| Discord interface | Talk to Andy naturally — no @mention needed; share PDFs, images, Google Drive links, GitHub repos |
| Artifact delivery | Andy sends files (MD, PDF, specs, reports) as Discord attachments |
| GitHub integration | Andy clones repos, agents push code, open PRs via `gh` |
| Multiple repos | Track several GitHub repos per project; agents work across all of them |
| 187 specialists | Full agency-agents roster: UX, legal, marketing, data science, and more |
| Web3 toolchain | Foundry (forge, cast, anvil, chisel) + Hardhat pre-installed |
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

Andy will connect to Discord within ~30 seconds. The default model team is **testing** (all kimi-k2.5). Say "switch to production" at any time to upgrade.

### 4 — Talk to Andy

Just write in your Discord PM channel — no @mention needed:

```
hello, what can you do?
add the repo https://github.com/myorg/my-contracts
build an ERC-20 staking contract with a 30-day lockup period
run a security audit on the staking contract and send me the report
switch to production models
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
| `GITHUB_TOKEN` | _(none)_ | GitHub personal access token. Required for private repo clones, `git push`, and `gh pr create`. Needs `repo` + `workflow` scopes |
| `GITHUB_ORG` | `jpkapinha` | Your GitHub org/username |
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

Andy responds to every message in the PM channel — no @mention required.

---

## Talking to Andy

### Starting a project — PRD and artifact review first

Before writing a single line of code, Andy creates a PRD and backlog and puts them in the shared artifacts folder for you to review and edit:

```
You:  build a staking protocol where users stake ETH and earn daily rewards

Andy: 📋 PRD ready for review [uploads prd.md]

      Your files are in project-data/.agency/artifacts/ — open them in any editor.
      • prd.md — Product Requirements Document
      • backlog.md — Prioritised user stories

      **Decision needed:**
      Review and edit both files, then type APPROVED to start development.

You:  APPROVED

Andy: On it — involving Solidity Dev and Risk Manager.
      🔧 Solidity Developer — Write staking contract...
      ⚙️ Solidity Developer [7] run_command `forge test`
      ✅ Solidity Developer — done (12,400 tokens, ~$0.04)
      🔎 QA — verifying Solidity Developer's deliverables…
      ✅ QA — VERIFIED: contracts/Staking.sol (312 lines), test/Staking.t.sol (94 lines)
      🔍 Tech Lead — verifying tests…
      ✅ Tech Lead — PASS: 14/14 tests passing
```

### Background execution — Andy stays responsive

Agents run in the background. You can chat with Andy while work happens:

```
Andy: 🔧 Solidity Developer — writing staking contract... (background)

You:  what's the status?
Andy: Solidity Dev has been running for 2m 14s on the staking contract.
      You can keep chatting — I'll post updates as they finish.

You:  remind me what we decided about the proxy pattern
Andy: We're using UUPS proxies — decided on 2024-01-15 per your instruction.

... (a minute later) ...
Andy: ✅ Solidity Developer — done (12,400 tokens, ~$0.04)
```

### Artifact collaboration — edit files before development starts

All project documents live in `project-data/.agency/artifacts/` on your machine. Open them in any editor. Andy reads the latest version before dispatching each phase:

```
You:  show me our documents
Andy: **Project artifacts** (edit locally at project-data/.agency/artifacts/):
      • prd.md — Product Requirements Document (4.2 KB, last modified 2024-01-15 14:30)
      • backlog.md — Product backlog (2.1 KB, last modified 2024-01-15 14:35)
      • architecture.md — System architecture decisions (1.8 KB)
```

### Pivot / mid-development changes

Change your mind after development starts? Andy creates a structured change plan, gets your approval, then dispatches only the agents needed for the delta:

```
You:  actually, let's use ERC-4626 vault standard instead of the custom staking logic

Andy: Got it. Reading current PRD and backlog...
      [uploads change-plan.md]

      **Decision needed:**
      Review the change plan at project-data/.agency/artifacts/change-plan.md.
      Type APPROVED to proceed, or tell me what to adjust.

You:  APPROVED

Andy: Updating PRD and backlog, then redeploying Solidity Dev with the new spec...
```

### Model profiles — switch teams on the fly

The default team is **testing** (all kimi-k2.5, near-zero cost). Switch to production when you need maximum capability:

```
You:  switch to production

Andy: ✅ Switched to production — Best capability per role
      • project-manager: kimi-k2.5
      • tech-lead: claude-sonnet-4-5
      • solutions-architect: claude-opus-4-5
      • solidity-dev: claude-sonnet-4-5
      • risk-manager: claude-opus-4-5
      ...
      This setting persists across sessions.

You:  switch to testing
Andy: ✅ Switched to testing — all roles using kimi-k2.5
```

### QA verification — no more hallucinated files

After every agent completes, the QA Verifier independently checks that claimed files actually exist and have real content:

```
✅ Backend Developer — done (8,200 tokens, ~$0.01)
🔎 QA — verifying Backend Developer's deliverables…
⚠️ QA — issues found:
   FAILED: /workspace/api/routes/staking.ts not found
🔄 Backend Developer — retrying to fix QA issues…
⚙️ [retry] write_file → /workspace/api/routes/staking.ts
🔎 QA — re-verifying after retry…
✅ QA (re-check) — VERIFIED: api/routes/staking.ts (187 lines)
```

### Checking status and costs

```
You:  what's the status?
Andy: (calls get_state, lists tasks done/in-progress/blocked)

You:  how much have we spent?
Andy: **Cost summary** (8 tasks, 94,300 tokens total, ~$0.38 estimated):
      • Write staking contract — kimi-k2.5 — 12,400 tokens — ~$0.04
      • Security audit — claude-opus-4-5 — 31,200 tokens — ~$0.24
      ...
```

---

## Model Profiles

Configure which model each role uses in `config/models.json`. Switch profiles at any time in Discord — the choice persists across Docker restarts.

### testing (default)

All roles use `moonshotai/kimi-k2.5`. Near-zero cost. Good for iterating on flows, testing the agency itself, and early-stage exploration.

### production

| Role | Model | Reasoning |
|---|---|---|
| Project Manager | `kimi-k2.5` | Cost-efficient orchestration |
| Product Manager | `kimi-k2.5` | Requirements and roadmap |
| Frontend Dev | `kimi-k2.5` | UI component generation |
| DevOps | `kimi-k2.5` | Infrastructure config |
| QA Verifier | `kimi-k2.5` | Read-only file checks |
| Tech Lead | `claude-sonnet-4-5` | Code review + test execution |
| Backend Dev | `claude-sonnet-4-5` | APIs and services |
| Solidity Dev | `claude-sonnet-4-5` | Smart contract precision |
| Solutions Architect | `claude-opus-4-5` | Architecture requires deep thinking |
| Risk Manager | `claude-opus-4-5` | Security is high-stakes |

All models route through [OpenRouter](https://openrouter.ai/) — one key, all providers.

> **Adding profiles:** Edit `config/models.json` to add your own named profiles. Rebuild Docker to apply.

---

## Repository Structure

```
agents-agency/
├── Dockerfile                    # Node 22 + Foundry + Hardhat + gh CLI + pandoc + poppler-utils
├── docker-compose.yml            # Single-command launcher
├── versions.lock                 # Pinned versions for agency-agents
├── .env.example                  # Copy to .env and fill in
├── config/
│   └── models.json               # Model profiles: testing + production (add your own)
├── setup/
│   ├── entrypoint.sh             # Bootstrap: agency-agents → git config → launch bot
│   ├── install-agency-agents.sh  # Clones msitarzewski/agency-agents (187 roles)
│   ├── load-web3-skills.sh       # Optional: SSH-clones private web3-skills repo
│   └── customize-pm.sh           # Validates Discord token format
├── skills/
│   ├── bot.ts                    # Andy: PM loop, tool dispatch, artifact workflow, cost tracking
│   ├── agents.ts                 # Core team + external specialists, auto-continuation loop
│   ├── channel-send.ts           # Background message sender (abort-independent)
│   ├── tools.ts                  # Agent tools: read/write files, run commands, git, read_pdf
│   ├── state.ts                  # Project state: tasks, decisions, repos, memory, active profile
│   └── package.json              # discord.js + tsx
├── project-data/                 # Your project's workspace (mounted at /workspace)
│   └── .agency/
│       ├── artifacts/            # Shared docs — edit locally, Andy reads before each phase
│       ├── state.json            # Persistent state including active model profile
│       ├── costs.json            # Per-task token usage and estimated USD
│       ├── history-*.json        # Andy's conversation history per channel
│       └── uploads/              # PDFs and files attached in Discord
└── secrets/                      # Place git_deploy_key here for private skills (gitignored)
```

### Persistent storage

Everything in `project-data/` (mounted as `/workspace`) survives container restarts:

| Path | Contents |
|---|---|
| `/workspace/.agency/state.json` | Tasks, decisions, blockers, repos, project memory, active model profile |
| `/workspace/.agency/artifacts/` | Shared project documents — PRD, backlog, tasks, architecture, change plans |
| `/workspace/.agency/history-{channelId}.json` | Andy's conversation history (last 40 messages) |
| `/workspace/.agency/costs.json` | Per-task token usage and estimated USD cost log |
| `/workspace/.agency/uploads/` | PDFs and files attached in Discord |
| `/workspace/{repo-name}/` | Cloned GitHub repositories |
| `/workspace/` | All files agents write (contracts, components, APIs, docs) |

---

## Agent Capabilities

### Core team roles

| Role | Specialty | Tools |
|---|---|---|
| **Solidity Developer** | EVM contracts, DeFi, token standards, Foundry testing | read/write/run |
| **Frontend Developer** | React, Next.js, wagmi/viem, wallet UX, Tailwind | read/write/run |
| **Backend Developer** | Node.js APIs, event indexers, PostgreSQL/Redis, IPFS | read/write/run |
| **DevOps** | Docker, GitHub Actions, deployment scripts, monitoring | read/write/run + git |
| **Tech Lead** | Architecture review, test execution, code quality | read/run |
| **Solutions Architect** | End-to-end system design, on-chain + off-chain | read/write/run |
| **Risk Manager** | Security analysis, slither/solhint, threat modelling | read/run |
| **QA Verifier** | Verifies files exist and have real content after every task | read only |

### Auto-continuation (120 effective rounds)

Complex tasks like writing a full contract suite, setting up a multi-service backend, or debugging a failing test cycle can exceed the old 20-round limit. The agentic loop now runs up to **40 rounds per segment across 3 segments**. When a segment ends without task completion, the agent is automatically given a continuation prompt listing what it already did and resumes where it left off — no manual intervention needed.

```
⚙️ Solidity Developer [40] run_command `forge test`
↩️ Solidity Developer — auto-continuing (segment 2/3)
⚙️ Solidity Developer [41] write_file → contracts/StakingV2.sol
...
✅ Solidity Developer — done (87 rounds, 2 segments)
```

### QA Verifier — independent file verification

The QA Verifier runs automatically after **every** agent task, regardless of role. It is read-only (cannot write or run commands) and checks independently whether the files the agent claimed to create actually exist and have real content.

**Verdicts:**
- `VERIFIED:` — all claimed files confirmed with real content ✅
- `PARTIAL:` — some files exist, some missing → agent is retried once
- `FAILED:` — no deliverables found → agent is retried once
- `SKIPPED:` — analytical task, no files expected

If QA finds issues, the original agent is retried once with the specific QA feedback. QA runs again after the retry and reports the final result.

### Automatic test gate

After every `solidity-dev`, `frontend-dev`, or `backend-dev` task (and after QA passes), Andy automatically dispatches **Tech Lead** to:
1. Identify what was built
2. Run the appropriate test suite (`forge test` / `npm test` / `tsc --noEmit`)
3. Return a verdict: **PASS** / **FAIL** / **NEEDS-TESTS**

### Tool access per role

| Tool | Builder roles | Advisor roles | QA Verifier | External specialists |
|---|---|---|---|---|
| `read_file` | ✅ | ✅ | ✅ | ✅ |
| `read_pdf` | ✅ | ✅ | — | — |
| `write_file` | ✅ | ✅ (Arch) | — | ✅ (reports) |
| `list_files` | ✅ | ✅ | ✅ | ✅ |
| `run_command` | ✅ | ✅ | — | — |
| `git_commit` | DevOps only (`[COMMIT APPROVED]`) | — | — | — |

---

## Cost Control

### Model profiles

The fastest way to control cost: use `testing` profile (all kimi-k2.5) for exploration and switch to `production` only when you need maximum quality.

```
testing  → ~$0.001–0.005 per task (kimi-k2.5 everywhere)
production → ~$0.01–0.30 per task depending on role (Opus for arch/risk, Sonnet for builders)
```

### Per-task visibility

After every specialist completes a task:
```
✅ Solidity Developer — done (12,400 tokens, ~$0.04)
```

### Session summary

```
You:  how much have we spent?

Andy: Cost summary (8 tasks, 94,300 tokens total, ~$0.38 estimated):
      • Write staking contract — kimi-k2.5 — 12,400 tokens — <$0.01
      • Security audit — claude-opus-4-5 — 31,200 tokens — ~$0.24
      ...
```

Costs are logged to `/workspace/.agency/costs.json` and persist across restarts.

---

## GitHub Integration

Add `GITHUB_TOKEN` to your `.env` to enable:

- **Private repo cloning** — `add the repo https://github.com/myorg/private-contracts`
- **Git push** — agents push branches after completing work
- **Pull request creation** — `run_command("gh pr create ...")` in devops tasks
- **Authenticated API calls** — `gh` CLI is pre-installed and authenticated at startup

The token is configured via git URL rewrite so it is **never exposed in child process environments**.

**Required scopes:** `repo`, `workflow`

---

## Updating

To pull the latest agency-agents role definitions, simply rebuild:

```bash
docker compose build
docker compose up -d
```

The `install-agency-agents.sh` script re-clones `msitarzewski/agency-agents` at every startup, so role definitions always stay current without a rebuild.

---

## Optional: Private Web3 Skills

Load a private patterns repository (coding standards, internal tooling docs, best practices) at startup via SSH deploy key. All agents automatically see a note about available patterns and can read them with `read_file("/app/patterns/<file>")`.

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
WEB3_SKILLS_BRANCH=main
```

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
