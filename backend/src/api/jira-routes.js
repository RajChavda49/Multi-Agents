import { Router } from "express";
import { z } from "zod";
import {
  isJiraConfigured,
  testConnection,
  getIssue,
  searchIssues,
} from "../integrations/jira-client.js";

const router = Router();

router.get("/status", async (_req, res) => {
  if (!isJiraConfigured()) {
    return res.json({
      configured: false,
      connected: false,
      message: "Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in backend/.env",
    });
  }

  try {
    const connection = await testConnection();
    res.json({
      configured: true,
      connected: true,
      account: connection.account,
      email: connection.email,
    });
  } catch (err) {
    res.status(502).json({
      configured: true,
      connected: false,
      error: err.message,
    });
  }
});

router.get("/tasks", async (req, res) => {
  try {
    const schema = z.object({
      jql: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional().default(50),
      nextPageToken: z.string().optional(),
    });
    const query = schema.parse(req.query);
    const result = await searchIssues({
      jql: query.jql,
      maxResults: query.limit,
      nextPageToken: query.nextPageToken,
    });
    res.json(result);
  } catch (err) {
    res.status(err.message.includes("not configured") ? 503 : 400).json({ error: err.message });
  }
});

router.get("/tasks/:key", async (req, res) => {
  try {
    const issue = await getIssue(req.params.key.toUpperCase());
    res.json({ issue });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
