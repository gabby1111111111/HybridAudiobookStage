import {
    extension_settings,
    getContext,
} from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    getRequestHeaders,
} from '../../../../script.js';

const extensionName = 'HybridAudiobookStage';
const audioDbName = 'HybridAudiobookStageAudioCache';
const audioStoreName = 'audios';

const defaultSettings = {
    enabled: true,
    videoUrl: '/scripts/extensions/third-party/HybridAudiobookStage/assets/scene.mp4',
    videoFit: 'contain',
    openInWindow: false,
    autoAdvance: false,
    secondsPerSubtitle: 5,
    preferLastContentMessage: true,
    inlineRect: null,
    ttsSyncAutoAdvanceMigrated: false,

    ttsEnabled: true,
    ttsApiUrl: 'http://127.0.0.1:7880/v1/audio/speech',
    ttsModel: 'index-tts2',
    defaultVoice: 'default.wav',
    speed: 1.0,
    volume: 1.0,
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    readNarration: true,
    sharedAudioCacheEnabled: true,
    sharedAudioCacheMaxMb: 2048,
    useServerIndexTtsProxy: true,
    audiobookPlaybackUi: 'video',
    voiceMap: {},
    indexTtsStartBat: '',
};

let stageState = {
    segments: [],
    segmentMeta: [],
    pagesBySegment: [],
    index: 0,
    pageIndex: 0,
    playing: false,
    timer: null,
    linked: false,
    linkedController: null,
    mode: 'video',
    progress: 0,
    progressText: '',
    uiMode: 'video',
};

let pipState = null;
let audioDbPromise = null;
let currentPlayback = {
    audio: null,
    controller: null,
    playlist: [],
    index: 0,
    sessionId: 0,
    msg: null,
};

function getSettings() {
    extension_settings[extensionName] ||= {};
    const settings = extension_settings[extensionName];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = Array.isArray(value) ? [...value] : (value && typeof value === 'object' ? { ...value } : value);
        }
    }
    if (!settings.voiceMap || typeof settings.voiceMap !== 'object' || Array.isArray(settings.voiceMap)) {
        settings.voiceMap = {};
    }
    if (settings.ttsSyncAutoAdvanceMigrated !== true) {
        settings.autoAdvance = false;
        settings.ttsSyncAutoAdvanceMigrated = true;
        saveSettingsDebounced?.();
    }
    return settings;
}

function saveSettings() {
    saveSettingsDebounced?.();
}

function normalizeCacheLimitMb(value) {
    const mb = Number(value);
    if (!Number.isFinite(mb) || mb <= 0) return defaultSettings.sharedAudioCacheMaxMb;
    return Math.max(64, Math.min(102400, Math.round(mb)));
}

function formatMegabytes(bytes) {
    const mb = Number(bytes || 0) / 1024 / 1024;
    return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
}

function toastInfo(message) {
    if (window.toastr?.info) window.toastr.info(message);
    else console.info(`[${extensionName}] ${message}`);
}

function toastSuccess(message) {
    if (window.toastr?.success) window.toastr.success(message);
    else console.info(`[${extensionName}] ${message}`);
}

function toastWarn(message) {
    if (window.toastr?.warning) window.toastr.warning(message);
    else console.warn(`[${extensionName}] ${message}`);
}

function toastError(message) {
    if (window.toastr?.error) window.toastr.error(message);
    else console.error(`[${extensionName}] ${message}`);
}

function ensureWavSuffix(value) {
    const text = String(value || '').trim();
    if (!text) return defaultSettings.defaultVoice;
    return /\.wav$/i.test(text) ? text : `${text}.wav`;
}

function getIndexTtsModelsUrl() {
    const apiUrl = String(getSettings().ttsApiUrl || defaultSettings.ttsApiUrl).trim();
    try {
        const url = new URL(apiUrl, window.location.href);
        url.pathname = url.pathname.replace(/\/v1\/audio\/speech\/?$/i, '/v1/models');
        if (!/\/v1\/models\/?$/i.test(url.pathname)) {
            url.pathname = '/v1/models';
        }
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return 'http://127.0.0.1:7880/v1/models';
    }
}

function setServiceStatus(id, message, tone = 'muted') {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.className = `has-service-status has-${tone}`;
}

async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard?.writeText(text);
        toastSuccess('已复制启动命令');
    } catch {
        toastWarn(`复制失败，请手动运行: ${text}`);
    }
}

async function checkIndexTtsApi({ silent = false } = {}) {
    const statusId = 'has-index-status';
    const modelsUrl = getIndexTtsModelsUrl();
    const settings = getSettings();
    setServiceStatus(statusId, settings.useServerIndexTtsProxy !== false ? '正在通过酒馆服务器检测 IndexTTS2 API...' : '正在直连检测 IndexTTS2 API...', 'muted');
    try {
        let response;
        if (settings.useServerIndexTtsProxy !== false) {
            const headers = getRequestHeaders ? getRequestHeaders() : {};
            headers['Content-Type'] = 'application/json';
            response = await fetch('/api/plugins/hybrid-audiobook-stage/index-tts2/models', {
                method: 'POST',
                headers,
                body: JSON.stringify({ modelsUrl }),
            });
        } else {
            response = await fetch(modelsUrl, { method: 'GET' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let modelText = '';
        try {
            const data = await response.json();
            const models = Array.isArray(data?.data) ? data.data.map(item => item.id || item.name).filter(Boolean) : [];
            modelText = models.length ? `，模型: ${models.slice(0, 3).join('、')}` : '';
        } catch {
            modelText = '';
        }
        setServiceStatus(statusId, `IndexTTS2 已启动${modelText}${settings.useServerIndexTtsProxy !== false ? '（酒馆代理可用）' : ''}`, 'ok');
        if (!silent) toastSuccess('IndexTTS2 API 可用');
        return true;
    } catch (error) {
        setServiceStatus(statusId, `IndexTTS2 未连接：${error.message}。请点击“启动 API”或手动运行启动脚本。`, 'bad');
        if (!silent) toastWarn('IndexTTS2 API 还没启动');
        return false;
    }
}

async function startIndexTtsApi() {
    const settings = getSettings();
    const batPath = String(settings.indexTtsStartBat || defaultSettings.indexTtsStartBat).trim();
    setServiceStatus('has-index-status', '正在请求 SillyTavern 启动 IndexTTS2 API...', 'muted');
    try {
        const response = await fetch('/api/plugins/hybrid-audiobook-stage/start-index-tts2', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ batPath }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }
        const data = await response.json().catch(() => ({}));
        setServiceStatus('has-index-status', data.message || '已发送启动请求，模型加载需要一会儿。', 'ok');
        toastInfo('已请求启动 IndexTTS2，等窗口加载完成后再检测一次');
        setTimeout(() => checkIndexTtsApi({ silent: true }), 8000);
    } catch (error) {
        const command = `powershell -ExecutionPolicy Bypass -Command "Start-Process -FilePath '${batPath.replace(/'/g, "''")}' -WorkingDirectory '${batPath.replace(/\\/g, '\\').replace(/\\[^\\]+$/, '')}'"`;
        setServiceStatus('has-index-status', `无法一键启动：${error.message}。可手动运行 ${batPath}`, 'bad');
        await copyTextToClipboard(command);
    }
}

async function checkEdgeTtsPlugin({ silent = false } = {}) {
    setServiceStatus('has-edge-status', '正在检测 Edge TTS 插件...', 'muted');
    try {
        const response = await fetch('/api/plugins/edge-tts/probe', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
        setServiceStatus('has-edge-status', 'Edge TTS 插件已加载', 'ok');
        if (!silent) toastSuccess('Edge TTS 可用');
        return true;
    } catch (error) {
        setServiceStatus('has-edge-status', `Edge TTS 未连接：${error.message}。请确认 SillyTavern-EdgeTTS-Plugin 已安装并重启酒馆。`, 'bad');
        if (!silent) toastWarn('Edge TTS 插件还没加载');
        return false;
    }
}

async function testEdgeTtsAudio() {
    const ok = await checkEdgeTtsPlugin({ silent: true });
    if (!ok) return;
    setServiceStatus('has-edge-status', '正在生成 Edge 测试音频...', 'muted');
    try {
        const response = await fetch('/api/plugins/edge-tts/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: 'Edge TTS 测试成功。',
                voice: getSettings().edgeVoice || defaultSettings.edgeVoice,
            }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = Math.max(0, Math.min(1, Number(getSettings().volume || 1)));
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
        audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        await audio.play();
        setServiceStatus('has-edge-status', 'Edge 测试音频已播放', 'ok');
    } catch (error) {
        setServiceStatus('has-edge-status', `Edge 测试失败：${error.message}`, 'bad');
        toastError(`Edge 测试失败: ${error.message}`);
    }
}

async function probeStageServerPlugin() {
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/probe', {
        method: 'POST',
        headers,
        body: '{}',
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    return response.json().catch(() => ({}));
}

function getMultiDeviceOriginAdvice(probeData = null) {
    const origin = window.location.origin;
    const host = window.location.hostname;
    const lanUrls = Array.isArray(probeData?.lanUrls) ? probeData.lanUrls.filter(Boolean) : [];
    const lanHint = lanUrls.length ? lanUrls.join('、') : '同一台酒馆的局域网地址';
    if (/^(127\.0\.0\.1|localhost|::1)$/i.test(host)) {
        return `访问地址：${origin}，电脑可用；手机请用 ${lanHint}`;
    }
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
        return `访问地址：${origin}，这是局域网地址，适合手机和电脑共用同一台酒馆服务器`;
    }
    return `访问地址：${origin}，请确认手机和电脑打开的是同一台 SillyTavern 服务器${lanUrls.length ? `；本机 LAN 地址：${lanUrls.join('、')}` : ''}`;
}

async function runMultiDeviceSelfCheck() {
    setServiceStatus('has-cache-status', '正在执行多端共享自检...', 'muted');
    const results = [];
    let probeData = null;

    try {
        probeData = await probeStageServerPlugin();
        results.push(getMultiDeviceOriginAdvice(probeData));
        results.push(`服务器插件：通过${probeData.defaultBat ? `，启动脚本 ${probeData.defaultBat}` : ''}`);
    } catch (error) {
        results.push(getMultiDeviceOriginAdvice());
        results.push(`服务器插件：失败（${error.message}）`);
    }

    try {
        const stats = await getSharedCacheStats();
        const limitMb = normalizeCacheLimitMb(getSettings().sharedAudioCacheMaxMb);
        results.push(`共享缓存：通过，${stats.count} 条，占用 ${formatMegabytes(stats.bytes)} / ${limitMb} MB`);
    } catch (error) {
        results.push(`共享缓存：失败（${error.message}）`);
    }

    try {
        const test = await selfTestSharedAudioCache();
        results.push(`缓存读写：通过，临时写读 ${test.testBytes || test.bytes || 0} 字节并已清理`);
    } catch (error) {
        results.push(`缓存读写：失败（${error.message}）`);
    }

    const indexOk = await checkIndexTtsApi({ silent: true });
    results.push(`IndexTTS2 代理：${indexOk ? '通过' : '未连接，请先启动 API'}`);

    const edgeOk = await checkEdgeTtsPlugin({ silent: true });
    results.push(`Edge TTS：${edgeOk ? '通过' : '未连接，旁白生成会失败'}`);

    const sharedSettingsOk = !!extension_settings?.[extensionName] && typeof saveSettingsDebounced === 'function';
    results.push(`共享设置：${sharedSettingsOk ? '通过' : '异常，设置可能无法跨设备保存'}`);

    const failed = results.some(text => /失败|未连接|异常/.test(text));
    setServiceStatus('has-cache-status', results.join('；'), failed ? 'bad' : 'ok');
    if (failed) toastWarn('多端共享自检发现需要处理的项目');
    else toastSuccess('多端共享自检通过');
    return !failed;
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractContentBlock(text) {
    const source = String(text || '');
    const match = source.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
    if (!match) return '';

    return normalizeWhitespace(match[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&'));
}

function getMessageId(msg) {
    if (!msg) return '';
    return msg.getAttribute('mesid')
        || msg.getAttribute('data-mesid')
        || msg.getAttribute('data-index')
        || msg.getAttribute('data-idx')
        || '';
}

function getRawMessageText(msg) {
    const context = getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const rawMesId = getMessageId(msg);
    if (rawMesId !== '') {
        const mesId = Number(rawMesId);
        if (Number.isInteger(mesId) && chat[mesId]) {
            return chat[mesId].mes || chat[mesId].message || '';
        }
    }
    const textEl = msg?.querySelector?.('.mes_text');
    return textEl?.innerText || msg?.innerText || '';
}

function getLastContentMessageText() {
    const context = getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const text = chat[i]?.mes || chat[i]?.message || '';
        if (/<content\b[^>]*>[\s\S]*?<\/content>/i.test(text)) return text;
    }
    return '';
}

function parseDialogueLine(line) {
    const trimmed = String(line || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return null;
    const match = trimmed.match(/^\[([^\]|\n]+)(?:\|([^\]\n]*))?\](?:\[([\d.,\s-]+)\])?\s*\|\s*([「“"](.*?)[」”"])\s*$/);
    if (!match) return null;

    const character = (match[1] || '').trim();
    const emotionLabel = (match[2] || '').trim();
    const emotion = match[3] ? match[3].replace(/\s/g, '') : null;
    const rawContent = (match[4] || '').trim();
    const text = (match[5] || '').trim();
    if (!character || !text) return null;
    return { character, emotionLabel, emotion, rawContent, text };
}

function splitNarrationText(text) {
    const normalized = normalizeWhitespace(text).replace(/[ \t]+/g, ' ');
    if (!normalized) return [];

    const chunks = [];
    for (const paragraph of normalized.split(/\n+/)) {
        let buffer = '';
        for (const char of paragraph.trim()) {
            buffer += char;
            if (/[。！？；!?;]/.test(char)) {
                chunks.push(buffer.trim());
                buffer = '';
            }
        }
        if (buffer.trim()) chunks.push(buffer.trim());
    }
    return chunks.filter(Boolean);
}

function collectSegmentsFromText(rawText) {
    const content = extractContentBlock(rawText);
    if (!content) return { hasContent: false, content: '', segments: [], cacheKey: '' };

    const settings = getSettings();
    const segments = [];
    let narration = [];

    const flushNarration = () => {
        const text = narration.join('\n');
        narration = [];
        for (const chunk of splitNarrationText(text)) {
            segments.push({
                engine: 'edge',
                type: 'narration',
                text: chunk,
                character: 'Narrator',
            });
        }
    };

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (narration.length && narration[narration.length - 1] !== '') narration.push('');
            continue;
        }

        const parsed = parseDialogueLine(trimmed);
        if (parsed) {
            flushNarration();
            segments.push({
                engine: 'index',
                type: 'dialogue',
                text: parsed.text,
                rawContent: parsed.rawContent,
                character: parsed.character,
                emotionLabel: parsed.emotionLabel,
                emotion: parsed.emotion,
                voice: settings.voiceMap[parsed.character] || '',
                originalLine: trimmed,
            });
        } else {
            narration.push(trimmed);
        }
    }
    flushNarration();

    const cacheKey = simpleStringHash(JSON.stringify({
        content,
        readNarration: settings.readNarration !== false,
        settings: {
            ttsApiUrl: settings.ttsApiUrl,
            ttsModel: settings.ttsModel,
            speed: settings.speed,
            volume: settings.volume,
            edgeVoice: settings.edgeVoice,
        },
        segments: segments.map(segment => ({
            engine: segment.engine,
            text: segment.text,
            character: segment.character,
            voice: segment.voice || '',
            emotion: segment.emotion || '',
        })),
    }));

    return { hasContent: true, content, segments, cacheKey };
}

function collectSegmentsFromMessage(msg) {
    return collectSegmentsFromText(getRawMessageText(msg));
}

function splitIntoSegments(content) {
    return splitNarrationText(content);
}

function splitTextIntoSubtitlePages(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return [];

    const maxChars = 46;
    const sentences = source.match(/[^。！？；!?;]+[。！？；!?;」』”’）)]*|[^。！？；!?;]+$/g) || [source];
    const pages = [];

    for (const rawSentence of sentences) {
        let sentence = rawSentence.trim();
        while (sentence.length > maxChars) {
            let splitAt = sentence.lastIndexOf('，', maxChars);
            if (splitAt < 16) splitAt = sentence.lastIndexOf(',', maxChars);
            if (splitAt < 16) splitAt = sentence.lastIndexOf('、', maxChars);
            if (splitAt < 16) splitAt = maxChars;
            pages.push(sentence.slice(0, splitAt + 1).trim());
            sentence = sentence.slice(splitAt + 1).trim();
        }
        if (sentence) pages.push(sentence);
    }

    return pages.filter(Boolean);
}

