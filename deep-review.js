/**
 * Narrow post-idle cost backfill for standalone Deep Review v3 reports.
 * The caller supplies only paths observed in this root session's write hooks.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

const MESSAGE_LIMIT = 500;
const HELPER_LIMIT = 32;
const SESSION_ID = /\bses_[A-Za-z0-9]+\b/g;
const safeSessionId = (value) => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value);

function unwrap(result) {
  if (result?.error) throw new Error("OpenCode session query failed");
  return result && Object.hasOwn(result, "data") ? result.data : result;
}

function unique(values) {
  return [...new Set(values)];
}

function parseReport(text) {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const reports = [];
  for (const match of matches) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.report_version === 3 && value.workflow === "deep-review") {
        reports.push({ match, value });
      }
    } catch {
      // Ignore unrelated or incomplete fenced examples.
    }
  }
  return reports.length === 1 ? reports[0] : null;
}

function declaredHelpers(text, report) {
  const field = report.review?.helper_session_ids;
  if (Array.isArray(field)) {
    if (field.some((id) => !safeSessionId(id))) return null;
    return unique(field);
  }
  // Compatibility with existing v3 reports that declare helpers in Run State.
  const heading = /^## Run State\s*$/m.exec(text);
  if (!heading) return null;
  const bodyStart = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(text.slice(bodyStart));
  const runState = text.slice(bodyStart, nextHeading ? bodyStart + nextHeading.index : text.length);
  const lines = runState.split("\n").filter((line) => /^- (?:Explorer|Ops) task IDs:/.test(line));
  if (!lines.length) return null;
  return unique(lines.flatMap((line) => [...line.matchAll(SESSION_ID)].map((m) => m[0])));
}

function runStateIsDone(text) {
  const heading = /^## Run State\s*$/m.exec(text);
  if (!heading) return false;
  const bodyStart = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(text.slice(bodyStart));
  const runState = text.slice(bodyStart, nextHeading ? bodyStart + nextHeading.index : text.length);
  const match = /^- Phase: ([^\r\n]+)$/m.exec(runState);
  return match?.[1].trim() === "Done";
}

function jsonCostReplacement(block, cost) {
  const source = block[1];
  const parsed = JSON.parse(source);
  if (!parsed.cost || typeof parsed.cost !== "object") return null;
  let open = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      const start = i;
      let j = i + 1;
      let quoteEscaped = false;
      for (; j < source.length; j++) {
        if (quoteEscaped) quoteEscaped = false;
        else if (source[j] === "\\") quoteEscaped = true;
        else if (source[j] === '"') break;
      }
      if (j >= source.length) return null;
      if (depth === 1 && JSON.parse(source.slice(start, j + 1)) === "cost") {
        let k = j + 1;
        while (/\s/.test(source[k] || "")) k++;
        if (source[k++] !== ":") return null;
        while (/\s/.test(source[k] || "")) k++;
        if (source[k] !== "{") return null;
        open = k;
        break;
      }
      i = j;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (open < 0) return null;
  depth = 0;
  inString = false;
  escaped = false;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const replacement = JSON.stringify(cost, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
  return source.slice(0, open) + replacement + source.slice(close + 1);
}

function formatRunCosts(total, sessionIds, completeThrough) {
  const usd = total.usd.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return [
    "## Run Costs",
    `Nominal total: **$${usd}** across ${sessionIds.length} verified session${sessionIds.length === 1 ? "" : "s"}. Input: ${total.input.toLocaleString("en-US")}; output: ${total.output.toLocaleString("en-US")}; reasoning: ${total.reasoning.toLocaleString("en-US")}; cache-read: ${total.cacheRead.toLocaleString("en-US")}; cache-write: ${total.cacheWrite.toLocaleString("en-US")}. Includes final assistant messages through session idle at ${completeThrough}. Nominal model telemetry, not billed subscription spend.`,
  ].join("\n");
}

function replaceRunCostsSection(text, replacement) {
  const heading = /^## Run Costs\s*$/m.exec(text);
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const rest = text.slice(bodyStart);
    const nextHeading = /^## /m.exec(rest);
    const footer = parseReport(text)?.match;
    const boundaries = [nextHeading ? bodyStart + nextHeading.index : null, footer && footer.index >= bodyStart ? footer.index : null]
      .filter((index) => index != null);
    const end = boundaries.length ? Math.min(...boundaries) : text.length;
    return `${text.slice(0, heading.index)}${replacement}\n\n${text.slice(end).replace(/^\n+/, "")}`;
  }
  const jsonFence = /```json\s*\n[\s\S]*?\n```/;
  const match = jsonFence.exec(text);
  if (!match) return null;
  return `${text.slice(0, match.index)}${replacement}\n\n${text.slice(match.index)}`;
}

function usage(info) {
  const tokenFields = [info?.tokens?.input, info?.tokens?.output, info?.tokens?.reasoning,
    info?.tokens?.cache?.read, info?.tokens?.cache?.write];
  if (typeof info?.cost !== "number" || !Number.isFinite(info.cost) || info.cost < 0 ||
      tokenFields.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  return { cost: info.cost, input: tokenFields[0], output: tokenFields[1], reasoning: tokenFields[2], cacheRead: tokenFields[3], cacheWrite: tokenFields[4] };
}

async function sessionInfo(client, id) {
  if (typeof client?.session?.get !== "function") throw new Error("session.get unavailable");
  return unwrap(await client.session.get({ path: { id } }));
}

async function messagesFor(client, id) {
  if (typeof client?.session?.messages !== "function") throw new Error("session.messages unavailable");
  const data = unwrap(await client.session.messages({ path: { id }, query: { limit: MESSAGE_LIMIT } }));
  if (!Array.isArray(data) || data.length >= MESSAGE_LIMIT) throw new Error("message history incomplete");
  return data.filter((entry) => entry?.info);
}

async function verifyChild(client, helperId, rootId) {
  const visited = new Set();
  let id = helperId;
  for (let depth = 0; depth < 10 && id && !visited.has(id); depth++) {
    if (id === rootId) return true;
    visited.add(id);
    const info = await sessionInfo(client, id);
    if (!info || info.id !== id) return false;
    id = info.parentID;
  }
  return false;
}

async function safeReportPath(filePath, home) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  const base = path.join(home, "reports", "deep-review");
  const normalized = path.resolve(filePath);
  const relative = path.relative(base, normalized);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  if (!/\.md$/.test(normalized) || /(?:\.partial|\.tmp)(?:\.|$)/i.test(path.basename(normalized))) return null;
  try {
    const resolvedBase = await fs.realpath(base);
    const resolvedFile = await fs.realpath(normalized);
    if (resolvedBase !== base || resolvedFile !== normalized) return null;
    const stat = await fs.lstat(normalized);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return normalized;
}

async function atomicReplace(filePath, content, mode) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

/** Extract only explicit file-target fields and apply_patch update headers. */
export function reportPathsFromTool(tool, args, output) {
  if (!/^(?:edit|write|apply_patch)$/.test(String(tool || "")) || !args || typeof args !== "object") return [];
  const paths = [];
  for (const key of ["filePath", "path", "targetPath"]) {
    if (typeof args[key] === "string") paths.push(args[key]);
  }
  for (const key of ["patch", "input", "patchText"]) {
    if (typeof args[key] === "string") {
      for (const match of args[key].matchAll(/^\*\*\* (?:Update|Add) File: ([^\r\n]+)$/gm)) paths.push(match[1]);
    }
  }
  const files = output?.metadata?.files;
  if (Array.isArray(files)) {
    for (const item of files) {
      if (typeof item === "string") paths.push(item);
      else if (typeof item?.path === "string") paths.push(item.path);
      else if (typeof item?.filePath === "string") paths.push(item.filePath);
    }
  }
  return unique(paths.filter((value) => path.isAbsolute(value)));
}

