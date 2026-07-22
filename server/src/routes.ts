import { Router } from "express";

export function createRouter(): Router {
  const router = Router();

  router.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return router;
}
