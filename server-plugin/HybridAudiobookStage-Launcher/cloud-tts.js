const MINIMAX_ENDPOINTS = Object.freeze({
    cn: 'https://api.minimaxi.com/v1/t2a_v2',
    io: 'https://api.minimax.io/v1/t2a_v2',
});
const MINIMAX_VOICE_ENDPOINTS = Object.freeze({
    cn: 'https://api.minimaxi.com/v1/get_voice',
    io: 'https://api.minimax.io/v1/get_voice',
});
const XIAOMI_MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

function requiredString(value, label, maxLength = 2000) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`缺少 ${label}`);
    if (text.length > maxLength) throw new Error(`${label} 过长`);
    return text;
}

function optionalString(value, maxLength = 2000) {
    const text = String(value || '').trim();
    if (text.length > maxLength) throw new Error('可选参数过长');
    return text;
}

function normalizeFormat(value, fallback) {
    const format = String(value || fallback).trim().toLowerCase();
    if (!['mp3', 'wav'].includes(format)) throw new Error('不支持的音频格式');
    return format;
}

const MINIMAX_EMOTION_ALIASES = Object.freeze([
    ['happy', ['happy', '开心', '高兴', '喜悦', '兴奋', '愉快']],
    ['sad', ['sad', '悲伤', '难过', '伤心', '低落']],
    ['angry', ['angry', '愤怒', '生气', '恼怒']],
    ['fearful', ['fearful', '害怕', '恐惧', '惊恐']],
    ['disgusted', ['disgusted', '厌恶', '嫌弃', '反感']],
    ['surprised', ['surprised', '惊讶', '震惊', '吃惊']],
    ['neutral', ['neutral', '中性', '平静', '自然']],
]);

function normalizeMinimaxEmotion(value) {
    const input = optionalString(value, 100).toLowerCase();
    if (!input) return '';
    for (const [emotion, aliases] of MINIMAX_EMOTION_ALIASES) {
        if (aliases.some(alias => input.includes(alias))) return emotion;
    }
    return '';
}

function buildMinimaxRequest(input = {}) {
    const platform = String(input.platform || 'cn').trim().toLowerCase();
    const url = MINIMAX_ENDPOINTS[platform];
    if (!url) throw new Error('MiniMax 平台必须是 cn 或 io');
    const apiKey = requiredString(input.apiKey, 'MiniMax API Key', 4096);
    const text = requiredString(input.text, '朗读文本', 20000);
    const voiceId = requiredString(input.voiceId, 'MiniMax Voice ID', 500);
    const model = requiredString(input.model || 'speech-2.8-hd', 'MiniMax 模型', 200);
    const format = normalizeFormat(input.format, 'mp3');
    const speed = Math.max(0.5, Math.min(2, Number(input.speed) || 1));
    const emotion = normalizeMinimaxEmotion(input.emotion);
    const voiceSetting = { voice_id: voiceId, speed, vol: 1, pitch: 0 };
    if (emotion) voiceSetting.emotion = emotion;
    return {
        url,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        payload: {
            model,
            text,
            stream: false,
            voice_setting: voiceSetting,
            audio_setting: {
                format,
                sample_rate: format === 'mp3' ? 32000 : 24000,
                channel: 1,
                ...(format === 'mp3' ? { bitrate: 128000 } : {}),
            },
            language_boost: 'auto',
            output_format: 'hex',
        },
        format,
    };
}

function parseMinimaxResponse(buffer, maxBytes) {
    let data;
    try {
        data = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || ''));
    } catch {
        throw new Error('MiniMax 返回了无效 JSON');
    }
    const code = Number(data?.base_resp?.status_code || 0);
    if (code !== 0) throw new Error(`MiniMax 服务错误 ${code}: ${String(data?.base_resp?.status_msg || '未知错误').slice(0, 200)}`);
    const hex = String(data?.data?.audio || '').trim();
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 返回中没有有效音频');
    const audio = Buffer.from(hex, 'hex');
    if (!audio.length || audio.length > maxBytes) throw new Error('MiniMax 音频为空或过大');
    return audio;
}

