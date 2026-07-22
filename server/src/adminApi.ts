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
