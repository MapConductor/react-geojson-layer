import type { GeoJSONGeometry } from './GeoJSONGeometry';

/**
 * Lightweight, non-reactive data object for static/bulk GeoJSON features.
 * Use this (instead of GeoJSONFeatureState) when loading large GeoJSON files
 * that don't need per-feature reactive updates.
 */
export interface GeoJSONFeatureData {
    readonly id?: string | null;
    readonly geometry: GeoJSONGeometry;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly strokeColor?: number | null;
    readonly fillColor?: number | null;
    readonly strokeWidth?: number | null;
    readonly pointRadius?: number | null;
    readonly visible: boolean;
}

export function createGeoJSONFeature(params: {
    id?: string | null;
    geometry: GeoJSONGeometry;
    properties?: Record<string, unknown>;
    strokeColor?: number | null;
    fillColor?: number | null;
    strokeWidth?: number | null;
    pointRadius?: number | null;
    visible?: boolean;
}): GeoJSONFeatureData {
    return {
        id: params.id ?? null,
        geometry: params.geometry,
        properties: params.properties ?? {},
        strokeColor: params.strokeColor ?? null,
        fillColor: params.fillColor ?? null,
        strokeWidth: params.strokeWidth ?? null,
        pointRadius: params.pointRadius ?? null,
        visible: params.visible ?? true,
    };
}
