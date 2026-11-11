#!/usr/bin/env node
'use strict';

/**
 * dsh/route-check.js —— 核对 /route 各阶段子代理**实际**跑在哪个模型上
 *
 * 用法：
 *   node dsh/route-check.js [--parent <会话 id 或前 8 位>] [--dir <sessions 根>]
 *                          [--from <ISO 时间或 epoch>] [--expect plan=provider/model,...]
 *                          [--json] [--cost]
 *     --parent  父会话 id（可只给前 8 位）；省略时自动选**最近修改**、且日志里含
 *               plan_subagent / impl_subagent / review_subagent 之一 tool/call 的会话
 *     --dir     会话日志根目录，默认 $DSH_HOME/sessions，否则 ~/.dsh/sessions
 *     --from    只看该时间之后派出的子代理（ISO 时间，或 epoch 秒/毫秒）
 *     --expect  覆盖角色期望，逗号分隔：plan=provider/model,impl=provider/model,review=...
 *     --json    输出 {"parent":...,"rows":[...],"summary":{...}}
 *     --cost    附带美元：表格末尾加一列 $（该子会话合计），表下给「主会话/规划/实现/
 *               审查/合计」汇总；--json 每行加 usd、summary 加 cost。不带时输出逐字节不变。
 *
 * 归属怎么确定（不靠时间窗口猜）：
 *   父会话日志里 tool/call 的 data.callId ↔ tool/result 的 data.message.source.callId
 *   （旧格式落 data.message.toolCallId / data.toolCallId）。结果文本里
 *   "started subagent <childId>" 给出子会话 id，再到同一 sessions 根目录下按目录名匹配
 *   （目录名可能是 <id> 或 session-<id>，--parent/子会话都支持前缀匹配）。
 *   子会话的模型取它**第一条** request/header 的 data.header.config.{provider,model,
 *   reasoningEffort}——这是子代理真实发请求时用的路由，不是父会话的配置推断。
 *
 * 输出约定：
 *   - 每个被派出的子代理一行；同一工具调多次就有多行，按派发顺序。
 *   - plan_subagent → 规划，impl_subagent → 实现，review_subagent → 审查；
 *     subagent（通用）默认没有期望，只列实际值；--expect 显式给出时才比对。
 *   - 期望不符 → 行尾 ✗，末行 "N/M 不符"，退出码 1。
 *   - 找不到任何子代理 → 一行 "no subagents found under this parent"，退出码 0。
 *   - tool/call 没有配到 tool/result（子代理没起来 / 结果被截断）→ 模型列 unknown，
 *     行尾 unknown，不算不符，但单独计数。
 *   - 子会话日志缺失 / 读不出 / 没有 request/header → 模型列 unreadable，算 ✗。
 *   - --json 在 ✗ 时也是完整合法 JSON，先写 stdout 再设置退出码。
 *
 * --cost 的计价口径与 usage-audit.js **完全一致**（实现共用 lib/pricing.js）：
 *   逐条 assistant/message 用它**自己的 event.time** 判高峰/非高峰、用它自己的模型查价
 *   （data.message.source.model，缺失退回最近一次 request/header 的模型）；usage 缺失或
 *   input/output/cacheRead/cacheWrite 全 0 的消息不计量。金额 = 该会话所有这类消息之和。
 *   子代理是独立会话：表里每行是该子会话合计，汇总里的「主会话」只算父会话自己的消息，
 *   两者不重叠；同一角色被派多次按子会话（文件）去重后累加。
 *   查不到单价的模型按 PRICE._default 估，该行 $ 后标 *，表下给一行说明。
 *   --cost 不参与对错判定，退出码与不带时相同。
 *
 * 退出码：0 全部符合 / 无子代理；1 有期望不符或参数指向的父会话/目录不存在；2 参数错误
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');

const { readSessionFile } = require('./lib/session-log.js');
const { PRICE } = require('./lib/pricing.js');
// 计价累计器放在 lib/ 里：设置页的「最近委派」用同一份实现，两边不会算出不同的数。
const { toCount, newCostState, costAdd, costOfEvents } = require('./lib/cost.js');

const USAGE =
  'usage: node dsh/route-check.js [--parent <session id|prefix>] [--dir <sessions root>] [--from <ISO time|epoch>] [--expect plan=provider/model,...] [--json] [--cost]';
/** --help / -h 的完整说明：只走 stdout + 退出码 0，正常路径不输出 */
const HELP = `用法：
  node route-check.js [--parent <会话 id 或前 8 位>] [--dir <sessions 根>]
                      [--from <ISO 时间或 epoch>] [--expect plan=provider/model,...]
                      [--json] [--cost] [--help]

参数：
  --parent <id>    父会话 id（可只给前 8 位，也接受 session- 前缀）；省略时自动挑最近修改、
                   且日志里派过 plan_subagent / impl_subagent / review_subagent 的会话
  --dir <路径>     会话日志根目录，默认 $DSH_HOME/sessions，没设 $DSH_HOME 时用 ~/.dsh/sessions
  --from <时间>    只看该时间之后派出的子代理；ISO 时间，或 epoch 秒/毫秒
  --expect <列表>  覆盖期望，逗号分隔：plan=provider/model,impl=provider/model,review=...
                   显式给出的角色会被比对（优先于该次派活的声明和 dmr.json；解析不到子代理的行仍不比对）
                   角色键也接受 plan_subagent / impl_subagent / review_subagent，以及
                   generic / subagent（默认不给通用工具设期望，设了就会比对）
  --json           输出 {"parent":...,"rows":[...],"summary":{...}}；判定不符时 JSON 仍完整合法
  --cost           附带美元：表格末尾加一列 $（该子会话合计），表下给「主会话/规划/实现/审查/
                   合计」汇总；--json 每行加 usd、summary 加 cost
  --help, -h       打印这份说明并退出（退出码 0）；出现在任何位置都生效

它核对什么：
  每个角色子代理实际跑的模型 vs 期望。模型取子会话日志里第一条 request/header 的
  data.header.config.{provider,model,reasoningEffort}，不是父会话的配置推断；
  plan_subagent → 规划，impl_subagent → 实现，review_subagent → 审查；
  通用 subagent 默认没有期望，只列实际值、不计入对错。

期望从哪来（优先级从高到低）：
  1. 命令行 --expect 显式给出的角色；
  2. 该次派活声明的路由——派活工具的返回文本里有「route: provider/model ...」；
     角色继承父会话时那里写的是「inherited ...」，不是路由，会被忽略；
  3. $DSH_HOME/dmr.json 的当前值。
  继承父会话的行不比对（那一轮没有固定路由可核）。所以改表不会误伤历史轮次，「声明了 A、实际跑了 B」照样能抓出来；三条都没有的角色
  就不比对，只在汇总里计一行「未比对」。

退出码：
  0  全部符合（或没有找到任何子代理）
  1  有 ✗（期望不符 / 子会话读不出），或读不到父会话（--parent 找不到、--dir 不存在）
  2  参数错误（未知参数、缺值、非法 --from / --expect 等）`;
