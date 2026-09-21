// lib/nativeCore.ts — one TypeScript gate for optional Rust/UniFFI cores.
//
// Screens never call native modules directly. A feature facade calls this helper,
// the helper decides "native or TS fallback", and the TSX UI stays boring.
// Default stays fallback until a native core self-checks successfully.

export type NativeBackend = 'ts' | 'rust';

export interface NativeCoreOptions<T> {
  name: string;
  envValue?: string;
  load: () => T;
  init: (module: T) => boolean;
  initError?: (module: T) => string | null;
  onFallback?: (reason: string) => void;
}

export interface NativeCoreSelection<T> {
  backend: NativeBackend;
  module: T | null;
}

export function selectNativeCore<T>({
  name,
  envValue,
  load,
  init,
  initError,
  onFallback,
}: NativeCoreOptions<T>): NativeCoreSelection<T> {
  if (String(envValue || 'ts').toLowerCase() !== 'rust') {
    return { backend: 'ts', module: null };
  }

  try {
    const module = load();
    if (init(module)) return { backend: 'rust', module };
    onFallback?.(initError?.(module) || `${name}: unknown init error`);
  } catch (e) {
    onFallback?.(String((e as Error)?.message || e));
  }

  return { backend: 'ts', module: null };
}
