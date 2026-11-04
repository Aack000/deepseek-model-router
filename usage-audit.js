#!/usr/bin/env node
'use strict';

/**
 * dsh/usage-audit.js —— 汇总 DSH 会话日志里的 token 用量；--cost 时再按价表估美元
 *
 * 用法：
 *   node dsh/usage-audit.js [--dir <path>] [--since <ISO 时间>] [--json] [--cost]
 *     --dir     会话日志根目录，默认 $DSH_HOME/sessions，否则 ~/.dsh/sessions
 *     --since   只保留「该时间之后还有事件」的会话（按事件里的 time，毫秒时间戳）；
 *               纯日期 YYYY-MM-DD 按本地 00:00 解析，带时间的写法按 Date.parse；
 *               命中后仍统计该会话的全部事件（会话级过滤，不是事件级过滤）
 *     --json    输出 {"sessions":[...],"total":{...}}
 *     --cost    附带美元：表格末尾多一列 $（会话合计），--json 每个会话/合计多一个 usd。
 *               不带 --cost 时输出与以前逐字节相同（不算价、不加键）
 *
 * 美元计价（口径见 lib/pricing.js，从 Claude Code 版 CMR 的 plugins/usage/usage-audit.js 搬来）：
 *   价表 PRICE[模型] = [输入, 输出, 读缓存, 写缓存（5 分钟）]，单位 **$/百万 token**，都是高峰价。
 *   分时计价：deepseek-flash / deepseek-v4-flash / deepseek-v4-pro 在**非高峰减半**；
 *   DeepSeek 高峰 = 周一到周五 UTC 01–04 点、06–10 点（北京 9–12 点、14–18 点），其余时间
 *   （含周末）非高峰。
 *   每条 assistant/message 用**它自己事件里的 time** 判高峰/非高峰、用它自己的模型查价：
 *   usd = k * (i*pi + o*po + cr*pr + cw*pw) / 1e6，k = 非高峰且属于上面三个模型 ? 0.5 : 1。
 *   所以同一次会话跨高峰/非高峰时，单价逐条变化（不是拿会话开始时间一把算）。
 *   查价先原样查，再去掉末尾 -YYYYMMDD 日期后缀查；都没有就用 _default = [5, 25, 0.5, 6.25]，
 *   该会话的 $ 后面标 *，表格下方给一行说明。
 *   已知偏差：DeepSeek 官方对**法定节假日**全天算非高峰，这里不认节假日，那几天会按高峰**多估**。
 *
 * 数据源：<dir>/<工作区 slug>/<会话目录>/session.v4.jsonl.zstd
 *   帧解析 / 解压 / 事件切分已抽到 lib/session-log.js（本文件只做统计与输出），
 *   下面这段切帧说明仍适用，细节见该模块。
 *   坑：一个日志文件是**多个 zstd 帧拼接**的（实测 500KB 的文件里有 200+ 帧）。
 *   zlib.zstdDecompressSync(整个文件) 只解第一帧、而且**不报错**，
 *   直接解整块只能读到一行 session 头，会误以为日志是空的。
 *   所以这里必须逐帧切分、逐帧解压后拼接。
 *
 *   切帧**不能**靠扫 zstd magic，也**不能**拿 decode(start, EOF) 当某一帧的真值：
 *   zstdDecompressSync 在「首帧明文长度恰为 131072（zstd 单块上限）的整数倍」时会越过
 *   帧边界继续解出后续帧（Node 24.11 实测：首帧明文 131071 字节不泄漏，131072 字节泄漏出
 *   第二帧）。于是 truth 含后面所有帧 → 每个候选边界都比不上 → 整批事件被重复统计
 *   （TOTAL 虚高、退出码仍是 0、只有一条弱告警）。这里改成**按 RFC 8878 精确解析帧结构**：
 *   从 magic 开始读帧头各长度字段，再按 3 字节块头逐块跳过负载，得到该帧的**精确字节范围**，
 *   只对 buf.subarray(start, end) 做单帧解压——不依赖任何未文档化行为。
 *
 *   截断判定因此也是精确的：解析器只在「一整帧刚好在 buf 末尾结束」时认为该帧完整；帧头
 *   字段越界、块循环没走完（缺下一个块头）、块负载越界都只可能是物理截断。截断时用
 *   decode(subarray(start, EOF)) 尽力解出已完成块的前缀（宁可少算），并且必须告警。
 *   skippable frame（magic 0x184D2A50..0x184D2A5F）按自带长度整体跳过，不参与统计。
 *
 * 输出约定：
 *   - JSON 的 models 数组 = 本会话出现过的不同模型，按**首次出现顺序去重**（models[0]
 *     与表格里的基名一致）；token 不按模型分桶。
 *   - <unreadable>：一个可解析事件都没有（0 字节 / 非 zstd / 全是坏行）；
 *     unknown：有事件但没有 request/header（例如只写了 session 头），所以没有模型信息。
 *   - 表格的 A(+N)：本会话还出现过 N 个**不同**模型（N = 不同模型数 - 1）；该行的
 *     req/in/out/cacheRead/cacheWrite 仍是**整个会话的合计，不是 A 这个模型的用量**。
 *   - --cost 的 $ 列：该会话的美元合计（同样不是某个模型的），TOTAL 行是全部会话的总价；
 *     金额 <$0.01 给 4 位小数，否则 2 位（$0.0012 / $1.50）；$ 后面带 * 表示该会话里有消息
 *     按 _default 估的价（价表里没有这个模型），表格下方会给一行说明。
 *
 * 已知限制：日志在 EOF 处被物理截断时，已完成块里的事件仍会计入统计，但被切掉的尾部无从
 * 恢复（会告警「truncated ... tail may be undercounted」）；中段损坏（帧头/块头不合法）
 * 之后无法可靠定位下一帧，只保留已解析部分并告警，不再猜。
 *
 * 运行时前提：需要 zlib 的 zstd 支持（Node >= 22.15）。启动时自检（见 checkZstdRuntime）：
 *   1) zstdCompressSync / zstdDecompressSync 存在；
 *   2) 回归探针：compress('a' * 131072) + compress('b') 里，用本文件的帧解析器切出的
 *      **第一帧范围**解压后必须恰好 131072 字节（不是 131073）。这条防的正是上面那个
 *      泄漏：只要切帧退化成「解到 EOF」，就会把下一帧内容吃进来 → 事件被重复统计。
 *      自检不过直接 exit 1，不带着错的前提继续算。
 *
 * 事件（每行一个 {type, seq, time, data}）：
 *   request/header     → data.header.config.{provider, model}
 *   assistant/message  → data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
 *                        计价用的模型取 data.message.source.model，没有就退回最近一次
 *                        request/header 的模型（同一会话中途换模型时按消息各算各的）
 *   注意 step/end、turn/end 里没有用量，别去那儿找。
 *
 * 退出码：0 正常；1 目录不存在/运行时前提不满足（无 zstd、或帧解析自检不过）；2 参数错误
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');
const process = require('node:process');

const { decodeSessionLog, parseEvents, ZSTD_BLOCK, parseFrame, FRAME_OK } = require('./lib/session-log.js');
const { PRICE, isPriced, usdOf } = require('./lib/pricing.js');

const USAGE = 'usage: node dsh/usage-audit.js [--dir <path>] [--since <ISO time>] [--json] [--cost]';
const LOG_FILE = 'session.v4.jsonl.zstd';
/** --cost 的 _default 说明行：价格从 PRICE._default 生成，避免手抄成第二份 */
const COST_DEFAULT_NOTE = `* 单价表里没有，按默认价 ${PRICE._default.map((value) => `$${value}`).join('/')} 估`;
/** 金额小数位：小于 $0.01 给 4 位小数（$0.0012），否则 2 位（$1.50）；TOTAL 同规则 */
const COST_SMALL_USD = 0.01;
/** 纯日期形式：按本地 00:00 解析，不走 Date.parse 的 UTC 语义 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 递归找日志的深度上限：sessions/<slug>/<session>/file 只要 2 层，留点余量 */
const MAX_WALK_DEPTH = 4;
const SESSION_ID_PREFIX = 'session-';