function setStageSegments(segments, meta = null, index = 0) {
    const normalizedMeta = Array.isArray(meta) ? meta : null;
    stageState.segments = segments.map(text => String(text || '').trim()).filter(Boolean);
    stageState.segmentMeta = normalizedMeta || stageState.segments.map((text, i) => ({ text, character: 'Narrator', index: i }));
    stageState.pagesBySegment = stageState.segments.map(splitTextIntoSubtitlePages);
    stageState.index = Math.max(0, Math.min(Number(index) || 0, stageState.segments.length - 1));
    stageState.pageIndex = 0;
    stageState.progress = 0;
    stageState.progressText = '';
}

function getCurrentPages() {
    return stageState.pagesBySegment[stageState.index]?.length
        ? stageState.pagesBySegment[stageState.index]
        : [stageState.segments[stageState.index] || ''];
}

function getCurrentSubtitleText() {
    const pages = getCurrentPages();
    return pages[Math.max(0, Math.min(stageState.pageIndex || 0, pages.length - 1))] || '';
}

function formatSpeakerName(segment) {
    const name = String(segment?.character || '').trim();
    if (!name || /^Narrator$/i.test(name)) return '旁白';
    return name;
}

function getCurrentPlaybackTitle() {
    const item = currentPlayback.playlist?.[currentPlayback.index] || stageState.segmentMeta?.[stageState.index] || null;
    const speaker = formatSpeakerName(item);
    const text = String(item?.text || getCurrentSubtitleText() || '').trim();
    return { speaker, text };
}

function getCacheSourceLabel(item = currentPlayback.playlist?.[currentPlayback.index]) {
    const source = String(item?.cacheSource || '').toLowerCase();
    if (source === 'server') return '服务器缓存';
    if (source === 'indexeddb') return '本机缓存';
    if (source === 'generated') return '新生成';
    return '';
}

function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(value / 60);
    const secs = value % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function setStageProgress(current = 0, duration = 0) {
    const safeCurrent = Math.max(0, Number(current) || 0);
    const safeDuration = Math.max(0, Number(duration) || 0);
    stageState.progress = safeDuration > 0 ? clamp(safeCurrent / safeDuration, 0, 1) : 0;
    stageState.progressText = safeDuration > 0 ? `${formatTime(safeCurrent)} / ${formatTime(safeDuration)}` : '';
    renderStage();
    renderAudioPlayer();
}

