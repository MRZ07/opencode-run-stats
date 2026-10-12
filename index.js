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

import { loadFileOptions } from "./options.js";
import { createNativeReporter } from "./native.js";

/** @type {import("@opencode-ai/plugin").Plugin} */
const RunStats = async ({ client }, options) => {
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

export default {
  id: "opencode-run-stats",
  server: RunStats,
  async setup(ctx) {
    const options = { ...(await loadFileOptions() || {}), ...ctx.options };
    const reporter = createNativeReporter(options, {
      location: ctx.location,
      get: (sessionID) => ctx.session.get({ sessionID }),
      log: (body) => console.info(JSON.stringify({ service: "run-stats", ...body })),
    });
    const controller = new AbortController();
    const consumer = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try { await reporter.handle(event); }
        catch { console.error("run-stats: session summary unavailable"); }
      }
    })().catch(() => {
      if (!controller.signal.aborted) console.error("run-stats: event subscription ended unexpectedly");
    });
    return async () => { controller.abort(); await consumer; };
  },
};
