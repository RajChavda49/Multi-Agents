import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3001,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  reasoningModel: process.env.OLLAMA_REASONING_MODEL || "llama3",
  mockLlm: (process.env.MOCK_LLM ?? "true").toLowerCase() === "true",
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data"),
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:3001",
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: process.env.JIRA_PROJECT_KEY || "",
  },
};
