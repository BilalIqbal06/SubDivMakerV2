import { GIS_BASE_URL } from '../config/gis'
import { networkCounter, verboseLog, ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS } from '../lib/perf'
import { arcGISPostQuery } from './gisService'
import type { TerrainContour, TerrainData, TerrainSample, TerrainProfilePoint, RoadTerrainProfile } from '../types/terrain'

const TERRAIN_CONTOUR_URL = `${GIS_BASE_URL}/gis/rest/services/COL/Environmental/MapServer/3`

export const TERRAIN_QUERY_BUFFER_FT = 500
export const TERRAIN_SAMPLE_INTERVAL_FT = 25
export const TERRAIN_NEARBY_THRESHOLD_FT = 100
const TERRAIN_CONTOUR_EQUIVALENCE_EPSILON_FT = 1e-6
const HIGH_CONFIDENCE_DISTANCE_FT = 25
const MODERATE_CONFIDENCE_DISTANCE_FT = 75
const STEEP_GRADE_THRESHOLD = 8 // percent

const FT_PER_DEGREE_LAT = 364411.0 // approximate, at mid-latitudes

function round4(n: number): number { return Math.round(n * 10000) / 10000 }

// DEV-only deep performance tracker for terrain profile sampling
interface ProfileOperationRecord {
  name: string
  callCount: number
  totalMs: number
  maxMs: number
}

interface SlowProfileRecord {
  routeId: string
  routeLengthFt: number
  profileSampleCount: number
  totalMs: number
  elevationMs: number
  slopeMs: number
  otherMs: number
}

class TerrainProfileTracker {
  routeProfileCallCount = 0
  totalMs = 0
  totalProfileSamples = 0
  uniqueSampleCoordinates = 0
  duplicateSampleCoordinates = 0
  elevationRequestCount = 0
  uniqueElevationCoordinateCount = 0
  elevationCacheHits = 0
  elevationCacheMisses = 0
  contourFeaturesExamined = 0
  contourVerticesExamined = 0
  slopeRequestCount = 0
  slopeElevationSubqueries = 0
  slopeRhumbDestinationCalls = 0
  slowestProfiles: SlowProfileRecord[] = []
  operations: Record<string, ProfileOperationRecord> = {}
  coordinateSet = new Set<string>()
  pending: { routeId: string; routeLengthFt: number; start: number; elevationMs: number; slopeMs: number } | null = null

  startProfile(routeId: string, routeLengthFt: number) {
    this.routeProfileCallCount++
    this.pending = { routeId, routeLengthFt, start: performance.now(), elevationMs: 0, slopeMs: 0 }
  }

  stopProfile(profileSampleCount: number) {
    if (!this.pending) return
    const ms = performance.now() - this.pending.start
    this.totalMs += ms
    this.totalProfileSamples += profileSampleCount
    this.slowestProfiles.push({
      routeId: this.pending.routeId,
      routeLengthFt: this.pending.routeLengthFt,
      profileSampleCount,
      totalMs: round4(ms),
      elevationMs: round4(this.pending.elevationMs),
      slopeMs: round4(this.pending.slopeMs),
      otherMs: round4(Math.max(0, ms - this.pending.elevationMs - this.pending.slopeMs))
    })
    this.slowestProfiles.sort((a, b) => b.totalMs - a.totalMs).splice(5)
    this.pending = null
  }

  recordElevationMs(ms: number) {
    this.pending && (this.pending.elevationMs += ms)
  }

  recordSlopeMs(ms: number) {
    this.pending && (this.pending.slopeMs += ms)
  }

  recordOp(name: string, ms: number) {
    const r = this.operations[name] = this.operations[name] || { name, callCount: 0, totalMs: 0, maxMs: 0 }
    r.callCount++
    r.totalMs += ms
    r.maxMs = Math.max(r.maxMs, ms)
  }

  timeOp<T>(name: string, fn: () => T): T {
    const t0 = performance.now()
    const r = fn()
    this.recordOp(name, performance.now() - t0)
    return r
  }

  recordCoordinateKey(key: string, cacheHit: boolean) {
    this.elevationRequestCount++
    if (cacheHit) {
      this.elevationCacheHits++
      return
    }
    this.elevationCacheMisses++
    if (this.coordinateSet.has(key)) {
      this.duplicateSampleCoordinates++
    } else {
      this.coordinateSet.add(key)
      this.uniqueSampleCoordinates++
      this.uniqueElevationCoordinateCount++
    }
  }

  recordContourFeatures(count: number, vertices: number) {
    this.contourFeaturesExamined += count
    this.contourVerticesExamined += vertices
  }

  recordSlopeRequest(rhumbCalls: number, subqueries: number) {
    this.slopeRequestCount++
    this.slopeRhumbDestinationCalls += rhumbCalls
    this.slopeElevationSubqueries += subqueries
  }

