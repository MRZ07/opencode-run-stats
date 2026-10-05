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
export const RunStats = async ({ client }, options) => {
  const fileOptions = await loadFileOptions();
  const tracker = createTracker({ ...(fileOptions || {}), ...(options || {}) }, client);

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") tracker.ingest(info);
      } else if (event.type === "session.created" || event.type === "session.updated") {
        tracker.ingestSession(event.properties.info);
      } else if (event.type === "session.idle") {
        await tracker.emit(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        tracker.forget(event.properties.info.id);
      }
    },
  };
};

export default RunStats;
