export const TTS_CACHE_ADAPTER_VERSION = 2;

function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
    }
    return value;
}

export function stableSerialize(value) {
    return JSON.stringify(sortValue(value));
}

export function buildSynthesisDescriptor({
    text,
    providerType,
    profileId,
    endpoint = '',
    model = '',
    voiceId,
    responseFormat = 'wav',
    synthesisParams = {},
    extraBody = {},
} = {}) {
    return {
        adapterVersion: TTS_CACHE_ADAPTER_VERSION,
        text: String(text || '').replace(/\s+/g, ' ').trim(),
        providerType: String(providerType || ''),
        profileId: String(profileId || ''),
        endpoint: String(endpoint || '').trim(),
        model: String(model || ''),
        voiceId: String(voiceId || ''),
        responseFormat: String(responseFormat || 'wav'),
        synthesisParams: sortValue(synthesisParams || {}),
        extraBody: sortValue(extraBody || {}),
    };
}

export function chooseLruEvictions(entries, maxBytes) {
    const normalized = (entries || []).map(entry => ({
        ...entry,
        size: Math.max(0, Number(entry.size || entry.blob?.size || 0)),
        lastAccessedAt: Number(entry.lastAccessedAt || entry.timestamp || 0),
    }));
    let totalBytes = normalized.reduce((sum, entry) => sum + entry.size, 0);
    const evictions = [];
    for (const entry of normalized.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)) {
        if (totalBytes <= maxBytes) break;
        evictions.push(entry.hash);
        totalBytes -= entry.size;
    }
    return { evictions, totalBytes };
}
