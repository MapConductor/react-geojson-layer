import type { GeoJSONGeometry, LonLat } from './GeoJSONGeometry';
import type { GeoJSONFeatureData } from './GeoJSONFeature';

/**
 * 緯度経度と世界座標（0..1 の正規化 Web メルカトル）の相互変換、ジオメトリの
 * 世界座標化、範囲の計算、間引き。すべて副作用のない計算。
 *
 * 緯度経度のままではなく先に世界座標へ移しておくのは、タイルを描くたびに
 * 投影を計算し直さないため。数万点のデータでは投影が支配的になる。
 *
 * android-sdk の `GeoJSONWorld.kt` / ios-sdk の同名ファイルと同じ式。
 */

// ─── Coordinate math ─────────────────────────────────────────────────────────

export function lonToWorld(lon: number): number { return lon / 360.0 + 0.5; }

export function latToWorld(lat: number): number {
    const siny = Math.sin(lat * Math.PI / 180.0);
    const c = Math.max(-0.9999, Math.min(0.9999, siny));
    return 0.5 - Math.log((1.0 + c) / (1.0 - c)) / (4.0 * Math.PI);
}

export function worldToLon(wx: number): number { return (wx - 0.5) * 360.0; }

export function worldToLat(wy: number): number {
    return Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * wy))) * 180.0 / Math.PI;
}

export function toPixel(world: number, worldSize: number, origin: number): number {
    return world * worldSize - origin;
}

export function segmentOutside(ax: number, ay: number, bx: number, by: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return (ax < minX && bx < minX) || (ax > maxX && bx > maxX) ||
        (ay < minY && by < minY) || (ay > maxY && by > maxY);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

export function simplifyRadial(coords: Float64Array, tolerance: number): Float64Array {
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

export const MAX_SIMPLIFY_ZOOM = 22;

export class WorldRing {
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

export type WorldGeometry =
    | { type: 'Point'; wx: number; wy: number }
    | { type: 'Points'; points: Float64Array }
    | { type: 'Line'; rings: WorldRing[] }
    | { type: 'Polygon'; rings: WorldRing[] }
    | { type: 'Collection'; parts: WorldGeometry[] }
    | { type: 'Empty' };

// ─── WorldBounds ──────────────────────────────────────────────────────────────

export class WorldBounds {
    constructor(
        readonly minX: number, readonly maxX: number,
        readonly minY: number, readonly maxY: number,
    ) {}
    intersects(x1: number, y1: number, x2: number, y2: number): boolean {
        return this.minX <= x2 && this.maxX >= x1 && this.minY <= y2 && this.maxY >= y1;
    }
}

// ─── RenderFeature ────────────────────────────────────────────────────────────

export interface RenderFeature {
    source: GeoJSONFeatureData;
    worldGeometry: WorldGeometry;
    bounds: WorldBounds;
    fillStyle: string;
    strokeStyle: string | null;
    strokeWidth: number;
    pointRadius: number;
}

// ─── Geometry conversion ──────────────────────────────────────────────────────

export function flatPoints(points: ReadonlyArray<{ longitude: number; latitude: number }>): Float64Array {
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

export function toWorldGeometry(geometry: GeoJSONGeometry): WorldGeometry {
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

export function boundsOfCoords(coords: Float64Array): WorldBounds {
    if (coords.length === 0) return new WorldBounds(0, 1, 0, 1);
    let minX = coords[0], maxX = coords[0], minY = coords[1], maxY = coords[1];
    for (let i = 2; i < coords.length; i += 2) {
        const x = coords[i], y = coords[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return new WorldBounds(minX, maxX, minY, maxY);
}

export function boundsOfRings(rings: WorldRing[]): WorldBounds {
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

export function computeBounds(geometry: WorldGeometry): WorldBounds {
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
