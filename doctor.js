#!/usr/bin/env node
'use strict';

/**
 * doctor.js —— 一次回答「DMR 现在到底哪一环坏了」
 *
 * 为什么要有它：踩过一次「profiles/desktop/package.json 里声明着插件、但
 * node_modules 里那条链接消失了」——三个工具和详情页的面板一起消失，而包清单
 * 看起来一切正常。清单只说明「应该装」，这里的每一项都直接读盘、或直接问接口，
 * 只报告**当下**的事实。
 *
 * 它按「从里到外」的顺序查五段：
 *   环境      DSH_HOME 在不在、能不能读
 *   安装      包目录、host/client 两个入口、bundle patch 里那行插件、profile 的
 *             依赖声明与 bundle 列表、node_modules 链接指向哪里、profile 的两层
 *             YAML（cordis.patch.yml / cordis.yml）有没有把它关掉、还有没有别的断链
 *   配置      dmr.json 是否存在·合法，每个角色的模型/effort 是否在**实时**目录里
 *   会话日志  $DSH_HOME/sessions 可读吗、有多少日志、最近一条是什么时候
 *   接口      端口（每次重启都会变，默认从本机监听端口里认出来）、四个接口是否
 *             应答、返回的是不是 DMR 的形状、进程里跑的代码是不是比磁盘上的旧
 *
 * 用法：node doctor.js [--home <DSH_HOME>] [--profile <名称>] [--port <端口>] [--json]
 * 退出码：0 全部通过（! 只是提醒）；1 有 ✗；2 参数错误
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { ROLE_IDS, validateRouteTable } = require('./lib/route-table.js');

const PKG_NAME = 'dsh-deepseek-model-route';
const BASE_PATH = '/plugins/dsh-deepseek-model-route';
const PATCH_ID = 'dmr-delegation';
const LOG_NAME = 'session.v4.jsonl.zstd';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PKG_DIR = __dirname;
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'];

const USAGE =
  'usage: node doctor.js [--home <DSH_HOME>] [--profile <name>] [--port <port>] [--json]';

/** --help / -h：只走 stdout + 退出码 0，正常路径不输出 */
const HELP = `用法：
  node doctor.js [--home <DSH_HOME>] [--profile <名称>] [--port <端口>] [--json] [--help]

参数：
  --home <路径>     DSH_HOME，默认取环境变量 DSH_HOME，否则 ~/.dsh
  --profile <名称>  profile 名，默认 desktop（$DSH_HOME/profiles 下的目录名）
  --port <端口>     GUI 端口；省略时扫本机回环监听端口，用 /config 的响应形状认出来
  --json            输出 {"home":…,"profile":…,"sections":[…],"summary":{…}}
  --help, -h        打印这份说明并退出（退出码 0）

它查什么：
  1. 环境：DSH_HOME 存在吗、能读吗
  2. 安装：包目录、host 入口（main）、client 入口（exports["./client"] + dsh.client）、
     bundle patch 里那条 id: dmr-delegation 的插件行；profile 的 dependencies、
     dsh.profile.bundles、node_modules 链接指向何处、profile 的 cordis.patch.yml 与
     cordis.yml 有没有把它禁用、还有没有别的断链
  3. 配置：dmr.json 是否存在（不存在=三个角色都继承父会话，不算错）、是否合法、
     每个角色的 provider/model/effort 是否在实时目录里（接口可达时才核对）
  4. 会话日志：$DSH_HOME/sessions 可读吗、多少条日志、最近一条的时间、zstd 魔数
  5. 接口：端口、/config /models /rounds /stats 四个接口的状态与耗时、返回形状，
     以及磁盘上的 index.mjs / client.js 是否比运行中的进程更新（那样改动还没生效）

判定：
  ✓ 通过   ✗ 失败（退出码 1）   ! 提醒（不影响退出码，例如 effort 读不到目录无法核对）
  - 跳过（缺前提，例如 DSH 没在运行时接口不查）

退出码：
  0  没有 ✗
  1  有 ✗
  2  参数错误`;

class DoctorError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ─────────────────────────────── 小工具 ───────────────────────────────