function ensureAudioPlayer() {
    let root = document.getElementById('has-audio-player');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'has-audio-player';
    root.className = 'has-player-window';
    root.innerHTML = `
        <div class="has-player-top">
            <div class="has-player-cover"><i class="fa-solid fa-headphones-simple"></i></div>
            <div class="has-player-info">
                <div class="has-player-charname" id="has-player-title">旁白</div>
                <div class="has-player-text"><span class="has-player-text-inner" id="has-player-text">准备播放...</span></div>
            </div>
            <div class="has-player-speed-area">
                <div class="has-player-speed-btn" id="has-player-speed" title="点击切换倍速">1.0x</div>
            </div>
            <div class="has-player-volume-area">
                <div class="has-player-volume-btn" id="has-player-volume" title="点击静音/恢复"><i class="fa-solid fa-volume-high"></i></div>
            </div>
            <div class="has-player-controls">
                <button class="has-player-ctrl-btn" id="has-player-prev" type="button" title="上一段"><i class="fa-solid fa-backward-step"></i></button>
                <button class="has-player-ctrl-btn has-player-play-btn" id="has-player-play" type="button" title="播放/暂停"><i class="fa-solid fa-play"></i></button>
                <button class="has-player-ctrl-btn" id="has-player-next" type="button" title="下一段"><i class="fa-solid fa-forward-step"></i></button>
            </div>
            <button id="has-player-close" class="has-player-close" type="button" title="停止"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="has-player-bottom">
            <input type="range" id="has-player-progress" class="has-player-progress" min="0" max="1000" value="0">
            <div class="has-player-time">
                <span id="has-player-time-current">0:00</span>
                <span id="has-player-time-left">-0:00</span>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    root.querySelector('#has-player-prev').addEventListener('click', () => currentPlayback.controller?.previous?.());
    root.querySelector('#has-player-play').addEventListener('click', togglePlayback);
    root.querySelector('#has-player-next').addEventListener('click', () => currentPlayback.controller?.next?.());
    root.querySelector('#has-player-close').addEventListener('click', stopCurrentPlayback);
    root.querySelector('#has-player-progress').addEventListener('input', event => currentPlayback.controller?.seek?.(Number(event.target.value) / 1000));
    root.querySelector('#has-player-speed').addEventListener('click', () => {
        const cycle = [0.5, 1, 1.25, 1.5, 2, 3];
        const current = Number(getSettings().speed || 1);
        const next = cycle.find(value => value > current + 0.01) || cycle[0];
        getSettings().speed = next;
        saveSettings();
        if (currentPlayback.audio) currentPlayback.audio.playbackRate = next;
        renderAudioPlayer();
        syncSettingsPanel();
    });
    root.querySelector('#has-player-volume').addEventListener('click', () => {
        const settings = getSettings();
        settings.volume = Number(settings.volume || 1) > 0 ? 0 : 1;
        saveSettings();
        if (currentPlayback.audio) currentPlayback.audio.volume = Math.min(1, Math.max(0, Number(settings.volume || 0)));
        renderAudioPlayer();
        syncSettingsPanel();
    });
    setupAudioPlayerDrag(root, root.querySelector('.has-player-top'));
    return root;
}

function openAudioPlayer() {
    const root = ensureAudioPlayer();
    root.classList.add('visible');
    renderAudioPlayer();
    return root;
}

function renderAudioPlayer() {
    const root = document.getElementById('has-audio-player');
    if (!root) return;
    const { speaker, text } = getCurrentPlaybackTitle();
    const title = root.querySelector('#has-player-title');
    const textEl = root.querySelector('#has-player-text');
    const play = root.querySelector('#has-player-play');
    const progress = root.querySelector('#has-player-progress');
    const timeCurrent = root.querySelector('#has-player-time-current');
    const timeLeft = root.querySelector('#has-player-time-left');
    const speed = root.querySelector('#has-player-speed');
    const volume = root.querySelector('#has-player-volume i');
    if (title) {
        const sourceLabel = getCacheSourceLabel();
        title.textContent = `${speaker} · ${currentPlayback.index + 1 || 0} / ${currentPlayback.playlist.length || stageState.segments.length || 0}${sourceLabel ? ` · ${sourceLabel}` : ''}`;
    }
    if (textEl) {
        textEl.textContent = text || '准备播放...';
        textEl.classList.remove('marquee');
        setTimeout(() => {
            const parent = textEl.parentElement;
            if (parent && textEl.scrollWidth > parent.clientWidth + 5) {
                textEl.textContent = `${text}     ${text}`;
                textEl.classList.add('marquee');
            }
        }, 30);
    }
    if (play) play.innerHTML = stageState.playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
    if (progress) progress.value = String(Math.round((stageState.progress || 0) * 1000));
    const activeAudio = currentPlayback.audio;
    const current = Number(activeAudio?.currentTime || 0);
    const duration = Number(activeAudio?.duration || currentPlayback.playlist?.[currentPlayback.index]?.duration || 0);
    if (timeCurrent) timeCurrent.textContent = formatTime(current);
    if (timeLeft) timeLeft.textContent = `-${formatTime(Math.max(0, duration - current))}`;
    if (speed) speed.textContent = `${Number(getSettings().speed || 1).toFixed(1)}x`;
    if (volume) {
        const vol = Number(getSettings().volume || 0);
        volume.className = vol === 0 ? 'fa-solid fa-volume-xmark' : (vol < 0.5 ? 'fa-solid fa-volume-low' : 'fa-solid fa-volume-high');
    }
}

function setupAudioPlayerDrag(root, handle) {
    if (!root || !handle || handle.dataset.ready === '1') return;
    handle.dataset.ready = '1';
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    handle.addEventListener('mousedown', event => {
        if (event.target.closest('button, input, .has-player-speed-area, .has-player-volume-area')) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        const rect = root.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        root.style.transform = 'none';
        root.style.left = `${startLeft}px`;
        root.style.top = `${startTop}px`;
        root.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', event => {
        if (!dragging) return;
        root.style.left = `${startLeft + event.clientX - startX}px`;
        root.style.top = `${startTop + event.clientY - startY}px`;
    });
    document.addEventListener('mouseup', () => {
        dragging = false;
    });
}

function simpleStringHash(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function openAudioDb() {
    if (audioDbPromise) return audioDbPromise;
    audioDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(audioDbName, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(audioStoreName)) {
                db.createObjectStore(audioStoreName, { keyPath: 'hash' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return audioDbPromise;
}

async function getCachedAudio(hash) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readonly');
        const req = tx.objectStore(audioStoreName).get(hash);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function saveCachedAudio(record) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readwrite');
        tx.objectStore(audioStoreName).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

function getAudioExtensionFromBlob(blob) {
    const type = String(blob?.type || '').toLowerCase();
    if (type.includes('webm')) return 'webm';
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    if (type.includes('ogg')) return 'ogg';
    return 'wav';
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function getServerCachedAudio(hash, fallbackMeta = {}) {
    if (getSettings().sharedAudioCacheEnabled === false) return null;
    try {
        const response = await fetch(`/api/plugins/hybrid-audiobook-stage/audio-cache/${encodeURIComponent(hash)}`, {
            method: 'GET',
            cache: 'no-store',
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return {
            ...fallbackMeta,
            hash,
            blob,
            blobUrl: URL.createObjectURL(blob),
            isCached: true,
            cacheSource: 'server',
        };
    } catch (error) {
        console.warn(`[${extensionName}] shared cache read failed`, error);
        return null;
    }
}

async function uploadServerCachedAudio(record) {
    const settings = getSettings();
    if (settings.sharedAudioCacheEnabled === false || !record?.hash || !record?.blob) return false;
    try {
        const data = await blobToBase64(record.blob);
        const headers = getRequestHeaders ? getRequestHeaders() : {};
        headers['Content-Type'] = 'application/json';
        const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                hash: record.hash,
                mime: record.blob.type || (record.engine === 'edge' ? 'audio/webm' : 'audio/wav'),
                ext: getAudioExtensionFromBlob(record.blob),
                data,
                maxCacheMb: normalizeCacheLimitMb(settings.sharedAudioCacheMaxMb),
                meta: {
                    engine: record.engine,
                    type: record.type,
                    character: record.character,
                    voice: record.voice,
                },
            }),
        });
        if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
        return true;
    } catch (error) {
        console.warn(`[${extensionName}] shared cache upload failed`, error);
        return false;
    }
}

async function getSharedCacheStats() {
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/stats', {
        method: 'POST',
        headers,
        body: '{}',
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    return response.json();
}

async function pruneSharedAudioCache() {
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/prune', {
        method: 'POST',
        headers,
        body: JSON.stringify({ maxCacheMb: normalizeCacheLimitMb(getSettings().sharedAudioCacheMaxMb) }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    return response.json();
}

async function selfTestSharedAudioCache() {
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/self-test', {
        method: 'POST',
        headers,
        body: '{}',
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    return response.json();
}

async function clearSharedAudioCache() {
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/clear', {
        method: 'POST',
        headers,
        body: '{}',
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    return response.json();
}

async function clearLocalAudioCache() {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readwrite');
        const req = tx.objectStore(audioStoreName).clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

async function fetchIndexTtsAudio(payload) {
    const settings = getSettings();
    if (settings.useServerIndexTtsProxy !== false) {
        try {
            const headers = getRequestHeaders ? getRequestHeaders() : {};
            headers['Content-Type'] = 'application/json';
            const response = await fetch('/api/plugins/hybrid-audiobook-stage/index-tts2/proxy', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    apiUrl: settings.ttsApiUrl,
                    payload,
                }),
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(`IndexTTS2 代理 HTTP ${response.status} ${errorText || response.statusText || ''}`.trim());
            }
            return response.blob();
        } catch (error) {
            console.warn(`[${extensionName}] IndexTTS2 proxy failed`, error);
            if (settings.useServerIndexTtsProxy === true) {
                throw error;
            }
        }
    }

    const response = await fetch(settings.ttsApiUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`IndexTTS2 HTTP ${response.status} ${errorText || response.statusText || ''}`.trim());
    }

    return response.blob();
}

async function ensureIndexAudio(segment) {
    const settings = getSettings();
    const voice = ensureWavSuffix(segment.voice || settings.defaultVoice);
    const speed = Number(settings.speed || 1) || 1;
    const volume = Number(settings.volume || 1) || 1;
    const hash = await sha256(JSON.stringify({
        engine: 'index',
        api: settings.ttsApiUrl,
        model: settings.ttsModel,
        text: segment.text,
        character: segment.character,
        voice,
        speed,
        volume,
        emotion: segment.emotion || '',
    }));
    const baseMeta = {
        engine: 'index',
        type: 'dialogue',
        text: segment.text,
        character: segment.character,
        voice,
        speed,
        volume,
        emotion: segment.emotion || '',
        timestamp: Date.now(),
    };

    const serverCached = await getServerCachedAudio(hash, baseMeta);
    if (serverCached?.blob) return serverCached;

    const cached = await getCachedAudio(hash).catch(() => null);
    if (cached?.blob) {
        uploadServerCachedAudio(cached).catch(error => console.warn(`[${extensionName}] cache promotion failed`, error));
        return {
            ...cached,
            blobUrl: URL.createObjectURL(cached.blob),
            isCached: true,
            cacheSource: 'indexeddb',
        };
    }

    const payload = {
        model: settings.ttsModel,
        input: segment.text,
        voice,
        response_format: 'wav',
        speed,
    };

    if (segment.emotion) {
        const emoVec = segment.emotion.split(',').map(value => Number.parseFloat(value.trim()));
        if (emoVec.length === 8 && emoVec.every(value => Number.isFinite(value))) {
            payload.emo_control_method = 2;
            payload.emo_vec = emoVec;
            payload.emo_weight = 0.6;
        }
    }

    const blob = await fetchIndexTtsAudio(payload);
    const record = {
        hash,
        ...baseMeta,
        blob,
        timestamp: Date.now(),
    };
    saveCachedAudio(record).catch(error => console.warn(`[${extensionName}] cache save failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared cache save failed`, error));
    return {
        ...record,
        blobUrl: URL.createObjectURL(blob),
        isCached: false,
        cacheSource: 'generated',
    };
}

async function ensureEdgeAudio(segment) {
    const settings = getSettings();
    const text = String(segment.text || '').trim();
    const voice = String(settings.edgeVoice || defaultSettings.edgeVoice).trim();
    const rate = 0;
    const hash = await sha256(JSON.stringify({
        engine: 'edge',
        text,
        voice,
        rate,
        volume: settings.volume,
    }));
    const baseMeta = {
        engine: 'edge',
        type: 'narration',
        text,
        character: 'Narrator',
        voice,
        rate,
        volume: settings.volume,
        timestamp: Date.now(),
    };

    const serverCached = await getServerCachedAudio(hash, baseMeta);
    if (serverCached?.blob) return serverCached;

    const cached = await getCachedAudio(hash).catch(() => null);
    if (cached?.blob) {
        uploadServerCachedAudio(cached).catch(error => console.warn(`[${extensionName}] edge cache promotion failed`, error));
        return {
            ...cached,
            blobUrl: URL.createObjectURL(cached.blob),
            isCached: true,
            cacheSource: 'indexeddb',
        };
    }

    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/edge-tts/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, voice, rate }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Edge TTS HTTP ${response.status} ${errorText || response.statusText || ''}`.trim());
    }

    const blob = await response.blob();
    const record = {
        hash,
        ...baseMeta,
        blob,
        timestamp: Date.now(),
    };
    saveCachedAudio(record).catch(error => console.warn(`[${extensionName}] cache save failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared edge cache save failed`, error));
    return {
        ...record,
        blobUrl: URL.createObjectURL(blob),
        isCached: false,
        cacheSource: 'generated',
    };
}

