import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDrizzleDb, getRunOutline, getRunWithSpans, getRuns } from "./db";
import * as schema from "./db/schema";

export type AutoDebugRunStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type AutoDebugSeverity = "low" | "medium" | "high";

export interface StartAutoDebugInput {
  runIds?: string[];
  limit?: number;
  model?: string;
  architectureContext?: string;
  maxTracePartChars?: number;
}

export interface AutoDebugRunRow {
  id: string;
  name: string | null;
  status: AutoDebugRunStatus;
  model: string;
  run_ids: string;
  architecture_context: string | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
}

type FailureCaseRow = typeof schema.auto_debug_failure_cases.$inferSelect;
type OccurrenceRow = typeof schema.auto_debug_failure_occurrences.$inferSelect;

type AutoDebugSpan = {
  id?: string | null;
  parent_span_id?: string | null;
  name: string;
  span_type: string | null;
  status?: string | null;
  input_payload?: string | null;
  output_payload?: string | null;
  duration_ms?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  attributes?: string | null;
  normalized?: unknown;
};

type TracePart = {
  run_id: string;
  part_index: number;
  part_count: number;
  run: Record<string, unknown>;
  summary: Record<string, unknown>;
  live_events: Record<string, unknown>;
  sub_agents: unknown[];
  annotations: unknown[];
  errors: unknown[];
  suspect_spans: Array<Record<string, unknown>>;
  spans: Array<Record<string, unknown>>;
};

type ModelFailureCase = {
  existing_failure_id?: unknown;
  title?: unknown;
  summary?: unknown;
  severity?: unknown;
  confidence?: unknown;
  occurrence?: {
    span_id?: unknown;
    where?: unknown;
    how_it_occurred?: unknown;
    evidence?: unknown;
    difference_from_existing?: unknown;
  };
};

type ModelAnalysis = {
  trace_verdict?: unknown;
  trace_summary?: unknown;
  failure_cases?: ModelFailureCase[];
  notes?: unknown;
};

type AutoDebugJob = {
  abort: AbortController;
};

const activeJobs = new Map<string, AutoDebugJob>();
const DEFAULT_MODEL = "DeepSeek-V4-Pro";
const MAX_RUNS_PER_ANALYSIS = 20;
const DEFAULT_TRACE_PART_CHARS = 80_000;
const MAX_TRACE_PART_CHARS = 160_000;
const MAX_PARTS_PER_TRACE = 8;

export function listAutoDebugRuns(limit = 50): AutoDebugRunRow[] {
  return getDrizzleDb()
    .select()
    .from(schema.auto_debug_runs)
    .orderBy(desc(schema.auto_debug_runs.updated_at))
    .limit(Math.max(1, Math.min(200, limit)))
    .all() as AutoDebugRunRow[];
}

export function getAutoDebugRun(id: string) {
  const db = getDrizzleDb();
  const run = db
    .select()
    .from(schema.auto_debug_runs)
    .where(eq(schema.auto_debug_runs.id, id))
    .limit(1)
    .get() as AutoDebugRunRow | undefined;
  if (!run) return null;
  return {
    run,
    occurrences: db
      .select()
      .from(schema.auto_debug_failure_occurrences)
      .where(eq(schema.auto_debug_failure_occurrences.analysis_run_id, id))
      .orderBy(desc(schema.auto_debug_failure_occurrences.created_at))
      .all(),
  };
}

export function listFailureCases(limit = 100) {
  const db = getDrizzleDb();
  const cases = db
    .select()
    .from(schema.auto_debug_failure_cases)
    .orderBy(desc(schema.auto_debug_failure_cases.updated_at))
    .limit(Math.max(1, Math.min(500, limit)))
    .all();
  const caseIds = cases.map((item) => item.id);
  const occurrences = caseIds.length
    ? db
        .select()
        .from(schema.auto_debug_failure_occurrences)
        .where(inArray(schema.auto_debug_failure_occurrences.failure_case_id, caseIds))
        .orderBy(desc(schema.auto_debug_failure_occurrences.created_at))
        .limit(500)
        .all()
    : [];
  const byCase = new Map<string, OccurrenceRow[]>();
  for (const occurrence of occurrences as OccurrenceRow[]) {
    const list = byCase.get(occurrence.failure_case_id) ?? [];
    if (list.length < 6) list.push(occurrence);
    byCase.set(occurrence.failure_case_id, list);
  }
  return cases.map((item) => ({ ...item, recent_occurrences: byCase.get(item.id) ?? [] }));
}

