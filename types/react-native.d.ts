// Minimal typings for the React Native components this plugin uses. Paseo provides
// react-native at runtime; the full package is not installed just to typecheck.
declare module "react-native" {
  import type { ComponentType, Ref } from "react";
  type Props = { [key: string]: any; ref?: Ref<any> };
  export const View: ComponentType<Props>;
  export type View = any;
  export const Text: ComponentType<Props>;
  export const Pressable: ComponentType<Props>;
  export const Image: ComponentType<Props>;
  export const ActivityIndicator: ComponentType<Props>;
  export const Platform: { OS: "ios" | "android" | "web" | "windows" | "macos" };
}
