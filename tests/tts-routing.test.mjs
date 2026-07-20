import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyPresetRouting,
    removeCharacterOverridesByProfile,
    resolveSegmentRoute,
    summarizeCharacterOverrides,
} from '../public/lib/tts-routing.mjs';

const profiles = {
    edge: { id: 'edge', name: 'Edge', type: 'edge', enabled: true, edgeVoice: 'narrator' },
    local: { id: 'local', name: 'Local', type: 'openai-compatible', enabled: true, defaultVoice: 'default.wav' },
    cloud: { id: 'cloud', name: 'Cloud', type: 'openai-compatible', enabled: true, defaultVoice: 'cloud-voice' },
};
const preset = {
    mode: 'mixed',
    narration: { profileId: 'edge', voiceId: 'narrator' },
    dialogueDefault: { profileId: 'local', voiceId: 'default.wav' },
    characterOverrides: { Alice: { profileId: 'cloud', voiceId: 'alice' } },
    singleVoice: { profileId: 'local', voiceId: 'reader.wav' },
};

test('routes narration, default dialogue and character overrides', () => {
    assert.equal(resolveSegmentRoute({ type: 'narration' }, preset, profiles).profileId, 'edge');
    assert.equal(resolveSegmentRoute({ type: 'dialogue', character: 'Bob' }, preset, profiles).profileId, 'local');
    assert.equal(resolveSegmentRoute({ type: 'dialogue', character: 'Alice' }, preset, profiles).profileId, 'cloud');
});

test('routes all single-voice segments to one target', () => {
    const singlePreset = { ...preset, mode: 'single-voice' };
    assert.equal(resolveSegmentRoute({ type: 'narration' }, singlePreset, profiles).voiceId, 'reader.wav');
    assert.equal(resolveSegmentRoute({ type: 'dialogue', character: 'Alice' }, singlePreset, profiles).profileId, 'local');
});

test('does not silently fall back when a profile is missing or disabled', () => {
    assert.match(resolveSegmentRoute({ type: 'narration' }, { ...preset, narration: { profileId: 'missing' } }, profiles).error, /找不到/);
    const disabled = { ...profiles, edge: { ...profiles.edge, enabled: false } };
    assert.match(resolveSegmentRoute({ type: 'narration' }, preset, disabled).error, /已禁用/);
});

test('reports every unresolved routed segment', () => {
    const result = applyPresetRouting([
        { type: 'narration', text: '旁白' },
        { type: 'dialogue', character: 'Alice', text: '台词' },
    ], { ...preset, narration: { profileId: 'missing' } }, profiles);
    assert.equal(result.segments.length, 2);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.segments[1].voiceId, 'alice');
});

test('finds and removes only legacy profile overrides while preserving other providers', () => {
    const editable = {
        characterOverrides: {
            Alice: { profileId: 'profile-openai-legacy', voiceId: 'alice.wav' },
            Bob: { profileId: 'doubao', voiceId: 'bob-speaker' },
            Carol: { profileId: 'profile-openai-legacy', voiceId: 'carol.wav' },
        },
    };
    const legacyVoiceMap = { Alice: 'alice.wav', Bob: 'bob-speaker', Carol: 'different.wav' };
    assert.deepEqual(summarizeCharacterOverrides(editable, 'profile-openai-legacy'), {
        total: 3,
        matchingProfile: 2,
    });
    assert.deepEqual(
        removeCharacterOverridesByProfile(editable, 'profile-openai-legacy', legacyVoiceMap),
        ['Alice', 'Carol'],
    );
    assert.deepEqual(editable.characterOverrides, {
        Bob: { profileId: 'doubao', voiceId: 'bob-speaker' },
    });
    assert.equal(legacyVoiceMap.Alice, undefined);
    assert.equal(legacyVoiceMap.Carol, 'different.wav');
});
