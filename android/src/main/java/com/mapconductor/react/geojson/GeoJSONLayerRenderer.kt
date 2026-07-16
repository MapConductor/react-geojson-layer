package com.mapconductor.react.geojson

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableMapKeySetIterator
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.mapconductor.compose.MapViewScope
import com.mapconductor.core.features.GeoPoint
import com.mapconductor.geojson.GeoJSONDefaults
import com.mapconductor.geojson.DefaultGeoJSONStyleProvider
import com.mapconductor.geojson.GeoJSONFeature
import com.mapconductor.geojson.GeoJSONGeometry
import com.mapconductor.geojson.GeoJSONLayer
import com.mapconductor.geojson.GeoJSONLayerState
import com.mapconductor.geojson.LonLat
import com.mapconductor.settings.Settings
import com.mapconductor.core.ResourceProvider
import com.mapconductor.react.extensions.NativeMapExtensionEventSink
import com.mapconductor.react.extensions.NativeMapExtensionRenderer
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream
import java.io.FileInputStream
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class GeoJSONLayerRenderer(
    internal val context: Context,
    private val extensionId: String,
    private val eventSink: NativeMapExtensionEventSink,
) : NativeMapExtensionRenderer {
    private val ingestDispatcher: CoroutineDispatcher =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "GeoJSONIngest-$extensionId").apply { isDaemon = true }
        }.asCoroutineDispatcher()
    private val scope = CoroutineScope(ingestDispatcher)
    private var updateJob: Job? = null
    private var features by mutableStateOf<List<GeoJSONFeature>>(emptyList())
    private var options = GeoJSONOptions.Default
    private val layerState =
        GeoJSONLayerState(
            onClick = onClick@{ feature, position ->
                if (!options.onClickEnabled) return@onClick
                eventSink.emit(
                    extensionId,
                    "click",
                    Arguments.createMap().apply {
                        putMap("feature", feature.toWritableMap())
                        putMap("position", position.toWritableMap())
                    },
                )
            },
        )

    override fun update(payload: ReadableMap?) {
        val nextOptions = GeoJSONOptions.fromReadableMap(payload?.map("options"))
        options = nextOptions
        applyOptions(nextOptions)
        val staticFeaturesPayload = payload?.array("features")
        val dynamicFeaturesPayload = payload?.array("dynamicFeatures")
        val sourceUri = payload?.string("sourceUri")
        updateJob?.cancel()
        updateJob =
            scope.launch {
                withContext(Dispatchers.Main) {
                    eventSink.emit(extensionId, "loadStart", Arguments.createMap())
                }
                try {
                    val styleProvider =
                        nextOptions.styleProviderId?.let { providerId ->
                            runCatching {
                                GeoJSONStyleProviderRegistry.create(providerId, context, sourceUri)
                            }.getOrNull()
                        } ?: DefaultGeoJSONStyleProvider
                    val decoded =
                        if (!sourceUri.isNullOrBlank()) {
                            decodeSourceUri(sourceUri)
                        } else {
                            decodeFeatureArray(staticFeaturesPayload) + decodeFeatureArray(dynamicFeaturesPayload)
                        }
                    withContext(Dispatchers.Main) {
                        layerState.styleProvider = styleProvider
                        features = decoded
                        eventSink.emit(extensionId, "loadComplete", Arguments.createMap())
                    }
                } catch (t: Throwable) {
                    withContext(Dispatchers.Main) {
                        eventSink.emit(
                            extensionId,
                            "loadComplete",
                            Arguments.createMap().apply {
                                putString("errorMessage", t.message ?: t.javaClass.name)
                            },
                        )
                    }
                }
            }
    }

    @Composable
    override fun MapViewScope.Render() {
        val current = options
        GeoJSONLayer(
            state = layerState,
            features = features,
            tileSize = current.tileSize,
            disableTileServerCache = current.disableTileServerCache,
        )
    }

    override fun onMapClick(
        point: GeoPoint,
        zoom: Double,
    ): Boolean {
        val pixelTolerance =
            Settings.Default.tapTolerance.value.toDouble() *
                ResourceProvider.getDensity().toDouble()
        return layerState.processClick(point, pixelTolerance = pixelTolerance, zoom = zoom)
    }

    override fun dispose() {
        updateJob?.cancel()
        scope.cancel()
        (ingestDispatcher as? java.io.Closeable)?.close()
    }

    private fun applyOptions(options: GeoJSONOptions) {
        layerState.opacity = options.opacity.toFloat()
        layerState.strokeColor = options.strokeColor
        layerState.fillColor = options.fillColor
        layerState.strokeWidth = options.strokeWidth.toFloat()
        layerState.pointRadius = options.pointRadius.toFloat()
        layerState.visible = options.visible
        layerState.minZoom = options.minZoom
        layerState.maxZoom = options.maxZoom
    }
}

