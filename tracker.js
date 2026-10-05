/**
 * opencode-run-stats — stateful tracker.
 *
 * Aggregates assistant-message tokens/cost per session and, when a run goes
 * idle, emits a one-line summary. Kept separate from index.js so the plugin
 * file exports only the plugin function.
 */
import { summarize, formatLine, normalizeOptions } from "./lib.js";

export function createTracker(options, client) {
  const cfg = normalizeOptions(options);
  /** @type {Map<string, {messages: Map<string,{cost:number,tokens:any}>, first?:number, last?:number, models:Set<string>, printedKey:?string}>} */
  const sessions = new Map();

  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map(), first: undefined, last: undefined, models: new Set(), printedKey: null };
      sessions.set(id, s);
    }
    return s;
  };

  const ingest = (info) => {
    const s = get(info.sessionID);
    s.messages.set(info.id, {
      cost: typeof info.cost === "number" ? info.cost : 0,
      tokens: info.tokens || null,
    });
    if (info.providerID && info.modelID) s.models.add(`${info.providerID}/${info.modelID}`);
    const created = info.time && info.time.created;
    if (created != null) {
      s.first = s.first == null ? created : Math.min(s.first, created);
      s.last = s.last == null ? created : Math.max(s.last, created);
    }
  };

  const emit = async (sessionID) => {
    const s = sessions.get(sessionID);
    if (!s) return null;
    const sum = summarize(s);
    if (sum.turns === 0) return null;
    if (sum.cost === 0 && sum.input === 0 && sum.output === 0) return null;
    if (sum.cost < cfg.minCost) return null;

    const key = [sum.turns, sum.cost, sum.input, sum.output, sum.cacheRead, sum.cacheWrite, sum.ms].join("|");
    if (s.printedKey === key) return null;
    s.printedKey = key;

    const line = formatLine({ ...sum, includeReasoning: cfg.includeReasoning });

    if (cfg.showLog) {
      try {
        await client.app.log({ body: { service: "run-stats", level: "info", message: line, extra: sum } });
      } catch {
        /* logging must never break the session */
      }
    }
    if (cfg.showToast) {
      try {
        await client.tui.showToast({
          body: { title: cfg.title, message: line, variant: "info", duration: cfg.toastDuration },
        });
      } catch {
        /* toast is best-effort */
      }
    }
    return line;
  };

  const forget = (id) => sessions.delete(id);

  return { ingest, emit, forget, _sessions: sessions, _cfg: cfg };
}
