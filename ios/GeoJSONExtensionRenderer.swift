import Foundation
import MapConductorCore
import MapConductorGeoJSON
import MapConductorReactNativeCore
import UIKit

/// iOS counterpart of Android's `GeoJSONLayerRenderer.kt`: decodes the `upsertNativeMapExtension`
/// payload for `type: "geojson"` into `GeoJSONFeature`s and drives a `GeoJSONLayerState`.
final class GeoJSONExtensionRenderer: NativeMapExtensionRenderer {
    private let extensionId: String
    private let eventSink: NativeMapExtensionEventSink
    private var layerState: GeoJSONLayerState?
    private var features: [GeoJSONFeature] = []
    private var options = Options.Default

    init(extensionId: String, eventSink: @escaping NativeMapExtensionEventSink) {
        self.extensionId = extensionId
        self.eventSink = eventSink
    }

    func update(payload: [String: Any]) {
        let nextOptions = Options.decode(payload["options"])
        options = nextOptions

        let state: GeoJSONLayerState
        if let existing = layerState {
            state = existing
        } else {
            state = GeoJSONLayerState(tileSize: nextOptions.tileSize)
            state.onClick = { [weak self] feature, point in
                guard let self, self.options.onClickEnabled else { return }
                self.eventSink(self.extensionId, "click", [
                    "feature": Self.featurePayload(feature),
                    "position": mcPointPayload(point)
                ])
            }
            state.onLoadStart = { [weak self] in
                guard let self else { return }
                self.eventSink(self.extensionId, "loadStart", [:])
            }
            state.onLoadComplete = { [weak self] error in
                guard let self else { return }
                var payload: [String: Any] = [:]
                if let error { payload["errorMessage"] = "\(error)" }
                self.eventSink(self.extensionId, "loadComplete", payload)
            }
            layerState = state
        }
        state.opacity = nextOptions.opacity
        state.minZoom = nextOptions.minZoom
        state.maxZoom = nextOptions.maxZoom
        state.layerStyle = nextOptions.layerStyle

        let sourceUri = mcString(payload["sourceUri"])
        if let sourceUri, !sourceUri.isEmpty {
            features = Self.decodeSourceUri(sourceUri)
        } else {
            features = Self.decodeFeatures(payload["features"]) + Self.decodeFeatures(payload["dynamicFeatures"])
        }
    }

    func dispose() {}

    /// Rebuilt on every call; `GeoJSONLayer`'s own `.task(id:)` only re-applies `features` to the
    /// renderer when their content actually changes, so this is cheap to call from every
    /// `content:` re-evaluation.
    func makeContent() -> MapViewContent {
        guard let layerState else { return MapViewContent() }
        return MapViewContentBuilder.buildExpression(GeoJSONLayer(layerState, features: features))
    }

    // MARK: - Source loading

    private static func decodeSourceUri(_ uriString: String) -> [GeoJSONFeature] {
        if uriString.components(separatedBy: "?").first?.lowercased().hasSuffix(".zip") == true {
            return decodeZipUri(uriString)
        }
        guard let stream = openUri(uriString) else { return [] }
        return GeoJSONParser.parse(stream: stream)
    }

