export const TTS_SETTINGS_VERSION = 3;

export const LEGACY_OPENAI_PROFILE_ID = 'profile-openai-legacy';
export const LEGACY_EDGE_PROFILE_ID = 'profile-edge-legacy';
export const DOUBAO_NATIVE_PROFILE_ID = 'profile-doubao-native';
export const LEGACY_PRESET_ID = 'preset-default-legacy';

function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value) {
    return isRecord(value) ? { ...value } : {};
}

function normalizeCharacterOverrides(voiceMap, profileId) {
    const overrides = {};
    for (const [character, value] of Object.entries(cloneRecord(voiceMap))) {
        const name = String(character || '').trim();
        const voiceId = String(value || '').trim();
        if (!name || !voiceId) continue;
        overrides[name] = { profileId, voiceId };
    }
    return overrides;
}

function buildLegacyOpenAiProfile(settings) {
    return {
        id: LEGACY_OPENAI_PROFILE_ID,
        name: 'IndexTTS2（迁移）',
        type: 'openai-compatible',
        enabled: true,
        endpoint: String(settings.ttsApiUrl || 'http://127.0.0.1:7880/v1/audio/speech'),
        apiKey: '',
        model: String(settings.ttsModel || 'index-tts2'),
        defaultVoice: String(settings.defaultVoice || 'default.wav'),
        responseFormat: 'wav',
        extraBody: {},
        requestMode: settings.useServerIndexTtsProxy === false ? 'direct' : 'server-proxy',
    };
}

function buildLegacyEdgeProfile(settings) {
    return {
        id: LEGACY_EDGE_PROFILE_ID,
        name: 'Edge 旁白（迁移）',
        type: 'edge',
        enabled: true,
        edgeVoice: String(settings.edgeVoice || 'zh-CN-XiaoxiaoNeural'),
        edgeRate: 0,
        requestMode: 'server-proxy',
    };
}

function buildDoubaoNativeProfile() {
    return {
        id: DOUBAO_NATIVE_PROFILE_ID,
        name: '豆包原生',
        type: 'doubao',
        enabled: true,
        appId: '',
        accessKey: '',
        resourceId: 'seed-tts-2.0',
        defaultVoice: '',
        contextText: '',
        requestMode: 'server-proxy',
    };
}

function buildLegacyPreset(settings) {
    const dialogueVoice = String(settings.defaultVoice || 'default.wav');
    const edgeVoice = String(settings.edgeVoice || 'zh-CN-XiaoxiaoNeural');
    return {
        id: LEGACY_PRESET_ID,
        name: '默认朗读（迁移）',
        mode: settings.readNarration === false ? 'dialogue-only' : 'mixed',
        narration: {
            profileId: LEGACY_EDGE_PROFILE_ID,
            voiceId: edgeVoice,
        },
        dialogueDefault: {
            profileId: LEGACY_OPENAI_PROFILE_ID,
            voiceId: dialogueVoice,
        },
        characterOverrides: normalizeCharacterOverrides(settings.voiceMap, LEGACY_OPENAI_PROFILE_ID),
        singleVoice: {
            profileId: LEGACY_OPENAI_PROFILE_ID,
            voiceId: dialogueVoice,
        },
    };
}

export function ensureTtsSettingsV2(settings) {
    if (!isRecord(settings)) {
        throw new TypeError('HybridAudiobookStage settings must be an object');
    }

    let changed = settings.ttsSettingsVersion !== TTS_SETTINGS_VERSION;
    const providerProfiles = cloneRecord(settings.providerProfiles);
    const routingPresets = cloneRecord(settings.routingPresets);

    if (!isRecord(providerProfiles[LEGACY_OPENAI_PROFILE_ID])) {
        providerProfiles[LEGACY_OPENAI_PROFILE_ID] = buildLegacyOpenAiProfile(settings);
        changed = true;
    }
    if (!isRecord(providerProfiles[LEGACY_EDGE_PROFILE_ID])) {
        providerProfiles[LEGACY_EDGE_PROFILE_ID] = buildLegacyEdgeProfile(settings);
        changed = true;
    } else {
        const legacyEdge = providerProfiles[LEGACY_EDGE_PROFILE_ID];
        const looksLikeBrokenEdgeMigration = legacyEdge.type !== 'edge'
            && /edge/i.test(String(legacyEdge.name || ''))
            && !String(legacyEdge.endpoint || '').trim();
        if (looksLikeBrokenEdgeMigration) {
            providerProfiles[LEGACY_EDGE_PROFILE_ID] = {
                ...legacyEdge,
                type: 'edge',
                edgeVoice: String(legacyEdge.edgeVoice || settings.edgeVoice || 'zh-CN-XiaoxiaoNeural'),
                edgeRate: Number(legacyEdge.edgeRate) || 0,
                requestMode: 'server-proxy',
            };
            changed = true;
        }
    }
    if (!isRecord(providerProfiles[DOUBAO_NATIVE_PROFILE_ID])) {
        providerProfiles[DOUBAO_NATIVE_PROFILE_ID] = buildDoubaoNativeProfile();
        changed = true;
    }
    if (!isRecord(routingPresets[LEGACY_PRESET_ID])) {
        routingPresets[LEGACY_PRESET_ID] = buildLegacyPreset(settings);
        changed = true;
    }

    settings.providerProfiles = providerProfiles;
    settings.routingPresets = routingPresets;

    if (!routingPresets[settings.activeRoutingPresetId]) {
        settings.activeRoutingPresetId = LEGACY_PRESET_ID;
        changed = true;
    }
    if (!Number.isFinite(Number(settings.playbackRate))) {
        settings.playbackRate = Number.isFinite(Number(settings.speed)) ? Number(settings.speed) : 1;
        changed = true;
    }
    if (!Number.isFinite(Number(settings.synthesisSpeed))) {
        settings.synthesisSpeed = 1;
        changed = true;
    }
    if (!Number.isFinite(Number(settings.prefetchCount))) {
        settings.prefetchCount = 2;
        changed = true;
    }
    if (!Number.isFinite(Number(settings.localAudioCacheMaxMb))) {
        settings.localAudioCacheMaxMb = 512;
        changed = true;
    }

    settings.ttsSettingsVersion = TTS_SETTINGS_VERSION;

    return {
        changed,
        version: TTS_SETTINGS_VERSION,
        profileCount: Object.keys(providerProfiles).length,
        presetCount: Object.keys(routingPresets).length,
        activePresetId: settings.activeRoutingPresetId,
    };
}
