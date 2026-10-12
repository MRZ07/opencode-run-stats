import { loadFileOptions } from "./options.js";
import { createNativeReporter } from "./native.js";

/** Loaded automatically from this package's ./tui export by OpenCode v2. */
export default {
  id: "opencode-run-stats.tui",
  async setup(ctx) {
    const options = { ...(await loadFileOptions() || {}), ...ctx.options };
    let lastTable;
    let stopped = false;
    let queue = Promise.resolve();
    const reporter = createNativeReporter({ ...options, showLog: false }, {
      location: { ...(ctx.location || ctx.data.location.default()) },
      get: async (sessionID) => (await ctx.client.session.get({ sessionID })).data,
      family: (sessionID) => ctx.data.session.family(sessionID),
      toast: (body) => { if (!stopped) ctx.ui.toast.show(body); },
    });
    const stop = ctx.data.listen(({ details }) => {
      queue = queue.then(async () => {
        if (stopped) return;
        const text = await reporter.handle(details);
        if (text) lastTable = text;
      }).catch(() => {
        if (!stopped) ctx.ui.toast.show({ title: "run stats", message: "Session summary unavailable", variant: "warning" });
      });
    });
    ctx.keymap.layer(() => ({
      commands: [{
        id: "run-stats.show", title: "Show last run costs", palette: true,
        slash: { name: "run-stats" },
        run: () => ctx.ui.dialog.alert({ title: options.title || "run stats", message: lastTable || "No completed task recorded yet." }),
      }],
    }));
    return async () => { stopped = true; stop(); await queue; };
  },
};
