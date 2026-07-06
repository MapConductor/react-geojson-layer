import React, {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    OverlayCollector,
    TileScheme,
    TileServerRegistry,
    createRasterLayerState,
} from '@mapconductor/js-sdk-core';
import { RasterLayer } from '@mapconductor/js-sdk-react';
import { GeoJSONDefaults } from './GeoJSONDefaults';
import { GeoJSONTileRenderer } from './GeoJSONTileRenderer';
import { GeoJSONLayerState } from './GeoJSONLayerState';
import { GeoJSONFeatureState } from './GeoJSONFeatureState';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import type { GeoJSONFeatureFingerPrint } from './GeoJSONFeatureState';

// ─── Context ──────────────────────────────────────────────────────────────────

const GeoJSONFeatureContext = createContext<OverlayCollector<GeoJSONFeatureState> | null>(null);

function useFeatureCollector(): OverlayCollector<GeoJSONFeatureState> {
    const ctx = useContext(GeoJSONFeatureContext);
    if (!ctx) throw new Error('GeoJSONFeature must be rendered inside <GeoJSONLayer>');
    return ctx;
}

// ─── GeoJSONLayer ─────────────────────────────────────────────────────────────

export interface GeoJSONLayerProps {
    state?: GeoJSONLayerState;
    features?: GeoJSONFeatureData[];
    tileSize?: number;
    trackFeatureUpdates?: boolean;
    children?: React.ReactNode;
}

export function GeoJSONLayer(props: GeoJSONLayerProps): React.ReactElement | null {
    const {
        state: stateProp,
        features = [],
        tileSize = GeoJSONDefaults.DEFAULT_TILE_SIZE,
        trackFeatureUpdates = false,
        children,
    } = props;

    const state = useMemo(() => stateProp ?? new GeoJSONLayerState(), [stateProp]);
    const groupId = useMemo(() => `geojson-${Math.random().toString(36).slice(2)}`, []);
    const renderer = useMemo(() => new GeoJSONTileRenderer({ tileSize }), [tileSize]);
    const collector = useMemo(() => new OverlayCollector<GeoJSONFeatureState>(), []);
    const tileServer = useMemo(() => TileServerRegistry.get(), []);

    const rasterStateRef = useRef(
        createRasterLayerState({
            source: {
                type: 'UrlTemplate',
                template: tileServer.urlTemplate({ routeId: groupId, tileSize }),
                tileSize,
                maxZoom: GeoJSONDefaults.DEFAULT_MAX_ZOOM,
                scheme: TileScheme.XYZ,
            },
            opacity: Math.max(0, Math.min(1, state.opacity)),
            visible: state.visible,
            id: `geojson-${groupId}`,
        }),
    );

    const [isTileServerRegistered, setIsTileServerRegistered] = useState(false);
    const [hasRenderedOnce, setHasRenderedOnce] = useState(false);
    const [featureVersion, setFeatureVersion] = useState(0);
    const [updateToken, setUpdateToken] = useState(0);
    const featureMapRef = useRef<ReadonlyMap<string, GeoJSONFeatureState>>(new Map());

    // ── Opacity / visibility updates ──────────────────────────────────────────
    useEffect(() => {
        rasterStateRef.current.opacity = Math.max(0, Math.min(1, state.opacity));
    }, [state.opacity]);

    useEffect(() => {
        rasterStateRef.current.visible = state.visible;
    }, [state.visible]);

    // ── Register tile server ──────────────────────────────────────────────────
    useEffect(() => {
        tileServer.register(groupId, renderer);
        setIsTileServerRegistered(true);
        return () => {
            tileServer.unregister(groupId);
            setIsTileServerRegistered(false);
        };
    }, [groupId, tileServer, renderer]);

    // ── Wire renderer to state for hit-testing ────────────────────────────────
    useEffect(() => {
        state.renderer = renderer;
        return () => { state.renderer = null; };
    }, [state, renderer]);

    // ── Subscribe to child-based feature changes ──────────────────────────────
    useEffect(() => {
        return collector.subscribe((map: ReadonlyMap<string, GeoJSONFeatureState>) => {
            featureMapRef.current = map;
            setFeatureVersion(v => v + 1);
        });
    }, [collector]);

    // ── Track per-feature state changes ──────────────────────────────────────
    useEffect(() => {
        if (trackFeatureUpdates) {
            collector.setUpdateHandler(() => setUpdateToken(t => t + 1));
        } else {
            collector.setUpdateHandler(null);
        }
        return () => { collector.setUpdateHandler(null); };
    }, [collector, trackFeatureUpdates]);

    // ── features prop → collector ─────────────────────────────────────────────
    // (static features are passed directly to renderer, not via collector)

    // ── Re-render tiles when features or style changes ────────────────────────
    useEffect(() => {
        const dynamicFeatures = Array.from(featureMapRef.current.values());
        const layerStyle = {
            strokeColor: state.strokeColor,
            fillColor: state.fillColor,
            strokeWidth: state.strokeWidth,
            pointRadius: state.pointRadius,
        };

        renderer.update(features, dynamicFeatures, layerStyle);

        if (features.length === 0 && dynamicFeatures.length === 0) {
            setHasRenderedOnce(false);
            return;
        }

        setHasRenderedOnce(true);
        rasterStateRef.current.source = {
            type: 'UrlTemplate',
            template: tileServer.urlTemplate({
                routeId: groupId,
                tileSize,
                cacheKey: String(featureVersion + updateToken),
            }),
            tileSize,
            maxZoom: GeoJSONDefaults.DEFAULT_MAX_ZOOM,
            scheme: TileScheme.XYZ,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        featureVersion, updateToken,
        features,
        state.strokeColor, state.fillColor, state.strokeWidth, state.pointRadius,
        groupId, tileSize, tileServer, renderer,
    ]);

    // ── Cleanup on unmount ────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            collector.setUpdateHandler(null);
            collector.clear();
        };
    }, [collector]);

    return (
        <GeoJSONFeatureContext.Provider value={collector}>
            {isTileServerRegistered && hasRenderedOnce && (
                <RasterLayer state={rasterStateRef.current} />
            )}
            {children}
        </GeoJSONFeatureContext.Provider>
    );
}

