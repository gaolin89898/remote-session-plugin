/**
 * bridge-test.mjs — session-bridge.js 离线自测。
 *
 * 运行：node research/bridge-test.mjs
 * 只读真实 ~/.dsh/sessions，不写任何文件、不改会话。
 *
 * 说明：仓库暂无 package.json（"type": "module"），因此 lib/session-bridge.js
 * 作为 .js 会被 Node 按 CJS 解析；本脚本先尝试常规 import，失败则用 data: URL
 * 按 ESM 载入（两者加载的是同一份源码）。一旦仓库加上 "type":"module"，常规
 * import 就会直接生效，无需改这个脚本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE_PATH = fileURLToPath(new URL('../lib/session-bridge.js', import.meta.url));

async function loadBridge() {
  try {
    return await import(pathToFileURL(BRIDGE_PATH).href);
  } catch (error) {
    const source = fs.readFileSync(BRIDGE_PATH, 'utf8');
    const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    console.log(`(note: 以 data:URL 载入 ESM — ${error.code || error.message})`);
    return mod;
  }
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
const short = (s, n = 64) => {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const {
  resolveDshHome,
  scanSessions,
  decodeSessionLogFileSync,
  eventsToMessages,
  findSessionFile,
} = await loadBridge();

const started = performance.now();
const home = resolveDshHome();
const tHome = performance.now();
const sessions = await scanSessions(home);
const tScan = performance.now();

console.log('=== session-bridge 自测 ===');
console.log(`DSH home   : ${home}`);
console.log(`扫描会话   : ${sessions.size} 个（${(tScan - tHome).toFixed(1)} ms）`);
check('扫描到会话', sessions.size > 0, `${sessions.size} 个`);

// 取最大的 2 个会话（内容最丰富），按文件大小排序
const picks = [...sessions.entries()]
  .map(([id, info]) => ({ id, ...info, size: fileSize(info.file) }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 2);

const decoded = [];
for (const [index, pick] of picks.entries()) {
  console.log(`\n--- [${index + 1}] ${pick.id}`);
  console.log(`    file    : ${pick.file}`);
  console.log(`    size    : ${(pick.size / 1024).toFixed(1)} KiB`);

  const t0 = performance.now();
  const { header, events } = decodeSessionLogFileSync(pick.file);
  const decodeMs = performance.now() - t0;

  const t1 = performance.now();
  const mapped = eventsToMessages(events);
  const mapMs = performance.now() - t1;

  console.log(`    header  : id=${header?.id} v=${header?.version} cwd=${short(header?.cwd, 40)}`);
  console.log(`    events  : ${events.length}（解码 ${decodeMs.toFixed(1)} ms）`);
  console.log(`    title   : ${mapped.title ? short(mapped.title, 50) : '(无)'}`);
  console.log(`    messages: total=${mapped.total}, 返回 ${mapped.messages.length}（映射 ${mapMs.toFixed(2)} ms）`);
  console.log('    最后 3 条：');
  for (const msg of mapped.messages.slice(-3)) {
    console.log(`      [${msg.seq}] ${msg.role.padEnd(9)} ${short(msg.text, 70)}`);
  }

  check(`[${index + 1}] header.id 与目录名一致`, header?.id === pick.id, `${header?.id} / ${pick.id}`);
  decoded.push({ pick, header, events, mapped });

  // findSessionFile 应能定位回同一文件
  check(`[${index + 1}] findSessionFile 命中`, findSessionFile(home, pick.id) === pick.file);

  // 映射选项行为
  const limited = eventsToMessages(events, { maxMessages: 5 });
  check(`[${index + 1}] maxMessages 生效`, limited.messages.length === Math.min(5, mapped.total), `总数${mapped.total} → ${limited.messages.length}`);
  const noTools = eventsToMessages(events, { includeTools: false });
  check(`[${index + 1}] includeTools=false 过滤工具行`, noTools.messages.every((m) => m.role !== 'tool'), `总数${mapped.total} → ${noTools.total}`);
  const truncated = eventsToMessages(events, { maxChars: 30 });
  check(`[${index + 1}] maxChars 截断加省略号`, truncated.messages.every((m) => typeof m.text !== 'string' || [...m.text].length <= 31), '<=31 码点');
  const withReasoning = eventsToMessages(events, { includeReasoning: true });
  check(`[${index + 1}] includeReasoning 增加内容`, withReasoning.total >= mapped.total, `${mapped.total} → ${withReasoning.total}`);
}

// 全局断言
check('至少一个会话解出 >0 条消息', decoded.some((d) => d.mapped.total > 0), decoded.map((d) => d.mapped.total).join('/'));
const titled = decoded.filter((d) => d.mapped.title);
check('存在非空标题（若有标题事件）', titled.length > 0 || decoded.every((d) => d.mapped.title === ''), `${titled.length}/${decoded.length} 个有标题`);

// tool 关联：callId → 工具名
const allToolRows = decoded.flatMap((d) => d.mapped.messages).filter((m) => m.role === 'tool');
const namedTools = allToolRows.filter((m) => m.tool?.name);
check('tool/result 能按 callId 关联到工具名', allToolRows.length === 0 || namedTools.length > 0, `${namedTools.length}/${allToolRows.length} 条带 name`);
check('tool/result 行带 isError 布尔', (() => {
  const resultRows = allToolRows.filter((m) => typeof m.text === 'string' && !m.text.startsWith('调用工具 '));
  return resultRows.length > 0 && resultRows.every((m) => typeof m.tool?.isError === 'boolean');
})(), `${allToolRows.filter((m) => typeof m.tool?.isError === 'boolean').length}/${allToolRows.length} 条结果行带 isError`);

// 容错断言
check('未知/空事件容错', (() => {
  const r = eventsToMessages([null, {}, { type: 'bogus' }, { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } }]);
  return r.total === 1 && r.messages[0].text === 'hi' && r.title === '';
})(), 'null/未知事件被跳过');
check('findSessionFile 非法 id 返回 null', findSessionFile(home, '../etc') === null && findSessionFile(home, '') === null);
check('scanSessions 容错不存在的 home', (await scanSessions(path.join(home, '__no_such_dir__'))).size === 0);

// ---- 回合错误（turn/end / assistant/attempt）映射 ----
const baseEvents = [
  { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: '跑一下' }] } },
  { type: 'assistant/attempt', seq: 2, time: 20, data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', error: { message: 'attempt 层错误', code: 'X' } } } }] } },
  { type: 'tool/call', seq: 3, time: 30, data: { callId: 'c1', name: 'ops_bash', arguments: '{}' } },
  {
    type: 'turn/end', seq: 4, time: 40,
    data: { reason: { kind: 'error', error: { message: 'no adapter registered for provider "opencode-go"', code: 'NO_ADAPTER' } } },
  },
];
const withError = eventsToMessages(baseEvents);
console.log('\n--- 回合错误映射（合成事件）');
console.log(`    total=${withError.total}, types=${withError.messages.map((m) => m.role).join(',')}`);
for (const msg of withError.messages.slice(-2)) console.log(`      [${msg.seq}] ${msg.role.padEnd(9)} ${short(msg.text, 80)}`);
const mainRows = withError.messages.filter((m) => m.role !== 'turn-end');
const last = mainRows.at(-1);
check('turn/end error → 最后一条为 system 错误行', last?.role === 'system' && last.text === '执行失败：no adapter registered for provider "opencode-go"', `${last?.role} / ${short(last?.text)}`);
check('system 错误行带 tool.isError=true 且参与 total', last?.tool?.isError === true && withError.total === 5, `total=${withError.total}`);
check('assistant/attempt finish error 也成行', withError.messages.some((m) => m.role === 'system' && m.text === '执行失败：attempt 层错误'), withError.messages.filter((m) => m.role === 'system').length + ' 条 system 行');
check('turn/end 出现在已有消息 seq 时仍保留', withError.messages.find((m) => m.seq === 4)?.role === 'system');

// 同 seq 去重：attempt 先到、turn/end 覆盖为权威版本
const dedup = eventsToMessages([
  { type: 'assistant/attempt', seq: 9, time: 1, data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', error: { message: '旧错误' } } } }] } },
  { type: 'turn/end', seq: 9, time: 2, data: { reason: { kind: 'error', error: { message: '新错误' } } } },
]);
const dedupRows = dedup.messages.filter((m) => m.role !== 'turn-end');
check('同 seq 只保留一条且以 turn/end 为准', dedupRows.length === 1 && dedupRows[0].text === '执行失败：新错误', `rows=${dedupRows.length}, text=${short(dedupRows[0]?.text)}`);

// 实测形状：attempt 用 reason.failure.message；attempt 与 turn/end 同文本相邻只保留一行
const failureShape = eventsToMessages([
  { type: 'assistant/attempt', seq: 1, time: 1, data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'pi-ai stream idle timeout', code: 'TIMEOUT' } } } }] } },
]);
check('attempt 兼容 reason.failure.message', failureShape.messages[0]?.text === '执行失败：pi-ai stream idle timeout', `${short(failureShape.messages[0]?.text)}`);
const adjacent = eventsToMessages([
  { type: 'assistant/attempt', seq: 834, time: 1, data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'same' } } } }] } },
  { type: 'turn/end', seq: 836, time: 2, data: { reason: { kind: 'error', error: { message: 'same' } } } },
]);
const adjacentRows = adjacent.messages.filter((m) => m.role !== 'turn-end');
check('attempt+turn/end 同文本相邻去重（以 turn/end 为准）', adjacentRows.length === 1 && adjacentRows[0].seq === 836, `rows=${adjacentRows.length}, seq=${adjacentRows[0]?.seq}`);

// 真实会话里若存在回合错误，映射结果必须出现 system 行
const realErrors = decoded.flatMap((d) => d.events.filter((e) =>
  (e.type === 'turn/end' && e.data?.reason?.kind === 'error')
  || (e.type === 'assistant/attempt' && Array.isArray(e.data?.stream) && e.data.stream.some((s) => (s?.chunk ?? s)?.type === 'finish' && (s?.chunk ?? s)?.reason?.kind === 'error')),
));
const realSystem = decoded.flatMap((d) => eventsToMessages(d.events, { maxMessages: Number.MAX_SAFE_INTEGER }).messages).filter((m) => m.role === 'system');
if (realErrors.length > 0) console.log(`    样例错误事件: ${short(JSON.stringify(realErrors.at(-1)), 200)}`);
console.log(`    真实会话回合错误事件: ${realErrors.length} 条，全量映射出 system 行 ${realSystem.length} 条（样本 ${decoded.map((d) => d.mapped.total).join('/')} 条消息）`);
check('真实会话错误事件 → system 行（若存在）', realErrors.length === 0 || realSystem.length > 0, `${realErrors.length} → ${realSystem.length}`);

const elapsed = performance.now() - started;
console.log(`\n总耗时 ${elapsed.toFixed(1)} ms · 断言 ${failures === 0 ? '全部通过' : `${failures} 个失败`}`);
process.exit(failures === 0 ? 0 : 1);