async function buildAudiobookQueue(msg, { dialogueOnly = false } = {}) {
    const settings = getSettings();
    const analysis = collectSegmentsFromMessage(msg);
    if (!analysis.hasContent) {
        toastInfo('未找到 <content> 正文块');
        return [];
    }

    const queue = [];
    const missingVoices = new Set();
    const segments = analysis.segments.filter(segment => {
        if (segment.engine === 'edge') return settings.readNarration !== false && !dialogueOnly;
        return true;
    });

    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        if (segment.engine === 'index' && !segment.voice) {
            missingVoices.add(segment.character || 'Unknown');
            continue;
        }

        try {
            const record = segment.engine === 'edge'
                ? await ensureEdgeAudio(segment)
                : await ensureIndexAudio(segment);
            queue.push({
                ...record,
                index: queue.length,
                sourceIndex: i,
                engine: segment.engine,
                type: segment.type,
                text: segment.text,
                character: segment.character,
                emotion: segment.emotion || '',
            });
        } catch (error) {
            console.error(`[${extensionName}] segment generation failed`, segment, error);
            toastError(`${segment.engine === 'edge' ? 'Edge' : 'IndexTTS2'} 片段生成失败: ${error.message}`);
        }
    }

    if (missingVoices.size) {
        toastWarn(`以下角色未配置音色，已跳过: ${Array.from(missingVoices).join('、')}`);
    }
    return queue;
}

function analyzeMessage(msg) {
    const settings = getSettings();
    const analysis = collectSegmentsFromMessage(msg);
    const dialogues = analysis.segments.filter(segment => segment.engine === 'index');
    const narration = analysis.segments.filter(segment => segment.engine === 'edge');
    const characters = Array.from(new Set(dialogues.map(segment => segment.character).filter(Boolean)));
    const missingVoices = Array.from(new Set(dialogues.filter(segment => !settings.voiceMap[segment.character]).map(segment => segment.character || 'Unknown')));
    return { ...analysis, dialogues, narration, characters, missingVoices };
}

function checkMessage(msg) {
    const analysis = analyzeMessage(msg);
    if (!analysis.hasContent) {
        toastInfo('未找到 <content> 正文块');
        return;
    }
    const message = `检测到 ${analysis.dialogues.length} 句台词、${analysis.narration.length} 段旁白、${analysis.characters.length} 个角色`
        + (analysis.missingVoices.length ? `；缺音色：${analysis.missingVoices.join('、')}` : '');
    if (analysis.missingVoices.length) toastWarn(message);
    else toastSuccess(message);
}

async function preGenerateDialogues(msg, button = null) {
    const analysis = analyzeMessage(msg);
    if (!analysis.hasContent) {
        toastInfo('未找到 <content> 正文块');
        return;
    }
    if (!analysis.dialogues.length) {
        toastWarn('未检测到已打标人物台词');
        return;
    }
    if (analysis.missingVoices.length) {
        toastWarn(`以下角色未配置音色：${analysis.missingVoices.join('、')}`);
        return;
    }

    button?.classList.add('has-busy');
    try {
        await buildAudiobookQueue(msg, { dialogueOnly: true });
        toastSuccess('人物台词预生成完成');
    } finally {
        button?.classList.remove('has-busy');
    }
}

async function playSingleDialogue(msg, dialogueIndex, button = null) {
    const analysis = analyzeMessage(msg);
    if (!analysis.hasContent) {
        toastInfo('未找到 <content> 正文块');
        return;
    }
    const dialogue = analysis.dialogues[Number(dialogueIndex)];
    if (!dialogue) {
        toastWarn('没有找到这句已打标台词');
        return;
    }
    if (!dialogue.voice) {
        toastWarn(`${dialogue.character || '该角色'} 未配置音色`);
        return;
    }

    button?.classList.add('has-busy');
    try {
        stopCurrentPlayback();
        toastInfo(`正在准备 ${dialogue.character} 的单句台词...`);
        const record = await ensureIndexAudio(dialogue);
        currentPlayback.playlist = [{
            ...record,
            index: 0,
            sourceIndex: Number(dialogueIndex),
            engine: 'index',
            type: 'dialogue',
            text: dialogue.text,
            character: dialogue.character,
            emotion: dialogue.emotion || '',
        }];
        currentPlayback.index = 0;
        currentPlayback.msg = msg;
        currentPlayback.sessionId = Date.now();

        setLinkedQueue({
            segments: [{
                text: dialogue.text,
                character: dialogue.character,
                engine: 'index',
                cacheSource: record.cacheSource || '',
                index: 0,
            }],
            index: 0,
            controller: {
                play: () => currentPlayback.audio?.play?.(),
                pause: () => currentPlayback.audio?.pause?.(),
                next: stopCurrentPlayback,
                previous: () => {},
                goTo: () => {},
                stop: stopCurrentPlayback,
            },
            mode: 'audiobook',
        });
        openStageFromCurrentChat({ mode: 'audiobook', forceInline: true, noAutoAdvance: true, keepLinked: true });

        const audio = new Audio(record.blobUrl);
        currentPlayback.audio = audio;
        audio.volume = Math.max(0, Math.min(1, Number(getSettings().volume || 1)));
        audio.playbackRate = Math.max(0.5, Math.min(2, Number(getSettings().speed || 1)));
        audio.addEventListener('loadedmetadata', () => setStageProgress(audio.currentTime, audio.duration));
        audio.addEventListener('timeupdate', () => setStageProgress(audio.currentTime, audio.duration));
        audio.addEventListener('play', () => setLinkedPlaybackState(true));
        audio.addEventListener('pause', () => setLinkedPlaybackState(false));
        audio.addEventListener('ended', () => {
            setStageProgress(audio.duration || 0, audio.duration || 0);
            setLinkedPlaybackState(false);
        }, { once: true });
        await audio.play();
    } catch (error) {
        console.error(`[${extensionName}] single dialogue play failed`, error);
        toastError(`单句播放失败: ${error.message}`);
    } finally {
        button?.classList.remove('has-busy');
    }
}

function loadAudioDuration(blobUrl) {
    return new Promise(resolve => {
        const audio = new Audio(blobUrl);
        audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
        audio.onerror = () => resolve(0);
        setTimeout(() => resolve(0), 1500);
    });
}

function stopCurrentPlayback() {
    if (currentPlayback.audio) {
        try {
            currentPlayback.audio.pause();
            currentPlayback.audio.src = '';
        } catch (error) {
            console.warn(`[${extensionName}] stop audio failed`, error);
        }
    }
    currentPlayback.audio = null;
    currentPlayback.controller = null;
    currentPlayback.playlist = [];
    currentPlayback.index = 0;
    currentPlayback.sessionId += 1;
    stageState.playing = false;
    stageState.linked = false;
    stageState.linkedController = null;
    stageState.progress = 0;
    stageState.progressText = '';
    document.getElementById('has-audio-player')?.classList.remove('visible');
    renderStage();
    renderAudioPlayer();
}

async function playAudiobookMessage(msg, button = null) {
    if (getSettings().ttsEnabled === false) {
        toastWarn('请先启用有声书 TTS');
        return;
    }

    button?.classList.add('has-busy');
    try {
        toastInfo('正在准备有声书播放队列...');
        const queue = await buildAudiobookQueue(msg);
        if (!queue.length) {
            toastWarn('没有可播放的有声书片段');
            return;
        }

        stopCurrentPlayback();
        const playlist = [];
        let totalDuration = 0;
        for (const item of queue) {
            const duration = await loadAudioDuration(item.blobUrl);
            playlist.push({
                ...item,
                index: playlist.length,
                duration,
                startOffset: totalDuration,
            });
            totalDuration += duration;
        }

        currentPlayback.playlist = playlist;
        currentPlayback.msg = msg;
        const sessionId = Date.now();
        currentPlayback.sessionId = sessionId;
        const audio = new Audio();
        currentPlayback.audio = audio;
        toastInfo(`有声书队列已准备：${playlist.length} 段`);

        const controller = {
            play: () => audio.play?.(),
            pause: () => currentPlayback.audio?.pause?.(),
            next: () => playTrack(Math.min(playlist.length - 1, currentPlayback.index + 1), 0),
            previous: () => playTrack(Math.max(0, currentPlayback.index - 1), 0),
            goTo: index => playTrack(Math.max(0, Math.min(playlist.length - 1, Number(index) || 0)), 0),
            seek: percent => {
                const safePercent = clamp(Number(percent) || 0, 0, 1);
                if (Number.isFinite(audio.duration) && audio.duration > 0) {
                    audio.currentTime = audio.duration * safePercent;
                }
            },
            stop: stopCurrentPlayback,
        };
        currentPlayback.controller = controller;
        const playbackUi = getSettings().audiobookPlaybackUi === 'player' ? 'player' : 'video';
        stageState.uiMode = playbackUi;

        setLinkedQueue({
            segments: playlist.map(item => ({
                text: item.text,
                character: item.character,
                engine: item.engine,
                cacheSource: item.cacheSource || '',
                index: item.index,
            })),
            index: 0,
            controller,
            mode: playbackUi === 'video' ? 'video' : 'audiobook',
            openStage: playbackUi === 'video',
        });
        if (playbackUi === 'video') {
            openStageFromCurrentChat({ mode: 'video', forceInline: true, noAutoAdvance: true, keepLinked: true });
            document.getElementById('has-audio-player')?.classList.remove('visible');
        } else {
            document.getElementById('has-stage')?.classList.remove('has-open');
            openAudioPlayer();
        }

        audio.addEventListener('play', () => setLinkedPlaybackState(true));
        audio.addEventListener('pause', () => setLinkedPlaybackState(false));
        audio.addEventListener('loadedmetadata', () => setStageProgress(audio.currentTime, audio.duration));
        audio.addEventListener('timeupdate', () => setStageProgress(audio.currentTime, audio.duration));
        audio.addEventListener('ended', () => {
            setStageProgress(audio.duration || 0, audio.duration || 0);
            setLinkedPlaybackState(false);
            playTrack(currentPlayback.index + 1, 0);
        });
        audio.addEventListener('error', () => {
            console.warn(`[${extensionName}] track audio error`, {
                index: currentPlayback.index,
                item: playlist[currentPlayback.index],
            });
            setLinkedPlaybackState(false);
            playTrack(currentPlayback.index + 1, 0);
        });

        function playTrack(index, seekTime = 0) {
            if (currentPlayback.sessionId !== sessionId) return;
            if (index >= playlist.length) {
                stopCurrentPlayback();
                return;
            }

            const item = playlist[index];
            currentPlayback.index = index;
            showLinkedSegment(index);
            setStageProgress(0, item.duration || 0);
            audio.volume = Math.max(0, Math.min(1, Number(getSettings().volume || 1)));
            audio.playbackRate = Math.max(0.5, Math.min(2, Number(getSettings().speed || 1)));
            if (audio.src !== item.blobUrl) {
                audio.src = item.blobUrl;
                audio.load();
            }
            const startPlayback = () => {
                if (currentPlayback.sessionId !== sessionId || currentPlayback.index !== index) return;
                if (seekTime > 0) {
                    try {
                        audio.currentTime = seekTime;
                    } catch (error) {
                        console.warn(`[${extensionName}] seek failed`, error);
                    }
                }
                audio.play().catch(error => {
                    console.warn(`[${extensionName}] playlist play blocked`, error);
                    setLinkedPlaybackState(false);
                    toastWarn('浏览器阻止了连续播放，请点字幕面板播放键继续');
                });
            };
            if (audio.readyState >= 1) startPlayback();
            else audio.addEventListener('loadedmetadata', startPlayback, { once: true });
            setTimeout(startPlayback, 250);
        }

        playTrack(0, 0);
    } catch (error) {
        console.error(`[${extensionName}] play failed`, error);
        toastError(`有声书播放失败: ${error.message}`);
    } finally {
        button?.classList.remove('has-busy');
    }
}