function defaultHome() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return env !== '' ? env : path.join(os.homedir(), '.dsh');
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '-';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 两个路径是不是同一个文件：Windows 上大小写不敏感，分隔符统一成 / */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (value) => {
    const resolved = path.resolve(value).split(path.sep).join('/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function errorCode(error) {
  return error && error.code ? error.code : (error && error.message) || String(error);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 终端显示宽度：CJK/全角按 2 格，其余按 1 格（与 route-check 的表格同一套算法） */
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

// ─────────────────────────────── 行 ───────────────────────────────

const MARK = { ok: '✓', fail: '✗', warn: '!', skip: '-' };

function makeRow(depth, item, status, detail, hint) {
  return { item, depth, status, detail: detail ?? '', hint: hint ?? null };
}
const top = (item, status, detail, hint) => makeRow(0, item, status, detail, hint);
const sub = (item, status, detail, hint) => makeRow(1, item, status, detail, hint);

// ─────────────────────────────── 环境与安装 ───────────────────────────────

function checkEnvironment(rows, home) {
  let stat = null;
  try {
    stat = fs.statSync(home);
  } catch {
    stat = null;
  }
  if (!stat) {
    rows.push(top('DSH_HOME', 'fail', `${home} 不存在`, '设 DSH_HOME，或用 --home 指向真正的 DSH 主目录'));
    return false;
  }
  if (!stat.isDirectory()) {
    rows.push(top('DSH_HOME', 'fail', `${home} 不是目录`, '--home 要指向 DSH 的主目录（含 profiles/ 和 sessions/）'));
    return false;
  }
  try {
    fs.readdirSync(home);
  } catch (error) {
    rows.push(top('DSH_HOME', 'fail', `${home} 读不出来（${errorCode(error)}）`, '权限问题：当前用户读不到这个目录，面板和 route-check 都会是空的'));
    return true;
  }
  rows.push(top('DSH_HOME', 'ok', home));
  return true;
}

/** 一行指向某个文件的存在性检查 */
function fileRow(item, file, detail, hint) {
  try {
    fs.statSync(file);
    return sub(item, 'ok', detail);
  } catch {
    return sub(item, 'fail', `缺少 ${path.basename(file)}（${path.dirname(file)}）`, hint);
  }
}

function checkPackage(rows) {
  const pkgFile = path.join(PKG_DIR, 'package.json');
  rows.push(top('包目录', 'ok', PKG_DIR));

  const text = readText(pkgFile);
  if (text === null) {
    rows.push(sub('package.json', 'fail', `读不出 ${pkgFile}`, 'doctor 要放在包目录里运行（node doctor.js）'));
    return;
  }

  let pkg = null;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    rows.push(sub('package.json', 'fail', `不是合法 JSON：${error.message}`));
    return;
  }

  rows.push(pkg.name === PKG_NAME
    ? sub('package.json', 'ok', `name=${pkg.name}`)
    : sub('package.json', 'fail', `name=${pkg.name ?? '(缺)'}，不是 ${PKG_NAME}`, 'doctor 跑的不是这个包'));

  const mainRel = typeof pkg.main === 'string' ? pkg.main : './index.mjs';
  const mainFile = path.resolve(PKG_DIR, mainRel);
  rows.push(fileRow('host 入口', mainFile, `${path.basename(mainFile)}（main）`, '没有入口，插件加载会直接失败'));

  const clientRel = pkg.exports && typeof pkg.exports['./client'] === 'string' ? pkg.exports['./client'] : null;
  if (clientRel === null) {
    rows.push(sub('client 入口', 'fail', 'package.json 里没有 exports["./client"]', '浏览器不会加载面板（三个工具仍可用）'));
  } else {
    const clientFile = path.resolve(PKG_DIR, clientRel);
    if (!fs.existsSync(clientFile)) {
      rows.push(sub('client 入口', 'fail', `缺少 ${clientRel}`, '面板不会出现（三个工具仍可用）'));
    } else {
      const decl = pkg.dsh && pkg.dsh.client;
      if (!decl || typeof decl !== 'object') {
        rows.push(sub('client 入口', 'warn', `${path.basename(clientFile)} 存在，但 package.json 没有 dsh.client`, '浏览器不会加载它：补上 dsh.client 再重装'));
      } else {
        const platform = typeof decl.platform === 'string' ? decl.platform : '?';
        rows.push(sub('client 入口', 'ok', `${path.basename(clientFile)}（dsh.client: ${platform}${decl.immediately ? ', immediately' : ''}）`));
      }
    }
  }

  const patchRel = pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string'
    ? pkg.dsh.bundle.patch
    : null;
  if (patchRel === null) {
    rows.push(sub('插件行', 'fail', 'package.json 里没有 dsh.bundle.patch', 'profile 拿不到插件行：三个工具不会注册'));
  } else {
    const patchFile = path.resolve(PKG_DIR, patchRel);
    const patchText = readText(patchFile);
    if (patchText === null) {
      rows.push(sub('插件行', 'fail', `缺少 ${patchRel}`));
    } else if (!new RegExp(`^\\s*-\\s*id:\\s*['"]?${PATCH_ID}['"]?\\s*$`, 'm').test(patchText)) {
      rows.push(sub('插件行', 'fail', `${patchRel} 里没有 id: ${PATCH_ID}`));
    } else if (!patchText.includes(PKG_NAME)) {
      rows.push(sub('插件行', 'fail', `${patchRel} 里那行没有 name: ${PKG_NAME}`));
    } else {
      const provider = /provider:\s*(\S+)/.exec(patchText);
      rows.push(sub('插件行', 'ok', `${patchRel} → ${PATCH_ID}${provider ? `（provider: ${provider[1]}）` : ''}`));
    }
  }

  rows.push(checkLocales(pkg));
}

/**
 * 面板与插件列表的文案走官方 locale：`locale/<lang>.json` 的 meta 由宿主读，
 * 包内文案靠 client 半的 `inject: ['locale']`。这几处任一缺失，表现都是「面板突然
 * 变成一串 key」或「插件标题退回包名」，所以一起查。
 */
function checkLocales(pkg) {
  const problems = [];
  const titles = [];
  const details = [];

  for (const lang of ['zh', 'en']) {
    const file = path.join(PKG_DIR, 'locale', `${lang}.json`);
    const text = readText(file);
    if (text === null) {
      problems.push(`缺少 locale/${lang}.json`);
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`locale/${lang}.json 不是合法 JSON`);
      continue;
    }
    const meta = parsed && typeof parsed.meta === 'object' && parsed.meta !== null ? parsed.meta : {};
    const title = meta.title;
    if (typeof title !== 'string' || title.trim() === '') {
      problems.push(`locale/${lang}.json 没有 meta.title`);
    } else {
      titles.push(`${lang}: ${title}`);
    }

    // 插件页正文：`meta.detail` 指向包内的 Markdown，规则与宿主一致。写错或缺文件时，
    // 那一页会直接显示错误，而不是退回 README——所以在这里拦。
    if (meta.detail !== undefined) {
      const detail = meta.detail;
      const bad = typeof detail !== 'string'
        || detail.trim() === ''
        || detail.includes('\\')
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(detail)
        || detail.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
        || !/\.(md|markdown)$/i.test(detail);
      if (bad) {
        problems.push(`locale/${lang}.json 的 meta.detail 不是包内的 Markdown 相对路径`);
      } else if (!fs.existsSync(path.join(PKG_DIR, detail))) {
        problems.push(`meta.detail 指向的 ${detail} 不存在`);
      } else {
        details.push(`${lang} → ${detail}`);
      }
    }
  }

  // 官方把 locale 文件作为包导出暴露，宿主按 <包名>/locale/<lang>.json 去读。
  const exported = pkg.exports && pkg.exports['./locale/*.json'];
  const exportOk = typeof exported === 'string'
    || (exported && typeof exported === 'object' && typeof exported.default === 'string');
  if (!exportOk) problems.push('package.json 没有导出 ./locale/*.json');

  const inject = pkg.dsh && pkg.dsh.client && Array.isArray(pkg.dsh.client.inject)
    ? pkg.dsh.client.inject
    : [];
  if (!inject.includes('@deepseek-ai/dsh-client-locale')) {
    problems.push('dsh.client.inject 里没有 @deepseek-ai/dsh-client-locale');
  }

  const detailText = details.length > 0 ? ` · 正文 ${details.join(' / ')}` : '';
  return problems.length === 0
    ? sub('locale 资源', 'ok', `${titles.join(' · ')}${detailText}`)
    : sub('locale 资源', 'fail', problems.join('；'), '插件列表的标题/说明和面板文案都靠它');
}