  getAudit(mcpi: string) {
    return {
      mcpi,
      routeProfileCallCount: this.routeProfileCallCount,
      totalMs: round4(this.totalMs),
      totalProfileSamples: this.totalProfileSamples,
      uniqueSampleCoordinates: this.uniqueSampleCoordinates,
      duplicateSampleCoordinates: this.duplicateSampleCoordinates,
      operations: Object.values(this.operations).map(o => ({
        name: o.name,
        callCount: o.callCount,
        totalMs: round4(o.totalMs),
        maxMs: round4(o.maxMs),
        averageMs: o.callCount > 0 ? round4(o.totalMs / o.callCount) : 0
      })).sort((a, b) => b.totalMs - a.totalMs),
      elevationLookup: {
        requestCount: this.elevationRequestCount,
        uniqueCoordinateCount: this.uniqueElevationCoordinateCount,
        cacheHits: this.elevationCacheHits,
        cacheMisses: this.elevationCacheMisses,
        contourFeaturesExamined: this.contourFeaturesExamined,
        contourVerticesExamined: this.contourVerticesExamined
      },
      slopeLookup: {
        requestCount: this.slopeRequestCount,
        elevationSubqueries: this.slopeElevationSubqueries,
        rhumbDestinationCalls: this.slopeRhumbDestinationCalls
      },
      slowestProfiles: this.slowestProfiles
    }
  }

  reset() {
    this.routeProfileCallCount = 0
    this.totalMs = 0
    this.totalProfileSamples = 0
    this.uniqueSampleCoordinates = 0
    this.duplicateSampleCoordinates = 0
    this.elevationRequestCount = 0
    this.uniqueElevationCoordinateCount = 0
    this.elevationCacheHits = 0
    this.elevationCacheMisses = 0
    this.contourFeaturesExamined = 0
    this.contourVerticesExamined = 0
    this.slopeRequestCount = 0
    this.slopeElevationSubqueries = 0
    this.slopeRhumbDestinationCalls = 0
    this.slowestProfiles = []
    this.operations = {}
    this.coordinateSet.clear()
    this.pending = null
  }
}

let terrainProfileTracker: TerrainProfileTracker | null = null
function getTracker(): TerrainProfileTracker {
  if (!terrainProfileTracker) terrainProfileTracker = new TerrainProfileTracker()
  return terrainProfileTracker
}

export function getTerrainProfileDeepAudit(mcpi: string) {
  return getTracker().getAudit(mcpi)
}

export function resetTerrainProfileDeepAudit() {
  if (terrainProfileTracker) terrainProfileTracker.reset()
}

export function recordTerrainProfileSlope(rhumbCalls: number, elevationSubqueries: number) {
  if (import.meta.env.DEV) getTracker().recordSlopeRequest(rhumbCalls, elevationSubqueries)
}

// Contour spatial index for findNearestContours
// ---------------------------------------------------------------------------

interface ContourBbox {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
  vertexCount: number
  contour: TerrainContour
}

interface ContourResult {
  distanceFt: number
  elevationFt: number
  OBJECTID: number
}

interface SpatialIndexStats {
  buildCount: number
  buildMs: number
  lookupCount: number
  indexedLookupCount: number
  fullScanFallbackCount: number
  candidateContoursExamined: number
  fullScanEquivalentContours: number
  contourVerticesExamined: number
  previousFullScanEstimatedVertices: number
  equivalenceChecks: number
  equivalenceMismatches: number
  maxDistanceDifferenceFt: number
  maxElevationDifferenceFt: number
  queryMs: number
  maxQueryMs: number
}

class ContourSpatialIndex {
  terrainData: TerrainData
  bboxes: ContourBbox[]
  cols: number
  rows: number
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
  lonStep: number
  latStep: number
  grid: number[][][]

  buildMs: number
  contourFeatureCount: number
  gridCellCount: number

  constructor(terrainData: TerrainData) {
    const t0 = performance.now()
    this.terrainData = terrainData
    this.contourFeatureCount = terrainData.contours.length

    this.bboxes = terrainData.contours.map((contour) => {
      const coords = contour.geometry.coordinates as number[][]
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
      for (const [lon, lat] of coords) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
      return { minLon, maxLon, minLat, maxLat, vertexCount: coords.length, contour }
    })

    this.minLon = Infinity
    this.maxLon = -Infinity
    this.minLat = Infinity
    this.maxLat = -Infinity
    for (const b of this.bboxes) {
      if (b.minLon < this.minLon) this.minLon = b.minLon
      if (b.maxLon > this.maxLon) this.maxLon = b.maxLon
      if (b.minLat < this.minLat) this.minLat = b.minLat
      if (b.maxLat > this.maxLat) this.maxLat = b.maxLat
    }

    const lonExtent = Math.max(1e-10, this.maxLon - this.minLon)
    const latExtent = Math.max(1e-10, this.maxLat - this.minLat)
    const targetCells = 64
    const step = Math.max(1e-10, Math.sqrt((lonExtent * latExtent) / targetCells))
    this.cols = Math.max(1, Math.ceil(lonExtent / step))
    this.rows = Math.max(1, Math.ceil(latExtent / step))
    this.lonStep = lonExtent / this.cols
    this.latStep = latExtent / this.rows
    this.gridCellCount = this.cols * this.rows

    this.grid = Array(this.cols)
    for (let c = 0; c < this.cols; c++) {
      this.grid[c] = Array(this.rows)
      for (let r = 0; r < this.rows; r++) {
        this.grid[c][r] = []
      }
    }

    for (let i = 0; i < this.bboxes.length; i++) {
      const b = this.bboxes[i]
      const c0 = Math.max(0, Math.floor((b.minLon - this.minLon) / this.lonStep))
      const c1 = Math.min(this.cols - 1, Math.floor((b.maxLon - this.minLon) / this.lonStep))
      const r0 = Math.max(0, Math.floor((b.minLat - this.minLat) / this.latStep))
      const r1 = Math.min(this.rows - 1, Math.floor((b.maxLat - this.minLat) / this.latStep))
      for (let c = c0; c <= c1; c++) {
        for (let r = r0; r <= r1; r++) {
          this.grid[c][r].push(i)
        }
      }
    }

    this.buildMs = performance.now() - t0
  }

