import { createGeoPoint, type GeoPointInterface, type TileProvider, type TileRequest } from '@mapconductor/js-sdk-core';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import type { GeoJSONFeatureState } from './GeoJSONFeatureState';
import { GeoJSONDefaults } from './GeoJSONDefaults';
import { encodePng, DynamicBuffer } from './GeoJSONPngEncoder';
import {
    buildRenderFeatureFromData,
    buildRenderFeatureFromState,
    type GeoJSONLayerStyle,
} from './GeoJSONRenderFeature';
import { SpatialIndex, type TileState } from './GeoJSONSpatialIndex';
import { LruCache } from './GeoJSONTileCache';
import { hitTestGeometry, HIT_LINE_TOLERANCE, HIT_POINT_TOLERANCE } from './GeoJSONHitTester';
import { createCanvas, type Ctx2D } from './GeoJSONTileCache';
import {
    lonToWorld,
    latToWorld,
    worldToLon,
    worldToLat,
    toPixel,
    segmentOutside,
    type RenderFeature,
    type WorldGeometry,
} from './GeoJSONWorld';

// スタイル型は GeoJSONRenderFeature.ts にある。以前からこのモジュール名で
// 公開しているので、そのまま再エクスポートして import 元を変えずに済ませる。
export type { GeoJSONLayerStyle } from './GeoJSONRenderFeature';

/**
 * GeoJSON をタイルへ描くタイルプロバイダ。
 *
 * このファイルが持つのは**元データの保持とタイル要求の段取り**だけで、
 * 実際の計算は責務ごとのファイルにある:
 *
 * | ファイル                  | 担当                                      |
 * |---------------------------|-------------------------------------------|
 * | `GeoJSONWorld`            | 緯度経度→世界座標、範囲、間引き           |
 * | `GeoJSONRenderFeature`    | スタイル解決と描画用フィーチャーの組み立て|
 * | `GeoJSONSpatialIndex`     | タイルにかかるフィーチャーの絞り込み      |
 * | `GeoJSONHitTester`        | クリック位置の当たり判定                  |
 * | `GeoJSONPngEncoder`       | ラスタ→PNG                                |
 * | `GeoJSONTileCache`        | タイルの LRU と canvas の使い回し         |
 *
 * android-sdk / ios-sdk も同じ責務分けのファイル構成にしてある。
 */

// ─── GeoJSONTileRenderer ─────────────────────────────────────────────────────

const INDEX_THRESHOLD = 256;
const DEFAULT_CACHE_KB = 8 * 1024;
const SENTINEL = new Uint8Array(0);

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