/** profile 的 cordis.patch.yml 有没有把这一行关掉：按顶层 "- id:" 切块找 disabled: true */
function findDisabled(text, names) {
  let block = null;
  for (const line of text.split(/\r?\n/)) {
    const start = /^\s*-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (start) {
      block = { id: start[1], name: null };
      continue;
    }
    if (!block) continue;
    const named = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (named) {
      block.name = named[1];
      continue;
    }
    if (/^\s+disabled:\s*true\s*$/.test(line) && (names.includes(block.id) || names.includes(block.name))) {
      return block.id;
    }
  }
  return null;
}

/** node_modules 顶层的断链：目标不在了，包名还在清单里 */
function brokenLinks(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const broken = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    try {
      fs.realpathSync(full);
    } catch {
      let target = '?';
      try {
        target = fs.readlinkSync(full);
      } catch {
        target = '?';
      }
      broken.push(`${entry.name} → ${target}`);
    }
  }
  return broken;
}

function checkProfile(rows, home, profileName) {
  const profileDir = path.join(home, 'profiles', profileName);
  const profileJson = path.join(profileDir, 'package.json');
  const text = readText(profileJson);
  if (text === null) {
    let available = [];
    try {
      available = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      available = [];
    }
    rows.push(top(`profile ${profileName}`, 'fail', `读不出 ${profileJson}`,
      available.length > 0
        ? `现有的 profile：${available.join(', ')}；用 --profile 指定`
        : '还没有任何 profile：装一次 DSH 或指定 --home'));
    return;
  }

  let profile = null;
  try {
    profile = JSON.parse(text);
  } catch (error) {
    rows.push(top(`profile ${profileName}`, 'fail', `不是合法 JSON：${error.message}`));
    return;
  }
  rows.push(top(`profile ${profileName}`, 'ok', profileDir));

  const dep = profile && profile.dependencies ? profile.dependencies[PKG_NAME] : undefined;
  rows.push(typeof dep === 'string'
    ? sub('依赖声明', 'ok', dep)
    : sub('依赖声明', 'fail', `dependencies 里没有 ${PKG_NAME}`, `在 ${profileJson} 里加 "${PKG_NAME}": "link:${PKG_DIR}"，再重装`));

  const bundles = profile && profile.dsh && profile.dsh.profile ? profile.dsh.profile.bundles : undefined;
  if (!Array.isArray(bundles)) {
    rows.push(sub('bundle 列表', 'fail', 'package.json 里没有 dsh.profile.bundles', '没有这一项，profile 不会加载任何 bundle'));
  } else if (!bundles.includes(PKG_NAME)) {
    rows.push(sub('bundle 列表', 'fail', `${bundles.length} 项里没有 ${PKG_NAME}`, '只声明依赖、不进 bundles 时，包装了但不加载：工具不会出现'));
  } else {
    rows.push(sub('bundle 列表', 'ok', `第 ${bundles.indexOf(PKG_NAME) + 1} 项 / 共 ${bundles.length} 项`));
  }

  // 这一条是当初真正断掉的地方：链接消失，清单无损。
  const linkPath = path.join(profileDir, 'node_modules', PKG_NAME);
  let linkStat = null;
  try {
    linkStat = fs.lstatSync(linkPath);
  } catch {
    linkStat = null;
  }
  if (linkStat === null) {
    rows.push(sub('node_modules 链接', 'fail', `不存在 ${linkPath}`,
      `重装一次：plugin_manager remove_bundle ${PKG_NAME} → install_bundle ${PKG_DIR}`));
  } else {
    let real = null;
    try {
      real = fs.realpathSync(linkPath);
    } catch {
      real = null;
    }
    let rawTarget = null;
    if (linkStat.isSymbolicLink()) {
      try {
        rawTarget = fs.readlinkSync(linkPath);
      } catch {
        rawTarget = null;
      }
    }

    if (real === null) {
      rows.push(sub('node_modules 链接', 'fail', `指向的目录不存在：${rawTarget ?? linkPath}`,
        `重装一次：plugin_manager remove_bundle ${PKG_NAME} → install_bundle ${PKG_DIR}`));
    } else if (!linkStat.isSymbolicLink()) {
      rows.push(sub('node_modules 链接', 'warn', `是实体目录而不是链接（${real}）`, '改仓库里的代码不会生效：删掉它，按链接方式重装'));
    } else if (samePath(real, fs.realpathSync(PKG_DIR))) {
      rows.push(sub('node_modules 链接', 'ok', `→ ${rawTarget ?? real}`));
    } else {
      rows.push(sub('node_modules 链接', 'fail', `指向 ${real}，doctor 跑的是 ${fs.realpathSync(PKG_DIR)}`,
        '装的是另一份拷贝：两边的代码不会一起变'));
    }
  }

  // 清单里有、链接也在，却仍可能被 profile 的两层 YAML 关掉：cordis.yml 是根条目
  // 列表（正常是空数组），cordis.patch.yml 是补丁层。两处都扫，命中就提醒。
  const disabledIn = [];
  for (const name of ['cordis.patch.yml', 'cordis.yml']) {
    const file = path.join(profileDir, name);
    const text2 = readText(file);
    if (text2 === null) continue;
    const hit = findDisabled(text2, [PATCH_ID, PKG_NAME]);
    if (hit !== null) disabledIn.push(`${name} 里的 "${hit}"`);
  }
  rows.push(disabledIn.length === 0
    ? sub('是否被禁用', 'ok', 'cordis.patch.yml / cordis.yml 都没有 disabled: true')
    : sub('是否被禁用', 'warn', `被 ${disabledIn.join('、')} 关掉了`,
      '这是人为设置：想恢复就去掉那个 disabled，或改成 false'));

  const broken = brokenLinks(path.join(profileDir, 'node_modules'));
  if (broken.length > 0) {
    rows.push(sub('其他断链', 'warn', `${broken.length} 条：${broken.join('；')}`, '指向的目录已经不在：重装或删掉这些链接'));
  } else {
    rows.push(sub('其他断链', 'ok', '没有'));
  }
}

