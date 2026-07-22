import { Router } from "express";
import { scanClaudeCodeUsage } from "./claudeCode.js";
import { fetchApiUsage } from "./adminApi.js";
import { TTLCache } from "./cache.js";
import type { ApiUsage, ClaudeCodeUsage } from "./types.js";

const CLAUDE_CODE_TTL_MS = 60_000;
const API_USAGE_TTL_MS = 5 * 60_000;

export function createRouter(): Router {
  const router = Router();
  const claudeCodeCache = new TTLCache<ClaudeCodeUsage>(CLAUDE_CODE_TTL_MS);
  const apiUsageCache = new TTLCache<ApiUsage>(API_USAGE_TTL_MS);

  router.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/api/claude-code", async (_req, res) => {
    try {
      const usage = await claudeCodeCache.getOrLoad(() => scanClaudeCodeUsage());
      res.json(usage);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/api/api-usage", async (_req, res) => {
    try {
      const usage = await apiUsageCache.getOrLoad(() => fetchApiUsage(process.env.ANTHROPIC_ADMIN_API_KEY));
      res.json(usage);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}
