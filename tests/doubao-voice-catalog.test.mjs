import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DOUBAO_CATBOX_VOICE_GROUPS,
    DOUBAO_ICL_RESOURCE_ID,
    getDoubaoCatboxVoice,
    isDoubaoCatboxVoice,
} from '../public/lib/doubao-voice-catalog.mjs';

test('contains the complete 27 male and 18 female Catbox ICL voice catalog', () => {
    assert.equal(DOUBAO_ICL_RESOURCE_ID, 'seed-icl-2.0');
    assert.deepEqual(DOUBAO_CATBOX_VOICE_GROUPS.map(group => [group.id, group.voices.length]), [
        ['male', 27],
        ['female', 18],
    ]);
    const voices = DOUBAO_CATBOX_VOICE_GROUPS.flatMap(group => group.voices);
    assert.equal(voices.length, 45);
    assert.equal(new Set(voices.map(voice => voice.voiceId)).size, 45);
    assert.ok(voices.every(voice => /^ICL_uranus_zh_(?:male|female)_[a-z]+_tob$/.test(voice.voiceId)));
});

test('looks up catalog names and rejects unrelated Doubao speaker ids', () => {
    assert.deepEqual(getDoubaoCatboxVoice('ICL_uranus_zh_male_aoqilingren_tob'), {
        name: '傲气凌人',
        voiceId: 'ICL_uranus_zh_male_aoqilingren_tob',
        groupId: 'male',
    });
    assert.equal(isDoubaoCatboxVoice('ICL_uranus_zh_female_zhixingwenwan_tob'), true);
    assert.equal(isDoubaoCatboxVoice('custom-speaker'), false);
});
