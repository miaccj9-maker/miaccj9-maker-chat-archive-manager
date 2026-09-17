import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    characters,
    selectCharacterById,
    openCharacterChat,
    setActiveGroup,
    getRequestHeaders,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../../scripts/extensions.js';

const MODULE_NAME = 'chat-archive-manager';
const MODULE_VERSION = '1.2.7';

// 初始化扩展设置
if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {
        notes: {}, // "avatar::fileName" -> 备注文本
    };
}

const settings = extension_settings[MODULE_NAME];
const notes = settings.notes;
// 存档专属头像（v1.2.0）：兼容旧版设置，无 avatars 字段时补上
if (!settings.avatars) settings.avatars = {};
const avatars = settings.avatars;

let panelContent = null;
let charListEl = null;
let countsStarted = false; // 面板首次展开后才拉取数量（懒加载）
let countsLoaded = false;
const counts = {};        // avatar -> 存档数量
const chatsCache = {};    // avatar -> 完整存档列表（缓存）
const expanded = new Set(); // 当前展开的存档文件夹（avatar，仅会话内）

// ========== 性能参数 ==========
const COUNT_CONCURRENCY = 5;   // 并发拉取存档数量的上限，避免一次性请求洪水压垮本地服务
const FETCH_TIMEOUT = 20000;   // 单个请求超时（毫秒），防止服务端卡住时面板一直转圈
let cacheVersion = 0;          // 存档列表缓存版本：刷新时 +1，用于跳过重复渲染
let countsPromise = null;      // 计数请求批次去重：同一时刻只跑一批
let renderChain = Promise.resolve(); // 渲染串行化：避免并发重建互相打断
let lastSignature = null;      // 上次渲染时的角色列表签名，用于跳过无变化的重复重建

// ========== 工具函数 ==========

function noteKey(avatar, fileName) {
    return `${avatar}::${fileName}`;
}

