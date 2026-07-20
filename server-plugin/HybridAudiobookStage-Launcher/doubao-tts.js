const DOUBAO_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const MAX_TEXT_LENGTH = 10000;
const MAX_CONTEXT_LENGTH = 2000;

function requiredText(value, label, maxLength = 512) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`豆包 TTS 缺少 ${label}`);
    if (text.length > maxLength) throw new Error(`豆包 TTS ${label} 过长`);
    return text;
}

function buildDoubaoUpstreamRequest(input = {}) {
    const appId = requiredText(input.appId, 'APP ID');
    const accessKey = requiredText(input.accessKey, 'Access Key', 2048);
    const resourceId = requiredText(input.resourceId || DEFAULT_RESOURCE_ID, 'Resource ID');
    const speaker = requiredText(input.speaker, 'Speaker ID');
    const text = requiredText(input.text, '文本', MAX_TEXT_LENGTH);
    const contextText = String(input.contextText || '').trim().slice(0, MAX_CONTEXT_LENGTH);

    return {
        url: DOUBAO_TTS_ENDPOINT,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Api-App-Key': appId,
            'X-Api-Access-Key': accessKey,
            'X-Api-Resource-Id': resourceId,
        },
        payload: {
            user: { uid: 'hybrid-audiobook-stage' },
            req_params: {
                text,
                speaker,
                audio_params: {
                    format: 'mp3',
                    sample_rate: 24000,
                },
                additions: JSON.stringify({
                    context_texts: contextText ? [contextText] : [],
                }),
            },
        },
    };
}

function parseDoubaoNdjson(value, maxBytes) {
    const chunks = [];
    let totalBytes = 0;
    const lines = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            throw new Error('豆包 TTS 返回了无法解析的流数据');
        }
        const code = Number(event?.code);
        if (code === 0 && event.data) {
            const chunk = Buffer.from(String(event.data), 'base64');
            if (!chunk.length) continue;
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) throw new Error('豆包 TTS 音频超过大小限制');
            chunks.push(chunk);
            continue;
        }
        if (code === 0 || code === 20000000) continue;
        if (Number.isFinite(code) && code > 0) {
            const message = String(event.message || event.msg || event.error || '').slice(0, 300);
            throw new Error(`豆包 TTS 错误 ${code}${message ? `：${message}` : ''}`);
        }
    }
    if (!chunks.length) throw new Error('豆包 TTS 没有返回音频');
    return Buffer.concat(chunks, totalBytes);
}

module.exports = {
    DEFAULT_RESOURCE_ID,
    DOUBAO_TTS_ENDPOINT,
    buildDoubaoUpstreamRequest,
    parseDoubaoNdjson,
};
