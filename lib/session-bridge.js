/**
 * session-bridge.js — DSH 跨端会话插件 Host 端的「文件级」会话读取桥。
 *
 * 只依赖 node 内置模块（fs / path / os / zlib），不依赖 DSH ctx 服务，
 * 因此可离线测试。职责：
 *   1. resolveDshHome()   解析 DSH home
 *   2. scanSessions()     枚举 sessions/*\/*\/session[.vN].jsonl[.zstd]
 *   3. decodeSessionLogFileSync()  jsonl(.zstd) 多帧解码 → {header, events}
 *   4. eventsToMessages() 事件流 → UI 用紧凑消息列表
 *   5. findSessionFile()  按 sessionId 定位单个会话文件
 *
 * 关键事实（见 research/host-session-api.md）：
 *   - 会话目录名就是 sessionId（两种历史命名 `session-<uuid>` 与 `<uuid>` 并存）。
 *   - 每代格式文件（session.jsonl / session.vN.jsonl）都是**完整日志**，从 seq 0 开始；
 *     取最高 N 即为当前可读版本。
 *   - `.zstd` 日志是**追加式多帧**：node:zlib 的 zstdDecompressSync 只解第一帧，
 *     必须按 zstd 帧边界切分后逐帧解压。
 *   - 会话目录可能带 session.lock 等非数据文件，只匹配 session 日志文件名。
 *
 * 所有函数容错：文件/目录不存在、帧损坏、行 JSON 损坏、未知事件类型 → 跳过不抛。
 * 唯一例外：decodeSessionLogFileSync() 的目标文件不存在时直接抛（显式找不到文件）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd 帧魔数（磁盘字节序 28 B5 2F FD）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 合法日志文件名：session.jsonl / session.vN.jsonl，可带 .zstd 后缀。 */
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/** 解析 DSH home：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/* ------------------------------------------------------------------ *
 * 目录扫描
 * ------------------------------------------------------------------ */

/** 同步读取一个会话目录里版本最高的日志文件。损坏/不存在返回 null。 */
function pickSessionFileSync(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;
    const version = m[1] === undefined ? 0 : Number(m[1]);
    const isZstd = m[2] === '.zstd';
    // 版本高者优先；同版本优先压缩文件（更常见）。
    if (!best || version > best.version || (version === best.version && isZstd && !best.isZstd)) {
      best = { file: path.join(dir, name), version, isZstd };
    }
  }
  return best;
}

function isDirectorySync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function addScanned(out, sessionDir, best) {
  const sessionId = path.basename(sessionDir);
  if (!sessionId) return;
  let updatedAt = 0;
  try {
    updatedAt = fs.statSync(best.file).mtimeMs;
  } catch {
    updatedAt = 0;
  }
  out.set(sessionId, { file: best.file, dir: sessionDir, updatedAt });
}

/**
 * 扫描 `sessions/<workspace-slug>/<session-dir>/` 下所有会话。
 * 兼容 `<session-dir>` 直接位于 `sessions/` 下的布局，以及 workspace 层本身
 * 就是一个会话目录的异常布局。
 * @param {string} dshHome
 * @returns {Promise<Map<string, {file: string, dir: string, updatedAt: number}>>}
 */
export async function scanSessions(dshHome) {
  const out = new Map();
  const root = path.join(dshHome, 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 没有 sessions 目录 → 空 Map
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(root, entry.name);
    // (a) 该层直接是会话目录
    const direct = pickSessionFileSync(workspaceDir);
    if (direct) {
      addScanned(out, workspaceDir, direct);
      continue;
    }
    // (b) 正常两层布局：sessions/<workspace-slug>/<session-dir>
    let children;
    try {
      children = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const sessionDir = path.join(workspaceDir, child.name);
      const best = pickSessionFileSync(sessionDir);
      if (best) addScanned(out, sessionDir, best);
    }
  }
  return out;
}

/** 校验 sessionId：拒绝空值、路径分隔符与向上穿越。 */
function safeSessionId(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const id = sessionId.trim();
  if (!id || id === '.' || id === '..') return null;
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return null;
  return id;
}

/**
 * 按 sessionId 定位会话文件；不存在/非法 id 返回 null。
 * 兼容两种目录命名，并在调用方只给裸 uuid 时尝试历史 `session-<uuid>` 目录。
 * @param {string} dshHome
 * @param {string} sessionId
 * @returns {string|null}
 */
