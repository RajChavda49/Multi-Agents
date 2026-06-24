# SDLC Agents — Phase 1

12-agent SDLC automation system. **Phase 1** covers Planning (A1 → A2 → A3 → Gate 1).

Stack: **Node.js** (Express + LangGraph JS) · **Vite/React/Tailwind** dashboard · **CLI**

## Quick Start

### 1. Backend API

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

API: `http://localhost:3001`

### 2. Dashboard

```bash
cd dashboard
npm install
npm run dev
```

Dashboard: `http://localhost:5173` (proxies `/api` → backend)

### 3. CLI

```bash
cd backend
npm run cli -- list
npm run cli -- create -k PROJ-42 -s "Add user profile page"
npm run cli -- show <pipeline-id>
npm run cli -- approve <pipeline-id>
npm run cli -- reject <pipeline-id> -f "Needs more API detail"
```

## Connect a local project codebase

Point agents at any project on your machine. Later you can swap this for a Git clone path.

### 1. Set path in `backend/.env`

```env
TARGET_REPO_PATH=/home/you/projects/my-app
TARGET_REPO_WRITE=true
```

Use an **absolute path** to the project root (where `package.json` lives).

### 2. Restart backend

```bash
curl http://localhost:3001/api/repo/status
```

You should see `connected: true`, project `name`, and detected `stack` (react, next.js, etc.).

### 3. What agents do with it

| Agent | Uses local repo |
|-------|-----------------|
| **A1** | Scans folder tree, README, package.json, keyword-matched files |
| **A2–A6** | Plans & generates code matching your project layout |
| **A4–A6 write** | Saves to sandbox **and** your project (if `TARGET_REPO_WRITE=true`) |
| **A7** | Runs `npm run lint` in your project when available |

### 4. Safety

- Paths are validated — agents cannot write outside `TARGET_REPO_PATH`
- Set `TARGET_REPO_WRITE=false` to scan only (sandbox copies for review)
- Use a feature branch in your project before enabling writes in production code

### GitLab (recommended)

When `GITLAB_*` vars are set, they take priority over `TARGET_REPO_PATH`:

```env
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=glpat-...
GITLAB_PROJECT_PATH=your-group/your-project
GITLAB_DEFAULT_BRANCH=main
GITLAB_WRITE=true
GITLAB_CREATE_MR=true
```

Flow per Jira task:

1. Clone/pull project into `backend/data/repos/`
2. Checkout branch `sdlc/{JIRA-KEY}` before A4–A6
3. Write generated files into the clone
4. After Gate 2 approval + A7–A9, commit, push, and open a merge request (MR URL posted to Jira)

```bash
curl http://localhost:3001/api/gitlab/status
curl -X POST http://localhost:3001/api/gitlab/sync
```

Token needs `read_repository`, `write_repository`, and `api` scopes.

### Local path only (fallback)

If GitLab is not configured, use `TARGET_REPO_PATH` as above.

## Phase 1 Flow

```
Jira Task → A1 Knowledge → A2 Dev Plan → A3 Test Cases → 🛑 Gate 1 (HITL)
```

- **A1** — Scans connected local codebase (or generic context if `TARGET_REPO_PATH` unset)
- **A2** — Technical specification (JSON)
- **A3** — Playwright-oriented test case library
- **Gate 1** — LangGraph `interrupt()` pauses until human approves via dashboard or CLI

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | API port |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama endpoint (required — all agents use live LLM) |
| `OLLAMA_REASONING_MODEL` | llama3 | Model for A1–A3, A7–A9 |
| `OLLAMA_CODING_MODEL` | qwen2.5-coder | Model for A4–A6 |
| `JIRA_BASE_URL` | — | Jira Cloud site URL (e.g. `https://acme.atlassian.net`) |
| `JIRA_EMAIL` | — | Atlassian account email |
| `JIRA_API_TOKEN` | — | API token from Atlassian account settings |
| `JIRA_PROJECT_KEY` | — | Default project for task listing (e.g. `PROJ`) |
| `GITLAB_BASE_URL` | https://gitlab.com | GitLab instance URL |
| `GITLAB_TOKEN` | — | Personal access token (`api`, `read_repository`, `write_repository`) |
| `GITLAB_PROJECT_PATH` | — | Project path e.g. `group/project` |
| `GITLAB_DEFAULT_BRANCH` | main | Branch to clone from |
| `GITLAB_WRITE` | true | Write generated code into clone |
| `GITLAB_CREATE_MR` | true | Open MR after Phase 2 completes |

## Jira Integration

1. Create an API token: [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Add to `backend/.env`:
   ```env
   JIRA_BASE_URL=https://your-domain.atlassian.net
   JIRA_EMAIL=you@company.com
   JIRA_API_TOKEN=your-token
   JIRA_PROJECT_KEY=PROJ
   ```
3. Restart the backend

```bash
npm run cli -- jira status
npm run cli -- jira list
npm run cli -- jira show PROJ-123
npm run cli -- create -k PROJ-123 --from-jira
```

Dashboard shows a **Live Jira Tasks** panel when connected — click **Start** to run Phase 1 on any issue.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/jira/status` | Jira connection status |
| GET | `/api/jira/tasks` | List live Jira issues (`?jql=&limit=`) |
| GET | `/api/jira/tasks/:key` | Fetch single Jira issue |
| GET | `/api/gitlab/status` | GitLab connection + clone status |
| POST | `/api/gitlab/sync` | Clone or pull GitLab project |
| GET | `/api/repo/status` | Effective repo target (GitLab or local) |
| GET | `/api/pipelines` | List pipelines |
| GET | `/api/pipelines/:id` | Pipeline detail |
| POST | `/api/pipelines` | Create & run Phase 1 |
| POST | `/api/pipelines/from-jira/:key` | Create from live Jira issue |
| POST | `/api/pipelines/:id/approve` | Approve Gate 1 |
| POST | `/api/pipelines/:id/reject` | Reject Gate 1 |
| POST | `/api/webhooks/jira` | Jira webhook trigger (stub parser) |

## Project Layout

```
backend/
  src/
    orchestrator/   # LangGraph + agents A1-A3
    api/            # Express routes
    services/       # Pipeline business logic
    storage/        # JSON file persistence
    cli.js          # Terminal management
dashboard/
  src/              # React + Tailwind (.js)
```
