import * as turf from '@turf/turf'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type { CandidateOpenAreaResult } from '../types/parameters'
import type { TerrainContour, TerrainData, TerrainSample, TerrainSuitabilityAudit, TerrainSuitabilityCellProperties, TerrainSuitabilityClass, TerrainSuitabilityResult } from '../types/terrain'
// Terrain sampling in this service uses a parcel-local contour index to avoid repeated full contour scans.

// Phase 7A conceptual slope feasibility bands.
// These are NOT Loudoun County engineering or zoning standards.
export const TERRAIN_SUITABILITY_BANDS = {
  PREFERRED: { label: 'Preferred', min: 0, max: 5 },
  MODERATE: { label: 'Moderate', min: 5, max: 10 },
  CHALLENGING: { label: 'Challenging', min: 10, max: 15 },
  AVOID: { label: 'Avoid', min: 15 }
} as const

export const TERRAIN_SUITABILITY_VERSION = '1.0'
export const DEFAULT_TERRAIN_SAMPLE_SPACING_FT = 50
export const SLOPE_SAMPLE_FT = 25
export const MAX_SAMPLE_POINTS = 2500
export const YIELD_INTERVAL = 50
export const AREA_RECONCILIATION_TOLERANCE_PCT = 5
export const MIN_CELL_AREA_SQ_FT = 0.01
export const SQFT_PER_ACRE = 43560
const SQ_METERS_TO_ACRES = 0.000247105
const FT_PER_DEGREE_LAT = 364411.0
const FT_TO_METERS = 0.3048
const SLOPE_DIRECTIONS = [0, 90, 180, 270] as const

function toRadians(deg: number): number {
  return deg * Math.PI / 180
}

function localScaleFactors(latitude: number): { latScale: number; lonScale: number } {
  const latScale = FT_PER_DEGREE_LAT
  const lonScale = FT_PER_DEGREE_LAT * Math.cos(toRadians(latitude))
  return { latScale, lonScale }
}

function safeTurfOp<T>(op: () => T, fallback: T): T {
  try {
    return op()
  } catch {
    return fallback
  }
}

function rhumbDestinationFt(coord: number[], distanceFt: number, bearing: number): number[] | null {
  return safeTurfOp(
    () => turf.rhumbDestination(turf.point(coord), distanceFt * FT_TO_METERS, bearing, { units: 'meters' }).geometry.coordinates,
    null
  )
}

