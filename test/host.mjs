import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const source = process.env.RUN_STATS_PACKAGE || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = process.env.OPENCODE_BIN || '/opt/homebrew/bin/opencode';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'run-stats-native-'));
const configDir = path.join(temp, 'config', 'opencode');
const project = path.join(temp, 'project');
await fs.mkdir(configDir, { recursive: true }); await fs.mkdir(project);
const packaged = path.join(temp, 'plugin');
await fs.mkdir(packaged);
for (const file of ['package.json', 'index.js', 'native.js', 'tui.js', 'options.js', 'tracker.js', 'lib.js']) await fs.copyFile(path.join(source, file), path.join(packaged, file));
let mockFailure;
const mock = createServer(async (req, res) => {
 try {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'Native stats fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })); return;
  }
  const chunk = choices => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify(chunk([{ index: 0, delta: { content: 'Native stats fixture complete.' }, finish_reason: null }])) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]), usage: { prompt_tokens: 1234, completion_tokens: 234, total_tokens: 1468 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
 } catch (error) { mockFailure = error; if (!res.headersSent) res.writeHead(500); res.end('Owned fixture failed'); }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const config = {
 plugins: [{ package: packaged, options: { showLog: true, showToast: false, minCost: 0, format: 'table' } }],
 model: 'stats_fixture/gpt-6.1', small_model: 'stats_fixture/gpt-6.1', default_agent: 'build', autoupdate: false, lsp: false, formatter: false,
 provider: { stats_fixture: { npm: '@ai-sdk/openai-compatible', name: 'Unpaid localhost fixture', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'local-fixture-only' }, models: { 'gpt-6.1': { name: 'fixture', limit: { context: 128000, output: 8192 }, tool_call: true } } } },
};
if (process.env.RUN_STATS_LEGACY_CONFIG === '1') {
 config.plugin = [[packaged, config.plugins[0].options]]; delete config.plugins;
}
await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify(config));
const optionsFile = path.join(temp, 'options.json'); await fs.writeFile(optionsFile, '{}');
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_STATE_HOME: path.join(temp, 'state'), OPENCODE_CONFIG_DIR: configDir, OPENCODE_RUN_STATS_CONFIG: optionsFile };
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']) delete env[key];
const host = spawn(binary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; host.stdout.on('data', b => { log += b; }); host.stderr.on('data', b => { log += b; });
const deadline = Date.now() + 90000;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const api = async (route, method = 'GET', body) => {
 const password = /server password (\S+)/.exec(log)?.[1]; assert.ok(password);
 const query = new URLSearchParams({ 'location[directory]': project });
 const response = await fetch(`http://127.0.0.1:${port}${route}?${query}`, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
 assert.ok(response.ok, 'Owned API status ' + response.status); return response.status === 204 ? null : response.json();
};
const outputs = () => [...log.matchAll(/\{"service":"run-stats"[^\n]+/g)].map(m => JSON.parse(m[0]));
try {
 while (!/server password /.test(log)) { assert.ok(Date.now() < deadline && host.exitCode == null, 'Owned startup failed'); await pause(); }
 const session = (await api('/api/session', 'POST', { agent: 'build', model: { providerID: 'stats_fixture', id: 'gpt-6.1' }, location: { directory: project } })).data;
 const results = [];
 let priorInput = 0;
 for (let turn = 1; turn <= 2; turn++) {
  const before = outputs().length;
  await api(`/api/session/${session.id}/prompt`, 'POST', { text: 'Complete this isolated stats fixture turn.' });
  let info, output;
  while (true) {
   if (mockFailure) throw mockFailure;
   info = (await api(`/api/session/${session.id}`)).data;
   output = outputs().at(-1);
   if (outputs().length > before && output && info.tokens.input > priorInput && info.tokens.input === output.extra.input && info.tokens.output === output.extra.output) break;
   assert.ok(Date.now() < deadline && host.exitCode == null, 'Native completion table missing'); await pause();
  }
  assert.match(output.message, /TOTAL/); assert.match(output.message, /build/);
  assert.equal(output.extra.input, info.tokens.input); assert.equal(output.extra.output, info.tokens.output);
  assert.equal(output.extra.cost, info.cost); assert.equal(info.cost, 0);
  assert.ok(info.tokens.input >= 1234 * turn);
  priorInput = info.tokens.input;
  results.push({ completion: turn, input: info.tokens.input, output: info.tokens.output, cost: info.cost, table: true });
 }
 const plugins = (await api('/api/plugin')).data;
 assert.ok(JSON.stringify(plugins).includes('opencode-run-stats'), 'Native definition must be registered');
 const result = { passed: true, version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), native_plugin_registered: true, zero_cost_completions: results, paid_model_calls: 0, limits: 'Real v2 server subscription and logging verified; TUI rendering/lifecycle is separately covered by native-context tests.' };
 if (process.env.RUN_STATS_RESULT) await fs.writeFile(process.env.RUN_STATS_RESULT, JSON.stringify(result, null, 2) + '\n');
 console.log(JSON.stringify(result));
} catch (error) {
 // Only bounded plugin diagnostics; never print owned server password/log body.
 console.error('Fixture registration diagnostic:', log.split('\n').filter(line => /plugin|entrypoint|LoadError/i.test(line)).slice(-8).map(line => line.replace(/server password \S+/g, 'server password [redacted]')).join('\n'));
 throw error;
} finally {
 host.kill('SIGTERM'); if (host.exitCode == null && host.signalCode == null) {
  const force = setTimeout(() => host.kill('SIGKILL'), 3000);
  await new Promise(resolve => host.once('close', resolve)); clearTimeout(force);
 }
 await new Promise(resolve => mock.close(resolve)); await fs.rm(temp, { recursive: true, force: true });
}