class UsageError extends Error {}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

/**
 * 解析 --since：纯日期（YYYY-MM-DD）按**本地** 00:00:00 解释（Date.parse 会按 UTC，
 * UTC+8 机器上会等于当天 08:00，把 00:00-07:59 整段漏掉）；带时间或时区的写法保持
 * Date.parse 语义。
 */
function parseSince(value) {
  const match = DATE_ONLY_RE.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const local = new Date(year, month - 1, day, 0, 0, 0, 0);
    // 拒绝 2026-13-40 这类会被 Date 自动进位的写法
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
      throw new UsageError(`invalid --since date: ${value}`);
    }
    return local.getTime();
  }

  const sinceMs = Date.parse(value);
  if (!Number.isFinite(sinceMs)) throw new UsageError(`invalid --since time: ${value}`);
  return sinceMs;
}

function parseArgs(argv) {
  const opts = { dir: null, sinceMs: null, json: false, cost: false };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    let name = raw;
    let value = null;

    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq > 2) {
        name = raw.slice(0, eq);
        value = raw.slice(eq + 1);
      }
    }

    if (name === '--json' && value === null) {
      opts.json = true;
      continue;
    }

    if (name === '--cost' && value === null) {
      opts.cost = true;
      continue;
    }

    if (name === '--dir' || name === '--since') {
      if (value === null) {
        const next = argv[i + 1];
        // 漏写值（--dir --json）不能被当成把 --json 当路径
        if (next === undefined || next.startsWith('--')) throw new UsageError(`missing value for ${name}`);
        i += 1;
        value = next;
      }
      if (value === '') throw new UsageError(`empty value for ${name}`);

      if (name === '--dir') {
        opts.dir = value;
      } else {
        opts.sinceMs = parseSince(value);
      }
      continue;
    }

    throw new UsageError(`unknown argument: ${raw}`);
  }

  return opts;
}

