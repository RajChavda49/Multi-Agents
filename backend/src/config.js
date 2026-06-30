import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const config = {
  port: Number(process.env.PORT) || 3001,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  /** Required for :cloud models — create at https://ollama.com/settings/keys */
  ollamaApiKey: process.env.OLLAMA_API_KEY || "",
  /** Smaller/faster model for A1–A3 planning (pull: ollama pull qwen2.5:3b) */
  planningModel: process.env.OLLAMA_PLANNING_MODEL || "qwen2.5:3b",
  reasoningModel: process.env.OLLAMA_REASONING_MODEL || "qwen2.5-coder",
  codingModel: process.env.OLLAMA_CODING_MODEL || "qwen2.5-coder",
  /** false = A5 allowed; A1/A2 backend_needed still gates whether it runs */
  skipBackendAgent: (process.env.SKIP_A5 ?? "true").toLowerCase() === "true",
  agentAutoRetryMax: Math.max(1, Number(process.env.AGENT_AUTO_RETRY_MAX) || 3),
  pipelineAutoRetryMax: Math.max(1, Number(process.env.PIPELINE_AUTO_RETRY_MAX) || 3),
  pipelineAutoRetryEnabled: (process.env.PIPELINE_AUTO_RETRY ?? "true").toLowerCase() === "true",
  /** ollama | gemini | auto — auto uses Gemini when GOOGLE_API_KEY is set */
  llmProvider: process.env.LLM_PROVIDER || "auto",
  /** Separate override for A4/A6; defaults to LLM_PROVIDER */
  codingLlmProvider: process.env.LLM_CODING_PROVIDER || process.env.LLM_PROVIDER || "auto",
  googleApiKey: process.env.GOOGLE_API_KEY || "",
  /** Free-tier friendly: gemini-2.0-flash (AI Studio) */
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  geminiCodingModel:
    process.env.GEMINI_CODING_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash",
  /** Agents auto-pick create vs patch, recover errors, skip weak clarifications */
  autonomousMode: (process.env.AUTONOMOUS_MODE ?? "true").toLowerCase() === "true",
  /** Auto-approve GATE_1 / GATE_2 without human interrupt (off by default) */
  autoApproveGates: (process.env.AUTO_APPROVE_GATES ?? "false").toLowerCase() === "true",
  /** Skip A1-intent LLM — use heuristics (faster on local 7B) */
  skipIntentLlm: (process.env.OLLAMA_INTENT_LLM ?? "false").toLowerCase() !== "true",
  /** A8 always uses LLM — agent decides execution strategy independently */
  skipA8Llm: (process.env.SKIP_A8_LLM ?? "false").toLowerCase() === "true",
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data"),
  workspacesDir: process.env.WORKSPACES_DIR || path.join(__dirname, "..", "data", "workspaces"),
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:3001",
  targetRepo: {
    path: process.env.TARGET_REPO_PATH || "",
    writeEnabled: (process.env.TARGET_REPO_WRITE ?? "true").toLowerCase() === "true",
  },
  gitlab: {
    baseUrl: process.env.GITLAB_BASE_URL || "https://gitlab.com",
    token: process.env.GITLAB_TOKEN || "",
    projectPath: process.env.GITLAB_PROJECT_PATH || "",
    defaultBranch: process.env.GITLAB_DEFAULT_BRANCH || "main",
    writeEnabled: (process.env.GITLAB_WRITE ?? "true").toLowerCase() === "true",
    createMr: (process.env.GITLAB_CREATE_MR ?? "true").toLowerCase() === "true",
  },
  github: {
    baseUrl: process.env.GITHUB_BASE_URL || "https://github.com",
    token: process.env.GITHUB_TOKEN || "",
    projectPath: process.env.GITHUB_PROJECT_PATH || "",
    defaultBranch: process.env.GITHUB_DEFAULT_BRANCH || "main",
    writeEnabled: (process.env.GITHUB_WRITE ?? "true").toLowerCase() === "true",
    createPr: (process.env.GITHUB_CREATE_MR ?? process.env.GITHUB_CREATE_PR ?? "true").toLowerCase() === "true",
  },
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: process.env.JIRA_PROJECT_KEY || "",
  },
};
