import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { Platform } from 'react-native';
import { OverlayCollector, type GeoPointInterface } from '@mapconductor/js-sdk-core';
import {
  useNativeMapExtension,
  type NativeMapExtensionDescriptor,
  type NativeMapExtensionEvent,
} from '@mapconductor/js-sdk-react/native';
import { GeoJSONDefaults } from './GeoJSONDefaults';
import type { GeoJSONFeatureData } from './GeoJSONFeature';
import {
  GeoJSONFeatureState,
  type GeoJSONFeatureFingerPrint,
} from './GeoJSONFeatureState';
import type { GeoJSONGeometry } from './GeoJSONGeometry';
import { GeoJSONLayer as WebGeoJSONLayer } from './GeoJSONLayer';
import { GeoJSONLayerState } from './GeoJSONLayerState';

const GeoJSONFeatureContext = createContext<OverlayCollector<GeoJSONFeatureState> | null>(null);
const EMPTY_FEATURES: GeoJSONFeatureData[] = [];

function useFeatureCollector(): OverlayCollector<GeoJSONFeatureState> {
  const ctx = useContext(GeoJSONFeatureContext);
  if (!ctx) throw new Error('GeoJSONFeature must be rendered inside <GeoJSONLayer>');
  return ctx;
}

export interface GeoJSONLayerProps {
  state?: GeoJSONLayerState;
  features?: GeoJSONFeatureData[];
  /** Android local/content URI for a GeoJSON or GeoJSON ZIP asset. */
  sourceUri?: string;
  tileSize?: number;
  trackFeatureUpdates?: boolean;
  disableTileServerCache?: boolean;
  children?: React.ReactNode;
}

let nextLayerId = 1;

export function GeoJSONLayer(props: GeoJSONLayerProps): React.ReactElement | null {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return <WebGeoJSONLayer {...props} />;
  }
  return <NativeGeoJSONLayer {...props} />;
}

function NativeGeoJSONLayer(props: GeoJSONLayerProps): React.ReactElement | null {
  const {
    state: stateProp,
    features = EMPTY_FEATURES,
    sourceUri,
    tileSize = GeoJSONDefaults.DEFAULT_TILE_SIZE,
    trackFeatureUpdates = false,
    disableTileServerCache = false,
    children,
  } = props;
  const state = useMemo(() => stateProp ?? new GeoJSONLayerState(), [stateProp]);
  const layerId = useMemo(() => `geojson-${nextLayerId++}`, []);
  const collector = useMemo(() => new OverlayCollector<GeoJSONFeatureState>(), []);
  const [revision, invalidate] = useReducer((value: number) => value + 1, 0);

  useEffect(() => collector.subscribe(() => invalidate()), [collector]);

  useEffect(() => {
    collector.setUpdateHandler(trackFeatureUpdates ? invalidate : null);
    return () => collector.setUpdateHandler(null);
  }, [collector, trackFeatureUpdates]);

  useEffect(() => () => collector.clear(), [collector]);

  const dynamicFeatures = useMemo(() => {
    void revision;
    return collector.values().map(featureStateToData);
  }, [collector, revision]);

  const extension = useMemo<NativeMapExtensionDescriptor>(
    () => ({
      id: layerId,
      type: 'geojson',
      payload: {
        features,
        dynamicFeatures,
        sourceUri,
        options: {
          opacity: state.opacity,
          strokeColor: state.strokeColor,
          fillColor: state.fillColor,
          strokeWidth: state.strokeWidth,
          pointRadius: state.pointRadius,
          visible: state.visible,
          minZoom: state.minZoom,
          maxZoom: state.maxZoom,
          styleProviderId: state.styleProviderId,
          tileSize,
          disableTileServerCache,
          onClickEnabled: state.onClick != null,
        },
      },
    }),
    [disableTileServerCache, dynamicFeatures, features, layerId, state, tileSize],
  );

  const handleEvent = useCallback(
    (event: NativeMapExtensionEvent) => {
      if (event.eventName === 'loadStart') {
        state.onLoadStart?.();
        return;
      }
      if (event.eventName === 'loadComplete') {
        const message = typeof event.payload.errorMessage === 'string' ? event.payload.errorMessage : null;
        state.onLoadComplete?.(message ? new Error(message) : null);
        return;
      }
      if (event.eventName !== 'click' || state.onClick == null) return;
      const feature = decodeGeoJSONFeatureData(event.payload.feature);
      const position = decodeGeoPoint(event.payload.position);
      if (feature == null || position == null) return;
      state.onClick(feature, position);
    },
    [state],
  );

  useNativeMapExtension(extension, handleEvent);

  return (
    <GeoJSONFeatureContext.Provider value={collector}>
      {children ?? null}
    </GeoJSONFeatureContext.Provider>
  );
}

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

  useEffect(() => {
    collector.add(state);
  }, [collector, state]);

  useEffect(() => {
    return () => {
      collector.remove(state.id);
    };
  }, [collector, state.id]);

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
  const state = stateRef.current;

  useEffect(() => {
    state.geometry = props.geometry;
  }, [props.geometry, state]);
  useEffect(() => {
    state.properties = props.properties ?? {};
  }, [props.properties, state]);
  useEffect(() => {
    state.strokeColor = props.strokeColor ?? null;
  }, [props.strokeColor, state]);
  useEffect(() => {
    state.fillColor = props.fillColor ?? null;
  }, [props.fillColor, state]);
  useEffect(() => {
    state.strokeWidth = props.strokeWidth ?? null;
  }, [props.strokeWidth, state]);
  useEffect(() => {
    state.pointRadius = props.pointRadius ?? null;
  }, [props.pointRadius, state]);
  useEffect(() => {
    state.visible = props.visible ?? true;
  }, [props.visible, state]);

  return <GeoJSONFeatureWithState state={state} />;
}

