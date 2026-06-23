import { config } from "../config.js";

function authHeader() {
  const token = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

export function isJiraConfigured() {
  return Boolean(config.jira.baseUrl && config.jira.email && config.jira.apiToken);
}

function normalizeSiteUrl(url) {
  if (!url) return "";
  return url
    .replace(/\/$/, "")
    .replace(/\/rest\/api\/\d+(\/.*)?$/i, "");
}

function siteUrl() {
  return normalizeSiteUrl(config.jira.baseUrl);
}

function apiUrl(path) {
  return `${siteUrl()}/rest/api/3${path}`;
}

async function jiraRequest(path, options = {}) {
  if (!isJiraConfigured()) {
    throw new Error(
      "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in backend/.env",
    );
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const msg =
      data?.errorMessages?.join("; ") ||
      data?.message ||
      data?.errors?.issue ||
      `Jira API error ${response.status}`;
    throw new Error(msg);
  }

  return data;
}

export function extractDescription(description) {
  if (!description) return "";
  if (typeof description === "string") return description;

  if (description.type === "doc" && Array.isArray(description.content)) {
    const lines = [];

    function walk(nodes) {
      for (const node of nodes || []) {
        if (node.type === "text" && node.text) {
          lines.push(node.text);
        }
        if (node.content) walk(node.content);
        if (node.type === "paragraph" || node.type === "heading") {
          lines.push("\n");
        }
      }
    }

    walk(description.content);
    return lines.join("").replace(/\n+/g, "\n").trim();
  }

  return "";
}

export function buildBrowseUrl(issueKey) {
  const base = siteUrl();
  if (!base) return null;
  return `${base}/browse/${issueKey}`;
}

export function normalizeIssue(issue) {
  const fields = issue.fields || {};

  return {
    jira_key: issue.key,
    summary: fields.summary || "Untitled",
    description: extractDescription(fields.description),
    issue_type: fields.issuetype?.name || "Task",
    priority: fields.priority?.name || "Medium",
    status: fields.status?.name || "Unknown",
    assignee: fields.assignee?.displayName || null,
    url: buildBrowseUrl(issue.key),
    updated_at: fields.updated || null,
    created_at: fields.created || null,
  };
}

export async function testConnection() {
  const user = await jiraRequest("/myself");
  return {
    connected: true,
    account: user.displayName || user.emailAddress,
    email: user.emailAddress,
  };
}

export async function getIssue(issueKey) {
  const issue = await jiraRequest(
    `/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,priority,assignee,updated,created`,
  );
  return normalizeIssue(issue);
}

const ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "updated",
  "created",
];

export async function searchIssues({ jql, maxResults = 50, nextPageToken } = {}) {
  const query =
    jql ||
    (config.jira.projectKey
      ? `project = "${config.jira.projectKey}" AND status != Done ORDER BY updated DESC`
      : "ORDER BY updated DESC");

  const params = new URLSearchParams({
    jql: query,
    maxResults: String(maxResults),
    fields: ISSUE_FIELDS.join(","),
  });

  if (nextPageToken) {
    params.set("nextPageToken", nextPageToken);
  }

  const data = await jiraRequest(`/search/jql?${params.toString()}`, {
    method: "GET",
  });

  const issues = (data.issues || []).map(normalizeIssue);
  return {
    issues,
    isLast: data.isLast ?? true,
    nextPageToken: data.nextPageToken ?? null,
    jql: query,
  };
}

export async function addComment(issueKey, body) {
  return jiraRequest(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    }),
  });
}
