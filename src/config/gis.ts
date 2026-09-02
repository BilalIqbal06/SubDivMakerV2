/**
 * GIS Service Configuration
 *
 * Local dev uses Vite's proxy at `/api/loudoun` and `/api/loudoun-gis` to
 * avoid CORS and route to the upstream Loudoun servers.
 *
 * Production builds use the absolute authoritative URLs directly because
 * GitHub Pages has no application proxy.
 *
 * /api/loudoun      → https://logis.loudoun.gov
 * /api/loudoun-gis  → https://gis.loudoun.gov
 */

export const LOGIS_GIS_BASE_URL = __LOGIS_GIS_BASE_URL__
export const LOUDOUN_GIS_BASE_URL = __LOUDOUN_GIS_BASE_URL__

// Backward-compatible alias for the logis-proxied COL services.
export const GIS_BASE_URL = LOGIS_GIS_BASE_URL
