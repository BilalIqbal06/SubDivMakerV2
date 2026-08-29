import { recomputeCounter, turfc as turf, turfPerformance, VERBOSE_GIS_DIAGNOSTICS } from '../lib/perf'
import { computeRedevelopmentDisturbance } from '../lib/redevelopmentContext'
import { fastAlong, fastBearing } from './fastAlong'
import { getTerrainDirectionAtPoint } from './terrainDirection'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import {
  CandidateOpenAreaResult,
  ConceptualRoadSkeletonResult,
  RoadNetworkPreference,
  RoadParameters,
  SecondaryRoad,
  SecondaryRoadNetworkResult
} from '../types/parameters'
import type { PrimaryRoadTerrainScoring, TerrainData, TerrainSuitabilityResult } from '../types/terrain'
import { computeRoadTerrainScore } from './terrainSuitabilityQuery'
import { sampleTerrainProfile } from './terrainService'

const FEET_TO_METERS = 0.3048
const METERS_TO_FEET = 3.28084
const SQ_METERS_TO_SQ_FEET = 10.7639

// Phase 2B MVP controls.
// These are feasibility heuristics, not engineering standards.
const MAX_SECONDARY_ROADS = 3
const SECONDARY_SERVICE_BUFFER_FEET = 200
const SECONDARY_ROAD_WIDTH_FEET = 24
const SECONDARY_ROAD_HALF_WIDTH_METERS = (SECONDARY_ROAD_WIDTH_FEET / 2) * FEET_TO_METERS
const MIN_BRANCH_LENGTH_FEET = 80
const MAX_BRANCH_LENGTH_FEET = 1000
const MIN_INCREMENTAL_SERVICE_SQFT = 5000
const MIN_MEANINGFUL_SERVICE_SQFT = 10000
const MIN_MEANINGFUL_SERVICE_FRACTION = 0.05
const JUNCTION_STEP_FEET = 70
const MIN_JUNCTION_SPACING_FT = 90
const RAY_STEP_FEET = 15
const MIN_CORRIDOR_WIDTH_FEET = 60
const MIN_BEND_ANGLE_DEG = 5
const GEOMETRY_TOLERANCE_SQ_METERS = 0.1
const SEED_STEP_FEET = 5
const SEED_MAX_SEARCH_FEET = 120

// Phase 7B.3B: terrain is a soft ~15% modifier on the newly-served-area ranking.
const SECONDARY_TERRAIN_INFLUENCE_PCT = 0.15
const SECONDARY_GRAMMAR_INFLUENCE_PCT = 0.07

function ftToM(ft: number) { return ft * FEET_TO_METERS }
function mToFt(m: number) { return m * METERS_TO_FEET }
function round3(n: number): number { return Math.round(n * 1000) / 1000 }
function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    return fallback
  }
}

function orientationDifferenceDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

function computeSecondaryGrammarPenalty(
  branch: BranchCandidate,
  primaryCenterline: GeoJSON.Feature<GeoJSON.LineString>,
  terrainSuitability: TerrainSuitabilityResult | null | undefined,
  primaryTerrainMode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
): number {
  if (primaryTerrainMode === 'DIRECT_FALLBACK' || !branch.newlyServedAreaSqFt) return 0

  const primaryCoords = primaryCenterline.geometry.coordinates as number[][]
  const primaryBearing = primaryCoords.length >= 2 ? (fastBearing(primaryCoords[0], primaryCoords[1]) ?? 0) : 0
  const branchBearing = branch.startBearing

  const intersectionDiff = Math.min(90, Math.abs(branch.junctionAngle - 90)) / 90
  const terrainDir = branch.junctionPoint && terrainSuitability
    ? getTerrainDirectionAtPoint(branch.junctionPoint, terrainSuitability)
    : null
  const desired = primaryTerrainMode === 'CONTOUR_FOLLOWING'
    ? (terrainDir?.fallLineBearing ?? (primaryBearing + 90))
    : (terrainDir?.contourBearing ?? (primaryBearing + 90))
  const terrainDiff = desired != null ? orientationDifferenceDeg(branchBearing, desired) / 90 : 0.5

  const intersectionScore = 1 - intersectionDiff
  const terrainScore = 1 - terrainDiff
  const grammarScore = (intersectionScore + terrainScore) / 2
  return branch.newlyServedAreaSqFt * (1 - grammarScore) * SECONDARY_GRAMMAR_INFLUENCE_PCT
}

function isValidPosition(c: any): c is [number, number] {
  return Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && isFinite(c[0]) && isFinite(c[1])
}

function positionsAreEqual(a: number[], b: number[]): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function dedupeConsecutivePositions(coords: number[][]): number[][] {
  return coords.filter((c, i) => i === 0 || !positionsAreEqual(c, coords[i - 1]))
}

function makeSafeLineString(coords: number[][]): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (!Array.isArray(coords) || coords.length < 2) return null
  const valid = coords.filter(isValidPosition)
  const deduped = dedupeConsecutivePositions(valid)
  if (deduped.length < 2) return null
  return safeTurfOp(() => turf.lineString(deduped), null)
}

function ensureFeature(geometry: GeoJSON.Geometry | GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!geometry) return null
  if ((geometry as any).type === 'Feature') {
    return geometry as GeoJSON.Feature<GeoJSON.Geometry>
  }
  try {
    return {
      type: 'Feature',
      properties: {},
      geometry: geometry as GeoJSON.Geometry
    } as GeoJSON.Feature<GeoJSON.Geometry>
  } catch {
    return null
  }
}

function sqMetersToSqFt(m2: number): number {
  return m2 * SQ_METERS_TO_SQ_FEET
}

