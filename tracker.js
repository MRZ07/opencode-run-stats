/**
 * opencode-run-stats — stateful tracker.
 *
 * Aggregates assistant-message tokens/cost per session and, when a run goes
 * idle, emits a summary. With `rollup` (default) only the root session emits,
 * summing the whole session tree (parent + spawned subagents) into a table
 * labelled by agent (message mode) and session title.
 */
import { summarize, summarizeMany, formatLine, formatTable, normalizeOptions } from "./lib.js";

export function createTracker(options, client) {
  const cfg = normalizeOptions(options);
  /** @type {Map<string, {messages: Map<string,{cost:number,tokens:any,mode?:string}>, first?:number, last?:number, models:Set<string>, modes:Map<string,number>, printedKey:?string}>} */
  const sessions = new Map();
  const parents = new Map();
  const titles = new Map();

  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map(), first: undefined, last: undefined, models: new Set(), modes: new Map(), printedKey: null };
      sessions.set(id, s);
    }
    return s;
  };

  const ingestSession = (info) => {
    if (!info || !info.id) return;
    parents.set(info.id, info.parentID ?? null);
    if (info.title) titles.set(info.id, info.title);
  };

  const ingest = (info) => {
    const s = get(info.sessionID);
    s.messages.set(info.id, {
      cost: typeof info.cost === "number" ? info.cost : 0,
      tokens: info.tokens || null,
      mode: info.mode || null,
    });
    if (info.mode) s.modes.set(info.mode, (s.modes.get(info.mode) || 0) + 1);
    if (info.providerID && info.modelID) s.models.add(`${info.providerID}/${info.modelID}`);
    const created = info.time && info.time.created;
    if (created != null) {
      s.first = s.first == null ? created : Math.min(s.first, created);
      s.last = s.last == null ? created : Math.max(s.last, created);
    }
  };

  const treeOf = (root) => {
    const out = [root];
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (const [id, pid] of parents) {
        if (pid === cur) {
          out.push(id);
          stack.push(id);
        }
      }
    }
    return out;
  };

  const depthOf = (id) => {
    let d = 0;
    let cur = parents.get(id);
    while (cur != null && d < 50) {
      d++;
      cur = parents.get(cur);
    }
    return d;
  };

  const agentOf = (id) => {
    const s = sessions.get(id);
    if (!s || s.modes.size === 0) return "?";
    let best = "?";
    let n = -1;
    for (const [m, c] of s.modes) if (c > n) ((n = c), (best = m));
    return best;
  };

  const rowFor = (id) => ({
    agent: agentOf(id),
    title: titles.get(id) || "",
    depth: depthOf(id),
    ...summarize(sessions.get(id)),
  });

  const emit = async (sessionID) => {
    const isSubagent = parents.get(sessionID) != null;
    if (cfg.rollup && isSubagent) return null;

    const ids = cfg.rollup ? treeOf(sessionID) : [sessionID];
    const present = ids.filter((id) => sessions.get(id) && sessions.get(id).messages.size);
    const total = summarizeMany(present.map((id) => sessions.get(id)));

    if (total.turns === 0) return null;
    if (total.cost === 0 && total.input === 0 && total.output === 0) return null;
    if (total.cost < cfg.minCost) return null;

    const key = [total.turns, total.cost, total.input, total.output, total.cacheRead, total.cacheWrite, total.ms].join("|");
    const root = get(sessionID);
    if (root.printedKey === key) return null;
    root.printedKey = key;

    const text =
      cfg.format === "table"
        ? formatTable(present.map(rowFor), { includeReasoning: cfg.includeReasoning, maxTitle: cfg.maxTitle, total })
        : formatLine({ ...total, includeReasoning: cfg.includeReasoning });

    if (cfg.showLog) {
      try {
        await client.app.log({ body: { service: "run-stats", level: "info", message: text, extra: total } });
      } catch {
        /* logging must never break the session */
      }
    }
    if (cfg.showToast) {
      try {
        await client.tui.showToast({
          body: { title: cfg.title, message: text, variant: "info", duration: cfg.toastDuration },
        });
      } catch {
        /* toast is best-effort */
      }
    }
    return text;
  };

  const forget = (id) => {
    sessions.delete(id);
    parents.delete(id);
    titles.delete(id);
  };

  return { ingest, ingestSession, emit, forget, _sessions: sessions, _cfg: cfg };
}
