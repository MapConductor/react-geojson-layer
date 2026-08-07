import { distanceSq, type WorldGeometry, type WorldRing } from './GeoJSONWorld';

// Hit tolerances in world coordinates (~0.0002 ≈ 72m at equator, ~3-5px at zoom 14)
export const HIT_LINE_TOLERANCE = 0.0002;
export const HIT_LINE_TOLERANCE_SQ = HIT_LINE_TOLERANCE * HIT_LINE_TOLERANCE;
export const HIT_POINT_TOLERANCE = 0.0004;
export const HIT_POINT_TOLERANCE_SQ = HIT_POINT_TOLERANCE * HIT_POINT_TOLERANCE;

/**
 * クリック位置に最も近いフィーチャーを探すときの、ジオメトリ単位の判定。
 *
 * 点と線は許容距離で拾う（1px の線をピクセル単位で当てるのは無理なので、
 * 世界座標での余裕を持たせる）。面は交差数の偶奇による内外判定で、
 * 穴の中は当たりにしない。
 *
 * android-sdk の `GeoJSONHitTester.kt` / ios-sdk の同名ファイルと同じ判定。
 */

// ─── Hit testing geometry ─────────────────────────────────────────────────────

export interface GeometryHit {
    readonly wx: number;
    readonly wy: number;
    readonly distanceSq: number;
}

export function hitTestGeometry(wx: number, wy: number, geometry: WorldGeometry, lineTolSq?: number, pointTolSq?: number): GeometryHit | null {
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

export function hitTestPoints(wx: number, wy: number, coords: Float64Array, pointTolSq?: number): GeometryHit | null {
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

export function hitTestRings(wx: number, wy: number, rings: WorldRing[], lineTolSq?: number): GeometryHit | null {
    let best: GeometryHit | null = null;
    for (const ring of rings) {
        const hit = hitTestLine(wx, wy, ring.coords, lineTolSq);
        if (hit && (!best || hit.distanceSq < best.distanceSq)) best = hit;
    }
    return best;
}

export function hitTestLine(wx: number, wy: number, coords: Float64Array, lineTolSq?: number): GeometryHit | null {
    const tolSq = lineTolSq ?? HIT_LINE_TOLERANCE_SQ;
    let best: GeometryHit | null = null;
    for (let i = 2; i < coords.length; i += 2) {
        const hit = closestPointOnSegment(wx, wy, coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
        if (hit.distanceSq <= tolSq && (!best || hit.distanceSq < best.distanceSq)) best = hit;
    }
    return best;
}

export function pointInRing(wx: number, wy: number, ring: Float64Array): boolean {
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

export function closestPointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): GeometryHit {
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return { wx: ax, wy: ay, distanceSq: distanceSq(px, py, ax, ay) };
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const wx = ax + t * dx;
    const wy = ay + t * dy;
    return { wx, wy, distanceSq: distanceSq(px, py, wx, wy) };
}
