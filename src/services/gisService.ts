import { GIS_BASE_URL } from '../config/gis'
import { networkCounter, verboseLog, turfc as turf } from '../lib/perf'

const gisSessionCache = new Map<string, any>()

function compactGeometryKey(geometry: any): string {
  const b = (() => { try { return turf.bbox(geometry) } catch { return null } })()
  const cs = (geometry as any).coordinates ?? (geometry as any).geometry?.coordinates
  const first = Array.isArray(cs) && cs.length > 0 ? JSON.stringify(cs[0]) : ''
  const last = Array.isArray(cs) && cs.length > 0 ? JSON.stringify(cs[cs.length - 1]) : ''
  const n = Array.isArray(cs) ? cs.length : 0
  return `bbox:${b ? b.join(',') : ''}:first:${first}:last:${last}:n:${n}`
}

function gisCacheKey(fnName: string, geometry: any, mcpi?: string): string {
  const geomKey = mcpi ? `mcpi:${mcpi}` : compactGeometryKey(geometry)
  return `${fnName}:${geomKey}`
}

async function withGisCache<T>(
  fnName: string,
  geometry: any,
  fetcher: () => Promise<T>,
  mcpi?: string
): Promise<T> {
  const key = gisCacheKey(fnName, geometry, mcpi)
  if (gisSessionCache.has(key)) {
    verboseLog(`[GisSessionCache] hit ${key}`)
    return gisSessionCache.get(key)
  }
  verboseLog(`[GisSessionCache] miss ${key}`)
  const result = await fetcher()
  gisSessionCache.set(key, result)
  return result
}

const COUNTY_BOUNDARY_URL = `${GIS_BASE_URL}/gis/rest/services/COL/pol_connect/MapServer/0`;
const ADDRESS_POINT_URL = `${GIS_BASE_URL}/gis/rest/services/COL/pol_connect/MapServer/1`;
const PARCEL_URL = `${GIS_BASE_URL}/gis/rest/services/COL/pol_connect/MapServer/3`;
const BUILDINGS_URL = `${GIS_BASE_URL}/gis/rest/services/COL/BaseMapLayers/MapServer/1`;
const STREET_CENTERLINE_URL = `${GIS_BASE_URL}/gis/rest/services/COL/StreetCenterline/MapServer/0`;
const PAVEMENT_URL = `${GIS_BASE_URL}/gis/rest/services/COL/BaseMapLayers/MapServer/3`;

/**
 * Check if a ring is clockwise using the shoelace formula
 * 
 * @param ring - Array of [longitude, latitude] coordinates
 * @returns true if clockwise, false if counterclockwise
 */
function isClockwise(ring: number[][]): boolean {
  if (ring.length < 3) return true
  
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]
    const next = ring[(i + 1) % ring.length]
    sum += (next[0] - current[0]) * (next[1] + current[1])
  }
  return sum > 0
}

/**
 * Ensure a ring is closed (first and last points match)
 * 
 * @param ring - Array of [longitude, latitude] coordinates
 * @returns Closed ring
 */
function ensureClosedRing(ring: number[][]): number[][] {
  if (ring.length === 0) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, first]
  }
  return ring
}

/**
 * Normalize ring orientation for ArcGIS
 * 
 * @param ring - Array of [longitude, latitude] coordinates
 * @param role - 'exterior' or 'hole'
 * @returns Ring with correct orientation
 */
function normalizeArcGISRing(ring: number[][], role: 'exterior' | 'hole'): number[][] {
  const closedRing = ensureClosedRing(ring)
  const shouldBeClockwise = role === 'exterior'
  const isRingClockwise = isClockwise(closedRing)
  
  if (isRingClockwise !== shouldBeClockwise) {
    // Reverse the ring (but keep it closed)
    const reversed = [...closedRing].reverse()
    return reversed
  }
  
  return closedRing
}

/**
 * Convert GeoJSON Polygon or MultiPolygon to ArcGIS REST polygon geometry format
 * 
 * @param geoJsonGeometry - GeoJSON Polygon or MultiPolygon geometry
 * @returns ArcGIS polygon geometry object with rings and spatial reference
 */