function ensureSettingsPanel() {
    if (document.getElementById('has-settings')) return;

    const container = document.createElement('div');
    container.id = 'has-settings';
    container.className = 'has-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎧 混合有声书舞台</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="has-section-title">有声书 TTS</div>
                <label class="checkbox_label"><input id="has-tts-enabled" type="checkbox"><span>启用有声书 TTS</span></label>
                <label class="checkbox_label"><input id="has-read-narration" type="checkbox"><span>用 Edge 朗读旁白</span></label>
                <label class="checkbox_label"><input id="has-shared-cache" type="checkbox"><span>启用服务器共享音频缓存</span></label>
                <label class="checkbox_label"><input id="has-index-proxy" type="checkbox"><span>通过酒馆服务器代理 IndexTTS2（手机推荐）</span></label>
                <label class="has-field">
                    <span>有声书播放界面</span>
                    <select id="has-playback-ui" class="text_pole">
                        <option value="player">纯播放器</option>
                        <option value="video">视频舞台</option>
                    </select>
                </label>
                <label class="has-field"><span>IndexTTS2 接口地址</span><input id="has-tts-url" class="text_pole" type="text"></label>
                <label class="has-field"><span>IndexTTS2 启动脚本</span><input id="has-index-start-bat" class="text_pole" type="text"></label>
                <div class="has-service-actions">
                    <button id="has-check-index" class="menu_button" type="button">检测 IndexTTS2</button>
                    <button id="has-start-index" class="menu_button" type="button">启动 API</button>
                </div>
                <div id="has-index-status" class="has-service-status has-muted">还未检测 IndexTTS2。</div>
                <label class="has-field"><span>IndexTTS2 模型名</span><input id="has-tts-model" class="text_pole" type="text"></label>
                <label class="has-field"><span>默认音色</span><input id="has-default-voice" class="text_pole" type="text" placeholder="default.wav"></label>
                <label class="has-field"><span>Edge 旁白音色</span><input id="has-edge-voice" class="text_pole" type="text" placeholder="zh-CN-XiaoxiaoNeural"></label>
                <div class="has-service-actions">
                    <button id="has-check-edge" class="menu_button" type="button">检测 Edge</button>
                    <button id="has-test-edge" class="menu_button" type="button">测试 Edge 朗读</button>
                </div>
                <div id="has-edge-status" class="has-service-status has-muted">还未检测 Edge TTS。</div>
                <label class="has-field"><span>共享缓存上限 MB</span><input id="has-shared-cache-max" class="text_pole" type="number" min="64" max="102400" step="64"></label>
                <div class="has-service-actions">
                    <button id="has-cache-stats" class="menu_button" type="button">缓存统计</button>
                    <button id="has-multidevice-check" class="menu_button" type="button">多端自检</button>
                    <button id="has-prune-shared-cache" class="menu_button" type="button">按上限清理</button>
                    <button id="has-clear-shared-cache" class="menu_button" type="button">清理共享缓存</button>
                </div>
                <div class="has-service-actions">
                    <button id="has-clear-local-cache" class="menu_button" type="button">清理本机缓存</button>
                    <button id="has-cache-help" class="menu_button" type="button">缓存说明</button>
                </div>
                <div id="has-cache-status" class="has-service-status has-muted">共享缓存用于 PC/手机复用同一台酒馆服务器上的音频。</div>
                <label class="has-field"><span>语速 <span id="has-speed-value"></span></span><input id="has-speed" type="range" min="0.5" max="2" step="0.1"></label>
                <label class="has-field"><span>音量 <span id="has-volume-value"></span></span><input id="has-volume" type="range" min="0" max="1" step="0.05"></label>
                <div class="has-section-title">角色音色</div>
                <div id="has-voice-map"></div>
                <div class="has-voice-add">
                    <input id="has-add-character" class="text_pole" type="text" placeholder="角色名">
                    <input id="has-add-voice" class="text_pole" type="text" placeholder="voice.wav">
                    <button id="has-add-voice-row" class="menu_button" type="button">添加</button>
                </div>

                <div class="has-section-title">视频字幕舞台</div>
                <label class="checkbox_label"><input id="has-enabled" type="checkbox"><span>启用字幕舞台</span></label>
                <label class="checkbox_label"><input id="has-auto" type="checkbox"><span>字幕自动播放</span></label>
                <label class="checkbox_label"><input id="has-window" type="checkbox"><span>视频舞台使用独立窗口</span></label>
                <label class="has-field"><span>视频地址</span><input id="has-video-url" class="text_pole" type="text" placeholder="/scripts/extensions/third-party/HybridAudiobookStage/assets/scene.mp4"></label>
                <label class="has-field">
                    <span>视频适配</span>
                    <select id="has-video-fit" class="text_pole">
                        <option value="contain">完整显示</option>
                        <option value="cover">铺满裁切</option>
                        <option value="fill">拉伸填满</option>
                    </select>
                </label>
                <label class="has-field"><span>每句字幕秒数</span><input id="has-seconds" class="text_pole" type="number" min="1" max="30" step="0.5"></label>
                <div class="has-open-actions">
                    <button id="has-open-audiobook" class="menu_button" type="button">听书面板</button>
                    <button id="has-open-stage" class="menu_button" type="button">视频舞台</button>
                    <button id="has-open-window" class="menu_button" type="button">独立窗口</button>
                </div>
                <small>纯有声书只读取第一段 &lt;content&gt; 正文；旁白走 Edge，已打标人物台词走 IndexTTS2。</small>
            </div>
        </div>
    `;

    document.querySelector('#extensions_settings')?.appendChild(container);
    syncSettingsPanel(container);
    bindSettingsPanel(container);
}

function syncSettingsPanel(container = document.getElementById('has-settings')) {
    if (!container) return;
    const settings = getSettings();
    container.querySelector('#has-tts-enabled').checked = settings.ttsEnabled !== false;
    container.querySelector('#has-read-narration').checked = settings.readNarration !== false;
    container.querySelector('#has-shared-cache').checked = settings.sharedAudioCacheEnabled !== false;
    container.querySelector('#has-index-proxy').checked = settings.useServerIndexTtsProxy !== false;
    container.querySelector('#has-playback-ui').value = settings.audiobookPlaybackUi || defaultSettings.audiobookPlaybackUi;
    container.querySelector('#has-tts-url').value = settings.ttsApiUrl || defaultSettings.ttsApiUrl;
    container.querySelector('#has-index-start-bat').value = settings.indexTtsStartBat || defaultSettings.indexTtsStartBat;
    container.querySelector('#has-tts-model').value = settings.ttsModel || defaultSettings.ttsModel;
    container.querySelector('#has-default-voice').value = settings.defaultVoice || defaultSettings.defaultVoice;
    container.querySelector('#has-edge-voice').value = settings.edgeVoice || defaultSettings.edgeVoice;
    container.querySelector('#has-shared-cache-max').value = String(normalizeCacheLimitMb(settings.sharedAudioCacheMaxMb));
    container.querySelector('#has-speed').value = String(settings.speed || 1);
    container.querySelector('#has-volume').value = String(settings.volume ?? 1);
    container.querySelector('#has-speed-value').textContent = `${Number(settings.speed || 1).toFixed(1)}x`;
    container.querySelector('#has-volume-value').textContent = Number(settings.volume ?? 1).toFixed(2);
    container.querySelector('#has-enabled').checked = !!settings.enabled;
    container.querySelector('#has-auto').checked = !!settings.autoAdvance;
    container.querySelector('#has-window').checked = !!settings.openInWindow;
    container.querySelector('#has-video-url').value = settings.videoUrl || defaultSettings.videoUrl;
    container.querySelector('#has-video-fit').value = settings.videoFit || defaultSettings.videoFit;
    container.querySelector('#has-seconds').value = String(settings.secondsPerSubtitle || defaultSettings.secondsPerSubtitle);
    renderVoiceMap(container);
}

function renderVoiceMap(container = document.getElementById('has-settings')) {
    const root = container?.querySelector('#has-voice-map');
    if (!root) return;
    const settings = getSettings();
    const entries = Object.entries(settings.voiceMap || {}).sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'));
    root.innerHTML = entries.length ? '' : '<div class="has-empty">还没有配置角色音色。</div>';
    for (const [character, voice] of entries) {
        const row = document.createElement('div');
        row.className = 'has-voice-row';
        row.innerHTML = `
            <input class="text_pole has-character" type="text">
            <input class="text_pole has-voice" type="text">
            <button class="menu_button has-delete-voice" type="button">删除</button>
        `;
        row.querySelector('.has-character').value = character;
        row.querySelector('.has-voice').value = voice;
        row.querySelector('.has-character').addEventListener('change', event => {
            const nextCharacter = event.target.value.trim();
            if (!nextCharacter || nextCharacter === character) return;
            settings.voiceMap[nextCharacter] = settings.voiceMap[character];
            delete settings.voiceMap[character];
            saveSettings();
            renderVoiceMap(container);
            refreshMessageButtons();
        });
        row.querySelector('.has-voice').addEventListener('change', event => {
            settings.voiceMap[character] = ensureWavSuffix(event.target.value);
            saveSettings();
            refreshMessageButtons();
        });
        row.querySelector('.has-delete-voice').addEventListener('click', () => {
            delete settings.voiceMap[character];
            saveSettings();
            renderVoiceMap(container);
            refreshMessageButtons();
        });
        root.appendChild(row);
    }
}

function bindSettingsPanel(container) {
    const settings = getSettings();
    const bindCheckbox = (selector, key, after = null) => {
        container.querySelector(selector)?.addEventListener('change', event => {
            settings[key] = event.target.checked;
            saveSettings();
            after?.();
        });
    };
    const bindInput = (selector, key, normalize = value => value) => {
        container.querySelector(selector)?.addEventListener('change', event => {
            settings[key] = normalize(event.target.value);
            saveSettings();
        });
    };

    bindCheckbox('#has-tts-enabled', 'ttsEnabled');
    bindCheckbox('#has-read-narration', 'readNarration');
    bindCheckbox('#has-shared-cache', 'sharedAudioCacheEnabled');
    bindCheckbox('#has-index-proxy', 'useServerIndexTtsProxy');
    bindInput('#has-playback-ui', 'audiobookPlaybackUi', value => value === 'player' ? 'player' : 'video');
    bindInput('#has-tts-url', 'ttsApiUrl', value => value.trim() || defaultSettings.ttsApiUrl);
    bindInput('#has-index-start-bat', 'indexTtsStartBat', value => value.trim() || defaultSettings.indexTtsStartBat);
    bindInput('#has-tts-model', 'ttsModel', value => value.trim() || defaultSettings.ttsModel);
    bindInput('#has-default-voice', 'defaultVoice', ensureWavSuffix);
    bindInput('#has-edge-voice', 'edgeVoice', value => value.trim() || defaultSettings.edgeVoice);
    bindInput('#has-shared-cache-max', 'sharedAudioCacheMaxMb', normalizeCacheLimitMb);
    container.querySelector('#has-speed')?.addEventListener('input', event => {
        settings.speed = Number(event.target.value) || 1;
        container.querySelector('#has-speed-value').textContent = `${settings.speed.toFixed(1)}x`;
        saveSettings();
    });
    container.querySelector('#has-volume')?.addEventListener('input', event => {
        settings.volume = Number(event.target.value);
        container.querySelector('#has-volume-value').textContent = settings.volume.toFixed(2);
        saveSettings();
    });

    container.querySelector('#has-add-voice-row')?.addEventListener('click', () => {
        const characterInput = container.querySelector('#has-add-character');
        const voiceInput = container.querySelector('#has-add-voice');
        const character = characterInput.value.trim();
        const voice = ensureWavSuffix(voiceInput.value);
        if (!character) {
            toastWarn('请先填写角色名');
            return;
        }
        settings.voiceMap[character] = voice;
        characterInput.value = '';
        voiceInput.value = '';
        saveSettings();
        renderVoiceMap(container);
        refreshMessageButtons();
    });

    bindCheckbox('#has-enabled', 'enabled', ensureLauncher);
    bindCheckbox('#has-auto', 'autoAdvance');
    bindCheckbox('#has-window', 'openInWindow');
    bindInput('#has-video-url', 'videoUrl', value => value.trim());
    bindInput('#has-video-fit', 'videoFit', value => value);
    container.querySelector('#has-video-fit')?.addEventListener('change', applyVideoFit);
    container.querySelector('#has-seconds')?.addEventListener('input', event => {
        settings.secondsPerSubtitle = Math.max(1, Number(event.target.value) || defaultSettings.secondsPerSubtitle);
        saveSettings();
    });
    container.querySelector('#has-open-audiobook')?.addEventListener('click', () => openStageFromCurrentChat({ mode: 'audiobook', forceInline: true }));
    container.querySelector('#has-open-stage')?.addEventListener('click', () => openStageFromCurrentChat({ mode: 'video', forceInline: true }));
    container.querySelector('#has-open-window')?.addEventListener('click', () => openStageFromCurrentChat({ mode: 'video', forceWindow: true }));
    container.querySelector('#has-check-index')?.addEventListener('click', () => checkIndexTtsApi());
    container.querySelector('#has-start-index')?.addEventListener('click', () => startIndexTtsApi());
    container.querySelector('#has-check-edge')?.addEventListener('click', () => checkEdgeTtsPlugin());
    container.querySelector('#has-test-edge')?.addEventListener('click', () => testEdgeTtsAudio());
    container.querySelector('#has-multidevice-check')?.addEventListener('click', () => runMultiDeviceSelfCheck());
    container.querySelector('#has-cache-stats')?.addEventListener('click', async () => {
        try {
            setServiceStatus('has-cache-status', '正在读取共享缓存统计...', 'muted');
            const stats = await getSharedCacheStats();
            const limitMb = normalizeCacheLimitMb(settings.sharedAudioCacheMaxMb);
            setServiceStatus('has-cache-status', `共享缓存：${stats.count} 条，占用 ${formatMegabytes(stats.bytes)}，上限 ${limitMb} MB`, 'ok');
        } catch (error) {
            setServiceStatus('has-cache-status', `共享缓存不可用：${error.message}`, 'bad');
        }
    });
    container.querySelector('#has-prune-shared-cache')?.addEventListener('click', async () => {
        try {
            const limitMb = normalizeCacheLimitMb(settings.sharedAudioCacheMaxMb);
            setServiceStatus('has-cache-status', `正在按 ${limitMb} MB 上限清理共享缓存...`, 'muted');
            const result = await pruneSharedAudioCache();
            setServiceStatus('has-cache-status', `已按上限清理：删除 ${result.removedCount || 0} 条，释放 ${formatMegabytes(result.removedBytes)}；当前 ${result.count || 0} 条，占用 ${formatMegabytes(result.bytes)}`, 'ok');
        } catch (error) {
            setServiceStatus('has-cache-status', `按上限清理失败：${error.message}`, 'bad');
        }
    });
    container.querySelector('#has-clear-shared-cache')?.addEventListener('click', async () => {
        if (!confirm('确定清理服务器共享音频缓存吗？手机和其他浏览器会失去这些缓存。')) return;
        try {
            const result = await clearSharedAudioCache();
            setServiceStatus('has-cache-status', `已清理共享缓存：${result.count} 条`, 'ok');
        } catch (error) {
            setServiceStatus('has-cache-status', `清理共享缓存失败：${error.message}`, 'bad');
        }
    });
    container.querySelector('#has-clear-local-cache')?.addEventListener('click', async () => {
        if (!confirm('确定清理当前浏览器的本机音频缓存吗？服务器共享缓存不会被删除。')) return;
        try {
            await clearLocalAudioCache();
            setServiceStatus('has-cache-status', '已清理当前浏览器 IndexedDB 音频缓存', 'ok');
        } catch (error) {
            setServiceStatus('has-cache-status', `清理本机缓存失败：${error.message}`, 'bad');
        }
    });
    container.querySelector('#has-cache-help')?.addEventListener('click', () => {
        setServiceStatus('has-cache-status', '共享缓存存在酒馆服务器，PC 生成后手机可复用；达到上限时会优先删除最久没播放的旧音频。本机缓存只存在当前浏览器和当前访问地址。', 'muted');
    });
}

function ensureLauncher() {
    const settings = getSettings();
    let launcher = document.getElementById('has-launcher');
    if (!settings.enabled) {
        launcher?.remove();
        return;
    }
    if (launcher) return;

    launcher = document.createElement('button');
    launcher.id = 'has-launcher';
    launcher.type = 'button';
    launcher.title = '混合有声书舞台';
    launcher.textContent = '字';
    launcher.addEventListener('click', () => openStageFromCurrentChat({ mode: 'audiobook', forceInline: true }));
    document.body.appendChild(launcher);
}

function fitInlineStageToVideo(video) {
    const root = document.getElementById('has-stage');
    if (!root) return;
    if (applySavedInlineRect(root)) return;
    const viewportWidth = Math.max(320, window.innerWidth);
    const viewportHeight = Math.max(240, window.innerHeight);
    const naturalWidth = video?.videoWidth || 960;
    const naturalHeight = video?.videoHeight || 540;
    const maxWidth = Math.min(560, viewportWidth - 28);
    const maxHeight = Math.min(360, viewportHeight - 168);
    const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
    root.style.width = `${Math.round(naturalWidth * scale)}px`;
    root.style.height = `${Math.round(naturalHeight * scale)}px`;
}

function applySavedInlineRect(root) {
    const rect = getSettings().inlineRect;
    if (!root || !rect || typeof rect !== 'object') return false;
    const width = clamp(Number(rect.width) || 420, 280, window.innerWidth - 16);
    const height = clamp(Number(rect.height) || 236, 158, window.innerHeight - 16);
    const left = clamp(Number(rect.left) || 8, 8, window.innerWidth - width - 8);
    const top = clamp(Number(rect.top) || 8, 8, window.innerHeight - height - 8);
    root.style.width = `${Math.round(width)}px`;
    root.style.height = `${Math.round(height)}px`;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    return true;
}

function saveInlineRect(root) {
    if (!root) return;
    const rect = root.getBoundingClientRect();
    getSettings().inlineRect = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    saveSettings();
}

function ensureStage() {
    let root = document.getElementById('has-stage');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'has-stage';
    root.innerHTML = `
        <div id="has-drag-handle" title="Drag"></div>
        <video id="has-stage-video" autoplay loop muted playsinline></video>
        <div id="has-stage-shade"></div>
        <button id="has-pip" type="button" title="Picture in picture">外</button>
        <button id="has-close" type="button" title="Close">×</button>
        <div id="has-counter"></div>
        <div id="has-subtitle-box" role="button" tabindex="0">
            <div id="has-speaker-name"></div>
            <div id="has-subtitle"></div>
        </div>
        <button id="has-prev" class="has-vn-control" type="button" title="Previous">‹</button>
        <button id="has-play" class="has-vn-control" type="button" title="Play/Pause">▶</button>
        <div class="has-resize-handle has-resize-nw" data-corner="nw" title="Resize"></div>
        <div class="has-resize-handle has-resize-ne" data-corner="ne" title="Resize"></div>
        <div class="has-resize-handle has-resize-sw" data-corner="sw" title="Resize"></div>
        <div class="has-resize-handle has-resize-se" data-corner="se" title="Resize"></div>
    `;
    document.body.appendChild(root);

    const video = root.querySelector('#has-stage-video');
    video.addEventListener('loadedmetadata', () => fitInlineStageToVideo(video));
    video.addEventListener('click', nextSegment);
    root.querySelector('#has-pip').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openDocumentPictureInPictureStage();
    });
    root.querySelector('#has-close').addEventListener('click', closeStage);
    root.querySelector('#has-prev').addEventListener('click', previousSegment);
    root.querySelector('#has-play').addEventListener('click', togglePlayback);
    root.querySelector('#has-subtitle-box').addEventListener('click', nextSegment);
    root.querySelectorAll('.has-resize-handle').forEach(handle => setupInlineResize(root, handle, handle.dataset.corner || 'se'));
    setupInlineDrag(root, root.querySelector('#has-drag-handle'));
    root.addEventListener('click', event => {
        if (event.target === root || event.target.id === 'has-stage-shade') nextSegment();
    });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeStage();
        if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') {
            event.preventDefault();
            nextSegment();
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            previousSegment();
        }
    });
    window.addEventListener('resize', () => fitInlineStageToVideo(video));
    return root;
}

function applyVideoFit() {
    const root = document.getElementById('has-stage');
    if (!root) return;
    const fit = getSettings().videoFit || defaultSettings.videoFit;
    root.classList.toggle('has-video-cover', fit === 'cover');
    root.classList.toggle('has-video-fill', fit === 'fill');
    root.classList.toggle('has-video-contain', fit !== 'cover' && fit !== 'fill');
}

function applyStageMode(mode) {
    const root = ensureStage();
    stageState.mode = mode || 'video';
    root.classList.toggle('has-audiobook-mode', stageState.mode === 'audiobook');
    root.classList.toggle('has-video-mode', stageState.mode !== 'audiobook');
    return root;
}

function setupInlineResize(root, handle, corner = 'se') {
    if (!root || !handle || handle.dataset.ready === '1') return;
    handle.dataset.ready = '1';
    const startResize = event => {
        event.preventDefault();
        event.stopPropagation();
        const point = getPointerPoint(event);
        const rect = root.getBoundingClientRect();
        const startX = point.x;
        const startY = point.y;
        const startLeft = rect.left;
        const startTop = rect.top;
        const startWidth = rect.width;
        const startHeight = rect.height;
        const aspect = startWidth / Math.max(1, startHeight);
        const fromWest = corner.includes('w');
        const fromNorth = corner.includes('n');

        const move = moveEvent => {
            moveEvent.preventDefault?.();
            const movePoint = getPointerPoint(moveEvent);
            const maxWidth = Math.max(320, window.innerWidth - 28);
            const maxHeight = Math.max(180, window.innerHeight - 28);
            const dx = movePoint.x - startX;
            const dy = movePoint.y - startY;
            let nextWidth = Math.min(maxWidth, Math.max(300, startWidth + (fromWest ? -dx : dx)));
            let nextHeight = Math.min(maxHeight, Math.max(170, startHeight + (fromNorth ? -dy : dy)));
            if (moveEvent.shiftKey) nextHeight = nextWidth / aspect;
            let nextLeft = fromWest ? startLeft + startWidth - nextWidth : startLeft;
            let nextTop = fromNorth ? startTop + startHeight - nextHeight : startTop;
            nextLeft = clamp(nextLeft, 8, window.innerWidth - nextWidth - 8);
            nextTop = clamp(nextTop, 8, window.innerHeight - nextHeight - 8);
            root.style.left = `${Math.round(nextLeft)}px`;
            root.style.top = `${Math.round(nextTop)}px`;
            root.style.right = 'auto';
            root.style.bottom = 'auto';
            root.style.width = `${Math.round(nextWidth)}px`;
            root.style.height = `${Math.round(nextHeight)}px`;
        };

        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('touchmove', move);
            window.removeEventListener('touchend', up);
            window.removeEventListener('touchcancel', up);
            saveInlineRect(root);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up, { once: true });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', up, { once: true });
        window.addEventListener('touchcancel', up, { once: true });
    };
    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResize, { passive: false });
}

function setupInlineDrag(root, handle) {
    if (!root || !handle || handle.dataset.ready === '1') return;
    handle.dataset.ready = '1';
    const startDrag = event => {
        event.preventDefault();
        event.stopPropagation();
        const point = getPointerPoint(event);
        const rect = root.getBoundingClientRect();
        const startX = point.x;
        const startY = point.y;
        const startLeft = rect.left;
        const startTop = rect.top;
        const move = moveEvent => {
            moveEvent.preventDefault?.();
            const movePoint = getPointerPoint(moveEvent);
            const nextLeft = clamp(startLeft + movePoint.x - startX, 8, window.innerWidth - rect.width - 8);
            const nextTop = clamp(startTop + movePoint.y - startY, 8, window.innerHeight - rect.height - 8);
            root.style.left = `${Math.round(nextLeft)}px`;
            root.style.top = `${Math.round(nextTop)}px`;
            root.style.right = 'auto';
            root.style.bottom = 'auto';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('touchmove', move);
            window.removeEventListener('touchend', up);
            window.removeEventListener('touchcancel', up);
            saveInlineRect(root);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up, { once: true });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', up, { once: true });
        window.addEventListener('touchcancel', up, { once: true });
    };
    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: false });
}

function getPointerPoint(event) {
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    return {
        x: touch ? touch.clientX : event.clientX,
        y: touch ? touch.clientY : event.clientY,
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function renderStage() {
    const root = ensureStage();
    const subtitle = root.querySelector('#has-subtitle');
    const speaker = root.querySelector('#has-speaker-name');
    const counter = root.querySelector('#has-counter');
    const playButton = root.querySelector('#has-play');
    const currentSegment = stageState.segmentMeta?.[stageState.index] || null;
    const pages = getCurrentPages();
    stageState.pageIndex = Math.max(0, Math.min(stageState.pageIndex || 0, pages.length - 1));
    subtitle.textContent = getCurrentSubtitleText();
    speaker.textContent = formatSpeakerName(currentSegment);
    const sourceLabel = getCacheSourceLabel(currentPlayback.playlist?.[stageState.index] || currentSegment);
    counter.textContent = stageState.segments.length
        ? `${stageState.index + 1} / ${stageState.segments.length}${pages.length > 1 ? ` · ${stageState.pageIndex + 1} / ${pages.length}` : ''}${sourceLabel ? ` · ${sourceLabel}` : ''}`
        : '0 / 0';
    playButton.textContent = stageState.playing ? 'Ⅱ' : '▶';
    renderPipStage();
    renderAudioPlayer();
}

function openInlineStageShell({ mode = 'video' } = {}) {
    const root = applyStageMode(mode);
    const video = root.querySelector('#has-stage-video');
    if (mode !== 'audiobook') {
        const videoUrl = getSettings().videoUrl || defaultSettings.videoUrl;
        if (video.getAttribute('src') !== videoUrl) {
            video.setAttribute('src', videoUrl);
            video.load();
        }
        video.play?.().catch(() => {});
    }
    fitInlineStageToVideo(video);
    root.classList.add('has-open');
    applyVideoFit();
    return root;
}

function normalizeLinkedSegments(segments) {
    if (!Array.isArray(segments)) return [];
    return segments
        .map((segment, index) => typeof segment === 'string' ? { text: segment, index } : {
            ...segment,
            text: String(segment?.text || ''),
            index: typeof segment?.index === 'number' ? segment.index : index,
        })
        .filter(segment => segment.text.trim());
}

function setLinkedQueue({ segments, index = 0, controller = null, mode = 'video', openStage = true } = {}) {
    const normalized = normalizeLinkedSegments(segments);
    if (!normalized.length) return false;
    clearTimeout(stageState.timer);
    setStageSegments(normalized.map(segment => segment.text), normalized, index);
    stageState.playing = false;
    stageState.linked = true;
    stageState.linkedController = controller || null;
    stageState.progress = 0;
    stageState.progressText = '';
    if (openStage) openInlineStageShell({ mode });
    renderStage();
    return true;
}

function showLinkedSegment(index) {
    if (!stageState.linked || !stageState.segments.length) return false;
    stageState.index = Math.max(0, Math.min(Number(index) || 0, stageState.segments.length - 1));
    stageState.pageIndex = 0;
    stageState.progress = 0;
    stageState.progressText = '';
    if (stageState.uiMode !== 'player') openInlineStageShell({ mode: stageState.mode });
    renderStage();
    renderAudioPlayer();
    return true;
}

function setLinkedPlaybackState(isPlaying) {
    if (!stageState.linked) return false;
    stageState.playing = !!isPlaying;
    clearTimeout(stageState.timer);
    renderStage();
    return true;
}

function clearLinkedQueue() {
    if (!stageState.linked) return;
    stageState.linked = false;
    stageState.linkedController = null;
    stageState.playing = false;
    stageState.progress = 0;
    stageState.progressText = '';
    clearTimeout(stageState.timer);
    renderStage();
}

function renderPipStage() {
    if (!pipState?.document || pipState.window?.closed) return;
    const doc = pipState.document;
    const subtitle = doc.getElementById('has-pip-subtitle');
    const speaker = doc.getElementById('has-pip-speaker-name');
    const counter = doc.getElementById('has-pip-counter');
    const playButton = doc.getElementById('has-pip-play');
    const currentSegment = stageState.segmentMeta?.[stageState.index] || null;
    const pages = getCurrentPages();
    if (subtitle) subtitle.textContent = getCurrentSubtitleText();
    if (speaker) speaker.textContent = formatSpeakerName(currentSegment);
    if (counter) counter.textContent = stageState.segments.length
        ? `${stageState.index + 1} / ${stageState.segments.length}${pages.length > 1 ? ` · ${stageState.pageIndex + 1} / ${pages.length}` : ''}`
        : '0 / 0';
    if (playButton) playButton.textContent = stageState.playing ? 'Ⅱ' : '▶';
}

async function openDocumentPictureInPictureStage() {
    if (!('documentPictureInPicture' in window)) {
        toastWarn('当前浏览器不支持外置置顶字幕窗口');
        return;
    }
    const root = ensureStage();
    try {
        const pipWindow = await window.documentPictureInPicture.requestWindow({
            width: Math.min(560, Math.max(360, Math.round(root.getBoundingClientRect().width || 480))),
            height: Math.min(360, Math.max(220, Math.round(root.getBoundingClientRect().height || 270))),
        });
        const doc = pipWindow.document;
        doc.title = '混合有声书舞台';
        doc.body.innerHTML = `
            <style>
                html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #050505; color: #fff; font-family: "Microsoft YaHei", system-ui, sans-serif; }
                #has-pip-root { position: fixed; inset: 0; overflow: hidden; background: #050505; }
                #has-pip-counter { position: absolute; top: 10px; left: 10px; min-width: 48px; padding: 4px 8px; border-radius: 999px; background: rgba(0,0,0,0.34); font-size: 12px; text-align: center; }
                #has-pip-subtitle-box { position: absolute; left: 6%; right: 6%; bottom: 8%; max-height: 30%; display: flex; flex-direction: column; padding: 22px 18px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.22); background: linear-gradient(115deg, rgba(12,12,14,0.68), rgba(12,12,14,0.46)); cursor: pointer; box-sizing: border-box; box-shadow: 0 8px 24px rgba(0,0,0,0.28); }
                #has-pip-speaker-name { position: absolute; top: 5px; left: 14px; font-size: 11px; color: rgba(255,255,255,0.88); font-weight: 700; }
                #has-pip-subtitle { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: clamp(16px, 4.7vw, 25px); line-height: 1.42; color: rgba(255,255,255,0.94); text-shadow: 0 1px 2px rgba(0,0,0,0.78); word-break: break-word; }
                .has-pip-vn-control { position: absolute; width: 24px; height: 24px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.36); background: rgba(0,0,0,0.24); color: #fff; font-size: 15px; cursor: pointer; }
                #has-pip-prev { left: 7%; bottom: 3.5%; }
                #has-pip-play { right: 7%; bottom: 3.5%; }
            </style>
            <main id="has-pip-root">
                <div id="has-pip-counter"></div>
                <div id="has-pip-subtitle-box"><div id="has-pip-speaker-name"></div><div id="has-pip-subtitle"></div></div>
                <button id="has-pip-prev" class="has-pip-vn-control" type="button">‹</button>
                <button id="has-pip-play" class="has-pip-vn-control" type="button">▶</button>
            </main>
        `;
        doc.getElementById('has-pip-prev').addEventListener('click', previousSegment);
        doc.getElementById('has-pip-play').addEventListener('click', togglePlayback);
        doc.getElementById('has-pip-subtitle-box').addEventListener('click', nextSegment);
        pipWindow.addEventListener('pagehide', () => {
            pipState = null;
        });
        pipState = { window: pipWindow, document: doc };
        renderPipStage();
    } catch (error) {
        console.warn(`[${extensionName}] PiP failed`, error);
        toastWarn('外置字幕窗口打开失败');
    }
}

function scheduleNext() {
    clearTimeout(stageState.timer);
    if (stageState.linked || !stageState.playing) return;
    const seconds = Math.max(1, Number(getSettings().secondsPerSubtitle) || defaultSettings.secondsPerSubtitle);
    stageState.timer = setTimeout(() => {
        const pages = getCurrentPages();
        if (stageState.pageIndex < pages.length - 1) {
            stageState.pageIndex += 1;
            renderStage();
            scheduleNext();
            return;
        }
        if (stageState.index >= stageState.segments.length - 1) {
            stageState.playing = false;
            renderStage();
            return;
        }
        stageState.index += 1;
        stageState.pageIndex = 0;
        renderStage();
        scheduleNext();
    }, seconds * 1000);
}

function startPlayback() {
    if (stageState.linked) {
        stageState.linkedController?.play?.();
        return;
    }
    stageState.playing = true;
    renderStage();
    scheduleNext();
}

function pausePlayback() {
    if (stageState.linked) {
        stageState.linkedController?.pause?.();
        return;
    }
    stageState.playing = false;
    clearTimeout(stageState.timer);
    renderStage();
}

function togglePlayback() {
    if (stageState.playing) pausePlayback();
    else startPlayback();
}

function nextSegment() {
    if (!stageState.segments.length) return;
    const pages = getCurrentPages();
    if (stageState.pageIndex < pages.length - 1) {
        stageState.pageIndex += 1;
        renderStage();
        return;
    }
    if (stageState.linked && stageState.linkedController?.next) {
        stageState.linkedController.next();
        return;
    }
    stageState.index = Math.min(stageState.index + 1, stageState.segments.length - 1);
    stageState.pageIndex = 0;
    renderStage();
    if (stageState.playing) scheduleNext();
}

function previousSegment() {
    if (!stageState.segments.length) return;
    if (stageState.pageIndex > 0) {
        stageState.pageIndex -= 1;
        renderStage();
        return;
    }
    if (stageState.linked && stageState.linkedController?.previous) {
        stageState.linkedController.previous();
        return;
    }
    stageState.index = Math.max(stageState.index - 1, 0);
    stageState.pageIndex = 0;
    renderStage();
    if (stageState.playing) scheduleNext();
}

function closeStage() {
    pausePlayback();
    document.getElementById('has-stage')?.classList.remove('has-open');
}

function buildStagePayload() {
    const settings = getSettings();
    const content = extractContentBlock(getLastContentMessageText());
    if (!content) {
        toastWarn('未找到 <content> 正文块');
        return null;
    }
    const segments = splitIntoSegments(content);
    if (!segments.length) {
        toastWarn('<content> 正文没有可显示的字幕');
        return null;
    }
    return {
        createdAt: Date.now(),
        segments,
        videoUrl: settings.videoUrl || defaultSettings.videoUrl,
        videoFit: settings.videoFit || defaultSettings.videoFit,
        autoAdvance: !!settings.autoAdvance,
        secondsPerSubtitle: Math.max(1, Number(settings.secondsPerSubtitle) || defaultSettings.secondsPerSubtitle),
    };
}

function openStageWindow(payload) {
    const stateKey = `has-stage-${Date.now()}`;
    localStorage.setItem(stateKey, JSON.stringify(payload));
    const url = `/scripts/extensions/third-party/HybridAudiobookStage/stage.html?state=${encodeURIComponent(stateKey)}`;
    const features = 'popup=yes,width=960,height=540,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes';
    const child = window.open(url, 'HybridAudiobookStageWindow', features);
    if (!child) {
        toastWarn('弹窗被浏览器拦截了');
        return false;
    }
    child.focus?.();
    return true;
}

function openStageFromCurrentChat(options = {}) {
    if (options.keepLinked && stageState.linked && stageState.segments.length) {
        openInlineStageShell({ mode: options.mode || stageState.mode || 'audiobook' });
        stageState.playing = false;
        renderStage();
        return;
    }

    if (options.mode === 'audiobook') {
        const root = openInlineStageShell({ mode: 'audiobook' });
        if (!stageState.segments.length) {
            setStageSegments(['点击楼层的播放按钮开始纯有声书朗读。'], [{ text: '点击楼层的播放按钮开始纯有声书朗读。', character: 'Narrator', index: 0 }], 0);
        }
        root.focus();
        renderStage();
        return;
    }

    const settings = getSettings();
    const payload = buildStagePayload();
    if (!payload) return;
    if (options.forceWindow || (!options.forceInline && settings.openInWindow)) {
        if (openStageWindow(payload)) return;
    }
    const root = openInlineStageShell({ mode: 'video' });
    setStageSegments(payload.segments, payload.segments.map((text, index) => ({ text, character: 'Narrator', index })), 0);
    stageState.playing = options.noAutoAdvance ? false : !!payload.autoAdvance;
    root.focus();
    renderStage();
    if (!options.noAutoAdvance) scheduleNext();
}

function injectMessageButtons(msg) {
    if (!msg || msg.querySelector('.has-msg-buttons')) return;
    const target = msg.querySelector('.mes_text') || msg;
    if (!target) return;
    const group = document.createElement('div');
    group.className = 'has-msg-buttons';
    group.innerHTML = `
        <button class="has-floating-action has-play-msg" type="button" title="有声书播放 <content>"><i class="fa-solid fa-volume-high"></i></button>
        <button class="has-floating-action has-infer-msg" type="button" title="预生成人物台词"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        <button class="has-floating-action has-check-msg" type="button" title="检查台词标签与音色"><i class="fa-solid fa-list-check"></i></button>
        <button class="has-floating-action has-config-msg" type="button" title="配置有声书 TTS"><i class="fa-solid fa-cog"></i></button>
    `;
    target.prepend(group);
}

function createInlineDialogueButton(index, dialogue) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'has-inline-dialogue-button';
    button.dataset.dialogueIndex = String(index);
    button.title = `播放/生成单句：${dialogue.character || '角色'}`;
    button.innerHTML = '<i class="fa-solid fa-headphones-simple"></i>';
    return button;
}

function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('.has-msg-buttons, .has-inline-dialogue-button, script, style, textarea')) {
                return NodeFilter.FILTER_REJECT;
            }
            return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function insertButtonAfterText(root, searchText, button) {
    const needle = String(searchText || '').trim();
    if (!needle) return false;
    for (const node of getTextNodes(root)) {
        const index = node.nodeValue.indexOf(needle);
        if (index < 0) continue;
        const afterNeedle = node.splitText(index + needle.length);
        afterNeedle.parentNode.insertBefore(button, afterNeedle);
        return true;
    }
    return false;
}

function injectInlineDialogueButtons(msg) {
    const root = msg?.querySelector?.('.mes_text');
    if (!root) return;
    root.querySelectorAll('.has-inline-dialogue-button').forEach(button => button.remove());
    const analysis = analyzeMessage(msg);
    if (!analysis.hasContent || !analysis.dialogues.length) return;

    const fallback = document.createElement('span');
    fallback.className = 'has-inline-dialogue-fallback';

    analysis.dialogues.forEach((dialogue, index) => {
        const button = createInlineDialogueButton(index, dialogue);
        const inserted = insertButtonAfterText(root, dialogue.rawContent, button)
            || insertButtonAfterText(root, dialogue.originalLine, button)
            || insertButtonAfterText(root, dialogue.text, button);
        if (!inserted) fallback.appendChild(button);
    });

    if (fallback.childElementCount) {
        root.prepend(fallback);
    }
}

function handleMessageButtonClick(event) {
    const inlineButton = event.target?.closest?.('.has-inline-dialogue-button');
    if (inlineButton) {
        const msg = inlineButton.closest('.mes');
        if (!msg) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const now = Date.now();
        const lastHandledAt = Number(inlineButton.dataset.hasHandledAt || 0);
        if (now - lastHandledAt < 250) return;
        inlineButton.dataset.hasHandledAt = String(now);
        playSingleDialogue(msg, inlineButton.dataset.dialogueIndex, inlineButton);
        return;
    }

    const button = event.target?.closest?.('.has-msg-buttons .has-floating-action');
    if (!button) return;
    const msg = button.closest('.mes');
    if (!msg) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const now = Date.now();
    const lastHandledAt = Number(button.dataset.hasHandledAt || 0);
    if (now - lastHandledAt < 250) return;
    button.dataset.hasHandledAt = String(now);

    if (button.classList.contains('has-play-msg')) {
        playAudiobookMessage(msg, button);
        return;
    }
    if (button.classList.contains('has-infer-msg')) {
        preGenerateDialogues(msg, button);
        return;
    }
    if (button.classList.contains('has-check-msg')) {
        checkMessage(msg);
        return;
    }
    if (button.classList.contains('has-config-msg')) {
        document.getElementById('has-settings')?.scrollIntoView({ block: 'center' });
    }
}

function refreshMessageButtons() {
    document.querySelectorAll('.mes').forEach(msg => {
        if (msg.getAttribute('is_user') === 'true') return;
        injectMessageButtons(msg);
        injectInlineDialogueButtons(msg);
    });
}

function init() {
    console.warn('[混合有声书舞台] root entry loaded');
    getSettings();
    ensureSettingsPanel();
    ensureLauncher();
    refreshMessageButtons();
    document.removeEventListener('click', handleMessageButtonClick, true);
    document.addEventListener('click', handleMessageButtonClick, true);
    window.removeEventListener('pointerdown', handleMessageButtonClick, true);
    window.addEventListener('pointerdown', handleMessageButtonClick, true);

    eventSource?.on?.(event_types.APP_READY, () => {
        ensureSettingsPanel();
        ensureLauncher();
        refreshMessageButtons();
    });
    [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.CHAT_CHANGED,
    ].filter(Boolean).forEach(eventType => {
        eventSource?.on?.(eventType, () => setTimeout(refreshMessageButtons, 50));
    });
    setInterval(refreshMessageButtons, 3000);

    window.HybridAudiobookStage = {
        open: openStageFromCurrentChat,
        close: closeStage,
        setLinkedQueue,
        showLinkedSegment,
        setLinkedPlaybackState,
        clearLinkedQueue,
        extractContentBlock,
        splitIntoSegments,
        collectSegmentsFromText,
    };
}

init();
