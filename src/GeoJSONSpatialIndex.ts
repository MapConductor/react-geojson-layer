import type { RenderFeature } from './GeoJSONWorld';

/**
 * フィーチャーの矩形を粗い格子へ入れた索引。
 *
 * タイル 1 枚ごとに全フィーチャーの矩形を見ると、数万件では描画より
 * 探す方が重くなる。格子のセルにフィーチャー番号を入れておき、
 * タイルにかかるセルだけを辿る。
 *
 * android-sdk の `GeoJSONSpatialIndex.kt` / ios-sdk の同名ファイルと同じ作り。
 */

// ─── SpatialIndex ─────────────────────────────────────────────────────────────

export const INDEX_GRID_SIZE = 64;

export class SpatialIndex {
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

export interface TileState {
    features: RenderFeature[];
    index: SpatialIndex | null;
}