function buildMinimaxVoiceListRequest(input = {}) {
    const platform = String(input.platform || 'cn').trim().toLowerCase();
    const url = MINIMAX_VOICE_ENDPOINTS[platform];
    if (!url) throw new Error('MiniMax 平台必须是 cn 或 io');
    const apiKey = requiredString(input.apiKey, 'MiniMax API Key', 4096);
    return {
        url,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        payload: { voice_type: 'all' },
    };
}

function normalizeMinimaxVoice(value, kind) {
    const voiceId = optionalString(value?.voice_id, 500);
    if (!voiceId) return null;
    const description = Array.isArray(value?.description)
        ? value.description.map(item => optionalString(item, 300)).filter(Boolean).join('；').slice(0, 1000)
        : optionalString(value?.description, 1000);
    return {
        voiceId,
        name: optionalString(value?.voice_name, 300) || voiceId,
        description,
        kind,
    };
}

function parseMinimaxVoiceListResponse(buffer, maxVoices = 2000) {
    let data;
    try {
        data = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || ''));
    } catch {
        throw new Error('MiniMax 音色列表返回了无效 JSON');
    }
    const code = Number(data?.base_resp?.status_code || 0);
    if (code !== 0) throw new Error(`MiniMax 服务错误 ${code}: ${String(data?.base_resp?.status_msg || '未知错误').slice(0, 200)}`);
    const groups = [
        ['system', data?.system_voice],
        ['voice_cloning', data?.voice_cloning],
        ['voice_generation', data?.voice_generation],
    ];
    const voices = [];
    const seen = new Set();
    for (const [kind, items] of groups) {
        for (const item of Array.isArray(items) ? items : []) {
            const voice = normalizeMinimaxVoice(item, kind);
            if (!voice || seen.has(voice.voiceId)) continue;
            seen.add(voice.voiceId);
            voices.push(voice);
            if (voices.length >= maxVoices) return voices;
        }
    }
    return voices;
}

function buildXiaomiMimoRequest(input = {}) {
    const apiKey = requiredString(input.apiKey, '小米 MiMo API Key', 4096);
    const text = requiredString(input.text, '朗读文本', 20000);
    const voiceId = requiredString(input.voiceId, '小米 MiMo Voice', 2000);
    const model = requiredString(input.model || 'mimo-v2.5-tts', '小米 MiMo 模型', 200);
    const format = normalizeFormat(input.format, 'wav');
    const style = optionalString(input.style, 1000);
    const messages = [];
    if (style) messages.push({ role: 'user', content: style });
    messages.push({ role: 'assistant', content: text });
    return {
        url: XIAOMI_MIMO_ENDPOINT,
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
            Authorization: `Bearer ${apiKey}`,
        },
        payload: { model, messages, audio: { format, voice: voiceId } },
        format,
    };
}

function parseXiaomiMimoResponse(buffer, maxBytes) {
    let data;
    try {
        data = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || ''));
    } catch {
        throw new Error('小米 MiMo 返回了无效 JSON');
    }
    const encoded = String(data?.choices?.[0]?.message?.audio?.data || '').trim();
    if (!encoded) throw new Error('小米 MiMo 返回中没有音频数据');
    const audio = Buffer.from(encoded, 'base64');
    if (!audio.length || audio.length > maxBytes) throw new Error('小米 MiMo 音频为空或过大');
    return audio;
}

module.exports = {
    MINIMAX_ENDPOINTS,
    MINIMAX_VOICE_ENDPOINTS,
    XIAOMI_MIMO_ENDPOINT,
    buildMinimaxRequest,
    normalizeMinimaxEmotion,
    parseMinimaxResponse,
    buildMinimaxVoiceListRequest,
    parseMinimaxVoiceListResponse,
    buildXiaomiMimoRequest,
    parseXiaomiMimoResponse,
};
