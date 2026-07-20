import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackSessionManager } from '../public/lib/playback-session.mjs';

test('starting a new session cancels controllers and URLs from the old session', () => {
    const revoked = [];
    const cancellations = [];
    const manager = createPlaybackSessionManager({
        revokeObjectUrl: url => revoked.push(url),
        onCancel: value => cancellations.push(value),
    });
    const first = manager.start({ segments: [{ text: 'one' }] });
    const controller = manager.createController(first, 0);
    manager.registerObjectUrl(first, 'blob:first');
    const second = manager.start({ segments: [{ text: 'two' }] });

    assert.equal(controller.signal.aborted, true);
    assert.equal(first.status, 'cancelled');
    assert.equal(manager.isActive(first), false);
    assert.equal(manager.isActive(second), true);
    assert.deepEqual(revoked, ['blob:first']);
    assert.equal(cancellations[0].abortCount, 1);
});

test('stale sessions cannot register new object URLs', () => {
    const revoked = [];
    const manager = createPlaybackSessionManager({ revokeObjectUrl: url => revoked.push(url) });
    const first = manager.start();
    manager.start();
    assert.equal(manager.registerObjectUrl(first, 'blob:late'), false);
    assert.deepEqual(revoked, ['blob:late']);
});

test('cancel is idempotent and clears active work', () => {
    const manager = createPlaybackSessionManager({ revokeObjectUrl: () => {} });
    const session = manager.start();
    manager.createController(session, 'a');
    assert.equal(manager.cancel('manual').abortCount, 1);
    assert.equal(manager.cancel('manual').abortCount, 0);
    assert.equal(manager.getActive(), null);
});