  cellBounds(col: number, row: number): { lon0: number; lon1: number; lat0: number; lat1: number } {
    const lon0 = this.minLon + col * this.lonStep
    const lon1 = lon0 + this.lonStep
    const lat0 = this.minLat + row * this.latStep
    const lat1 = lat0 + this.latStep
    return { lon0, lon1, lat0, lat1 }
  }

  cellRectDistanceFt(point: number[], col: number, row: number): number {
    const { lon0, lon1, lat0, lat1 } = this.cellBounds(col, row)
    const [lon, lat] = point
    if (lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1) return 0
    const boundary: number[][] = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return pointToLineStringDistanceFt(point, boundary).distanceFt
  }

  contourBboxDistance(point: number[], b: ContourBbox): number {
    const [lon, lat] = point
    if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) return 0
    const boundary: number[][] = [[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]]
    return pointToLineStringDistanceFt(point, boundary).distanceFt
  }

  nearestVertex(point: number[]): ContourResult | null {
    let best: ContourResult | null = null
    const entries: { idx: number; bboxDist: number }[] = []
    for (let i = 0; i < this.bboxes.length; i++) {
      const d = this.contourBboxDistance(point, this.bboxes[i])
      entries.push({ idx: i, bboxDist: d })
    }
    entries.sort((a, b) => a.bboxDist - b.bboxDist)
    for (const e of entries) {
      if (best && e.bboxDist > best.distanceFt) break
      const b = this.bboxes[e.idx]
      const coords = b.contour.geometry.coordinates as number[][]
      for (const coord of coords) {
        const d = coordinateDistanceFt(point, coord)
        if (!best || d < best.distanceFt - 1e-12) {
          best = { distanceFt: d, elevationFt: b.contour.properties.elevationFt, OBJECTID: b.contour.properties.OBJECTID }
        }
      }
    }
    return best
  }

  query(point: number[], stats: SpatialIndexStats, diag?: { cells: any[]; stopReason: string; consideredCount: number; nearestFt: number | null; secondFt: number | null }): ContourResult[] {
    const t0 = performance.now()
    const cells: { col: number; row: number; cellLowerFt: number }[] = []
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        if (this.grid[c][r].length === 0) continue
        cells.push({ col: c, row: r, cellLowerFt: this.cellRectDistanceFt(point, c, r) })
      }
    }
    cells.sort((a, b) => a.cellLowerFt - b.cellLowerFt)

    const considered = new Set<number>()
    const best: ContourResult[] = []

    function insertBest(r: ContourResult) {
      best.push(r)
      best.sort(compareContourResult)
      if (best.length > 2) best.pop()
    }

    let stopReason = 'all cells processed'
    for (const cell of cells) {
      if (diag) {
        const { lon0, lon1, lat0, lat1 } = this.cellBounds(cell.col, cell.row)
        diag.cells.push({ col: cell.col, row: cell.row, cellLowerFt: cell.cellLowerFt, lon0, lon1, lat0, lat1 })
      }
      const nearest = best[0]?.distanceFt ?? Infinity
      if (cell.cellLowerFt > nearest && cell.cellLowerFt > TERRAIN_NEARBY_THRESHOLD_FT) {
        stopReason = `cellLower=${cell.cellLowerFt} > nearest=${nearest} and > threshold=${TERRAIN_NEARBY_THRESHOLD_FT}`
        break
      }

      const cellContours = this.grid[cell.col][cell.row]
      for (const idx of cellContours) {
        if (considered.has(idx)) continue
        considered.add(idx)
        const b = this.bboxes[idx]
        stats.contourVerticesExamined += b.vertexCount
        stats.candidateContoursExamined++
        const { distanceFt } = pointToLineStringDistanceFt(point, b.contour.geometry.coordinates as number[][])
        insertBest({ distanceFt, elevationFt: b.contour.properties.elevationFt, OBJECTID: b.contour.properties.OBJECTID })
      }
    }

    if (diag) {
      diag.stopReason = stopReason
      diag.consideredCount = considered.size
      diag.nearestFt = best[0]?.distanceFt ?? null
      diag.secondFt = best[1]?.distanceFt ?? null
    }

    const ms = performance.now() - t0
    stats.queryMs += ms
    if (ms > stats.maxQueryMs) stats.maxQueryMs = ms
    stats.indexedLookupCount++
    return best
  }
}

function compareContourResult(a: ContourResult, b: ContourResult): number {
  const d = a.distanceFt - b.distanceFt
  if (Math.abs(d) > 1e-12) return d
  const e = a.elevationFt - b.elevationFt
  if (e !== 0) return e
  return a.OBJECTID - b.OBJECTID
}

function fullScanFindNearestContours(point: number[], contours: TerrainContour[]): ContourResult[] {
  const results: ContourResult[] = []
  let vertexCount = 0
  for (const contour of contours) {
    const line = contour.geometry.coordinates as number[][]
    vertexCount += line.length
    const { distanceFt } = pointToLineStringDistanceFt(point, line)
    results.push({ distanceFt, elevationFt: contour.properties.elevationFt, OBJECTID: contour.properties.OBJECTID })
  }
  return results.sort(compareContourResult)
}

