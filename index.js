/**
 * 端口密钥绑定 Port Key Binder
 * SillyTavern 扩展：把「地址/端口 + API 密钥」保存为多个方案，一键切换，不用每次换密钥都手写端口。
 *
 * 功能：
 *  - 在输入框魔法棒按钮正上方放一个快捷按钮，点开下拉列出所有方案，点选即直接替换端口+密钥
 *  - 完整面板支持添加/编辑/删除多个方案，含快速切换下拉
 *  - 应用时自动切到 Chat Completion + Custom（OpenAI 兼容）源，写入地址与密钥
 *  - 兼容新旧版本（oai_settings + secrets 密钥系统 / 旧版 settings + 输入框）
 *
 * 安装：把整个 api 文件夹放到 SillyTavern/public/scripts/extensions/ 下
 * 使用：点击输入框左下角魔法棒按钮上方的钥匙按钮，或 设置 → 扩展 → 端口密钥绑定
 */

import {
    extension_settings,
    getContext,
} from '/scripts/extensions.js';
import {
    saveSettingsDebounced,
    saveSettings as saveSettingsImmediate,
    selectRightMenuWithAnimation,
    eventSource,
    event_types,
    online_status,
} from '/script.js';

const EXTENSION_KEY = 'port_key_binder';
const EXTENSION_DISPLAY = '端口密钥绑定';

const defaultSettings = {
    presets: [],          // [{ id, name, url, key, model, syncLabel }]
    models: [],           // [{ id, name }] 模型名列表
    lastModel: '',        // 最近一次应用的模型
    autoSwitchSource: true,
    defaultHost: '127.0.0.1',
    lastAppliedId: null,
    secretIndex: [],      // [{ fp: 密钥指纹, id: 密钥记录ID, name, url, ts }] 用于切换时精确复用同一密钥，绝不重复添加
};

let panel = null;
let editingId = null;
let quickMenuVisible = false;

/* ================= 设置读写 ================= */

function getSettings() {
    if (!extension_settings[EXTENSION_KEY]) {
        extension_settings[EXTENSION_KEY] = { ...defaultSettings };
    }
    const s = extension_settings[EXTENSION_KEY];
    if (!Array.isArray(s.presets)) s.presets = [];
    if (!Array.isArray(s.models)) s.models = [];
    if (typeof s.lastModel !== 'string') s.lastModel = '';
    if (typeof s.autoSwitchSource !== 'boolean') s.autoSwitchSource = true;
    if (!s.defaultHost) s.defaultHost = '127.0.0.1';
    if (!Array.isArray(s.secretIndex)) s.secretIndex = [];
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

/** 立即写入设置（不防抖），用于密钥指纹这种「必须持久化」的关键数据；失败则退回防抖 */
function saveSettingsNow() {
    try {
        if (typeof saveSettingsImmediate === 'function') { saveSettingsImmediate(); return; }
    } catch (e) { /* 退回防抖 */ }
    saveSettingsDebounced();
}

/* ================= 工具函数 ================= */

function normalizeUrl(raw) {
    let url = (raw || '').trim();
    if (!url) return '';
    if (/^\d+$/.test(url)) {
        // 只填端口号 -> 自动补全为 http://127.0.0.1:端口
        const s = getSettings();
        url = `http://${s.defaultHost}:${url}`;
    } else if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }
    return url;
}

function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 稳定字符串指纹（djb2），用于本地精确识别“同一个密钥”，非安全用途 */
function hashKey(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/** 复刻服务端 getMaskedValue 的掩码算法（allowKeysExposure=false 时 secret_state.value 的形态）：
    长度 ≤10 → 10 个 *；否则 → 7 个 * + 末 3 位。用于「末 3 位相同即同一密钥」的复用判断。 */
function maskOfKey(key) {
    const s = String(key || '');
    if (s.length <= 10) return '**********';
    return '*******' + s.slice(-3);
}

/** 计算要同步到 API 密钥备注名的文字：
    勾选「同步备注」→ 备注非空用备注，备注为空回退方案名；
    否则勾选「同步方案名」→ 用方案名；都没勾 → 空串（不同步）。 */
function computeSyncLabel(preset) {
    if (!preset) return '';
    const note = String(preset.note || '').trim();
    if (preset.syncNote) return note || String(preset.name || '').trim();
    if (preset.syncLabel) return String(preset.name || '').trim();
    return '';
}

/** 时间戳 → YYYY-MM-DD HH:mm（去重弹窗展示用） */
function formatTs(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return ''; }
}

let __pkbPlainAllowed = null; // null=未知；true=服务端允许明文（allowKeysExposure）
/** 探测服务端是否允许明文暴露（/api/secrets/settings），结果缓存。 */
async function detectPlainAllowed() {
    if (__pkbPlainAllowed !== null) return __pkbPlainAllowed;
    try {
        const resp = await fetch('/api/secrets/settings', {
            method: 'POST',
            headers: (typeof getRequestHeaders === 'function') ? getRequestHeaders({ omitContentType: true }) : { 'Content-Type': 'application/json' },
        });
        const d = resp.ok ? await resp.json() : null;
        __pkbPlainAllowed = !!(d && d.allowKeysExposure === true);
    } catch (e) { __pkbPlainAllowed = false; }
    return __pkbPlainAllowed;
}

/* ================= 应用方案 / 模型 ================= */

/**
 * 动态加载 SillyTavern 内部模块，返回 { scriptMod, settings, oaiSettings }。
 * 适配不同版本，任一失败都不影响整体。
 */
async function loadChatContext() {
    const out = { scriptMod: null, settings: null, oaiSettings: null };
    try { out.scriptMod = await import('/script.js'); } catch (e) { /* ignore */ }
    try { out.settings = out.scriptMod?.settings || window.settings; } catch (e) { /* ignore */ }
    // oai_settings：优先走公开的 getContext().chatCompletionSettings
    try {
        const context = getContext();
        out.oaiSettings = context?.chatCompletionSettings || null;
    } catch (e) { /* ignore */ }
    if (!out.oaiSettings) {
        try {
            const oaiMod = await import('/scripts/openai.js');
            out.oaiSettings = oaiMod?.oai_settings || null;
        } catch (e) { /* ignore */ }
    }
    return out;
}

/** 读取当前 Custom 源正在使用的模型名 */
async function getCurrentModel() {
    try {
        const ctx = await loadChatContext();
        return (ctx.oaiSettings && ctx.oaiSettings.custom_model) ||
               (ctx.settings && ctx.settings.custom_model) ||
               '';
    } catch (e) { return ''; }
}

/** 切换模型（Custom/OpenAI 兼容源）。opts.silent=true 时不弹 toast（应用方案时随方案一起切） */
async function applyModel(modelName, opts = {}) {
    const silent = !!opts.silent;
    const skipReconnect = !!opts.skipReconnect;
    try {
        const name = String(modelName || '').trim();
        if (!name) return;
        const s = getSettings();
        const ctx = await loadChatContext();
        if (ctx.oaiSettings) ctx.oaiSettings.custom_model = name;
        if (ctx.settings) ctx.settings.custom_model = name;
        // 同步到 API 设置界面的 Custom 源模型输入框（官方 #custom_model_id，input 事件由官方 handler 写全局并保存）
        const mSel = $('#custom_model_id');
        if (mSel.length) mSel.val(name).trigger('input');
        // 走官方 #model_custom_select change 通道，确保与 API 界面完全一致：
        // 模型列表接口不可用时（官方一直显示「绕过检查」）下拉为空，这里主动补上该模型再选中，
        // 保证方案里的模型每次都能被真正应用。
        const mSelect = $('#model_custom_select');
        if (mSelect.length) {
            if (!mSelect.find(`option[value="${CSS.escape(name)}"]`).length) {
                mSelect.append($('<option>').val(name).text(name));
            }
            mSelect.val(name).trigger('change');
        }
        s.lastModel = name;
        // 记住该方案上次连接的模型：之后切回此方案会自动连接它
        const curPreset = s.presets.find(p => p.id === s.lastAppliedId);
        if (curPreset) curPreset.lastModel = name;
        saveSettings();
        // 同步「可用模型」下拉与补全列表
        syncApiModelList(s.models, name);
        // ——真正连接：仅当当前为 Custom 源时，触发官方 #main_api change 强制按新模型重连，
        //    让 API 连接设置界面与本次切换实时同步（与官方切换模型行为一致）——
        //    优化：切换方案流程中（skipReconnect=true）来源切换已触发过官方重连，此处跳过避免重复请求。
        const isCustom = (ctx.oaiSettings && ctx.oaiSettings.chat_completion_source === 'custom')
            || ($('#chat_completion_source').length && $('#chat_completion_source').val() === 'custom');
        if (isCustom && !skipReconnect) {
            const mainApi = $('#main_api');
            if (mainApi.length) mainApi.trigger('change');
        }
        if (!silent) toastr.success(`已切换模型：${name}`);
        renderQuickMenu();
        if (panel && panel.is(':visible')) renderPanel();
        scheduleApiValidate();
    } catch (err) {
        console.error('[端口密钥绑定] 切换模型失败', err);
        if (!silent) toastr.error(`切换模型失败：${err.message}`);
    }
}

/**
 * 调用酒馆后端拉取 Custom 源的模型列表（同时校验连接）。
 * 与官方「状态检查/拉取模型」同一接口：POST /api/backends/chat-completions/status
 * 返回 { models: [{id,name}], ms }；失败抛异常。
 */
async function fetchBackendModels(opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    const ctx = await loadChatContext();
    const oai = ctx.oaiSettings || {};
    const body = {
        reverse_proxy: oai.reverse_proxy ?? false,
        proxy_password: oai.proxy_password ?? '',
        chat_completion_source: 'custom',
        custom_url: oai.custom_url || '',
        custom_include_headers: Array.isArray(oai.custom_include_headers) ? oai.custom_include_headers : [],
    };
    let headers = { 'Content-Type': 'application/json' };
    if (ctx.scriptMod && typeof ctx.scriptMod.getRequestHeaders === 'function') {
        try { headers = ctx.scriptMod.getRequestHeaders(); } catch (e) { /* keep default */ }
    }
    // 超时控制：后端无响应时不再无限等待，避免切换卡顿
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = performance.now();
    let res;
    try {
        res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            cache: 'no-cache',
            signal: controller.signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`连接超时（>${Math.round(timeoutMs / 1000)}s）`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.error) throw new Error(typeof json.error === 'string' ? json.error : '接口返回错误');
    const models = (json && Array.isArray(json.data) ? json.data : [])
        .filter(m => m && typeof m.id === 'string')
        .map(m => ({ id: m.id, name: m.id }));
    __pkbProbeOkUrl = currentCustomUrl(); // 该地址的模型列表接口可用，后续失败才可信
    return { models, ms };
}

/** 连接测试：调用拉取接口并反馈结果 */
async function testConnection() {
    try {
        const { models, ms } = await fetchBackendModels();
        __pkbLastModels = models;
        __pkbLastFetchOkTs = Date.now();
        recordPositive();
        toastr.success(`连接成功（${ms}ms），发现 ${models.length} 个模型`);
        return models;
    } catch (e) {
        console.error('[端口密钥绑定] 连接失败', e);
        setConnState('fail');
        toastr.error(`连接失败：${e.message}`);
        return null;
    }
}

/** 拉取模型并保存到列表；opts.silent=true 时静默（切换方案自动拉取用，不弹提示） */
async function pullModels(opts) {
    const silent = opts === true || (opts && opts.silent === true);
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    try {
        const { models, ms } = await fetchBackendModels({ timeoutMs });
        const s = getSettings();
        const cur = await getCurrentModel();
        s.models = models;
        s.lastModel = models.some(m => m.name === cur) ? cur : '';
        saveSettings();
        // 同步到 API 设置界面：同时填充「输入模型名」补全列表 + 「可用模型」下拉
        try {
            syncApiModelList(models, s.lastModel || cur);
        } catch (e) { /* ignore */ }
        renderQuickMenu();
        if (panel && panel.is(':visible')) renderPanel();
        // 记录最近一次成功拉取（供 scheduleApiValidate 复用，避免切换时重复请求）
        __pkbLastModels = models;
        __pkbLastFetchOkTs = Date.now();
        recordPositive();
        if (!silent) toastr.success(`已拉取 ${models.length} 个模型（${ms}ms）`);
    } catch (e) {
        console.error('[端口密钥绑定] 拉取模型失败', e);
        connProbeFailed();
        if (!silent) toastr.error(`拉取模型失败：${e.message}`);
    }
}

/* ================= 查看 API 额度 ================= */

/** 从连接地址推导 API 根地址（去掉 /v1、/api、/openai 等常见路径后缀），额度接口一般挂在根地址下 */
function quotaProbeBase(url) {
    try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length && ['v1', 'v1beta', 'v1beta1', 'api', 'openai'].includes(segs[segs.length - 1])) {
            segs.pop();
        }
        u.pathname = segs.length ? '/' + segs.join('/') : '/';
        return u.toString().replace(/\/+$/, '');
    } catch (e) {
        return String(url || '').replace(/\/+$/, '');
    }
}

