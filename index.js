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
const MODULE_VERSION = '1.1.4';

// 初始化扩展设置
if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {
        notes: {}, // "avatar::fileName" -> 备注文本
    };
}

const settings = extension_settings[MODULE_NAME];
const notes = settings.notes;

let panelContent = null;
let charListEl = null;
let countsStarted = false; // 面板首次展开后才拉取数量（懒加载）
let countsLoaded = false;
const counts = {};        // avatar -> 存档数量
const chatsCache = {};    // avatar -> 完整存档列表（缓存）
const expanded = new Set(); // 当前展开的存档文件夹（avatar，仅会话内）

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

// 按最后消息时间倒序
function sortChats(list) {
    return list.slice().sort((a, b) => toMs(b.last_mes) - toMs(a.last_mes));
}

// ========== 数据获取（走酒馆原生接口） ==========

// 数量用 simple 模式：只读目录，不解析文件内容，非常轻量
async function fetchSimpleCount(avatar) {
    try {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        if (data && data.error === true) return 0;
        return Array.isArray(data) ? data.length : 0;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 获取角色存档数量失败:`, e);
        return 0;
    }
}

// 完整信息：file_name / chat_items / file_size / mes / last_mes
async function fetchCharacterChats(avatar) {
    try {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.error === true) return [];
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 获取角色存档失败:`, e);
        return null;
    }
}

// 加载各角色存档数量（只补缺失的）
async function loadCounts() {
    const list = getContext().characters || [];
    countsLoaded = true;
    await Promise.all(list.map(async c => {
        if (!c || !c.avatar) return;
        if (counts[c.avatar] === undefined) {
            counts[c.avatar] = await fetchSimpleCount(c.avatar);
        }
    }));
    await renderCharFolders();
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
        return;
    }

    const currentChat = getContext().chatId;
    const frag = document.createDocumentFragment();
    chats.forEach(chat => frag.appendChild(buildChatRow(chat, avatar, currentChat)));
    body.appendChild(frag);
}

// 更新角色文件夹上的存档数量徽章
function updateCharBadge(avatar, count) {
    if (!charListEl) return;
    const folder = charListEl.querySelector(`.cam-char[data-avatar="${CSS.escape(avatar)}"]`);
    if (!folder) return;
    const badge = folder.querySelector('.cam-char-count');
    if (badge) badge.textContent = String(count);
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
        toastr?.success?.(`已加载存档：${fileName}`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 加载存档失败:`, e);
        toastr?.error?.(`加载存档失败：${fileName}`);
    }
}

async function renderCharFolders() {
    if (!charListEl) return;
    charListEl.innerHTML = '';

    const list = getContext().characters || [];

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
    Object.keys(chatsCache).forEach(k => delete chatsCache[k]);
    Object.keys(counts).forEach(k => delete counts[k]);
    countsLoaded = true;
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

    // 聊天切换时更新「当前」标记
    eventSource.on(event_types.CHAT_CHANGED, updateCurrentBadges);

    console.log(`[${MODULE_NAME}] 初始化完成`);
}

export async function loop() {
    // 无需循环逻辑
}
