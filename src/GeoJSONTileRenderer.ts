import { createGeoPoint, type GeoPointInterface, type TileProvider, type TileRequest } from '@mapconductor/js-sdk-core';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import type { GeoJSONFeatureState } from './GeoJSONFeatureState';
import type { GeoJSONGeometry, LonLat } from './GeoJSONGeometry';
import { GeoJSONDefaults, argbToCss, colorAlpha } from './GeoJSONDefaults';

// ─── PNG encoder ─────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? ((0xedb88320 ^ (c >>> 1)) | 0) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32Init(): number { return -1; }
function crc32Update(crc: number, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): number {
    for (let i = offset; i < offset + len; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return crc;
}
function crc32Finalize(crc: number): number { return (crc ^ -1) >>> 0; }

const ADLER_MOD = 65521;
function adler32Update(s: number, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): number {
    let s1 = s & 0xffff, s2 = (s >>> 16) & 0xffff;
    for (let i = offset; i < offset + len; i++) { s1 = (s1 + data[i]) % ADLER_MOD; s2 = (s2 + s1) % ADLER_MOD; }
    return ((s2 << 16) | s1) >>> 0;
}

class DynamicBuffer {
    private buf: Uint8Array;
    private count = 0;
    constructor(cap = 4096) { this.buf = new Uint8Array(Math.max(cap, 16)); }
    position(): number { return this.count; }
    reset(): void { this.count = 0; }
    private grow(min: number): void {
        if (this.buf.length >= min) return;
        let n = this.buf.length;
        while (n < min) n = (n * 2) | 0;
        const next = new Uint8Array(n);
        next.set(this.buf.subarray(0, this.count));
        this.buf = next;
    }
    writeByte(v: number): void { this.grow(this.count + 1); this.buf[this.count++] = v & 0xff; }
    writeInt32BE(v: number): void {
        this.grow(this.count + 4);
        this.buf[this.count++] = (v >>> 24) & 0xff;
        this.buf[this.count++] = (v >>> 16) & 0xff;
        this.buf[this.count++] = (v >>> 8) & 0xff;
        this.buf[this.count++] = v & 0xff;
    }
    setInt32BE(offset: number, v: number): void {
        this.buf[offset] = (v >>> 24) & 0xff; this.buf[offset + 1] = (v >>> 16) & 0xff;
        this.buf[offset + 2] = (v >>> 8) & 0xff; this.buf[offset + 3] = v & 0xff;
    }
    writeBytes(src: Uint8Array | Uint8ClampedArray, offset = 0, len = src.length): void {
        if (len <= 0) return;
        this.grow(this.count + len);
        for (let i = 0; i < len; i++) this.buf[this.count + i] = src[offset + i];
        this.count += len;
    }
    toUint8Array(): Uint8Array { return this.buf.slice(0, this.count); }
}

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);
const PNG_IDAT = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const PNG_IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
const ZLIB_HEADER = new Uint8Array([0x78, 0x01]);
const EMPTY_BYTES = new Uint8Array(0);

function writePngChunk(buf: DynamicBuffer, type: Uint8Array, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): void {
    buf.writeInt32BE(len);
    buf.writeBytes(type);
    if (len > 0) buf.writeBytes(data, offset, len);
    let crc = crc32Init();
    crc = crc32Update(crc, type, 0, type.length);
    if (len > 0) crc = crc32Update(crc, data, offset, len);
    buf.writeInt32BE(crc32Finalize(crc));
}

