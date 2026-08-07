import type { GeoJSONFeatureData } from './GeoJSONFeature';
import type { GeoJSONGeometry } from './GeoJSONGeometry';
import type { GeoJSONFeatureState } from './GeoJSONFeatureState';
import { argbToCss, colorAlpha } from './GeoJSONDefaults';
import { computeBounds, toWorldGeometry, type RenderFeature } from './GeoJSONWorld';

/** レイヤ全体の既定スタイル。フィーチャー個別の指定が無いときに使われる。 */
export interface GeoJSONLayerStyle {
    strokeColor: number;
    fillColor: number;
    strokeWidth: number;
    pointRadius: number;
}

/**
 * スタイルを解決し、描画用フィーチャーを組み立てる部分。
 *
 * 元の緯度経度ジオメトリは捨てる。座標は世界座標側が持っており、描画も
 * 当たり判定もそちらを使う。両方持つとメモリが倍になる。
 *
 * android-sdk の `GeoJSONRenderFeature.kt` / ios-sdk の同名ファイルと同じ。
 */

// ─── Build render features ───────────────────────────────────────────────────

export function buildRenderFeatureFromData(feature: GeoJSONFeatureData, layerStyle: GeoJSONLayerStyle): RenderFeature {
    return buildRenderFeature(
        feature,
        feature.geometry,
        feature.strokeColor ?? layerStyle.strokeColor,
        feature.fillColor ?? layerStyle.fillColor,
        feature.strokeWidth ?? layerStyle.strokeWidth,
        feature.pointRadius ?? layerStyle.pointRadius,
    );
}

export function buildRenderFeatureFromState(state: GeoJSONFeatureState, layerStyle: GeoJSONLayerStyle): RenderFeature {
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

export function buildRenderFeature(
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