const LOG_FILE = 'session.v4.jsonl.zstd';
const SESSION_ID_PREFIX = 'session-';
/** --cost 的 _default 说明行：价格从 PRICE._default 生成，避免手抄成第二份（措辞同 usage-audit） */
const COST_DEFAULT_NOTE = `* 单价表里没有，按默认价 ${PRICE._default.map((value) => `$${value}`).join('/')} 估`;
/** 递归找日志的深度上限：sessions/<slug>/<session>/file 只要 2 层，留点余量 */
const MAX_WALK_DEPTH = 4;
/** 参与核对的工具；generic 的 subagent 默认没有期望（--expect 给出时才比对） */
const ROLE_TOOLS = {
  plan_subagent: { role: 'plan', label: '规划' },
  impl_subagent: { role: 'impl', label: '实现' },
  review_subagent: { role: 'review', label: '审查' },
  subagent: { role: 'generic', label: '通用' },
};
// 期望值来自路由表，不写死型号：改了 dmr.json，核对口径跟着改。
// 表里没有某个角色（或整个文件不存在）→ 该角色不比对，只列实际值。
const ROUTE_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dmr.json');
function loadRouteExpectations() {
  const expect = {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8'));
  } catch {
    return expect;
  }
  const roles = (parsed && typeof parsed.roles === 'object' && parsed.roles) || {};
  for (const [tool, meta] of Object.entries(ROLE_TOOLS)) {
    const entry = roles[meta.role];
    if (!entry || typeof entry !== 'object') continue;
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (provider !== '' && model !== '') expect[tool] = `${provider}/${model}`;
  }
  return expect;
}
const DEFAULT_EXPECT = loadRouteExpectations();
/** --expect 的角色键 → 工具名（也接受完整工具名） */
const EXPECT_KEYS = {
  plan: 'plan_subagent',
  impl: 'impl_subagent',
  review: 'review_subagent',
  generic: 'subagent',
  plan_subagent: 'plan_subagent',
  impl_subagent: 'impl_subagent',
  review_subagent: 'review_subagent',
  subagent: 'subagent',
};
/** 结果文本：started subagent <id>；容忍 session- 前缀和常见空白 */
const STARTED_SUBAGENT_RE = /started\s+subagent\s+(session-)?([0-9A-Za-z][0-9A-Za-z-]*)/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EPOCH_RE = /^\d+$/;

