import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('lightweight TTS is the three-step default settings flow', () => {
    for (const testId of [
        'has-lightweight-step-mode',
        'has-lightweight-step-test',
        'has-lightweight-step-playback',
    ]) {
        assert.equal(source.match(new RegExp(`data-testid="${testId}"`, 'g'))?.length, 1);
    }
    assert.match(source, /<strong>三步开始朗读<\/strong>/);
    assert.match(source, /default_sections:/);
});

test('advanced and legacy settings remain available but collapsed by default', () => {
    assert.match(source, /<details class="has-settings-fold" data-testid="has-advanced-settings">/);
    assert.match(source, /<details class="has-settings-fold" data-testid="has-legacy-stage-settings">/);
    assert.doesNotMatch(source, /<details[^>]+data-testid="has-(?:advanced-settings|legacy-stage-settings)"[^>]+open/);
});

test('message toolbar keeps daily reading actions visible and moves utilities into more menu', () => {
    assert.match(source, /<details class="has-msg-more">/);
    assert.match(source, /class="has-floating-action has-play-msg"/);
    assert.match(source, /class="has-floating-action has-play-selection"/);
    assert.match(source, /class="has-floating-action has-play-paragraph"/);
    assert.match(source, /<div class="has-msg-more-menu">[\s\S]*has-infer-msg[\s\S]*has-check-msg[\s\S]*has-config-msg[\s\S]*<\/div>/);
});

