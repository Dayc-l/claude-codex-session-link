import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, appendFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { SessionStore } from '../lib/sessions.mjs';
import { planQuestion, askQuestion, runProcess } from '../lib/ask.mjs';
import { callTool, startMcp } from '../lib/mcp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEMP = path.join(ROOT, '.test-tmp');
const ID = '11111111-1111-4111-8111-111111111111';
const FORK = '22222222-2222-4222-8222-222222222222';
const msg = (uuid, parentUuid, role, content, extra = {}) => ({ type: role, uuid, parentUuid, sessionId: ID, cwd: ROOT,
  timestamp: '2026-10-14T00:00:00Z', message: { role, content }, ...extra });
async function fixture(t, rows) {
  await mkdir(TEMP, { recursive: true });
  const home = await mkdtemp(path.join(TEMP, 'case-'));
  const bucket = path.join(home, 'projects', 'F--demo'); await mkdir(bucket, { recursive: true });
  const file = path.join(bucket, ID + '.jsonl');
  await writeFile(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  t.after(async () => {
    // Never recursively delete a computed location outside the test-owned directory.
    if (path.dirname(path.resolve(home)) !== path.resolve(TEMP) || !path.basename(home).startsWith('case-')) throw new Error('Unsafe test cleanup target');
    await rm(home, { recursive: true, force: true });
  });
  return { store: new SessionStore(home), home, bucket, file };
}
const basic = () => [msg('a', null, 'user', '请解释缓存设计'), msg('b', 'a', 'assistant', [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: '使用分层缓存。' }])];
const HELP = '--safe-mode --resume --fork-session --tools --strict-mcp-config --disable-slash-commands --no-chrome --settings';

