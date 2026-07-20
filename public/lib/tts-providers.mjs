function assertProfile(profile, expectedType = null) {
    if (!profile || typeof profile !== 'object') throw new Error('TTS Provider Profile 不存在');
    if (profile.enabled === false) throw new Error(`TTS Profile 已禁用: ${profile.name || profile.id || 'unknown'}`);
    if (expectedType && profile.type !== expectedType) throw new Error(`TTS Profile 类型不匹配: ${profile.type || 'unknown'}`);
}

function ensureText(value) {
    const text = String(value || '').trim();
    if (!text) throw new Error('TTS 文本为空');
    return text;
}

async function readAudioResponse(response, label) {
    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`${label} HTTP ${response.status}${message ? ` ${message.slice(0, 300)}` : ''}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error(`${label} 返回了空音频`);
    const mimeType = blob.type || response.headers.get('content-type') || 'audio/wav';
    if (/json|text\/html/i.test(mimeType)) {
        const message = await blob.text().catch(() => '');
        throw new Error(`${label} 未返回音频${message ? `: ${message.slice(0, 300)}` : ''}`);
    }
    return { blob, mimeType };
}

export function buildOpenAiSpeechPayload(profile, request) {
    assertProfile(profile, 'openai-compatible');
    const text = ensureText(request?.text);
    const model = String(request?.model || profile.model || '').trim();
    const voice = String(request?.voiceId || profile.defaultVoice || '').trim();
    if (!model) throw new Error('OpenAI 兼容 Profile 缺少 model');
    if (!voice) throw new Error('OpenAI 兼容 Profile 缺少 voice');

    const extraBody = profile.extraBody && typeof profile.extraBody === 'object' && !Array.isArray(profile.extraBody)
        ? profile.extraBody
        : {};
    const requestExtra = request?.extraBody && typeof request.extraBody === 'object' && !Array.isArray(request.extraBody)
        ? request.extraBody
        : {};
    return {
        model,
        input: text,
        voice,
        response_format: String(request?.responseFormat || profile.responseFormat || 'wav'),
        speed: Number.isFinite(Number(request?.synthesisParams?.speed)) ? Number(request.synthesisParams.speed) : 1,
        ...extraBody,
        ...requestExtra,
    };
}

export function buildDoubaoProxyPayload(profile, request) {
    assertProfile(profile, 'doubao');
    const text = ensureText(request?.text);
    const appId = String(profile.appId || '').trim();
    const accessKey = String(profile.accessKey || '').trim();
    const resourceId = String(profile.resourceId || 'seed-tts-2.0').trim();
    const speaker = String(request?.voiceId || profile.defaultVoice || '').trim();
    const contextText = String(request?.contextText || profile.contextText || '').trim();
    if (!appId) throw new Error('豆包 Profile 缺少 APP ID');
    if (!accessKey) throw new Error('豆包 Profile 缺少 Access Key');
    if (!resourceId) throw new Error('豆包 Profile 缺少 Resource ID');
    if (!speaker) throw new Error('豆包 Profile 缺少 Speaker ID');
    return { appId, accessKey, resourceId, speaker, text, contextText };
}

export function createProviderRegistry({
    fetchImpl = globalThis.fetch,
    getSillyTavernHeaders = () => ({ 'Content-Type': 'application/json' }),
    proxyBase = '/api/plugins/hybrid-audiobook-stage',
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

    const adapters = {
        'openai-compatible': {
            async probe(profile, signal) {
                assertProfile(profile, 'openai-compatible');
                const endpoint = String(profile.endpoint || '').trim();
                if (!endpoint) throw new Error('OpenAI 兼容 Profile 缺少 endpoint');
                if (profile.requestMode === 'direct') return { ok: true, mode: 'direct', unverified: true };
                const response = await fetchImpl(`${proxyBase}/tts/probe`, {
                    method: 'POST',
                    headers: getSillyTavernHeaders(),
                    body: JSON.stringify({ endpoint, apiKey: profile.apiKey || '' }),
                    signal,
                });
                if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
                return response.json();
            },
            async listVoices() {
                return [];
            },
            async synthesize(profile, request) {
                assertProfile(profile, 'openai-compatible');
                const endpoint = String(profile.endpoint || '').trim();
                if (!endpoint) throw new Error('OpenAI 兼容 Profile 缺少 endpoint');
                const payload = buildOpenAiSpeechPayload(profile, request);
                let response;
                if (profile.requestMode === 'direct') {
                    const headers = { 'Content-Type': 'application/json' };
                    if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
                    response = await fetchImpl(endpoint, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(payload),
                        signal: request.signal,
                    });
                } else {
                    response = await fetchImpl(`${proxyBase}/tts/proxy`, {
                        method: 'POST',
                        headers: getSillyTavernHeaders(),
                        body: JSON.stringify({ endpoint, apiKey: profile.apiKey || '', payload }),
                        signal: request.signal,
                    });
                }
                const audio = await readAudioResponse(response, profile.name || 'OpenAI-compatible TTS');
                return {
                    ...audio,
                    providerId: 'openai-compatible',
                    profileId: profile.id,
                    model: payload.model,
                    voiceId: payload.voice,
                    cacheDescriptor: { payload, endpoint },
                };
            },
        },
        edge: {
            async probe(_profile, signal) {
                const response = await fetchImpl('/api/plugins/edge-tts/probe', {
                    method: 'POST',
                    headers: getSillyTavernHeaders(),
                    signal,
                });
                if (!response.ok && response.status !== 204) throw new Error(`Edge TTS HTTP ${response.status}`);
                return { ok: true };
            },
            async listVoices() {
                return [];
            },
            async synthesize(profile, request) {
                assertProfile(profile, 'edge');
                const text = ensureText(request?.text);
                const voice = String(request?.voiceId || profile.edgeVoice || '').trim();
                if (!voice) throw new Error('Edge Profile 缺少 voice');
                const rate = Number.isFinite(Number(request?.synthesisParams?.rate))
                    ? Number(request.synthesisParams.rate)
                    : (Number(profile.edgeRate) || 0);
                const response = await fetchImpl('/api/plugins/edge-tts/generate', {
                    method: 'POST',
                    headers: getSillyTavernHeaders(),
                    body: JSON.stringify({ text, voice, rate }),
                    signal: request.signal,
                });
                const audio = await readAudioResponse(response, profile.name || 'Edge TTS');
                return {
                    ...audio,
                    providerId: 'edge',
                    profileId: profile.id,
                    model: 'edge-tts',
                    voiceId: voice,
                    cacheDescriptor: { text, voice, rate },
                };
            },
        },
        doubao: {
            async probe(profile) {
                buildDoubaoProxyPayload(profile, { text: '配置检查' });
                return { ok: true, configured: true, unverified: true };
            },
            async listVoices() {
                return [];
            },
            async synthesize(profile, request) {
                const payload = buildDoubaoProxyPayload(profile, request);
                const response = await fetchImpl(`${proxyBase}/doubao-tts/generate`, {
                    method: 'POST',
                    headers: getSillyTavernHeaders(),
                    body: JSON.stringify(payload),
                    signal: request.signal,
                });
                const audio = await readAudioResponse(response, profile.name || '豆包 TTS');
                return {
                    ...audio,
                    providerId: 'doubao',
                    profileId: profile.id,
                    model: payload.resourceId,
                    voiceId: payload.speaker,
                    cacheDescriptor: {
                        resourceId: payload.resourceId,
                        speaker: payload.speaker,
                        text: payload.text,
                        contextText: payload.contextText,
                    },
                };
            },
        },
    };

    return {
        get(profile) {
            assertProfile(profile);
            const adapter = adapters[profile.type];
            if (!adapter) throw new Error(`不支持的 TTS Provider: ${profile.type || 'unknown'}`);
            return adapter;
        },
        probe(profile, signal) {
            return this.get(profile).probe(profile, signal);
        },
        listVoices(profile, signal) {
            return this.get(profile).listVoices(profile, signal);
        },
        synthesize(profile, request) {
            return this.get(profile).synthesize(profile, request);
        },
    };
}