/** GET 拉取额度接口 JSON（带超时，后端无响应不挂起） */
async function fetchQuotaJson(endpoint, headers, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(endpoint, { method: 'GET', headers, cache: 'no-cache', signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        if (!json && text) throw new Error('响应不是 JSON');
        return json;
    } finally {
        clearTimeout(timer);
    }
}

const fmtQuotaInt = (v) => Number(v || 0).toLocaleString('en-US');
const fmtQuotaUsd = (v) => '$' + (Number(v || 0) / 100).toFixed(2);

/** 时间戳/日期 → 'YYYY-MM-DD'；0、-1、无效值返回空（表示长期有效/无此字段） */
function fmtQuotaDate(v) {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    if (!s || s === '0' || s === '-1' || s === '') return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (!n || n < 0) return '';
        const d = new Date(n > 100000000000 ? n : n * 1000); // 毫秒或秒
        if (isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return '';
}

/** 解析额度接口响应；识别不了返回 null。返回归一化字段：
    family='oneapi' → { name, username, group, quota, used, remain, accessUntil }（配额单位由服务商定义）
    family='openai' → { granted, used, available, softLimit, accessUntil }（统一为美分） */
function parseQuotaPayload(endpoint, json) {
    if (!json) return null;
    // one-api / new-api 风格：/api/user/self、/api/token/self
    //    -> { data: { quota, used_quota, remain_quota, expired_time, ... } }
    if (endpoint.includes('/api/user/self') || endpoint.includes('/api/token/self')) {
        const d = json && json.data && typeof json.data === 'object' ? json.data : null;
        if (d && (d.quota !== undefined || d.used_quota !== undefined || d.remain_quota !== undefined)) {
            const quota = d.quota;
            const used = d.used_quota !== undefined ? d.used_quota
                : (d.quota !== undefined && d.remain_quota !== undefined ? d.quota - d.remain_quota : undefined);
            const remain = d.remain_quota !== undefined ? d.remain_quota
                : (d.quota !== undefined && d.used_quota !== undefined ? d.quota - d.used_quota : undefined);
            const fields = {};
            if (d.name) fields.name = d.name;
            if (d.username) fields.username = d.username;
            if (d.group) fields.group = d.group;
            if (quota !== undefined) fields.quota = Number(quota);
            if (used !== undefined) fields.used = Number(used);
            if (remain !== undefined) fields.remain = Number(remain);
            const until = fmtQuotaDate(d.expired_time !== undefined ? d.expired_time : (d.expires_at !== undefined ? d.expires_at : d.expire_at));
            if (until) fields.accessUntil = until;
            return { family: 'oneapi', title: endpoint.includes('/api/token/self') ? '令牌额度（one-api / new-api）' : '账户额度（one-api / new-api）', fields };
        }
        return null;
    }
    // OpenAI 风格账单：/dashboard/billing/usage -> { total_usage, total_granted, total_available }（单位：美分）
    if (endpoint.includes('/dashboard/billing/usage')) {
        const d = json && json.data && typeof json.data === 'object' ? json.data : json;
        if (d && (d.total_usage !== undefined || d.total_granted !== undefined || d.total_available !== undefined)) {
            const fields = {};
            if (d.total_granted !== undefined) { const n = Number(d.total_granted); if (isFinite(n)) fields.granted = n; }
            if (d.total_usage !== undefined) { const n = Number(d.total_usage); if (isFinite(n)) fields.used = n; }
            if (d.total_available !== undefined) { const n = Number(d.total_available); if (isFinite(n)) fields.available = n; }
            return { family: 'openai', title: '账单额度（OpenAI 风格）', fields };
        }
        return null;
    }
    // OpenAI 风格订阅：/dashboard/billing/subscription -> { hard_usage_limit_usd, soft_limit_usd, access_until, ... }（美元，转美分统一）
    if (endpoint.includes('/dashboard/billing/subscription')) {
        const d = json && json.data && typeof json.data === 'object' ? json.data : json;
        if (d && (d.hard_usage_limit_usd !== undefined || d.soft_limit_usd !== undefined || d.access_until !== undefined || d.expires_at !== undefined)) {
            const fields = {};
            if (d.hard_usage_limit_usd !== undefined) { const n = Number(d.hard_usage_limit_usd); if (isFinite(n)) fields.granted = Math.round(n * 100); }
            if (d.soft_limit_usd !== undefined) { const n = Number(d.soft_limit_usd); if (isFinite(n)) fields.softLimit = Math.round(n * 100); }
            const until = fmtQuotaDate(d.access_until !== undefined ? d.access_until : d.expires_at);
            if (until) fields.accessUntil = until;
            return { family: 'openai', title: '订阅信息（OpenAI 风格）', fields };
        }
        return null;
    }
    return null;
}

/** 合并多次探测结果：同族字段互补，并用「总额 − 已用」反推缺失的余额 */
function mergeQuotaResults(results) {
    const fam = {};
    for (const r of results) {
        if (!fam[r.family]) fam[r.family] = { title: r.title, fields: {} };
        const t = fam[r.family];
        for (const [k, v] of Object.entries(r.fields)) {
            if (v !== undefined && v !== '' && t.fields[k] === undefined) t.fields[k] = v;
        }
    }
    // 补齐余额：oneapi 用 quota−used；openai 用 granted−used
    for (const f of Object.values(fam)) {
        const F = f.fields;
        if (F.remain === undefined && F.quota !== undefined && F.used !== undefined) F.remain = F.quota - F.used;
        if (F.available === undefined && F.granted !== undefined && F.used !== undefined) F.available = F.granted - F.used;
        // openai 无硬限额时，用「合理数值」的软限额（< $100 万美分）作为总额度兜底，反推余额
        if (F.granted === undefined && F.softLimit !== undefined && F.softLimit < 100000000) {
            F.granted = F.softLimit;
            if (F.available === undefined && F.used !== undefined) F.available = F.granted - F.used;
        }
    }
    const entries = Object.entries(fam);
    if (!entries.length) return null;
    // 优先选择能显示「余额/剩余」、字段更完整的 family
    const score = ([, t]) => {
        const F = t.fields;
        let s = 0;
        if (F.remain !== undefined || F.available !== undefined) s += 100;
        if (F.quota !== undefined || F.granted !== undefined) s += 10;
        if (F.used !== undefined) s += 5;
        if (F.username || F.group) s += 1;
        if (F.accessUntil || F.softLimit !== undefined) s += 1;
        return s;
    };
    entries.sort((a, b) => score(b) - score(a));
    return { family: entries[0][0], title: entries[0][1].title, fields: entries[0][1].fields };
}

/** 按 family 生成展示行；没有余额字段时给出提示 */
function buildQuotaLines(family, fields) {
    const lines = [];
    const F = fields;
    if (family === 'oneapi') {
        if (F.name) lines.push(`令牌：${F.name}`);
        if (F.username) lines.push(`账号：${F.username}`);
        if (F.group) lines.push(`分组：${F.group}`);
        if (F.quota !== undefined) lines.push(`总额度：${fmtQuotaInt(F.quota)}`);
        if (F.used !== undefined) lines.push(`已用额度：${fmtQuotaInt(F.used)}`);
        if (F.remain !== undefined) lines.push(`剩余额度：${fmtQuotaInt(F.remain)}`);
        if (F.accessUntil) lines.push(`有效期至：${F.accessUntil}`);
    } else {
        if (F.granted !== undefined) lines.push(`总额度：${fmtQuotaUsd(F.granted)}`);
        if (F.used !== undefined) lines.push(`已用额度：${fmtQuotaUsd(F.used)}`);
        if (F.available !== undefined) lines.push(`剩余额度：${fmtQuotaUsd(F.available)}`);
        if (F.softLimit !== undefined) lines.push(`软限额：${F.softLimit >= 100000000 ? '无上限' : fmtQuotaUsd(F.softLimit)}`);
        if (F.accessUntil) lines.push(`有效期至：${F.accessUntil}`);
    }
    if (F.remain === undefined && F.available === undefined) {
        lines.push('（该服务未返回余额字段，仅能显示已用额度）');
    }
    return lines;
}

/** 查询当前 Custom 连接的 API 额度（自动探测常见额度接口） */
async function checkQuota() {
    const s = getSettings();
    const active = s.presets.find(p => p.id === s.lastAppliedId);
    const ctx = await loadChatContext();
    const oai = ctx.oaiSettings || {};

    // 地址与密钥：优先当前应用的方案（方案里存有明文密钥）；无方案时退回当前 Custom 设置
    let url = '';
    let key = '';
    if (active && active.url) {
        url = normalizeUrl(active.url);
        key = active.key || '';
    } else {
        url = normalizeUrl(oai.custom_url || '');
        try {
            const secretsMod = await import('/scripts/secrets.js');
            if (secretsMod?.SECRET_KEYS?.CUSTOM && typeof secretsMod.readSecretState === 'function') {
                await secretsMod.readSecretState();
                const recs = (secretsMod.secret_state && secretsMod.secret_state[secretsMod.SECRET_KEYS.CUSTOM]) || [];
                const act = recs.find(r => r && r.active);
                if (act && act.value && !String(act.value).includes('*')) key = act.value;
            }
        } catch (e) { /* 读不到则视为无密钥 */ }
    }
    if (!url) { toastr.warning('未找到可查询的 API 地址，请先应用一个方案'); return; }
    if (!key) { toastr.warning('未找到 API 密钥，请先应用一个方案后再查看额度'); return; }
    if (!isCustomActive()) { toastr.warning('当前不是 Custom（OpenAI 兼容）源，请先应用方案后再查看额度'); return; }

    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
    const base = quotaProbeBase(url);
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const probes = [
        { endpoint: `${base}/dashboard/billing/usage?start_date=${fmtDate(start)}&end_date=${fmtDate(now)}`, label: '账单额度接口' },
        { endpoint: `${base}/dashboard/billing/subscription`, label: '订阅信息接口' },
        { endpoint: `${base}/api/user/self`, label: '账户额度接口' },
        { endpoint: `${base}/api/token/self`, label: '令牌额度接口' },
    ];

    const qBtn = $('#pkb-quota-btn');
    if (qBtn.length) { qBtn.prop('disabled', true).text('查询中…'); }
    try {
        // 并行探测全部额度接口（各自带超时，互不阻塞），合并出最完整的余额信息
        const settled = await Promise.allSettled(probes.map(async (probe) => {
            const json = await fetchQuotaJson(probe.endpoint, headers, 8000);
            const parsed = parseQuotaPayload(probe.endpoint, json);
            if (!parsed) throw new Error('无法识别响应');
            parsed.label = probe.label;
            parsed.src = probe.endpoint;
            return parsed;
        }));
        const results = [];
        for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value);
        }
        if (!results.length) {
            toastr.error('未查询到额度：常见额度接口均无有效响应，请确认后端服务支持额度查询');
            hideQuotaResult();
            return;
        }
        const merged = mergeQuotaResults(results);
        if (!merged) {
            toastr.error('未查询到额度字段，请确认后端服务支持额度查询');
            hideQuotaResult();
            return;
        }
        showQuotaResult({
            title: merged.title,
            lines: buildQuotaLines(merged.family, merged.fields),
            label: results.map(r => r.label).join('、'),
            src: results.map(r => r.src).join('\n'),
        });
    } finally {
        if (qBtn.length) { qBtn.prop('disabled', false).text('查看额度'); }
    }
}

/** 展示额度结果：面板内渲染结果框（存在时），并弹 toast 摘要 */
function showQuotaResult(parsed) {
    const box = $('#pkb-quota-box');
    if (box.length) {
        box.empty();
        box.append($('<div>').addClass('pkb-quota-title').text(parsed.title));
        parsed.lines.forEach(l => box.append($('<div>').text(l)));
        box.append($('<div>').addClass('pkb-quota-src').text(`来源：${parsed.label} · ${parsed.src}`));
        box.css('display', 'block');
    }
    const linesHtml = parsed.lines.map(l => {
        const div = document.createElement('div');
        div.textContent = l;
        return div.innerHTML;
    }).join('<br>');
    toastr.success(`<b>${parsed.title}</b><br>${linesHtml}`);
}

function hideQuotaResult() {
    const box = $('#pkb-quota-box');
    if (box.length) box.css('display', 'none');
}

/**
 * 去重密钥：把 API 密钥列表里「同一密钥值」的重复记录合并为一条（真正的 1:1），
 * 绝不错删不同值的密钥。按值分组，若某组含激活项则保留激活项，否则保留最先出现的。
 */
/**
 * 去重密钥：先展示重复密钥的明文让用户对比确认，确认后才把「同一密钥值」的重复记录合并为一条
 * （真正的 1:1），绝不错删不同值的密钥。按值分组，若某组含激活项则保留激活项，否则保留最先出现的。
 */
