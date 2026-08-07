/**
 * タイルのバイト列を KB 単位で上限管理する LRU と、描画用 canvas の使い回し。
 *
 * canvas はタイルごとに作らない。1 画面数十枚を描くので、生成と破棄が
 * そのまま待ち時間になる。
 */

// ─── LRU cache ────────────────────────────────────────────────────────────────

export class LruCache {
    private readonly map = new Map<string, Uint8Array>();
    private sizeKb = 0;
    constructor(private readonly maxKb: number) {}
    get(key: string): Uint8Array | undefined {
        const v = this.map.get(key);
        if (v === undefined) return undefined;
        this.map.delete(key); this.map.set(key, v);
        return v;
    }
    put(key: string, value: Uint8Array): void {
        if (this.map.has(key)) {
            const old = this.map.get(key)!;
            this.sizeKb -= Math.max(1, (old.length / 1024) | 0);
            this.map.delete(key);
        }
        const sz = Math.max(1, (value.length / 1024) | 0);
        while (this.sizeKb + sz > this.maxKb && this.map.size > 0) {
            const first = this.map.keys().next().value!;
            this.sizeKb -= Math.max(1, ((this.map.get(first)?.length ?? 0) / 1024) | 0);
            this.map.delete(first);
        }
        this.map.set(key, value); this.sizeKb += sz;
    }
    evictAll(): void { this.map.clear(); this.sizeKb = 0; }
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(size: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(size, size);
    }
    const el = document.createElement('canvas');
    el.width = size; el.height = size;
    return el;
}