test('list/read are read-only and support VS Code titles, search and custom home', async t => {
  const { store, file } = await fixture(t, [...basic(), { type: 'ai-title', aiTitle: '缓存方案评审', sessionId: ID }]);
  const before = await readFile(file); const info = await stat(file);
  const result = await store.list({ query: '评审' });
  assert.equal(result.total, 1); assert.equal(result.sessions[0].sessionId, ID);
  assert.equal(result.sessions[0].projectDirectory, ROOT);
  const read = await store.read(ID); assert.equal(read.messages.length, 2);
  assert.ok(!JSON.stringify(read).includes('PRIVATE_THINKING'));
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mtimeMs, info.mtimeMs);
});
test('select latest message parent chain and do not merge abandoned branches', async t => {
  const rows = [msg('a', null, 'user', '起点'), msg('old', 'a', 'assistant', '旧分支'),
    { type: 'system', uuid: 'sys', parentUuid: 'a' }, msg('new', 'sys', 'assistant', '新分支'),
    msg('side', 'a', 'assistant', '子代理', { isSidechain: true })];
  const { store } = await fixture(t, rows);
  assert.deepEqual((await store.read(ID)).messages.map(m => m.text), ['起点', '新分支']);
  assert.equal((await store.read(ID, { view: 'all' })).messages.length, 3);
});
test('partial writes, invalid records and compact ancestry are surfaced', async t => {
  const { store, file } = await fixture(t, ['{bad}', msg('a', 'missing', 'assistant', '压缩后')]);
  await appendFile(file, '{"type":"user"');
  const read = await store.read(ID);
  assert.equal(read.messages[0].text, '压缩后'); assert.equal(read.warnings.length, 3);
});
test('tool bodies and attachments are not leaked and pagination is deterministic', async t => {
  const { store } = await fixture(t, [...basic(), msg('c', 'b', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { secret: 'SECRET' } }]),
    msg('d', 'c', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET' }]), msg('e', 'd', 'assistant', '结论')]);
  const read = await store.read(ID, { includeTools: true, limit: 2, offset: 1 });
  assert.equal(read.totalMessages, 5); assert.equal(read.nextOffset, 3); assert.equal(read.messages[1].tools[0].name, 'Read');
  assert.ok(!JSON.stringify(read).includes('SECRET'));
});
test('invalid IDs, ambiguous IDs and invalid pagination are refused', async t => {
  const { store, bucket } = await fixture(t, basic());
  await assert.rejects(store.read('../settings.json'), /完整/);
  await assert.rejects(store.list({ limit: -1 }), /limit/);
  const second = path.join(path.dirname(bucket), 'F--copy'); await mkdir(second);
  await writeFile(path.join(second, ID + '.jsonl'), JSON.stringify(basic()[0]) + '\n');
  await assert.rejects(store.read(ID), /多个项目/);
});
test('oversized sessions and output are bounded', async t => {
  const { store, file } = await fixture(t, [msg('a', null, 'user', 'x'.repeat(30_000))]);
  assert.equal((await store.read(ID)).messages[0].truncated, true);
  await truncate(file, 128 * 1024 * 1024 + 1);
  await assert.rejects(store.read(ID), /128MiB/);
});
test('dry run never starts a process and defaults to a fork', async t => {
  const { store } = await fixture(t, basic());
  const plan = await askQuestion(store, { sessionId: ID, question: '为什么？' }, { runner: () => { throw new Error('must not run'); } });
  assert.equal(plan.sent, false); assert.equal(plan.mode, 'fork'); assert.ok(plan.args.includes('--fork-session'));
  assert.equal(plan.args[plan.args.indexOf('--tools') + 1], '');
  assert.ok(!plan.args.includes('--dangerously-skip-permissions'));
});
test('append requires explicit idle acknowledgement; stale reads cannot send', async t => {
  const { store, file } = await fixture(t, basic());
  await assert.rejects(planQuestion(store, { sessionId: ID, question: 'x', mode: 'resume' }), /confirmIdle/);
  const previous = await store.read(ID); await appendFile(file, JSON.stringify(msg('c', 'b', 'user', '新输入')) + '\n');
  await assert.rejects(planQuestion(store, { sessionId: ID, question: 'x', expectedVersion: previous.version }), /已变化/);
});
test('explicit send uses stdin without a shell, preserves prompt text, and returns fork ID', async t => {
  const { store } = await fixture(t, basic()); const calls = [];
  const question = '中文 "quotes" `backticks` $(command)\n第二行';
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === '--help' ? { code: 0, stdout: HELP } : { code: 0, stdout: JSON.stringify({ result: '解释', session_id: FORK, total_cost_usd: 0.01 }) };
  };
  const answer = await askQuestion(store, { sessionId: ID, question, send: true }, { runner });
  assert.equal(answer.sessionId, FORK); assert.equal(calls.length, 2);
  assert.ok(calls[1].options.input.endsWith(question)); assert.ok(!calls[1].args.includes(question));
  assert.equal(calls[1].options.cwd, ROOT);
});
test('unsupported CLI, changes during preflight, unknown results never auto-retry', async t => {
  const { store, file } = await fixture(t, basic());
  let count = 0;
  await assert.rejects(askQuestion(store, { sessionId: ID, question: 'x', send: true }, { runner: async () => { count++; return { code: 0, stdout: 'old cli' }; } }), /缺少/);
  assert.equal(count, 1);
  await assert.rejects(askQuestion(store, { sessionId: ID, question: 'x', send: true }, { runner: async () => { await appendFile(file, '\n'); return { code: 0, stdout: HELP }; } }), /已变化/);
  count = 0;
  await assert.rejects(askQuestion(store, { sessionId: ID, question: 'x', send: true }, { runner: async (_, args) => { count++; return { code: 0, stdout: args[0] === '--help' ? HELP : 'not JSON' }; } }), /勿自动重发/);
  assert.equal(count, 2);
});
test('fork cannot silently continue original session', async t => {
  const { store } = await fixture(t, basic());
  await assert.rejects(askQuestion(store, { sessionId: ID, question: 'x', send: true }, { runner: async (_, args) => ({ code: 0, stdout: args[0] === '--help' ? HELP : JSON.stringify({ result: 'x', session_id: ID }) }) }), /未确认分叉/);
});
test('native subprocess preserves split UTF-8 and exact stdin; timeout and abort stop it', async t => {
  const { home } = await fixture(t, basic()); const script = path.join(home, 'fake.mjs');
  await writeFile(script, `if(process.argv[2]==='wait'){setInterval(()=>{},1000)}else{let s='';for await(const c of process.stdin)s+=c;const b=Buffer.from(s);process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)}`);
  const reply = await runProcess(process.execPath, [script], { input: '中文\n"$()`' });
  assert.equal(reply.stdout, '中文\n"$()`');
  await assert.rejects(runProcess(process.execPath, [script, 'wait'], { timeoutMs: 80 }), /超时/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, [script, 'wait'], { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /取消/);
});
test('MCP handshake, tools, read and errors have clean newline JSON framing', async t => {
  const { store } = await fixture(t, basic());
  const input = new PassThrough(), output = new PassThrough(); const replies = [];
  let raw = ''; output.on('data', chunk => { raw += chunk.toString(); });
  const server = startMcp(store, { input, output }); t.after(() => server.close());
  const waitFor = async id => {
    for (let i = 0; i < 100; i++) {
      const found = raw.trim().split('\n').filter(Boolean).map(s => JSON.parse(s)).find(r => r.id === id);
      if (found) { replies.push(found); return found; } await new Promise(r => setTimeout(r, 10));
    } throw new Error('MCP response timed out');
  };
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  assert.equal((await waitFor(1)).result.serverInfo.name, 'claude-session-link');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  assert.equal((await waitFor(2)).result.tools.length, 5);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'claude_read_session', arguments: { sessionId: ID } } }) + '\n');
  assert.equal(JSON.parse((await waitFor(3)).result.content[0].text).messages.length, 2);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'claude_sessions', arguments: { send: true } } }) + '\n');
  assert.equal((await waitFor(4)).result.isError, true);
  input.write('{bad}\n'); assert.equal((await waitFor(null)).error.code, -32700);
});
test('tool argument validation prevents accidental sends and ignores no unknown fields', async t => {
  const { store } = await fixture(t, basic());
  await assert.rejects(callTool(store, 'claude_ask_session', { sessionId: ID, question: 'x', send: 'true' }), /send/);
  await assert.rejects(callTool(store, 'claude_sessions', { query: 123 }), /query/);
  await assert.rejects(callTool(store, 'claude_sessions', { shell: 'malicious' }), /未知/);
});
test('MCP listing provides explicit user choices without persisting a default target', async t => {
  const { store, file } = await fixture(t, basic()); const before = await readFile(file);
  const page = await callTool(store, 'claude_sessions', { limit: 3 });
  assert.equal(page.choices[0].sessionId, ID);
  assert.equal(page.choices[0].title, page.sessions[0].title);
  assert.match(page.selectionHint, /不保存全局/);
  assert.deepEqual(await readFile(file), before);
});
test('CLI subprocess can list/read without touching settings or launching Claude', async t => {
  const { home } = await fixture(t, basic());
  const output = await runProcess(process.execPath, [path.join(ROOT, 'cli.mjs'), 'list', '--claude-home', home]);
  assert.equal(output.code, 0); assert.equal(JSON.parse(output.stdout).total, 1);
  const read = await runProcess(process.execPath, [path.join(ROOT, 'cli.mjs'), 'read', '--claude-home', home, '--session', ID]);
  assert.equal(JSON.parse(read.stdout).messages.length, 2);
});
test('incremental reads return only appended visible messages and do not repeat them', async t => {
  const { store, file } = await fixture(t, basic());
  const first = await callTool(store, 'claude_session_updates', { sessionId: ID });
  assert.equal(first.status, 'initial');
  const unchanged = await store.updates(ID, { cursor: first.cursor });
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.messages.length, 0);
  await appendFile(file, JSON.stringify(msg('c', 'b', 'assistant', '新增回答')) + '\n');
  const update = await store.updates(ID, { cursor: first.cursor });
  assert.equal(update.status, 'updated'); assert.deepEqual(update.messages.map(m => m.text), ['新增回答']);
  assert.equal((await store.updates(ID, { cursor: update.cursor })).messages.length, 0);
});
test('partial last line is picked up after completion without advancing cursor early', async t => {
  const { store, file } = await fixture(t, basic()); const initial = await store.updates(ID);
  const line = JSON.stringify(msg('c', 'b', 'assistant', '写完后才出现'));
  await appendFile(file, line.slice(0, 20));
  const partial = await store.updates(ID, { cursor: initial.cursor }); assert.equal(partial.messages.length, 0);
  await appendFile(file, line.slice(20) + '\n');
  const complete = await store.updates(ID, { cursor: partial.cursor });
  assert.equal(complete.messages[0].text, '写完后才出现');
});
test('branch replacement, compaction and edits of previously read records trigger reset', async t => {
  const { store, file } = await fixture(t, basic()); const initial = await store.updates(ID);
  await appendFile(file, JSON.stringify(msg('alternate', 'a', 'assistant', '另一分支')) + '\n');
  const branch = await store.updates(ID, { cursor: initial.cursor }); assert.equal(branch.status, 'reset');
  await writeFile(file, JSON.stringify(msg('compact', null, 'assistant', '压缩后的摘要')) + '\n');
  assert.equal((await store.updates(ID, { cursor: branch.cursor })).resetRequired, true);
  await writeFile(file, basic().map(r => JSON.stringify(r)).join('\n') + '\n'); const before = await store.updates(ID);
  await appendFile(file, JSON.stringify(msg('b', 'a', 'assistant', '同UUID的修订正文')) + '\n');
  const changed = await store.updates(ID, { cursor: before.cursor }); assert.equal(changed.resetRequired, true);
  assert.ok(changed.messages.some(m => m.text === '同UUID的修订正文'));
});
test('long incremental messages continue across pages without losing text', async t => {
  const { store, file } = await fixture(t, basic()); const initial = await store.updates(ID);
  const long = '中文'.repeat(25_000);
  await appendFile(file, JSON.stringify(msg('long', 'b', 'assistant', long)) + '\n' + JSON.stringify(msg('tail', 'long', 'user', '下一条')) + '\n');
  let cursor = initial.cursor, result, combined = '', tail = [];
  do {
    result = await store.updates(ID, { cursor, limit: 1 }); cursor = result.cursor;
    for (const m of result.messages) { if (m.uuid === 'long') combined += m.text; else tail.push(m.text); }
  } while (result.hasMore);
  assert.equal(combined, long); assert.deepEqual(tail, ['下一条']);
  assert.equal((await store.updates(ID, { cursor })).status, 'unchanged');
});
test('bad and cross-session cursors fail rather than silently advancing', async t => {
  const { store } = await fixture(t, basic());
  await assert.rejects(store.updates(ID, { cursor: 'not-json' }), /cursor/);
  const first = await store.updates(ID);
  await assert.rejects(store.updates(FORK, { cursor: first.cursor }), /不属于/);
});
