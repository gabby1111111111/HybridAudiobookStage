const MODES = new Set(['mixed', 'dialogue-only', 'single-voice']);

export function normalizePresetMode(value) {
    return MODES.has(value) ? value : 'mixed';
}

export function resolveSegmentRoute(segment, preset, profiles, { ignoreCharacterOverrideProfileId = '' } = {}) {
    const mode = normalizePresetMode(preset?.mode);
    let target;
    if (mode === 'single-voice' || segment?.type === 'single') {
        target = preset?.singleVoice;
    } else if (segment?.type === 'narration') {
        target = preset?.narration;
    } else {
        const characterOverride = preset?.characterOverrides?.[segment?.character];
        const ignoredProfileId = String(ignoreCharacterOverrideProfileId || '').trim();
        target = ignoredProfileId && characterOverride?.profileId === ignoredProfileId
            ? preset?.dialogueDefault
            : (characterOverride || preset?.dialogueDefault);
    }

    const profileId = String(target?.profileId || '').trim();
    const profile = profiles?.[profileId];
    const voiceId = String(target?.voiceId || profile?.defaultVoice || profile?.edgeVoice || '').trim();
    if (!profileId || !profile) {
        return { ok: false, profileId, voiceId, error: `找不到 TTS Profile: ${profileId || '未配置'}` };
    }
    if (profile.enabled === false) {
        return { ok: false, profileId, voiceId, error: `TTS Profile 已禁用: ${profile.name || profileId}` };
    }
    if (!voiceId) {
        return { ok: false, profileId, voiceId, error: `TTS Profile 缺少音色: ${profile.name || profileId}` };
    }
    return { ok: true, profileId, voiceId, providerType: profile.type, profile, error: null };
}

export function applyPresetRouting(segments, preset, profiles) {
    const routed = [];
    const unresolved = [];
    for (const segment of segments || []) {
        const route = resolveSegmentRoute(segment, preset, profiles);
        const item = {
            ...segment,
            profileId: route.profileId,
            voiceId: route.voiceId,
            providerType: route.providerType || null,
            routeError: route.error,
        };
        routed.push(item);
        if (!route.ok) unresolved.push(item);
    }
    return { segments: routed, unresolved };
}

export function summarizeCharacterOverrides(preset, profileId = '') {
    const entries = Object.entries(preset?.characterOverrides || {}).filter(([, route]) => route && typeof route === 'object');
    return {
        total: entries.length,
        matchingProfile: profileId ? entries.filter(([, route]) => route.profileId === profileId).length : 0,
    };
}

export function removeCharacterOverridesByProfile(preset, profileId, legacyVoiceMap = null) {
    if (!preset?.characterOverrides || !profileId) return [];
    const removed = [];
    for (const [character, route] of Object.entries(preset.characterOverrides)) {
        if (route?.profileId !== profileId) continue;
        delete preset.characterOverrides[character];
        if (legacyVoiceMap && legacyVoiceMap[character] === route.voiceId) delete legacyVoiceMap[character];
        removed.push(character);
    }
    return removed;
}