export function getNearestContourVertex(point: number[], terrainData: TerrainData): { distanceFt: number; elevationFt: number; OBJECTID: number } | null {
  if (!terrainData || !terrainData.contours.length) return null
  const index = getSpatialIndex(terrainData)
  return index.nearestVertex(point)
}

let spatialIndexByTerrainData: WeakMap<TerrainData, ContourSpatialIndex> | null = null
let activeSpatialIndex: ContourSpatialIndex | null = null
let spatialIndexStats: SpatialIndexStats = {
  buildCount: 0,
  buildMs: 0,
  lookupCount: 0,
  indexedLookupCount: 0,
  fullScanFallbackCount: 0,
  candidateContoursExamined: 0,
  fullScanEquivalentContours: 0,
  contourVerticesExamined: 0,
  previousFullScanEstimatedVertices: 0,
  equivalenceChecks: 0,
  equivalenceMismatches: 0,
  maxDistanceDifferenceFt: 0,
  maxElevationDifferenceFt: 0,
  queryMs: 0,
  maxQueryMs: 0
}
let equivalenceCounter = 0

function getSpatialIndex(terrainData: TerrainData): ContourSpatialIndex {
  if (!spatialIndexByTerrainData) spatialIndexByTerrainData = new WeakMap()
  let idx = spatialIndexByTerrainData.get(terrainData)
  if (!idx) {
    idx = new ContourSpatialIndex(terrainData)
    activeSpatialIndex = idx
    spatialIndexByTerrainData.set(terrainData, idx)
    spatialIndexStats.buildCount++
    spatialIndexStats.buildMs += idx.buildMs
    spatialIndexStats.fullScanEquivalentContours += idx.contourFeatureCount
  }
  return idx
}

export function resetContourSpatialIndexAudit() {
  spatialIndexByTerrainData = null
  activeSpatialIndex = null
  spatialIndexStats = {
    buildCount: 0,
    buildMs: 0,
    lookupCount: 0,
    indexedLookupCount: 0,
    fullScanFallbackCount: 0,
    candidateContoursExamined: 0,
    fullScanEquivalentContours: 0,
    contourVerticesExamined: 0,
    previousFullScanEstimatedVertices: 0,
    equivalenceChecks: 0,
    equivalenceMismatches: 0,
    maxDistanceDifferenceFt: 0,
    maxElevationDifferenceFt: 0,
    queryMs: 0,
    maxQueryMs: 0
  }
  equivalenceCounter = 0
}

export function getContourSpatialIndexAudit(mcpi: string) {
  const totalVerticesInDataset = activeSpatialIndex
    ? activeSpatialIndex.bboxes.reduce((sum, b) => sum + b.vertexCount, 0)
    : 0
  const previousFullScanEstimatedVertices = spatialIndexStats.lookupCount * totalVerticesInDataset
  const candidateEquivalent = spatialIndexStats.lookupCount * spatialIndexStats.fullScanEquivalentContours
  const reduction = spatialIndexStats.fullScanEquivalentContours > 0 && spatialIndexStats.lookupCount > 0
    ? round4(1 - (spatialIndexStats.candidateContoursExamined / candidateEquivalent))
    : 0
  const vertexReduction = previousFullScanEstimatedVertices > 0
    ? round4(1 - (spatialIndexStats.contourVerticesExamined / previousFullScanEstimatedVertices))
    : 0
  return {
    mcpi,
    indexBuildCount: spatialIndexStats.buildCount,
    indexBuildMs: round4(spatialIndexStats.buildMs),
    contourFeatureCount: spatialIndexStats.fullScanEquivalentContours,
    gridCellCount: activeSpatialIndex ? activeSpatialIndex.gridCellCount : 0,
    lookupCount: spatialIndexStats.lookupCount,
    indexedLookupCount: spatialIndexStats.indexedLookupCount,
    fullScanFallbackCount: spatialIndexStats.fullScanFallbackCount,
    candidateContoursExamined: spatialIndexStats.candidateContoursExamined,
    fullScanEquivalentContours: candidateEquivalent,
    candidateReductionPercent: reduction * 100,
    contourVerticesExamined: spatialIndexStats.contourVerticesExamined,
    previousFullScanEstimatedVertices,
    vertexReductionPercent: vertexReduction * 100,
    equivalenceChecks: spatialIndexStats.equivalenceChecks,
    equivalenceMismatches: spatialIndexStats.equivalenceMismatches,
    maxDistanceDifferenceFt: round4(spatialIndexStats.maxDistanceDifferenceFt),
    maxElevationDifferenceFt: round4(spatialIndexStats.maxElevationDifferenceFt),
    queryMs: round4(spatialIndexStats.queryMs),
    meanQueryMs: spatialIndexStats.lookupCount > 0 ? round4(spatialIndexStats.queryMs / spatialIndexStats.lookupCount) : 0,
    maxQueryMs: round4(spatialIndexStats.maxQueryMs)
  }
}

function toRadians(deg: number): number {
  return deg * Math.PI / 180
}

/**
 * Haversine distance between two WGS-84 coordinates, returned in feet.
 */
