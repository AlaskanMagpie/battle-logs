/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_UNIT_GLB?: string;
  readonly VITE_TRAILER_HERO_MODE?: string;
  /** Colyseus server base URL (HTTP(S) or WS(S); production builds should use a public TLS endpoint). */
  readonly VITE_COLYSEUS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
