/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_UNIT_GLB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