private fun GeoJSONLayerRenderer.decodeSourceUri(uriString: String): List<GeoJSONFeature> {
    val input = openUri(uriString)
    if (!uriString.substringBefore('?').lowercase().endsWith(".zip")) {
        return input.use { com.mapconductor.geojson.GeoJSONParser.parseStream(it) }
    }
    input.use { rawInput ->
        ZipInputStream(rawInput).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (!entry.isDirectory && entry.name.endsWith(".geojson", ignoreCase = true)) {
                    return com.mapconductor.geojson.GeoJSONParser.parseStream(zip)
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
            error("No GeoJSON entry found in $uriString")
        }
    }
}

private fun GeoJSONLayerRenderer.openUri(uriString: String): java.io.InputStream {
    val uri = Uri.parse(uriString)
    return when (uri.scheme?.lowercase()) {
        "content", "android.resource" -> context.contentResolver.openInputStream(uri)
            ?: error("Unable to open GeoJSON URI: $uriString")
        "file" -> FileInputStream(uri.path ?: error("GeoJSON file URI has no path: $uriString"))
        else -> FileInputStream(uriString)
    }
}

private data class GeoJSONOptions(
    val opacity: Double,
    val strokeColor: Int,
    val fillColor: Int,
    val strokeWidth: Double,
    val pointRadius: Double,
    val visible: Boolean,
    val minZoom: Int,
    val maxZoom: Int,
    val styleProviderId: String?,
    val tileSize: Int,
    val disableTileServerCache: Boolean,
    val onClickEnabled: Boolean,
) {
    companion object {
        val Default =
            GeoJSONOptions(
                opacity = GeoJSONDefaults.DEFAULT_OPACITY.toDouble(),
                strokeColor = GeoJSONDefaults.DEFAULT_STROKE_COLOR,
                fillColor = GeoJSONDefaults.DEFAULT_FILL_COLOR,
                strokeWidth = GeoJSONDefaults.DEFAULT_STROKE_WIDTH.toDouble(),
                pointRadius = GeoJSONDefaults.DEFAULT_POINT_RADIUS.toDouble(),
                visible = true,
                minZoom = 0,
                maxZoom = GeoJSONDefaults.DEFAULT_MAX_ZOOM,
                styleProviderId = null,
                tileSize = GeoJSONDefaults.DEFAULT_TILE_SIZE,
                disableTileServerCache = false,
                onClickEnabled = false,
            )

        fun fromReadableMap(map: ReadableMap?): GeoJSONOptions =
            GeoJSONOptions(
                opacity = map?.number("opacity") ?: Default.opacity,
                strokeColor = map?.number("strokeColor")?.toInt() ?: Default.strokeColor,
                fillColor = map?.number("fillColor")?.toInt() ?: Default.fillColor,
                strokeWidth = map?.number("strokeWidth") ?: Default.strokeWidth,
                pointRadius = map?.number("pointRadius") ?: Default.pointRadius,
                visible = map?.boolean("visible") ?: Default.visible,
                minZoom = map?.number("minZoom")?.toInt() ?: Default.minZoom,
                maxZoom = map?.number("maxZoom")?.toInt() ?: Default.maxZoom,
                styleProviderId = map?.string("styleProviderId") ?: Default.styleProviderId,
                tileSize = map?.number("tileSize")?.toInt() ?: Default.tileSize,
                disableTileServerCache = map?.boolean("disableTileServerCache") ?: false,
                onClickEnabled = map?.boolean("onClickEnabled") ?: false,
            )
    }
}

private fun decodeFeatureArray(payload: ReadableArray?): List<GeoJSONFeature> {
    if (payload == null) return emptyList()
    return buildList {
        for (index in 0 until payload.size()) {
            val feature = payload.getMap(index)?.toGeoJSONFeature() ?: continue
            add(feature)
        }
    }
}