function sampleKey(point: number[]): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`
}

function classifySlope(slopePct: number): TerrainSuitabilityClass {
  if (!Number.isFinite(slopePct)) return 'INSUFFICIENT_DATA'
  const { PREFERRED, MODERATE, CHALLENGING, AVOID } = TERRAIN_SUITABILITY_BANDS
  if (slopePct >= PREFERRED.min && slopePct < PREFERRED.max) return 'PREFERRED'
  if (slopePct >= MODERATE.min && slopePct < MODERATE.max) return 'MODERATE'
  if (slopePct >= CHALLENGING.min && slopePct <= CHALLENGING.max) return 'CHALLENGING'
  if (slopePct > AVOID.min) return 'AVOID'
  return 'INSUFFICIENT_DATA'
}

function sqMToAcres(sqM: number): number {
  return sqM * SQ_METERS_TO_ACRES
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function buildSuitabilityCacheKey(
  mcpi: string,
  candidateOpenArea: CandidateOpenAreaResult,
  sampleSpacingFt: number
): string {
  const geometryKey = candidateOpenArea.candidateGeometry
    ? JSON.stringify((candidateOpenArea.candidateGeometry.geometry as any)?.coordinates)
    : 'no-geometry'
  return `${mcpi}|${candidateOpenArea.analysisRunId}|${sampleSpacingFt}|${TERRAIN_SUITABILITY_VERSION}|${geometryKey}`
}

function computeEffectiveSpacing(
  candidateGeometry: GeoJSON.Feature<GeoJSON.Geometry>,
  requestedSpacingFt: number
): number {
  const bbox = safeTurfOp(() => turf.bbox(candidateGeometry), null)
  if (!bbox) return requestedSpacingFt

  const lat = (bbox[1] + bbox[3]) / 2
  const { latScale, lonScale } = localScaleFactors(lat)
  const widthFt = (bbox[2] - bbox[0]) * lonScale
  const heightFt = (bbox[3] - bbox[1]) * latScale

  const pointsX = Math.max(1, Math.ceil(widthFt / requestedSpacingFt))
  const pointsY = Math.max(1, Math.ceil(heightFt / requestedSpacingFt))
  const totalPoints = pointsX * pointsY

  if (totalPoints <= MAX_SAMPLE_POINTS) {
    return requestedSpacingFt
  }

  // Increase spacing uniformly until the grid is under the cap.
  const area = pointsX * pointsY
  const scale = Math.sqrt(MAX_SAMPLE_POINTS / area)
  return Math.ceil(requestedSpacingFt / scale)
}

function pointInsideFeature(point: number[], feature: GeoJSON.Feature<GeoJSON.Geometry>): boolean {
  return safeTurfOp(() => turf.booleanPointInPolygon(turf.point(point), feature as any), false)
}

function buildSquareCell(
  center: number[],
  halfSpacingLon: number,
  halfSpacingLat: number
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [lon, lat] = center
  const coords: number[][] = [
    [lon - halfSpacingLon, lat + halfSpacingLat],
    [lon + halfSpacingLon, lat + halfSpacingLat],
    [lon + halfSpacingLon, lat - halfSpacingLat],
    [lon - halfSpacingLon, lat - halfSpacingLat],
    [lon - halfSpacingLon, lat + halfSpacingLat]
  ]
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] }
  }
}

// Same thresholds used by terrainService sampleTerrain, mirrored here to support
// the parcel-local fast sampling path without changing semantics.
const TERRAIN_NEARBY_THRESHOLD_FT = 100
const HIGH_CONFIDENCE_DISTANCE_FT = 25
const MODERATE_CONFIDENCE_DISTANCE_FT = 75
const TERRAIN_CONTOUR_GRID_CELL_FT = 100

interface ContourSegment {
  a: number[]
  b: number[]
  elevationFt: number
}

interface ContourGridIndex {
  cellSizeLon: number
  cellSizeLat: number
  minLon: number
  minLat: number
  grid: Map<string, number[]>
  segments: ContourSegment[]
}

function pointToSegmentDistanceFt(p: number[], a: number[], b: number[]): number {
  const { latScale, lonScale } = localScaleFactors((a[1] + b[1]) / 2)
  const px = (p[0] - a[0]) * lonScale
  const py = (p[1] - a[1]) * latScale
  const bx = (b[0] - a[0]) * lonScale
  const by = (b[1] - a[1]) * latScale
  const len2 = bx * bx + by * by
  if (len2 === 0) return Math.sqrt(px * px + py * py)
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2))
  const dx = px - t * bx
  const dy = py - t * by
  return Math.sqrt(dx * dx + dy * dy)
}

function buildContourGridIndex(contours: TerrainContour[], latitude: number): ContourGridIndex {
  const { latScale, lonScale } = localScaleFactors(latitude)
  const cellSizeLon = TERRAIN_CONTOUR_GRID_CELL_FT / lonScale
  const cellSizeLat = TERRAIN_CONTOUR_GRID_CELL_FT / latScale

  const segments: ContourSegment[] = []
  let minLon = Infinity
  let minLat = Infinity

  for (const contour of contours) {
    const coords = contour.geometry.coordinates as number[][]
    const elev = contour.properties.elevationFt
    for (let i = 0; i < coords.length - 1; i++) {
      segments.push({ a: coords[i], b: coords[i + 1], elevationFt: elev })
      minLon = Math.min(minLon, coords[i][0], coords[i + 1][0])
      minLat = Math.min(minLat, coords[i][1], coords[i + 1][1])
    }
  }

  const grid = new Map<string, number[]>()
  for (let idx = 0; idx < segments.length; idx++) {
    const s = segments[idx]
    const minX = Math.min(s.a[0], s.b[0])
    const maxX = Math.max(s.a[0], s.b[0])
    const minY = Math.min(s.a[1], s.b[1])
    const maxY = Math.max(s.a[1], s.b[1])
    const cMinX = Math.floor((minX - minLon) / cellSizeLon)
    const cMaxX = Math.floor((maxX - minLon) / cellSizeLon)
    const cMinY = Math.floor((minY - minLat) / cellSizeLat)
    const cMaxY = Math.floor((maxY - minLat) / cellSizeLat)
    for (let x = cMinX; x <= cMaxX; x++) {
      for (let y = cMinY; y <= cMaxY; y++) {
        const key = `${x},${y}`
        const arr = grid.get(key)
        if (arr) {
          arr.push(idx)
        } else {
          grid.set(key, [idx])
        }
      }
    }
  }

  return { cellSizeLon, cellSizeLat, minLon, minLat, grid, segments }
}

function sampleTerrainWithIndex(
  point: number[],
  terrainData: TerrainData,
  index: ContourGridIndex,
  sampleCache: Map<string, TerrainSample>,
  stats: { requests: number; hits: number; misses: number }
): TerrainSample {
  stats.requests++
  const key = sampleKey(point)
  const cached = sampleCache.get(key)
  if (cached) {
    stats.hits++
    return cached
  }
  stats.misses++

  const empty = (): TerrainSample => ({
    coordinate: point,
    elevationFt: null,
    confidence: 'UNAVAILABLE',
    nearestContourDistanceFt: Infinity,
    lowerContourFt: null,
    upperContourFt: null
  })

  if (!terrainData.coverageAvailable || terrainData.contourCount === 0) {
    return empty()
  }

  const { grid, segments, cellSizeLon, cellSizeLat, minLon, minLat } = index
  const cx = Math.floor((point[0] - minLon) / cellSizeLon)
  const cy = Math.floor((point[1] - minLat) / cellSizeLat)

  const within: { distanceFt: number; elevationFt: number }[] = []
  let nearest = Infinity

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(`${cx + dx},${cy + dy}`)
      if (!cell) continue
      for (const idx of cell) {
        const s = segments[idx]
        const d = pointToSegmentDistanceFt(point, s.a, s.b)
        if (d <= TERRAIN_NEARBY_THRESHOLD_FT) {
          within.push({ distanceFt: d, elevationFt: s.elevationFt })
        }
        if (d < nearest) nearest = d
      }
    }
  }

  if (within.length === 0) {
    const sample = empty()
    sample.nearestContourDistanceFt = nearest
    return sample
  }

  within.sort((a, b) => a.distanceFt - b.distanceFt)
  const nearestSorted = within[0]

  if (within.length === 1) {
    const only = within[0]
    let confidence: TerrainSample['confidence'] = 'LOW'
    if (only.distanceFt <= HIGH_CONFIDENCE_DISTANCE_FT) confidence = 'MODERATE'
    if (only.distanceFt <= 8) confidence = 'HIGH'
    const sample: TerrainSample = {
      coordinate: point,
      elevationFt: only.elevationFt,
      confidence,
      nearestContourDistanceFt: only.distanceFt,
      lowerContourFt: only.elevationFt,
      upperContourFt: only.elevationFt
    }
    sampleCache.set(key, sample)
    return sample
  }

  const sortedByElev = within.slice(0, 2).sort((a, b) => a.elevationFt - b.elevationFt)
  const lower = sortedByElev[0]
  const upper = sortedByElev[1]
  const sum = lower.distanceFt + upper.distanceFt
  const fraction = sum === 0 ? 0 : lower.distanceFt / sum
  const elevation = lower.elevationFt + fraction * (upper.elevationFt - lower.elevationFt)

  let confidence: TerrainSample['confidence'] = 'LOW'
  if (lower.distanceFt + upper.distanceFt <= 2 * MODERATE_CONFIDENCE_DISTANCE_FT) confidence = 'MODERATE'
  if (lower.distanceFt + upper.distanceFt <= 2 * HIGH_CONFIDENCE_DISTANCE_FT) confidence = 'HIGH'

  const sample: TerrainSample = {
    coordinate: point,
    elevationFt: elevation,
    confidence,
    nearestContourDistanceFt: nearestSorted.distanceFt,
    lowerContourFt: lower.elevationFt,
    upperContourFt: upper.elevationFt
  }
  sampleCache.set(key, sample)
  return sample
}

const terrainSuitabilityCache = new Map<string, TerrainSuitabilityResult>()

export function clearTerrainSuitabilityCache(): void {
  terrainSuitabilityCache.clear()
}

export function getCachedTerrainSuitability(
  mcpi: string,
  candidateOpenArea: CandidateOpenAreaResult,
  sampleSpacingFt: number
): TerrainSuitabilityResult | undefined {
  const key = buildSuitabilityCacheKey(mcpi, candidateOpenArea, sampleSpacingFt)
  return terrainSuitabilityCache.get(key)
}

export interface ComputeTerrainSuitabilityInput {
  mcpi: string
  candidateOpenArea: CandidateOpenAreaResult
  terrainData: TerrainData | null | undefined
  sampleSpacingFt?: number
  signal?: AbortSignal
}

export async function computeTerrainSuitability(
  input: ComputeTerrainSuitabilityInput
): Promise<TerrainSuitabilityResult> {
  const {
    mcpi,
    candidateOpenArea,
    terrainData,
    sampleSpacingFt: requestedSpacing = DEFAULT_TERRAIN_SAMPLE_SPACING_FT,
    signal
  } = input

  const processingStart = performance.now()
  const cacheKey = buildSuitabilityCacheKey(mcpi, candidateOpenArea, requestedSpacing)
  const cached = terrainSuitabilityCache.get(cacheKey)
  if (cached) {
    if (import.meta.env.DEV) {
      console.log('[TerrainSuitabilityCacheAudit]', { mcpi, cacheHit: true, cacheKey })
    }
    return cached
  }

  if (!candidateOpenArea.candidateGeometry) {
    const empty: TerrainSuitabilityResult = {
      mcpi,
      status: 'skipped',
      sampleSpacingFt: requestedSpacing,
      sampledPointCount: 0,
      validSampleCount: 0,
      unavailableSampleCount: 0,
      preferredAreaAcres: 0,
      moderateAreaAcres: 0,
      challengingAreaAcres: 0,
      avoidAreaAcres: 0,
      insufficientDataAreaAcres: 0,
      preferredPercent: 0,
      moderatePercent: 0,
      challengingPercent: 0,
      avoidPercent: 0,
      insufficientDataPercent: 0,
      dominantClass: 'INSUFFICIENT_DATA',
      maxSampledSlopePct: null,
      meanSampledSlopePct: null,
      medianSampledSlopePct: null,
      suitabilityFeatures: { type: 'FeatureCollection', features: [] },
      audit: {
        mcpi,
        candidateAreaAcres: candidateOpenArea.candidateAreaAcres,
        requestedSampleSpacingFt: requestedSpacing,
        effectiveSampleSpacingFt: requestedSpacing,
        sampledPointCount: 0,
        validSampleCount: 0,
        unavailableSampleCount: 0,
        preferredAreaAcres: 0,
        moderateAreaAcres: 0,
        challengingAreaAcres: 0,
        avoidAreaAcres: 0,
        insufficientDataAreaAcres: 0,
        preferredPercent: 0,
        moderatePercent: 0,
        challengingPercent: 0,
        avoidPercent: 0,
        insufficientDataPercent: 0,
        meanSlopePct: null,
        medianSlopePct: null,
        maxSlopePct: null,
        dominantClass: 'INSUFFICIENT_DATA',
        cacheHit: false,
        processingMs: 0,
        percentReconciliation: 0,
        invariantRespected: true,
        gridGenerationMs: 0,
        terrainSamplingMs: 0,
        slopeComputationMs: 0,
        cellGeometryMs: 0,
        areaAggregationMs: 0,
        totalProcessingMs: 0,
        terrainSampleRequests: 0,
        uniqueTerrainSamplePoints: 0,
        terrainCacheHits: 0,
        terrainCacheMisses: 0,
        terrainCacheHitPercent: 0,
        contourFeatureCount: 0,
        boundaryCellCount: 0,
        interiorCellCount: 0,
        clippedCellCount: 0
      }
    }
    return empty
  }

  if (!terrainData || !terrainData.coverageAvailable || terrainData.contourCount === 0) {
    const empty = createInsufficientDataResult(
      mcpi,
      candidateOpenArea,
      requestedSpacing,
      processingStart
    )
    terrainSuitabilityCache.set(cacheKey, empty)
    return empty
  }

  const effectiveSpacing = computeEffectiveSpacing(candidateOpenArea.candidateGeometry, requestedSpacing)
  const candidateFeature = candidateOpenArea.candidateGeometry

  const bbox = safeTurfOp(() => turf.bbox(candidateFeature), null)
  if (!bbox) {
    const empty = createInsufficientDataResult(
      mcpi,
      candidateOpenArea,
      effectiveSpacing,
      processingStart
    )
    terrainSuitabilityCache.set(cacheKey, empty)
    return empty
  }

  const candidateAreaSqM = safeTurfOp(() => turf.area(candidateFeature), 0)
  const candidateAreaAcres = sqMToAcres(candidateAreaSqM)

  const lat = (bbox[1] + bbox[3]) / 2
  const { latScale, lonScale } = localScaleFactors(lat)
  const lonStep = effectiveSpacing / lonScale
  const latStep = effectiveSpacing / latScale
  const halfLon = lonStep / 2
  const halfLat = latStep / 2

  const points: number[][] = []
  let lon = bbox[0] + halfLon
  while (lon < bbox[2]) {
    let latCursor = bbox[1] + halfLat
    while (latCursor < bbox[3]) {
      const point = [lon, latCursor]
      if (pointInsideFeature(point, candidateFeature)) {
        points.push(point)
      }
      latCursor += latStep
    }
    lon += lonStep
  }

  const sampleCache = new Map<string, TerrainSample>()
  const cells: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, TerrainSuitabilityCellProperties>[] = []
  const classAreaSqM: Record<TerrainSuitabilityClass, number> = {
    PREFERRED: 0,
    MODERATE: 0,
    CHALLENGING: 0,
    AVOID: 0,
    INSUFFICIENT_DATA: 0
  }
  let validSlopeCount = 0
  let unavailableCount = 0
  const slopeValues: number[] = []

  const tGrid0 = performance.now()
  const contourIndex = buildContourGridIndex(terrainData.contours, lat)
  const sampleStats = { requests: 0, hits: 0, misses: 0 }
  const uniquePointsMap = new Map<string, number[]>()
  const centerKeys: string[] = []

  for (let i = 0; i < points.length; i++) {
    const k = sampleKey(points[i])
    centerKeys.push(k)
    uniquePointsMap.set(k, points[i])
  }

  const offsetKeys: (string | null)[][] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    const dirs: (string | null)[] = []
    for (const bearing of SLOPE_DIRECTIONS) {
      const off = rhumbDestinationFt(point, SLOPE_SAMPLE_FT, bearing)
      if (off) {
        const k = sampleKey(off)
        uniquePointsMap.set(k, off)
        dirs.push(k)
      } else {
        dirs.push(null)
      }
    }
    offsetKeys.push(dirs)
  }
  const gridGenerationMs = Math.round(performance.now() - tGrid0)

  const tSampling0 = performance.now()
  const uniqueSamplePoints = Array.from(uniquePointsMap.values())
  for (let i = 0; i < uniqueSamplePoints.length; i++) {
    if (i > 0 && i % YIELD_INTERVAL === 0) {
      await yieldIfNeeded(signal)
    }
    const p = uniqueSamplePoints[i]
    const s = sampleTerrainWithIndex(p, terrainData, contourIndex, sampleCache, sampleStats)
    sampleCache.set(sampleKey(p), s)
  }
  const terrainSamplingMs = Math.round(performance.now() - tSampling0)

  const tSlope0 = performance.now()
  const slopePcts: number[] = new Array(points.length).fill(Infinity)
  for (let i = 0; i < points.length; i++) {
    const key = centerKeys[i]
    const center = sampleCache.get(key)!
    if (center.elevationFt === null || center.confidence === 'UNAVAILABLE') {
      slopePcts[i] = Infinity
      continue
    }
    let maxDiff = 0
    const offsets = offsetKeys[i]
    for (let j = 0; j < SLOPE_DIRECTIONS.length; j++) {
      const ok = offsets[j]
      if (!ok) continue
      const s = sampleCache.get(ok)!
      if (s.elevationFt !== null) {
        maxDiff = Math.max(maxDiff, Math.abs(s.elevationFt - center.elevationFt))
      }
    }
    slopePcts[i] = (maxDiff / (2 * SLOPE_SAMPLE_FT)) * 100
  }
  const slopeComputationMs = Math.round(performance.now() - tSlope0)

  const tCell0 = performance.now()
  let boundaryCellCount = 0
  let interiorCellCount = 0
  let clippedCellCount = 0
  const fullCellAreaM2 = (2 * halfLon * lonScale) * (2 * halfLat * latScale) * 0.092903

  for (let i = 0; i < points.length; i++) {
    const point = points[i]

    if (i > 0 && i % YIELD_INTERVAL === 0) {
      await yieldIfNeeded(signal)
    }

    const centerSample = sampleCache.get(centerKeys[i])!
    const slopePct = slopePcts[i]
    let terrainClass: TerrainSuitabilityClass

    if (!Number.isFinite(slopePct)) {
      terrainClass = 'INSUFFICIENT_DATA'
      unavailableCount++
    } else {
      validSlopeCount++
      slopeValues.push(slopePct)
      terrainClass = classifySlope(slopePct)
    }

    const square = buildSquareCell(point, halfLon, halfLat)
    const isWithin = safeTurfOp(() => turf.booleanWithin(square as any, candidateFeature as any), false)
    let cell: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
    let cellAreaM2: number

    if (isWithin) {
      cell = square
      cellAreaM2 = fullCellAreaM2
      interiorCellCount++
    } else {
      boundaryCellCount++
      const clipped = safeTurfOp(() => {
        const inter = turf.intersect(square as any, candidateFeature as any)
        if (inter && (inter as any).geometry) return inter as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
        return null
      }, null)
      if (clipped && (clipped as any).geometry) {
        cell = clipped
        clippedCellCount++
      } else {
        cell = square
      }
      cellAreaM2 = safeTurfOp(() => turf.area(cell), 0)
    }

    if (cellAreaM2 < MIN_CELL_AREA_SQ_FT * 0.092903) continue

    classAreaSqM[terrainClass] += cellAreaM2

    const properties: TerrainSuitabilityCellProperties = {
      terrainClass,
      slopePct: Number.isFinite(slopePct) ? round3(slopePct) : null,
      elevationFt: centerSample.elevationFt,
      confidence: centerSample.confidence,
      conceptualOnly: true
    }

    cells.push({
      ...cell,
      properties
    })
  }
  const cellGeometryMs = Math.round(performance.now() - tCell0)

  await yieldIfNeeded(signal)

  const tArea0 = performance.now()
  const totalClassifiedSqM = Object.values(classAreaSqM).reduce((s, v) => s + v, 0)
  const totalClassifiedAcres = sqMToAcres(totalClassifiedSqM)

  const preferredAreaAcres = round3(sqMToAcres(classAreaSqM.PREFERRED))
  const moderateAreaAcres = round3(sqMToAcres(classAreaSqM.MODERATE))
  const challengingAreaAcres = round3(sqMToAcres(classAreaSqM.CHALLENGING))
  const avoidAreaAcres = round3(sqMToAcres(classAreaSqM.AVOID))
  const insufficientDataAreaAcres = round3(sqMToAcres(classAreaSqM.INSUFFICIENT_DATA))

  const percentDenominator = candidateAreaAcres > 0 ? candidateAreaAcres : totalClassifiedAcres
  const preferredPercent = percentDenominator > 0 ? round3((preferredAreaAcres / percentDenominator) * 100) : 0
  const moderatePercent = percentDenominator > 0 ? round3((moderateAreaAcres / percentDenominator) * 100) : 0
  const challengingPercent = percentDenominator > 0 ? round3((challengingAreaAcres / percentDenominator) * 100) : 0
  const avoidPercent = percentDenominator > 0 ? round3((avoidAreaAcres / percentDenominator) * 100) : 0
  const insufficientDataPercent = percentDenominator > 0 ? round3((insufficientDataAreaAcres / percentDenominator) * 100) : 0

  const meanSlopePct = slopeValues.length > 0 ? round3(slopeValues.reduce((s, v) => s + v, 0) / slopeValues.length) : null
  const medianSlopePct = slopeValues.length > 0 ? round3(median(slopeValues) ?? 0) : null
  const maxSlopePct = slopeValues.length > 0 ? round3(Math.max(...slopeValues)) : null

  const areaRank = [
    { class: 'PREFERRED' as TerrainSuitabilityClass, area: classAreaSqM.PREFERRED },
    { class: 'MODERATE' as TerrainSuitabilityClass, area: classAreaSqM.MODERATE },
    { class: 'CHALLENGING' as TerrainSuitabilityClass, area: classAreaSqM.CHALLENGING },
    { class: 'AVOID' as TerrainSuitabilityClass, area: classAreaSqM.AVOID },
    { class: 'INSUFFICIENT_DATA' as TerrainSuitabilityClass, area: classAreaSqM.INSUFFICIENT_DATA }
  ].sort((a, b) => b.area - a.area)
  const dominantClass = areaRank[0].area > 0 ? areaRank[0].class : 'INSUFFICIENT_DATA'

  const percentReconciliation = candidateAreaAcres > 0 ? round3((totalClassifiedAcres / candidateAreaAcres) * 100) : 0
  const invariantRespected = Math.abs(percentReconciliation - 100) <= AREA_RECONCILIATION_TOLERANCE_PCT
  const areaAggregationMs = Math.round(performance.now() - tArea0)
  const processingMs = Math.round(performance.now() - processingStart)
  const totalProcessingMs = processingMs

  const audit: TerrainSuitabilityAudit = {
    mcpi,
    candidateAreaAcres: round3(candidateAreaAcres),
    requestedSampleSpacingFt: requestedSpacing,
    effectiveSampleSpacingFt: effectiveSpacing,
    sampledPointCount: points.length,
    validSampleCount: validSlopeCount,
    unavailableSampleCount: unavailableCount,
    preferredAreaAcres,
    moderateAreaAcres,
    challengingAreaAcres,
    avoidAreaAcres,
    insufficientDataAreaAcres,
    preferredPercent,
    moderatePercent,
    challengingPercent,
    avoidPercent,
    insufficientDataPercent,
    meanSlopePct,
    medianSlopePct,
    maxSlopePct,
    dominantClass,
    cacheHit: false,
    processingMs,
    percentReconciliation,
    invariantRespected,
    gridGenerationMs,
    terrainSamplingMs,
    slopeComputationMs,
    cellGeometryMs,
    areaAggregationMs,
    totalProcessingMs,
    terrainSampleRequests: sampleStats.requests,
    uniqueTerrainSamplePoints: uniqueSamplePoints.length,
    terrainCacheHits: sampleStats.hits,
    terrainCacheMisses: sampleStats.misses,
    terrainCacheHitPercent: sampleStats.requests > 0 ? round3((sampleStats.hits / sampleStats.requests) * 100) : 0,
    contourFeatureCount: terrainData.contours.length,
    boundaryCellCount,
    interiorCellCount,
    clippedCellCount
  }

  const result: TerrainSuitabilityResult = {
    mcpi,
    status: 'completed',
    sampleSpacingFt: effectiveSpacing,
    sampledPointCount: points.length,
    validSampleCount: validSlopeCount,
    unavailableSampleCount: unavailableCount,
    preferredAreaAcres,
    moderateAreaAcres,
    challengingAreaAcres,
    avoidAreaAcres,
    insufficientDataAreaAcres,
    preferredPercent,
    moderatePercent,
    challengingPercent,
    avoidPercent,
    insufficientDataPercent,
    dominantClass,
    maxSampledSlopePct: maxSlopePct,
    meanSampledSlopePct: meanSlopePct,
    medianSampledSlopePct: medianSlopePct,
    suitabilityFeatures: { type: 'FeatureCollection', features: cells },
    audit
  }

  if (import.meta.env.DEV) {
    console.log('[TerrainSuitabilityAudit]', audit)
  }

  terrainSuitabilityCache.set(cacheKey, result)
  return result
}

function createInsufficientDataResult(
  mcpi: string,
  candidateOpenArea: CandidateOpenAreaResult,
  sampleSpacingFt: number,
  processingStart: number
): TerrainSuitabilityResult {
  const processingMs = Math.round(performance.now() - processingStart)
  const candidateAreaAcres = round3(candidateOpenArea.candidateAreaAcres)
  const audit: TerrainSuitabilityAudit = {
    mcpi,
    candidateAreaAcres,
    requestedSampleSpacingFt: sampleSpacingFt,
    effectiveSampleSpacingFt: sampleSpacingFt,
    sampledPointCount: 0,
    validSampleCount: 0,
    unavailableSampleCount: 0,
    preferredAreaAcres: 0,
    moderateAreaAcres: 0,
    challengingAreaAcres: 0,
    avoidAreaAcres: 0,
    insufficientDataAreaAcres: candidateAreaAcres,
    preferredPercent: 0,
    moderatePercent: 0,
    challengingPercent: 0,
    avoidPercent: 0,
    insufficientDataPercent: 100,
    meanSlopePct: null,
    medianSlopePct: null,
    maxSlopePct: null,
    dominantClass: 'INSUFFICIENT_DATA',
    cacheHit: false,
    processingMs,
    percentReconciliation: 100,
    invariantRespected: true,
    gridGenerationMs: 0,
    terrainSamplingMs: 0,
    slopeComputationMs: 0,
    cellGeometryMs: 0,
    areaAggregationMs: 0,
    totalProcessingMs: processingMs,
    terrainSampleRequests: 0,
    uniqueTerrainSamplePoints: 0,
    terrainCacheHits: 0,
    terrainCacheMisses: 0,
    terrainCacheHitPercent: 0,
    contourFeatureCount: 0,
    boundaryCellCount: 0,
    interiorCellCount: 0,
    clippedCellCount: 0
  }

  return {
    mcpi,
    status: 'skipped',
    sampleSpacingFt,
    sampledPointCount: 0,
    validSampleCount: 0,
    unavailableSampleCount: 0,
    preferredAreaAcres: 0,
    moderateAreaAcres: 0,
    challengingAreaAcres: 0,
    avoidAreaAcres: 0,
    insufficientDataAreaAcres: candidateAreaAcres,
    preferredPercent: 0,
    moderatePercent: 0,
    challengingPercent: 0,
    avoidPercent: 0,
    insufficientDataPercent: 100,
    dominantClass: 'INSUFFICIENT_DATA',
    maxSampledSlopePct: null,
    meanSampledSlopePct: null,
    medianSampledSlopePct: null,
    suitabilityFeatures: { type: 'FeatureCollection', features: [] },
    audit
  }
}
