import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setImmediate as flush } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { callTool, startMcp } from '../lib/mcp.mjs';

const sessions = [
  { sessionId: '11111111-1111-4111-8111-111111111111', title: '缓存方案', projectDirectory: 'F:/demo-a', modifiedAt: '2026-10-22T01:00:00Z' },
  { sessionId: '22222222-2222-4222-8222-222222222222', title: '缓存方案', projectDirectory: 'F:/demo-b', modifiedAt: '2026-10-21T01:00:00Z' },
];
function storeFor(rows = sessions) {
  return { list: async () => ({ sessions: rows, total: rows.length, nextOffset: null }),
    read: () => assert.fail('Selection must not read session contents'),
    updates: () => assert.fail('Selection must not synchronize before confirmation'),
  };
}
function client(t, store = storeFor(), transport) {
  const input = transport?.input ?? new PassThrough();
  const output = transport?.output ?? new PassThrough();
  const server = transport ? null : startMcp(store, { input, output });
  const events = new EventEmitter(), messages = [];
  let buffer = '', id = 0;
  output.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const message = JSON.parse(line); messages.push(message); events.emit('message', message); }
  });
  t.after(() => { server?.close(); input.destroy(); output.destroy(); });
  const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  function waitFor(predicate) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('message', onMessage); reject(new Error('MCP test timed out')); }, 5000);
      function onMessage(message) { if (predicate(message)) { clearTimeout(timer); events.off('message', onMessage); resolve(message); } }
      events.on('message', onMessage);
    });
  }
  function request(method, params) { const requestId = ++id; send({ id: requestId, method, params }); return requestId; }
  return { messages, send, waitFor, request,
    result: requestId => waitFor(message => message.id === requestId),
    elicitation: (index = 0) => waitFor(message => message.method === 'elicitation/create' && messages.filter(m => m.method === 'elicitation/create').indexOf(message) === index),
    initialize: async (capabilities = { elicitation: { form: {} } }, protocolVersion = '2025-11-25') => {
      const requestId = request('initialize', { capabilities, protocolVersion });
      return (await waitFor(message => message.id === requestId)).result;
    },
  };
}
const data = reply => JSON.parse(reply.result.content[0].text);
const select = (c, args = {}) => c.request('tools/call', { name: 'claude_select_session', arguments: args });
const respond = (c, elicitation, result) => c.send({ id: elicitation.id, result });

test('selection stays pending until the client submits, and blocks concurrent reads, sync and sends', async t => {
  const c = client(t);
  await c.initialize();
  const id = select(c);
  const form = await c.elicitation();
  assert.equal(form.params.mode, 'form');
  const schema = form.params.requestedSchema;
  assert.deepEqual(schema.required, ['sessionId']);
  assert.deepEqual(schema.properties.sessionId.enum, sessions.map(s => s.sessionId));
  assert.equal(Object.hasOwn(schema.properties.sessionId, 'default'), false);
  for (const s of sessions) {
    const name = schema.properties.sessionId.enumNames[sessions.indexOf(s)];
    assert.ok(name.includes(s.projectDirectory)); assert.ok(name.includes(s.modifiedAt));
  }
  await flush();
  assert.ok(!c.messages.some(message => message.id === id));
  for (const name of ['claude_read_session', 'claude_session_updates', 'claude_ask_session', 'claude_select_session']) {
    const blocked = await c.result(c.request('tools/call', { name, arguments: { sessionId: sessions[0].sessionId } }));
    assert.equal(blocked.result.isError, true);
    assert.match(data(blocked).error, /等待用户点击选择/);
  }
  assert.deepEqual((await c.result(c.request('ping'))).result, {});
  respond(c, form, { action: 'accept', content: { sessionId: sessions[1].sessionId } });
  const selected = data(await c.result(id));
  assert.equal(selected.status, 'selected');
  assert.equal(selected.sessionId, sessions[1].sessionId);
  assert.deepEqual(selected.selectedSession, sessions[1]);
});

test('one candidate still waits for submission, including legacy form capability', async t => {
  const c = client(t, storeFor(sessions.slice(0, 1)));
  await c.initialize({ elicitation: {} }, '2025-06-18');
  const id = select(c), form = await c.elicitation();
  assert.equal(Object.hasOwn(form.params, 'mode'), false);
  assert.equal(form.params.requestedSchema.properties.sessionId.enum.length, 1);
  await flush(); assert.ok(!c.messages.some(message => message.id === id));
  respond(c, form, { action: 'accept', content: { sessionId: sessions[0].sessionId } });
  assert.equal(data(await c.result(id)).sessionId, sessions[0].sessionId);
});

for (const action of ['cancel', 'decline']) {
  test(action + ' never selects a candidate, even if the client sends a preselected value', async t => {
    const c = client(t); await c.initialize();
    const id = select(c), form = await c.elicitation();
    respond(c, form, { action, content: { sessionId: sessions[0].sessionId } });
    const result = data(await c.result(id));
    assert.equal(result.selected, false);
    assert.equal(result.status, action === 'cancel' ? 'cancelled' : 'declined');
    assert.equal(Object.hasOwn(result, 'sessionId'), false);
    await flush(); assert.equal(c.messages.filter(m => m.method === 'elicitation/create').length, 1);
  });
}

