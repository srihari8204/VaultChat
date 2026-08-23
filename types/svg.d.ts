// types/svg.d.ts — SVG files import as React components.
//
// react-native-svg-transformer (wired in metro.config.js) compiles .svg into a
// react-native-svg component at bundle time. TypeScript knows nothing about
// that, so without this declaration every `import Logo from './x.svg'` is a
// "cannot find module" error even though the bundle is correct.
//
// expo-env.d.ts is generated and says not to edit it, hence a file of our own.

declare module '*.svg' {
  import type React from 'react';
  import type { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}