export function coordinateDistanceFt(a: number[], b: number[]): number {
  const lat1 = toRadians(a[1])
  const lat2 = toRadians(b[1])
  const dLat = toRadians(b[1] - a[1])
  const dLon = toRadians(b[0] - a[0])
  const r = 6371000 // earth radius in meters
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  return r * c * 3.28084
}

function localScaleFactors(latitude: number): { latScale: number; lonScale: number } {
  const latScale = FT_PER_DEGREE_LAT
  const lonScale = FT_PER_DEGREE_LAT * Math.cos(toRadians(latitude))
  return { latScale, lonScale }
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

function pointToLineStringDistanceFt(point: number[], line: number[][]): { distanceFt: number; closestCoord: number[] } {
  let best = Infinity
  let closest = line[0]
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const d = pointToSegmentDistanceFt(point, a, b)
    if (d < best) {
      best = d
      // compute closest point for optional use
      const { latScale, lonScale } = localScaleFactors((a[1] + b[1]) / 2)
      const px = (point[0] - a[0]) * lonScale
      const py = (point[1] - a[1]) * latScale
      const bx = (b[0] - a[0]) * lonScale
      const by = (b[1] - a[1]) * latScale
      const len2 = bx * bx + by * by
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2))
      const lon = a[0] + t * (b[0] - a[0])
      const lat = a[1] + t * (b[1] - a[1])
      closest = [lon, lat]
    }
  }
  return { distanceFt: best, closestCoord: closest }
}

function lineStringLengthFt(coords: number[][]): number {
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) {
    total += coordinateDistanceFt(coords[i], coords[i + 1])
  }
  return total
}

function pointAtDistanceAlongLineFt(coords: number[][], distanceFt: number): number[] {
  if (coords.length === 0) return [0, 0]
  if (coords.length === 1) return coords[0]
  const total = lineStringLengthFt(coords)
  if (total === 0 || distanceFt <= 0) return coords[0]
  if (distanceFt >= total) return coords[coords.length - 1]
  let accumulated = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]
    const b = coords[i + 1]
    const seg = coordinateDistanceFt(a, b)
    if (accumulated + seg >= distanceFt) {
      const frac = seg === 0 ? 0 : (distanceFt - accumulated) / seg
      return [a[0] + frac * (b[0] - a[0]), a[1] + frac * (b[1] - a[1])]
    }
    accumulated += seg
  }
  return coords[coords.length - 1]
}

function sampleCenterline(centerline: GeoJSON.Feature<GeoJSON.LineString>, roadLengthFt: number, sampleSpacingFt: number): { coordinate: number[]; distanceAlongRoadFt: number }[] {
  const tracker = import.meta.env.DEV ? getTracker() : null
  const t0 = performance.now()
  const coords = centerline.geometry.coordinates as number[][]
  if (!coords || coords.length < 2) {
    tracker?.recordOp('sampleCenterline', performance.now() - t0)
    return []
  }
  const actualLength = Math.max(roadLengthFt, lineStringLengthFt(coords))
  const pointCount = actualLength > sampleSpacingFt ? Math.max(2, Math.floor(actualLength / sampleSpacingFt) + 1) : 2
  const points: { coordinate: number[]; distanceAlongRoadFt: number }[] = []
  for (let i = 0; i < pointCount; i++) {
    const d = (i / (pointCount - 1)) * actualLength
    points.push({ coordinate: pointAtDistanceAlongLineFt(coords, d), distanceAlongRoadFt: d })
  }
  tracker?.recordOp('sampleCenterline', performance.now() - t0)
  return points
}

