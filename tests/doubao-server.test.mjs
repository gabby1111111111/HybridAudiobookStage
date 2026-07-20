import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
    DOUBAO_TTS_ENDPOINT,
    buildDoubaoUpstreamRequest,
    parseDoubaoNdjson,
} = require('../server-plugin/HybridAudiobookStage-Launcher/doubao-tts.js');

test('builds the native Doubao v3 request without putting credentials in the payload', () => {
    const request = buildDoubaoUpstreamRequest({
        appId: 'app-id',
        accessKey: 'access-secret',
        resourceId: 'seed-tts-2.0',
        speaker: 'speaker-id',
        text: '你好',
        contextText: '温柔地说',
    });
    assert.equal(request.url, DOUBAO_TTS_ENDPOINT);
    assert.equal(request.headers['X-Api-App-Key'], 'app-id');
    assert.equal(request.headers['X-Api-Access-Key'], 'access-secret');
    assert.equal(request.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.equal(request.payload.req_params.speaker, 'speaker-id');
    assert.deepEqual(JSON.parse(request.payload.req_params.additions), { context_texts: ['温柔地说'] });
    assert.equal(JSON.stringify(request.payload).includes('access-secret'), false);
});

test('merges native Doubao NDJSON audio chunks and rejects provider errors', () => {
    const first = Buffer.from('first').toString('base64');
    const second = Buffer.from('second').toString('base64');
    const audio = parseDoubaoNdjson([
        JSON.stringify({ code: 0, data: first }),
        JSON.stringify({ code: 0, sentence: { text: 'ignored' } }),
        JSON.stringify({ code: 0, data: second }),
        JSON.stringify({ code: 20000000 }),
    ].join('\n'), 1024);
    assert.equal(audio.toString(), 'firstsecond');
    assert.throws(() => parseDoubaoNdjson(JSON.stringify({ code: 3001, message: 'bad speaker' }), 1024), /3001.*bad speaker/);
});

test('validates required Doubao credentials and synthesis inputs', () => {
    assert.throws(() => buildDoubaoUpstreamRequest({}), /APP ID/);
    assert.throws(() => buildDoubaoUpstreamRequest({ appId: 'a' }), /Access Key/);
});

test('server exposes a fixed Doubao proxy route and parses NDJSON before returning MP3', async () => {
    const source = await readFile(new URL('../server-plugin/HybridAudiobookStage-Launcher/index.js', import.meta.url), 'utf8');
    assert.match(source, /router\.post\('\/doubao-tts\/generate'/);
    assert.match(source, /parseDoubaoNdjson\(upstreamBuffer\.toString\('utf8'\)/);
    assert.match(source, /Content-Type', 'audio\/mpeg'/);
    assert.match(source, /req\.once\('aborted', abortForClient\)/);
    assert.match(source, /signal: controller\.signal/);
});

test('server exposes a read-only IndexTTS2 ckyp WAV discovery route', async () => {
    const source = await readFile(new URL('../server-plugin/HybridAudiobookStage-Launcher/index.js', import.meta.url), 'utf8');
    assert.match(source, /DEFAULT_INDEX_TTS_VOICE_DIR = process\.env\.HYBRID_AUDIOBOOK_INDEX_TTS_VOICE_DIR[\s\S]*?path\.join\(INDEX_TTS_ROOT, 'api', 'ckyp'\)/);
    assert.match(source, /router\.get\('\/index-tts2\/voices'/);
    assert.match(source, /path\.extname\(entry\.name\)\.toLowerCase\(\) === '\.wav'/);
    assert.match(source, /res\.json\(\{ ok: true, voices, count: voices\.length \}\)/);
});