class RouteError extends Error {
  constructor(message, exitCode = 2, hint = null) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

/** 只显示相对路径：告警里不输出 $DSH_HOME / 用户主目录的实际值，分隔符统一成 / */
function displayPath(root, full) {
  const rel = path.relative(root, full);
  if (rel === '') return '.';
  return rel.split(path.sep).join('/');
}

function normalizeSessionId(id) {
  const text = typeof id === 'string' ? id.trim() : '';
  if (text === '') return '';
  return text.startsWith(SESSION_ID_PREFIX) ? text.slice(SESSION_ID_PREFIX.length) : text;
}

/** --from：纯日期按本地 00:00；纯数字按 epoch（< 1e12 视为秒）；其余 Date.parse */
function parseFrom(value) {
  const match = DATE_ONLY_RE.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const local = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
      throw new RouteError(`invalid --from date: ${value}`);
    }
    return local.getTime();
  }

  if (EPOCH_RE.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n < 1e12 ? n * 1000 : n;
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new RouteError(`invalid --from time: ${value}`);
  return ms;
}

/** 解析 --expect：逗号分隔的 role=provider/model；只覆盖显式给出的角色 */
function parseExpect(value, expect, explicit) {
  const parts = value.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new RouteError(`invalid --expect entry: ${trimmed} (want role=provider/model)`);
    }
    const key = trimmed.slice(0, eq).trim();
    const target = trimmed.slice(eq + 1).trim();
    const tool = EXPECT_KEYS[key];
    if (!tool) throw new RouteError(`unknown --expect role: ${key} (use plan, impl, review, generic or subagent)`);
    if (target === '') throw new RouteError(`empty --expect value for ${key}`);
    expect[tool] = target;
    // 记下"用户显式要求比对"的角色：它要压过派活声明，否则 --expect 在已经声明过
    // 路由的行上完全无效（用户以为按他给的核对过，其实没有）。
    if (explicit) explicit.add(tool);
  }
}

function parseArgs(argv) {
  // --help/-h 优先于一切参数校验：先扫整条 argv，--parent x --help 也要生效
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const opts = { parent: null, dir: null, fromMs: null, expect: { ...DEFAULT_EXPECT }, explicitExpect: new Set(), json: false, cost: false };

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

    if (name === '--parent' || name === '--dir' || name === '--from' || name === '--expect') {
      if (value === null) {
        const next = argv[i + 1];
        // 漏写值（--dir --json）不能被当成把 --json 当路径
        if (next === undefined || next.startsWith('--')) throw new RouteError(`missing value for ${name}`);
        i += 1;
        value = next;
      }
      if (value === '') throw new RouteError(`empty value for ${name}`);

      if (name === '--parent') {
        opts.parent = value;
      } else if (name === '--dir') {
        opts.dir = value;
      } else if (name === '--from') {
        opts.fromMs = parseFrom(value);
      } else {
        parseExpect(value, opts.expect, opts.explicitExpect);
      }
      continue;
    }

    throw new RouteError(`unknown argument: ${raw}`);
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

/**
 * 列出 sessions 根下的所有会话日志。每条：
 *   { file, id, slug, mtimeMs }
 * id 从目录名去掉 session- 前缀；--parent / 子会话 id 都用它做前缀匹配。
 */
function listSessionLogs(root) {
  const entries = [];

  const walk = (dir, depth) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warn(`cannot read directory ${displayPath(root, dir)}: ${err.code || err.message}`);
      return;
    }

    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of dirents) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === LOG_FILE) {
        const sessionDir = path.dirname(full);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch (err) {
          mtimeMs = 0;
        }
        entries.push({
          file: full,
          id: normalizeSessionId(path.basename(sessionDir)),
          slug: path.basename(path.dirname(sessionDir)),
          mtimeMs,
        });
      }
    }
  };

  walk(root, 0);
  return entries;
}

