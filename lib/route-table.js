'use strict';

/**
 * lib/route-table.js —— 路由表的结构校验。
 *
 * 三处共用这一份，免得「面板保存得进去、派活却读不出来」：
 *   - index.mjs 的 PUT /config（写盘之前校验）
 *   - doctor.js（核对 dmr.json 时给出与面板一致的错误话术）
 *
 * 允许空：某个角色缺省、或整个 roles 缺省，都表示「继承父会话」，这是人可以做
 * 的决定。不允许的是「声明了但写错」：provider/model 必须是字符串，lifecycle 只
 * 有两个值，effort 写了就得是字符串。
 */

/** 三个角色，顺序与页面上的表格一致 */
const ROLE_IDS = ['plan', 'impl', 'review'];

function validateRouteTable(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the top level must be an object');
  const roles = parsed.roles;
  if (roles !== undefined && (roles === null || typeof roles !== 'object' || Array.isArray(roles))) {
    throw new Error('"roles" must be an object');
  }
  for (const [id, entry] of Object.entries(roles ?? {})) {
    if (!ROLE_IDS.includes(id)) throw new Error(`unknown role "${id}" (expected ${ROLE_IDS.join(', ')})`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`roles.${id} must be an object`);
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      throw new Error(`roles.${id}.provider must be a non-empty string`);
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      throw new Error(`roles.${id}.model must be a non-empty string`);
    }
    if (entry.effort !== undefined && typeof entry.effort !== 'string') {
      throw new Error(`roles.${id}.effort must be a string`);
    }
    if (entry.lifecycle !== undefined && entry.lifecycle !== 'one-shot' && entry.lifecycle !== 'continuable') {
      throw new Error(`roles.${id}.lifecycle must be "one-shot" or "continuable"`);
    }
    if (entry.preset !== undefined && typeof entry.preset !== 'string') {
      throw new Error(`roles.${id}.preset must be a string`);
    }
  }
  return parsed;
}

module.exports = { ROLE_IDS, validateRouteTable };