function geoJsonPolygonToArcGisGeometry(geoJsonGeometry: any): any {
  if (!geoJsonGeometry) {
    throw new Error('Invalid geometry: null or undefined')
  }

  const type = geoJsonGeometry.type
  const coordinates = geoJsonGeometry.coordinates

  let rings: number[][][]

  if (type === 'Polygon') {
    // GeoJSON Polygon: array of rings, first is exterior, rest are holes
    const exteriorRing = normalizeArcGISRing(coordinates[0], 'exterior')
    const holeRings = coordinates.slice(1).map((hole: number[][]) => normalizeArcGISRing(hole, 'hole'))
    rings = [exteriorRing, ...holeRings]
  } else if (type === 'MultiPolygon') {
    // GeoJSON MultiPolygon: array of Polygons
    rings = []
    coordinates.forEach((polygon: number[][][]) => {
      const exteriorRing = normalizeArcGISRing(polygon[0], 'exterior')
      const holeRings = polygon.slice(1).map((hole: number[][]) => normalizeArcGISRing(hole, 'hole'))
      rings.push(exteriorRing, ...holeRings)
    })
  } else {
    throw new Error(`Unsupported geometry type: ${type}`)
  }

  return {
    rings,
    spatialReference: { wkid: 4326 }
  }
}

/**
 * Centralized ArcGIS POST query helper (with geometry)
 * 
 * @param url - The ArcGIS service endpoint URL
 * @param parcelGeometry - GeoJSON Polygon or MultiPolygon geometry
 * @param additionalParams - Additional query parameters (e.g., distance, units)
 * @param signal - AbortSignal for request cancellation
 * @returns Promise resolving to GeoJSON features array
 */
export async function arcGISPostQuery(
  url: string,
  parcelGeometry: any,
  additionalParams: Record<string, string> = {},
  signal?: AbortSignal
): Promise<any[]> {
  const category = url.includes('BaseMapLayers/MapServer/1')
    ? 'buildings'
    : url.includes('BaseMapLayers/MapServer/3')
    ? 'pavement'
    : url.includes('StreetCenterline')
    ? 'roads'
    : url.includes('pol_connect/MapServer/0')
    ? 'countyBoundary'
    : url.includes('pol_connect/MapServer/3')
    ? 'parcel'
    : 'arcgis'
  const requestKey = `${category}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  networkCounter.start(category, requestKey)
  try {
    const arcgisGeometry = geoJsonPolygonToArcGisGeometry(parcelGeometry)

  const baseParams = {
    where: '1=1',
    geometry: JSON.stringify(arcgisGeometry),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '500'
  }

  const paramRecord: Record<string, string> = {
    ...baseParams,
    ...additionalParams
  }

  const params = new URLSearchParams(paramRecord)
  const requestUrl = url
  const bodyString = params.toString()

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: bodyString,
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('ArcGIS POST query failed:', {
      status: response.status,
      statusText: response.statusText,
      request: requestUrl,
      response: errorText
    })
    throw new Error(`ArcGIS query failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  // Check for ArcGIS error object
  if (data.error) {
    console.error('ArcGIS error in POST query:', data.error)
    throw new Error(`ArcGIS error: ${data.error.message || 'Unknown error'}`)
  }

    return (data.features || []) as any[]
  } finally {
    networkCounter.finish(category, requestKey)
  }
}

/**
 * Get ArcGIS layer metadata
 * 
 * @param url - The ArcGIS service layer URL
 * @returns Promise resolving to layer metadata
 */
export async function getLayerMetadata(url: string): Promise<any> {
  const response = await fetch(`${url}?f=json`)
  if (!response.ok) {
    throw new Error(`Failed to fetch layer metadata: ${response.statusText}`)
  }
  const data = await response.json()
  if (data.error) {
    throw new Error(`ArcGIS error: ${data.error.message || 'Unknown error'}`)
  }
  return data
}

/**
 * Centralized ArcGIS POST query helper (without geometry for attribute queries)
 * 
 * @param url - The ArcGIS service endpoint URL
 * @param queryParams - Query parameters (where, outFields, etc.)
 * @param signal - AbortSignal for request cancellation
 * @returns Promise resolving to GeoJSON features array
 */