/** 先精确匹配，再前缀匹配；多个前缀命中时取最近修改的那个（8 位前缀碰撞极少） */
function matchSession(entries, wanted) {
  const norm = normalizeSessionId(wanted);
  if (norm === '') return null;

  const exact = entries.filter((entry) => entry.id === norm);
  if (exact.length === 1) return exact[0];

  const prefixed = entries.filter((entry) => entry.id.startsWith(norm));
  if (prefixed.length === 0) return null;
  prefixed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return prefixed[0];
}

function isRoleTool(name) {
  return name === 'plan_subagent' || name === 'impl_subagent' || name === 'review_subagent';
}

/**
 * 自动挑父会话：按 mtime 从新到旧，第一个日志里出现角色工具 tool/call 的会话。
 * 搜索阶段静默读（坏日志不刷屏）；选中的父会话稍后带标签重读一次，告警照常输出。
 */
function findAutoParent(entries) {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of sorted) {
    let decoded;
    try {
      decoded = readSessionFile(entry.file);
    } catch (err) {
      continue;
    }
    const hit = decoded.events.some(
      (event) => event && event.type === 'tool/call' && event.data && isRoleTool(event.data.name)
    );
    if (hit) return entry;
  }
  return null;
}

/** tool/result 里取 callId：新格式在 message.source.callId，旧格式散落在 message/data 上 */
function resultCallId(data) {
  if (!data || typeof data !== 'object') return null;
  const message = data.message;
  if (message && typeof message === 'object') {
    if (message.source && typeof message.source.callId === 'string') return message.source.callId;
    if (typeof message.toolCallId === 'string') return message.toolCallId;
  }
  if (typeof data.toolCallId === 'string') return data.toolCallId;
  if (typeof data.callId === 'string') return data.callId;
  return null;
}