// ─── GeoJSONFeature (child component) ────────────────────────────────────────

export interface GeoJSONFeatureStateProps {
    state: GeoJSONFeatureState;
    geometry?: never;
}

export interface GeoJSONFeatureParamsProps {
    state?: never;
    geometry: GeoJSONFeatureState['geometry'];
    featureId?: string | null;
    properties?: Record<string, unknown>;
    strokeColor?: number | null;
    fillColor?: number | null;
    strokeWidth?: number | null;
    pointRadius?: number | null;
    visible?: boolean;
}

export type GeoJSONFeatureProps = GeoJSONFeatureStateProps | GeoJSONFeatureParamsProps;

function GeoJSONFeatureWithState({ state }: GeoJSONFeatureStateProps): null {
    const collector = useFeatureCollector();

    useEffect(() => { collector.add(state); }, [state, collector]);

    useEffect(() => {
        return () => { collector.remove(state.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.id, collector]);

    return null;
}

function GeoJSONFeatureFromParams(props: GeoJSONFeatureParamsProps): React.ReactElement | null {
    const stateRef = useRef<GeoJSONFeatureState | null>(null);
    if (!stateRef.current) {
        stateRef.current = new GeoJSONFeatureState({
            featureId: props.featureId,
            geometry: props.geometry,
            properties: props.properties,
            strokeColor: props.strokeColor,
            fillColor: props.fillColor,
            strokeWidth: props.strokeWidth,
            pointRadius: props.pointRadius,
            visible: props.visible,
        });
    }
    const s = stateRef.current;

    useEffect(() => { s.geometry = props.geometry; }, [s, props.geometry]);
    useEffect(() => { s.properties = props.properties ?? {}; }, [s, props.properties]);
    useEffect(() => { s.strokeColor = props.strokeColor ?? null; }, [s, props.strokeColor]);
    useEffect(() => { s.fillColor = props.fillColor ?? null; }, [s, props.fillColor]);
    useEffect(() => { s.strokeWidth = props.strokeWidth ?? null; }, [s, props.strokeWidth]);
    useEffect(() => { s.pointRadius = props.pointRadius ?? null; }, [s, props.pointRadius]);
    useEffect(() => { s.visible = props.visible ?? true; }, [s, props.visible]);

    return <GeoJSONFeatureWithState state={s} />;
}

export function GeoJSONFeature(props: GeoJSONFeatureStateProps): null;
export function GeoJSONFeature(props: GeoJSONFeatureParamsProps): React.ReactElement | null;
export function GeoJSONFeature(props: GeoJSONFeatureProps): React.ReactElement | null {
    if (props.state !== undefined) return <GeoJSONFeatureWithState state={props.state} />;
    return <GeoJSONFeatureFromParams {...(props as GeoJSONFeatureParamsProps)} />;
}

// ─── GeoJSONFeatures (bulk) ───────────────────────────────────────────────────

export interface GeoJSONFeaturesProps {
    states: GeoJSONFeatureState[];
}

export function GeoJSONFeatures({ states }: GeoJSONFeaturesProps): null {
    const collector = useFeatureCollector();

    useEffect(() => {
        collector.replaceAll(states);
    }, [states, states.length, collector]);

    useEffect(() => {
        return () => { collector.clear(); };
    }, [collector]);

    return null;
}

// Re-export type for external consumers
export type { GeoJSONFeatureFingerPrint };
