import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSynthesisDescriptor, chooseLruEvictions, stableSerialize } from '../public/lib/tts-cache-key.mjs';

test('cache descriptor includes synthesis inputs and excludes playback-only data', () => {
    const descriptor = buildSynthesisDescriptor({
        text: '  你好\n世界  ', providerType: 'openai-compatible', profileId: 'p1', endpoint: 'http://local/tts',
        model: 'm1', voiceId: 'v1', responseFormat: 'wav', synthesisParams: { speed: 1.2 }, extraBody: { emotion: 'happy' },
        apiKey: 'secret', volume: 0.2, playbackRate: 2,
    });
    const serialized = stableSerialize(descriptor);
    assert.equal(descriptor.text, '你好 世界');
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('playbackRate'), false);
    assert.equal(serialized.includes('volume'), false);
    assert.equal(serialized.includes('happy'), true);
});

test('stable serialization ignores object key insertion order', () => {
    assert.equal(stableSerialize({ b: 2, a: { d: 4, c: 3 } }), stableSerialize({ a: { c: 3, d: 4 }, b: 2 }));
});

test('entry point names do not change synthesis cache identity', () => {
    const synthesis = {
        text: '今晚很安静。',
        providerType: 'openai-compatible',
        profileId: 'character-profile',
        endpoint: 'http://127.0.0.1:7880/v1/audio/speech',
        model: 'index-tts2',
        voiceId: 'character.wav',
        responseFormat: 'wav',
        synthesisParams: { speed: 1 },
        extraBody: { emotion: '0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8' },
    };
    const fromDialogueButton = buildSynthesisDescriptor({ ...synthesis, source: 'dialogue', segmentType: 'single' });
    const fromFullMessage = buildSynthesisDescriptor({ ...synthesis, source: 'message', segmentType: 'dialogue' });
    const fromSelection = buildSynthesisDescriptor({ ...synthesis, source: 'selection' });

    assert.equal(stableSerialize(fromDialogueButton), stableSerialize(fromFullMessage));
    assert.equal(stableSerialize(fromFullMessage), stableSerialize(fromSelection));
});

test('LRU eviction removes oldest entries until under the byte limit', () => {
    assert.deepEqual(chooseLruEvictions([
        { hash: 'new', size: 40, lastAccessedAt: 30 },
        { hash: 'old', size: 50, lastAccessedAt: 10 },
        { hash: 'middle', size: 30, lastAccessedAt: 20 },
    ], 70), { evictions: ['old'], totalBytes: 70 });
});