for (const [name, capabilities, protocol] of [
  ['missing capability', {}, '2025-11-25'],
  ['URL-only client', { elicitation: { url: {} } }, '2025-11-25'],
  ['old protocol', { elicitation: {} }, '2025-03-26'],
]) {
  test(name + ' fails explicitly without a text-choice fallback', async t => {
    const c = client(t); await c.initialize(capabilities, protocol);
    const reply = await c.result(select(c));
    assert.equal(reply.result.isError, true);
    assert.match(data(reply).error, /未声明支持MCP表单/);
    assert.equal(c.messages.filter(m => m.method === 'elicitation/create').length, 0);
    const listed = data(await c.result(c.request('tools/call', { name: 'claude_sessions', arguments: {} })));
    assert.equal(listed.choices.length, 2); // Metadata listing remains available.
    assert.equal(Object.hasOwn(listed, 'sessionId'), false);
  });
}

test('empty results do not open a form or pretend a session was selected', async t => {
  const c = client(t, storeFor([])); await c.initialize();
  const result = data(await c.result(select(c)));
  assert.equal(result.status, 'empty'); assert.equal(result.selected, false);
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
  assert.equal(c.messages.filter(m => m.method === 'elicitation/create').length, 0);
});

test('missing or out-of-list submissions cannot select a session', async t => {
  const c = client(t); await c.initialize();
  const invalid = [{ action: 'accept' }, { action: 'accept', content: { sessionId: 'unknown' } }, { action: 'unknown' }];
  for (const [index, response] of invalid.entries()) {
    const id = select(c), form = await c.elicitation(index);
    respond(c, form, response);
    const result = await c.result(id);
    assert.equal(result.result.isError, true);
    assert.match(data(result).error, /未返回有效/);
  }
});

test('form pagination needs a final submission and uses the displayed snapshot', async t => {
  const calls = [];
  const store = { list: async ({ offset }) => {
    calls.push(offset);
    return { sessions: [sessions[offset]], total: 2, nextOffset: offset === 0 ? 1 : null };
  } };
  const c = client(t, store); await c.initialize();
  const id = select(c, { limit: 1 });
  const first = await c.elicitation();
  respond(c, first, { action: 'accept', content: { sessionId: '__next_page__' } });
  const second = await c.elicitation(1);
  assert.ok(second.params.requestedSchema.properties.sessionId.enum.includes('__previous_page__'));
  assert.ok(!c.messages.some(message => message.id === id));
  respond(c, second, { action: 'accept', content: { sessionId: '__previous_page__' } });
  const third = await c.elicitation(2);
  respond(c, third, { action: 'accept', content: { sessionId: sessions[0].sessionId } });
  assert.equal(data(await c.result(id)).sessionId, sessions[0].sessionId);
  assert.deepEqual(calls, [0, 1, 0]); // Confirmation never relists or changes the selected ID.
});

test('cancelling a pending tool clears the form, ignores late acceptance, and permits another selection', async t => {
  const c = client(t); await c.initialize();
  const id = select(c), form = await c.elicitation();
  c.send({ method: 'notifications/cancelled', params: { requestId: id } });
  await c.waitFor(m => m.method === 'notifications/cancelled' && m.params.requestId === form.id);
  await flush();
  respond(c, form, { action: 'accept', content: { sessionId: sessions[0].sessionId } });
  await flush();
  assert.ok(!c.messages.some(message => message.id === id));
  const nextId = select(c), nextForm = await c.elicitation(1);
  respond(c, nextForm, { action: 'cancel' });
  assert.equal(data(await c.result(nextId)).status, 'cancelled');
});

test('client-side form failure returns an error without retrying or selecting', async t => {
  const c = client(t); await c.initialize();
  const id = select(c), form = await c.elicitation();
  c.send({ id: form.id, error: { code: -32603, message: 'UI unavailable' } });
  const reply = await c.result(id);
  assert.equal(reply.result.isError, true);
  assert.match(data(reply).error, /UI unavailable/);
  assert.equal(c.messages.filter(m => m.method === 'elicitation/create').length, 1);
});

test('plain programmatic calls cannot fake selection without an elicitation channel', async () => {
  await assert.rejects(callTool(storeFor(), 'claude_select_session'), /需要支持MCP表单/);
  const calls = [];
  await callTool({ read: async (...args) => { calls.push(args); return {}; } }, 'claude_read_session', { sessionId: sessions[1].sessionId });
  assert.deepEqual(calls, [[sessions[1].sessionId, {}]]);
});

test('actual stdio subprocess waits for the client form response before completing selection', async t => {
  const moduleUrl = new URL('../lib/mcp.mjs', import.meta.url).href;
  const script = 'import { startMcp } from ' + JSON.stringify(moduleUrl) + ';startMcp({list:async()=>({sessions:' + JSON.stringify(sessions) + ',total:2,nextOffset:null})});';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const c = client(t, null, { input: child.stdin, output: child.stdout });
  await c.initialize();
  const id = select(c), form = await c.elicitation();
  await flush(); assert.ok(!c.messages.some(message => message.id === id));
  respond(c, form, { action: 'accept', content: { sessionId: sessions[1].sessionId } });
  assert.equal(data(await c.result(id)).sessionId, sessions[1].sessionId);
  assert.equal(stderr, '');
});
