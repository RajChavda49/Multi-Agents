import { Router } from "express";
import { isJiraConfigured } from "../integrations/jira-client.js";
import {
  listPipelines,
  getPipeline,
  toSummary,
} from "../storage/pipelines.js";
import {
  createAndRunPipeline,
  createAndRunPipelineFromJiraKey,
  approveGate1,
  rejectGate1,
  parseJiraWebhook,
  CreatePipelineSchema,
  GateDecisionSchema,
} from "../services/pipeline-service.js";
import jiraRoutes from "./jira-routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    phase: 1,
    agents: ["A1", "A2", "A3", "GATE_1"],
    jira: { configured: isJiraConfigured() },
  });
});

router.use("/jira", jiraRoutes);

router.get("/pipelines", (_req, res) => {
  const pipelines = listPipelines().map(toSummary);
  res.json({ pipelines });
});

router.get("/pipelines/:id", (req, res) => {
  const pipeline = getPipeline(req.params.id);
  if (!pipeline) {
    return res.status(404).json({ error: "Pipeline not found" });
  }
  res.json({ pipeline });
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
    const pipeline = await createAndRunPipelineFromJiraKey(req.params.key);
    res.status(201).json({ pipeline, source: "jira_api" });
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