async function arcGISAttributeQuery(
  url: string,
  queryParams: Record<string, string>,
  signal?: AbortSignal
): Promise<any[]> {
  const category = url.includes('pol_connect/MapServer/1')
    ? 'addresses'
    : url.includes('pol_connect/MapServer/3')
    ? 'parcel'
    : url.includes('StreetCenterline')
    ? 'roads'
    : 'arcgis-attribute'
  const requestKey = `${category}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  networkCounter.start(category, requestKey)
  try {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '500',
    ...queryParams
  })

  const requestUrl = url
  
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: params,
    signal
  })
  
  if (!response.ok) {
    const errorText = await response.text()
    console.error('ArcGIS attribute query failed:', {
      status: response.status,
      statusText: response.statusText,
      request: requestUrl,
      response: errorText
    })
    throw new Error(`ArcGIS query failed: ${response.status} ${response.statusText}`)
  }
  
  const data = await response.json()
  
  // Check for ArcGIS error object
  if (data.error) {
    console.error('ArcGIS error in attribute query:', data.error)
    throw new Error(`ArcGIS error: ${data.error.message || 'Unknown error'}`)
  }

    return (data.features || []) as any[]
  } finally {
    networkCounter.finish(category, requestKey)
  }
}

export interface ParcelData {
  properties: {
    OBJECTID: number;
    PA_MCPI: string;
    PA_GIS_ACRE: number;
    PA_LEGAL_ACRE: number;
    PA_SUBD_NAME: string;
    PA_PLAT_NUM?: string;
    PA_PLAT_LOT?: string;
    PA_TYPE?: string;
    [key: string]: any;
  };
  geometry: any;
}

export interface AddressData {
  FULL_ADDRESS: string;
  AD_MCPI: string;
  geometry: any;
}

export interface BuildingData {
  properties: {
    OBJECTID: number;
    BL_SOURCE: number;
    BL_UPD_DATE: string;
    BL_TYPE: number;
    SHAPE_Length: number;
    SHAPE_Area: number;
    BU_LOUD_ID: number;
    [key: string]: any;
  };
  geometry: any;
}

export interface RoadData {
  properties: {
    OBJECTID: number;
    CE_CHAIN_ID: number;
    CE_LOUD_ID: number;
    ST_CHAIN_ID: number;
    ST_DIR_PREF: string;
    ST_STR_NAME: string;
    ST_DIR_SUF: string;
    ST_STR_TYPE: string;
    CE_RTNO: string;
    CE_CFCC: string;
    ST_FULLNAME: string;
    SHAPE_Length: number;
    [key: string]: any;
  };
  geometry: any;
}

export interface PavementData {
  source: 'loudoun-gis'
  features: any[]
  parkingLotFeatureCount: number
  drivewayFeatureCount: number
  totalFeatureCount: number
  pavementCoverageAvailable: boolean
  fetchError?: string
}

export async function fetchCountyBoundary(): Promise<any> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });

  const response = await fetch(`${COUNTY_BOUNDARY_URL}/query?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch county boundary: ${response.statusText}`);
  }
  const data = await response.json();
  return data;
}

export async function fetchParcesInBounds(
  bounds: L.LatLngBounds,
  offset: number = 0
): Promise<{ features: any[]; exceededLimit: boolean }> {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,PA_MCPI,PA_GIS_ACRE,PA_LEGAL_ACRE,PA_SUBD_NAME,PA_PLAT_NUM,PA_PLAT_LOT,PA_TYPE',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '2000',
    resultOffset: offset.toString()
  });

  const response = await fetch(`${PARCEL_URL}/query?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch parcels: ${response.statusText}`);
  }
  const data = await response.json();
  
  return {
    features: data.features || [],
    exceededLimit: data.exceededTransferLimit || false
  };
}

export async function fetchParcelByMCPI(mcpi: string, signal?: AbortSignal): Promise<ParcelData | null> {
  return withGisCache('parcelByMCPI', null, async () => {
    networkCounter.count('parcel')
    const features = await arcGISAttributeQuery(`${PARCEL_URL}/query`, {
      where: `PA_MCPI='${mcpi}'`,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    }, signal)

    if (features && features.length > 0) {
      return features[0] as ParcelData
    }
    return null
  }, mcpi) as Promise<ParcelData | null>
}

// Fetch addresses connected to a parcel MCPI
export async function fetchAddressesByMCPI(mcpi: string, signal?: AbortSignal): Promise<AddressData[]> {
  return withGisCache('addressesByMCPI', null, async () => {
    networkCounter.count('parcel')
    const features = await arcGISAttributeQuery(`${ADDRESS_POINT_URL}/query`, {
      where: `AD_MCPI='${mcpi}'`,
      outFields: 'FULL_ADDRESS,AD_MCPI',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    }, signal)

    return (features || []) as AddressData[]
  }, mcpi) as Promise<AddressData[]>
}

// Normalize search input
function normalizeSearchInput(input: string): string {
  return input
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?"()]/g, '')
    .replace(/'/g, "''");
}

// Split search into tokens
function tokenizeSearch(input: string): string[] {
  const normalized = normalizeSearchInput(input);
  return normalized.split(' ').filter(token => token.length > 0);
}

// Classify search input type
function classifySearch(input: string): 'number-only' | 'address' | 'mcpi' {
  const normalized = normalizeSearchInput(input);
  
  // Check if it's a number-only input (e.g., "20851")
  if (/^\d+$/.test(normalized)) {
    return 'number-only';
  }
  
  // Check if it starts with a number followed by text (e.g., "20851 Co")
  if (/^\d+\s/.test(normalized)) {
    return 'address';
  }
  
  // Check if it looks like an MCPI (usually numeric but could be alphanumeric)
  if (/^\d+$/.test(normalized) || /^[A-Z0-9]+$/.test(normalized)) {
    return 'mcpi';
  }
  
  return 'address';
}

// Build WHERE clause based on search classification
function buildSearchWhereClause(input: string): string {
  const normalized = normalizeSearchInput(input);
  const classification = classifySearch(input);
  
  switch (classification) {
    case 'number-only':
      // Query AD_ADDRESS field directly for number-only input
      const whereClause = `AD_ADDRESS = ${normalized}`;
      return whereClause;
      
    case 'address':
      // Extract street number and address tokens
      const tokens = tokenizeSearch(input);
      if (tokens.length === 0) return '1=1';
      
      const streetNumber = tokens[0];
      const addressTokens = tokens.slice(1);
      
      if (/^\d+$/.test(streetNumber) && addressTokens.length > 0) {
        // Address with street number and text: AD_ADDRESS = 20851 AND UPPER(FULL_ADDRESS) LIKE '%CO%'
        const likeClauses = addressTokens.map(token => `UPPER(FULL_ADDRESS) LIKE '%${token}%'`);
        const whereClause = `AD_ADDRESS = ${streetNumber} AND ${likeClauses.join(' AND ')}`;
        return whereClause;
      } else {
        // Fallback to token-based LIKE query
        const likeClauses = tokens.map(token => `UPPER(FULL_ADDRESS) LIKE '%${token}%'`);
        const whereClause = likeClauses.join(' AND ');
        return whereClause;
      }
      
    case 'mcpi':
      // Query parcel layer's PA_MCPI field
      return `PA_MCPI = '${normalized}'`;
      
    default:
      return '1=1';
  }
}

export async function searchAddresses(
  query: string,
  signal?: AbortSignal
): Promise<AddressData[]> {
  if (query.length < 3) return [];
  
  const classification = classifySearch(query);
  
  // If it's MCPI-like, query the parcel layer instead
  if (classification === 'mcpi') {
    const parcel = await fetchParcelByMCPI(query, signal);
    if (parcel) {
      // Return as address-like result for consistency
      return [{
        FULL_ADDRESS: `MCPI: ${query}`,
        AD_MCPI: query,
        geometry: parcel.geometry
      } as AddressData];
    }
    return [];
  }
  
  const whereClause = buildSearchWhereClause(query);
  
  const features = await arcGISAttributeQuery(`${ADDRESS_POINT_URL}/query`, {
    where: whereClause,
    outFields: 'FULL_ADDRESS,AD_MCPI',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '10'
  }, signal);
  
  const results = (features || []) as AddressData[];
  
  // Rank results: exact matches first, then starts with, then others
  const normalizedQuery = normalizeSearchInput(query);
  const ranked = results.sort((a, b) => {
    const aAddress = normalizeSearchInput(a.FULL_ADDRESS);
    const bAddress = normalizeSearchInput(b.FULL_ADDRESS);
    
    // Exact match
    const aExact = aAddress === normalizedQuery;
    const bExact = bAddress === normalizedQuery;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    
    // Starts with
    const aStarts = aAddress.startsWith(normalizedQuery);
    const bStarts = bAddress.startsWith(normalizedQuery);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    
    return 0;
  });
  
  return ranked;
}

// Fetch parcel by spatial query (fallback when MCPI fails)
export async function fetchParcelByGeometry(
  longitude: number,
  latitude: number,
  signal?: AbortSignal
): Promise<ParcelData | null> {
  const features = await arcGISAttributeQuery(`${PARCEL_URL}/query`, {
    where: '1=1',
    geometry: `${longitude},${latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  }, signal);
  
  if (features && features.length > 0) {
    return features[0] as ParcelData;
  }
  return null;
}

