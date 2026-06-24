import { Router } from "express";
import { getRepoStatus } from "../integrations/local-repo.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json(getRepoStatus());
});

export default router;