function resolveSessionsDir(opts) {
  if (opts.dir) return { dir: path.resolve(opts.dir), fromDefault: false, dshHome: null };

  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const home = envHome !== '' ? envHome : path.join(os.homedir(), '.dsh');
  return {
    dir: path.resolve(path.join(home, 'sessions')),
    fromDefault: true,
    dshHome: envHome !== '' ? path.resolve(envHome) : null,
  };
}

/** 只显示相对路径：告警里不输出 $DSH_HOME / 用户主目录的实际值，分隔符统一成 / */
function displayPath(root, full) {
  const rel = path.relative(root, full);
  if (rel === '') return '.';
  return rel.split(path.sep).join('/');
}

function listLogFiles(root) {
  const files = [];

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warn(`cannot read directory ${displayPath(root, dir)}: ${err.code || err.message}`);
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === LOG_FILE) {
        files.push(full);
      }
    }
  };

  walk(root, 0);
  return files;
}

function toCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeSessionId(id) {
  const text = typeof id === 'string' ? id.trim() : '';
  if (text === '') return '';
  return text.startsWith(SESSION_ID_PREFIX) ? text.slice(SESSION_ID_PREFIX.length) : text;
}

/**
 * 读一个会话日志，返回该会话的汇总；--since 没命中的会话返回 null。
 * 日志不存在 / 读不了 / 坏帧 / 坏行都不会抛错：坏数据跳过，日志本身读不到就告警并返回 null。
 *
 * cost=true 时逐条 assistant/message 计价（用该事件自己的 time 和自己的模型），汇总到
 * stats.usd；有消息按 _default 估的会话 stats.unpriced=true，由输出层标 *。
 * cost=false 时完全不碰价表，保证不带 --cost 的输出与旧版逐字节相同。
 */
