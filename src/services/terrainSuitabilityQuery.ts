import * as turf from '@turf/turf'
import { ENABLE_DEEP_GENERATION_PROFILING } from '../lib/perf'
import type {
  TerrainSuitabilityResult,
  TerrainSuitabilityClass,
  TerrainSuitabilityCellProperties,
  TerrainPointQueryResult,
  TerrainGeometryQueryResult,
  TerrainLineQueryResult,
  TerrainPlacementEvaluation,
  PrimaryRoadTerrainScoring
} from '../types/terrain'

const FEET_TO_METERS = 0.3048
export const TERRAIN_AVOID_TOLERANCE_PERCENT = 2
export const TERRAIN_PLACEMENT_WEIGHTS: Record<TerrainSuitabilityClass, number> = {
  PREFERRED: 1.00,
  MODERATE: 0.75,
  CHALLENGING: 0.30,
  AVOID: 0,
  INSUFFICIENT_DATA: 0.45
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export const TERRAIN_CLASS_SEVERITY: TerrainSuitabilityClass[] = [
  'PREFERRED',
  'MODERATE',
  'CHALLENGING',
  'AVOID',
  'INSUFFICIENT_DATA'
]

const SEVERITY_RANK: Record<TerrainSuitabilityClass, number> = TERRAIN_CLASS_SEVERITY.reduce(
  (acc, c, i) => { acc[c] = i; return acc },
  {} as Record<TerrainSuitabilityClass, number>
)

interface IndexedCell {
  feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, TerrainSuitabilityCellProperties>
  index: number
  bbox: number[]
  areaM2: number
}

interface CellIndex {
  cells: IndexedCell[]
  cellByIndex: (IndexedCell | undefined)[]
  bbox: number[] | null
  spatialGrid: Map<string, number[]>
  gridSizeX: number
  gridSizeY: number
}

const cellIndexCache = new WeakMap<TerrainSuitabilityResult, CellIndex>()

// Generation-scoped terrain line-query cache to avoid re-sampling identical centerlines.
const terrainLineQueryCache = new WeakMap<TerrainSuitabilityResult, Map<string, PrimaryRoadTerrainScoring>>()
let terrainLineQueryRequests = 0
let terrainLineQueryCacheHits = 0
let terrainLineQueryCacheMisses = 0
let terrainLineQueryMsAvoided = 0
let terrainCellIndexBuildCount = 0
const terrainCellIndexBuiltSet = new Set<TerrainSuitabilityResult>()

function normalizeLineCoordinates(coords: number[][]): string {
  return JSON.stringify(coords.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]))
}

function makeLineSignature(line: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString): string {
  const coordinates = (line as any).coordinates ?? (line as any).geometry?.coordinates
  if (!coordinates || !Array.isArray(coordinates)) return 'invalid'
  return normalizeLineCoordinates(coordinates as number[][])
}

export function getTerrainLineQueryAudit(): { requests: number; uniqueQueries: number; cacheHits: number; cacheMisses: number; hitPercent: number; msAvoidedEstimate: number; cellIndexBuildCount: number } {
  return {
    requests: terrainLineQueryRequests,
    uniqueQueries: terrainLineQueryCacheMisses,
    cacheHits: terrainLineQueryCacheHits,
    cacheMisses: terrainLineQueryCacheMisses,
    hitPercent: terrainLineQueryRequests > 0 ? round3((terrainLineQueryCacheHits / terrainLineQueryRequests) * 100) : 0,
    msAvoidedEstimate: round3(terrainLineQueryMsAvoided),
    cellIndexBuildCount: terrainCellIndexBuildCount
  }
}

export function resetTerrainLineQueryCache(): void {
  terrainLineQueryRequests = 0
  terrainLineQueryCacheHits = 0
  terrainLineQueryCacheMisses = 0
  terrainLineQueryMsAvoided = 0
  terrainCellIndexBuildCount = 0
  terrainCellIndexBuiltSet.clear()
}

// Pass 11 lightweight terrain query counters
let terrainGeometryQueries = 0
let terrainPointQueries = 0
let terrainSpatialIndexQueries = 0
let terrainSpatialIndexCandidateCells = 0
let terrainLegacyFullScanFallbacks = 0
let terrainCellsAvailable = 0
let terrainCellsActuallyTested = 0
let terrainCellsSkippedBySpatialIndex = 0
let terrainGeometryValidationCount = 0
let terrainPointValidationCount = 0
const TERRAIN_GEOMETRY_VALIDATION_LIMIT = 5
const TERRAIN_POINT_VALIDATION_LIMIT = 10

const terrainGeometryQueryByCaller: Record<string, number> = {}
const terrainPointQueryByCaller: Record<string, number> = {}
const terrainLineQueryByCaller: Record<string, number> = {}

function recordGeometryQuery(caller = 'unknown') {
  terrainGeometryQueries++
  terrainGeometryQueryByCaller[caller] = (terrainGeometryQueryByCaller[caller] || 0) + 1
}

function recordPointQuery(caller = 'unknown') {
  terrainPointQueries++
  terrainPointQueryByCaller[caller] = (terrainPointQueryByCaller[caller] || 0) + 1
}

