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
import {
    DOUBAO_NATIVE_PROFILE_ID,
    ensureTtsSettingsV2,
    LEGACY_EDGE_PROFILE_ID,
    LEGACY_OPENAI_PROFILE_ID,
    MINIMAX_NATIVE_PROFILE_ID,
    XIAOMI_MIMO_PROFILE_ID,
} from './public/lib/tts-settings.mjs';
import {
    collectTextSegments,
    extractContentBlock as extractTtsContentBlock,
    normalizeWhitespace as normalizeTtsWhitespace,
    parseDialogueLine as parseTtsDialogueLine,
    splitNarrationText as splitTtsNarrationText,
} from './public/lib/tts-text.mjs';
import { createProviderRegistry } from './public/lib/tts-providers.mjs';
import {
    applyPresetRouting,
    removeCharacterOverridesByProfile,
    resolveSegmentRoute,
    summarizeCharacterOverrides,
} from './public/lib/tts-routing.mjs';
import { createPlaybackSessionManager } from './public/lib/playback-session.mjs';
import { getInlineDialogueButtonPresentation } from './public/lib/inline-dialogue-button.mjs';
import { buildSynthesisDescriptor, chooseLruEvictions, stableSerialize } from './public/lib/tts-cache-key.mjs';
import { beginTtsAuditRun, createTtsAuditState } from './public/lib/tts-audit.mjs';
import { createAudioMemoryCache, findAudioCacheHit } from './public/lib/tts-memory-cache.mjs';
import {
    chooseProfileVoice,
    collectProfileVoiceOptions,
    matchesVoiceSearch,
    rememberProfileVoice,
} from './public/lib/tts-voice-options.mjs';
import {
    DOUBAO_CATBOX_VOICE_GROUPS,
    DOUBAO_ICL_RESOURCE_ID,
    getDoubaoCatboxVoice,
    isDoubaoCatboxVoice,
} from './public/lib/doubao-voice-catalog.mjs';
import {
    getEdgeCatalogVoice,
    getPrioritizedEdgeVoiceGroups,
} from './public/lib/edge-voice-catalog.mjs';
import {
    CUSTOM_CLOUD_MODEL_OPTION,
    XIAOMI_MIMO_VOICES,
    getCloudModelOptions,
    getXiaomiMimoVoice,
    normalizeDiscoveredMinimaxVoices,
} from './public/lib/cloud-voice-catalog.mjs';

const extensionName = 'HybridAudiobookStage';
const integrationEvents = {
    speak: 'hybrid-audiobook:speak',
    stop: 'hybrid-audiobook:stop',
    segmentChanged: 'hybrid-audiobook:segment-changed',
    playbackState: 'hybrid-audiobook:playback-state',
};
const audioDbName = 'HybridAudiobookStageAudioCache';
const audioStoreName = 'audios';
const fallbackIndexTtsVoiceCatalog = ['Nanami.wav', 'QinChe.wav', 'zjx.wav'];
let indexTtsVoiceCatalog = [...fallbackIndexTtsVoiceCatalog];

function getAudit() {
    window.__hybridAudiobookStageAudit ||= createTtsAuditState();
    return window.__hybridAudiobookStageAudit;
}

function beginAuditRun(action) {
    return beginTtsAuditRun(getAudit(), action);
}

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
const audioMemoryCache = createAudioMemoryCache();
let currentPlayback = {
    audio: null,
    controller: null,
    playlist: [],
    index: 0,
    sessionId: 0,
    session: null,
    msg: null,
};

let latestTextSelection = { text: '', paragraphText: '', messageId: '', msg: null };
const inlineDialogueButtonStates = new Map();
let inlineDialogueCacheGeneration = 0;

function getInlineDialogueButtonKey(msg, dialogueIndex) {
    return `${getMessageId(msg)}:${Number(dialogueIndex) || 0}`;
}

function setInlineDialogueButtonState(key, state, {
    cacheReady = undefined,
    cacheHash = undefined,
    cacheChecked = undefined,
    error = null,
} = {}) {
    if (!key) return;
    const previous = inlineDialogueButtonStates.get(key) || { state: 'idle', cacheReady: false };
    const next = {
        state,
        cacheReady: cacheReady === undefined ? previous.cacheReady : !!cacheReady,
        cacheHash: cacheHash === undefined ? previous.cacheHash : cacheHash,
        cacheChecked: cacheChecked === undefined ? previous.cacheChecked : !!cacheChecked,
    };
    inlineDialogueButtonStates.set(key, next);
    const presentation = getInlineDialogueButtonPresentation(state);
    document.querySelectorAll('.has-inline-dialogue-button').forEach(button => {
        if (button.dataset.dialogueKey !== key) return;
        button.dataset.state = state;
        button.classList.toggle('has-busy', presentation.busy);
        button.classList.toggle('has-playing', state === 'playing');
        button.setAttribute('aria-busy', String(presentation.busy));
        button.setAttribute('aria-pressed', String(presentation.pressed));
        button.setAttribute('aria-label', presentation.label);
        button.title = presentation.label;
        button.innerHTML = `<i class="${presentation.iconClass}" aria-hidden="true"></i>`;
    });
    Object.assign(getAudit().inline_button ||= {}, {
        status: error ? 'fail' : 'success',
        error: error ? String(error).slice(0, 200) : null,
        state,
        cache_ready: next.cacheReady,
    });
}

const playbackSessions = createPlaybackSessionManager({
    onCancel: ({ session, abortCount, reason }) => {
        Object.assign(getAudit().request_cancelled, {
            status: 'success', error: null, abort_count: abortCount, stale_result_blocked: true,
        });
        emitPlaybackState(session, 'cancelled', reason || null);
    },
});

function emitPlaybackState(session, status, error = null) {
    if (!session) return;
    eventSource?.emit?.(integrationEvents.playbackState, {
        sessionId: session.id,
        status,
        index: Number(session.currentIndex || 0),
        total: session.segments?.length || 0,
        error: error ? String(error).slice(0, 300) : null,
    });
}

function emitSegmentChanged(session, index) {
    const segment = session?.segments?.[index];
    if (!session || !segment) return;
    eventSource?.emit?.(integrationEvents.segmentChanged, {
        sessionId: session.id,
        index,
        total: session.segments.length,
        type: segment.type || 'single',
        character: segment.character || '',
        status: segment.synthesisStatus || 'idle',
    });
}

