export interface LonLat {
    readonly longitude: number;
    readonly latitude: number;
}

export type GeoJSONGeometry =
    | { readonly type: 'Point'; readonly longitude: number; readonly latitude: number }
    | { readonly type: 'MultiPoint'; readonly points: ReadonlyArray<{ readonly longitude: number; readonly latitude: number }> }
    | { readonly type: 'LineString'; readonly coordinates: ReadonlyArray<LonLat> }
    | { readonly type: 'MultiLineString'; readonly lines: ReadonlyArray<ReadonlyArray<LonLat>> }
    | { readonly type: 'Polygon'; readonly rings: ReadonlyArray<ReadonlyArray<LonLat>> }
    | { readonly type: 'MultiPolygon'; readonly polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<LonLat>>> }
    | { readonly type: 'GeometryCollection'; readonly geometries: ReadonlyArray<GeoJSONGeometry> }
    | { readonly type: 'Empty' };
