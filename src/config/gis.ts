/**
 * GIS Service Configuration
 * 
 * This configuration centralizes the frontend proxy base URLs for all Loudoun County
 * GIS requests. Both /api/loudoun and /api/loudoun-gis are transparently proxied to
 * the upstream ArcGIS servers by Vite (local dev) and by Vercel rewrites (production).
 * 
 * Local dev proxy:   vite.config.ts
 * Production proxy:  vercel.json
 * 
 * /api/loudoun      → https://logis.loudoun.gov
 * /api/loudoun-gis  → https://gis.loudoun.gov
 */

export const LOGIS_GIS_BASE_URL = '/api/loudoun'
export const LOUDOUN_GIS_BASE_URL = '/api/loudoun-gis'

// Backward-compatible alias for the logis-proxied COL services.
export const GIS_BASE_URL = LOGIS_GIS_BASE_URL
