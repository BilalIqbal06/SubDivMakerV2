// src/services/terrainAwareRoadGenerator.ts
// Phase 2F.1 — adaptive terrain-aware conceptual primary road alternatives.
// All outputs are conceptual feasibility evidence, not engineering design.

import * as turf from '@turf/turf'
import type { TerrainSuitabilityResult } from '../types/terrain'
import { fastAlong, fastRhumbDestinationCoord, fastBearing } from './fastAlong'
import { getTerrainDirectionAtPoint, blendBearings, limitBearingChange } from './terrainDirection'
import { analyzeNearbyRoadPrecedent, scorePrecedentForMode, type NearbyRoadProfile } from './roadPrecedent'
import type { RoadData } from './gisService'
import type { ConceptualRoadSkeletonResult } from '../types/parameters'
import type { TerrainData, TerrainRoadAlternative, TerrainRoadAlternativeFamily, TerrainRoadAlternativeResult, TerrainRoutingMetrics, TerrainSample, PrimaryRoadRowSafety } from '../types/terrain'
import { sampleTerrainProfile, getTerrainProfileDeepAudit, resetTerrainProfileDeepAudit, recordTerrainProfileSlope, getContourSpatialIndexAudit, resetContourSpatialIndexAudit, getNearestContourVertex } from './terrainService'
import { getTerrainLineQueryAudit } from './terrainSuitabilityQuery'
import { getTurfStageTotal } from '../lib/primaryRoadInstrumentation'
import { VERBOSE_GIS_DIAGNOSTICS, ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS } from '../lib/perf'

interface GenerateTerrainAwarePrimaryOptions {
  mcpi: string
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  candidateOpenAreaGeometry: GeoJSON.Feature<GeoJSON.Geometry>
  buildingUnionGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  hydrologyObstaclesGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  existingPavementGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  developmentOpportunityBlocks?: any[] | null
  roadParameters: { rightOfWayWidth?: number }
  terrainData?: TerrainData | null
  terrainSuitability?: TerrainSuitabilityResult | null
  nearbyStreets?: RoadData[] | null
  roadPrecedentProfile?: NearbyRoadProfile | null
  terrainRoadMode?: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  safeCenterlineArea?: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null
  requiredCenterlineInsetFt?: number
}

const FT_TO_METERS = 0.3048
const MAX_ROAD_LENGTH_FT = 1000
const MAX_ROUTE_EFFICIENCY = 1.75
const MAX_DEFLECTION_DEG = 35
const MAX_BEND_COUNT = 3
const MIN_INITIAL_TANGENT_FT = 50
const BUILDING_CLEARANCE_METERS = 3.0
const SERVICE_BUFFER_METERS = 30
const MIN_BEND_ANGLE_DEG = 5
const MIN_TERRAIN_IMPROVEMENT_PCT = 2.0
const MAX_ACCEPTABLE_LENGTH_INCREASE_PCT = 25
const MAX_ACCEPTABLE_BEND_INCREASE = 1
const MIN_SERVICE_RETENTION_PCT = 80

const MAX_WAYPOINT_CANDIDATES = 30
const ONE_WAYPOINT_LIMIT = 15
const TWO_WAYPOINT_LIMIT = 30
const SLOPE_SAMPLE_FT = 25
const MAX_SNAP_FT = 20

class TerrainCache {
  featurePolygons = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, GeoJSON.Feature<GeoJSON.Polygon>[]>()
  featureBbox = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, number[]>()
  featureRings = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, { lines: GeoJSON.Feature<GeoJSON.LineString>[]; multi: boolean }>()
  pointInside = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, Map<string, boolean>>()
  ringDistance = new WeakMap<GeoJSON.Feature<GeoJSON.Polygon>, Map<string, number>>()
  obstacleDistance = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, Map<string, number>>()
  pointInsideBboxRejects = 0
  sampleElevation = new Map<string, TerrainSample>()
  sampleLocalSlope = new Map<string, number>()
  pointToBaseline = new Map<string, number>()
  lineStringLength = new Map<string, number>()
  straightLineLength = new Map<string, number>()
  uniqueTerrainSamples = 0
  duplicateTerrainSamples = 0
  repeatedGeometryConstructions = 0
  parcelFeature = new WeakMap<GeoJSON.Polygon | GeoJSON.MultiPolygon, GeoJSON.Feature<GeoJSON.Geometry>>()
  cacheStats = new Map<string, { requests: number; hits: number; misses: number }>()

  record(name: string, hit: boolean) {
    let s = this.cacheStats.get(name)
    if (!s) {
      s = { requests: 0, hits: 0, misses: 0 }
      this.cacheStats.set(name, s)
    }
    s.requests++
    if (hit) s.hits++; else s.misses++
  }

  key(point: number[], digits = 6): string {
    return `${point[0].toFixed(digits)},${point[1].toFixed(digits)}`
  }

  pointKey(a: number[], b: number[]): string {
    return `${this.key(a)}|${this.key(b)}`
  }

  getParcelFeature(parcel: GeoJSON.Polygon | GeoJSON.MultiPolygon): GeoJSON.Feature<GeoJSON.Geometry> {
    let f = this.parcelFeature.get(parcel)
    if (!f) {
      f = turf.feature(parcel) as any as GeoJSON.Feature<GeoJSON.Geometry>
      this.parcelFeature.set(parcel, f)
    }
    return f
  }
}

interface LoopRecord {
  name: string
  executionCount: number
  iterationsEntering: number
  iterationsExiting: number
  totalMs: number
  maxMs: number
  startMs: number | null
  active: boolean
}

interface AlternativeRecord {
  id: string
  totalMs: number
  waypointGenerationMs: number
  terrainSamplingMs: number
  routeConstructionMs: number
  obstacleValidationMs: number
  scoringMs: number
  waypointCount: number
  routePointCount: number
  segmentCount: number
}

interface SubfunctionRecord {
  label: string
  callCount: number
  totalMs: number
  maxMs: number
  turfMs: number
  cacheHits: number
  cacheMisses: number
}

class TerrainAwareTimer {
  records: Record<string, SubfunctionRecord> = {}
  loopRecords: Record<string, LoopRecord> = {}
  alternativeRecords: AlternativeRecord[] = []
  stack: { label: string; startMs: number; turfBefore: number }[] = []
  loopStack: { name: string; startMs: number; entering: number }[] = []
  cacheHits: Record<string, number> = {}
  cacheMisses: Record<string, number> = {}

  start(label: string) {
    this.stack.push({ label, startMs: performance.now(), turfBefore: getTurfStageTotal() })
  }

  stop(label: string) {
    const now = performance.now()
    const frame = this.stack.pop()
    if (!frame || frame.label !== label) return
    const ms = now - frame.startMs
    const turfMs = getTurfStageTotal() - frame.turfBefore
    const r = this.records[label] = this.records[label] || { label, callCount: 0, totalMs: 0, maxMs: 0, turfMs: 0, cacheHits: 0, cacheMisses: 0 }
    r.callCount++
    r.totalMs += ms
    r.maxMs = Math.max(r.maxMs, ms)
    r.turfMs += turfMs
    r.cacheHits += (this.cacheHits[label] || 0)
    r.cacheMisses += (this.cacheMisses[label] || 0)
    this.cacheHits[label] = 0
    this.cacheMisses[label] = 0
  }

  startLoop(name: string, entering: number) {
    this.loopStack.push({ name, startMs: performance.now(), entering })
    const r = this.loopRecords[name] = this.loopRecords[name] || { name, executionCount: 0, iterationsEntering: 0, iterationsExiting: 0, totalMs: 0, maxMs: 0, startMs: null, active: false }
    r.executionCount++
    r.iterationsEntering += entering
    r.active = true
    r.startMs = performance.now()
  }

  stopLoop(name: string, exiting: number) {
    const frame = this.loopStack.pop()
    if (!frame || frame.name !== name) return
    const r = this.loopRecords[name]
    if (!r) return
    const ms = performance.now() - frame.startMs
    r.totalMs += ms
    r.maxMs = Math.max(r.maxMs, ms)
    r.iterationsExiting += exiting
    r.active = false
    r.startMs = null
  }

  recordAlternative(a: AlternativeRecord) {
    this.alternativeRecords.push(a)
  }

  recordCacheHit(label: string) {
    this.cacheHits[label] = (this.cacheHits[label] || 0) + 1
  }

  recordCacheMiss(label: string) {
    this.cacheMisses[label] = (this.cacheMisses[label] || 0) + 1
  }

  ranked() {
    return Object.values(this.records).sort((a, b) => b.totalMs - a.totalMs)
  }
}

let activeCache: TerrainCache | null = null
let activeTimer: TerrainAwareTimer | null = null

const routeAlternativeBreakdown: Record<string, { callCount: number; totalMs: number; maxMs: number; turfMs: number }> = {}

function recordRouteBreakdown(label: string, startMs: number, turfBefore: number) {
  const now = performance.now()
  const r = routeAlternativeBreakdown[label] = routeAlternativeBreakdown[label] || { callCount: 0, totalMs: 0, maxMs: 0, turfMs: 0 }
  r.callCount++
  r.totalMs += now - startMs
  r.maxMs = Math.max(r.maxMs, now - startMs)
  r.turfMs += getTurfStageTotal() - turfBefore
}

function withActiveContext<T>(fn: () => T, cache: TerrainCache, timer: TerrainAwareTimer): T {
  activeCache = cache
  activeTimer = timer
  try {
    return fn()
  } finally {
    activeCache = null
    activeTimer = null
  }
}

function withSubTiming<T>(label: string, fn: () => T): T {
  if (!activeTimer) return fn()
  activeTimer.start(label)
  try {
    return fn()
  } finally {
    activeTimer.stop(label)
  }
}

function round3(n: number): number { return Math.round(n * 1000) / 1000 }
const SNAP_INSIDE_SHIFT_FT = 1
const MIN_MEANINGFUL_WAYPOINT_DEVIATION_FT = 5
const MAX_PRIMARY_ENTRY_LENGTH_FT = 100
const CENTERLINE_SAMPLE_SPACING_FT = 10
const MIN_RAY_ORIGIN_SEPARATION_FT = 1

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function computeMaxGradePoint(roadProfile: any) {
  const pts: any[] = roadProfile?.profile?.points || []
  if (pts.length < 2) return null
  let best: any = null
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1]
    const p1 = pts[i]
    const run = (p1.distanceAlongRoadFt ?? 0) - (p0.distanceAlongRoadFt ?? 0)
    if (run <= 0) continue
    const rise = (p1.elevationFt ?? 0) - (p0.elevationFt ?? 0)
    const grade = Math.abs(rise / run) * 100
    if (!best || grade > best.calculatedGradePercent) {
      best = {
        distanceAlongRoadFt: p0.distanceAlongRoadFt,
        startElevationFt: p0.elevationFt,
        endElevationFt: p1.elevationFt,
        horizontalSampleDistanceFt: run,
        calculatedGradePercent: grade,
        lowerContourFt: p0.lowerContourFt,
        upperContourFt: p0.upperContourFt,
        confidence: p0.confidence
      }
    }
  }
  return best
}

function squareMetersToSquareFeet(sqm: number): number {
  return sqm * 10.7639
}

function ftToMeters(ft: number): number {
  return ft * FT_TO_METERS
}

function rightOfWayHalfMeters(rightOfWayWidthFt: number): number {
  return (rightOfWayWidthFt * FT_TO_METERS) / 2
}

function obstacleBufferMeters(rightOfWayWidthFt: number): number {
  return rightOfWayHalfMeters(rightOfWayWidthFt) + BUILDING_CLEARANCE_METERS
}

function lineStringLengthFt(coords: number[][]): number {
  if (activeCache) {
    const k = coords.map(p => activeCache!.key(p)).join(';')
    const cached = activeCache.lineStringLength.get(k)
    if (cached !== undefined) { activeCache.record('lineStringLength', true); activeTimer?.recordCacheHit('lineStringLengthFt'); return cached }
    activeCache.record('lineStringLength', false)
    activeTimer?.recordCacheMiss('lineStringLengthFt')
    let total = 0
    for (let i = 0; i < coords.length - 1; i++) {
      total += turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'feet' })
    }
    activeCache.lineStringLength.set(k, total)
    return total
  }
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) {
    total += turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'feet' })
  }
  return total
}

function computeBearing(a: number[], b: number[]): number {
  return fastBearing(a, b) ?? 0
}

function normalizeAngle(delta: number): number {
  while (delta > 180) delta -= 360
  while (delta < -180) delta += 360
  return delta
}

