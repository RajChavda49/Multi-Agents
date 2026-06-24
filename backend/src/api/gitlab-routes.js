import { Router } from "express";
import {
  getGitLabStatus,
  testGitLabConnection,
  syncGitLabRepository,
  isGitLabConfigured,
} from "../integrations/gitlab-client.js";
import { getRepoGitInfo } from "../integrations/repo-target.js";

const router = Router();

router.get("/status", async (_req, res) => {
  if (!isGitLabConfigured()) {
    return res.json(getGitLabStatus());
  }

  const base = getGitLabStatus();
  try {
    const project = await testGitLabConnection();
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
    const result = await syncGitLabRepository();
    res.json({ ok: true, ...result, git: getRepoGitInfo() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
