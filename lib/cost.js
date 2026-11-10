'use strict';

/**
 * lib/cost.js —— 一个会话日志的美元计价，以及按会话 id 找它的日志文件。
 *
 * 计价口径与 usage-audit.js 完全一致（细则见 pricing.js 顶部注释）：
 *   - 模型取 assistant/message 的 source.model，缺失退回**最近一次** request/header；
 *   - 时间用该条消息自己的 event.time（同一会话跨高峰/非高峰时逐条变价）；
 *   - 四项 token 全 0 的消息不计量，也不因此标 unpriced；
 *   - 查不到单价 → usdOf 落 PRICE._default，同时 unpriced=true。
 *
 * route-check.js 的 --cost 与设置页的「最近委派」共用这里的累计器，避免两条
 * 计价路径算出不一样的数。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readSessionFile } = require('./session-log.js');
const { isPriced, usdOf } = require('./pricing.js');

function toCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function newCostState() {
  return { headerModel: null, usd: 0, unpriced: false };
}

function costAdd(state, event) {
  if (!event || typeof event !== 'object') return;

  if (event.type === 'request/header') {
    const config = event.data && event.data.header && event.data.header.config;
    const model = config && config.model;
    if (typeof model === 'string' && model.trim() !== '') state.headerModel = model.trim();
    return;
  }

  if (event.type !== 'assistant/message') return;
  const usage = event.data && event.data.usage;
  if (!usage || typeof usage !== 'object') return;

  const input = toCount(usage.inputTokens);
  const output = toCount(usage.outputTokens);
  const cacheRead = toCount(usage.cacheReadTokens);
  const cacheWrite = toCount(usage.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite <= 0) return;

  const source = event.data.message && event.data.message.source;
  const model = source && typeof source.model === 'string' && source.model.trim() !== ''
    ? source.model.trim()
    : state.headerModel;
  if (!isPriced(model)) state.unpriced = true;
  state.usd += usdOf({
    model,
    i: input,
    o: output,
    cr: cacheRead,
    cw: cacheWrite,
    t: event.time,
  });
}

/** 一次事件遍历算完一个会话的美元合计 */
function costOfEvents(events) {
  const state = newCostState();
  for (const event of events) costAdd(state, event);
  return state;
}

/**
 * 一遍遍历同时给出美元和 token 合计。`calls` 是**模型调用次数**（每条带 usage 的
 * assistant/message 算一次），不是 request/header 的条数——后者只标记上下文重置。
 * `header` 是**第一条** request/header 里的路由，也就是这个会话实际跑的模型。
 */
function summarizeEvents(events) {
  const state = newCostState();
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let header = null;

  for (const event of events) {
    costAdd(state, event);
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'request/header') {
      if (header !== null) continue;
      const config = event.data && event.data.header && event.data.header.config;
      if (!config || typeof config !== 'object') continue;
      header = {
        provider: typeof config.provider === 'string' ? config.provider : null,
        model: typeof config.model === 'string' ? config.model : null,
        effort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
      };
      continue;
    }

    if (event.type !== 'assistant/message') continue;
    const usage = event.data && event.data.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = toCount(usage.inputTokens);
    const output = toCount(usage.outputTokens);
    const cacheRead = toCount(usage.cacheReadTokens);
    const cacheWrite = toCount(usage.cacheWriteTokens);
    if (input + output + cacheRead + cacheWrite <= 0) continue;

    totals.calls += 1;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
  }

  return { usd: state.usd, unpriced: state.unpriced, ...totals, header };
}

// ─────────────────────────── 找到某个会话的日志 ───────────────────────────

/**
 * 会话日志的层级是 `<home>/sessions/<工作区 slug>/<会话 id>/session.v4.jsonl.zstd`。
 * 主会话的目录名带 `session-` 前缀，子代理直接用自己的 id；两者同层，所以按 id
 * 找日志只需扫这一层。
 */
const LOG_NAME = 'session.v4.jsonl.zstd';
const SCAN_TTL_MS = 5_000;
let scanCache = { home: null, at: 0, byId: new Map() };

function scanSessions(home) {
  if (scanCache.home === home && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.byId;

  const byId = new Map();
  let slugs = [];
  try {
    slugs = fs.readdirSync(path.join(home, 'sessions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(home, 'sessions', entry.name));
  } catch {
    slugs = [];
  }

  for (const slugDir of slugs) {
    let entries = [];
    try {
      entries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(slugDir, entry.name, LOG_NAME);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue; // 子会话目录可能刚建、日志还没落盘
      }
      byId.set(entry.name, { file, name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  scanCache = { home, at: Date.now(), byId };
  return byId;
}

/** 子会话 id（不带 `session-` 前缀也能匹配）→ 日志文件；找不到返回 null。 */
function findSessionLog(sessionId, home) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return null;
  const byId = scanSessions(home);
  return byId.get(id) ?? byId.get(`session-${id}`) ?? byId.get(id.replace(/^session-/, '')) ?? null;
}

// 计价比读日志要贵（解压 + 逐行 JSON）。按「文件 + 大小 + mtime」缓存结果：
// 子会话在跑的时候日志一直在长，键变了就重算，静止时不再重复解压。
const MAX_BYTES_DEFAULT = 48 * 1024 * 1024;
const COST_TTL_MS = 8_000;
let costCache = new Map();

/**
 * 一个会话的花费。
 *
 * @returns {{status:'ok', usd:number, unpriced:boolean, calls:number, input:number,
 *            output:number, cacheRead:number, cacheWrite:number, file:string, bytes:number}}
 *        | {status:'missing'}  日志找不到（会话还没起执行，或已被清掉）
 *        | {status:'too-large', bytes:number}  日志超过上限，放弃解压
 *        | {status:'unreadable', reason:string}
 */
function costOfSession(sessionId, { home, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  const found = findSessionLog(sessionId, home);
  if (found === null) return { status: 'missing' };
  if (found.bytes > maxBytes) return { status: 'too-large', bytes: found.bytes };

  const key = `${found.file}:${found.bytes}:${found.mtimeMs}`;
  const hit = costCache.get(key);
  if (hit && Date.now() - hit.at < COST_TTL_MS) return hit.value;

  let decoded;
  try {
    decoded = readSessionFile(found.file);
  } catch (error) {
    return { status: 'unreadable', reason: String(error?.message ?? error) };
  }

  const value = {
    status: 'ok',
    ...summarizeEvents(decoded.events),
    file: found.file,
    bytes: found.bytes,
  };
  // 缓存只留最近几十个键，避免长时间运行后攒成一坨
  if (costCache.size > 64) costCache = new Map();
  costCache.set(key, { at: Date.now(), value });
  return value;
}

/** 日志文件的默认根目录：环境变量优先，回落到 ~/.dsh。 */
function defaultHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

module.exports = {
  toCount,
  newCostState,
  costAdd,
  costOfEvents,
  summarizeEvents,
  findSessionLog,
  costOfSession,
  defaultHome,
  MAX_BYTES_DEFAULT,
};