function geometryQualityMetrics(centerline: GeoJSON.Feature<GeoJSON.LineString>): {
  bendCount: number
  maxDeflectionAngle: number
  totalAbsoluteDeflection: number
  initialTangentLengthFt: number
  routeEfficiencyRatio: number
  roadLengthFt: number
  straightLineLengthFt: number
} {
  const coords = centerline.geometry.coordinates as number[][]
  if (coords.length < 3) {
    const length = lineStringLengthFt(coords)
    const straight = turf.distance(turf.point(coords[0]), turf.point(coords[coords.length - 1]), { units: 'feet' })
    return {
      bendCount: 0,
      maxDeflectionAngle: 0,
      totalAbsoluteDeflection: 0,
      initialTangentLengthFt: length,
      routeEfficiencyRatio: straight > 0 ? length / straight : 1,
      roadLengthFt: length,
      straightLineLengthFt: straight
    }
  }

  const bearings: number[] = []
  for (let i = 0; i < coords.length - 1; i++) {
    bearings.push(computeBearing(coords[i], coords[i + 1]))
  }

  let bendCount = 0
  let maxDeflection = 0
  let totalAbs = 0
  let firstBendIndex = -1
  for (let i = 1; i < bearings.length; i++) {
    const deflection = Math.abs(normalizeAngle(bearings[i] - bearings[i - 1]))
    totalAbs += deflection
    if (deflection > maxDeflection) maxDeflection = deflection
    if (deflection > MIN_BEND_ANGLE_DEG) {
      bendCount++
      if (firstBendIndex === -1) firstBendIndex = i
    }
  }

  const length = lineStringLengthFt(coords)
  const straight = turf.distance(turf.point(coords[0]), turf.point(coords[coords.length - 1]), { units: 'feet' })
  const routeEfficiency = straight > 0 ? length / straight : 1
  const initialTangentLengthFt = firstBendIndex > 0
    ? lineStringLengthFt(coords.slice(0, firstBendIndex + 1))
    : length

  return {
    bendCount,
    maxDeflectionAngle: maxDeflection,
    totalAbsoluteDeflection: totalAbs,
    initialTangentLengthFt,
    routeEfficiencyRatio: routeEfficiency,
    roadLengthFt: length,
    straightLineLengthFt: straight
  }
}

function bufferRightOfWay(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  rightOfWayWidthFt: number
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const halfMeters = rightOfWayHalfMeters(rightOfWayWidthFt)
  return safeTurfOp(
    () => (turf.buffer(centerline, halfMeters, { units: 'meters', steps: 8 }) as GeoJSON.Feature<GeoJSON.Geometry> | null) ?? null,
    null
  )
}

function computeResidual(
  candidateOpenArea: GeoJSON.Feature<GeoJSON.Geometry>,
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!rightOfWay) return null
  return safeTurfOp(
    () => (turf.difference(turf.featureCollection([candidateOpenArea, rightOfWay] as any)) as GeoJSON.Feature<GeoJSON.Geometry> | null) ?? null,
    null
  )
}

function estimateServedArea(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  candidateOpenArea: GeoJSON.Feature<GeoJSON.Geometry>
): { servedSqFt: number; componentAreaSqFt: number } {
  const serviceArea = safeTurfOp(
    () => turf.buffer(centerline, SERVICE_BUFFER_METERS, { units: 'meters', steps: 8 }),
    null
  )
  if (!serviceArea) return { servedSqFt: 0, componentAreaSqFt: 0 }

  const componentArea = safeTurfOp(() => turf.area(candidateOpenArea), 0)
  const fragments = safeTurfOp(() => turf.flatten(candidateOpenArea), turf.featureCollection([]))

  let servedSqM = 0
  for (const f of fragments.features) {
    const inter = safeTurfOp(() => turf.intersect(turf.featureCollection([serviceArea, f])), null)
    if (inter) {
      servedSqM += safeTurfOp(() => turf.area(inter), 0)
    }
  }

  return {
    servedSqFt: squareMetersToSquareFeet(servedSqM),
    componentAreaSqFt: squareMetersToSquareFeet(componentArea)
  }
}

function pointInsideParcel(point: number[], parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  const feature = activeCache ? activeCache.getParcelFeature(parcelGeometry) : turf.feature(parcelGeometry) as any
  return pointInsideFeature(point, feature)
}

function distanceToParcelEdgeFt(point: number[], parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const feature = activeCache ? activeCache.getParcelFeature(parcelGeometry) : turf.feature(parcelGeometry) as any
  const polys = featureToPolygons(feature)
  let best = Infinity
  for (const poly of polys) {
    const d = ringDistanceFt(point, poly)
    if (d < best) best = d
  }
  return best
}

function sampleCenterlinePoints(centerline: GeoJSON.Feature<GeoJSON.LineString>, spacingFt: number): number[][] {
  const lengthM = turf.length(centerline, { units: 'meters' })
  const spacingM = ftToMeters(spacingFt)
  if (lengthM <= 0) return [centerline.geometry.coordinates[0]]
  const points: number[][] = []
  let currentM = 0
  while (currentM <= lengthM + 0.001) {
    const ratio = Math.min(currentM / lengthM, 1)
    const pt = fastAlong(centerline as any, ratio * lengthM, 'meters')?.geometry.coordinates
    if (pt) points.push(pt)
    currentM += spacingM
  }
  if (points.length === 0) points.push(centerline.geometry.coordinates[0])
  return points
}

function primaryRoadInsideParcelAudit(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry>,
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  rightOfWayWidthFt: number
): {
  insidePercent: number
  expectedEntryOutsideAreaSqFt: number
  invalidInteriorOutsideAreaSqFt: number
  entryLengthFt: number
  reason: string | null
} {
  const rowHalfFt = rightOfWayHalfMeters(rightOfWayWidthFt) / FT_TO_METERS
  const samples = sampleCenterlinePoints(centerline, CENTERLINE_SAMPLE_SPACING_FT)

  let entryEndFt = 0
  let hasEntered = false
  for (let i = 0; i < samples.length; i++) {
    const pt = samples[i]
    const inside = pointInsideParcel(pt, parcelGeometry)
    const distEdge = distanceToParcelEdgeFt(pt, parcelGeometry)
    const d = i * CENTERLINE_SAMPLE_SPACING_FT
    if (!hasEntered) {
      if (inside && distEdge >= rowHalfFt + 2) {
        hasEntered = true
        entryEndFt = d
      } else if (d > MAX_PRIMARY_ENTRY_LENGTH_FT) {
        return { insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0, entryLengthFt: d, reason: 'Access entry exceeds 100 ft outside parcel' }
      }
    } else {
      if (!inside || distEdge < rowHalfFt + 2) {
        return { insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0, entryLengthFt: d, reason: 'Right-of-way leaves parcel interior' }
      }
    }
  }

  const insideAreaM2 = safeTurfOp(() => {
    const rowPolys = featureToPolygons(rightOfWay as any)
    const parcelPolys = featureToPolygons(turf.feature(parcelGeometry) as any)
    let total = 0
    for (const rowPoly of rowPolys) {
      for (const parcelPoly of parcelPolys) {
        const inter = turf.intersect(turf.featureCollection([rowPoly as any, parcelPoly as any]))
        if (inter) total += turf.area(inter)
      }
    }
    return total
  }, 0)
  const rowAreaM2 = safeTurfOp(() => turf.area(rightOfWay), 0)
  const insidePercent = rowAreaM2 > 0 ? (insideAreaM2 / rowAreaM2) * 100 : 0
  const outsideAreaM2 = Math.max(0, rowAreaM2 - insideAreaM2)
  const outsideAreaSqFt = squareMetersToSquareFeet(outsideAreaM2)
  const totalLengthFt = lineStringLengthFt(centerline.geometry.coordinates as number[][])
  const entryRatio = totalLengthFt > 0 ? Math.min(1, entryEndFt / totalLengthFt) : 0
  const expectedEntryOutsideAreaSqFt = outsideAreaSqFt * entryRatio
  const invalidInteriorOutsideAreaSqFt = outsideAreaSqFt - expectedEntryOutsideAreaSqFt

  if (insidePercent < 95) {
    return { insidePercent, expectedEntryOutsideAreaSqFt, invalidInteriorOutsideAreaSqFt, entryLengthFt: entryEndFt, reason: `Right-of-way only ${insidePercent.toFixed(1)}% inside parcel` }
  }

  return { insidePercent, expectedEntryOutsideAreaSqFt, invalidInteriorOutsideAreaSqFt, entryLengthFt: entryEndFt, reason: null }
}

