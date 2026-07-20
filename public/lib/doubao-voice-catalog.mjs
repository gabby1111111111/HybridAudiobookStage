export const DOUBAO_ICL_RESOURCE_ID = 'seed-icl-2.0';

export const DOUBAO_CATBOX_VOICE_GROUPS = Object.freeze([
    Object.freeze({
        id: 'male',
        label: '猫箱同款 · 男声',
        voices: Object.freeze([
            ['傲气凌人', 'ICL_uranus_zh_male_aoqilingren_tob'],
            ['傲娇公子', 'ICL_uranus_zh_male_aojiaogongzi_tob'],
            ['傲娇精英', 'ICL_uranus_zh_male_aojiaojingying_tob'],
            ['傲慢少爷', 'ICL_uranus_zh_male_aomanshaoye_tob'],
            ['病娇白莲', 'ICL_uranus_zh_male_bingjiaobailian_tob'],
            ['病娇弟弟', 'ICL_uranus_zh_male_bingjiaodidi_tob'],
            ['病娇哥哥', 'ICL_uranus_zh_male_bingjiaogege_tob'],
            ['清冷矜贵', 'ICL_uranus_zh_male_qinglengjingui_tob'],
            ['绿茶小哥', 'ICL_uranus_zh_male_lvchaxiaoge_tob'],
            ['寡言小哥', 'ICL_uranus_zh_male_guayanxiaoge_tob'],
            ['清朗温润', 'ICL_uranus_zh_male_qinglangwenrun_tob'],
            ['青涩小生', 'ICL_uranus_zh_male_qingsexiaosheng_tob'],
            ['温柔内敛', 'ICL_uranus_zh_male_wenrouneilian_tob'],
            ['幽默叔叔', 'ICL_uranus_zh_male_youmoshushu_tob'],
            ['优柔公子', 'ICL_uranus_zh_male_yourougongzi_tob'],
            ['沉稳优雅', 'ICL_uranus_zh_male_chenwenyouya_tob'],
            ['活泼爽朗', 'ICL_uranus_zh_male_huoposhuanglang_tob'],
            ['憨厚敦实', 'ICL_uranus_zh_male_hanhoudunshi_tob'],
            ['诡异神秘', 'ICL_uranus_zh_male_guiyishenmi_tob'],
            ['固执病娇', 'ICL_uranus_zh_male_guzhibingjiao_tob'],
            ['蓝银草魂师', 'ICL_uranus_zh_male_lanyincaohunshi_tob'],
            ['闷油瓶小哥', 'ICL_uranus_zh_male_menyoupingxiaoge_tob'],
            ['翩翩公子', 'ICL_uranus_zh_male_pianpiangongzi_tob'],
            ['撒娇粘人', 'ICL_uranus_zh_male_sajiaonianren_tob'],
            ['仗剑君子', 'ICL_uranus_zh_male_zhangjianjunzi_tob'],
            ['正直青年', 'ICL_uranus_zh_male_zhengzhiqingnian_tob'],
            ['贴心男友', 'ICL_uranus_zh_male_tiexinnanyou_tob'],
        ].map(([name, voiceId]) => Object.freeze({ name, voiceId }))),
    }),
    Object.freeze({
        id: 'female',
        label: '猫箱同款 · 女声',
        voices: Object.freeze([
            ['傲娇女友', 'ICL_uranus_zh_female_aojiaonvyou_tob'],
            ['病娇姐姐', 'ICL_uranus_zh_female_bingjiaojiejie_tob'],
            ['病娇萌妹', 'ICL_uranus_zh_female_bingjiaomengmei_tob'],
            ['成熟姐姐', 'ICL_uranus_zh_female_chengshujiejie_tob'],
            ['活泼刁蛮', 'ICL_uranus_zh_female_huopodiaoman_tob'],
            ['娇弱萝莉', 'ICL_uranus_zh_female_jiaoruoluoli_tob'],
            ['假小子', 'ICL_uranus_zh_female_jiaxiaozi_tob'],
            ['可爱女生', 'ICL_uranus_zh_female_keainvsheng_tob'],
            ['清冷高雅', 'ICL_uranus_zh_female_qinglenggaoya_tob'],
            ['柔骨魂师', 'ICL_uranus_zh_female_rouguhunshi_tob'],
            ['甜美娇俏', 'ICL_uranus_zh_female_tianmeijiaoqiao_tob'],
            ['甜美活泼', 'ICL_uranus_zh_female_tianmeihuopo_tob'],
            ['调皮公主', 'ICL_uranus_zh_female_tiaopigongzhu_tob'],
            ['贴心女友', 'ICL_uranus_zh_female_tiexinnvyou_tob'],
            ['温柔文雅', 'ICL_uranus_zh_female_wenrouwenya_tob'],
            ['妩媚御姐', 'ICL_uranus_zh_female_wumeiyujie_tob'],
            ['性感御姐', 'ICL_uranus_zh_female_xingganyujie_tob'],
            ['知性温婉', 'ICL_uranus_zh_female_zhixingwenwan_tob'],
        ].map(([name, voiceId]) => Object.freeze({ name, voiceId }))),
    }),
]);

const catalogByVoiceId = new Map(
    DOUBAO_CATBOX_VOICE_GROUPS.flatMap(group => group.voices.map(voice => [voice.voiceId, { ...voice, groupId: group.id }])),
);

export function getDoubaoCatboxVoice(voiceId) {
    return catalogByVoiceId.get(String(voiceId || '').trim()) || null;
}

export function isDoubaoCatboxVoice(voiceId) {
    return catalogByVoiceId.has(String(voiceId || '').trim());
}