export function GeoJSONFeature(props: GeoJSONFeatureStateProps): null;
export function GeoJSONFeature(props: GeoJSONFeatureParamsProps): React.ReactElement | null;
export function GeoJSONFeature(props: GeoJSONFeatureProps): React.ReactElement | null {
  if (props.state !== undefined) return <GeoJSONFeatureWithState state={props.state} />;
  return <GeoJSONFeatureFromParams {...(props as GeoJSONFeatureParamsProps)} />;
}

export interface GeoJSONFeaturesProps {
  states: GeoJSONFeatureState[];
}

export function GeoJSONFeatures({ states }: GeoJSONFeaturesProps): null {
  const collector = useFeatureCollector();

  useEffect(() => {
    collector.replaceAll(states);
  }, [collector, states, states.length]);

  useEffect(() => {
    return () => {
      collector.clear();
    };
  }, [collector]);

  return null;
}

function featureStateToData(state: GeoJSONFeatureState): GeoJSONFeatureData {
  return {
    id: state.id,
    geometry: state.geometry,
    properties: state.properties,
    strokeColor: state.strokeColor,
    fillColor: state.fillColor,
    strokeWidth: state.strokeWidth,
    pointRadius: state.pointRadius,
    visible: state.visible,
  };
}

function decodeGeoJSONFeatureData(value: unknown): GeoJSONFeatureData | null {
  if (!isRecord(value)) return null;
  const geometry = decodeGeometry(value.geometry);
  if (geometry == null) return null;
  return {
    id: typeof value.id === 'string' ? value.id : null,
    geometry,
    properties: isRecord(value.properties) ? value.properties : {},
    strokeColor: typeof value.strokeColor === 'number' ? value.strokeColor : null,
    fillColor: typeof value.fillColor === 'number' ? value.fillColor : null,
    strokeWidth: typeof value.strokeWidth === 'number' ? value.strokeWidth : null,
    pointRadius: typeof value.pointRadius === 'number' ? value.pointRadius : null,
    visible: typeof value.visible === 'boolean' ? value.visible : true,
  };
}

function decodeGeoPoint(value: unknown): GeoPointInterface | null {
  if (!isRecord(value)) return null;
  if (typeof value.latitude !== 'number' || typeof value.longitude !== 'number') return null;
  return { latitude: value.latitude, longitude: value.longitude };
}

function decodeGeometry(value: unknown): GeoJSONGeometry | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  return value as GeoJSONGeometry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type { GeoJSONFeatureFingerPrint };
