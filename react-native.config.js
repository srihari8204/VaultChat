// Project-level autolinking overrides.
//
// react-native-pdf-thumbnail@1.3.1 ships an inconsistent Android package: its
// AndroidManifest declares `com.pdfthumbnail` (which autolinking picks up) but
// the actual ReactPackage class is `org.songsterq.pdfthumbnail.PdfThumbnailPackage`.
// Point autolinking at the real class so PackageList.java compiles.
module.exports = {
  assets: ['./assets/fonts'],
  dependencies: {
    'react-native-pdf-thumbnail': {
      platforms: {
        android: {
          packageImportPath: 'import org.songsterq.pdfthumbnail.PdfThumbnailPackage;',
          packageInstance: 'new PdfThumbnailPackage()',
        },
      },
    },
  },
};
