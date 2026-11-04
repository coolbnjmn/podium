export function forwardBody(payload: unknown): {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  background_tasks?: { id?: string; type?: string; status?: string; description?: string }[];
  session_crons?: { id?: string; schedule?: string; recurring?: boolean; prompt?: string; next_at?: number }[];
} | null;
export function tokenFor(url: string, env: Record<string, string | undefined>, home: string): string;
export function nextCronAt(schedule: string, from: number): number | null;