/** tool/result 的文本：message.content[{type:'text',text}]，兼容直接给的 content/output/result */
function resultText(data) {
  if (!data || typeof data !== 'object') return '';
  const message = data.message;
  if (message && typeof message.content === 'string') return message.content;
  const blocks = message && Array.isArray(message.content) ? message.content : null;
  if (blocks) {
    return blocks
      .filter((block) => block && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  if (Array.isArray(data.content)) {
    return data.content
      .filter((block) => block && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  if (typeof data.content === 'string') return data.content;
  if (typeof data.output === 'string') return data.output;
  if (typeof data.result === 'string') return data.result;
  return '';
}

/**
 * 从父会话事件里建立派发表：每条相关 tool/call 一行，按事件顺序；
 * tool/result 按 callId 回填 childId（识别不出就是 null → unknown）。
 */
function collectDispatches(events, fromMs) {
  const rows = [];
  const byCallId = new Map();

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'tool/call') {
      const data = event.data;
      const name = data && typeof data.name === 'string' ? data.name : '';
      const mapping = ROLE_TOOLS[name];
      if (!mapping) continue;
      const callId = typeof data.callId === 'string' ? data.callId : null;
      const time = Number.isFinite(event.time) ? event.time : null;
      if (fromMs !== null && (time === null || time < fromMs)) continue;

      const row = {
        role: mapping.role,
        roleLabel: mapping.label,
        tool: name,
        callId,
        time,
        child: null,
        status: 'pending',
      };
      rows.push(row);
      if (callId !== null) byCallId.set(callId, row);
      continue;
    }

    if (event.type === 'tool/result') {
      const callId = resultCallId(event.data);
      if (callId === null) continue;
      const row = byCallId.get(callId);
      if (!row || row.child !== null) continue;
      const text = resultText(event.data);
      const match = STARTED_SUBAGENT_RE.exec(text);
      if (match) {
        row.child = normalizeSessionId(match[2]);
        row.status = 'started';
      }
      // DMR 的派活工具会把当时生效的路由写进返回文本（`route: provider/model @effort`）。
      // 拿它当期望，比拿当前 dmr.json 准：改过表之后，历史轮次仍按当时的声明核对，
      // 而「声明了 A、实际跑了 B」这种真正的路由事故照样能抓出来。
      //
      // 只有一种值不算路由：角色继承父会话时工具写「inherited from the parent session」。
      // 那行**根本不比对**（不退回 dmr.json）——否则事后把该角色补进表、模型又不同，
      // 历史继承行会被拿新表核对，凭空 ✗。其余 `route:` 值照收：判据是语义而不是
      // 「含不含斜杠」，免得哪天声明格式变了（比如只写 model）就静默丢掉。
      const claim = /route:\s*([^\s,)]+)/.exec(text);
      if (claim) {
        if (/^inherited/i.test(claim[1])) row.inherited = true;
        else row.claimed = claim[1];
      }
    }
  }

  return rows;
}

/**
 * 读子会话：第一条 request/header 的模型/effort + 请求数 + token 用量；withCost 时再算该会话美元合计。
 * 返回 { info, usd, unpriced }：info=null 表示没有可用的 request/header（调用方判 unreadable），
 * 但 usd 仍按日志里实际存在的 assistant/message 算——「模型读不出」和「这段日志没有花费」
 * 是两件事，计价口径要和 usage-audit 一致。
 */
function summarizeChild(entry, withCost = false) {
  let decoded;
  try {
    decoded = readSessionFile(entry.file);
  } catch (err) {
    return null;
  }

  // calls = 带 usage 的 assistant/message 条数（模型调用次数）；ctx = request/header 条数
  // （上下文重置次数）。子会话里 ctx 往往只有 1，拿它当调用次数会把成本看小一个量级。
  let calls = 0;
  let ctx = 0;
  let input = 0;
  let output = 0;
  let header = null;
  const costState = withCost ? newCostState() : null;

  for (const event of decoded.events) {
    if (!event || typeof event !== 'object') continue;
    if (costState !== null) costAdd(costState, event);
    if (event.type === 'request/header') {
      ctx += 1;
      if (header === null) header = event;
      continue;
    }
    if (event.type === 'assistant/message') {
      const usage = event.data && event.data.usage;
      if (!usage || typeof usage !== 'object') continue;
      calls += 1;
      input += toCount(usage.inputTokens);
      output += toCount(usage.outputTokens);
    }
  }

  const config = header && header.data && header.data.header && header.data.header.config;
  const model = config && typeof config.model === 'string' && config.model.trim() !== '' ? config.model.trim() : null;
  const usd = costState === null ? 0 : costState.usd;
  const unpriced = costState === null ? false : costState.unpriced;
  if (model === null) return { info: null, usd, unpriced };

  return {
    info: {
      model,
      provider: config && typeof config.provider === 'string' ? config.provider.trim() : '',
      effort: config && typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
      calls,
      ctx,
      in: input,
      out: output,
    },
    usd,
    unpriced,
  };
}

/**
 * --cost 的累计状态在 lib/cost.js：口径与 usage-audit.js 一致（模型取
 * message.source.model、时间用消息自己的 event.time、查不到价落默认价并标 *）。
 * 父会话和子会话都走这一份实现。
 */

/**
 * 期望 "provider/model" 与日志里的 config.{provider,model} 比对：
 * provider 已知时必须一致；日志没写 provider 时只比 model（不比不存在的信息）。
 * --expect 允许只写 model（没有 /）——那就只比 model。
 */
function identityMatches(provider, model, expected) {
  const slash = expected.lastIndexOf('/');
  const expectedProvider = slash >= 0 ? expected.slice(0, slash) : null;
  const expectedModel = slash >= 0 ? expected.slice(slash + 1) : expected;
  if (expectedModel !== model) return false;
  if (expectedProvider !== null && provider) return expectedProvider === provider;
  return true;
}

/**
 * 形态化每一行：
 *   ok=true 符合；ok=false 不符（含 unreadable）；ok=null 无期望或 unknown，不计对错。
 * status: started | unknown | unreadable
 */
function evaluate(rows, entries, parentEntry, expect, explicitExpect, withCost = false) {
  const siblings = entries.filter((entry) => entry.slug === parentEntry.slug);

  return rows.map((row) => {
    const explicit = explicitExpect && explicitExpect.has(row.tool);
    const fromTable = Object.prototype.hasOwnProperty.call(expect, row.tool) ? expect[row.tool] : null;
    // 命令行显式给的压过声明：用户说"按这个核对"，就不该被派活自己的声明顶掉。
    // 继承父路由的行不比对（除非用户显式给了期望）——那一轮本就没有固定路由可言。
    const expected = explicit ? fromTable : (row.inherited ? null : (row.claimed ?? fromTable));
    const base = {
      role: row.role,
      roleLabel: row.roleLabel,
      tool: row.tool,
      child: row.child,
      model: null,
      effort: null,
      // 调用次数与上下文重置次数分开：表格只显示 calls，ctx 留给 JSON。
      calls: null,
      ctx: null,
      in: null,
      out: null,
      expected,
      ok: null,
      status: row.status,
      // --cost 用：该子会话的美元合计、是否用了默认价、去重用的会话文件键
      usd: 0,
      unpriced: false,
      costKey: null,
    };

    if (row.child === null) {
      base.model = 'unknown';
      base.status = 'unknown';
      return base;
    }

    // 先在同一工作区里找，再退回整个 sessions 根（工作区 slug 不会变，但目录可能被挪过）
    const scoped = matchSession(siblings, row.child);
    const childEntry = scoped || matchSession(entries, row.child);
    if (!childEntry) {
      base.model = 'unreadable';
      base.status = 'unreadable';
      if (expected !== null) base.ok = false;
      return base;
    }

    const child = summarizeChild(childEntry, withCost);
    if (!child) {
      base.model = 'unreadable';
      base.status = 'unreadable';
      if (expected !== null) base.ok = false;
      return base;
    }

    // 有日志但读不出模型：判定仍是 unreadable，但日志里真实发生的 assistant/message 照常计价
    base.usd = child.usd;
    base.unpriced = child.unpriced;
    base.costKey = childEntry.file;
    if (child.info === null) {
      base.model = 'unreadable';
      base.status = 'unreadable';
      if (expected !== null) base.ok = false;
      return base;
    }

    const info = child.info;
    base.model = info.model;
    base.effort = info.effort;
    base.calls = info.calls;
    base.ctx = info.ctx;
    base.in = info.in;
    base.out = info.out;
    base.status = 'started';

    if (expected !== null) {
      base.ok = identityMatches(info.provider, info.model, expected);
    }
    return base;
  });
}

function summarize(rows) {
  let total = 0;
  let mismatched = 0;
  let unknown = 0;
  let unchecked = 0;

  for (const row of rows) {
    if (row.status === 'unknown') unknown += 1;
    if (row.expected === null) {
      unchecked += 1;
      continue;
    }
    if (row.status === 'unknown') continue;
    total += 1;
    if (row.ok === false) mismatched += 1;
  }

  return { total, mismatched, unknown, unchecked };
}

/**
 * --cost 汇总：
 *   主会话 = 父会话自己的 assistant/message 合计（子代理是独立会话，不能重复计入）；
 *   各阶段 = 该角色所有子会话之和（按日志文件去重，同一角色派多次就累加）。
 * 合计 = 主会话 + 规划 + 实现 + 审查（+ 通用，若有子代理用了通用 subagent）。
 * 通用行没有阶段期望，只在真有金额时单独列/写进 JSON，不悄悄并进三个阶段。
 */
function summarizeCost(parentEvents, rows) {
  const parent = costOfEvents(parentEvents);
  const roles = { plan: 0, impl: 0, review: 0, generic: 0 };
  const seen = { plan: new Set(), impl: new Set(), review: new Set(), generic: new Set() };
  let unpriced = parent.unpriced;

  for (const row of rows) {
    if (row.unpriced) unpriced = true;
    if (!Object.prototype.hasOwnProperty.call(roles, row.role) || row.costKey === null) continue;
    if (seen[row.role].has(row.costKey)) continue;
    seen[row.role].add(row.costKey);
    roles[row.role] += row.usd;
  }

  // 先按输出精度（6 位小数）定下各分项，再由分项相加得到合计：
  // 这样 JSON 里 parent+plan+impl+review(+generic) 逐位等于 total（不会出现 1e-6 的舍入差）。
  const parentUsd = roundUsd(parent.usd);
  const planUsd = roundUsd(roles.plan);
  const implUsd = roundUsd(roles.impl);
  const reviewUsd = roundUsd(roles.review);
  const genericUsd = roundUsd(roles.generic);

  return {
    parent: parentUsd,
    plan: planUsd,
    impl: implUsd,
    review: reviewUsd,
    generic: genericUsd,
    total: roundUsd(parentUsd + planUsd + implUsd + reviewUsd + genericUsd),
    parentUnpriced: parent.unpriced,
    unpriced,
  };
}

/** 表格/汇总里的金额：统一 4 位小数（$0.0231），与输出示例一致 */
function formatUsd(value) {
  const usd = Number.isFinite(value) ? value : 0;
  return `$${usd.toFixed(4)}`;
}

/** JSON 里的 usd：保留 6 位小数，仍是 number（同 usage-audit） */
function roundUsd(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

/** 表下的汇总行：主会话 $x · 规划 $y · 实现 $z · 审查 $w · 合计 $t */
function costLine(cost) {
  const parts = [
    `主会话 ${formatUsd(cost.parent)}${cost.parentUnpriced ? '*' : ''}`,
    `规划 ${formatUsd(cost.plan)}`,
    `实现 ${formatUsd(cost.impl)}`,
    `审查 ${formatUsd(cost.review)}`,
  ];
  if (cost.generic !== 0) parts.push(`通用 ${formatUsd(cost.generic)}`);
  parts.push(`合计 ${formatUsd(cost.total)}`);
  return parts.join(' · ');
}

/** 终端显示宽度：CJK/全角按 2 格，其余按 1 格（表格对齐用） */
function cellWidth(text) {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text, width) {
  return text + ' '.repeat(Math.max(0, width - cellWidth(text)));
}

function statusMark(row) {
  if (row.status === 'unknown') return 'unknown';
  if (row.ok === true) return '✓';
  if (row.ok === false) return '✗';
  return '-';
}

function printTable(parentId, rows, summary, cost = null) {
  const header = ['角色', '工具', '子会话', '模型', 'effort', 'calls', 'in', 'out', '判定'];
  const cells = rows.map((row) => [
    row.roleLabel,
    row.tool,
    row.child === null ? '-' : row.child.slice(0, 8),
    row.model === null ? '-' : row.model,
    row.effort === null ? '-' : row.effort,
    row.calls === null ? '-' : String(row.calls),
    row.in === null ? '-' : String(row.in),
    row.out === null ? '-' : String(row.out),
    statusMark(row),
  ]);

  if (cost !== null) {
    // 新列只能加在末尾：不改现有列顺序，也不动「判定」
    header.push('$');
    for (let index = 0; index < cells.length; index += 1) {
      const row = rows[index];
      cells[index].push(`${formatUsd(row.usd)}${row.unpriced ? '*' : ''}`);
    }
  }

  const widths = header.map((title, index) =>
    Math.max(cellWidth(title), ...cells.map((row) => cellWidth(row[index])))
  );

  const lines = [];
  lines.push(`parent: ${parentId}`);
  lines.push(header.map((title, index) => padCell(title, widths[index])).join('  ').trimEnd());
  for (const row of cells) {
    lines.push(row.map((value, index) => padCell(value, widths[index])).join('  ').trimEnd());
  }
  lines.push(`${summary.mismatched}/${summary.total} 不符`);
  if (summary.mismatched > 0) lines.push('（期望优先级：--expect 显式值 > 该次派活的声明路由 > 当前 dmr.json；继承父路由的行不比对）');
  if (summary.unknown > 0) lines.push(`unknown: ${summary.unknown}`);
  if (summary.unchecked > 0) {
    lines.push(`${summary.unchecked} 行未比对（没有 --expect、没有声明路由、dmr.json 也没有该角色，或它继承自父会话）`);
  }
  if (cost !== null) {
    lines.push(costLine(cost));
    if (cost.unpriced) lines.push(COST_DEFAULT_NOTE);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function toJson(parentId, rows, summary, cost = null) {
  return {
    parent: parentId,
    rows: rows.map((row) => ({
      role: row.role,
      tool: row.tool,
      child: row.child,
      model: row.model === null ? 'unknown' : row.model,
      effort: row.effort,
      calls: row.calls,
      ctx: row.ctx,
      in: row.in,
      out: row.out,
      expected: row.expected,
      ok: row.ok,
      ...(cost !== null ? { usd: roundUsd(row.usd) } : {}),
    })),
    summary: {
      total: summary.total,
      mismatched: summary.mismatched,
      unknown: summary.unknown,
      ...(cost !== null
        ? {
            cost: {
              parent: roundUsd(cost.parent),
              plan: roundUsd(cost.plan),
              impl: roundUsd(cost.impl),
              review: roundUsd(cost.review),
              ...(cost.generic !== 0 ? { generic: roundUsd(cost.generic) } : {}),
              total: roundUsd(cost.total),
            },
          }
        : {}),
    },
  };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof RouteError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return err.exitCode;
    }
    throw err;
  }

  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

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

  const entries = listSessionLogs(resolved.dir);

  let parentEntry = null;
  let decoded = null;

  if (opts.parent !== null) {
    parentEntry = matchSession(entries, opts.parent);
    if (!parentEntry) {
      process.stderr.write(`error: parent session not found under ${resolved.dir}: ${opts.parent}\n`);
      return 1;
    }
    try {
      decoded = readSessionFile(parentEntry.file, displayPath(resolved.dir, parentEntry.file));
    } catch (err) {
      process.stderr.write(
        `error: cannot read parent session log ${displayPath(resolved.dir, parentEntry.file)}: ${err.code || err.message}\n`
      );
      return 1;
    }
    for (const message of decoded.warnings) warn(message);
  } else {
    parentEntry = findAutoParent(entries);
    if (!parentEntry) {
      if (opts.json) {
        const result = toJson(null, [], { total: 0, mismatched: 0, unknown: 0 });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write('no subagents found under this parent\n');
      }
      return 0;
    }
    try {
      decoded = readSessionFile(parentEntry.file, displayPath(resolved.dir, parentEntry.file));
    } catch (err) {
      process.stderr.write(
        `error: cannot read parent session log ${displayPath(resolved.dir, parentEntry.file)}: ${err.code || err.message}\n`
      );
      return 1;
    }
    for (const message of decoded.warnings) warn(message);
  }

  const dispatches = collectDispatches(decoded.events, opts.fromMs);
  const rows = evaluate(dispatches, entries, parentEntry, opts.expect, opts.explicitExpect, opts.cost);
  const summary = summarize(rows);
  const cost = opts.cost ? summarizeCost(decoded.events, rows) : null;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(toJson(parentEntry.id, rows, summary, cost), null, 2)}\n`);
  } else if (rows.length === 0) {
    // 没有子代理也照常给主会话金额 + 汇总（各阶段为 0），不改变退出码
    if (cost !== null) {
      process.stdout.write(`parent: ${parentEntry.id}\n`);
      process.stdout.write('no subagents found under this parent\n');
      process.stdout.write(`${costLine(cost)}\n`);
      if (cost.unpriced) process.stdout.write(`${COST_DEFAULT_NOTE}\n`);
    } else {
      process.stdout.write('no subagents found under this parent\n');
    }
  } else {
    printTable(parentEntry.id, rows, summary, cost);
  }

  return summary.mismatched > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