    private static func decodeZipUri(_ uriString: String) -> [GeoJSONFeature] {
        guard let path = filePath(for: uriString), let archive = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return [] }
        // Minimal zip support is out of scope for this pass; unzip ahead of time on the JS side
        // and pass a plain .geojson `sourceUri` instead. Fall back to treating the archive bytes
        // as a raw GeoJSON document so this doesn't silently produce nothing for a mislabeled URI.
        return GeoJSONParser.parse(data: archive)
    }

    private static func openUri(_ uriString: String) -> InputStream? {
        guard let path = filePath(for: uriString) else { return nil }
        return InputStream(fileAtPath: path)
    }

    private static func filePath(for uriString: String) -> String? {
        if uriString.hasPrefix("file://") { return URL(string: uriString)?.path }
        if uriString.hasPrefix("data:") { return nil }
        return uriString
    }

    // MARK: - Feature / geometry decode

    private static func decodeFeatures(_ value: Any?) -> [GeoJSONFeature] {
        (mcArray(value) ?? []).compactMap(decodeFeature)
    }

    private static func decodeFeature(_ value: Any?) -> GeoJSONFeature? {
        guard let map = mcMap(value), let geometry = decodeGeometry(map["geometry"]) else { return nil }
        return GeoJSONFeature(
            id: mcString(map["id"]),
            geometry: geometry,
            properties: mcMap(map["properties"]) ?? [:],
            strokeColor: mcColorOrNil(argb: map["strokeColor"]),
            fillColor: mcColorOrNil(argb: map["fillColor"]),
            strokeWidth: mcNumber(map["strokeWidth"]).map { CGFloat($0.doubleValue) },
            pointRadius: mcNumber(map["pointRadius"]).map { CGFloat($0.doubleValue) },
            visible: mcBool(map["visible"], default: true)
        )
    }

    private static func decodeGeometry(_ value: Any?) -> GeoJSONGeometry? {
        guard let map = mcMap(value) else { return nil }
        switch mcString(map["type"]) {
        case "Point":
            guard let longitude = mcNumber(map["longitude"]), let latitude = mcNumber(map["latitude"]) else { return nil }
            return .point(longitude: longitude.doubleValue, latitude: latitude.doubleValue)
        case "MultiPoint":
            return .multiPoint(points: decodeLonLatList(map["points"]))
        case "LineString":
            return .lineString(coordinates: decodeLonLatList(map["coordinates"]))
        case "MultiLineString":
            return .multiLineString(lines: decodeLonLatListOfLists(map["lines"]))
        case "Polygon":
            return .polygon(rings: decodeLonLatListOfLists(map["rings"]))
        case "MultiPolygon":
            return .multiPolygon(polygons: (mcArray(map["polygons"]) ?? []).map(decodeLonLatListOfLists))
        case "GeometryCollection":
            return .geometryCollection(geometries: (mcArray(map["geometries"]) ?? []).compactMap(decodeGeometry))
        case "Empty":
            return .empty
        default:
            return nil
        }
    }

    private static func decodeLonLatList(_ value: Any?) -> [LonLat] {
        (mcArray(value) ?? []).compactMap { entry -> LonLat? in
            guard let map = mcMap(entry), let lng = mcNumber(map["longitude"]), let lat = mcNumber(map["latitude"]) else { return nil }
            return LonLat(longitude: lng.doubleValue, latitude: lat.doubleValue)
        }
    }

    private static func decodeLonLatListOfLists(_ value: Any?) -> [[LonLat]] {
        (mcArray(value) ?? []).map(decodeLonLatList)
    }

    // MARK: - Event payload encoding

    private static func featurePayload(_ feature: GeoJSONFeature) -> [String: Any] {
        var payload: [String: Any] = [
            "geometry": geometryPayload(feature.geometry),
            "properties": feature.properties,
            "visible": feature.visible
        ]
        if let id = feature.id { payload["id"] = id }
        return payload
    }

    private static func geometryPayload(_ geometry: GeoJSONGeometry) -> [String: Any] {
        switch geometry {
        case let .point(longitude, latitude):
            return ["type": "Point", "longitude": longitude, "latitude": latitude]
        case let .multiPoint(points):
            return ["type": "MultiPoint", "points": points.map(lonLatPayload)]
        case let .lineString(coordinates):
            return ["type": "LineString", "coordinates": coordinates.map(lonLatPayload)]
        case let .multiLineString(lines):
            return ["type": "MultiLineString", "lines": lines.map { $0.map(lonLatPayload) }]
        case let .polygon(rings):
            return ["type": "Polygon", "rings": rings.map { $0.map(lonLatPayload) }]
        case let .multiPolygon(polygons):
            return ["type": "MultiPolygon", "polygons": polygons.map { ring in ring.map { $0.map(lonLatPayload) } }]
        case let .geometryCollection(geometries):
            return ["type": "GeometryCollection", "geometries": geometries.map(geometryPayload)]
        case .empty:
            return ["type": "Empty"]
        }
    }

    private static func lonLatPayload(_ point: LonLat) -> [String: Any] {
        ["longitude": point.longitude, "latitude": point.latitude]
    }

    private struct Options {
        let opacity: Double
        let minZoom: Int
        let maxZoom: Int
        let onClickEnabled: Bool
        let layerStyle: GeoJSONTileRenderer.LayerStyle
        let tileSize: Int

        static let Default = Options(
            opacity: GeoJSONDefaults.defaultOpacity,
            minZoom: 0,
            maxZoom: GeoJSONDefaults.defaultMaxZoom,
            onClickEnabled: false,
            layerStyle: GeoJSONTileRenderer.LayerStyle(),
            tileSize: GeoJSONDefaults.defaultTileSize
        )

        static func decode(_ value: Any?) -> Options {
            guard let map = mcMap(value) else { return .Default }
            return Options(
                opacity: mcDouble(map["opacity"], default: Default.opacity),
                minZoom: mcInt(map["minZoom"], default: Default.minZoom),
                maxZoom: mcInt(map["maxZoom"], default: Default.maxZoom),
                onClickEnabled: mcBool(map["onClickEnabled"], default: false),
                layerStyle: GeoJSONTileRenderer.LayerStyle(
                    strokeColor: mcColor(argb: map["strokeColor"], default: GeoJSONDefaults.defaultStrokeColor),
                    fillColor: mcColor(argb: map["fillColor"], default: GeoJSONDefaults.defaultFillColor),
                    strokeWidth: CGFloat(mcDouble(map["strokeWidth"], default: Double(GeoJSONDefaults.defaultStrokeWidth))),
                    pointRadius: CGFloat(mcDouble(map["pointRadius"], default: Double(GeoJSONDefaults.defaultPointRadius)))
                ),
                tileSize: mcInt(map["tileSize"], default: Default.tileSize)
            )
        }
    }
}
