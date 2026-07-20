import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioMemoryCache, findAudioCacheHit } from '../public/lib/tts-memory-cache.mjs';

function audioRecord(size, marker) {
    return { blob: { size }, marker };
}

test('memory audio cache immediately reuses a generated record', () => {
    const cache = createAudioMemoryCache({ maxEntries: 3, maxBytes: 100 });
    const record = audioRecord(20, 'generated');

    assert.equal(cache.set('same-key', record), true);
    assert.equal(cache.get('same-key'), record);
    assert.deepEqual(cache.stats(), { count: 1, bytes: 20 });
});

test('memory cache can report availability without materializing audio', () => {
    const cache = createAudioMemoryCache();
    cache.set('ready', audioRecord(20, 'memory'));
    assert.equal(cache.has('ready'), true);
    assert.equal(cache.has('missing'), false);
});

test('memory audio cache evicts least recently used records within limits', () => {
    const cache = createAudioMemoryCache({ maxEntries: 2, maxBytes: 100 });
    cache.set('old', audioRecord(20, 'old'));
    cache.set('kept', audioRecord(20, 'kept'));
    cache.get('old');
    cache.set('new', audioRecord(20, 'new'));

    assert.equal(cache.get('kept'), null);
    assert.equal(cache.get('old').marker, 'old');
    assert.equal(cache.get('new').marker, 'new');
});

test('clearing local audio cache can clear the memory layer too', () => {
    const cache = createAudioMemoryCache();
    cache.set('key', audioRecord(20, 'value'));
    cache.clear();
    assert.equal(cache.get('key'), null);
    assert.deepEqual(cache.stats(), { count: 0, bytes: 0 });
});

test('IndexedDB hit skips server lookup', async () => {
    const cache = createAudioMemoryCache();
    let serverReads = 0;
    const hit = await findAudioCacheHit({
        hash: 'persisted',
        memoryCache: cache,
        readIndexedDb: async () => audioRecord(20, 'indexeddb'),
        readServer: async () => {
            serverReads += 1;
            return audioRecord(20, 'server');
        },
    });

    assert.equal(hit.source, 'indexeddb');
    assert.equal(hit.record.marker, 'indexeddb');
    assert.equal(serverReads, 0);
});

test('memory hit skips both persistent layers', async () => {
    const cache = createAudioMemoryCache();
    cache.set('ready', audioRecord(20, 'memory'));
    let persistentReads = 0;
    const hit = await findAudioCacheHit({
        hash: 'ready',
        memoryCache: cache,
        readIndexedDb: async () => {
            persistentReads += 1;
            return null;
        },
        readServer: async () => {
            persistentReads += 1;
            return null;
        },
    });

    assert.equal(hit.source, 'memory');
    assert.equal(hit.record.marker, 'memory');
    assert.equal(persistentReads, 0);
});