function findNearestContours(point: number[], terrainData: TerrainData): ContourResult[] {
  const t0 = performance.now()
  const tracker = import.meta.env.DEV ? getTracker() : null
  const candidatesBefore = spatialIndexStats.candidateContoursExamined
  const verticesBefore = spatialIndexStats.contourVerticesExamined

  spatialIndexStats.lookupCount++
  const index = getSpatialIndex(terrainData)
  const isCheck = import.meta.env.DEV && ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS && (equivalenceCounter + 1) % 20 === 0
  const diag = isCheck ? { cells: [] as any[], stopReason: '', consideredCount: 0, nearestFt: null as number | null, secondFt: null as number | null } : undefined
  const nearby = index.query(point, spatialIndexStats, diag)

  let result = nearby

  if (import.meta.env.DEV && ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS) {
    equivalenceCounter++
    const EQUIVALENCE_INTERVAL = 20
    if (equivalenceCounter % EQUIVALENCE_INTERVAL === 0) {
      spatialIndexStats.equivalenceChecks++
      const full = fullScanFindNearestContours(point, terrainData.contours)
      const fullTop = full.slice(0, 2)
      const indexedTop = nearby.slice(0, 2)

      const deltas: { rank: number; indexed: ContourResult | null; full: ContourResult | null; distanceDeltaFt: number | null; elevationDeltaFt: number | null }[] = []
      let mismatch = false
      let failure = 'UNKNOWN'
      const ranksToCompare = Math.min(2, fullTop.length)

      for (let rank = 0; rank < ranksToCompare; rank++) {
        const f = fullTop[rank]
        const n = indexedTop[rank]
        const usedInSampleTerrain = f.distanceFt <= TERRAIN_NEARBY_THRESHOLD_FT
        if (!n) {
          const distanceDelta = Infinity
          const elevationDelta = Infinity
          if (distanceDelta > spatialIndexStats.maxDistanceDifferenceFt) spatialIndexStats.maxDistanceDifferenceFt = 1e12
          if (elevationDelta > spatialIndexStats.maxElevationDifferenceFt) spatialIndexStats.maxElevationDifferenceFt = 1e12
          deltas.push({ rank, indexed: null, full: f, distanceDeltaFt: null, elevationDeltaFt: null })
          if (usedInSampleTerrain) {
            mismatch = true
            failure = rank === 0 ? 'WRONG_NEAREST' : 'MISSED_SECOND_WITHIN_100'
          }
          break
        }

        const distanceDelta = Math.abs(n.distanceFt - f.distanceFt)
        const elevationDelta = Math.abs(n.elevationFt - f.elevationFt)
        if (distanceDelta > spatialIndexStats.maxDistanceDifferenceFt) spatialIndexStats.maxDistanceDifferenceFt = distanceDelta
        if (elevationDelta > spatialIndexStats.maxElevationDifferenceFt) spatialIndexStats.maxElevationDifferenceFt = elevationDelta

        deltas.push({
          rank,
          indexed: n,
          full: f,
          distanceDeltaFt: round4(distanceDelta),
          elevationDeltaFt: round4(elevationDelta)
        })

        const idDiff = n.OBJECTID !== f.OBJECTID
        const distDiff = distanceDelta > TERRAIN_CONTOUR_EQUIVALENCE_EPSILON_FT
        const elevDiff = elevationDelta > TERRAIN_CONTOUR_EQUIVALENCE_EPSILON_FT

        if (usedInSampleTerrain) {
          if (idDiff) {
            mismatch = true
            failure = rank === 0 ? 'WRONG_NEAREST' : 'WRONG_SECOND'
          } else if (distDiff || elevDiff) {
            mismatch = true
            failure = rank === 0 ? 'WRONG_NEAREST' : 'NUMERICAL_DISTANCE'
          }
        }

        if (mismatch) break
      }

      if (mismatch) {
        spatialIndexStats.equivalenceMismatches++
        console.warn('[TerrainContourSpatialIndexEquivalenceMismatch]', {
          point,
          failure,
          deltas,
          indexed: indexedTop,
          full: fullTop,
          nextFull: full[2] ? { distanceFt: full[2].distanceFt, elevationFt: full[2].elevationFt, OBJECTID: full[2].OBJECTID } : null,
          cellsSearched: diag?.cells,
          stopReason: diag?.stopReason,
          consideredCount: diag?.consideredCount,
          nearestIndexed: diag?.nearestFt,
          secondIndexed: diag?.secondFt,
          epsilon: TERRAIN_CONTOUR_EQUIVALENCE_EPSILON_FT
        })
        result = fullTop
        spatialIndexStats.fullScanFallbackCount++
      }
    }
  }

  const candidatesExamined = spatialIndexStats.candidateContoursExamined - candidatesBefore
  const verticesExamined = spatialIndexStats.contourVerticesExamined - verticesBefore
  tracker?.recordContourFeatures(candidatesExamined, verticesExamined)
  tracker?.recordOp('findNearestContours', performance.now() - t0)
  return result
}