/** Update one explicitly associated pending v3 report, returning a small status. */
export async function updateDeepReviewReport({ client, rootId, filePath, idleAt = Date.now(), home = os.homedir() }) {
  const target = await safeReportPath(filePath, home);
  if (!target || !safeSessionId(rootId)) return "ineligible";
  let handle;
  try {
    const root = await sessionInfo(client, rootId);
    if (!root || root.id !== rootId || root.parentID) return "ineligible";
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fileStat = await handle.stat();
    const original = await handle.readFile("utf8");
    const parsed = parseReport(original);
    if (!parsed) return "ineligible";
    const { value: report, match } = parsed;
    if (!runStateIsDone(original)) return "pending";
    const pending = report.cost?.source === "pending" && Array.isArray(report.cost.session_ids) && report.cost.session_ids.length === 0;
    const snapshot = report.cost?.source === "fusion-ops-db" && Array.isArray(report.cost.session_ids);
    if (!pending && !snapshot) return "preserved";
    const startedAt = Date.parse(report.started_at);
    if (!Number.isFinite(startedAt)) return "pending";
    const helpers = declaredHelpers(original, report);
    if (!helpers || helpers.includes(rootId) || helpers.length > HELPER_LIMIT || helpers.some((id) => !safeSessionId(id))) return "pending";
    for (const helperId of helpers) if (!(await verifyChild(client, helperId, rootId))) return "pending";

    const sessionIds = [rootId, ...helpers];
    const histories = await Promise.all(sessionIds.map((id) => messagesFor(client, id)));
    const rootMessages = histories[0].map((entry) => entry.info);
    const anchor = rootMessages
      .filter((message) => message.role === "user" && Number.isFinite(message.time?.created) && message.time.created <= startedAt)
      .sort((a, b) => b.time.created - a.time.created)[0];
    if (!anchor) return "pending";
    const upper = Number.isFinite(idleAt) ? idleAt : Date.now();
    const latestRootAssistant = rootMessages
      .filter((message) => message.role === "assistant" && Number.isFinite(message.time?.created) && message.time.created >= anchor.time.created && message.time.created <= upper)
      .sort((a, b) => b.time.created - a.time.created)[0];
    if (!latestRootAssistant || (latestRootAssistant.mode || latestRootAssistant.agent) !== "deep-review") return "pending";
    const taskSessionIds = new Set();
    for (const entry of histories[0]) {
      const message = entry.info;
      const created = message.time?.created;
      if (message.role !== "assistant" || !Number.isFinite(created) || created < anchor.time.created || created > upper) continue;
      if (!Array.isArray(entry.parts)) return "pending";
      for (const part of entry.parts) {
        if (part?.type !== "tool") continue;
        if (part.tool !== "task") continue;
        const metadata = part.state?.metadata;
        if (metadata?.sessionId == null && part.state?.status === "completed") return "pending";
        if (metadata?.parentSessionId !== rootId || metadata.sessionId == null) continue;
        if (part.state?.status !== "completed") return "pending";
        if (!safeSessionId(metadata.sessionId)) return "pending";
        taskSessionIds.add(metadata.sessionId);
      }
    }
    if (taskSessionIds.size !== helpers.length || helpers.some((id) => !taskSessionIds.has(id))) return "pending";
    const uniqueMessages = new Map();
    const rootModels = new Set();
    for (let i = 0; i < histories.length; i++) {
      let scopedAssistantCount = 0;
      for (const entry of histories[i]) {
        const message = entry.info;
        if (message.role !== "assistant") continue;
        const created = message.time?.created;
        if (!Number.isFinite(created)) return "pending";
        if (created < anchor.time.created || created > upper) continue;
        if (typeof message.id !== "string" || !message.id || message.sessionID !== sessionIds[i]) return "pending";
        if (i === 0) {
          if (!Array.isArray(entry.parts)) return "pending";
          if (message.providerID && message.modelID) rootModels.add(`${message.providerID}/${message.modelID}`);
        }
        scopedAssistantCount++;
        const key = `${sessionIds[i]}:${message.id}`;
        uniqueMessages.set(key, message);
      }
      if (scopedAssistantCount === 0) return "pending";
    }
    if (snapshot && (report.cost.session_ids.length !== sessionIds.length || sessionIds.some((id) => !report.cost.session_ids.includes(id)))) return "pending";
    if (!uniqueMessages.size) return "pending";
    const total = { usd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const message of uniqueMessages.values()) {
      const value = usage(message);
      if (!value) return "pending";
      total.usd += value.cost;
      total.input += value.input;
      total.output += value.output;
      total.reasoning += value.reasoning;
      total.cacheRead += value.cacheRead;
      total.cacheWrite += value.cacheWrite;
    }
    total.usd = Math.round(total.usd * 1e12) / 1e12;
    const cutoff = new Date(upper).toISOString();
    const cost = {
      model_lead: [...rootModels].join(", ") || report.cost.model_lead || null,
      usd: total.usd,
      tokens_input: total.input,
      tokens_output: total.output,
      tokens_reasoning: total.reasoning,
      tokens_cache_read: total.cacheRead,
      tokens_cache_write: total.cacheWrite,
      session_ids: sessionIds,
      source: "opencode-run-stats",
      complete_through: cutoff,
      complete: true,
    };
    const costJson = jsonCostReplacement(match, cost);
    if (costJson == null) return "pending";
    const replacedFence = original.replace(match[0], `\`\`\`json\n${costJson}\n\`\`\``);
    const updated = replaceRunCostsSection(replacedFence, formatRunCosts(total, sessionIds, cutoff));
    if (updated == null) return "pending";
    const validated = parseReport(updated);
    if (!validated) return "pending";
    const { cost: validatedCost, ...validatedNonCost } = validated.value;
    const { cost: originalCost, ...originalNonCost } = report;
    if (JSON.stringify(validatedCost) !== JSON.stringify(cost) ||
        JSON.stringify(validatedNonCost) !== JSON.stringify(originalNonCost)) return "pending";
    if ((await safeReportPath(target, home)) !== target) return "pending";
    const currentStat = await fs.lstat(target);
    if (!currentStat.isFile() || currentStat.dev !== fileStat.dev || currentStat.ino !== fileStat.ino) return "pending";
    if ((await fs.readFile(target, "utf8")) !== original) return "pending";
    await handle.close();
    handle = null;
    await atomicReplace(target, updated, fileStat.mode & 0o777);
    return "updated";
  } catch {
    return "pending";
  } finally {
    await handle?.close().catch(() => {});
  }
}