function recordLineQuery(caller = 'unknown') {
  terrainLineQueryByCaller[caller] = (terrainLineQueryByCaller[caller] || 0) + 1
}

export function resetTerrainQueryCounters(): void {
  terrainGeometryQueries = 0
  terrainPointQueries = 0
  terrainSpatialIndexQueries = 0
  terrainSpatialIndexCandidateCells = 0
  terrainLegacyFullScanFallbacks = 0
  terrainCellsAvailable = 0
  terrainCellsActuallyTested = 0
  terrainCellsSkippedBySpatialIndex = 0
  terrainGeometryValidationCount = 0
  terrainPointValidationCount = 0
  for (const k of Object.keys(terrainGeometryQueryByCaller)) delete terrainGeometryQueryByCaller[k]
  for (const k of Object.keys(terrainPointQueryByCaller)) delete terrainPointQueryByCaller[k]
  for (const k of Object.keys(terrainLineQueryByCaller)) delete terrainLineQueryByCaller[k]
}

export function getTerrainQueryCounters(): {
  terrainGeometryQueries: number
  terrainPointQueries: number
  terrainLineQueries: number
  terrainSpatialIndexQueries: number
  terrainSpatialIndexCandidateCells: number
  terrainLegacyFullScanFallbacks: number
  terrainCellsAvailable: number
  terrainCellsActuallyTested: number
  terrainCellsSkippedBySpatialIndex: number
  terrainCellIndexBuildCount: number
  geometryQueryByCaller: Record<string, number>
  pointQueryByCaller: Record<string, number>
  lineQueryByCaller: Record<string, number>
} {
  return {
    terrainGeometryQueries,
    terrainPointQueries,
    terrainLineQueries: terrainLineQueryRequests,
    terrainSpatialIndexQueries,
    terrainSpatialIndexCandidateCells,
    terrainLegacyFullScanFallbacks,
    terrainCellsAvailable,
    terrainCellsActuallyTested,
    terrainCellsSkippedBySpatialIndex,
    terrainCellIndexBuildCount,
    geometryQueryByCaller: { ...terrainGeometryQueryByCaller },
    pointQueryByCaller: { ...terrainPointQueryByCaller },
    lineQueryByCaller: { ...terrainLineQueryByCaller }
  }
}

export function getTerrainCellIndexInfo(terrainSuitability: TerrainSuitabilityResult | null | undefined): {
  cellIndexExists: boolean
  cellCount: number
  spatialGridSize: number
  bbox: number[] | null
} {
  const index = buildCellIndex(terrainSuitability)
  return {
    cellIndexExists: !!index,
    cellCount: index ? index.cells.length : 0,
    spatialGridSize: index ? index.spatialGrid.size : 0,
    bbox: index ? index.bbox : null
  }
}

function ensureFeature(
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.Geometry
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!geometry) return null
  if ((geometry as any).type === 'Feature') return geometry as GeoJSON.Feature<GeoJSON.Geometry>
  if ((geometry as any).geometry) {
    return geometry as GeoJSON.Feature<GeoJSON.Geometry>
  }
  if ((geometry as any).type) {
    try {
      return { type: 'Feature', properties: {}, geometry: geometry as GeoJSON.Geometry }
    } catch {
      return null
    }
  }
  return null
}

function ensurePointFeature(
  point: GeoJSON.Feature<GeoJSON.Point> | GeoJSON.Point | number[]
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!point) return null
  if (Array.isArray(point) && point.length >= 2) {
    return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } }
  }
  if ((point as any).type === 'Feature') {
    return point as GeoJSON.Feature<GeoJSON.Point>
  }
  if ((point as any).type === 'Point') {
    return { type: 'Feature', properties: {}, geometry: point as GeoJSON.Point }
  }
  return null
}

