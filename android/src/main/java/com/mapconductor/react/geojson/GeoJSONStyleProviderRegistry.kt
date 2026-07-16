package com.mapconductor.react.geojson

import android.content.Context
import com.mapconductor.geojson.GeoJSONStyleProviderInterface
import java.util.concurrent.ConcurrentHashMap

/** Application-owned native providers used by the React Native GeoJSON bridge. */
fun interface GeoJSONStyleProviderFactory {
    fun create(
        context: Context,
        sourceUri: String?,
    ): GeoJSONStyleProviderInterface
}

object GeoJSONStyleProviderRegistry {
    private val factories = ConcurrentHashMap<String, GeoJSONStyleProviderFactory>()

    fun register(
        id: String,
        factory: GeoJSONStyleProviderFactory,
    ) {
        require(id.isNotBlank()) { "GeoJSON style provider id must not be blank" }
        factories[id] = factory
    }

    fun create(
        id: String,
        context: Context,
        sourceUri: String?,
    ): GeoJSONStyleProviderInterface? = factories[id]?.create(context, sourceUri)
}