// Fetch buildings intersecting a parcel geometry
export async function fetchBuildingsByParcel(
  parcelGeometry: any,
  signal?: AbortSignal
): Promise<BuildingData[]> {
  return withGisCache('buildings', parcelGeometry, async () => {
    networkCounter.count('buildings')
    return (await arcGISPostQuery(`${BUILDINGS_URL}/query`, parcelGeometry, {}, signal)) as BuildingData[]
  })
}

// Fetch intersecting streets (no distance buffer)
export async function fetchIntersectingStreets(
  parcelGeometry: any,
  signal?: AbortSignal
): Promise<RoadData[]> {
  return withGisCache('intersectingStreets', parcelGeometry, async () => {
    networkCounter.count('roads')
    return (await arcGISPostQuery(`${STREET_CENTERLINE_URL}/query`, parcelGeometry, {}, signal)) as RoadData[]
  })
}

// Fetch nearby streets within 100 feet
export async function fetchNearbyStreets(
  parcelGeometry: any,
  signal?: AbortSignal
): Promise<RoadData[]> {
  return withGisCache('nearbyStreets', parcelGeometry, async () => {
    networkCounter.count('roads')
    return (await arcGISPostQuery(`${STREET_CENTERLINE_URL}/query`, parcelGeometry, {
      distance: '100',
      units: 'esriSRUnit_Foot'
    }, signal)) as RoadData[]
  })
}

