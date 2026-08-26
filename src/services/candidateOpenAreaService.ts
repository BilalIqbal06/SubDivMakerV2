import * as turf from '@turf/turf'
import {
  CandidateOpenAreaResult,
  type HydrologyConstraintClass,
  type HydrologyConstraintResult,
  type ClassifiedHydrologyFeature
} from '../types/parameters'
import { HydrologyData, PavementData } from './gisService'

// Road corridor configuration
export const CANDIDATE_OPEN_AREA_ROAD_HALF_WIDTH_FEET = 25

// Geometry tolerance for area conservation check
export const AREA_CONSERVATION_TOLERANCE_PERCENT = 0.01 // 1%
export const AREA_CONSERVATION_TOLERANCE_MIN_SQ_FT = 250

// Small artifact removal threshold (very small numerical artifacts)
export const ARTIFACT_THRESHOLD_SQ_FT = 1

export interface CalculateCandidateOpenAreaOptions {
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  parcelGisAcreage: number | null
  mcpi: string
  buildingFeatures: any[]
  streetFeatures: any[]
  hydrologyFeatures?: HydrologyData | null
  pavementFeatures?: PavementData | null
  signal?: AbortSignal
  analysisRunId?: number
}

// ============================================================================
// CENTRALIZED TURF WRAPPERS - Turf v7 API
// ============================================================================

interface TurfOperationResult<T> {
  success: boolean
  result: T | null
  error: string | null
}

/**
 * Union polygon features using Turf v7 API.
 * Accepts a FeatureCollection of Polygon/MultiPolygon features.
 * Returns the union as a single Feature or null if union fails.
 */
function unionPolygonFeatures(features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[]): TurfOperationResult<GeoJSON.Feature<GeoJSON.Geometry>> {
  if (features.length === 0) {
    return { success: false, result: null, error: 'No features to union' }
  }

  if (features.length === 1) {
    return { success: true, result: features[0], error: null }
  }

  try {
    // Turf v7 union accepts a FeatureCollection
    const featureCollection = turf.featureCollection(features)
    const unioned = turf.union(featureCollection) as GeoJSON.Feature<GeoJSON.Geometry>
    return { success: true, result: unioned, error: null }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, result: null, error: `Union failed: ${errorMessage}` }
  }
}

/**
 * Intersect two polygon features using Turf v7 API.
 * Accepts two features and returns their intersection.
 */
function intersectPolygonFeatures(
  featureA: GeoJSON.Feature<GeoJSON.Geometry>,
  featureB: GeoJSON.Feature<GeoJSON.Geometry>
): TurfOperationResult<GeoJSON.Feature<GeoJSON.Geometry>> {
  try {
    // Turf v7 intersect accepts a FeatureCollection
    const featureCollection = turf.featureCollection([featureA, featureB]) as any
    const intersected = turf.intersect(featureCollection) as GeoJSON.Feature<GeoJSON.Geometry> | null
    return { success: true, result: intersected, error: null }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, result: null, error: `Intersect failed: ${errorMessage}` }
  }
}

/**
 * Subtract exclusions from subject using Turf v7 API.
 * Accepts subject and exclusions as features, returns the difference.
 */
function differencePolygonFeatures(
  subject: GeoJSON.Feature<GeoJSON.Geometry>,
  exclusions: GeoJSON.Feature<GeoJSON.Geometry>
): TurfOperationResult<GeoJSON.Feature<GeoJSON.Geometry>> {
  try {
    // Turf v7 difference accepts a FeatureCollection
    const featureCollection = turf.featureCollection([subject, exclusions]) as any
    const differed = turf.difference(featureCollection) as GeoJSON.Feature<GeoJSON.Geometry> | null
    return { success: true, result: differed, error: null }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, result: null, error: `Difference failed: ${errorMessage}` }
  }
}

/**
 * Buffer a line feature by a distance in feet.
 */
function bufferLineFeature(line: GeoJSON.Feature<GeoJSON.LineString>, distanceFeet: number): TurfOperationResult<GeoJSON.Feature<GeoJSON.Polygon>> {
  try {
    const distanceMeters = distanceFeet * 0.3048
    const buffered = turf.buffer(line, distanceMeters, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Polygon>
    return { success: true, result: buffered, error: null }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, result: null, error: `Buffer failed: ${errorMessage}` }
  }
}

// ============================================================================
// GEOMETRY NORMALIZATION
// ============================================================================

interface NormalizedPolygonFeature {
  feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  valid: boolean
  reason: string | null
}

interface NormalizedLineStringFeature {
  feature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>
  valid: boolean
  reason: string | null
}

function normalizePolygonFeature(feature: any): NormalizedPolygonFeature {
  if (!feature || !feature.geometry) {
    return { feature: null as any, valid: false, reason: 'Missing geometry' }
  }

  const geom = feature.geometry

  // Check geometry type
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    return { feature: null as any, valid: false, reason: `Invalid geometry type: ${geom.type}` }
  }

  // Check coordinates exist
  if (!geom.coordinates || !Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
    return { feature: null as any, valid: false, reason: 'Missing or empty coordinates' }
  }

  // Validate coordinates contain finite values
  const hasInvalidCoords = (coords: any[]): boolean => {
    for (const coord of coords) {
      if (Array.isArray(coord)) {
        if (hasInvalidCoords(coord)) return true
      } else if (typeof coord === 'number') {
        if (!isFinite(coord)) return true
      }
    }
    return false
  }

  if (hasInvalidCoords(geom.coordinates)) {
    return { feature: null as any, valid: false, reason: 'Coordinates contain non-finite values' }
  }

  // Validate polygon rings have at least 4 coordinates (closed ring)
  const validateRing = (ring: number[][]): boolean => {
    if (!Array.isArray(ring) || ring.length < 4) return false
    // Check if ring is closed (first and last coordinates match)
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (!first || !last) return false
    return Math.abs(first[0] - last[0]) < 1e-10 && Math.abs(first[1] - last[1]) < 1e-10
  }

  const validatePolygon = (coords: number[][][]): boolean => {
    if (!Array.isArray(coords) || coords.length === 0) return false
    // Exterior ring must be valid
    if (!validateRing(coords[0])) return false
    // Interior rings (holes) must be valid if present
    for (let i = 1; i < coords.length; i++) {
      if (!validateRing(coords[i])) return false
    }
    return true
  }

  if (geom.type === 'Polygon') {
    if (!validatePolygon(geom.coordinates)) {
      return { feature: null as any, valid: false, reason: 'Invalid polygon ring structure' }
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (!validatePolygon(poly)) {
        return { feature: null as any, valid: false, reason: 'Invalid multipolygon ring structure' }
      }
    }
  }

  return { feature, valid: true, reason: null }
}

