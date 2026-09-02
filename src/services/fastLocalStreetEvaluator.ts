import { turfc as turf, VERBOSE_GIS_DIAGNOSTICS, generationPerformance, turfCounter } from '../lib/perf'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type { ProjectParameters } from '../types/parameters'
import type { ConceptualDevelopmentProgramResult, ConceptualDevelopmentZone } from './conceptualDevelopmentProgram'
import type { ConceptualLocalStreet } from '../types/localStreets'
import type { ConceptualDevelopmentLayoutResult, ConceptualLot, ConceptualBuildingEnvelope, ConceptualLotAuditItem, LotFrontageGenerationAudit, DevelopmentUseAssignment } from './conceptualDevelopmentLayout'
import { generateSingleFamilyLots, computeAvailableGeometry } from './conceptualDevelopmentLayout'
import { fastBearing } from './fastAlong'
import { getTerrainDirectionAtPoint } from './terrainDirection'
import type { LayoutConstraints } from './conceptualDevelopmentLayout'

const SQFT_PER_ACRE = 43560

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function sqMetersToSqFt(m2: number): number { return m2 * 10.7639 }
function sqFtToAcres(sqft: number): number { return sqft / SQFT_PER_ACRE }
function round3(n: number): number { return Math.round(n * 1000) / 1000 }
function orientationDifferenceDeg(a: number, b: number): number { return Math.abs((((a - b) % 360) + 540) % 360 - 180) }

const LOCAL_GRAMMAR_INFLUENCE_PCT = 0.05

// Batch 1: exact target/buildable intersection cache. The context object is the
// immutable precomputed container for a single authoritative transaction, and the
// target object is the immutable target being evaluated. The result depends only
// on those two inputs, so object identity is a safe cache key.
const targetBuildableCache = new WeakMap<any, Map<any, any>>()
let targetBuildableCacheHits = 0
let localStreetCandidateCalls = 0

function computeLocalGrammarPenalty(
  centerline: GeoJSON.Feature<GeoJSON.LineString>,
  mode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK',
  terrainSuitability: import('../types/terrain').TerrainSuitabilityResult | null | undefined
): number {
  if (mode === 'DIRECT_FALLBACK' || !terrainSuitability) return 0
  const coords = centerline.geometry.coordinates as number[][]
  if (coords.length < 2) return 0
  const brg = fastBearing(coords[0], coords[1]) ?? 0
  const origin = coords[0]
  const dir = getTerrainDirectionAtPoint(origin, terrainSuitability)
  const desiredBearing = mode === 'CONTOUR_FOLLOWING' ? dir.contourBearing : dir.fallLineBearing
  if (desiredBearing == null || dir.confidence === 'UNAVAILABLE') return 0
  const diff = orientationDifferenceDeg(brg, desiredBearing)
  return (diff / 90) * LOCAL_GRAMMAR_INFLUENCE_PCT
}

function toPolygonFeatures(geometry: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!geometry || !geometry.geometry) return []
  const g = geometry.geometry
  if (g.type === 'Polygon') {
    return [{ type: 'Feature', properties: { ...(geometry.properties || {}), source: 'flatten' }, geometry: g }]
  }
  if (g.type === 'MultiPolygon') {
    return g.coordinates.map((polygon, i) => ({
      type: 'Feature' as const,
      properties: { ...(geometry.properties || {}), source: 'flatten', part: i },
      geometry: { type: 'Polygon' as const, coordinates: polygon }
    }))
  }
  return []
}

function areaSqFt(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

function turfIntersect(a: any, b: any): any {
  if (!a || !b) return null
  return safeTurfOp(() => (turf as any).intersect(turf.featureCollection([a, b])) as any, null)
}

function pointInFeature(coords: number[], feature: any): boolean {
  if (!feature || !feature.geometry) return false
  return safeTurfOp(() => (turf as any).booleanPointInPolygon((turf as any).point(coords), feature), false)
}

function polygonFeaturesForConstraints(feature: any): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!feature || !feature.geometry) return []
  return toPolygonFeatures(feature)
}