export async function fetchRoadPrecedentStreets(
  mcpi: string,
  parcelGeometry: any,
  signal?: AbortSignal
): Promise<RoadData[]> {
  const narrow = await withGisCache('roadPrecedentStreets', parcelGeometry, async () => {
    networkCounter.count('roads')
    return (await arcGISPostQuery(`${STREET_CENTERLINE_URL}/query`, parcelGeometry, {
      distance: '3960',
      units: 'esriSRUnit_Foot'
    }, signal)) as RoadData[]
  }, mcpi)
  const usable = narrow.filter(s => !isLikelyHighwayPrecedent(s))
  if (usable.length >= 4) return narrow
  const expanded = await withGisCache('roadPrecedentStreetsExpanded', parcelGeometry, async () => {
    networkCounter.count('roads')
    return (await arcGISPostQuery(`${STREET_CENTERLINE_URL}/query`, parcelGeometry, {
      distance: '7920',
      units: 'esriSRUnit_Foot'
    }, signal)) as RoadData[]
  }, mcpi)
  return expanded
}

function isLikelyHighwayPrecedent(data: RoadData): boolean {
  const cfcc = data.properties?.CE_CFCC
  const name = (data.properties?.ST_FULLNAME ?? '').toUpperCase()
  if (typeof cfcc === 'string' && /^[AI]/.test(cfcc)) return true
  if (['INTERSTATE', 'FWY', 'FREEWAY', 'RAMP', 'EXIT'].some(s => name.includes(s))) return true
  return false
}

