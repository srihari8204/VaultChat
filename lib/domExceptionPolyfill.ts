// Hermes does not provide DOMException, but livekit-client reads it at module
// scope. Keep this tiny polyfill at the root instead of importing LiveKit there.
const g = globalThis as typeof globalThis & { DOMException?: typeof DOMException };

if (typeof g.DOMException === 'undefined') {
  g.DOMException = class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
    }
  } as unknown as typeof DOMException;
}

export {};
