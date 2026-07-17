import Foundation
import MapConductorReactNativeCore

/// Exists purely so React Native instantiates it once at bridge startup (via
/// `MapConductorGeoJSONPackage.m`'s `RCT_EXTERN_MODULE`), as the trigger point to register the
/// `"geojson"` native map extension renderer — mirrors Android's `MapConductorGeoJSONPackage.kt`.
/// No JS code ever calls a method on this module.
@objc(MapConductorGeoJSONPackage)
public final class MapConductorGeoJSONPackage: NSObject {
    public override init() {
        super.init()
        MapConductorGeoJSONPackage.registerOnce
    }

    @objc public static func requiresMainQueueSetup() -> Bool { false }

    private static let registerOnce: Void = {
        NativeMapExtensionRegistry.register(type: "geojson") { extensionId, eventSink in
            GeoJSONExtensionRenderer(extensionId: extensionId, eventSink: eventSink)
        }
    }()
}