// 把 ST 的日期值（ISO 字符串 / 毫秒数 / 秒数）统一转成毫秒
function toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        return n < 1e11 ? n * 1000 : n;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatDateTime(value) {
    const ms = toMs(value);
    if (!ms) return '';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 纯时间戳命名的存档（未重命名过）→ 格式化为日期时间；否则返回 null
function formatTimestampName(base) {
    if (!/^\d+$/.test(base)) return null;
    return formatDateTime(base);
}

// 按最后消息时间倒序（时间戳只解析一次，避免比较时重复转换）
function sortChats(list) {
    const msByChat = new Map();
    for (const c of list) msByChat.set(c, toMs(c && c.last_mes));
    return list.slice().sort((a, b) => (msByChat.get(b) || 0) - (msByChat.get(a) || 0));
}

// ========== 数据获取（走酒馆原生接口） ==========

// 带超时的 fetch：避免单个请求挂起导致整个面板一直转圈
async function fetchWithTimeout(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// 数量用 simple 模式：只读目录，不解析文件内容，非常轻量
async function fetchSimpleCount(avatar) {
    try {
        const res = await fetchWithTimeout('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        if (data && data.error === true) return 0;
        return Array.isArray(data) ? data.length : 0;
    } catch (e) {
        if (e && e.name === 'AbortError') {
            console.warn(`[${MODULE_NAME}] 获取角色存档数量超时(${FETCH_TIMEOUT}ms):`, avatar);
        } else {
            console.warn(`[${MODULE_NAME}] 获取角色存档数量失败:`, e);
        }
        return 0;
    }
}

// 完整信息：file_name / chat_items / file_size / mes / last_mes
async function fetchCharacterChats(avatar) {
    try {
        const res = await fetchWithTimeout('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.error === true) return [];
        return Array.isArray(data) ? data : [];
    } catch (e) {
        if (e && e.name === 'AbortError') {
            console.warn(`[${MODULE_NAME}] 获取角色存档超时(${FETCH_TIMEOUT}ms):`, avatar);
        } else {
            console.warn(`[${MODULE_NAME}] 获取角色存档失败:`, e);
        }
        return null;
    }
}

// 受并发上限的 map：同一时刻最多 limit 个任务在跑，避免并发请求洪水
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// 加载各角色存档数量（只补缺失的；并发受限；重复调用复用同一批次，不重复请求）
function loadCounts() {
    if (countsPromise) return countsPromise;
    countsPromise = (async () => {
        try {
            const list = getContext().characters || [];
            countsLoaded = true;
            const missing = list.filter(c => c && c.avatar && counts[c.avatar] === undefined);
            if (missing.length > 0) {
                await mapLimit(missing, COUNT_CONCURRENCY, async c => {
                    counts[c.avatar] = await fetchSimpleCount(c.avatar);
                });
                // 有新的计数结果：必须重渲染（过滤无存档角色 + 更新徽章）
                await renderCharFolders(true);
            } else {
                // 无新计数：交给签名检查决定是否需要重建
                await renderCharFolders();
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 加载存档数量失败:`, e);
        }
    })().finally(() => { countsPromise = null; });
    return countsPromise;
}

// ========== UI 构建 ==========

function updateStats() {
    const el = document.getElementById('cam-stats');
    if (!el) return;
    const total = (getContext().characters || []).length;
    const visible = charListEl ? charListEl.querySelectorAll('.cam-char').length : 0;
    el.textContent = countsLoaded
        ? `共 ${total} 个角色，${visible} 个有存档`
        : `共 ${total} 个角色`;
}

function buildCharFolder(c, count) {
    // 一个角色 = 一个档案文件夹卡片：底色/边框/文字全部用主题变量，与原生 fieldset 一致
    const folder = document.createElement('div');
    folder.className = 'cam-char';
    folder.dataset.avatar = c.avatar;
    folder.style.cssText = 'border: 1px solid var(--SmartThemeBorderColor); border-radius: 10px; overflow: hidden; background: var(--SmartThemeBlurTintColor);';

    const head = document.createElement('div');
    head.className = 'cam-char-head flex-container alignItemCenter flexGap5';
    head.style.cssText = 'padding: 8px 12px; cursor: pointer; user-select: none;';

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-right cam-chevron';
    chevron.style.cssText = 'font-size: 11px; width: 14px; flex-shrink: 0; opacity: 0.7;';

    const name = document.createElement('span');
    name.className = 'cam-char-name';
    name.style.cssText = 'flex: 1; min-width: 0; font-weight: 600; opacity: 0.95;';
    name.textContent = c.name || String(c.avatar).replace(/\.png$/i, '');
    name.title = c.name || c.avatar;

    const badge = document.createElement('span');
    badge.className = 'cam-char-count';
    badge.style.cssText = 'flex-shrink: 0; font-size: 0.85em; padding: 0 7px; border-radius: 10px; border: 1px solid var(--SmartThemeBorderColor); opacity: 0.85;';
    badge.textContent = count === -1 ? '…' : String(count);

    head.appendChild(chevron);
    head.appendChild(name);
    head.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'cam-char-body flex-container flexFlowColumn';
    body.style.cssText = 'max-height: 340px; overflow-y: auto; border-top: 1px solid var(--SmartThemeBorderColor); padding: 8px; gap: 6px;';

    head.addEventListener('click', () => toggleFolder(folder, c.avatar, chevron));

    folder.appendChild(head);
    folder.appendChild(body);
    return folder;
}

async function toggleFolder(folder, avatar, chevron) {
    if (folder.classList.contains('cam-open')) {
        folder.classList.remove('cam-open');
        chevron.classList.remove('fa-chevron-down');
        chevron.classList.add('fa-chevron-right');
        expanded.delete(avatar);
        return;
    }
    folder.classList.add('cam-open');
    chevron.classList.remove('fa-chevron-right');
    chevron.classList.add('fa-chevron-down');
    expanded.add(avatar);
    const body = folder.querySelector('.cam-char-body');
    if (body) await renderChatList(avatar, body);
}

async function renderChatList(avatar, body) {
    let chats = chatsCache[avatar];

    // 已用当前版本的缓存完整渲染过：直接复用，避免收起/展开反复重建 DOM
    if (chats && body.dataset.cacheVer === String(cacheVersion) && body.childElementCount > 0) {
        return;
    }

    // 无论是否命中缓存都先清空容器，避免「收起再展开」时存档重复显示
    body.innerHTML = '';

    if (!chats) {
        const loading = document.createElement('div');
        loading.className = 'cam-loading';
        loading.textContent = '加载存档中…';
        body.appendChild(loading);

        chats = await fetchCharacterChats(avatar);
        if (chats === null) {
            body.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'cam-empty';
            err.textContent = '加载失败，请点击右上角「🔄 刷新」重试';
            body.appendChild(err);
            return;
        }
        chats = sortChats(chats);
        chatsCache[avatar] = chats;

        // 展开时同步徽章数量，避免显示数量与实际存档不一致
        if (counts[avatar] !== chats.length) {
            counts[avatar] = chats.length;
            updateCharBadge(avatar, chats.length);
        }
        body.innerHTML = '';
    }

    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cam-empty';
        empty.textContent = '该角色暂无聊天存档';
        body.appendChild(empty);
        body.dataset.cacheVer = String(cacheVersion);
        return;
    }

    const currentChat = getContext().chatId;
    const frag = document.createDocumentFragment();
    chats.forEach(chat => frag.appendChild(buildChatRow(chat, avatar, currentChat)));
    body.appendChild(frag);
    body.dataset.cacheVer = String(cacheVersion);
}

// 更新角色文件夹上的存档数量徽章
function updateCharBadge(avatar, count) {
    if (!charListEl) return;
    const folder = charListEl.querySelector(`.cam-char[data-avatar="${CSS.escape(avatar)}"]`);
    if (!folder) return;
    const badge = folder.querySelector('.cam-char-count');
    if (badge) badge.textContent = String(count);
}

// ========== 存档专属头像（v1.2.0） ==========
// 每个存档可设置独立头像：以压缩后的 data URL 存进扩展设置（本地持久化，重启不丢）。
// 打开/切换存档时自动应用到聊天窗口的角色消息头像；未设置时保持角色默认头像。

function getChatAvatar(avatar, fileName) {
    return avatars[noteKey(avatar, fileName)] || null;
}

function setChatAvatar(avatar, fileName, dataUrl) {
    avatars[noteKey(avatar, fileName)] = dataUrl;
    saveSettingsDebounced();
}

function removeChatAvatar(avatar, fileName) {
    delete avatars[noteKey(avatar, fileName)];
    saveSettingsDebounced();
}

// 角色默认头像的访问 URL（带时间戳防缓存）
function defaultAvatarUrl(avatar) {
    return `/characters/${encodeURIComponent(avatar)}`;
}

// 当前是否正打开「avatar 角色的 fileName 存档」
function isCurrentChat(avatar, fileName) {
    const chatId = getContext().chatId;
    if (!chatId) return false;
    const c = getContext().characters[getContext().characterId];
    if (!c || c.avatar !== avatar) return false;
    return stripJsonl(fileName) === chatId;
}

// 当前角色对象：酒馆的 characterId 可能是数字也可能是数字字符串（script.js 中 this_chid = String(value)），
// 统一归一为数字索引；无角色/越界/群聊时返回 null
function currentCharacter() {
    const ci = getContext().characterId;
    if (ci === undefined || ci === null || ci === '') return null;
    const idx = Number(ci);
    const cs = getContext().characters || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= cs.length) return null;
    return cs[idx] || null;
}

// 当前打开的存档若有专属头像则返回 dataURL，否则返回 null（群聊/无角色时返回 null）
function currentChatAvatarUrl() {
    const c = currentCharacter();
    if (!c || !c.avatar) return null;
    const chatId = getContext().chatId;
    if (!chatId) return null;
    return getChatAvatar(c.avatar, chatId + '.jsonl');
}

// 判断消息头像 img 是否正显示「该角色的默认头像」：
// 酒馆用 /thumbnail?type=avatar&file=... 渲染角色头像，
// 用户消息是 type=persona、强制头像/系统头像均不含此格式，天然区分。
// 判断 img 是否为「当前角色的默认头像」：
// 兼容两种酒馆实际渲染格式：
//   /characters/<avatar>            （旧版/当前版本消息头像直接路径）
//   /thumbnail?type=avatar&file=…   （缩略图格式）
function isRoleAvatarImg(img, avatar) {
    const src = img.getAttribute('src') || '';
    if (!src || !avatar) return false;
    const encoded = encodeURIComponent(avatar);
    return (src.includes('type=avatar')
            && (src.includes('file=' + encoded) || src.includes('file=' + avatar)))
        || src.includes('/characters/' + encoded)
        || src.includes('/characters/' + avatar);
}

// 替换/恢复单个消息头像（幂等：已替换过的直接更新 src，换图/恢复均即时生效）
function replaceMessageAvatar(img, avatar, customUrl) {
    if (customUrl) {
        if (img.dataset.camCustom === '1') {
            img.src = customUrl; // 已替换过：直接换新图
        } else if (isRoleAvatarImg(img, avatar)) {
            img.dataset.camOrig = img.getAttribute('src') || '';
            img.dataset.camCustom = '1';
            img.src = customUrl;
        }
    } else if (img.dataset.camCustom === '1') {
        img.src = img.dataset.camOrig || '';
        delete img.dataset.camCustom;
        delete img.dataset.camOrig;
    }
}

// 判断元素是否位于管理区（左侧角色列表/角色编辑/扩展设置等），避免误替换非聊天界面的头像
function isManagementArea(img) {
    return !!img.closest('#rm_print_characters_block, #character_edit_panel, #extension_settings, #avatar_upload_panel, #option_section, .mes_edit_area');
}

// 收集消息 HTML 内嵌的角色头像 img（文档级扫描，覆盖楼层/手账/小剧场等自定义渲染，不限于 .mes 内部）：
// - 明确的头像类（ls-avatar 等楼层/卡片头像）
// - 小尺寸方形头像图（高 30~64px + 圆角 + object-fit:cover），常见于微信小剧场/手账卡片等自定义 HTML
// 排除右侧对话头像（margin-left，通常为对话接收方/用户头像），避免把用户头像误换成角色头像
function collectEmbeddedAvatars(scope) {
    const out = [];
    const all = scope.querySelectorAll('img.ls-avatar, img[style*="object-fit:cover"]');
    for (const img of all) {
        if (isManagementArea(img)) continue;
        const style = img.getAttribute('style') || '';
        if (img.classList.contains('ls-avatar')) {
            out.push(img);
            continue;
        }
        if (/margin-left:\s*\d+px/.test(style)) continue;
        const h = /height:\s*(\d+)px/.exec(style);
        if (h && Number(h[1]) >= 30 && Number(h[1]) <= 64 && /border-radius/.test(style)) out.push(img);
    }
    return out;
}

// 替换/恢复消息内嵌头像（选择器已限定为角色头像，无需再校验 src）
function replaceEmbeddedAvatar(img, customUrl) {
    if (customUrl) {
        if (img.dataset.camCustom === '1') {
            img.src = customUrl; // 已替换过：直接换新图
        } else {
            img.dataset.camOrig = img.getAttribute('src') || '';
            img.dataset.camCustom = '1';
            img.src = customUrl;
        }
    } else if (img.dataset.camCustom === '1') {
        img.src = img.dataset.camOrig || '';
        delete img.dataset.camCustom;
        delete img.dataset.camOrig;
    }
}

// 应用到当前聊天窗口内的全部角色消息头像：
// 1) 酒馆标准布局（.mesAvatarWrapper > .avatar > img）
// 2) 消息 HTML 内嵌的角色头像（楼层/手账/微信小剧场等自定义卡片，文档级扫描）
function applyAvatarToChat(avatar, customUrl) {
    const chat = document.getElementById('chat') || document;
    const std = chat.querySelectorAll('.mes .avatar img, .mes .mes_avatar, .mes img.avatar');
    const emb = collectEmbeddedAvatars(document);
    let replaced = 0;
    let lsCount = 0;
    let styleCount = 0;
    for (const img of std) {
        const before = img.getAttribute('src') || '';
        replaceMessageAvatar(img, avatar, customUrl);
        if (img.getAttribute('src') !== before) replaced++;
    }
    for (const img of emb) {
        const before = img.getAttribute('src') || '';
        replaceEmbeddedAvatar(img, customUrl);
        if (img.getAttribute('src') !== before) {
            replaced++;
            if (img.classList.contains('ls-avatar')) lsCount++; else styleCount++;
        }
    }
    console.log(`[${MODULE_NAME}] 头像应用完成：标准 ${std.length} 个，内嵌 ${emb.length} 个（ls-avatar ${lsCount} + style ${styleCount}），共替换 ${replaced} 个`, { avatar, hasCustom: !!customUrl });
}

// 聊天切换 / 页面加载后：按当前存档自动应用专属头像（无自定义头像时新 DOM 本就是默认，无需恢复）
function applyAvatarForCurrentChat() {
    const c = currentCharacter();
    if (!c || !c.avatar) {
        console.log(`[${MODULE_NAME}] 无当前角色，跳过头像应用`, { characterId: getContext().characterId });
        return;
    }
    const url = currentChatAvatarUrl();
    console.log(`[${MODULE_NAME}] 检查当前存档头像`, { avatar: c.avatar, chatId: getContext().chatId, hasCustom: !!url });
    if (url) {
        applyAvatarToChat(c.avatar, url);
        // 切换聊天时消息 DOM 可能尚未渲染完成，延迟补一次（isRoleAvatarImg 校验角色，不会误伤其他存档）
        setTimeout(() => applyAvatarToChat(c.avatar, url), 150);
    }
}

// MutationObserver 兜底：页面新增消息/楼层头像时自动应用当前存档头像
// （覆盖批量渲染、分页加载「显示更多」、流式生成、楼层扩展异步渲染等一切路径，事件驱动、不轮询）
let chatObserver = null;
let applyScheduled = false;
function scheduleApplyForChat() {
    if (applyScheduled) return;
    applyScheduled = true;
    requestAnimationFrame(() => {
        applyScheduled = false;
        applyAvatarForCurrentChat();
    });
}
function ensureChatObserver() {
    if (chatObserver) return;
    const target = document.body || document.getElementById('chat');
    if (!target) return;
    chatObserver = new MutationObserver((mutations) => {
        let hasNewMes = false;
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList && node.classList.contains('mes')
                    || (node.querySelector && (node.querySelector('.mes') || node.querySelector('img.ls-avatar')))) {
                    hasNewMes = true;
                    break;
                }
            }
            if (hasNewMes) break;
        }
        if (hasNewMes) scheduleApplyForChat();
    });
    chatObserver.observe(target, { childList: true, subtree: true });
}

// 单条消息渲染/更新后：若当前存档有专属头像则补上该消息头像
// （酒馆事件 CHARACTER_MESSAGE_RENDERED / MESSAGE_UPDATED，参数为消息 id）
function onMessageRendered(arg) {
    const id = (typeof arg === 'object' && arg !== null) ? arg.id : arg;
    if (id === undefined || id === null) return;
    const chat = getContext().chat || [];
    const m = chat.find(x => String(x.id) === String(id));
    if (m && m.is_user) return; // 用户消息不替换
    const c = currentCharacter();
    if (!c || !c.avatar) return;
    const url = currentChatAvatarUrl();
    if (!url) return;
    const el = document.querySelector(`#chat .mes[mesid="${id}"]`) || document.querySelector(`.mes[mesid="${id}"]`);
    if (!el) return;
    const img = el.querySelector('.avatar img, .mes_avatar, img.avatar');
    if (img) replaceMessageAvatar(img, c.avatar, url);
    // 该消息内嵌的角色头像（楼层/手账/小剧场等）也一并应用
    const embedded = collectEmbeddedAvatars(el);
    for (const em of embedded) replaceEmbeddedAvatar(em, url);
}

// ========== 头像压缩与选择（轻量：仅在用户主动操作时执行） ==========

const AVATAR_MAX_SIZE = 512; // 压缩后最大边长，控制设置体积与渲染开销

let avatarFileInput = null;
function getAvatarFileInput() {
    if (!avatarFileInput) {
        avatarFileInput = document.createElement('input');
        avatarFileInput.type = 'file';
        avatarFileInput.accept = 'image/*';
        avatarFileInput.style.display = 'none';
        document.body.appendChild(avatarFileInput);
    }
    return avatarFileInput;
}

// 读取图片文件 → canvas 等比压缩（优先 webp，保留透明；失败回退 PNG）
async function fileToCompressedDataUrl(file) {
    let bmp = null;
    try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; }
    let w = 0, h = 0, source = null;
    if (bmp) {
        w = bmp.width;
        h = bmp.height;
        source = bmp;
    } else {
        const url = URL.createObjectURL(file);
        try {
            source = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('无法读取图片'));
                im.src = url;
            });
            w = source.naturalWidth;
            h = source.naturalHeight;
        } finally {
            URL.revokeObjectURL(url);
        }
    }
    try {
        if (!w || !h) throw new Error('无效图片');
        const scale = Math.min(1, AVATAR_MAX_SIZE / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(source, 0, 0, cw, ch);
        }
        let dataUrl = canvas.toDataURL('image/webp', 0.88);
        if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
        return dataUrl;
    } finally {
        if (bmp) bmp.close();
    }
}

// 弹出文件选择并压缩，成功后回调 dataURL
function openAvatarPicker(onDone) {
    const input = getAvatarFileInput();
    input.value = '';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const dataUrl = await fileToCompressedDataUrl(file);
            onDone(dataUrl);
        } catch (e) {
            console.error(`[${MODULE_NAME}] 头像处理失败:`, e);
            toastr?.error?.('头像处理失败，请换一张图片重试');
        }
    };
    input.click();
}

// 存档行顶部的头像区：缩略图 + 换头像 + 移除
function buildAvatarRow(chat, avatar) {
    const row = document.createElement('div');
    row.className = 'cam-avatar-row flex-container alignItemCenter flexGap5';

    const img = document.createElement('img');
    img.className = 'cam-avatar-img';
    img.alt = '';

    const custom = getChatAvatar(avatar, chat.file_name);
    if (custom) {
        img.src = custom;
        img.title = '该存档的专属头像';
    } else {
        img.src = defaultAvatarUrl(avatar);
        img.classList.add('cam-avatar-default');
        img.title = '角色默认头像（未设置专属头像）';
    }

    const changeBtn = document.createElement('div');
    changeBtn.className = 'menu_button menu_button_icon cam-avatar-btn';
    changeBtn.innerHTML = '<i class="fa-solid fa-image"></i><span>换头像</span>';
    changeBtn.title = '为该存档设置专属头像（本地保存，切换存档自动生效）';
    changeBtn.addEventListener('click', () => {
        openAvatarPicker((dataUrl) => {
            setChatAvatar(avatar, chat.file_name, dataUrl);
            img.src = dataUrl;
            img.classList.remove('cam-avatar-default');
            img.title = '该存档的专属头像';
            removeBtn.style.display = '';
            if (isCurrentChat(avatar, chat.file_name)) applyAvatarToChat(avatar, dataUrl);
        });
    });

    const removeBtn = document.createElement('div');
    removeBtn.className = 'menu_button menu_button_icon cam-avatar-btn cam-avatar-remove';
    removeBtn.innerHTML = '<i class="fa-solid fa-eraser"></i><span>移除</span>';
    removeBtn.title = '恢复为角色默认头像';
    removeBtn.style.display = custom ? '' : 'none';
    removeBtn.addEventListener('click', () => {
        removeChatAvatar(avatar, chat.file_name);
        img.src = defaultAvatarUrl(avatar);
        img.classList.add('cam-avatar-default');
        img.title = '角色默认头像（未设置专属头像）';
        removeBtn.style.display = 'none';
        if (isCurrentChat(avatar, chat.file_name)) applyAvatarToChat(avatar, null);
    });

    row.appendChild(img);
    row.appendChild(changeBtn);
    row.appendChild(removeBtn);
    return row;
}

// 存档文件名去掉 .jsonl 后缀（服务端 /api/chats/get 会自动补后缀，
// 而 getContext().chatId 存的是不带后缀的名字，比较前必须统一）
function stripJsonl(name) {
    return String(name || '').replace(/\.jsonl$/i, '');
}

function buildChatRow(chat, avatar, currentChat) {
    const row = document.createElement('div');
    row.className = 'cam-chat flex-container flexFlowColumn';
    row.dataset.file = chat.file_name;
    row.style.cssText = 'border: 1px solid var(--SmartThemeBorderColor); border-radius: 10px; padding: 8px 10px; background: var(--SmartThemeBlurTintColor);';
    if (currentChat && stripJsonl(chat.file_name) === currentChat) {
        row.classList.add('cam-current');
    }

    const meta = document.createElement('div');
    meta.className = 'cam-chat-meta flex-container alignItemCenter flexGap5';
    meta.style.cssText = 'flex-wrap: wrap;';

    // 标题：未重命名的纯时间戳显示为日期时间；重命名过的显示自定义名
    const title = document.createElement('span');
    title.className = 'cam-chat-title';
    title.style.cssText = 'font-weight: 600;';
    const base = String(chat.file_name || '').replace(/\.jsonl$/i, '');
    title.textContent = formatTimestampName(base) || base || chat.file_name;
    title.title = chat.file_name;

    // 副信息：条数 · 大小 · 最后消息时间
    const sub = document.createElement('small');
    sub.className = 'cam-chat-sub';
    sub.style.cssText = 'opacity: 0.7;';
    const msgs = Number.isFinite(Number(chat.chat_items)) ? Number(chat.chat_items) : 0;
    let subText = `${msgs} 条 · ${chat.file_size || '?'}`;
    const dateStr = formatDateTime(chat.last_mes);
    if (dateStr) subText += ` · ${dateStr}`;
    sub.textContent = subText;

    // 当前标记
    const curBadge = document.createElement('span');
    curBadge.className = 'cam-current-badge';
    curBadge.style.cssText = 'font-size: 0.8em; padding: 0 6px; border-radius: 8px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeBlurTintColor); flex-shrink: 0;';
    curBadge.textContent = '当前';

    // 加载按钮（酒馆原生 menu_button）
    const loadBtn = document.createElement('div');
    loadBtn.className = 'menu_button menu_button_icon cam-load';
    loadBtn.style.cssText = 'margin-left: auto; padding: 2px 8px; font-size: 0.85em;';
    loadBtn.innerHTML = '<span>加载</span>';
    loadBtn.title = '切换到该角色并打开这个存档';
    loadBtn.addEventListener('click', () => loadChat(avatar, chat.file_name));

    meta.appendChild(title);
    meta.appendChild(sub);
    if (row.classList.contains('cam-current')) meta.appendChild(curBadge);
    meta.appendChild(loadBtn);

    // 最后一条消息预览：单行省略，不解析 HTML，防注入
    const preview = document.createElement('div');
    preview.className = 'cam-chat-preview';
    preview.style.cssText = 'font-size: 0.9em; opacity: 0.75; margin: 4px 0 0;';
    const mes = chat.mes && chat.mes !== '[The chat is empty]' ? chat.mes : '';
    preview.textContent = mes;
    preview.title = mes;

    // 备注输入框（酒馆原生 text_pole，主题化外观）
    const noteInput = document.createElement('input');
    noteInput.className = 'text_pole cam-note';
    noteInput.type = 'text';
    noteInput.placeholder = '✎ 添加备注…';
    noteInput.maxLength = 200;
    noteInput.style.cssText = 'margin: 4px 0 0; padding: 3px 6px; font-size: 0.9em;';
    noteInput.value = notes[noteKey(avatar, chat.file_name)] || '';
    noteInput.addEventListener('input', () => {
        const v = noteInput.value.trim();
        if (v) notes[noteKey(avatar, chat.file_name)] = v;
        else delete notes[noteKey(avatar, chat.file_name)];
        saveSettingsDebounced();
    });

    row.appendChild(buildAvatarRow(chat, avatar));
    row.appendChild(meta);
    row.appendChild(preview);
    row.appendChild(noteInput);
    return row;
}

// 加载指定角色的指定存档（与酒馆原生聊天列表点击行为一致）
async function loadChat(avatar, fileName) {
    const idx = characters.findIndex(c => c && c.avatar === avatar);
    if (idx === -1) {
        console.warn(`[${MODULE_NAME}] 找不到角色:`, avatar);
        toastr?.warning?.(`找不到角色「${avatar}」`);
        return;
    }
    try {
        // 关键修复：服务端 /api/chats/get 会自动给 file_name 追加 .jsonl 后缀。
        // 若直接传入带后缀的完整文件名，会被拼成「xxx.jsonl.jsonl」而找不到存档，
        // 酒馆将返回空聊天并插入角色开场白 —— 表现就是「点了加载却开了个新聊天」。
        const chatBase = stripJsonl(fileName);

        setActiveGroup(null); // 确保退出群聊模式
        await selectCharacterById(idx);
        // 用酒馆原生 openCharacterChat 显式打开指定存档：
        // 即使当前已选中该角色，也能正确切换存档（selectCharacterById 不会重新加载同角色聊天）
        await openCharacterChat(chatBase);
        // 若目标存档与当前已打开存档相同，酒馆会直接返回（"is already open"）而不触发事件，
        // 这里显式补一次头像应用，确保任何时候点「加载」都能立即生效
        setTimeout(() => applyAvatarForCurrentChat(), 100);
        toastr?.success?.(`已加载存档：${fileName}`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 加载存档失败:`, e);
        toastr?.error?.(`加载存档失败：${fileName}`);
    }
}

// 渲染串行化：CHARACTER_PAGE_LOADED 与计数完成两个来源可能并发触发，排队避免互相打断
function renderCharFolders(force = false) {
    const run = renderChain.then(() => renderCharFoldersImpl(force));
    renderChain = run.catch(e => console.warn(`[${MODULE_NAME}] 渲染失败:`, e));
    return run;
}

async function renderCharFoldersImpl(force) {
    if (!charListEl) return;
    const list = getContext().characters || [];

    // 角色列表签名：列表没变且计数已加载时跳过重建（徽章与过滤结果均为最新）
    const sig = list.map(c => c && c.avatar).filter(Boolean).join('\u0001');
    if (!force && countsLoaded && sig === lastSignature) {
        updateStats();
        return;
    }
    lastSignature = sig;

    charListEl.innerHTML = '';

    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cam-empty';
        empty.textContent = '未找到角色卡，请先导入角色';
        charListEl.appendChild(empty);
        updateStats();
        return;
    }

    const frag = document.createDocumentFragment();
    list.forEach(c => {
        if (!c || !c.avatar) return;
        const n = countsLoaded ? (counts[c.avatar] ?? 0) : -1;
        if (countsLoaded && n === 0) return; // 无存档的角色不展示
        frag.appendChild(buildCharFolder(c, n));
    });
    charListEl.appendChild(frag);
    updateStats();

    // 恢复上次展开的文件夹
    await Promise.all(list.map(async c => {
        if (!c || !expanded.has(c.avatar)) return;
        const folder = charListEl.querySelector(`.cam-char[data-avatar="${CSS.escape(c.avatar)}"]`);
        if (!folder) return;
        folder.classList.add('cam-open');
        const chevron = folder.querySelector('.cam-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-right');
            chevron.classList.add('fa-chevron-down');
        }
        const body = folder.querySelector('.cam-char-body');
        if (body) await renderChatList(c.avatar, body);
    }));
}

// 仅更新「当前」标记，不重建列表
function updateCurrentBadges() {
    if (!panelContent) return;
    const current = getContext().chatId;
    const rows = panelContent.querySelectorAll('.cam-chat');
    for (const row of rows) {
        const isCur = current && stripJsonl(row.dataset.file) === current;
        row.classList.toggle('cam-current', isCur);
        let badge = row.querySelector('.cam-current-badge');
        if (isCur && !badge) {
            badge = document.createElement('span');
            badge.className = 'cam-current-badge';
            badge.textContent = '当前';
            const meta = row.querySelector('.cam-chat-meta');
            const loadBtn = row.querySelector('.cam-load');
            if (meta) meta.insertBefore(badge, loadBtn);
        } else if (!isCur && badge) {
            badge.remove();
        }
    }
}

// 刷新：清空缓存并重拉数量与已展开的存档
async function refreshAll() {
    cacheVersion++; // 让所有已渲染的存档列表整体失效，重新拉取
    Object.keys(chatsCache).forEach(k => delete chatsCache[k]);
    Object.keys(counts).forEach(k => delete counts[k]);
    countsLoaded = true;
    // 先等在途计数批次结束，再基于清空后的状态重新拉取，避免与在途批次交错遗漏
    await countsPromise;
    await loadCounts();
}

function createSettingsPanel() {
    // 结构与柏宝箱等原生扩展一致：全部使用酒馆全局组件类
    // （inline-drawer / inline-drawer-header / menu_button / text_pole / flex-container …）
    // 颜色一律内联使用主题变量，不写自定义样式，因此天然跟随主题美化。
    const container = document.createElement('div');
    container.id = 'cam-panel';
    container.className = 'inline-drawer';

    // 标题栏：inline-drawer-toggle 触发酒馆原生展开/收起；图标由酒馆原生逻辑切换
    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header cam-header';
    header.innerHTML = `
        <b>📁 聊天存档管理器<small class="cam-version"
                style="color: var(--SmartThemeBodyColor); opacity: 0.6; border-radius: 4px; padding: 2px 4px; margin-left: 4px; font-size: 0.8em;">v${MODULE_VERSION}</small></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    `;

    // 内容区
    const content = document.createElement('div');
    content.className = 'inline-drawer-content cam-content';
    content.style.paddingTop = '5px';

    // 工具栏（刷新 + 统计）
    const toolbar = document.createElement('div');
    toolbar.className = 'flex-container justifySpaceBetween alignItemCenter';
    toolbar.style.margin = '0 0 8px';

    const refreshBtn = document.createElement('div');
    refreshBtn.className = 'menu_button menu_button_icon cam-refresh';
    refreshBtn.title = '重新加载各角色的存档数量与列表';
    refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i><span>刷新</span>';
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('disabled');
        refreshBtn.style.opacity = '0.5';
        await refreshAll();
        refreshBtn.classList.remove('disabled');
        refreshBtn.style.opacity = '';
    });

    const stats = document.createElement('span');
    stats.className = 'cam-stats';
    stats.id = 'cam-stats';
    stats.style.fontSize = '0.9em';
    stats.style.opacity = '0.7';

    toolbar.appendChild(refreshBtn);
    toolbar.appendChild(stats);

    // 角色档案列表（一个角色 = 一个文件夹）
    charListEl = document.createElement('div');
    charListEl.className = 'flex-container flexFlowColumn cam-char-list';
    charListEl.id = 'cam-char-list';
    charListEl.style.gap = '6px';

    content.appendChild(toolbar);
    content.appendChild(charListEl);

    container.appendChild(header);
    container.appendChild(content);

    const extensionsSettings = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2');
    if (extensionsSettings) {
        extensionsSettings.appendChild(container);
    } else {
        console.warn(`[${MODULE_NAME}] 未找到扩展设置容器，面板将不可用`);
    }

    panelContent = content;

    // 首次展开面板时才拉取各角色存档数量（懒加载，页面加载时零额外请求）
    header.addEventListener('click', () => {
        if (!countsStarted) {
            countsStarted = true;
            loadCounts();
        }
    });

    return content;
}

// ========== 扩展入口 ==========

export async function init() {
    console.log(`[${MODULE_NAME}] v${MODULE_VERSION} 初始化中...`);

    // 创建设置面板
    createSettingsPanel();

    // 初始渲染角色列表（数量在面板首次展开后懒加载）
    renderCharFolders();

    // 角色列表加载/变化时重建（清理已删除角色的缓存与展开状态）
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        const avatars = new Set((getContext().characters || []).map(c => c && c.avatar).filter(Boolean));
        Object.keys(chatsCache).forEach(k => { if (!avatars.has(k)) delete chatsCache[k]; });
        Object.keys(counts).forEach(k => { if (!avatars.has(k)) delete counts[k]; });
        expanded.forEach(k => { if (!avatars.has(k)) expanded.delete(k); });
        if (countsStarted) {
            countsLoaded = true;
            loadCounts();
        } else {
            renderCharFolders();
        }
    });

    // 聊天切换时更新「当前」标记，并按存档应用专属头像
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateCurrentBadges();
        applyAvatarForCurrentChat();
    });

    // 角色消息渲染/消息更新时补上该存档的专属头像（本版本酒馆用 CHARACTER_MESSAGE_RENDERED）
    if (event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageRendered);

    // 页面加载完成时（酒馆自动恢复上次聊天）应用一次专属头像
    applyAvatarForCurrentChat();

    // 聊天加载完成时应用（酒馆任何方式加载聊天都会触发，含自动恢复；比 CHAT_CHANGED 更可靠）
    if (event_types.CHAT_LOADED) eventSource.on(event_types.CHAT_LOADED, () => applyAvatarForCurrentChat());

    // 酒馆自动恢复上次聊天可能发生在扩展激活之前（错过事件），延迟重试几次（一次性、非轮询）
    [300, 1000, 2500, 5000].forEach(ms => setTimeout(() => applyAvatarForCurrentChat(), ms));

    // 监听聊天区域新增消息，任何渲染路径下都自动补上存档头像
    ensureChatObserver();

    console.log(`[${MODULE_NAME}] 初始化完成`);
}

export async function loop() {
    // 无需循环逻辑
}