export function startAutoDebugAnalysis(input: StartAutoDebugInput): AutoDebugRunRow {
  const runIds = chooseRunIds(input);
  if (runIds.length === 0) {
    throw new Error("No trace runs found for auto-debugging.");
  }
  if (runIds.length > MAX_RUNS_PER_ANALYSIS) {
    throw new Error(`Auto-debugging is capped at ${MAX_RUNS_PER_ANALYSIS} traces per run.`);
  }

  const now = Date.now();
  const id = `autodebug_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
  const model = cleanString(input.model) || process.env.RAINDROP_AUTODEBUG_MODEL || DEFAULT_MODEL;
  const row = {
    id,
    name: `Auto debug ${runIds.length} trace${runIds.length === 1 ? "" : "s"}`,
    status: "queued" as AutoDebugRunStatus,
    model,
    run_ids: JSON.stringify(runIds),
    architecture_context: cleanString(input.architectureContext) || null,
    summary: null,
    error: null,
    started_at: now,
    completed_at: null,
    updated_at: now,
  };
  getDrizzleDb().insert(schema.auto_debug_runs).values(row).run();

  const abort = new AbortController();
  activeJobs.set(id, { abort });
  void runAutoDebugAnalysis(id, input, abort.signal).finally(() => {
    activeJobs.delete(id);
  });
  return row;
}

export function cancelAutoDebugAnalysis(id: string): boolean {
  const job = activeJobs.get(id);
  if (!job) return false;
  job.abort.abort();
  markRunStatus(id, "cancelled", "Cancelled by user.");
  activeJobs.delete(id);
  return true;
}

async function runAutoDebugAnalysis(
  analysisRunId: string,
  input: StartAutoDebugInput,
  signal: AbortSignal,
): Promise<void> {
  const db = getDrizzleDb();
  const run = db
    .select()
    .from(schema.auto_debug_runs)
    .where(eq(schema.auto_debug_runs.id, analysisRunId))
    .limit(1)
    .get() as AutoDebugRunRow | undefined;
  if (!run) return;

  markRunStatus(analysisRunId, "running");
  const runIds = parseRunIds(run.run_ids);
  let traceCount = 0;
  let partCount = 0;
  let occurrenceCount = 0;

  try {
    for (const runId of runIds) {
      if (signal.aborted) throw new Error("Auto-debugging was cancelled.");
      const parts = buildTraceParts(runId, tracePartCharBudget(input.maxTracePartChars));
      traceCount++;
      for (const part of parts) {
        if (signal.aborted) throw new Error("Auto-debugging was cancelled.");
        partCount++;
        const analysis = await analyzeTracePart({
          model: run.model,
          architectureContext: run.architecture_context ?? "",
          part,
          failureCases: compactFailureCases(listFailureCases(120)),
          signal,
        });
        occurrenceCount += persistModelAnalysis({
          analysisRunId,
          traceRunId: runId,
          partIndex: part.part_index,
          analysis,
        });
        updateRunProgress(analysisRunId, {
          traceCount,
          partCount,
          occurrenceCount,
          currentRunId: runId,
        });
      }
    }
    markRunStatus(
      analysisRunId,
      "done",
      `Analyzed ${traceCount} trace${traceCount === 1 ? "" : "s"} in ${partCount} part${partCount === 1 ? "" : "s"} and recorded ${occurrenceCount} failure occurrence${occurrenceCount === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    if (signal.aborted) {
      markRunStatus(analysisRunId, "cancelled", "Cancelled by user.");
      return;
    }
    markRunStatus(analysisRunId, "error", null, (err as Error).message);
  }
}