// ─────────────────────────────── 配置 ───────────────────────────────

function checkRole(rows, id, entry, catalog, why) {
  const route = `${entry.provider}/${entry.model}${entry.effort ? ` @${entry.effort}` : ''}`;
  const lifecycle = entry.lifecycle === 'one-shot' ? 'one-shot' : 'continuable';
  const preset = typeof entry.preset === 'string' && entry.preset.trim() !== '' ? ` · preset ${entry.preset.trim()}` : '';

  if (catalog === null) {
    // 接口都没通时不逐行提醒：端口那一行已经说了原因，这里只标「没核对」。
    rows.push(sub(id, 'skip', `${route} · ${lifecycle}${preset} · 未核对（${why}）`));
    return;
  }

  const provider = catalog.find((item) => item.id === entry.provider);
  if (!provider) {
    rows.push(sub(id, 'fail', `${route} · provider "${entry.provider}" 不在实时目录里（有：${catalog.map((item) => item.id).join(', ') || '无'}）`,
      '改 dmr.json，或先把该 provider 的凭据配上'));
    return;
  }

  const models = Array.isArray(provider.models) ? provider.models : [];
  if (models.length === 0) {
    rows.push(sub(id, 'warn', `${route} · ${provider.id} 的目录是空的（可能没配凭据），无法核对`));
    return;
  }

  const model = models.find((item) => item.id === entry.model);
  if (!model) {
    rows.push(sub(id, 'fail', `${route} · "${entry.model}" 不在 ${provider.id} 的目录里（有：${models.map((item) => item.id).join(', ')}）`,
      '派活时这一行会在创建子代理之前被拒绝'));
    return;
  }

  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  if (entry.effort && efforts.length > 0 && !efforts.includes(entry.effort)) {
    rows.push(sub(id, 'fail', `${route} · effort "${entry.effort}" 不在 ${model.id} 的档位里（有：${efforts.join(', ')}）`,
      '派活时同样会被拒绝'));
    return;
  }

  // 目录里的 id 和界面上的显示名不是一回事，一起写出来省得对不上号。
  const shown = model.name && model.name !== model.id ? `（${model.name}）` : '';
  rows.push(sub(id, 'ok', `${route}${shown} · ${lifecycle}${preset}`));
}