async function dedupeSecrets() {
    if (__pkbDeduping) { toastr.info('去重正在进行中，请稍候…'); return; }
    __pkbDeduping = true;
    try {
        const secretsMod = await import('/scripts/secrets.js');
        if (!secretsMod?.SECRET_KEYS?.CUSTOM) {
            toastr.error('当前酒馆版本不支持密钥去重');
            return;
        }
        if (typeof secretsMod.readSecretState === 'function') {
            try { await secretsMod.readSecretState(); } catch (e) { /* ignore */ }
        }
        const sk = secretsMod.SECRET_KEYS.CUSTOM;
        const recs = (secretsMod.secret_state && secretsMod.secret_state[sk]) || [];
        if (!Array.isArray(recs) || recs.length === 0) {
            toastr.info('没有可去重的密钥');
            return;
        }
        // 服务端是否允许暴露明文（allowKeysExposure=true 时 secret_state.value 与 findSecret 均为明文）
        const canPlain = await detectPlainAllowed();

        const s3 = getSettings();
        const index = Array.isArray(s3.secretIndex) ? s3.secretIndex : [];
        const presets = Array.isArray(s3.presets) ? s3.presets : [];
        // 掩码 → 方案明文 反查表：默认掩码环境下，方案里保存的密钥可借此在弹窗「完整显示明文」供对比
        const maskToPlain = {};
        for (const p of presets) {
            const k = p && p.key ? String(p.key) : '';
            if (!k) continue;
            const mk = maskOfKey(k);
            if (!(mk in maskToPlain)) maskToPlain[mk] = k;
        }

        // 每条记录：确定分组键（明文优先，否则方案反推明文/掩码）与展示值
        const items = [];
        if (canPlain && typeof secretsMod.findSecret === 'function') {
            const plainList = await Promise.all(recs.map(r =>
                secretsMod.findSecret(sk, r.id).then(v => v).catch(() => null)
            ));
            recs.forEach((r, i) => {
                const plain = plainList[i];
                const has = plain && String(plain).length > 0;
                const gk = has ? 'p:' + String(plain) : 'e:empty';
                items.push({ rec: r, gk, display: has ? String(plain) : '' });
            });
        } else {
            recs.forEach(r => {
                const v = (r.value === undefined || r.value === null) ? '' : String(r.value);
                if (v === '') { items.push({ rec: r, gk: 'e:empty', display: '' }); return; }
                // 方案反推明文：该掩码命中某个方案密钥 → 完整显示明文，并按明文精确分组
                const plainGuess = maskToPlain[v];
                if (plainGuess) items.push({ rec: r, gk: 'k:' + plainGuess, display: plainGuess });
                else items.push({ rec: r, gk: 'm:' + v, display: v });
            });
        }

        // 分组
        const groups = {};
        for (const it of items) {
            if (!it.rec || !it.rec.id) continue;
            (groups[it.gk] = groups[it.gk] || []).push(it);
        }
        const dupGroups = Object.values(groups).filter(g => g.length > 1);
        const empties = items.filter(it => it.gk === 'e:empty');

        // 防误删：掩码模式下，若同一掩码组内「本地指纹已知且互相不同」→ 说明明文不同，绝不合并
        const groupsToMerge = [];
        for (const g of dupGroups) {
            if (!canPlain) {
                const fps = new Set();
                for (const it of g) {
                    const found = index.find(x => x.id === it.rec.id);
                    if (found && found.fp) fps.add(found.fp);
                }
                if (fps.size > 1) continue; // 本地指纹证明是不同密钥 → 跳过该组
            }
            groupsToMerge.push(g);
        }

        if (groupsToMerge.length === 0 && empties.length === 0) {
            toastr.success('密钥已无重复（一对一）');
            return;
        }

        // 去重计划：每组保留 active（无则第一条），其余删除；空值全部清理。
        // summary 里携带组内【每一条】重复记录的完整信息（密钥/备注/时间/是否激活），供弹窗逐条对比。
        const plan = [];
        const summary = [];
        const tsOf = id => { const z = index.find(x => x.id === id); return z ? z.ts : null; };
        for (const g of groupsToMerge) {
            const keep = g.find(x => x.rec.active) || g[0];
            const delCount = g.filter(x => x.rec.id !== keep.rec.id).length;
            summary.push({
                group: g.map(x => ({
                    id: x.rec.id,
                    display: x.display,
                    label: x.rec.label || '',
                    active: !!x.rec.active,
                    time: tsOf(x.rec.id),
                })),
                keepId: keep.rec.id,
                delCount,
                empty: false,
            });
            g.forEach(x => { if (x.rec.id !== keep.rec.id) plan.push({ del: x.rec }); });
        }
        empties.forEach(it => {
            summary.push({
                group: [{ id: it.rec.id, display: '', label: it.rec.label || '', active: !!it.rec.active, time: tsOf(it.rec.id) }],
                keepId: it.rec.id,
                delCount: 1,
                empty: true,
            });
            plan.push({ del: it.rec });
        });

        // 弹窗展示重复内容供对比，确认后才执行
        const ok = await confirmDedupeDialog(summary, plan.length, canPlain);
        if (ok !== true) { toastr.info('已取消去重'); return; }
        let deleted = 0;
        for (const p of plan) {
            try {
                await secretsMod.deleteSecret(sk, p.del.id);
                const s2 = getSettings();
                s2.secretIndex = (Array.isArray(s2.secretIndex) ? s2.secretIndex : []).filter(x => x.id !== p.del.id);
                deleted++;
            } catch (e) { /* ignore */ }
        }
        saveSettingsNow();
        try { if (typeof secretsMod.readSecretState === 'function') await secretsMod.readSecretState(); } catch (e) { /* ignore */ }
        toastr.success(`去重完成：已合并删除 ${deleted} 条重复密钥`);
    } catch (e) {
        console.error('[端口密钥绑定] 去重失败', e);
        toastr.error(`去重失败：${e.message}`);
    } finally {
        __pkbDeduping = false;
    }
}
/**
 * 去重确认弹窗：逐条展示重复密钥（明文或掩码）+ 重复条数 + 保留哪条，供用户对比确认。
 * 返回 Promise<true> 确认执行；返回 false / null 取消。
 * @param {boolean} canPlain 服务端是否允许暴露明文（决定展示明文还是掩码）
 */
/** 去重弹窗像素定位：ST 的 -webkit-transform:translateZ(0) 会让纯 CSS fixed 以 html 为包含块，
    手机端 html 高度≠视口时会跑出屏幕。此处用 JS 按视口像素居中，保证绝不飘出界面。 */
