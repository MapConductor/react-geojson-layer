import type { GeoJSONGeometry, LonLat } from './GeoJSONGeometry';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import { GeoJSONFeatureState } from './GeoJSONFeatureState';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONValue = any;

export const GeoJSONParser = {
    /**
     * Parses a GeoJSON string and returns reactive GeoJSONFeatureState objects.
     * Accepts Feature and FeatureCollection at the top level.
     */
    parse(json: string): GeoJSONFeatureState[] {
        const obj = tryParseJson(json);
        if (!obj) return [];
        switch (obj.type) {
            case 'FeatureCollection': return parseFeatureCollection(obj);
            case 'Feature': return [parseFeatureAsState(obj)].filter(Boolean) as GeoJSONFeatureState[];
            default: {
                const geometry = parseGeometryObject(obj);
                return geometry ? [new GeoJSONFeatureState({ geometry })] : [];
            }
        }
    },

    /**
     * Parses a single GeoJSON Feature string into a GeoJSONFeatureState.
     */
    parseFeature(json: string): GeoJSONFeatureState | null {
        const obj = tryParseJson(json);
        return obj ? parseFeatureAsState(obj) : null;
    },

    /**
     * Parses a GeoJSON geometry string.
     */
    parseGeometry(json: string): GeoJSONGeometry | null {
        const obj = tryParseJson(json);
        return obj ? parseGeometryObject(obj) : null;
    },

    /**
     * Parses a GeoJSON string and returns lightweight GeoJSONFeature objects
     * suitable for bulk loading without per-feature reactive state.
     */
    parseFeatures(json: string): GeoJSONFeatureData[] {
        const obj = tryParseJson(json);
        if (!obj) return [];
        switch (obj.type) {
            case 'FeatureCollection': {
                const features: JSONValue[] = obj.features ?? [];
                return features.map(parseFeatureAsData).filter(Boolean) as GeoJSONFeatureData[];
            }
            case 'Feature': {
                const f = parseFeatureAsData(obj);
                return f ? [f] : [];
            }
            default: {
                const geometry = parseGeometryObject(obj);
                return geometry ? [{ id: null, geometry, properties: {}, visible: true }] : [];
            }
        }
    },

    /**
     * Streams features one at a time from a parsed GeoJSON string.
     * Useful for large FeatureCollections to process without building the full array.
     */
    streamParse(json: string, onFeature: (feature: GeoJSONFeatureData) => void): void {
        const obj = tryParseJson(json);
        if (!obj) return;
        const features: JSONValue[] = obj.features ?? [];
        for (const f of features) {
            const feature = parseFeatureAsData(f);
            if (feature) onFeature(feature);
        }
    },
};

function tryParseJson(json: string): JSONValue {
    try { return JSON.parse(json); } catch { return null; }
}

function parseFeatureCollection(obj: JSONValue): GeoJSONFeatureState[] {
    const features: JSONValue[] = obj.features ?? [];
    return features.map(parseFeatureAsState).filter(Boolean) as GeoJSONFeatureState[];
}

function parseFeatureAsState(obj: JSONValue): GeoJSONFeatureState | null {
    const geometry = parseGeometryObject(obj.geometry);
    if (!geometry) return null;
    const id = obj.id != null ? String(obj.id) : null;
    const properties = parseProperties(obj.properties);
    return new GeoJSONFeatureState({ featureId: id, geometry, properties });
}

export function parseFeatureAsData(obj: JSONValue): GeoJSONFeatureData | null {
    const geometry = parseGeometryObject(obj?.geometry);
    if (!geometry) return null;
    const id = obj.id != null ? String(obj.id) : null;
    return {
        id,
        geometry,
        properties: parseProperties(obj.properties),
        visible: true,
    };
}

function parseProperties(props: JSONValue): Record<string, unknown> {
    if (!props || typeof props !== 'object') return {};
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
        result[key] = props[key] ?? null;
    }
    return result;
}

export function parseGeometryObject(obj: JSONValue): GeoJSONGeometry | null {
    if (!obj) return null;
    switch (obj.type) {
        case 'Point': return parsePoint(obj.coordinates);
        case 'MultiPoint': return parseMultiPoint(obj.coordinates);
        case 'LineString': return parseLineString(obj.coordinates);
        case 'MultiLineString': return parseMultiLineString(obj.coordinates);
        case 'Polygon': return parsePolygon(obj.coordinates);
        case 'MultiPolygon': return parseMultiPolygon(obj.coordinates);
        case 'GeometryCollection': return parseGeometryCollection(obj.geometries);
        default: return null;
    }
}

function parsePoint(coords: JSONValue): GeoJSONGeometry | null {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lon = Number(coords[0]), lat = Number(coords[1]);
    if (isNaN(lon) || isNaN(lat)) return null;
    return { type: 'Point', longitude: lon, latitude: lat };
}

function parseMultiPoint(coords: JSONValue): GeoJSONGeometry {
    const points: { longitude: number; latitude: number }[] = [];
    if (Array.isArray(coords)) {
        for (const c of coords) {
            if (Array.isArray(c) && c.length >= 2) {
                const lon = Number(c[0]), lat = Number(c[1]);
                if (!isNaN(lon) && !isNaN(lat)) points.push({ longitude: lon, latitude: lat });
            }
        }
    }
    return { type: 'MultiPoint', points };
}

function parseLineString(coords: JSONValue): GeoJSONGeometry {
    return { type: 'LineString', coordinates: parseLonLatList(coords) };
}

function parseMultiLineString(coords: JSONValue): GeoJSONGeometry {
    const lines: LonLat[][] = [];
    if (Array.isArray(coords)) {
        for (const line of coords) lines.push(parseLonLatList(line));
    }
    return { type: 'MultiLineString', lines };
}

function parsePolygon(coords: JSONValue): GeoJSONGeometry {
    const rings: LonLat[][] = [];
    if (Array.isArray(coords)) {
        for (const ring of coords) rings.push(parseLonLatList(ring));
    }
    return { type: 'Polygon', rings };
}

function parseMultiPolygon(coords: JSONValue): GeoJSONGeometry {
    const polygons: LonLat[][][] = [];
    if (Array.isArray(coords)) {
        for (const poly of coords) {
            const rings: LonLat[][] = [];
            if (Array.isArray(poly)) {
                for (const ring of poly) rings.push(parseLonLatList(ring));
            }
            polygons.push(rings);
        }
    }
    return { type: 'MultiPolygon', polygons };
}

function parseGeometryCollection(geometries: JSONValue): GeoJSONGeometry {
    const result: GeoJSONGeometry[] = [];
    if (Array.isArray(geometries)) {
        for (const g of geometries) {
            const geom = parseGeometryObject(g);
            if (geom) result.push(geom);
        }
    }
    return { type: 'GeometryCollection', geometries: result };
}

function parseLonLatList(coords: JSONValue): LonLat[] {
    const result: LonLat[] = [];
    if (!Array.isArray(coords)) return result;
    for (const point of coords) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const lon = Number(point[0]), lat = Number(point[1]);
        if (!isNaN(lon) && !isNaN(lat)) result.push({ longitude: lon, latitude: lat });
    }
    return result;
}
