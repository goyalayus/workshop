import type { Express } from "express";
import {
  cancelAutoDebugAnalysis,
  getAutoDebugRun,
  listAutoDebugRuns,
  listFailureCases,
  startAutoDebugAnalysis,
} from "./auto-debug";

export function registerAutoDebugRoutes(app: Express): void {
  app.get("/api/auto-debug/runs", (req, res) => {
    const limit = Number(req.query.limit);
    res.json({
      runs: listAutoDebugRuns(Number.isFinite(limit) ? limit : 50),
    });
  });

  app.get("/api/auto-debug/runs/:id", (req, res) => {
    const run = getAutoDebugRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Auto-debug run not found" });
      return;
    }
    res.json(run);
  });

  app.post("/api/auto-debug/runs", (req, res) => {
    const body = req.body && typeof req.body === "object"
      ? req.body as Record<string, unknown>
      : {};
    const runIds = Array.isArray(body.run_ids)
      ? body.run_ids.filter((item): item is string => typeof item === "string")
      : Array.isArray(body.runIds)
        ? body.runIds.filter((item): item is string => typeof item === "string")
        : undefined;

    try {
      const run = startAutoDebugAnalysis({
        runIds,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        architectureContext: typeof body.architecture_context === "string"
          ? body.architecture_context
          : typeof body.architectureContext === "string"
            ? body.architectureContext
            : undefined,
        maxTracePartChars: typeof body.max_trace_part_chars === "number"
          ? body.max_trace_part_chars
          : undefined,
      });
      res.json({ run });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/auto-debug/runs/:id/cancel", (req, res) => {
    res.json({ cancelled: cancelAutoDebugAnalysis(req.params.id) });
  });

  app.get("/api/auto-debug/failure-cases", (req, res) => {
    const limit = Number(req.query.limit);
    res.json({
      failure_cases: listFailureCases(Number.isFinite(limit) ? limit : 100),
    });
  });
}
