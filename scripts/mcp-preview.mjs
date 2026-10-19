#!/usr/bin/env node
// Exercise the actual stdio MCP process. No Claude inference and no config writes.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const server = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'mcp'], {
  shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map(); let nextId = 0; let stderr = '';
server.stderr.setEncoding('utf8'); server.stderr.on('data', data => { stderr += data; });
server.stdin.on('error', () => {});
const lines = createInterface({ input: server.stdout });
lines.on('line', line => {
  let reply;
  try { reply = JSON.parse(line); } catch { return fail(new Error('MCP stdout contains non-JSON output.')); }
  const waiter = pending.get(reply.id); if (!waiter) return;
  pending.delete(reply.id); clearTimeout(waiter.timer);
  if (reply.error) waiter.reject(new Error(reply.error.message)); else waiter.resolve(reply.result);
});
function fail(error) {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear();
}
server.on('error', fail);
server.on('close', code => fail(new Error(`MCP exited (${code}). ${stderr.slice(0, 500)}`)));
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP preview timed out.')); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
}
try {
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-preview', version: '1.0.0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list');
  const args = process.argv.slice(2);
  const query = args[0] || '';
  const result = await request('tools/call', { name: 'claude_sessions', arguments: { query, limit: 6 } });
  if (result.isError) throw new Error(result.content?.[0]?.text || 'Session listing failed.');
  const page = JSON.parse(result.content[0].text);
  console.log(JSON.stringify({ transport: 'stdio MCP', server: initialized.serverInfo, tools: catalog.tools.map(t => t.name),
    total: page.total, choices: page.sessions.map((s, index) => ({ choice: index + 1, sessionId: s.sessionId, title: s.title,
      projectDirectory: s.projectDirectory, modifiedAt: s.modifiedAt })), warnings: page.warnings }, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { server.stdin.end(); lines.close(); server.kill(); }