// Loudoun County water / hydrology layers.
// WaterBodies (31) and WetlandsModel (30) are in the same pol_connect service used
// for parcels, buildings, and roads. Base Map Drains (7) is a line feature class
// used here as a source of stream/flowline geometry for conceptual avoidance.
const WATER_BODIES_URL = `${GIS_BASE_URL}/gis/rest/services/COL/pol_connect/MapServer/31`
const WETLANDS_MODEL_URL = `${GIS_BASE_URL}/gis/rest/services/COL/pol_connect/MapServer/30`
const BASE_MAP_DRAINS_URL = `${GIS_BASE_URL}/gis/rest/services/COL_cache/BaseLayers/MapServer/7`

export interface WaterBodyData {
  properties: { OBJECTID: number; WA_TYPE?: number; WA_WELEV?: number; Shape_Area?: number; [key: string]: any }
  geometry: any
}

export interface WetlandData {
  properties: { OBJECTID: number; WE_TYPE?: string; SHAPE_Area?: number; [key: string]: any }
  geometry: any
}

export interface StreamDrainData {
  properties: { OBJECTID: number; DR_TYPE?: number; DR_CLASS?: string; [key: string]: any }
  geometry: any
}

export interface HydrologyData {
  source: 'loudoun-gis'
  waterBodyFeatures: WaterBodyData[]
  wetlandFeatures: WetlandData[]
  streamDrainFeatures: StreamDrainData[]
  hydrologyCoverageAvailable: boolean
  fetchError?: string
  diagnostics?: HydrologyDiagnostics
}

export interface HydrologyDiagnostics {
  water?: SourceDiagnostic
  wetlands?: SourceDiagnostic
  streams?: SourceDiagnostic
}

export interface SourceDiagnostic {
  requestUrl: string
  requestMethod: string
  requestContentType: string
  requestFields: Record<string, string>
  geometrySent: string
  httpStatus: number
  responseType: string
  arcgisError?: any
  rawFeatureCount: number
}

function isStreamDrainFeature(f: any): boolean {
  // Base Map Drains type codes 2 and 9 are documented as "Single line stream network".
  const t = f?.properties?.DR_TYPE
  return t === 2 || t === 9
}

function summarizeGeometryForLog(geometry: any) {
  if (!geometry || !geometry.coordinates) return { type: geometry?.type || 'null', bbox: null, sample: null }

  let sample: number[][] | null = null
  if (geometry.type === 'Polygon') {
    sample = geometry.coordinates[0]?.slice(0, 3) || null
  } else if (geometry.type === 'MultiPolygon') {
    sample = geometry.coordinates[0]?.[0]?.slice(0, 3) || null
  }

  // Compute simple bbox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const update = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) {
      for (const [x, y] of ring) update(x, y)
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        for (const [x, y] of ring) update(x, y)
      }
    }
  }

  return {
    type: geometry.type,
    bbox: [minX, minY, maxX, maxY],
    sample,
    spatialReferenceUsed: 4326
  }
}

function buildSourceDiagnostic(
  requestUrl: string,
  arcgisGeometry: any,
  params: URLSearchParams,
  response: Response,
  data: any,
  featureCount: number
): SourceDiagnostic {
  return {
    requestUrl,
    requestMethod: 'POST',
    requestContentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    requestFields: {
      endpoint: requestUrl,
      geometryType: params.get('geometryType') || '',
      inSR: params.get('inSR') || '',
      outSR: params.get('outSR') || '',
      spatialRel: params.get('spatialRel') || '',
      where: params.get('where') || '',
      outFields: params.get('outFields') || '',
      returnGeometry: params.get('returnGeometry') || '',
      f: params.get('f') || ''
    },
    geometrySent: JSON.stringify(arcgisGeometry).slice(0, 2000),
    httpStatus: response.status,
    responseType: data?.type || 'FeatureCollection',
    arcgisError: data?.error,
    rawFeatureCount: featureCount
  }
}

