import Foundation
import MapConductorGeoJSON

public typealias GeoJSONStyleProviderFactory = (
    _ sourceUri: String?
) throws -> any GeoJSONStyleProvider

/// Application-owned native style providers used by the React Native GeoJSON bridge.
public enum GeoJSONStyleProviderRegistry {
    private static let lock = NSLock()
    private static var factories: [String: GeoJSONStyleProviderFactory] = [:]

    public static func register(id: String, factory: @escaping GeoJSONStyleProviderFactory) {
        precondition(!id.isEmpty, "GeoJSON style provider id must not be empty")
        lock.lock()
        factories[id] = factory
        lock.unlock()
    }

    static func create(
        id: String,
        sourceUri: String?
    ) throws -> (any GeoJSONStyleProvider)? {
        lock.lock()
        let factory = factories[id]
        lock.unlock()
        return try factory?(sourceUri)
    }
}
