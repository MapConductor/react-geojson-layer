import type { GeoJSONFeatureData } from './GeoJSONFeature';
import { parseFeatureAsData, parseGeometryObject } from './GeoJSONParser';

const RS = '';

/**
 * Parser for GeoJSON Text Sequences (RFC 8142).
 *
 * Records are separated by RS (0x1E). Each record is a GeoJSON Feature or bare geometry.
 * Unlike FeatureCollection, there is no wrapping object — suitable for streaming very large datasets.
 */
export const GeoJSONSeqParser = {
    parse(text: string): GeoJSONFeatureData[] {
        const result: GeoJSONFeatureData[] = [];
        GeoJSONSeqParser.streamParse(text, (f) => result.push(f));
        return result;
    },

    streamParse(text: string, onFeature: (feature: GeoJSONFeatureData) => void): void {
        const records = text.split(RS);
        for (const record of records) {
            const trimmed = record.trim();
            if (!trimmed) continue;
            const feature = parseRecord(trimmed);
            if (feature) onFeature(feature);
        }
    },
};

function parseRecord(text: string): GeoJSONFeatureData | null {
    let obj: unknown;
    try { obj = JSON.parse(text); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = obj as any;
    if (o.type === 'Feature') return parseFeatureAsData(o);
    const geometry = parseGeometryObject(o);
    return geometry ? { id: null, geometry, properties: {}, visible: true } : null;
}