function encodePng(rgba: Uint8ClampedArray, width: number, height: number, pngBuf: DynamicBuffer): Uint8Array {
    pngBuf.reset();
    pngBuf.writeBytes(PNG_SIG);

    const ihdrBuf = new Uint8Array(13);
    ihdrBuf[0] = (width >>> 24) & 0xff; ihdrBuf[1] = (width >>> 16) & 0xff;
    ihdrBuf[2] = (width >>> 8) & 0xff;  ihdrBuf[3] = width & 0xff;
    ihdrBuf[4] = (height >>> 24) & 0xff; ihdrBuf[5] = (height >>> 16) & 0xff;
    ihdrBuf[6] = (height >>> 8) & 0xff;  ihdrBuf[7] = height & 0xff;
    ihdrBuf[8] = 8; ihdrBuf[9] = 6; // bit depth=8, color type=RGBA
    writePngChunk(pngBuf, PNG_IHDR, ihdrBuf, 0, 13);

    const rowLen = 1 + width * 4;
    const rowBuf = new Uint8Array(rowLen);
    const sbhBuf = new Uint8Array(5);
    const adlerBuf = new Uint8Array(4);

    const idatLenPos = pngBuf.position();
    pngBuf.writeInt32BE(0);
    pngBuf.writeBytes(PNG_IDAT);
    let crc = crc32Init();
    crc = crc32Update(crc, PNG_IDAT, 0, 4);
    const idatDataStart = pngBuf.position();

    crc = crc32Update(crc, ZLIB_HEADER, 0, 2);
    pngBuf.writeBytes(ZLIB_HEADER);

    let adler = 1;
    for (let y = 0; y < height; y++) {
        rowBuf[0] = 0;
        const srcBase = y * width * 4;
        for (let i = 0; i < width * 4; i++) rowBuf[1 + i] = rgba[srcBase + i];
        adler = adler32Update(adler, rowBuf, 0, rowLen);

        const isLast = y === height - 1;
        const nlen = (~rowLen) & 0xffff;
        sbhBuf[0] = isLast ? 0x01 : 0x00;
        sbhBuf[1] = rowLen & 0xff; sbhBuf[2] = (rowLen >>> 8) & 0xff;
        sbhBuf[3] = nlen & 0xff; sbhBuf[4] = (nlen >>> 8) & 0xff;
        crc = crc32Update(crc, sbhBuf, 0, 5);
        pngBuf.writeBytes(sbhBuf, 0, 5);
        crc = crc32Update(crc, rowBuf, 0, rowLen);
        pngBuf.writeBytes(rowBuf, 0, rowLen);
    }

    adlerBuf[0] = (adler >>> 24) & 0xff; adlerBuf[1] = (adler >>> 16) & 0xff;
    adlerBuf[2] = (adler >>> 8) & 0xff; adlerBuf[3] = adler & 0xff;
    crc = crc32Update(crc, adlerBuf, 0, 4);
    pngBuf.writeBytes(adlerBuf);

    pngBuf.setInt32BE(idatLenPos, pngBuf.position() - idatDataStart);
    pngBuf.writeInt32BE(crc32Finalize(crc));
    writePngChunk(pngBuf, PNG_IEND, EMPTY_BYTES, 0, 0);
    return pngBuf.toUint8Array();
}

// ─── Coordinate math ─────────────────────────────────────────────────────────

function lonToWorld(lon: number): number { return lon / 360.0 + 0.5; }

function latToWorld(lat: number): number {
    const siny = Math.sin(lat * Math.PI / 180.0);
    const c = Math.max(-0.9999, Math.min(0.9999, siny));
    return 0.5 - Math.log((1.0 + c) / (1.0 - c)) / (4.0 * Math.PI);
}

function worldToLon(wx: number): number { return (wx - 0.5) * 360.0; }

function worldToLat(wy: number): number {
    return Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * wy))) * 180.0 / Math.PI;
}

function toPixel(world: number, worldSize: number, origin: number): number {
    return world * worldSize - origin;
}

function segmentOutside(ax: number, ay: number, bx: number, by: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return (ax < minX && bx < minX) || (ax > maxX && bx > maxX) ||
        (ay < minY && by < minY) || (ay > maxY && by > maxY);
}

