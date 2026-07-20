import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EDGE_VOICE_CATALOG,
    getEdgeCatalogVoice,
    getPrioritizedEdgeVoiceGroups,
} from '../public/lib/edge-voice-catalog.mjs';

test('contains all 302 unique Edge voices in the source file order', () => {
    assert.equal(EDGE_VOICE_CATALOG.length, 302);
    assert.equal(new Set(EDGE_VOICE_CATALOG.map(voice => voice.voiceId)).size, 302);
    assert.deepEqual(EDGE_VOICE_CATALOG[0], {
        voiceId: 'af-ZA-AdriNeural', gender: 'Female', locale: 'af-ZA', sourceIndex: 0,
    });
    assert.deepEqual(EDGE_VOICE_CATALOG.at(-1), {
        voiceId: 'zu-ZA-ThembaNeural', gender: 'Male', locale: 'zu-ZA', sourceIndex: 301,
    });
});

test('prioritizes zh-CN male then female and keeps every other voice in source order', () => {
    const groups = getPrioritizedEdgeVoiceGroups();
    assert.deepEqual(groups.map(group => group.id), ['zh-cn-male', 'zh-cn-female', 'other']);
    assert.deepEqual(groups[0].voices.map(voice => voice.voiceId), [
        'zh-CN-YunjianNeural',
        'zh-CN-YunxiNeural',
        'zh-CN-YunxiaNeural',
        'zh-CN-YunyangNeural',
    ]);
    assert.deepEqual(groups[1].voices.map(voice => voice.voiceId), [
        'zh-CN-XiaoxiaoNeural',
        'zh-CN-XiaoyiNeural',
    ]);
    assert.equal(groups[2].voices.length, 296);
    assert.equal(groups[2].voices[0].voiceId, 'af-ZA-AdriNeural');
    assert.equal(groups[2].voices.at(-1).voiceId, 'zu-ZA-ThembaNeural');
    assert.ok(groups[2].voices.every((voice, index, array) => index === 0 || voice.sourceIndex > array[index - 1].sourceIndex));
});

test('removes used voices from Edge catalog groups while retaining their metadata lookup', () => {
    const groups = getPrioritizedEdgeVoiceGroups(['zh-CN-YunxiNeural', 'af-ZA-AdriNeural']);
    assert.equal(groups.flatMap(group => group.voices).some(voice => voice.voiceId === 'zh-CN-YunxiNeural'), false);
    assert.equal(groups.flatMap(group => group.voices).some(voice => voice.voiceId === 'af-ZA-AdriNeural'), false);
    assert.equal(getEdgeCatalogVoice('zh-CN-YunxiNeural')?.gender, 'Male');
});