async function queryHydrologySource(
  mcpi: string,
  sourceName: 'water' | 'wetlands' | 'streams',
  url: string,
  parcelGeometry: any,
  additionalParams: Record<string, string> = {},
  signal?: AbortSignal
): Promise<{ features: any[]; diagnostic?: SourceDiagnostic; error?: string }> {
  const arcgisGeometry = geoJsonPolygonToArcGisGeometry(parcelGeometry)

  const baseParams = {
    where: '1=1',
    geometry: JSON.stringify(arcgisGeometry),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '500'
  }

  const paramRecord = { ...baseParams, ...additionalParams }
  const params = new URLSearchParams(paramRecord)
  const requestUrl = url

  console.log('[HydrologyFetchStart]', { mcpi, source: sourceName, requestUrl, geometryType: parcelGeometry?.type })

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: params.toString(),
      signal
    })

    const responseText = await response.text()
    let data: any
    let parseError: string | undefined

    try {
      data = JSON.parse(responseText)
    } catch (e: any) {
      parseError = `Invalid JSON: ${e.message}`
      data = { raw: responseText.slice(0, 500) }
    }

    const httpStatus = response.status
    const rawFeatureCount = Array.isArray(data?.features) ? data.features.length : 0

    const diagnostic = buildSourceDiagnostic(requestUrl, arcgisGeometry, params, response, data, rawFeatureCount)
    console.log('[HydrologySourceResult]', { source: sourceName, ...diagnostic })

    if (!response.ok) {
      throw new Error(`ArcGIS query failed: ${httpStatus} ${response.statusText}`)
    }
    if (parseError) {
      throw new Error(parseError)
    }
    if (data?.error) {
      throw new Error(`ArcGIS error: ${data.error.message || 'Unknown error'}`)
    }

    return { features: data.features || [], diagnostic }
  } catch (err: any) {
    console.error('[HydrologyFailure]', {
      mcpi,
      source: sourceName,
      stage: 'query',
      message: err?.message,
      stack: err?.stack?.slice(0, 1000),
      originalError: err
    })
    return { features: [], error: String(err?.message || err) }
  }
}

export async function fetchHydrologyObstacles(
  parcelGeometry: any,
  mcpi: string = '',
  signal?: AbortSignal
): Promise<HydrologyData> {
  return withGisCache('hydrology', parcelGeometry, async () => {
    networkCounter.count('hydrology')
    verboseLog('[HydrologyFetcherEntered]', { mcpi, hasParcelGeometry: !!parcelGeometry, parcelGeometryType: parcelGeometry?.type })

    const empty: HydrologyData = {
      source: 'loudoun-gis',
      waterBodyFeatures: [],
      wetlandFeatures: [],
      streamDrainFeatures: [],
      hydrologyCoverageAvailable: false
    }

    verboseLog('[HydrologyParcelInput]', { mcpi, ...summarizeGeometryForLog(parcelGeometry) })

    if (!parcelGeometry) {
      console.error('[HydrologyFailure]', { mcpi, source: 'all', stage: 'input', message: 'No parcel geometry provided' })
      return { ...empty, fetchError: 'No parcel geometry provided' }
    }

    const waterResult = await queryHydrologySource(mcpi, 'water', `${WATER_BODIES_URL}/query`, parcelGeometry, {}, signal)
    const wetlandResult = await queryHydrologySource(mcpi, 'wetlands', `${WETLANDS_MODEL_URL}/query`, parcelGeometry, {}, signal)
    const drainResult = await queryHydrologySource(mcpi, 'streams', `${BASE_MAP_DRAINS_URL}/query`, parcelGeometry, {}, signal)

    const waterBodyFeatures = waterResult.features || []
    const wetlandFeatures = wetlandResult.features || []
    const streamDrainFeatures = (drainResult.features || []).filter(isStreamDrainFeature)

    const errors: string[] = []
    if (waterResult.error) errors.push(`water: ${waterResult.error}`)
    if (wetlandResult.error) errors.push(`wetlands: ${wetlandResult.error}`)
    if (drainResult.error) errors.push(`streams: ${drainResult.error}`)

    const fetchError = errors.length > 0 ? errors.join('; ') : undefined
    const hydrologyCoverageAvailable = errors.length === 0

    const result: HydrologyData = {
      source: 'loudoun-gis',
      waterBodyFeatures,
      wetlandFeatures,
      streamDrainFeatures,
      hydrologyCoverageAvailable,
      fetchError,
      diagnostics: {
        water: waterResult.diagnostic,
        wetlands: wetlandResult.diagnostic,
        streams: drainResult.diagnostic
      }
    }

    console.log('[HydrologyFetchComplete]', {
      mcpi,
      waterRaw: waterBodyFeatures.length,
      wetlandsRaw: wetlandFeatures.length,
      streamsRaw: drainResult.features?.length || 0,
      streamsFiltered: streamDrainFeatures.length,
      hydrologyCoverageAvailable,
      fetchError
    })

    return result
  }, mcpi) as Promise<HydrologyData>
}

