import { createTracker } from "./tracker.js";
import { resolve } from "node:path";

const terminal = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

/** Shared native reporter. Session totals are the sole usage source. */
export function createNativeReporter(options, host) {
  let unavailable = 0;
  const annotate = (body) => unavailable ? {
    ...body, message: `Usage incomplete: ${unavailable} session(s) unavailable\n${body.message}`,
    ...(body.extra ? { extra: { ...body.extra, incomplete: true } } : {}),
  } : body;
  const tracker = createTracker(options, {
    app: { log: async ({ body }) => host.log?.(annotate(body)) },
    tui: { showToast: async ({ body }) => host.toast?.(annotate(body)) },
  });
  const known = new Set();
  const completed = new Set();
  const settled = new Set();
  const belongs = (info) => info?.id && info.location?.directory &&
    resolve(info.location.directory) === resolve(host.location.directory) &&
    (!host.location.project?.id || info.projectID === host.location.project.id);
  const load = async (id) => {
    const info = await host.get(id);
    if (!belongs(info)) return null;
    known.add(id);
    tracker.ingestSnapshot(info);
    return info;
  };
  const handle = async (event) => {
    let id = event.data?.sessionID;
    if (!id) return;
    if (event.location?.directory && resolve(event.location.directory) !== resolve(host.location.directory)) return;
    if (event.type === "session.deleted") { known.delete(id); settled.delete(id); tracker.forget(id); return; }
    if (!event.type.startsWith("session.")) return;
    known.add(id);
    if (event.type === "session.execution.started") settled.delete(id);
    const correction = event.type === "session.usage.updated" && settled.has(id);
    if (!terminal.has(event.type) && !correction) return;
    if (event.id && completed.has(event.id)) return;
    unavailable = 0;
    let info = await load(id);
    if (!info) return;
    settled.add(id);
    if (tracker._cfg.rollup && info.parentID) {
      if (!correction) return;
      const seen = new Set([id]);
      while (info.parentID) {
        id = info.parentID;
        if (seen.has(id) || !settled.has(id)) return;
        seen.add(id);
        info = await load(id);
        if (!info) return;
      }
    }
    // TUI family discovery also covers helpers created before plugin startup.
    for (const member of host.family?.(id) || []) known.add(member);
    const candidates = (host.family ? host.family(id) : [...known]).filter(member => member !== id);
    for (const member of candidates) {
      try { await load(member); } catch { unavailable++; tracker.forget(member); }
    }
    const text = await tracker.emit(id, { force: !correction });
    if (event.id) {
      completed.add(event.id);
      if (completed.size > 1024) completed.delete(completed.values().next().value);
    }
    return text && unavailable ? `Usage incomplete: ${unavailable} session(s) unavailable\n${text}` : text;
  };
  return { handle };
}