function summarizeSession(file, root, sinceMs, cost) {
  const label = displayPath(root, file);

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    warn(`cannot read ${label}: ${err.code || err.message}`);
    return null;
  }

  const stats = {
    sessionId: null,
    model: null,
    models: [],
    events: 0,
    req: 0,
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
    lastEventMs: null,
    usd: 0,
    unpriced: false,
  };

  /** 最近一次 request/header 的模型：给没带 message.source.model 的 assistant/message 兜底 */
  let headerModel = null;

  const decoded = buf.length === 0
    ? { text: '', notZstd: false, warnings: [], broken: 0, truncatedTail: false }
    : decodeSessionLog(buf, label);

  // 告警逐条原样输出，顺序与旧实现完全一致（notZstd → corrupt → skipped → truncated）
  for (const message of decoded.warnings) warn(message);

  const { events } = parseEvents(decoded.text);
  for (const event of events) {
    stats.events += 1;

    if (Number.isFinite(event.time)) {
      if (stats.lastEventMs === null || event.time > stats.lastEventMs) stats.lastEventMs = event.time;
    }

    if (event.type === 'session') {
      if (stats.sessionId === null) stats.sessionId = normalizeSessionId(event.id) || null;
      continue;
    }

    if (event.type === 'request/header') {
      stats.req += 1;
      const config = event.data && event.data.header && event.data.header.config;
      const model = config && config.model;
      if (typeof model === 'string' && model.trim() !== '') {
        const name = model.trim();
        headerModel = name;
        // 同一会话中途换过模型：保留首次出现顺序，表格/JSON 都能看出混用
        if (!stats.models.includes(name)) stats.models.push(name);
      }
      continue;
    }

    if (event.type === 'assistant/message') {
      const usage = event.data && event.data.usage;
      if (!usage || typeof usage !== 'object') continue; // 没有用量的消息跳过
      const inputTokens = toCount(usage.inputTokens);
      const outputTokens = toCount(usage.outputTokens);
      const cacheReadTokens = toCount(usage.cacheReadTokens);
      const cacheWriteTokens = toCount(usage.cacheWriteTokens);
      stats.in += inputTokens;
      stats.out += outputTokens;
      stats.cacheRead += cacheReadTokens;
      stats.cacheWrite += cacheWriteTokens;

      // 计价只在 --cost 时做：全 0 的消息没有金额可算，也不该把会话标成「按默认价估」
      if (!cost || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;
      const source = event.data.message && event.data.message.source;
      const messageModel = source && typeof source.model === 'string' && source.model.trim() !== ''
        ? source.model.trim()
        : headerModel;
      if (!isPriced(messageModel)) stats.unpriced = true;
      // 时间用**这条消息自己的** time，不是会话开始时间：同一会话跨高峰/非高峰时单价会变
      stats.usd += usdOf({
        model: messageModel,
        i: inputTokens,
        o: outputTokens,
        cr: cacheReadTokens,
        cw: cacheWriteTokens,
        t: event.time,
      });
    }
  }

  if (stats.events === 0 && !decoded.notZstd) {
    // 0 字节文件没有别处告过，仍要说清是「空内容」；非空但没有可解析事件（全是坏行 /
    // 帧解不开）是另一种故障，用 "(no decodable events)"。已经没有 magic 的文件上面
    // 那条 "not a zstd frame" 就是结论，不再补一条同义告警。
    // 注意判据是**文件**长度，不是解码结果：非 zstd / 坏行也会得到空 text，但文件不 empty。
    warn(`${label}: decoded no events${buf.length === 0 ? ' (empty content)' : ' (no decodable events)'}`);
  }

  if (stats.sessionId === null) {
    stats.sessionId = normalizeSessionId(path.basename(path.dirname(file)));
  }
  if (stats.sessionId === '') stats.sessionId = path.basename(path.dirname(file));
  if (stats.models.length > 0) {
    stats.model = stats.models[0];
  } else {
    stats.model = stats.events === 0 ? '<unreadable>' : 'unknown';
  }

  if (sinceMs !== null && (stats.lastEventMs === null || stats.lastEventMs <= sinceMs)) return null;

  return stats;
}