function isPavementFeature(f: any): boolean {
  const t = f?.properties?.RD_TYPE
  return t === 2 || t === 3
}

export async function fetchExistingPavementSurfaces(
  parcelGeometry: any,
  mcpi: string = '',
  signal?: AbortSignal
): Promise<PavementData> {
  return withGisCache('pavement', parcelGeometry, async () => {
    networkCounter.count('pavement')
    verboseLog('[PavementFetcherEntered]', { mcpi, hasParcelGeometry: !!parcelGeometry, parcelGeometryType: parcelGeometry?.type })

    const t0 = performance.now()

    const empty: PavementData = {
      source: 'loudoun-gis',
      features: [],
      parkingLotFeatureCount: 0,
      drivewayFeatureCount: 0,
      totalFeatureCount: 0,
      pavementCoverageAvailable: false
    }

    if (!parcelGeometry) {
      console.error('[PavementFailure]', { mcpi, stage: 'input', message: 'No parcel geometry provided' })
      return { ...empty, fetchError: 'No parcel geometry provided' }
    }

    console.log('[PavementParcelInput]', { mcpi, ...summarizeGeometryForLog(parcelGeometry) })

    try {
      const arcgisGeometry = geoJsonPolygonToArcGisGeometry(parcelGeometry)
      const rawFeatures = await arcGISPostQuery(`${PAVEMENT_URL}/query`, parcelGeometry, {
        where: 'RD_TYPE IN (2,3)',
        resultRecordCount: '500'
      }, signal)

      const features = (rawFeatures || []).filter(isPavementFeature)
      const parkingLotFeatureCount = features.filter((f: any) => f.properties?.RD_TYPE === 2).length
      const drivewayFeatureCount = features.filter((f: any) => f.properties?.RD_TYPE === 3).length
      const totalFeatureCount = features.length
      const fetchMs = performance.now() - t0

      if (import.meta.env.DEV) {
        const requestBodyLength = JSON.stringify(arcgisGeometry).length
        console.log('[PavementFetchDiagnostic]', {
          mcpi,
          url: `${PAVEMENT_URL}/query`,
          resultRecordCount: 500,
          spatialRel: 'esriSpatialRelIntersects',
          outFields: '*',
          requestGeometryRings: (arcgisGeometry as any)?.rings?.length ?? 0,
          requestGeometryPoints: (arcgisGeometry as any)?.rings?.reduce((sum: number, ring: number[][]) => sum + ring.length, 0) ?? 0,
          requestBodyLength,
          rawFeatureCount: rawFeatures.length,
          filteredFeatureCount: features.length,
          parkingLotFeatureCount,
          drivewayFeatureCount,
          fetchMs: Math.round(fetchMs),
          sequentialWithOtherQueries: 'unknown'
        })
      }

      console.log('[PavementFetchSummary]', {
        mcpi,
        source: 'loudoun-gis',
        coverageAvailable: true,
        rawFeatureCount: rawFeatures.length,
        parkingLotFeatureCount,
        drivewayFeatureCount,
        fetchError: undefined
      })

      return {
        source: 'loudoun-gis',
        features,
        parkingLotFeatureCount,
        drivewayFeatureCount,
        totalFeatureCount,
        pavementCoverageAvailable: true
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError'
      console.error('[PavementFailure]', {
        mcpi,
        stage: 'query',
        isAbort,
        message: err?.message,
        stack: err?.stack?.slice(0, 1000),
        originalError: err
      })
      return { ...empty, fetchError: isAbort ? 'Analysis aborted' : String(err?.message || err) }
    }
  }, mcpi) as Promise<PavementData>
}