function hardValid(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null,
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  buildingUnion: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  hydrology: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  pavement: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  rightOfWayWidthFt: number
): { valid: boolean; reason: string | null; insidePercent: number; expectedEntryOutsideAreaSqFt: number; invalidInteriorOutsideAreaSqFt: number } {
  if (!rightOfWay) return { valid: false, reason: 'Could not buffer right-of-way', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }

  const length = lineStringLengthFt(centerline.geometry.coordinates as number[][])
  if (length > MAX_ROAD_LENGTH_FT) {
    return { valid: false, reason: 'Road length exceeds maximum', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }

  const { routeEfficiencyRatio } = geometryQualityMetrics(centerline)
  if (routeEfficiencyRatio > MAX_ROUTE_EFFICIENCY) {
    return { valid: false, reason: 'Route efficiency exceeds maximum', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }

  const obsBufM = obstacleBufferMeters(rightOfWayWidthFt)
  const obstacleBuffer = safeTurfOp(
    () => turf.buffer(centerline, obsBufM, { units: 'meters', steps: 8 }),
    null
  )
  if (!obstacleBuffer) {
    return { valid: false, reason: 'Could not buffer for obstacle check', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }

  if (buildingUnion) {
    const hit = safeTurfOp(() => turf.booleanIntersects(obstacleBuffer, buildingUnion), false)
    if (hit) return { valid: false, reason: 'Building collision', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }
  if (hydrology) {
    const hit = safeTurfOp(() => turf.booleanIntersects(obstacleBuffer, hydrology), false)
    if (hit) return { valid: false, reason: 'Water/hydrology collision', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }
  if (pavement) {
    const hit = safeTurfOp(() => turf.booleanIntersects(obstacleBuffer, pavement), false)
    if (hit) return { valid: false, reason: 'Pavement collision', insidePercent: 0, expectedEntryOutsideAreaSqFt: 0, invalidInteriorOutsideAreaSqFt: 0 }
  }

  const audit = primaryRoadInsideParcelAudit(centerline, rightOfWay, parcelGeometry, rightOfWayWidthFt)
  if (audit.reason) {
    return { valid: false, ...audit }
  }

  return { valid: true, ...audit, reason: null }
}

function sampleElevationAt(coord: number[], terrainData: TerrainData): TerrainSample {
  if (!terrainData || !terrainData.contours.length) {
    return { coordinate: coord, elevationFt: null, confidence: 'UNAVAILABLE', nearestContourDistanceFt: Infinity, lowerContourFt: null, upperContourFt: null }
  }
  if (activeCache) {
    const k = activeCache.key(coord)
    const cached = activeCache.sampleElevation.get(k)
    if (cached) { activeCache.record('sampleElevation', true); activeCache.duplicateTerrainSamples++; activeTimer?.recordCacheHit('sampleElevationAt'); return cached }
    activeCache.record('sampleElevation', false)
    activeCache.uniqueTerrainSamples++
    activeTimer?.recordCacheMiss('sampleElevationAt')
    const nearest = getNearestContourVertex(coord, terrainData)
    const v: TerrainSample = nearest
      ? {
          coordinate: coord,
          elevationFt: nearest.elevationFt,
          confidence: nearest.distanceFt < 25 ? 'HIGH' : nearest.distanceFt < 75 ? 'MODERATE' : 'LOW',
          nearestContourDistanceFt: nearest.distanceFt,
          lowerContourFt: nearest.elevationFt,
          upperContourFt: nearest.elevationFt
        }
      : {
          coordinate: coord,
          elevationFt: null,
          confidence: 'UNAVAILABLE',
          nearestContourDistanceFt: Infinity,
          lowerContourFt: null,
          upperContourFt: null
        }
    activeCache.sampleElevation.set(k, v)
    return v
  }
  const nearest = getNearestContourVertex(coord, terrainData)
  if (!nearest) {
    return { coordinate: coord, elevationFt: null, confidence: 'UNAVAILABLE', nearestContourDistanceFt: Infinity, lowerContourFt: null, upperContourFt: null }
  }
  return {
    coordinate: coord,
    elevationFt: nearest.elevationFt,
    confidence: nearest.distanceFt < 25 ? 'HIGH' : nearest.distanceFt < 75 ? 'MODERATE' : 'LOW',
    nearestContourDistanceFt: nearest.distanceFt,
    lowerContourFt: nearest.elevationFt,
    upperContourFt: nearest.elevationFt
  }
}

function sampleLocalSlopePct(coord: number[], terrainData: TerrainData): number {
  if (activeCache) {
    const k = activeCache.key(coord)
    const cached = activeCache.sampleLocalSlope.get(k)
    if (cached !== undefined) { activeCache.record('sampleLocalSlope', true); activeTimer?.recordCacheHit('sampleLocalSlopePct'); return cached }
    activeCache.record('sampleLocalSlope', false)
    activeTimer?.recordCacheMiss('sampleLocalSlopePct')
    recordTerrainProfileSlope(4, 4)
    const center = sampleElevationAt(coord, terrainData)
    if (center.elevationFt === null) {
      activeCache.sampleLocalSlope.set(k, Infinity)
      return Infinity
    }
    let maxDiff = 0
    for (const bearing of [0, 90, 180, 270]) {
      const p = fastRhumbDestinationCoord(coord, SLOPE_SAMPLE_FT, 'feet', bearing)
      if (p) {
        const s = sampleElevationAt(p, terrainData)
        if (s.elevationFt !== null) {
          maxDiff = Math.max(maxDiff, Math.abs(s.elevationFt - center.elevationFt))
        }
      }
    }
    const v = (maxDiff / (2 * SLOPE_SAMPLE_FT)) * 100
    activeCache.sampleLocalSlope.set(k, v)
    return v
  }
  const center = sampleElevationAt(coord, terrainData)
  if (center.elevationFt === null) return Infinity
  recordTerrainProfileSlope(4, 4)
  let maxDiff = 0
  for (const bearing of [0, 90, 180, 270]) {
    const p = fastRhumbDestinationCoord(coord, SLOPE_SAMPLE_FT, 'feet', bearing)
    if (p) {
      const s = sampleElevationAt(p, terrainData)
      if (s.elevationFt !== null) {
        maxDiff = Math.max(maxDiff, Math.abs(s.elevationFt - center.elevationFt))
      }
    }
  }
  // Two-sample run is 2 * SLOPE_SAMPLE_FT; grade percent is rise/run * 100.
  return (maxDiff / (2 * SLOPE_SAMPLE_FT)) * 100
}

function featureToPolygons(feature: GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!feature || !feature.geometry) return []
  if (activeCache) {
    const cached = activeCache.featurePolygons.get(feature)
    if (cached !== undefined) { activeCache.record('featurePolygons', true); activeCache.repeatedGeometryConstructions++; activeTimer?.recordCacheHit('featureToPolygons'); return cached }
    activeCache.record('featurePolygons', false)
    activeTimer?.recordCacheMiss('featureToPolygons')
    const flat = safeTurfOp(() => turf.flatten(feature), turf.featureCollection([]))
    const res = flat.features.filter((f: any) => f.geometry && f.geometry.type === 'Polygon') as GeoJSON.Feature<GeoJSON.Polygon>[]
    activeCache.featurePolygons.set(feature, res)
    return res
  }
  const flat = safeTurfOp(() => turf.flatten(feature), turf.featureCollection([]))
  return flat.features.filter((f: any) => f.geometry && f.geometry.type === 'Polygon') as GeoJSON.Feature<GeoJSON.Polygon>[]
}

function pointInsideFeature(point: number[], feature: GeoJSON.Feature<GeoJSON.Geometry> | null): boolean {
  if (!feature || !feature.geometry) return false
  if (activeCache) {
    let perFeature = activeCache.pointInside.get(feature)
    if (!perFeature) { perFeature = new Map(); activeCache.pointInside.set(feature, perFeature) }
    const k = activeCache.key(point)
    if (perFeature.has(k)) { activeCache.record('pointInside', true); activeTimer?.recordCacheHit('pointInsideFeature'); return perFeature.get(k)! }
    activeCache.record('pointInside', false)
    activeTimer?.recordCacheMiss('pointInsideFeature')
    const bbox = getFeatureBbox(feature)
    if (bbox && (point[0] < bbox[0] || point[0] > bbox[2] || point[1] < bbox[1] || point[1] > bbox[3])) {
      activeCache.pointInsideBboxRejects++
      perFeature.set(k, false)
      return false
    }
    const v = safeTurfOp(() => turf.booleanPointInPolygon(turf.point(point), feature as any), false)
    perFeature.set(k, v)
    return v
  }
  return safeTurfOp(() => turf.booleanPointInPolygon(turf.point(point), feature as any), false)
}

function getFeatureBbox(feature: GeoJSON.Feature<GeoJSON.Geometry>): number[] | null {
  if (activeCache) {
    const cached = activeCache.featureBbox.get(feature)
    if (cached !== undefined) return cached
    const b = safeTurfOp(() => turf.bbox(feature), null)
    if (b) { activeCache.featureBbox.set(feature, b); return b }
    return null
  }
  return safeTurfOp(() => turf.bbox(feature), null)
}

function ringDistanceFt(point: number[], polygon: GeoJSON.Feature<GeoJSON.Polygon>): number {
  if (activeCache) {
    let rings = activeCache.featureRings.get(polygon)
    if (!rings) {
      const outline = safeTurfOp(() => turf.polygonToLine(polygon) as any, null)
      if (!outline) return Infinity
      const multi = outline.geometry.type === 'MultiLineString'
      const lines = multi
        ? (outline.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
        : [outline]
      rings = { lines, multi }
      activeCache.featureRings.set(polygon, rings)
    }
    let perPoly = activeCache.ringDistance.get(polygon)
    if (!perPoly) { perPoly = new Map(); activeCache.ringDistance.set(polygon, perPoly) }
    const k = activeCache.key(point)
    if (perPoly.has(k)) { activeCache.record('ringDistance', true); activeTimer?.recordCacheHit('ringDistanceFt'); return perPoly.get(k)! }
    activeCache.record('ringDistance', false)
    activeTimer?.recordCacheMiss('ringDistanceFt')
    let best = Infinity
    for (const line of rings.lines) {
      const lineBbox = getFeatureBbox(line)
      if (lineBbox && best < Infinity) {
        const clamped: [number, number] = [Math.max(lineBbox[0], Math.min(point[0], lineBbox[2])), Math.max(lineBbox[1], Math.min(point[1], lineBbox[3]))]
        const lowerFt = safeTurfOp(() => turf.distance(turf.point(point), turf.point(clamped), { units: 'feet' }) as number, 0)
        if (lowerFt >= best) continue
      }
      const d = safeTurfOp(() => turf.pointToLineDistance(turf.point(point), line as any, { units: 'feet' }), Infinity)
      if (d < best) best = d
    }
    perPoly.set(k, best)
    return best
  }
  const outline = safeTurfOp(() => turf.polygonToLine(polygon) as any, null)
  if (!outline) return Infinity
  const lines = outline.geometry.type === 'MultiLineString'
    ? (outline.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
    : [outline]
  let best = Infinity
  for (const line of lines) {
    const lineBbox = safeTurfOp(() => turf.bbox(line), null)
    if (lineBbox && best < Infinity) {
      const clamped: [number, number] = [Math.max(lineBbox[0], Math.min(point[0], lineBbox[2])), Math.max(lineBbox[1], Math.min(point[1], lineBbox[3]))]
      const lowerFt = safeTurfOp(() => turf.distance(turf.point(point), turf.point(clamped), { units: 'feet' }) as number, 0)
      if (lowerFt >= best) continue
    }
    const d = safeTurfOp(() => turf.pointToLineDistance(turf.point(point), line, { units: 'feet' }), Infinity)
    if (d < best) best = d
  }
  return best
}

function clearanceToObstacleFt(point: number[], obstacle: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!obstacle || !obstacle.geometry) return Infinity
  if (pointInsideFeature(point, obstacle)) return 0
  if (activeCache) {
    const perObstacle = activeCache.obstacleDistance.get(obstacle)
    const k = activeCache.key(point)
    if (perObstacle && perObstacle.has(k)) return perObstacle.get(k)!
  }
  let best = Infinity
  for (const poly of featureToPolygons(obstacle)) {
    const d = ringDistanceFt(point, poly)
    if (d < best) best = d
  }
  if (activeCache) {
    const perObstacle = activeCache.obstacleDistance.get(obstacle)
    const k = activeCache.key(point)
    if (perObstacle) {
      perObstacle.set(k, best)
    } else {
      const m = new Map<string, number>()
      m.set(k, best)
      activeCache.obstacleDistance.set(obstacle, m)
    }
  }
  return best
}

function nearestDistanceToFeatureFt(point: number[], feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!feature || !feature.geometry) return Infinity
  if (activeCache) {
    const perFeature = activeCache.obstacleDistance.get(feature)
    const k = activeCache.key(point)
    if (perFeature && perFeature.has(k)) return perFeature.get(k)!
  }
  let best = Infinity
  for (const poly of featureToPolygons(feature)) {
    const d = ringDistanceFt(point, poly)
    if (d < best) best = d
  }
  if (activeCache) {
    const perFeature = activeCache.obstacleDistance.get(feature)
    const k = activeCache.key(point)
    if (perFeature) {
      perFeature.set(k, best)
    } else {
      const m = new Map<string, number>()
      m.set(k, best)
      activeCache.obstacleDistance.set(feature, m)
    }
  }
  return best
}

function findTargetCOAComponent(
  endPoint: number[],
  candidateOpenArea: GeoJSON.Feature<GeoJSON.Geometry>
): GeoJSON.Feature<GeoJSON.Polygon> | null {
  const polys = featureToPolygons(candidateOpenArea)
  if (polys.length === 0) return null
  for (const p of polys) {
    if (pointInsideFeature(endPoint, p)) return p
  }
  let best = polys[0]
  let bestDist = Infinity
  for (const p of polys) {
    const d = ringDistanceFt(endPoint, p)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  return best
}

interface WaypointCandidate {
  id: string
  coordinate: number[]
  source: string
  projected: boolean
  projectedFrom: number[] | null
  elevationFt: number | null
  terrainConfidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
  localSlopePct: number
  nearestContourDistanceFt: number
  distanceToBaselineFt: number
  distanceToBuildingFt: number
  distanceToHydrologyFt: number
  distanceToPavementFt: number
  distanceToParcelEdgeFt: number
  distanceToCOAEdgeFt: number
  developmentOpportunityClassification: string | null
  usable: boolean
  primaryRejectionReason: string | null
  allRejectionReasons: string[]
  rejectionReason: string | null
}

function routeTangentBearing(centerline: GeoJSON.Feature<GeoJSON.LineString>, ratio: number): number {
  const coords = centerline.geometry.coordinates as number[][]
  const lengthM = turf.length(centerline, { units: 'meters' })
  if (lengthM <= 0) return 0
  const targetM = ratio * lengthM
  const point = fastAlong(centerline as any, targetM, 'meters')?.geometry.coordinates
  if (!point) return computeBearing(coords[0], coords[coords.length - 1])
  // Find nearest segment and use its bearing.
  let bestIdx = 0
  let accumM = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const segM = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' })
    if (accumM + segM / 2 >= targetM) {
      bestIdx = i
      break
    }
    accumM += segM
  }
  return computeBearing(coords[bestIdx], coords[bestIdx + 1])
}

function lateralIntersectionDistanceFt(
  origin: number[],
  bearing: number,
  component: GeoJSON.Feature<GeoJSON.Polygon>
): number {
  const outline = safeTurfOp(() => turf.polygonToLine(component) as any, null)
  if (!outline) return 0
  const lines: any[] = outline.geometry.type === 'MultiLineString'
    ? (outline.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
    : [outline]
  const bbox = safeTurfOp(() => turf.bbox(component), [0, 0, 0, 0])
  const diagM = turf.distance(turf.point([bbox[0], bbox[1]]), turf.point([bbox[2], bbox[3]]), { units: 'meters' })
  const ray = fastRhumbDestinationCoord(origin, diagM * 1.5 + 250, 'meters', bearing)
  if (!ray) return 0
  const rayLine = turf.lineString([origin, ray])
  let best = Infinity
  for (const line of lines) {
    const hits = safeTurfOp(() => turf.lineIntersect(rayLine, line as any), turf.featureCollection([]))
    for (const hit of (hits as any).features || []) {
      const d = turf.distance(turf.point(origin), hit, { units: 'feet' })
      if (d > MIN_RAY_ORIGIN_SEPARATION_FT && d < best) best = d
    }
  }
  return best === Infinity ? 0 : best
}

function nearestPointOnBoundary(
  point: number[],
  component: GeoJSON.Feature<GeoJSON.Polygon>
): { coordinate: number[]; distanceFt: number } | null {
  const outline = safeTurfOp(() => turf.polygonToLine(component) as any, null)
  if (!outline) return null
  const lines: any[] = outline.geometry.type === 'MultiLineString'
    ? (outline.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
    : [outline]
  let bestPt: number[] | null = null
  let bestDist = Infinity
  for (const line of lines) {
    const np = safeTurfOp(() => turf.nearestPointOnLine(line as any, turf.point(point), { units: 'feet' }), null)
    if (!np) continue
    const d = turf.distance(turf.point(point), np, { units: 'feet' })
    if (d < bestDist) {
      bestDist = d
      bestPt = np.geometry.coordinates
    }
  }
  if (!bestPt) return null
  return { coordinate: bestPt, distanceFt: bestDist }
}

function snapPointToFeasible(
  point: number[],
  component: GeoJSON.Feature<GeoJSON.Polygon>,
  options: GenerateTerrainAwarePrimaryOptions
): { coordinate: number[]; distanceFt: number } | null {
  if (pointInsideFeature(point, component)) return { coordinate: point, distanceFt: 0 }
  const near = nearestPointOnBoundary(point, component)
  if (!near || near.distanceFt > MAX_SNAP_FT) return null
  const bearing = safeTurfOp(() => turf.rhumbBearing(turf.point(point), turf.point(near.coordinate)), null)
  if (bearing === null) return null
  const connector = turf.lineString([point, near.coordinate])
  const obstacles = [options.buildingUnionGeometry, options.hydrologyObstaclesGeometry, options.existingPavementGeometry]
  for (const obs of obstacles) {
    if (!obs || !obs.geometry) continue
    if (safeTurfOp(() => turf.booleanIntersects(connector, obs as any), false)) return null
  }
  for (const shift of [SNAP_INSIDE_SHIFT_FT, 0.5, 0.25]) {
    const inside = fastRhumbDestinationCoord(near.coordinate, shift, 'feet', bearing)
    if (inside && pointInsideFeature(inside, component)) {
      return { coordinate: inside, distanceFt: near.distanceFt }
    }
  }
  return null
}

function buildWaypointCandidate(
  coord: number[],
  source: string,
  options: GenerateTerrainAwarePrimaryOptions,
  terrainData: TerrainData,
  targetComponent: GeoJSON.Feature<GeoJSON.Polygon> | null
): WaypointCandidate {
  const rightOfWayWidthFt = options.roadParameters.rightOfWayWidth || 50
  const rowHalfFt = rightOfWayHalfMeters(rightOfWayWidthFt) / FT_TO_METERS
  const obstacleClearanceFt = obstacleBufferMeters(rightOfWayWidthFt) / FT_TO_METERS
  const isDirect = source.includes('-direct')

  let point = [...coord]
  let projectedFrom: number[] | null = null
  let projectedDistanceFt = 0
  let snapFailed = false

  const parcel = options.parcelGeometry

  // Snap interior waypoints into the target component if they fall just outside.
  if (!isDirect && targetComponent) {
    const snap = snapPointToFeasible(point, targetComponent, options)
    if (snap && snap.distanceFt <= MAX_SNAP_FT) {
      if (snap.distanceFt > 0) {
        projectedFrom = point
        projectedDistanceFt = snap.distanceFt
      }
      point = snap.coordinate
    } else {
      snapFailed = true
    }
  }

  const parcelFeature = activeCache ? activeCache.getParcelFeature(parcel) : turf.feature(parcel as any)
  const insideParcel = pointInsideFeature(point, parcelFeature)
  const insideTarget = targetComponent ? pointInsideFeature(point, targetComponent) : false

  const sample = sampleElevationAt(point, terrainData)
  const localSlope = sample.elevationFt !== null ? sampleLocalSlopePct(point, terrainData) : Infinity

  const distBuilding = clearanceToObstacleFt(point, options.buildingUnionGeometry)
  const distHydrology = clearanceToObstacleFt(point, options.hydrologyObstaclesGeometry)
  const distPavement = clearanceToObstacleFt(point, options.existingPavementGeometry)
  const distParcelEdge = nearestDistanceToFeatureFt(point, parcelFeature)
  const distCOAEdge = targetComponent ? ringDistanceFt(point, targetComponent) : (options.candidateOpenAreaGeometry ? nearestDistanceToFeatureFt(point, options.candidateOpenAreaGeometry) : Infinity)

  const baselineLine = (options as any).__baselineCenterline as GeoJSON.Feature<GeoJSON.LineString> | null
  const distanceToBaseline = baselineLine
    ? (() => {
        const k = activeCache ? activeCache.key(point) : null
        if (k && activeCache) {
          const cached = activeCache.pointToBaseline.get(k)
          if (cached !== undefined) { activeCache.record('pointToBaseline', true); activeTimer?.recordCacheHit('pointToBaseline'); return cached }
        }
        const d = safeTurfOp(() => turf.pointToLineDistance(turf.point(point), baselineLine, { units: 'feet' }), 0)
        if (k && activeCache) { activeCache.record('pointToBaseline', false); activeCache.pointToBaseline.set(k, d) }
        return d
      })()
    : 0

  const allRejectionReasons: string[] = []
  if (!insideParcel) allRejectionReasons.push('outside parcel')
  if (snapFailed) allRejectionReasons.push('failed to snap into feasible target')
  if (!isDirect && !insideTarget && !snapFailed) allRejectionReasons.push('outside target COA')
  if (!isDirect && distParcelEdge < rowHalfFt + 2) allRejectionReasons.push('too close to parcel edge for ROW')
  if (distBuilding < obstacleClearanceFt) allRejectionReasons.push('too close to building for ROW')
  if (distHydrology < obstacleClearanceFt) allRejectionReasons.push('too close to hydrology for ROW')
  if (distPavement < obstacleClearanceFt) allRejectionReasons.push('too close to pavement for ROW')
  if (localSlope === Infinity) allRejectionReasons.push('no terrain sample')

  const primaryRejectionReason = allRejectionReasons[0] ?? null
  const usable = allRejectionReasons.length === 0

  return {
    id: `${options.mcpi}-WP-${source}`,
    coordinate: point,
    source,
    projected: projectedDistanceFt > 0,
    projectedFrom: projectedFrom,
    elevationFt: sample.elevationFt,
    terrainConfidence: sample.confidence,
    localSlopePct: localSlope,
    nearestContourDistanceFt: sample.nearestContourDistanceFt,
    distanceToBaselineFt: distanceToBaseline,
    distanceToBuildingFt: distBuilding,
    distanceToHydrologyFt: distHydrology,
    distanceToPavementFt: distPavement,
    distanceToParcelEdgeFt: distParcelEdge,
    distanceToCOAEdgeFt: distCOAEdge,
    developmentOpportunityClassification: null,
    usable,
    primaryRejectionReason,
    allRejectionReasons,
    rejectionReason: primaryRejectionReason
  }
}

function buildWaypointInventory(
  baseline: ConceptualRoadSkeletonResult,
  options: GenerateTerrainAwarePrimaryOptions,
  terrainData: TerrainData
): { candidates: WaypointCandidate[]; targetComponent: GeoJSON.Feature<GeoJSON.Polygon> | null } {
  const t0Inventory = performance.now()
  const baselineCenterline = baseline.proposedRoadCenterline
  if (!baselineCenterline) return { candidates: [], targetComponent: null }

  const coords = baselineCenterline.geometry.coordinates as number[][]
  const end = coords[coords.length - 1]

  const targetComponent = findTargetCOAComponent(end, options.candidateOpenAreaGeometry)
  const candidates: WaypointCandidate[] = []

  // Seed points inside the target component.
  if (targetComponent) {
    const centroid = safeTurfOp(() => turf.centroid(targetComponent).geometry.coordinates, null)
    if (centroid) candidates.push(buildWaypointCandidate(centroid, 'centroid', options, terrainData, targetComponent))
    const pof = safeTurfOp(() => turf.pointOnFeature(targetComponent).geometry.coordinates, null)
    if (pof) candidates.push(buildWaypointCandidate(pof, 'pointOnFeature', options, terrainData, targetComponent))
  }

  // Longitudinal stations with lateral samples constrained to the target component.
  const totalM = turf.length(baselineCenterline, { units: 'meters' })
  activeTimer?.startLoop('waypointStationSampling', 5)
  for (const ratio of [0.25, 0.40, 0.55, 0.70, 0.85]) {
    const m = ratio * totalM
    const pt = fastAlong(baselineCenterline as any, m, 'meters')?.geometry.coordinates
    if (!pt) continue
    const direct = buildWaypointCandidate(pt, `long${Math.round(ratio * 100)}-direct`, options, terrainData, targetComponent)
    candidates.push(direct)
    if (!targetComponent) continue
    if (!pointInsideFeature(pt, targetComponent)) continue
    const bearing = routeTangentBearing(baselineCenterline, ratio)
    for (const side of [-1, 1]) {
      const sideBearing = normalizeAngle(bearing + side * 90)
      const maxDist = lateralIntersectionDistanceFt(pt, sideBearing, targetComponent)
      if (maxDist <= 0) continue
      for (const fraction of [0.15, 0.30, 0.45]) {
        const d = Math.min(fraction * maxDist, 75)
        if (d <= 0) continue
        const p = fastRhumbDestinationCoord(pt, d, 'feet', sideBearing)
        if (!p) continue
        candidates.push(buildWaypointCandidate(p, `long${Math.round(ratio * 100)}-L${Math.round(d)}-${side > 0 ? 'R' : 'L'}`, options, terrainData, targetComponent))
      }
    }
  }
  activeTimer?.stopLoop('waypointStationSampling', candidates.length)

  // Development opportunity block centroids inside the target component.
  if (options.developmentOpportunityBlocks) {
    for (const block of options.developmentOpportunityBlocks) {
      const bg = block?.geometry
      if (!bg) continue
      const center = safeTurfOp(() => turf.centroid(bg as any).geometry.coordinates, null)
      if (!center) continue
      if (targetComponent && !pointInsideFeature(center, targetComponent)) continue
      const c = buildWaypointCandidate(center, `block-${block.id || 'unknown'}`, options, terrainData, targetComponent)
      c.developmentOpportunityClassification = block.classification || null
      candidates.push(c)
    }
  }

  // Deduplicate by coordinate within 20 ft.
  const unique: WaypointCandidate[] = []
  for (const c of candidates) {
    if (unique.some(u => turf.distance(turf.point(u.coordinate), turf.point(c.coordinate), { units: 'feet' }) < 20)) continue
    unique.push(c)
  }

  // Sort for output stability: usable first, then by lower slope, then by larger clearance.
  unique.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1
    const slopeA = a.localSlopePct === Infinity ? 9999 : a.localSlopePct
    const slopeB = b.localSlopePct === Infinity ? 9999 : b.localSlopePct
    if (slopeA !== slopeB) return slopeA - slopeB
    return b.distanceToCOAEdgeFt - a.distanceToCOAEdgeFt
  })

  if (import.meta.env.DEV) {
    const totalMs = performance.now() - t0Inventory
    const sourceCounts = { centroid: 0, pointOnFeature: 0, longitudinal: 0, lateral: 0, opportunityBlocks: 0 }
    for (const c of candidates) {
      if (c.source === 'centroid') sourceCounts.centroid++
      else if (c.source === 'pointOnFeature') sourceCounts.pointOnFeature++
      else if (c.source.startsWith('long') && c.source.includes('-direct')) sourceCounts.longitudinal++
      else if (c.source.startsWith('long') && c.source.includes('-L')) sourceCounts.lateral++
      else if (c.source.startsWith('block-')) sourceCounts.opportunityBlocks++
    }
    const getCache = (name: string) => activeCache ? activeCache.cacheStats.get(name) ?? { requests: 0, hits: 0, misses: 0 } : { requests: 0, hits: 0, misses: 0 }
    const se = getCache('sampleElevation')
    const sl = getCache('sampleLocalSlope')
    const pi = getCache('pointInside')
    const rd = getCache('ringDistance')
    const ptb = getCache('pointToBaseline')
    const ranked = activeTimer ? activeTimer.ranked().map(r => ({
      name: r.label,
      callCount: r.callCount,
      totalMs: round3(r.totalMs),
      maxMs: round3(r.maxMs),
      averageMs: r.callCount > 0 ? round3(r.totalMs / r.callCount) : 0
    })) : []
    const snapshot = unique.slice(0, MAX_WAYPOINT_CANDIDATES).map(c => ({
      coordinate: c.coordinate,
      source: c.source,
      elevation: c.elevationFt,
      slope: c.localSlopePct,
      clearance: Math.min(c.distanceToBuildingFt, c.distanceToHydrologyFt, c.distanceToPavementFt),
      baselineDistance: c.distanceToBaselineFt,
      usable: c.usable,
      primaryRejectionReason: c.primaryRejectionReason
    }))
    console.log('[WaypointInventoryOptimizationAudit]', {
      mcpi: options.mcpi,
      totalMsBeforeEquivalentOrBaselineMs: null,
      totalMs: round3(totalMs),
      candidateCounts: {
        rawGenerated: candidates.length,
        uniqueCoordinates: unique.length,
        accepted: unique.filter(c => c.usable).length,
        rejected: unique.filter(c => !c.usable).length
      },
      sourceCounts,
      operations: ranked,
      cacheStats: {
        elevationHits: se.hits,
        elevationMisses: se.misses,
        slopeHits: sl.hits,
        slopeMisses: sl.misses,
        insideHits: pi.hits,
        insideMisses: pi.misses,
        clearanceHits: rd.hits,
        clearanceMisses: rd.misses,
        baselineDistanceHits: ptb.hits,
        baselineDistanceMisses: ptb.misses
      },
      duplicateCoordinatesAvoided: activeCache ? activeCache.duplicateTerrainSamples : 0,
      beforeAfterEquivalent: null,
      snapshot
    })
  }

  return { candidates: unique.slice(0, MAX_WAYPOINT_CANDIDATES), targetComponent }
}

const ROAD_STEP_FT = 75
const MAX_BEARING_CHANGE_DEG = 20

function isFeasibleStepPoint(
  point: number[],
  current: number[],
  target: number[],
  options: GenerateTerrainAwarePrimaryOptions,
  requiredObstacleClearanceFt: number
): boolean {
  const midpoint: number[] = [(current[0] + point[0]) / 2, (current[1] + point[1]) / 2]

  function insideSafeArea(p: number[]): boolean {
    if (options.safeCenterlineArea) {
      return pointInsideFeature(p, options.safeCenterlineArea)
    }
    return distanceToParcelEdgeFt(p, options.parcelGeometry) >= (options.requiredCenterlineInsetFt ?? 30)
  }

  if (!insideSafeArea(point)) return false
  if (!insideSafeArea(midpoint)) return false
  if (clearanceToObstacleFt(point, options.buildingUnionGeometry) < requiredObstacleClearanceFt) return false
  if (clearanceToObstacleFt(point, options.hydrologyObstaclesGeometry) < requiredObstacleClearanceFt) return false
  if (clearanceToObstacleFt(point, options.existingPavementGeometry) < requiredObstacleClearanceFt) return false

  const dCurrent = turf.distance(turf.point(current), turf.point(target), { units: 'feet' })
  const dNext = turf.distance(turf.point(point), turf.point(target), { units: 'feet' })
  if (dNext > dCurrent + 5) return false
  return true
}

function buildTerrainSteeredCenterline(
  start: number[],
  waypoints: number[][],
  end: number[],
  options: GenerateTerrainAwarePrimaryOptions,
  mode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (mode === 'DIRECT_FALLBACK' || waypoints.length === 0) {
    return turf.lineString([start, end])
  }

  const rightOfWayWidthFt = options.roadParameters.rightOfWayWidth || 50
  const requiredObstacleClearanceFt = obstacleBufferMeters(rightOfWayWidthFt) / FT_TO_METERS + 2

  const points: number[][] = [start]
  const targets = [...waypoints, end]
  let current = start
  let previousBearing = fastBearing(start, targets[0]) ?? 0

  for (let t = 0; t < targets.length; t++) {
    const target = targets[t]
    while (true) {
      const d = turf.distance(turf.point(current), turf.point(target), { units: 'feet' })
      if (d <= ROAD_STEP_FT) break

      const terrainDir = getTerrainDirectionAtPoint(current, options.terrainSuitability)
      const targetBearing = fastBearing(current, target) ?? previousBearing
      const terrainBearing = mode === 'CONTOUR_FOLLOWING'
        ? (terrainDir.contourBearing ?? targetBearing)
        : (terrainDir.fallLineBearing ?? targetBearing)

      const targetInfluence = 0.30 + 0.30 * Math.max(0, 1 - d / 300)
      const continuityInfluence = 0.15
      const terrainInfluence = 1 - targetInfluence - continuityInfluence
      const desiredBearing = blendBearings(
        [terrainBearing, targetBearing, previousBearing],
        [terrainInfluence, targetInfluence, continuityInfluence]
      )
      const baseClamped = limitBearingChange(previousBearing, desiredBearing, MAX_BEARING_CHANGE_DEG)

      const fanOffsets = [0, 5, -5, 10, -10, 15, -15, 20, -20]
      let step: number[] | null = null
      let chosenBearing = baseClamped
      for (const offset of fanOffsets) {
        const candidate = limitBearingChange(previousBearing, baseClamped + offset, MAX_BEARING_CHANGE_DEG)
        const candidateStep = fastRhumbDestinationCoord(current, ROAD_STEP_FT, 'feet', candidate)
        if (candidateStep && candidateStep.length >= 2) {
          const ok = isFeasibleStepPoint(candidateStep, current, target, options, requiredObstacleClearanceFt)
          if (ok) {
            step = candidateStep
            chosenBearing = candidate
            break
          }
        }
      }

      if (!step) return null

      current = step
      points.push(current)
      previousBearing = chosenBearing

      if (points.length > 50) break
    }
    points.push(target)
    previousBearing = fastBearing(current, target) ?? previousBearing
    current = target
  }

  const cleaned = cleanReversedAndTinySegments(points)
  return cleaned.length >= 2 ? turf.lineString(cleaned) : null
}

function cleanReversedAndTinySegments(coords: number[][]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < coords.length; i++) {
    if (i === 0) {
      out.push(coords[i])
      continue
    }
    const d = turf.distance(turf.point(out[out.length - 1]), turf.point(coords[i]), { units: 'feet' })
    if (d < 10 && i < coords.length - 1) continue
    if (out.length >= 2) {
      const brg = fastBearing(out[out.length - 2], out[out.length - 1])
      const newBearing = fastBearing(out[out.length - 1], coords[i])
      if (brg != null && newBearing != null) {
        const diff = Math.abs((((newBearing - brg) % 360) + 540) % 360 - 180)
        if (diff > 170) continue
      }
    }
    out.push(coords[i])
  }
  return out
}

function computeTerrainAlignmentScore(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  mode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK',
  terrainSuitability: TerrainSuitabilityResult
): number | null {
  if (mode === 'DIRECT_FALLBACK') return null
  const coords = centerline.geometry.coordinates as number[][]
  if (coords.length < 2) return null

  let total = 0
  let weight = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]
    const b = coords[i + 1]
    const brg = fastBearing(a, b)
    if (brg == null) continue
    const mid: number[] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const dir = getTerrainDirectionAtPoint(mid, terrainSuitability)
    const targetBearing = mode === 'CONTOUR_FOLLOWING' ? dir.contourBearing : dir.fallLineBearing
    if (targetBearing == null || dir.confidence === 'UNAVAILABLE' || dir.confidence === 'LOW') continue
    const diff = Math.abs((((brg - targetBearing) % 360) + 540) % 360 - 180)
    const alignment = Math.max(0, Math.cos((diff * Math.PI) / 180))
    const w = dir.confidence === 'HIGH' ? 1.0 : 0.7
    total += alignment * w
    weight += w
  }
  return weight > 0 ? total / weight : null
}

function categorizePrimaryRejection(reason: string | null): string {
  if (!reason) return 'VALID'
  const r = reason.toLowerCase()
  if (r.includes('building')) return 'BUILDING_CONFLICT'
  if (r.includes('water') || r.includes('hydrology')) return 'HYDROLOGY_CONFLICT'
  if (r.includes('pavement')) return 'PAVEMENT_CONFLICT'
  if (r.includes('exceeds 100 ft outside parcel')) return 'OUTSIDE_PARCEL'
  if (r.includes('leaves parcel interior')) return 'ROW_OUTSIDE_PARCEL'
  if (r.includes('only ') && r.includes('inside parcel')) return 'ROW_OUTSIDE_PARCEL'
  if (r.includes('right-of-way leaves the developable residual area')) return 'OUTSIDE_CANDIDATE_AREA'
  if (r.includes('excessive deflection')) return 'EXCESSIVE_DEFLECTION'
  if (r.includes('too many bends')) return 'TOO_MANY_BENDS'
  if (r.includes('short initial tangent')) return 'TOO_SHORT'
  if (r.includes('length exceeds maximum')) return 'TOO_LONG'
  if (r.includes('route efficiency exceeds maximum')) return 'ROUTE_EFFICIENCY'
  if (r.includes('could not buffer for obstacle check')) return 'INVALID_GEOMETRY'
  if (r.includes('could not buffer right-of-way')) return 'INVALID_GEOMETRY'
  if (r.includes('collapsed to baseline')) return 'COLLAPSED_TO_BASELINE'
  if (r === 'insufficient_deviation') return 'COLLAPSED_TO_BASELINE'
  if (r === 'two_point_route') return 'COLLAPSED_TO_BASELINE'
  if (r === 'other') return 'COLLAPSED_TO_BASELINE'
  if (r.includes('could not compute service area')) return 'NO_SERVICE_AREA'
  if (r.includes('corridor is too narrow')) return 'NARROW_CORRIDOR'
  return 'OTHER'
}

function maxCenterlineDeviationFromBaseline(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  baselineCenterline: GeoJSON.Feature<GeoJSON.LineString> | null
): number {
  if (!baselineCenterline) return 0
  const baselineLine = baselineCenterline
  let max = 0
  for (const coord of centerline.geometry.coordinates) {
    const d = safeTurfOp(() => turf.pointToLineDistance(turf.point(coord), baselineLine, { units: 'feet' }), 0)
    if (d > max) max = d
  }
  return max
}

function buildRouteAlternative(
  id: string,
  family: TerrainRoadAlternativeFamily,
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  baseline: ConceptualRoadSkeletonResult,
  options: GenerateTerrainAwarePrimaryOptions,
  terrainData: TerrainData,
  maxWaypointOffsetFromBaselineFt: number
): TerrainRoadAlternative {
  const altStart = performance.now()
  const subs = {
    waypointGenerationMs: 0,
    terrainSamplingMs: 0,
    routeConstructionMs: 0,
    obstacleValidationMs: 0,
    scoringMs: 0
  }

  let t0 = performance.now(); let t0Turf = getTurfStageTotal()
  const rightOfWay = bufferRightOfWay(centerline, options.roadParameters.rightOfWayWidth || 50)
  let t1 = performance.now()
  subs.routeConstructionMs += t1 - t0
  recordRouteBreakdown('bufferRightOfWay', t0, t0Turf)

  t0 = performance.now(); t0Turf = getTurfStageTotal()
  const residual = rightOfWay ? computeResidual(options.candidateOpenAreaGeometry, rightOfWay) : null
  t1 = performance.now()
  subs.routeConstructionMs += t1 - t0
  recordRouteBreakdown('computeResidual', t0, t0Turf)

  t0 = performance.now(); t0Turf = getTurfStageTotal()
  const gq = geometryQualityMetrics(centerline)
  t1 = performance.now()
  subs.routeConstructionMs += t1 - t0
  recordRouteBreakdown('geometryQualityMetrics', t0, t0Turf)
  const maxCenterlineDeviationFt = maxCenterlineDeviationFromBaseline(centerline, (options as any).__baselineCenterline)
  const MIN_MEANINGFUL_CENTERLINE_DEVIATION_FT = 15
  let geometryCollapsed = centerline.geometry.coordinates.length <= 3 || maxCenterlineDeviationFt < MIN_MEANINGFUL_CENTERLINE_DEVIATION_FT
  let collapseReason: string | null = null
  if (geometryCollapsed) {
    if (centerline.geometry.coordinates.length <= 3) collapseReason = 'TWO_POINT_ROUTE'
    else if (maxCenterlineDeviationFt < MIN_MEANINGFUL_CENTERLINE_DEVIATION_FT) collapseReason = 'INSUFFICIENT_DEVIATION'
    else collapseReason = 'OTHER'
  }

  t0 = performance.now(); t0Turf = getTurfStageTotal()
  const terrainProfile = sampleTerrainProfile(
    id,
    'primary',
    baseline.connectionStreetName || null,
    centerline,
    gq.roadLengthFt,
    terrainData,
    undefined,
    activeCache?.sampleElevation
  )
  t1 = performance.now()
  subs.terrainSamplingMs += t1 - t0
  recordRouteBreakdown('sampleTerrainProfile', t0, t0Turf)

  t0 = performance.now(); t0Turf = getTurfStageTotal()
  const served = estimateServedArea(centerline, options.candidateOpenAreaGeometry)
  t1 = performance.now()
  subs.scoringMs += t1 - t0
  recordRouteBreakdown('estimateServedArea', t0, t0Turf)
  const componentArea = baseline.candidateComponentUsed?.areaSqFt ?? served.componentAreaSqFt
  const componentServiceRatio = componentArea > 0 ? served.servedSqFt / componentArea : 0

  const metrics: TerrainRoutingMetrics = {
    ...gq,
    averageGradePercent: terrainProfile.averageGradePercent,
    maximumSegmentGradePercent: terrainProfile.maximumSegmentGradePercent,
    steepSegmentCount: terrainProfile.steepSegmentCount,
    totalElevationChangeFt: terrainProfile.totalElevationChangeFt,
    netElevationChangeFt: terrainProfile.netElevationChangeFt,
    terrainCoveragePercent: terrainProfile.terrainCoveragePercent,
    terrainConfidence: terrainProfile.confidence,
    terrainAssessment: terrainProfile.terrainAssessment,
    servedDevelopableAreaSqFt: served.servedSqFt,
    componentServiceRatio
  }

  let hardValidFinal: boolean
  let finalReason: string | null
  let insidePercent = 0
  let expectedEntryOutsideAreaSqFt = 0
  let invalidInteriorOutsideAreaSqFt = 0

  if (geometryCollapsed) {
    hardValidFinal = false
    finalReason = collapseReason ?? 'Geometry collapsed to baseline'
  } else {
    t0 = performance.now(); t0Turf = getTurfStageTotal()
    const { valid, reason, insidePercent: pct, expectedEntryOutsideAreaSqFt: expected, invalidInteriorOutsideAreaSqFt: invalid } = hardValid(
      centerline,
      rightOfWay,
      options.parcelGeometry,
      options.buildingUnionGeometry,
      options.hydrologyObstaclesGeometry,
      options.existingPavementGeometry,
      options.roadParameters.rightOfWayWidth || 50
    )
    t1 = performance.now()
    subs.obstacleValidationMs += t1 - t0
    recordRouteBreakdown('hardValid', t0, t0Turf)
    insidePercent = pct
    expectedEntryOutsideAreaSqFt = expected
    invalidInteriorOutsideAreaSqFt = invalid
    const extraReasons: string[] = []
    if (gq.maxDeflectionAngle > MAX_DEFLECTION_DEG) extraReasons.push('excessive deflection')
    if (gq.bendCount > MAX_BEND_COUNT) extraReasons.push('too many bends')
    if (gq.initialTangentLengthFt < MIN_INITIAL_TANGENT_FT) extraReasons.push('short initial tangent')
    hardValidFinal = valid && extraReasons.length === 0
    finalReason = hardValidFinal ? null : (reason ? `${reason}; ${extraReasons.join(', ')}` : extraReasons.join(', '))
  }

  const rejectionCategory = categorizePrimaryRejection(finalReason)

  if (VERBOSE_GIS_DIAGNOSTICS) {
    const profilePoints: any[] = terrainProfile.profile.points || []
    const maxGradePoint = computeMaxGradePoint(terrainProfile)
    const buildingConflict = options.buildingUnionGeometry ? safeTurfOp(() => rightOfWay && turf.booleanIntersects(rightOfWay as any, options.buildingUnionGeometry as any), false) : false
    const hydrologyConflict = options.hydrologyObstaclesGeometry ? safeTurfOp(() => rightOfWay && turf.booleanIntersects(rightOfWay as any, options.hydrologyObstaclesGeometry as any), false) : false
    const pavementConflict = options.existingPavementGeometry ? safeTurfOp(() => rightOfWay && turf.booleanIntersects(rightOfWay as any, options.existingPavementGeometry as any), false) : false

    console.log('[TerrainRouteGeometryAudit] ' + JSON.stringify({
      routeId: id,
      family,
      waypointCount: family === 'ADAPTIVE_1' ? 1 : family === 'ADAPTIVE_2' ? 2 : 0,
      rawPointCount: centerline.geometry.coordinates.length,
      finalPointCount: centerline.geometry.coordinates.length,
      centerlineCoordinates: centerline.geometry.coordinates,
      maxWaypointOffsetFromBaselineFt,
      geometryCollapsedToBaseline: geometryCollapsed,
      collapseReason: geometryCollapsed ? 'waypoints within meaningful deviation threshold' : null,
      rowInsideParcelPercent: insidePercent,
      expectedEntryOutsideAreaSqFt,
      invalidInteriorOutsideAreaSqFt,
      roadLengthFt: gq.roadLengthFt,
      straightLineLengthFt: gq.straightLineLengthFt,
      routeEfficiency: gq.routeEfficiencyRatio,
      bendCount: gq.bendCount,
      maxDeflection: gq.maxDeflectionAngle,
      averageGradePercent: terrainProfile.averageGradePercent,
      maximumSegmentGradePercent: terrainProfile.maximumSegmentGradePercent,
      steepSegmentCount: terrainProfile.steepSegmentCount,
      totalElevationChangeFt: terrainProfile.totalElevationChangeFt,
      servedDevelopableAreaSqFt: served.servedSqFt,
      componentServiceRatio,
      terrainAssessment: terrainProfile.terrainAssessment,
      hardValid: hardValidFinal,
      rejectionReason: finalReason,
      buildingConflict,
      hydrologyConflict,
      pavementConflict,
      maxGradePoint,
      startElevationFt: profilePoints[0]?.elevationFt ?? null,
      endElevationFt: profilePoints[profilePoints.length - 1]?.elevationFt ?? null,
      sampleSpacingFt: terrainProfile.profile.sampleSpacingFt ?? null
    }))
  }

  const altTotal = performance.now() - altStart
  activeTimer?.recordAlternative({
    id,
    totalMs: round3(altTotal),
    waypointGenerationMs: round3(subs.waypointGenerationMs),
    terrainSamplingMs: round3(subs.terrainSamplingMs),
    routeConstructionMs: round3(subs.routeConstructionMs),
    obstacleValidationMs: round3(subs.obstacleValidationMs),
    scoringMs: round3(subs.scoringMs),
    waypointCount: family === 'ADAPTIVE_1' ? 1 : family === 'ADAPTIVE_2' ? 2 : 0,
    routePointCount: centerline.geometry.coordinates.length,
    segmentCount: Math.max(0, centerline.geometry.coordinates.length - 1)
  })

  const terrainAlignment = options.terrainSuitability && options.terrainRoadMode
    ? computeTerrainAlignmentScore(centerline, options.terrainRoadMode, options.terrainSuitability)
    : null
  const precedent = options.roadPrecedentProfile
    ? scorePrecedentForMode(options.terrainRoadMode ?? 'CONTOUR_FOLLOWING', options.roadPrecedentProfile)
    : { score: 0, confidence: 0 }

  const alt: TerrainRoadAlternative = {
    id,
    family,
    hardValid: hardValidFinal,
    rejectionReason: finalReason,
    rejectionCategory,
    centerline,
    rightOfWay,
    residual,
    lengthFt: gq.roadLengthFt,
    terrainProfile,
    metrics,
    selected: false,
    terrainRoadMode: options.terrainRoadMode ?? 'CONTOUR_FOLLOWING',
    terrainAlignmentScore: terrainAlignment,
    roadPrecedentScore: precedent.score,
    roadPrecedentPattern: options.roadPrecedentProfile?.inferredPattern,
    roadPrecedentConfidence: options.roadPrecedentProfile?.confidence
  }
  ;(alt as any).__maxWaypointOffsetFromBaselineFt = maxWaypointOffsetFromBaselineFt
  return alt
}

function buildAdaptiveRoutes(
  baseline: ConceptualRoadSkeletonResult,
  inventory: WaypointCandidate[],
  options: GenerateTerrainAwarePrimaryOptions,
  terrainData: TerrainData
): { alternatives: TerrainRoadAlternative[]; oneWaypointCount: number; twoWaypointCount: number; distinctRouteCount: number; collapsedRouteCount: number } {
  if (!baseline.proposedRoadCenterline) return { alternatives: [], oneWaypointCount: 0, twoWaypointCount: 0, distinctRouteCount: 0, collapsedRouteCount: 0 }

  const coords = baseline.proposedRoadCenterline.geometry.coordinates as number[][]
  const start = coords[0]
  const end = coords[coords.length - 1]

  const usable = inventory.filter(c => c.usable)
  const topForOne = usable.slice(0, ONE_WAYPOINT_LIMIT)
  const topForTwo = usable.slice(0, Math.min(usable.length, 8))

  const alternatives: TerrainRoadAlternative[] = []
  let oneWaypointCount = 0
  let twoWaypointCount = 0
  let distinctRouteCount = 0
  let collapsedRouteCount = 0

  // One-waypoint routes.
  activeTimer?.startLoop('oneWaypointRoutes', topForOne.length)
  for (let i = 0; i < topForOne.length; i++) {
    const w = topForOne[i]
    const maxOffset = w.distanceToBaselineFt
    const centerline = buildTerrainSteeredCenterline(start, [w.coordinate], end, options, options.terrainRoadMode ?? 'CONTOUR_FOLLOWING')
    if (!centerline) continue
    oneWaypointCount++
    if (maxOffset >= MIN_MEANINGFUL_WAYPOINT_DEVIATION_FT) distinctRouteCount++
    else collapsedRouteCount++
    const alt = withSubTiming('buildRouteAlternative', () => buildRouteAlternative(
      `${options.mcpi}-ADAPTIVE_1-${i}`,
      'ADAPTIVE_1',
      centerline,
      baseline,
      options,
      terrainData,
      maxOffset
    ))
    alternatives.push(alt)
  }
  activeTimer?.stopLoop('oneWaypointRoutes', oneWaypointCount)

  // Two-waypoint routes.
  activeTimer?.startLoop('twoWaypointPairGeneration', topForTwo.length * topForTwo.length)
  const twoWaypointPairs: [WaypointCandidate, WaypointCandidate][] = []
  for (let i = 0; i < topForTwo.length; i++) {
    for (let j = 0; j < topForTwo.length; j++) {
      if (i === j) continue
      const w1 = topForTwo[i]
      const w2 = topForTwo[j]
      // Enforce progress: w2 must be closer to the end than w1.
      const d1 = turf.distance(turf.point(w1.coordinate), turf.point(end), { units: 'feet' })
      const d2 = turf.distance(turf.point(w2.coordinate), turf.point(end), { units: 'feet' })
      if (d2 >= d1) continue
      twoWaypointPairs.push([w1, w2])
    }
  }
  activeTimer?.stopLoop('twoWaypointPairGeneration', twoWaypointPairs.length)

  // Sort pairs by combined slope preference and limited detour, then cap.
  twoWaypointPairs.sort((a, b) => {
    const slopeA = a[0].localSlopePct + a[1].localSlopePct
    const slopeB = b[0].localSlopePct + b[1].localSlopePct
    const detourA = turf.distance(turf.point(a[0].coordinate), turf.point(a[1].coordinate), { units: 'feet' })
    const detourB = turf.distance(turf.point(b[0].coordinate), turf.point(b[1].coordinate), { units: 'feet' })
    if (slopeA !== slopeB) return slopeA - slopeB
    return detourA - detourB
  })

  const selectedPairs = twoWaypointPairs.slice(0, TWO_WAYPOINT_LIMIT)
  twoWaypointCount = selectedPairs.length
  activeTimer?.startLoop('twoWaypointRoutes', selectedPairs.length)
  for (let i = 0; i < selectedPairs.length; i++) {
    const [w1, w2] = selectedPairs[i]
    const maxOffset = Math.max(w1.distanceToBaselineFt, w2.distanceToBaselineFt)
    const centerline = buildTerrainSteeredCenterline(start, [w1.coordinate, w2.coordinate], end, options, options.terrainRoadMode ?? 'CONTOUR_FOLLOWING')
    if (!centerline) continue
    if (maxOffset >= MIN_MEANINGFUL_WAYPOINT_DEVIATION_FT) distinctRouteCount++
    else collapsedRouteCount++
    const alt = withSubTiming('buildRouteAlternative', () => buildRouteAlternative(
      `${options.mcpi}-ADAPTIVE_2-${i}`,
      'ADAPTIVE_2',
      centerline,
      baseline,
      options,
      terrainData,
      maxOffset
    ))
    alternatives.push(alt)
  }
  activeTimer?.stopLoop('twoWaypointRoutes', twoWaypointCount)

  return { alternatives, oneWaypointCount, twoWaypointCount, distinctRouteCount, collapsedRouteCount }
}

function buildSafeCenterlineArea(
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  insetFt: number
): { feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null; method: 'NEGATIVE_BUFFER' | 'BOUNDARY_DISTANCE_FALLBACK'; geometryType: string | null; areaSqFt: number | null; failureReason: string | null } {
  const parcelFeature = turf.feature(parcelGeometry as any)
  const polys = featureToPolygons(parcelFeature)
  const validCoords: number[][][][] = []

  for (const poly of polys) {
    const buffered = safeTurfOp(
      () => turf.buffer(poly as any, -insetFt, { units: 'feet' }),
      null
    )
    if (!buffered) continue
    const area = safeTurfOp(() => turf.area(buffered as any), 0)
    if (area <= 0.1) continue
    const bufferedPolys = featureToPolygons(buffered as any)
    for (const bp of bufferedPolys) {
      validCoords.push(bp.geometry.coordinates as number[][][])
    }
  }

  if (validCoords.length === 0) {
    return { feature: null, method: 'BOUNDARY_DISTANCE_FALLBACK', geometryType: null, areaSqFt: null, failureReason: 'Negative buffer produced no usable interior area for the required inset' }
  }

  const feature = validCoords.length === 1
    ? (turf.polygon(validCoords[0]) as any)
    : (turf.multiPolygon(validCoords) as any)
  const area = safeTurfOp(() => turf.area(feature), 0)
  const areaSqFt = squareMetersToSquareFeet(area)
  return { feature, method: 'NEGATIVE_BUFFER', geometryType: feature.geometry.type, areaSqFt, failureReason: null }
}

export function generateTerrainAwarePrimary(
  baseline: ConceptualRoadSkeletonResult,
  options: GenerateTerrainAwarePrimaryOptions
): TerrainRoadAlternativeResult {
  const terrainData = options.terrainData
  const cache = new TerrainCache()
  const timer = new TerrainAwareTimer()
  const startMs = performance.now()

  if (!options.roadPrecedentProfile && options.mcpi && options.nearbyStreets && options.terrainSuitability) {
    options.roadPrecedentProfile = analyzeNearbyRoadPrecedent(options.mcpi, options.nearbyStreets, options.terrainSuitability)
  }

  const rightOfWayWidthFt = options.roadParameters.rightOfWayWidth || 50
  const rowHalfFt = rightOfWayHalfMeters(rightOfWayWidthFt) / FT_TO_METERS
  const requiredInset = rowHalfFt + 5
  options.requiredCenterlineInsetFt = requiredInset
  const safeCenterline = buildSafeCenterlineArea(options.parcelGeometry, requiredInset)
  options.safeCenterlineArea = safeCenterline.feature
  const rowSafety: PrimaryRoadRowSafety = {
    primaryRowWidthFt: rightOfWayWidthFt,
    requiredCenterlineInsetFt: requiredInset,
    safeCenterlineAreaAvailable: !!safeCenterline.feature,
    safeCenterlineMethod: safeCenterline.method,
    safeCenterlineAreaGeometryType: safeCenterline.geometryType,
    safeCenterlineAreaSqFt: safeCenterline.areaSqFt,
    safeCenterlineFailureReason: safeCenterline.failureReason
  }
  // Store the baseline centerline for distance calculations.
  ;(options as any).__baselineCenterline = baseline.proposedRoadCenterline

  function emitAudits(result: TerrainRoadAlternativeResult, totalMs: number) {
    const selected = result.selected
    const selectedMaxOffset = (selected as any).__maxWaypointOffsetFromBaselineFt ?? 0
    const refAlt = withActiveContext(() => {
      if (selected.family === 'BASELINE') {
        return buildBaselineAlternative(baseline, options)
      }
      return buildRouteAlternative(
        `ref-${selected.id}`,
        selected.family,
        selected.centerline,
        baseline,
        options,
        terrainData!,
        selectedMaxOffset
      )
    }, new TerrainCache(), new TerrainAwareTimer())

    const mismatches: any[] = []
    function note(label: string, a: any, b: any) {
      const av = JSON.stringify(a)
      const bv = JSON.stringify(b)
      if (av !== bv) mismatches.push({ field: label, optimized: a, reference: b })
    }
    {
      note('selectedCandidate', selected.id, refAlt.id)
      note('selectedFamily', selected.family, refAlt.family)
      note('proposedRoadCenterline', selected.centerline.geometry.coordinates, refAlt.centerline.geometry.coordinates)
      note('proposedRoadLengthFt', selected.lengthFt, refAlt.lengthFt)
      note('maxGradePercent', selected.metrics.maximumSegmentGradePercent, refAlt.metrics.maximumSegmentGradePercent)
      note('avgGradePercent', selected.metrics.averageGradePercent, refAlt.metrics.averageGradePercent)
      note('steepSegmentCount', selected.metrics.steepSegmentCount, refAlt.metrics.steepSegmentCount)
      note('bendCount', selected.metrics.bendCount, refAlt.metrics.bendCount)
      note('servedAreaSqFt', selected.metrics.servedDevelopableAreaSqFt, refAlt.metrics.servedDevelopableAreaSqFt)
      note('routeEfficiency', selected.metrics.routeEfficiencyRatio, refAlt.metrics.routeEfficiencyRatio)
      note('terrainAssessment', selected.terrainProfile.terrainAssessment, refAlt.terrainProfile.terrainAssessment)
      const rowAreaA = selected.rightOfWay ? safeTurfOp(() => turf.area(selected.rightOfWay as any), 0) : 0
      const rowAreaB = refAlt.rightOfWay ? safeTurfOp(() => turf.area(refAlt.rightOfWay as any), 0) : 0
      const resAreaA = selected.residual ? safeTurfOp(() => turf.area(selected.residual as any), 0) : 0
      const resAreaB = refAlt.residual ? safeTurfOp(() => turf.area(refAlt.residual as any), 0) : 0
      note('rightOfWayAreaSqFt', rowAreaA, rowAreaB)
      note('residualAreaSqFt', resAreaA, resAreaB)
      const buildingA = options.buildingUnionGeometry ? safeTurfOp(() => selected.rightOfWay && turf.booleanIntersects(selected.rightOfWay as any, options.buildingUnionGeometry as any), false) : false
      const buildingB = options.buildingUnionGeometry ? safeTurfOp(() => refAlt.rightOfWay && turf.booleanIntersects(refAlt.rightOfWay as any, options.buildingUnionGeometry as any), false) : false
      const hydA = options.hydrologyObstaclesGeometry ? safeTurfOp(() => selected.rightOfWay && turf.booleanIntersects(selected.rightOfWay as any, options.hydrologyObstaclesGeometry as any), false) : false
      const hydB = options.hydrologyObstaclesGeometry ? safeTurfOp(() => refAlt.rightOfWay && turf.booleanIntersects(refAlt.rightOfWay as any, options.hydrologyObstaclesGeometry as any), false) : false
      const pavA = options.existingPavementGeometry ? safeTurfOp(() => selected.rightOfWay && turf.booleanIntersects(selected.rightOfWay as any, options.existingPavementGeometry as any), false) : false
      const pavB = options.existingPavementGeometry ? safeTurfOp(() => refAlt.rightOfWay && turf.booleanIntersects(refAlt.rightOfWay as any, options.existingPavementGeometry as any), false) : false
      note('buildingConflict', buildingA, buildingB)
      note('hydrologyConflict', hydA, hydB)
      note('pavementConflict', pavA, pavB)
    }

    const ranked = timer.ranked().map(r => ({
      label: r.label,
      callCount: r.callCount,
      totalMs: round3(r.totalMs),
      avgMs: r.callCount > 0 ? round3(r.totalMs / r.callCount) : 0,
      maxMs: round3(r.maxMs),
      turfMs: round3(r.turfMs),
      cacheHits: r.cacheHits,
      cacheMisses: r.cacheMisses
    }))
    const terrainSampleCount = cache.sampleElevation.size
    const uniqueTerrainSampleCount = cache.uniqueTerrainSamples
    const duplicateTerrainSampleCount = cache.duplicateTerrainSamples
    const duplicateTerrainSamplePercent = uniqueTerrainSampleCount + duplicateTerrainSampleCount > 0
      ? round3((duplicateTerrainSampleCount / (uniqueTerrainSampleCount + duplicateTerrainSampleCount)) * 100)
      : 0

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[TerrainAwareHotspotAudit]', {
        mcpi: baseline.mcpi,
        totalTerrainAwareMs: round3(totalMs),
        subfunctions: ranked,
        cacheHits: ranked.reduce((s, r) => s + r.cacheHits, 0),
        cacheMisses: ranked.reduce((s, r) => s + r.cacheMisses, 0),
        pointInsideBboxRejects: cache.pointInsideBboxRejects,
        terrainSampleCount,
        uniqueTerrainSampleCount,
        duplicateTerrainSampleCount,
        duplicateTerrainSamplePercent,
        repeatedGeometryCount: cache.repeatedGeometryConstructions,
        turfOperationMs: round3(ranked.reduce((s, r) => s + r.turfMs, 0)),
        cacheStats: Object.fromEntries(cache.cacheStats.entries()),
        terrainCacheRequests: [...cache.cacheStats.values()].reduce((s, v) => s + v.requests, 0),
        terrainCacheHits: [...cache.cacheStats.values()].reduce((s, v) => s + v.hits, 0),
        terrainCacheMisses: [...cache.cacheStats.values()].reduce((s, v) => s + v.misses, 0),
        terrainCacheHitRate: [...cache.cacheStats.values()].reduce((s, v) => s + v.requests, 0) > 0
          ? round3([...cache.cacheStats.values()].reduce((s, v) => s + v.hits, 0) / [...cache.cacheStats.values()].reduce((s, v) => s + v.requests, 0))
          : 0
      })
      console.log('[TerrainAwareOptimizationEquivalenceAudit]', {
        mcpi: baseline.mcpi,
        allEquivalent: mismatches.length === 0,
        mismatchCount: mismatches.length,
        mismatches,
        selectedFamily: selected.family,
        selectedId: selected.id,
        referenceId: refAlt?.id
      })
    }

    if (VERBOSE_GIS_DIAGNOSTICS) {
      const totalRouteMs = Object.values(routeAlternativeBreakdown).reduce((s, r) => s + r.totalMs, 0)
      const breakdown = Object.entries(routeAlternativeBreakdown).map(([label, r]) => ({
        label,
        callCount: r.callCount,
        totalMs: round3(r.totalMs),
        avgMs: r.callCount > 0 ? round3(r.totalMs / r.callCount) : 0,
        maxMs: round3(r.maxMs),
        percentOfBuildRouteAlternative: totalRouteMs > 0 ? round3((r.totalMs / totalRouteMs) * 100) : 0
      }))
      const trackedMs = breakdown.reduce((s, r) => s + r.totalMs, 0)
      if (totalRouteMs > trackedMs) {
        breakdown.push({
          label: 'other/unaccounted',
          callCount: Object.values(routeAlternativeBreakdown).reduce((s, r) => s + r.callCount, 0),
          totalMs: round3(totalRouteMs - trackedMs),
          avgMs: 0,
          maxMs: 0,
          percentOfBuildRouteAlternative: totalRouteMs > 0 ? round3(((totalRouteMs - trackedMs) / totalRouteMs) * 100) : 0
        })
      }
      console.log('[TerrainRouteAlternativeBreakdownAudit]', {
        mcpi: baseline.mcpi,
        callCount: breakdown.reduce((s, r) => Math.max(s, r.callCount), 0),
        totalBuildRouteAlternativeMs: round3(totalRouteMs),
        breakdown
      })
    }

    // DEV-only deep performance audit.
    if (import.meta.env.DEV) {
      const measuredOperationMs = round3(Object.values(timer.records).reduce((s, r) => s + r.totalMs, 0))
      const unaccountedMs = round3(Math.max(0, totalMs - measuredOperationMs))
      const unaccountedPercent = totalMs > 0 ? round3((unaccountedMs / totalMs) * 100) : 0
      const ops = timer.ranked()
      const slowest = ops[0]

      const inputRoutePointCount = baseline.proposedRoadCenterline
        ? baseline.proposedRoadCenterline.geometry.coordinates.length
        : 0
      const terrainQueries = getTerrainLineQueryAudit()

      const topSlowAlternatives = [...timer.alternativeRecords]
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 5)

      console.log('[TerrainAwarePrimaryDeepPerformanceAudit]', {
        mcpi: baseline.mcpi,
        totalMs: round3(totalMs),
        measuredOperationMs,
        unaccountedMs,
        unaccountedPercent,
        slowestOperation: slowest?.label ?? null,
        slowestOperationMs: slowest ? round3(slowest.totalMs) : 0,
        slowestOperationPercent: slowest && totalMs > 0 ? round3((slowest.totalMs / totalMs) * 100) : 0,
        operations: ops.map(r => ({
          name: r.label,
          callCount: r.callCount,
          totalMs: round3(r.totalMs),
          maxMs: round3(r.maxMs),
          averageMs: r.callCount > 0 ? round3(r.totalMs / r.callCount) : 0
        })),
        loops: Object.values(timer.loopRecords).map(l => ({
          name: l.name,
          executionCount: l.executionCount,
          iterationsEntering: l.iterationsEntering,
          iterationsExiting: l.iterationsExiting,
          totalMs: round3(l.totalMs),
          maxMs: round3(l.maxMs),
          averageMs: l.executionCount > 0 ? round3(l.totalMs / l.executionCount) : 0
        })),
        counts: {
          inputRoutePointCount,
          terrainSampleCount,
          waypointCandidateCount: result.waypointInventory?.candidateCount ?? 0,
          waypointCombinationCount: result.routeSearch?.oneWaypointRoutes ?? 0 + (result.routeSearch?.twoWaypointRoutes ?? 0),
          routeAlternativeCount: result.alternatives.length,
          validAlternativeCount: result.alternatives.filter(a => a.hardValid).length,
          rejectedAlternativeCount: result.alternatives.filter(a => !a.hardValid).length
        },
        terrainQueries: {
          requestCount: terrainQueries.requests,
          uniqueCount: terrainQueries.uniqueQueries,
          cacheHits: terrainQueries.cacheHits,
          cacheMisses: terrainQueries.cacheMisses
        },
        topSlowAlternatives
      })
      console.log('[TerrainProfileDeepPerformanceAudit]', getTerrainProfileDeepAudit(baseline.mcpi))
      console.log('[TerrainContourSpatialIndexAudit]', getContourSpatialIndexAudit(baseline.mcpi))
      resetTerrainProfileDeepAudit()
      resetContourSpatialIndexAudit()
    }
  }

  const result = withActiveContext(() => {
    if (!baseline.proposedRoadCenterline || !terrainData || !terrainData.coverageAvailable) {
      const baselineAlt = withSubTiming('buildBaselineAlternative', () => buildBaselineAlternative(baseline, options))
      return {
        mcpi: baseline.mcpi,
        baseline: baselineAlt,
        alternatives: [],
        selected: baselineAlt,
        selectionReason: 'Terrain data unavailable; baseline retained by default.',
        fallbackReason: 'TERRAIN_DATA_UNAVAILABLE' as const,
        fallbackReasonDetail: 'Terrain data or coverage not available for this parcel.',
        rowSafety,
        waypointInventory: { candidates: 0, usable: 0, rejected: 0, reasons: {}, favorableTerrainCount: 0 },
        routeSearch: { routesGenerated: 0, oneWaypointRoutes: 0, twoWaypointRoutes: 0, hardValidRoutes: 0, terrainImprovingRoutes: 0, serviceCompetitiveRoutes: 0, selectedRouteId: baselineAlt.id }
      }
    }

    const baselineAlt = withSubTiming('buildBaselineAlternative', () => buildBaselineAlternative(baseline, options))
    const { candidates, targetComponent } = withSubTiming('buildWaypointInventory', () => buildWaypointInventory(baseline, options, terrainData))

    let usableCount = 0
    let favorableCount = 0
    let projectedCount = 0
    const primaryRejectionReasons: Record<string, number> = {}
    const allRejectionCounts: Record<string, number> = {}
    for (const c of candidates) {
      if (c.usable) {
        usableCount++
        if (c.localSlopePct < 5) favorableCount++
      }
      if (c.projected) projectedCount++
      if (c.primaryRejectionReason) {
        primaryRejectionReasons[c.primaryRejectionReason] = (primaryRejectionReasons[c.primaryRejectionReason] || 0) + 1
      }
      for (const r of c.allRejectionReasons) {
        allRejectionCounts[r] = (allRejectionCounts[r] || 0) + 1
      }
    }

    const fallback = !options.terrainSuitability
    const modes: ('CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK')[] = fallback
      ? []
      : ['CONTOUR_FOLLOWING', 'FALL_LINE']

    let alternatives: TerrainRoadAlternative[] = []
    let oneWaypointCount = 0
    let twoWaypointCount = 0
    let distinctRouteCount = 0
    let collapsedRouteCount = 0
    for (const mode of modes) {
      options.terrainRoadMode = mode
      const r = withSubTiming(`buildAdaptiveRoutes-${mode}`, () => buildAdaptiveRoutes(baseline, candidates, options, terrainData))
      alternatives = alternatives.concat(r.alternatives)
      oneWaypointCount += r.oneWaypointCount
      twoWaypointCount += r.twoWaypointCount
      distinctRouteCount += r.distinctRouteCount
      collapsedRouteCount += r.collapsedRouteCount
    }

    const hardValidRoutes = alternatives.filter(a => a.hardValid).length
    const terrainImprovingRoutes = alternatives.filter(a =>
      a.hardValid && (
        baselineAlt.metrics.maximumSegmentGradePercent - a.metrics.maximumSegmentGradePercent >= MIN_TERRAIN_IMPROVEMENT_PCT ||
        baselineAlt.metrics.steepSegmentCount - a.metrics.steepSegmentCount >= 2
      )
    ).length
    const serviceCompetitiveRoutes = alternatives.filter(a =>
      a.hardValid && a.metrics.servedDevelopableAreaSqFt >= baselineAlt.metrics.servedDevelopableAreaSqFt * (MIN_SERVICE_RETENTION_PCT / 100)
    ).length

    const waypointInventory = {
      candidateCount: candidates.length,
      usableCount,
      projectedCount,
      rejectedCount: candidates.length - usableCount,
      primaryRejectionReasons,
      allRejectionCounts,
      reasons: primaryRejectionReasons,
      favorableTerrainCount: favorableCount,
      targetComponentAreaSqFt: targetComponent ? squareMetersToSquareFeet(turf.area(targetComponent)) : 0,
      candidates
    }

    const routeSearch = {
      routesGenerated: alternatives.length,
      oneWaypointRoutes: oneWaypointCount,
      twoWaypointRoutes: twoWaypointCount,
      distinctRouteCount,
      collapsedRouteCount,
      hardValidRoutes,
      terrainImprovingRoutes,
      serviceCompetitiveRoutes,
      selectedRouteId: baselineAlt.id
    }

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[TerrainWaypointInventory]', waypointInventory)
      console.log('[AdaptiveTerrainRouteSearch]', routeSearch)
    }

    // Staged comparator.
    let best = baselineAlt as TerrainRoadAlternative
    let reason = 'No materially superior terrain-aware corridor was identified within current parcel/constraint geometry.'
    let foundWinner = false
    let hardValidCount = 0
    activeTimer?.startLoop('terrainAwareSelection', alternatives.length)

    for (const alt of alternatives) {
      if (!alt.hardValid) continue
      hardValidCount++
      if (alt.metrics.servedDevelopableAreaSqFt < baselineAlt.metrics.servedDevelopableAreaSqFt * (MIN_SERVICE_RETENTION_PCT / 100)) {
        continue
      }
      if (alt.metrics.roadLengthFt > baselineAlt.metrics.roadLengthFt * (1 + MAX_ACCEPTABLE_LENGTH_INCREASE_PCT / 100)) {
        continue
      }
      if (alt.metrics.bendCount > baselineAlt.metrics.bendCount + MAX_ACCEPTABLE_BEND_INCREASE) {
        continue
      }

      const maxGradeImprovement = baselineAlt.metrics.maximumSegmentGradePercent - alt.metrics.maximumSegmentGradePercent
      const steepImprovement = baselineAlt.metrics.steepSegmentCount - alt.metrics.steepSegmentCount
      const grammarBonus = (alt.terrainAlignmentScore ?? 0) * 1.0 + (alt.roadPrecedentScore ?? 0) * 2.0

      const terrainScore =
        maxGradeImprovement * 2 +
        steepImprovement * 3 -
        Math.max(0, alt.metrics.bendCount - baselineAlt.metrics.bendCount) * 2 -
        ((alt.metrics.roadLengthFt - baselineAlt.metrics.roadLengthFt) / baselineAlt.metrics.roadLengthFt) * 5 +
        grammarBonus

      const bestGrammarBonus = (best.terrainAlignmentScore ?? 0) * 1.0 + (best.roadPrecedentScore ?? 0) * 2.0

      const bestScore =
        (baselineAlt.metrics.maximumSegmentGradePercent - best.metrics.maximumSegmentGradePercent) * 2 +
        (baselineAlt.metrics.steepSegmentCount - best.metrics.steepSegmentCount) * 3 -
        Math.max(0, best.metrics.bendCount - baselineAlt.metrics.bendCount) * 2 -
        ((best.metrics.roadLengthFt - baselineAlt.metrics.roadLengthFt) / baselineAlt.metrics.roadLengthFt) * 5 +
        bestGrammarBonus

      if (terrainScore > bestScore) {
        best = alt
        reason = `Selected ${alt.id} (family ${alt.family}) because it reduced maximum conceptual grade from ${baselineAlt.metrics.maximumSegmentGradePercent.toFixed(1)}% to ${alt.metrics.maximumSegmentGradePercent.toFixed(1)}% and steep segments from ${baselineAlt.metrics.steepSegmentCount} to ${alt.metrics.steepSegmentCount} while retaining comparable developable-land service.`
        foundWinner = true
      }
    }
    activeTimer?.stopLoop('terrainAwareSelection', foundWinner ? 1 : 0)

    if (!foundWinner) {
      reason = hardValidCount === 0
        ? 'No terrain-aware primary candidate passed the required geometry and hard-constraint validations.'
        : 'Terrain-aware candidates were generated but none were materially superior to the direct baseline.'
    }

    if (foundWinner) {
      routeSearch.selectedRouteId = best.id
    }

    const selected = best
    selected.selected = true
    baselineAlt.selected = selected.family === 'BASELINE'

    let fallbackReason: TerrainRoadAlternativeResult['fallbackReason'] = null
    let fallbackReasonDetail = reason
    if (fallback) {
      fallbackReason = 'TERRAIN_DATA_UNAVAILABLE'
      fallbackReasonDetail = 'Terrain suitability not provided; using direct baseline.'
      reason = fallbackReasonDetail
    } else if (alternatives.length === 0) {
      fallbackReason = 'NO_VALID_TERRAIN_CANDIDATES'
      fallbackReasonDetail = 'No terrain-aware routes could be constructed within the parcel for the required ROW.'
    } else if (hardValidCount === 0) {
      fallbackReason = 'NO_VALID_TERRAIN_CANDIDATES'
      fallbackReasonDetail = 'No terrain-aware candidate passed the required geometry and hard-constraint validations.'
    } else if (!foundWinner) {
      fallbackReason = 'TERRAIN_CANDIDATES_MATERIALLY_INFERIOR'
    }

    return {
      mcpi: baseline.mcpi,
      baseline: baselineAlt,
      alternatives,
      selected,
      selectionReason: reason,
      fallbackReason,
      fallbackReasonDetail,
      rowSafety,
      waypointInventory,
      routeSearch
    }
  }, cache, timer)

  const totalMs = round3(performance.now() - startMs)
  if (ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS) emitAudits(result, totalMs)
  return result
}

