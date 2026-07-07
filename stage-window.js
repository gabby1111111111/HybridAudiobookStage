(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const stateKey = params.get('state');
    const raw = stateKey ? localStorage.getItem(stateKey) : '';
    const payload = raw ? JSON.parse(raw) : {};
    if (stateKey) localStorage.removeItem(stateKey);

    const state = {
        segments: Array.isArray(payload.segments) ? payload.segments : [],
        index: 0,
        playing: !!payload.autoAdvance,
        timer: null,
        seconds: Math.max(1, Number(payload.secondsPerSubtitle) || 5),
        autoSized: false,
    };

    const stage = document.getElementById('stage');
    const video = document.getElementById('video');
    const subtitle = document.getElementById('subtitle');
    const counter = document.getElementById('counter');
    const play = document.getElementById('play');
    const fitSize = document.getElementById('fitSize');

    function applyVideo() {
        const fit = payload.videoFit || 'contain';
        stage.classList.toggle('fit-cover', fit === 'cover');
        stage.classList.toggle('fit-fill', fit === 'fill');
        stage.classList.toggle('fit-contain', fit !== 'cover' && fit !== 'fill');

        if (payload.videoUrl) {
            video.src = payload.videoUrl;
            video.play?.().catch(() => {});
        }

        updateMediaRect();
    }

    function setPx(name, value) {
        stage.style.setProperty(name, `${Math.round(value)}px`);
    }

    function updateMediaRect() {
        const fit = payload.videoFit || 'contain';
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        let mediaLeft = 0;
        let mediaTop = 0;
        let mediaWidth = windowWidth;
        let mediaHeight = windowHeight;

        if (fit === 'contain' && video.videoWidth > 0 && video.videoHeight > 0) {
            const aspect = video.videoWidth / video.videoHeight;
            mediaWidth = windowWidth;
            mediaHeight = mediaWidth / aspect;

            if (mediaHeight > windowHeight) {
                mediaHeight = windowHeight;
                mediaWidth = mediaHeight * aspect;
            }

            mediaLeft = (windowWidth - mediaWidth) / 2;
            mediaTop = (windowHeight - mediaHeight) / 2;
        }

        setPx('--media-left', mediaLeft);
        setPx('--media-top', mediaTop);
        setPx('--media-width', mediaWidth);
        setPx('--media-height', mediaHeight);
        setPx('--subtitle-left', mediaLeft + mediaWidth * 0.08);
        setPx('--subtitle-top', mediaTop + mediaHeight * 0.70);
        setPx('--subtitle-width', mediaWidth * 0.84);
        setPx('--controls-left', mediaLeft + mediaWidth / 2);
        setPx('--controls-bottom', Math.max(16, windowHeight - mediaTop - mediaHeight + mediaHeight * 0.035));
    }

    function render() {
        subtitle.textContent = state.segments[state.index] || '没有字幕数据';
        counter.textContent = state.segments.length ? `${state.index + 1} / ${state.segments.length}` : '0 / 0';
        play.textContent = state.playing ? 'Ⅱ' : '▶';
    }

    function schedule() {
        clearTimeout(state.timer);
        if (!state.playing) return;

        state.timer = setTimeout(() => {
            if (state.index >= state.segments.length - 1) {
                state.playing = false;
                render();
                return;
            }

            state.index += 1;
            render();
            schedule();
        }, state.seconds * 1000);
    }

    function toggle() {
        state.playing = !state.playing;
        render();
        schedule();
    }

    function next() {
        if (!state.segments.length) return;
        state.index = Math.min(state.index + 1, state.segments.length - 1);
        render();
        schedule();
    }

    function prev() {
        if (!state.segments.length) return;
        state.index = Math.max(state.index - 1, 0);
        render();
        schedule();
    }

    function fitWindowToVideo() {
        if (!video.videoWidth || !video.videoHeight) {
            updateMediaRect();
            return;
        }

        const maxContentWidth = Math.max(320, screen.availWidth - 80);
        const maxContentHeight = Math.max(240, screen.availHeight - 140);
        const scale = Math.min(1, maxContentWidth / video.videoWidth, maxContentHeight / video.videoHeight);
        const targetContentWidth = Math.round(video.videoWidth * scale);
        const targetContentHeight = Math.round(video.videoHeight * scale);
        const chromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
        const chromeHeight = Math.max(0, window.outerHeight - window.innerHeight);

        window.resizeTo(targetContentWidth + chromeWidth, targetContentHeight + chromeHeight);
        window.moveTo(
            Math.max(0, Math.round((screen.availWidth - targetContentWidth - chromeWidth) / 2)),
            Math.max(0, Math.round((screen.availHeight - targetContentHeight - chromeHeight) / 2)),
        );
        setTimeout(updateMediaRect, 120);
    }

    document.getElementById('close').addEventListener('click', () => window.close());
    fitSize.addEventListener('click', fitWindowToVideo);
    document.getElementById('prev').addEventListener('click', prev);
    document.getElementById('play').addEventListener('click', toggle);
    document.getElementById('next').addEventListener('click', next);
    document.getElementById('subtitleBox').addEventListener('click', next);
    video.addEventListener('click', next);
    stage.addEventListener('click', (event) => {
        if (event.target === stage || event.target.id === 'shade') next();
    });
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') window.close();
        if (event.key.toLowerCase() === 'f') {
            event.preventDefault();
            fitWindowToVideo();
        }
        if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') {
            event.preventDefault();
            next();
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            prev();
        }
    });
    video.addEventListener('loadedmetadata', () => {
        updateMediaRect();
        if (!state.autoSized) {
            state.autoSized = true;
            fitWindowToVideo();
        }
    });
    window.addEventListener('resize', updateMediaRect);

    applyVideo();
    render();
    schedule();
})();
