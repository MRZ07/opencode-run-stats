import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateDeepReviewReport, reportPathsFromTool } from "../deep-review.js";
import { RunStats } from "../index.js";

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "run-stats-review-")));
const reportRoot = path.join(temp, "reports", "deep-review", "repo");
await fs.mkdir(reportRoot, { recursive: true });
const file = path.join(reportRoot, "2026-10-06-review.md");
const rootId = "ses_Root123";
const opsId = "ses_Ops123";
const explorerId = "ses_Explore123";
const unrelatedId = "ses_Other123";
let integrationTemp;
const reportText = (helpers = [opsId, explorerId], includeHelperField = true) => `## Run State
- Phase: Done
- Explorer task IDs: ${helpers.includes(explorerId) ? explorerId : "none"}
- Ops task IDs: ${helpers.includes(opsId) ? `${opsId} (2 invocations)` : "none"}

## Findings
Verdict data stays here.

## Run Costs
Old cost prose.

\`\`\`json
{
  "report_version": 3,
  "workflow": "deep-review",
  "started_at": "1970-01-01T00:00:01.400Z",
  "ended_at": "1970-01-01T00:00:02.500Z",
  "cost": { "model_lead": "provider/model", "usd": null, "session_ids": [], "source": "pending" },
  "review": { "mode": "Diff", "verdict": "Ship it"${includeHelperField ? `, "helper_session_ids": ${JSON.stringify(helpers)}` : ""} },
  "notes": "Keep this note."
}
\`\`\`
`;
const assistant = (id, created, cost, tokenBase) => ({
  id, role: "assistant", mode: "deep-review", time: { created }, cost, providerID: "provider", modelID: "model",
  tokens: { input: tokenBase, output: tokenBase / 10, reasoning: tokenBase / 20, cache: { read: tokenBase * 2, write: tokenBase / 100 } },
});
const user = (id, created) => ({ id, role: "user", time: { created } });

function clientFor({ histories, parents = {}, rootParent = null }) {
  const queried = [];
  const client = {
    session: {
      get: async ({ path: { id } }) => ({ data: { id, ...(id === rootId ? (rootParent ? { parentID: rootParent } : {}) : { parentID: parents[id] }) } }),
      messages: async ({ path: { id }, query }) => {
        queried.push({ id, limit: query.limit });
        return { data: (histories[id] ?? []).map((entry) => ({ ...entry, info: { ...entry.info, sessionID: entry.info.sessionID ?? id } })) };
      },
    },
  };
  return { client, queried };
}

const baseHistories = (helpers = [opsId, explorerId]) => ({
  [rootId]: [
    { info: user("old", 500) },
    { info: assistant("previous-turn", 600, 8, 800) },
    { info: user("turn-start", 1000) },
    { info: assistant("root-work", 1500, 0.1, 100), parts: helpers.map((id) => ({ type: "tool", tool: "task", state: { status: "completed", metadata: { sessionId: id, parentSessionId: rootId, truncated: false } } })) },
    { info: assistant("root-final", 3000, 0.2, 200), parts: [] },
    { info: assistant("root-final", 3000, 0.2, 200), parts: [] }, // SDK/event duplicate must count once
    { info: assistant("later-question", 5000, 5, 500), parts: [] },
  ],
  [opsId]: [
    { info: assistant("ops-old", 900, 9, 900) },
    { info: assistant("ops-work", 1800, 0.3, 300) },
  ],
  [explorerId]: [{ info: assistant("explore-work", 2000, 0, 0) }],
});