function distanceSq(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

function simplifyRadial(coords: Float64Array, tolerance: number): Float64Array {
    if (coords.length <= 4 || tolerance <= 0) return coords;
    const tolSq = tolerance * tolerance;
    const output = new Float64Array(coords.length);
    let out = 0;
    let lastX = coords[0], lastY = coords[1];
    output[out++] = lastX; output[out++] = lastY;
    for (let i = 2; i < coords.length - 2; i += 2) {
        const x = coords[i], y = coords[i + 1];
        if (distanceSq(lastX, lastY, x, y) > tolSq) {
            output[out++] = x; output[out++] = y;
            lastX = x; lastY = y;
        }
    }
    const endX = coords[coords.length - 2], endY = coords[coords.length - 1];
    if (out < 2 || output[out - 2] !== endX || output[out - 1] !== endY) {
        output[out++] = endX; output[out++] = endY;
    }
    return out === coords.length ? coords : output.slice(0, out);
}

// ─── WorldRing ────────────────────────────────────────────────────────────────

const MAX_SIMPLIFY_ZOOM = 22;

class WorldRing {
    readonly coords: Float64Array;
    private readonly cache: (Float64Array | null)[];

    constructor(coords: Float64Array) {
        this.coords = coords;
        this.cache = new Array(MAX_SIMPLIFY_ZOOM + 1).fill(null);
    }

    coordsForZoom(zoom: number, tileSize: number): Float64Array {
        if (this.coords.length < 6) return this.coords;
        const idx = Math.min(zoom, MAX_SIMPLIFY_ZOOM);
        if (this.cache[idx]) return this.cache[idx]!;
        const tol = 0.5 / (tileSize * (1 << idx));
        const simplified = simplifyRadial(this.coords, tol);
        this.cache[idx] = simplified;
        return simplified;
    }
}

// ─── WorldGeometry ────────────────────────────────────────────────────────────

type WorldGeometry =
    | { type: 'Point'; wx: number; wy: number }
    | { type: 'Points'; points: Float64Array }
    | { type: 'Line'; rings: WorldRing[] }
    | { type: 'Polygon'; rings: WorldRing[] }
    | { type: 'Collection'; parts: WorldGeometry[] }
    | { type: 'Empty' };

// ─── WorldBounds ──────────────────────────────────────────────────────────────

class WorldBounds {
    constructor(
        readonly minX: number, readonly maxX: number,
        readonly minY: number, readonly maxY: number,
    ) {}
    intersects(x1: number, y1: number, x2: number, y2: number): boolean {
        return this.minX <= x2 && this.maxX >= x1 && this.minY <= y2 && this.maxY >= y1;
    }
}

// ─── RenderFeature ────────────────────────────────────────────────────────────

interface RenderFeature {
    source: GeoJSONFeatureData;
    worldGeometry: WorldGeometry;
    bounds: WorldBounds;
    fillStyle: string;
    strokeStyle: string | null;
    strokeWidth: number;
    pointRadius: number;
}

// ─── SpatialIndex ─────────────────────────────────────────────────────────────

const INDEX_GRID_SIZE = 64;

class SpatialIndex {
    private readonly grid: number[][];
    constructor(features: RenderFeature[]) {
        this.grid = Array.from({ length: INDEX_GRID_SIZE * INDEX_GRID_SIZE }, () => []);
        for (let i = 0; i < features.length; i++) {
            const b = features[i].bounds;
            const x0 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (b.minX * INDEX_GRID_SIZE) | 0));
            const x1 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (b.maxX * INDEX_GRID_SIZE) | 0));
            const y0 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (b.minY * INDEX_GRID_SIZE) | 0));
            const y1 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (b.maxY * INDEX_GRID_SIZE) | 0));
            for (let cy = y0; cy <= y1; cy++) {
                for (let cx = x0; cx <= x1; cx++) {
                    this.grid[cy * INDEX_GRID_SIZE + cx].push(i);
                }
            }
        }
    }

    query(x1: number, y1: number, x2: number, y2: number): number[] {
        const cx0 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (x1 * INDEX_GRID_SIZE) | 0));
        const cx1 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (x2 * INDEX_GRID_SIZE) | 0));
        const cy0 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (y1 * INDEX_GRID_SIZE) | 0));
        const cy1 = Math.max(0, Math.min(INDEX_GRID_SIZE - 1, (y2 * INDEX_GRID_SIZE) | 0));
        const seen = new Set<number>();
        const result: number[] = [];
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                for (const idx of this.grid[cy * INDEX_GRID_SIZE + cx]) {
                    if (!seen.has(idx)) { seen.add(idx); result.push(idx); }
                }
            }
        }
        return result;
    }
}

// ─── TileState ────────────────────────────────────────────────────────────────

interface TileState {
    features: RenderFeature[];
    index: SpatialIndex | null;
}

