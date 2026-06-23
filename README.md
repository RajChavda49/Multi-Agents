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

## Phase 1 Flow

```
Jira Task → A1 Knowledge → A2 Dev Plan → A3 Test Cases → 🛑 Gate 1 (HITL)
```

- **A1** — RAG-ready knowledge context (mocked RAG for now; ChromaDB in Phase 2)
- **A2** — Technical specification (JSON)
- **A3** — Playwright-oriented test case library
- **Gate 1** — LangGraph `interrupt()` pauses until human approves via dashboard or CLI

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | API port |
| `MOCK_LLM` | true | Use mock agent outputs (set false + Ollama for real LLM) |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama endpoint |
| `OLLAMA_REASONING_MODEL` | llama3 | Model for A1–A3 |
| `JIRA_BASE_URL` | — | Jira Cloud site URL (e.g. `https://acme.atlassian.net`) |
| `JIRA_EMAIL` | — | Atlassian account email |
| `JIRA_API_TOKEN` | — | API token from Atlassian account settings |
| `JIRA_PROJECT_KEY` | — | Default project for task listing (e.g. `PROJ`) |

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
