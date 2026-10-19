import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { integer } from './sessions.mjs';

const REQUIRED = ['--safe-mode', '--resume', '--fork-session', '--tools', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--settings'];
const active = new Set();
export function runProcess(command, args, { cwd, input = '', timeoutMs = 120_000, signal, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('请求已取消，未启动Claude。'));
    if (/\.(cmd|bat)$/i.test(command)) return reject(new Error('请使用Claude原生可执行文件；本工具不通过shell执行.cmd/.bat。'));
    let child;
    try { child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }
    let stdout = '', stderr = '', outputSize = 0, stopReason, settled = false;
    const stop = reason => { if (!stopReason) { stopReason = reason; child.kill(); } };
    const timer = setTimeout(() => stop('Claude调用超时；投递或生成结果可能未知，请核对会话后再决定是否重试。'), timeoutMs);
    const abort = () => stop('Claude调用已取消；请求可能已经提交，请核对会话后再决定是否重试。');
    signal?.addEventListener('abort', abort, { once: true });
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    child.on('error', e => finish(new Error(`无法启动Claude（${e.code || '进程错误'}）；请检查CLAUDE_SESSION_LINK_BIN。`)));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { outputSize += Buffer.byteLength(data); if (outputSize > 4 * 1024 * 1024) stop('Claude输出超过4MiB，已停止；请核对结果，勿自动重试。'); else stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 64_000) stderr += data; });
    child.stdin.on('error', () => {});
    child.once('close', code => finish(stopReason ? new Error(stopReason) : null, { code, stdout, stderr }));
    child.stdin.end(input, 'utf8');
  });
}
export async function planQuestion(store, { sessionId, question, mode = 'fork', confirmIdle = false, expectedVersion, timeoutMs = 120_000 } = {}) {
  if (typeof question !== 'string' || !question.trim() || question.length > 50_000) throw new Error('question不能为空，且不能超过50000字符。');
  if (!['fork', 'resume'].includes(mode)) throw new Error('mode只能是fork或resume。');
  if (mode === 'resume' && confirmIdle !== true) throw new Error('写入原会话必须明确设置confirmIdle=true，并先停止在终端/VS Code中操作该会话；无法自动证明其空闲。');
  integer(timeoutMs, 1000, 300_000, 'timeoutMs');
  const session = await store.read(sessionId, { limit: 1 });
  if (expectedVersion && expectedVersion !== session.version) throw new Error('目标会话已变化；请重新读取后再发送。');
  if (!session.projectDirectory || !path.isAbsolute(session.projectDirectory)) throw new Error('会话缺少有效的本机工作目录，不能安全恢复。');
  const directory = await stat(session.projectDirectory).catch(() => null);
  if (!directory?.isDirectory()) throw new Error('会话的原工作目录在本机不存在；可能是WSL或远程会话。');
  const args = ['--print', '--resume', session.sessionId, '--output-format', 'json', '--safe-mode',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    '--no-chrome', '--permission-mode', 'dontAsk', '--settings', '{"disableAllHooks":true}'];
  if (mode === 'fork') args.push('--fork-session');
  return { sessionId: session.sessionId, title: session.title, projectDirectory: session.projectDirectory,
    sourceVersion: session.version, mode, question, command: process.env.CLAUDE_SESSION_LINK_BIN || 'claude', args,
    timeoutMs, effects: mode === 'fork' ? '联网调用Claude并产生新的分叉会话，消耗Claude额度；目标原会话不用于追加。' : '联网调用Claude并向原会话追加一轮，消耗Claude额度。',
    restriction: '纯文字模式；禁用内置工具、用户自定义扩展、其他MCP与hooks。CLI自身仍会写会话/运行记录，组织管理策略仍适用；这不是操作系统沙箱。',
    sent: false };
}
export async function askQuestion(store, options, { runner = runProcess, signal } = {}) {
  const plan = await planQuestion(store, options);
  if (options.send !== true) return plan;
  if (active.has(plan.sessionId)) throw new Error('本工具正在向该会话提问，请等当前请求结束。');
  active.add(plan.sessionId);
  try {
    const help = await runner(plan.command, ['--help'], { timeoutMs: 15_000, signal });
    if (help.code !== 0 || REQUIRED.some(flag => !help.stdout.includes(flag))) throw new Error('本机Claude缺少安全模式或恢复能力，已停止；不会降低限制自动重试。');
    await store.assertVersion(plan.sessionId, plan.sourceVersion);
    const reply = await runner(plan.command, plan.args, { cwd: plan.projectDirectory,
      input: `请针对这个会话中已有的任务回答下面的问题。本轮只做文字解释，不执行工具、不修改文件。\n\n${plan.question}`, timeoutMs: plan.timeoutMs, signal });
    if (reply.code !== 0) throw new Error(`Claude退出码${reply.code}；可能是认证、额度或恢复失败。请在Claude中核对后重试；为避免泄露本机信息，不回传原始stderr。`);
    let result;
    try { result = JSON.parse(reply.stdout); } catch { throw new Error('Claude没有返回预期JSON；请求可能已处理，勿自动重发。'); }
    if (result.is_error || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) throw new Error('Claude报告调用失败；请核对目标会话和额度，勿自动重发。');
    if (typeof result.result !== 'string' || typeof result.session_id !== 'string') throw new Error('Claude返回缺少正文或session ID；结果未知，勿自动重发。');
    if (plan.mode === 'fork' && result.session_id.toLowerCase() === plan.sessionId) throw new Error('Claude未确认分叉出新ID；请核对原会话，勿自动重发。');
    if (plan.mode === 'resume' && result.session_id.toLowerCase() !== plan.sessionId) throw new Error('Claude返回了不同会话ID；请核对，勿自动重发。');
    return { sent: true, mode: plan.mode, sourceSessionId: plan.sessionId, sessionId: result.session_id,
      answer: result.result, durationMs: result.duration_ms ?? null, costUsd: result.total_cost_usd ?? null,
      note: plan.mode === 'fork' ? '已创建分支；后续如需沿此问答继续，请使用返回的新sessionId，并明确选择resume及确认其空闲。' : '已向指定会话追加问答；原IDE面板未必立即刷新。' };
  } finally { active.delete(plan.sessionId); }
}
