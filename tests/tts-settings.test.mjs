import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ensureTtsSettingsV2,
    DOUBAO_NATIVE_PROFILE_ID,
    LEGACY_EDGE_PROFILE_ID,
    LEGACY_OPENAI_PROFILE_ID,
    LEGACY_PRESET_ID,
    TTS_SETTINGS_VERSION,
} from '../public/lib/tts-settings.mjs';

test('migrates empty settings without deleting legacy-compatible fields', () => {
    const settings = {};
    const result = ensureTtsSettingsV2(settings);

    assert.equal(result.changed, true);
    assert.equal(settings.ttsSettingsVersion, TTS_SETTINGS_VERSION);
    assert.equal(settings.activeRoutingPresetId, LEGACY_PRESET_ID);
    assert.equal(settings.providerProfiles[LEGACY_OPENAI_PROFILE_ID].type, 'openai-compatible');
    assert.equal(settings.providerProfiles[LEGACY_EDGE_PROFILE_ID].type, 'edge');
    assert.equal(settings.providerProfiles[DOUBAO_NATIVE_PROFILE_ID].type, 'doubao');
    assert.equal(settings.providerProfiles[DOUBAO_NATIVE_PROFILE_ID].resourceId, 'seed-tts-2.0');
    assert.equal(settings.routingPresets[LEGACY_PRESET_ID].mode, 'mixed');
    assert.equal(settings.playbackRate, 1);
    assert.equal(settings.synthesisSpeed, 1);
});

test('migrates legacy provider, speed, narration and character settings', () => {
    const settings = {
        ttsApiUrl: 'http://127.0.0.1:9000/v1/audio/speech',
        ttsModel: 'custom-model',
        defaultVoice: 'hero.wav',
        edgeVoice: 'zh-CN-YunxiNeural',
        speed: 1.4,
        readNarration: false,
        useServerIndexTtsProxy: false,
        voiceMap: { Alice: 'alice.wav', Empty: '' },
        videoUrl: '/keep-me.mp4',
    };

    ensureTtsSettingsV2(settings);

    const openAi = settings.providerProfiles[LEGACY_OPENAI_PROFILE_ID];
    const preset = settings.routingPresets[LEGACY_PRESET_ID];
    assert.equal(openAi.endpoint, settings.ttsApiUrl);
    assert.equal(openAi.model, 'custom-model');
    assert.equal(openAi.defaultVoice, 'hero.wav');
    assert.equal(openAi.requestMode, 'direct');
    assert.equal(settings.playbackRate, 1.4);
    assert.equal(settings.synthesisSpeed, 1);
    assert.equal(preset.mode, 'dialogue-only');
    assert.deepEqual(preset.characterOverrides.Alice, {
        profileId: LEGACY_OPENAI_PROFILE_ID,
        voiceId: 'alice.wav',
    });
    assert.equal(preset.characterOverrides.Empty, undefined);
    assert.equal(settings.videoUrl, '/keep-me.mp4');
});

test('preserves custom v2 profiles and presets', () => {
    const settings = {
        ttsSettingsVersion: TTS_SETTINGS_VERSION,
        providerProfiles: {
            custom: { id: 'custom', name: 'Custom', type: 'openai-compatible' },
        },
        routingPresets: {
            customPreset: { id: 'customPreset', name: 'Custom preset', mode: 'single-voice' },
        },
        activeRoutingPresetId: 'customPreset',
        playbackRate: 0.9,
        synthesisSpeed: 1.1,
        prefetchCount: 1,
        localAudioCacheMaxMb: 128,
    };

    ensureTtsSettingsV2(settings);

    assert.equal(settings.providerProfiles.custom.name, 'Custom');
    assert.equal(settings.routingPresets.customPreset.mode, 'single-voice');
    assert.equal(settings.activeRoutingPresetId, 'customPreset');
    assert.equal(settings.playbackRate, 0.9);
    assert.equal(settings.synthesisSpeed, 1.1);
});

test('is idempotent after the first migration', () => {
    const settings = { voiceMap: { Alice: 'alice.wav' } };
    ensureTtsSettingsV2(settings);
    const snapshot = structuredClone(settings);
    const second = ensureTtsSettingsV2(settings);

    assert.equal(second.changed, false);
    assert.deepEqual(settings, snapshot);
});

test('repairs a malformed reserved Edge migration profile without touching valid custom profiles', () => {
    const settings = {
        ttsSettingsVersion: 2,
        edgeVoice: 'zh-CN-XiaoxiaoNeural',
        providerProfiles: {
            [LEGACY_OPENAI_PROFILE_ID]: {
                id: LEGACY_OPENAI_PROFILE_ID,
                name: 'IndexTTS2（迁移）',
                type: 'openai-compatible',
                endpoint: 'http://127.0.0.1:7880/v1/audio/speech',
            },
            [LEGACY_EDGE_PROFILE_ID]: {
                id: LEGACY_EDGE_PROFILE_ID,
                name: 'Edge 旁白（迁移）',
                type: 'openai-compatible',
                endpoint: '',
            },
            custom: {
                id: 'custom',
                name: 'Custom OpenAI',
                type: 'openai-compatible',
                endpoint: 'https://example.invalid/v1/audio/speech',
            },
        },
        routingPresets: {},
    };

    const result = ensureTtsSettingsV2(settings);

    assert.equal(result.changed, true);
    assert.equal(settings.providerProfiles[LEGACY_EDGE_PROFILE_ID].type, 'edge');
    assert.equal(settings.providerProfiles[LEGACY_EDGE_PROFILE_ID].edgeVoice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(settings.providerProfiles.custom.type, 'openai-compatible');
    assert.equal(settings.providerProfiles.custom.endpoint, 'https://example.invalid/v1/audio/speech');
});

test('rejects invalid settings containers', () => {
    assert.throws(() => ensureTtsSettingsV2(null), TypeError);
    assert.throws(() => ensureTtsSettingsV2([]), TypeError);
});
