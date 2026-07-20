import assert from 'node:assert/strict';
import test from 'node:test';

import { beginTtsAuditRun, createTtsAuditState } from '../public/lib/tts-audit.mjs';

test('advances run id and resets action-scoped evidence', () => {
    const audit = createTtsAuditState(100);
    audit.audio_played = {
        status: 'success', error: null, source: 'selection', first_segment_started: true, order_ok: true,
    };
    audit.cache = { status: 'success', error: null, cache_source: 'server', api_key_in_descriptor: false };
    audit.route_built = {
        status: 'success', error: null, mode: 'mixed', narration_count: 1, dialogue_count: 2,
        override_count: 2, legacy_index_override_count: 1,
    };

    const next = beginTtsAuditRun(audit, 'provider-probe', 100);

    assert.equal(next, audit);
    assert.equal(next.run_id, 101);
    assert.equal(next.action, 'provider-probe');
    assert.equal(next.audio_played.status, 'pending');
    assert.equal(next.audio_played.first_segment_started, false);
    assert.equal(next.cache.status, 'pending');
    assert.equal(next.route_built.legacy_index_override_count, 0);
});

test('preserves page-scoped migration and stage evidence between actions', () => {
    const audit = createTtsAuditState(200);
    audit.settings_migrated = { status: 'success', error: null, profile_count: 2, preset_count: 3 };
    audit.stage_linked = { status: 'success', error: null, uses_shared_session: true };
    audit.inline_cache_scan = { status: 'success', error: null, checked_count: 4, ready_count: 3, server_checked: true };
    audit.last_error = 'old failure';

    beginTtsAuditRun(audit, 'speak:message', 250);

    assert.equal(audit.run_id, 250);
    assert.equal(audit.settings_migrated.status, 'success');
    assert.equal(audit.stage_linked.uses_shared_session, true);
    assert.equal(audit.inline_cache_scan.ready_count, 3);
    assert.equal(audit.last_error, null);
});
