module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath:
          'import com.mapconductor.react.geojson.MapConductorGeoJSONPackage;',
        packageInstance: 'new MapConductorGeoJSONPackage()',
      },
      ios: {
        sourceDir: './ios',
      },
    },
  },
};
