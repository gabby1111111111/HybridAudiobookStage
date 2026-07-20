import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoubaoProxyPayload, buildOpenAiSpeechPayload, createProviderRegistry } from '../public/lib/tts-providers.mjs';

const profile = {
    id: 'index-local',
    name: 'Index local',
    type: 'openai-compatible',
    enabled: true,
    endpoint: 'http://127.0.0.1:7880/v1/audio/speech',
    apiKey: 'secret-key',
    model: 'index-tts2',
    defaultVoice: 'default.wav',
    responseFormat: 'wav',
    extraBody: { emo_weight: 0.6 },
    requestMode: 'server-proxy',
};

test('builds a standard OpenAI-compatible payload with extensions', () => {
    assert.deepEqual(buildOpenAiSpeechPayload(profile, {
        text: '你好',
        voiceId: 'alice.wav',
        synthesisParams: { speed: 1.2 },
        extraBody: { emo_control_method: 2 },
    }), {
        model: 'index-tts2',
        input: '你好',
        voice: 'alice.wav',
        response_format: 'wav',
        speed: 1.2,
        emo_weight: 0.6,
        emo_control_method: 2,
    });
});

test('routes OpenAI-compatible synthesis through the server proxy', async () => {
    const calls = [];
    const registry = createProviderRegistry({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response(new Blob(['RIFFaudio'], { type: 'audio/wav' }), { status: 200 });
        },
        getSillyTavernHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }),
    });

    const result = await registry.synthesize(profile, { text: '测试', signal: new AbortController().signal });
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(calls[0].url, '/api/plugins/hybrid-audiobook-stage/tts/proxy');
    assert.equal(sent.endpoint, profile.endpoint);
    assert.equal(sent.apiKey, 'secret-key');
    assert.equal(sent.payload.input, '测试');
    assert.equal(result.profileId, profile.id);
    assert.equal(result.mimeType, 'audio/wav');
});

test('supports direct OpenAI-compatible requests without leaking the key into payload', async () => {
    const direct = { ...profile, requestMode: 'direct' };
    let call;
    const registry = createProviderRegistry({
        fetchImpl: async (url, options) => {
            call = { url, options };
            return new Response(new Blob(['RIFFaudio'], { type: 'audio/wav' }), { status: 200 });
        },
    });
    await registry.synthesize(direct, { text: '测试' });
    assert.equal(call.url, direct.endpoint);
    assert.equal(call.options.headers.Authorization, 'Bearer secret-key');
    assert.equal(JSON.stringify(JSON.parse(call.options.body)).includes('secret-key'), false);
});

test('routes Edge synthesis to the installed Edge plugin', async () => {
    let call;
    const registry = createProviderRegistry({
        fetchImpl: async (url, options) => {
            call = { url, options };
            return new Response(new Blob(['RIFFedge'], { type: 'audio/wav' }), { status: 200 });
        },
    });
    const result = await registry.synthesize({
        id: 'edge', type: 'edge', enabled: true, edgeVoice: 'zh-CN-XiaoxiaoNeural', edgeRate: 5,
    }, { text: '旁白' });
    assert.equal(call.url, '/api/plugins/edge-tts/generate');
    assert.deepEqual(JSON.parse(call.options.body), {
        text: '旁白', voice: 'zh-CN-XiaoxiaoNeural', rate: 5,
    });
    assert.equal(result.providerId, 'edge');
});

test('routes native Doubao synthesis through the fixed local proxy', async () => {
    let call;
    const doubao = {
        id: 'doubao-native', type: 'doubao', enabled: true,
        appId: 'app-id', accessKey: 'access-secret', resourceId: 'seed-tts-2.0',
        defaultVoice: 'zh_female_xueayi_saturn_bigtts', contextText: '温柔地说',
    };
    assert.deepEqual(buildDoubaoProxyPayload(doubao, { text: '你好' }), {
        appId: 'app-id', accessKey: 'access-secret', resourceId: 'seed-tts-2.0',
        speaker: 'zh_female_xueayi_saturn_bigtts', text: '你好', contextText: '温柔地说',
    });
    const registry = createProviderRegistry({
        fetchImpl: async (url, options) => {
            call = { url, options };
            return new Response(new Blob(['mp3audio'], { type: 'audio/mpeg' }), { status: 200 });
        },
    });
    const result = await registry.synthesize(doubao, { text: '你好' });
    assert.equal(call.url, '/api/plugins/hybrid-audiobook-stage/doubao-tts/generate');
    assert.equal(JSON.parse(call.options.body).accessKey, 'access-secret');
    assert.equal(result.providerId, 'doubao');
    assert.equal(JSON.stringify(result.cacheDescriptor).includes('access-secret'), false);
});

test('propagates abort and HTTP errors', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const abortRegistry = createProviderRegistry({
        fetchImpl: async (_url, options) => {
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            return new Response('unexpected', { status: 500 });
        },
    });
    await assert.rejects(abortRegistry.synthesize(profile, { text: '测试', signal: aborted.signal }), { name: 'AbortError' });

    const errorRegistry = createProviderRegistry({
        fetchImpl: async () => new Response('provider failed', { status: 429 }),
    });
    await assert.rejects(errorRegistry.synthesize(profile, { text: '测试' }), /HTTP 429 provider failed/);
});