function checkRouteTable(rows, home, catalog, why) {
  const file = path.join(home, 'dmr.json');
  const text = readText(file);

  if (text === null) {
    let exists = true;
    try {
      fs.statSync(file);
    } catch {
      exists = false;
    }
    rows.push(exists
      ? top('路由表', 'fail', `${file} 读不出来`, '权限问题：派活时会直接报错')
      : top('路由表', 'skip', `${file} 不存在`, '三个角色都继承父会话的路由；要分阶段就复制 dmr.example.json'));
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    rows.push(top('路由表', 'fail', `${file} 不是合法 JSON：${error.message}`, '文件存在但写坏时，派活会直接报错（不会退回继承）'));
    return;
  }

  try {
    validateRouteTable(parsed);
  } catch (error) {
    rows.push(top('路由表', 'fail', `${file}：${error.message}`, '面板保存时也是这条规则，先改到能存进去'));
    return;
  }

  const roles = parsed && typeof parsed.roles === 'object' && parsed.roles ? parsed.roles : {};
  const ids = Object.keys(roles);
  rows.push(top('路由表', 'ok', ids.length === 0
    ? `${file}（0 个角色，全部继承）`
    : `${file}（${ids.length} 个角色）`));

  for (const id of ROLE_IDS) {
    const entry = roles[id];
    if (!entry || typeof entry !== 'object') {
      rows.push(sub(id, 'skip', '未配置 → 继承父会话'));
      continue;
    }
    checkRole(rows, id, entry, catalog, why);
  }
}

function checkRounds(rows, home) {
  const file = path.join(home, 'dmr-rounds.jsonl');
  const text = readText(file);
  if (text === null) {
    rows.push(top('最近委派日志', 'skip', `${file} 不存在（还没派过活）`));
    return;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  let latest = null;
  for (let index = lines.length - 1; index >= 0 && latest === null; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed.at === 'number') latest = parsed.at;
    } catch {
      // 半行 / 坏行：跳过
    }
  }
  rows.push(top('最近委派日志', 'ok', `${lines.length} 行 · 最近 ${latest === null ? '-' : formatTime(latest)}`));
}

// ─────────────────────────────── 会话日志 ───────────────────────────────

function checkSessions(rows, home) {
  const root = path.join(home, 'sessions');
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    rows.push(top('sessions', 'fail', `读不出 ${root}（${errorCode(error)}）`,
      '没有会话日志，面板的「最近委派」和 route-check 都会是空的：先确认 --home 对，再开一次会话'));
    return;
  }

  let count = 0;
  let latestFile = null;
  let latestMs = 0;
  for (const slug of slugs) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, slug.name, entry.name, LOG_NAME);
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      count += 1;
      if (stat.mtimeMs > latestMs) {
        latestMs = stat.mtimeMs;
        latestFile = file;
      }
    }
  }

  if (count === 0) {
    rows.push(top('sessions', 'warn', `${root} 里没有 ${LOG_NAME}`, '还没跑过会话：面板和 route-check 会是空的，这不算故障'));
    return;
  }

  rows.push(top('sessions', 'ok', `${count} 个会话日志 · ${slugs.length} 个工作区 · 最近 ${formatTime(latestMs)}`));

  // 能列目录不等于能解压：读 4 个字节确认是 zstd 帧，免得拿一堆解不开的文件去算钱。
  try {
    const fd = fs.openSync(latestFile, 'r');
    const head = Buffer.alloc(4);
    try {
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    rows.push(head.equals(ZSTD_MAGIC)
      ? sub('最新日志', 'ok', '可以读，且是 zstd 帧')
      : sub('最新日志', 'warn', '头 4 字节不是 zstd 魔数', '日志可能被截断或被别的程序改过：route-check 会读不出这一段'));
  } catch (error) {
    rows.push(sub('最新日志', 'fail', `读不出来（${errorCode(error)}）`, '面板和 route-check 的花费都会是空的'));
  }
}

// ─────────────────────────────── 接口 ───────────────────────────────

function httpGet(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve({ ...value, ms: Number((process.hrtime.bigint() - started) / 1000000n) });
    };

    const timer = setTimeout(() => {
      finish({ status: 0, error: 'timeout' });
      req.destroy();
    }, timeoutMs);

    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers: { accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (error) => {
          clearTimeout(timer);
          finish({ status: 0, error: errorCode(error) });
        });
      },
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      finish({ status: 0, error: errorCode(error) });
    });
  });
}