export function findSessionFile(dshHome, sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const root = path.join(dshHome, 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = new Set();
  const add = (dir) => {
    if (isDirectorySync(dir)) candidates.add(dir);
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(root, entry.name);
    add(path.join(workspaceDir, id));
    add(workspaceDir); // workspace 层本身即会话目录的布局
    if (!id.startsWith('session-')) add(path.join(workspaceDir, `session-${id}`));
  }
  for (const dir of candidates) {
    if (path.basename(dir) !== id && path.basename(dir) !== `session-${id}`) continue;
    const best = pickSessionFileSync(dir);
    if (best) return best.file;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * zstd 多帧解码
 * ------------------------------------------------------------------ */

const hasZstd = typeof zlib.zstdDecompressSync === 'function';

function isZstdBuffer(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * 计算从 `offset` 开始的完整 zstd 帧的结束偏移。
 * 帧头解析见 RFC 8878：magic + 帧头描述符 + [window] + [dictID] + [contentSize]，
 * 随后是若干 block（3 字节小端头：bit0 last、bit1-2 type、其余 size）。
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {number}
 */
function zstdFrameEnd(buf, offset) {
  let p = offset + 4; // magic
  const descriptor = buf[p++];
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictFlag = descriptor & 3;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  p += (singleSegment ? 0 : 1) + dictBytes + fcsBytes;
  for (;;) {
    const header = buf.readUIntLE(p, 3);
    p += 3;
    const blockType = (header >>> 1) & 3;
    // RLE block 的 payload 只有 1 字节；raw/compressed 用 block size。
    p += blockType === 1 ? 1 : header >>> 3;
    if (header & 1) break;
  }
  return checksum ? p + 4 : p;
}

/**
 * 逐帧解压整个 `.zstd` 日志。遇到撕裂尾/损坏帧时**保留已解出的前缀**。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function decodeZstdFramesTolerant(buf) {
  if (!hasZstd) throw new Error('当前 Node 不支持 zstd（需要 node:zlib.zstdDecompressSync，Node >= 22.15）');
  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 4 || !isZstdBuffer(buf.subarray(offset))) break; // 撕裂尾
    let end;
    try {
      end = zstdFrameEnd(buf, offset);
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offset, end)));
    } catch {
      break; // 损坏帧：丢弃该帧及之后内容，保留前缀
    }
    offset = end;
  }
  return Buffer.concat(chunks);
}

/**
 * 解析一个会话日志文件（`.jsonl` 或 `.jsonl.zstd`）。
 * @param {string} file 绝对/相对路径
 * @returns {{header: object|null, events: object[]}}
 * @throws 目标文件不存在时抛 ENOENT（显式找不到文件）；其余错误尽量降级。
 */
export function decodeSessionLogFileSync(file) {
  const buf = fs.readFileSync(file); // 文件不存在 → 显式抛错
  let text = '';
  try {
    text = isZstdBuffer(buf) ? decodeZstdFramesTolerant(buf).toString('utf8') : buf.toString('utf8');
  } catch {
    return { header: null, events: [] };
  }

  const values = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 坏行跳过
    }
    if (parsed && typeof parsed === 'object') values.push(parsed);
  }

  // v4 日志首行是 {"type":"session",...} 的 header（非事件）；其余每行一个 SessionEvent。
  const header = values.length > 0 && values[0].type === 'session' ? values[0] : null;
  return { header, events: header ? values.slice(1) : values };
}

/** Harness-injected user-role records that render as context rows, not prompts. */
function isContextInjection(text) {
  return (
    typeof text === 'string' &&
    /^(Current runtime context\.|Time sampled while preparing turn|\[model changed:|This is an automated|The following context)/u.test(
      text.trimStart(),
    )
  );
}

/**
 * 读取原始 SessionEvent 序列（官方 conversation assembler 的输入）。
 * @param {string} dshHome dsh 根目录
 * @param {string} sessionId 会话 id
 * @param {{limit?: number}} options limit 默认 4000，超出保留最后 N 条
 * @returns {Array<{seq:number,type:string,time:number,data:object}>|null}
 */
export function readSessionEventsSync(dshHome, sessionId, options = {}) {
  const file = findSessionFile(dshHome, sessionId);
  if (!file) return null;
  const { events } = decodeSessionLogFileSync(file);
  const items = [];
  for (const event of events) {
    if (!event || typeof event.seq !== 'number' || typeof event.type !== 'string') continue;
    // 客户端会话 API 会为每个事件计算 surfaceOp（日志本身不存）；追加写入的
    // 历史按 append 处理，压缩检查点等替换事件标记为 replace。
    const sourceKind = event.data && event.data.source && event.data.source.kind;
    const surfaceOp = sourceKind === 'compact-checkpoint' ? undefined : 'append';
    items.push({
      seq: event.seq,
      type: event.type,
      time: typeof event.time === 'number' ? event.time : 0,
      data: event.data && typeof event.data === 'object' ? event.data : {},
      ...(surfaceOp ? { surfaceOp } : {}),
    });
  }
  items.sort((left, right) => left.seq - right.seq);
  const limit = Number(options.limit) || 4000;
  return items.length > limit ? items.slice(items.length - limit) : items;
}

/* ------------------------------------------------------------------ *
 * 事件 → UI 消息
 * ------------------------------------------------------------------ */

/** 截断到 maxChars 个 Unicode 码点，超出加省略号。 */
function truncateText(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) return text;
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

/**
 * 提取 message content 里的文本。
 * @param {unknown} content 数组（text part）或字符串
 * @param {{withReasoning?: boolean}} options
 */
function contentText(content, options = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (options.withReasoning && part.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join(options.withReasoning ? '\n' : '');
}

/**
 * 把会话事件流映射成 UI 用的紧凑消息列表。
 *
 * @param {object[]} events decodeSessionLogFileSync().events
 * @param {{maxMessages?: number, maxChars?: number, includeReasoning?: boolean, includeTools?: boolean}} [opts]
 * @returns {{title: string, messages: Array<{seq:number, at:number, role:'user'|'assistant'|'tool'|'system', text:string, tool?:{name?:string, isError?:boolean}}>, total: number}}
 */
export function eventsToMessages(events, opts = {}) {
  const {
    maxMessages = 120,
    maxChars = 2000,
    includeReasoning = false,
    includeTools = true,
  } = opts || {};

  const list = Array.isArray(events) ? events : [];
  const callNames = new Map(); // callId → 工具名（tool/call 事件通常先于 tool/result）
  const toolRows = new Map(); // callId → 已推送的 tool/call 行（结果到达时合并到同一行）
  const messages = [];
  const systemErrorAt = new Map(); // seq → messages 下标（同 seq 只保留一条 system 错误行）
  let title = '';
  let turnStartAt = 0; // turn/start 的 time，用于「已完成，用时 X」
  let currentStep = 0; // step/start 的序号（官方按 step 分组过程活动）

  // 回合执行失败行：turn/end 的 reason.kind==='error'，或 assistant/attempt 流里的
  // finish 错误。同 seq 去重：turn/end 为准（authoritative），attempt 先到时被替换；
  // 实测 attempt 错误后紧跟同文本 turn/end（不同 seq），此时也以 turn/end 覆盖前一行。
  const addSystemError = (seq, at, message, authoritative) => {
    const detail = typeof message === 'string' && message.trim() ? message.trim() : '未知错误';
    const row = {
      seq,
      at,
      role: 'system',
      text: truncateText(`执行失败：${detail}`, maxChars),
      tool: { isError: true },
    };
    const existing = systemErrorAt.get(seq);
    if (existing !== undefined) {
      if (authoritative) messages[existing] = row;
      return;
    }
    const prev = messages[messages.length - 1];
    const sameAsPrev = prev && prev.role === 'system' && prev.tool?.isError === true && prev.text === row.text;
    if (sameAsPrev) {
      // attempt 与 turn/end 重复描述同一次失败：turn/end 权威，直接复用/替换上一行
      if (authoritative) messages[messages.length - 1] = row;
      return;
    }
    systemErrorAt.set(seq, messages.length);
    messages.push(row);
  };

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const seq = typeof event.seq === 'number' ? event.seq : messages.length;
    const at = typeof event.time === 'number' ? event.time : 0;

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
        break;
      }
      case 'user/message': {
        const text = contentText(data.content);
        if (!text) break;
        // Harness-injected user-role records (runtime context, time sampling,
        // model switches) are context rows in the official flow, not prompts.
        const sourceKind = data && data.source && data.source.kind;
        const reminderInjection = /^<hindsight_[a-z_]+>/i.test(text.trim());
        const injected =
          reminderInjection
          || (typeof sourceKind === 'string' && sourceKind !== 'user' && sourceKind !== 'steering')
          || isContextInjection(text);
        const role = injected ? 'context' : 'user';
        messages.push({ seq, at, role, text: truncateText(text, maxChars) });
        break;
      }
      case 'turn/start': {
        turnStartAt = at;
        currentStep = 0;
        break;
      }
      case 'step/start': {
        currentStep = Number(data.step) || currentStep + 1;
        break;
      }
      case 'assistant/message': {
        const message = data.message && typeof data.message === 'object' ? data.message : data;
        if (includeReasoning && Array.isArray(message.content)) {
          const reasoningParts = message.content.filter((part) => part && part.type === 'reasoning');
          const reasoningText = contentText(reasoningParts);
          if (reasoningText && reasoningText.trim()) {
            messages.push({ seq, at, role: 'reasoning', step: currentStep, text: truncateText(reasoningText.trim(), maxChars) });
          }
        }
        const text = contentText(message.content);
        if (!text) break; // 纯 tool-call / 纯 reasoning 的消息不成条
        messages.push({ seq, at, role: 'assistant', step: currentStep, text: truncateText(text, maxChars) });
        break;
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' && data.name ? data.name : '';
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId && name) callNames.set(callId, name);
        if (!includeTools) break;
        const tool = { isError: false, done: false };
        if (name) tool.name = name;
        if (callId) tool.callId = callId;
        const argsText =
          typeof data.arguments === 'string'
            ? data.arguments
            : data.arguments && typeof data.arguments === 'object'
              ? JSON.stringify(data.arguments)
              : '';
        if (argsText) tool.args = truncateText(argsText, Math.max(200, Math.floor(maxChars / 2)));
        // 人类可读的活动详情（官方 live detail）：优先取命令/路径/模式等字段
        try {
          const parsedArgs = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
          if (parsedArgs && typeof parsedArgs === 'object') {
            for (const field of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description', 'content']) {
              const value = parsedArgs[field];
              if (typeof value === 'string' && value.trim()) {
                tool.detail = truncateText(value.replace(/\s+/gu, ' ').trim(), 160);
                break;
              }
            }
          }
        } catch {
          /* 参数不是 JSON 时用参数原文 */
        }
        if (!tool.detail && argsText) tool.detail = truncateText(argsText.replace(/\s+/gu, ' ').trim(), 160);
        const row = {
          seq,
          at,
          step: currentStep,
          role: 'tool',
          text: truncateText(argsText || `调用工具 ${name || 'unknown'}`, maxChars),
          tool,
        };
        if (callId) toolRows.set(callId, row);
        messages.push(row);
        break;
      }
      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : data;
        if (!includeTools) break;
        const contentTextValue = contentText(message.content);
        const callIdFromMessage = typeof message.toolCallId === 'string' ? message.toolCallId : data.callId;
        const callId = typeof callIdFromMessage === 'string' ? callIdFromMessage : '';
        const name = callId ? callNames.get(callId) : undefined;
        const existing = callId ? toolRows.get(callId) : undefined;
        if (existing) {
          // 同一个工具调用只保留一行：call 行补上结果与状态。
          existing.text = truncateText(contentTextValue, maxChars);
          existing.tool.isError = Boolean(message.isError);
          existing.tool.done = true;
          break;
        }
        const tool = { isError: Boolean(message.isError), done: true };
        if (name) tool.name = name;
        if (callId) tool.callId = callId;
        messages.push({ seq, at, step: currentStep, role: 'tool', text: truncateText(contentTextValue, maxChars), tool });
        break;
      }
      case 'turn/end': {
        const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
        if (reason.kind === 'error') {
          // 实测 turn/end 用 reason.error.message；attempt 用 reason.failure.message，两者都兼容。
          const message = reason.error?.message ?? reason.failure?.message ?? reason.message;
          addSystemError(seq, at, message, true);
        }
        const durationMs = turnStartAt > 0 && at > 0 ? Math.max(0, at - turnStartAt) : 0;
        messages.push({
          seq,
          at,
          role: 'turn-end',
          turn: Number(data.turn) || 0,
          durationMs,
          reason: typeof reason.kind === 'string' ? reason.kind : 'done',
        });
        turnStartAt = 0;
        break;
      }
      case 'assistant/attempt': {
        const stream = Array.isArray(data.stream) ? data.stream : [];
        for (const entry of stream) {
          if (!entry || typeof entry !== 'object') continue;
          const chunk = entry.chunk && typeof entry.chunk === 'object' ? entry.chunk : entry;
          if (!chunk || chunk.type !== 'finish') continue;
          const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : {};
          if (reason.kind !== 'error') continue;
          const message = reason.error?.message ?? reason.failure?.message ?? chunk.message;
          addSystemError(seq, at, message, false);
          break; // 一次 attempt 只取第一条 finish 错误
        }
        break;
      }
      default:
        break; // 未知事件类型静默跳过
    }
  }

  const total = messages.length;
  return {
    title,
    messages: total > maxMessages ? messages.slice(total - maxMessages) : messages,
    total,
  };
}

export default {
  resolveDshHome,
  scanSessions,
  decodeSessionLogFileSync,
  eventsToMessages,
  findSessionFile,
};
