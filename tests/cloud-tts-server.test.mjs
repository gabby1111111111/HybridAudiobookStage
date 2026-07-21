import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
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
} = require('../server-plugin/HybridAudiobookStage-Launcher/cloud-tts.js');

test('builds a fixed MiniMax T2A request and keeps the key out of its payload', () => {
    const request = buildMinimaxRequest({
        apiKey: 'mini-secret', platform: 'cn', model: 'speech-2.8-hd',
        voiceId: 'Chinese (Mandarin)_Warm_Bestie', text: '你好', format: 'mp3', emotion: 'happy',
    });
    assert.equal(request.url, MINIMAX_ENDPOINTS.cn);
    assert.equal(request.headers.Authorization, 'Bearer mini-secret');
    assert.equal(request.payload.voice_setting.voice_id, 'Chinese (Mandarin)_Warm_Bestie');
    assert.equal(request.payload.output_format, 'hex');
    assert.equal(JSON.stringify(request.payload).includes('mini-secret'), false);
    const audio = parseMinimaxResponse(Buffer.from(JSON.stringify({
        base_resp: { status_code: 0 }, data: { audio: Buffer.from('mp3').toString('hex') },
    })), 1024);
    assert.equal(audio.toString(), 'mp3');
});

test('maps supported MiniMax emotions and omits free-form style text', () => {
    assert.equal(normalizeMinimaxEmotion('温柔；开心'), 'happy');
    assert.equal(normalizeMinimaxEmotion('fearful'), 'fearful');
    assert.equal(normalizeMinimaxEmotion('温柔地低声说'), '');

    const request = buildMinimaxRequest({
        apiKey: 'mini-secret', platform: 'cn', model: 'speech-2.8-hd',
        voiceId: 'Chinese (Mandarin)_Warm_Bestie', text: '你好', format: 'mp3', emotion: '温柔地低声说',
    });
    assert.equal('emotion' in request.payload.voice_setting, false);
});

test('builds and sanitizes MiniMax official voice discovery', () => {
    const request = buildMinimaxVoiceListRequest({ apiKey: 'mini-secret', platform: 'io' });
    assert.equal(request.url, MINIMAX_VOICE_ENDPOINTS.io);
    assert.equal(request.headers.Authorization, 'Bearer mini-secret');
    assert.deepEqual(request.payload, { voice_type: 'all' });
    assert.equal(JSON.stringify(request.payload).includes('mini-secret'), false);
    const voices = parseMinimaxVoiceListResponse(Buffer.from(JSON.stringify({
        base_resp: { status_code: 0 },
        system_voice: [{ voice_id: 'system-one', voice_name: '系统一', description: ['中文', '女声'], private: 'drop-me' }],
        voice_cloning: [{ voice_id: 'clone-one', voice_name: '我的复刻' }],
        voice_generation: [{ voice_id: 'system-one', voice_name: '重复项' }],
    })));
    assert.deepEqual(voices, [
        { voiceId: 'system-one', name: '系统一', description: '中文；女声', kind: 'system' },
        { voiceId: 'clone-one', name: '我的复刻', description: '', kind: 'voice_cloning' },
    ]);
    assert.equal('private' in voices[0], false);
});

test('builds a fixed Xiaomi MiMo request and decodes base64 audio', () => {
    const request = buildXiaomiMimoRequest({
        apiKey: 'mimo-secret', model: 'mimo-v2.5-tts', voiceId: 'mimo_default',
        text: '你好', format: 'wav', style: '温柔',
    });
    assert.equal(request.url, XIAOMI_MIMO_ENDPOINT);
    assert.equal(request.headers['api-key'], 'mimo-secret');
    assert.equal(request.headers.Authorization, 'Bearer mimo-secret');
    assert.deepEqual(request.payload.messages.map(item => item.role), ['user', 'assistant']);
    assert.equal(JSON.stringify(request.payload).includes('mimo-secret'), false);
    const audio = parseXiaomiMimoResponse(Buffer.from(JSON.stringify({
        choices: [{ message: { audio: { data: Buffer.from('wav').toString('base64') } } }],
    })), 1024);
    assert.equal(audio.toString(), 'wav');
});

test('server exposes abortable MiniMax and Xiaomi MiMo proxy routes', async () => {
    const source = await readFile(new URL('../server-plugin/HybridAudiobookStage-Launcher/index.js', import.meta.url), 'utf8');
    assert.match(source, /registerCloudTtsRoute\('\/minimax-tts\/generate'/);
    assert.match(source, /registerCloudTtsRoute\('\/xiaomi-mimo-tts\/generate'/);
    assert.match(source, /router\.post\('\/minimax-tts\/voices'/);
    assert.match(source, /req\.once\('aborted', abortForClient\)/);
    assert.match(source, /signal: controller\.signal/);
});
