/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_UNIT_GLB?: string;
  readonly VITE_TRAILER_HERO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