function centerDedupeModal(modal) {
    if (!modal || !modal.length) return;
    try {
        const iw = window.innerWidth || document.documentElement.clientWidth || 0;
        const ih = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!iw || !ih) return;
        const narrow = iw <= 800;
        const w = Math.min(narrow ? iw * 0.92 : 520, iw * 0.92);
        const h = Math.min(narrow ? ih * 0.8 : 560, ih * 0.84, ih);
        modal.css({
            left: Math.max(0, Math.round((iw - w) / 2)) + 'px',
            top: Math.max(0, Math.round((ih - h) / 2)) + 'px',
            width: Math.round(w) + 'px',
            height: Math.round(h) + 'px',
        });
        const box = modal.find('.pkb-dedupe-box');
        if (box.length) box.css({ width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%' });
    } catch (e) { /* 定位失败不阻塞弹窗 */ }
}

function confirmDedupeDialog(summary, willDelete, canPlain) {
    return new Promise(function (resolve) {
        if (!summary || summary.length === 0) { resolve(false); return; }
        const body = $('body');
        // 移除旧弹窗
        $('#pkb-dedupe-modal').remove();
        const modal = $('<div>').attr('id', 'pkb-dedupe-modal').addClass('pkb-dedupe-modal');
        const box = $('<div>').addClass('pkb-dedupe-box');
        box.append($('<div>').addClass('pkb-dedupe-title').text('确认去重密钥'));
        if (canPlain) {
            box.append($('<div>').addClass('pkb-dedupe-tip').text('以下为检测到的重复密钥明文，请逐条对比确认；确认后将合并为一条（保留激活项），不同值的密钥不受影响。'));
        } else {
            box.append($('<div>').addClass('pkb-dedupe-tip').text('以下为重复密钥对比：已配置在方案里的密钥会完整显示明文（可直接对比、复制）；未在方案中的记录显示脱敏片段（片段相同即视为同一密钥）。确认后合并为一条（保留激活项），不同值的密钥绝不会误删。若希望所有记录都显示完整明文，可在 config.yaml 中设置 allowKeysExposure: true 后重启。'));
        }
        const list = $('<div>').addClass('pkb-dedupe-list');
        summary.forEach(function (s) {
            const item = $('<div>').addClass('pkb-dedupe-item');
            const head = $('<div>').addClass('pkb-dedupe-head');
            if (s.empty) head.text('空值记录 → 清理');
            else head.text(`同一密钥重复 ${s.group.length} 条 → 合并为 1 条（删除 ${s.delCount} 条，保留激活项）`);
            item.append(head);
            s.group.forEach(function (m) {
                const keep = m.id === s.keepId;
                const row = $('<div>').addClass('pkb-dedupe-row').toggleClass('pkb-dedupe-keep', keep).toggleClass('pkb-dedupe-del', !keep);
                const valLine = $('<div>').addClass('pkb-dedupe-val');
                if (m.display === '') {
                    valLine.text('（空值）').addClass('pkb-dedupe-empty');
                } else {
                    valLine.text(m.display);
                }
                const meta = $('<div>').addClass('pkb-dedupe-meta');
                const parts = [];
                parts.push(keep ? '保留' : '将删除');
                if (m.active) parts.push('当前激活');
                if (m.label) parts.push(`备注：${m.label}`);
                parts.push(`时间：${m.time ? formatTs(m.time) : '未知'}`);
                meta.text(parts.join('　·　'));
                row.append(valLine, meta);
                item.append(row);
            });
            list.append(item);
        });
        box.append(list);
        const btns = $('<div>').addClass('pkb-dedupe-btns');
        const cancelBtn = $('<button>').addClass('pkb-btn').text('取消');
        const okBtn = $('<button>').addClass('pkb-btn pkb-primary').text(`确认去重（删除 ${willDelete} 条）`);
        // 视口变化时重新居中（先声明，供 closeModal 引用）
        const onResize = function () { centerDedupeModal(modal); };
        const closeModal = function () {
            window.removeEventListener('resize', onResize);
            modal.remove();
        };
        cancelBtn.on('click', function () { closeModal(); resolve(false); });
        okBtn.on('click', function () { closeModal(); resolve(true); });
        btns.append(cancelBtn, okBtn);
        box.append(btns);
        modal.append(box);
        body.append(modal);
        // 移动端/任意视口：JS 像素定位保证不飘出界面
        centerDedupeModal(modal);
        window.addEventListener('resize', onResize);
    });
}

let __lastApiValidate = 0;
let __pkbDeduping = false; // 去重进行中标志：防止手机端重复点击导致 toastr 堆积
/**
 * 应用后后台静默校验连接并同步 API 界面（不阻塞、不弹 toast、节流防刷）。
 * 成功：更新 API 在线状态 + 填充模型补全列表，确保「真正连接」。
 */
function scheduleApiValidate() {
    const now = Date.now();
    if (now - __lastApiValidate < 2000) return;
    __lastApiValidate = now;
    (async () => {
        try {
            const ctx = await loadChatContext();
            // 若最近 6 秒内刚成功拉取过模型（如切换方案时的 pullModels），直接复用结果，不再重复请求
            let models;
            if (now - __pkbLastFetchOkTs < 6000 && Array.isArray(__pkbLastModels) && __pkbLastModels.length) {
                models = __pkbLastModels;
                recordPositive();
            } else {
                const { models: m } = await fetchBackendModels({ timeoutMs: 12000 });
                models = m;
                __pkbLastModels = models;
                __pkbLastFetchOkTs = Date.now();
                recordPositive();
            }
            if (ctx.scriptMod && typeof ctx.scriptMod.setOnlineStatus === 'function') {
                try { ctx.scriptMod.setOnlineStatus('Valid'); } catch (e) { /* ignore */ }
            }
            try {
                const cur = (ctx.oaiSettings && ctx.oaiSettings.custom_model) || '';
                syncApiModelList(models, cur);
            } catch (e) { /* ignore */ }
        } catch (e) {
            connProbeFailed();
            /* 校验失败静默忽略，不打扰用户 */
        }
    })();
}

/**
 * 把模型列表同步到 API 设置界面的 Custom 源控件（与官方 saveModelList 同通道）：
 *  - #model_custom_select_fill：输入模型名框的补全 datalist
 *  - #model_custom_select：「可用模型」下拉，并选中 activeModel
 */
function syncApiModelList(models, activeModel) {
    try {
        const names = (Array.isArray(models) ? models : []).map(m => (m && (m.name || m.id)) || '').filter(Boolean);
        const cur = activeModel || '';
        if (cur && !names.includes(cur)) names.unshift(cur);
        const fill = $('#model_custom_select_fill');
        if (fill.length) {
            fill.empty();
            names.forEach(n => fill.append($('<option>').val(n).text(n)));
        }
        const sel = $('#model_custom_select');
        if (sel.length) {
            sel.empty();
            sel.append($('<option>').val('').text('None'));
            names.forEach(n => sel.append($('<option>').val(n).text(n)));
            if (cur) sel.val(cur).trigger('change');
        }
    } catch (e) { /* ignore */ }
}

async function applyPreset(preset) {
    __pkbApplying = true;
    try {
        const url = normalizeUrl(preset.url);
        const key = preset.key || '';
        const s = getSettings();
        const targetModel = (preset.model && preset.model.trim()) || (preset.lastModel && preset.lastModel.trim()) || '';

        const { scriptMod, settings, oaiSettings } = await loadChatContext();

        // 0) 离开当前方案前，先把「正在使用的模型」记到当前方案名下——
        //    用户在官方界面手动连过的新模型，切走再切回时才能自动恢复连接。
        //    注意：必须在 step 1 覆盖 custom_model 之前读取，否则读到的是新方案的模型。
        try {
            const leavingPreset = s.presets.find(p => p.id === s.lastAppliedId);
            const curModel = (oaiSettings && oaiSettings.custom_model) || '';
            if (leavingPreset && curModel) leavingPreset.lastModel = curModel;
        } catch (e) { /* ignore */ }

        // 1) 先把 地址/密钥/模型 写进设置与界面（放在触发官方重连之前），
        //    让官方连接检查从一开始就用新方案的配置，而不是旧值——
        //    旧逻辑在官方 change 之后才写地址/密钥，官方检查读到旧地址会失败，
        //    状态就会一直卡在「绕过检查（Status check bypassed）」。
        if (oaiSettings) {
            oaiSettings.custom_url = url;
            oaiSettings.oai_url = url;
            oaiSettings.custom_api_key = key;
            if (targetModel) oaiSettings.custom_model = targetModel;
        }
        if (settings) {
            settings.oai_url = url;
            settings.oai_key = key;
        }
        const urlInput = $('#custom_api_url_text, #oai_url');
        if (urlInput.length) {
            if (urlInput.val() !== url) urlInput.val(url).trigger('input').trigger('change');
        }

        // 2) 主 API 与源：切到 Chat Completion + Custom（OpenAI 兼容）
        //    优化：仅在值确实发生变化时才触发官方 change —— 已经是 Custom 时不再触发，
        //    避免每次都触发官方重连请求，切换明显更流畅。
        if (s.autoSwitchSource) {
            const curMain = $('#main_api').length ? $('#main_api').val() : (settings && settings.main_api);
            if (curMain !== 'openai') {
                if (settings) settings.main_api = 'openai';
                const mainSel = $('#main_api');
                if (mainSel.length) {
                    mainSel.val('openai').trigger('change');
                } else if (scriptMod && typeof scriptMod.changeMainAPI === 'function') {
                    try { scriptMod.changeMainAPI('openai'); } catch (e) { /* ignore */ }
                }
            }

            const sourceCustom = 'custom';
            const curSrc = $('#chat_completion_source').length ? $('#chat_completion_source').val() : (oaiSettings && oaiSettings.chat_completion_source);
            if (curSrc !== sourceCustom) {
                if (oaiSettings) oaiSettings.chat_completion_source = sourceCustom;
                if (settings) settings.chat_completion_source = sourceCustom;
                const srcSel = $('#chat_completion_source');
                if (srcSel.length) srcSel.val(sourceCustom).trigger('change');
            }
        }

        // 3) 密钥：优先新版 secrets 系统；兜底旧版字段 + 输入框（在官方重连前完成，确保检查时密钥已就绪）
        let secretWritten = false;
        try {
            const secretsMod = await import('/scripts/secrets.js');
            if (secretsMod?.SECRET_KEYS?.CUSTOM) {
                const sk = secretsMod.SECRET_KEYS.CUSTOM;
                // 先刷新一次密钥状态，确保查重基于最新数据
                if (typeof secretsMod.readSecretState === 'function') {
                    try { await secretsMod.readSecretState(); } catch (e) { /* ignore */ }
                }
                const recs = (secretsMod.secret_state && secretsMod.secret_state[sk]) || [];
                const s3 = getSettings();
                if (!Array.isArray(s3.secretIndex)) s3.secretIndex = [];
                const fp = hashKey(key);

                // ① 本地指纹表命中：本插件之前写过这个密钥 → 直接切回记忆的 id（绝不新增）
                let target = null;
                for (const fr of s3.secretIndex) {
                    if (!fr || fr.fp !== fp) continue;
                    const live = Array.isArray(recs) ? recs.find(r => r && r.id === fr.id) : null;
                    if (live) { target = live; break; }
                    // 记忆的 id 已被官方界面删除，清理这条过期记录
                    s3.secretIndex = s3.secretIndex.filter(x => !(x.fp === fp && x.id === fr.id));
                }

                // ② 明文匹配：服务端开启 allowKeysExposure 时 secret_state 里 value 为明文，可精确兜底
                if (!target && Array.isArray(recs)) {
                    for (const r of recs) {
                        if (r && r.id && r.value === key) { target = r; break; }
                    }
                }

                // ③ 掩码匹配：默认 allowKeysExposure=false 时 secret_state.value 是脱敏掩码（末 3 位相同即同一密钥）。
                //    命中历史遗留（无指纹记录）的同一密钥 → 直接切换复用，不再新增。
                if (!target && Array.isArray(recs)) {
                    const mask = maskOfKey(key);
                    const sameMask = recs.filter(r => r && r.id && r.value === mask);
                    if (sameMask.length) {
                        target = sameMask.find(r => r.active) || sameMask[0];
                    }
                }

                if (target) {
                    // 已存在相同密钥：不新增，直接切换到它（若已激活则无需操作）
                    if (!target.active && typeof secretsMod.rotateSecret === 'function') {
                        await secretsMod.rotateSecret(sk, target.id);
                    }
                    // 备注同步：勾选「同步备注」或「同步方案名」任一即生效；
                    //   备注为空自动回退用方案名称（保证勾了就有反应）。同步后刷新官方密钥状态让备注立即生效。
                    const wantSync = computeSyncLabel(preset);
                    if (typeof secretsMod.renameSecret === 'function' && wantSync) {
                        const curLabel = (target.label || '').trim();
                        if (wantSync !== curLabel) {
                            try {
                                await secretsMod.renameSecret(sk, target.id, wantSync);
                                // 立即刷新官方密钥状态，让 API 密钥界面的备注名生效
                                if (typeof secretsMod.readSecretState === 'function') {
                                    try { await secretsMod.readSecretState(); } catch (e) { /* ignore */ }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                    // 记录指纹 → 下次切换直接复用，不重复添加
                    if (!s3.secretIndex.some(x => x.fp === fp && x.id === target.id)) {
                        s3.secretIndex.push({ fp, id: target.id, name: preset.name || '', url: preset.url || '', ts: Date.now() });
                    }
                    secretWritten = true;
                } else if (typeof secretsMod.writeSecret === 'function') {
                    // ③ 确实不存在 → 新增，并记住返回的记录 id（之后切回此方案绝不重复添加）
                    //    备注同步规则与上方一致：勾选任一同步选项即带上备注（备注空回退方案名）
                    const label = computeSyncLabel(preset) || undefined;
                    const newId = await secretsMod.writeSecret(sk, key, label);
                    if (newId) {
                        s3.secretIndex = s3.secretIndex.filter(x => x.fp !== fp);
                        s3.secretIndex.push({ fp, id: newId, name: preset.name || '', url: preset.url || '', ts: Date.now() });
                    }
                    secretWritten = true;
                }
                saveSettingsNow();
            }
        } catch (e) { /* secrets 不可用则走输入框兜底 */ }

        if (!secretWritten) {
            const keyInput = $('#api_key_custom, #api_key_openai, #api_key');
            if (keyInput.length && keyInput.val() !== key) keyInput.val(key).trigger('input');
        }

        // 4) 模型：切换方案时先拉取最新模型列表（静默），再自动连接
        //    该方案上次连接过的模型（方案里填写了固定 model 则优先），确保真正连接
        //    优化：静默拉取带 12s 超时，后端无响应时不再长时间卡顿
        //    注意：必须先标记「当前方案」再切模型——applyModel 记录 lastModel 时
        //    才能记到本方案（a）而不是上一个方案（b），否则 a 没填模型时会误用 b 的模型。
        s.lastAppliedId = preset.id;
        try { await pullModels({ silent: true, timeoutMs: 12000 }); } catch (e) { /* ignore */ }
        if (targetModel) {
            await applyModel(targetModel, { silent: true, skipReconnect: true });
        }
        // 5) 保存
        saveSettings();

        toastr.success(`已应用方案「${preset.name}」 → ${url}${preset.model ? `（模型：${preset.model}）` : ''}`);
        if (panel) {
            const quick = panel.find('.pkb-quick select');
            if (quick.length) quick.val('');
            if (panel.is(':visible')) renderPanel();
        }
        renderQuickMenu();
        scheduleApiValidate();
    } catch (err) {
        console.error('[端口密钥绑定] 应用失败', err);
        toastr.error(`应用失败：${err.message}`);
    } finally {
        __pkbApplying = false;
        __pkbApplyEndTs = Date.now(); // 切换结束后短窗口内抑制官方重连的瞬时状态误报红色
    }
}

/* ================= 快捷按钮（魔法棒上方） ================= */

let quickBtn = null;
let quickMenu = null;

/* ---------- 菜单定位（上下左右均防溢出屏幕） ---------- */
function positionMenu(menu, anchorBtn) {
    try {
        if (!menu || !menu.length || !anchorBtn || !anchorBtn.length) return;
        const r = anchorBtn[0].getBoundingClientRect();
        const menuH = menu[0].offsetHeight || 200;
        const menuW = menu[0].offsetWidth || 260;
        const vw = window.innerWidth || document.documentElement.clientWidth || 320;
        const vh = window.innerHeight || document.documentElement.clientHeight || 600;
        // 垂直：优先弹上方，空间不足弹下方，仍不足则贴顶
        let top = r.top - menuH - 4;
        if (top < 4) top = r.bottom + 4;
        if (top + menuH > vh - 4) top = Math.max(4, vh - menuH - 4);
        // 水平：默认对齐按钮左侧，超出右边缘时左移，超左边缘则贴左
        let left = r.left;
        if (left + menuW > vw - 4) left = Math.max(4, vw - menuW - 4);
        if (left < 4) left = 4;
        menu.css({ top: `${top}px`, left: `${left}px` });
    } catch (e) { /* ignore */ }
}

/** 把「当前模型」填进菜单顶部的 .pkb-qmenu-model 行 */
async function fillCurrentModelLine(menu) {
    try {
        if (!menu || !menu.length) return;
        const line = menu.find('.pkb-qmenu-model');
        if (!line.length) return;
        const m = await getCurrentModel();
        line.text(`当前模型：${m || '未选择'}`);
    } catch (e) { /* ignore */ }
}

/** 快捷弹窗：只显示方案列表 + 当前模型（模型管理在面板里） */
function buildQuickMenu() {
    if (quickMenu) return;
    quickMenu = $('<div>').attr('id', 'pkb-qmenu').addClass('pkb-qmenu').hide();
    const title = $('<div>').addClass('pkb-qmenu-title').text(EXTENSION_DISPLAY);
    const modelLine = $('<div>').addClass('pkb-qmenu-model').text('当前模型：…');
    const presetList = $('<div>').addClass('pkb-qmenu-list pkb-preset-list');
    const manage = $('<div>').addClass('pkb-qmenu-manage').text('＋ 添加 / 管理方案与模型');
    manage.on('click', () => { closeQuickMenu(); openPanel(); });
    const quotaLink = $('<div>').addClass('pkb-qmenu-manage').text('查看 API 额度');
    quotaLink.on('click', () => { closeQuickMenu(); checkQuota(); });
    quickMenu.append(title, modelLine, presetList, manage, quotaLink);
    try { document.body.appendChild(quickMenu[0]); } catch (e) { /* ignore */ }
}

function renderQuickMenu() {
    if (!quickMenu) return;
    const s = getSettings();
    const pList = quickMenu.find('.pkb-preset-list');
    pList.empty();
    if (s.presets.length === 0) {
        pList.append($('<div>').addClass('pkb-qmenu-empty').text('暂无方案，点下方添加'));
        return;
    }
    s.presets.forEach(p => {
        const item = $('<div>').addClass('pkb-qmenu-item').toggleClass('pkb-qmenu-active', s.lastAppliedId === p.id);
        const nameSpan = $('<span>').addClass('pkb-qmenu-name').text((s.lastAppliedId === p.id ? '✓ ' : '') + p.name);
        const urlSpan = $('<span>').addClass('pkb-qmenu-url').text(p.url);
        item.append(nameSpan, urlSpan);
        item.on('click', () => { closeQuickMenu(); applyPreset(p); });
        pList.append(item);
    });
}

function openQuickMenu() {
    buildQuickMenu();
    renderQuickMenu();
    quickMenu.css('display', 'flex'); // 显式 flex（jQuery .show() 会覆盖为 block）
    quickMenuVisible = true;
    positionMenu(quickMenu, quickBtn);
    fillCurrentModelLine(quickMenu);
    scheduleConnCheck(150, false); // 打开菜单时顺手刷新连接状态（节流）
    $(document).off('click.pkb');
    $(document).on('click.pkb', function (e) {
        const t = $(e.target);
        if (quickBtn && t.closest('#pkb-qbtn').length) return;
        if (quickMenu && t.closest('#pkb-qmenu').length) return;
        closeQuickMenu();
    });
}

function closeQuickMenu() {
    if (quickMenu) quickMenu.css('display', 'none');
    quickMenuVisible = false;
}

function toggleQuickMenu() {
    syncKeyIconWithTheme();
    if (quickMenuVisible) closeQuickMenu();
    else openQuickMenu();
}

/**
 * 把快捷按钮加进输入栏 #leftSendForm。
 * flex order:3，排在魔法棒(order:4)前面：
 *  - 手机/窄屏：leftSendForm 竖排，按钮在魔法棒正上方
 *  - 桌面/宽屏：leftSendForm 横排，按钮紧挨魔法棒左侧
 * 不依赖固定定位，任何布局下都稳定显示。
 */
function addQuickButton() {
    try {
        if (quickBtn && quickBtn.length) return true;
        const form = $('#leftSendForm');
        if (!form.length) return false;

        quickBtn = $('<div>').attr('id', 'pkb-qbtn').addClass('pkb-qbtn')
            .attr('title', `${EXTENSION_DISPLAY}：切换方案 / 模型`);
        // 图标由 injectKeyIcon() 以「低优先级背景 SVG」注入：
        // 默认显示钥匙；若主题对底部按钮统一换图标，主题背景规则会覆盖它，
        // 使钥匙与魔法棒、汉堡菜单的图标一起跟随主题变化。
        quickBtn.on('click', (e) => { e.stopPropagation(); toggleQuickMenu(); });
        form.append(quickBtn);
        syncKeyIconWithTheme(); // 按钮就绪后立刻同步一次主题图标
        return true;
    } catch (e) {
        console.warn('[端口密钥绑定] 快捷按钮添加失败', e);
        return false;
    }
}

/* 钥匙按钮图标：把官方钥匙 SVG（当前主题正文色）作为低优先级背景注入。
   刻意只用低特异性选择器 #pkb-qbtn（不使用 !important、不用 #leftSendForm>div 前缀）：
   - 主题没有给底部按钮换图时：显示钥匙，始终可见；
   - 主题用通用规则（如 #leftSendForm > div）给魔法棒/汉堡等底部按钮统一换图标时：
     主题规则优先级更高，钥匙自动跟随主题图标，与旁边按钮一致。
   颜色取 --SmartThemeBodyColor，随主题自动适配。 */
function injectKeyIcon() {
    try {
        const style = $('#pkb-style');
        if (!style || !style.length) return;
        const root = getComputedStyle(document.documentElement);
        let c = (root.getPropertyValue('--SmartThemeBodyColor') || '').trim();
        if (!c) c = '#888888';
        const d = 'M336 352c97.2 0 176-78.8 176-176S433.2 0 336 0S160 78.8 160 176c0 18.7 2.9 36.8 8.3 53.7L7 391c-4.5 4.5-7 10.6-7 17v80c0 13.3 10.7 24 24 24h80c13.3 0 24-10.7 24-24V448h40c13.3 0 24-10.7 24-24V384h40c6.4 0 12.5-2.5 17-7l33.3-33.3c16.9 5.4 35 8.3 53.7 8.3zM376 96a40 40 0 1 1 0 80 40 40 0 1 1 0-80z';
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" id="pkb-key"><path fill="' + c + '" d="' + d + '"/></svg>';
        const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
        style.append('#pkb-qbtn{background-image:url("' + uri + '");}');
    } catch (e) { /* 忽略，钥匙按钮退化为无图标但不报错 */ }
}

/* 让钥匙按钮的图标跟随主题：直接读取魔法棒/汉堡按钮当前实际使用的背景图，镜像到钥匙按钮。
   主题无论是「通用规则」还是「逐个按钮」换图标，都能被拿到并同步；
   主题没换图标时，钥匙保持插件自带的钥匙 SVG（清除镜像的 inline 样式即可）。 */
function syncKeyIconWithTheme() {
    try {
        const k = document.getElementById('pkb-qbtn');
        if (!k) return;
        const ref = document.getElementById('extensionsMenuButton') || document.getElementById('options_button');
        if (!ref) return;
        const cs = getComputedStyle(ref);
        const bg = (cs.backgroundImage || 'none').trim();
        // 伪元素 ::before 的信息（主题两种换法：content:url(...) 或 content:'' + background-image）
        const pcs = getComputedStyle(ref, '::before');
        const content = (pcs.content || 'none').trim();
        const pbgi = (pcs.backgroundImage || 'none').trim();
        // 内部 <i> 元素上的背景图（部分主题把图放在 i 上）
        const inner = ref.querySelector('i');
        const ics = inner ? getComputedStyle(inner) : null;
        const ibg = ics ? (ics.backgroundImage || 'none').trim() : 'none';
        const hasBg = bg !== 'none' && bg !== 'initial' && bg.indexOf('pkb-key') < 0;
        const hasContentUrl = content.indexOf('url(') >= 0 && content !== 'none';
        const hasPseudoBg = !hasBg && pbgi !== 'none' && pbgi !== 'initial' && pbgi.indexOf('pkb-key') < 0;
        const hasInnerBg = !hasBg && !hasPseudoBg && ibg !== 'none' && ibg !== 'initial' && ibg.indexOf('pkb-key') < 0;
        if (hasBg) {
            // 机制1：主题用 background-image url 换图 → 镜像背景到钥匙
            k.style.backgroundImage = bg;
            k.style.backgroundSize = cs.backgroundSize;
            k.style.backgroundRepeat = cs.backgroundRepeat;
            k.style.backgroundPosition = cs.backgroundPosition;
            k.style.color = cs.color;
            setKeyPseudo('');
        } else if (hasContentUrl) {
            // 机制2：主题用 ::before content:url(...) 换图 → 把同一图片给钥匙的 ::before
            k.style.backgroundImage = 'none';
            k.style.removeProperty('background-size');
            k.style.removeProperty('background-repeat');
            k.style.removeProperty('background-position');
            k.style.color = cs.color;
            setKeyPseudo('content:' + content + ';display:block;width:100%;height:100%;line-height:1;text-align:center;');
        } else if (hasPseudoBg) {
            // 机制3：主题在按钮 ::before 上用 content:'' + background-image 换图（最常见，如“勿忘我”主题）
            // → 把魔法棒的 ::before 背景图及尺寸完整镜像给钥匙的 ::before
            const w = /px$/.test(pcs.width) ? pcs.width : '23px';
            const h = /px$/.test(pcs.height) ? pcs.height : '23px';
            k.style.backgroundImage = 'none';
            k.style.removeProperty('background-size');
            k.style.removeProperty('background-repeat');
            k.style.removeProperty('background-position');
            k.style.color = cs.color;
            setKeyPseudo(
                "content:'';display:inline-block;width:" + w + ";height:" + h +
                ";background-image:" + pbgi +
                ";background-size:" + pcs.backgroundSize +
                ";background-repeat:" + pcs.backgroundRepeat +
                ";background-position:" + pcs.backgroundPosition +
                ';vertical-align:middle;'
            );
        } else if (hasInnerBg) {
            // 机制4：主题把图标背景放在内部 <i> 上 → 镜像给钥匙
            k.style.backgroundImage = ibg;
            k.style.backgroundSize = ics.backgroundSize;
            k.style.backgroundRepeat = ics.backgroundRepeat;
            k.style.backgroundPosition = ics.backgroundPosition;
            k.style.color = ics.color;
            setKeyPseudo('');
        } else {
            // 主题未换图 → 恢复插件自带的钥匙 SVG
            k.style.removeProperty('background-image');
            k.style.removeProperty('background-size');
            k.style.removeProperty('background-repeat');
            k.style.removeProperty('background-position');
            k.style.removeProperty('color');
            setKeyPseudo('');
        }
    } catch (e) { /* ignore */ }
}

/* 给钥匙按钮 ::before 设置 content（contentCss 形如 url("...")；空串=清除） */
function setKeyPseudo(decl) {
    try {
        let st = document.getElementById('pkb-icon-pseudo');
        if (!decl) {
            if (st) st.textContent = '';
            return;
        }
        if (!st) {
            st = document.createElement('style');
            st.id = 'pkb-icon-pseudo';
            document.head.appendChild(st);
        }
        st.textContent = '#pkb-qbtn::before{' + decl + '}';
    } catch (e) { /* ignore */ }
}

/* 监听主题切换/图标变化，自动重同步钥匙图标（防抖到下一帧） */
function startThemeIconSync() {
    try {
        const target = document.documentElement || document.body;
        if (!target) return;
        let t = null;
        const run = () => { if (t) clearTimeout(t); t = setTimeout(syncKeyIconWithTheme, 60); };
        const obs = new MutationObserver(run);
        obs.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'data-theme', 'style'],
            subtree: true,
        });
        window._pkbThemeObs = obs;
        // 主题/用户脚本动态往 <head> 塞样式表时，也触发重同步
        try {
            const headObs = new MutationObserver(run);
            headObs.observe(document.head, { childList: true, subtree: true });
            window._pkbHeadObs = headObs;
        } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
}

/* ================= 连接状态监控（钥匙图标红色提示未连接模型） ================= */
let __pkbConnState = 'unknown';        // 'unknown' | 'ok' | 'fail'
let __pkbConnLastCheck = 0;            // 上次主动探测时间戳
let __pkbConnTimer = null;             // 延迟探测定时器
let __pkbApplying = false;             // 方案切换进行中（抑制瞬时 no_connection 误报红色）
let __pkbApplyEndTs = Date.now();      // 最近一次方案切换结束时刻（页面启动/切换后的短窗口内同样抑制误报）
let __pkbFailStreak = 0;               // 连续负面信号计数（连续 ≥2 次才确认红色，防瞬时抖动误报）
const CONN_CHECK_MIN_INTERVAL = 15000; // 后台主动探测的最小间隔（ms）
const CONN_CHECK_TIMEOUT = 8000;       // 探测超时（ms），后端无响应时不挂起
const CONN_CONFIRM_DELAY = 1500;       // 负面信号后延迟确认探测（ms）：给瞬时抖动自愈机会
const CONN_FAIL_REPROBE = 8000;        // fail（红色）状态下的自愈重探间隔（ms），恢复后一次成功即回绿
const CONN_APPLY_GRACE = 8000;         // 方案切换/页面启动后的红色抑制宽限期（ms）
const CONN_FAIL_CONFIRM = 2;           // 连续负面信号达到该次数才显示红色
const CONN_DEAD_STATUSES = ['no_connection', 'no_server', 'no_key']; // 官方明确断连的状态（其他如 Valid/绕过检查 一律视为已连接）
let __pkbLastFetchOkTs = 0;            // 最近一次后端拉取成功的时刻
let __pkbLastModels = [];              // 最近一次后端拉取成功的模型列表
let __pkbProbeOkUrl = '';              // 最近一次探测成功的地址（模型列表接口可用才记；仅该地址的失败可信）

/** 正面信号：任何一次确认成功都立即恢复 ok，并清零负面计数（乐观恢复，切换后快速回绿） */
function recordPositive() {
    __pkbFailStreak = 0;
    setConnState('ok');
}

/** 负面信号（no_connection 事件 / 探测失败）：
 *   - 方案切换进行中：完全忽略，等切换完成后的真实探测结果；
 *   - 切换刚结束/页面启动（宽限期）：只累计计数并安排确认探测，不立即标红；
 *   - 连续 ≥2 次负面：才确认红色（连接正常时绝不再闪红）；
 *   - 已在红色状态：安排自愈探测，连接恢复后一次成功即回绿。 */
function recordNegative() {
    if (__pkbApplying) return;
    __pkbFailStreak++;
    if (__pkbConnState === 'fail') {
        scheduleConnCheck(CONN_FAIL_REPROBE, true); // 已红：持续自愈探测
        return;
    }
    const inGrace = Date.now() - __pkbApplyEndTs < CONN_APPLY_GRACE;
    if (__pkbFailStreak >= CONN_FAIL_CONFIRM && !inGrace) {
        setConnState('fail');
    } else {
        scheduleConnCheck(CONN_CONFIRM_DELAY, true);
    }
}

/** 更新连接状态并刷新输入框钥匙图标的颜色（未连接 → 红色） */
function setConnState(state) {
    if (__pkbConnState === state) return;
    __pkbConnState = state;
    if (state === 'fail') scheduleConnCheck(CONN_FAIL_REPROBE, true); // 进入红色即启动自愈探测
    applyConnIcon();
}

/** 把连接状态落到 #pkb-qbtn 上：fail 加 .pkb-offline（图标染红），ok/unknown 恢复原图标 */
function applyConnIcon() {
    const k = document.getElementById('pkb-qbtn');
    if (!k) return;
    const offline = __pkbConnState === 'fail';
    k.classList.toggle('pkb-offline', offline);
    const base = `${EXTENSION_DISPLAY}：切换方案 / 模型`;
    k.setAttribute('title', offline ? `${base}（未连接模型，图标为红色）` : base);
}

/** 判断当前是否处于 Custom（OpenAI 兼容）源：仅该场景需要主动探测后端 */
function isCustomActive() {
    try {
        const m = $('#main_api').length ? $('#main_api').val() : '';
        if (m && m !== 'openai') return false;
        const s = $('#chat_completion_source').length ? $('#chat_completion_source').val() : '';
        return s === 'custom';
    } catch (e) { return false; }
}

/** 读取当前界面上的 Custom 地址（用于按地址记忆「探测接口是否可用」） */
function currentCustomUrl() {
    try {
        const el = document.querySelector('#custom_api_url_text') || document.querySelector('#oai_url');
        return (el && el.value) ? String(el.value).trim() : '';
    } catch (e) { return ''; }
}

/** 探测失败：仅在「官方也明确断连」或「该地址此前被探测成功过（接口可用，失败可信）」时才累计负面，
 *  避免后端不支持模型列表接口（官方一直显示绕过检查）时误报红色。 */
function connProbeFailed() {
    if (CONN_DEAD_STATUSES.includes(String(online_status))) { recordNegative(); return; }
    const url = currentCustomUrl();
    if (__pkbProbeOkUrl && url && url === __pkbProbeOkUrl) recordNegative();
}

/** 主动探测后端连接（节流）。opts.force=true 可跳过节流立即探测。 */
async function checkConnNow(opts) {
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (__pkbApplying) return __pkbConnState; // 切换进行中不探测，避免读到半切换状态
    if (!force && now - __pkbConnLastCheck < CONN_CHECK_MIN_INTERVAL) return __pkbConnState;
    // 非 Custom 源：不主动探测后端，直接以官方连接状态为准（避免误报红色）
    if (!isCustomActive()) {
        __pkbConnLastCheck = now;
        if (CONN_DEAD_STATUSES.includes(String(online_status))) {
            recordNegative();
        } else {
            recordPositive();
        }
        return __pkbConnState;
    }
    __pkbConnLastCheck = now;
    try {
        const { models } = await fetchBackendModels({ timeoutMs: CONN_CHECK_TIMEOUT });
        __pkbLastModels = models;
        __pkbLastFetchOkTs = Date.now();
        recordPositive();
    } catch (e) {
        connProbeFailed();
    }
    return __pkbConnState;
}

/** 延迟调度一次连接探测（节流由 checkConnNow 内部保证；已有排队探测则不重复排队，防刷） */
function scheduleConnCheck(delayMs, force) {
    if (__pkbConnTimer) return;
    __pkbConnTimer = setTimeout(() => {
        __pkbConnTimer = null;
        checkConnNow({ force: !!force });
    }, delayMs || 0);
}

/** 启动连接监控：官方状态事件 + 低频周期兜底 + 首屏探测 */
function startConnMonitor() {
    try {
        eventSource.on(event_types.ONLINE_STATUS_CHANGED, (status) => {
            // 以官方状态为准：只有明确断连状态才可能标红（还需连续确认），
            // Valid /「绕过检查」/ 其他提示一律视为已连接，
            // 避免官方模型列表检查不通过（Custom 源会显示绕过检查）时误报红色。
            if (CONN_DEAD_STATUSES.includes(String(status))) {
                recordNegative();
            } else {
                recordPositive();
            }
        });
    } catch (e) { /* ignore */ }
    // 低频兜底探测：每 45 秒一次，仅在快捷按钮存在时进行（非 Custom 源会自动跳过探测）
    setInterval(() => {
        if (document.getElementById('pkb-qbtn')) checkConnNow(false);
    }, 45000);
    // 首屏延迟探测（等页面与扩展都就绪；启动初期与切换一样有宽限期保护）
    setTimeout(() => {
        if (document.getElementById('pkb-qbtn')) checkConnNow(false);
    }, 2500);
}

/** 注入「未连接」红色图标的样式（高优先级覆盖主题滤镜/内联样式）。
 *  保留当前实际显示的图标（含主题美化图标），仅用 CSS 滤镜统一染色为红色：
 *  无论图标来自按钮背景图、::before 还是内部 <i>，都会被染成红色轮廓，不会退回成红色钥匙。 */
function injectOfflineIconStyle() {
    if ($('#pkb-offline-style').length) return;
    $('<style>').attr('id', 'pkb-offline-style').text(
        `#pkb-qbtn.pkb-offline{opacity:1;filter:brightness(0) invert(1) sepia(1) saturate(10000%) hue-rotate(300deg) !important;}`
    ).appendTo('head');
}

/* ================= 面板界面 ================= */

function buildPresetRow(p) {
    const s = getSettings();
    const isActive = s.lastAppliedId === p.id;

    const row = $('<div>').addClass('pkb-row').toggleClass('pkb-active', isActive);

    const info = $('<div>').addClass('pkb-row-info');
    const nameLine = $('<div>').addClass('pkb-row-name');
    nameLine.append($('<b>').text(p.name));
    if (isActive) nameLine.append($('<span>').addClass('pkb-badge').text('当前'));
    info.append(nameLine);
    info.append($('<span>').addClass('pkb-row-url').text(p.url));
    info.append($('<span>').addClass('pkb-row-key').text(maskKey(p.key)));
    if (p.model) info.append($('<span>').addClass('pkb-row-model').text(`模型：${p.model}`));
    if (p.syncLabel) info.append($('<span>').addClass('pkb-row-model').text('备注同步'));

    const actions = $('<div>').addClass('pkb-row-actions');
    const applyBtn = $('<button>').addClass('pkb-btn pkb-apply').text('应用');
    applyBtn.on('click', () => applyPreset(p));
    const editBtn = $('<button>').addClass('pkb-btn').text('编辑');
    editBtn.on('click', () => startEdit(p));
    const delBtn = $('<button>').addClass('pkb-btn pkb-del').text('删除');
    delBtn.on('click', () => {
        const s2 = getSettings();
        s2.presets = s2.presets.filter(x => x.id !== p.id);
        if (s2.lastAppliedId === p.id) s2.lastAppliedId = null;
        saveSettings();
        renderPanel();
        renderQuickMenu();
        toastr.info(`已删除方案「${p.name}」`);
    });
    actions.append(applyBtn, editBtn, delBtn);

    row.append(info, actions);
    return row;
}

function startEdit(p) {
    editingId = p.id;
    $('#pkb-name').val(p.name);
    $('#pkb-url').val(p.url);
    $('#pkb-key').val(p.key);
    $('#pkb-model').val(p.model || '');
    $('#pkb-note').val(p.note || '');
    $('#pkb-synclabel').prop('checked', !!p.syncLabel);
    $('#pkb-syncnote').prop('checked', !!p.syncNote);
    $('#pkb-save').text('保存修改');
    $('#pkb-panel').find('.pkb-cancel').removeClass('pkb-hidden');
    $('#pkb-panel').find('.pkb-form-section h4').text('编辑方案');
}

function cancelEdit() {
    editingId = null;
    $('#pkb-name').val('');
    $('#pkb-url').val('');
    $('#pkb-key').val('');
    $('#pkb-model').val('');
    $('#pkb-note').val('');
    $('#pkb-synclabel').prop('checked', false);
    $('#pkb-syncnote').prop('checked', false);
    $('#pkb-save').text('添加');
    $('#pkb-panel').find('.pkb-cancel').addClass('pkb-hidden');
    $('#pkb-panel').find('.pkb-form-section h4').text('添加方案');
}

function renderPanel() {
    const s = getSettings();
    if (!panel) return;
    panel.empty();

    /* 头部：标题 + 关闭 */
    const header = $('<div>').addClass('pkb-header');
    header.append($('<span>').addClass('pkb-title').text(EXTENSION_DISPLAY));
    const closeBtn = $('<span>').addClass('pkb-close').text('✕').attr('title', '关闭');
    closeBtn.on('click', () => panel.css('display', 'none'));
    header.append(closeBtn);
    panel.append(header);

    /* 主体 */
    const body = $('<div>').addClass('pkb-body');

    // ① 方案列表
    const listSection = $('<div>').addClass('pkb-section');
    listSection.append($('<h4>').text('方案列表'));
    const list = $('<div>').addClass('pkb-list');
    if (s.presets.length === 0) {
        list.append($('<div>').addClass('pkb-empty').text('暂无方案，请在下方添加。'));
    } else {
        s.presets.forEach(p => list.append(buildPresetRow(p)));
    }
    listSection.append(list);
    body.append(listSection);

    // ② 添加 / 编辑方案（紧跟方案列表，手机端优先可见）
    const formSection = $('<div>').addClass('pkb-section pkb-form-section');
    formSection.append($('<h4>').text(editingId ? '编辑方案' : '添加方案'));
    const form = $('<div>').addClass('pkb-form');

    const nameInput = $('<input>').attr({ id: 'pkb-name', type: 'text', placeholder: '方案名称（如：套餐A / 海外 / 备用）' });
    const urlInput = $('<input>').attr({ id: 'pkb-url', type: 'text', placeholder: '端口或地址（如 8080 或 http://127.0.0.1:8080）' });
    const keyWrap = $('<div>').addClass('pkb-keyrow');
    const keyInput = $('<input>').attr({ id: 'pkb-key', type: 'password', placeholder: 'API 密钥' });
    const eyeBtn = $('<button>').addClass('pkb-btn pkb-eye').text('显示');
    eyeBtn.on('click', () => {
        const isPassword = keyInput.attr('type') === 'password';
        keyInput.attr('type', isPassword ? 'text' : 'password');
        eyeBtn.text(isPassword ? '隐藏' : '显示');
    });
    keyWrap.append(keyInput, eyeBtn);
    // 模型字段：可手填，也从已拉取的模型列表补全
    const modelWrap = $('<div>').addClass('pkb-keyrow');
    const presetModelInput = $('<input>').attr({ id: 'pkb-model', type: 'text', placeholder: '模型（可选，如 gpt-4o-mini；留空则只切端口密钥）', list: 'pkb-model-list' });
    const modelDatalist = $('<datalist>').attr('id', 'pkb-model-list');
    s.models.forEach(m => modelDatalist.append($('<option>').val(m.name).text(m.name)));
    modelWrap.append(presetModelInput, modelDatalist);
    // 备注（可选）：可同步到 API 密钥界面对应密钥的备注名
    const noteInput = $('<input>').attr({ id: 'pkb-note', type: 'text', placeholder: '备注（可选，可同步到密钥界面的密钥备注名）' });
    // 备注同步：勾选且填写了备注时，应用时把备注同步为密钥界面对应的密钥备注名
    const syncNoteWrap = $('<label>').addClass('pkb-check pkb-syncrow');
    const syncNoteInput = $('<input>').attr({ id: 'pkb-syncnote', type: 'checkbox' }).prop('checked', false);
    syncNoteInput.on('change', function () {
        const v = $(this).prop('checked');
        if (v && !noteInput.val().trim()) toastr.info('填写上面的备注后，应用时会把该备注同步为密钥界面的备注名');
    });
    syncNoteWrap.append(syncNoteInput).append($('<span>').text('把上面的备注同步到 API 密钥界面对应的密钥备注'));
    // 备注同步：应用时把方案名称同步为 API 密钥界面的密钥备注名（可选）
    const syncWrap = $('<label>').addClass('pkb-check pkb-syncrow');
    const syncInput = $('<input>').attr({ id: 'pkb-synclabel', type: 'checkbox' }).prop('checked', false);
    syncInput.on('change', function () {
        const v = $(this).prop('checked');
        if (v && !nameInput.val().trim()) {
            toastr.info('填写方案名称后，应用时会把该名称同步为密钥界面的备注名');
        }
    });
    syncWrap.append(syncInput).append($('<span>').text('应用时把方案名称同步为 API 密钥界面的备注名'));
    modelWrap.after(syncWrap);

    const btnRow = $('<div>').addClass('pkb-add-row');
    const saveBtn = $('<button>').attr('id', 'pkb-save').addClass('pkb-btn pkb-primary').text(editingId ? '保存修改' : '添加');
    const cancelBtn = $('<button>').addClass('pkb-btn pkb-cancel').text('取消编辑').toggleClass('pkb-hidden', !editingId);
    cancelBtn.on('click', cancelEdit);
    btnRow.append(saveBtn, cancelBtn);

    function savePreset() {
        const name = nameInput.val().trim();
        const raw = urlInput.val().trim();
        const key = keyInput.val().trim();
        const model = presetModelInput.val().trim();
        const note = noteInput.val().trim();
        const syncLabel = !!syncInput.prop('checked');
        const syncNote = !!syncNoteInput.prop('checked');
        if (!name || !raw || !key) {
            toastr.warning('名称、端口/地址、密钥均不能为空');
            return;
        }
        const s2 = getSettings();
        const url = normalizeUrl(raw);
        if (editingId) {
            const target = s2.presets.find(p => p.id === editingId);
            if (target) {
                target.name = name;
                target.url = url;
                target.key = key;
                target.model = model || '';
                target.note = note || '';
                target.syncLabel = syncLabel;
                target.syncNote = syncNote;
            }
            toastr.success(`已更新方案「${name}」`);
        } else {
            s2.presets.push({
                id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                name,
                url,
                key,
                model: model || '',
                note: note || '',
                syncLabel,
                syncNote,
            });
            toastr.success(`已添加方案「${name}」`);
        }
        editingId = null;
        saveSettings();
        renderPanel();
        renderQuickMenu();
    }
    saveBtn.on('click', savePreset);
    nameInput.on('keydown', e => { if (e.key === 'Enter') urlInput.trigger('focus'); });
    urlInput.on('keydown', e => { if (e.key === 'Enter') keyInput.trigger('focus'); });
    keyInput.on('keydown', e => { if (e.key === 'Enter') savePreset(); });

    form.append(nameInput, urlInput, keyWrap, modelWrap, noteInput, syncNoteWrap, syncWrap, btnRow);
    formSection.append(form);
    body.append(formSection);

    // ③ 模型（连接测试 + 手动补充模型名）
    //    已去除重复的「拉取模型」按钮与重复的「模型列表」（官方 API 界面自带「可用模型」下拉与
    //    「输入模型名」，面板内不再重复展示）；切换方案时仍会自动静默拉取模型并同步到官方下拉。
    const modelSection = $('<div>').addClass('pkb-section');
    modelSection.append($('<h4>').text('模型'));
    const modelActionRow = $('<div>').addClass('pkb-add-row pkb-model-actions');
    const connBtn = $('<button>').addClass('pkb-btn pkb-conn').text('连接测试');
    connBtn.on('click', testConnection);
    const quotaBtn = $('<button>').attr('id', 'pkb-quota-btn').addClass('pkb-btn pkb-quota').text('查看额度');
    quotaBtn.on('click', checkQuota);
    modelActionRow.append(connBtn, quotaBtn);
    modelSection.append(modelActionRow);
    modelSection.append($('<div>').addClass('pkb-hint').text('模型列表已并入上方「可用模型」下拉，可在下方手动补充模型名。'));
    const quotaBox = $('<div>').attr('id', 'pkb-quota-box').addClass('pkb-quota-box').hide();
    modelSection.append(quotaBox);
    // 手动补充模型（备用：接口无 /models 时）
    const modelForm = $('<div>').addClass('pkb-form');
    const modelInputRow = $('<div>').addClass('pkb-add-row');
    const modelInput = $('<input>').attr({ id: 'pkb-model-name', type: 'text', placeholder: '手动补充模型名（可选）' });
    const modelAddBtn = $('<button>').addClass('pkb-btn pkb-primary').text('添加模型');
    modelAddBtn.on('click', () => {
        const name = modelInput.val().trim();
        if (!name) { toastr.warning('请输入模型名'); return; }
        const s2 = getSettings();
        if (s2.models.some(x => x.name === name)) { toastr.info('该模型已存在'); return; }
        s2.models.push({ id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, name });
        saveSettings();
        renderPanel();
        renderQuickMenu();
        toastr.success(`已添加模型「${name}」`);
    });
    modelInput.on('keydown', e => { if (e.key === 'Enter') modelAddBtn.trigger('click'); });
    modelInputRow.append(modelInput, modelAddBtn);
    modelForm.append(modelInputRow);
    modelSection.append(modelForm);
    body.append(modelSection);

    // ④ 选项
    const autoWrap = $('<label>').addClass('pkb-check');
    const autoCheck = $('<input>').attr('type', 'checkbox').prop('checked', s.autoSwitchSource);
    autoCheck.on('change', function () {
        const s2 = getSettings();
        s2.autoSwitchSource = $(this).prop('checked');
        saveSettings();
    });
    autoWrap.append(autoCheck).append($('<span>').text('应用时自动切换到 Custom（OpenAI 兼容）源'));
    body.append(autoWrap);
    // 密钥去重：合并 API 密钥列表里同一值的重复记录（一对一），不会误删不同密钥
    const dedupeWrap = $('<div>').addClass('pkb-add-row');
    const dedupeBtn = $('<button>').addClass('pkb-btn pkb-dedupe').text('去重密钥（合并重复）');
    dedupeBtn.on('click', dedupeSecrets);
    dedupeWrap.append(dedupeBtn);
    body.append(dedupeWrap);
    body.append($('<div>').addClass('pkb-footnote').text('提示：端口只填数字时自动补全为 http://127.0.0.1:端口；密钥在新版酒馆中写入内置密钥系统，与官方 API Key 同样方式保管。切换方案时同一密钥只保存一次，已存在的密钥自动切换到对应条目，不再重复添加。'));

    panel.append(body);
}

function openPanel() {
    const host = document.getElementById('rm_api_block');
    if (!host) {
        // 兜底：老版本酒馆没有 API 设置抽屉时，退回原来的浮动居中面板
        openPanelFallback();
        return;
    }
    if (!panel) {
        panel = $('<div>').attr('id', 'pkb-panel').addClass('pkb-panel');
        try { host.appendChild(panel[0]); } catch (e) { $(host).append(panel); }
    }
    try {
        // 打开酒馆原生的 API 连接设置抽屉，面板内嵌在该界面中
        try { selectRightMenuWithAnimation('rm_api_block'); } catch (e) { /* ignore */ }
        renderPanel();
        panel.css('display', 'flex'); // 显式 flex（jQuery .show() 会覆盖为 block，破坏 flex 布局）
        // 平滑滚动到面板位置
        requestAnimationFrame(() => {
            try { panel[0].scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
        });
        scheduleConnCheck(300, false);
    } catch (err) {
        console.error('[端口密钥绑定] 打开面板失败', err);
        toastr.error(`打开面板失败：${err.message}`);
    }
}

/* 兜底：老版本无 #rm_api_block 时，保持原来的浮动居中面板 */
function openPanelFallback() {
    if (!panel) {
        panel = $('<div>').attr('id', 'pkb-panel').addClass('pkb-panel pkb-panel-float');
        try { document.body.appendChild(panel[0]); } catch (e) { $('body').append(panel); }
    }
    try {
        renderPanel();
        centerPanel();
        panel.css('display', 'flex'); // 显式 flex（jQuery .show() 会覆盖为 block，破坏 flex 布局）
    } catch (err) {
        console.error('[端口密钥绑定] 打开面板失败', err);
        toastr.error(`打开面板失败：${err.message}`);
    }
}

/**
 * 用 JS 像素把面板在视口内居中（绕开 html transform 破坏 fixed 百分比定位的问题）。
 * 宽 ≤92vw、高 ≤84vh/dvh；移动端缩放到 92vw/86dvh。绝不超出视口。
 */
function centerPanel() {
    if (!panel) return;
    try {
        const iw = window.innerWidth || document.documentElement.clientWidth || 0;
        const ih = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!iw || !ih) return;
        const narrow = iw <= 800;
        const w = Math.min(narrow ? iw : 560, iw * (narrow ? 0.9 : 0.92));
        const h = Math.min(narrow ? ih * 0.78 : 700, ih * 0.84, ih);
        panel.css({
            width: Math.round(w) + 'px',
            maxWidth: Math.round(iw * 0.92) + 'px',
            maxHeight: Math.round(h) + 'px',
            left: Math.max(0, Math.round((iw - w) / 2)) + 'px',
            top: Math.max(0, Math.round((ih - h) / 2)) + 'px',
        });
    } catch (e) { /* 定位失败不阻塞打开 */ }
}

// 视口变化（旋转/浏览器栏伸缩）时保持面板居中（仅浮动兜底模式需要）
jQuery(window).on('resize.pkb', () => {
    if (panel && panel.hasClass('pkb-panel-float') && panel.is(':visible')) centerPanel();
});

/* ================= 样式 ================= */

function injectStyles() {
    if ($('#pkb-style').length) return;
    const css = `
/* ============ 全部跟随酒馆当前美化主题变量 ============ */
/* 实色主题配色：毛玻璃主题下也保持不透明。
   方法：底层铺一实色主题底（FastUIBG），上层再叠一层主题面板色 tint（可半透明）——
   任意浏览器下都是「实色」且配色贴合主题；不再依赖兼容性差的 rgb(from...) 相对色语法。 */
#pkb-panel, #pkb-qmenu, .pkb-dedupe-box {
  --pkb-solid-bg: var(--SmartThemeFastUIBGColor);
  background-color: var(--SmartThemeFastUIBGColor);
  background-image: linear-gradient(var(--SmartThemeBlurTintColor), var(--SmartThemeBlurTintColor));
}
#pkb-panel {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: none;
  flex-direction: column;
  overflow: hidden;
  /* 面板内嵌在酒馆原生 API 设置抽屉（#rm_api_block）末尾，随抽屉一起滚动 */
  margin: 14px 0 18px;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 12px;
  color: var(--SmartThemeBodyColor);
  font-size: var(--mainFontSize);
  line-height: 1.5;
}
/* 老版本无 API 抽屉时的浮动兜底模式（居中弹窗） */
#pkb-panel.pkb-panel-float {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 30000;
  width: min(560px, 92vw);
  max-width: 92vw;
  max-height: min(84vh, 700px);
  max-height: min(84dvh, 700px); /* dvh 优先，移动端动态工具栏更准确；不支持时回退上一行 */
  border-radius: 14px;
  box-shadow: 0 1px 10px color-mix(in srgb, var(--SmartThemeShadowColor) 35%, transparent);
}
/* 未连接模型：输入框图标变红（保留主题美化图标，仅染色为红色，不退回红色钥匙） */
#pkb-qbtn.pkb-offline {
  opacity: 1;
  filter: brightness(0) invert(1) sepia(1) saturate(10000%) hue-rotate(300deg) !important;
}
.pkb-header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--SmartThemeBorderColor);
  flex-shrink: 0;
  background: var(--pkb-solid-bg);
  z-index: 1;
}
.pkb-title { font-weight: 700; font-size: calc(var(--mainFontSize) * 1.1); white-space: nowrap; }
.pkb-quick { display: flex; align-items: center; gap: 6px; margin-left: 8px; flex: 1; min-width: 0; }
.pkb-quick span { white-space: nowrap; opacity: .85; }
.pkb-quick select {
  flex: 1; min-width: 0;
  background: var(--SmartThemeFastUIBGColor);
  color: var(--SmartThemeBodyColor);
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 6px; padding: 5px 8px; font-size: calc(var(--mainFontSize) * 0.95);
}
.pkb-close { cursor: pointer; font-size: calc(var(--mainFontSize) * 1.4); opacity: .75; line-height: 1; padding: 0 2px; }
.pkb-close:hover { opacity: 1; }
.pkb-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 16px;
  display: flex; flex-direction: column; gap: 14px;
}
.pkb-section h4 { margin: 0 0 8px; font-size: calc(var(--mainFontSize) * 0.85); text-transform: uppercase; letter-spacing: .5px; opacity: .75; }
.pkb-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; padding-right: 4px; }
.pkb-empty { opacity: .6; }
.pkb-hint { opacity: .6; font-size: calc(var(--mainFontSize) - 0.15em); margin: 2px 0 6px; }
.pkb-quota-box {
  display: none;
  margin-top: 10px; padding: 10px 12px;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 8px;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 40%, var(--SmartThemeFastUIBGColor) 60%);
  font-size: calc(var(--mainFontSize) - 0.1em);
  line-height: 1.6;
  word-break: break-all;
}
.pkb-quota-box .pkb-quota-title { font-weight: 700; margin-bottom: 4px; }
.pkb-quota-box .pkb-quota-src { opacity: .55; font-size: calc(var(--mainFontSize) - 0.25em); margin-top: 6px; word-break: break-all; }
.pkb-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  background: var(--SmartThemeFastUIBGColor);
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 8px; padding: 8px 10px;
}
.pkb-row.pkb-active {
  border-color: var(--SmartThemeQuoteColor);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 22%, var(--SmartThemeFastUIBGColor) 78%);
  box-shadow: none;
}
.pkb-row-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pkb-row-name { display: flex; align-items: center; gap: 6px; }
.pkb-row-name b { font-weight: 700; }
.pkb-badge {
  font-size: calc(var(--mainFontSize) * 0.72);
  padding: 1px 6px; border-radius: 8px;
  background: var(--SmartThemeQuoteColor);
  color: var(--SmartThemeBlurTintColor);
  font-weight: 700;
}
.pkb-row-url { font-size: calc(var(--mainFontSize) * 0.88); opacity: .8; word-break: break-all; }
.pkb-row-key { font-size: calc(var(--mainFontSize) * 0.8); opacity: .6; font-family: monospace; }
.pkb-row-model {
  font-size: calc(var(--mainFontSize) * 0.8);
  opacity: .8;
  color: color-mix(in srgb, var(--SmartThemeQuoteColor) 55%, var(--SmartThemeBodyColor) 45%);
}
.pkb-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
.pkb-btn {
  border: 1px solid var(--SmartThemeBorderColor);
  background: var(--SmartThemeFastUIBGColor);
  color: var(--SmartThemeBodyColor);
  border-radius: 6px; padding: 5px 12px; cursor: pointer;
  font-size: calc(var(--mainFontSize) * 0.95);
}
.pkb-btn:hover { filter: brightness(1.12); }
.pkb-apply {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 30%, var(--SmartThemeFastUIBGColor) 70%);
  border-color: var(--SmartThemeQuoteColor);
  font-weight: 600;
}
.pkb-primary {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 45%, var(--SmartThemeFastUIBGColor) 55%);
  border-color: var(--SmartThemeQuoteColor);
  font-weight: 700;
}
.pkb-del:hover { filter: brightness(1.2) saturate(1.3); color: var(--SmartThemeQuoteColor); }
.pkb-form { display: flex; flex-direction: column; gap: 8px; }
.pkb-form-section h4 { margin: 0 0 2px; font-size: calc(var(--mainFontSize) * 0.85); text-transform: uppercase; letter-spacing: .5px; opacity: .75; }
.pkb-form input[type="text"], .pkb-form input[type="password"] {
  background: var(--SmartThemeFastUIBGColor);
  color: var(--SmartThemeBodyColor);
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 6px; padding: 7px 9px; width: 100%; box-sizing: border-box;
  font-size: calc(var(--mainFontSize) * 0.95);
}
.pkb-form input[type="text"]::placeholder, .pkb-form input[type="password"]::placeholder { opacity: .5; }
.pkb-keyrow { display: flex; align-items: center; gap: 6px; }
.pkb-keyrow input { flex: 1; }
.pkb-eye { white-space: nowrap; }
.pkb-add-row { display: flex; gap: 8px; }
.pkb-add-row .pkb-btn { flex: 1; }
.pkb-cancel { background: transparent; }
.pkb-hidden { display: none !important; }
.pkb-check { display: flex; align-items: center; gap: 8px; font-size: calc(var(--mainFontSize) * 0.95); cursor: pointer; opacity: .9; }
.pkb-check input { cursor: pointer; }
.pkb-footnote { font-size: calc(var(--mainFontSize) * 0.8); opacity: .55; }

/* 魔法棒上方的快捷按钮（输入栏内联，用 order 排在魔法棒前面）
   注意：#leftSendForm>div 自带 width/height=bottomFormBlockSize，必须用更高特异性+!important 才能真正缩小 */
#leftSendForm>div#pkb-qbtn {
  order: 3; /* 魔法棒 #extensionsMenuButton 是 order:4，保证排在其前（手机竖排=上方，桌面横排=左侧） */
  /* 与兄弟按钮同尺寸(#leftSendForm>div 自带 width/height=bottomFormBlockSize)，
     无 margin/间距，完全贴合汉堡菜单与魔法棒，不挤动任何图标 */
  width: var(--bottomFormBlockSize) !important;
  height: var(--bottomFormBlockSize) !important;
  min-width: 0;
  min-height: 0;
  margin: 0 !important;
  padding: 0 !important;
  flex-shrink: 0;
  border: none !important;
  border-radius: 0;
  color: var(--SmartThemeBodyColor);
  opacity: 0.72;
  cursor: pointer;
  box-sizing: border-box;
}
#leftSendForm>div#pkb-qbtn:hover { opacity: 1; filter: brightness(1.2); }
/* 钥匙图标：背景 SVG 兜底（背景图本身由 injectKeyIcon() 注入）。
   只写排版属性，不写 background-image 高优先级规则，保证主题可覆盖 */
#pkb-qbtn {
  background-repeat: no-repeat;
  background-position: center;
  background-size: 55%;
}

/* 快捷下拉菜单 */
#pkb-qmenu {
  box-sizing: border-box;
  position: fixed;
  z-index: 30001;
  min-width: 240px;
  max-width: min(320px, 92vw); /* 移动端禁止溢出屏幕 */
  max-height: min(70vh, 420px); /* 移动端防过高，内部列表自滚动 */
  display: flex;
  flex-direction: column;
  /* 背景色由上方双层叠加提供（实色） */
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 10px;
  box-shadow: 0 1px 8px color-mix(in srgb, var(--SmartThemeShadowColor) 30%, transparent);
  color: var(--SmartThemeBodyColor);
  font-size: calc(var(--mainFontSize) * 0.95);
  overflow-y: auto; /* 内容超高时整体可滚动，禁止裁切/飘出 */
  display: none;
}
.pkb-qmenu-title {
  padding: 9px 14px;
  font-weight: 700;
  border-bottom: 1px solid var(--SmartThemeBorderColor);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, var(--pkb-solid-bg) 88%);
}
.pkb-qmenu-model {
  padding: 6px 12px;
  font-size: calc(var(--mainFontSize) * 0.85);
  opacity: .85;
  border-bottom: 1px solid var(--SmartThemeBorderColor);
  background: var(--SmartThemeFastUIBGColor);
}
.pkb-qmenu-list { flex: 1 1 auto; min-height: 0; max-height: 180px; overflow-y: auto; padding: 4px; }
.pkb-qmenu-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--SmartThemeBodyColor);
}
.pkb-qmenu-item:hover { background: var(--SmartThemeFastUIBGColor); filter: brightness(1.08); }
.pkb-qmenu-item.pkb-qmenu-active {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor) 28%, var(--pkb-solid-bg) 72%);
  border: 1px solid var(--SmartThemeQuoteColor);
  color: var(--SmartThemeBodyColor);
  font-weight: 600;
}
.pkb-qmenu-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pkb-qmenu-url { opacity: .7; font-size: calc(var(--mainFontSize) * 0.8); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
.pkb-qmenu-empty { padding: 10px; opacity: .6; }
.pkb-qmenu-manage {
  padding: 9px 12px;
  border-top: 1px solid var(--SmartThemeBorderColor);
  cursor: pointer;
  text-align: center;
  font-weight: 600;
}
.pkb-qmenu-manage:hover { background: var(--SmartThemeFastUIBGColor); }
.pkb-syncrow { margin-top: 6px; flex-wrap: wrap; }
/* 去重确认弹窗：显示重复密钥明文对比，确认后才执行 */
#pkb-dedupe-modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 30002; display: flex; align-items: center; justify-content: center; padding: 0; }
.pkb-dedupe-box { box-sizing: border-box; width: min(520px, 92vw); max-width: min(520px, 92vw); max-height: min(78vh, 560px); max-height: min(78dvh, 560px); display: flex; flex-direction: column; border: 1px solid var(--SmartThemeBorderColor); border-radius: 14px; box-shadow: 0 1px 10px color-mix(in srgb, var(--SmartThemeShadowColor) 35%, transparent); color: var(--SmartThemeBodyColor); font-size: calc(var(--mainFontSize) * 0.95); overflow: hidden; }
.pkb-dedupe-title { padding: 14px 18px; font-weight: 700; border-bottom: 1px solid var(--SmartThemeBorderColor); }
.pkb-dedupe-tip { padding: 10px 18px 4px; font-size: calc(var(--mainFontSize) * 0.82); opacity: .8; }
.pkb-dedupe-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 18px; display: flex; flex-direction: column; gap: 8px; }
.pkb-dedupe-item { border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeFastUIBGColor); border-radius: 8px; padding: 8px 10px; }
.pkb-dedupe-val { font-family: monospace; font-size: calc(var(--mainFontSize) * 0.9); word-break: break-all; user-select: text; }
.pkb-dedupe-empty { opacity: .55; font-style: italic; }
.pkb-dedupe-meta { font-size: calc(var(--mainFontSize) * 0.78); opacity: .7; margin-top: 3px; }
 .pkb-dedupe-head { font-size: calc(var(--mainFontSize) * 0.82); font-weight: 700; margin-bottom: 4px; opacity: .9; }
 .pkb-dedupe-row { border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 6px 8px; margin-top: 6px; }
 .pkb-dedupe-keep { border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 50%, var(--SmartThemeBorderColor)); }
 .pkb-dedupe-del { opacity: .82; }
.pkb-dedupe-btns { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--SmartThemeBorderColor); flex-wrap: wrap; }

/* ============ 移动端：面板/弹窗按比例缩小并严格居中，禁止飘出屏幕 ============ */
@media (max-width: 800px) {
  #pkb-dedupe-modal { padding: 0; }
  #pkb-dedupe-modal .pkb-dedupe-title { padding: 10px 14px; font-size: calc(var(--mainFontSize) * 0.92); }
  #pkb-dedupe-modal .pkb-dedupe-tip { padding: 8px 14px 3px; font-size: calc(var(--mainFontSize) * 0.78); }
  #pkb-dedupe-modal .pkb-dedupe-list { padding: 8px 12px; }
  #pkb-dedupe-modal .pkb-dedupe-item { padding: 6px 8px; }
  #pkb-dedupe-modal .pkb-dedupe-val { font-size: calc(var(--mainFontSize) * 0.82); }
  #pkb-dedupe-modal .pkb-dedupe-meta { font-size: calc(var(--mainFontSize) * 0.72); }
  #pkb-dedupe-modal .pkb-dedupe-btns { padding: 10px 14px; }
  #pkb-panel { margin: 10px 0 14px; border-radius: 12px; }
  #pkb-panel.pkb-panel-float {
    width: 90vw;
    max-width: 90vw;
    max-height: 78vh;
    max-height: 78dvh;
    border-radius: 12px;
  }
  #pkb-panel .pkb-header { padding: 7px 10px; gap: 6px; }
  #pkb-panel .pkb-title { font-size: calc(var(--mainFontSize) * 0.92); }
  #pkb-panel .pkb-close { font-size: calc(var(--mainFontSize) * 0.9); }
  #pkb-panel .pkb-body { padding: 9px 10px; gap: 9px; font-size: calc(var(--mainFontSize) * 0.85); }
  #pkb-panel .pkb-section h4, #pkb-panel .pkb-form-section h4 { font-size: calc(var(--mainFontSize) * 0.72); margin-bottom: 5px; }
  #pkb-panel .pkb-list { max-height: 24vh; }
  #pkb-panel .pkb-row { flex-wrap: wrap; padding: 5px 7px; gap: 4px; }
  #pkb-panel .pkb-row-name { font-size: calc(var(--mainFontSize) * 0.9); }
  #pkb-panel .pkb-row-url, #pkb-panel .pkb-row-key, #pkb-panel .pkb-row-model { font-size: calc(var(--mainFontSize) * 0.72); }
  #pkb-panel .pkb-row-actions { margin-top: 2px; width: 100%; }
  #pkb-panel .pkb-row-actions .pkb-btn { flex: 1; padding: 4px 6px; font-size: calc(var(--mainFontSize) * 0.78); }
  #pkb-panel .pkb-add-row { flex-wrap: wrap; gap: 6px; }
  #pkb-panel .pkb-add-row input { flex: 1 1 100%; font-size: calc(var(--mainFontSize) * 0.85); }
  #pkb-panel .pkb-add-row .pkb-btn { flex: 1 1 auto; padding: 4px 8px; font-size: calc(var(--mainFontSize) * 0.8); }
  #pkb-panel .pkb-form { gap: 6px; }
  #pkb-panel .pkb-form input[type="text"], #pkb-panel .pkb-form input[type="password"] { padding: 5px 7px; font-size: calc(var(--mainFontSize) * 0.85); }
  #pkb-panel .pkb-keyrow .pkb-btn { padding: 4px 8px; font-size: calc(var(--mainFontSize) * 0.78); }
  #pkb-panel .pkb-check { font-size: calc(var(--mainFontSize) * 0.8); }
  #pkb-panel .pkb-footnote { font-size: calc(var(--mainFontSize) * 0.66); }
  #pkb-panel .pkb-badge { font-size: calc(var(--mainFontSize) * 0.65); padding: 1px 5px; }
  #pkb-qmenu { min-width: min(250px, 86vw); max-width: 86vw; }
}
`;

    $('<style>').attr('id', 'pkb-style').text(css).appendTo('head');
}

/* ================= 入口 ================= */

jQuery(async () => {
    injectStyles();
    injectKeyIcon();
    injectOfflineIconStyle();
    startThemeIconSync();
    startConnMonitor();

    // 把设置入口按钮加进「扩展设置」区块（各版本通用）
    const container = $('#extensions_settings');
    if (container.length) {
        const btn = $('<div>')
            .attr('id', 'pkb-settings-button')
            .addClass('inline-drawer-toggle inline-drawer-header')
            .text(EXTENSION_DISPLAY)
            .attr('title', '打开「端口密钥绑定」设置')
            .css('cursor', 'pointer');
        container.append(btn);
        btn.on('click', openPanel);
    } else {
        // 兜底：老版本通过 getContext().extensionSettings 注册
        try {
            const context = await getContext();
            if (context && typeof context.extensionSettings === 'function') {
                context.extensionSettings(EXTENSION_DISPLAY, openPanel);
            }
        } catch (e) {
            console.warn('[端口密钥绑定] 未能注册设置入口', e);
        }
    }

    // 在输入栏魔法棒按钮上方加快捷按钮（#leftSendForm 是静态存在的，直接插入即可）
    if (!addQuickButton()) {
        // 极少数主题把 leftSendForm 藏起来的兜底：延迟到扩展加载完成再试一次
        try {
            const evt = await import('/script.js');
            if (evt && evt.eventSource && evt.event_types) {
                evt.eventSource.on(evt.event_types.EXTENSIONS_FIRST_LOAD, () => { if (addQuickButton()) applyConnIcon(); });
            }
        } catch (e) { /* ignore */ }
    } else {
        applyConnIcon(); // 按钮就绪后同步一次连接状态图标
    }

    // 把完整面板内嵌进酒馆原生 API 设置抽屉（#rm_api_block）末尾：
    // 用户打开 API 界面即可直接看到并管理方案，无需再弹独立窗口
    try {
        const host = document.getElementById('rm_api_block');
        if (host) {
            if (!panel) {
                panel = $('<div>').attr('id', 'pkb-panel').addClass('pkb-panel');
                try { host.appendChild(panel[0]); } catch (e) { $(host).append(panel); }
            }
            renderPanel();
            panel.css('display', 'flex');
        }
    } catch (e) { /* 失败不阻塞：下次 openPanel 会重新处理 */ }

    // Esc 关闭面板/菜单
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') {
            if (panel && panel.is(':visible')) panel.css('display', 'none');
            closeQuickMenu();
        }
    });

    console.log('[端口密钥绑定] 已加载');
});