private fun ReadableMap.toGeoJSONFeature(): GeoJSONFeature? {
    val geometry = map("geometry")?.toGeoJSONGeometry() ?: return null
    return GeoJSONFeature(
        id = string("id"),
        geometry = geometry,
        properties = map("properties")?.toKotlinMap().orEmpty(),
        strokeColor = number("strokeColor")?.toInt(),
        fillColor = number("fillColor")?.toInt(),
        strokeWidth = number("strokeWidth")?.toFloat(),
        pointRadius = number("pointRadius")?.toFloat(),
        visible = boolean("visible") ?: true,
    )
}

private fun ReadableMap.toGeoJSONGeometry(): GeoJSONGeometry? =
    when (string("type")) {
        "Point" -> {
            val longitude = number("longitude") ?: return null
            val latitude = number("latitude") ?: return null
            GeoJSONGeometry.Point(longitude = longitude, latitude = latitude)
        }
        "MultiPoint" ->
            GeoJSONGeometry.MultiPoint(
                points = array("points").toLonLatList().map { GeoJSONGeometry.Point(it.longitude, it.latitude) },
            )
        "LineString" ->
            GeoJSONGeometry.LineString(
                coordinates = array("coordinates").toLonLatList(),
            )
        "MultiLineString" ->
            GeoJSONGeometry.MultiLineString(
                lines = array("lines").toLonLatListOfLists(),
            )
        "Polygon" ->
            GeoJSONGeometry.Polygon(
                rings = array("rings").toLonLatListOfLists(),
            )
        "MultiPolygon" ->
            GeoJSONGeometry.MultiPolygon(
                polygons = array("polygons").toLonLatListOfListOfLists(),
            )
        "GeometryCollection" ->
            GeoJSONGeometry.GeometryCollection(
                geometries =
                    buildList {
                        val geometries = array("geometries") ?: return@buildList
                        for (index in 0 until geometries.size()) {
                            val geometry = geometries.getMap(index)?.toGeoJSONGeometry() ?: continue
                            add(geometry)
                        }
                    },
            )
        "Empty" -> GeoJSONGeometry.Empty
        else -> null
    }

private fun ReadableArray?.toLonLatList(): List<LonLat> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until size()) {
            val point = getMap(index) ?: continue
            val longitude = point.number("longitude") ?: continue
            val latitude = point.number("latitude") ?: continue
            add(LonLat(longitude = longitude, latitude = latitude))
        }
    }
}

private fun ReadableArray?.toLonLatListOfLists(): List<List<LonLat>> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until size()) {
            add(getArray(index).toLonLatList())
        }
    }
}

private fun ReadableArray?.toLonLatListOfListOfLists(): List<List<List<LonLat>>> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until size()) {
            add(getArray(index).toLonLatListOfLists())
        }
    }
}

private fun ReadableMap.toKotlinMap(): Map<String, Any?> =
    buildMap {
        val iterator: ReadableMapKeySetIterator = keySetIterator()
        while (iterator.hasNextKey()) {
            val key = iterator.nextKey()
            put(key, readableValue(key))
        }
    }

private fun ReadableArray.toKotlinList(): List<Any?> =
    buildList {
        for (index in 0 until size()) {
            add(readableValue(index))
        }
    }

private fun ReadableMap.readableValue(key: String): Any? =
    when (getType(key)) {
        ReadableType.Null -> null
        ReadableType.Boolean -> getBoolean(key)
        ReadableType.Number -> getDouble(key)
        ReadableType.String -> getString(key)
        ReadableType.Map -> getMap(key)?.toKotlinMap()
        ReadableType.Array -> getArray(key)?.toKotlinList()
    }

private fun ReadableArray.readableValue(index: Int): Any? =
    when (getType(index)) {
        ReadableType.Null -> null
        ReadableType.Boolean -> getBoolean(index)
        ReadableType.Number -> getDouble(index)
        ReadableType.String -> getString(index)
        ReadableType.Map -> getMap(index)?.toKotlinMap()
        ReadableType.Array -> getArray(index)?.toKotlinList()
    }

private fun GeoPoint.toWritableMap() =
    Arguments.createMap().apply {
        putDouble("latitude", latitude)
        putDouble("longitude", longitude)
    }

private fun GeoJSONFeature.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        id?.let { putString("id", it) }
        putMap("geometry", geometry.toWritableMap())
        putMap("properties", properties.toWritableMap())
        strokeColor?.let { putInt("strokeColor", it) }
        fillColor?.let { putInt("fillColor", it) }
        strokeWidth?.let { putDouble("strokeWidth", it.toDouble()) }
        pointRadius?.let { putDouble("pointRadius", it.toDouble()) }
        putBoolean("visible", visible)
    }