function buildCellIndex(terrainSuitability: TerrainSuitabilityResult | null | undefined): CellIndex | null {
  if (!terrainSuitability) return null
  if (terrainSuitability.status !== 'completed') return null
  const cached = cellIndexCache.get(terrainSuitability)
  if (cached) return cached
  const cells = terrainSuitability.suitabilityFeatures?.features
  if (!cells || cells.length === 0) return null

  const indexed: IndexedCell[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let totalWidth = 0, totalHeight = 0

  for (let i = 0; i < cells.length; i++) {
    const feature = cells[i] as unknown as GeoJSON.Feature<
      GeoJSON.Polygon | GeoJSON.MultiPolygon,
      TerrainSuitabilityCellProperties
    >
    if (!feature.geometry) continue
    const bbox = safeTurfOp(() => turf.bbox(feature) as number[], null)
    if (!bbox || bbox.length < 4) continue
    const areaM2 = safeTurfOp(() => turf.area(feature), 0)
    if (areaM2 <= 0) continue
    indexed.push({ feature, index: i, bbox, areaM2 })
    totalWidth += bbox[2] - bbox[0]
    totalHeight += bbox[3] - bbox[1]

    minX = Math.min(minX, bbox[0])
    minY = Math.min(minY, bbox[1])
    maxX = Math.max(maxX, bbox[2])
    maxY = Math.max(maxY, bbox[3])
  }

  if (indexed.length === 0) return null
  const bbox = [minX, minY, maxX, maxY]
  const cellByIndex: (IndexedCell | undefined)[] = new Array(cells.length)
  for (const c of indexed) cellByIndex[c.index] = c

  // Grid cell dimensions based on average terrain cell size to keep the
  // coarse lookup conservative but compact.
  const avgWidth = totalWidth / indexed.length
  const avgHeight = totalHeight / indexed.length
  const gridSizeX = avgWidth > 0 ? avgWidth : 1
  const gridSizeY = avgHeight > 0 ? avgHeight : 1
  const spatialGrid = new Map<string, number[]>()

  for (const c of indexed) {
    const minGx = Math.floor(c.bbox[0] / gridSizeX)
    const maxGx = Math.ceil(c.bbox[2] / gridSizeX)
    const minGy = Math.floor(c.bbox[1] / gridSizeY)
    const maxGy = Math.ceil(c.bbox[3] / gridSizeY)
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const key = `${gx},${gy}`
        const list = spatialGrid.get(key) ?? []
        if (list.length === 0) spatialGrid.set(key, list)
        list.push(c.index)
      }
    }
  }

  const index: CellIndex = { cells: indexed, cellByIndex, bbox, spatialGrid, gridSizeX, gridSizeY }
  cellIndexCache.set(terrainSuitability, index)
  if (!terrainCellIndexBuiltSet.has(terrainSuitability)) {
    terrainCellIndexBuiltSet.add(terrainSuitability)
    terrainCellIndexBuildCount++
  }
  return index
}

function getCandidatesFromGrid(index: CellIndex, queryBbox: number[]): IndexedCell[] | null {
  if (!queryBbox || queryBbox.length < 4) return null
  if (index.spatialGrid.size === 0) return null

  const minGx = Math.floor(queryBbox[0] / index.gridSizeX)
  const maxGx = Math.ceil(queryBbox[2] / index.gridSizeX)
  const minGy = Math.floor(queryBbox[1] / index.gridSizeY)
  const maxGy = Math.ceil(queryBbox[3] / index.gridSizeY)

  const seen = new Set<number>()
  const candidateIndices: number[] = []
  for (let gx = minGx; gx <= maxGx; gx++) {
    for (let gy = minGy; gy <= maxGy; gy++) {
      const list = index.spatialGrid.get(`${gx},${gy}`)
      if (!list) continue
      for (const idx of list) {
        if (seen.has(idx)) continue
        seen.add(idx)
        candidateIndices.push(idx)
      }
    }
  }

  if (candidateIndices.length === 0) return null
  candidateIndices.sort((a, b) => a - b)
  return candidateIndices.map(idx => index.cellByIndex[idx]).filter((c): c is IndexedCell => c !== undefined)
}

function evaluatePointForCells(
  pt: GeoJSON.Feature<GeoJSON.Point>,
  cells: IndexedCell[]
): TerrainPointQueryResult {
  for (const cell of cells) {
    if (!pointInBbox(pt, cell.bbox)) continue
    const inside = safeTurfOp(
      () => turf.booleanPointInPolygon(pt as any, cell.feature as any),
      false
    )
    terrainCellsActuallyTested++
    if (inside) {
      const props = cell.feature.properties
      return {
        available: true,
        class: props.terrainClass,
        slopePct: props.slopePct,
        elevationFt: props.elevationFt,
        confidence: props.confidence,
        sourceCellIndex: cell.index
      }
    }
  }
  return emptyPointResult()
}

