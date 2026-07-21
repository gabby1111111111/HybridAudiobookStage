export const CUSTOM_CLOUD_MODEL_OPTION = '__custom_cloud_model__';

export const MINIMAX_MODEL_OPTIONS = Object.freeze([
    { value: 'speech-2.8-hd', label: 'speech-2.8-hd（最新 HD）' },
    { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo（最新 Turbo）' },
    { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
    { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
    { value: 'speech-02-hd', label: 'speech-02-hd' },
    { value: 'speech-02-turbo', label: 'speech-02-turbo' },
]);

export const XIAOMI_MIMO_MODEL_OPTIONS = Object.freeze([
    { value: 'mimo-v2.5-tts', label: 'mimo-v2.5-tts（普通 TTS）', enabled: true },
    { value: 'mimo-v2.5-tts-voicedesign', label: 'mimo-v2.5-tts-voicedesign（音色设计，首版暂未开放）', enabled: false },
    { value: 'mimo-v2.5-tts-voiceclone', label: 'mimo-v2.5-tts-voiceclone（音色复刻，首版暂未开放）', enabled: false },
]);

export const XIAOMI_MIMO_VOICES = Object.freeze([
    { voiceId: 'mimo_default', name: 'MiMo · 默认', meta: '通用' },
    { voiceId: '冰糖', name: '冰糖', meta: '中文女声' },
    { voiceId: '茉莉', name: '茉莉', meta: '中文女声' },
    { voiceId: '苏打', name: '苏打', meta: '中文男声' },
    { voiceId: '白桦', name: '白桦', meta: '中文男声' },
    { voiceId: 'Mia', name: 'Mia', meta: '英文女声' },
    { voiceId: 'Chloe', name: 'Chloe', meta: '英文女声' },
    { voiceId: 'Milo', name: 'Milo', meta: '英文男声' },
    { voiceId: 'Dean', name: 'Dean', meta: '英文男声' },
]);

export function getCloudModelOptions(providerType) {
    return providerType === 'minimax' ? MINIMAX_MODEL_OPTIONS : XIAOMI_MIMO_MODEL_OPTIONS;
}

export function getXiaomiMimoVoice(voiceId) {
    const normalized = String(voiceId || '').trim();
    return XIAOMI_MIMO_VOICES.find(voice => voice.voiceId === normalized) || null;
}

export function normalizeDiscoveredMinimaxVoices(voices, limit = 2000) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(voices) ? voices : []) {
        const voiceId = String(value?.voiceId || '').trim().slice(0, 500);
        if (!voiceId || seen.has(voiceId)) continue;
        seen.add(voiceId);
        result.push({
            voiceId,
            name: String(value?.name || voiceId).trim().slice(0, 300) || voiceId,
            description: String(value?.description || '').trim().slice(0, 1000),
            kind: ['system', 'voice_cloning', 'voice_generation'].includes(value?.kind) ? value.kind : 'system',
        });
        if (result.length >= limit) break;
    }
    return result;
}
