'use strict';

/**
 * dsh/lib/pricing.js —— DSH 会话日志的按 token 计价（$/百万 token）
 *
 * 口径从 Claude Code 版 CMR 的 plugins/usage/usage-audit.js 原样搬来（PRICE / OFFPEAK_HALF /
 * isDeepSeekPeak / priceKey / isPriced / priceOf / priceLabel / usdOf），只去掉 Claude 专有的
 * 1 小时写缓存（cw1h）：DSH 日志没有这个区分，一律当 0。
 *
 * 单位：PRICE[模型] = [输入, 输出, 读缓存, 写缓存（5 分钟）]，**$/百万 token**，且都是**高峰价**。
 * 分时计价：OFFPEAK_HALF 里的模型（deepseek-flash / deepseek-v4-flash / deepseek-v4-pro）
 * 在**非高峰减半**。DeepSeek 高峰 = 周一到周五 UTC 01–04 点、06–10 点（北京 9–12 点、14–18 点），
 * 其余时间（含周末）非高峰。
 *
 * 单条消息的美元：usd = k * (i*pi + o*po + cr*pr + cw*pw) / 1e6，
 * k = 该消息的时间落在非高峰、且模型属于 OFFPEAK_HALF ? 0.5 : 1。
 * **时间由调用方按每条消息自己的 time 传进来**（不是会话开始时间）：同一次会话跨高峰/非高峰时单价会变。
 *
 * 查价：先原样查；查不到再去掉末尾 -YYYYMMDD 日期后缀查（deepseek-flash-20260101 → deepseek-flash）；
 * 还没有才落到 _default，此时 isPriced() 为 false，由调用方在输出里标记「按默认价估」。
 *
 * 已知偏差：DeepSeek 官方对**法定节假日**全天算非高峰，这里不认节假日（只按星期 + UTC 小时判断），
 * 节假日那几天会按高峰价**多估**（flash 类正好多一倍）。
 */

/**
 * 模型公开价（$/百万 token）：[输入, 输出, 读缓存, 写缓存（5 分钟）]。
 * 5 系来自 CC Switch 的 model_pricing 表（Claude Code 版口径）；DeepSeek 三项取自
 * api-docs.deepseek.com 定价页（10-26），是高峰价，没有单独的写缓存费，未命中按输入价算，
 * 所以第 4 项 = 输入价。deepseek-v4-flash 是旧名，现由 flash 接管、按 flash 计价。
 * _default 只给查不到价的模型兜底，用到就会在输出里标 *。
 */
const PRICE = {
  'deepseek-flash': [0.30, 1.20, 0.006, 0.30],
  'deepseek-v4-flash': [0.30, 1.20, 0.006, 0.30],
  'deepseek-v4-pro': [1.32, 3.96, 0.044, 1.32],
  _default: [5, 25, 0.50, 6.25],
};

/**
 * 分时计价的模型：PRICE 里是高峰价，非高峰减半。
 * 中国法定节假日全天算非高峰，这里不认节假日，那几天会按高峰多估（已知偏差，见文件头）。
 */
const OFFPEAK_HALF = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']);

/** DeepSeek 高峰：周一到周五 UTC 01–04 点、06–10 点（北京 9–12 点、14–18 点）；其余时间含周末都非高峰 */
const isDeepSeekPeak = (t) => {
  const d = new Date(t);
  const h = d.getUTCHours();
  const w = d.getUTCDay();
  return w >= 1 && w <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * 查价用的键：先原样查，再去掉末尾 -YYYYMMDD 日期后缀查（haiku-4-5-20251001 → haiku-4-5）。
 * 用 hasOwnProperty 而不是 `in`：模型名来自日志，不能让 __proto__ 之类的名字查到原型上去。
 */
const priceKey = (model) => {
  const name = typeof model === 'string' ? model : String(model);
  if (hasOwn(PRICE, name)) return name;
  return name.replace(/-\d{8}$/, '');
};

/** 价表里有没有这个模型（false = 会落到 _default，调用方要标记） */
const isPriced = (model) => hasOwn(PRICE, priceKey(model));

/** 取单价四元组；查不到就给 _default */
const priceOf = (model) => (isPriced(model) ? PRICE[priceKey(model)] : PRICE._default);

/** 单价的可读形式，例如 priceLabel('deepseek-flash') → "$0.3/1.2/0.006/0.3" */
const priceLabel = (model) => {
  const [pi, po, pr, pw] = priceOf(model);
  return `$${pi}/${po}/${pr}/${pw}`;
};

/** 非数字的 token 计数一律当 0（缺字段 / undefined / NaN 都不让整条算成 NaN） */
const num = (value) => (Number.isFinite(value) ? value : 0);

/**
 * 一条消息的美元（未四舍五入）。
 * @param {{model: string|null, i?: number, o?: number, cr?: number, cw?: number, t?: number}} r
 *   i=输入、o=输出、cr=读缓存、cw=写缓存（5 分钟）、t=该条消息自己的 time（毫秒时间戳）
 * @returns {number} 美元；t 不是有限数时按高峰价（无法判断在非高峰，就不擅自减半）
 */
const usdOf = (r) => {
  const [pi, po, pr, pw] = priceOf(r.model);
  const k = OFFPEAK_HALF.has(priceKey(r.model)) && Number.isFinite(r.t) && !isDeepSeekPeak(r.t) ? 0.5 : 1;
  return (k * (num(r.i) * pi + num(r.o) * po + num(r.cr) * pr + num(r.cw) * pw)) / 1e6;
};

module.exports = {
  PRICE,
  OFFPEAK_HALF,
  isDeepSeekPeak,
  priceKey,
  isPriced,
  priceOf,
  priceLabel,
  usdOf,
};
