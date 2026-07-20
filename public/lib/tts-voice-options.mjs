const MAX_PROFILE_VOICE_OPTIONS = 100;

function normalizeVoiceId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function matchesVoiceSearch(searchText, query) {
    const normalizedQuery = String(query || '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
    if (!normalizedQuery) return true;
    const normalizedSearchText = String(searchText || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
    return normalizedSearchText.includes(normalizedQuery);
}

function addVoice(target, value) {
    const voiceId = normalizeVoiceId(value);
    if (voiceId) target.add(voiceId);
}

export function collectProfileVoiceOptions(settings, profileId, selectedVoice = '') {
    const normalizedProfileId = normalizeVoiceId(profileId);
    const profile = settings?.providerProfiles?.[normalizedProfileId];
    if (!normalizedProfileId || !profile) return [];

    const voices = new Set();
    addVoice(voices, profile.lastUsedVoice);
    addVoice(voices, profile.defaultVoice);
    addVoice(voices, profile.edgeVoice);
    for (const voiceId of Array.isArray(profile.voiceOptions) ? profile.voiceOptions : []) {
        addVoice(voices, voiceId);
    }

    for (const preset of Object.values(settings?.routingPresets || {})) {
        for (const route of [preset?.narration, preset?.dialogueDefault, preset?.singleVoice]) {
            if (normalizeVoiceId(route?.profileId) === normalizedProfileId) addVoice(voices, route?.voiceId);
        }
        for (const route of Object.values(preset?.characterOverrides || {})) {
            if (normalizeVoiceId(route?.profileId) === normalizedProfileId) addVoice(voices, route?.voiceId);
        }
    }

    addVoice(voices, selectedVoice);
    const lastUsedVoice = normalizeVoiceId(profile.lastUsedVoice);
    return Array.from(voices).sort((left, right) => {
        if (left === lastUsedVoice) return -1;
        if (right === lastUsedVoice) return 1;
        return left.localeCompare(right, 'zh-CN');
    });
}

export function chooseProfileVoice(settings, profileId, preferredVoice = '') {
    const options = collectProfileVoiceOptions(settings, profileId);
    const preferred = normalizeVoiceId(preferredVoice);
    if (preferred && options.includes(preferred)) return preferred;

    const profile = settings?.providerProfiles?.[normalizeVoiceId(profileId)];
    const lastUsedVoice = normalizeVoiceId(profile?.lastUsedVoice);
    if (lastUsedVoice && options.includes(lastUsedVoice)) return lastUsedVoice;
    const profileDefault = normalizeVoiceId(profile?.defaultVoice || profile?.edgeVoice);
    if (profileDefault && options.includes(profileDefault)) return profileDefault;
    return options[0] || '';
}

export function rememberProfileVoice(profile, voiceId, limit = MAX_PROFILE_VOICE_OPTIONS) {
    if (!profile || typeof profile !== 'object') return [];
    const normalized = normalizeVoiceId(voiceId);
    const boundedLimit = Math.max(1, Math.min(MAX_PROFILE_VOICE_OPTIONS, Number(limit) || MAX_PROFILE_VOICE_OPTIONS));
    const voices = [];
    for (const value of Array.isArray(profile.voiceOptions) ? profile.voiceOptions : []) {
        const item = normalizeVoiceId(value);
        if (!item || item === normalized || voices.includes(item)) continue;
        voices.push(item);
    }
    if (normalized) voices.push(normalized);
    profile.voiceOptions = voices.slice(-boundedLimit);
    if (normalized) profile.lastUsedVoice = normalized;
    return profile.voiceOptions;
}
