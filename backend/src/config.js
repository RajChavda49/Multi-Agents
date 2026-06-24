import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3001,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  reasoningModel: process.env.OLLAMA_REASONING_MODEL || "llama3",
  codingModel: process.env.OLLAMA_CODING_MODEL || "qwen2.5-coder",
  mockLlm: (process.env.MOCK_LLM ?? "true").toLowerCase() === "true",
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
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: process.env.JIRA_PROJECT_KEY || "",
  },
};