function sampleKey(point: number[]): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`
}

export function sampleTerrain(point: number[], terrainData: TerrainData | null | undefined, sampleCache?: Map<string, TerrainSample>): TerrainSample {
  const tracker = import.meta.env.DEV ? getTracker() : null
  const t0 = performance.now()
  const key = sampleKey(point)
  const cacheHit = !!(sampleCache && sampleCache.get(key))
  tracker?.recordCoordinateKey(key, cacheHit)

  const empty = (): TerrainSample => ({
    coordinate: point,
    elevationFt: null,
    confidence: 'UNAVAILABLE',
    nearestContourDistanceFt: Infinity,
    lowerContourFt: null,
    upperContourFt: null
  })

  try {
    if (!terrainData || !terrainData.coverageAvailable || terrainData.contourCount === 0) {
      return empty()
    }

    if (sampleCache) {
      const cached = sampleCache.get(key)
      if (cached) return cached
    }

    const nearby = findNearestContours(point, terrainData)
    if (nearby.length === 0) return empty()

    const nearest = nearby[0]
    const withinThreshold = nearby.filter(n => n.distanceFt <= TERRAIN_NEARBY_THRESHOLD_FT)

    if (withinThreshold.length === 0) {
      return {
        coordinate: point,
        elevationFt: null,
        confidence: 'UNAVAILABLE',
        nearestContourDistanceFt: nearest.distanceFt,
        lowerContourFt: null,
        upperContourFt: null
      }
    }

    if (withinThreshold.length === 1) {
      const only = withinThreshold[0]
      let confidence: TerrainSample['confidence'] = 'LOW'
      if (only.distanceFt <= HIGH_CONFIDENCE_DISTANCE_FT) confidence = 'MODERATE'
      if (only.distanceFt <= 8) confidence = 'HIGH'
      const v: TerrainSample = {
        coordinate: point,
        elevationFt: only.elevationFt,
        confidence,
        nearestContourDistanceFt: only.distanceFt,
        lowerContourFt: only.elevationFt,
        upperContourFt: only.elevationFt
      }
      if (sampleCache) sampleCache.set(key, v)
      return v
    }

    // Two nearest contours in threshold; treat as lower/upper bound.
    const sortedByElev = withinThreshold.slice(0, 2).sort((a, b) => a.elevationFt - b.elevationFt)
    const lower = sortedByElev[0]
    const upper = sortedByElev[1]
    const dLower = lower.distanceFt
    const dUpper = upper.distanceFt
    const sum = dLower + dUpper
    const fraction = sum === 0 ? 0 : dLower / sum
    const elevation = lower.elevationFt + fraction * (upper.elevationFt - lower.elevationFt)

    let confidence: TerrainSample['confidence'] = 'LOW'
    if (dLower + dUpper <= 2 * MODERATE_CONFIDENCE_DISTANCE_FT) confidence = 'MODERATE'
    if (dLower + dUpper <= 2 * HIGH_CONFIDENCE_DISTANCE_FT) confidence = 'HIGH'

    const sample: TerrainSample = {
      coordinate: point,
      elevationFt: elevation,
      confidence,
      nearestContourDistanceFt: nearest.distanceFt,
      lowerContourFt: lower.elevationFt,
      upperContourFt: upper.elevationFt
    }
    if (sampleCache) sampleCache.set(key, sample)
    return sample
  } finally {
    const ms = performance.now() - t0
    tracker?.recordOp('sampleTerrain', ms)
    tracker?.recordElevationMs(ms)
  }
}

export function sampleTerrainProfile(
  roadId: string,
  roadType: 'primary' | 'secondary',
  street: string | null,
  centerline: GeoJSON.Feature<GeoJSON.LineString> | null,
  roadLengthFt: number,
  terrainData: TerrainData | null | undefined,
  sampleSpacingFt = TERRAIN_SAMPLE_INTERVAL_FT,
  sampleCache?: Map<string, TerrainSample>
): RoadTerrainProfile {
  const tracker = import.meta.env.DEV ? getTracker() : null
  tracker?.startProfile(roadId, roadLengthFt)
  const unavailable: RoadTerrainProfile = {
    roadId,
    roadType,
    street,
    roadLengthFt,
    profileSampleCount: 0,
    terrainCoveragePercent: 0,
    startElevationFt: null,
    endElevationFt: null,
    minElevationFt: null,
    maxElevationFt: null,
    totalElevationChangeFt: 0,
    netElevationChangeFt: 0,
    averageGradePercent: 0,
    maximumSegmentGradePercent: 0,
    steepSegmentCount: 0,
    terrainAssessment: 'INSUFFICIENT_DATA',
    terrainAssessmentReason: 'No terrain contour coverage available for this parcel.',
    profile: { sampleSpacingFt, points: [] },
    confidence: 'UNAVAILABLE'
  }

  if (!centerline || !terrainData || !terrainData.coverageAvailable || terrainData.contourCount === 0) {
    tracker?.stopProfile(0)
    return unavailable
  }

  const sampledPoints = sampleCenterline(centerline, roadLengthFt, sampleSpacingFt)
  const profilePoints: TerrainProfilePoint[] = sampledPoints.map(p => ({
    ...sampleTerrain(p.coordinate, terrainData, sampleCache),
    distanceAlongRoadFt: p.distanceAlongRoadFt
  }))

  const validElevations = profilePoints.map(p => p.elevationFt).filter((v): v is number => v !== null)
  const coveragePercent = sampledPoints.length === 0 ? 0 : (validElevations.length / sampledPoints.length) * 100

  if (validElevations.length === 0) {
    tracker?.stopProfile(profilePoints.length)
    return {
      ...unavailable,
      profile: { sampleSpacingFt, points: profilePoints },
      profileSampleCount: profilePoints.length,
      terrainCoveragePercent: coveragePercent
    }
  }

  const startElevation = profilePoints[0].elevationFt ?? null
  const endElevation = profilePoints[profilePoints.length - 1].elevationFt ?? null
  const minElevation = Math.min(...validElevations)
  const maxElevation = Math.max(...validElevations)

  let totalChange = 0
  let netChange = 0
  let maxSegmentGrade = 0
  let steepCount = 0
  for (let i = 1; i < profilePoints.length; i++) {
    const prev = profilePoints[i - 1]
    const cur = profilePoints[i]
    if (prev.elevationFt !== null && cur.elevationFt !== null) {
      const segLength = cur.distanceAlongRoadFt - prev.distanceAlongRoadFt
      const elevChange = cur.elevationFt - prev.elevationFt
      totalChange += Math.abs(elevChange)
      if (segLength > 0) {
        const grade = (Math.abs(elevChange) / segLength) * 100
        if (grade > maxSegmentGrade) maxSegmentGrade = grade
        if (grade > STEEP_GRADE_THRESHOLD) steepCount++
      }
    }
  }

  if (startElevation !== null && endElevation !== null) {
    netChange = endElevation - startElevation
  }

  const averageGrade = roadLengthFt > 0 ? (netChange / roadLengthFt) * 100 : 0

  let assessment: RoadTerrainProfile['terrainAssessment'] = 'INSUFFICIENT_DATA'
  let reason = ''
  if (coveragePercent < 50) {
    assessment = 'INSUFFICIENT_DATA'
    reason = 'Less than half of the road profile could be assigned an elevation from available contours.'
  } else if (maxSegmentGrade < 5 && totalChange < 15) {
    assessment = 'FAVORABLE'
    reason = 'Terrain appears comparatively favorable for conceptual routing.'
  } else if (maxSegmentGrade < 10 && totalChange < 40) {
    assessment = 'MODERATE'
    reason = 'Moderate terrain variation; likely manageable with reasonable alignment/grading.'
  } else if (maxSegmentGrade < 15) {
    assessment = 'CHALLENGING'
    reason = 'Steeper terrain may require alignment/grading refinement.'
  } else {
    assessment = 'CHALLENGING'
    reason = 'Steep conceptual grades encountered; road alignment may need significant refinement.'
  }

  const confidenceLevels = profilePoints.map(p => p.confidence)
  const overallConfidence: RoadTerrainProfile['confidence'] =
    confidenceLevels.includes('HIGH') ? 'HIGH' :
    confidenceLevels.includes('MODERATE') ? 'MODERATE' :
    confidenceLevels.includes('LOW') ? 'LOW' : 'UNAVAILABLE'

  tracker?.stopProfile(profilePoints.length)
  return {
    roadId,
    roadType,
    street,
    roadLengthFt,
    profileSampleCount: profilePoints.length,
    terrainCoveragePercent: coveragePercent,
    startElevationFt: startElevation,
    endElevationFt: endElevation,
    minElevationFt: minElevation,
    maxElevationFt: maxElevation,
    totalElevationChangeFt: totalChange,
    netElevationChangeFt: netChange,
    averageGradePercent: averageGrade,
    maximumSegmentGradePercent: maxSegmentGrade,
    steepSegmentCount: steepCount,
    terrainAssessment: assessment,
    terrainAssessmentReason: reason,
    profile: { sampleSpacingFt, points: profilePoints },
    confidence: overallConfidence
  }
}

export async function fetchTerrainContours(
  mcpi: string,
  parcelGeometry: any,
  signal?: AbortSignal
): Promise<TerrainData> {
  networkCounter.count('terrain/contours')
  const empty: TerrainData = {
    mcpi,
    coverageAvailable: false,
    contourCount: 0,
    minElevationFt: null,
    maxElevationFt: null,
    elevationRangeFt: null,
    contours: [],
    source: TERRAIN_CONTOUR_URL,
    warnings: []
  }

  if (!parcelGeometry) {
    console.warn('[TerrainFetch] No parcel geometry provided', { mcpi })
    return { ...empty, fetchError: 'No parcel geometry provided' }
  }

  verboseLog('[TerrainFetchStart]', { mcpi, source: TERRAIN_CONTOUR_URL })

  try {
    const rawFeatures = await arcGISPostQuery(
      `${TERRAIN_CONTOUR_URL}/query`,
      parcelGeometry,
      {
        outFields: 'OBJECTID,TO_TELEV,TO_TYPE,TO_UPD_DATE',
        distance: String(TERRAIN_QUERY_BUFFER_FT),
        units: 'esriSRUnit_Foot',
        resultRecordCount: '1000'
      },
      signal
    )

    const contours: TerrainContour[] = []
    const warnings: string[] = []
    const elevations: number[] = []

    for (const f of rawFeatures) {
      const props = f.properties || {}
      const elevRaw = props.TO_TELEV
      const elev = elevRaw === undefined || elevRaw === null ? null : Number(elevRaw)
      if (elev === null || Number.isNaN(elev)) {
        warnings.push(`Contour OBJECTID ${props.OBJECTID} has no usable TO_TELEV value`)
        continue
      }

      const geom = f.geometry
      if (!geom || (geom.type !== 'LineString' && geom.type !== 'MultiLineString')) {
        warnings.push(`Contour OBJECTID ${props.OBJECTID} has no line geometry`)
        continue
      }

      if (geom.type === 'LineString') {
        contours.push({
          type: 'Feature',
          geometry: geom,
          properties: {
            OBJECTID: Number(props.OBJECTID) || 0,
            elevationFt: elev,
            contourType: props.TO_TYPE != null ? String(props.TO_TYPE) : undefined,
            updateDate: props.TO_UPD_DATE != null ? String(props.TO_UPD_DATE) : undefined
          }
        })
      } else if (geom.type === 'MultiLineString') {
        for (let i = 0; i < geom.coordinates.length; i++) {
          contours.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: geom.coordinates[i] },
            properties: {
              OBJECTID: Number(props.OBJECTID) || 0,
              elevationFt: elev,
              contourType: props.TO_TYPE != null ? String(props.TO_TYPE) : undefined,
              updateDate: props.TO_UPD_DATE != null ? String(props.TO_UPD_DATE) : undefined
            }
          })
        }
      }
      elevations.push(elev)
    }

    const minElevation = elevations.length > 0 ? Math.min(...elevations) : null
    const maxElevation = elevations.length > 0 ? Math.max(...elevations) : null

    const result: TerrainData = {
      mcpi,
      coverageAvailable: contours.length > 0,
      contourCount: contours.length,
      minElevationFt: minElevation,
      maxElevationFt: maxElevation,
      elevationRangeFt: minElevation !== null && maxElevation !== null ? maxElevation - minElevation : null,
      contours,
      source: TERRAIN_CONTOUR_URL,
      warnings
    }

    

    return result
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError'
    const message = isAbort ? 'Terrain fetch aborted' : String(err?.message || err)
    console.error('[TerrainFetchFailure]', { mcpi, isAbort, message })
    return { ...empty, fetchError: message, warnings: [message] }
  }
}
