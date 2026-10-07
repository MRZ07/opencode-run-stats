/**
 * opencode-run-stats — plugin entry.
 *
 * Prints a session's token/cost/time summary when a run ends (session.idle).
 * Computed from opencode events; never asks the model.
 *
 * Only this plugin function is exported: opencode registers every exported
 * function in a plugin file as a plugin, so helper logic lives in ./lib.js.
 */
import { createTracker } from "./tracker.js";
import { reportPathsFromTool, updateDeepReviewReport } from "./deep-review.js";
import { projectKey } from "./accounting.js";
let z;
try { ({ z } = await import("zod")); } catch { z = null; }
const toolArgs = z ? {
  scope: z.enum(["run", "session"]).optional(),
  sessionID: z.string().min(1).max(256).optional(),
} : {};
if (z) for (const [key, schema] of Object.entries(toolArgs)) schema.describe(key === "scope" ? "Report scope; default run" : "A known session ID in this project");

/** Optional config file for local installs, where the plugin tuple can't pass options. */
async function loadFileOptions() {
  try {
    const fs = await import("node:fs/promises");
    const p =
      process.env.OPENCODE_RUN_STATS_CONFIG ||
      (process.env.HOME ? `${process.env.HOME}/.config/opencode/run-stats.json` : null);
    if (!p) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const RunStats = async ({ client, directory }, options) => {
  const fileOptions = await loadFileOptions();
  const mergedOptions = { ...(fileOptions || {}), ...(options || {}) };
  const projectDirectory = directory?.worktree || directory?.project || directory || process.cwd();
  const tracker = createTracker(mergedOptions, client, mergedOptions.now || (() => Date.now()), projectDirectory);
  const reportPaths = new Map();
  const command = {
    description: "Show current OpenCode run or session usage",
    template: "Use the run_stats tool to report current usage. Default scope is run. If the user asks for session scope, pass scope=session.",
  };

  return {
    config: async (input) => {
      const configured = input.command || {};
      if (!Object.hasOwn(configured, "run-stats")) configured["run-stats"] = command;
      input.command = configured;
    },
    tool: {
      run_stats: {
        description: "Report current run or session cost and token usage; pricing may be unavailable. Does not call a model.",
        args: toolArgs,
        async execute(args, context) {
          const requested = args?.sessionID;
          if (requested != null && (typeof requested !== "string" || requested.length === 0 || requested.length > 256)) throw new Error("run-stats: sessionID must be a non-empty string up to 256 characters");
          if (requested) {
            const currentResult = await client.session?.get?.({ path: { id: context.sessionID } });
            const targetResult = await client.session?.get?.({ path: { id: requested } });
            const validResponse = (response, id) => response && !response.error && response.data?.id === id &&
              typeof (response.data.projectID || response.data.directory) === "string";
            if (!validResponse(currentResult, context.sessionID) || !validResponse(targetResult, requested)) throw new Error("run-stats: selector requires successful session metadata with project identity");
            const currentProject = currentResult.data.projectID || currentResult.data.directory;
            const targetProject = targetResult.data.projectID || targetResult.data.directory;
            if (currentProject !== targetProject) throw new Error("run-stats: selected session belongs to another OpenCode project");
          }
          await tracker.ready;
          await tracker.refresh();
          await tracker.refreshGuardConfig();
          const reportSession = requested || context.sessionID;
          const result = await tracker.report(reportSession, args?.scope || "run");
          return JSON.stringify(result, null, 2);
        },
      },
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") await tracker.ingest(info);
      } else if (event.type === "session.created" || event.type === "session.updated") {
        await tracker.ingestSession(event.properties.info);
      } else if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        const idleAt = Date.now();
        await tracker.refresh();
        await tracker.emit(sessionID);
        const paths = reportPaths.get(sessionID);
        reportPaths.delete(sessionID); // one idle window per trusted report-write binding
        for (const filePath of paths || []) {
          await updateDeepReviewReport({ client, rootId: sessionID, filePath, idleAt });
        }
      } else if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        await tracker.forget(sessionID);
        reportPaths.delete(sessionID);
      }
    },
    "tool.execute.after": async ({ tool, sessionID, args }, output) => {
      const paths = reportPathsFromTool(tool, args, output);
      if (!paths.length || !sessionID) return;
      const current = reportPaths.get(sessionID) || new Set();
      for (const filePath of paths) current.add(filePath);
      reportPaths.set(sessionID, current);
    },
  };
};

export default RunStats;
