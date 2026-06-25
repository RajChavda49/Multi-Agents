import { Router } from "express";
import { isJiraConfigured } from "../integrations/jira-client.js";
import { getRepoStatus } from "../integrations/local-repo.js";
import { checkOllamaConnection, checkGeminiConnection } from "../orchestrator/llm.js";
import {
  listPipelines,
  getPipeline,
  getActivePipelineByJiraKey,
  normalizeStatus,
  toSummary,
} from "../storage/pipelines.js";
import {
  createAndRunPipeline,
  createAndRunPipelineFromJiraKey,
  getPipelineByJiraKey,
  approveGate1,
  rejectGate1,
  approveGate2,
  rejectGate2,
  confirmTargets,
  confirmCodeWrite,
  parseJiraWebhook,
  removePipelineById,
  retryPipeline,
  CreatePipelineSchema,
  RetrySchema,
  GateDecisionSchema,
} from "../services/pipeline-service.js";
import jiraRoutes from "./jira-routes.js";
import repoRoutes from "./repo-routes.js";
import gitlabRoutes from "./gitlab-routes.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const [ollama, gemini] = await Promise.all([checkOllamaConnection(), checkGeminiConnection()]);
  res.json({
    ok: true,
    phases: [1, 2],
    agents: ["A1", "A2", "A3", "GATE_1", "A4", "A5", "A6", "A7", "A8", "A9", "GATE_2"],
    ollama,
    gemini,
    jira: { configured: isJiraConfigured() },
    repo: getRepoStatus(),
  });
});

router.use("/jira", jiraRoutes);
router.use("/repo", repoRoutes);
router.use("/gitlab", gitlabRoutes);

router.get("/pipelines", (_req, res) => {
  const pipelines = listPipelines().map((p) =>
    toSummary({ ...p, status: normalizeStatus(p.status, p.phase) }),
  );
  res.json({ pipelines });
});

router.get("/pipelines/by-jira/:key", (req, res) => {
  const pipeline = getPipelineByJiraKey(req.params.key);
  if (!pipeline) {
    return res.status(404).json({ error: "No active pipeline for this Jira key" });
  }
  res.json({ pipeline });
});

router.get("/pipelines/:id", (req, res) => {
  const pipeline = getPipeline(req.params.id);
  if (!pipeline) {
    return res.status(404).json({ error: "Pipeline not found" });
  }
  res.json({
    pipeline: {
      ...pipeline,
      status: normalizeStatus(pipeline.status, pipeline.phase),
    },
  });
});

router.delete("/pipelines/:id", (req, res) => {
  try {
    const result = removePipelineById(req.params.id);
    res.json(result);
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.post("/pipelines", async (req, res) => {
  try {
    const input = CreatePipelineSchema.parse(req.body);
    const pipeline = await createAndRunPipeline(input);
    res.status(201).json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/from-jira/:key", async (req, res) => {
  try {
    const { pipeline, existing } = await createAndRunPipelineFromJiraKey(req.params.key);
    res.status(existing ? 200 : 201).json({ pipeline, source: "jira_api", existing });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/approve", async (req, res) => {
  try {
    const { feedback } = GateDecisionSchema.parse(req.body || {});
    const pipeline = await approveGate1(req.params.id, feedback);
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/reject", async (req, res) => {
  try {
    const { feedback } = GateDecisionSchema.parse(req.body || {});
    const pipeline = await rejectGate1(req.params.id, feedback || "Rejected");
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/confirm-targets", async (req, res) => {
  try {
    const pipeline = await confirmTargets(req.params.id, req.body || {});
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/confirm-code-write", async (req, res) => {
  try {
    const pipeline = await confirmCodeWrite(req.params.id, req.body || {});
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/approve-gate-2", async (req, res) => {
  try {
    const { feedback } = GateDecisionSchema.parse(req.body || {});
    const pipeline = await approveGate2(req.params.id, feedback);
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/reject-gate-2", async (req, res) => {
  try {
    const { feedback } = GateDecisionSchema.parse(req.body || {});
    const pipeline = await rejectGate2(req.params.id, feedback || "Rejected");
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/pipelines/:id/retry", async (req, res) => {
  try {
    const input = RetrySchema.parse(req.body || {});
    const pipeline = await retryPipeline(req.params.id, input);
    res.json({ pipeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/webhooks/jira", async (req, res) => {
  try {
    const parsed = await parseJiraWebhook(req.body);
    if (!parsed) {
      return res.status(400).json({ error: "Invalid Jira webhook payload" });
    }

    const pipeline = await createAndRunPipeline({
      jira_key: parsed.jira_key,
      summary: parsed.summary,
      description: parsed.description,
      issue_type: parsed.issue_type,
      priority: parsed.priority,
      url: parsed.url,
    });
    res.status(201).json({ pipeline, source: "jira_webhook" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