function buildBaselineAlternative(
  baseline: ConceptualRoadSkeletonResult,
  options: GenerateTerrainAwarePrimaryOptions
): TerrainRoadAlternative {
  const centerline = baseline.proposedRoadCenterline as GeoJSON.Feature<GeoJSON.LineString>
  const terrainProfile = baseline.terrainProfile || sampleTerrainProfile(
    'baseline',
    'primary',
    baseline.connectionStreetName || null,
    centerline,
    baseline.proposedRoadLengthFeet || 0,
    options.terrainData || null,
    undefined,
    activeCache?.sampleElevation
  )
  const gq = geometryQualityMetrics(centerline)
  const served = estimateServedArea(centerline, options.candidateOpenAreaGeometry)
  const componentArea = baseline.candidateComponentUsed?.areaSqFt ?? served.componentAreaSqFt
  const componentServiceRatio = componentArea > 0 ? served.servedSqFt / componentArea : 0

  const metrics: TerrainRoutingMetrics = {
    ...gq,
    averageGradePercent: terrainProfile.averageGradePercent,
    maximumSegmentGradePercent: terrainProfile.maximumSegmentGradePercent,
    steepSegmentCount: terrainProfile.steepSegmentCount,
    totalElevationChangeFt: terrainProfile.totalElevationChangeFt,
    netElevationChangeFt: terrainProfile.netElevationChangeFt,
    terrainCoveragePercent: terrainProfile.terrainCoveragePercent,
    terrainConfidence: terrainProfile.confidence,
    terrainAssessment: terrainProfile.terrainAssessment,
    servedDevelopableAreaSqFt: served.servedSqFt,
    componentServiceRatio
  }

  const rightOfWay = baseline.proposedRightOfWay as GeoJSON.Feature<GeoJSON.Geometry> | null
  if (rightOfWay && VERBOSE_GIS_DIAGNOSTICS) {
    const baselineAudit = primaryRoadInsideParcelAudit(centerline, rightOfWay, options.parcelGeometry, options.roadParameters.rightOfWayWidth || 50)
    const rowAreaSqFt = squareMetersToSquareFeet(turf.area(rightOfWay))
    const insideAreaSqFt = rowAreaSqFt * (baselineAudit.insidePercent / 100)
    const outsideAreaSqFt = rowAreaSqFt - insideAreaSqFt
    const profilePoints: any[] = terrainProfile.profile.points || []
    const maxGradePoint = computeMaxGradePoint(terrainProfile)
    const buildingConflict = options.buildingUnionGeometry ? safeTurfOp(() => turf.booleanIntersects(rightOfWay as any, options.buildingUnionGeometry as any), false) : false
    const hydrologyConflict = options.hydrologyObstaclesGeometry ? safeTurfOp(() => turf.booleanIntersects(rightOfWay as any, options.hydrologyObstaclesGeometry as any), false) : false
    const pavementConflict = options.existingPavementGeometry ? safeTurfOp(() => turf.booleanIntersects(rightOfWay as any, options.existingPavementGeometry as any), false) : false
    console.log('[BaselineRouteGeometryAudit] ' + JSON.stringify({
      mcpi: baseline.mcpi,
      routeId: `${baseline.mcpi}-BASELINE`,
      family: 'BASELINE',
      rawPointCount: centerline.geometry.coordinates.length,
      finalPointCount: centerline.geometry.coordinates.length,
      roadLengthFt: gq.roadLengthFt,
      straightLineLengthFt: gq.straightLineLengthFt,
      routeEfficiency: gq.routeEfficiencyRatio,
      bendCount: gq.bendCount,
      maxDeflection: gq.maxDeflectionAngle,
      averageGradePercent: terrainProfile.averageGradePercent,
      maximumSegmentGradePercent: terrainProfile.maximumSegmentGradePercent,
      steepSegmentCount: terrainProfile.steepSegmentCount,
      totalElevationChangeFt: terrainProfile.totalElevationChangeFt,
      servedDevelopableAreaSqFt: served.servedSqFt,
      componentServiceRatio,
      terrainAssessment: terrainProfile.terrainAssessment,
      rowInsideParcelPercent: baselineAudit.insidePercent,
      rowAreaSqFt,
      insideAreaSqFt,
      outsideAreaSqFt,
      expectedEntryOutsideAreaSqFt: baselineAudit.expectedEntryOutsideAreaSqFt,
      invalidInteriorOutsideAreaSqFt: baselineAudit.invalidInteriorOutsideAreaSqFt,
      buildingConflict,
      hydrologyConflict,
      pavementConflict,
      maxGradePoint,
      startElevationFt: profilePoints[0]?.elevationFt ?? null,
      endElevationFt: profilePoints[profilePoints.length - 1]?.elevationFt ?? null,
      sampleSpacingFt: terrainProfile.profile.sampleSpacingFt ?? null
    }))
  }

  return {
    id: `${baseline.mcpi}-BASELINE`,
    family: 'BASELINE',
    hardValid: true,
    rejectionReason: null,
    rejectionCategory: 'VALID',
    centerline,
    rightOfWay,
    residual: baseline.residualDevelopmentArea,
    lengthFt: baseline.proposedRoadLengthFeet || 0,
    terrainProfile,
    metrics,
    selected: false,
    terrainRoadMode: 'DIRECT_FALLBACK',
    terrainAlignmentScore: null,
    roadPrecedentScore: options.roadPrecedentProfile ? scorePrecedentForMode('DIRECT_FALLBACK', options.roadPrecedentProfile).score : 0,
    roadPrecedentPattern: options.roadPrecedentProfile?.inferredPattern,
    roadPrecedentConfidence: options.roadPrecedentProfile?.confidence
  }
}