const providerRegistry = createProviderRegistry({
    getSillyTavernHeaders: () => {
        const headers = getRequestHeaders ? getRequestHeaders() : {};
        headers['Content-Type'] = 'application/json';
        return headers;
    },
});

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
    try {
        const migration = ensureTtsSettingsV2(settings);
        Object.assign(getAudit().settings_migrated, {
            status: 'success',
            error: null,
            profile_count: migration.profileCount,
            preset_count: migration.presetCount,
        });
        if (migration.changed) saveSettingsDebounced?.();
    } catch (error) {
        Object.assign(getAudit().settings_migrated, {
            status: 'fail',
            error: error?.message || String(error),
        });
        getAudit().last_error = error?.message || String(error);
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

async function loadIndexTtsVoiceCatalog(container = document.getElementById('has-settings')) {
    try {
        const response = await fetch('/api/plugins/hybrid-audiobook-stage/index-tts2/voices', {
            method: 'GET',
            headers: getRequestHeaders ? getRequestHeaders() : {},
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const voices = Array.from(new Set((Array.isArray(data?.voices) ? data.voices : [])
            .map(value => String(value || '').trim())
            .filter(value => value && /\.wav$/i.test(value))));
        if (!voices.length) throw new Error('ckyp 文件夹里没有 WAV 音色');
        indexTtsVoiceCatalog = voices;
        Object.assign(getAudit().index_voice_catalog ||= {}, {
            status: 'success', error: null, count: voices.length, source: 'server-directory',
        });
        renderTtsConfiguration(container);
        return voices;
    } catch (error) {
        indexTtsVoiceCatalog = [...fallbackIndexTtsVoiceCatalog];
        Object.assign(getAudit().index_voice_catalog ||= {}, {
            status: 'fail', error: String(error.message || error).slice(0, 160),
            count: indexTtsVoiceCatalog.length, source: 'bundled-fallback',
        });
        renderTtsConfiguration(container);
        return indexTtsVoiceCatalog;
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
    return normalizeTtsWhitespace(text);
}

function extractContentBlock(text) {
    return extractTtsContentBlock(text);
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
    return parseTtsDialogueLine(line);
}

function splitNarrationText(text) {
    return splitTtsNarrationText(text);
}

function collectSegmentsFromText(rawText) {
    const settings = getSettings();
    const preset = settings.routingPresets?.[settings.activeRoutingPresetId] || {};
    const mode = ['mixed', 'dialogue-only', 'single-voice'].includes(preset.mode)
        ? preset.mode
        : (settings.readNarration === false ? 'dialogue-only' : 'mixed');
    const parsed = collectTextSegments(rawText, { mode });
    if (!parsed.hasContent) {
        Object.assign(getAudit().content_extracted, { status: 'fail', error: 'content_not_found', content_found: false });
        return { hasContent: false, content: '', segments: [], cacheKey: '' };
    }
    const { content } = parsed;
    const legacySegments = parsed.segments.map(segment => ({
        ...segment,
        engine: segment.type === 'narration' ? 'edge' : 'index',
        voice: segment.type === 'dialogue' ? (settings.voiceMap[segment.character] || '') : '',
    }));
    const routed = applyPresetRouting(legacySegments, preset, settings.providerProfiles);
    let dialogueIndex = 0;
    const segments = routed.segments.map(segment => segment.type === 'dialogue'
        ? { ...segment, dialogueIndex: dialogueIndex++ }
        : segment);

    const narrationCount = segments.filter(segment => segment.type === 'narration').length;
    const dialogueCount = segments.filter(segment => segment.type === 'dialogue').length;
    Object.assign(getAudit().content_extracted, { status: 'success', error: null, content_found: true });
    Object.assign(getAudit().route_built, {
        status: 'success',
        error: null,
        mode,
        narration_count: narrationCount,
        dialogue_count: dialogueCount,
        unresolved_count: routed.unresolved.length,
        override_count: summarizeCharacterOverrides(preset).total,
        legacy_index_override_count: summarizeCharacterOverrides(preset, LEGACY_OPENAI_PROFILE_ID).matchingProfile,
    });

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
    if (source === 'memory') return '即时缓存';
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

function isDialoguePlaybackSegment(segment) {
    if (segment?.type === 'dialogue') return true;
    if (segment?.type === 'narration') return false;
    const character = String(segment?.character || '').trim();
    return !!character && !/^Narrator$|^旁白$/i.test(character);
}

function getPlaybackRate(segment = currentPlayback.playlist?.[currentPlayback.index]) {
    const settings = getSettings();
    const value = isDialoguePlaybackSegment(segment)
        ? settings.dialoguePlaybackRate
        : settings.playbackRate;
    return Math.max(0.5, Math.min(3, Number(value || 1)));
}

function applyPlaybackSettings(audio, segment = currentPlayback.playlist?.[currentPlayback.index]) {
    if (!audio) return;
    const settings = getSettings();
    audio.volume = Math.max(0, Math.min(1, Number(settings.volume ?? 1)));
    audio.playbackRate = getPlaybackRate(segment);
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
                <div class="has-player-status" id="has-player-status">等待生成</div>
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
        const settings = getSettings();
        const segment = currentPlayback.playlist?.[currentPlayback.index];
        const settingsKey = isDialoguePlaybackSegment(segment) ? 'dialoguePlaybackRate' : 'playbackRate';
        const current = Number(settings[settingsKey] || 1);
        const next = cycle.find(value => value > current + 0.01) || cycle[0];
        settings[settingsKey] = next;
        saveSettings();
        applyPlaybackSettings(currentPlayback.audio, segment);
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
    const status = root.querySelector('#has-player-status');
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
    const activeSegment = currentPlayback.playlist?.[currentPlayback.index];
    if (speed) {
        speed.textContent = `${getPlaybackRate(activeSegment).toFixed(1)}x`;
        speed.title = isDialoguePlaybackSegment(activeSegment) ? '角色台词语速' : '旁白语速';
    }
    if (volume) {
        const vol = Number(getSettings().volume || 0);
        volume.className = vol === 0 ? 'fa-solid fa-volume-xmark' : (vol < 0.5 ? 'fa-solid fa-volume-low' : 'fa-solid fa-volume-high');
    }
    if (status) {
        const session = currentPlayback.session;
        const segment = session?.segments?.[currentPlayback.index];
        const pendingCount = session?.segments?.filter(item => item.synthesisStatus === 'pending').length || 0;
        const label = segment?.synthesisStatus === 'pending' ? '正在生成当前段'
            : segment?.synthesisStatus === 'error' ? '当前段生成失败'
                : stageState.playing ? '正在播放' : (session?.status === 'completed' ? '播放完成' : '已暂停');
        status.textContent = pendingCount ? `${label} · 预取 ${pendingCount}` : label;
    }
    const rect = root.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const playerVisible = root.classList.contains('visible');
    Object.assign(getAudit().player_ready, {
        status: 'success', error: null, ui_mode: stageState.uiMode || 'player', controls_ready: true,
        playback_rate: getPlaybackRate(activeSegment), current_audio_rate: Number(activeAudio?.playbackRate || 0),
        segment_type: isDialoguePlaybackSegment(activeSegment) ? 'dialogue' : 'narration',
        visible: playerVisible,
        in_viewport: playerVisible && rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight,
    });
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
        const request = indexedDB.open(audioDbName, 2);
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
        const tx = db.transaction(audioStoreName, 'readwrite');
        const store = tx.objectStore(audioStoreName);
        const req = store.get(hash);
        req.onsuccess = () => {
            const record = req.result || null;
            if (record) {
                record.lastAccessedAt = Date.now();
                record.size = Number(record.size || record.blob?.size || 0);
                store.put(record);
            }
            resolve(record);
        };
        req.onerror = () => reject(req.error);
    });
}

async function hasLocalCachedAudio(hash) {
    if (audioMemoryCache.has(hash)) return true;
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readonly');
        const req = tx.objectStore(audioStoreName).getKey(hash);
        req.onsuccess = () => resolve(req.result !== undefined);
        req.onerror = () => reject(req.error);
    });
}

async function verifyServerCachedAudio(hashes, signal = undefined) {
    const uniqueHashes = [...new Set((hashes || []).filter(Boolean))];
    if (!uniqueHashes.length || getSettings().sharedAudioCacheEnabled === false) return {};
    const headers = getRequestHeaders ? getRequestHeaders() : {};
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/plugins/hybrid-audiobook-stage/audio-cache/verify', {
        method: 'POST',
        headers,
        body: JSON.stringify({ hashes: uniqueHashes }),
        signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload?.result && typeof payload.result === 'object' ? payload.result : {};
}

async function saveCachedAudio(record) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readwrite');
        tx.objectStore(audioStoreName).put({
            ...record,
            size: Number(record.size || record.blob?.size || 0),
            lastAccessedAt: Date.now(),
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

function toPersistentAudioRecord(record) {
    if (!record || !record.blob) return null;
    const { blobUrl: _blobUrl, cacheSource: _cacheSource, isCached: _isCached, ...persistent } = record;
    return {
        ...persistent,
        size: Number(persistent.size || persistent.blob?.size || 0),
    };
}

function materializeAudioRecord(record, cacheSource, fallbackMeta = {}) {
    const persistent = toPersistentAudioRecord({ ...fallbackMeta, ...record });
    if (!persistent) return null;
    audioMemoryCache.set(persistent.hash, persistent);
    return {
        ...persistent,
        blobUrl: URL.createObjectURL(persistent.blob),
        isCached: cacheSource !== 'generated',
        cacheSource,
    };
}

async function pruneLocalAudioCache() {
    const db = await openAudioDb();
    const records = await new Promise((resolve, reject) => {
        const request = db.transaction(audioStoreName, 'readonly').objectStore(audioStoreName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
    const maxBytes = Math.max(32, Math.min(10240, Number(getSettings().localAudioCacheMaxMb) || 512)) * 1024 * 1024;
    const result = chooseLruEvictions(records, maxBytes);
    if (!result.evictions.length) return result;
    await new Promise((resolve, reject) => {
        const tx = db.transaction(audioStoreName, 'readwrite');
        const store = tx.objectStore(audioStoreName);
        result.evictions.forEach(hash => store.delete(hash));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    return result;
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

async function getServerCachedAudio(hash, fallbackMeta = {}, signal = undefined) {
    if (getSettings().sharedAudioCacheEnabled === false) return null;
    try {
        const response = await fetch(`/api/plugins/hybrid-audiobook-stage/audio-cache/${encodeURIComponent(hash)}`, {
            method: 'GET',
            cache: 'no-store',
            signal,
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return {
            ...fallbackMeta,
            hash,
            blob,
        };
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn(`[${extensionName}] shared cache read failed`, error);
        return null;
    }
}

async function findCachedAudio(hash, fallbackMeta = {}, signal = undefined) {
    const hit = await findAudioCacheHit({
        hash,
        memoryCache: audioMemoryCache,
        readIndexedDb: () => getCachedAudio(hash).catch(error => {
            console.warn(`[${extensionName}] local cache read failed`, error);
            return null;
        }),
        readServer: () => getServerCachedAudio(hash, fallbackMeta, signal),
    });
    if (!hit?.record?.blob) return null;

    const persistent = toPersistentAudioRecord(hit.record);
    if (hit.source === 'indexeddb') {
        uploadServerCachedAudio(persistent).catch(error => console.warn(`[${extensionName}] cache promotion failed`, error));
    } else if (hit.source === 'server') {
        saveCachedAudio(persistent).then(pruneLocalAudioCache).catch(error => console.warn(`[${extensionName}] server cache local save failed`, error));
    }
    return materializeAudioRecord(persistent, hit.source, fallbackMeta);
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
                    profileId: record.profileId,
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
        req.onsuccess = () => {
            audioMemoryCache.clear();
            resolve(true);
        };
        req.onerror = () => reject(req.error);
    });
}

function getProviderProfile(profileId, type, fallbackId) {
    const profiles = getSettings().providerProfiles || {};
    const requested = profiles[profileId];
    if (requested?.type === type) return requested;
    const fallback = profiles[fallbackId];
    if (fallback?.type === type) return fallback;
    return Object.values(profiles).find(profile => profile?.type === type && profile.enabled !== false) || null;
}

async function buildIndexAudioCacheIdentity(segment) {
    const settings = getSettings();
    const preset = settings.routingPresets?.[settings.activeRoutingPresetId] || {};
    const profile = getProviderProfile(segment.profileId || preset.dialogueDefault?.profileId, 'openai-compatible', LEGACY_OPENAI_PROFILE_ID);
    if (!profile) throw new Error('没有可用的 OpenAI 兼容 TTS Profile');
    const rawVoice = String(segment.voiceId || segment.voice || preset.dialogueDefault?.voiceId || profile.defaultVoice || settings.defaultVoice || '').trim();
    const voice = profile.id === LEGACY_OPENAI_PROFILE_ID ? ensureWavSuffix(rawVoice) : rawVoice;
    const speed = 1;
    const cacheDescriptor = buildSynthesisDescriptor({
        providerType: profile.type,
        profileId: profile.id,
        endpoint: profile.endpoint,
        model: profile.model,
        text: segment.text,
        voiceId: voice,
        responseFormat: profile.responseFormat || 'wav',
        synthesisParams: { speed },
        extraBody: { ...(profile.extraBody || {}), emotion: segment.emotion || '' },
    });
    const hash = await sha256(stableSerialize(cacheDescriptor));
    const baseMeta = {
        engine: profile.type,
        profileId: profile.id,
        type: segment.type || 'dialogue',
        text: segment.text,
        character: segment.character || '',
        voice,
        speed,
        emotion: segment.emotion || '',
        timestamp: Date.now(),
    };
    return { settings, profile, voice, speed, hash, baseMeta };
}

async function ensureIndexAudio(segment, { signal } = {}) {
    const { profile, voice, speed, hash, baseMeta } = await buildIndexAudioCacheIdentity(segment);

    const cached = await findCachedAudio(hash, baseMeta, signal);
    if (cached?.blob) return cached;

    const payload = {
        text: segment.text,
        voiceId: voice,
        model: profile.model,
        responseFormat: profile.responseFormat || 'wav',
        synthesisParams: { speed },
        extraBody: {},
        signal,
    };

    if (segment.emotion) {
        const emoVec = segment.emotion.split(',').map(value => Number.parseFloat(value.trim()));
        if (emoVec.length === 8 && emoVec.every(value => Number.isFinite(value))) {
            payload.extraBody.emo_control_method = 2;
            payload.extraBody.emo_vec = emoVec;
            payload.extraBody.emo_weight = 0.6;
        }
    }

    const synthesis = await providerRegistry.synthesize(profile, payload);
    const blob = synthesis.blob;
    Object.assign(getAudit().provider_ready, {
        status: 'success', error: null, profile_id: profile.id, provider_type: profile.type, probe_ok: true,
    });
    const record = {
        hash,
        ...baseMeta,
        blob,
        timestamp: Date.now(),
    };
    await saveCachedAudio(record);
    record.localPersisted = true;
    pruneLocalAudioCache().catch(error => console.warn(`[${extensionName}] cache prune failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared cache save failed`, error));
    return materializeAudioRecord(record, 'generated');
}

async function buildEdgeAudioCacheIdentity(segment) {
    const settings = getSettings();
    const preset = settings.routingPresets?.[settings.activeRoutingPresetId] || {};
    const profile = getProviderProfile(segment.profileId || preset.narration?.profileId, 'edge', LEGACY_EDGE_PROFILE_ID);
    if (!profile) throw new Error('没有可用的 Edge TTS Profile');
    const text = String(segment.text || '').trim();
    const voice = String(segment.voiceId || preset.narration?.voiceId || profile.edgeVoice || settings.edgeVoice || defaultSettings.edgeVoice).trim();
    const rate = Number(profile.edgeRate) || 0;
    const cacheDescriptor = buildSynthesisDescriptor({
        providerType: 'edge',
        profileId: profile.id,
        text,
        voiceId: voice,
        model: 'edge-tts',
        responseFormat: 'audio',
        synthesisParams: { rate },
    });
    const hash = await sha256(stableSerialize(cacheDescriptor));
    const baseMeta = {
        engine: 'edge',
        profileId: profile.id,
        type: segment.type || 'narration',
        text,
        character: segment.character || 'Narrator',
        voice,
        rate,
        timestamp: Date.now(),
    };
    return { profile, text, voice, rate, hash, baseMeta };
}

async function ensureEdgeAudio(segment, { signal } = {}) {
    const { profile, text, voice, rate, hash, baseMeta } = await buildEdgeAudioCacheIdentity(segment);

    const cached = await findCachedAudio(hash, baseMeta, signal);
    if (cached?.blob) return cached;

    const synthesis = await providerRegistry.synthesize(profile, {
        text,
        voiceId: voice,
        synthesisParams: { rate },
        signal,
    });
    const blob = synthesis.blob;
    Object.assign(getAudit().provider_ready, {
        status: 'success', error: null, profile_id: profile.id, provider_type: profile.type, probe_ok: true,
    });
    const record = {
        hash,
        ...baseMeta,
        blob,
        timestamp: Date.now(),
    };
    await saveCachedAudio(record);
    record.localPersisted = true;
    pruneLocalAudioCache().catch(error => console.warn(`[${extensionName}] cache prune failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared edge cache save failed`, error));
    return materializeAudioRecord(record, 'generated');
}

function getDoubaoContextText(profile, segment) {
    return [
        String(profile.contextText || '').trim(),
        segment.emotionLabel ? `情绪：${String(segment.emotionLabel).trim()}` : '',
    ].filter(Boolean).join('；');
}

async function buildDoubaoAudioCacheIdentity(segment) {
    const profile = getProviderProfile(segment.profileId, 'doubao', DOUBAO_NATIVE_PROFILE_ID);
    if (!profile) throw new Error('没有可用的豆包 TTS Profile');
    const text = String(segment.text || '').trim();
    const voice = String(segment.voiceId || profile.defaultVoice || '').trim();
    const resourceId = String(profile.resourceId || 'seed-tts-2.0').trim();
    const contextText = getDoubaoContextText(profile, segment);
    const cacheDescriptor = buildSynthesisDescriptor({
        providerType: 'doubao',
        profileId: profile.id,
        model: resourceId,
        text,
        voiceId: voice,
        responseFormat: 'mp3',
        extraBody: { contextText },
    });
    const hash = await sha256(stableSerialize(cacheDescriptor));
    const baseMeta = {
        engine: 'doubao',
        profileId: profile.id,
        type: segment.type || 'dialogue',
        text,
        character: segment.character || '',
        voice,
        resourceId,
        contextText,
        timestamp: Date.now(),
    };
    return { profile, text, voice, resourceId, contextText, hash, baseMeta };
}

async function ensureDoubaoAudio(segment, { signal } = {}) {
    const { profile, text, voice, contextText, hash, baseMeta } = await buildDoubaoAudioCacheIdentity(segment);
    const cached = await findCachedAudio(hash, baseMeta, signal);
    if (cached?.blob) return cached;

    const synthesis = await providerRegistry.synthesize(profile, {
        text,
        voiceId: voice,
        contextText,
        signal,
    });
    Object.assign(getAudit().provider_ready, {
        status: 'success', error: null, profile_id: profile.id, provider_type: profile.type, probe_ok: true,
    });
    const record = {
        hash,
        ...baseMeta,
        blob: synthesis.blob,
        timestamp: Date.now(),
    };
    await saveCachedAudio(record);
    record.localPersisted = true;
    pruneLocalAudioCache().catch(error => console.warn(`[${extensionName}] cache prune failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared doubao cache save failed`, error));
    return materializeAudioRecord(record, 'generated');
}

async function buildCloudAudioCacheIdentity(segment, providerType, fallbackProfileId) {
    const profile = getProviderProfile(segment.profileId, providerType, fallbackProfileId);
    if (!profile) throw new Error(`没有可用的 ${providerType} TTS Profile`);
    const text = String(segment.text || '').trim();
    const voice = String(segment.voiceId || profile.defaultVoice || '').trim();
    if (!text) throw new Error('TTS 文本为空');
    if (!voice) throw new Error(`${profile.name || providerType} 缺少音色`);
    const model = String(profile.model || '').trim();
    const format = String(profile.responseFormat || (providerType === 'minimax' ? 'mp3' : 'wav')).trim();
    const style = [String(profile.style || '').trim(), String(segment.emotionLabel || '').trim()]
        .filter(Boolean).join('；');
    const platform = providerType === 'minimax' ? String(profile.platform || 'cn').trim() : '';
    const cacheDescriptor = buildSynthesisDescriptor({
        providerType,
        profileId: profile.id,
        model,
        text,
        voiceId: voice,
        responseFormat: format,
        extraBody: { platform, style },
    });
    const hash = await sha256(stableSerialize(cacheDescriptor));
    const baseMeta = {
        engine: providerType,
        profileId: profile.id,
        type: segment.type || 'dialogue',
        text,
        character: segment.character || '',
        voice,
        model,
        format,
        platform,
        style,
        timestamp: Date.now(),
    };
    return { profile, text, voice, model, format, platform, style, hash, baseMeta };
}

async function ensureCloudAudio(segment, providerType, fallbackProfileId, { signal } = {}) {
    const identity = await buildCloudAudioCacheIdentity(segment, providerType, fallbackProfileId);
    const cached = await findCachedAudio(identity.hash, identity.baseMeta, signal);
    if (cached?.blob) return cached;
    const synthesis = await providerRegistry.synthesize(identity.profile, {
        text: identity.text,
        voiceId: identity.voice,
        style: identity.style,
        emotion: identity.style,
        signal,
    });
    Object.assign(getAudit().provider_ready, {
        status: 'success', error: null, profile_id: identity.profile.id,
        provider_type: providerType, probe_ok: true,
    });
    const record = { hash: identity.hash, ...identity.baseMeta, blob: synthesis.blob, timestamp: Date.now() };
    await saveCachedAudio(record);
    record.localPersisted = true;
    pruneLocalAudioCache().catch(error => console.warn(`[${extensionName}] cache prune failed`, error));
    uploadServerCachedAudio(record).catch(error => console.warn(`[${extensionName}] shared cloud cache save failed`, error));
    return materializeAudioRecord(record, 'generated');
}

async function ensureRoutedAudio(segment, options = {}) {
    if (segment.routeError) throw new Error(segment.routeError);
    const profile = getSettings().providerProfiles?.[segment.profileId];
    if (!profile) throw new Error(`找不到 TTS Profile: ${segment.profileId || '未配置'}`);
    if (profile.type === 'edge') return ensureEdgeAudio(segment, options);
    if (profile.type === 'openai-compatible') return ensureIndexAudio(segment, options);
    if (profile.type === 'doubao') return ensureDoubaoAudio(segment, options);
    if (profile.type === 'minimax') return ensureCloudAudio(segment, 'minimax', MINIMAX_NATIVE_PROFILE_ID, options);
    if (profile.type === 'xiaomi-mimo') return ensureCloudAudio(segment, 'xiaomi-mimo', XIAOMI_MIMO_PROFILE_ID, options);
    throw new Error(`不支持的 TTS Provider: ${profile.type || 'unknown'}`);
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
    const segments = analysis.segments.filter(segment => !dialogueOnly || segment.type === 'dialogue');

    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        if (segment.routeError || !segment.voiceId) {
            missingVoices.add(segment.character || 'Unknown');
            continue;
        }

        try {
            const record = await ensureRoutedAudio(segment);
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
            toastError(`${segment.providerType || 'TTS'} 片段生成失败: ${error.message}`);
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
    const dialogues = analysis.segments.filter(segment => segment.type === 'dialogue');
    const narration = analysis.segments.filter(segment => segment.type === 'narration');
    const characters = Array.from(new Set(dialogues.map(segment => segment.character).filter(Boolean)));
    const missingVoices = Array.from(new Set(dialogues.filter(segment => segment.routeError || !segment.voiceId).map(segment => segment.character || 'Unknown')));
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
    const dialogueKey = getInlineDialogueButtonKey(msg, dialogueIndex);
    const activeSession = playbackSessions.getActive();
    if (activeSession?.inlineDialogueKey === dialogueKey || activeSession?.currentInlineDialogueKey === dialogueKey) {
        const audio = currentPlayback.audio;
        if (!audio || activeSession.status === 'preparing') {
            stopCurrentPlayback();
            return true;
        }
        if (!audio.paused && activeSession.status === 'playing') {
            audio.pause();
            activeSession.status = 'paused';
            setInlineDialogueButtonState(dialogueKey, 'ready', { cacheReady: true });
            emitPlaybackState(activeSession, 'paused');
            return true;
        }
        try {
            if (activeSession.status === 'completed' && Number.isFinite(audio.duration)) audio.currentTime = 0;
            await audio.play();
            activeSession.status = 'playing';
            setInlineDialogueButtonState(dialogueKey, 'playing', { cacheReady: true });
            emitPlaybackState(activeSession, 'playing');
        } catch (error) {
            setInlineDialogueButtonState(dialogueKey, 'error', { cacheReady: true, error });
            toastWarn(`无法继续播放：${error.message}`);
        }
        return true;
    }
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
    if (dialogue.routeError || !dialogue.voiceId) {
        toastWarn(`${dialogue.character || '该角色'} 未配置音色`);
        return;
    }

    setInlineDialogueButtonState(dialogueKey, 'preparing');
    try {
        await playLightweightText(dialogue.text, {
            source: 'dialogue',
            profileId: dialogue.profileId,
            voiceId: dialogue.voiceId,
            character: dialogue.character,
            segment: dialogue,
            inlineDialogueKey: dialogueKey,
        });
    } catch (error) {
        setInlineDialogueButtonState(dialogueKey, 'error', { error });
        throw error;
    }
}

async function playLightweightText(text, {
    source = 'selection',
    profileId = '',
    voiceId = '',
    character = '',
    segment: suppliedSegment = null,
    sourceMessage = null,
    inlineDialogueKey = '',
} = {}) {
    const audit = beginAuditRun(`speak:${source}`);
    if (inlineDialogueKey) setInlineDialogueButtonState(inlineDialogueKey, 'preparing');
    const cleanText = normalizeWhitespace(String(text || '')).slice(0, 10000);
    if (!cleanText) {
        Object.assign(audit.audio_played, {
            status: 'fail', error: 'empty_text', source, first_segment_started: false, order_ok: false,
        });
        audit.last_error = 'empty_text';
        toastWarn('没有可朗读的文字');
        return false;
    }
    const settings = getSettings();
    const preset = getActivePreset(settings);
    let matchedSegment = suppliedSegment;
    if (!matchedSegment && sourceMessage) {
        const normalizedTarget = normalizeWhitespace(cleanText);
        matchedSegment = collectSegmentsFromMessage(sourceMessage).segments
            .find(item => normalizeWhitespace(item.text) === normalizedTarget) || null;
    }
    const baseSegment = matchedSegment
        ? { ...matchedSegment, text: cleanText }
        : { type: 'single', character, text: cleanText };
    const effectiveProfileId = String(profileId || baseSegment.profileId || '').trim();
    const selectedProfile = settings.providerProfiles?.[effectiveProfileId];
    const explicitVoiceId = String(voiceId || baseSegment.voiceId || selectedProfile?.defaultVoice || selectedProfile?.edgeVoice || '').trim();
    const route = effectiveProfileId
        ? {
            ok: !!selectedProfile && !!explicitVoiceId,
            profileId: effectiveProfileId,
            voiceId: explicitVoiceId,
            providerType: selectedProfile?.type,
            error: !selectedProfile ? '找不到指定 TTS Profile' : (!explicitVoiceId ? '没有指定音色' : null),
        }
        : resolveSegmentRoute(baseSegment, preset, settings.providerProfiles);
    const segment = {
        ...baseSegment,
        profileId: route.profileId,
        voiceId: route.voiceId,
        providerType: route.providerType,
        routeError: route.error,
    };
    if (!route.ok) {
        Object.assign(audit.route_built, {
            status: 'fail', error: route.error || 'route_unresolved', mode: 'single', narration_count: 0, dialogue_count: 0,
        });
        audit.last_error = route.error || 'route_unresolved';
        toastError(route.error || '无法确定 TTS 路由');
        return false;
    }

    stopCurrentPlayback();
    const session = playbackSessions.start({ source, segments: [segment] });
    session.inlineDialogueKey = inlineDialogueKey;
    session.inlineAudioReady = false;
    currentPlayback.session = session;
    currentPlayback.sessionId = session.id;
    const requestController = playbackSessions.createController(session, 0);
    emitPlaybackState(session, 'preparing');
    try {
        const record = await ensureRoutedAudio(segment, { signal: requestController.signal });
        playbackSessions.finishController(session, 0);
        if (!playbackSessions.isActive(session) || !playbackSessions.registerObjectUrl(session, record.blobUrl)) return false;
        session.inlineAudioReady = true;
        if (inlineDialogueKey) setInlineDialogueButtonState(inlineDialogueKey, 'ready', { cacheReady: true });
        Object.assign(audit.cache, {
            status: 'success', error: null, cache_source: record.cacheSource || 'generated', api_key_in_descriptor: false,
            persistent_ready: record.cacheSource !== 'generated' || record.localPersisted === true,
            lookup_order: 'memory-indexeddb-server-provider',
        });
        session.segments[0].synthesisStatus = 'success';
        emitSegmentChanged(session, 0);
        const item = { ...segment, ...record, index: 0 };
        currentPlayback.playlist = [item];
        currentPlayback.index = 0;
        const audio = new Audio(record.blobUrl);
        currentPlayback.audio = audio;
        const controller = {
            play: () => audio.play?.(),
            pause: () => audio.pause?.(),
            next: () => {},
            previous: () => {},
            goTo: () => {},
            seek: percent => {
                if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * clamp(Number(percent) || 0, 0, 1);
            },
            stop: stopCurrentPlayback,
        };
        currentPlayback.controller = controller;
        stageState.uiMode = 'player';
        setLinkedQueue({
            segments: [item], index: 0, controller, mode: 'audiobook', openStage: false,
        });
        document.getElementById('has-stage')?.classList.remove('has-open');
        openAudioPlayer();
        applyPlaybackSettings(audio, item);
        audio.addEventListener('play', () => {
            if (!playbackSessions.isActive(session)) return;
            session.status = 'playing';
            if (inlineDialogueKey) setInlineDialogueButtonState(inlineDialogueKey, 'playing', { cacheReady: true });
            setLinkedPlaybackState(true);
            emitPlaybackState(session, 'playing');
        });
        audio.addEventListener('pause', () => {
            if (!playbackSessions.isActive(session)) return;
            setLinkedPlaybackState(false);
            if (inlineDialogueKey && session.status !== 'completed') {
                setInlineDialogueButtonState(inlineDialogueKey, 'ready', { cacheReady: session.inlineAudioReady });
            }
        });
        audio.addEventListener('timeupdate', () => {
            if (playbackSessions.isActive(session)) setStageProgress(audio.currentTime, audio.duration);
        });
        audio.addEventListener('ended', () => {
            if (!playbackSessions.isActive(session)) return;
            session.status = 'completed';
            if (inlineDialogueKey) setInlineDialogueButtonState(inlineDialogueKey, 'ready', { cacheReady: true });
            setLinkedPlaybackState(false);
            emitPlaybackState(session, 'completed');
        }, { once: true });
        Object.assign(audit.selection_captured ||= {}, {
            status: 'success', error: null, character_count: cleanText.length, message_id: latestTextSelection.messageId || null,
        });
        await audio.play();
        Object.assign(audit.audio_played, {
            status: 'success', error: null, source, first_segment_started: true, order_ok: true,
        });
        return true;
    } catch (error) {
        playbackSessions.finishController(session, 0);
        if (error?.name === 'AbortError' || session.status === 'cancelled') return false;
        if (inlineDialogueKey) setInlineDialogueButtonState(inlineDialogueKey, 'error', { error });
        session.segments[0].synthesisStatus = 'error';
        Object.assign(audit.audio_played, {
            status: 'fail', error: error?.message || String(error), source, first_segment_started: false, order_ok: false,
        });
        audit.last_error = error?.message || String(error);
        emitPlaybackState(session, 'error', error.message);
        const routeHint = segment.profileId === LEGACY_OPENAI_PROFILE_ID
            ? '；这句仍有旧的 IndexTTS2 特定角色覆盖，请在轻量 TTS 第 1 步清除旧 Index 覆盖'
            : '';
        toastError(`朗读失败：${error.message}${routeHint}`);
        return false;
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

function stopCurrentPlayback(reason = 'stopped') {
    const stoppedSession = currentPlayback.session || playbackSessions.getActive();
    if (currentPlayback.audio) {
        try {
            currentPlayback.audio.pause();
            currentPlayback.audio.src = '';
        } catch (error) {
            console.warn(`[${extensionName}] stop audio failed`, error);
        }
    }
    currentPlayback.audio = null;
    playbackSessions.cancel(reason);
    if (stoppedSession?.inlineDialogueKey) {
        setInlineDialogueButtonState(
            stoppedSession.inlineDialogueKey,
            stoppedSession.inlineAudioReady ? 'ready' : 'idle',
            { cacheReady: stoppedSession.inlineAudioReady },
        );
    }
    if (stoppedSession?.currentInlineDialogueKey) {
        setInlineDialogueButtonState(stoppedSession.currentInlineDialogueKey, 'ready', { cacheReady: true });
    }
    currentPlayback.session = null;
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

function invalidateSynthesisRouting(reason = 'synthesis_settings_changed') {
    stopCurrentPlayback(reason);
    inlineDialogueCacheGeneration += 1;
    inlineDialogueButtonStates.clear();
    refreshMessageButtons();
}

async function playAudiobookMessage(msg, button = null, { playbackUiOverride = null } = {}) {
    const audit = beginAuditRun('speak:message');
    if (getSettings().ttsEnabled === false) {
        audit.last_error = 'tts_disabled';
        toastWarn('请先启用有声书 TTS');
        return;
    }

    button?.classList.add('has-busy');
    let session = null;
    try {
        const analysis = collectSegmentsFromMessage(msg);
        if (!analysis.hasContent || !analysis.segments.length) {
            toastWarn('没有可播放的有声书片段');
            return;
        }

        stopCurrentPlayback();
        session = playbackSessions.start({ source: 'message', segments: analysis.segments });
        session.messageId = getMessageId(msg);
        session.currentInlineDialogueKey = '';
        currentPlayback.session = session;
        currentPlayback.sessionId = session.id;
        emitPlaybackState(session, 'preparing');
        currentPlayback.msg = msg;
        currentPlayback.playlist = new Array(session.segments.length);
        const playlist = currentPlayback.playlist;
        const pending = new Map();
        const audio = new Audio();
        currentPlayback.audio = audio;

        const isCurrent = () => playbackSessions.isActive(session) && currentPlayback.session === session;
        const prepareSegment = index => {
            if (!isCurrent() || index < 0 || index >= session.segments.length) return Promise.resolve(null);
            if (playlist[index]) return Promise.resolve(playlist[index]);
            if (pending.has(index)) return pending.get(index);
            const segment = session.segments[index];
            segment.synthesisStatus = 'pending';
            const requestController = playbackSessions.createController(session, index);
            const promise = ensureRoutedAudio(segment, { signal: requestController.signal })
                .then(record => {
                    if (!isCurrent() || !playbackSessions.registerObjectUrl(session, record.blobUrl)) {
                        throw new DOMException('Stale playback session', 'AbortError');
                    }
                    segment.synthesisStatus = 'success';
                    const item = { ...segment, ...record, index, sourceIndex: index };
                    playlist[index] = item;
                    if (segment.type === 'dialogue' && Number.isInteger(segment.dialogueIndex)) {
                        setInlineDialogueButtonState(
                            getInlineDialogueButtonKey(msg, segment.dialogueIndex),
                            'ready',
                            { cacheReady: true },
                        );
                    }
                    Object.assign(getAudit().cache, {
                        status: 'success', error: null, cache_source: record.cacheSource || 'generated', api_key_in_descriptor: false,
                        persistent_ready: record.cacheSource !== 'generated' || record.localPersisted === true,
                        lookup_order: 'memory-indexeddb-server-provider',
                    });
                    return item;
                })
                .catch(error => {
                    segment.synthesisStatus = error?.name === 'AbortError' || !isCurrent() ? 'cancelled' : 'error';
                    segment.synthesisError = error?.name === 'AbortError' ? null : (error?.message || String(error));
                    if (error?.name === 'AbortError') return null;
                    console.warn(`[${extensionName}] segment generation failed`, { index, error });
                    if (segment.profileId === LEGACY_OPENAI_PROFILE_ID && !session.legacyOverrideWarningShown) {
                        session.legacyOverrideWarningShown = true;
                        toastWarn('有角色仍使用旧的 IndexTTS2 特定覆盖；请在轻量 TTS 第 1 步点击“清除旧 Index 覆盖”');
                    }
                    return null;
                })
                .finally(() => {
                    playbackSessions.finishController(session, index);
                    pending.delete(index);
                });
            pending.set(index, promise);
            return promise;
        };

        const prefetch = index => {
            const count = Math.max(0, Math.min(2, Number(getSettings().prefetchCount) || 2));
            Object.assign(getAudit().prefetch, { status: 'success', error: null, max_ahead: count });
            for (let offset = 1; offset <= count; offset += 1) prepareSegment(index + offset);
        };

        const playTrack = async (requestedIndex, seekTime = 0) => {
            if (!isCurrent()) return false;
            let index = Math.max(0, Number(requestedIndex) || 0);
            let item = null;
            while (index < session.segments.length && !item && isCurrent()) {
                item = await prepareSegment(index);
                if (!item) index += 1;
            }
            if (!isCurrent()) return false;
            if (!item) {
                const hadPlayableSegment = playlist.some(Boolean);
                session.status = hadPlayableSegment ? 'completed' : 'error';
                if (!hadPlayableSegment) {
                    Object.assign(audit.audio_played, {
                        status: 'fail', error: 'all_segments_failed', source: 'message', first_segment_started: false, order_ok: false,
                    });
                    audit.last_error = 'all_segments_failed';
                }
                emitPlaybackState(session, session.status, hadPlayableSegment ? null : 'all_segments_failed');
                setLinkedPlaybackState(false);
                if (!hadPlayableSegment) toastError('所有 TTS 片段均生成失败');
                renderAudioPlayer();
                return false;
            }

            currentPlayback.index = index;
            session.currentIndex = index;
            if (session.currentInlineDialogueKey) {
                setInlineDialogueButtonState(session.currentInlineDialogueKey, 'ready', { cacheReady: true });
            }
            session.currentInlineDialogueKey = item.type === 'dialogue' && Number.isInteger(item.dialogueIndex)
                ? getInlineDialogueButtonKey(msg, item.dialogueIndex)
                : '';
            emitSegmentChanged(session, index);
            showLinkedSegment(index);
            setStageProgress(0, item.duration || 0);
            if (audio.src !== item.blobUrl) {
                audio.src = item.blobUrl;
                audio.load();
            }
            // Loading a new source may reset playbackRate on mobile browsers.
            // Reapply playback-only settings for every queued segment immediately before play().
            applyPlaybackSettings(audio, item);
            if (seekTime > 0 && audio.readyState >= 1) audio.currentTime = seekTime;
            try {
                await audio.play();
                if (!isCurrent()) return false;
                session.status = 'playing';
                if (session.currentInlineDialogueKey) {
                    setInlineDialogueButtonState(session.currentInlineDialogueKey, 'playing', { cacheReady: true });
                }
                emitPlaybackState(session, 'playing');
                Object.assign(audit.audio_played, {
                    status: 'success', error: null, source: 'message', first_segment_started: true, order_ok: true,
                });
                prefetch(index);
                return true;
            } catch (error) {
                if (!isCurrent()) return false;
                Object.assign(audit.audio_played, {
                    status: 'fail', error: error?.message || String(error), source: 'message', first_segment_started: false, order_ok: false,
                });
                audit.last_error = error?.message || String(error);
                console.warn(`[${extensionName}] playlist play blocked`, error);
                setLinkedPlaybackState(false);
                toastWarn('浏览器阻止了连续播放，请点击播放键继续');
                return false;
            }
        };

        const controller = {
            play: () => audio.play?.(),
            pause: () => audio.pause?.(),
            next: () => playTrack(currentPlayback.index + 1, 0),
            previous: () => playTrack(Math.max(0, currentPlayback.index - 1), 0),
            goTo: index => playTrack(Math.max(0, Math.min(session.segments.length - 1, Number(index) || 0)), 0),
            seek: percent => {
                const safePercent = clamp(Number(percent) || 0, 0, 1);
                if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * safePercent;
            },
            stop: stopCurrentPlayback,
        };
        currentPlayback.controller = controller;
        const playbackUi = playbackUiOverride === 'video' || playbackUiOverride === 'player'
            ? playbackUiOverride
            : (getSettings().audiobookPlaybackUi === 'video' ? 'video' : 'player');
        stageState.uiMode = playbackUi;
        setLinkedQueue({
            segments: session.segments.map((item, index) => ({
                text: item.text, character: item.character, engine: item.providerType || item.engine, cacheSource: '', index,
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

        audio.addEventListener('play', () => {
            if (!isCurrent()) return;
            session.status = 'playing';
            if (session.currentInlineDialogueKey) {
                setInlineDialogueButtonState(session.currentInlineDialogueKey, 'playing', { cacheReady: true });
            }
            setLinkedPlaybackState(true);
            emitPlaybackState(session, 'playing');
        });
        audio.addEventListener('pause', () => {
            if (!isCurrent()) return;
            if (session.status === 'playing') session.status = 'paused';
            if (session.currentInlineDialogueKey) {
                setInlineDialogueButtonState(session.currentInlineDialogueKey, 'ready', { cacheReady: true });
            }
            setLinkedPlaybackState(false);
        });
        audio.addEventListener('loadedmetadata', () => {
            if (isCurrent()) setStageProgress(audio.currentTime, audio.duration);
        });
        audio.addEventListener('timeupdate', () => {
            if (isCurrent()) setStageProgress(audio.currentTime, audio.duration);
        });
        audio.addEventListener('ended', () => {
            if (!isCurrent()) return;
            setStageProgress(audio.duration || 0, audio.duration || 0);
            setLinkedPlaybackState(false);
            if (currentPlayback.index >= session.segments.length - 1) {
                session.status = 'completed';
                emitPlaybackState(session, 'completed');
                renderAudioPlayer();
                return;
            }
            playTrack(currentPlayback.index + 1, 0);
        });
        audio.addEventListener('error', () => {
            if (!isCurrent()) return;
            setLinkedPlaybackState(false);
            playTrack(currentPlayback.index + 1, 0);
        });

        toastInfo(`正在准备第 1 段，共 ${session.segments.length} 段`);
        await playTrack(0, 0);
    } catch (error) {
        if (error?.name === 'AbortError' || session?.status === 'cancelled') return;
        Object.assign(audit.audio_played, {
            status: 'fail', error: error?.message || String(error), source: 'message', first_segment_started: false, order_ok: false,
        });
        audit.last_error = error?.message || String(error);
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
                <b><i class="fa-solid fa-headphones" aria-hidden="true"></i> 轻量 TTS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="has-quick-intro">
                    <strong>三步开始朗读</strong>
                    <span>选模式和声音 → 测试连接与试听 → 回到聊天点击朗读按钮</span>
                </div>
                <section class="has-settings-card" data-testid="has-lightweight-step-mode">
                    <div class="has-step-heading"><span>1</span><div><strong>选择朗读方式</strong><small>日常只需要改这里。</small></div></div>
                    <label class="checkbox_label has-primary-toggle"><input id="has-tts-enabled" type="checkbox"><span>启用轻量 TTS</span></label>
                    <label class="has-field"><span>我的朗读方案</span><select id="has-preset-select" class="text_pole"></select></label>
                    <label class="has-field">
                        <span>朗读内容</span>
                        <select id="has-preset-mode" class="text_pole">
                            <option value="mixed">旁白和角色分别朗读</option>
                            <option value="dialogue-only">只读角色台词</option>
                            <option value="single-voice">全文使用一个声音</option>
                        </select>
                    </label>
                    <div class="has-route-grid">
                        <label class="has-field has-route-choice" data-route-modes="mixed"><span>旁白使用</span><select id="has-route-narration-profile" class="text_pole"></select></label>
                        <label class="has-field has-route-choice" data-route-modes="mixed"><span>旁白音色</span><div id="has-route-narration-voice" class="has-voice-combobox"><button class="has-voice-combobox-toggle text_pole" type="button" aria-haspopup="listbox" aria-expanded="false"><span>选择音色</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="has-voice-combobox-popover" hidden><input class="has-voice-search text_pole" type="search" autocomplete="off" placeholder="搜索名称、ID、Locale、Gender" aria-label="搜索旁白音色"><div class="has-voice-options" role="listbox"></div></div></div></label>
                        <label class="has-field has-route-choice" data-route-modes="mixed dialogue-only"><span>角色默认使用</span><select id="has-route-dialogue-profile" class="text_pole"></select></label>
                        <label class="has-field has-route-choice" data-route-modes="mixed dialogue-only"><span>角色默认音色</span><div id="has-route-dialogue-voice" class="has-voice-combobox"><button class="has-voice-combobox-toggle text_pole" type="button" aria-haspopup="listbox" aria-expanded="false"><span>选择音色</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="has-voice-combobox-popover" hidden><input class="has-voice-search text_pole" type="search" autocomplete="off" placeholder="搜索名称、ID、Locale、Gender" aria-label="搜索角色默认音色"><div class="has-voice-options" role="listbox"></div></div></div></label>
                        <label class="has-field has-route-choice" data-route-modes="single-voice"><span>全文使用</span><select id="has-route-single-profile" class="text_pole"></select></label>
                        <label class="has-field has-route-choice" data-route-modes="single-voice"><span>全文音色</span><div id="has-route-single-voice" class="has-voice-combobox"><button class="has-voice-combobox-toggle text_pole" type="button" aria-haspopup="listbox" aria-expanded="false"><span>选择音色</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="has-voice-combobox-popover" hidden><input class="has-voice-search text_pole" type="search" autocomplete="off" placeholder="搜索名称、ID、Locale、Gender" aria-label="搜索全文音色"><div class="has-voice-options" role="listbox"></div></div></div></label>
                    </div>
                    <small id="has-route-help">旁白和角色可以使用不同服务与音色。</small>
                    <div id="has-route-override-warning" class="has-route-warning" role="status" aria-live="polite" hidden>
                        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                        <span id="has-route-override-warning-text"></span>
                        <button id="has-clear-legacy-index-overrides" class="menu_button" type="button">清除旧 Index 覆盖</button>
                    </div>
                </section>

                <section class="has-settings-card" data-testid="has-lightweight-step-test">
                    <div class="has-step-heading"><span>2</span><div><strong>连接并试听声音</strong><small>如果使用本机 IndexTTS2，请先启动它的 API 后台。</small></div></div>
                    <label class="has-field"><span>要测试的声音服务</span><select id="has-profile-select" class="text_pole"></select></label>
                    <div id="has-doubao-quick" class="has-provider-quick" data-testid="has-doubao-quick" hidden>
                        <div class="has-provider-quick-title"><strong>豆包原生连接</strong><small>密钥保存在 SillyTavern 共享设置中，未经额外加密。</small></div>
                        <label class="has-field"><span>APP ID</span><input id="has-doubao-app-id" class="text_pole" type="text" autocomplete="off" placeholder="火山引擎语音应用 APP ID"></label>
                        <label class="has-field"><span>Access Key</span><input id="has-doubao-access-key" class="text_pole" type="password" autocomplete="off" placeholder="X-Api-Access-Key"></label>
                        <label class="has-field"><span>资源类型</span><select id="has-doubao-resource-id" class="text_pole"><option value="seed-tts-2.0">Seed TTS 2.0 合成音色</option><option value="seed-icl-2.0">Seed ICL 2.0 复刻音色</option></select></label>
                        <label class="has-field"><span>Speaker ID</span><div id="has-doubao-speaker-id" class="has-voice-combobox"><button class="has-voice-combobox-toggle text_pole" type="button" aria-haspopup="listbox" aria-expanded="false"><span>选择音色</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="has-voice-combobox-popover" hidden><input class="has-voice-search text_pole" type="search" autocomplete="off" placeholder="搜索名称、ID、Locale、Gender" aria-label="搜索测试声音 Speaker ID"><div class="has-voice-options" role="listbox"></div></div></div></label>
                        <label class="has-field"><span>语气提示（可选）</span><input id="has-doubao-context-text" class="text_pole" type="text" maxlength="2000" placeholder="例如：温柔、自然地讲述"></label>
                    </div>
                    <div id="has-cloud-quick" class="has-provider-quick" data-testid="has-cloud-quick" hidden>
                        <div class="has-provider-quick-title"><strong id="has-cloud-quick-title">云 TTS 连接</strong><small>API Key 保存在 SillyTavern 共享设置中，未经额外加密；请求仅经本机酒馆服务器代理。</small></div>
                        <label class="has-field"><span>API Key</span><input id="has-cloud-api-key" class="text_pole" type="password" autocomplete="off"></label>
                        <label id="has-cloud-platform-row" class="has-field"><span>MiniMax 区域</span><select id="has-cloud-platform" class="text_pole"><option value="cn">国内站 minimaxi.com</option><option value="io">国际站 minimax.io</option></select></label>
                        <label class="has-field"><span>模型</span><select id="has-cloud-model" class="text_pole"></select></label>
                        <label id="has-cloud-custom-model-row" class="has-field" hidden><span>自定义模型</span><input id="has-cloud-custom-model" class="text_pole" type="text" placeholder="输入模型 ID"></label>
                        <label class="has-field"><span>默认音色</span><div id="has-cloud-voice" class="has-voice-combobox"><button class="has-voice-combobox-toggle text_pole" type="button" aria-haspopup="listbox" aria-expanded="false"><span>选择音色</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="has-voice-combobox-popover" hidden><input class="has-voice-search text_pole" type="search" autocomplete="off" placeholder="搜索名称、ID、Locale、Gender" aria-label="搜索云 TTS 测试音色"><div class="has-voice-options" role="listbox"></div></div></div></label>
                        <div id="has-minimax-voice-actions" class="has-service-actions" hidden><button id="has-minimax-refresh-voices" class="menu_button" type="button"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 刷新官方音色</button><span id="has-minimax-voice-status" class="has-muted" role="status" aria-live="polite">填写 API Key 后可刷新</span></div>
                        <label class="has-field"><span>音频格式</span><select id="has-cloud-format" class="text_pole"><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>
                        <label class="has-field"><span>风格/情绪提示（可选）</span><input id="has-cloud-style" class="text_pole" type="text" maxlength="1000"></label>
                    </div>
                    <button id="has-profile-test" class="menu_button has-primary-action" type="button"><i class="fa-solid fa-plug" aria-hidden="true"></i> 测试连接</button>
                    <div id="has-provider-status" class="has-service-status has-muted" role="status" aria-live="polite">尚未测试连接。</div>
                    <label class="has-field"><span>试听文字</span><input id="has-profile-preview-text" class="text_pole" type="text" value="你好，很高兴见到你。"></label>
                    <div class="has-service-actions">
                        <button id="has-profile-preview" class="menu_button" type="button"><i class="fa-solid fa-play" aria-hidden="true"></i> 试听声音</button>
                        <button id="has-profile-preview-stop" class="menu_button" type="button"><i class="fa-solid fa-stop" aria-hidden="true"></i> 停止试听</button>
                    </div>
                </section>

                <section class="has-settings-card" data-testid="has-lightweight-step-playback">
                    <div class="has-step-heading"><span>3</span><div><strong>调整播放手感</strong><small>这些设置不会改变声音分配。</small></div></div>
                    <label class="has-field"><span>角色台词语速 <span id="has-synthesis-speed-value"></span></span><input id="has-synthesis-speed" type="range" min="0.5" max="3" step="0.1"></label>
                    <label class="has-field"><span>旁白语速 <span id="has-speed-value"></span></span><input id="has-speed" type="range" min="0.5" max="3" step="0.1"></label>
                    <label class="has-field"><span>音量 <span id="has-volume-value"></span></span><input id="has-volume" type="range" min="0" max="1" step="0.05"></label>
                    <label class="checkbox_label"><input id="has-shared-cache" type="checkbox"><span>PC 和手机共用已生成声音</span></label>
                    <div class="has-daily-hint"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>回到聊天后，可使用消息右上角按钮朗读整条、选中文字或当前段落；角色台词旁的小耳机只读该句。</span></div>
                </section>

                <details class="has-settings-fold" data-testid="has-advanced-settings">
                    <summary><i class="fa-solid fa-sliders" aria-hidden="true"></i><span><strong>高级 TTS 设置</strong><small>新建服务、精细路由、缓存和兼容选项</small></span></summary>
                    <div class="has-fold-content">
                        <div class="has-section-title">朗读方案管理</div>
                        <div class="has-service-actions">
                            <button id="has-preset-new" class="menu_button" type="button">新建方案</button>
                            <button id="has-preset-copy" class="menu_button" type="button">复制方案</button>
                            <button id="has-preset-rename" class="menu_button" type="button">重命名</button>
                            <button id="has-preset-delete" class="menu_button" type="button">删除方案</button>
                        </div>

                        <div class="has-section-title">声音服务详细配置</div>
                        <div class="has-service-actions">
                            <button id="has-profile-new" class="menu_button" type="button">新建服务</button>
                            <button id="has-profile-copy" class="menu_button" type="button">复制服务</button>
                            <button id="has-profile-delete" class="menu_button" type="button">删除服务</button>
                        </div>
                        <label class="has-field"><span>服务名称</span><input id="has-profile-name" class="text_pole" type="text"></label>
                        <label class="has-field"><span>服务类型</span><select id="has-profile-type" class="text_pole"><option value="openai-compatible">OpenAI 兼容</option><option value="edge">Edge</option><option value="doubao">豆包原生</option><option value="minimax">MiniMax 原生</option><option value="xiaomi-mimo">小米 MiMo 原生</option></select></label>
                        <label class="has-field" data-profile-types="openai-compatible"><span>接口地址</span><input id="has-profile-endpoint" class="text_pole" type="text"></label>
                        <label class="has-field" data-profile-types="openai-compatible minimax xiaomi-mimo"><span>API Key（共享设置，非加密）</span><input id="has-profile-api-key" class="text_pole" type="password" autocomplete="off"></label>
                        <label class="has-field" data-profile-types="openai-compatible minimax xiaomi-mimo"><span>模型</span><input id="has-profile-model" class="text_pole" type="text"></label>
                        <label class="has-field"><span>默认音色</span><input id="has-profile-voice" class="text_pole" type="text"></label>
                        <label class="has-field" data-profile-types="minimax"><span>MiniMax 区域</span><select id="has-profile-platform" class="text_pole"><option value="cn">国内站</option><option value="io">国际站</option></select></label>
                        <label class="has-field" data-profile-types="minimax xiaomi-mimo"><span>音频格式</span><select id="has-profile-format" class="text_pole"><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>
                        <label class="has-field" data-profile-types="minimax xiaomi-mimo"><span>风格/情绪提示</span><input id="has-profile-style" class="text_pole" type="text" maxlength="1000"></label>
                        <label class="has-field" data-profile-types="openai-compatible"><span>请求方式</span><select id="has-profile-request-mode" class="text_pole"><option value="server-proxy">酒馆服务器代理（推荐）</option><option value="direct">浏览器直连</option></select></label>
                        <div class="has-service-actions">
                            <button id="has-config-export" class="menu_button" type="button">导出配置</button>
                            <button id="has-config-import" class="menu_button" type="button">导入配置</button>
                            <input id="has-config-import-file" type="file" accept="application/json,.json" hidden>
                        </div>

                        <div class="has-section-title">旧设置兼容</div>
                        <label class="checkbox_label"><input id="has-read-narration" type="checkbox"><span>读取旁白</span></label>
                        <label class="checkbox_label"><input id="has-index-proxy" type="checkbox"><span>通过酒馆服务器代理 IndexTTS2（手机推荐）</span></label>
                        <label class="has-field"><span>IndexTTS2 接口地址</span><input id="has-tts-url" class="text_pole" type="text"></label>
                        <label class="has-field"><span>IndexTTS2 启动脚本</span><input id="has-index-start-bat" class="text_pole" type="text"></label>
                        <div class="has-service-actions"><button id="has-check-index" class="menu_button" type="button">检测 IndexTTS2</button><button id="has-start-index" class="menu_button" type="button">启动 API</button></div>
                        <div id="has-index-status" class="has-service-status has-muted" role="status" aria-live="polite">还未检测 IndexTTS2。</div>
                        <label class="has-field"><span>IndexTTS2 模型名</span><input id="has-tts-model" class="text_pole" type="text"></label>
                        <label class="has-field"><span>默认音色</span><input id="has-default-voice" class="text_pole" type="text" placeholder="default.wav"></label>
                        <label class="has-field"><span>Edge 旁白音色</span><input id="has-edge-voice" class="text_pole" type="text" placeholder="zh-CN-XiaoxiaoNeural"></label>
                        <div class="has-service-actions"><button id="has-check-edge" class="menu_button" type="button">检测 Edge</button><button id="has-test-edge" class="menu_button" type="button">测试 Edge 朗读</button></div>
                        <div id="has-edge-status" class="has-service-status has-muted" role="status" aria-live="polite">还未检测 Edge TTS。</div>

                        <div class="has-section-title">缓存与预取</div>
                        <label class="has-field"><span>预取段数</span><input id="has-prefetch-count" class="text_pole" type="number" inputmode="numeric" min="0" max="2" step="1"></label>
                        <label class="has-field"><span>共享缓存上限 MB</span><input id="has-shared-cache-max" class="text_pole" type="number" inputmode="numeric" min="64" max="102400" step="64"></label>
                        <label class="has-field"><span>本机缓存上限 MB</span><input id="has-local-cache-max" class="text_pole" type="number" inputmode="numeric" min="32" max="10240" step="32"></label>
                        <div class="has-service-actions"><button id="has-cache-stats" class="menu_button" type="button">缓存统计</button><button id="has-multidevice-check" class="menu_button" type="button">多端自检</button><button id="has-prune-shared-cache" class="menu_button" type="button">按上限清理</button><button id="has-clear-shared-cache" class="menu_button" type="button">清理共享缓存</button></div>
                        <div class="has-service-actions"><button id="has-clear-local-cache" class="menu_button" type="button">清理本机缓存</button><button id="has-cache-help" class="menu_button" type="button">缓存说明</button></div>
                        <div id="has-cache-status" class="has-service-status has-muted" role="status" aria-live="polite">共享缓存用于 PC/手机复用同一台酒馆服务器上的音频。</div>

                        <div class="has-section-title">特定角色声音</div>
                        <div id="has-voice-map"></div>
                        <div class="has-voice-add"><input id="has-add-character" class="text_pole" type="text" placeholder="角色名"><input id="has-add-voice" class="text_pole" type="text" placeholder="音色名"><button id="has-add-voice-row" class="menu_button" type="button">添加</button></div>
                    </div>
                </details>

                <details class="has-settings-fold" data-testid="has-legacy-stage-settings">
                    <summary><i class="fa-solid fa-film" aria-hidden="true"></i><span><strong>旧视频与字幕舞台</strong><small>保留原功能，日常轻量朗读无需设置</small></span></summary>
                    <div class="has-fold-content">
                        <label class="has-field"><span>整条有声书使用</span><select id="has-playback-ui" class="text_pole"><option value="player">纯播放器</option><option value="video">视频舞台</option></select></label>
                        <label class="checkbox_label"><input id="has-enabled" type="checkbox"><span>启用字幕舞台</span></label>
                        <label class="checkbox_label"><input id="has-auto" type="checkbox"><span>字幕自动播放</span></label>
                        <label class="checkbox_label"><input id="has-window" type="checkbox"><span>视频舞台使用独立窗口</span></label>
                        <label class="has-field"><span>视频地址</span><input id="has-video-url" class="text_pole" type="text" placeholder="/scripts/extensions/third-party/HybridAudiobookStage/assets/scene.mp4"></label>
                        <label class="has-field"><span>视频适配</span><select id="has-video-fit" class="text_pole"><option value="contain">完整显示</option><option value="cover">铺满裁切</option><option value="fill">拉伸填满</option></select></label>
                        <label class="has-field"><span>每句字幕秒数</span><input id="has-seconds" class="text_pole" type="number" inputmode="decimal" min="1" max="30" step="0.5"></label>
                        <div class="has-open-actions"><button id="has-open-audiobook" class="menu_button" type="button">听书面板</button><button id="has-open-stage" class="menu_button" type="button">视频舞台</button><button id="has-open-window" class="menu_button" type="button">独立窗口</button></div>
                    </div>
                </details>
            </div>
        </div>
    `;

    document.querySelector('#extensions_settings')?.appendChild(container);
    syncSettingsPanel(container);
    bindSettingsPanel(container);
    loadIndexTtsVoiceCatalog(container);
    const advanced = container.querySelector('[data-testid="has-advanced-settings"]');
    const legacy = container.querySelector('[data-testid="has-legacy-stage-settings"]');
    Object.assign(getAudit().lightweight_ui, {
        status: 'success',
        error: null,
        default_sections: container.querySelectorAll(':scope [data-testid^="has-lightweight-step-"]').length,
        advanced_collapsed: advanced ? !advanced.open : false,
        legacy_collapsed: legacy ? !legacy.open : false,
    });
}

function createStableId(prefix) {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${suffix}`;
}

function fillNamedSelect(select, records, selectedId) {
    if (!select) return;
    select.replaceChildren();
    for (const record of Object.values(records || {})) {
        if (!record?.id) continue;
        select.add(new Option(record.name || record.id, record.id, false, record.id === selectedId));
    }
}

const CUSTOM_VOICE_OPTION = '__custom_voice__';

function normalizeVoiceSearchText(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
}

function closeVoiceCombobox(control) {
    const popover = control?.querySelector?.('.has-voice-combobox-popover');
    const toggle = control?.querySelector?.('.has-voice-combobox-toggle');
    if (popover) popover.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
}

function filterVoiceCombobox(control, query = '') {
    const normalizedQuery = normalizeVoiceSearchText(query);
    let visibleCount = 0;
    for (const option of control?.querySelectorAll?.('.has-voice-option') || []) {
        option.hidden = !matchesVoiceSearch(option.dataset.search, normalizedQuery);
        if (!option.hidden) visibleCount += 1;
    }
    for (const group of control?.querySelectorAll?.('.has-voice-option-group') || []) {
        group.hidden = !group.querySelector('.has-voice-option:not([hidden])');
    }
    const empty = control?.querySelector?.('.has-voice-search-empty');
    if (empty) empty.hidden = visibleCount > 0;
}

function setVoiceComboboxValue(control, value, displayLabel = '') {
    if (!control) return;
    const normalized = String(value || '').trim();
    control.dataset.value = normalized;
    control.value = normalized;
    const selectedOption = Array.from(control.querySelectorAll('.has-voice-option'))
        .find(option => option.dataset.value === normalized);
    const label = displayLabel || selectedOption?.dataset.displayLabel || normalized || '选择音色';
    const labelNode = control.querySelector('.has-voice-combobox-toggle > span');
    if (labelNode) labelNode.textContent = label;
    for (const option of control.querySelectorAll('.has-voice-option')) {
        const selected = option.dataset.value === normalized;
        option.classList.toggle('has-selected', selected);
        option.setAttribute('aria-selected', String(selected));
    }
}

function ensureVoiceCombobox(control) {
    if (!control || control.dataset.comboboxBound === 'true') return;
    control.dataset.comboboxBound = 'true';
    const toggle = control.querySelector('.has-voice-combobox-toggle');
    const popover = control.querySelector('.has-voice-combobox-popover');
    const search = control.querySelector('.has-voice-search');
    toggle?.addEventListener('click', event => {
        event.preventDefault();
        const opening = popover?.hidden !== false;
        document.querySelectorAll('.has-voice-combobox').forEach(other => {
            if (other !== control) closeVoiceCombobox(other);
        });
        if (!popover) return;
        popover.hidden = !opening;
        toggle.setAttribute('aria-expanded', String(opening));
        if (opening) {
            search.value = '';
            filterVoiceCombobox(control, '');
            requestAnimationFrame(() => search.focus());
        }
    });
    search?.addEventListener('input', () => filterVoiceCombobox(control, search.value));
    search?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeVoiceCombobox(control);
            toggle?.focus();
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            control.querySelector('.has-voice-option:not([hidden])')?.focus();
        }
    });
    control.querySelector('.has-voice-options')?.addEventListener('click', event => {
        const option = event.target.closest('.has-voice-option');
        if (!option) return;
        event.preventDefault();
        setVoiceComboboxValue(control, option.dataset.value, option.dataset.displayLabel);
        closeVoiceCombobox(control);
        control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    control.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeVoiceCombobox(control);
    });
    document.addEventListener('pointerdown', event => {
        if (!control.contains(event.target)) closeVoiceCombobox(control);
    });
}

function addVoiceComboboxGroup(host, groupLabel, items) {
    if (!items.length) return;
    const group = document.createElement('div');
    group.className = 'has-voice-option-group';
    group.dataset.groupLabel = groupLabel;
    const heading = document.createElement('div');
    heading.className = 'has-voice-option-heading';
    heading.textContent = groupLabel;
    group.append(heading);
    for (const item of items) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'has-voice-option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.value;
        const primaryLabel = item.name || item.label;
        const secondaryLabel = item.meta || '';
        option.dataset.displayLabel = item.selectionLabel || primaryLabel;
        option.dataset.search = normalizeVoiceSearchText(`${groupLabel} ${primaryLabel} ${secondaryLabel} ${item.label} ${item.value} ${item.searchText || ''}`);
        option.title = secondaryLabel ? `${primaryLabel}\n${secondaryLabel}` : primaryLabel;
        const primary = document.createElement('span');
        primary.className = 'has-voice-option-name';
        primary.textContent = primaryLabel;
        option.append(primary);
        if (secondaryLabel) {
            const secondary = document.createElement('span');
            secondary.className = 'has-voice-option-meta';
            secondary.textContent = secondaryLabel;
            option.append(secondary);
        }
        group.append(option);
    }
    host.append(group);
}

function isIndexTtsProfile(profile) {
    if (!profile || profile.type !== 'openai-compatible') return false;
    return profile.id === LEGACY_OPENAI_PROFILE_ID
        || /index[\s_-]*tts/i.test(String(profile.model || profile.name || ''))
        || /127\.0\.0\.1:7880|localhost:7880/i.test(String(profile.endpoint || ''));
}

function getEdgeVoiceReadableName(voice) {
    const voiceId = String(voice?.voiceId || '').trim();
    const locale = String(voice?.locale || '').trim();
    return locale && voiceId.startsWith(`${locale}-`) ? voiceId.slice(locale.length + 1) : voiceId;
}

function fillRouteVoiceSelect(select, settings, profileId, selectedVoice = '') {
    if (!select) return;
    ensureVoiceCombobox(select);
    const voices = collectProfileVoiceOptions(settings, profileId, selectedVoice);
    const selected = String(selectedVoice || '').trim();
    const profile = settings?.providerProfiles?.[profileId];
    const isDoubao = profile?.type === 'doubao';
    const isEdge = profile?.type === 'edge';
    const isIndexTts = isIndexTtsProfile(profile);
    const isMinimax = profile?.type === 'minimax';
    const isXiaomiMimo = profile?.type === 'xiaomi-mimo';
    const minimaxVoices = normalizeDiscoveredMinimaxVoices(profile?.discoveredVoices);
    const host = select.querySelector('.has-voice-options');
    host.replaceChildren();
    const usedItems = [];
    for (const voiceId of voices) {
        const catalogVoice = isDoubao ? getDoubaoCatboxVoice(voiceId) : null;
        const edgeVoice = isEdge ? getEdgeCatalogVoice(voiceId) : null;
        const minimaxVoice = isMinimax ? minimaxVoices.find(voice => voice.voiceId === voiceId) : null;
        const xiaomiVoice = isXiaomiMimo ? getXiaomiMimoVoice(voiceId) : null;
        if (catalogVoice) {
            usedItems.push({
                value: voiceId,
                label: catalogVoice.name,
                name: catalogVoice.name,
                meta: voiceId,
                selectionLabel: catalogVoice.name,
            });
        } else if (edgeVoice) {
            const name = getEdgeVoiceReadableName(edgeVoice);
            usedItems.push({
                value: voiceId,
                label: name,
                name,
                meta: `${edgeVoice.locale} · ${edgeVoice.gender} · ${voiceId}`,
                selectionLabel: `${name} · ${edgeVoice.locale}`,
            });
        } else if (minimaxVoice) {
            usedItems.push({
                value: voiceId,
                label: minimaxVoice.name,
                name: minimaxVoice.name,
                meta: [minimaxVoice.description, voiceId].filter(Boolean).join(' · '),
                selectionLabel: minimaxVoice.name,
            });
        } else if (xiaomiVoice) {
            usedItems.push({
                value: voiceId,
                label: xiaomiVoice.name,
                name: xiaomiVoice.name,
                meta: `${xiaomiVoice.meta} · ${voiceId}`,
                selectionLabel: xiaomiVoice.name,
            });
        } else if (isIndexTts && /\.wav$/i.test(voiceId)) {
            const name = voiceId.replace(/\.wav$/i, '');
            usedItems.push({ value: voiceId, label: name, name, meta: voiceId, selectionLabel: name });
        } else {
            usedItems.push({ value: voiceId, label: voiceId });
        }
    }
    addVoiceComboboxGroup(host, voices.length ? '已使用的音色' : '尚无已使用音色', usedItems);

    if (isDoubao) {
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加音色 ID…' }]);
        const usedVoiceIds = new Set(voices);
        for (const group of DOUBAO_CATBOX_VOICE_GROUPS) {
            const items = [];
            for (const voice of group.voices) {
                if (usedVoiceIds.has(voice.voiceId)) continue;
                items.push({
                    value: voice.voiceId,
                    label: voice.name,
                    name: voice.name,
                    meta: voice.voiceId,
                    selectionLabel: voice.name,
                });
            }
            addVoiceComboboxGroup(host, `${group.label}（Seed ICL 2.0）`, items);
        }
    } else if (isEdge) {
        for (const group of getPrioritizedEdgeVoiceGroups(voices)) {
            const items = group.voices.map(voice => {
                const name = getEdgeVoiceReadableName(voice);
                const genderSearch = voice.gender === 'Male' ? '男 男声 male' : '女 女声 female';
                return {
                    value: voice.voiceId,
                    label: name,
                    name,
                    meta: `${voice.locale} · ${voice.gender} · ${voice.voiceId}`,
                    selectionLabel: `${name} · ${voice.locale}`,
                    searchText: `${voice.locale} ${voice.gender} ${genderSearch}`,
                };
            });
            addVoiceComboboxGroup(host, group.label, items);
        }
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加音色 ID…' }]);
    } else if (isIndexTts) {
        const usedVoiceIds = new Set(voices);
        addVoiceComboboxGroup(host, 'IndexTTS2 · ckyp 音色', indexTtsVoiceCatalog
            .filter(voiceId => !usedVoiceIds.has(voiceId))
            .map(voiceId => ({
                value: voiceId,
                label: voiceId.replace(/\.wav$/i, ''),
                name: voiceId.replace(/\.wav$/i, ''),
                meta: voiceId,
                searchText: 'IndexTTS2 ckyp',
            })));
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加音色 ID…' }]);
    } else if (isMinimax) {
        const usedVoiceIds = new Set(voices);
        const minimaxGroups = [
            ['MiniMax 官方系统音色', 'system'],
            ['MiniMax 我的复刻音色', 'voice_cloning'],
            ['MiniMax 我的生成音色', 'voice_generation'],
        ];
        for (const [label, kind] of minimaxGroups) {
            addVoiceComboboxGroup(host, label, minimaxVoices
                .filter(voice => voice.kind === kind && !usedVoiceIds.has(voice.voiceId))
                .map(voice => ({
                    value: voice.voiceId,
                    label: voice.name,
                    name: voice.name,
                    meta: [voice.description, voice.voiceId].filter(Boolean).join(' · '),
                    selectionLabel: voice.name,
                    searchText: `${voice.kind} ${voice.description}`,
                })));
        }
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加 Voice ID…' }]);
    } else if (isXiaomiMimo) {
        const usedVoiceIds = new Set(voices);
        addVoiceComboboxGroup(host, '小米 MiMo 预置音色', XIAOMI_MIMO_VOICES
            .filter(voice => !usedVoiceIds.has(voice.voiceId))
            .map(voice => ({
                value: voice.voiceId,
                label: voice.name,
                name: voice.name,
                meta: `${voice.meta} · ${voice.voiceId}`,
                selectionLabel: voice.name,
                searchText: voice.meta,
            })));
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加 Voice…' }]);
    } else {
        addVoiceComboboxGroup(host, '添加音色', [{ value: CUSTOM_VOICE_OPTION, label: '手动添加音色 ID…' }]);
    }
    const empty = document.createElement('div');
    empty.className = 'has-voice-search-empty';
    empty.textContent = '没有匹配的音色';
    empty.hidden = true;
    host.append(empty);
    setVoiceComboboxValue(select, voices.includes(selected) ? selected : (voices[0] || ''));
}

function warnIfDoubaoIclResourceMismatch(profile, voiceId) {
    if (profile?.type !== 'doubao' || !isDoubaoCatboxVoice(voiceId)) return;
    if (String(profile.resourceId || 'seed-tts-2.0') === DOUBAO_ICL_RESOURCE_ID) return;
    toastWarn('这个猫箱同款音色需要 Seed ICL 2.0；请在第 2 步把“资源类型”切换为 Seed ICL 2.0。');
}

function getActivePreset(settings = getSettings()) {
    return settings.routingPresets?.[settings.activeRoutingPresetId] || null;
}

function getEditingProfile(settings = getSettings()) {
    const profiles = settings.providerProfiles || {};
    if (!profiles[settings.editingProviderProfileId]) {
        settings.editingProviderProfileId = Object.keys(profiles)[0] || '';
    }
    return profiles[settings.editingProviderProfileId] || null;
}

function getSelectedProfile(container, settings = getSettings()) {
    const selectedId = String(container?.querySelector?.('#has-profile-select')?.value || '').trim();
    if (selectedId && settings.providerProfiles?.[selectedId]) {
        settings.editingProviderProfileId = selectedId;
        return settings.providerProfiles[selectedId];
    }
    return getEditingProfile(settings);
}

function renderCloudModelSelect(container, profile) {
    const select = container?.querySelector?.('#has-cloud-model');
    const customRow = container?.querySelector?.('#has-cloud-custom-model-row');
    const customInput = container?.querySelector?.('#has-cloud-custom-model');
    if (!select || !profile || !['minimax', 'xiaomi-mimo'].includes(profile.type)) return;
    const options = getCloudModelOptions(profile.type);
    const current = String(profile.model || (profile.type === 'minimax' ? 'speech-2.8-hd' : 'mimo-v2.5-tts')).trim();
    select.replaceChildren();
    for (const model of options) {
        const option = new Option(model.label, model.value, false, model.value === current);
        option.disabled = model.enabled === false;
        select.add(option);
    }
    const known = options.some(model => model.value === current);
    if (profile.type === 'minimax') {
        select.add(new Option('自定义模型…', CUSTOM_CLOUD_MODEL_OPTION, false, !known));
        if (customInput) customInput.value = known ? '' : current;
        if (customRow) customRow.hidden = known;
    } else {
        if (!known && current) select.add(new Option(`${current}（已有自定义配置）`, current, false, true));
        if (customInput) customInput.value = '';
        if (customRow) customRow.hidden = true;
    }
}

function readCloudModelValue(container, profile) {
    const selected = String(container?.querySelector?.('#has-cloud-model')?.value || '').trim();
    if (selected !== CUSTOM_CLOUD_MODEL_OPTION) return selected;
    return String(container?.querySelector?.('#has-cloud-custom-model')?.value || profile?.model || '').trim();
}

function syncRouteModeVisibility(container, mode = 'mixed') {
    const activeMode = ['mixed', 'dialogue-only', 'single-voice'].includes(mode) ? mode : 'mixed';
    for (const field of container?.querySelectorAll?.('[data-route-modes]') || []) {
        field.hidden = !String(field.dataset.routeModes || '').split(/\s+/).includes(activeMode);
    }
    const help = container?.querySelector?.('#has-route-help');
    if (help) {
        help.textContent = activeMode === 'mixed'
            ? '旁白和角色可以使用不同服务与音色。'
            : activeMode === 'dialogue-only'
                ? '只朗读已识别的角色台词，不读旁白。'
                : '整段正文使用同一个服务和音色。';
    }
}

function renderRouteOverrideWarning(container, preset) {
    const warning = container?.querySelector?.('#has-route-override-warning');
    const text = container?.querySelector?.('#has-route-override-warning-text');
    if (!warning || !text) return;
    const summary = summarizeCharacterOverrides(preset, LEGACY_OPENAI_PROFILE_ID);
    warning.hidden = summary.matchingProfile < 1;
    if (warning.hidden) {
        text.textContent = '';
        return;
    }
    text.textContent = `${summary.matchingProfile} 个特定角色仍使用 IndexTTS2（迁移），会覆盖上面的“角色默认使用”。`;
}

function syncProfileTypeVisibility(container, profile) {
    const type = profile?.type || 'openai-compatible';
    for (const field of container?.querySelectorAll?.('[data-profile-types]') || []) {
        field.hidden = !String(field.dataset.profileTypes || '').split(/\s+/).includes(type);
    }
    const doubaoQuick = container?.querySelector?.('#has-doubao-quick');
    if (doubaoQuick) doubaoQuick.hidden = type !== 'doubao';
    const cloudQuick = container?.querySelector?.('#has-cloud-quick');
    if (cloudQuick) cloudQuick.hidden = !['minimax', 'xiaomi-mimo'].includes(type);
    const cloudTitle = container?.querySelector?.('#has-cloud-quick-title');
    if (cloudTitle) cloudTitle.textContent = type === 'minimax' ? 'MiniMax 原生连接' : '小米 MiMo 原生连接';
    const platformRow = container?.querySelector?.('#has-cloud-platform-row');
    if (platformRow) platformRow.hidden = type !== 'minimax';
    const minimaxVoiceActions = container?.querySelector?.('#has-minimax-voice-actions');
    if (minimaxVoiceActions) minimaxVoiceActions.hidden = type !== 'minimax';
}

function renderTtsConfiguration(container = document.getElementById('has-settings')) {
    if (!container) return;
    const settings = getSettings();
    const preset = getActivePreset(settings);
    const profile = getEditingProfile(settings);

    fillNamedSelect(container.querySelector('#has-preset-select'), settings.routingPresets, settings.activeRoutingPresetId);
    fillNamedSelect(container.querySelector('#has-profile-select'), settings.providerProfiles, settings.editingProviderProfileId);
    for (const selector of ['#has-route-narration-profile', '#has-route-dialogue-profile', '#has-route-single-profile']) {
        fillNamedSelect(container.querySelector(selector), settings.providerProfiles, '');
    }

    if (preset) {
        container.querySelector('#has-preset-mode').value = preset.mode || 'mixed';
        container.querySelector('#has-route-narration-profile').value = preset.narration?.profileId || '';
        container.querySelector('#has-route-dialogue-profile').value = preset.dialogueDefault?.profileId || '';
        container.querySelector('#has-route-single-profile').value = preset.singleVoice?.profileId || '';
        fillRouteVoiceSelect(container.querySelector('#has-route-narration-voice'), settings, preset.narration?.profileId, preset.narration?.voiceId);
        fillRouteVoiceSelect(container.querySelector('#has-route-dialogue-voice'), settings, preset.dialogueDefault?.profileId, preset.dialogueDefault?.voiceId);
        fillRouteVoiceSelect(container.querySelector('#has-route-single-voice'), settings, preset.singleVoice?.profileId, preset.singleVoice?.voiceId);
    }
    syncRouteModeVisibility(container, preset?.mode || 'mixed');
    renderRouteOverrideWarning(container, preset);

    if (profile) {
        container.querySelector('#has-profile-name').value = profile.name || '';
        container.querySelector('#has-profile-type').value = profile.type || 'openai-compatible';
        container.querySelector('#has-profile-endpoint').value = profile.endpoint || '';
        container.querySelector('#has-profile-api-key').value = profile.apiKey || '';
        container.querySelector('#has-profile-model').value = profile.model || '';
        container.querySelector('#has-profile-voice').value = profile.type === 'edge' ? (profile.edgeVoice || '') : (profile.defaultVoice || '');
        container.querySelector('#has-profile-request-mode').value = profile.requestMode || 'server-proxy';
        container.querySelector('#has-profile-platform').value = profile.platform || 'cn';
        container.querySelector('#has-profile-format').value = profile.responseFormat || (profile.type === 'minimax' ? 'mp3' : 'wav');
        container.querySelector('#has-profile-style').value = profile.style || '';
        container.querySelector('#has-doubao-app-id').value = profile.appId || '';
        container.querySelector('#has-doubao-access-key').value = profile.accessKey || '';
        container.querySelector('#has-doubao-resource-id').value = profile.resourceId || 'seed-tts-2.0';
        fillRouteVoiceSelect(
            container.querySelector('#has-doubao-speaker-id'),
            settings,
            profile.id,
            profile.defaultVoice || '',
        );
        container.querySelector('#has-doubao-context-text').value = profile.contextText || '';
        container.querySelector('#has-cloud-api-key').value = ['minimax', 'xiaomi-mimo'].includes(profile.type) ? (profile.apiKey || '') : '';
        container.querySelector('#has-cloud-platform').value = profile.platform || 'cn';
        renderCloudModelSelect(container, profile);
        fillRouteVoiceSelect(container.querySelector('#has-cloud-voice'), settings, profile.id, profile.defaultVoice || '');
        container.querySelector('#has-cloud-format').value = profile.responseFormat || (profile.type === 'minimax' ? 'mp3' : 'wav');
        container.querySelector('#has-cloud-style').value = profile.style || '';
    }
    syncProfileTypeVisibility(container, profile);
}

function profileReferences(profileId, settings = getSettings()) {
    const references = [];
    for (const preset of Object.values(settings.routingPresets || {})) {
        const used = preset?.narration?.profileId === profileId
            || preset?.dialogueDefault?.profileId === profileId
            || preset?.singleVoice?.profileId === profileId
            || Object.values(preset?.characterOverrides || {}).some(route => route?.profileId === profileId);
        if (used) references.push(preset.name || preset.id);
    }
    return references;
}

function downloadTtsConfiguration(settings = getSettings()) {
    const blob = new Blob([JSON.stringify({
        version: 3,
        providerProfiles: settings.providerProfiles,
        routingPresets: settings.routingPresets,
        activeRoutingPresetId: settings.activeRoutingPresetId,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `HybridAudiobookStage-TTS-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function bindTtsConfiguration(container, settings) {
    container.querySelector('#has-preset-select')?.addEventListener('change', event => {
        settings.activeRoutingPresetId = event.target.value;
        const preset = getActivePreset(settings);
        settings.readNarration = preset?.mode !== 'dialogue-only';
        saveSettings();
        syncSettingsPanel(container);
        invalidateSynthesisRouting('routing_preset_changed');
    });
    container.querySelector('#has-preset-new')?.addEventListener('click', () => {
        const name = prompt('新预设名称', '新朗读预设')?.trim();
        if (!name) return;
        const source = getActivePreset(settings);
        const id = createStableId('preset');
        settings.routingPresets[id] = structuredClone({ ...source, id, name });
        settings.activeRoutingPresetId = id;
        saveSettings();
        syncSettingsPanel(container);
        invalidateSynthesisRouting('routing_preset_changed');
    });
    container.querySelector('#has-preset-copy')?.addEventListener('click', () => {
        const source = getActivePreset(settings);
        if (!source) return;
        const id = createStableId('preset');
        settings.routingPresets[id] = structuredClone({ ...source, id, name: `${source.name || '预设'} 副本` });
        settings.activeRoutingPresetId = id;
        saveSettings();
        syncSettingsPanel(container);
        invalidateSynthesisRouting('routing_preset_changed');
    });
    container.querySelector('#has-preset-rename')?.addEventListener('click', () => {
        const preset = getActivePreset(settings);
        if (!preset) return;
        const name = prompt('预设名称', preset.name || '')?.trim();
        if (!name) return;
        preset.name = name;
        saveSettings();
        renderTtsConfiguration(container);
    });
    container.querySelector('#has-preset-delete')?.addEventListener('click', () => {
        const ids = Object.keys(settings.routingPresets || {});
        if (ids.length <= 1) return toastWarn('至少保留一套朗读预设');
        if (!confirm('确定删除当前朗读预设吗？')) return;
        delete settings.routingPresets[settings.activeRoutingPresetId];
        settings.activeRoutingPresetId = Object.keys(settings.routingPresets)[0];
        saveSettings();
        syncSettingsPanel(container);
        invalidateSynthesisRouting('routing_preset_changed');
    });

    const updatePreset = () => {
        const preset = getActivePreset(settings);
        if (!preset) return;
        preset.mode = container.querySelector('#has-preset-mode').value;
        preset.narration = {
            profileId: container.querySelector('#has-route-narration-profile').value,
            voiceId: container.querySelector('#has-route-narration-voice').value,
        };
        preset.dialogueDefault = {
            profileId: container.querySelector('#has-route-dialogue-profile').value,
            voiceId: container.querySelector('#has-route-dialogue-voice').value,
        };
        preset.singleVoice = {
            profileId: container.querySelector('#has-route-single-profile').value,
            voiceId: container.querySelector('#has-route-single-voice').value,
        };
        settings.readNarration = preset.mode !== 'dialogue-only';
        saveSettings();
        syncRouteModeVisibility(container, preset.mode);
        renderVoiceMap(container);
        invalidateSynthesisRouting('tts_route_changed');
    };
    container.querySelector('#has-preset-mode')?.addEventListener('change', updatePreset);
    const routeControls = [
        ['#has-route-narration-profile', '#has-route-narration-voice', 'narration'],
        ['#has-route-dialogue-profile', '#has-route-dialogue-voice', 'dialogueDefault'],
        ['#has-route-single-profile', '#has-route-single-voice', 'singleVoice'],
    ];
    for (const [profileSelector, voiceSelector, routeKey] of routeControls) {
        const profileSelect = container.querySelector(profileSelector);
        const voiceSelect = container.querySelector(voiceSelector);
        profileSelect?.addEventListener('change', () => {
            const profileId = profileSelect.value;
            const voiceId = chooseProfileVoice(settings, profileId);
            fillRouteVoiceSelect(voiceSelect, settings, profileId, voiceId);
            updatePreset();
        });
        voiceSelect?.addEventListener('change', () => {
            if (voiceSelect.value !== CUSTOM_VOICE_OPTION) {
                const profileId = profileSelect?.value || '';
                const voiceId = voiceSelect.value;
                const profile = settings.providerProfiles?.[profileId];
                warnIfDoubaoIclResourceMismatch(profile, voiceId);
                rememberProfileVoice(profile, voiceId);
                updatePreset();
                fillRouteVoiceSelect(voiceSelect, settings, profileId, voiceId);
                return;
            }
            const profileId = profileSelect?.value || '';
            const profile = settings.providerProfiles?.[profileId];
            const voiceId = prompt('输入新的音色 ID', '')?.trim();
            if (!voiceId || !profile) {
                const previous = getActivePreset(settings)?.[routeKey]?.voiceId || '';
                fillRouteVoiceSelect(voiceSelect, settings, profileId, previous);
                return;
            }
            rememberProfileVoice(profile, voiceId);
            fillRouteVoiceSelect(voiceSelect, settings, profileId, voiceId);
            warnIfDoubaoIclResourceMismatch(profile, voiceId);
            updatePreset();
        });
    }

    container.querySelector('#has-clear-legacy-index-overrides')?.addEventListener('click', () => {
        const preset = getActivePreset(settings);
        const summary = summarizeCharacterOverrides(preset, LEGACY_OPENAI_PROFILE_ID);
        if (!summary.matchingProfile) return renderRouteOverrideWarning(container, preset);
        if (!confirm(`确定清除 ${summary.matchingProfile} 个仍指向 IndexTTS2（迁移）的特定角色覆盖吗？这些角色之后会跟随“角色默认使用”。`)) return;
        const removed = removeCharacterOverridesByProfile(
            preset,
            LEGACY_OPENAI_PROFILE_ID,
            settings.voiceMap,
        );
        saveSettings();
        renderTtsConfiguration(container);
        renderVoiceMap(container);
        invalidateSynthesisRouting('character_overrides_changed');
        toastSuccess(`已清除 ${removed.length} 个旧 Index 角色覆盖`);
    });

    container.querySelector('#has-profile-select')?.addEventListener('change', event => {
        settings.editingProviderProfileId = event.target.value;
        saveSettings();
        renderTtsConfiguration(container);
    });
    container.querySelector('#has-profile-new')?.addEventListener('click', () => {
        const id = createStableId('profile');
        settings.providerProfiles[id] = {
            id, name: '新 TTS Profile', type: 'openai-compatible', enabled: true,
            endpoint: '', apiKey: '', model: '', defaultVoice: '', responseFormat: 'wav', extraBody: {}, requestMode: 'server-proxy',
        };
        settings.editingProviderProfileId = id;
        saveSettings();
        renderTtsConfiguration(container);
    });
    container.querySelector('#has-profile-copy')?.addEventListener('click', () => {
        const profile = getEditingProfile(settings);
        if (!profile) return;
        const id = createStableId('profile');
        settings.providerProfiles[id] = structuredClone({ ...profile, id, name: `${profile.name || 'Profile'} 副本` });
        settings.editingProviderProfileId = id;
        saveSettings();
        renderTtsConfiguration(container);
    });
    container.querySelector('#has-profile-delete')?.addEventListener('click', () => {
        const profile = getEditingProfile(settings);
        if (!profile) return;
        const references = profileReferences(profile.id, settings);
        if (references.length) return toastWarn(`该 Profile 正被预设使用：${references.join('、')}`);
        delete settings.providerProfiles[profile.id];
        settings.editingProviderProfileId = Object.keys(settings.providerProfiles)[0] || '';
        saveSettings();
        renderTtsConfiguration(container);
    });

    const updateProfile = () => {
        const profile = getEditingProfile(settings);
        if (!profile) return;
        const previousSynthesisSettings = stableSerialize({
            type: profile.type,
            endpoint: profile.endpoint,
            model: profile.model,
            edgeVoice: profile.edgeVoice,
            defaultVoice: profile.defaultVoice,
            platform: profile.platform,
            responseFormat: profile.responseFormat,
            style: profile.style,
        });
        profile.name = container.querySelector('#has-profile-name').value.trim() || profile.id;
        profile.type = container.querySelector('#has-profile-type').value;
        profile.endpoint = container.querySelector('#has-profile-endpoint').value.trim();
        profile.apiKey = container.querySelector('#has-profile-api-key').value;
        profile.model = container.querySelector('#has-profile-model').value.trim();
        profile.requestMode = container.querySelector('#has-profile-request-mode').value;
        profile.platform = container.querySelector('#has-profile-platform').value || 'cn';
        profile.responseFormat = container.querySelector('#has-profile-format').value || (profile.type === 'minimax' ? 'mp3' : 'wav');
        profile.style = container.querySelector('#has-profile-style').value.trim();
        const voice = container.querySelector('#has-profile-voice').value.trim();
        if (profile.type === 'edge') profile.edgeVoice = voice;
        else profile.defaultVoice = voice;
        if (profile.type === 'doubao') {
            profile.resourceId ||= 'seed-tts-2.0';
            profile.requestMode = 'server-proxy';
        }
        if (['minimax', 'xiaomi-mimo'].includes(profile.type)) profile.requestMode = 'server-proxy';
        saveSettings();
        renderTtsConfiguration(container);
        const nextSynthesisSettings = stableSerialize({
            type: profile.type,
            endpoint: profile.endpoint,
            model: profile.model,
            edgeVoice: profile.edgeVoice,
            defaultVoice: profile.defaultVoice,
            platform: profile.platform,
            responseFormat: profile.responseFormat,
            style: profile.style,
        });
        if (previousSynthesisSettings !== nextSynthesisSettings) {
            invalidateSynthesisRouting('provider_synthesis_settings_changed');
        }
    };
    for (const selector of [
        '#has-profile-name', '#has-profile-type', '#has-profile-endpoint', '#has-profile-api-key',
        '#has-profile-model', '#has-profile-voice', '#has-profile-request-mode',
        '#has-profile-platform', '#has-profile-format', '#has-profile-style',
    ]) container.querySelector(selector)?.addEventListener('change', updateProfile);

    const updateDoubaoProfile = () => {
        const profile = getSelectedProfile(container, settings);
        if (!profile || profile.type !== 'doubao') return;
        const previousSynthesisSettings = stableSerialize({
            resourceId: profile.resourceId,
            defaultVoice: profile.defaultVoice,
            contextText: profile.contextText,
        });
        profile.appId = container.querySelector('#has-doubao-app-id').value.trim();
        profile.accessKey = container.querySelector('#has-doubao-access-key').value;
        profile.resourceId = container.querySelector('#has-doubao-resource-id').value || 'seed-tts-2.0';
        profile.defaultVoice = String(container.querySelector('#has-doubao-speaker-id').value || '').trim();
        profile.contextText = container.querySelector('#has-doubao-context-text').value.trim();
        profile.requestMode = 'server-proxy';
        saveSettings();
        renderTtsConfiguration(container);
        const nextSynthesisSettings = stableSerialize({
            resourceId: profile.resourceId,
            defaultVoice: profile.defaultVoice,
            contextText: profile.contextText,
        });
        if (previousSynthesisSettings !== nextSynthesisSettings) {
            invalidateSynthesisRouting('doubao_synthesis_settings_changed');
        }
    };
    for (const selector of [
        '#has-doubao-app-id', '#has-doubao-access-key', '#has-doubao-resource-id',
        '#has-doubao-context-text',
    ]) container.querySelector(selector)?.addEventListener('change', updateDoubaoProfile);
    const doubaoSpeakerSelect = container.querySelector('#has-doubao-speaker-id');
    doubaoSpeakerSelect?.addEventListener('change', () => {
        const profile = getSelectedProfile(container, settings);
        if (!profile || profile.type !== 'doubao') return;
        if (doubaoSpeakerSelect.value === CUSTOM_VOICE_OPTION) {
            const voiceId = prompt('输入新的 Speaker ID', '')?.trim();
            if (!voiceId) {
                fillRouteVoiceSelect(doubaoSpeakerSelect, settings, profile.id, profile.defaultVoice || '');
                return;
            }
            rememberProfileVoice(profile, voiceId);
            fillRouteVoiceSelect(doubaoSpeakerSelect, settings, profile.id, voiceId);
        } else {
            rememberProfileVoice(profile, doubaoSpeakerSelect.value);
        }
        warnIfDoubaoIclResourceMismatch(profile, doubaoSpeakerSelect.value);
        updateDoubaoProfile();
    });

    const updateCloudProfile = () => {
        const profile = getSelectedProfile(container, settings);
        if (!profile || !['minimax', 'xiaomi-mimo'].includes(profile.type)) return;
        profile.apiKey = container.querySelector('#has-cloud-api-key').value;
        profile.platform = container.querySelector('#has-cloud-platform').value || 'cn';
        profile.model = readCloudModelValue(container, profile)
            || (profile.type === 'minimax' ? 'speech-2.8-hd' : 'mimo-v2.5-tts');
        profile.defaultVoice = String(container.querySelector('#has-cloud-voice').value || '').trim();
        profile.responseFormat = container.querySelector('#has-cloud-format').value || (profile.type === 'minimax' ? 'mp3' : 'wav');
        profile.style = container.querySelector('#has-cloud-style').value.trim();
        profile.requestMode = 'server-proxy';
        saveSettings();
        renderTtsConfiguration(container);
        invalidateSynthesisRouting('cloud_synthesis_settings_changed');
    };
    for (const selector of [
        '#has-cloud-api-key', '#has-cloud-platform', '#has-cloud-format', '#has-cloud-style',
    ]) container.querySelector(selector)?.addEventListener('change', updateCloudProfile);
    container.querySelector('#has-cloud-model')?.addEventListener('change', event => {
        const profile = getSelectedProfile(container, settings);
        const customRow = container.querySelector('#has-cloud-custom-model-row');
        if (event.target.value === CUSTOM_CLOUD_MODEL_OPTION) {
            customRow.hidden = false;
            container.querySelector('#has-cloud-custom-model')?.focus();
            return;
        }
        customRow.hidden = true;
        if (profile?.type === 'xiaomi-mimo' && event.target.selectedOptions?.[0]?.disabled) return;
        updateCloudProfile();
    });
    container.querySelector('#has-cloud-custom-model')?.addEventListener('change', updateCloudProfile);
    const cloudVoiceSelect = container.querySelector('#has-cloud-voice');
    cloudVoiceSelect?.addEventListener('change', () => {
        const profile = getSelectedProfile(container, settings);
        if (!profile || !['minimax', 'xiaomi-mimo'].includes(profile.type)) return;
        if (cloudVoiceSelect.value === CUSTOM_VOICE_OPTION) {
            const label = profile.type === 'minimax' ? 'Voice ID' : 'Voice';
            const voiceId = prompt(`输入新的 ${label}`, '')?.trim();
            if (!voiceId) {
                fillRouteVoiceSelect(cloudVoiceSelect, settings, profile.id, profile.defaultVoice || '');
                return;
            }
            rememberProfileVoice(profile, voiceId);
            fillRouteVoiceSelect(cloudVoiceSelect, settings, profile.id, voiceId);
        } else {
            rememberProfileVoice(profile, cloudVoiceSelect.value);
        }
        updateCloudProfile();
    });
    container.querySelector('#has-minimax-refresh-voices')?.addEventListener('click', async event => {
        const profile = getSelectedProfile(container, settings);
        if (!profile || profile.type !== 'minimax') return;
        const apiKey = container.querySelector('#has-cloud-api-key').value;
        const platform = container.querySelector('#has-cloud-platform').value || 'cn';
        if (!apiKey.trim()) return toastWarn('请先填写 MiniMax API Key');
        const button = event.currentTarget;
        const status = container.querySelector('#has-minimax-voice-status');
        const audit = beginAuditRun('minimax-voice-discovery');
        button.disabled = true;
        status.textContent = '正在刷新官方音色…';
        try {
            const response = await fetch('/api/plugins/hybrid-audiobook-stage/minimax-tts/voices', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ apiKey, platform }),
            });
            if (!response.ok) throw new Error((await response.text()).slice(0, 300) || `HTTP ${response.status}`);
            const payload = await response.json();
            const voices = normalizeDiscoveredMinimaxVoices(payload?.voices);
            profile.apiKey = apiKey;
            profile.platform = platform;
            profile.discoveredVoices = voices;
            profile.voiceCatalogUpdatedAt = Date.now();
            saveSettings();
            renderTtsConfiguration(container);
            const nextStatus = container.querySelector('#has-minimax-voice-status');
            nextStatus.textContent = `已加载 ${voices.length} 个音色`;
            Object.assign(audit.provider_ready, {
                status: 'success', error: null, profile_id: profile.id, provider_type: profile.type,
                probe_ok: true, voice_count: voices.length,
            });
        } catch (error) {
            const message = error?.message || 'MiniMax 音色刷新失败';
            status.textContent = `刷新失败：${message}`;
            Object.assign(audit.provider_ready, {
                status: 'fail', error: message, profile_id: profile.id, provider_type: profile.type, probe_ok: false,
            });
            audit.last_error = message;
            toastError(message);
        } finally {
            button.disabled = false;
        }
    });

    container.querySelector('#has-profile-test')?.addEventListener('click', async () => {
        const audit = beginAuditRun('provider-probe');
        const profile = getSelectedProfile(container, settings);
        setServiceStatus('has-provider-status', '正在检测 Provider...', 'muted');
        try {
            const result = await providerRegistry.probe(profile);
            Object.assign(audit.provider_ready, {
                status: 'success', error: null, profile_id: profile.id, provider_type: profile.type, probe_ok: result.ok !== false,
            });
            setServiceStatus(
                'has-provider-status',
                result.unverified
                    ? `配置完整：${profile.name}，请点击“试听声音”完成真实 API 验证`
                    : `连接成功：${profile.name}`,
                'ok',
            );
        } catch (error) {
            Object.assign(audit.provider_ready, {
                status: 'fail', error: error.message, profile_id: profile?.id || null, provider_type: profile?.type || null, probe_ok: false,
            });
            audit.last_error = error?.message || String(error);
            setServiceStatus('has-provider-status', `连接失败：${error.message}`, 'bad');
        }
    });
    container.querySelector('#has-profile-preview')?.addEventListener('click', async () => {
        const profile = getSelectedProfile(container, settings);
        if (!profile) return;
        const voiceId = profile.type === 'edge'
            ? String(profile.edgeVoice || '').trim()
            : String(profile.defaultVoice || '').trim();
        const text = container.querySelector('#has-profile-preview-text').value.trim();
        await playLightweightText(text, { source: 'preview', profileId: profile.id, voiceId });
    });
    container.querySelector('#has-profile-preview-stop')?.addEventListener('click', stopCurrentPlayback);

    container.querySelector('#has-config-export')?.addEventListener('click', () => downloadTtsConfiguration(settings));
    container.querySelector('#has-config-import')?.addEventListener('click', () => container.querySelector('#has-config-import-file')?.click());
    container.querySelector('#has-config-import-file')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!data.providerProfiles || !data.routingPresets) throw new Error('文件缺少 Provider 或预设数据');
            settings.providerProfiles = { ...settings.providerProfiles, ...data.providerProfiles };
            settings.routingPresets = { ...settings.routingPresets, ...data.routingPresets };
            if (settings.routingPresets[data.activeRoutingPresetId]) settings.activeRoutingPresetId = data.activeRoutingPresetId;
            ensureTtsSettingsV2(settings);
            saveSettings();
            syncSettingsPanel(container);
            invalidateSynthesisRouting('tts_configuration_imported');
            toastSuccess('TTS 配置已导入');
        } catch (error) {
            toastError(`导入失败：${error.message}`);
        }
    });
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
    container.querySelector('#has-local-cache-max').value = String(Math.max(32, Math.min(10240, Number(settings.localAudioCacheMaxMb) || 512)));
    container.querySelector('#has-speed').value = String(settings.playbackRate || 1);
    container.querySelector('#has-synthesis-speed').value = String(settings.dialoguePlaybackRate || 1);
    container.querySelector('#has-prefetch-count').value = String(Math.max(0, Math.min(2, Number(settings.prefetchCount) || 2)));
    container.querySelector('#has-volume').value = String(settings.volume ?? 1);
    container.querySelector('#has-speed-value').textContent = `${Number(settings.playbackRate || 1).toFixed(1)}x`;
    container.querySelector('#has-synthesis-speed-value').textContent = `${Number(settings.dialoguePlaybackRate || 1).toFixed(1)}x`;
    container.querySelector('#has-volume-value').textContent = Number(settings.volume ?? 1).toFixed(2);
    container.querySelector('#has-enabled').checked = !!settings.enabled;
    container.querySelector('#has-auto').checked = !!settings.autoAdvance;
    container.querySelector('#has-window').checked = !!settings.openInWindow;
    container.querySelector('#has-video-url').value = settings.videoUrl || defaultSettings.videoUrl;
    container.querySelector('#has-video-fit').value = settings.videoFit || defaultSettings.videoFit;
    container.querySelector('#has-seconds').value = String(settings.secondsPerSubtitle || defaultSettings.secondsPerSubtitle);
    renderTtsConfiguration(container);
    renderVoiceMap(container);
}

function renderVoiceMap(container = document.getElementById('has-settings')) {
    const root = container?.querySelector('#has-voice-map');
    if (!root) return;
    const settings = getSettings();
    const preset = getActivePreset(settings);
    preset.characterOverrides ||= {};
    const legacyEntries = Object.fromEntries(Object.entries(settings.voiceMap || {}).map(([character, voiceId]) => [character, {
        profileId: preset.dialogueDefault?.profileId || LEGACY_OPENAI_PROFILE_ID,
        voiceId,
    }]));
    const overrides = { ...legacyEntries, ...preset.characterOverrides };
    const entries = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'));
    root.innerHTML = entries.length ? '' : '<div class="has-empty">还没有配置角色音色。</div>';
    for (const [character, route] of entries) {
        const row = document.createElement('div');
        row.className = 'has-voice-row';
        row.innerHTML = `
            <input class="text_pole has-character" type="text">
            <select class="text_pole has-character-profile"></select>
            <input class="text_pole has-voice" type="text">
            <button class="menu_button has-delete-voice" type="button">删除</button>
        `;
        row.querySelector('.has-character').value = character;
        fillNamedSelect(row.querySelector('.has-character-profile'), settings.providerProfiles, route.profileId);
        row.querySelector('.has-character-profile').value = route.profileId || '';
        row.querySelector('.has-voice').value = route.voiceId || '';
        row.querySelector('.has-character').addEventListener('change', event => {
            const nextCharacter = event.target.value.trim();
            if (!nextCharacter || nextCharacter === character) return;
            preset.characterOverrides[nextCharacter] = preset.characterOverrides[character] || route;
            settings.voiceMap[nextCharacter] = preset.characterOverrides[nextCharacter].voiceId;
            delete preset.characterOverrides[character];
            delete settings.voiceMap[character];
            saveSettings();
            renderVoiceMap(container);
            invalidateSynthesisRouting('character_override_changed');
        });
        row.querySelector('.has-character-profile').addEventListener('change', event => {
            preset.characterOverrides[character] ||= { profileId: '', voiceId: route.voiceId || '' };
            preset.characterOverrides[character].profileId = event.target.value;
            saveSettings();
            invalidateSynthesisRouting('character_override_changed');
        });
        row.querySelector('.has-voice').addEventListener('change', event => {
            const voiceId = event.target.value.trim();
            preset.characterOverrides[character] ||= { profileId: route.profileId || preset.dialogueDefault?.profileId || '', voiceId: '' };
            preset.characterOverrides[character].voiceId = voiceId;
            settings.voiceMap[character] = voiceId;
            saveSettings();
            invalidateSynthesisRouting('character_override_changed');
        });
        row.querySelector('.has-delete-voice').addEventListener('click', () => {
            delete preset.characterOverrides[character];
            delete settings.voiceMap[character];
            saveSettings();
            renderVoiceMap(container);
            invalidateSynthesisRouting('character_override_changed');
        });
        root.appendChild(row);
    }
}

function bindSettingsPanel(container) {
    const settings = getSettings();
    bindTtsConfiguration(container, settings);
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
    bindCheckbox('#has-read-narration', 'readNarration', () => {
        const preset = getActivePreset(settings);
        if (preset) preset.mode = settings.readNarration === false ? 'dialogue-only' : 'mixed';
        saveSettings();
        renderTtsConfiguration(container);
        invalidateSynthesisRouting('reading_mode_changed');
    });
    bindCheckbox('#has-shared-cache', 'sharedAudioCacheEnabled');
    bindCheckbox('#has-index-proxy', 'useServerIndexTtsProxy');
    bindInput('#has-playback-ui', 'audiobookPlaybackUi', value => value === 'player' ? 'player' : 'video');
    bindInput('#has-tts-url', 'ttsApiUrl', value => value.trim() || defaultSettings.ttsApiUrl);
    bindInput('#has-index-start-bat', 'indexTtsStartBat', value => value.trim() || defaultSettings.indexTtsStartBat);
    bindInput('#has-tts-model', 'ttsModel', value => value.trim() || defaultSettings.ttsModel);
    bindInput('#has-default-voice', 'defaultVoice', ensureWavSuffix);
    bindInput('#has-edge-voice', 'edgeVoice', value => value.trim() || defaultSettings.edgeVoice);
    bindInput('#has-shared-cache-max', 'sharedAudioCacheMaxMb', normalizeCacheLimitMb);
    bindInput('#has-local-cache-max', 'localAudioCacheMaxMb', value => Math.max(32, Math.min(10240, Number(value) || 512)));
    container.querySelector('#has-speed')?.addEventListener('input', event => {
        settings.playbackRate = Number(event.target.value) || 1;
        container.querySelector('#has-speed-value').textContent = `${settings.playbackRate.toFixed(1)}x`;
        applyPlaybackSettings(currentPlayback.audio, currentPlayback.playlist?.[currentPlayback.index]);
        saveSettings();
    });
    container.querySelector('#has-synthesis-speed')?.addEventListener('input', event => {
        settings.dialoguePlaybackRate = Number(event.target.value) || 1;
        container.querySelector('#has-synthesis-speed-value').textContent = `${settings.dialoguePlaybackRate.toFixed(1)}x`;
        applyPlaybackSettings(currentPlayback.audio, currentPlayback.playlist?.[currentPlayback.index]);
        saveSettings();
    });
    container.querySelector('#has-prefetch-count')?.addEventListener('change', event => {
        settings.prefetchCount = Math.max(0, Math.min(2, Number(event.target.value) || 0));
        event.target.value = String(settings.prefetchCount);
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
        const voice = voiceInput.value.trim();
        if (!character) {
            toastWarn('请先填写角色名');
            return;
        }
        settings.voiceMap[character] = voice;
        const preset = getActivePreset(settings);
        preset.characterOverrides ||= {};
        preset.characterOverrides[character] = {
            profileId: preset.dialogueDefault?.profileId || LEGACY_OPENAI_PROFILE_ID,
            voiceId: voice,
        };
        characterInput.value = '';
        voiceInput.value = '';
        saveSettings();
        renderVoiceMap(container);
        invalidateSynthesisRouting('character_override_changed');
    });

    container.querySelector('#has-tts-url')?.addEventListener('change', () => {
        const profile = settings.providerProfiles?.[LEGACY_OPENAI_PROFILE_ID];
        if (profile) profile.endpoint = settings.ttsApiUrl;
        saveSettings();
        invalidateSynthesisRouting('legacy_endpoint_changed');
    });
    container.querySelector('#has-tts-model')?.addEventListener('change', () => {
        const profile = settings.providerProfiles?.[LEGACY_OPENAI_PROFILE_ID];
        if (profile) profile.model = settings.ttsModel;
        saveSettings();
        invalidateSynthesisRouting('legacy_model_changed');
    });
    container.querySelector('#has-default-voice')?.addEventListener('change', () => {
        const profile = settings.providerProfiles?.[LEGACY_OPENAI_PROFILE_ID];
        if (profile) profile.defaultVoice = settings.defaultVoice;
        saveSettings();
        invalidateSynthesisRouting('legacy_voice_changed');
    });
    container.querySelector('#has-edge-voice')?.addEventListener('change', () => {
        const profile = settings.providerProfiles?.[LEGACY_EDGE_PROFILE_ID];
        if (profile) profile.edgeVoice = settings.edgeVoice;
        saveSettings();
        invalidateSynthesisRouting('legacy_voice_changed');
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
    if (stageState.linked && currentPlayback.session) {
        stopCurrentPlayback();
        document.getElementById('has-stage')?.classList.remove('has-open');
        return;
    }
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
        <button class="has-floating-action has-play-selection" type="button" title="朗读选中文字"><i class="fa-solid fa-i-cursor"></i></button>
        <button class="has-floating-action has-play-paragraph" type="button" title="朗读当前段落"><i class="fa-solid fa-paragraph"></i></button>
        <details class="has-msg-more">
            <summary title="更多 TTS 操作" aria-label="更多 TTS 操作"><i class="fa-solid fa-ellipsis"></i></summary>
            <div class="has-msg-more-menu">
                <button class="has-floating-action has-infer-msg" type="button" title="预生成人物台词"><i class="fa-solid fa-wand-magic-sparkles"></i><span>预生成角色台词</span></button>
                <button class="has-floating-action has-check-msg" type="button" title="检查台词标签与音色"><i class="fa-solid fa-list-check"></i><span>检查台词与音色</span></button>
                <button class="has-floating-action has-config-msg" type="button" title="打开轻量 TTS 设置"><i class="fa-solid fa-cog"></i><span>打开 TTS 设置</span></button>
            </div>
        </details>
    `;
    target.prepend(group);
}

function captureLatestTextSelection() {
    const selection = window.getSelection?.();
    const text = normalizeWhitespace(selection?.toString?.() || '');
    if (!text || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer?.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
    const msg = node?.closest?.('.mes');
    if (!msg || !node?.closest?.('.mes_text')) return;
    const paragraph = node.closest?.('p, li, blockquote, div');
    latestTextSelection = {
        text: text.slice(0, 10000),
        paragraphText: normalizeWhitespace(paragraph?.innerText || text).slice(0, 10000),
        messageId: getMessageId(msg),
        msg,
    };
    const button = ensureSelectionSpeakButton();
    button.classList.add('visible');
}

function ensureSelectionSpeakButton() {
    let button = document.getElementById('has-selection-speak');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'has-selection-speak';
    button.type = 'button';
    button.className = 'menu_button';
    button.innerHTML = '<i class="fa-solid fa-volume-high"></i><span>朗读选中</span>';
    button.addEventListener('click', () => playLightweightText(latestTextSelection.text, {
        source: 'selection', sourceMessage: latestTextSelection.msg,
    }));
    document.body.appendChild(button);
    return button;
}

async function buildRoutedAudioCacheIdentity(segment) {
    if (segment.routeError) throw new Error(segment.routeError);
    const profile = getSettings().providerProfiles?.[segment.profileId];
    if (!profile) throw new Error(`找不到 TTS Profile: ${segment.profileId || '未配置'}`);
    if (profile.type === 'edge') return buildEdgeAudioCacheIdentity(segment);
    if (profile.type === 'openai-compatible') return buildIndexAudioCacheIdentity(segment);
    if (profile.type === 'doubao') return buildDoubaoAudioCacheIdentity(segment);
    if (profile.type === 'minimax') return buildCloudAudioCacheIdentity(segment, 'minimax', MINIMAX_NATIVE_PROFILE_ID);
    if (profile.type === 'xiaomi-mimo') return buildCloudAudioCacheIdentity(segment, 'xiaomi-mimo', XIAOMI_MIMO_PROFILE_ID);
    throw new Error(`不支持的 TTS Provider: ${profile.type || 'unknown'}`);
}

function applyInlineCacheAvailability(key, hash, available, cacheChecked = true) {
    const previous = inlineDialogueButtonStates.get(key) || { state: 'idle', cacheReady: false };
    const keepLifecycleState = ['preparing', 'playing'].includes(previous.state);
    setInlineDialogueButtonState(key, keepLifecycleState ? previous.state : (available ? 'ready' : 'idle'), {
        cacheReady: available,
        cacheHash: hash,
        cacheChecked,
    });
}

async function scanInlineDialogueCache(msg, analysis) {
    const cacheGeneration = inlineDialogueCacheGeneration;
    const candidates = [];
    for (let index = 0; index < analysis.dialogues.length; index += 1) {
        const segment = analysis.dialogues[index];
        if (segment.routeError || !segment.profileId || !segment.voiceId) continue;
        try {
            const { hash } = await buildRoutedAudioCacheIdentity(segment);
            if (cacheGeneration !== inlineDialogueCacheGeneration) return;
            const key = getInlineDialogueButtonKey(msg, index);
            const previous = inlineDialogueButtonStates.get(key);
            if (previous?.cacheHash === hash && previous.cacheChecked) {
                candidates.push({ key, hash, local: previous.cacheReady, checked: true });
                continue;
            }
            const local = await hasLocalCachedAudio(hash).catch(error => {
                console.warn(`[${extensionName}] inline local cache check failed`, error);
                return false;
            });
            if (cacheGeneration !== inlineDialogueCacheGeneration) return;
            if (local) applyInlineCacheAvailability(key, hash, true);
            else applyInlineCacheAvailability(key, hash, false, false);
            candidates.push({ key, hash, local, checked: false });
        } catch (error) {
            console.warn(`[${extensionName}] inline cache identity failed`, error);
        }
    }

    const misses = candidates.filter(item => !item.local && !item.checked);
    let serverResult = {};
    let serverError = null;
    if (misses.length && getSettings().sharedAudioCacheEnabled !== false) {
        try {
            serverResult = await verifyServerCachedAudio(misses.map(item => item.hash));
        } catch (error) {
            serverError = error;
            console.warn(`[${extensionName}] inline server cache check failed`, error);
        }
    }
    if (cacheGeneration !== inlineDialogueCacheGeneration) return;
    misses.forEach(item => applyInlineCacheAvailability(
        item.key,
        item.hash,
        serverResult[item.hash] === true,
        !serverError,
    ));

    const readyCount = candidates.filter(item => {
        const state = inlineDialogueButtonStates.get(item.key);
        return state?.cacheHash === item.hash && state.cacheReady;
    }).length;
    Object.assign(getAudit().inline_cache_scan ||= {}, {
        status: serverError ? 'fail' : 'success',
        error: serverError ? String(serverError.message || serverError).slice(0, 200) : null,
        checked_count: candidates.length,
        ready_count: readyCount,
        server_checked: misses.length > 0 && getSettings().sharedAudioCacheEnabled !== false,
    });
}

function createInlineDialogueButton(msg, index, dialogue) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'has-inline-dialogue-button';
    button.dataset.dialogueIndex = String(index);
    const dialogueKey = getInlineDialogueButtonKey(msg, index);
    button.dataset.dialogueKey = dialogueKey;
    const savedState = inlineDialogueButtonStates.get(dialogueKey) || { state: 'idle', cacheReady: false };
    const presentation = getInlineDialogueButtonPresentation(savedState.state);
    button.dataset.state = savedState.state;
    button.title = presentation.label;
    button.setAttribute('aria-label', presentation.label);
    button.setAttribute('aria-busy', String(presentation.busy));
    button.setAttribute('aria-pressed', String(presentation.pressed));
    button.classList.toggle('has-busy', presentation.busy);
    button.classList.toggle('has-playing', savedState.state === 'playing');
    button.innerHTML = `<i class="${presentation.iconClass}" aria-hidden="true"></i>`;
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
        const button = createInlineDialogueButton(msg, index, dialogue);
        const inserted = insertButtonAfterText(root, dialogue.rawContent, button)
            || insertButtonAfterText(root, dialogue.originalLine, button)
            || insertButtonAfterText(root, dialogue.text, button);
        if (!inserted) fallback.appendChild(button);
    });

    if (fallback.childElementCount) {
        root.prepend(fallback);
    }
    scanInlineDialogueCache(msg, analysis).catch(error => {
        Object.assign(getAudit().inline_cache_scan ||= {}, {
            status: 'fail', error: String(error.message || error).slice(0, 200),
        });
    });
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
    button.closest('.has-msg-more')?.removeAttribute('open');

    if (button.classList.contains('has-play-msg')) {
        playAudiobookMessage(msg, button);
        return;
    }
    if (button.classList.contains('has-play-selection')) {
        if (!latestTextSelection.text || latestTextSelection.msg !== msg) {
            toastWarn('请先在这条消息中选中文字');
            return;
        }
        playLightweightText(latestTextSelection.text, { source: 'selection', sourceMessage: msg });
        return;
    }
    if (button.classList.contains('has-play-paragraph')) {
        const content = extractContentBlock(getRawMessageText(msg));
        const paragraph = latestTextSelection.msg === msg && latestTextSelection.paragraphText
            ? latestTextSelection.paragraphText
            : normalizeWhitespace(content).split(/\n+/).find(Boolean);
        playLightweightText(paragraph || '', { source: 'paragraph', sourceMessage: msg });
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

function getPublicPlaybackState() {
    const session = playbackSessions.getActive();
    return session ? {
        sessionId: session.id,
        source: session.source,
        status: session.status,
        index: session.currentIndex,
        total: session.segments.length,
    } : { sessionId: null, source: null, status: 'idle', index: 0, total: 0 };
}

async function handleIntegrationSpeak(data = {}) {
    Object.assign(getAudit().integration_event, { status: 'success', error: null, last_event: integrationEvents.speak });
    if (String(data.text || '').trim()) {
        return playLightweightText(data.text, {
            source: 'external',
            profileId: String(data.profileId || ''),
            voiceId: String(data.voiceId || ''),
            character: String(data.character || ''),
        });
    }
    const messages = Array.from(document.querySelectorAll('.mes'));
    const msg = data.messageId !== undefined && data.messageId !== null
        ? messages.find(item => String(getMessageId(item)) === String(data.messageId))
        : messages.reverse().find(item => item.getAttribute('is_user') !== 'true');
    if (!msg) {
        emitPlaybackState({ id: String(data.requestId || 'external'), currentIndex: 0, segments: [] }, 'error', 'message_not_found');
        return false;
    }
    const settings = getSettings();
    const preset = getActivePreset(settings);
    const previousMode = preset?.mode;
    if (preset && ['mixed', 'dialogue-only', 'single-voice'].includes(data.mode)) preset.mode = data.mode;
    const promise = playAudiobookMessage(msg, null, { playbackUiOverride: data.openStage === true ? 'video' : 'player' });
    if (preset && previousMode) preset.mode = previousMode;
    return promise;
}

function setupIntegrationEvents() {
    const previous = window.__hybridAudiobookStageIntegrationHandlers;
    if (previous) {
        eventSource?.removeListener?.(integrationEvents.speak, previous.speak);
        eventSource?.removeListener?.(integrationEvents.stop, previous.stop);
    }
    const handlers = {
        speak: data => handleIntegrationSpeak(data).catch(error => {
            Object.assign(getAudit().integration_event, { status: 'fail', error: error.message, last_event: integrationEvents.speak });
        }),
        stop: () => {
            Object.assign(getAudit().integration_event, { status: 'success', error: null, last_event: integrationEvents.stop });
            stopCurrentPlayback();
        },
    };
    eventSource?.on?.(integrationEvents.speak, handlers.speak);
    eventSource?.on?.(integrationEvents.stop, handlers.stop);
    window.__hybridAudiobookStageIntegrationHandlers = handlers;
}

function init() {
    console.warn('[混合有声书舞台] root entry loaded');
    getSettings();
    ensureSettingsPanel();
    ensureLauncher();
    refreshMessageButtons();
    ensureSelectionSpeakButton();
    setupIntegrationEvents();
    document.removeEventListener('selectionchange', captureLatestTextSelection);
    document.addEventListener('selectionchange', captureLatestTextSelection);
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
        eventSource?.on?.(eventType, () => {
            if ([event_types.MESSAGE_EDITED, event_types.MESSAGE_SWIPED, event_types.CHAT_CHANGED].includes(eventType)) {
                stopCurrentPlayback();
                inlineDialogueButtonStates.clear();
                latestTextSelection = { text: '', paragraphText: '', messageId: '', msg: null };
                document.getElementById('has-selection-speak')?.classList.remove('visible');
            }
            setTimeout(refreshMessageButtons, 50);
        });
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
        speak: handleIntegrationSpeak,
        stop: stopCurrentPlayback,
        getPlaybackState: getPublicPlaybackState,
    };
    Object.assign(getAudit().stage_linked, { status: 'success', error: null, uses_shared_session: true });
}

init();
