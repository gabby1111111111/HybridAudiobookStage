import assert from 'node:assert/strict';
import test from 'node:test';
import {
    chooseProfileVoice,
    collectProfileVoiceOptions,
    matchesVoiceSearch,
    rememberProfileVoice,
} from '../public/lib/tts-voice-options.mjs';

const settings = {
    providerProfiles: {
        doubao: { id: 'doubao', type: 'doubao', defaultVoice: 'doubao-default', voiceOptions: ['saved', 'saved'] },
        edge: { id: 'edge', type: 'edge', edgeVoice: 'edge-default' },
        index: { id: 'index', type: 'openai-compatible', defaultVoice: 'default.wav' },
    },
    routingPresets: {
        first: {
            narration: { profileId: 'doubao', voiceId: 'doubao-narrator' },
            dialogueDefault: { profileId: 'doubao', voiceId: 'doubao-character' },
            singleVoice: { profileId: 'index', voiceId: 'reader.wav' },
            characterOverrides: {
                Alice: { profileId: 'doubao', voiceId: 'doubao-alice' },
                Bob: { profileId: 'edge', voiceId: 'edge-bob' },
            },
        },
    },
};

test('collects and deduplicates only voices associated with one Profile', () => {
    assert.deepEqual(collectProfileVoiceOptions(settings, 'doubao'), [
        'doubao-alice', 'doubao-character', 'doubao-default', 'doubao-narrator', 'saved',
    ]);
    assert.deepEqual(collectProfileVoiceOptions(settings, 'edge'), ['edge-bob', 'edge-default']);
    assert.doesNotMatch(collectProfileVoiceOptions(settings, 'doubao').join(','), /default\.wav|reader\.wav/);
});

test('chooses a known preferred voice and never carries an unrelated provider voice', () => {
    assert.equal(chooseProfileVoice(settings, 'doubao', 'doubao-character'), 'doubao-character');
    assert.equal(chooseProfileVoice(settings, 'doubao', 'default.wav'), 'doubao-default');
    assert.equal(chooseProfileVoice(settings, 'edge', 'doubao-character'), 'edge-default');
});

test('remembers manual voice ids as bounded strings without duplicates', () => {
    const profile = { voiceOptions: ['saved', '', 'saved', 123] };
    assert.deepEqual(rememberProfileVoice(profile, ' new-speaker '), ['saved', 'new-speaker']);
    assert.equal(profile.lastUsedVoice, 'new-speaker');
    assert.deepEqual(rememberProfileVoice(profile, 'saved'), ['new-speaker', 'saved']);
    assert.equal(profile.lastUsedVoice, 'saved');
    assert.equal(Object.values(profile).some(value => /key|secret/i.test(String(value))), false);
});

test('searches voice labels and metadata by normalized substring', () => {
    const edgeText = 'Locale: zh-CN · Gender: Male｜zh-CN-YunxiNeural 男声';
    assert.equal(matchesVoiceSearch(edgeText, 'yunxi'), true);
    assert.equal(matchesVoiceSearch(edgeText, 'ZH-CN'), true);
    assert.equal(matchesVoiceSearch(edgeText, 'male'), true);
    assert.equal(matchesVoiceSearch(edgeText, '男声'), true);
    assert.equal(matchesVoiceSearch('傲气凌人｜ICL_uranus_zh_male_aoqilingren_tob', '傲气'), true);
    assert.equal(matchesVoiceSearch('Nanami.wav IndexTTS2 ckyp', 'nanami'), true);
    assert.equal(matchesVoiceSearch(edgeText, 'female'), false);
    assert.equal(matchesVoiceSearch(edgeText, ''), true);
});

test('defaults to the Profile last-used voice when switching providers', () => {
    const recentSettings = structuredClone(settings);
    recentSettings.providerProfiles.doubao.lastUsedVoice = 'doubao-character';
    recentSettings.providerProfiles.doubao.voiceOptions = ['doubao-character'];
    assert.equal(chooseProfileVoice(recentSettings, 'doubao'), 'doubao-character');
    assert.equal(collectProfileVoiceOptions(recentSettings, 'doubao')[0], 'doubao-character');
});