export function applyTerrainAwareSelection(
  result: ConceptualRoadSkeletonResult,
  selection: TerrainRoadAlternativeResult
): void {
  result.terrainAlternatives = selection.alternatives
  result.terrainSelectionReason = selection.selectionReason
  result.terrainFallbackReason = selection.fallbackReason
  result.terrainFallbackReasonDetail = selection.fallbackReasonDetail
  result.primaryRoadRowSafety = selection.rowSafety
  result.terrainWaypointInventory = selection.waypointInventory ?? null
  result.adaptiveTerrainRouteSearch = selection.routeSearch ?? null

  const alt = selection.selected
  result.proposedRoadCenterline = alt.centerline
  result.proposedRightOfWay = alt.rightOfWay
  result.residualDevelopmentArea = alt.residual
  result.proposedRoadLengthFeet = alt.lengthFt
  result.terrainRoadMode = alt.terrainRoadMode
  result.terrainAlignmentScore = alt.terrainAlignmentScore ?? null
  result.roadPrecedentScore = alt.roadPrecedentScore ?? null
  result.roadPrecedentPattern = alt.roadPrecedentPattern
  result.roadPrecedentConfidence = alt.roadPrecedentConfidence
  result.vertexCount = alt.centerline.geometry.coordinates.length


  if (result.primarySpineAdequacy) {
    result.primarySpineAdequacy.achievedPenetrationMeters = alt.lengthFt * FT_TO_METERS
    result.primarySpineAdequacy.servedDevelopableAreaSqFt = alt.metrics.servedDevelopableAreaSqFt
    result.primarySpineAdequacy.componentServiceRatio = alt.metrics.componentServiceRatio
    result.primarySpineAdequacy.bendCount = alt.metrics.bendCount
    result.primarySpineAdequacy.maxDeflectionAngle = alt.metrics.maxDeflectionAngle
    result.primarySpineAdequacy.totalAbsoluteDeflection = alt.metrics.totalAbsoluteDeflection
    result.primarySpineAdequacy.routeEfficiencyRatio = alt.metrics.routeEfficiencyRatio
    result.primarySpineAdequacy.initialTangentLengthFt = alt.metrics.initialTangentLengthFt
  }

  const rightOfWayArea = safeTurfOp(() => (alt.rightOfWay ? turf.area(alt.rightOfWay) : 0), 0)
  result.rightOfWayAreaAcres = squareMetersToSquareFeet(rightOfWayArea) / 43560

  const residualArea = safeTurfOp(() => (alt.residual ? turf.area(alt.residual) : 0), 0)
  result.residualDevelopmentAreaAcres = squareMetersToSquareFeet(residualArea) / 43560
}