// ─── LRU cache ────────────────────────────────────────────────────────────────

class LruCache {
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

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createCanvas(size: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(size, size);
    }
    const el = document.createElement('canvas');
    el.width = size; el.height = size;
    return el;
}

// ─── GeoJSONTileRenderer ─────────────────────────────────────────────────────

export interface GeoJSONLayerStyle {
    strokeColor: number;
    fillColor: number;
    strokeWidth: number;
    pointRadius: number;
}

const INDEX_THRESHOLD = 256;
const DEFAULT_CACHE_KB = 8 * 1024;
const SENTINEL = new Uint8Array(0);

// Hit tolerances in world coordinates (~0.0002 ≈ 72m at equator, ~3-5px at zoom 14)
const HIT_LINE_TOLERANCE = 0.0002;
const HIT_LINE_TOLERANCE_SQ = HIT_LINE_TOLERANCE * HIT_LINE_TOLERANCE;
const HIT_POINT_TOLERANCE = 0.0004;
const HIT_POINT_TOLERANCE_SQ = HIT_POINT_TOLERANCE * HIT_POINT_TOLERANCE;

export class GeoJSONTileRenderer implements TileProvider {
    readonly tileSize: number;
    private cacheEpoch = 0;
    private state: TileState = { features: [], index: null };
    private readonly cache: LruCache;
    private _canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    private _ctx: Ctx2D | null = null;
    private readonly pngBuf: DynamicBuffer;

    constructor(params: { tileSize?: number; cacheSizeKb?: number } = {}) {
        this.tileSize = params.tileSize ?? GeoJSONDefaults.DEFAULT_TILE_SIZE;
        this.cache = new LruCache(params.cacheSizeKb ?? DEFAULT_CACHE_KB);
        this.pngBuf = new DynamicBuffer(this.tileSize * this.tileSize * 4 + 1024);
    }

    update(
        staticFeatures: GeoJSONFeatureData[],
        dynamicFeatures: GeoJSONFeatureState[],
        layerStyle: GeoJSONLayerStyle,
    ): void {
        const rendered: RenderFeature[] = [];
        for (const f of staticFeatures) if (f.visible) rendered.push(buildRenderFeatureFromData(f, layerStyle));
        for (const s of dynamicFeatures) if (s.visible) rendered.push(buildRenderFeatureFromState(s, layerStyle));
        this.state = {
            features: rendered,
            index: rendered.length >= INDEX_THRESHOLD ? new SpatialIndex(rendered) : null,
        };
        this.cacheEpoch++;
        this.cache.evictAll();
    }