private fun GeoJSONGeometry.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        when (this@toWritableMap) {
            is GeoJSONGeometry.Point -> {
                putString("type", "Point")
                putDouble("longitude", longitude)
                putDouble("latitude", latitude)
            }
            is GeoJSONGeometry.MultiPoint -> {
                putString("type", "MultiPoint")
                putArray("points", points.toWritablePointArray())
            }
            is GeoJSONGeometry.LineString -> {
                putString("type", "LineString")
                putArray("coordinates", coordinates.toWritableLonLatArray())
            }
            is GeoJSONGeometry.MultiLineString -> {
                putString("type", "MultiLineString")
                putArray("lines", lines.toWritableNestedArray())
            }
            is GeoJSONGeometry.Polygon -> {
                putString("type", "Polygon")
                putArray("rings", rings.toWritableNestedArray())
            }
            is GeoJSONGeometry.MultiPolygon -> {
                putString("type", "MultiPolygon")
                putArray("polygons", polygons.toWritableTripleNestedArray())
            }
            is GeoJSONGeometry.GeometryCollection -> {
                putString("type", "GeometryCollection")
                putArray("geometries", geometries.toWritableGeometryArray())
            }
            GeoJSONGeometry.Empty -> {
                putString("type", "Empty")
            }
        }
    }

private fun Map<String, Any?>.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        forEach { (key, value) -> putAny(key, value) }
    }

private fun List<Any?>.toWritableArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { value -> pushAny(value) }
    }

private fun List<GeoJSONGeometry.Point>.toWritablePointArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { point -> pushMap(point.toWritablePointMap()) }
    }

private fun List<LonLat>.toWritableLonLatArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { point -> pushMap(point.toWritablePointMap()) }
    }

private fun List<List<LonLat>>.toWritableNestedArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { ring -> pushArray(ring.toWritableLonLatArray()) }
    }

private fun List<List<List<LonLat>>>.toWritableTripleNestedArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { polygon -> pushArray(polygon.toWritableNestedArray()) }
    }

private fun List<GeoJSONGeometry>.toWritableGeometryArray(): WritableArray =
    Arguments.createArray().apply {
        forEach { geometry -> pushMap(geometry.toWritableMap()) }
    }

private fun GeoJSONGeometry.Point.toWritablePointMap(): WritableMap =
    Arguments.createMap().apply {
        putDouble("longitude", longitude)
        putDouble("latitude", latitude)
    }

private fun LonLat.toWritablePointMap(): WritableMap =
    Arguments.createMap().apply {
        putDouble("longitude", longitude)
        putDouble("latitude", latitude)
    }

@Suppress("UNCHECKED_CAST")
private fun WritableMap.putAny(
    key: String,
    value: Any?,
) {
    when (value) {
        null -> putNull(key)
        is Boolean -> putBoolean(key, value)
        is Int -> putInt(key, value)
        is Long -> putDouble(key, value.toDouble())
        is Float -> putDouble(key, value.toDouble())
        is Double -> putDouble(key, value)
        is String -> putString(key, value)
        is Map<*, *> -> putMap(key, (value as Map<String, Any?>).toWritableMap())
        is List<*> -> putArray(key, (value as List<Any?>).toWritableArray())
        else -> putString(key, value.toString())
    }
}

@Suppress("UNCHECKED_CAST")
private fun WritableArray.pushAny(value: Any?) {
    when (value) {
        null -> pushNull()
        is Boolean -> pushBoolean(value)
        is Int -> pushInt(value)
        is Long -> pushDouble(value.toDouble())
        is Float -> pushDouble(value.toDouble())
        is Double -> pushDouble(value)
        is String -> pushString(value)
        is Map<*, *> -> pushMap((value as Map<String, Any?>).toWritableMap())
        is List<*> -> pushArray((value as List<Any?>).toWritableArray())
        else -> pushString(value.toString())
    }
}

private fun ReadableMap.map(key: String): ReadableMap? =
    if (hasKey(key) && !isNull(key)) getMap(key) else null

private fun ReadableMap.array(key: String): ReadableArray? =
    if (hasKey(key) && !isNull(key)) getArray(key) else null

private fun ReadableMap.number(key: String): Double? =
    if (hasKey(key) && !isNull(key)) getDouble(key) else null

private fun ReadableMap.boolean(key: String): Boolean? =
    if (hasKey(key) && !isNull(key)) getBoolean(key) else null

private fun ReadableMap.string(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null