function readJsonBody(res) {
  if (!res || res.status !== 200 || typeof res.body !== 'string') return null;
  try {
    const parsed = JSON.parse(res.body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** /config 的响应形状：{ path, exists, text }。用它把「DMR 的端口」和别人的端口分开 */
function readConfigBody(res) {
  const body = readJsonBody(res);
  if (!body) return null;
  if (typeof body.path !== 'string' || typeof body.text !== 'string') return null;
  return body;
}

/** 本机处于 LISTENING 的端口（回环优先）。拿不到就返回空数组。 */
function listListening() {
  const run = (command, args) => {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      return '';
    }
  };

  const found = [];
  if (process.platform === 'win32') {
    const text = run('netstat', ['-ano', '-p', 'TCP']);
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*TCP\s+(.+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
      if (!match) continue;
      const host = match[1].replace(/^\[|\]$/g, '');
      if (!LOOPBACK_HOSTS.includes(host)) continue;
      found.push({ port: Number(match[2]), pid: Number(match[3]), loopback: host === '127.0.0.1' || host === '::1' });
    }
    return found;
  }

  for (const [command, args] of [['ss', ['-ltn']], ['netstat', ['-ltn']]]) {
    const text = run(command, args);
    if (text === '') continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTEN/.test(line)) continue;
      const fields = line.trim().split(/\s+/);
      const local = fields.find((field) => /^\[?[0-9a-fA-F.:*]+\]:\d+$/.test(field));
      if (!local) continue;
      const cut = local.lastIndexOf(':');
      const host = local.slice(0, cut).replace(/^\[|\]$/g, '');
      if (!LOOPBACK_HOSTS.includes(host)) continue;
      found.push({ port: Number(local.slice(cut + 1)), pid: null, loopback: host === '127.0.0.1' || host === '::1' });
    }
    break;
  }
  return found;
}

function uniquePorts(list) {
  const byPort = new Map();
  for (const entry of list) {
    const seen = byPort.get(entry.port);
    if (!seen || (entry.loopback && !seen.loopback)) byPort.set(entry.port, entry);
  }
  return [...byPort.values()]
    .sort((a, b) => (Number(b.loopback) - Number(a.loopback)) || (a.port - b.port))
    .slice(0, 64);
}

/**
 * 端口每次重启都会变，所以默认不猜：先扫本机监听端口，再用 /config 的**响应形状**
 * 认出来。只看状态码不够——实测本机有别的程序对任意路径都回 200。
 */
async function probeService(explicitPort, home) {
  const state = {
    port: null,
    source: null,
    pid: null,
    scanned: 0,
    config: null,
    models: null,
    rounds: null,
    stats: null,
    catalog: null,
  };

  if (explicitPort !== null) {
    state.port = explicitPort;
    state.source = '--port 指定';
    const owner = uniquePorts(listListening()).find((entry) => entry.port === explicitPort);
    state.pid = owner ? owner.pid : null;
  } else {
    const candidates = uniquePorts(listListening());
    state.scanned = candidates.length;
    if (candidates.length === 0) return state;

    const probed = await Promise.all(candidates.map(async (entry) => ({
      entry,
      res: await httpGet(entry.port, `${BASE_PATH}/config`, 700),
    })));
    const hits = probed.filter((item) => readConfigBody(item.res) !== null);
    if (hits.length === 0) return state;

    // 有多个 DSH 实例时，优先选「读的正是 doctor 要查的那份 dmr.json」的那个。
    const wanted = path.join(home, 'dmr.json');
    hits.sort((a, b) => {
      const am = samePath(readConfigBody(a.res).path, wanted) ? 0 : 1;
      const bm = samePath(readConfigBody(b.res).path, wanted) ? 0 : 1;
      return (am - bm) || (a.entry.port - b.entry.port);
    });
    state.port = hits[0].entry.port;
    state.pid = hits[0].entry.pid;
    state.config = hits[0].res;
    state.source = `netstat 扫了 ${candidates.length} 个监听端口，${hits.length} 个应答`;
  }

  if (state.port === null) return state;

  if (state.config === null) {
    state.config = await httpGet(state.port, `${BASE_PATH}/config`, 1500);
  }
  const [models, rounds, stats] = await Promise.all([
    httpGet(state.port, `${BASE_PATH}/models`, 4000),
    httpGet(state.port, `${BASE_PATH}/rounds`, 8000),
    httpGet(state.port, `${BASE_PATH}/stats`, 1500),
  ]);
  state.models = models;
  state.rounds = rounds;
  state.stats = stats;

  const modelBody = readJsonBody(models);
  if (modelBody && Array.isArray(modelBody.providers)) state.catalog = modelBody.providers;
  return state;
}

