import express from "express";
import cors from "cors";
import { config } from "./config.js";
import apiRoutes from "./api/routes.js";
import { getRepoStatus } from "./integrations/local-repo.js";
import { checkOllamaConnection, checkGeminiConnection, warmupOllama } from "./orchestrator/llm.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", apiRoutes);

async function start() {
  const [ollama, gemini] = await Promise.all([checkOllamaConnection(), checkGeminiConnection()]);
  console.log(
    `Ollama: ${ollama.connected ? `connected (planning fallback: ${ollama.planning_model})` : `OFFLINE — ${ollama.error}`}`,
  );
  if (gemini.configured) {
    console.log(
      `Gemini: ${gemini.connected ? `connected (${gemini.model}, planning=${gemini.planning_provider}, coding=${gemini.coding_provider})` : `FAILED — ${gemini.error}`}`,
    );
    if (gemini.hint) console.log(`  → ${gemini.hint}`);
  } else {
    console.log("Gemini: not configured (set GOOGLE_API_KEY for free-tier cloud LLM)");
  }
  console.log(`LLM routing: planning=${ollama.llm_provider || "ollama"}, coding=${ollama.coding_llm_provider || "ollama"}`);
  console.log(`Jira: ${config.jira.baseUrl ? siteUrlForLog() : "not configured"}`);
  const repo = getRepoStatus();
  if (repo.source === "gitlab") {
    console.log(
      `GitLab repo: ${repo.connected ? repo.path : "configured, not cloned yet"} (${repo.project_path || "?"})`,
    );
  } else if (repo.source === "github") {
    console.log(
      `GitHub repo: ${repo.connected ? repo.path : "configured, not cloned yet"} (${repo.project_path || "?"})`,
    );
  } else {
    console.log(`Target repo: ${repo.connected ? repo.path : repo.configured ? repo.error : "not configured"}`);
  }

  app.listen(config.port, () => {
    console.log(`SDLC Agents API running on http://localhost:${config.port}`);
  });

  if (ollama.connected) {
    warmupOllama(); // background — don't block API on slow CPU model load
  }
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});

function siteUrlForLog() {
  return config.jira.baseUrl.replace(/\/$/, "").replace(/\/rest\/api\/\d+(\/.*)?$/i, "");
}
