# Claude Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, dark-mode, auto-refreshing dashboard that visualizes Claude Code (Pro/Max) usage from local session logs and Anthropic API usage/cost from the Admin API.

**Architecture:** An Express + TypeScript backend (`server/`) scans `~/.claude/projects/**/*.jsonl` and calls the Anthropic Admin Usage & Cost API, caching both in memory and exposing them as two JSON endpoints. A Vite + React + TypeScript frontend (`frontend/`) polls those endpoints and renders dark-mode charts (Recharts) following the dataviz skill's color/contrast rules.

**Tech Stack:** Node.js, TypeScript, Express, Vite, React, Recharts, Vitest (both packages), Supertest (backend integration tests), npm workspaces, `concurrently` for the dev script.

## Global Constraints

- Dark mode only — no light-mode toggle (explicit user request). Colors come from the dataviz skill's validated dark-mode palette (see below), not invented ad hoc.
- The Admin API key (`ANTHROPIC_ADMIN_API_KEY`) is read only by the backend (`process.env`), from a local `.env` file (gitignored) — it must never be sent to or readable by the frontend.
- Anthropic Admin Usage & Cost API: base `https://api.anthropic.com/v1/organizations`, endpoints `/usage_report/messages` and `/cost_report`, header `anthropic-version: 2023-06-01`, auth header `x-api-key: <admin key>`. `cost_report` amounts are decimal strings in **cents** — divide by 100 for dollars.
- Dark-mode CSS variables (from the dataviz skill's reference palette, `references/palette.md`): surface `#1a1a19`, page `#0d0d0d`, primary ink `#ffffff`, secondary ink `#c3c2b7`, muted `#898781`, gridline `#2c2c2a`, axis `#383835`, border `rgba(255,255,255,0.10)`, categorical series in fixed order blue `#3987e5`, orange `#d95926`, aqua `#199e70`, yellow `#c98500`.
- One axis per chart — never dual-axis. Claude Code tokens and API dollars are rendered as separate single-axis charts, never combined on one chart with two y-scales.
- All new code is TypeScript, ES modules (`"type": "module"`).

---

## Task 1: Repo scaffold & root tooling

**Files:**
- Create: `package.json` (root)
- Create: `.gitignore` (append to existing)
- Create: `.env.example`

**Interfaces:**
- Produces: root `npm run dev` / `npm run build` / `npm run test` scripts that later tasks wire real workspace scripts into.

- [ ] **Step 1: Write the root `package.json`**

```json
{
  "name": "claude-dashboard",
  "private": true,
  "type": "module",
  "workspaces": [
    "server",
    "frontend"
  ],
  "scripts": {
    "dev": "concurrently -n server,frontend -c blue,green \"npm run dev -w server\" \"npm run dev -w frontend\"",
    "build": "npm run build -w frontend && npm run build -w server",
    "test": "npm run test -w server && npm run test -w frontend"
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

- [ ] **Step 2: Update `.gitignore`**

Read the existing `.gitignore`, then append these lines (create the file if it doesn't exist):

```
node_modules/
dist/
.env
```

- [ ] **Step 3: Write `.env.example`**

```
# Generate an Admin API key in the Anthropic Console (org admin only) and paste it here as .env
ANTHROPIC_ADMIN_API_KEY=
```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore .env.example
git commit -m "Scaffold root workspace tooling"
```

---

## Task 2: Backend scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/src/routes.ts`
- Test: `server/src/routes.test.ts`

**Interfaces:**
- Produces: `createRouter(): express.Router` exported from `server/src/routes.ts`, mounted by `server/src/index.ts`. Exposes `GET /api/health` returning `{ status: "ok" }`. Later tasks add more routes to this same `createRouter()`.

- [ ] **Step 1: Write `server/package.json`**

```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install backend dependencies**

```bash
cd server && npm install && cd ..
```

- [ ] **Step 4: Write the failing test**

`server/src/routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createRouter } from "./routes.js";