test('provider test and preview resolve the visibly selected Profile', () => {
    assert.match(source, /function getSelectedProfile\(container, settings/);
    assert.match(source, /has-profile-test[\s\S]*?getSelectedProfile\(container, settings\)/);
    assert.match(source, /has-profile-preview[\s\S]*?getSelectedProfile\(container, settings\)/);
});

test('native Doubao setup stays compact and conditional in the lightweight connection step', () => {
    assert.match(source, /data-testid="has-doubao-quick"[^>]+hidden/);
    assert.match(source, /option value="doubao">豆包原生/);
    assert.match(source, /<div id="has-doubao-speaker-id" class="has-voice-combobox"/);
    assert.doesNotMatch(source, /<input id="has-doubao-speaker-id"/);
    assert.match(source, /aria-label="搜索测试声音 Speaker ID"/);
    assert.match(source, /fillRouteVoiceSelect\(\s*container\.querySelector\('#has-doubao-speaker-id'\)/);
    assert.match(source, /prompt\('输入新的 Speaker ID'/);
    assert.match(source, /function syncProfileTypeVisibility\(container, profile\)/);
    assert.match(source, /result\.unverified[\s\S]*?试听声音/);
    assert.match(source, /if \(profile\.type === 'doubao'\) return ensureDoubaoAudio/);
    assert.match(source, /providerType: 'doubao'[\s\S]*?extraBody: \{ contextText \}/);
});

test('MiniMax and Xiaomi MiMo use one compact conditional cloud setup', () => {
    assert.match(source, /data-testid="has-cloud-quick"[^>]+hidden/);
    assert.match(source, /option value="minimax">MiniMax 原生/);
    assert.match(source, /option value="xiaomi-mimo">小米 MiMo 原生/);
    assert.match(source, /if \(profile\.type === 'minimax'\) return ensureCloudAudio/);
    assert.match(source, /if \(profile\.type === 'xiaomi-mimo'\) return ensureCloudAudio/);
    for (const id of [
        'has-cloud-api-key', 'has-cloud-platform', 'has-cloud-model',
        'has-cloud-voice', 'has-cloud-format', 'has-cloud-style',
    ]) assert.equal(source.match(new RegExp(`id="${id}"`, 'g'))?.length, 1);
    assert.match(source, /<select id="has-cloud-model"/);
    assert.match(source, /<div id="has-cloud-voice" class="has-voice-combobox"/);
    assert.match(source, /id="has-minimax-refresh-voices"/);
    assert.match(source, /MINIMAX_MODEL_OPTIONS|function renderCloudModelSelect/);
    assert.match(source, /XIAOMI_MIMO_VOICES/);
    assert.match(source, /getCloudModelOptions\(profile\.type\)/);
    assert.match(source, /\/minimax-tts\/voices/);
});

test('lightweight routing warns when hidden legacy Index character overrides beat the visible default', () => {
    assert.match(source, /id="has-route-override-warning"[^>]+role="status"[^>]+hidden/);
    assert.match(source, /id="has-clear-legacy-index-overrides"/);
    assert.match(source, /summarizeCharacterOverrides\(preset, LEGACY_OPENAI_PROFILE_ID\)/);
    assert.match(source, /removeCharacterOverridesByProfile\([\s\S]*?LEGACY_OPENAI_PROFILE_ID/);
    assert.match(source, /仍有旧的 IndexTTS2 特定角色覆盖/);
});

test('lightweight route voices are provider-linked searchable comboboxes with a manual add path', () => {
    for (const id of ['has-route-narration-voice', 'has-route-dialogue-voice', 'has-route-single-voice']) {
        assert.match(source, new RegExp(`<div id="${id}" class="has-voice-combobox"`));
        assert.doesNotMatch(source, new RegExp(`<input id="${id}"`));
    }
    assert.equal(source.match(/placeholder="搜索名称、ID、Locale、Gender"/g)?.length, 5);
    assert.match(source, /function filterVoiceCombobox\(control, query/);
    assert.match(source, /matchesVoiceSearch\(option\.dataset\.search, normalizedQuery\)/);
    assert.match(source, /collectProfileVoiceOptions\(settings, profileId, selectedVoice\)/);
    assert.match(source, /手动添加音色 ID…/);
    assert.match(source, /chooseProfileVoice\(settings, profileId\)/);
    assert.match(source, /rememberProfileVoice\(profile, voiceId\)/);
});

test('Doubao route selects order used voices, manual ID entry, then grouped Catbox voices', () => {
    const fillStart = source.indexOf('function fillRouteVoiceSelect');
    const fillEnd = source.indexOf('function warnIfDoubaoIclResourceMismatch');
    const fillSource = source.slice(fillStart, fillEnd);
    assert.ok(fillStart > 0 && fillEnd > fillStart);
    assert.ok(fillSource.indexOf('已使用的音色') < fillSource.indexOf('手动添加音色 ID…'));
    assert.ok(fillSource.indexOf('手动添加音色 ID…') < fillSource.indexOf('DOUBAO_CATBOX_VOICE_GROUPS'));
    assert.match(fillSource, /usedVoiceIds\.has\(voice\.voiceId\)/);
    assert.match(source, /这个猫箱同款音色需要 Seed ICL 2\.0/);
});

test('Edge route selects order used voices, zh-CN male, zh-CN female, other source order, then manual ID', () => {
    const fillStart = source.indexOf('function fillRouteVoiceSelect');
    const fillEnd = source.indexOf('function warnIfDoubaoIclResourceMismatch');
    const fillSource = source.slice(fillStart, fillEnd);
    const usedIndex = fillSource.indexOf('已使用的音色');
    const edgeIndex = fillSource.indexOf('getPrioritizedEdgeVoiceGroups(voices)');
    const edgeManualIndex = fillSource.indexOf("addVoiceComboboxGroup(host, '添加音色'", edgeIndex);
    assert.ok(usedIndex >= 0 && edgeIndex > usedIndex && edgeManualIndex > edgeIndex);
    assert.match(fillSource, /meta: `\$\{voice\.locale\} · \$\{voice\.gender\} · \$\{voice\.voiceId\}`/);
    assert.match(fillSource, /getEdgeCatalogVoice\(voiceId\)/);
    assert.match(source, /updatePreset\(\);[\s\S]*?fillRouteVoiceSelect\(voiceSelect, settings, profileId, voiceId\)/);
});

test('IndexTTS2 route voices come from the ckyp directory and remember the Profile last selection', () => {
    assert.match(source, /fallbackIndexTtsVoiceCatalog = \['Nanami\.wav', 'QinChe\.wav', 'zjx\.wav'\]/);
    assert.match(source, /fetch\('\/api\/plugins\/hybrid-audiobook-stage\/index-tts2\/voices'/);
    assert.match(source, /IndexTTS2 · ckyp 音色/);
    assert.match(source, /rememberProfileVoice\(profile, voiceId\);[\s\S]*?updatePreset\(\)/);
});

test('voice options expose readable primary names and secondary metadata without clipping long ids', () => {
    assert.match(source, /function getEdgeVoiceReadableName\(voice\)/);
    assert.match(source, /primary\.className = 'has-voice-option-name'/);
    assert.match(source, /secondary\.className = 'has-voice-option-meta'/);
    assert.match(source, /selectionLabel: `\$\{name\} · \$\{voice\.locale\}`/);
    assert.match(style, /\.has-voice-combobox-popover \{[\s\S]*?width: calc\(200% \+ 8px\);[\s\S]*?min-width: 0;/);
    assert.match(style, /\.has-voice-option \{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/);
    assert.match(style, /\.has-voice-option-meta \{[\s\S]*?overflow-wrap: anywhere;/);
});

test('single dialogue and exact message selections preserve the full routed segment', () => {
    assert.match(source, /playLightweightText\(dialogue\.text,[\s\S]*?segment: dialogue/);
    assert.match(source, /sourceMessage = null/);
    assert.match(source, /collectSegmentsFromMessage\(sourceMessage\)\.segments[\s\S]*?normalizeWhitespace\(item\.text\) === normalizedTarget/);
    assert.match(source, /source: 'selection', sourceMessage:/);
    assert.match(source, /source: 'paragraph', sourceMessage:/);
});

test('inline dialogue buttons reflect cached and active full-message segments', () => {
    assert.match(source, /dialogueIndex: dialogueIndex\+\+/);
    assert.match(source, /setInlineDialogueButtonState\([\s\S]*?'ready',[\s\S]*?cacheReady: true/);
    assert.match(source, /currentInlineDialogueKey[\s\S]*?setInlineDialogueButtonState\([\s\S]*?'playing'/);
    assert.match(source, /activeSession\?\.inlineDialogueKey === dialogueKey \|\| activeSession\?\.currentInlineDialogueKey === dialogueKey/);
});

test('inline dialogue buttons proactively check local and shared cache availability', () => {
    assert.match(source, /async function hasLocalCachedAudio\(hash\)/);
    assert.match(source, /audio-cache\/verify/);
    assert.match(source, /async function scanInlineDialogueCache\(msg, analysis\)/);
    assert.match(source, /scanInlineDialogueCache\(msg, analysis\)/);
    assert.match(source, /applyInlineCacheAvailability\([\s\S]*?'ready' : 'idle'/);
});

test('synthesis-affecting routes cancel stale playback and rescan the current voice cache', () => {
    assert.match(source, /function invalidateSynthesisRouting\([\s\S]*?stopCurrentPlayback\(reason\);[\s\S]*?inlineDialogueCacheGeneration \+= 1;[\s\S]*?inlineDialogueButtonStates\.clear\(\);[\s\S]*?refreshMessageButtons\(\);/);
    assert.match(source, /const updatePreset = \(\) => \{[\s\S]*?invalidateSynthesisRouting\('tts_route_changed'\)/);
    assert.match(source, /has-character-profile[\s\S]*?invalidateSynthesisRouting\('character_override_changed'\)/);
    assert.match(source, /const cacheGeneration = inlineDialogueCacheGeneration;[\s\S]*?cacheGeneration !== inlineDialogueCacheGeneration/);
});

test('playback-only speed and volume do not invalidate synthesis routing', () => {
    const playbackRateStart = source.indexOf("container.querySelector('#has-speed')?.addEventListener('input'");
    const synthesisSpeedStart = source.indexOf("container.querySelector('#has-synthesis-speed')?.addEventListener('input'", playbackRateStart);
    const volumeStart = source.indexOf("container.querySelector('#has-volume')?.addEventListener('input'", synthesisSpeedStart);
    const addVoiceStart = source.indexOf("container.querySelector('#has-add-voice-row')?.addEventListener('click'", volumeStart);
    const playbackRateBinding = source.slice(playbackRateStart, synthesisSpeedStart);
    const volumeBinding = source.slice(volumeStart, addVoiceStart);
    assert.doesNotMatch(playbackRateBinding, /invalidateSynthesisRouting/);
    assert.doesNotMatch(volumeBinding, /invalidateSynthesisRouting/);
});

test('dialogue and narration use independent playback rates across queued source changes', () => {
    assert.match(source, /function getPlaybackRate\(segment[\s\S]*?dialoguePlaybackRate[\s\S]*?settings\.playbackRate/);
    assert.match(source, /function applyPlaybackSettings\(audio, segment[\s\S]*?audio\.playbackRate = getPlaybackRate\(segment\)/);
    assert.match(source, /if \(audio\.src !== item\.blobUrl\)[\s\S]*?audio\.load\(\);[\s\S]*?applyPlaybackSettings\(audio, item\);[\s\S]*?await audio\.play\(\)/);
    assert.match(source, /角色台词语速[\s\S]*?旁白语速/);
});

test('mobile player is forced into the safe viewport with a two-row control layout', () => {
    assert.match(style, /@media \(max-width: 720px\)[\s\S]*?\.has-player-window \{[\s\S]*?left: calc\(8px \+ env\(safe-area-inset-left,[\s\S]*?right: calc\(8px \+ env\(safe-area-inset-right,[\s\S]*?top: auto !important;/);
    assert.match(style, /@media \(max-width: 720px\)[\s\S]*?\.has-player-top \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto;/);
    assert.match(source, /player_ready[\s\S]*?current_audio_rate:[\s\S]*?visible: playerVisible,[\s\S]*?in_viewport:/);
});

test('persistent cache lookup is local-first and generation waits for IndexedDB save', () => {
    assert.match(source, /findAudioCacheHit\(\{[\s\S]*?memoryCache: audioMemoryCache[\s\S]*?readIndexedDb:[\s\S]*?readServer:/);
    assert.match(source, /await saveCachedAudio\(record\);[\s\S]*?record\.localPersisted = true/);
});

test('server cache reads verify existence before downloading audio', () => {
    const functionStart = source.indexOf('async function getServerCachedAudio');
    const functionEnd = source.indexOf('async function findCachedAudio', functionStart);
    const functionSource = source.slice(functionStart, functionEnd);
    assert.match(functionSource, /verifyServerCachedAudio\(\[hash\], signal\)/);
    assert.ok(functionSource.indexOf('verifyServerCachedAudio') < functionSource.indexOf('audio-cache\/\$\{encodeURIComponent\(hash\)\}'));
});

test('existing settings bindings keep exactly one matching control', () => {
    const requiredIds = [
        'has-tts-enabled', 'has-preset-select', 'has-preset-mode', 'has-profile-select',
        'has-profile-test', 'has-provider-status', 'has-profile-preview-text', 'has-profile-preview',
        'has-profile-preview-stop', 'has-synthesis-speed', 'has-speed', 'has-volume',
        'has-shared-cache', 'has-profile-name', 'has-profile-type', 'has-profile-endpoint',
        'has-profile-api-key', 'has-profile-model', 'has-profile-voice', 'has-profile-request-mode',
        'has-prefetch-count', 'has-voice-map', 'has-playback-ui', 'has-open-stage', 'has-open-window',
        'has-doubao-app-id', 'has-doubao-access-key', 'has-doubao-resource-id',
        'has-doubao-speaker-id', 'has-doubao-context-text',
        'has-route-override-warning', 'has-route-override-warning-text', 'has-clear-legacy-index-overrides',
    ];
    for (const id of requiredIds) {
        assert.equal(source.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, id);
    }
});
