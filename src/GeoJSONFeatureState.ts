import { createSubject } from '@mapconductor/js-sdk-core';
import type { GeoJSONGeometry } from './GeoJSONGeometry';

export interface GeoJSONFeatureFingerPrint {
    id: number;
    geometry: number;
    properties: number;
    style: number;
    visible: number;
}

function fpEquals(a: GeoJSONFeatureFingerPrint, b: GeoJSONFeatureFingerPrint): boolean {
    return a.id === b.id &&
        a.geometry === b.geometry &&
        a.properties === b.properties &&
        a.style === b.style &&
        a.visible === b.visible;
}

function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h;
}

function objectHash(obj: unknown): number {
    try {
        return hashStr(JSON.stringify(obj) ?? '');
    } catch {
        return 0;
    }
}

function buildDefaultId(geometry: GeoJSONGeometry, properties: Record<string, unknown>): string {
    return ((objectHash(geometry) * 31 + objectHash(properties)) | 0).toString();
}

export class GeoJSONFeatureState {
    readonly id: string;

    private _geometry: GeoJSONGeometry;
    private _properties: Record<string, unknown>;
    private _strokeColor: number | null;
    private _fillColor: number | null;
    private _strokeWidth: number | null;
    private _pointRadius: number | null;
    private _visible: boolean;

    private readonly subject = createSubject<GeoJSONFeatureFingerPrint>(fpEquals);

    constructor(params: {
        featureId?: string | null;
        geometry: GeoJSONGeometry;
        properties?: Record<string, unknown>;
        strokeColor?: number | null;
        fillColor?: number | null;
        strokeWidth?: number | null;
        pointRadius?: number | null;
        visible?: boolean;
    }) {
        this._geometry = params.geometry;
        this._properties = params.properties ?? {};
        this._strokeColor = params.strokeColor ?? null;
        this._fillColor = params.fillColor ?? null;
        this._strokeWidth = params.strokeWidth ?? null;
        this._pointRadius = params.pointRadius ?? null;
        this._visible = params.visible ?? true;
        this.id = params.featureId ?? buildDefaultId(this._geometry, this._properties);
        this.subject.next(this.fingerPrint());
    }

    get geometry(): GeoJSONGeometry { return this._geometry; }
    set geometry(v: GeoJSONGeometry) { this._geometry = v; this.subject.next(this.fingerPrint()); }

    get properties(): Record<string, unknown> { return this._properties; }
    set properties(v: Record<string, unknown>) { this._properties = v; this.subject.next(this.fingerPrint()); }

    get strokeColor(): number | null { return this._strokeColor; }
    set strokeColor(v: number | null) { this._strokeColor = v; this.subject.next(this.fingerPrint()); }

    get fillColor(): number | null { return this._fillColor; }
    set fillColor(v: number | null) { this._fillColor = v; this.subject.next(this.fingerPrint()); }

    get strokeWidth(): number | null { return this._strokeWidth; }
    set strokeWidth(v: number | null) { this._strokeWidth = v; this.subject.next(this.fingerPrint()); }

    get pointRadius(): number | null { return this._pointRadius; }
    set pointRadius(v: number | null) { this._pointRadius = v; this.subject.next(this.fingerPrint()); }

    get visible(): boolean { return this._visible; }
    set visible(v: boolean) { this._visible = v; this.subject.next(this.fingerPrint()); }

    fingerPrint(): GeoJSONFeatureFingerPrint {
        const styleHash = (
            ((this._strokeColor ?? 0) * 31) ^
            ((this._fillColor ?? 0) * 961) ^
            (((this._strokeWidth ?? 0) * 1000 | 0) * 29791) ^
            (((this._pointRadius ?? 0) * 1000 | 0) * 923521)
        ) | 0;
        return {
            id: hashStr(this.id),
            geometry: objectHash(this._geometry),
            properties: objectHash(this._properties),
            style: styleHash,
            visible: this._visible ? 1 : 0,
        };
    }

    asObservable(): { subscribe: (fn: (fp: GeoJSONFeatureFingerPrint) => void) => () => void } {
        return { subscribe: this.subject.subscribe };
    }
}
