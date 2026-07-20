const presentations = {
    idle: {
        iconClass: 'fa-solid fa-headphones-simple',
        label: '生成并播放单句',
        busy: false,
        pressed: false,
    },
    preparing: {
        iconClass: 'fa-solid fa-spinner fa-spin',
        label: '正在准备单句语音',
        busy: true,
        pressed: false,
    },
    ready: {
        iconClass: 'fa-solid fa-play',
        label: '播放已准备好的单句',
        busy: false,
        pressed: false,
    },
    playing: {
        iconClass: 'fa-solid fa-pause',
        label: '停止当前单句',
        busy: false,
        pressed: true,
    },
    error: {
        iconClass: 'fa-solid fa-rotate-right',
        label: '重新准备并播放单句',
        busy: false,
        pressed: false,
    },
};

export function getInlineDialogueButtonPresentation(state = 'idle') {
    return presentations[state] || presentations.idle;
}