function chooseRunIds(input: StartAutoDebugInput): string[] {
  const explicit = (input.runIds ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)].slice(0, MAX_RUNS_PER_ANALYSIS);

  const limit = Math.max(1, Math.min(MAX_RUNS_PER_ANALYSIS, input.limit ?? 10));
  return (getRuns(limit * 3) as Array<{ id: string; finished?: number | null; span_count?: number | null }>)
    .filter((run) => run.finished === 1 && (run.span_count ?? 0) > 0)
    .slice(0, limit)
    .map((run) => run.id);
}

function buildTraceParts(runId: string, maxChars: number): TracePart[] {
  const outline = getRunOutline(runId, 220);
  const { run, spans } = getRunWithSpans(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const compactSpans = (spans as AutoDebugSpan[]).map(compactSpan);
  const suspectSpans = spans
    .filter((span) => isSuspectSpan(span as AutoDebugSpan))
    .slice(0, 24)
    .map((span) => compactSuspectSpan(span as AutoDebugSpan));
  const totalChars = jsonSize(compactSpans);
  const budget = Math.max(maxChars, Math.ceil(totalChars / MAX_PARTS_PER_TRACE));
  const base = {
    run_id: runId,
    run: outline.run ?? (run as Record<string, unknown>),
    summary: outline.summary,
    live_events: outline.live_events,
    sub_agents: outline.sub_agents,
    annotations: outline.annotations,
    errors: outline.errors,
  };
  const parts: TracePart[] = [];
  let current: Array<Record<string, unknown>> = [];
  for (const span of compactSpans) {
    const candidate = [...current, span];
    if (current.length > 0 && jsonSize({ ...base, spans: candidate }) > budget) {
      parts.push({
        ...base,
        part_index: parts.length,
        part_count: 0,
        suspect_spans: [],
        spans: current,
      });
      current = [span];
    } else {
      current = candidate;
    }
  }
  parts.push({ ...base, part_index: parts.length, part_count: 0, suspect_spans: [], spans: current });
  const cappedParts = parts.length > MAX_PARTS_PER_TRACE
    ? rebalanceTraceParts(base, compactSpans)
    : parts;
  if (cappedParts[0]) cappedParts[0].suspect_spans = suspectSpans;
  const partCount = cappedParts.length;
  return cappedParts.map((part, index) => ({
    ...part,
    part_index: index,
    part_count: partCount,
  }));
}

function rebalanceTraceParts(
  base: Omit<TracePart, "part_index" | "part_count" | "suspect_spans" | "spans">,
  spans: Array<Record<string, unknown>>,
): TracePart[] {
  const chunkSize = Math.max(1, Math.ceil(spans.length / MAX_PARTS_PER_TRACE));
  const parts: TracePart[] = [];
  for (let index = 0; index < spans.length; index += chunkSize) {
    parts.push({
      ...base,
      part_index: parts.length,
      part_count: 0,
      suspect_spans: [],
      spans: spans.slice(index, index + chunkSize),
    });
  }
  return parts;
}

function compactSpan(span: AutoDebugSpan): Record<string, unknown> {
  const normalized = span.normalized;
  return {
    id: span.id,
    parent_id: span.parent_span_id,
    name: span.name,
    type: span.span_type,
    status: span.status,
    duration_ms: span.duration_ms,
    model: span.model,
    tokens: { in: span.input_tokens ?? 0, out: span.output_tokens ?? 0 },
    input_chars: span.input_payload?.length ?? 0,
    output_chars: span.output_payload?.length ?? 0,
    input_preview: truncate(span.input_payload, 2_000),
    output_preview: truncate(span.output_payload, 2_000),
    normalized: compactNormalizedSpan(normalized),
  };
}

function isSuspectSpan(span: AutoDebugSpan): boolean {
  const haystack = [
    span.name,
    span.status,
    span.input_payload,
    span.output_payload,
    span.attributes,
  ].join("\n").toLowerCase();
  return [
    "needs_repair",
    "needs_fix",
    "verification",
    "validation",
    "reviewer",
    "repair",
    "missing",
    "invalid",
    "suspicious",
    "card_id",
    "account_id",
    "any_of",
    "followup",
    "prerequisite",
  ].some((term) => haystack.includes(term));
}

function compactSuspectSpan(span: AutoDebugSpan): Record<string, unknown> {
  return {
    id: span.id,
    name: span.name,
    type: span.span_type,
    status: span.status,
    input_preview: truncate(span.input_payload, 3_000),
    output_preview: truncate(span.output_payload, 5_000),
  };
}

function compactNormalizedSpan(normalized: unknown): unknown {
  if (!normalized || typeof normalized !== "object") return undefined;
  const value = normalized as Record<string, unknown>;
  if (value.kind === "other") return undefined;
  if (value.kind === "tool") {
    return {
      kind: "tool",
      name: value.name,
      args: truncateJson(value.args, 1_200),
      result: truncateJson(value.result, 1_200),
      resultIsError: value.resultIsError,
    };
  }
  if (value.kind === "llm") {
    const messages = value.messages;
    return {
      kind: "llm",
      model: value.model,
      userMessage: truncate(value.userMessage, 1_200),
      systemPrompt: truncate(value.systemPrompt, 1_200),
      messageCount: Array.isArray(messages) ? messages.length : 0,
    };
  }
  return undefined;
}

async function analyzeTracePart(args: {
  model: string;
  architectureContext: string;
  part: TracePart;
  failureCases: unknown[];
  signal: AbortSignal;
}): Promise<ModelAnalysis> {
  const messages = [
    {
      role: "system",
      content: autoDebugSystemPrompt(),
    },
    {
      role: "user",
      content: autoDebugUserPrompt(args),
    },
  ];
  const parsed = await callAzureChatJson({
    deployment: args.model,
    messages,
    signal: args.signal,
  });
  return normalizeModelAnalysis(parsed);
}

function autoDebugSystemPrompt(): string {
  return [
    "You are Raindrop Workshop Auto-Debugger.",
    "Your job is to inspect one trace part and update a growing failure-case database.",
    "Be precise. A failure case is a reusable bug pattern, not a one-off complaint.",
    "If the same failure pattern already exists, use existing_failure_id instead of creating a duplicate.",
    "If the trace only shows normal behavior, return an empty failure_cases array.",
    "Use span IDs as evidence whenever possible.",
    "Do not propose code changes unless the trace proves the mechanism.",
    "Important: graph-agent failures often have status OK. Look for quality failures in reviewer outputs, verifier outputs, repaired JSON, and final graph artifacts.",
    "Treat reviewer misses, verifier misses, bad repair application, invalid dependency paths, and semantically wrong value mappings as real failures when evidence exists.",
    "Return one valid JSON object only.",
  ].join("\n");
}

function autoDebugUserPrompt(args: {
  architectureContext: string;
  part: TracePart;
  failureCases: unknown[];
}): string {
  return [
    "Analyze this trace part sequentially. You are seeing prior failure cases found in earlier traces/parts.",
    "",
    "Architecture context from the agent-building chat:",
    args.architectureContext.trim() || "(No architecture context was provided.)",
    "",
    "Existing failure cases. Reuse an id when this trace shows the same underlying bug pattern:",
    JSON.stringify(args.failureCases, null, 2),
    "",
    "Trace part:",
    JSON.stringify(args.part, null, 2),
    "",
    "Failure patterns to actively check for in tool-graph traces:",
    JSON.stringify([
      "A reviewer says needs_repair, but the repaired payload keeps the same underlying issue.",
      "A programmatic verifier reports pass even though a path cannot actually satisfy a required previous_tool_output argument.",
      "An edge carries an identifier for one entity into an argument for a different entity without a lookup/conversion in the path.",
      "A dependency group uses any_of where each branch is not independently executable.",
      "A required or should action is incorrectly stored as a maybe-followup, or optional work is made required.",
      "A constraint is accepted even though the selected trajectory failed programmatic verification.",
      "The final graph looks clean only because a verifier checked field existence but not semantic identity.",
    ], null, 2),
    "",
    "Output schema:",
    JSON.stringify({
      trace_verdict: "has_failure|no_failure|unclear",
      trace_summary: "short factual trace summary",
      failure_cases: [
        {
          existing_failure_id: "existing id or empty string",
          title: "short reusable failure pattern title",
          summary: "what goes wrong and why it matters",
          severity: "low|medium|high",
          confidence: 0.0,
          occurrence: {
            span_id: "best evidence span id or empty string",
            where: "where it happened in this trace",
            how_it_occurred: "exact mechanism in this trace",
            evidence: "short evidence, preferably span ids or quoted field names",
            difference_from_existing: "only if reusing an existing failure id",
          },
        },
      ],
      notes: "short notes",
    }, null, 2),
    "",
    "Few-shot examples:",
    JSON.stringify([
      {
        trace_verdict: "has_failure",
        failure_cases: [
          {
            existing_failure_id: "failure_tool_argument_entity_mismatch",
            title: "Tool argument carries the wrong entity identifier",
            summary: "The graph treats one entity id as another instead of requiring a lookup or user-supplied value.",
            severity: "high",
            confidence: 0.93,
            occurrence: {
              span_id: "span_123",
              where: "followup extraction output",
              how_it_occurred: "The edge maps card_id into account_id without a lookup that exposes account_id.",
              evidence: "span_123 output_used_for contains card_id -> account_id",
              difference_from_existing: "Same pattern; this occurrence is in a followup edge instead of a prerequisite edge.",
            },
          },
        ],
      },
      {
        trace_verdict: "no_failure",
        trace_summary: "The trace follows the expected retry and repair flow.",
        failure_cases: [],
        notes: "No reusable failure pattern was visible in this part.",
      },
    ], null, 2),
  ].join("\n");
}

async function callAzureChatJson(args: {
  deployment: string;
  messages: Array<{ role: string; content: string }>;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const config = azureConfig(args.deployment);
  const url = `${config.endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
  const baseBody = {
    messages: args.messages,
    temperature: 0.1,
    max_tokens: 4096,
  };
  const first = await postAzureChat(url, config.apiKey, {
    ...baseBody,
    response_format: { type: "json_object" },
  }, args.signal);
  if (first.ok) return parseJsonObjectStrict(first.text);

  // Some non-OpenAI Azure deployments reject response_format. Retry once with
  // prompt-only JSON enforcement before surfacing the provider error.
  if (first.status === 400) {
    const retry = await postAzureChat(url, config.apiKey, baseBody, args.signal);
    if (retry.ok) return parseJsonObjectStrict(retry.text);
    throw new Error(providerErrorMessage(retry.status, retry.text));
  }
  throw new Error(providerErrorMessage(first.status, first.text));
}

async function postAzureChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function azureConfig(model: string): {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
} {
  loadLocalAutoDebugEnv();
  const endpoint = stripTrailingSlash(
    process.env.RAINDROP_AUTODEBUG_AZURE_ENDPOINT
      || process.env.AZURE_OPENAI_CHAT_ENDPOINT
      || process.env.AZURE_OPENAI_ENDPOINT
      || "",
  );
  const apiKey =
    process.env.RAINDROP_AUTODEBUG_AZURE_API_KEY
    || process.env.AZURE_OPENAI_CHAT_API_KEY
    || process.env.AZURE_OPENAI_API_KEY
    || "";
  const deployment =
    process.env.RAINDROP_AUTODEBUG_AZURE_DEPLOYMENT
    || process.env.AZURE_OPENAI_CHAT_DEPLOYMENT
    || model
    || DEFAULT_MODEL;
  const apiVersion =
    process.env.RAINDROP_AUTODEBUG_AZURE_API_VERSION
    || process.env.AZURE_OPENAI_API_VERSION
    || "2025-04-01-preview";
  if (!endpoint) throw new Error("Missing RAINDROP_AUTODEBUG_AZURE_ENDPOINT or AZURE_OPENAI_ENDPOINT.");
  if (!apiKey) throw new Error("Missing RAINDROP_AUTODEBUG_AZURE_API_KEY or AZURE_OPENAI_API_KEY.");
  return { endpoint, apiKey, deployment, apiVersion };
}

let localEnvLoaded = false;

function loadLocalAutoDebugEnv(): void {
  if (localEnvLoaded) return;
  localEnvLoaded = true;
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = unquoteEnvValue(match[2].trim());
    }
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function persistModelAnalysis(args: {
  analysisRunId: string;
  traceRunId: string;
  partIndex: number;
  analysis: ModelAnalysis;
}): number {
  const cases = Array.isArray(args.analysis.failure_cases)
    ? args.analysis.failure_cases
    : [];
  let count = 0;
  for (const item of cases) {
    const title = cleanString(item.title);
    const summary = cleanString(item.summary);
    const occurrence = item.occurrence && typeof item.occurrence === "object"
      ? item.occurrence
      : {};
    const occurrenceSummary = cleanString(occurrence.how_it_occurred) || summary;
    if (!title || !summary || !occurrenceSummary) continue;
    const failureCase = upsertFailureCase({
      existingId: cleanString(item.existing_failure_id),
      title,
      summary,
      severity: normalizeSeverity(item.severity),
      traceRunId: args.traceRunId,
    });
    insertOccurrence({
      analysisRunId: args.analysisRunId,
      failureCaseId: failureCase.id,
      traceRunId: args.traceRunId,
      partIndex: args.partIndex,
      spanId: cleanString(occurrence.span_id) || null,
      summary: occurrenceSummary,
      evidence: cleanString(occurrence.evidence) || cleanString(occurrence.where) || null,
      difference: cleanString(occurrence.difference_from_existing) || null,
      rawJson: JSON.stringify(item),
    });
    count++;
  }
  return count;
}

function upsertFailureCase(args: {
  existingId: string;
  title: string;
  summary: string;
  severity: AutoDebugSeverity;
  traceRunId: string;
}): FailureCaseRow {
  const db = getDrizzleDb();
  const now = Date.now();
  const existing = findExistingFailureCase(args.existingId, args.title);
  if (existing) {
    const severity = maxSeverity(existing.severity as AutoDebugSeverity, args.severity);
    db.update(schema.auto_debug_failure_cases)
      .set({
        title: args.title || existing.title,
        summary: args.summary || existing.summary,
        severity,
        occurrence_count: sql`${schema.auto_debug_failure_cases.occurrence_count} + 1`,
        updated_at: now,
      })
      .where(eq(schema.auto_debug_failure_cases.id, existing.id))
      .run();
    return {
      ...existing,
      title: args.title || existing.title,
      summary: args.summary || existing.summary,
      severity,
      occurrence_count: existing.occurrence_count + 1,
      updated_at: now,
    };
  }

  const row = {
    id: `failure_${randomUUID()}`,
    title: args.title,
    summary: args.summary,
    severity: args.severity,
    status: "open" as const,
    first_seen_run_id: args.traceRunId,
    occurrence_count: 1,
    created_at: now,
    updated_at: now,
  };
  db.insert(schema.auto_debug_failure_cases).values(row).run();
  return row;
}

function findExistingFailureCase(existingId: string, title: string): FailureCaseRow | null {
  const db = getDrizzleDb();
  if (existingId) {
    const row = db
      .select()
      .from(schema.auto_debug_failure_cases)
      .where(eq(schema.auto_debug_failure_cases.id, existingId))
      .limit(1)
      .get() as FailureCaseRow | undefined;
    if (row) return row;
  }
  const normalized = normalizeTitle(title);
  const rows = db
    .select()
    .from(schema.auto_debug_failure_cases)
    .orderBy(desc(schema.auto_debug_failure_cases.updated_at))
    .limit(200)
    .all() as FailureCaseRow[];
  return rows.find((row) => normalizeTitle(row.title) === normalized) ?? null;
}

function insertOccurrence(args: {
  analysisRunId: string;
  failureCaseId: string;
  traceRunId: string;
  partIndex: number;
  spanId: string | null;
  summary: string;
  evidence: string | null;
  difference: string | null;
  rawJson: string;
}): void {
  getDrizzleDb()
    .insert(schema.auto_debug_failure_occurrences)
    .values({
      id: `occurrence_${randomUUID()}`,
      analysis_run_id: args.analysisRunId,
      failure_case_id: args.failureCaseId,
      trace_run_id: args.traceRunId,
      span_id: args.spanId,
      trace_part_index: args.partIndex,
      summary: args.summary,
      evidence: args.evidence,
      difference: args.difference,
      raw_json: args.rawJson,
      created_at: Date.now(),
    })
    .run();
}

function markRunStatus(
  id: string,
  status: AutoDebugRunStatus,
  summary?: string | null,
  error?: string | null,
): void {
  const now = Date.now();
  const patch: Partial<AutoDebugRunRow> = {
    status,
    completed_at: status === "done" || status === "error" || status === "cancelled" ? now : null,
    updated_at: now,
  };
  if (summary !== undefined) patch.summary = summary;
  if (error !== undefined) patch.error = error;
  getDrizzleDb()
    .update(schema.auto_debug_runs)
    .set(patch)
    .where(eq(schema.auto_debug_runs.id, id))
    .run();
}

function updateRunProgress(
  id: string,
  progress: {
    traceCount: number;
    partCount: number;
    occurrenceCount: number;
    currentRunId: string;
  },
): void {
  const summary = `Analyzed ${progress.traceCount} trace(s), ${progress.partCount} part(s), ${progress.occurrenceCount} occurrence(s). Current trace: ${progress.currentRunId}`;
  getDrizzleDb()
    .update(schema.auto_debug_runs)
    .set({ summary, updated_at: Date.now() })
    .where(eq(schema.auto_debug_runs.id, id))
    .run();
}

function compactFailureCases(
  cases: Array<Pick<FailureCaseRow, "id" | "title" | "summary" | "severity" | "occurrence_count">>,
) {
  return cases.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    severity: item.severity,
    occurrence_count: item.occurrence_count,
  }));
}

function normalizeModelAnalysis(value: Record<string, unknown>): ModelAnalysis {
  return {
    trace_verdict: cleanString(value.trace_verdict) || "unclear",
    trace_summary: cleanString(value.trace_summary),
    failure_cases: Array.isArray(value.failure_cases)
      ? value.failure_cases.filter((item): item is ModelFailureCase => !!item && typeof item === "object")
      : [],
    notes: cleanString(value.notes),
  };
}

function parseJsonObjectStrict(text: string): Record<string, unknown> {
  const direct = tryParseJsonObject(text);
  if (direct) return direct;
  const match = text.match(/\{[\s\S]*\}/);
  const extracted = match ? tryParseJsonObject(match[0]) : null;
  if (extracted) return extracted;
  throw new Error(`Provider did not return valid JSON: ${truncate(text, 600)}`);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function providerErrorMessage(status: number, text: string): string {
  const parsed = tryParseJsonObject(text);
  const message = parsed?.error && typeof parsed.error === "object"
    ? cleanString((parsed.error as Record<string, unknown>).message)
    : cleanString(parsed?.message);
  return message || `Auto-debug model request failed with HTTP ${status}: ${truncate(text, 800)}`;
}

function tracePartCharBudget(value: unknown): number {
  const parsed = typeof value === "number" ? value : DEFAULT_TRACE_PART_CHARS;
  return Math.max(8_000, Math.min(MAX_TRACE_PART_CHARS, Math.floor(parsed)));
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function truncate(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function truncateJson(value: unknown, max: number): string {
  return truncate(JSON.stringify(value), max);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseRunIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && !!item)
      : [];
  } catch {
    return [];
  }
}

function normalizeSeverity(value: unknown): AutoDebugSeverity {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

function maxSeverity(left: AutoDebugSeverity, right: AutoDebugSeverity): AutoDebugSeverity {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[right] > rank[left] ? right : left;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
