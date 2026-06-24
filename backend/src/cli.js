#!/usr/bin/env node

import { Command } from "commander";
import { config } from "./config.js";

const API = `${config.apiBaseUrl}/api`;

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function printPipelineSummary(p) {
  console.log(`${p.jira_key || p.id}  [${p.status}]  phase=${p.phase}  agent=${p.current_agent || "-"}`);
  console.log(`  ${p.summary || ""}`);
  console.log(`  id: ${p.id}`);
}

function printJiraTask(task) {
  console.log(`${task.jira_key}  [${task.status}]  ${task.issue_type} · ${task.priority}`);
  console.log(`  ${task.summary}`);
  if (task.assignee) console.log(`  assignee: ${task.assignee}`);
}

const program = new Command();

program
  .name("sdlc")
  .description("CLI for 12-agent SDLC pipeline management")
  .version("0.1.0");

const jira = program.command("jira").description("Live Jira integration");

jira
  .command("status")
  .description("Check Jira API connection")
  .action(async () => {
    const status = await request("/jira/status");
    console.log(JSON.stringify(status, null, 2));
  });

jira
  .command("list")
  .description("List live Jira tasks")
  .option("--jql <query>", "Custom JQL filter")
  .option("-n, --limit <n>", "Max results", "30")
  .action(async (opts) => {
    const params = new URLSearchParams({ limit: opts.limit });
    if (opts.jql) params.set("jql", opts.jql);
    const result = await request(`/jira/tasks?${params}`);
    if (!result.issues?.length) {
      console.log("No tasks found.");
      return;
    }
    result.issues.forEach(printJiraTask);
    console.log(`\n${result.issues.length} tasks${result.isLast ? "" : " (more available)"}`);
  });

jira
  .command("show <key>")
  .description("Fetch a single Jira issue")
  .action(async (key) => {
    const { issue } = await request(`/jira/tasks/${key}`);
    console.log(JSON.stringify(issue, null, 2));
  });

program
  .command("list")
  .description("List all pipelines")
  .action(async () => {
    const { pipelines } = await request("/pipelines");
    if (!pipelines.length) {
      console.log("No pipelines yet.");
      return;
    }
    pipelines.forEach(printPipelineSummary);
  });

program
  .command("create")
  .description("Create and run Phase 1 planning pipeline")
  .requiredOption("-k, --key <key>", "Jira issue key (e.g. PROJ-123)")
  .option("-s, --summary <summary>", "Issue summary (optional if Jira API configured)")
  .option("-d, --description <desc>", "Issue description", "")
  .option("--from-jira", "Fetch issue details from Jira API", false)
  .action(async (opts) => {
    let pipeline;

    if (opts.fromJira || !opts.summary) {
      ({ pipeline } = await request(`/pipelines/from-jira/${opts.key}`, { method: "POST" }));
    } else {
      ({ pipeline } = await request("/pipelines", {
        method: "POST",
        body: JSON.stringify({
          jira_key: opts.key,
          summary: opts.summary,
          description: opts.description,
        }),
      }));
    }

    console.log("Pipeline created:");
    printPipelineSummary(pipeline);
    if (pipeline.status === "awaiting_gate_1") {
      console.log("\n⏸  Awaiting Gate 1 approval. Run: sdlc approve " + pipeline.id);
    }
    if (pipeline.status === "awaiting_gate_2") {
      console.log("Phase 2 complete (A7–A9) — awaiting Gate 2. Run: sdlc approve-gate-2 " + pipeline.id);
    }
    if (pipeline.status === "phase_2_complete") {
      console.log("Phase 2 complete — review, tests, and report finished.");
    }
  });

program
  .command("show <id>")
  .description("Show full pipeline details")
  .action(async (id) => {
    const { pipeline } = await request(`/pipelines/${id}`);
    console.log(JSON.stringify(pipeline, null, 2));
  });

program
  .command("delete <id>")
  .description("Delete a pipeline (allows starting a new run for the same Jira key)")
  .action(async (id) => {
    const result = await request(`/pipelines/${id}`, { method: "DELETE" });
    console.log(`Deleted pipeline ${result.id}${result.jira_key ? ` (${result.jira_key})` : ""}`);
  });

program
  .command("approve <id>")
  .description("Approve Gate 1 (spec & test plan)")
  .option("-f, --feedback <text>", "Optional approval note")
  .action(async (id, opts) => {
    const { pipeline } = await request(`/pipelines/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ feedback: opts.feedback }),
    });
    console.log(`Gate 1 approved for ${pipeline.jira_task?.key}`);
    console.log(`Status: ${pipeline.status}`);
    if (pipeline.status === "awaiting_gate_2") {
      console.log("Phase 2 complete (A7–A9) — awaiting Gate 2 (review results).");
    }
    if (pipeline.status === "phase_2_running") {
      console.log("Phase 2 in progress (coding → review → tests → report).");
    }
  });

program
  .command("reject <id>")
  .description("Reject Gate 1")
  .option("-f, --feedback <text>", "Rejection reason", "Rejected via CLI")
  .action(async (id, opts) => {
    const { pipeline } = await request(`/pipelines/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ feedback: opts.feedback }),
    });
    console.log(`Gate 1 rejected for ${pipeline.jira_task?.key}`);
    console.log(`Feedback: ${pipeline.gate_1_feedback}`);
  });

program
  .command("approve-gate-2 <id>")
  .description("Approve Gate 2 (code & test results)")
  .option("-f, --feedback <text>", "Optional approval note")
  .action(async (id, opts) => {
    const { pipeline } = await request(`/pipelines/${id}/approve-gate-2`, {
      method: "POST",
      body: JSON.stringify({ feedback: opts.feedback }),
    });
    console.log(`Gate 2 approved for ${pipeline.jira_task?.key}`);
    console.log(`Status: ${pipeline.status}`);
  });

program
  .command("reject-gate-2 <id>")
  .description("Reject Gate 2")
  .option("-f, --feedback <text>", "Rejection reason", "Rejected via CLI")
  .action(async (id, opts) => {
    const { pipeline } = await request(`/pipelines/${id}/reject-gate-2`, {
      method: "POST",
      body: JSON.stringify({ feedback: opts.feedback }),
    });
    console.log(`Gate 2 rejected for ${pipeline.jira_task?.key}`);
    console.log(`Feedback: ${pipeline.gate_2_feedback}`);
  });

program.parse();