    renderTile(request: TileRequest): Uint8Array | null {
        const epoch = this.cacheEpoch;
        const key = `${epoch}:${request.z}/${request.x}/${request.y}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached === SENTINEL ? null : cached;

        const result = this.renderTileInternal(request, this.state);
        this.cache.put(key, result ?? SENTINEL);
        return result;
    }

    private getCtx(): Ctx2D {
        if (!this._canvas) {
            this._canvas = createCanvas(this.tileSize);
            this._ctx = this._canvas.getContext('2d') as Ctx2D;
        }
        return this._ctx!;
    }

    private renderTileInternal(request: TileRequest, tileState: TileState): Uint8Array | null {
        if (tileState.features.length === 0) return null;

        const z = request.z;
        const worldTileCount = 1 << z;
        const x = ((request.x % worldTileCount) + worldTileCount) % worldTileCount;
        const y = request.y;
        if (y < 0 || y >= worldTileCount) return null;

        const tileMinX = x / worldTileCount;
        const tileMaxX = (x + 1) / worldTileCount;
        const tileMinY = y / worldTileCount;
        const tileMaxY = (y + 1) / worldTileCount;

        const candidates = tileState.index
            ? tileState.index.query(tileMinX, tileMinY, tileMaxX, tileMaxY)
            : tileState.features.map((_, i) => i);

        const worldSize = this.tileSize * worldTileCount;
        const originX = x * this.tileSize;
        const originY = y * this.tileSize;

        const ctx = this.getCtx();
        ctx.clearRect(0, 0, this.tileSize, this.tileSize);

        let hasContent = false;
        for (const idx of candidates) {
            const feature = tileState.features[idx];
            if (!feature.bounds.intersects(tileMinX, tileMinY, tileMaxX, tileMaxY)) continue;
            if (this.renderFeature(ctx, feature, z, worldSize, originX, originY, tileMinX, tileMinY, tileMaxX, tileMaxY)) {
                hasContent = true;
            }
        }

        if (!hasContent) return null;

        const imageData = (ctx as CanvasRenderingContext2D).getImageData(0, 0, this.tileSize, this.tileSize);
        return encodePng(imageData.data, this.tileSize, this.tileSize, this.pngBuf);
    }

    private renderFeature(
        ctx: Ctx2D, feature: RenderFeature, zoom: number,
        worldSize: number, originX: number, originY: number,
        tileMinX: number, tileMinY: number, tileMaxX: number, tileMaxY: number,
    ): boolean {
        return this.renderGeometry(ctx, feature, feature.worldGeometry, zoom, worldSize, originX, originY, tileMinX, tileMinY, tileMaxX, tileMaxY);
    }

    private renderGeometry(
        ctx: Ctx2D, feature: RenderFeature, geometry: WorldGeometry, zoom: number,
        worldSize: number, originX: number, originY: number,
        tileMinX: number, tileMinY: number, tileMaxX: number, tileMaxY: number,
    ): boolean {
        switch (geometry.type) {
            case 'Point': {
                const px = toPixel(geometry.wx, worldSize, originX);
                const py = toPixel(geometry.wy, worldSize, originY);
                ctx.beginPath();
                ctx.arc(px, py, feature.pointRadius, 0, Math.PI * 2);
                ctx.fillStyle = feature.fillStyle;
                ctx.fill();
                if (feature.strokeStyle) {
                    ctx.beginPath();
                    ctx.arc(px, py, feature.pointRadius, 0, Math.PI * 2);
                    ctx.strokeStyle = feature.strokeStyle;
                    ctx.lineWidth = feature.strokeWidth;
                    ctx.stroke();
                }
                return true;
            }

            case 'Points': {
                const pts = geometry.points;
                if (pts.length === 0) return false;
                for (let i = 0; i < pts.length; i += 2) {
                    const px = toPixel(pts[i], worldSize, originX);
                    const py = toPixel(pts[i + 1], worldSize, originY);
                    ctx.beginPath();
                    ctx.arc(px, py, feature.pointRadius, 0, Math.PI * 2);
                    ctx.fillStyle = feature.fillStyle;
                    ctx.fill();
                    if (feature.strokeStyle) {
                        ctx.beginPath();
                        ctx.arc(px, py, feature.pointRadius, 0, Math.PI * 2);
                        ctx.strokeStyle = feature.strokeStyle;
                        ctx.lineWidth = feature.strokeWidth;
                        ctx.stroke();
                    }
                }
                return true;
            }

            case 'Line': {
                const sw = feature.strokeWidth;
                const margin = (tileMaxX - tileMinX) * 0.25 + sw / worldSize;
                const minX = tileMinX - margin, minY = tileMinY - margin;
                const maxX = tileMaxX + margin, maxY = tileMaxY + margin;

                let hasSegments = false;
                ctx.beginPath();
                for (const ring of geometry.rings) {
                    const coords = ring.coordsForZoom(zoom, this.tileSize);
                    if (coords.length < 4) continue;
                    let needsMove = true;
                    for (let i = 2; i < coords.length; i += 2) {
                        const ax = coords[i - 2], ay = coords[i - 1];
                        const bx = coords[i], by = coords[i + 1];
                        if (!segmentOutside(ax, ay, bx, by, minX, minY, maxX, maxY)) {
                            if (needsMove) {
                                ctx.moveTo(toPixel(ax, worldSize, originX), toPixel(ay, worldSize, originY));
                                needsMove = false;
                            }
                            ctx.lineTo(toPixel(bx, worldSize, originX), toPixel(by, worldSize, originY));
                            hasSegments = true;
                        } else {
                            needsMove = true;
                        }
                    }
                }
                if (!hasSegments) return false;
                ctx.strokeStyle = feature.strokeStyle ?? feature.fillStyle;
                ctx.lineWidth = sw;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.stroke();
                return true;
            }

            case 'Polygon': {
                let hasRings = false;
                ctx.beginPath();
                for (const ring of geometry.rings) {
                    const coords = ring.coordsForZoom(zoom, this.tileSize);
                    if (coords.length < 6) continue;
                    ctx.moveTo(toPixel(coords[0], worldSize, originX), toPixel(coords[1], worldSize, originY));
                    for (let i = 2; i < coords.length; i += 2) {
                        ctx.lineTo(toPixel(coords[i], worldSize, originX), toPixel(coords[i + 1], worldSize, originY));
                    }
                    ctx.closePath();
                    hasRings = true;
                }
                if (!hasRings) return false;
                ctx.fillStyle = feature.fillStyle;
                ctx.fill('evenodd');
                if (feature.strokeStyle) {
                    ctx.strokeStyle = feature.strokeStyle;
                    ctx.lineWidth = feature.strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.stroke();
                }
                return true;
            }

            case 'Collection': {
                let drew = false;
                for (const part of geometry.parts) {
                    if (this.renderGeometry(ctx, feature, part, zoom, worldSize, originX, originY, tileMinX, tileMinY, tileMaxX, tileMaxY)) drew = true;
                }
                return drew;
            }

            case 'Empty': return false;
        }
    }

    // ── Hit-testing ──────────────────────────────────────────────────────────

    hitTest(longitude: number, latitude: number, lineTolSq?: number, pointTolSq?: number): GeoJSONHitTestResult | null {
        const wx = lonToWorld(longitude);
        const wy = latToWorld(latitude);
        const lineTolerance = lineTolSq !== undefined ? Math.sqrt(lineTolSq) : HIT_LINE_TOLERANCE;
        const pointTolerance = pointTolSq !== undefined ? Math.sqrt(pointTolSq) : HIT_POINT_TOLERANCE;
        const tolerance = Math.max(lineTolerance, pointTolerance);
        const s = this.state;
        const candidates = s.index
            ? s.index.query(wx - tolerance, wy - tolerance, wx + tolerance, wy + tolerance)
            : s.features.map((_, i) => i);

        for (let i = candidates.length - 1; i >= 0; i--) {
            const feature = s.features[candidates[i]];
            if (!feature.bounds.intersects(wx - tolerance, wy - tolerance, wx + tolerance, wy + tolerance)) continue;
            const hit = hitTestGeometry(wx, wy, feature.worldGeometry, lineTolSq, pointTolSq);
            if (hit) {
                return {
                    feature: feature.source,
                    position: createGeoPoint({
                        longitude: worldToLon(hit.wx),
                        latitude: worldToLat(hit.wy),
                    }),
                };
            }
        }
        return null;
    }
}

export interface GeoJSONHitTestResult {
    readonly feature: GeoJSONFeatureData;
    readonly position: GeoPointInterface;
}

// ─── Build render features ───────────────────────────────────────────────────

function buildRenderFeatureFromData(feature: GeoJSONFeatureData, layerStyle: GeoJSONLayerStyle): RenderFeature {
    return buildRenderFeature(
        feature,
        feature.geometry,
        feature.strokeColor ?? layerStyle.strokeColor,
        feature.fillColor ?? layerStyle.fillColor,
        feature.strokeWidth ?? layerStyle.strokeWidth,
        feature.pointRadius ?? layerStyle.pointRadius,
    );
}

function buildRenderFeatureFromState(state: GeoJSONFeatureState, layerStyle: GeoJSONLayerStyle): RenderFeature {
    const source: GeoJSONFeatureData = {
        id: state.id,
        geometry: state.geometry,
        properties: state.properties,
        strokeColor: state.strokeColor,
        fillColor: state.fillColor,
        strokeWidth: state.strokeWidth,
        pointRadius: state.pointRadius,
        visible: state.visible,
    };
    return buildRenderFeature(
        source,
        state.geometry,
        state.strokeColor ?? layerStyle.strokeColor,
        state.fillColor ?? layerStyle.fillColor,
        state.strokeWidth ?? layerStyle.strokeWidth,
        state.pointRadius ?? layerStyle.pointRadius,
    );
}

function buildRenderFeature(
    source: GeoJSONFeatureData,
    geometry: GeoJSONGeometry,
    strokeColor: number,
    fillColor: number,
    strokeWidth: number,
    pointRadius: number,
): RenderFeature {
    const strokeStyle = (colorAlpha(strokeColor) > 0 && strokeWidth > 0) ? argbToCss(strokeColor) : null;
    const worldGeometry = toWorldGeometry(geometry);
    const bounds = computeBounds(worldGeometry);
    return {
        // Strip geometry from source; worldGeometry holds all coords for rendering
        source: { ...source, geometry: { type: 'Empty' } },
        worldGeometry,
        bounds,
        fillStyle: argbToCss(fillColor),
        strokeStyle,
        strokeWidth,
        pointRadius,
    };
}

// ─── Geometry conversion ──────────────────────────────────────────────────────

function flatPoints(points: ReadonlyArray<{ longitude: number; latitude: number }>): Float64Array {
    const coords = new Float64Array(points.length * 2);
    let i = 0;
    for (const p of points) { coords[i++] = lonToWorld(p.longitude); coords[i++] = latToWorld(p.latitude); }
    return coords;
}

function flatCoords(lonlats: ReadonlyArray<LonLat>): Float64Array {
    const coords = new Float64Array(lonlats.length * 2);
    let i = 0;
    for (const p of lonlats) { coords[i++] = lonToWorld(p.longitude); coords[i++] = latToWorld(p.latitude); }
    return coords;
}

function toWorldGeometry(geometry: GeoJSONGeometry): WorldGeometry {
    switch (geometry.type) {
        case 'Point':
            return { type: 'Point', wx: lonToWorld(geometry.longitude), wy: latToWorld(geometry.latitude) };
        case 'MultiPoint':
            return { type: 'Points', points: flatPoints(geometry.points) };
        case 'LineString':
            return { type: 'Line', rings: [new WorldRing(flatCoords(geometry.coordinates))] };
        case 'MultiLineString':
            return { type: 'Line', rings: geometry.lines.map(l => new WorldRing(flatCoords(l))) };
        case 'Polygon':
            return { type: 'Polygon', rings: geometry.rings.map(r => new WorldRing(flatCoords(r))) };
        case 'MultiPolygon':
            return {
                type: 'Collection',
                parts: geometry.polygons.map(poly => ({
                    type: 'Polygon' as const,
                    rings: poly.map(r => new WorldRing(flatCoords(r))),
                })),
            };
        case 'GeometryCollection':
            return { type: 'Collection', parts: geometry.geometries.map(toWorldGeometry) };
        case 'Empty':
            return { type: 'Empty' };
    }
}

// ─── Bounds computation ───────────────────────────────────────────────────────

function boundsOfCoords(coords: Float64Array): WorldBounds {
    if (coords.length === 0) return new WorldBounds(0, 1, 0, 1);
    let minX = coords[0], maxX = coords[0], minY = coords[1], maxY = coords[1];
    for (let i = 2; i < coords.length; i += 2) {
        const x = coords[i], y = coords[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return new WorldBounds(minX, maxX, minY, maxY);
}

function boundsOfRings(rings: WorldRing[]): WorldBounds {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ring of rings) {
        const coords = ring.coords;
        for (let i = 0; i < coords.length; i += 2) {
            const x = coords[i], y = coords[i + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
    return minX <= maxX ? new WorldBounds(minX, maxX, minY, maxY) : new WorldBounds(0, 1, 0, 1);
}

function computeBounds(geometry: WorldGeometry): WorldBounds {
    switch (geometry.type) {
        case 'Point': return new WorldBounds(geometry.wx, geometry.wx, geometry.wy, geometry.wy);
        case 'Points': return boundsOfCoords(geometry.points);
        case 'Line': return boundsOfRings(geometry.rings);
        case 'Polygon': return boundsOfRings(geometry.rings);
        case 'Collection': {
            if (geometry.parts.length === 0) return new WorldBounds(0, 1, 0, 1);
            const childBounds = geometry.parts.map(computeBounds);
            return new WorldBounds(
                Math.min(...childBounds.map(b => b.minX)),
                Math.max(...childBounds.map(b => b.maxX)),
                Math.min(...childBounds.map(b => b.minY)),
                Math.max(...childBounds.map(b => b.maxY)),
            );
        }
        case 'Empty': return new WorldBounds(0, 1, 0, 1);
    }
}

// ─── Hit testing geometry ─────────────────────────────────────────────────────

interface GeometryHit {
    readonly wx: number;
    readonly wy: number;
    readonly distanceSq: number;
}

function hitTestGeometry(wx: number, wy: number, geometry: WorldGeometry, lineTolSq?: number, pointTolSq?: number): GeometryHit | null {
    switch (geometry.type) {
        case 'Point': {
            const distance = distanceSq(wx, wy, geometry.wx, geometry.wy);
            return distance <= (pointTolSq ?? HIT_POINT_TOLERANCE_SQ)
                ? { wx: geometry.wx, wy: geometry.wy, distanceSq: distance }
                : null;
        }
        case 'Points':
            return hitTestPoints(wx, wy, geometry.points, pointTolSq);
        case 'Line':
            return hitTestRings(wx, wy, geometry.rings, lineTolSq);
        case 'Polygon': {
            if (lineTolSq !== undefined) {
                return hitTestRings(wx, wy, geometry.rings, lineTolSq);
            }
            const rings = geometry.rings;
            const containsPoint = rings.length > 0 &&
                pointInRing(wx, wy, rings[0].coords) &&
                !rings.slice(1).some(hole => pointInRing(wx, wy, hole.coords));
            return containsPoint ? { wx, wy, distanceSq: 0 } : null;
        }
        case 'Collection': {
            let best: GeometryHit | null = null;
            for (const part of geometry.parts) {
                const hit = hitTestGeometry(wx, wy, part, lineTolSq, pointTolSq);
                if (hit && (!best || hit.distanceSq < best.distanceSq)) best = hit;
            }
            return best;
        }
        case 'Empty': return null;
    }
}

function hitTestPoints(wx: number, wy: number, coords: Float64Array, pointTolSq?: number): GeometryHit | null {
    const tolSq = pointTolSq ?? HIT_POINT_TOLERANCE_SQ;
    let best: GeometryHit | null = null;
    for (let i = 0; i < coords.length; i += 2) {
        const distance = distanceSq(wx, wy, coords[i], coords[i + 1]);
        if (distance <= tolSq && (!best || distance < best.distanceSq)) {
            best = { wx: coords[i], wy: coords[i + 1], distanceSq: distance };
        }
    }
    return best;
}

function hitTestRings(wx: number, wy: number, rings: WorldRing[], lineTolSq?: number): GeometryHit | null {
    let best: GeometryHit | null = null;
    for (const ring of rings) {
        const hit = hitTestLine(wx, wy, ring.coords, lineTolSq);
        if (hit && (!best || hit.distanceSq < best.distanceSq)) best = hit;
    }
    return best;
}

function hitTestLine(wx: number, wy: number, coords: Float64Array, lineTolSq?: number): GeometryHit | null {
    const tolSq = lineTolSq ?? HIT_LINE_TOLERANCE_SQ;
    let best: GeometryHit | null = null;
    for (let i = 2; i < coords.length; i += 2) {
        const hit = closestPointOnSegment(wx, wy, coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
        if (hit.distanceSq <= tolSq && (!best || hit.distanceSq < best.distanceSq)) best = hit;
    }
    return best;
}

function pointInRing(wx: number, wy: number, ring: Float64Array): boolean {
    let inside = false;
    let j = ring.length - 2;
    for (let i = 0; i < ring.length; i += 2) {
        const xi = ring[i], yi = ring[i + 1];
        const xj = ring[j], yj = ring[j + 1];
        if (((yi > wy) !== (yj > wy)) && (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi)) inside = !inside;
        j = i;
    }
    return inside;
}

function closestPointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): GeometryHit {
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return { wx: ax, wy: ay, distanceSq: distanceSq(px, py, ax, ay) };
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const wx = ax + t * dx;
    const wy = ay + t * dy;
    return { wx, wy, distanceSq: distanceSq(px, py, wx, wy) };
}