function areaSqFt(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

const featureBboxCache = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, number[]>()
let bboxCacheHits = 0
let bboxCacheMisses = 0
function getFeatureBbox(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number[] | null {
  if (!feature || !feature.geometry) return null
  let cached = featureBboxCache.get(feature)
  if (cached) {
    bboxCacheHits++
    return cached
  }
  const bbox = safeTurfOp(() => turf.bbox(feature) as number[], null)
  if (!bbox) return null
  cached = bbox
  featureBboxCache.set(feature, cached)
  bboxCacheMisses++
  return cached
}

function pointOutsideBbox(point: GeoJSON.Feature<GeoJSON.Point>, bbox: number[] | null): boolean {
  if (!bbox || !point?.geometry) return false
  const [x, y] = point.geometry.coordinates
  return x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]
}

export function pointInFreeArea(point: GeoJSON.Feature<GeoJSON.Point>, freeArea: GeoJSON.Feature<GeoJSON.Geometry>): boolean {
  if (!point || !point.geometry || !freeArea || !freeArea.geometry) return false
  const bbox = getFeatureBbox(freeArea)
  if (pointOutsideBbox(point, bbox)) return false
  // booleanPointInPolygon does not reliably accept MultiPolygon in all versions.
  // Fall back to a tiny buffer intersection for mixed geometry types.
  const inside = safeTurfOp(() => turf.booleanPointInPolygon(point as any, freeArea as any), false)
  if (inside) return true
  const probe = safeTurfOp(() => turf.buffer(point, 0.05, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
  if (!probe) return false
  const overlap = safeTurfOp(() => (turf.intersect as any)(turf.featureCollection([probe as any, freeArea as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
  return !!overlap && !!overlap.geometry && safeTurfOp(() => turf.area(overlap), 0) > 0.0001
}

export function lineBearingAtPoint(line: GeoJSON.Feature<GeoJSON.LineString>, distanceMeters: number, totalLengthMeters: number): number | null {
  if (totalLengthMeters <= 0 || !line?.geometry?.coordinates || line.geometry.coordinates.length < 2) return null
  const d1 = Math.max(0, distanceMeters - 1)
  const d2 = Math.min(totalLengthMeters, distanceMeters + 1)
  const p1 = fastAlong(line, d1, 'meters')
  const p2 = fastAlong(line, d2, 'meters')
  if (!p1 || !p2 || !isValidPosition(p1.geometry.coordinates) || !isValidPosition(p2.geometry.coordinates)) return null
  if (positionsAreEqual(p1.geometry.coordinates, p2.geometry.coordinates)) return null
  return fastBearing(p1, p2) ?? null
}

function normalizeBearing(b: number): number {
  let x = b % 360
  if (x < 0) x += 360
  return x
}

function acuteAngleDifference(b1: number, b2: number): number {
  let diff = Math.abs(b1 - b2) % 180
  if (diff > 90) diff = 180 - diff
  return diff
}

function bboxesOverlap(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return true
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function geometryDifference(a: GeoJSON.Feature<GeoJSON.Geometry>, b: GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!a || !a.geometry || !b || !b.geometry) return a
  if (!bboxesOverlap(getFeatureBbox(a), getFeatureBbox(b))) return a
  return safeTurfOp(() => (turf.difference as any)(turf.featureCollection([a as any, b as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
}

function geometryIntersection(a: GeoJSON.Feature<GeoJSON.Geometry>, b: GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!a || !a.geometry || !b || !b.geometry) return null
  if (!bboxesOverlap(getFeatureBbox(a), getFeatureBbox(b))) return null
  return safeTurfOp(() => (turf.intersect as any)(turf.featureCollection([a as any, b as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
}

function geometryUnion(features: GeoJSON.Feature<GeoJSON.Geometry>[]): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const valid = features.filter(f => f?.geometry)
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0]
  const fc = turf.featureCollection(valid as any)
  return safeTurfOp(() => (turf.union as any)(fc as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
}

function rowOverlapsArea(row: GeoJSON.Feature<GeoJSON.Geometry>, obstacle: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): boolean {
  if (!row || !row.geometry || !obstacle || !obstacle.geometry) return false
  const overlap = geometryIntersection(row, obstacle)
  return !!overlap && !!overlap.geometry && safeTurfOp(() => turf.area(overlap), 0) > GEOMETRY_TOLERANCE_SQ_METERS
}

export interface GenerateSecondaryRoadNetworkOptions {
  mcpi: string
  analysisRunId: number
  generationRunId: number
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  primaryRoad: ConceptualRoadSkeletonResult
  candidateOpenArea: CandidateOpenAreaResult
  roadParameters: RoadParameters
  terrainData?: TerrainData | null
  terrainSuitability?: TerrainSuitabilityResult | null
  primaryTerrainMode?: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  signal?: AbortSignal
}

export interface BranchCandidate {
  id: string
  centerline: GeoJSON.Feature<GeoJSON.LineString>
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry>
  junctionPoint: number[]
  junctionAngle: number
  startBearing: number
  lengthFt: number
  templateType: 'simple-branch' | 't-branch' | 'small-loop'
  newlyServedAreaSqFt: number
  newlyServedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  servedGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  routeEfficiencyRatio: number
  bendCount: number
  maximumDeflectionAngle: number
  totalAbsoluteDeflection: number
  conflicts: SecondaryRoad['obstacleConflictCounts']
  incrementalServiceRatio: number
  valid: boolean
  rejectionReason: string | null
  selectionReason: string
  seedPoint?: number[]
  seedDistanceMeters?: number
  exitedPrimaryROW?: boolean
  seedInsideResidual?: boolean
  junctionIndex?: number
  junctionDistanceMeters?: number
  stopReason?: string
  lastAcceptedMarginalSqFt?: number
  nextRejectedMarginalSqFt?: number
  outsideArea?: number
  newlyServedWithoutPrimary?: GeoJSON.Feature<GeoJSON.Geometry> | null
  terrainSuitabilityScoring?: PrimaryRoadTerrainScoring | null
  terrainRoadScore?: number
  terrainPenalty?: number
  grammarPenalty?: number
  redevelopmentPenalty?: number
  terrainRoadMode?: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  _crossesPrimaryChecked?: boolean
  _conflictConstraintsChecked?: boolean
}

export function findResidualExitSeed(
  junction: GeoJSON.Feature<GeoJSON.Point>,
  startBearing: number,
  primaryRightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>,
  maxSearchM: number,
  stepM: number
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!junction || !junction.geometry || !residualArea || !residualArea.geometry) return null
  if (!primaryRightOfWay || !primaryRightOfWay.geometry) return null

  let currentM = 0
  while (currentM < maxSearchM) {
    if (currentM + stepM > maxSearchM) currentM = maxSearchM
    else currentM += stepM

    const probe = safeTurfOp(() => turf.destination(junction, currentM, startBearing, { units: 'meters' }), null)
    if (!probe || !isValidPosition(probe.geometry.coordinates)) return null

    const insidePrimary = pointInFreeArea(probe, primaryRightOfWay)
    const insideResidual = pointInFreeArea(probe, residualArea)

    if (!insidePrimary && insideResidual) {
      return probe
    }
    if (!insidePrimary && !insideResidual) {
      return null
    }
  }
  return null
}

const emptyPolygon: GeoJSON.Feature<GeoJSON.Geometry> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } as any

export function castBranch(
  junction: GeoJSON.Feature<GeoJSON.Point>,
  startBearing: number,
  primaryBearing: number,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>,
  primaryRightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  primaryCenterline: GeoJSON.Feature<GeoJSON.LineString> | null | undefined,
  maxLenM: number,
  minLenM: number,
  stepM: number
): BranchCandidate | null {
  if (!junction || !junction.geometry || !residualArea || !residualArea.geometry) return null
  const start = junction.geometry.coordinates

  const seed = findResidualExitSeed(
    junction,
    startBearing,
    primaryRightOfWay,
    residualArea,
    Math.min(ftToM(SEED_MAX_SEARCH_FEET), maxLenM),
    ftToM(SEED_STEP_FEET)
  )

  const seedDistanceM = seed ? safeTurfOp(() => turf.distance(junction, seed, { units: 'meters' }), 0) : 0

  if (!seed || seedDistanceM <= 0) {
    const probe = safeTurfOp(() => turf.destination(junction, ftToM(SEED_STEP_FEET), startBearing, { units: 'meters' }), null)
    const exited = !primaryRightOfWay || !primaryRightOfWay.geometry || (probe && !pointInFreeArea(probe, primaryRightOfWay))
    const inside = probe && pointInFreeArea(probe, residualArea)
    const branch: BranchCandidate = {
      id: '',
      centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } as any,
      rightOfWay: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } as any,
      junctionPoint: start,
      startBearing,
      seedPoint: start,
      seedDistanceMeters: 0,
      exitedPrimaryROW: !!exited,
      seedInsideResidual: !!inside,
      junctionAngle: 0,
      lengthFt: 0,
      templateType: 'simple-branch',
      newlyServedAreaSqFt: 0,
      newlyServedGeometry: null,
      servedGeometry: null,
      routeEfficiencyRatio: 1,
      bendCount: 0,
      maximumDeflectionAngle: 0,
      totalAbsoluteDeflection: 0,
      conflicts: { buildings: 0, hydrology: 0, pavement: 0, primaryROW: 0, parcelBoundary: 0, otherSecondaryROW: 0 },
      incrementalServiceRatio: 0,
      valid: false,
      rejectionReason: 'no residual exit found through primary ROW',
      selectionReason: '',
      stopReason: 'no residual exit found'
    }
    return branch
  }

  let currentM = seedDistanceM
  let lastValidM = currentM
  let lastValid = seed.geometry.coordinates
  let stopReason: string | undefined = undefined

  while (currentM < maxLenM) {
    if (currentM + stepM > maxLenM) currentM = maxLenM
    else currentM += stepM

    const probe = safeTurfOp(() => turf.destination(junction, currentM, startBearing, { units: 'meters' }), null)
    if (!probe || !isValidPosition(probe.geometry.coordinates)) {
      stopReason = 'geometry construction failed'
      break
    }
    if (!pointInFreeArea(probe, residualArea)) {
      stopReason = 'residual boundary reached'
      break
    }

    const centerline = makeSafeLineString([start, probe.geometry.coordinates])
    if (!centerline) {
      stopReason = 'geometry construction failed'
      break
    }

    if (primaryCenterline && crossesPrimaryOtherThanStart(centerline, primaryCenterline, start)) {
      stopReason = 'centerline crosses primary spine outside the junction'
      break
    }

    lastValidM = currentM
    lastValid = probe.geometry.coordinates

    if (currentM >= maxLenM) {
      stopReason = 'safety hard cap reached'
    }
  }

  const seedPt = seed.geometry.coordinates
  if (!lastValid || positionsAreEqual(seedPt, lastValid) || positionsAreEqual(start, lastValid)) return null

  let trimmedM = lastValidM
  let trimmedPoint = lastValid
  let finalCenterline: GeoJSON.Feature<GeoJSON.LineString> | null = null
  let finalRightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null = null
  let finalLengthM = 0

  while (trimmedM >= minLenM) {
    const centerline = makeSafeLineString([start, trimmedPoint])
    const lengthM = centerline ? safeTurfOp(() => turf.length(centerline, { units: 'meters' }), 0) : 0
    if (!centerline || lengthM < minLenM) {
      trimmedM -= stepM
      const nextProbe = safeTurfOp(() => turf.destination(junction, trimmedM, startBearing, { units: 'meters' }), null)
      if (!nextProbe || !isValidPosition(nextProbe.geometry.coordinates)) break
      trimmedPoint = nextProbe.geometry.coordinates
      continue
    }
    const rightOfWay = safeTurfOp(() => turf.buffer(centerline, SECONDARY_ROAD_HALF_WIDTH_METERS, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry>, null)
    if (!rightOfWay || !rightOfWay.geometry) {
      trimmedM -= stepM
      const nextProbe = safeTurfOp(() => turf.destination(junction, trimmedM, startBearing, { units: 'meters' }), null)
      if (!nextProbe || !isValidPosition(nextProbe.geometry.coordinates)) break
      trimmedPoint = nextProbe.geometry.coordinates
      continue
    }
    const outsideArea = areaOutsideResidual(rightOfWay, residualArea, start, primaryRightOfWay)
    if (outsideArea <= GEOMETRY_TOLERANCE_SQ_METERS) {
      finalCenterline = centerline
      finalRightOfWay = rightOfWay
      finalLengthM = lengthM
      break
    }
    stopReason = 'right-of-way leaves the developable residual area'
    trimmedM -= stepM
    const nextProbe = safeTurfOp(() => turf.destination(junction, trimmedM, startBearing, { units: 'meters' }), null)
    if (!nextProbe || !isValidPosition(nextProbe.geometry.coordinates)) break
    trimmedPoint = nextProbe.geometry.coordinates
  }

  if (!finalCenterline || !finalRightOfWay) {
    const tooShort: BranchCandidate = {
      id: '',
      centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } as any,
      rightOfWay: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } as any,
      junctionPoint: start,
      startBearing,
      seedPoint: seedPt,
      seedDistanceMeters: seedDistanceM,
      exitedPrimaryROW: true,
      seedInsideResidual: true,
      junctionAngle: 0,
      lengthFt: mToFt(trimmedM > 0 ? trimmedM : seedDistanceM),
      templateType: 'simple-branch',
      newlyServedAreaSqFt: 0,
      newlyServedGeometry: null,
      servedGeometry: null,
      routeEfficiencyRatio: 1,
      bendCount: 0,
      maximumDeflectionAngle: 0,
      totalAbsoluteDeflection: 0,
      conflicts: { buildings: 0, hydrology: 0, pavement: 0, primaryROW: 0, parcelBoundary: 0, otherSecondaryROW: 0 },
      incrementalServiceRatio: 0,
      valid: false,
      rejectionReason: 'branch terminated before the minimum branch length',
      selectionReason: '',
      stopReason: stopReason || 'branch terminated before the minimum branch length'
    }
    return tooShort
  }

  const junctionAngle = acuteAngleDifference(primaryBearing, startBearing)

  const branch: BranchCandidate = {
    id: '',
    centerline: finalCenterline,
    rightOfWay: finalRightOfWay ?? emptyPolygon,
    junctionPoint: start,
    junctionAngle,
    startBearing,
    lengthFt: mToFt(finalLengthM),
    templateType: 'simple-branch',
    newlyServedAreaSqFt: 0,
    newlyServedGeometry: null,
    servedGeometry: null,
    routeEfficiencyRatio: 1,
    bendCount: Math.max(0, finalCenterline.geometry.coordinates.length - 2),
    maximumDeflectionAngle: 0,
    totalAbsoluteDeflection: 0,
    conflicts: { buildings: 0, hydrology: 0, pavement: 0, primaryROW: 0, parcelBoundary: 0, otherSecondaryROW: 0 },
    incrementalServiceRatio: 0,
    valid: true,
    rejectionReason: null,
    selectionReason: '',
    seedPoint: seedPt,
    seedDistanceMeters: seedDistanceM,
    exitedPrimaryROW: true,
    seedInsideResidual: true,
    stopReason: stopReason || 'natural termination'
  }
  return branch
}

function serviceBufferForLine(
  line: GeoJSON.Feature<GeoJSON.LineString>,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!line || !line.geometry) return null
  const buffer = safeTurfOp(() => turf.buffer(line, ftToM(SECONDARY_SERVICE_BUFFER_FEET), { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry>, null)
  if (!buffer) return null
  return geometryIntersection(buffer, residualArea)
}

function areaOutsideResidual(
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry>,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>,
  start: number[],
  primaryRightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined
): number {
  if (!rightOfWay || !rightOfWay.geometry || !residualArea || !residualArea.geometry) return Infinity
  const startCap = safeTurfOp(() => turf.buffer(turf.point(start), SECONDARY_ROAD_HALF_WIDTH_METERS + 0.5, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry>, null)
  let rowWithoutStart = rightOfWay
  if (startCap) {
    rowWithoutStart = geometryDifference(rightOfWay, startCap) ?? rightOfWay
  }
  if (primaryRightOfWay && primaryRightOfWay.geometry) {
    const primaryOverlap = geometryIntersection(rowWithoutStart, primaryRightOfWay)
    if (primaryOverlap && primaryOverlap.geometry) {
      rowWithoutStart = geometryDifference(rowWithoutStart, primaryOverlap) ?? rowWithoutStart
    }
  }
  const outside = geometryDifference(rowWithoutStart, residualArea)
  return outside ? safeTurfOp(() => turf.area(outside), 0) : 0
}

function overlapsExistingSecondary(
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry>,
  existing: GeoJSON.Feature<GeoJSON.Geometry>[]
): boolean {
  if (!rightOfWay || !rightOfWay.geometry || existing.length === 0) return false
  for (const existingRow of existing) {
    if (!existingRow || !existingRow.geometry) continue
    const overlap = geometryIntersection(rightOfWay, existingRow)
    if (overlap && overlap.geometry && safeTurfOp(() => turf.area(overlap), 0) > GEOMETRY_TOLERANCE_SQ_METERS) {
      return true
    }
  }
  return false
}

function crossesPrimaryOtherThanStart(
  branchLine: GeoJSON.Feature<GeoJSON.LineString>,
  primaryLine: GeoJSON.Feature<GeoJSON.LineString>,
  start: number[]
): boolean {
  if (!branchLine || !branchLine.geometry || !primaryLine || !primaryLine.geometry) return false
  const intersections = safeTurfOp(() => (turf.lineIntersect as any)(branchLine as any, primaryLine as any) as GeoJSON.FeatureCollection<GeoJSON.Point>, null)
  if (!intersections || !intersections.features) return false
  for (const pt of intersections.features) {
    if (!pt.geometry || !isValidPosition(pt.geometry.coordinates)) continue
    const d = safeTurfOp(() => turf.distance(turf.point(start), pt, { units: 'meters' }), Infinity)
    if (d > 1.0) return true
  }
  return false
}

function computeBendMetrics(centerline: GeoJSON.Feature<GeoJSON.LineString> | null): { bendCount: number; maxDeflection: number; totalDeflection: number; routeEfficiency: number } {
  if (!centerline || !centerline.geometry || centerline.geometry.coordinates.length < 2) {
    return { bendCount: 0, maxDeflection: 0, totalDeflection: 0, routeEfficiency: 1 }
  }
  const coords = centerline.geometry.coordinates
  const start = coords[0]
  const end = coords[coords.length - 1]
  const straightM = safeTurfOp(() => turf.distance(turf.point(start), turf.point(end), { units: 'meters' }), 0)
  const lengthM = safeTurfOp(() => turf.length(centerline, { units: 'meters' }), 0)
  const routeEfficiency = lengthM > 0 ? straightM / lengthM : 1

  let bendCount = 0
  let maxDeflection = 0
  let totalDeflection = 0
  for (let i = 1; i < coords.length - 1; i++) {
    const a = [coords[i - 1], coords[i], coords[i + 1]]
    const b1 = fastBearing(a[0], a[1]) ?? 0
    const b2 = fastBearing(a[1], a[2]) ?? 0
    const deflection = acuteAngleDifference(b1, b2)
    if (deflection > MIN_BEND_ANGLE_DEG) {
      bendCount++
      maxDeflection = Math.max(maxDeflection, deflection)
      totalDeflection += deflection
    }
  }

  return { bendCount, maxDeflection, totalDeflection, routeEfficiency }
}

export function validateAndScoreCandidate(
  branch: BranchCandidate,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>,
  primaryCenterline: GeoJSON.Feature<GeoJSON.LineString>,
  primaryRightOfWay: GeoJSON.Feature<GeoJSON.Geometry>,
  primaryServedArea: GeoJSON.Feature<GeoJSON.Geometry>,
  existingServedAreas: GeoJSON.Feature<GeoJSON.Geometry>[],
  existingRightOfWays: GeoJSON.Feature<GeoJSON.Geometry>[],
  buildingUnion: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  hydrology: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  pavement: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  _parcelFeature: GeoJSON.Feature<GeoJSON.Geometry> | null,
  terrainSuitability: TerrainSuitabilityResult | null | undefined = undefined,
  primaryTerrainMode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK' = 'DIRECT_FALLBACK'
): BranchCandidate {
  const start = branch.junctionPoint

  // Phase 7B.3B: score the candidate centerline once using the cached terrain query.
  // This runs before hard checks so rejected candidates still carry diagnostic terrain data.
  if (terrainSuitability !== undefined && !branch.terrainSuitabilityScoring) {
    if (branch.centerline?.geometry?.coordinates && branch.centerline.geometry.coordinates.length >= 2) {
      branch.terrainSuitabilityScoring = computeRoadTerrainScore(branch.centerline, terrainSuitability)
      branch.terrainRoadScore = branch.terrainSuitabilityScoring.terrainRoadScore
    }
  }

  if (branch.valid === false && branch.rejectionReason) {
    return branch
  }

  // Invariant checks that only depend on the branch and primary geometry.
  if (!branch._crossesPrimaryChecked) {
    if (crossesPrimaryOtherThanStart(branch.centerline, primaryCenterline, start)) {
      branch.conflicts.primaryROW = 1
    }
    branch._crossesPrimaryChecked = true
  }
  if (branch.conflicts.primaryROW) {
    branch.valid = false
    branch.rejectionReason = 'centerline crosses primary spine outside the junction'
    return branch
  }

  if (branch.outsideArea == null) {
    branch.outsideArea = areaOutsideResidual(branch.rightOfWay, residualArea, start, primaryRightOfWay)
  }
  if (branch.outsideArea > GEOMETRY_TOLERANCE_SQ_METERS) {
    branch.conflicts.parcelBoundary = 1
    branch.valid = false
    branch.rejectionReason = 'right-of-way leaves the developable residual area'
    return branch
  }

  // Selection-dependent: existing secondary right-of-way overlap.
  if (overlapsExistingSecondary(branch.rightOfWay, existingRightOfWays)) {
    branch.conflicts.otherSecondaryROW = 1
    branch.valid = false
    branch.rejectionReason = 'right-of-way overlaps an existing secondary road'
    return branch
  }

  // Invariant constraint overlap.
  if (!branch._conflictConstraintsChecked) {
    if (rowOverlapsArea(branch.rightOfWay, buildingUnion)) branch.conflicts.buildings = 1
    if (rowOverlapsArea(branch.rightOfWay, hydrology)) branch.conflicts.hydrology = 1
    if (rowOverlapsArea(branch.rightOfWay, pavement)) branch.conflicts.pavement = 1
    branch._conflictConstraintsChecked = true
  }

  if (branch.conflicts.buildings || branch.conflicts.hydrology || branch.conflicts.pavement) {
    branch.valid = false
    branch.rejectionReason = 'right-of-way overlaps buildings, hydrology, or pavement'
    return branch
  }

  if (branch.junctionAngle < 30) {
    branch.valid = false
    branch.rejectionReason = 'junction angle is too shallow'
    return branch
  }

  // Invariant served geometry.
  if (!branch.servedGeometry) {
    branch.servedGeometry = serviceBufferForLine(branch.centerline, residualArea)
  }
  if (!branch.servedGeometry || !branch.servedGeometry.geometry) {
    branch.valid = false
    branch.rejectionReason = 'could not compute service area for branch'
    return branch
  }

  // Invariant: service area after subtracting the primary served area.
  if (!branch.newlyServedWithoutPrimary) {
    branch.newlyServedWithoutPrimary = geometryDifference(branch.servedGeometry, primaryServedArea) ?? branch.servedGeometry
  }

  // Selection-dependent: subtract already-selected secondary served areas.
  let newlyServed = branch.newlyServedWithoutPrimary
  for (const existing of existingServedAreas) {
    if (!existing || !existing.geometry) continue
    newlyServed = geometryDifference(newlyServed, existing) ?? newlyServed
  }
  branch.newlyServedGeometry = newlyServed
  branch.newlyServedAreaSqFt = areaSqFt(newlyServed)

  // Invariant bend metrics.
  if (branch.bendCount === 0 && branch.maximumDeflectionAngle === 0 && branch.totalAbsoluteDeflection === 0) {
    const { bendCount, maxDeflection, totalDeflection, routeEfficiency } = computeBendMetrics(branch.centerline)
    branch.bendCount = bendCount
    branch.maximumDeflectionAngle = maxDeflection
    branch.totalAbsoluteDeflection = totalDeflection
    branch.routeEfficiencyRatio = routeEfficiency
  }

  if (branch.newlyServedAreaSqFt < MIN_INCREMENTAL_SERVICE_SQFT) {
    branch.valid = false
    branch.rejectionReason = `newly served area ${Math.round(branch.newlyServedAreaSqFt)} sq ft is below the ${MIN_INCREMENTAL_SERVICE_SQFT} threshold`
    return branch
  }

  const averageServedWidthFt = branch.newlyServedAreaSqFt / (branch.lengthFt + 0.0001)
  if (averageServedWidthFt < MIN_CORRIDOR_WIDTH_FEET) {
    branch.valid = false
    branch.rejectionReason = `served corridor is too narrow for development service`
    return branch
  }

  branch.incrementalServiceRatio = branch.newlyServedAreaSqFt / (branch.lengthFt * SECONDARY_SERVICE_BUFFER_FEET)

  // Phase 7B.3B: soft terrain penalty as a fraction of newly served area.
  const terrainRoadScore = branch.terrainRoadScore ?? 1
  branch.terrainPenalty = branch.newlyServedAreaSqFt * (1 - terrainRoadScore) * SECONDARY_TERRAIN_INFLUENCE_PCT

  // Road grammar soft penalty.
  branch.grammarPenalty = computeSecondaryGrammarPenalty(branch, primaryCenterline, terrainSuitability, primaryTerrainMode)

  // Redevelopment opportunity/disturbance scoring.
  const rd = computeRedevelopmentDisturbance(branch.rightOfWay, {
    servedDevelopableAreaSqFt: branch.newlyServedAreaSqFt,
    isDirectAccess: true,
    unlocksAdditionalAcreage: branch.newlyServedAreaSqFt > 10000
  })
  branch.redevelopmentPenalty = rd.totalPenalty

  branch.valid = true
  branch.rejectionReason = null
  branch.selectionReason = `newly serves ${Math.round(branch.newlyServedAreaSqFt).toLocaleString()} sq ft with a ${branch.lengthFt.toFixed(0)} ft branch at a ${branch.junctionAngle.toFixed(0)}° junction`
  return branch
}

export function generateBranchCandidates(
  primaryRoad: ConceptualRoadSkeletonResult,
  residualArea: GeoJSON.Feature<GeoJSON.Geometry>,
  primaryServedArea: GeoJSON.Feature<GeoJSON.Geometry>,
  buildingUnion: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  hydrology: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  pavement: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  parcelFeature: GeoJSON.Feature<GeoJSON.Geometry> | null,
  networkPreference: RoadNetworkPreference,
  terrainSuitability: TerrainSuitabilityResult | null | undefined = undefined,
  primaryTerrainMode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK' = 'DIRECT_FALLBACK'
): BranchCandidate[] {
  const primaryCenterline = primaryRoad.proposedRoadCenterline
  if (!primaryCenterline || !primaryCenterline.geometry) return []

  const primaryRightOfWay = primaryRoad.proposedRightOfWay
  const totalLengthM = safeTurfOp(() => turf.length(primaryCenterline, { units: 'meters' }), 0)
  if (totalLengthM <= 0) return []

  const startSkip = ftToM(MIN_JUNCTION_SPACING_FT / 2)
  const endSkip = ftToM(MIN_JUNCTION_SPACING_FT / 2)
  const stepM = ftToM(JUNCTION_STEP_FEET)
  const minLenM = ftToM(MIN_BRANCH_LENGTH_FEET)
  const maxLenM = ftToM(MAX_BRANCH_LENGTH_FEET)
  const rayStepM = ftToM(RAY_STEP_FEET)

  const baseAngles = [90, -90, 60, -60, 45, -45, 120, -120, 30, -30, 150, -150]
  const gridAngles = networkPreference === 'modified-grid' ? [90, -90] : baseAngles

  const candidates: BranchCandidate[] = []
  let pointIdx = 0
  for (let dM = startSkip; dM <= totalLengthM - endSkip; dM += stepM) {
    const junction = fastAlong(primaryCenterline, dM, 'meters')
    if (!junction || !junction.geometry || !isValidPosition(junction.geometry.coordinates)) continue
    const primaryBearing = lineBearingAtPoint(primaryCenterline, dM, totalLengthM)
    if (primaryBearing == null) continue

    for (const angleOffset of gridAngles) {
      const branchBearing = normalizeBearing(primaryBearing + angleOffset)
      const branch = castBranch(
        junction,
        branchBearing,
        primaryBearing,
        residualArea,
        primaryRightOfWay,
        primaryCenterline,
        maxLenM,
        minLenM,
        rayStepM
      )
      if (!branch) continue
      branch.id = `sec-${pointIdx}-${angleOffset}`
      branch.junctionIndex = pointIdx
      branch.junctionDistanceMeters = dM
      candidates.push(
        validateAndScoreCandidate(
          branch,
          residualArea,
          primaryCenterline,
          primaryRightOfWay ?? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
          primaryServedArea,
          [],
          [],
          buildingUnion,
          hydrology,
          pavement,
          parcelFeature,
          terrainSuitability,
          primaryTerrainMode
        )
      )
    }
    pointIdx++
  }

  return candidates
}

function buildExplorationSummary(result: SecondaryRoadNetworkResult): string {
  if (result.status === 'unavailable') {
    return 'Secondary network unavailable because no feasible primary development spine was identified.'
  }
  if (result.roads.length === 0) {
    return 'No secondary roads were added because the remaining developable area is too constrained, too narrow, or does not provide meaningful additional development service.'
  }
  const total = result.roads.length
  const totalNewServed = result.secondaryNewlyServedAreaSqFt
  return `${total} conceptual secondary ${total === 1 ? 'road was' : 'roads were'} added to the primary spine, increasing the reachable developable area by approximately ${(totalNewServed / 43560).toFixed(2)} acres.`
}

export async function generateSecondaryRoadNetwork(
  options: GenerateSecondaryRoadNetworkOptions
): Promise<SecondaryRoadNetworkResult> {
  recomputeCounter.increment('secondaryRoad')
  const startTime = performance.now()
  bboxCacheHits = 0
  bboxCacheMisses = 0
  const turfBefore = turfPerformance.get()
  const { mcpi, primaryRoad, candidateOpenArea, roadParameters, terrainData, terrainSuitability, signal, primaryTerrainMode = 'DIRECT_FALLBACK' } = options

  const primaryCenterline = primaryRoad.proposedRoadCenterline
  const primaryRightOfWay = primaryRoad.proposedRightOfWay

  const emptyResult: SecondaryRoadNetworkResult = {
    status: 'empty',
    mcpi,
    primaryRoadUsed: primaryRoad
      ? {
          mcpi: primaryRoad.mcpi,
          roadLengthFt: primaryRoad.proposedRoadLengthFeet,
          connectionMethod: primaryRoad.connectionMethod || 'unknown'
        }
      : null,
    secondaryRoadCount: 0,
    totalSecondaryRoadLengthFt: 0,
    totalSecondaryROWAreaSqFt: 0,
    primaryServedAreaSqFt: 0,
    secondaryNewlyServedAreaSqFt: 0,
    totalNetworkServedAreaSqFt: 0,
    totalNetworkServiceRatio: 0,
    residualUnservedDevelopableAreaSqFt: 0,
    roads: [],
    warnings: [],
    explanation: ''
  }

  if (signal?.aborted) {
    emptyResult.status = 'unavailable'
    emptyResult.explanation = 'Secondary road generation was aborted.'
    return emptyResult
  }

  if (!primaryRoad || (primaryRoad.status !== 'generated' && primaryRoad.status !== 'warning')) {
    emptyResult.status = 'unavailable'
    emptyResult.explanation = 'Secondary network unavailable because no feasible primary development spine was identified.'
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[SecondaryRoadNetworkResult]', { mcpi, status: 'unavailable', reason: 'primary road not generated', primaryStatus: primaryRoad?.status })
    }
    return emptyResult
  }

  if (!primaryCenterline || !primaryCenterline.geometry) {
    emptyResult.status = 'unavailable'
    emptyResult.explanation = 'Secondary network unavailable because the primary spine has no centerline.'
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[SecondaryRoadNetworkResult]', { mcpi, status: 'unavailable', reason: 'no primary centerline' })
    }
    return emptyResult
  }

  let residualArea: GeoJSON.Feature<GeoJSON.Geometry> | null = null
  if (primaryRoad.residualDevelopmentArea) {
    residualArea = ensureFeature(primaryRoad.residualDevelopmentArea)
  }
  if (!residualArea && candidateOpenArea.candidateGeometry) {
    const coa = ensureFeature(candidateOpenArea.candidateGeometry)
    const row = primaryRightOfWay
    if (coa && row) {
      residualArea = geometryDifference(coa, row)
    } else {
      residualArea = coa
    }
  }
  if (!residualArea || !residualArea.geometry) {
    emptyResult.status = 'empty'
    emptyResult.explanation = 'No residual developable area remains after the primary spine.'
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[SecondaryRoadNetworkResult]', { mcpi, status: 'empty', reason: 'no residual area' })
    }
    return emptyResult
  }

  const residualAreaSqFt = areaSqFt(residualArea)
  if (residualAreaSqFt < MIN_INCREMENTAL_SERVICE_SQFT) {
    emptyResult.status = 'empty'
    emptyResult.explanation = 'The remaining developable area is too small to justify additional internal circulation.'
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[SecondaryRoadNetworkResult]', { mcpi, status: 'empty', reason: 'residual area too small', residualAreaSqFt })
    }
    return emptyResult
  }

  const parcelFeature = ensureFeature(options.parcelGeometry)
  const primaryServedGeometry = serviceBufferForLine(primaryCenterline, residualArea) ?? residualArea
  const primaryServedAreaSqFt = areaSqFt(primaryServedGeometry)

  const tGenerateBranchCandidates = performance.now()
  const candidates = generateBranchCandidates(
    primaryRoad,
    residualArea,
    primaryServedGeometry,
    candidateOpenArea.buildingUnionGeometry,
    candidateOpenArea.hydrologyGeometry,
    candidateOpenArea.pavementGeometry,
    parcelFeature,
    roadParameters.networkPreference,
    terrainSuitability,
    primaryTerrainMode
  )
  const generateBranchCandidatesMs = performance.now() - tGenerateBranchCandidates
  const auditCandidateCount = candidates.length

  if (VERBOSE_GIS_DIAGNOSTICS && candidates.length > 0) {
    for (const c of candidates) {
      console.log('[SecondaryRoadCandidateAudit]', {
        id: c.id,
        template: c.templateType,
        lengthFt: Math.round(c.lengthFt),
        newServedAreaSqFt: Math.round(c.newlyServedAreaSqFt),
        serviceRatio: c.incrementalServiceRatio,
        bends: c.bendCount,
        efficiency: c.routeEfficiencyRatio,
        conflicts: c.conflicts,
        redundancy: false,
        junctionAngle: c.junctionAngle,
        junctionPoint: c.junctionPoint,
        departureBearing: c.startBearing,
        seedPoint: c.seedPoint,
        centerlineToSeedDistanceFt: c.seedDistanceMeters ? mToFt(c.seedDistanceMeters) : null,
        exitedPrimaryROW: c.exitedPrimaryROW,
        seedInsideResidual: c.seedInsideResidual,
        rejectionReason: c.rejectionReason
      })
    }
  }

  const selected: BranchCandidate[] = []
  const selectedServed: GeoJSON.Feature<GeoJSON.Geometry>[] = []
  const selectedRightOfWays: GeoJSON.Feature<GeoJSON.Geometry>[] = []
  const selectedJunctionIndexes = new Set<number>()
  let warnings: string[] = []

  const residualUnservedGeometry = geometryDifference(residualArea, primaryServedGeometry) ?? residualArea
  let residualUnservedAreaSqFt = areaSqFt(residualUnservedGeometry)

  const iterationAudits: any[] = []
  let terrainChangedSelectionCount = 0

  const tSelectionLoop = performance.now()
  for (let iteration = 0; iteration < MAX_SECONDARY_ROADS; iteration++) {
    if (selected.length >= MAX_SECONDARY_ROADS) {
      break
    }
    if (signal?.aborted) {
      warnings.push('Secondary road generation was aborted before completion.')
      break
    }
    if (iteration % 1 === 0) {
      await yieldIfNeeded(options.signal)
      if (signal?.aborted) {
        warnings.push('Secondary road generation was aborted before completion.')
        break
      }
    }

    // Re-score remaining candidates against already selected roads.
    const scored = candidates
      .filter((c) => c.valid)
      .map((c) =>
        validateAndScoreCandidate(
          { ...c, id: c.id },
          residualArea,
          primaryCenterline,
          primaryRightOfWay ?? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
          primaryServedGeometry,
          selectedServed,
          selectedRightOfWays,
          candidateOpenArea.buildingUnionGeometry,
          candidateOpenArea.hydrologyGeometry,
          candidateOpenArea.pavementGeometry,
          parcelFeature,
          terrainSuitability,
          primaryTerrainMode
        )
      )

    // Phase 7B.3B: terrain is a soft ~15% adjustment of newly served area.
    const best = scored
      .filter(
        (c) =>
          c.valid &&
          c.newlyServedAreaSqFt >= MIN_INCREMENTAL_SERVICE_SQFT &&
          (c.newlyServedAreaSqFt >= MIN_MEANINGFUL_SERVICE_SQFT ||
            (residualUnservedAreaSqFt > 0 &&
              c.newlyServedAreaSqFt / residualUnservedAreaSqFt >= MIN_MEANINGFUL_SERVICE_FRACTION)) &&
          !selectedJunctionIndexes.has(c.junctionIndex ?? -1)
      )
      .sort((a, b) => {
        const aFinal = a.newlyServedAreaSqFt - (a.terrainPenalty ?? 0) - (a.grammarPenalty ?? 0) - (a.redevelopmentPenalty ?? 0)
        const bFinal = b.newlyServedAreaSqFt - (b.terrainPenalty ?? 0) - (b.grammarPenalty ?? 0) - (b.redevelopmentPenalty ?? 0)
        if (bFinal !== aFinal) return bFinal - aFinal
        if (a.lengthFt !== b.lengthFt) return a.lengthFt - b.lengthFt
        if (a.bendCount !== b.bendCount) return a.bendCount - b.bendCount
        return b.routeEfficiencyRatio - a.routeEfficiencyRatio
      })[0]

    if (!best) {
      if (iteration === 0) {
        warnings.push('No secondary branch added: remaining developable area is too constrained, too narrow, or does not provide meaningful additional development service.')
      }
      break
    }

    best.conflicts = { ...best.conflicts }

    if (import.meta.env.DEV) {
      // Baseline winner uses the original area-first ranking (no terrain).
      const baselineCandidates = [...scored].sort((a, b) => {
        if (b.newlyServedAreaSqFt !== a.newlyServedAreaSqFt) return b.newlyServedAreaSqFt - a.newlyServedAreaSqFt
        if (a.lengthFt !== b.lengthFt) return a.lengthFt - b.lengthFt
        if (a.bendCount !== b.bendCount) return a.bendCount - b.bendCount
        return b.routeEfficiencyRatio - a.routeEfficiencyRatio
      })
      const baselineWinner = baselineCandidates[0]

      const topTerrainAware = scored
        .filter(
          (c) =>
            c.valid &&
            c.newlyServedAreaSqFt >= MIN_INCREMENTAL_SERVICE_SQFT &&
            !selectedJunctionIndexes.has(c.junctionIndex ?? -1)
        )
        .sort((a, b) => {
          const aFinal = a.newlyServedAreaSqFt - (a.terrainPenalty ?? 0) - (a.redevelopmentPenalty ?? 0)
          const bFinal = b.newlyServedAreaSqFt - (b.terrainPenalty ?? 0) - (b.redevelopmentPenalty ?? 0)
          if (bFinal !== aFinal) return bFinal - aFinal
          if (a.lengthFt !== b.lengthFt) return a.lengthFt - b.lengthFt
          if (a.bendCount !== b.bendCount) return a.bendCount - b.bendCount
          return b.routeEfficiencyRatio - a.routeEfficiencyRatio
        })
        .slice(0, 5)

      const asAcres = (sqFt: number) => round3(sqFt / 43560)
      const candidateAudit = (c: BranchCandidate) => ({
        candidateId: c.id,
        roadType: c.templateType,
        existingScore: asAcres(c.newlyServedAreaSqFt),
        terrainRoadScore: round3(c.terrainRoadScore ?? 1),
        terrainPenalty: asAcres(c.terrainPenalty ?? 0),
        finalScore: asAcres(c.newlyServedAreaSqFt - (c.terrainPenalty ?? 0)),
        newlyServedAreaAcres: asAcres(c.newlyServedAreaSqFt),
        roadLengthFt: round3(c.lengthFt),
        preferredPct: round3((c.terrainSuitabilityScoring?.preferredFraction ?? 0) * 100),
        moderatePct: round3((c.terrainSuitabilityScoring?.moderateFraction ?? 0) * 100),
        challengingPct: round3((c.terrainSuitabilityScoring?.challengingFraction ?? 0) * 100),
        avoidPct: round3((c.terrainSuitabilityScoring?.avoidFraction ?? 0) * 100),
        insufficientPct: round3((c.terrainSuitabilityScoring?.insufficientDataFraction ?? 0) * 100),
        meanSlopePct: c.terrainSuitabilityScoring?.meanSlopePct ?? null,
        maxSlopePct: c.terrainSuitabilityScoring?.maxSlopePct ?? null,
        dominantClass: c.terrainSuitabilityScoring?.dominantClass ?? 'INSUFFICIENT_DATA',
        sampleCount: c.terrainSuitabilityScoring?.sampleCount ?? 0,
        hardRejected: !c.valid
      })

      const winnerChanged = !baselineWinner || best.id !== baselineWinner.id
      if (winnerChanged) {
        terrainChangedSelectionCount++
      }

      iterationAudits.push({
        iteration,
        candidateCount: scored.length,
        baselineWinnerWithoutSuitability: baselineWinner
          ? {
              candidateId: baselineWinner.id,
              existingScore: asAcres(baselineWinner.newlyServedAreaSqFt),
              newlyServedAreaAcres: asAcres(baselineWinner.newlyServedAreaSqFt)
            }
          : null,
        winnerWithSuitability: {
          candidateId: best.id,
          existingScore: asAcres(best.newlyServedAreaSqFt),
          terrainRoadScore: round3(best.terrainRoadScore ?? 1),
          finalScore: asAcres(best.newlyServedAreaSqFt - (best.terrainPenalty ?? 0)),
          newlyServedAreaAcres: asAcres(best.newlyServedAreaSqFt)
        },
        winnerChangedBecauseOfTerrain: winnerChanged,
        candidates: topTerrainAware.map(candidateAudit)
      })
    }

    selected.push(best)
    selectedJunctionIndexes.add(best.junctionIndex ?? -1)
    if (best.servedGeometry) selectedServed.push(best.servedGeometry)
    selectedRightOfWays.push(best.rightOfWay)
    residualUnservedAreaSqFt = Math.max(0, residualUnservedAreaSqFt - best.newlyServedAreaSqFt)
  }
  const selectionLoopMs = performance.now() - tSelectionLoop

  const roads: SecondaryRoad[] = selected.map((s) => ({
    id: s.id,
    templateType: s.templateType,
    centerlineGeometry: s.centerline,
    rightOfWayGeometry: s.rightOfWay,
    lengthFt: s.lengthFt,
    newlyServedAreaSqFt: s.newlyServedAreaSqFt,
    incrementalServiceRatio: s.incrementalServiceRatio,
    routeEfficiencyRatio: s.routeEfficiencyRatio,
    bendCount: s.bendCount,
    maximumDeflectionAngle: s.maximumDeflectionAngle,
    totalAbsoluteDeflection: s.totalAbsoluteDeflection,
    junctionPoint: s.junctionPoint,
    junctionAngle: s.junctionAngle,
    obstacleConflictCounts: { ...s.conflicts },
    selectionReason: s.selectionReason,
    junctionIndex: s.junctionIndex ?? -1,
    stopReason: s.stopReason ?? 'unknown',
    terrainProfile: sampleTerrainProfile(s.id, 'secondary', null, s.centerline, s.lengthFt, terrainData || null),
    terrainRoadScore: s.terrainRoadScore ?? 1,
    terrainPenalty: s.terrainPenalty ?? 0,
    grammarPenalty: s.grammarPenalty ?? 0,
    terrainSuitabilityScoring: s.terrainSuitabilityScoring ?? null
  }))

  const totalSecondaryLength = roads.reduce((sum, r) => sum + r.lengthFt, 0)
  const totalSecondaryROWArea = roads.reduce((sum, r) => sum + areaSqFt(r.rightOfWayGeometry), 0)
  const totalNewServed = roads.reduce((sum, r) => sum + r.newlyServedAreaSqFt, 0)
  const rawServedSum = primaryServedAreaSqFt + totalNewServed

  const allServedGeometries = [primaryServedGeometry, ...selectedServed].filter((g): g is GeoJSON.Feature<GeoJSON.Geometry> => !!g && !!g.geometry)
  let uniqueServedGeometry = geometryUnion(allServedGeometries) ?? primaryServedGeometry
  if (uniqueServedGeometry?.geometry) {
    uniqueServedGeometry = geometryIntersection(uniqueServedGeometry, residualArea) ?? uniqueServedGeometry
  }
  if (uniqueServedGeometry?.geometry && candidateOpenArea.candidateGeometry) {
    const candidateFeature = ensureFeature(candidateOpenArea.candidateGeometry)
    if (candidateFeature?.geometry) {
      uniqueServedGeometry = geometryIntersection(uniqueServedGeometry, candidateFeature) ?? uniqueServedGeometry
    }
  }
  if (uniqueServedGeometry?.geometry && parcelFeature?.geometry) {
    uniqueServedGeometry = geometryIntersection(uniqueServedGeometry, parcelFeature) ?? uniqueServedGeometry
  }
  const uniqueServedAreaSqFt = uniqueServedGeometry ? areaSqFt(uniqueServedGeometry) : 0
  const totalNetworkServed = Math.min(
    uniqueServedAreaSqFt > 0 ? uniqueServedAreaSqFt : Math.min(rawServedSum, residualAreaSqFt),
    residualAreaSqFt
  )
  const residualUnserved = Math.max(0, residualAreaSqFt - totalNetworkServed)
  const serviceRatio = residualAreaSqFt > 0 ? totalNetworkServed / residualAreaSqFt : 0

  const result: SecondaryRoadNetworkResult = {
    status: roads.length > 0 ? 'generated' : 'empty',
    mcpi,
    primaryRoadUsed: {
      mcpi: primaryRoad.mcpi,
      roadLengthFt: primaryRoad.proposedRoadLengthFeet,
      connectionMethod: primaryRoad.connectionMethod || 'unknown'
    },
    secondaryRoadCount: roads.length,
    totalSecondaryRoadLengthFt: totalSecondaryLength,
    totalSecondaryROWAreaSqFt: totalSecondaryROWArea,
    primaryServedAreaSqFt,
    secondaryNewlyServedAreaSqFt: totalNewServed,
    totalNetworkServedAreaSqFt: totalNetworkServed,
    totalNetworkServiceRatio: serviceRatio,
    residualUnservedDevelopableAreaSqFt: residualUnserved,
    roads,
    warnings,
    explanation: ''
  }

  result.explanation = buildExplorationSummary(result)

  if (import.meta.env.DEV) {
    const candidateAcres = candidateOpenArea.candidateAreaAcres ?? 0
    const parentAcres = parcelFeature ? areaSqFt(parcelFeature) / 43560 : 0
    const rawServedAreaSumAcres = rawServedSum / 43560
    const uniqueServedAreaAcres = uniqueServedAreaSqFt / 43560
    const networkServedAcres = totalNetworkServed / 43560
    const overlapDifferenceAcres = rawServedAreaSumAcres - networkServedAcres
    const tolerance = 0.05
    console.log('[ServedAreaIntegrityAudit]', {
      mcpi,
      parentParcelAcres: parentAcres,
      candidateDevelopableAcres: candidateAcres,
      residualAreaAcres: residualAreaSqFt / 43560,
      rawServedAreaSumAcres,
      uniqueServedAreaAcres,
      networkServedAcres,
      servedGeometryCount: allServedGeometries.length,
      overlapDifferenceAcres,
      invariantRespected: networkServedAcres <= candidateAcres + tolerance && networkServedAcres <= parentAcres + tolerance
    })

    const allQueryMs = candidates.map((c) => c.terrainSuitabilityScoring?.queryMs ?? 0)
    const totalTerrainQueryMs = round3(allQueryMs.reduce((a, b) => a + b, 0))
    const meanTerrainQueryMs = round3(totalTerrainQueryMs / (allQueryMs.length || 1))
    const maxTerrainQueryMs = round3(Math.max(...allQueryMs))

    console.log('[SecondaryRoadTerrainScoringAudit]', {
      mcpi,
      iterationCount: iterationAudits.length,
      totalCandidateCount: candidates.length,
      selectedSecondaryRoadCount: selected.length,
      totalTerrainQueryMs,
      meanTerrainQueryMs,
      maxTerrainQueryMs,
      terrainChangedAnySelection: terrainChangedSelectionCount > 0,
      terrainChangedSelectionCount,
      iterations: iterationAudits
    })
  }

  const totalMs = performance.now() - startTime
  const turfAfter = turfPerformance.get()
  const secondaryTurfOps: Record<string, number> = {}
  for (const op of Object.keys(turfAfter)) {
    const before = turfBefore[op]
    const delta = turfAfter[op].calls - (before?.calls || 0)
    if (delta > 0) secondaryTurfOps[op] = delta
  }
  const topTurfOps = Object.entries(secondaryTurfOps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([op, calls]) => ({ op, calls }))

  

  

  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[SecondaryRoadNetworkResult]', {
      mcpi,
      status: result.status,
      secondaryRoadCount: result.secondaryRoadCount,
      totalSecondaryRoadLengthFt: Math.round(result.totalSecondaryRoadLengthFt),
      primaryServedAreaSqFt: Math.round(result.primaryServedAreaSqFt),
      secondaryNewlyServedAreaSqFt: Math.round(result.secondaryNewlyServedAreaSqFt),
      totalNetworkServedAreaSqFt: Math.round(result.totalNetworkServedAreaSqFt),
      residualUnservedDevelopableAreaSqFt: Math.round(result.residualUnservedDevelopableAreaSqFt),
      explanation: result.explanation,
      warnings: result.warnings
    })
  }

  return result
}
