import express from "express";
import cors from "cors";
import { config } from "./config.js";
import apiRoutes from "./api/routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", apiRoutes);

app.listen(config.port, () => {
  console.log(`SDLC Agents API running on http://localhost:${config.port}`);
  console.log(`Mock LLM: ${config.mockLlm}`);
  console.log(`Jira: ${config.jira.baseUrl ? siteUrlForLog() : "not configured"}`);
});

function siteUrlForLog() {
  return config.jira.baseUrl.replace(/\/$/, "").replace(/\/rest\/api\/\d+(\/.*)?$/i, "");
}
