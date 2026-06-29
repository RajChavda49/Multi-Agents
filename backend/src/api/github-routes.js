import { Router } from "express";
import {
  getGitHubStatus,
  testGitHubConnection,
  syncGitHubRepository,
  isGitHubConfigured,
} from "../integrations/github-client.js";
import { getRepoGitInfo } from "../integrations/repo-target.js";

const router = Router();

router.get("/status", async (_req, res) => {
  if (!isGitHubConfigured()) {
    return res.json(getGitHubStatus());
  }

  const base = getGitHubStatus();
  try {
    const project = await testGitHubConnection();
    res.json({
      ...base,
      connected: true,
      project,
      git: getRepoGitInfo(),
    });
  } catch (err) {
    res.json({
      ...base,
      connected: false,
      error: err.message,
    });
  }
});

router.post("/sync", async (_req, res) => {
  try {
    const result = await syncGitHubRepository();
    res.json({ ok: true, ...result, git: getRepoGitInfo() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