function centroidInTarget(lot: ConceptualLot, targetGeometry: any): boolean {
  const centroid = safeTurfOp(() => (turf as any).centroid(lot.geometry), null)
  return centroid && pointInFeature(centroid.geometry.coordinates, targetGeometry)
}

export interface FastLocalStreetStageTimings {
  baselineLotIntersectionMs: number
  preservedConstraintMs: number
  computeAvailableGeometryMs: number
  generateSingleFamilyLotsMs: number
  frontageExtractionMs: number
  metricAssemblyMs: number
  totalMs: number
  baselineLotIntersectionAttempts: number
  baselineLotIntersectionActualIntersects: number
  targetBuildableCacheHits?: number
  targetBuildableCacheMisses?: number
  localStreetCandidateCalls?: number
}

export interface CandidateLayoutSnapshot {
  mcpi: string
  lotCount: number
  buildingEnvelopeCount: number
  drawableResidentialCapacity: number
  layoutAreaAcres: number
  layoutAreaSqFt: number
  unusedProgrammableAreaAcres: number
  lotCells: ConceptualLot[]
  buildingEnvelopes: ConceptualBuildingEnvelope[]
  conceptualLotAudit: ConceptualLotAuditItem[]
  useAssignments: DevelopmentUseAssignment[]
  lotFrontageGenerationAudit: LotFrontageGenerationAudit
  warnings: string[]
  stageTimings: FastLocalStreetStageTimings
  localGrammarPenalty?: number
}


export interface FastLocalStreetPrecomputedContext {
  candidateOpenAreaGeometry: any
  baselineLotBboxes: { lot: ConceptualLot; bbox: number[] }[]
  baselineUnusedBuildable: any
  conflictGroups: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] }
  preferredLotSize: number
  baselineTotalFrontageFt: number
  baselineUsableFrontageFt: number
  hardConstraintPolygons: GeoJSON.Feature<GeoJSON.Polygon>[]
  allBaselineLotGeometries: GeoJSON.Feature<GeoJSON.Geometry>[]
  primaryTerrainMode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  terrainSuitability: import('../types/terrain').TerrainSuitabilityResult | null | undefined
}

export interface FastLocalStreetEvaluationContext {
  baseline: ConceptualDevelopmentLayoutResult
  programResult: ConceptualDevelopmentProgramResult
  projectParameters?: ProjectParameters | null
  target: any
  mcpi: string
  precomputed: FastLocalStreetPrecomputedContext
  candidate: ConceptualLocalStreet
  localId: string
  rankOnly?: boolean
  signal?: AbortSignal
}

function materialIntersectionArea(lot: ConceptualLot, row: any, toleranceSqFt: number = 1.0): number {
  const inter = turfIntersect(lot.geometry, row)
  if (!inter) return 0
  const a = areaSqFt(inter)
  return a > toleranceSqFt ? a : 0
}

