import type { GeoPointInterface } from '@mapconductor/js-sdk-core';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import type { GeoJSONTileRenderer } from './GeoJSONTileRenderer';
import { GeoJSONDefaults } from './GeoJSONDefaults';

export class GeoJSONLayerState {
    opacity: number;
    strokeColor: number;
    fillColor: number;
    strokeWidth: number;
    pointRadius: number;
    visible: boolean;
    minZoom: number;
    maxZoom: number;
    readonly onClick?: ((feature: GeoJSONFeatureData, position: GeoPointInterface) => void) | null;

    /** @internal set by GeoJSONLayer */
    renderer: GeoJSONTileRenderer | null = null;

    constructor(params: {
        opacity?: number;
        strokeColor?: number;
        fillColor?: number;
        strokeWidth?: number;
        pointRadius?: number;
        visible?: boolean;
        minZoom?: number;
        maxZoom?: number;
        onClick?: ((feature: GeoJSONFeatureData, position: GeoPointInterface) => void) | null;
    } = {}) {
        this.opacity = params.opacity ?? GeoJSONDefaults.DEFAULT_OPACITY;
        this.strokeColor = params.strokeColor ?? GeoJSONDefaults.DEFAULT_STROKE_COLOR;
        this.fillColor = params.fillColor ?? GeoJSONDefaults.DEFAULT_FILL_COLOR;
        this.strokeWidth = params.strokeWidth ?? GeoJSONDefaults.DEFAULT_STROKE_WIDTH;
        this.pointRadius = params.pointRadius ?? GeoJSONDefaults.DEFAULT_POINT_RADIUS;
        this.visible = params.visible ?? true;
        this.minZoom = params.minZoom ?? 0;
        this.maxZoom = params.maxZoom ?? 22;
        this.onClick = params.onClick ?? null;
    }

    /**
     * Call from your map's click handler to perform feature hit-testing.
     * Returns true and invokes onClick if a feature is found at the given position.
     *
     * Pass `pixelTolerance` and `zoom` to use a pixel-based hit threshold instead of
     * the default world-coordinate tolerances. For example, `processClick(point, 10, zoom)`
     * fires only when the click is within 10 pixels of the nearest segment.
     */
    processClick(position: GeoPointInterface, pixelTolerance?: number, zoom?: number): boolean {
        let lineTolSq: number | undefined;
        let pointTolSq: number | undefined;
        if (pixelTolerance !== undefined && zoom !== undefined && this.renderer) {
            const worldSize = this.renderer.tileSize * Math.pow(2, zoom);
            const lineTol  = pixelTolerance / worldSize;
            const pointTol = (pixelTolerance * 2) / worldSize;
            lineTolSq  = lineTol  * lineTol;
            pointTolSq = pointTol * pointTol;
        }
        const feature = this.renderer?.hitTest(position.longitude, position.latitude, lineTolSq, pointTolSq) ?? null;
        if (!feature) return false;
        this.onClick?.(feature, position);
        return true;
    }
}