try {
  await fs.writeFile(file, reportText());
  const initialData = JSON.parse((await fs.readFile(file, "utf8")).match(/```json\n([\s\S]*?)\n```/)[1]);
  const histories = baseHistories();
  const { client, queried } = clientFor({ histories, parents: { [opsId]: rootId, [explorerId]: rootId } });
  assert.deepEqual(reportPathsFromTool("write", { filePath: file }), [file]);
  assert.deepEqual(reportPathsFromTool("read", { filePath: file }), []);
  assert.deepEqual(reportPathsFromTool("apply_patch", { patch: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` }), [file]);
  assert.deepEqual(reportPathsFromTool("apply_patch", { patchText: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` }), [file]);
  assert.deepEqual(reportPathsFromTool("apply_patch", { patchText: `*** Begin Patch\n*** Add File: ${file}\n*** End Patch` }), [file]);
  assert.deepEqual(reportPathsFromTool("edit", {}, { metadata: { files: [{ path: file }] } }), [file]);
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: file, home: temp, idleAt: 4000 }), "updated");
  assert.deepEqual(queried.map((item) => item.id), [rootId, opsId, explorerId]);
  assert.ok(queried.every((item) => item.limit === 500));
  let updated = await fs.readFile(file, "utf8");
  const data = JSON.parse(updated.match(/```json\n([\s\S]*?)\n```/)[1]);
  const { cost: ignoredInitialCost, ...initialNonCost } = initialData;
  const { cost: ignoredUpdatedCost, ...updatedNonCost } = data;
  assert.deepEqual(updatedNonCost, initialNonCost);
  assert.equal(data.cost.usd, 0.6); // final reply included; earlier/later root turns excluded
  assert.equal(data.cost.tokens_input, 600);
  assert.deepEqual(data.cost.session_ids, [rootId, opsId, explorerId]);
  assert.equal(data.cost.source, "opencode-run-stats");
  assert.equal(data.cost.model_lead, "provider/model");
  assert.equal(data.cost.complete, true);
  assert.equal(data.review.verdict, "Ship it");
  assert.equal(data.notes, "Keep this note.");
  assert.match(updated, /Nominal total: \*\*\$0\.6\*\*/);
  assert.match(updated, /through session idle at 1970-01-01T00:00:04\.000Z/);
  assert.equal((updated.match(/^## Run Costs$/gm) || []).length, 1);

  // A later idle in this long-lived root cannot add a later unrelated question.
  histories[rootId].push({ info: assistant("later-question-2", 6000, 7, 700) });
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: file, home: temp, idleAt: 7000 }), "preserved");
  updated = await fs.readFile(file, "utf8");
  assert.equal(JSON.parse(updated.match(/```json\n([\s\S]*?)\n```/)[1]).cost.usd, 0.6);

  // Cold tracker: history is fetched from the SDK, without any event replay state.
  const coldFile = path.join(reportRoot, "cold.md");
  await fs.writeFile(coldFile, reportText([opsId]));
  const cold = clientFor({ histories: { [rootId]: baseHistories([opsId])[rootId].slice(0, 5), [opsId]: histories[opsId] }, parents: { [opsId]: rootId } });
  assert.equal(await updateDeepReviewReport({ client: cold.client, rootId, filePath: coldFile, home: temp, idleAt: 4000 }), "updated");

  const legacyFile = path.join(reportRoot, "legacy.md");
  await fs.writeFile(legacyFile, reportText([opsId], false));
  const legacy = clientFor({ histories: { [rootId]: baseHistories([opsId])[rootId], [opsId]: histories[opsId] }, parents: { [opsId]: rootId } });
  assert.equal(await updateDeepReviewReport({ client: legacy.client, rootId, filePath: legacyFile, home: temp, idleAt: 4000 }), "updated");

  // Unknown usage, unverified parentage, and oversized history stay pending.
  const unknownFile = path.join(reportRoot, "unknown.md");
  await fs.writeFile(unknownFile, reportText([opsId]));
  const unknownHistory = baseHistories();
  unknownHistory[rootId] = unknownHistory[rootId].map((entry) => entry.info?.id === "root-final"
    ? { info: { ...entry.info, cost: undefined } } : entry);
  const unknown = clientFor({ histories: unknownHistory, parents: { [opsId]: rootId } });
  assert.equal(await updateDeepReviewReport({ client: unknown.client, rootId, filePath: unknownFile, home: temp, idleAt: 4000 }), "pending");
  assert.match(await fs.readFile(unknownFile, "utf8"), /"source": "pending"/);

  const omittedHelperFile = path.join(reportRoot, "omitted-helper.md");
  await fs.writeFile(omittedHelperFile, reportText([]));
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: omittedHelperFile, home: temp, idleAt: 4000 }), "pending");

  const foreign = clientFor({ histories: baseHistories(), parents: { [opsId]: unrelatedId } });
  assert.equal(await updateDeepReviewReport({ client: foreign.client, rootId, filePath: unknownFile, home: temp, idleAt: 4000 }), "pending");
  const nested = clientFor({ histories: baseHistories(), parents: { [opsId]: rootId }, rootParent: unrelatedId });
  assert.equal(await updateDeepReviewReport({ client: nested.client, rootId, filePath: unknownFile, home: temp, idleAt: 4000 }), "ineligible");

  const fullHistory = clientFor({ histories: { ...baseHistories(), [rootId]: Array(500).fill({ info: user("u", 1000) }) }, parents: { [opsId]: rootId } });
  assert.equal(await updateDeepReviewReport({ client: fullHistory.client, rootId, filePath: unknownFile, home: temp, idleAt: 4000 }), "pending");

  const snapshotFile = path.join(reportRoot, "snapshot.md");
  await fs.writeFile(snapshotFile, reportText().replace('"source": "pending"', '"source": "fusion-ops-db"').replace('"session_ids": []', `"session_ids": ["${rootId}", "${opsId}", "${explorerId}"]`));
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: snapshotFile, home: temp, idleAt: 4000 }), "updated");

  const gateFile = path.join(reportRoot, "gate.md");
  await fs.writeFile(gateFile, reportText().replace("- Phase: Done", "- Phase: Gate"));
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: gateFile, home: temp, idleAt: 4000 }), "pending");
  await fs.writeFile(gateFile, reportText()); // resumed review explicitly rewrites the report
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: gateFile, home: temp, idleAt: 4000 }), "updated");

  // Paths outside the report root, traversal, and symlink targets are rejected.
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: path.join(temp, "outside.md"), home: temp }), "ineligible");
  const escapeLink = path.join(reportRoot, "escape.md");
  await fs.symlink(file, escapeLink);
  assert.equal(await updateDeepReviewReport({ client, rootId, filePath: escapeLink, home: temp, idleAt: 4000 }), "ineligible");

  // File update still runs when UI stats are below the configured toast threshold.
  integrationTemp = await fs.mkdtemp(path.join(os.homedir(), "reports", "deep-review", "opencode-run-stats-test-"));
  const pluginFile = path.join(integrationTemp, "plugin-hook.md");
  await fs.writeFile(pluginFile, reportText([opsId]).replace("- Phase: Done", "- Phase: Gate"));
  const pluginHistories = { [rootId]: baseHistories([opsId])[rootId].slice(0, 6), [opsId]: histories[opsId] };
  const pluginClient = clientFor({ histories: pluginHistories, parents: { [opsId]: rootId } }).client;
  const hooks = await RunStats({ client: { ...pluginClient, app: { log: async () => {} }, tui: { showToast: async () => {} } } }, { minCost: 99, showToast: false });
  await hooks["tool.execute.after"]({ tool: "write", sessionID: rootId, args: { filePath: pluginFile } }, {});
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: rootId } } });
  assert.match(await fs.readFile(pluginFile, "utf8"), /"source": "pending"/);
  await fs.writeFile(pluginFile, reportText([opsId]));
  await hooks["tool.execute.after"]({ tool: "write", sessionID: rootId, args: { filePath: pluginFile } }, {});
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: rootId } } });
  const pluginData = JSON.parse((await fs.readFile(pluginFile, "utf8")).match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(pluginData.cost.source, "opencode-run-stats");
  pluginHistories[rootId].push({ info: { ...assistant("later-build", 3500, 4, 400), mode: "build" }, parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: rootId } } });
  const afterLaterIdle = JSON.parse((await fs.readFile(pluginFile, "utf8")).match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(afterLaterIdle.cost.usd, 0.6); // the consumed binding cannot absorb later root usage
  const buildFile = path.join(integrationTemp, "build-writer.md");
  await fs.writeFile(buildFile, reportText([opsId]));
  await hooks["tool.execute.after"]({ tool: "write", sessionID: rootId, args: { filePath: buildFile } }, {});
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: rootId } } });
  assert.match(await fs.readFile(buildFile, "utf8"), /"source": "pending"/); // Build mode cannot finalize Deep Review costs

  console.log("deep-review: post-idle cost backfill assertions passed");
} finally {
  if (integrationTemp) await fs.rm(integrationTemp, { recursive: true, force: true });
  await fs.rm(temp, { recursive: true, force: true });
}