function evaluateGeometryForCells(
  feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  totalAreaM2: number,
  targetBbox: number[] | null,
  cells: IndexedCell[]
): TerrainGeometryQueryResult {
  const classAreaM2: Record<TerrainSuitabilityClass, number> = {
    PREFERRED: 0,
    MODERATE: 0,
    CHALLENGING: 0,
    AVOID: 0,
    INSUFFICIENT_DATA: 0
  }

  let weightedSlopeSum = 0
  let slopeSampleM2 = 0
  let maxSlopePct: number | null = null
  let sampledCellCount = 0
  let intersectedCellCount = 0

  for (const cell of cells) {
    if (targetBbox && !bboxIntersects(cell.bbox, targetBbox)) continue
    sampledCellCount++
    terrainCellsActuallyTested++

    const overlap = safeTurfOp(
      () => (turf.intersect as any)(turf.featureCollection([cell.feature as any, feature as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null,
      null
    )
    if (!overlap || !overlap.geometry) continue

    const overlapM2 = safeTurfOp(() => turf.area(overlap), 0)
    if (overlapM2 <= 0) continue

    intersectedCellCount++
    const cls = cell.feature.properties.terrainClass
    classAreaM2[cls] += overlapM2

    const slope = cell.feature.properties.slopePct
    if (slope !== null && Number.isFinite(slope)) {
      weightedSlopeSum += slope * overlapM2
      slopeSampleM2 += overlapM2
      if (maxSlopePct === null || slope > maxSlopePct) {
        maxSlopePct = slope
      }
    }
  }

  const classifiedM2 = Object.values(classAreaM2).reduce((s, v) => s + v, 0)
  const unclassifiedM2 = Math.max(0, totalAreaM2 - classifiedM2)
  classAreaM2['INSUFFICIENT_DATA'] += unclassifiedM2

  const percentages: Record<TerrainSuitabilityClass, number> = {
    PREFERRED: round3((classAreaM2.PREFERRED / totalAreaM2) * 100),
    MODERATE: round3((classAreaM2.MODERATE / totalAreaM2) * 100),
    CHALLENGING: round3((classAreaM2.CHALLENGING / totalAreaM2) * 100),
    AVOID: round3((classAreaM2.AVOID / totalAreaM2) * 100),
    INSUFFICIENT_DATA: round3((classAreaM2.INSUFFICIENT_DATA / totalAreaM2) * 100)
  }

  const sum = Object.values(percentages).reduce((s, v) => s + v, 0)
  if (sum !== 0 && sum !== 100) {
    const diff = round3(100 - sum)
    percentages.INSUFFICIENT_DATA = round3(percentages.INSUFFICIENT_DATA + diff)
  }

  return {
    available: true,
    preferredPercent: percentages.PREFERRED,
    moderatePercent: percentages.MODERATE,
    challengingPercent: percentages.CHALLENGING,
    avoidPercent: percentages.AVOID,
    insufficientDataPercent: percentages.INSUFFICIENT_DATA,
    dominantClass: resolveDominantClass(percentages),
    meanSlopePct: slopeSampleM2 > 0 ? round3(weightedSlopeSum / slopeSampleM2) : null,
    maxSlopePct,
    sampledCellCount,
    intersectedCellCount
  }
}

function bboxIntersects(a: number[], b: number[]): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return true
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function pointInBbox(point: GeoJSON.Feature<GeoJSON.Point>, bbox: number[]): boolean {
  if (!bbox || bbox.length < 4) return true
  const [x, y] = point.geometry.coordinates
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]
}

function resolveDominantClass(
  percentages: Record<TerrainSuitabilityClass, number>
): TerrainSuitabilityClass {
  let dominant: TerrainSuitabilityClass = 'INSUFFICIENT_DATA'
  let best = -1
  for (const cls of TERRAIN_CLASS_SEVERITY) {
    const pct = percentages[cls]
    if (pct > best || (pct === best && SEVERITY_RANK[cls] > SEVERITY_RANK[dominant])) {
      best = pct
      dominant = cls
    }
  }
  return best > 0 ? dominant : 'INSUFFICIENT_DATA'
}

function emptyPointResult(): TerrainPointQueryResult {
  return {
    available: false,
    class: 'INSUFFICIENT_DATA',
    slopePct: null,
    elevationFt: null,
    confidence: null,
    sourceCellIndex: null
  }
}

export function getTerrainSuitabilityAtPoint(
  point: GeoJSON.Feature<GeoJSON.Point> | GeoJSON.Point | number[],
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  caller = 'unknown'
): TerrainPointQueryResult {
  recordPointQuery(caller)
  const pt = ensurePointFeature(point)
  if (!pt) return emptyPointResult()

  const index = buildCellIndex(terrainSuitability)
  if (!index) return emptyPointResult()
  terrainCellsAvailable += index.cells.length

  if (index.bbox && !pointInBbox(pt, index.bbox)) {
    return emptyPointResult()
  }

  const [x, y] = pt.geometry.coordinates
  const pointBbox = [x, y, x, y]
  const candidates = getCandidatesFromGrid(index, pointBbox)
  let cellsToTest: IndexedCell[]
  if (candidates) {
    terrainSpatialIndexQueries++
    terrainSpatialIndexCandidateCells += candidates.length
    terrainCellsSkippedBySpatialIndex += index.cells.length - candidates.length
    cellsToTest = candidates
  } else {
    terrainLegacyFullScanFallbacks++
    cellsToTest = index.cells
  }

  const result = evaluatePointForCells(pt, cellsToTest)

  if (import.meta.env.DEV && terrainPointValidationCount < TERRAIN_POINT_VALIDATION_LIMIT) {
    terrainPointValidationCount++
    const legacy = evaluatePointForCells(pt, index.cells)
    if (
      legacy.available !== result.available ||
      legacy.class !== result.class ||
      legacy.sourceCellIndex !== result.sourceCellIndex ||
      legacy.slopePct !== result.slopePct
    ) {
      console.error('[TerrainSpatialIndexMismatch]', {
        queryType: 'point',
        optimized: result,
        legacy,
        point: pt.geometry.coordinates,
        candidateCount: cellsToTest.length,
        legacyCount: index.cells.length
      })
    }
  }

  return result
}

export function getTerrainSuitabilityForGeometry(
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.Geometry,
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  caller = 'unknown'
): TerrainGeometryQueryResult {
  recordGeometryQuery(caller)
  const feature = ensureFeature(geometry)
  if (!feature?.geometry) {
    return {
      available: false,
      preferredPercent: 0,
      moderatePercent: 0,
      challengingPercent: 0,
      avoidPercent: 0,
      insufficientDataPercent: 100,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampledCellCount: 0,
      intersectedCellCount: 0
    }
  }

  if (feature.geometry.type === 'LineString') {
    const lineResult = getTerrainSuitabilityForLine(feature as any, terrainSuitability, caller)
    return {
      available: lineResult.available,
      preferredPercent: round3(lineResult.preferredFraction * 100),
      moderatePercent: round3(lineResult.moderateFraction * 100),
      challengingPercent: round3(lineResult.challengingFraction * 100),
      avoidPercent: round3(lineResult.avoidFraction * 100),
      insufficientDataPercent: round3(lineResult.insufficientDataFraction * 100),
      dominantClass: lineResult.dominantClass,
      meanSlopePct: lineResult.meanSlopePct,
      maxSlopePct: lineResult.maxSlopePct,
      sampledCellCount: lineResult.sampleCount,
      intersectedCellCount: lineResult.sampleCount
    }
  }

  const index = buildCellIndex(terrainSuitability)
  if (!index || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return {
      available: false,
      preferredPercent: 0,
      moderatePercent: 0,
      challengingPercent: 0,
      avoidPercent: 0,
      insufficientDataPercent: 100,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampledCellCount: 0,
      intersectedCellCount: 0
    }
  }

  terrainCellsAvailable += index.cells.length

  const totalAreaM2 = safeTurfOp(() => turf.area(feature), 0)
  if (totalAreaM2 <= 0) {
    return {
      available: false,
      preferredPercent: 0,
      moderatePercent: 0,
      challengingPercent: 0,
      avoidPercent: 0,
      insufficientDataPercent: 100,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampledCellCount: 0,
      intersectedCellCount: 0
    }
  }

  const targetBbox = safeTurfOp(() => turf.bbox(feature) as number[], null)
  const candidates = targetBbox ? getCandidatesFromGrid(index, targetBbox) : null
  let cellsToTest: IndexedCell[]
  if (candidates) {
    terrainSpatialIndexQueries++
    terrainSpatialIndexCandidateCells += candidates.length
    terrainCellsSkippedBySpatialIndex += index.cells.length - candidates.length
    cellsToTest = candidates
  } else {
    terrainLegacyFullScanFallbacks++
    cellsToTest = index.cells
  }

  const typedFeature = feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  const result = evaluateGeometryForCells(typedFeature, totalAreaM2, targetBbox, cellsToTest)

  if (import.meta.env.DEV && terrainGeometryValidationCount < TERRAIN_GEOMETRY_VALIDATION_LIMIT) {
    terrainGeometryValidationCount++
    const legacy = evaluateGeometryForCells(typedFeature, totalAreaM2, targetBbox, index.cells)
    if (
      legacy.preferredPercent !== result.preferredPercent ||
      legacy.moderatePercent !== result.moderatePercent ||
      legacy.challengingPercent !== result.challengingPercent ||
      legacy.avoidPercent !== result.avoidPercent ||
      legacy.insufficientDataPercent !== result.insufficientDataPercent ||
      legacy.dominantClass !== result.dominantClass ||
      legacy.meanSlopePct !== result.meanSlopePct ||
      legacy.maxSlopePct !== result.maxSlopePct
    ) {
      console.error('[TerrainSpatialIndexMismatch]', {
        queryType: 'geometry',
        optimized: result,
        legacy,
        targetBbox,
        candidateCount: cellsToTest.length,
        legacyCount: index.cells.length
      })
    }
  }

  return result
}

export function computeTerrainPlacementEvaluation(
  geometry: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.Geometry,
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  caller = 'unknown'
): TerrainPlacementEvaluation {
  const q = getTerrainSuitabilityForGeometry(geometry, terrainSuitability, caller)
  if (!q.available) {
    return {
      available: false,
      dominantClass: 'INSUFFICIENT_DATA',
      preferredPercent: 0,
      moderatePercent: 0,
      challengingPercent: 0,
      avoidPercent: 0,
      insufficientDataPercent: 100,
      placementScore: 0,
      avoidRejection: false,
      warning: 'Terrain suitability data is unavailable for placement evaluation.'
    }
  }
  const score = round3(
    (q.preferredPercent * TERRAIN_PLACEMENT_WEIGHTS.PREFERRED +
      q.moderatePercent * TERRAIN_PLACEMENT_WEIGHTS.MODERATE +
      q.challengingPercent * TERRAIN_PLACEMENT_WEIGHTS.CHALLENGING +
      q.insufficientDataPercent * TERRAIN_PLACEMENT_WEIGHTS.INSUFFICIENT_DATA) / 100
  )
  return {
    available: true,
    dominantClass: q.dominantClass,
    preferredPercent: q.preferredPercent,
    moderatePercent: q.moderatePercent,
    challengingPercent: q.challengingPercent,
    avoidPercent: q.avoidPercent,
    insufficientDataPercent: q.insufficientDataPercent,
    placementScore: score,
    avoidRejection: q.avoidPercent > TERRAIN_AVOID_TOLERANCE_PERCENT,
    warning: q.insufficientDataPercent > 0
      ? 'Terrain data was insufficient for part of the geometry.'
      : undefined
  }
}

// Primary road terrain-suitability scoring (Phase 7B.3A).
// Strongly penalizes AVOID and steep slopes; never rejects on its own.
const TERRAIN_ROAD_AVOID_TOLERANCE_FRACTION = TERRAIN_AVOID_TOLERANCE_PERCENT / 100
const TERRAIN_ROAD_AVOID_PENALTY_MULTIPLIER = 5
const TERRAIN_ROAD_SLOPE_MEAN_MODERATE_PCT = 6
const TERRAIN_ROAD_SLOPE_MEAN_STEEP_PCT = 12
const TERRAIN_ROAD_SLOPE_MAX_STEEP_PCT = 20
const TERRAIN_ROAD_SLOPE_MAX_SEVERE_PCT = 35
const TERRAIN_ROAD_MEAN_SLOPE_PENALTY_MODERATE = 0.05
const TERRAIN_ROAD_MEAN_SLOPE_PENALTY_STEEP = 0.12
const TERRAIN_ROAD_MAX_SLOPE_PENALTY_STEEP = 0.12
const TERRAIN_ROAD_MAX_SLOPE_PENALTY_SEVERE = 0.28
const TERRAIN_ROAD_MAX_TOTAL_PENALTY = 0.70

export function computeRoadTerrainScore(
  line: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString,
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  caller = 'unknown'
): PrimaryRoadTerrainScoring {
  recordLineQuery(caller)
  const timingEnabled = ENABLE_DEEP_GENERATION_PROFILING
  const q0 = timingEnabled ? performance.now() : 0
  let lineSignature: string | null = null
  terrainLineQueryRequests++
  if (terrainSuitability) {
    let perTerrain = terrainLineQueryCache.get(terrainSuitability)
    if (!perTerrain) {
      perTerrain = new Map<string, PrimaryRoadTerrainScoring>()
      terrainLineQueryCache.set(terrainSuitability, perTerrain)
    }
    lineSignature = makeLineSignature(line)
    const cached = perTerrain.get(lineSignature)
    if (cached) {
      terrainLineQueryCacheHits++
      if (timingEnabled) terrainLineQueryMsAvoided += cached.queryMs ?? 0
      return cached
    }
  }

  const lineResult = getTerrainSuitabilityForLine(line, terrainSuitability, caller)
  const queryMs = timingEnabled ? round3(performance.now() - q0) : 0
  if (!lineResult.available) {
    const result: PrimaryRoadTerrainScoring = {
      available: false,
      dominantClass: 'INSUFFICIENT_DATA',
      preferredFraction: 0,
      moderateFraction: 0,
      challengingFraction: 0,
      avoidFraction: 0,
      insufficientDataFraction: 1,
      meanSlopePct: null,
      maxSlopePct: null,
      terrainRoadScore: 1,
      rawWeightedScore: 0,
      slopePenalty: 0,
      avoidPenalty: 0,
      sampleCount: 0,
      queryMs
    }
    if (terrainSuitability && lineSignature) {
      terrainLineQueryCache.get(terrainSuitability)?.set(lineSignature, result)
      terrainLineQueryCacheMisses++
    }
    return result
  }

  const rawWeightedScore =
    lineResult.preferredFraction * TERRAIN_PLACEMENT_WEIGHTS.PREFERRED +
    lineResult.moderateFraction * TERRAIN_PLACEMENT_WEIGHTS.MODERATE +
    lineResult.challengingFraction * TERRAIN_PLACEMENT_WEIGHTS.CHALLENGING +
    lineResult.insufficientDataFraction * TERRAIN_PLACEMENT_WEIGHTS.INSUFFICIENT_DATA

  const excessAvoid = Math.max(0, lineResult.avoidFraction - TERRAIN_ROAD_AVOID_TOLERANCE_FRACTION)
  const avoidPenalty = Math.min(excessAvoid * TERRAIN_ROAD_AVOID_PENALTY_MULTIPLIER, 0.5)

  let slopePenalty = 0
  const mean = lineResult.meanSlopePct
  const max = lineResult.maxSlopePct
  if (mean !== null && Number.isFinite(mean)) {
    if (mean > TERRAIN_ROAD_SLOPE_MEAN_STEEP_PCT) {
      slopePenalty += TERRAIN_ROAD_MEAN_SLOPE_PENALTY_STEEP
    } else if (mean > TERRAIN_ROAD_SLOPE_MEAN_MODERATE_PCT) {
      slopePenalty += TERRAIN_ROAD_MEAN_SLOPE_PENALTY_MODERATE
    }
  }
  if (max !== null && Number.isFinite(max)) {
    if (max > TERRAIN_ROAD_SLOPE_MAX_SEVERE_PCT) {
      slopePenalty += TERRAIN_ROAD_MAX_SLOPE_PENALTY_SEVERE
    } else if (max > TERRAIN_ROAD_SLOPE_MAX_STEEP_PCT) {
      slopePenalty += TERRAIN_ROAD_MAX_SLOPE_PENALTY_STEEP
    }
  }

  slopePenalty = Math.min(slopePenalty, TERRAIN_ROAD_MAX_TOTAL_PENALTY)

  const terrainRoadScore = Math.max(0, Math.min(1, round3(rawWeightedScore - avoidPenalty - slopePenalty)))

  const result: PrimaryRoadTerrainScoring = {
    available: true,
    dominantClass: lineResult.dominantClass,
    preferredFraction: lineResult.preferredFraction,
    moderateFraction: lineResult.moderateFraction,
    challengingFraction: lineResult.challengingFraction,
    avoidFraction: lineResult.avoidFraction,
    insufficientDataFraction: lineResult.insufficientDataFraction,
    meanSlopePct: lineResult.meanSlopePct,
    maxSlopePct: lineResult.maxSlopePct,
    terrainRoadScore,
    rawWeightedScore: round3(rawWeightedScore),
    slopePenalty: round3(slopePenalty),
    avoidPenalty: round3(avoidPenalty),
    sampleCount: lineResult.sampleCount,
    queryMs
  }

  if (terrainSuitability && lineSignature) {
    terrainLineQueryCache.get(terrainSuitability)?.set(lineSignature, result)
    terrainLineQueryCacheMisses++
  }

  return result
}

// Phase 7B.3A backward-compatible alias; the helper is now road-neutral.
export const computePrimaryRoadTerrainScore = computeRoadTerrainScore

export function getTerrainSuitabilityForLine(
  line: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString,
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  caller = 'unknown'
): TerrainLineQueryResult {
  const feature = ensureFeature({ type: 'LineString', coordinates: (line as any).coordinates } as GeoJSON.LineString)
  if (!feature) {
    return {
      available: false,
      preferredFraction: 0,
      moderateFraction: 0,
      challengingFraction: 0,
      avoidFraction: 0,
      insufficientDataFraction: 1,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampleCount: 0,
      sampleSpacingFt: 0
    }
  }

  if (!line || (line as any).type !== 'LineString' || !(line as any).coordinates) {
    return {
      available: false,
      preferredFraction: 0,
      moderateFraction: 0,
      challengingFraction: 0,
      avoidFraction: 0,
      insufficientDataFraction: 1,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampleCount: 0,
      sampleSpacingFt: 0
    }
  }

  const lineFeature = (line as any).type === 'Feature' ? line as GeoJSON.Feature<GeoJSON.LineString> : { type: 'Feature', properties: {}, geometry: line as GeoJSON.LineString } as GeoJSON.Feature<GeoJSON.LineString>
  const lineLengthM = safeTurfOp(() => turf.length(lineFeature, { units: 'meters' }), 0)
  const lineLengthFt = lineLengthM / FEET_TO_METERS

  if (lineLengthFt <= 0) {
    return {
      available: false,
      preferredFraction: 0,
      moderateFraction: 0,
      challengingFraction: 0,
      avoidFraction: 0,
      insufficientDataFraction: 1,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampleCount: 0,
      sampleSpacingFt: 0
    }
  }

  const index = buildCellIndex(terrainSuitability)
  if (!index) {
    return {
      available: false,
      preferredFraction: 0,
      moderateFraction: 0,
      challengingFraction: 0,
      avoidFraction: 0,
      insufficientDataFraction: 1,
      dominantClass: 'INSUFFICIENT_DATA',
      meanSlopePct: null,
      maxSlopePct: null,
      sampleCount: 0,
      sampleSpacingFt: 0
    }
  }

  const MAX_LINE_SAMPLES = 500
  let sampleSpacingFt = terrainSuitability?.sampleSpacingFt ?? 25
  if (sampleSpacingFt <= 0) sampleSpacingFt = 25
  let sampleCount = Math.max(1, Math.ceil(lineLengthFt / sampleSpacingFt)) + 1
  if (sampleCount > MAX_LINE_SAMPLES) {
    sampleSpacingFt = lineLengthFt / (MAX_LINE_SAMPLES - 1)
    sampleCount = MAX_LINE_SAMPLES
  }

  const counts: Record<TerrainSuitabilityClass, number> = {
    PREFERRED: 0,
    MODERATE: 0,
    CHALLENGING: 0,
    AVOID: 0,
    INSUFFICIENT_DATA: 0
  }

  let slopeSum = 0
  let slopeCount = 0
  let maxSlopePct: number | null = null
  let availableSamples = 0

  for (let i = 0; i < sampleCount; i++) {
    const d = Math.min(i * sampleSpacingFt, lineLengthFt)
    const meters = d * FEET_TO_METERS
    const pt = safeTurfOp(() => turf.along(lineFeature, meters, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Point> | null, null)
    if (!pt) {
      counts.INSUFFICIENT_DATA++
      continue
    }
    const query = getTerrainSuitabilityAtPoint(pt, terrainSuitability, caller)
    if (!query.available) {
      counts.INSUFFICIENT_DATA++
      continue
    }
    counts[query.class]++
    availableSamples++
    if (query.slopePct !== null && Number.isFinite(query.slopePct)) {
      slopeSum += query.slopePct
      slopeCount++
      if (maxSlopePct === null || query.slopePct > maxSlopePct) {
        maxSlopePct = query.slopePct
      }
    }
  }

  const fractions: Record<TerrainSuitabilityClass, number> = {
    PREFERRED: round3(counts.PREFERRED / sampleCount),
    MODERATE: round3(counts.MODERATE / sampleCount),
    CHALLENGING: round3(counts.CHALLENGING / sampleCount),
    AVOID: round3(counts.AVOID / sampleCount),
    INSUFFICIENT_DATA: round3(counts.INSUFFICIENT_DATA / sampleCount)
  }

  const sum = Object.values(fractions).reduce((s, v) => s + v, 0)
  if (sum !== 0 && sum !== 1) {
    const diff = round3(1 - sum)
    fractions.INSUFFICIENT_DATA = round3(fractions.INSUFFICIENT_DATA + diff)
  }

  return {
    available: availableSamples > 0,
    preferredFraction: fractions.PREFERRED,
    moderateFraction: fractions.MODERATE,
    challengingFraction: fractions.CHALLENGING,
    avoidFraction: fractions.AVOID,
    insufficientDataFraction: fractions.INSUFFICIENT_DATA,
    dominantClass: resolveDominantClass({
      PREFERRED: fractions.PREFERRED * 100,
      MODERATE: fractions.MODERATE * 100,
      CHALLENGING: fractions.CHALLENGING * 100,
      AVOID: fractions.AVOID * 100,
      INSUFFICIENT_DATA: fractions.INSUFFICIENT_DATA * 100
    }),
    meanSlopePct: slopeCount > 0 ? round3(slopeSum / slopeCount) : null,
    maxSlopePct,
    sampleCount,
    sampleSpacingFt: round3(sampleSpacingFt)
  }
}

export interface TerrainQueryAuditResult {
  mcpi: string
  pointQuery: TerrainPointQueryResult & { queryMs: number }
  primaryRoadQuery: TerrainLineQueryResult & { queryMs: number }
  zoneQuery: TerrainGeometryQueryResult & { queryMs: number }
  percentageReconciliation: {
    pointRespected: boolean
    lineRespected: boolean
    polygonRespected: boolean
    polygonSum: number
    lineSum: number
  }
}

export function runTerrainQueryAudit(
  mcpi: string,
  terrainSuitability: TerrainSuitabilityResult | null,
  parcelCenter: GeoJSON.Feature<GeoJSON.Point> | number[] | null,
  primaryRoadCenterline: GeoJSON.Feature<GeoJSON.LineString> | null,
  zoneGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null
): TerrainQueryAuditResult | null {
  if (!terrainSuitability || terrainSuitability.status !== 'completed') return null
  if (!parcelCenter && !primaryRoadCenterline && !zoneGeometry) return null

  const t0 = performance.now()
  const pointResult = parcelCenter
    ? getTerrainSuitabilityAtPoint(parcelCenter, terrainSuitability)
    : emptyPointResult()
  const pointMs = performance.now() - t0

  const t1 = performance.now()
  const primaryRoadQuery = primaryRoadCenterline
    ? getTerrainSuitabilityForLine(primaryRoadCenterline, terrainSuitability)
    : {
        available: false,
        preferredFraction: 0,
        moderateFraction: 0,
        challengingFraction: 0,
        avoidFraction: 0,
        insufficientDataFraction: 1,
        dominantClass: 'INSUFFICIENT_DATA' as TerrainSuitabilityClass,
        meanSlopePct: null,
        maxSlopePct: null,
        sampleCount: 0,
        sampleSpacingFt: 0
      }
  const primaryRoadMs = performance.now() - t1

  const t2 = performance.now()
  const zoneQuery = zoneGeometry
    ? getTerrainSuitabilityForGeometry(zoneGeometry, terrainSuitability)
    : {
        available: false,
        preferredPercent: 0,
        moderatePercent: 0,
        challengingPercent: 0,
        avoidPercent: 0,
        insufficientDataPercent: 100,
        dominantClass: 'INSUFFICIENT_DATA' as TerrainSuitabilityClass,
        meanSlopePct: null,
        maxSlopePct: null,
        sampledCellCount: 0,
        intersectedCellCount: 0
      }
  const zoneMs = performance.now() - t2

  const polygonSum = round3(
    zoneQuery.preferredPercent +
    zoneQuery.moderatePercent +
    zoneQuery.challengingPercent +
    zoneQuery.avoidPercent +
    zoneQuery.insufficientDataPercent
  )
  const lineSum = round3(
    primaryRoadQuery.preferredFraction +
    primaryRoadQuery.moderateFraction +
    primaryRoadQuery.challengingFraction +
    primaryRoadQuery.avoidFraction +
    primaryRoadQuery.insufficientDataFraction
  )

  return {
    mcpi,
    pointQuery: { ...pointResult, queryMs: Math.round(pointMs) },
    primaryRoadQuery: { ...primaryRoadQuery, queryMs: Math.round(primaryRoadMs) },
    zoneQuery: { ...zoneQuery, queryMs: Math.round(zoneMs) },
    percentageReconciliation: {
      pointRespected: pointResult.available ? true : true,
      lineRespected: Math.abs(lineSum - 1) < 0.001,
      polygonRespected: Math.abs(polygonSum - 100) < 0.1,
      polygonSum,
      lineSum
    }
  }
}