function bboxesOverlap(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function buildLocalRoadRow(candidate: ConceptualLocalStreet, localId: string): { roadId: string; roadType: 'local'; row: any; centerline: any } {
  return {
    roadId: `LOCAL-${localId}`,
    roadType: 'local',
    row: candidate.rightOfWayGeometry,
    centerline: candidate.centerlineGeometry
  }
}

export function precomputeFastLocalStreetContext(
  baseline: ConceptualDevelopmentLayoutResult,
  constraints: LayoutConstraints,
  programResult: ConceptualDevelopmentProgramResult,
  projectParameters?: ProjectParameters | null
): FastLocalStreetPrecomputedContext {
  targetBuildableCacheHits = 0
  localStreetCandidateCalls = 0
  const hard: GeoJSON.Feature<GeoJSON.Polygon>[] = []
  if (constraints.buildingUnionGeometry) hard.push(...polygonFeaturesForConstraints(constraints.buildingUnionGeometry))
  if (constraints.hydrologyGeometry) hard.push(...polygonFeaturesForConstraints(constraints.hydrologyGeometry))
  if (constraints.pavementGeometry) hard.push(...polygonFeaturesForConstraints(constraints.pavementGeometry))

  const primary = constraints.conceptualRoadResult
  if (primary?.proposedRightOfWay?.geometry) {
    hard.push(...polygonFeaturesForConstraints(primary.proposedRightOfWay))
  }
  for (const r of constraints.secondaryRoadNetworkResult?.roads || []) {
    if (r.rightOfWayGeometry?.geometry) {
      hard.push(...polygonFeaturesForConstraints(r.rightOfWayGeometry))
    }
  }

  const lotGeometries: any[] = baseline.lotCells.map(l => l.geometry)
  const candidateOpenAreaGeometry = constraints.candidateOpenAreaGeometry ?? constraints.parcelBoundary

  const baselineUnusedBuildable = candidateOpenAreaGeometry
    ? computeAvailableGeometry(candidateOpenAreaGeometry as any, null, [...hard, ...lotGeometries])
    : null

  const baselineLotBboxes = baseline.lotCells.map(lot => ({
    lot,
    bbox: safeTurfOp(() => (turf as any).bbox(lot.geometry), [0, 0, 0, 0])
  }))

  const conflictGroups = {
    rows: [] as any[],
    buildings: polygonFeaturesForConstraints(constraints.buildingUnionGeometry),
    hydrology: polygonFeaturesForConstraints(constraints.hydrologyGeometry),
    pavement: polygonFeaturesForConstraints(constraints.pavementGeometry)
  }

  function precomputeConstraintBboxes(features: any[]) {
    for (const f of features) {
      (f as any).bbox = safeTurfOp(() => (turf as any).bbox(f), null)
    }
  }
  precomputeConstraintBboxes(conflictGroups.buildings)
  precomputeConstraintBboxes(conflictGroups.hydrology)
  precomputeConstraintBboxes(conflictGroups.pavement)

  const preferredLotSize = programResult.preferredLotSize ?? projectParameters?.zoningAndLots?.minLotArea ?? 6000

  return {
    candidateOpenAreaGeometry,
    baselineLotBboxes,
    baselineUnusedBuildable,
    conflictGroups,
    preferredLotSize,
    baselineTotalFrontageFt: baseline.lotFrontageGenerationAudit.totalLotFrontageFt,
    baselineUsableFrontageFt: baseline.lotFrontageGenerationAudit.totalUsableFrontageFt,
    hardConstraintPolygons: hard,
    allBaselineLotGeometries: lotGeometries,
    primaryTerrainMode: primary?.terrainRoadMode ?? 'DIRECT_FALLBACK',
    terrainSuitability: (constraints as any).terrainSuitability
  }
}

export async function evaluateLocalStreetCandidate(ctx: FastLocalStreetEvaluationContext): Promise<CandidateLayoutSnapshot> {
  const t0 = performance.now()
  generationPerformance.start('localStreetFast')
  if (VERBOSE_GIS_DIAGNOSTICS) turfCounter.startStage('fastLocalStreetEvaluator')

  const stageTimings: FastLocalStreetStageTimings = {
    baselineLotIntersectionMs: 0,
    preservedConstraintMs: 0,
    computeAvailableGeometryMs: 0,
    generateSingleFamilyLotsMs: 0,
    frontageExtractionMs: 0,
    metricAssemblyMs: 0,
    totalMs: 0,
    baselineLotIntersectionAttempts: 0,
    baselineLotIntersectionActualIntersects: 0
  }

  const { baseline, programResult, target, mcpi, precomputed, candidate, localId } = ctx
  const warnings: string[] = []

  // 1. Baseline-lot classification with bbox pre-filter.
  const s1 = performance.now()
  const removedBaselineLots: ConceptualLot[] = []
  const removedIds = new Set<string>()
  let removedBaselineLotAreaSqFt = 0
  let removedBaselineFrontageFt = 0
  const candidateBbox = safeTurfOp(() => (turf as any).bbox(candidate.rightOfWayGeometry), [0, 0, 0, 0])

  let bboxIndex = 0
  for (const { lot, bbox } of precomputed.baselineLotBboxes) {
    if (ctx.signal?.aborted) throw new Error('Generation aborted')
    if (bboxIndex % 50 === 0) await yieldIfNeeded(ctx.signal)
    bboxIndex++
    stageTimings.baselineLotIntersectionAttempts++
    if (!bboxesOverlap(bbox, candidateBbox)) continue
    const interArea = materialIntersectionArea(lot, candidate.rightOfWayGeometry)
    if (interArea > 0) {
      removedBaselineLots.push(lot)
      removedIds.add(lot.id)
      removedBaselineLotAreaSqFt += lot.areaSqFt
      removedBaselineFrontageFt += lot.frontageFt
      stageTimings.baselineLotIntersectionActualIntersects++
    }
  }
  const preservedBaselineLots = baseline.lotCells.filter(l => !removedIds.has(l.id))
  stageTimings.baselineLotIntersectionMs = performance.now() - s1

  // 2. Preserved-lot constraints: no polygon union; buildable precomputed to exclude baseline lots.
  const s2 = performance.now()
  stageTimings.preservedConstraintMs = performance.now() - s2

  // 3. Candidate-specific buildable: precomputed unused buildable intersected with target and minus local ROW.
  const s3 = performance.now()
  let buildable: any = null
  if (precomputed.baselineUnusedBuildable) {
    localStreetCandidateCalls++
    let subCache = targetBuildableCache.get(precomputed)
    if (!subCache) {
      subCache = new Map()
      targetBuildableCache.set(precomputed, subCache)
    }
    let targetBuildable: any
    if (subCache.has(target)) {
      targetBuildableCacheHits++
      targetBuildable = subCache.get(target)
    } else {
      targetBuildable = safeTurfOp(() =>
        (turf as any).intersect(turf.featureCollection([precomputed.baselineUnusedBuildable, target.geometry])),
        null
      )
      subCache.set(target, targetBuildable)
    }
    const localRowPolygons = polygonFeaturesForConstraints(candidate.rightOfWayGeometry)
    buildable = targetBuildable
      ? computeAvailableGeometry(targetBuildable, null, localRowPolygons)
      : computeAvailableGeometry(precomputed.baselineUnusedBuildable, null, localRowPolygons)
  }
  stageTimings.computeAvailableGeometryMs = performance.now() - s3

  // Fallback if no buildable canvas could be computed.
  if (!buildable || areaSqFt(buildable) < 1000) {
    warnings.push('No usable buildable geometry remained for fast local-street candidate.')
    const totalMs = performance.now() - t0
    stageTimings.metricAssemblyMs = totalMs - stageTimings.baselineLotIntersectionMs - stageTimings.preservedConstraintMs - stageTimings.computeAvailableGeometryMs
    stageTimings.totalMs = totalMs
    if (VERBOSE_GIS_DIAGNOSTICS) turfCounter.endStage()
    generationPerformance.finish('localStreetFast')
    return {
      mcpi,
      lotCount: baseline.lotCount,
      buildingEnvelopeCount: baseline.buildingEnvelopeCount,
      drawableResidentialCapacity: baseline.drawableResidentialCapacity,
      layoutAreaAcres: baseline.layoutAreaAcres,
      layoutAreaSqFt: baseline.layoutAreaSqFt,
      unusedProgrammableAreaAcres: baseline.unusedProgrammableAreaAcres,
      lotCells: baseline.lotCells,
      buildingEnvelopes: baseline.buildingEnvelopes,
      conceptualLotAudit: baseline.conceptualLotAudit,
      useAssignments: baseline.useAssignments,
      lotFrontageGenerationAudit: baseline.lotFrontageGenerationAudit,
      warnings,
      stageTimings
    }
  }

  // 4. Synthesize a conceptual development zone from the target for the lot generator.
  const zone: ConceptualDevelopmentZone = {
    id: target.sourceZoneId ?? target.id ?? `TARGET-${localId}`,
    sourceBlockId: target.sourceBlockId ?? target.id ?? '',
    geometry: buildable,
    areaSqFt: areaSqFt(target.geometry),
    areaAcres: round3(sqFtToAcres(areaSqFt(target.geometry))),
    perimeterFt: 0,
    compactness: 0,
    dominantDimensionFt: 0,
    shapeProxy: 'irregular',
    programStatus: 'PROGRAMMABLE',
    roadRelationship: (target.sourceRoadRelationship ?? 'NEAR_NETWORK') as any,
    roadFrontageFt: 0,
    distanceToPrimaryRoadFt: null,
    distanceToSecondaryRoadFt: null,
    distanceToNearestRoadFt: null,
    actualRoadServedAreaAcres: null,
    roadServedFraction: null,
    terrainAssessment: (target.terrainAssessment ?? 'INSUFFICIENT_DATA') as any,
    opportunityClass: target.classification ?? 'MODERATE',
    constraintProximities: {
      nearestBuildingFt: null,
      nearestHydrologyFt: null,
      nearestPavementFt: null
    },
    programCompatibilities: [],
    compatibilityByUse: target.compatibilityByUse ?? { 'single-family': 'MODERATE' },
    bestCompatibleUse: 'single-family',
    bestCompatibility: 'MODERATE',
    capacityStatus: 'ROAD_SUPPORTED',
    reasons: []
  }

  // 5. Generate single-family lots using ONLY the candidate local road row.
  const s4 = performance.now()
  const localRoadRow = buildLocalRoadRow(candidate, localId)
  const roadRows = [localRoadRow]
  const conflictGroups = {
    rows: [candidate.rightOfWayGeometry],
    buildings: precomputed.conflictGroups.buildings,
    hydrology: precomputed.conflictGroups.hydrology,
    pavement: precomputed.conflictGroups.pavement
  }

  if (VERBOSE_GIS_DIAGNOSTICS) turfCounter.setCaller('generateSingleFamilyLots')
  const localResult = await generateSingleFamilyLots(
    zone,
    buildable,
    roadRows,
    conflictGroups,
    precomputed.preferredLotSize,
    baseline.lotCells.length,
    mcpi,
    ctx.rankOnly !== false,
    ctx.signal
  )
  if (VERBOSE_GIS_DIAGNOSTICS) turfCounter.clearCaller()
  stageTimings.generateSingleFamilyLotsMs = performance.now() - s4
  stageTimings.frontageExtractionMs = localResult.frontageExtractionMs

  const newLocalLots = localResult.lots
  const localLotAudits = localResult.lotAudit
  const newLocalEnvelopes = localResult.envelopes

  // 6. Metrics assembly.
  const s5 = performance.now()
  const newLocalFrontageFt = newLocalLots.reduce((s, l) => s + l.frontageFt, 0)
  const newLocalLotAreaSqFt = newLocalLots.reduce((s, l) => s + l.areaSqFt, 0)

  let newLotsInPreviouslyUnusedLand: ConceptualLot[] = []
  let newlyUsedPreviouslyUnusedAcres = 0
  if (!ctx.rankOnly) {
    newLotsInPreviouslyUnusedLand = newLocalLots.filter(l => centroidInTarget(l, target.geometry))
    newlyUsedPreviouslyUnusedAcres = newLotsInPreviouslyUnusedLand.reduce((s, l) => s + l.areaAcres, 0)
  }

  const candidateLotCount = baseline.lotCount - removedBaselineLots.length + newLocalLots.length
  const candidateDrawableResidentialCapacity = baseline.drawableResidentialCapacity - removedBaselineLots.length + newLocalLots.length
  const candidateLayoutAreaSqFt = baseline.layoutAreaSqFt - removedBaselineLotAreaSqFt + newLocalLotAreaSqFt
  const candidateLayoutAreaAcres = round3(sqFtToAcres(candidateLayoutAreaSqFt))
  const candidateUnusedProgrammableAreaAcres = round3(Math.max(0, programResult.programmableAreaAcres - candidateLayoutAreaAcres))
  const newlyUsedProgrammableAcres = round3(sqFtToAcres(newLocalLotAreaSqFt - removedBaselineLotAreaSqFt))
  const newlyServedAcres = round3(newlyUsedPreviouslyUnusedAcres)
  const newTrueFrontageFt = round3(Math.max(0, newLocalFrontageFt - removedBaselineFrontageFt))

  const conceptualLotAudit: ConceptualLotAuditItem[] = ctx.rankOnly ? [] : [...baseline.conceptualLotAudit, ...localLotAudits]
  const candidateTotalFrontageFt = round3(
    precomputed.baselineTotalFrontageFt - removedBaselineFrontageFt + newLocalFrontageFt
  )
  const candidateUsableFrontageFt = round3(
    precomputed.baselineUsableFrontageFt - removedBaselineFrontageFt + newLocalFrontageFt
  )
  const lotFrontageGenerationAudit: LotFrontageGenerationAudit = {
    ...localResult.audit,
    mcpi,
    totalLotFrontageFt: candidateTotalFrontageFt,
    totalUsableFrontageFt: candidateUsableFrontageFt
  }

  const targetZoneId = target.sourceZoneId ?? target.id
  const useAssignments = baseline.useAssignments.map(a =>
    a.zoneId === targetZoneId
      ? {
          ...a,
          generatedFeatureCount: newLocalLots.length,
          generatedAreaAcres: round3(sqFtToAcres(newLocalLotAreaSqFt))
        }
      : { ...a }
  )
  if (!useAssignments.some(a => a.zoneId === targetZoneId)) {
    useAssignments.push({
      zoneId: targetZoneId,
      assignedUse: 'single-family',
      compatibility: (target.compatibilityByUse?.['single-family'] ?? 'MODERATE') as any,
      roadRelationship: (target.sourceRoadRelationship ?? 'NEAR_NETWORK') as any,
      zoneAcres: round3(sqFtToAcres(areaSqFt(target.geometry))),
      generatedFeatureCount: newLocalLots.length,
      generatedAreaAcres: round3(sqFtToAcres(newLocalLotAreaSqFt)),
      terrain: (target.terrainAssessment ?? 'INSUFFICIENT_DATA') as any,
      reason: 'Fast local-street single-family lot generation.'
    })
  }

  const lotCells: ConceptualLot[] = [...preservedBaselineLots, ...newLocalLots]
  const buildingEnvelopes: ConceptualBuildingEnvelope[] = ctx.rankOnly
      ? []
      : [
          ...baseline.buildingEnvelopes.filter(e => !removedBaselineLots.some(l => l.id === e.parentLotId)),
          ...newLocalEnvelopes
        ]

  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[FastLocalStreetEvaluator]', {
      mcpi,
      localId,
      durationMs: round3(performance.now() - t0),
      baselineLotCount: baseline.lotCount,
      removedBaselineLotCount: removedBaselineLots.length,
      newLocalLotCount: newLocalLots.length,
      candidateLotCount,
      newTrueFrontageFt,
      newlyUsedProgrammableAcres,
      newlyServedAcres,
      stageTimings
    })
  }

  stageTimings.metricAssemblyMs = performance.now() - s5
  stageTimings.totalMs = performance.now() - t0
  if (VERBOSE_GIS_DIAGNOSTICS) turfCounter.endStage()
  generationPerformance.finish('localStreetFast')

  const localGrammarPenalty = computeLocalGrammarPenalty(
    ctx.candidate.centerlineGeometry,
    ctx.precomputed.primaryTerrainMode,
    ctx.precomputed.terrainSuitability
  )

  return {
    mcpi,
    lotCount: candidateLotCount,
    buildingEnvelopeCount: buildingEnvelopes.length,
    drawableResidentialCapacity: candidateDrawableResidentialCapacity,
    layoutAreaAcres: candidateLayoutAreaAcres,
    layoutAreaSqFt: round3(candidateLayoutAreaSqFt),
    unusedProgrammableAreaAcres: candidateUnusedProgrammableAreaAcres,
    lotCells,
    buildingEnvelopes,
    conceptualLotAudit,
    useAssignments: ctx.rankOnly ? baseline.useAssignments : useAssignments,
    lotFrontageGenerationAudit,
    warnings,
    stageTimings,
    localGrammarPenalty
  }
}

export function getLocalStreetCacheStats(): { candidateCalls: number; targetBuildableCacheHits: number } {
  return { candidateCalls: localStreetCandidateCalls, targetBuildableCacheHits: targetBuildableCacheHits }
}
