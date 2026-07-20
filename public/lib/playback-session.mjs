export function createPlaybackSessionManager({ revokeObjectUrl = url => URL.revokeObjectURL(url), onCancel = null } = {}) {
    let active = null;
    let sequence = 0;

    function isActive(session) {
        return !!session && active === session && session.status !== 'cancelled';
    }

    function cancel(reason = 'stopped') {
        const session = active;
        if (!session || session.status === 'cancelled') return { session: null, abortCount: 0 };
        session.status = 'cancelled';
        session.cancelReason = reason;
        let abortCount = 0;
        for (const controller of session.abortControllers.values()) {
            if (!controller.signal.aborted) {
                controller.abort(reason);
                abortCount += 1;
            }
        }
        session.abortControllers.clear();
        for (const url of session.objectUrls) {
            try { revokeObjectUrl(url); } catch {}
        }
        session.objectUrls.clear();
        active = null;
        onCancel?.({ session, abortCount, reason });
        return { session, abortCount };
    }

    function start({ source = 'message', segments = [] } = {}) {
        cancel('replaced');
        active = {
            id: `tts-session-${Date.now()}-${++sequence}`,
            source,
            status: 'preparing',
            segments: segments.map(segment => ({
                ...segment,
                synthesisStatus: segment.synthesisStatus || 'idle',
            })),
            currentIndex: 0,
            abortControllers: new Map(),
            objectUrls: new Set(),
            cancelReason: null,
        };
        return active;
    }

    function createController(session, key) {
        if (!isActive(session)) throw new DOMException('Session cancelled', 'AbortError');
        const existing = session.abortControllers.get(key);
        if (existing && !existing.signal.aborted) return existing;
        const controller = new AbortController();
        session.abortControllers.set(key, controller);
        return controller;
    }

    function finishController(session, key) {
        session?.abortControllers?.delete(key);
    }

    function registerObjectUrl(session, url) {
        if (!url) return false;
        if (!isActive(session)) {
            try { revokeObjectUrl(url); } catch {}
            return false;
        }
        session.objectUrls.add(url);
        return true;
    }

    return {
        start,
        cancel,
        isActive,
        createController,
        finishController,
        registerObjectUrl,
        getActive: () => active,
    };
}
