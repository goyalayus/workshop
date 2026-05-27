import { apiJson, jsonInit } from "./request";

export type AutoDebugStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type AutoDebugSeverity = "low" | "medium" | "high";

export interface AutoDebugRun {
  id: string;
  name: string | null;
  status: AutoDebugStatus;
  model: string;
  run_ids: string;
  architecture_context: string | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
}

export interface AutoDebugOccurrence {
  id: string;
  analysis_run_id: string;
  failure_case_id: string;
  trace_run_id: string;
  span_id: string | null;
  trace_part_index: number;
  summary: string;
  evidence: string | null;
  difference: string | null;
  raw_json: string | null;
  created_at: number;
}

export interface AutoDebugFailureCase {
  id: string;
  title: string;
  summary: string;
  severity: AutoDebugSeverity;
  status: "open" | "resolved" | "ignored";
  first_seen_run_id: string | null;
  occurrence_count: number;
  created_at: number;
  updated_at: number;
  recent_occurrences: AutoDebugOccurrence[];
}

export async function listAutoDebugRuns(): Promise<AutoDebugRun[]> {
  const body = await apiJson<{ runs: AutoDebugRun[] }>("/api/auto-debug/runs");
  return body.runs;
}

export async function listAutoDebugFailures(): Promise<AutoDebugFailureCase[]> {
  const body = await apiJson<{ failure_cases: AutoDebugFailureCase[] }>("/api/auto-debug/failure-cases");
  return body.failure_cases;
}

export async function startAutoDebugRun(input: {
  runIds?: string[];
  limit?: number;
  model?: string;
  architectureContext?: string;
}): Promise<AutoDebugRun> {
  const body = await apiJson<{ run: AutoDebugRun }>("/api/auto-debug/runs", jsonInit("POST", input));
  return body.run;
}

export async function cancelAutoDebugRun(id: string): Promise<boolean> {
  const body = await apiJson<{ cancelled: boolean }>(`/api/auto-debug/runs/${encodeURIComponent(id)}/cancel`, jsonInit("POST"));
  return body.cancelled;
}