function emptyTotals() {
  return { req: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
}

function summarize(files, root, sinceMs, cost) {
  const sessions = [];
  const total = emptyTotals();
  /** 有没有会话里有消息按 _default 估的价（表格下方那行说明只在 --cost 时用） */
  let unpriced = false;

  for (const file of files) {
    const session = summarizeSession(file, root, sinceMs, cost);
    if (!session) continue;
    sessions.push(session);
    total.req += session.req;
    total.in += session.in;
    total.out += session.out;
    total.cacheRead += session.cacheRead;
    total.cacheWrite += session.cacheWrite;
    total.usd += session.usd;
    if (session.unpriced) unpriced = true;
  }

  return { sessions, total, unpriced };
}

function formatRow(id, model, counts) {
  return `${id}  ${model}  req=${counts.req}  in=${counts.in}  out=${counts.out}  cacheRead=${counts.cacheRead}  cacheWrite=${counts.cacheWrite}`;
}

/** 表格里的金额：小于 $0.01 给 4 位小数（$0.0012），否则 2 位（$1.50）；TOTAL 同规则 */
function formatUsd(value) {
  const usd = Number.isFinite(value) ? value : 0;
  return `$${usd < COST_SMALL_USD ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** JSON 里的 usd：保留 6 位小数，仍是 number */
function roundUsd(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

/** 表格里的模型列：一个模型照旧，多个不同模型显示成 A(+1)，读不出内容的会话显示 <unreadable> */
function modelLabel(session) {
  if (session.models.length > 1) return `${session.models[0]}(+${session.models.length - 1})`;
  return session.model;
}

/**
 * 表格：列序与旧版一致，只在**末尾**追加 $ 列（cost=true 时）。
 * 金额列右对齐；带 * 表示该会话里有消息按 _default 估的价，表格下方补一行说明。
 */
function printTable(result, cost) {
  const idWidth = 8;
  const rows = result.sessions.map((session) => ({ session, label: modelLabel(session) }));
  const modelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 5);
  const totalUsdLabel = cost ? formatUsd(result.total.usd) : '';
  const usdLabels = cost
    ? rows.map((row) => `${formatUsd(row.session.usd)}${row.session.unpriced ? '*' : ''}`)
    : [];
  const usdWidth = usdLabels.reduce((width, label) => Math.max(width, label.length), totalUsdLabel.length);
  const lines = [];

  rows.forEach((row, index) => {
    const tail = cost ? `  ${usdLabels[index].padStart(usdWidth)}` : '';
    lines.push(formatRow(row.session.sessionId.slice(0, idWidth).padEnd(idWidth), row.label.padEnd(modelWidth), row.session) + tail);
  });
  lines.push(formatRow('TOTAL'.padEnd(idWidth), ''.padEnd(modelWidth), result.total) + (cost ? `  ${totalUsdLabel.padStart(usdWidth)}` : ''));

  if (cost && result.unpriced) lines.push(COST_DEFAULT_NOTE);

  process.stdout.write(`${lines.join('\n')}\n`);
}

function toJson(result, cost) {
  return {
    sessions: result.sessions.map((session) => ({
      sessionId: session.sessionId,
      model: session.model,
      models: session.models,
      req: session.req,
      in: session.in,
      out: session.out,
      cacheRead: session.cacheRead,
      cacheWrite: session.cacheWrite,
      ...(cost ? { usd: roundUsd(session.usd) } : {}),
    })),
    total: {
      req: result.total.req,
      in: result.total.in,
      out: result.total.out,
      cacheRead: result.total.cacheRead,
      cacheWrite: result.total.cacheWrite,
      ...(cost ? { usd: roundUsd(result.total.usd) } : {}),
    },
  };
}

/**
 * 运行时自检（启动跑一次，毫秒级；成功完全静默）。
 *   1) 有没有 zstd 支持（Node >= 22.15 才有 zlib.zstdCompressSync/zstdDecompressSync）；
 *   2) 泄漏回归探针：明文中恰为 131072 字节的首帧，若切帧退化成「解到 EOF」，
 *      zstdDecompressSync 会把下一帧也一起吃进来（Node 24.11 实测 131072 字节时返回
 *      131073 字节）。本文件的切帧只依赖帧结构，所以断言「解析出的第一帧范围」解压后
 *      **恰好 131072 字节**：多一个字节就说明我们在依赖那个泄漏行为，内容会被重复统计。
 */
function checkZstdRuntime() {
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
    process.stderr.write('error: this Node.js runtime has no zstd support (need Node >= 22.15)\n');
    return false;
  }

  let firstFrame;
  let expectedLength;
  try {
    const frameA = zlib.zstdCompressSync(Buffer.alloc(ZSTD_BLOCK, 0x61)); // 明文恰为 131072 字节
    const frameB = zlib.zstdCompressSync(Buffer.from('b'));
    const probe = Buffer.concat([frameA, frameB]);
    expectedLength = frameA.length;

    const parsed = parseFrame(probe, 0);
    if (parsed.kind !== FRAME_OK || parsed.end !== expectedLength) {
      process.stderr.write(
        `error: zstd frame parser self-check failed (first frame: ${parsed.kind === FRAME_OK ? `boundary ${parsed.end}` : parsed.kind}, expected boundary ${expectedLength}); aborting\n`
      );
      return false;
    }

    firstFrame = zlib.zstdDecompressSync(probe.subarray(0, parsed.end));
  } catch (err) {
    process.stderr.write(`error: runtime zstd rejected the leak-regression probe (${err.code || err.message}); aborting\n`);
    return false;
  }

  if (firstFrame.length !== ZSTD_BLOCK) {
    process.stderr.write(
      `error: frame isolation self-check decoded ${firstFrame.length} bytes for a ${ZSTD_BLOCK}-byte frame (expected ${ZSTD_BLOCK}); content from following frames would be counted twice; aborting\n`
    );
    return false;
  }
  return true;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }

  // 自检必须在开始扫描之前：切帧/解压的正确性完全押在它验证的那两条上
  if (!checkZstdRuntime()) return 1;

  const resolved = resolveSessionsDir(opts);

  let stat = null;
  try {
    stat = fs.statSync(resolved.dir);
  } catch (err) {
    stat = null;
  }

  if (!stat) {
    process.stderr.write(`error: sessions directory not found: ${resolved.dir}\n`);
    if (resolved.dshHome !== null) {
      process.stderr.write(
        `hint: DSH_HOME is set to ${resolved.dshHome}, so ~/.dsh/sessions is not used; create ${resolved.dir} or pass --dir <path>\n`
      );
    } else if (!resolved.fromDefault) {
      process.stderr.write('hint: pass an existing path, or omit --dir to use the default sessions directory\n');
    }
    return 1;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: not a sessions directory: ${resolved.dir}\n`);
    return 1;
  }

  const files = listLogFiles(resolved.dir);
  const result = summarize(files, resolved.dir, opts.sinceMs, opts.cost);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(toJson(result, opts.cost), null, 2)}\n`);
  } else {
    printTable(result, opts.cost);
  }

  return 0;
}

process.exitCode = main(process.argv.slice(2));