describe("routes", () => {
  it("GET /api/health returns ok", async () => {
    const app = express();
    app.use(createRouter());
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd server && npx vitest run` (from `server/`)
Expected: FAIL — `./routes.js` has no exported member `createRouter` (module doesn't exist yet)

- [ ] **Step 6: Write `server/src/routes.ts`**

```ts
import { Router } from "express";

export function createRouter(): Router {
  const router = Router();

  router.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return router;
}
```

- [ ] **Step 7: Write `server/src/index.ts`**

```ts
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;

const app = express();
app.use(createRouter());

const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Claude dashboard server listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && npx vitest run`
Expected: PASS (1 test)

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/tsconfig.json server/src/index.ts server/src/routes.ts server/src/routes.test.ts server/package-lock.json
git commit -m "Scaffold Express backend with health endpoint"
```

---

## Task 3: Claude Code log scanner & aggregation

**Files:**
- Create: `server/src/types.ts`
- Create: `server/src/claudeCode.ts`
- Test: `server/src/claudeCode.test.ts`

**Interfaces:**
- Produces: `ClaudeCodeUsage`, `DailyUsage`, `ModelUsage`, `ProjectUsage`, `UsageRollup` types in `server/src/types.ts`; `scanClaudeCodeUsage(projectsDir?: string, now?: Date): Promise<ClaudeCodeUsage>` and `DEFAULT_PROJECTS_DIR: string` from `server/src/claudeCode.ts`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write `server/src/types.ts`**

```ts
export interface DailyUsage {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ProjectUsage {
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageRollup {
  totalTokens: number;
}

export interface ClaudeCodeUsage {
  daily: DailyUsage[];
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  today: UsageRollup;
  week: UsageRollup;
  month: UsageRollup;
}

export interface ApiDailyUsage {
  date: string;
  totalTokens: number;
  costUsd: number;
}

export interface ApiModelUsage {
  model: string;
  totalTokens: number;
  costUsd: number;
}

export interface ApiUsageRollup {
  totalTokens: number;
  costUsd: number;
}

export interface ApiUsage {
  configured: boolean;
  daily: ApiDailyUsage[];
  byModel: ApiModelUsage[];
  today: ApiUsageRollup;
  week: ApiUsageRollup;
  month: ApiUsageRollup;
}
```

- [ ] **Step 2: Write the failing test**

`server/src/claudeCode.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { scanClaudeCodeUsage } from "./claudeCode.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function writeSession(dir: string, project: string, file: string, lines: object[]) {
  const projectDir = path.join(dir, project);
  await mkdir(projectDir, { recursive: true });
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  await writeFile(path.join(projectDir, file), content, "utf-8");
}

describe("scanClaudeCodeUsage", () => {
  it("aggregates tokens by day, model, and project, and computes rollups", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-dashboard-test-"));

    await writeSession(tmpDir, "-Users-eengelking-dev-app-a", "session1.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-07-21T10:00:00.000Z",
        cwd: "/Users/eengelking/dev/app-a",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
          },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-07-20T09:00:00.000Z",
        cwd: "/Users/eengelking/dev/app-a",
        message: {
          model: "claude-sonnet-5",
          usage: {
            input_tokens: 200,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      // malformed line should be skipped, not throw
      "not valid json {{{",
    ]);

    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = await scanClaudeCodeUsage(tmpDir, now);

    expect(result.daily).toEqual([
      { date: "2026-07-20", inputTokens: 200, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { date: "2026-07-21", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5 },
    ]);

    expect(result.byModel).toEqual([
      { model: "claude-sonnet-5", inputTokens: 200, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5 },
    ]);

    expect(result.byProject).toEqual([
      {
        project: "app-a",
        inputTokens: 300,
        outputTokens: 70,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
      },
    ]);

    expect(result.today).toEqual({ totalTokens: 165 }); // 100+50+10+5
    expect(result.week).toEqual({ totalTokens: 385 }); // both days, same week
    expect(result.month).toEqual({ totalTokens: 385 });
  });

  it("returns empty aggregates when the directory does not exist", async () => {
    const result = await scanClaudeCodeUsage("/nonexistent/path/for/test", new Date());
    expect(result.daily).toEqual([]);
    expect(result.byModel).toEqual([]);
    expect(result.byProject).toEqual([]);
    expect(result.today).toEqual({ totalTokens: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run claudeCode`
Expected: FAIL — cannot find module `./claudeCode.js`

- [ ] **Step 4: Write `server/src/claudeCode.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ClaudeCodeUsage, DailyUsage, ModelUsage, ProjectUsage } from "./types.js";

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

interface RawUsageEvent {
  date: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseLine(line: string): RawUsageEvent | null {
  if (!line.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = obj?.message?.usage;
  const model = obj?.message?.model;
  const timestamp = obj?.timestamp;
  const cwd = obj?.cwd;
  if (!usage || typeof model !== "string" || typeof timestamp !== "string" || typeof cwd !== "string") {
    return null;
  }
  return {
    date: timestamp.slice(0, 10),
    model,
    project: path.basename(cwd) || cwd,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

async function readEvents(filePath: string): Promise<RawUsageEvent[]> {
  const content = await readFile(filePath, "utf-8");
  const events: RawUsageEvent[] = [];
  for (const line of content.split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function emptyUsageRow(): { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addEvent(
  row: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
  event: RawUsageEvent,
): void {
  row.inputTokens += event.inputTokens;
  row.outputTokens += event.outputTokens;
  row.cacheCreationTokens += event.cacheCreationTokens;
  row.cacheReadTokens += event.cacheReadTokens;
}

function total(row: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): number {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
}

export async function scanClaudeCodeUsage(
  projectsDir: string = DEFAULT_PROJECTS_DIR,
  now: Date = new Date(),
): Promise<ClaudeCodeUsage> {
  const files = await findJsonlFiles(projectsDir);
  const allEvents: RawUsageEvent[] = [];
  for (const file of files) {
    allEvents.push(...(await readEvents(file)));
  }

  const dailyMap = new Map<string, DailyUsage>();
  const modelMap = new Map<string, ModelUsage>();
  const projectMap = new Map<string, ProjectUsage>();

  const todayStr = isoDate(now);
  const weekStartStr = isoDate(startOfWeek(now));
  const monthStartStr = isoDate(startOfMonth(now));

  let todayTokens = 0;
  let weekTokens = 0;
  let monthTokens = 0;

  for (const event of allEvents) {
    const daily = dailyMap.get(event.date) ?? { date: event.date, ...emptyUsageRow() };
    addEvent(daily, event);
    dailyMap.set(event.date, daily);

    const model = modelMap.get(event.model) ?? { model: event.model, ...emptyUsageRow() };
    addEvent(model, event);
    modelMap.set(event.model, model);

    const project = projectMap.get(event.project) ?? { project: event.project, ...emptyUsageRow() };
    addEvent(project, event);
    projectMap.set(event.project, project);

    const eventTotal = total(event);
    if (event.date === todayStr) todayTokens += eventTotal;
    if (event.date >= weekStartStr) weekTokens += eventTotal;
    if (event.date >= monthStartStr) monthTokens += eventTotal;
  }

  const byTotalDesc = (a: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }, b: typeof a) =>
    total(b) - total(a);

  return {
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...modelMap.values()].sort(byTotalDesc),
    byProject: [...projectMap.values()].sort(byTotalDesc),
    today: { totalTokens: todayTokens },
    week: { totalTokens: weekTokens },
    month: { totalTokens: monthTokens },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run claudeCode`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/claudeCode.ts server/src/claudeCode.test.ts
git commit -m "Add Claude Code log scanner and aggregation"
```

---

## Task 4: TTL cache

**Files:**
- Create: `server/src/cache.ts`
- Test: `server/src/cache.test.ts`

**Interfaces:**
- Produces: `class TTLCache<T>` with constructor `(ttlMs: number)`, method `getOrLoad(loader: () => Promise<T>): Promise<T>`, method `invalidate(): void`. Used by Task 6's routes.

- [ ] **Step 1: Write the failing test**

`server/src/cache.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { TTLCache } from "./cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TTLCache", () => {
  it("loads once and serves the cached value within the TTL window", async () => {
    const loader = vi.fn().mockResolvedValue("value-1");
    const cache = new TTLCache<string>(1000);

    const first = await cache.getOrLoad(loader);
    const second = await cache.getOrLoad(loader);

    expect(first).toBe("value-1");
    expect(second).toBe("value-1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL expires", async () => {
    const loader = vi.fn().mockResolvedValueOnce("value-1").mockResolvedValueOnce("value-2");
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);

    const cache = new TTLCache<string>(1000);
    const first = await cache.getOrLoad(loader);

    nowSpy.mockReturnValue(1500);
    const second = await cache.getOrLoad(loader);

    expect(first).toBe("value-1");
    expect(second).toBe("value-2");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next call to reload", async () => {
    const loader = vi.fn().mockResolvedValueOnce("value-1").mockResolvedValueOnce("value-2");
    const cache = new TTLCache<string>(10_000);

    await cache.getOrLoad(loader);
    cache.invalidate();
    const second = await cache.getOrLoad(loader);

    expect(second).toBe("value-2");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run cache`
Expected: FAIL — cannot find module `./cache.js`

- [ ] **Step 3: Write `server/src/cache.ts`**

```ts
export class TTLCache<T> {
  private value: T | undefined;
  private expiresAt = 0;

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.value !== undefined && now < this.expiresAt) {
      return this.value;
    }
    const loaded = await loader();
    this.value = loaded;
    this.expiresAt = now + this.ttlMs;
    return loaded;
  }

  invalidate(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run cache`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/cache.ts server/src/cache.test.ts
git commit -m "Add in-memory TTL cache"
```

---

## Task 5: Anthropic Admin Usage & Cost API client

**Files:**
- Modify: `server/src/types.ts` (already has `ApiUsage` types from Task 3 — no change needed)
- Create: `server/src/adminApi.ts`
- Test: `server/src/adminApi.test.ts`

**Interfaces:**
- Produces: `fetchApiUsage(apiKey: string | undefined, now?: Date): Promise<ApiUsage>` from `server/src/adminApi.ts`. Used by Task 6's routes.
- Consumes: `ApiUsage`, `ApiDailyUsage`, `ApiModelUsage`, `ApiUsageRollup` from `./types.js` (Task 3).

- [ ] **Step 1: Write the failing test**

`server/src/adminApi.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchApiUsage } from "./adminApi.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function usageResponse() {
  return {
    data: [
      {
        starting_at: "2026-07-20T00:00:00Z",
        ending_at: "2026-07-21T00:00:00Z",
        results: [
          {
            model: "claude-opus-4-8",
            uncached_input_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 },
            output_tokens: 500,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

function costResponse() {
  return {
    data: [
      {
        starting_at: "2026-07-20T00:00:00Z",
        ending_at: "2026-07-21T00:00:00Z",
        results: [{ amount: "250.00", model: "claude-opus-4-8" }],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

describe("fetchApiUsage", () => {
  it("returns a not-configured result when no API key is provided", async () => {
    const result = await fetchApiUsage(undefined);
    expect(result.configured).toBe(false);
    expect(result.daily).toEqual([]);
  });

  it("aggregates usage and cost reports into daily and per-model rollups", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("usage_report/messages")) {
        return new Response(JSON.stringify(usageResponse()), { status: 200 });
      }
      if (href.includes("cost_report")) {
        return new Response(JSON.stringify(costResponse()), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = await fetchApiUsage("sk-ant-admin01-test", now);

    expect(result.configured).toBe(true);
    expect(result.daily).toEqual([{ date: "2026-07-20", totalTokens: 1800, costUsd: 2.5 }]);
    expect(result.byModel).toEqual([{ model: "claude-opus-4-8", totalTokens: 1800, costUsd: 2.5 }]);
    expect(result.week.costUsd).toBeCloseTo(2.5);
  });

  it("throws when the Admin API returns a non-2xx status", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchApiUsage("bad-key", new Date())).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run adminApi`
Expected: FAIL — cannot find module `./adminApi.js`

- [ ] **Step 3: Write `server/src/adminApi.ts`**

```ts
import type { ApiDailyUsage, ApiModelUsage, ApiUsage, ApiUsageRollup } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const BASE_URL = "https://api.anthropic.com/v1/organizations";

interface UsageResultRow {
  model: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  output_tokens: number;
}

interface UsageBucket {
  starting_at: string;
  ending_at: string;
  results: UsageResultRow[];
}

interface UsageReportResponse {
  data: UsageBucket[];
  has_more: boolean;
  next_page: string | null;
}

interface CostResultRow {
  amount: string;
  model: string | null;
}

interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: CostResultRow[];
}

interface CostReportResponse {
  data: CostBucket[];
  has_more: boolean;
  next_page: string | null;
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": apiKey,
  };
}

async function fetchUsageReport(apiKey: string, startingAt: string): Promise<UsageBucket[]> {
  const buckets: UsageBucket[] = [];
  let page: string | undefined;
  do {
    const url = new URL(`${BASE_URL}/usage_report/messages`);
    url.searchParams.set("starting_at", startingAt);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by[]", "model");
    if (page) url.searchParams.set("page", page);

    const response = await fetch(url, { headers: authHeaders(apiKey) });
    if (!response.ok) {
      throw new Error(`Usage API request failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as UsageReportResponse;
    buckets.push(...body.data);
    page = body.has_more ? body.next_page ?? undefined : undefined;
  } while (page);
  return buckets;
}

async function fetchCostReport(apiKey: string, startingAt: string): Promise<CostBucket[]> {
  const buckets: CostBucket[] = [];
  let page: string | undefined;
  do {
    const url = new URL(`${BASE_URL}/cost_report`);
    url.searchParams.set("starting_at", startingAt);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by[]", "description");
    if (page) url.searchParams.set("page", page);

    const response = await fetch(url, { headers: authHeaders(apiKey) });
    if (!response.ok) {
      throw new Error(`Cost API request failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as CostReportResponse;
    buckets.push(...body.data);
    page = body.has_more ? body.next_page ?? undefined : undefined;
  } while (page);
  return buckets;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function emptyRollup(): ApiUsageRollup {
  return { totalTokens: 0, costUsd: 0 };
}

export async function fetchApiUsage(apiKey: string | undefined, now: Date = new Date()): Promise<ApiUsage> {
  if (!apiKey) {
    return {
      configured: false,
      daily: [],
      byModel: [],
      today: emptyRollup(),
      week: emptyRollup(),
      month: emptyRollup(),
    };
  }

  const rangeStart = new Date(now);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 30);
  const startingAt = `${isoDate(rangeStart)}T00:00:00Z`;

  const [usageBuckets, costBuckets] = await Promise.all([
    fetchUsageReport(apiKey, startingAt),
    fetchCostReport(apiKey, startingAt),
  ]);

  const dailyMap = new Map<string, ApiDailyUsage>();
  const modelTokens = new Map<string, number>();
  const modelCost = new Map<string, number>();

  for (const bucket of usageBuckets) {
    const date = bucket.starting_at.slice(0, 10);
    const daily = dailyMap.get(date) ?? { date, totalTokens: 0, costUsd: 0 };
    for (const row of bucket.results) {
      const tokens =
        row.uncached_input_tokens +
        row.cache_read_input_tokens +
        row.cache_creation.ephemeral_1h_input_tokens +
        row.cache_creation.ephemeral_5m_input_tokens +
        row.output_tokens;
      daily.totalTokens += tokens;
      if (row.model) {
        modelTokens.set(row.model, (modelTokens.get(row.model) ?? 0) + tokens);
      }
    }
    dailyMap.set(date, daily);
  }

  for (const bucket of costBuckets) {
    const date = bucket.starting_at.slice(0, 10);
    const daily = dailyMap.get(date) ?? { date, totalTokens: 0, costUsd: 0 };
    for (const row of bucket.results) {
      const dollars = Number(row.amount) / 100;
      daily.costUsd += dollars;
      if (row.model) {
        modelCost.set(row.model, (modelCost.get(row.model) ?? 0) + dollars);
      }
    }
    dailyMap.set(date, daily);
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const byModel: ApiModelUsage[] = [...new Set([...modelTokens.keys(), ...modelCost.keys()])].map((model) => ({
    model,
    totalTokens: modelTokens.get(model) ?? 0,
    costUsd: modelCost.get(model) ?? 0,
  }));
  byModel.sort((a, b) => b.costUsd - a.costUsd);

  const todayStr = isoDate(now);
  const weekStartStr = isoDate(startOfWeek(now));
  const monthStartStr = isoDate(startOfMonth(now));

  const rollup = (predicate: (date: string) => boolean): ApiUsageRollup =>
    daily.filter((d) => predicate(d.date)).reduce(
      (acc, d) => ({ totalTokens: acc.totalTokens + d.totalTokens, costUsd: acc.costUsd + d.costUsd }),
      emptyRollup(),
    );

  return {
    configured: true,
    daily,
    byModel,
    today: rollup((date) => date === todayStr),
    week: rollup((date) => date >= weekStartStr),
    month: rollup((date) => date >= monthStartStr),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run adminApi`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/adminApi.ts server/src/adminApi.test.ts
git commit -m "Add Anthropic Admin Usage and Cost API client"
```

---

## Task 6: Wire cached routes

**Files:**
- Modify: `server/src/routes.ts`
- Test: `server/src/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `scanClaudeCodeUsage` (Task 3), `fetchApiUsage` (Task 5), `TTLCache` (Task 4).
- Produces: `GET /api/claude-code` → `ClaudeCodeUsage` JSON; `GET /api/api-usage` → `ApiUsage` JSON. Both consumed by the frontend (Task 9).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `server/src/routes.test.ts` with:

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createRouter } from "./routes.js";

vi.mock("./claudeCode.js", () => ({
  scanClaudeCodeUsage: vi.fn().mockResolvedValue({
    daily: [],
    byModel: [],
    byProject: [],
    today: { totalTokens: 0 },
    week: { totalTokens: 0 },
    month: { totalTokens: 0 },
  }),
}));

vi.mock("./adminApi.js", () => ({
  fetchApiUsage: vi.fn().mockResolvedValue({
    configured: false,
    daily: [],
    byModel: [],
    today: { totalTokens: 0, costUsd: 0 },
    week: { totalTokens: 0, costUsd: 0 },
    month: { totalTokens: 0, costUsd: 0 },
  }),
}));

describe("routes", () => {
  it("GET /api/health returns ok", async () => {
    const app = express();
    app.use(createRouter());
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/claude-code returns aggregated usage from the cache", async () => {
    const app = express();
    app.use(createRouter());
    const res = await request(app).get("/api/claude-code");
    expect(res.status).toBe(200);
    expect(res.body.daily).toEqual([]);
    expect(res.body.today).toEqual({ totalTokens: 0 });
  });

  it("GET /api/api-usage reports not-configured when no admin key is set", async () => {
    const app = express();
    app.use(createRouter());
    const res = await request(app).get("/api/api-usage");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run routes`
Expected: FAIL — `GET /api/claude-code` and `GET /api/api-usage` return 404 (routes don't exist yet)

- [ ] **Step 3: Rewrite `server/src/routes.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run routes`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full backend test suite**

Run: `cd server && npx vitest run`
Expected: PASS (all tests across claudeCode.test.ts, cache.test.ts, adminApi.test.ts, routes.test.ts)

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/src/routes.test.ts
git commit -m "Wire cached /api/claude-code and /api/api-usage routes"
```

---

## Task 7: Frontend scaffold

**Files:**
- Modify: `package.json` (root — no change needed, `frontend` already listed in `workspaces`)
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/theme.css`
- Create: `frontend/src/setupTests.ts`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Produces: a running Vite dev server on the default port (5173) that proxies `/api/*` to `http://localhost:4317`, and a minimal `App` component later replaced by Task 12.

- [ ] **Step 1: Write `frontend/package.json`**

```json
{
  "name": "frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^24.1.1",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4317",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.ts",
  },
});
```

- [ ] **Step 4: Write `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claude Usage Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `frontend/src/theme.css`**

Dark-mode-only palette, values taken from the dataviz skill's reference palette (`references/palette.md`), dark column:

```css
:root {
  color-scheme: dark;
  --surface-page: #0d0d0d;
  --surface-card: #1a1a19;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --gridline: #2c2c2a;
  --axis: #383835;
  --border: rgba(255, 255, 255, 0.1);
  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background: var(--surface-page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

- [ ] **Step 6: Write `frontend/src/setupTests.ts`**

```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 7: Write the failing test**

`frontend/src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the dashboard title", () => {
    render(<App />);
    expect(screen.getByText("Claude Usage Dashboard")).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Install frontend dependencies**

```bash
cd frontend && npm install && cd ..
```

- [ ] **Step 9: Run test to verify it fails**

Run: `cd frontend && npx vitest run`
Expected: FAIL — cannot find module `./App` (or the module doesn't export a title yet)

- [ ] **Step 10: Write `frontend/src/App.tsx` (minimal placeholder — Task 12 replaces this)**

```tsx
export default function App() {
  return (
    <div className="dashboard">
      <h1>Claude Usage Dashboard</h1>
    </div>
  );
}
```

- [ ] **Step 11: Write `frontend/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS (1 test)

- [ ] **Step 13: Commit**

```bash
git add frontend/package.json frontend/tsconfig.json frontend/vite.config.ts frontend/index.html frontend/src/main.tsx frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/theme.css frontend/src/setupTests.ts frontend/package-lock.json
git commit -m "Scaffold Vite + React frontend"
```

---

## Task 8: Formatting helpers & StatTile component

**Files:**
- Create: `frontend/src/format.ts`
- Test: `frontend/src/format.test.ts`
- Create: `frontend/src/components/StatTile.tsx`
- Test: `frontend/src/components/StatTile.test.tsx`
- Create: `frontend/src/components.css`

**Interfaces:**
- Produces: `formatTokens(n: number): string`, `formatUsd(n: number): string` from `format.ts`; `StatTile({ label, primaryValue, secondaryValue? }): JSX.Element` from `components/StatTile.tsx`. Both consumed by Task 12's `App.tsx`.

- [ ] **Step 1: Write the failing test for `format.ts`**

`frontend/src/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatTokens, formatUsd } from "./format";

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(42)).toBe("42");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatTokens(12_345)).toBe("12.3K");
  });

  it("formats millions with an M suffix", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatUsd", () => {
  it("formats to two decimal places with a dollar sign", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run format`
Expected: FAIL — cannot find module `./format`

- [ ] **Step 3: Write `frontend/src/format.ts`**

```ts
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run format`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for `StatTile`**

`frontend/src/components/StatTile.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders label, primary value, and optional secondary value", () => {
    render(<StatTile label="Today — Claude Code" primaryValue="12.3K" secondaryValue="tokens" />);
    expect(screen.getByText("Today — Claude Code")).toBeInTheDocument();
    expect(screen.getByText("12.3K")).toBeInTheDocument();
    expect(screen.getByText("tokens")).toBeInTheDocument();
  });

  it("omits the secondary value node when not provided", () => {
    render(<StatTile label="Today — API spend" primaryValue="$4.20" />);
    expect(screen.queryByText("tokens")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run StatTile`
Expected: FAIL — cannot find module `./StatTile`

- [ ] **Step 7: Write `frontend/src/components/StatTile.tsx`**

```tsx
export interface StatTileProps {
  label: string;
  primaryValue: string;
  secondaryValue?: string;
}

export function StatTile({ label, primaryValue, secondaryValue }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{primaryValue}</div>
      {secondaryValue && <div className="stat-tile-secondary">{secondaryValue}</div>}
    </div>
  );
}
```

- [ ] **Step 8: Write `frontend/src/components.css`**

```css
.dashboard {
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.dashboard-header h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 24px;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}

.stat-tile {
  background: var(--surface-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.stat-tile-label {
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin-bottom: 8px;
}

.stat-tile-value {
  color: var(--text-primary);
  font-size: 1.5rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-tile-secondary {
  color: var(--text-muted);
  font-size: 0.75rem;
  margin-top: 4px;
}

.chart-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.chart-card {
  background: var(--surface-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.chart-title {
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-weight: 500;
  margin: 0 0 12px;
}

.error-banner {
  color: var(--series-2);
  font-size: 0.85rem;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd frontend && npx vitest run StatTile`
Expected: PASS (2 tests)

- [ ] **Step 10: Commit**

```bash
git add frontend/src/format.ts frontend/src/format.test.ts frontend/src/components/StatTile.tsx frontend/src/components/StatTile.test.tsx frontend/src/components.css
git commit -m "Add formatting helpers and StatTile component"
```

---

## Task 9: Backend API client & polling hook

**Files:**
- Create: `frontend/src/api.ts`
- Create: `frontend/src/hooks/usePolling.ts`
- Test: `frontend/src/hooks/usePolling.test.ts`

**Interfaces:**
- Produces: `fetchClaudeCodeUsage(): Promise<ClaudeCodeUsage>`, `fetchApiUsageData(): Promise<ApiUsage>` from `api.ts`; `usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): { data: T | null; error: string | null; loading: boolean }` from `hooks/usePolling.ts`. Both consumed by Task 12's `App.tsx`.
- Consumes: nothing from earlier frontend tasks (mirrors the backend `ClaudeCodeUsage`/`ApiUsage` shapes from Task 3, duplicated here since frontend and backend are separate packages).

- [ ] **Step 1: Write `frontend/src/api.ts`**

```ts
export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ProjectUsage {
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageRollup {
  totalTokens: number;
}

export interface ClaudeCodeUsage {
  daily: DailyUsage[];
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  today: UsageRollup;
  week: UsageRollup;
  month: UsageRollup;
}

export interface ApiDailyUsage {
  date: string;
  totalTokens: number;
  costUsd: number;
}

export interface ApiModelUsage {
  model: string;
  totalTokens: number;
  costUsd: number;
}

export interface ApiUsageRollup {
  totalTokens: number;
  costUsd: number;
}

export interface ApiUsage {
  configured: boolean;
  daily: ApiDailyUsage[];
  byModel: ApiModelUsage[];
  today: ApiUsageRollup;
  week: ApiUsageRollup;
  month: ApiUsageRollup;
}

export async function fetchClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  const res = await fetch("/api/claude-code");
  if (!res.ok) throw new Error(`Failed to load Claude Code usage: ${res.status}`);
  return res.json();
}

export async function fetchApiUsageData(): Promise<ApiUsage> {
  const res = await fetch("/api/api-usage");
  if (!res.ok) throw new Error(`Failed to load API usage: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Write the failing test for `usePolling`**

`frontend/src/hooks/usePolling.test.ts`:

```ts
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { usePolling } from "./usePolling";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePolling", () => {
  it("loads data immediately and exposes it once resolved", async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { result } = renderHook(() => usePolling(fetcher, 60_000));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual({ value: 1 });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches on the configured interval", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    renderHook(() => usePolling(fetcher, 1000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces the error message when the fetcher rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePolling(fetcher, 60_000));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run usePolling`
Expected: FAIL — cannot find module `./usePolling`

- [ ] **Step 4: Write `frontend/src/hooks/usePolling.ts`**

```ts
import { useEffect, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetcher();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetcher, intervalMs]);

  return { data, error, loading };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run usePolling`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/hooks/usePolling.ts frontend/src/hooks/usePolling.test.ts
git commit -m "Add backend API client and polling hook"
```

---

## Task 10: TimeSeriesChart component

**Files:**
- Create: `frontend/src/components/TimeSeriesChart.tsx`
- Test: `frontend/src/components/TimeSeriesChart.test.tsx`

**Interfaces:**
- Produces: `TimeSeriesChart({ title, data, color, valueFormatter }): JSX.Element` where `data: Array<{ date: string; value: number }>`. Consumed by Task 12's `App.tsx`.

- [ ] **Step 1: Write the failing test**

`frontend/src/components/TimeSeriesChart.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { formatTokens } from "../format";

describe("TimeSeriesChart", () => {
  it("renders the chart title", () => {
    render(
      <TimeSeriesChart
        title="Claude Code tokens/day"
        data={[
          { date: "2026-07-20", value: 1000 },
          { date: "2026-07-21", value: 2000 },
        ]}
        color="var(--series-1)"
        valueFormatter={formatTokens}
      />,
    );
    expect(screen.getByText("Claude Code tokens/day")).toBeInTheDocument();
  });

  it("renders without crashing when given an empty series", () => {
    render(<TimeSeriesChart title="Empty" data={[]} color="var(--series-1)" valueFormatter={formatTokens} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run TimeSeriesChart`
Expected: FAIL — cannot find module `./TimeSeriesChart`

- [ ] **Step 3: Write `frontend/src/components/TimeSeriesChart.tsx`**

```tsx
import { Line, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface TimeSeriesChartProps {
  title: string;
  data: TimeSeriesPoint[];
  color: string;
  valueFormatter: (value: number) => string;
}

export function TimeSeriesChart({ title, data, color, valueFormatter }: TimeSeriesChartProps) {
  return (
    <div className="chart-card">
      <h2 className="chart-title">{title}</h2>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--gridline)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" stroke="var(--axis)" tick={{ fill: "var(--text-muted)", fontSize: 12 }} />
          <YAxis
            stroke="var(--axis)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            tickFormatter={valueFormatter}
            width={64}
          />
          <Tooltip
            formatter={(value: number) => valueFormatter(value)}
            contentStyle={{ background: "var(--surface-card)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            labelStyle={{ color: "var(--text-secondary)" }}
          />
          <Line type="monotone" dataKey="value" name={title} stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run TimeSeriesChart`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TimeSeriesChart.tsx frontend/src/components/TimeSeriesChart.test.tsx
git commit -m "Add TimeSeriesChart component"
```

---

## Task 11: HorizontalBarChart component (model & project breakdowns)

**Files:**
- Create: `frontend/src/components/HorizontalBarChart.tsx`
- Test: `frontend/src/components/HorizontalBarChart.test.tsx`

**Interfaces:**
- Produces: `HorizontalBarChart({ title, data, valueFormatter }): JSX.Element` where `data: Array<{ label: string; value: number }>`. Consumed by Task 12's `App.tsx` for both the model breakdown and project breakdown panels.

- [ ] **Step 1: Write the failing test**

`frontend/src/components/HorizontalBarChart.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HorizontalBarChart } from "./HorizontalBarChart";
import { formatTokens } from "../format";

describe("HorizontalBarChart", () => {
  it("renders the chart title", () => {
    render(
      <HorizontalBarChart
        title="Claude Code tokens by model"
        data={[
          { label: "claude-opus-4-8", value: 5000 },
          { label: "claude-sonnet-5", value: 3000 },
        ]}
        valueFormatter={formatTokens}
      />,
    );
    expect(screen.getByText("Claude Code tokens by model")).toBeInTheDocument();
  });

  it("renders without crashing when given no entries", () => {
    render(<HorizontalBarChart title="Empty" data={[]} valueFormatter={formatTokens} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run HorizontalBarChart`
Expected: FAIL — cannot find module `./HorizontalBarChart`

- [ ] **Step 3: Write `frontend/src/components/HorizontalBarChart.tsx`**

```tsx
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const SLOT_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

export interface HorizontalBarChartEntry {
  label: string;
  value: number;
}

export interface HorizontalBarChartProps {
  title: string;
  data: HorizontalBarChartEntry[];
  valueFormatter: (value: number) => string;
}

export function HorizontalBarChart({ title, data, valueFormatter }: HorizontalBarChartProps) {
  return (
    <div className="chart-card">
      <h2 className="chart-title">{title}</h2>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--gridline)" strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            stroke="var(--axis)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            tickFormatter={valueFormatter}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--axis)"
            tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
            width={140}
          />
          <Tooltip
            formatter={(value: number) => valueFormatter(value)}
            contentStyle={{ background: "var(--surface-card)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => (
              <Cell key={entry.label} fill={SLOT_COLORS[index % SLOT_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run HorizontalBarChart`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HorizontalBarChart.tsx frontend/src/components/HorizontalBarChart.test.tsx
git commit -m "Add HorizontalBarChart component for model and project breakdowns"
```

---

## Task 12: Full dashboard wiring

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/main.tsx` (import `components.css`)

**Interfaces:**
- Consumes: `usePolling` (Task 9), `fetchClaudeCodeUsage`/`fetchApiUsageData` (Task 9), `StatTile` (Task 8), `TimeSeriesChart` (Task 10), `HorizontalBarChart` (Task 11), `formatTokens`/`formatUsd` (Task 8).

- [ ] **Step 1: Update the failing test**

Replace `frontend/src/App.test.tsx` with:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "./App";
import type { ApiUsage, ClaudeCodeUsage } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

function claudeCodeFixture(): ClaudeCodeUsage {
  return {
    daily: [{ date: "2026-07-21", inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    byModel: [{ model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    byProject: [{ project: "app-a", inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    today: { totalTokens: 1500 },
    week: { totalTokens: 1500 },
    month: { totalTokens: 1500 },
  };
}

function apiUsageFixture(): ApiUsage {
  return {
    configured: true,
    daily: [{ date: "2026-07-21", totalTokens: 800, costUsd: 3.5 }],
    byModel: [{ model: "claude-opus-4-8", totalTokens: 800, costUsd: 3.5 }],
    today: { totalTokens: 800, costUsd: 3.5 },
    week: { totalTokens: 800, costUsd: 3.5 },
    month: { totalTokens: 800, costUsd: 3.5 },
  };
}

describe("App", () => {
  it("renders the dashboard title and KPI tiles once data loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.includes("/api/claude-code")) {
          return new Response(JSON.stringify(claudeCodeFixture()), { status: 200 });
        }
        if (href.includes("/api/api-usage")) {
          return new Response(JSON.stringify(apiUsageFixture()), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    render(<App />);

    expect(screen.getByText("Claude Usage Dashboard")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("1.5K")).toBeInTheDocument());
    expect(screen.getByText("$3.50")).toBeInTheDocument();
  });

  it("shows a not-configured hint for API spend when the admin key is unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.includes("/api/claude-code")) {
          return new Response(JSON.stringify(claudeCodeFixture()), { status: 200 });
        }
        if (href.includes("/api/api-usage")) {
          return new Response(
            JSON.stringify({
              configured: false,
              daily: [],
              byModel: [],
              today: { totalTokens: 0, costUsd: 0 },
              week: { totalTokens: 0, costUsd: 0 },
              month: { totalTokens: 0, costUsd: 0 },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText("Admin API key not configured")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run App`
Expected: FAIL — the placeholder `App` from Task 7 has no KPI tiles or charts

- [ ] **Step 3: Rewrite `frontend/src/App.tsx`**

```tsx
import { usePolling } from "./hooks/usePolling";
import { fetchClaudeCodeUsage, fetchApiUsageData } from "./api";
import { StatTile } from "./components/StatTile";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { HorizontalBarChart } from "./components/HorizontalBarChart";
import { formatTokens, formatUsd } from "./format";

const CLAUDE_CODE_POLL_MS = 60_000;
const API_USAGE_POLL_MS = 60_000;

function tokenTotal(row: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): number {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
}

export default function App() {
  const claudeCode = usePolling(fetchClaudeCodeUsage, CLAUDE_CODE_POLL_MS);
  const apiUsage = usePolling(fetchApiUsageData, API_USAGE_POLL_MS);

  const claudeCodeTokenSeries = (claudeCode.data?.daily ?? []).map((d) => ({
    date: d.date,
    value: tokenTotal(d),
  }));

  const apiCostSeries = (apiUsage.data?.daily ?? []).map((d) => ({
    date: d.date,
    value: d.costUsd,
  }));

  const modelTokenData = (claudeCode.data?.byModel ?? []).map((m) => ({
    label: m.model,
    value: tokenTotal(m),
  }));

  const apiModelCostData = (apiUsage.data?.byModel ?? []).map((m) => ({
    label: m.model,
    value: m.costUsd,
  }));

  const projectData = (claudeCode.data?.byProject ?? []).map((p) => ({
    label: p.project,
    value: tokenTotal(p),
  }));

  const apiConfigured = apiUsage.data?.configured ?? true;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Claude Usage Dashboard</h1>
      </header>

      <section className="stat-row">
        <StatTile label="Today — Claude Code" primaryValue={formatTokens(claudeCode.data?.today.totalTokens ?? 0)} secondaryValue="tokens" />
        <StatTile
          label="Today — API spend"
          primaryValue={apiConfigured ? formatUsd(apiUsage.data?.today.costUsd ?? 0) : "—"}
          secondaryValue={apiConfigured ? undefined : "Admin API key not configured"}
        />
        <StatTile label="This week — Claude Code" primaryValue={formatTokens(claudeCode.data?.week.totalTokens ?? 0)} secondaryValue="tokens" />
        <StatTile label="This week — API spend" primaryValue={apiConfigured ? formatUsd(apiUsage.data?.week.costUsd ?? 0) : "—"} />
        <StatTile label="This month — Claude Code" primaryValue={formatTokens(claudeCode.data?.month.totalTokens ?? 0)} secondaryValue="tokens" />
        <StatTile label="This month — API spend" primaryValue={apiConfigured ? formatUsd(apiUsage.data?.month.costUsd ?? 0) : "—"} />
      </section>

      <section className="chart-row">
        <TimeSeriesChart
          title="Claude Code tokens/day (last 30 days)"
          data={claudeCodeTokenSeries}
          color="var(--series-1)"
          valueFormatter={formatTokens}
        />
        <TimeSeriesChart title="API spend/day (last 30 days)" data={apiCostSeries} color="var(--series-2)" valueFormatter={formatUsd} />
      </section>

      <section className="chart-row">
        <HorizontalBarChart title="Claude Code tokens by model" data={modelTokenData} valueFormatter={formatTokens} />
        <HorizontalBarChart title="API spend by model" data={apiModelCostData} valueFormatter={formatUsd} />
      </section>

      <section className="chart-row">
        <HorizontalBarChart title="Claude Code tokens by project" data={projectData} valueFormatter={formatTokens} />
      </section>

      {claudeCode.error && <p className="error-banner">Claude Code data error: {claudeCode.error}</p>}
      {apiUsage.error && <p className="error-banner">API usage data error: {apiUsage.error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Import `components.css` in `frontend/src/main.tsx`**

Update the import list at the top of `frontend/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./components.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run App`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (all tests across format, StatTile, usePolling, TimeSeriesChart, HorizontalBarChart, App)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/main.tsx
git commit -m "Wire full dashboard layout: KPI tiles, trend charts, breakdowns"
```

---

## Task 13: End-to-end wiring & manual verification

**Files:**
- Modify: `.env` (local only, not committed — created by the user from `.env.example`)
- No new source files; this task verifies the two packages run together correctly.

**Interfaces:**
- Consumes: everything from Tasks 1–12.

- [ ] **Step 1: Run the full test suite from the repo root**

```bash
npm install
npm run test
```

Expected: both `server` and `frontend` test suites PASS.

- [ ] **Step 2: Build both packages**

```bash
npm run build
```

Expected: `frontend/dist/` and `server/dist/` are produced with no TypeScript errors.

- [ ] **Step 3: Start the dev servers**

```bash
npm run dev
```

Expected console output: the server logs `Claude dashboard server listening on http://localhost:4317` and Vite logs its local dev URL (default `http://localhost:5173`).

- [ ] **Step 4: Manually verify in the browser**

Open `http://localhost:5173`. Confirm:
- The page renders in dark mode with the "Claude Usage Dashboard" title.
- The KPI tile row shows real numbers for "Today/This week/This month — Claude Code" (pulled from your actual `~/.claude/projects` logs).
- The "API spend" tiles show `—` with "Admin API key not configured" if `.env` has no `ANTHROPIC_ADMIN_API_KEY` set, or real `$` figures if it does.
- The trend chart, model breakdown, and project breakdown charts render without console errors.
- Reloading after a minute shows updated numbers if new Claude Code activity occurred (confirms the polling/cache refresh works).

- [ ] **Step 5: (Optional) Configure the Admin API key**

Copy `.env.example` to `.env` at the repo root, generate an Admin API key in the Anthropic Console (org admin only), and set `ANTHROPIC_ADMIN_API_KEY=sk-ant-admin01-...`. Restart `npm run dev` and confirm the "API spend" tiles and charts populate with real data within one refresh cycle (up to 5 minutes, per the backend's `API_USAGE_TTL_MS`).

- [ ] **Step 6: Commit any final fixups**

If manual verification surfaced no issues, there's nothing to commit here. If it did, fix the specific file, re-run the relevant test suite, and commit with a message describing the fix.

```bash
git status
```

Expected: clean working tree (all prior task commits already cover the shipped code).
