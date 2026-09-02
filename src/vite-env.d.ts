/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly MODE: string
  readonly BASE_URL: string
  readonly PROD: boolean
  readonly SSR: boolean
  readonly VITE_VERBOSE_GIS_DIAGNOSTICS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __LOGIS_GIS_BASE_URL__: string
declare const __LOUDOUN_GIS_BASE_URL__: string