/** DSH 进程的启动时间：磁盘上的文件比它新，说明运行中的代码是旧的 */
function processStart(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const text = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `[int64]((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true },
      );
      const ms = Number(text.trim());
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const text = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const seconds = Number(text.trim());
    return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : null;
  } catch {
    return null;
  }
}

function describeHttp(res) {
  if (!res) return '没有请求';
  if (res.status === 0) return `连接失败（${res.error ?? 'unknown'}）`;
  return `${res.status} · ${res.ms}ms`;
}

function checkEndpoints(rows, state, home) {
  if (state.port === null) {
    rows.push(top('端口', 'fail', '没有端口应答 DMR 的 /config',
      `扫了 ${state.scanned} 个本机监听端口；DSH 没在运行就用 --port 指定 GUI 端口`));
    return;
  }

  const configBody = readConfigBody(state.config);

  // 端口有应答不等于端口是对的：本机有别的程序对任意路径都回 200，所以端口这一行
  // 也按 /config 的响应形状判定，而不是「连上了就算」。
  rows.push(configBody === null
    ? top('端口', 'fail', `${state.port}${state.pid ? `（pid ${state.pid}）` : ''} · ${describeHttp(state.config)}`,
      '这个端口回的 /config 不是 {path, exists, text}；别加 --port 让它自己找，或换一个端口')
    : top('端口', 'ok', `${state.port}${state.pid ? `（pid ${state.pid}）` : ''}`, state.source));

  if (configBody === null) {
    // 端口认错了，其余三个接口必然一起报错：只说一次，别拿四行同样的失败凑数。
    rows.push(sub('/config', 'fail', describeHttp(state.config)));
    rows.push(sub('/models /rounds /stats', 'skip', '没有查（端口不对）'));
    return;
  }

  const wanted = path.join(home, 'dmr.json');
  rows.push(samePath(configBody.path, wanted)
    ? sub('/config', 'ok', `${describeHttp(state.config)} · 与 doctor 读的是同一份 dmr.json`)
    : sub('/config', 'warn', `${describeHttp(state.config)} · 插件读 ${configBody.path}，doctor 读 ${wanted}`,
      '两边不是同一份文件：--home 可能指错了'));

  const modelBody = readJsonBody(state.models);
  if (modelBody === null || !Array.isArray(modelBody.providers)) {
    rows.push(sub('/models', 'fail', `${describeHttp(state.models)}${modelBody && modelBody.error ? ` · ${modelBody.error}` : ''}`,
      '面板的模型下拉会是空的，dmr.json 里的模型也无法核对'));
  } else {
    const providers = modelBody.providers;
    const models = providers.reduce((sum, item) => sum + (Array.isArray(item.models) ? item.models.length : 0), 0);
    const empty = providers.filter((item) => !Array.isArray(item.models) || item.models.length === 0).map((item) => item.id);
    rows.push(sub('/models', 'ok', `${describeHttp(state.models)} · ${providers.length} 个 provider / ${models} 个模型${empty.length > 0 ? `（${empty.join(', ')} 为空）` : ''}`));
  }

  const roundsBody = readJsonBody(state.rounds);
  if (roundsBody === null || !Array.isArray(roundsBody.rounds)) {
    rows.push(sub('/rounds', 'fail', `${describeHttp(state.rounds)}${roundsBody && roundsBody.error ? ` · ${roundsBody.error}` : ''}`,
      '面板的「最近委派」会是空的'));
  } else {
    const expected = path.join(home, 'dmr-rounds.jsonl');
    const lines = roundsBody.rounds.length;
    if (typeof roundsBody.file === 'string' && !samePath(roundsBody.file, expected)) {
      rows.push(sub('/rounds', 'warn', `${describeHttp(state.rounds)} · 读了 ${roundsBody.file}，doctor 看的是 ${expected}`));
    } else {
      rows.push(sub('/rounds', 'ok', `${describeHttp(state.rounds)} · 回报 ${lines} 次委派`));
    }
  }

  const statsBody = readJsonBody(state.stats);
  if (statsBody === null || !Array.isArray(statsBody.released)) {
    rows.push(sub('/stats', 'fail', `${describeHttp(state.stats)}${statsBody && statsBody.error ? ` · ${statsBody.error}` : ''}`));
  } else {
    rows.push(sub('/stats', 'ok', `${describeHttp(state.stats)} · 本进程释放过 ${statsBody.released.length} 个子代理`));
  }

  checkFreshness(rows, state.pid);
}

/** 磁盘上的入口文件比进程新：改动还没生效（client 半要重启 DSH，host 半要重装） */
function checkFreshness(rows, pid) {
  const startMs = processStart(pid);
  if (startMs === null) {
    rows.push(sub('运行中的代码', 'skip', '拿不到 DSH 进程的启动时间，未核对'));
    return;
  }

  const stale = [];
  for (const [name, what] of [['index.mjs', '三个工具'], ['client.js', '详情页的面板']]) {
    let stat = null;
    try {
      stat = fs.statSync(path.join(PKG_DIR, name));
    } catch {
      continue;
    }
    // 留 2 秒余量：安装/克隆时 mtime 可能与进程启动同秒
    if (stat.mtimeMs > startMs + 2000) stale.push(`${name}（${what}）改于 ${formatTime(stat.mtimeMs)}`);
  }

  if (stale.length === 0) {
    rows.push(sub('运行中的代码', 'ok', `进程启动于 ${formatTime(startMs)}，比包内文件新`));
  } else {
    rows.push(sub('运行中的代码', 'warn', `${stale.join('；')}，晚于进程启动 ${formatTime(startMs)}`,
      'host 半重装一次插件即生效；client 半必须重启 DSH（刷新页面不够）'));
  }
}

// ─────────────────────────────── 输出 ───────────────────────────────

function allRows(sections) {
  return sections.flatMap((section) => section.rows);
}

function summarize(sections) {
  const rows = allRows(sections);
  const summary = { total: 0, ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const row of rows) {
    if (row.status !== 'skip') summary.total += 1;
    summary[row.status] += 1;
  }
  return summary;
}

function printReport(report) {
  const lines = [];
  lines.push(`DMR doctor · home ${report.home} · profile ${report.profile}${report.port === null ? '' : ` · 端口 ${report.port}`}`);
  lines.push('');

  const header = ['检查', '状态', '说明'];
  const cells = [];
  for (const section of report.sections) {
    if (section.rows.length === 0) continue;
    cells.push([section.title, '', '']);
    for (const row of section.rows) {
      cells.push([`${'  '.repeat(row.depth)}${row.item}`, MARK[row.status], row.detail]);
    }
  }

  const widths = header.map((title, index) =>
    Math.max(cellWidth(title), ...cells.map((row) => cellWidth(row[index]))));

  lines.push(header.map((title, index) => padCell(title, widths[index])).join('  ').trimEnd());
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of cells) {
    lines.push(row.map((value, index) => padCell(value, widths[index])).join('  ').trimEnd());
  }

  const summary = report.summary;
  const parts = [`${summary.ok}/${summary.total} 通过`];
  if (summary.warn > 0) parts.push(`${summary.warn} 项提醒`);
  if (summary.fail > 0) parts.push(`${summary.fail} 项失败`);
  if (summary.skip > 0) parts.push(`${summary.skip} 项跳过`);
  lines.push('');
  lines.push(parts.join(' · '));

  const failed = allRows(report.sections).filter((row) => row.status === 'fail');
  for (const row of failed) {
    if (row.hint) lines.push(`hint: ${row.item.trim()} —— ${row.hint}`);
  }
  for (const row of allRows(report.sections)) {
    if (row.status === 'warn' && row.hint) lines.push(`提醒: ${row.item.trim()} —— ${row.hint}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function toJson(report) {
  return {
    home: report.home,
    profile: report.profile,
    port: report.port,
    portSource: report.portSource,
    sections: report.sections.map((section) => ({
      title: section.title,
      rows: section.rows.map((row) => ({
        item: row.item,
        depth: row.depth,
        status: row.status,
        detail: row.detail,
        ...(row.hint ? { hint: row.hint } : {}),
      })),
    })),
    summary: report.summary,
  };
}

// ─────────────────────────────── 入口 ───────────────────────────────

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const opts = { home: null, profile: 'desktop', port: null, json: false };
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

    if (name === '--home' || name === '--profile' || name === '--port') {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new DoctorError(`missing value for ${name}`);
        i += 1;
        value = next;
      }
      if (value.trim() === '') throw new DoctorError(`empty value for ${name}`);

      if (name === '--home') {
        opts.home = value;
      } else if (name === '--profile') {
        if (value !== path.basename(value)) throw new DoctorError(`invalid --profile: ${value} (want a directory name under profiles/)`);
        opts.profile = value;
      } else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DoctorError(`invalid --port: ${value}`);
        opts.port = port;
      }
      continue;
    }

    throw new DoctorError(`unknown argument: ${raw}`);
  }

  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof DoctorError)) throw error;
    process.stderr.write(`error: ${error.message}\n${USAGE}\n`);
    return error.exitCode;
  }

  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const home = path.resolve(opts.home ?? defaultHome());

  const sections = [
    { title: '环境', rows: [] },
    { title: '安装', rows: [] },
    { title: '配置', rows: [] },
    { title: '会话日志', rows: [] },
    { title: '接口', rows: [] },
  ];
  const [environment, installed, config, sessions, endpoints] = sections.map((section) => section.rows);

  // 主目录都不对时，后面的每一条都会跟着错，不如停在这里说清楚。
  let state = null;
  if (checkEnvironment(environment, home)) {
    checkPackage(installed);
    checkProfile(installed, home, opts.profile);

    // 先摸接口：角色行的模型核对要用实时目录，而目录只有接口能给。
    state = await probeService(opts.port, home);
    checkRouteTable(config, home, state.catalog, state.port === null ? 'DSH 没在运行' : '/models 读不出来');
    checkRounds(config, home);
    checkSessions(sessions, home);
    checkEndpoints(endpoints, state, home);
  }

  const report = {
    home,
    profile: opts.profile,
    port: state === null ? null : state.port,
    portSource: state === null ? null : state.source,
    sections,
  };
  report.summary = summarize(sections);

  if (opts.json) process.stdout.write(`${JSON.stringify(toJson(report), null, 2)}\n`);
  else printReport(report);

  return report.summary.fail > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`error: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);
