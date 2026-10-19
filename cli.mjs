#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { SessionStore } from './lib/sessions.mjs';
import { askQuestion } from './lib/ask.mjs';
import { startMcp } from './lib/mcp.mjs';

const HELP = `Claude Session Link — 零依赖、本机Claude Code会话工具

  node.exe cli.mjs list [--query 关键词] [--project 项目路径] [--limit 20] [--offset 0]
  node.exe cli.mjs read --session 完整UUID [--limit 30] [--offset 0] [--view current|all]
  node.exe cli.mjs updates --session 完整UUID [--cursor 上次返回的cursor] [--initial-limit 10]
  node.exe cli.mjs ask --session 完整UUID --question "继续问的问题" [--send]
  node.exe cli.mjs ask --session 完整UUID --question-file UTF8文件 [--send]
  node.exe cli.mjs mcp

通用：--claude-home 自定义Claude配置目录（包含projects目录）
ask默认仅预览；--send才联网、消耗Claude额度并保存新分支。
如需写原会话：--mode resume --confirm-idle --send（必须先让目标空闲）。
--expected-version 使用read返回的version核对目标是否变化。
不改VS Code设置、不装依赖、不自动注册MCP、不创建后台服务。
`;
function parse(argv) {
  const [command = 'help', ...args] = argv;
  const booleans = new Set(['send', 'confirm-idle', 'include-tools']);
  const allowed = {
    list: ['query', 'project', 'limit', 'offset'],
    read: ['session', 'limit', 'offset', 'view', 'include-tools'],
    updates: ['session', 'cursor', 'limit', 'initial-limit'],
    ask: ['session', 'question', 'question-file', 'mode', 'confirm-idle', 'send', 'expected-version', 'timeout-ms'],
    mcp: [],
  };
  if (['help', '--help', '-h'].includes(command)) return { command: 'help', options: {} };
  if (!Object.hasOwn(allowed, command)) throw new Error('未知命令；使用--help查看用法。');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || ![...allowed[command], 'claude-home'].includes(key)) throw new Error(`未知选项：${args[i]}`);
    if (Object.hasOwn(options, key)) throw new Error(`重复选项：--${key}`);
    if (booleans.has(key)) options[key] = true;
    else { if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`--${key}缺少值`); options[key] = args[++i]; }
  }
  return { command, options };
}
try {
  const { command, options: o } = parse(process.argv.slice(2));
  const store = new SessionStore(o['claude-home']);
  const num = key => o[key] === undefined ? undefined : Number(o[key]);
  let result;
  if (command === 'help') console.log(HELP);
  else if (command === 'mcp') startMcp(store);
  else {
    if (command === 'list') result = await store.list({ query: o.query, project: o.project, limit: num('limit'), offset: num('offset') });
    if (command === 'read') result = await store.read(o.session, { limit: num('limit'), offset: num('offset'), view: o.view, includeTools: Boolean(o['include-tools']) });
    if (command === 'updates') result = await store.updates(o.session, { cursor: o.cursor, limit: num('limit'), initialLimit: num('initial-limit') });
    if (command === 'ask') {
      if (o.question !== undefined && o['question-file']) throw new Error('--question和--question-file只能选一个。');
      const question = o['question-file'] ? (await readFile(o['question-file'], 'utf8')).replace(/^\uFEFF/, '') : o.question;
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      result = await askQuestion(store, { sessionId: o.session, question, mode: o.mode, send: Boolean(o.send),
        confirmIdle: Boolean(o['confirm-idle']), expectedVersion: o['expected-version'], timeoutMs: num('timeout-ms') }, { signal: controller.signal });
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
