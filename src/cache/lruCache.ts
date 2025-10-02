export class LRUCache<K, V> {
    private map = new Map<K, { value: V; lastAccess: number }>();
    private max: number;
    constructor(max = 60) { this.max = Math.max(1, Math.floor(max)); }

    get size() { return this.map.size; }

    get(key: K): V | undefined {
        const entry = this.map.get(key);
        if (!entry) { return undefined; }
        entry.lastAccess = Date.now();
        // move to end
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V) {
        if (this.map.has(key)) { this.map.delete(key); }
        this.map.set(key, { value, lastAccess: Date.now() });
        if (this.map.size > this.max) {
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined) { this.map.delete(firstKey); }
        }
    }

    delete(key: K) { return this.map.delete(key); }

    has(key: K) { return this.map.has(key); }

    clear() { this.map.clear(); }

    forEach(cb: (value: V, key: K) => void) { for (const [k, v] of this.map.entries()) { cb(v.value, k); } }

    // prune entries not accessed within maxAgeMs
    pruneByAge(maxAgeMs: number) {
        const now = Date.now();
        for (const [k, v] of Array.from(this.map.entries())) {
            if (now - v.lastAccess > maxAgeMs) { this.map.delete(k); }
        }
    }

    keys(): K[] { return Array.from(this.map.keys()); }
}
