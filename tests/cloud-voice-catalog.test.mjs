import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MINIMAX_MODEL_OPTIONS,
    XIAOMI_MIMO_MODEL_OPTIONS,
    XIAOMI_MIMO_VOICES,
    getXiaomiMimoVoice,
    normalizeDiscoveredMinimaxVoices,
} from '../public/lib/cloud-voice-catalog.mjs';

test('exposes six MiniMax models and only enables ordinary Xiaomi TTS in the first release', () => {
    assert.deepEqual(MINIMAX_MODEL_OPTIONS.map(item => item.value), [
        'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd',
        'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo',
    ]);
    assert.deepEqual(XIAOMI_MIMO_MODEL_OPTIONS.filter(item => item.enabled).map(item => item.value), ['mimo-v2.5-tts']);
    assert.equal(XIAOMI_MIMO_MODEL_OPTIONS.length, 3);
});

test('exposes nine Xiaomi preset voices and sanitizes discovered MiniMax metadata', () => {
    assert.equal(XIAOMI_MIMO_VOICES.length, 9);
    assert.equal(new Set(XIAOMI_MIMO_VOICES.map(item => item.voiceId)).size, 9);
    assert.equal(getXiaomiMimoVoice('冰糖')?.meta, '中文女声');
    assert.deepEqual(normalizeDiscoveredMinimaxVoices([
        { voiceId: ' a ', name: ' A ', description: ' desc ', kind: 'voice_cloning', secret: 'drop' },
        { voiceId: 'a', name: 'duplicate' },
        { voiceId: 'b', kind: 'unknown' },
    ]), [
        { voiceId: 'a', name: 'A', description: 'desc', kind: 'voice_cloning' },
        { voiceId: 'b', name: 'b', description: '', kind: 'system' },
    ]);
});
