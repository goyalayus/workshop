import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bug, Loader2, Play, Square, WandSparkles } from "lucide-react";
import {
  cancelAutoDebugRun,
  listAutoDebugFailures,
  listAutoDebugRuns,
  startAutoDebugRun,
  type AutoDebugFailureCase,
  type AutoDebugRun,
} from "../api/auto-debug";
import { C } from "../utils/colors";
import { runPath } from "../utils/navigation";

const DEFAULT_MODEL = "DeepSeek-V4-Pro";

function statusColor(status: AutoDebugRun["status"]): string {
  if (status === "done") return C.green;
  if (status === "error" || status === "cancelled") return C.red;
  if (status === "running") return C.accent;
  return C.fg1;
}

function severityColor(severity: AutoDebugFailureCase["severity"]): string {
  if (severity === "high") return C.red;
  if (severity === "medium") return C.orange;
  return C.cyan;
}

function parseRunIds(value: string): string[] {
  return value
    .split(/[\n, ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

export function AutoDebugPage() {
  const [runs, setRuns] = useState<AutoDebugRun[]>([]);
  const [failures, setFailures] = useState<AutoDebugFailureCase[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [limit, setLimit] = useState(10);
  const [runIdsText, setRunIdsText] = useState("");
  const [architectureContext, setArchitectureContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = useMemo(
    () => runs.find((run) => run.status === "queued" || run.status === "running") ?? null,
    [runs],
  );

  const refresh = useCallback(async () => {
    const [nextRuns, nextFailures] = await Promise.all([
      listAutoDebugRuns(),
      listAutoDebugFailures(),
    ]);
    setRuns(nextRuns);
    setFailures(nextFailures);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  useEffect(() => {
    if (!activeRun) return;
    const interval = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 1800);
    return () => window.clearInterval(interval);
  }, [activeRun, refresh]);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const runIds = parseRunIds(runIdsText);
      await startAutoDebugRun({
        model: model.trim() || DEFAULT_MODEL,
        limit: runIds.length ? undefined : limit,
        runIds: runIds.length ? runIds : undefined,
        architectureContext,
      });
      setRunIdsText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const cancel = async (id: string) => {
    setError(null);
    try {
      await cancelAutoDebugRun(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="min-h-screen px-8 py-7" style={{ background: C.bg, color: C.fg4 }}>
      <div className="mx-auto flex max-w-[1380px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: C.accent }}>
              <WandSparkles className="size-3.5" />
              Auto Debugging
            </div>
            <h1 className="mt-2 text-[30px] font-semibold tracking-tight text-white">Failure Case Miner</h1>
            <p className="mt-2 max-w-[760px] text-[14px] leading-6" style={{ color: C.fg1 }}>
              Sequentially inspect traces, persist reusable failure cases, and let later traces reuse or refine earlier findings.
            </p>
          </div>
          <button
            className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: C.borderLight, background: "rgba(255,255,255,0.04)", color: C.fg4 }}
            disabled={loading || !!activeRun}
            onClick={start}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run Sequential Batch
          </button>
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]" style={{ borderColor: "rgba(235,20,20,0.35)", background: "rgba(235,20,20,0.08)", color: C.fg4 }}>
            <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: C.red }} />
            <span>{error}</span>
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[420px_1fr]">
          <div className="rounded-lg border p-4" style={{ borderColor: C.borderLight, background: C.surface }}>
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: C.fg2 }}>Run contract</div>
            <label className="mt-4 block text-[12px]" style={{ color: C.fg2 }}>
              Model
              <input
                className="mt-1 h-10 w-full rounded-md border bg-black px-3 text-[13px] outline-none"
                style={{ borderColor: C.borderLight, color: C.fg4 }}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label className="mt-3 block text-[12px]" style={{ color: C.fg2 }}>
              Recent trace limit
              <input
                className="mt-1 h-10 w-full rounded-md border bg-black px-3 text-[13px] outline-none"
                style={{ borderColor: C.borderLight, color: C.fg4 }}
                type="number"
                min={1}
                max={20}
                value={limit}
                onChange={(event) => setLimit(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
              />
            </label>
            <label className="mt-3 block text-[12px]" style={{ color: C.fg2 }}>
              Exact run IDs
              <textarea
                className="mt-1 min-h-[92px] w-full resize-y rounded-md border bg-black px-3 py-2 font-mono text-[12px] outline-none"
                style={{ borderColor: C.borderLight, color: C.fg4 }}
                placeholder="Optional. Paste one or more run ids."
                value={runIdsText}
                onChange={(event) => setRunIdsText(event.target.value)}
              />
            </label>
            <label className="mt-3 block text-[12px]" style={{ color: C.fg2 }}>
              Agent architecture context
              <textarea
                className="mt-1 min-h-[140px] w-full resize-y rounded-md border bg-black px-3 py-2 text-[12px] leading-5 outline-none"
                style={{ borderColor: C.borderLight, color: C.fg4 }}
                placeholder="Optional. Paste the architecture doc or current design notes for the agent being debugged."
                value={architectureContext}
                onChange={(event) => setArchitectureContext(event.target.value)}
              />
            </label>
            <div className="mt-3 text-[11px] leading-5" style={{ color: C.fg1 }}>
              Runs are capped at 20 traces. Trace parts are analyzed sequentially, and each part sees the current failure-case catalog.
            </div>
          </div>

          <div className="rounded-lg border" style={{ borderColor: C.borderLight, background: C.surface }}>
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: C.border }}>
              <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: C.fg2 }}>Analysis runs</div>
              <button className="text-[12px]" style={{ color: C.accent }} onClick={() => void refresh()}>Refresh</button>
            </div>
            <div className="divide-y" style={{ borderColor: C.border }}>
              {runs.length === 0 ? (
                <div className="px-4 py-8 text-[13px]" style={{ color: C.fg1 }}>No auto-debugging runs yet.</div>
              ) : runs.slice(0, 8).map((run) => (
                <div key={run.id} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-white">{run.id}</span>
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ color: statusColor(run.status), background: "rgba(255,255,255,0.06)" }}>
                        {run.status}
                      </span>
                      <span className="text-[11px]" style={{ color: C.fg1 }}>{run.model}</span>
                    </div>
                    <div className="mt-1 text-[12px]" style={{ color: C.fg2 }}>{run.summary || "Waiting for progress..."}</div>
                    {run.error && <div className="mt-1 text-[12px]" style={{ color: C.red }}>{run.error}</div>}
                    <div className="mt-1 text-[11px]" style={{ color: C.fg0 }}>{formatDate(run.updated_at)}</div>
                  </div>
                  {(run.status === "queued" || run.status === "running") && (
                    <button className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px]" style={{ borderColor: C.borderLight, color: C.fg3 }} onClick={() => void cancel(run.id)}>
                      <Square className="size-3" />
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-lg border" style={{ borderColor: C.borderLight, background: C.surface }}>
          <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: C.border }}>
            <Bug className="size-4" style={{ color: C.orange }} />
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: C.fg2 }}>Failure cases</div>
          </div>
          {failures.length === 0 ? (
            <div className="px-4 py-10 text-[13px]" style={{ color: C.fg1 }}>No failure cases recorded yet.</div>
          ) : (
            <div className="grid gap-3 p-4 xl:grid-cols-2">
              {failures.map((failure) => (
                <article key={failure.id} className="rounded-md border p-4" style={{ borderColor: C.border, background: "rgba(255,255,255,0.025)" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-[11px]" style={{ color: C.fg0 }}>{failure.id}</div>
                      <h2 className="mt-1 text-[15px] font-semibold text-white">{failure.title}</h2>
                    </div>
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ color: severityColor(failure.severity), background: "rgba(255,255,255,0.06)" }}>
                      {failure.severity}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-6" style={{ color: C.fg2 }}>{failure.summary}</p>
                  <div className="mt-3 text-[11px]" style={{ color: C.fg1 }}>
                    {failure.occurrence_count} occurrence{failure.occurrence_count === 1 ? "" : "s"}
                  </div>
                  <div className="mt-3 space-y-2">
                    {failure.recent_occurrences.map((occurrence) => (
                      <div key={occurrence.id} className="rounded border px-3 py-2 text-[12px]" style={{ borderColor: C.border, background: "rgba(0,0,0,0.25)" }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <a href={runPath(occurrence.trace_run_id)} className="font-mono" style={{ color: C.accent }}>
                            {occurrence.trace_run_id.slice(0, 18)}
                          </a>
                          {occurrence.span_id && <span className="font-mono" style={{ color: C.fg0 }}>span {occurrence.span_id.slice(0, 12)}</span>}
                        </div>
                        <div className="mt-1 leading-5" style={{ color: C.fg2 }}>{occurrence.summary}</div>
                        {occurrence.evidence && <div className="mt-1 leading-5" style={{ color: C.fg1 }}>{occurrence.evidence}</div>}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
