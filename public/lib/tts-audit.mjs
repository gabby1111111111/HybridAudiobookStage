const actionScopedFields = [
    'content_extracted',
    'route_built',
    'provider_ready',
    'request_cancelled',
    'selection_captured',
    'audio_played',
    'prefetch',
    'inline_button',
    'player_ready',
    'integration_event',
    'cache',
];

export function createTtsAuditState(now = Date.now()) {
    return {
        run_id: Number(now),
        action: 'page-load',
        settings_migrated: { status: 'pending', error: null, profile_count: 0, preset_count: 0 },
        content_extracted: { status: 'pending', error: null, content_found: false },
        route_built: {
            status: 'pending', error: null, mode: null, narration_count: 0, dialogue_count: 0,
            override_count: 0, legacy_index_override_count: 0,
        },
        provider_ready: { status: 'pending', error: null, profile_id: null, provider_type: null, probe_ok: false },
        request_cancelled: { status: 'pending', error: null, abort_count: 0, stale_result_blocked: false },
        selection_captured: { status: 'pending', error: null, character_count: 0, message_id: null },
        audio_played: { status: 'pending', error: null, source: null, first_segment_started: false, order_ok: false },
        prefetch: { status: 'pending', error: null, max_ahead: 0 },
        inline_button: { status: 'pending', error: null, state: 'idle', cache_ready: false },
        inline_cache_scan: { status: 'pending', error: null, checked_count: 0, ready_count: 0, server_checked: false },
        player_ready: {
            status: 'pending', error: null, ui_mode: null, controls_ready: false, playback_rate: 1,
            current_audio_rate: 0, visible: false, in_viewport: false,
        },
        integration_event: { status: 'pending', error: null, last_event: null },
        stage_linked: { status: 'pending', error: null, uses_shared_session: false },
        lightweight_ui: { status: 'pending', error: null, default_sections: 0, advanced_collapsed: false, legacy_collapsed: false },
        cache: {
            status: 'pending', error: null, cache_source: null, api_key_in_descriptor: false,
            persistent_ready: false, lookup_order: 'memory-indexeddb-server-provider',
        },
        last_error: null,
    };
}

export function beginTtsAuditRun(audit, action, now = Date.now()) {
    const current = audit && typeof audit === 'object' ? audit : createTtsAuditState(now);
    const fresh = createTtsAuditState(now);
    for (const key of actionScopedFields) current[key] = fresh[key];
    current.run_id = Math.max(Number(now), Number(current.run_id || 0) + 1);
    current.action = String(action || 'unknown').slice(0, 80);
    current.last_error = null;
    return current;
}
