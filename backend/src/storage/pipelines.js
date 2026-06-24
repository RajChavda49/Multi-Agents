import fs from "fs";
import path from "path";
import { config } from "../config.js";

const STORE_FILE = path.join(config.dataDir, "pipelines.json");

function ensureStore() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ pipelines: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
}

function writeStore(data) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

export function listPipelines() {
  const store = readStore();
  return store.pipelines.sort(
    (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
  );
}

export function getPipeline(id) {
  return listPipelines().find((p) => p.id === id) || null;
}

export function savePipeline(record) {
  const store = readStore();
  const idx = store.pipelines.findIndex((p) => p.id === record.id);

  const enriched = {
    ...record,
    updated_at: new Date().toISOString(),
  };

  if (idx >= 0) {
    store.pipelines[idx] = enriched;
  } else {
    store.pipelines.push({
      ...enriched,
      created_at: enriched.created_at || enriched.updated_at,
    });
  }

  writeStore(store);
  return enriched;
}

export function deletePipeline(id) {
  const store = readStore();
  store.pipelines = store.pipelines.filter((p) => p.id !== id);
  writeStore(store);
}

export function normalizeStatus(status, phase) {
  if (status === "pending") {
    return phase === "development" ? "phase_2_running" : "phase_1_running";
  }
  if (status === "gate_1_approved" || status === "developing") return "phase_2_running";
  if (status === "running") return phase === "development" ? "phase_2_running" : "phase_1_running";
  return status;
}

export function getActivePipelineByJiraKey(jiraKey) {
  const key = jiraKey?.toUpperCase();
  const TERMINAL = ["gate_1_rejected", "gate_2_rejected", "failed", "completed", "phase_2_complete"];
  return (
    listPipelines().find(
      (p) =>
        p.jira_task?.key?.toUpperCase() === key && !TERMINAL.includes(normalizeStatus(p.status, p.phase)),
    ) || null
  );
}

export function toSummary(pipeline) {
  const status = normalizeStatus(pipeline.status, pipeline.phase);
  return {
    id: pipeline.id,
    jira_key: pipeline.jira_task?.key,
    summary: pipeline.jira_task?.summary,
    phase: pipeline.phase,
    status,
    current_agent: pipeline.current_agent,
    gate_1_approved: pipeline.gate_1_approved,
    gate_2_approved: pipeline.gate_2_approved,
    created_at: pipeline.created_at,
    updated_at: pipeline.updated_at,
    error: pipeline.error || null,
    failed_agent: pipeline.failure?.agent || null,
  };
}