function normalizeLineStringFeature(feature: any): NormalizedLineStringFeature {
  if (!feature || !feature.geometry) {
    return { feature: null as any, valid: false, reason: 'Missing geometry' }
  }

  const geom = feature.geometry

  if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') {
    return { feature: null as any, valid: false, reason: `Invalid geometry type: ${geom.type}` }
  }

  if (!geom.coordinates || !Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
    return { feature: null as any, valid: false, reason: 'Missing or empty coordinates' }
  }

  // Validate coordinates contain finite values
  const hasInvalidCoords = (coords: any[]): boolean => {
    for (const coord of coords) {
      if (Array.isArray(coord)) {
        if (hasInvalidCoords(coord)) return true
      } else if (typeof coord === 'number') {
        if (!isFinite(coord)) return true
      }
    }
    return false
  }

  if (hasInvalidCoords(geom.coordinates)) {
    return { feature: null as any, valid: false, reason: 'Coordinates contain non-finite values' }
  }

  return { feature, valid: true, reason: null }
}

export async function calculateCandidateOpenArea(
  input: CalculateCandidateOpenAreaOptions
): Promise<CandidateOpenAreaResult> {
  const {
    parcelGeometry,
    parcelGisAcreage,
    mcpi,
    buildingFeatures,
    streetFeatures,
    hydrologyFeatures,
    pavementFeatures,
    signal,
    analysisRunId = 0
  } = input

  const warnings: string[] = []
  const errors: string[] = []

  // Check for abort
  if (signal?.aborted) {
    throw new Error('Analysis aborted')
  }

  // Calculate parcel area
  let parcelAreaSqFt = 0
  try {
    parcelAreaSqFt = turf.area(parcelGeometry) * 10.7639 // Convert m² to sq ft
  } catch (e) {
    errors.push('Failed to calculate parcel area')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  const parcelAreaAcres = parcelAreaSqFt / 43560

  // Process building footprints
  const buildingResult = processBuildingFootprints(
    parcelGeometry,
    buildingFeatures,
    signal
  )
  warnings.push(...buildingResult.warnings)
  errors.push(...buildingResult.errors)

  // Process road corridors
  const roadResult = processRoadCorridors(
    parcelGeometry,
    streetFeatures,
    signal
  )
  warnings.push(...roadResult.warnings)
  errors.push(...roadResult.errors)

  // Process hydrology / water bodies / wetlands / conceptual stream avoidance
  const hydrologyResult = processHydrologyObstacles(
    parcelGeometry,
    hydrologyFeatures,
    mcpi,
    signal
  )
  warnings.push(...hydrologyResult.warnings)
  errors.push(...hydrologyResult.errors)

  // Process existing parking lot / driveway pavement
  const pavementResult = processPavementSurfaces(
    parcelGeometry,
    pavementFeatures,
    mcpi,
    signal
  )
  if (pavementResult.coverageError) {
    errors.push(pavementResult.coverageError)
  }
  warnings.push(...pavementResult.warnings)
  errors.push(...pavementResult.errors)

  // Fail if core operations failed
  if (errors.length > 0) {
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  // Union locked features
  const lockedUnionResult = unionLockedFeatures(
    buildingResult.clippedGeometry,
    roadResult.clippedGeometry,
    hydrologyResult.clippedGeometry,
    pavementResult.clippedGeometry,
    signal
  )
  errors.push(...lockedUnionResult.errors)

  // Fail if locked-feature union failed
  if (lockedUnionResult.errors.length > 0) {
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  // Calculate locked area
  const totalLockedAreaSqFt = lockedUnionResult.area
  const totalLockedAreaAcres = totalLockedAreaSqFt / 43560

  // Calculate building/road overlap
  const overlapAreaSqFt = calculateOverlap(
    buildingResult.clippedGeometry,
    roadResult.clippedGeometry
  )

  // Subtract locked features from parcel
  const candidateResult = subtractLockedFeatures(
    parcelGeometry,
    lockedUnionResult.geometry,
    signal
  )
  errors.push(...candidateResult.errors)

  // Fail if difference failed
  if (candidateResult.errors.length > 0) {
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  // Calculate candidate area
  const candidateAreaSqFt = candidateResult.area
  const candidateAreaAcres = candidateAreaSqFt / 43560
  const candidatePercent = parcelAreaSqFt > 0 
    ? (candidateAreaSqFt / parcelAreaSqFt) * 100 
    : 0

  // Validation rules to prevent false success
  if (!isFinite(parcelAreaSqFt) || parcelAreaSqFt <= 0) {
    errors.push('Parcel area is invalid')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (!isFinite(buildingResult.area) || buildingResult.area < 0) {
    errors.push('Building area is invalid')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (!isFinite(roadResult.area) || roadResult.area < 0) {
    errors.push('Road area is invalid')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (!isFinite(totalLockedAreaSqFt) || totalLockedAreaSqFt < 0) {
    errors.push('Total locked area is invalid')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (!isFinite(candidateAreaSqFt) || candidateAreaSqFt < 0) {
    errors.push('Candidate area is invalid')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (candidateAreaSqFt > parcelAreaSqFt + 1000) { // Allow small tolerance
    errors.push('Candidate area exceeds parcel area')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  if (candidatePercent < 0 || candidatePercent > 100) {
    errors.push('Candidate percentage is out of valid range')
    return createFailedResult(mcpi, parcelGisAcreage, errors, analysisRunId)
  }

  // Zero-exclusion warnings for loaded layers that do not actually intersect the parcel.
  // This is a valid result: a loaded street/building footprint outside the parcel
  // should not abort the entire Candidate Open Area computation.
  if (buildingFeatures.length > 0 && buildingResult.area === 0) {
    warnings.push('Buildings loaded but building exclusion area is zero (footprints may be outside the parcel)')
  }

  if (streetFeatures.length > 0 && roadResult.area === 0) {
    warnings.push('Street segments loaded but road corridor exclusion area is zero (streets may not fall within the parcel)')
  }

  // Analyze components
  const componentAnalysis = analyzeComponents(candidateResult.geometry)

  // Area conservation check
  const conservationDifferenceSqFt = 
    parcelAreaSqFt - (candidateAreaSqFt + totalLockedAreaSqFt)
  const tolerance = Math.max(
    parcelAreaSqFt * AREA_CONSERVATION_TOLERANCE_PERCENT,
    AREA_CONSERVATION_TOLERANCE_MIN_SQ_FT
  )
  const conservationWithinTolerance = Math.abs(conservationDifferenceSqFt) <= tolerance

  // Determine status
  let status: CandidateOpenAreaResult['status'] = 'loaded'
  if (candidateAreaSqFt < ARTIFACT_THRESHOLD_SQ_FT) {
    status = 'empty'
  } else if (!conservationWithinTolerance || warnings.length > 0) {
    status = 'warning'
  }

  // Compare with GIS acreage
  if (parcelGisAcreage) {
    const gisDifference = Math.abs(parcelAreaAcres - parcelGisAcreage)
    const gisDifferencePercent = (gisDifference / parcelGisAcreage) * 100
    if (gisDifferencePercent > 5) {
      warnings.push(
        `Calculated parcel area (${parcelAreaAcres.toFixed(2)} acres) differs from GIS acreage (${parcelGisAcreage.toFixed(2)} acres) by ${gisDifferencePercent.toFixed(1)}%`
      )
    }
  }

  logHydrologySummary(hydrologyResult, mcpi)
  logPavementSummary(pavementResult, mcpi)

  return {
    mcpi,
    analysisRunId,
    status,
    parcelAreaSqFt,
    parcelAreaAcres,
    gisAcreage: parcelGisAcreage,
    buildingAreaSqFt: buildingResult.area,
    buildingAreaAcres: buildingResult.area / 43560,
    roadAreaSqFt: roadResult.area,
    roadAreaAcres: roadResult.area / 43560,
    buildingRoadOverlapSqFt: overlapAreaSqFt,
    totalLockedAreaSqFt,
    totalLockedAreaAcres,
    candidateAreaSqFt,
    candidateAreaAcres,
    candidatePercent,
    componentCount: componentAnalysis.count,
    largestComponentSqFt: componentAnalysis.largest,
    largestComponentAcres: componentAnalysis.largest / 43560,
    smallestComponentSqFt: componentAnalysis.smallest,
    geometryType: componentAnalysis.type,
    totalPointCount: componentAnalysis.pointCount,
    roadHalfWidthFeet: CANDIDATE_OPEN_AREA_ROAD_HALF_WIDTH_FEET,
    conservationDifferenceSqFt,
    conservationWithinTolerance,
    warnings,
    errors,
    calculatedAt: new Date().toISOString(),
    candidateGeometry: candidateResult.geometry || undefined,
    buildingUnionGeometry: buildingResult.clippedGeometry || undefined,
    roadCorridorGeometry: roadResult.clippedGeometry || undefined,
    hydrologyGeometry: hydrologyResult.clippedGeometry || undefined,
    hydrologyConstraintResult: hydrologyResult.constraintResult,
    hydrologyAreaSqFt: hydrologyResult.area,
    hydrologyAreaAcres: hydrologyResult.area / 43560,
    hydrologyCoverageAvailable: hydrologyResult.hydrologyCoverageAvailable,
    waterFeatureCount: hydrologyResult.waterFeatureCount,
    wetlandFeatureCount: hydrologyResult.wetlandFeatureCount,
    streamFeatureCount: hydrologyResult.streamDrainCount,
    pavementGeometry: pavementResult.clippedGeometry || undefined,
    pavementAreaSqFt: pavementResult.area,
    pavementAreaAcres: pavementResult.area / 43560,
    parkingLotFeatureCount: pavementResult.parkingLotFeatureCount,
    drivewayFeatureCount: pavementResult.drivewayFeatureCount,
    pavementFeatureCount: pavementResult.pavementFeatureCount,
    pavementCoverageAvailable: pavementResult.pavementCoverageAvailable
  }
}

function logHydrologySummary(hydrologyResult: ProcessedHydrology, mcpi: string) {
  if (import.meta.env?.DEV) {
    console.log('[HydrologySummary]', {
      mcpi,
      source: 'loudoun-gis',
      waterFeatureCount: hydrologyResult.waterFeatureCount,
      wetlandFeatureCount: hydrologyResult.wetlandFeatureCount,
      streamFeatureCount: hydrologyResult.streamDrainCount,
      waterExcludedAreaSqFt: hydrologyResult.area,
      afterClipCount: hydrologyResult.afterClipCount,
      hydrologyCoverageAvailable: hydrologyResult.hydrologyCoverageAvailable,
      fetchError: hydrologyResult.fetchError
    })
  }
}

interface ProcessedBuildings {
  clippedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  warnings: string[]
  errors: string[]
  buildingsLoaded: number
  duplicatesRemoved: number
  validPolygons: number
  invalidSkipped: number
  clippedCount: number
  unionResultType: string
}

function processBuildingFootprints(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  buildingFeatures: any[],
  signal?: AbortSignal
): ProcessedBuildings {
  const warnings: string[] = []
  const errors: string[] = []
  const validBuildings: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  let skippedCount = 0

  // Deduplicate by OBJECTID
  const seenObjectIds = new Set<number>()
  const uniqueBuildings = buildingFeatures.filter(f => {
    const objectId = f.properties?.OBJECTID
    if (objectId === undefined) return true
    if (seenObjectIds.has(objectId)) return false
    seenObjectIds.add(objectId)
    return true
  })

  const duplicatesRemoved = buildingFeatures.length - uniqueBuildings.length

  // Normalize and validate each building
  for (const feature of uniqueBuildings) {
    if (signal?.aborted) break

    const normalized = normalizePolygonFeature(feature)
    if (!normalized.valid) {
      skippedCount++
      continue
    }

    validBuildings.push(normalized.feature)
  }

  // If no valid buildings, fail analysis if buildings were loaded
  if (validBuildings.length === 0) {
    if (buildingFeatures.length > 0) {
      errors.push(`All ${buildingFeatures.length} building footprints failed validation`)
    }
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      buildingsLoaded: buildingFeatures.length,
      duplicatesRemoved,
      validPolygons: 0,
      invalidSkipped: skippedCount,
      clippedCount: 0,
      unionResultType: 'none'
    }
  }

  // Union all valid buildings
  const unionResult = unionPolygonFeatures(validBuildings)
  if (!unionResult.success || !unionResult.result) {
    errors.push(`Building union failed: ${unionResult.error}`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      buildingsLoaded: buildingFeatures.length,
      duplicatesRemoved,
      validPolygons: validBuildings.length,
      invalidSkipped: skippedCount,
      clippedCount: 0,
      unionResultType: 'failed'
    }
  }

  const buildingUnion = unionResult.result
  const unionResultType = buildingUnion.geometry?.type || 'unknown'

  // Clip union to parcel
  const parcelFeature = turf.feature(parcelGeometry)
  const intersectResult = intersectPolygonFeatures(buildingUnion, parcelFeature)
  if (!intersectResult.success) {
    errors.push(`Building clipping failed: ${intersectResult.error}`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      buildingsLoaded: buildingFeatures.length,
      duplicatesRemoved,
      validPolygons: validBuildings.length,
      invalidSkipped: skippedCount,
      clippedCount: 0,
      unionResultType
    }
  }

  const clipped = intersectResult.result
  if (!clipped) {
    // Empty intersection is valid (buildings outside parcel)
    warnings.push(`No buildings intersect the parcel boundary`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      buildingsLoaded: buildingFeatures.length,
      duplicatesRemoved,
      validPolygons: validBuildings.length,
      invalidSkipped: skippedCount,
      clippedCount: 0,
      unionResultType
    }
  }

  const area = turf.area(clipped) * 10.7639

  return {
    clippedGeometry: clipped,
    area,
    warnings,
    errors,
    buildingsLoaded: buildingFeatures.length,
    duplicatesRemoved,
    validPolygons: validBuildings.length,
    invalidSkipped: skippedCount,
    clippedCount: 1,
    unionResultType
  }
}

interface ProcessedRoads {
  clippedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  warnings: string[]
  errors: string[]
  intersectingLoaded: number
  nearbyLoaded: number
  duplicatesRemoved: number
  uniqueSegments: number
  invalidSkipped: number
  validBuffers: number
  clippedBuffers: number
  unionResultType: string
}

function processRoadCorridors(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  streetFeatures: any[],
  signal?: AbortSignal
): ProcessedRoads {
  const warnings: string[] = []
  const errors: string[] = []
  const validLines: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>[] = []
  let skippedCount = 0

  // Deduplicate by OBJECTID
  const seenObjectIds = new Set<number>()
  const uniqueStreets = streetFeatures.filter(f => {
    const objectId = f.properties?.OBJECTID
    if (objectId === undefined) return true
    if (seenObjectIds.has(objectId)) return false
    seenObjectIds.add(objectId)
    return true
  })

  const duplicatesRemoved = streetFeatures.length - uniqueStreets.length

  // Normalize and validate each street
  for (const feature of uniqueStreets) {
    if (signal?.aborted) break

    const normalized = normalizeLineStringFeature(feature)
    if (!normalized.valid) {
      skippedCount++
      continue
    }

    validLines.push(normalized.feature)
  }

  // If no valid streets, fail analysis if streets were loaded
  if (validLines.length === 0) {
    if (streetFeatures.length > 0) {
      errors.push(`All ${streetFeatures.length} street segments failed validation`)
    }
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      intersectingLoaded: streetFeatures.length,
      nearbyLoaded: 0,
      duplicatesRemoved,
      uniqueSegments: 0,
      invalidSkipped: skippedCount,
      validBuffers: 0,
      clippedBuffers: 0,
      unionResultType: 'none'
    }
  }

  // Buffer each valid street
  const bufferedStreets: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  for (const street of validLines) {
    if (signal?.aborted) break

    // Handle both LineString and MultiLineString
    if (street.geometry.type === 'LineString') {
      const bufferResult = bufferLineFeature(street as GeoJSON.Feature<GeoJSON.LineString>, CANDIDATE_OPEN_AREA_ROAD_HALF_WIDTH_FEET)
      if (!bufferResult.success || !bufferResult.result) {
        skippedCount++
        continue
      }
      bufferedStreets.push(bufferResult.result)
    } else if (street.geometry.type === 'MultiLineString') {
      // Buffer each line in MultiLineString separately, then union
      const lines = street.geometry.coordinates.map(coords => ({
        type: 'LineString' as const,
        coordinates: coords
      }))
      let unionedBuffer: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = null
      for (const line of lines) {
        const lineFeature = turf.feature(line)
        const bufferResult = bufferLineFeature(lineFeature as GeoJSON.Feature<GeoJSON.LineString>, CANDIDATE_OPEN_AREA_ROAD_HALF_WIDTH_FEET)
        if (bufferResult.success && bufferResult.result) {
          if (!unionedBuffer) {
            unionedBuffer = bufferResult.result as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
          } else {
            const unionResult = unionPolygonFeatures([unionedBuffer, bufferResult.result as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>])
            if (unionResult.success && unionResult.result) {
              unionedBuffer = unionResult.result as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
            }
          }
        }
      }
      if (unionedBuffer) {
        bufferedStreets.push(unionedBuffer)
      } else {
        skippedCount++
      }
    }
  }

  // If no valid buffers, fail analysis if streets were loaded
  if (bufferedStreets.length === 0) {
    errors.push(`All ${validLines.length} street segments failed buffering`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      intersectingLoaded: streetFeatures.length,
      nearbyLoaded: 0,
      duplicatesRemoved,
      uniqueSegments: validLines.length,
      invalidSkipped: skippedCount,
      validBuffers: 0,
      clippedBuffers: 0,
      unionResultType: 'failed'
    }
  }

  // Union all buffered streets
  const unionResult = unionPolygonFeatures(bufferedStreets)
  if (!unionResult.success || !unionResult.result) {
    errors.push(`Road union failed: ${unionResult.error}`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      intersectingLoaded: streetFeatures.length,
      nearbyLoaded: 0,
      duplicatesRemoved,
      uniqueSegments: validLines.length,
      invalidSkipped: skippedCount,
      validBuffers: bufferedStreets.length,
      clippedBuffers: 0,
      unionResultType: 'failed'
    }
  }

  const roadUnion = unionResult.result
  const unionResultType = roadUnion.geometry?.type || 'unknown'

  // Clip union to parcel
  const parcelFeature = turf.feature(parcelGeometry)
  const intersectResult = intersectPolygonFeatures(roadUnion, parcelFeature)
  if (!intersectResult.success) {
    errors.push(`Road clipping failed: ${intersectResult.error}`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      intersectingLoaded: streetFeatures.length,
      nearbyLoaded: 0,
      duplicatesRemoved,
      uniqueSegments: validLines.length,
      invalidSkipped: skippedCount,
      validBuffers: bufferedStreets.length,
      clippedBuffers: 0,
      unionResultType
    }
  }

  const clipped = intersectResult.result
  if (!clipped) {
    // Empty intersection is valid (roads outside parcel)
    warnings.push(`No road corridors intersect the parcel boundary`)
    return {
      clippedGeometry: null,
      area: 0,
      warnings,
      errors,
      intersectingLoaded: streetFeatures.length,
      nearbyLoaded: 0,
      duplicatesRemoved,
      uniqueSegments: validLines.length,
      invalidSkipped: skippedCount,
      validBuffers: bufferedStreets.length,
      clippedBuffers: 0,
      unionResultType
    }
  }

  const area = turf.area(clipped) * 10.7639

  return {
    clippedGeometry: clipped,
    area,
    warnings,
    errors,
    intersectingLoaded: streetFeatures.length,
    nearbyLoaded: 0,
    duplicatesRemoved,
    uniqueSegments: validLines.length,
    invalidSkipped: skippedCount,
    validBuffers: bufferedStreets.length,
    clippedBuffers: 1,
    unionResultType
  }
}

// Conceptual stream/flowline avoidance buffer. This is NOT a regulatory setback.
// It is an MVP routing guard to keep proposed roads from being drawn through
// mapped drain lines. A real project would replace this with agency buffers.
const STREAM_CONCEPTUAL_AVOIDANCE_BUFFER_FEET = 25

interface ProcessedHydrology {
  clippedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  waterArea: number
  wetlandArea: number
  streamBufferArea: number
  warnings: string[]
  errors: string[]
  waterFeatureCount: number
  wetlandFeatureCount: number
  streamDrainCount: number
  unionResultType: string
  hydrologyCoverageAvailable: boolean
  fetchError?: string
  afterClipCount?: number
  constraintResult: HydrologyConstraintResult
}

function classifyWaterBody(_feature: any, rawProps: any): HydrologyConstraintClass {
  const waType = rawProps?.WA_TYPE
  // Water bodies are mapped, but WA_TYPE meaning is not documented in the
  // project metadata, so we classify conservatively while preserving the value.
  // Future Phase 7B can remap specific WA_TYPE codes to OPEN_WATER_HARD_AVOID.
  if (waType == null) return 'UNCERTAIN_HYDROLOGY'
  return 'UNCERTAIN_HYDROLOGY'
}

function classifyWetland(_feature: any, _rawProps: any): HydrologyConstraintClass {
  return 'WETLAND_HIGH_CONSTRAINT'
}

function classifyStream(_feature: any, rawProps: any): HydrologyConstraintClass {
  // Base Map Drains 2 and 9 are the flowline types already used for avoidance.
  // DR_CLASS may eventually distinguish major waterway corridors, but until
  // those values are documented all supported drains are treated as corridors.
  const drClass = rawProps?.DR_CLASS
  if (typeof drClass === 'string' && /major|river|named|perennial/i.test(drClass)) {
    return 'MAJOR_WATERWAY_CORRIDOR'
  }
  return 'STREAM_CORRIDOR'
}

function clipToParcel(
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  parcelFeature: GeoJSON.Feature<GeoJSON.Geometry>
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!geometry) return null
  const intersected = intersectPolygonFeatures(geometry, parcelFeature)
  return intersected.success ? intersected.result : null
}

function safeAreaSqFt(geometry: GeoJSON.Feature<GeoJSON.Geometry> | null): number {
  if (!geometry) return 0
  try {
    return turf.area(geometry) * 10.7639
  } catch {
    return 0
  }
}

function processHydrologyObstacles(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  hydrologyFeatures: HydrologyData | null | undefined,
  mcpi: string = '',
  signal?: AbortSignal
): ProcessedHydrology {
  const warnings: string[] = []
  const classifiedFeatures: ClassifiedHydrologyFeature[] = []
  const classCounts: Record<HydrologyConstraintClass, number> = {
    OPEN_WATER_HARD_AVOID: 0,
    MAJOR_WATERWAY_CORRIDOR: 0,
    STREAM_CORRIDOR: 0,
    WETLAND_HIGH_CONSTRAINT: 0,
    UNCERTAIN_HYDROLOGY: 0
  }

  const emptyConstraintResult: HydrologyConstraintResult = {
    combinedHardObstacleGeometry: null,
    waterBodiesGeometry: null,
    wetlandsGeometry: null,
    streamCorridorGeometry: null,
    classifiedFeatures: [],
    waterBodyCount: 0,
    wetlandCount: 0,
    streamFeatureCount: 0,
    classCounts,
    distinctWaterBodyTypes: [],
    distinctWetlandTypes: [],
    distinctDrainTypes: [],
    distinctDrainClasses: []
  }

  const empty: ProcessedHydrology = {
    clippedGeometry: null,
    area: 0,
    waterArea: 0,
    wetlandArea: 0,
    streamBufferArea: 0,
    warnings,
    errors: [],
    waterFeatureCount: 0,
    wetlandFeatureCount: 0,
    streamDrainCount: 0,
    unionResultType: 'none',
    hydrologyCoverageAvailable: false,
    constraintResult: emptyConstraintResult
  }

  if (!hydrologyFeatures) {
    return { ...empty, errors: ['Environmental/hydrology coverage is unavailable or incomplete'] }
  }

  if (!hydrologyFeatures.hydrologyCoverageAvailable) {
    const detail = hydrologyFeatures.fetchError ? `: ${hydrologyFeatures.fetchError}` : ' (no fetch error recorded)'
    
    return { ...empty, hydrologyCoverageAvailable: false, fetchError: hydrologyFeatures.fetchError, errors: [`Environmental/hydrology coverage is unavailable or incomplete${detail}`] }
  }

  if (signal?.aborted) {
    return { ...empty, errors: ['Analysis aborted'] }
  }

  const waterPolygons: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  const wetlandPolygons: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  const bufferedStreams: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  const waterGeometryTypes = new Set<string>()
  const wetlandGeometryTypes = new Set<string>()
  const streamGeometryTypes = new Set<string>()
  const distinctWaterBodyTypes = new Set<string | number | null | undefined>()
  const distinctWetlandTypes = new Set<string | number | null | undefined>()
  const distinctDrainTypes = new Set<string | number | null | undefined>()
  const distinctDrainClasses = new Set<string | number | null | undefined>()

  let waterRaw = 0
  let waterValid = 0
  for (const f of hydrologyFeatures.waterBodyFeatures) {
    if (signal?.aborted) break
    waterRaw++
    waterGeometryTypes.add(f?.geometry?.type || 'undefined')
    distinctWaterBodyTypes.add(f?.properties?.WA_TYPE)
    try {
      const normalized = normalizePolygonFeature(f)
      if (normalized.valid) {
        waterPolygons.push(normalized.feature)
        waterValid++
        const constraintClass = classifyWaterBody(normalized.feature, f?.properties)
        classCounts[constraintClass]++
        classifiedFeatures.push({
          source: 'water',
          constraintClass,
          rawProperties: { ...(f?.properties || {}), WA_TYPE: f?.properties?.WA_TYPE, WA_WELEV: f?.properties?.WA_WELEV },
          feature: normalized.feature
        })
      }
    } catch (err: any) {
      console.error('[HydrologyFailure]', { mcpi, source: 'water', stage: 'normalize', message: err?.message, originalError: err })
    }
  }

  

  let wetlandRaw = 0
  let wetlandValid = 0
  for (const f of hydrologyFeatures.wetlandFeatures) {
    if (signal?.aborted) break
    wetlandRaw++
    wetlandGeometryTypes.add(f?.geometry?.type || 'undefined')
    distinctWetlandTypes.add(f?.properties?.WE_TYPE)
    try {
      const normalized = normalizePolygonFeature(f)
      if (normalized.valid) {
        wetlandPolygons.push(normalized.feature)
        wetlandValid++
        const constraintClass = classifyWetland(normalized.feature, f?.properties)
        classCounts[constraintClass]++
        classifiedFeatures.push({
          source: 'wetland',
          constraintClass,
          rawProperties: { ...(f?.properties || {}), WE_TYPE: f?.properties?.WE_TYPE },
          feature: normalized.feature
        })
      }
    } catch (err: any) {
      console.error('[HydrologyFailure]', { mcpi, source: 'wetlands', stage: 'normalize', message: err?.message, originalError: err })
    }
  }

  

  let streamRaw = 0
  let streamNormalizedValid = 0
  for (const f of hydrologyFeatures.streamDrainFeatures) {
    if (signal?.aborted) break
    streamRaw++
    streamGeometryTypes.add(f?.geometry?.type || 'undefined')
    distinctDrainTypes.add(f?.properties?.DR_TYPE)
    distinctDrainClasses.add(f?.properties?.DR_CLASS)
    try {
      const normalized = normalizeLineStringFeature(f)
      if (!normalized.valid) continue
      streamNormalizedValid++
      const feature = normalized.feature
      const constraintClass = classifyStream(feature, f?.properties)
      classCounts[constraintClass]++

      if (feature.geometry.type === 'LineString') {
        const bufferResult = bufferLineFeature(feature as GeoJSON.Feature<GeoJSON.LineString>, STREAM_CONCEPTUAL_AVOIDANCE_BUFFER_FEET)
        if (bufferResult.success && bufferResult.result) {
          const buffered = bufferResult.result
          bufferedStreams.push(buffered)
          classifiedFeatures.push({
            source: 'stream',
            constraintClass,
            rawProperties: { ...(f?.properties || {}), DR_TYPE: f?.properties?.DR_TYPE, DR_CLASS: f?.properties?.DR_CLASS },
            feature: buffered
          })
        }
      } else if (feature.geometry.type === 'MultiLineString') {
        for (const lineCoords of feature.geometry.coordinates) {
          const lineFeature = turf.feature({ type: 'LineString', coordinates: lineCoords })
          const bufferResult = bufferLineFeature(lineFeature as any, STREAM_CONCEPTUAL_AVOIDANCE_BUFFER_FEET)
          if (bufferResult.success && bufferResult.result) {
            const buffered = bufferResult.result
            bufferedStreams.push(buffered)
            classifiedFeatures.push({
              source: 'stream',
              constraintClass,
              rawProperties: { ...(f?.properties || {}), DR_TYPE: f?.properties?.DR_TYPE, DR_CLASS: f?.properties?.DR_CLASS },
              feature: buffered
            })
          }
        }
      }
    } catch (err: any) {
      console.error('[HydrologyFailure]', { mcpi, source: 'streams', stage: 'normalize-or-buffer', message: err?.message, originalError: err })
    }
  }

  

  const parcelFeature = turf.feature(parcelGeometry)

  const allHydrology = [...waterPolygons, ...wetlandPolygons, ...bufferedStreams]
  if (allHydrology.length === 0) {
    warnings.push('Hydrology layers returned no usable features for this parcel')
    return { ...empty, hydrologyCoverageAvailable: true }
  }

  // Existing combined hard obstacle geometry — behavior for current Phase 6 consumers.
  const unionResult = unionPolygonFeatures(allHydrology)
  if (!unionResult.success || !unionResult.result) {
    warnings.push(`Hydrology union failed: ${unionResult.error}. Some water features may be excluded.`)
    return { ...empty, hydrologyCoverageAvailable: true }
  }

  const intersectResult = intersectPolygonFeatures(unionResult.result, parcelFeature)
  if (!intersectResult.success || !intersectResult.result) {
    warnings.push('Could not clip hydrology features to the parcel boundary')
    return { ...empty, hydrologyCoverageAvailable: true }
  }

  const clipped = intersectResult.result
  const area = turf.area(clipped) * 10.7639
  let afterClipCount = 0
  if (clipped.geometry.type === 'Polygon') {
    afterClipCount = 1
  } else if (clipped.geometry.type === 'MultiPolygon') {
    afterClipCount = clipped.geometry.coordinates.length
  }

  // Classified/typed geometries for future Phase 7B consumers.
  const waterUnion = unionPolygonFeatures(waterPolygons).success ? (unionPolygonFeatures(waterPolygons).result as GeoJSON.Feature<GeoJSON.Geometry>) : null
  const wetlandUnion = unionPolygonFeatures(wetlandPolygons).success ? (unionPolygonFeatures(wetlandPolygons).result as GeoJSON.Feature<GeoJSON.Geometry>) : null
  const streamUnion = unionPolygonFeatures(bufferedStreams).success ? (unionPolygonFeatures(bufferedStreams).result as GeoJSON.Feature<GeoJSON.Geometry>) : null

  const waterBodiesGeometry = clipToParcel(waterUnion, parcelFeature)
  const wetlandsGeometry = clipToParcel(wetlandUnion, parcelFeature)
  const streamCorridorGeometry = clipToParcel(streamUnion, parcelFeature)

  const constraintResult: HydrologyConstraintResult = {
    combinedHardObstacleGeometry: clipped,
    waterBodiesGeometry,
    wetlandsGeometry,
    streamCorridorGeometry,
    classifiedFeatures,
    waterBodyCount: waterRaw,
    wetlandCount: wetlandRaw,
    streamFeatureCount: streamRaw,
    classCounts: { ...classCounts },
    distinctWaterBodyTypes: Array.from(distinctWaterBodyTypes),
    distinctWetlandTypes: Array.from(distinctWetlandTypes),
    distinctDrainTypes: Array.from(distinctDrainTypes),
    distinctDrainClasses: Array.from(distinctDrainClasses)
  }

  logHydrologyClassificationAudit(mcpi, constraintResult)

  

  return {
    clippedGeometry: clipped,
    area,
    waterArea: safeAreaSqFt(waterBodiesGeometry),
    wetlandArea: safeAreaSqFt(wetlandsGeometry),
    streamBufferArea: safeAreaSqFt(streamCorridorGeometry),
    warnings,
    errors: [],
    waterFeatureCount: waterRaw,
    wetlandFeatureCount: wetlandRaw,
    streamDrainCount: streamRaw,
    unionResultType: clipped.geometry?.type || 'unknown',
    hydrologyCoverageAvailable: true,
    afterClipCount,
    constraintResult
  }
}

function logHydrologyClassificationAudit(mcpi: string, result: HydrologyConstraintResult) {
  if (!import.meta.env.DEV) return
  
}

interface ProcessedPavement {
  clippedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  warnings: string[]
  errors: string[]
  parkingLotFeatureCount: number
  drivewayFeatureCount: number
  pavementFeatureCount: number
  coverageError?: string
  pavementCoverageAvailable: boolean
}

function processPavementSurfaces(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  pavementFeatures: PavementData | null | undefined,
  mcpi: string = '',
  signal?: AbortSignal
): ProcessedPavement {
  const warnings: string[] = []
  const errors: string[] = []
  const empty: ProcessedPavement = {
    clippedGeometry: null,
    area: 0,
    warnings,
    errors,
    parkingLotFeatureCount: 0,
    drivewayFeatureCount: 0,
    pavementFeatureCount: 0,
    pavementCoverageAvailable: false
  }

  if (!pavementFeatures) {
    return { ...empty, coverageError: 'Existing pavement coverage is unavailable: no pavement data provided' }
  }
  if (!pavementFeatures.pavementCoverageAvailable) {
    const detail = pavementFeatures.fetchError ? `: ${pavementFeatures.fetchError}` : ''
    return { ...empty, coverageError: `Existing pavement coverage is unavailable or incomplete${detail}` }
  }

  const geometryTypes = new Set<string>()
  const parkingLotFeatureCount = pavementFeatures.parkingLotFeatureCount ?? 0
  const drivewayFeatureCount = pavementFeatures.drivewayFeatureCount ?? 0
  const rawFeatureCount = pavementFeatures.totalFeatureCount ?? 0

  const validPavements: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  const seenObjectIds = new Set<number>()
  const uniquePavement = (pavementFeatures.features || []).filter(f => {
    const objectId = f.properties?.OBJECTID
    if (objectId === undefined) return true
    if (seenObjectIds.has(objectId)) return false
    seenObjectIds.add(objectId)
    return true
  })

  for (const f of uniquePavement) {
    if (signal?.aborted) break
    geometryTypes.add(f?.geometry?.type || 'undefined')
    const normalized = normalizePolygonFeature(f)
    if (normalized.valid) {
      validPavements.push(normalized.feature)
    }
  }

  

  if (validPavements.length === 0) {
    return { ...empty, pavementCoverageAvailable: true, parkingLotFeatureCount, drivewayFeatureCount, pavementFeatureCount: 0 }
  }

  const unionResult = unionPolygonFeatures(validPavements)
  if (!unionResult.success || !unionResult.result) {
    errors.push(`Pavement union failed: ${unionResult.error}`)
    return { ...empty, pavementCoverageAvailable: true, parkingLotFeatureCount, drivewayFeatureCount, pavementFeatureCount: validPavements.length }
  }

  const parcelFeature = turf.feature(parcelGeometry)
  const intersectResult = intersectPolygonFeatures(unionResult.result, parcelFeature)
  if (!intersectResult.success || !intersectResult.result) {
    warnings.push('Could not clip pavement features to the parcel boundary')
    return { ...empty, pavementCoverageAvailable: true, parkingLotFeatureCount, drivewayFeatureCount, pavementFeatureCount: validPavements.length }
  }

  const clipped = intersectResult.result
  const area = turf.area(clipped) * 10.7639
  let afterClipCount = 0
  if (clipped.geometry.type === 'Polygon') {
    afterClipCount = 1
  } else if (clipped.geometry.type === 'MultiPolygon') {
    afterClipCount = clipped.geometry.coordinates.length
  }

  

  return {
    clippedGeometry: clipped,
    area,
    warnings,
    errors,
    parkingLotFeatureCount,
    drivewayFeatureCount,
    pavementFeatureCount: validPavements.length,
    pavementCoverageAvailable: true
  }
}

function logPavementSummary(pavementResult: ProcessedPavement, mcpi: string) {
  if (import.meta.env?.DEV) {
    console.log('[PavementSummary]', {
      mcpi,
      source: 'loudoun-gis',
      parkingLotFeatureCount: pavementResult.parkingLotFeatureCount,
      drivewayFeatureCount: pavementResult.drivewayFeatureCount,
      pavementFeatureCount: pavementResult.pavementFeatureCount,
      pavementAreaSqFt: pavementResult.area,
      pavementCoverageAvailable: pavementResult.pavementCoverageAvailable,
      coverageError: pavementResult.coverageError
    })
  }
}

interface UnionResult {
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  errors: string[]
}

function unionLockedFeatures(
  buildingGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  roadGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  hydrologyGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  pavementGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  signal?: AbortSignal
): UnionResult {
  const errors: string[] = []

  if (signal?.aborted) {
    return { geometry: null, area: 0, errors }
  }

  const inputs: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  if (buildingGeometry) inputs.push(buildingGeometry as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
  if (roadGeometry) inputs.push(roadGeometry as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
  if (hydrologyGeometry) inputs.push(hydrologyGeometry as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
  if (pavementGeometry) inputs.push(pavementGeometry as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)

  if (inputs.length === 0) {
    return { geometry: null, area: 0, errors }
  }

  if (inputs.length === 1) {
    const area = turf.area(inputs[0]) * 10.7639
    return { geometry: inputs[0], area, errors }
  }

  // Union all locked inputs using Turf v7 API
  const unionResult = unionPolygonFeatures(inputs)

  if (!unionResult.success || !unionResult.result) {
    errors.push(`Locked-feature union failed: ${unionResult.error}`)
    // If union fails, return the largest single input
    let largest = inputs[0]
    let largestArea = turf.area(largest) * 10.7639
    for (let i = 1; i < inputs.length; i++) {
      const a = turf.area(inputs[i]) * 10.7639
      if (a > largestArea) {
        largest = inputs[i]
        largestArea = a
      }
    }
    return { geometry: largest, area: largestArea, errors }
  }

  const unioned = unionResult.result
  const area = turf.area(unioned) * 10.7639
  return { geometry: unioned, area, errors }
}

function calculateOverlap(
  buildingGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  roadGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
): number {
  if (!buildingGeometry || !roadGeometry) {
    return 0
  }

  try {
    const intersectResult = intersectPolygonFeatures(buildingGeometry, roadGeometry)
    if (!intersectResult.success || !intersectResult.result) return 0
    return turf.area(intersectResult.result) * 10.7639
  } catch (e) {
    return 0
  }
}

interface SubtractionResult {
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  area: number
  errors: string[]
}

function subtractLockedFeatures(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  lockedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null,
  signal?: AbortSignal
): SubtractionResult {
  const errors: string[] = []

  if (signal?.aborted) {
    return { geometry: null, area: 0, errors }
  }

  if (!lockedGeometry) {
    const area = turf.area(parcelGeometry) * 10.7639
    return { geometry: turf.feature(parcelGeometry), area, errors }
  }

  // Use Turf v7 difference API
  const differenceResult = differencePolygonFeatures(
    turf.feature(parcelGeometry),
    lockedGeometry
  )

  if (!differenceResult.success || !differenceResult.result) {
    errors.push(`Difference failed: ${differenceResult.error}`)
    return { geometry: null, area: 0, errors }
  }

  const difference = differenceResult.result
  if (!difference) {
    // Complete subtraction (parcel entirely covered by locked features)
    return { geometry: null, area: 0, errors }
  }

  const area = turf.area(difference) * 10.7639
  return { geometry: difference, area, errors }
}

interface ComponentAnalysis {
  count: number
  largest: number
  smallest: number
  type: 'Polygon' | 'MultiPolygon' | 'Empty'
  pointCount: number
}

function analyzeComponents(
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | null
): ComponentAnalysis {
  if (!geometry) {
    return {
      count: 0,
      largest: 0,
      smallest: 0,
      type: 'Empty',
      pointCount: 0
    }
  }

  const geom = geometry.geometry

  if (geom.type === 'Polygon') {
    const area = turf.area(geometry) * 10.7639
    const pointCount = countPoints(geom.coordinates)
    return {
      count: 1,
      largest: area,
      smallest: area,
      type: 'Polygon',
      pointCount
    }
  }

  if (geom.type === 'MultiPolygon') {
    const areas = geom.coordinates.map(coords => {
      const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: coords }
      return turf.area(turf.feature(poly)) * 10.7639
    })

    const validAreas = areas.filter(a => a > ARTIFACT_THRESHOLD_SQ_FT)
    const pointCount = geom.coordinates.reduce((sum, coords) => sum + countPoints(coords), 0)

    if (validAreas.length === 0) {
      return {
        count: 0,
        largest: 0,
        smallest: 0,
        type: 'Empty',
        pointCount
      }
    }

    return {
      count: validAreas.length,
      largest: Math.max(...validAreas),
      smallest: Math.min(...validAreas),
      type: 'MultiPolygon',
      pointCount
    }
  }

  return {
    count: 0,
    largest: 0,
    smallest: 0,
    type: 'Empty',
    pointCount: 0
  }
}

function countPoints(coordinates: any[][]): number {
  let count = 0
  for (const ring of coordinates) {
    count += ring.length
  }
  return count
}

export function createFailedResult(
  mcpi: string,
  gisAcreage: number | null,
  errors: string[],
  analysisRunId: number = 0
): CandidateOpenAreaResult {
  return {
    mcpi,
    analysisRunId,
    status: 'failed',
    parcelAreaSqFt: 0,
    parcelAreaAcres: 0,
    gisAcreage,
    buildingAreaSqFt: 0,
    buildingAreaAcres: 0,
    roadAreaSqFt: 0,
    roadAreaAcres: 0,
    buildingRoadOverlapSqFt: 0,
    totalLockedAreaSqFt: 0,
    totalLockedAreaAcres: 0,
    candidateAreaSqFt: 0,
    candidateAreaAcres: 0,
    candidatePercent: 0,
    componentCount: 0,
    largestComponentSqFt: 0,
    largestComponentAcres: 0,
    smallestComponentSqFt: 0,
    geometryType: 'Empty',
    totalPointCount: 0,
    roadHalfWidthFeet: CANDIDATE_OPEN_AREA_ROAD_HALF_WIDTH_FEET,
    conservationDifferenceSqFt: 0,
    conservationWithinTolerance: false,
    warnings: [],
    errors,
    calculatedAt: new Date().toISOString(),
    hydrologyGeometry: undefined,
    hydrologyAreaSqFt: 0,
    hydrologyAreaAcres: 0,
    hydrologyCoverageAvailable: false,
    waterFeatureCount: 0,
    wetlandFeatureCount: 0,
    streamFeatureCount: 0,
    pavementGeometry: undefined,
    pavementAreaSqFt: 0,
    pavementAreaAcres: 0,
    parkingLotFeatureCount: 0,
    drivewayFeatureCount: 0,
    pavementFeatureCount: 0,
    pavementCoverageAvailable: false
  }
}
