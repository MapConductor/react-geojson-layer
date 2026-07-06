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
     */
    processClick(position: GeoPointInterface): boolean {
        const feature = this.renderer?.hitTest(position.longitude, position.latitude) ?? null;
        if (!feature) return false;
        this.onClick?.(feature, position);
        return true;
    }
}
