export function createAudioMemoryCache({ maxEntries = 24, maxBytes = 64 * 1024 * 1024 } = {}) {
    const entries = new Map();
    let totalBytes = 0;

    const sizeOf = record => Math.max(0, Number(record?.blob?.size || record?.size || 0));

    const remove = hash => {
        const existing = entries.get(hash);
        if (!existing) return false;
        totalBytes -= sizeOf(existing);
        entries.delete(hash);
        return true;
    };

    const prune = () => {
        while (entries.size > maxEntries || totalBytes > maxBytes) {
            const oldestHash = entries.keys().next().value;
            if (oldestHash === undefined) break;
            remove(oldestHash);
        }
    };

    return {
        get(hash) {
            const record = entries.get(hash) || null;
            if (!record) return null;
            entries.delete(hash);
            entries.set(hash, record);
            return record;
        },
        has(hash) {
            return entries.has(hash);
        },
        set(hash, record) {
            if (!hash || !record?.blob) return false;
            const size = sizeOf(record);
            if (size > maxBytes) return false;
            remove(hash);
            entries.set(hash, record);
            totalBytes += size;
            prune();
            return entries.has(hash);
        },
        clear() {
            entries.clear();
            totalBytes = 0;
        },
        stats() {
            return { count: entries.size, bytes: totalBytes };
        },
    };
}

export async function findAudioCacheHit({ hash, memoryCache, readIndexedDb, readServer } = {}) {
    const memoryRecord = memoryCache?.get?.(hash) || null;
    if (memoryRecord?.blob) return { record: memoryRecord, source: 'memory' };

    const indexedDbRecord = await readIndexedDb?.(hash);
    if (indexedDbRecord?.blob) return { record: indexedDbRecord, source: 'indexeddb' };

    const serverRecord = await readServer?.(hash);
    if (serverRecord?.blob) return { record: serverRecord, source: 'server' };
    return null;
}
