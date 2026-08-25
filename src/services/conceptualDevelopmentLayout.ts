import { turfc as turf, VERBOSE_GIS_DIAGNOSTICS, recomputeCounter, generationPerformance, turfCounter } from '../lib/perf'
import { fastAlong, fastRhumbDestination, fastBearing } from './fastAlong'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type {
  ProjectParameters,
  ConceptualRoadSkeletonResult,
  SecondaryRoadNetworkResult,
  DevelopmentOpportunityBlockResult
} from '../types/parameters'
import type { TerrainData, TerrainSuitabilityResult, TerrainPlacementEvaluation } from '../types/terrain'
import { computeTerrainPlacementEvaluation } from './terrainSuitabilityQuery'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import type {
  ConceptualDevelopmentProgramResult,
  ConceptualDevelopmentZone,
  ProgramCompatibilityLevel,
  DevelopmentZoneRoadRelationship
} from './conceptualDevelopmentProgram'

const SQFT_PER_ACRE = 43560

function sqMetersToSqFt(m2: number): number { return m2 * 10.7639 }
function sqFtToAcres(sqft: number): number { return sqft / SQFT_PER_ACRE }

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function isTerrainDataAvailable(terrainData: TerrainData | null | undefined): boolean {
  if (!terrainData) return false
  if ((terrainData as any).coveragePercent === 0 || (terrainData as any).overall === 'INSUFFICIENT_DATA' || (terrainData as any).confidence === 'UNAVAILABLE') return false
  return true
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function turfDifference(a: any, b: any): any {
  if (!a || !b) return null
  return safeTurfOp(() => (turf as any).difference(turf.featureCollection([a, b])) as any, null)
}

function turfIntersect(a: any, b: any): any {
  if (!a || !b) return null
  return safeTurfOp(() => (turf as any).intersect(turf.featureCollection([a, b])) as any, null)
}

function turfLineSliceAlong(line: any, start: number, stop: number, options?: any): any {
  if (!line || !line.geometry) return null
  try {
    const existing = (turf as any).lineSliceAlong
    if (existing) {
      return existing(line, start, stop, options)
    }
  } catch { /* fall through */ }
  const startPt = safeTurfOp(() => (turf as any).along(line, start, options), null)
  const endPt = safeTurfOp(() => (turf as any).along(line, stop, options), null)
  if (!startPt || !endPt) return null
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [startPt.geometry.coordinates, endPt.geometry.coordinates] }
  }
}

function normalizeBearing(b: number): number {
  let v = b % 360
  if (v < 0) v += 360
  return v
}

function areaSqFt(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

function outsideAreaSqFt(inner: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined, outer: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!inner || !inner.geometry || !outer || !outer.geometry) return 0
  const diff = turfDifference(inner, outer)
  return diff ? areaSqFt(diff) : 0
}

function overlapAreaSqFt(a: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined, b: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!a || !a.geometry || !b || !b.geometry) return 0
  const inter = turfIntersect(a, b)
  return inter ? areaSqFt(inter) : 0
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

function largestPolygonComponent(geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (!geometry) return null
  const parts = toPolygonFeatures(geometry)
  if (parts.length === 0) return null
  return parts.reduce((best, p) => (areaSqFt(p) > areaSqFt(best) ? p : best))
}

function componentCountForGeometry(geometry: GeoJSON.Geometry | null): number {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') return 1
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.length
  return 0
}

function ringCountForGeometry(geometry: GeoJSON.Geometry | null): number {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') return geometry.coordinates.length
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((s, p) => s + p.length, 0)
  return 0
}

function geometryTruth(geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null) {
  const parts = geometry ? toPolygonFeatures(geometry) : []
  const isMulti = (geometry?.geometry?.type ?? 'None') === 'MultiPolygon'
  return {
    geometryType: geometry?.geometry?.type ?? 'None',
    polygonComponentCount: parts.length,
    coordinateRingCount: ringCountForGeometry(geometry?.geometry ?? null),
    areaSqFt: geometry ? round3(areaSqFt(geometry)) : 0,
    bbox: safeTurfOp(() => (turf as any).bbox(geometry), null) as number[] | null,
    ...(isMulti ? { componentCount: parts.length, componentAreasSqFt: parts.map(p => round3(areaSqFt(p))) } : {})
  }
}

function combineConstraints(...features: (GeoJSON.Feature<GeoJSON.Geometry> | null | undefined)[]): GeoJSON.Feature<GeoJSON.Polygon>[] {
  const out: GeoJSON.Feature<GeoJSON.Polygon>[] = []
  for (const f of features) {
    if (!f) continue
    out.push(...toPolygonFeatures(f))
  }
  return out
}

export function computeAvailableGeometry(
  zoneGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  candidateOpenAreaGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  constraints: GeoJSON.Feature<GeoJSON.Polygon>[]
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  let current: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = zoneGeometry

  if (candidateOpenAreaGeometry) {
    const clipped = safeTurfOp(() => turfIntersect(current as any, candidateOpenAreaGeometry as any) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, null)
    if (clipped) current = clipped
  }

  for (const c of constraints) {
    if (!c.geometry) continue
    const next: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = safeTurfOp(() => turfDifference(current, c) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, current)
    if (next && areaSqFt(next) > 0) {
      current = next
    } else if (!next) {
      return null
    }
  }

  return current
}

function nearestRoadBearing(
  zone: ConceptualDevelopmentZone,
  roadLines: GeoJSON.Feature<GeoJSON.LineString>[]
): { bearing: number; distanceFt: number } {
  const centroid = safeTurfOp(() => turf.centroid(zone.geometry), null)
  if (!centroid) return { bearing: 0, distanceFt: Infinity }

  let bestBearing = 0
  let bestDist = Infinity

  for (const line of roadLines) {
    if (!line.geometry || !line.geometry.coordinates || line.geometry.coordinates.length < 2) continue
    try {
      const nearest = turf.nearestPointOnLine(line, centroid, { units: 'feet' })
      const dist = nearest.properties.dist ?? Infinity
      const idx = (nearest.properties.index ?? 0) as number
      const coords = line.geometry.coordinates
      const a = coords[Math.max(0, Math.min(idx, coords.length - 1))]
      const b = coords[Math.max(0, Math.min(idx + 1, coords.length - 1))]
      const brg = fastBearing(a, b) ?? 0
      if (dist < bestDist) {
        bestDist = dist
        bestBearing = brg
      }
    } catch {
      continue
    }
  }

  return { bearing: bestBearing, distanceFt: bestDist }
}

function orientedRectangle(
  center: GeoJSON.Feature<GeoJSON.Point>,
  widthFt: number,
  depthFt: number,
  bearing: number
): GeoJSON.Feature<GeoJSON.Polygon> {
  const halfW = widthFt / 2
  const halfD = depthFt / 2

  const front = fastRhumbDestination(center, halfD, 'feet', bearing) || center
  const back = fastRhumbDestination(center, halfD, 'feet', normalizeBearing(bearing + 180)) || center

  const fl = fastRhumbDestination(front, halfW, 'feet', normalizeBearing(bearing - 90)) || front
  const fr = fastRhumbDestination(front, halfW, 'feet', normalizeBearing(bearing + 90)) || front
  const br = fastRhumbDestination(back, halfW, 'feet', normalizeBearing(bearing + 90)) || back
  const bl = fastRhumbDestination(back, halfW, 'feet', normalizeBearing(bearing - 90)) || back

  const coords = [
    fl.geometry.coordinates,
    fr.geometry.coordinates,
    br.geometry.coordinates,
    bl.geometry.coordinates,
    fl.geometry.coordinates
  ]

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] }
  }
}

function shapeQuality(feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): { maxSideFt: number; minSideFt: number; aspect: number } {
  const bbox = safeTurfOp(() => turf.bbox(feature) as [number, number, number, number], [0, 0, 0, 0])
  const [minX, minY, maxX, maxY] = bbox
  const w = safeTurfOp(() => turf.distance([minX, minY], [maxX, minY], { units: 'feet' }), 1)
  const h = safeTurfOp(() => turf.distance([minX, minY], [minX, maxY], { units: 'feet' }), 1)
  const maxSide = Math.max(w, h)
  const minSide = Math.max(Math.min(w, h), 0.1)
  return { maxSideFt: maxSide, minSideFt: minSide, aspect: maxSide / minSide }
}

export interface ConceptualLot {
  id: string
  useType: string
  zoneId: string
  geometry: GeoJSON.Feature<GeoJSON.Polygon>
  areaSqFt: number
  areaAcres: number
  targetLotAreaSqFt: number
  lotWidthFt: number
  lotDepthFt: number
  roadBearing: number
  roadRelationship: DevelopmentZoneRoadRelationship
  terrain: string
  compatibility: ProgramCompatibilityLevel
  frontageFt: number
  depthFt: number
  frontageRoadId: string
  frontageClassification: 'DIRECT_ROW_FRONTAGE' | 'VALID_ROW_CONNECTOR' | 'PROXIMITY_ONLY' | 'NO_ACCESS'
  frontageToRowDistanceFt: number
  connectorLengthFt: number
  quality: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'REJECT'
  terrainPlacement?: TerrainPlacementEvaluation
}

export interface ConceptualBuildingEnvelope {
  id: string
  parentLotId: string
  geometry: GeoJSON.Feature<GeoJSON.Polygon>
  areaSqFt: number
  areaAcres: number
  terrainPlacement?: TerrainPlacementEvaluation
}

export interface ConceptualDevelopmentPad {
  id: string
  useType: string
  zoneId: string
  geometry: GeoJSON.Feature<GeoJSON.Polygon>
  areaSqFt: number
  areaAcres: number
  estimatedUnits: number
  roadBearing: number
  roadRelationship: DevelopmentZoneRoadRelationship
  terrain: string
  compatibility: ProgramCompatibilityLevel
  terrainPlacement?: TerrainPlacementEvaluation
}

export interface DevelopmentUseAssignment {
  zoneId: string
  assignedUse: string | null
  compatibility: ProgramCompatibilityLevel
  roadRelationship: DevelopmentZoneRoadRelationship
  zoneAcres: number
  generatedFeatureCount: number
  generatedAreaAcres: number
  terrain: string
  reason: string
}

export interface LayoutAudit {
  overlaps: number
  outsideZoneSqFt: number
  rowConflictSqFt: number
  buildingConflictSqFt: number
  hydrologyConflictSqFt: number
  pavementConflictSqFt: number
}

export interface SingleFamilyPlacementAudit {
  mcpi: string
  alternativeId: string
  selectedDevelopmentTypes: string[]
  targetUnitCount: number | null
  assignedSingleFamilyZoneCount: number
  eligibleZoneCount: number
  attemptedLotCount: number
  acceptedLotCount: number
  rejectedLotCount: number
  generatedSingleFamilyHomes: number
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  rejectionReasons: Record<string, number>
  capacityRespected: boolean
  allLotsInsideParcel: boolean
  allLotsInsideCandidateArea: boolean
  allLotsInsideAssignedZones: boolean
  lotOverlapCount: number
  buildingOverlapCount: number
  allBuildingsInsideLots: boolean
  allBuildingsInsideCandidateArea: boolean
  terrainQueryCount: number
  terrainQueryMs: number
  terrainRejectedCount: number
  preferredAcceptedCount: number
  moderateAcceptedCount: number
  challengingAcceptedCount: number
  insufficientAcceptedCount: number
  avoidOverlapRejectedCount: number
  meanTerrainPlacementScore: number | null
  maxAcceptedAvoidPercent: number
}

export interface SingleFamilyGenerationResult {
  mcpi: string
  status: 'generated' | 'empty' | 'skipped'
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  targetUnitCount: number | null
  lotCount: number
  homeCount: number
  acceptedLotCount: number
  rejectedLotCount: number
  attemptedLotCount: number
  lots: ConceptualLot[]
  envelopes: ConceptualBuildingEnvelope[]
  placementAudit: SingleFamilyPlacementAudit
}

export interface ApartmentCommercialPlacementAudit {
  mcpi: string
  alternativeId: string
  selectedDevelopmentTypes: string[]
  targetCapacity: number | null
  assignedZoneCount: number
  eligibleZoneCount: number
  attemptedPadCount: number
  acceptedPadCount: number
  generatedBuildingCount: number
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  rejectionReasons: Record<string, number>
  allPadsInsideParcel: boolean
  allPadsInsideCandidateArea: boolean
  allPadsInsideAssignedZones: boolean
  allBuildingsInsidePads: boolean
  allBuildingsInsideCandidateArea: boolean
  padOverlapCount: number
  buildingOverlapCount: number
  padAreaAcres: number
  footprintAreaAcres: number
  padPrimaryRowOverlapSqFt: number
  padSecondaryRowOverlapSqFt: number
  padLocalRowOverlapSqFt: number
  buildingPrimaryRowOverlapSqFt: number
  buildingSecondaryRowOverlapSqFt: number
  buildingLocalRowOverlapSqFt: number
  authoritativePadCount: number
  authoritativeBuildingCount: number
  renderedPadCount: number
  renderedBuildingCount: number
  padGeometryType: string
  padComponentCount: number
  buildingGeometryType: string
  buildingComponentCount: number
  renderedPadGeometryType: string
  renderedPadComponentCount: number
  auditedPadMatchesRenderedPad: boolean
  terrainQueryCount: number
  terrainQueryMs: number
  terrainRejectedCount: number
  padTerrainPlacement?: TerrainPlacementEvaluation
  buildingTerrainPlacement?: TerrainPlacementEvaluation
  meanTerrainPlacementScore: number | null
}

export interface ApartmentGenerationResult {
  mcpi: string
  status: 'generated' | 'empty' | 'skipped'
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  targetCapacity: number | null
  padCount: number
  buildingCount: number
  pads: ConceptualDevelopmentPad[]
  buildings: ConceptualBuildingEnvelope[]
  placementAudit: ApartmentCommercialPlacementAudit
}

export interface CommercialGenerationResult {
  mcpi: string
  status: 'generated' | 'empty' | 'skipped'
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  targetCapacity: number | null
  padCount: number
  buildingCount: number
  pads: ConceptualDevelopmentPad[]
  buildings: ConceptualBuildingEnvelope[]
  placementAudit: ApartmentCommercialPlacementAudit
}

export interface ConceptualDevelopmentLayoutResult {
  mcpi: string
  status: 'generated' | 'ACCESS_CONSTRAINED' | 'empty' | 'unavailable'
  selectedDevelopmentTypes: string[]
  assignedZoneCount: number
  lotCount: number
  buildingEnvelopeCount: number
  developmentPadCount: number
  drawableResidentialCapacity: number
  densityCapacityProxy: number | null
  lotCapacityProxy: number | null
  layoutAreaAcres: number
  layoutAreaSqFt: number
  unusedProgrammableAreaAcres: number
  utilizationPercent: number
  lotCells: ConceptualLot[]
  buildingEnvelopes: ConceptualBuildingEnvelope[]
  developmentPads: ConceptualDevelopmentPad[]
  useAssignments: DevelopmentUseAssignment[]
  audit: LayoutAudit
  lotFrontageGenerationAudit: LotFrontageGenerationAudit
  conceptualLotAudit: ConceptualLotAuditItem[]
  warnings: string[]
  townhomeGenerationResult?: import('./conceptualTownhomeGenerator').TownhomeGenerationResult | null
  townhomeInputs?: import('./conceptualTownhomeGenerator').TownhomeGeneratorInput | null
  singleFamilyGenerationResult?: SingleFamilyGenerationResult | null
  apartmentGenerationResult?: ApartmentGenerationResult | null
  commercialGenerationResult?: CommercialGenerationResult | null
}

interface LotQuality {
  rating: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'REJECT'
  reasons: string[]
}

export interface LotFrontageGenerationAudit {
  mcpi: string
  assignedSingleFamilyZoneCount: number
  eligibleRoadCount: number
  eligibleRowBoundaryFt: number
  candidateRowEdgeSegments: number
  buildableSideSegments: number
  directRowFrontageSegments: number
  validConnectorSegments: number
  proximityOnlySegments: number
  noAccessSegments: number
  rejectedRowSegments: number
  frontageCandidates: number
  frontageSegmentCount: number
  totalUsableFrontageFt: number
  totalLotFrontageFt: number
  lotCandidatesGenerated: number
  lotsAccepted: number
  lotsRejected: number
  lotsFromDirectRowFrontage: number
  lotsFromValidConnector: number
  lotsFromProximityOnly: number
  rejectionCountsByReason: Record<string, number>
  medianLotAreaSqFt: number | null
  medianFrontageFt: number | null
  medianDepthFt: number | null
  medianLotFrontageFt: number | null
  medianLotDepthFt: number | null
  medianFrontageToRowDistanceFt: number | null
  maxFrontageToRowDistanceFt: number | null
  medianConnectorLengthFt: number | null
  maxConnectorLengthFt: number | null
  unusedProgrammableAreaAcres: number
  terrainQueryCount: number
  terrainQueryMs: number
  terrainRejectedCount: number
  preferredAcceptedCount: number
  moderateAcceptedCount: number
  challengingAcceptedCount: number
  insufficientAcceptedCount: number
  avoidOverlapRejectedCount: number
  meanTerrainPlacementScore: number | null
  maxAcceptedAvoidPercent: number
}

export interface RowFrontageByRoadAudit {
  mcpi: string
  roadId: string
  roadNameOrId: string
  roadType: 'primary' | 'secondary' | 'existing' | 'local'
  rowBoundaryLengthFt: number
  usableFrontageSideAFt: number
  usableFrontageSideBFt: number
  lotCountSideA: number
  lotCountSideB: number
  rejectedFrontageFt: number
  dominantRejectionReason: string
}

export interface ConceptualLotAuditItem {
  lotId: string
  zoneId: string
  frontageRoadId: string
  frontageFt: number
  depthFt: number
  areaSqFt: number
  aspectRatio: number
  roadDistanceFt: number
  frontageToRowDistanceFt: number
  connectorLengthFt: number
  frontageClassification: 'DIRECT_ROW_FRONTAGE' | 'VALID_ROW_CONNECTOR' | 'PROXIMITY_ONLY' | 'NO_ACCESS'
  supportingRoadNameOrId: string
  quality: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'REJECT'
  hasBuildingEnvelope: boolean
  terrainPlacement?: TerrainPlacementEvaluation
  buildingTerrainPlacement?: TerrainPlacementEvaluation
  buildingEnvelopeRejected?: boolean
}

export interface LayoutConstraints {
  candidateOpenAreaGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  conceptualRoadResult?: ConceptualRoadSkeletonResult | null
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null
  localStreetNetworkResult?: LocalStreetNetworkResult | null
  buildingUnionGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  hydrologyGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  pavementGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  parcelBoundary?: GeoJSON.Feature<GeoJSON.Geometry> | null
  terrainData?: TerrainData | null
  terrainSuitability?: TerrainSuitabilityResult | null
}

const ROAD_RELATIONSHIP_ORDER: Record<DevelopmentZoneRoadRelationship, number> = {
  PRIMARY_FRONTAGE: 0,
  SECONDARY_FRONTAGE: 1,
  NEAR_NETWORK: 2,
  LATENT: 3
}

const USE_ALLOCATION_ORDER = ['commercial', 'multifamily', 'townhomes', 'single-family']

const MAX_USE_ZONES: Record<string, number> = {
  commercial: 1,
  multifamily: 1,
  townhomes: 1,
  'single-family': Number.MAX_SAFE_INTEGER
}

export function canonicalUseType(use: string | null | undefined): string {
  if (!use) return ''
  const u = use.toLowerCase()
  if (u.includes('single-family') || u.includes('single family')) return 'single-family'
  if (u.includes('townhome') || u.includes('townhouse')) return 'townhomes'
  if (u.includes('multi-family') || u.includes('multifamily') || u.includes('apartment')) return 'multifamily'
  if (u.includes('commercial') || u.includes('retail') || u.includes('office')) return 'commercial'
  return u
}

function canonicalizeUseRecord<T>(record: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    result[canonicalUseType(key)] = value
  }
  return result
}

function isCompatible(level: ProgramCompatibilityLevel | undefined): boolean {
  return !!level && level !== 'UNSUITABLE'
}

function rankCompatibility(level: ProgramCompatibilityLevel | undefined): number {
  const map: Record<ProgramCompatibilityLevel, number> = { STRONG: 3, MODERATE: 2, WEAK: 1, UNSUITABLE: 0 }
  return map[level ?? 'UNSUITABLE'] ?? 0
}

function collectRoadLines(
  conceptualRoadResult: ConceptualRoadSkeletonResult | null | undefined,
  secondaryRoadNetworkResult: SecondaryRoadNetworkResult | null | undefined
): GeoJSON.Feature<GeoJSON.LineString>[] {
  const lines: GeoJSON.Feature<GeoJSON.LineString>[] = []

  if (conceptualRoadResult?.proposedRoadCenterline?.geometry?.type === 'LineString') {
    lines.push(conceptualRoadResult.proposedRoadCenterline as GeoJSON.Feature<GeoJSON.LineString>)
  }

  for (const r of secondaryRoadNetworkResult?.roads || []) {
    if (r?.centerlineGeometry?.geometry?.type === 'LineString') {
      lines.push(r.centerlineGeometry as GeoJSON.Feature<GeoJSON.LineString>)
    }
  }

  return lines
}

function assignUseToZones(
  zones: ConceptualDevelopmentZone[],
  selectedUses: string[],
  capacityStatus: ConceptualDevelopmentProgramResult['capacityStatus'],
  warnings: string[]
): Map<string, string | null> {
  const assignment = new Map<string, string | null>()
  if (capacityStatus === 'LATENT_ACCESS_CONSTRAINED' || capacityStatus === 'UNAVAILABLE') {
    for (const z of zones) assignment.set(z.id, null)
    return assignment
  }

  const eligible = zones
    .filter(z => z.programStatus === 'PROGRAMMABLE')
    .filter(z => z.roadRelationship !== 'LATENT')
    .sort((a, b) => ROAD_RELATIONSHIP_ORDER[a.roadRelationship] - ROAD_RELATIONSHIP_ORDER[b.roadRelationship])

  const used = new Set<string>()
  const orderedUses = USE_ALLOCATION_ORDER.filter(u => selectedUses.includes(u))

  for (let idx = 0; idx < orderedUses.length; idx++) {
    const use = orderedUses[idx]
    const max = use === 'single-family' ? Number.MAX_SAFE_INTEGER : (MAX_USE_ZONES[use] ?? 0)
    if (max <= 0) continue

    const candidates = eligible
      .filter(z => !used.has(z.id) && isCompatible(z.compatibilityByUse[use]))
      .sort((a, b) => {
        const roadDiff = ROAD_RELATIONSHIP_ORDER[a.roadRelationship] - ROAD_RELATIONSHIP_ORDER[b.roadRelationship]
        if (roadDiff !== 0) return roadDiff
        const compatDiff = rankCompatibility(b.compatibilityByUse[use]) - rankCompatibility(a.compatibilityByUse[use])
        if (compatDiff !== 0) return compatDiff
        return b.areaAcres - a.areaAcres
      })

    const unassignedCount = eligible.filter(z => !used.has(z.id)).length
    const isLast = idx === orderedUses.length - 1
    const reserve = isLast ? 0 : 1
    const chosenCount = isLast
      ? Math.max(0, unassignedCount - reserve)
      : Math.min(max, Math.max(0, unassignedCount - reserve))
    const chosen = candidates.slice(0, chosenCount)
    if (chosen.length === 0 && use !== 'single-family') {
      warnings.push(`No geometrically suitable conceptual ${use} zone identified.`)
    }

    for (const z of chosen) {
      used.add(z.id)
      assignment.set(z.id, use)
    }
  }

  for (const z of zones) {
    if (!assignment.has(z.id)) {
      assignment.set(z.id, null)
    }
  }

  return assignment
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function pointInFeature(p: number[], feature: any): boolean {
  if (!feature || !feature.geometry) return false
  try {
    return (turf as any).booleanPointInPolygon((turf as any).point(p), feature)
  } catch { return false }
}

function roadBearingAtPoint(line: any, pt: any): number {
  if (!line || !pt || !pt.properties) return 0
  const idx = pt.properties.index || 0
  const coords = line.geometry.coordinates
  const a = coords[Math.max(0, Math.min(idx, coords.length - 1))]
  const b = coords[Math.max(0, Math.min(idx + 1, coords.length - 1))]
  if (!a || !b) return 0
  return safeTurfOp(() => (turf as any).bearing(a, b), 0)
}

function lotCandidateQuality(
  area: number,
  frontage: number,
  depth: number,
  preferredLotSize: number
): LotQuality {
  const reasons: string[] = []
  const minAcceptArea = preferredLotSize * 0.35
  const goodAreaMin = preferredLotSize * 0.7
  const goodAreaMax = preferredLotSize * 1.4
  const maxAcceptArea = preferredLotSize * 2.0
  const aspect = Math.max(frontage, depth) / Math.max(0.1, Math.min(frontage, depth))
  if (area < 1000 || area > maxAcceptArea * 2 || frontage < 20 || depth < 20) {
    if (area < 1000) reasons.push('area too small')
    if (area > maxAcceptArea * 2) reasons.push('area too large')
    if (frontage < 20) reasons.push('frontage too narrow')
    if (depth < 20) reasons.push('depth too shallow')
    return { rating: 'REJECT', reasons }
  }
  if (area < minAcceptArea || area > maxAcceptArea || aspect > 5) {
    if (area < minAcceptArea) reasons.push('area below preferred tolerance')
    if (area > maxAcceptArea) reasons.push('area above preferred tolerance')
    if (aspect > 5) reasons.push('aspect too extreme')
    return { rating: 'POOR', reasons }
  }
  if (area >= goodAreaMin && area <= goodAreaMax && aspect <= 3 && frontage >= 35) {
    return { rating: 'GOOD', reasons: ['area, aspect, and frontage within conceptual preferred range'] }
  }
  if (aspect > 4) reasons.push('aspect somewhat elongated')
  return { rating: 'ACCEPTABLE', reasons: reasons.length ? reasons : ['meets conceptual lot acceptability thresholds'] }
}

function makeEnvelopeForLot(lot: any, lotId: string, terrainSuitability?: TerrainSuitabilityResult | null): ConceptualBuildingEnvelope | null {
  const scaled = safeTurfOp(() => (turf as any).transformScale(lot, 0.45, { origin: 'centroid' }) as GeoJSON.Feature<GeoJSON.Polygon>, null)
  if (!scaled) return null
  const envClip = safeTurfOp(() => turfIntersect(scaled, lot) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
  if (!envClip || areaSqFt(envClip) <= 300) return null
  const envelopePlacement = computeTerrainPlacementEvaluation(envClip, terrainSuitability)
  if (envelopePlacement.avoidRejection) return null
  return {
    id: `ENV-${lotId}`,
    parentLotId: lotId,
    geometry: envClip,
    areaSqFt: round3(areaSqFt(envClip)),
    areaAcres: round3(sqFtToAcres(areaSqFt(envClip))),
    terrainPlacement: envelopePlacement
  }
}

function allBoundaryRings(feature: any): GeoJSON.Feature<GeoJSON.MultiLineString> | null {
  if (!feature || !feature.geometry) return null
  const g = feature.geometry
  const polys: number[][][][] = []
  if (g.type === 'Polygon') {
    polys.push(g.coordinates as number[][][])
  } else if (g.type === 'MultiPolygon') {
    polys.push(...g.coordinates)
  } else {
    return null
  }
  const rings: number[][][] = []
  for (const poly of polys) {
    for (const ring of poly) rings.push(ring)
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: rings } }
}

function toLineStringArray(feature: any): any[] {
  if (!feature || !feature.geometry) return []
  if (feature.geometry.type === 'LineString') return [feature]
  if (feature.geometry.type === 'MultiLineString') {
    return feature.geometry.coordinates.map((c: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }))
  }
  return []
}

function nearestPointOnLineFeature(line: any, pt: number[]): { point: any; distFt: number } | null {
  const n = safeTurfOp(() => (turf as any).nearestPointOnLine(line, (turf as any).point(pt)), null)
  if (!n) return null
  const d = safeTurfOp(() => (turf as any).distance((turf as any).point(pt), n, { units: 'feet' }), Infinity)
  return { point: n, distFt: d }
}

function nearestPointOnMultiLine(multiLine: any, pt: number[]): { point: any; distFt: number } | null {
  const lines = toLineStringArray(multiLine)
  let bestPoint: any = null
  let bestDist = Infinity
  for (const line of lines) {
    const res = nearestPointOnLineFeature(line, pt)
    if (res && res.distFt < bestDist) {
      bestPoint = res.point
      bestDist = res.distFt
    }
  }
  return bestPoint ? { point: bestPoint, distFt: bestDist } : null
}

export interface FrontageRun extends GeoJSON.Feature<GeoJSON.LineString> {
  properties: {
    roadId: string
    roadType: 'primary' | 'secondary' | 'existing' | 'local'
    side: 'A' | 'B'
    centerline: any
    roadPolygon: any
    frontageClassification: 'DIRECT_ROW_FRONTAGE' | 'VALID_ROW_CONNECTOR' | 'PROXIMITY_ONLY' | 'NO_ACCESS'
    frontageToRowDistanceFt: number
    connectorLengthFt: number
    roadBearing: number
    inwardBearing: number
    roadBoundaryPoint: any
    rejectionReason?: string
  }
}

function pointInAnyFeature(pt: number[], features: any[]): boolean {
  for (const f of features) {
    if (!f || !f.geometry) continue
    if (safeTurfOp(() => (turf as any).booleanPointInPolygon((turf as any).point(pt), f), false)) return true
  }
  return false
}

function isBuildablePoint(pt: any, buildable: any, constraints: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] }): boolean {
  if (!buildable || !buildable.geometry) return false
  const coords = pt.geometry ? pt.geometry.coordinates : pt
  if (!pointInFeature(coords, buildable)) return false
  if (pointInAnyFeature(coords, constraints.rows)) return false
  if (pointInAnyFeature(coords, constraints.buildings)) return false
  if (pointInAnyFeature(coords, constraints.hydrology)) return false
  if (pointInAnyFeature(coords, constraints.pavement)) return false
  return true
}

function resolveBuildableSides(
  mid: any,
  roadCenterline: any,
  buildable: any,
  constraints: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] }
): { side: 'A' | 'B'; bearing: number }[] {
  const nearestOnCenterline = nearestPointOnMultiLine(roadCenterline, mid.geometry.coordinates)
  if (!nearestOnCenterline) return []
  const rb = roadBearingAtPoint(roadCenterline, nearestOnCenterline.point)
  const probeFt = 5
  const plus = fastRhumbDestination(mid, probeFt, 'feet', rb + 90)
  const minus = fastRhumbDestination(mid, probeFt, 'feet', rb - 90)
  if (!plus || !minus) return []
  const plusBuildable = isBuildablePoint(plus, buildable, constraints)
  const minusBuildable = isBuildablePoint(minus, buildable, constraints)
  const out: { side: 'A' | 'B'; bearing: number }[] = []
  if (plusBuildable) out.push({ side: 'A', bearing: normalizeBearing(rb + 90) })
  if (minusBuildable) out.push({ side: 'B', bearing: normalizeBearing(rb - 90) })
  return out
}

export function extractFrontageRuns(
  zone: ConceptualDevelopmentZone,
  buildable: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[],
  constraints: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] }
): FrontageRun[] {
  if (!zone || !zone.geometry || !buildable || !buildable.geometry || roadRows.length === 0) return []
  const runLengthFt = 80
  const intersectionSetbackFt = 20
  const minRunLen = 25
  const runs: FrontageRun[] = []

  for (const road of roadRows) {
    if (!road.centerline || !road.row) continue
    if (road.roadType === 'primary' && zone.roadRelationship !== 'PRIMARY_FRONTAGE') continue
    const roadBoundary = allBoundaryRings(road.row)
    if (!roadBoundary || !roadBoundary.geometry) continue
    const boundaryLines = toLineStringArray(roadBoundary)

    for (const ringLine of boundaryLines) {
      const ringLen = safeTurfOp(() => (turf as any).length(ringLine, { units: 'feet' }), 0)
      if (ringLen < minRunLen) continue
      const coords = ringLine.geometry.coordinates
      const closed = coords.length > 2 && safeTurfOp(() => (turf as any).distance(coords[0], coords[coords.length - 1], { units: 'feet' }), Infinity) < 1
      const chunkCount = Math.max(1, Math.floor(ringLen / runLengthFt))

      for (let i = 0; i < chunkCount; i++) {
        const start = i * (ringLen / chunkCount)
        const end = (i + 1) * (ringLen / chunkCount)
        if (!closed) {
          if (start < intersectionSetbackFt || end > ringLen - intersectionSetbackFt) continue
        }
        const slice = turfLineSliceAlong(ringLine, start, end, { units: 'feet' })
        if (!slice || !slice.geometry || slice.geometry.coordinates.length < 2) continue
        const runLen = safeTurfOp(() => (turf as any).length(slice, { units: 'feet' }), 0)
        if (runLen < minRunLen) continue

        const mid = safeTurfOp(() => (turf as any).along(slice, runLen / 2, { units: 'feet' }), null)
        if (!mid) continue

        const roadCenterlineNearest = nearestPointOnMultiLine(road.centerline, mid.geometry.coordinates)
        if (!roadCenterlineNearest) continue
        const roadBearing = roadBearingAtPoint(road.centerline, roadCenterlineNearest.point)
        const p0 = slice.geometry.coordinates[0]
        const p1 = slice.geometry.coordinates[slice.geometry.coordinates.length - 1]
        const localBearing = safeTurfOp(() => (turf as any).bearing(p0, p1), roadBearing)
        const bend = Math.abs(((localBearing - roadBearing + 540) % 360) - 180)
        if (bend > 45) continue

        const buildableSides = resolveBuildableSides(mid, road.centerline, buildable, constraints)
        if (buildableSides.length === 0) {
          runs.push({
            ...slice,
            properties: {
              ...slice.properties,
              roadId: road.roadId,
              roadType: road.roadType,
              side: 'A',
              centerline: road.centerline,
              roadPolygon: road.row,
              frontageClassification: 'NO_ACCESS',
              frontageToRowDistanceFt: 0,
              connectorLengthFt: 0,
              roadBearing,
              inwardBearing: 0,
              roadBoundaryPoint: mid,
              rejectionReason: 'no buildable side'
            } as any
          })
          continue
        }

        for (const { side, bearing } of buildableSides) {
          runs.push({
            ...slice,
            properties: {
              ...slice.properties,
              roadId: road.roadId,
              roadType: road.roadType,
              side,
              centerline: road.centerline,
              roadPolygon: road.row,
              frontageClassification: 'DIRECT_ROW_FRONTAGE',
              frontageToRowDistanceFt: 0,
              connectorLengthFt: 0,
              roadBearing,
              inwardBearing: bearing,
              roadBoundaryPoint: mid,
              rejectionReason: undefined
            } as any
          })
        }
      }
    }
  }

  return runs
}

function computePracticalDepth(mid: any, inward: number, targetGeometry: any, maxDepth: number): number {
  if (!targetGeometry || !targetGeometry.geometry) return 15
  let d = 5
  let last = 5
  while (d <= maxDepth) {
    const pt = fastRhumbDestination(mid, d, 'feet', inward)
    if (!pt) break
    if (pointInFeature(pt.geometry.coordinates, targetGeometry)) {
      last = d
    } else {
      break
    }
    d += 5
  }
  return Math.max(15, last)
}

export async function generateSingleFamilyLots(
  zone: ConceptualDevelopmentZone,
  available: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[],
  constraints: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] },
  preferredLotSize: number,
  lotIndexStart: number,
  mcpi: string,
  rankOnly = false,
  signal?: AbortSignal,
  terrainSuitability?: TerrainSuitabilityResult | null
): Promise<{ lots: ConceptualLot[]; envelopes: ConceptualBuildingEnvelope[]; nextIndex: number; remaining: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null; audit: LotFrontageGenerationAudit; lotAudit: ConceptualLotAuditItem[]; rowAudits: RowFrontageByRoadAudit[]; frontageExtractionMs: number }> {
  const lots: ConceptualLot[] = []
  const envelopes: ConceptualBuildingEnvelope[] = []
  const lotAudit: ConceptualLotAuditItem[] = []
  const lotRejectionDiagnostics: any[] = []
  let remaining: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = available

  const targetArea = Math.max(1000, preferredLotSize || 6000)
  const targetDepth = Math.max(40, Math.sqrt(targetArea / 1.4))
  const maxDepth = targetDepth * 1.5

  const feStart = performance.now()
  const frontageRuns = extractFrontageRuns(zone, available, roadRows, constraints)
  const frontageExtractionMs = performance.now() - feStart
  const eligibleRoadCount = roadRows.filter(r => !!r.centerline && !!r.row && (r.roadType !== 'primary' || zone.roadRelationship === 'PRIMARY_FRONTAGE')).length
  const eligibleRowBoundaryFt = roadRows
    .filter(r => !!r.centerline && !!r.row && (r.roadType !== 'primary' || zone.roadRelationship === 'PRIMARY_FRONTAGE'))
    .reduce((s, r) => {
      const rb = allBoundaryRings(r.row)
      return s + (rb ? toLineStringArray(rb).reduce((t, line) => t + safeTurfOp(() => (turf as any).length(line, { units: 'feet' }), 0), 0) : 0)
    }, 0)
  const frontageCandidates = frontageRuns.length
  const directRowFrontageSegments = frontageRuns.filter((f: any) => f.properties.frontageClassification === 'DIRECT_ROW_FRONTAGE').length
  const validConnectorSegments = frontageRuns.filter((f: any) => f.properties.frontageClassification === 'VALID_ROW_CONNECTOR').length
  const proximityOnlySegments = frontageRuns.filter((f: any) => f.properties.frontageClassification === 'PROXIMITY_ONLY').length
  const noAccessSegments = frontageRuns.filter((f: any) => f.properties.frontageClassification === 'NO_ACCESS').length
  const buildableSideSegments = directRowFrontageSegments + validConnectorSegments
  const rejectedRowSegments = noAccessSegments
  const totalUsableFrontageFt = frontageRuns
    .filter((f: any) => f.properties.frontageClassification === 'DIRECT_ROW_FRONTAGE' || f.properties.frontageClassification === 'VALID_ROW_CONNECTOR')
    .reduce((s, f) => s + safeTurfOp(() => (turf as any).length(f, { units: 'feet' }), 0), 0)
  const candidateRowEdgeSegments = frontageCandidates

  const roadAuditMap = new Map<string, { roadType: 'primary' | 'secondary' | 'existing' | 'local'; sideAFt: number; sideBFt: number; sideALots: number; sideBLots: number; rejectedFt: number; rejectedReasons: Record<string, number> }>()

  let lotIndex = lotIndexStart
  let candidates = 0
  let accepted = 0
  let rejected = 0
  const rejectionCounts: Record<string, number> = {}
  const reject = (reason: string) => {
    rejected++
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1
  }

  let lotsFromDirectRowFrontage = 0
  let lotsFromValidConnector = 0

  let lotsYieldCounter = 0
  let lotPlacement: TerrainPlacementEvaluation | undefined
  let terrainQueryCount = 0
  let terrainQueryMs = 0
  let terrainRejectedCount = 0
  let preferredAcceptedCount = 0
  let moderateAcceptedCount = 0
  let challengingAcceptedCount = 0
  let insufficientAcceptedCount = 0
  let avoidOverlapRejectedCount = 0
  const placementScores: number[] = []
  let maxAcceptedAvoidPercent = 0
  for (const run of frontageRuns) {
    if (signal?.aborted) throw new Error('Generation aborted')
    if (lotsYieldCounter % 10 === 0) await yieldIfNeeded(signal)
    lotsYieldCounter++
    const runLen = safeTurfOp(() => (turf as any).length(run, { units: 'feet' }), 0)
    const roadId = run.properties.roadId
    const side = run.properties.side
    if (!roadAuditMap.has(roadId)) {
      roadAuditMap.set(roadId, { roadType: run.properties.roadType, sideAFt: 0, sideBFt: 0, sideALots: 0, sideBLots: 0, rejectedFt: 0, rejectedReasons: {} })
    }
    const rdm = roadAuditMap.get(roadId)!

    if (run.properties.frontageClassification !== 'DIRECT_ROW_FRONTAGE' && run.properties.frontageClassification !== 'VALID_ROW_CONNECTOR') {
      rdm.rejectedFt += runLen
      rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] = (rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] || 0) + 1
      reject('INSUFFICIENT_FRONTAGE')
      continue
    }

    if (side === 'A') rdm.sideAFt += runLen
    else rdm.sideBFt += runLen

    if (runLen < 25) {
      rdm.rejectedFt += runLen
      rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] = (rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] || 0) + 1
      reject('INSUFFICIENT_FRONTAGE')
      continue
    }

    const practicalDepth = computePracticalDepth(run.properties.roadBoundaryPoint, run.properties.inwardBearing, remaining, maxDepth)
    const runTargetFrontage = clamp(targetArea / practicalDepth, 45, 130)
    const castDepth = Math.min(practicalDepth, maxDepth)

    const chunkCount = Math.max(1, Math.floor(runLen / runTargetFrontage))
    for (let i = 0; i < chunkCount; i++) {
      if (signal?.aborted) throw new Error('Generation aborted')
      if (lotsYieldCounter % 10 === 0) {
        await yieldIfNeeded(signal)
      }
      lotsYieldCounter++
      const start = i * (runLen / chunkCount)
      const end = (i + 1) * (runLen / chunkCount)
      const slice = turfLineSliceAlong(run, start, end, { units: 'feet' })
      if (!slice || !slice.geometry || slice.geometry.coordinates.length < 2) {
        rdm.rejectedFt += 0
        rdm.rejectedReasons['slice error'] = (rdm.rejectedReasons['slice error'] || 0) + 1
        reject('slice error')
        continue
      }
      const frontLen = safeTurfOp(() => (turf as any).length(slice, { units: 'feet' }), 0)
      if (frontLen < runTargetFrontage * 0.4) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] = (rdm.rejectedReasons['INSUFFICIENT_FRONTAGE'] || 0) + 1
        reject('INSUFFICIENT_FRONTAGE')
        continue
      }
      candidates++

      const p0 = slice.geometry.coordinates[0]
      const p1 = slice.geometry.coordinates[slice.geometry.coordinates.length - 1]
      const mid = fastAlong(slice, frontLen / 2, 'feet')
      if (!mid) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['slice error'] = (rdm.rejectedReasons['slice error'] || 0) + 1
        reject('slice error')
        continue
      }

      const roadBearing = run.properties.roadBearing
      const inward = run.properties.inwardBearing
      const rdmDepth = computePracticalDepth(mid, inward, remaining, castDepth)
      const lotDepthLimit = Math.min(castDepth, rdmDepth)

      const b0 = fastRhumbDestination(p0, lotDepthLimit, 'feet', inward)
      const b1 = fastRhumbDestination(p1, lotDepthLimit, 'feet', inward)
      if (!b0 || !b1) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['slice error'] = (rdm.rejectedReasons['slice error'] || 0) + 1
        reject('slice error')
        continue
      }

      const rect: any = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[p0, p1, b1.geometry.coordinates, b0.geometry.coordinates, p0]] }
      }
      const clip = turfIntersect(rect, remaining)
      if (!clip) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['no remaining geometry'] = (rdm.rejectedReasons['no remaining geometry'] || 0) + 1
        reject('no remaining geometry')
        continue
      }
      const polys = toPolygonFeatures(clip)
      if (polys.length === 0) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['no remaining geometry'] = (rdm.rejectedReasons['no remaining geometry'] || 0) + 1
        reject('no remaining geometry')
        continue
      }
      polys.sort((a, b) => areaSqFt(b) - areaSqFt(a))
      const lotPoly = polys[0]

      const area = areaSqFt(lotPoly)
      const frontage = frontLen
      const depth = area / Math.max(0.1, frontage)
      const quality = lotCandidateQuality(area, frontage, depth, targetArea)

      let rejectReason: string | null = null
      if (quality.rating === 'REJECT') {
        const raw = quality.reasons[0] || 'rejected by quality'
        if (raw.includes('area')) rejectReason = 'INSUFFICIENT_AREA'
        else if (raw.includes('frontage')) rejectReason = 'INSUFFICIENT_FRONTAGE'
        else if (raw.includes('depth')) rejectReason = 'INSUFFICIENT_DEPTH'
        else rejectReason = 'INSUFFICIENT_AREA'
      }

      if (!rejectReason) {
        const t0 = performance.now()
        lotPlacement = computeTerrainPlacementEvaluation(lotPoly, terrainSuitability)
        terrainQueryCount++
        terrainQueryMs += performance.now() - t0
        if (lotPlacement.avoidRejection) {
          rejectReason = 'TERRAIN_AVOID'
          avoidOverlapRejectedCount++
          terrainRejectedCount++
        } else {
          if (lotPlacement.dominantClass === 'PREFERRED') preferredAcceptedCount++
          else if (lotPlacement.dominantClass === 'MODERATE') moderateAcceptedCount++
          else if (lotPlacement.dominantClass === 'CHALLENGING') challengingAcceptedCount++
          else if (lotPlacement.dominantClass === 'INSUFFICIENT_DATA') insufficientAcceptedCount++
          if (lotPlacement.dominantClass === 'CHALLENGING' && quality.rating !== 'REJECT') {
            quality.rating = 'POOR'
            quality.reasons.push('challenging terrain')
          }
          placementScores.push(lotPlacement.placementScore)
          maxAcceptedAvoidPercent = Math.max(maxAcceptedAvoidPercent, lotPlacement.avoidPercent)
        }
      }

      const conflicts = !rejectReason ? computeConflicts(lotPoly, constraints, run.properties.roadId) : null
      const outsideZoneSqFt = !rejectReason && zone.geometry ? outsideAreaSqFt(lotPoly, zone.geometry) : 0
      const outsideCandidateSqFt = !rejectReason && (constraints as any).candidateOpenAreaGeometry ? outsideAreaSqFt(lotPoly, (constraints as any).candidateOpenAreaGeometry) : 0

      if (!rejectReason && outsideZoneSqFt > 1) rejectReason = 'OUTSIDE_ASSIGNED_ZONE'
      else if (!rejectReason && outsideCandidateSqFt > 1) rejectReason = 'OUTSIDE_CANDIDATE'
      else if (!rejectReason && conflicts) {
        if (conflicts.hydrology > 0) rejectReason = 'WATER_WETLAND_CONFLICT'
        else if (conflicts.building > 0) rejectReason = 'EXISTING_BUILDING_CONFLICT'
        else if (conflicts.pavement > 0) rejectReason = 'PRESERVED_PAVEMENT_CONFLICT'
        else if (conflicts.primaryRow > 0) rejectReason = 'PRIMARY_ROW_CONFLICT'
        else if (conflicts.secondaryRow > 0) rejectReason = 'SECONDARY_ROW_CONFLICT'
        else if (conflicts.localRow > 0) rejectReason = 'LOCAL_ROW_CONFLICT'
      }

      if (rejectReason) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons[rejectReason] = (rdm.rejectedReasons[rejectReason] || 0) + 1
        reject(rejectReason)
        if (candidates <= 15) {
          lotRejectionDiagnostics.push({
            lotIndex,
            servingRoadType: run.properties.roadType,
            candidateAreaSqFt: round3(area),
            frontageFt: round3(frontage),
            depthFt: round3(depth),
            rejectionReason: rejectReason,
            waterOverlapSqFt: round3(conflicts?.hydrology ?? 0),
            buildingOverlapSqFt: round3(conflicts?.building ?? 0),
            pavementOverlapSqFt: round3(conflicts?.pavement ?? 0),
            primaryRowOverlapSqFt: round3(conflicts?.primaryRow ?? 0),
            secondaryRowOverlapSqFt: round3(conflicts?.secondaryRow ?? 0),
            localRowOverlapSqFt: round3(conflicts?.localRow ?? 0),
            outsideCandidateSqFt: round3(outsideCandidateSqFt),
            outsideZoneSqFt: round3(outsideZoneSqFt)
          })
        }
        continue
      }

      const centroid = safeTurfOp(() => (turf as any).centroid(lotPoly), null)
      if (!centroid || !pointInFeature(centroid.geometry.coordinates, remaining)) {
        rdm.rejectedFt += frontLen
        rdm.rejectedReasons['outside usable area'] = (rdm.rejectedReasons['outside usable area'] || 0) + 1
        reject('outside usable area')
        if (candidates <= 15) {
          lotRejectionDiagnostics.push({
            lotIndex,
            servingRoadType: run.properties.roadType,
            candidateAreaSqFt: round3(area),
            frontageFt: round3(frontage),
            depthFt: round3(depth),
            rejectionReason: 'outside usable area',
            waterOverlapSqFt: 0,
            buildingOverlapSqFt: 0,
            pavementOverlapSqFt: 0,
            primaryRowOverlapSqFt: 0,
            secondaryRowOverlapSqFt: 0,
            localRowOverlapSqFt: 0,
            outsideCandidateSqFt: round3(outsideCandidateSqFt),
            outsideZoneSqFt: round3(outsideZoneSqFt)
          })
        }
        continue
      }

      if (side === 'A') rdm.sideALots++
      else rdm.sideBLots++

      const id = `LOT-${zone.id}-${lotIndex}`
      lotIndex++

      const lotCell: ConceptualLot = {
        id,
        useType: 'single-family',
        zoneId: zone.id,
        geometry: lotPoly as GeoJSON.Feature<GeoJSON.Polygon>,
        areaSqFt: round3(area),
        areaAcres: round3(sqFtToAcres(area)),
        targetLotAreaSqFt: targetArea,
        lotWidthFt: round3(frontage),
        lotDepthFt: round3(depth),
        roadBearing: round3(roadBearing),
        roadRelationship: zone.roadRelationship,
        terrain: zone.terrainAssessment,
        compatibility: zone.compatibilityByUse['single-family'] ?? 'WEAK',
        frontageFt: round3(frontage),
        depthFt: round3(depth),
        frontageRoadId: run.properties.roadId,
        frontageClassification: run.properties.frontageClassification,
        frontageToRowDistanceFt: round3(run.properties.frontageToRowDistanceFt),
        connectorLengthFt: round3(run.properties.connectorLengthFt),
        quality: quality.rating,
        terrainPlacement: lotPlacement
      }
      lots.push(lotCell)
      remaining = safeTurfOp(() => turfDifference(remaining as any, lotPoly as any) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, remaining)
      if (!remaining) break

      if (!rankOnly) {
        const env = makeEnvelopeForLot(lotPoly, id, terrainSuitability)
        if (env) envelopes.push(env)

        const roadDist = round3(run.properties.frontageToRowDistanceFt + (depth / 2))
        lotAudit.push({
          lotId: id,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageFt: round3(frontage),
          depthFt: round3(depth),
          areaSqFt: round3(area),
          aspectRatio: round3(Math.max(frontage, depth) / Math.max(0.1, Math.min(frontage, depth))),
          roadDistanceFt: round3(roadDist),
          frontageToRowDistanceFt: round3(run.properties.frontageToRowDistanceFt),
          connectorLengthFt: round3(run.properties.connectorLengthFt),
          frontageClassification: run.properties.frontageClassification,
          supportingRoadNameOrId: run.properties.roadId,
          quality: quality.rating,
          hasBuildingEnvelope: !!env,
          terrainPlacement: lotPlacement,
          buildingTerrainPlacement: env?.terrainPlacement,
          buildingEnvelopeRejected: !env
        })
      }

      accepted++
      if (run.properties.frontageClassification === 'DIRECT_ROW_FRONTAGE') lotsFromDirectRowFrontage++
      else if (run.properties.frontageClassification === 'VALID_ROW_CONNECTOR') lotsFromValidConnector++
    }
    if (!remaining) break
  }

  const unused = remaining ? areaSqFt(remaining) : 0
  const totalLotFrontageFt = lots.reduce((s, l) => s + l.frontageFt, 0)

  const rowAudits: RowFrontageByRoadAudit[] = []
  if (!rankOnly) {
    for (const [roadId, rdm] of roadAuditMap.entries()) {
      const reasons = Object.entries(rdm.rejectedReasons).sort((a, b) => b[1] - a[1])
      const dominantRejectionReason = reasons.length > 0 ? reasons[0][0] : ''
      rowAudits.push({
        mcpi,
        roadId,
        roadNameOrId: roadId,
        roadType: rdm.roadType,
        rowBoundaryLengthFt: round3(rdm.sideAFt + rdm.sideBFt + rdm.rejectedFt),
        usableFrontageSideAFt: round3(rdm.sideAFt),
        usableFrontageSideBFt: round3(rdm.sideBFt),
        lotCountSideA: rdm.sideALots,
        lotCountSideB: rdm.sideBLots,
        rejectedFrontageFt: round3(rdm.rejectedFt),
        dominantRejectionReason
      })
    }
  }

  const meanTerrainPlacementScore = placementScores.length ? round3(placementScores.reduce((s, v) => s + v, 0) / placementScores.length) : null
  const audit: LotFrontageGenerationAudit = {
    mcpi,
    assignedSingleFamilyZoneCount: 1,
    eligibleRoadCount,
    eligibleRowBoundaryFt: round3(eligibleRowBoundaryFt),
    candidateRowEdgeSegments,
    buildableSideSegments,
    directRowFrontageSegments,
    validConnectorSegments,
    proximityOnlySegments,
    noAccessSegments,
    rejectedRowSegments,
    frontageCandidates,
    frontageSegmentCount: frontageCandidates,
    totalUsableFrontageFt: round3(totalUsableFrontageFt),
    totalLotFrontageFt: round3(totalLotFrontageFt),
    lotCandidatesGenerated: candidates,
    lotsAccepted: accepted,
    lotsRejected: rejected,
    lotsFromDirectRowFrontage,
    lotsFromValidConnector,
    lotsFromProximityOnly: 0,
    rejectionCountsByReason: rejectionCounts,
    medianLotAreaSqFt: !rankOnly ? median(lotAudit.map(l => l.areaSqFt)) : 0,
    medianFrontageFt: !rankOnly ? median(lotAudit.map(l => l.frontageFt)) : 0,
    medianDepthFt: !rankOnly ? median(lotAudit.map(l => l.depthFt)) : 0,
    medianLotFrontageFt: !rankOnly ? median(lotAudit.map(l => l.frontageFt)) : 0,
    medianLotDepthFt: !rankOnly ? median(lotAudit.map(l => l.depthFt)) : 0,
    medianFrontageToRowDistanceFt: !rankOnly ? median(lotAudit.map(l => l.frontageToRowDistanceFt)) : 0,
    maxFrontageToRowDistanceFt: !rankOnly && lotAudit.length ? Math.max(...lotAudit.map(l => l.frontageToRowDistanceFt)) : null,
    medianConnectorLengthFt: !rankOnly ? median(lotAudit.map(l => l.connectorLengthFt)) : 0,
    maxConnectorLengthFt: !rankOnly && lotAudit.length ? Math.max(...lotAudit.map(l => l.connectorLengthFt)) : null,
    unusedProgrammableAreaAcres: round3(sqFtToAcres(unused)),
    terrainQueryCount,
    terrainQueryMs: round3(terrainQueryMs),
    terrainRejectedCount,
    preferredAcceptedCount,
    moderateAcceptedCount,
    challengingAcceptedCount,
    insufficientAcceptedCount,
    avoidOverlapRejectedCount,
    meanTerrainPlacementScore,
    maxAcceptedAvoidPercent: round3(maxAcceptedAvoidPercent)
  }

  if (import.meta.env.DEV && lotRejectionDiagnostics.length > 0) {
    console.log('[SingleFamilyLotRejectionDiagnostic]', { mcpi, zoneId: zone.id, sample: lotRejectionDiagnostics })
  }

  return { lots, envelopes, nextIndex: lotIndex, remaining, audit, lotAudit, rowAudits, frontageExtractionMs }
}

function generatePad(
  zone: ConceptualDevelopmentZone,
  available: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  roadBearing: number,
  useType: string,
  targetDensity: number,
  padId: string
): { pad: ConceptualDevelopmentPad | null; remaining: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null } {
  const zoneArea = areaSqFt(available)
  if (zoneArea < 5000) return { pad: null, remaining: available }

  let targetArea = zoneArea * 0.5
  let aspect = 1.2
  if (useType === 'commercial') {
    targetArea = Math.min(zoneArea * 0.5, SQFT_PER_ACRE * 1.0)
    aspect = 1.5
  } else if (useType === 'townhomes') {
    targetArea = Math.min(zoneArea * 0.6, SQFT_PER_ACRE * 1.2)
    aspect = 3.0
  } else if (useType === 'multifamily') {
    targetArea = Math.min(zoneArea * 0.6, SQFT_PER_ACRE * 2.0)
    aspect = 1.0
  }

  targetArea = Math.max(targetArea, 5000)

  const padDepth = Math.sqrt(targetArea / aspect)
  const padWidth = padDepth * aspect

  const centroid = safeTurfOp(() => turf.centroid(zone.geometry), null)
  if (!centroid) return { pad: null, remaining: available }

  const shift = useType === 'commercial' ? -padDepth / 4 : 0
  const padCenter = fastRhumbDestination(centroid, shift, 'feet', roadBearing) || centroid
  const rect = orientedRectangle(padCenter, padWidth, padDepth, roadBearing)
  const clip = safeTurfOp(() => turfIntersect(rect as any, available as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)

  if (!clip || areaSqFt(clip) < targetArea * 0.25) {
    return { pad: null, remaining: available }
  }

  const q = shapeQuality(clip)
  if (q.aspect > 6) {
    return { pad: null, remaining: available }
  }

  const padArea = areaSqFt(clip)
  let estimatedUnits = 0
  if (useType === 'multifamily') {
    estimatedUnits = Math.max(1, Math.round(sqFtToAcres(padArea) * targetDensity))
  } else if (useType === 'townhomes') {
    estimatedUnits = Math.max(1, Math.round(padArea / 1600))
  }

  const pad: ConceptualDevelopmentPad = {
    id: padId,
    useType,
    zoneId: zone.id,
    geometry: clip,
    areaSqFt: round3(padArea),
    areaAcres: round3(sqFtToAcres(padArea)),
    estimatedUnits,
    roadBearing: round3(roadBearing),
    roadRelationship: zone.roadRelationship,
    terrain: zone.terrainAssessment,
    compatibility: zone.compatibilityByUse[useType] ?? 'WEAK'
  }

  const remaining = safeTurfOp(() => turfDifference(available, clip) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, available)

  return { pad, remaining }
}

const CONCEPTUAL_BUILDING_ASSUMPTIONS = {
  apartment: { minPadAreaSqFt: 15000, typicalBuildingWidthFt: 120, typicalBuildingDepthFt: 60, maxBuildingsPerPad: 1, buildingInsetScale: 0.55 },
  commercial: { minPadAreaSqFt: 12000, typicalBuildingWidthFt: 100, typicalBuildingDepthFt: 80, maxBuildingsPerPad: 1, buildingInsetScale: 0.55 }
}

function makeBuildingEnvelopeForPad(pad: ConceptualDevelopmentPad, padId: string, terrainSuitability?: TerrainSuitabilityResult | null): ConceptualBuildingEnvelope | null {
  const scaled = safeTurfOp(() => (turf as any).transformScale(pad.geometry, CONCEPTUAL_BUILDING_ASSUMPTIONS[pad.useType as 'apartment' | 'commercial']?.buildingInsetScale ?? 0.55, { origin: 'centroid' }) as GeoJSON.Feature<GeoJSON.Polygon>, null)
  if (!scaled) return null
  const rawClip = safeTurfOp(() => turfIntersect(scaled, pad.geometry) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, null)
  if (!rawClip) return null
  const envClip = largestPolygonComponent(rawClip)
  if (!envClip || areaSqFt(envClip) <= 800) return null
  const envelopePlacement = computeTerrainPlacementEvaluation(envClip, terrainSuitability)
  if (envelopePlacement.avoidRejection) return null
  return {
    id: `ENV-${padId}`,
    parentLotId: padId,
    geometry: envClip,
    areaSqFt: round3(areaSqFt(envClip)),
    areaAcres: round3(sqFtToAcres(areaSqFt(envClip))),
    terrainPlacement: envelopePlacement
  }
}

interface GenerateApartmentCommercialInput {
  use: 'multifamily' | 'commercial'
  zone: ConceptualDevelopmentZone
  available: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  roadBearing: number
  targetDensity: number
  mcpi: string
  alternativeId: string
  selectedDevelopmentTypes: string[]
  conflictGroups: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[]; candidateOpenAreaGeometry?: any }
  parcelBoundary?: GeoJSON.Feature<GeoJSON.Geometry> | null
  buildingEnvelopes: ConceptualBuildingEnvelope[]
  developmentPads: ConceptualDevelopmentPad[]
  terrainSuitability?: TerrainSuitabilityResult | null
}

function generateApartmentCommercialPads(input: GenerateApartmentCommercialInput): ApartmentGenerationResult | CommercialGenerationResult {
  const { use, zone, available, roadBearing, targetDensity, mcpi, alternativeId, selectedDevelopmentTypes, conflictGroups, parcelBoundary, buildingEnvelopes, developmentPads, terrainSuitability } = input
  const useKey = use === 'multifamily' ? 'apartment' : 'commercial'
  const assumptions = CONCEPTUAL_BUILDING_ASSUMPTIONS[useKey]
  const result: ApartmentGenerationResult & CommercialGenerationResult = {
    mcpi,
    status: 'empty',
    placementStatus: 'NO_VALID_PLACEMENT',
    targetCapacity: null,
    padCount: 0,
    buildingCount: 0,
    pads: [],
    buildings: [],
    placementAudit: {
      mcpi,
      alternativeId,
      selectedDevelopmentTypes,
      targetCapacity: null,
      assignedZoneCount: 0,
      eligibleZoneCount: 1,
      attemptedPadCount: 0,
      acceptedPadCount: 0,
      generatedBuildingCount: 0,
      placementStatus: 'NO_VALID_PLACEMENT',
      rejectionReasons: {},
      allPadsInsideParcel: true,
      allPadsInsideCandidateArea: true,
      allPadsInsideAssignedZones: true,
      allBuildingsInsidePads: true,
      allBuildingsInsideCandidateArea: true,
      padOverlapCount: 0,
      buildingOverlapCount: 0,
      padAreaAcres: 0,
      footprintAreaAcres: 0,
      padPrimaryRowOverlapSqFt: 0,
      padSecondaryRowOverlapSqFt: 0,
      padLocalRowOverlapSqFt: 0,
      buildingPrimaryRowOverlapSqFt: 0,
      buildingSecondaryRowOverlapSqFt: 0,
      buildingLocalRowOverlapSqFt: 0,
      authoritativePadCount: 0,
      authoritativeBuildingCount: 0,
      renderedPadCount: 0,
      renderedBuildingCount: 0,
      padGeometryType: 'None',
      padComponentCount: 0,
      buildingGeometryType: 'None',
      buildingComponentCount: 0,
      renderedPadGeometryType: 'None',
      renderedPadComponentCount: 0,
      auditedPadMatchesRenderedPad: false,
      terrainQueryCount: 0,
      terrainQueryMs: 0,
      terrainRejectedCount: 0,
      padTerrainPlacement: undefined,
      buildingTerrainPlacement: undefined,
      meanTerrainPlacementScore: null
    }
  }

  const availableComponent = largestPolygonComponent(available)
  if (!availableComponent) {
    result.placementAudit.rejectionReasons['INVALID_GEOMETRY'] = 1
    return result
  }
  const zoneArea = areaSqFt(availableComponent)
  if (zoneArea < assumptions.minPadAreaSqFt) {
    result.placementAudit.rejectionReasons['INSUFFICIENT_AREA'] = 1
    return result
  }

  const padAreaTarget = Math.min(zoneArea * 0.6, SQFT_PER_ACRE * (use === 'multifamily' ? 1.5 : 1.2))
  const aspect = use === 'multifamily' ? 2.0 : 1.5
  const padDepth = Math.sqrt(padAreaTarget / aspect)
  const padWidth = padDepth * aspect
  const shift = use === 'commercial' ? -padDepth / 4 : 0
  const centroid = safeTurfOp(() => turf.centroid(availableComponent), null)
  if (!centroid) {
    result.placementAudit.rejectionReasons['INVALID_GEOMETRY'] = 1
    return result
  }

  const padCenter = fastRhumbDestination(centroid, shift, 'feet', roadBearing) || centroid
  const rect = orientedRectangle(padCenter, padWidth, padDepth, roadBearing)
  const rawClip = safeTurfOp(() => turfIntersect(rect as any, availableComponent as any) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null, null)
  const clip = rawClip ? largestPolygonComponent(rawClip) : null
  if (!clip || areaSqFt(clip) < padAreaTarget * 0.3) {
    result.placementAudit.rejectionReasons['INSUFFICIENT_AREA'] = 1
    return result
  }

  const q0 = performance.now()
  const padPlacement = computeTerrainPlacementEvaluation(clip, terrainSuitability)
  const padQueryMs = performance.now() - q0
  result.placementAudit.terrainQueryCount = 1
  result.placementAudit.terrainQueryMs = round3(padQueryMs)
  result.placementAudit.padTerrainPlacement = padPlacement
  if (padPlacement.avoidRejection) {
    result.placementAudit.terrainRejectedCount = 1
    result.placementAudit.rejectionReasons['TERRAIN_AVOID'] = 1
    result.placementAudit.meanTerrainPlacementScore = 0
    return result
  }

  const q = shapeQuality(clip)
  if (q.aspect > 6) {
    result.placementAudit.rejectionReasons['INSUFFICIENT_AREA'] = 1
    return result
  }

  const padArea = areaSqFt(clip)
  const estimatedUnits = use === 'multifamily'
    ? Math.max(1, Math.round(sqFtToAcres(padArea) * targetDensity))
    : 0

  const pad: ConceptualDevelopmentPad = {
    id: `PAD-${zone.id}-${use}`,
    useType: use,
    zoneId: zone.id,
    geometry: clip,
    areaSqFt: round3(padArea),
    areaAcres: round3(sqFtToAcres(padArea)),
    estimatedUnits,
    roadBearing: round3(roadBearing),
    roadRelationship: zone.roadRelationship,
    terrain: zone.terrainAssessment,
    compatibility: zone.compatibilityByUse[use] ?? 'WEAK',
    terrainPlacement: padPlacement
  }

  const padConflicts = computeConflicts(clip, conflictGroups)
  result.placementAudit.padPrimaryRowOverlapSqFt = round3(padConflicts.primaryRow)
  result.placementAudit.padSecondaryRowOverlapSqFt = round3(padConflicts.secondaryRow)
  result.placementAudit.padLocalRowOverlapSqFt = round3(padConflicts.localRow)
  if (padConflicts.hydrology > 0 || padConflicts.building > 0 || padConflicts.pavement > 0 || padConflicts.row > 0) {
    if (padConflicts.hydrology > 0) result.placementAudit.rejectionReasons['WATER_WETLAND_CONFLICT'] = 1
    else if (padConflicts.building > 0) result.placementAudit.rejectionReasons['EXISTING_BUILDING_CONFLICT'] = 1
    else if (padConflicts.pavement > 0) result.placementAudit.rejectionReasons['PRESERVED_PAVEMENT_CONFLICT'] = 1
    else if (padConflicts.primaryRow > 0) result.placementAudit.rejectionReasons['PRIMARY_ROW_CONFLICT'] = 1
    else if (padConflicts.secondaryRow > 0) result.placementAudit.rejectionReasons['SECONDARY_ROW_CONFLICT'] = 1
    else if (padConflicts.localRow > 0) result.placementAudit.rejectionReasons['LOCAL_ROW_CONFLICT'] = 1
    return result
  }

  const outsideZone = zone.geometry ? outsideAreaSqFt(clip, zone.geometry) : 0
  const outsideCandidate = conflictGroups.candidateOpenAreaGeometry ? outsideAreaSqFt(clip, conflictGroups.candidateOpenAreaGeometry) : 0
  const outsideParcel = parcelBoundary ? outsideAreaSqFt(clip, parcelBoundary) : 0
  if (outsideZone > 1) {
    result.placementAudit.rejectionReasons['OUTSIDE_ASSIGNED_ZONE'] = 1
    return result
  }
  if (outsideCandidate > 1) {
    result.placementAudit.rejectionReasons['OUTSIDE_CANDIDATE'] = 1
    return result
  }
  if (outsideParcel > 1) {
    result.placementAudit.rejectionReasons['OUTSIDE_CANDIDATE'] = 1
    return result
  }

  const existingPadOverlap = developmentPads.some(p => overlapAreaSqFt(clip, p.geometry) > 1)
  const existingBuildingOverlap = buildingEnvelopes.some(e => overlapAreaSqFt(clip, e.geometry) > 1)
  if (existingPadOverlap || existingBuildingOverlap) {
    result.placementAudit.rejectionReasons['PAD_OVERLAP'] = 1
    return result
  }

  const building = makeBuildingEnvelopeForPad(pad, pad.id, terrainSuitability)
  if (!building) {
    result.placementAudit.rejectionReasons['NO_VALID_BUILDING_FIT'] = 1
  } else {
    const bConflicts = computeConflicts(building.geometry, conflictGroups)
    const bOutsidePad = outsideAreaSqFt(building.geometry, pad.geometry)
    const bOutsideZone = zone.geometry ? outsideAreaSqFt(building.geometry, zone.geometry) : 0
    const bOutsideCandidate = conflictGroups.candidateOpenAreaGeometry ? outsideAreaSqFt(building.geometry, conflictGroups.candidateOpenAreaGeometry) : 0
    const bOutsideParcel = parcelBoundary ? outsideAreaSqFt(building.geometry, parcelBoundary) : 0
    const bOverlap = buildingEnvelopes.some(e => overlapAreaSqFt(building.geometry, e.geometry) > 1) || developmentPads.some(p => p.id !== pad.id && overlapAreaSqFt(building.geometry, p.geometry) > 1)
    result.placementAudit.buildingPrimaryRowOverlapSqFt = round3(bConflicts.primaryRow)
    result.placementAudit.buildingSecondaryRowOverlapSqFt = round3(bConflicts.secondaryRow)
    result.placementAudit.buildingLocalRowOverlapSqFt = round3(bConflicts.localRow)
    if (bConflicts.hydrology > 0 || bConflicts.building > 0 || bConflicts.pavement > 0 || bConflicts.row > 0 || bOutsidePad > 1 || bOutsideZone > 1 || bOutsideCandidate > 1 || bOutsideParcel > 1 || bOverlap) {
      result.placementAudit.rejectionReasons['NO_VALID_BUILDING_FIT'] = 1
    } else {
      result.buildings.push(building)
      result.buildingCount = 1
    }
  }

  result.pads.push(pad)
  result.padCount = 1
  result.status = 'generated'
  result.placementStatus = result.buildingCount > 0 ? 'FULL_TARGET_MET' : 'PARTIAL_TARGET'
  result.targetCapacity = estimatedUnits

  result.placementAudit.assignedZoneCount = 1
  result.placementAudit.eligibleZoneCount = 1
  result.placementAudit.attemptedPadCount = 1
  result.placementAudit.acceptedPadCount = 1
  result.placementAudit.generatedBuildingCount = result.buildingCount
  result.placementAudit.placementStatus = result.placementStatus
  result.placementAudit.targetCapacity = estimatedUnits
  result.placementAudit.padAreaAcres = round3(sqFtToAcres(padArea))
  result.placementAudit.footprintAreaAcres = round3(sqFtToAcres(result.buildings.reduce((s, b) => s + b.areaSqFt, 0)))
  result.placementAudit.authoritativePadCount = result.padCount
  result.placementAudit.authoritativeBuildingCount = result.buildingCount
  result.placementAudit.padGeometryType = pad.geometry.type
  result.placementAudit.padComponentCount = componentCountForGeometry(pad.geometry.geometry)
  const acceptedBuilding = result.buildings[0]
  result.placementAudit.buildingGeometryType = acceptedBuilding?.geometry?.type ?? 'None'
  result.placementAudit.buildingComponentCount = acceptedBuilding ? componentCountForGeometry(acceptedBuilding.geometry.geometry) : 0
  result.placementAudit.buildingTerrainPlacement = acceptedBuilding?.terrainPlacement
  const padScore = pad.terrainPlacement?.placementScore ?? 0
  const buildingScore = acceptedBuilding?.terrainPlacement?.placementScore ?? null
  result.placementAudit.meanTerrainPlacementScore = buildingScore !== null ? round3((padScore + buildingScore) / 2) : round3(padScore)
  if (acceptedBuilding?.terrainPlacement) {
    result.placementAudit.terrainQueryCount = 2
    result.placementAudit.terrainQueryMs = round3((result.placementAudit.terrainQueryMs ?? 0) + 0)
  }

  if (import.meta.env.DEV) {
    console.log(`[${use === 'multifamily' ? 'ApartmentGeometryTruth' : 'CommercialGeometryTruth'}]`, { padId: pad.id, ...geometryTruth(pad.geometry) })
    console.log(`[${use === 'multifamily' ? 'ApartmentPlacementAudit' : 'CommercialPlacementAudit'}]`, result.placementAudit)
  }

  return result
}

const CONFLICT_TOLERANCE_SQFT = 5

function computeConflicts(
  feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  constraints: { rows: GeoJSON.Feature<GeoJSON.Polygon>[]; buildings: GeoJSON.Feature<GeoJSON.Polygon>[]; hydrology: GeoJSON.Feature<GeoJSON.Polygon>[]; pavement: GeoJSON.Feature<GeoJSON.Polygon>[] },
  servingRoadId?: string | null
): { outside: number; row: number; building: number; hydrology: number; pavement: number; primaryRow: number; secondaryRow: number; localRow: number } {
  let outside = 0
  let row = 0
  let building = 0
  let hydrology = 0
  let pavement = 0
  let primaryRow = 0
  let secondaryRow = 0
  let localRow = 0

  const featureBbox = safeTurfOp(() => turf.bbox(feature), null)
  function getBbox(c: any): number[] | null {
    return c?.bbox ?? safeTurfOp(() => turf.bbox(c), null)
  }
  function mayOverlap(c: any): boolean {
    const cb = getBbox(c)
    if (!featureBbox || !cb || featureBbox.length < 4 || cb.length < 4) return true
    return featureBbox[0] <= cb[2] && featureBbox[2] >= cb[0] && featureBbox[1] <= cb[3] && featureBbox[3] >= cb[1]
  }

  for (const c of constraints.rows) {
    if (!c.geometry) continue
    const roadId = (c as any).properties?.roadId as string | undefined
    if (servingRoadId && roadId === servingRoadId) continue
    if (!mayOverlap(c)) continue
    const inter = safeTurfOp(() => turfIntersect(feature as any, c as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
    if (inter) {
      const a = areaSqFt(inter)
      if (a > CONFLICT_TOLERANCE_SQFT) {
        row += a
        const roadType = (c as any).properties?.roadType as string | undefined
        if (roadType === 'primary') primaryRow += a
        else if (roadType === 'secondary') secondaryRow += a
        else if (roadType === 'local') localRow += a
      }
    }
  }
  for (const c of constraints.buildings) {
    if (!mayOverlap(c)) continue
    const inter = safeTurfOp(() => turfIntersect(feature as any, c as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
    if (inter) {
      const a = areaSqFt(inter)
      if (a > CONFLICT_TOLERANCE_SQFT) building += a
    }
  }
  for (const c of constraints.hydrology) {
    if (!mayOverlap(c)) continue
    const inter = safeTurfOp(() => turfIntersect(feature as any, c as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
    if (inter) {
      const a = areaSqFt(inter)
      if (a > CONFLICT_TOLERANCE_SQFT) hydrology += a
    }
  }
  for (const c of constraints.pavement) {
    if (!mayOverlap(c)) continue
    const inter = safeTurfOp(() => turfIntersect(feature as any, c as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
    if (inter) {
      const a = areaSqFt(inter)
      if (a > CONFLICT_TOLERANCE_SQFT) pavement += a
    }
  }

  return { outside, row, building, hydrology, pavement, primaryRow, secondaryRow, localRow }
}

function collectRoadRows(
  conceptualRoadResult: ConceptualRoadSkeletonResult | null | undefined,
  secondaryRoadNetworkResult: SecondaryRoadNetworkResult | null | undefined,
  localStreetNetworkResult: LocalStreetNetworkResult | null | undefined
): { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[] {
  const rows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[] = []

  if (conceptualRoadResult?.proposedRightOfWay) {
    rows.push({
      roadId: 'PRIMARY',
      roadType: 'primary',
      row: conceptualRoadResult.proposedRightOfWay,
      centerline: conceptualRoadResult.proposedRoadCenterline || null
    })
  }

  if (secondaryRoadNetworkResult?.roads) {
    for (const r of secondaryRoadNetworkResult.roads) {
      if (r.rightOfWayGeometry) {
        rows.push({
          roadId: `SECONDARY-${r.id || rows.length}`,
          roadType: 'secondary',
          row: r.rightOfWayGeometry,
          centerline: r.centerlineGeometry || null
        })
      }
    }
  }

  if (localStreetNetworkResult?.localStreets) {
    for (const r of localStreetNetworkResult.localStreets) {
      if (r.rightOfWayGeometry) {
        rows.push({
          roadId: `LOCAL-${r.id || rows.length}`,
          roadType: 'local',
          row: r.rightOfWayGeometry,
          centerline: r.centerlineGeometry || null
        })
      }
    }
  }

  return rows
}

export async function generateConceptualDevelopmentLayout(
  programResult: ConceptualDevelopmentProgramResult,
  _blockResult: DevelopmentOpportunityBlockResult,
  constraints: LayoutConstraints,
  projectParameters?: ProjectParameters | null,
  runType: 'baseline' | 'candidate' | 'final' | 'other' = 'other',
  semanticKey?: string,
  signal?: AbortSignal
): Promise<ConceptualDevelopmentLayoutResult> {
  const layoutSemanticKey = semanticKey || `${programResult.mcpi}|${runType}`
  recomputeCounter.increment('layout', layoutSemanticKey)
  recomputeCounter.increment(`layout-${runType}`, layoutSemanticKey)
  generationPerformance.start('layout')
  turfCounter.setCaller('layout')
  try {
  const mcpi = programResult.mcpi
  const selected = [...programResult.selectedDevelopmentTypes]
  const selectedCanonical = selected.map(canonicalUseType)
  const warnings: string[] = []

  const zones: ConceptualDevelopmentZone[] = programResult.zones.map(z => ({
    ...z,
    compatibilityByUse: canonicalizeUseRecord(z.compatibilityByUse),
    programCompatibilities: z.programCompatibilities.map(pc => ({ ...pc, useType: canonicalUseType(pc.useType) })),
    bestCompatibleUse: z.bestCompatibleUse ? canonicalUseType(z.bestCompatibleUse) : null
  }))

  if (programResult.capacityStatus === 'UNAVAILABLE') {
    return {
      mcpi,
      status: 'unavailable',
      selectedDevelopmentTypes: selected,
      assignedZoneCount: 0,
      lotCount: 0,
      buildingEnvelopeCount: 0,
      developmentPadCount: 0,
      drawableResidentialCapacity: 0,
      densityCapacityProxy: programResult.conceptualCapacity?.densityUnits ?? null,
      lotCapacityProxy: programResult.conceptualCapacity?.lotUnits ?? null,
      layoutAreaAcres: 0,
      layoutAreaSqFt: 0,
      unusedProgrammableAreaAcres: programResult.programmableAreaAcres,
      utilizationPercent: 0,
      lotCells: [],
      buildingEnvelopes: [],
      developmentPads: [],
      useAssignments: [],
      audit: { overlaps: 0, outsideZoneSqFt: 0, rowConflictSqFt: 0, buildingConflictSqFt: 0, hydrologyConflictSqFt: 0, pavementConflictSqFt: 0 },
      lotFrontageGenerationAudit: {
        mcpi,
        assignedSingleFamilyZoneCount: 0,
        eligibleRoadCount: 0,
        eligibleRowBoundaryFt: 0,
        candidateRowEdgeSegments: 0,
        buildableSideSegments: 0,
        directRowFrontageSegments: 0,
        validConnectorSegments: 0,
        proximityOnlySegments: 0,
        noAccessSegments: 0,
        rejectedRowSegments: 0,
        frontageCandidates: 0,
        frontageSegmentCount: 0,
        totalUsableFrontageFt: 0,
        totalLotFrontageFt: 0,
        lotCandidatesGenerated: 0,
        lotsAccepted: 0,
        lotsRejected: 0,
        lotsFromDirectRowFrontage: 0,
        lotsFromValidConnector: 0,
        lotsFromProximityOnly: 0,
        rejectionCountsByReason: {},
        medianLotAreaSqFt: null,
        medianFrontageFt: null,
        medianDepthFt: null,
        medianLotFrontageFt: null,
        medianLotDepthFt: null,
        medianFrontageToRowDistanceFt: null,
        maxFrontageToRowDistanceFt: null,
        medianConnectorLengthFt: null,
        maxConnectorLengthFt: null,
        unusedProgrammableAreaAcres: 0,
        terrainQueryCount: 0,
        terrainQueryMs: 0,
        terrainRejectedCount: 0,
        preferredAcceptedCount: 0,
        moderateAcceptedCount: 0,
        challengingAcceptedCount: 0,
        insufficientAcceptedCount: 0,
        avoidOverlapRejectedCount: 0,
        meanTerrainPlacementScore: null,
        maxAcceptedAvoidPercent: 0
      },
      conceptualLotAudit: [],
      warnings: ['No conceptual layout generated; development program is unavailable.']
    }
  }

  if (programResult.capacityStatus === 'LATENT_ACCESS_CONSTRAINED') {
    return {
      mcpi,
      status: 'ACCESS_CONSTRAINED',
      selectedDevelopmentTypes: selected,
      assignedZoneCount: 0,
      lotCount: 0,
      buildingEnvelopeCount: 0,
      developmentPadCount: 0,
      drawableResidentialCapacity: 0,
      densityCapacityProxy: programResult.conceptualCapacity?.densityUnits ?? null,
      lotCapacityProxy: programResult.conceptualCapacity?.lotUnits ?? null,
      layoutAreaAcres: 0,
      layoutAreaSqFt: 0,
      unusedProgrammableAreaAcres: programResult.programmableAreaAcres,
      utilizationPercent: 0,
      lotCells: [],
      buildingEnvelopes: [],
      developmentPads: [],
      useAssignments: [],
      audit: { overlaps: 0, outsideZoneSqFt: 0, rowConflictSqFt: 0, buildingConflictSqFt: 0, hydrologyConflictSqFt: 0, pavementConflictSqFt: 0 },
      lotFrontageGenerationAudit: {
        mcpi,
        assignedSingleFamilyZoneCount: 0,
        eligibleRoadCount: 0,
        eligibleRowBoundaryFt: 0,
        candidateRowEdgeSegments: 0,
        buildableSideSegments: 0,
        directRowFrontageSegments: 0,
        validConnectorSegments: 0,
        proximityOnlySegments: 0,
        noAccessSegments: 0,
        rejectedRowSegments: 0,
        frontageCandidates: 0,
        frontageSegmentCount: 0,
        totalUsableFrontageFt: 0,
        totalLotFrontageFt: 0,
        lotCandidatesGenerated: 0,
        lotsAccepted: 0,
        lotsRejected: 0,
        lotsFromDirectRowFrontage: 0,
        lotsFromValidConnector: 0,
        lotsFromProximityOnly: 0,
        rejectionCountsByReason: {},
        medianLotAreaSqFt: null,
        medianFrontageFt: null,
        medianDepthFt: null,
        medianLotFrontageFt: null,
        medianLotDepthFt: null,
        medianFrontageToRowDistanceFt: null,
        maxFrontageToRowDistanceFt: null,
        medianConnectorLengthFt: null,
        maxConnectorLengthFt: null,
        unusedProgrammableAreaAcres: 0,
        terrainQueryCount: 0,
        terrainQueryMs: 0,
        terrainRejectedCount: 0,
        preferredAcceptedCount: 0,
        moderateAcceptedCount: 0,
        challengingAcceptedCount: 0,
        insufficientAcceptedCount: 0,
        avoidOverlapRejectedCount: 0,
        meanTerrainPlacementScore: null,
        maxAcceptedAvoidPercent: 0
      },
      conceptualLotAudit: [],
      warnings: ['No feasible conceptual primary/access network; layout is access-constrained.']
    }
  }

  const rowConstraints: GeoJSON.Feature<GeoJSON.Polygon>[] = []
  const buildingConstraints = combineConstraints(constraints.buildingUnionGeometry)
  const hydrologyConstraints = combineConstraints(constraints.hydrologyGeometry)
  const pavementConstraints = combineConstraints(constraints.pavementGeometry)

  if (constraints.conceptualRoadResult?.proposedRightOfWay) {
    const rows = toPolygonFeatures(constraints.conceptualRoadResult.proposedRightOfWay)
    rows.forEach(f => { f.properties = { ...(f.properties || {}), roadId: 'PRIMARY', roadType: 'primary' } })
    rowConstraints.push(...rows)
  }
  if (constraints.secondaryRoadNetworkResult?.roads) {
    for (const r of constraints.secondaryRoadNetworkResult.roads) {
      if (r.rightOfWayGeometry) {
        const rows = toPolygonFeatures(r.rightOfWayGeometry)
        rows.forEach(f => { f.properties = { ...(f.properties || {}), roadId: `SECONDARY-${r.id || rowConstraints.length}`, roadType: 'secondary' } })
        rowConstraints.push(...rows)
      }
    }
  }
  if (constraints.localStreetNetworkResult?.localStreets) {
    for (const r of constraints.localStreetNetworkResult.localStreets) {
      if (r.rightOfWayGeometry) {
        const rows = toPolygonFeatures(r.rightOfWayGeometry)
        rows.forEach(f => { f.properties = { ...(f.properties || {}), roadId: `LOCAL-${r.id || rowConstraints.length}`, roadType: 'local' } })
        rowConstraints.push(...rows)
      }
    }
  }

  const allConstraints = [...rowConstraints, ...buildingConstraints, ...hydrologyConstraints, ...pavementConstraints]

  const assignments = assignUseToZones(zones, selectedCanonical, programResult.capacityStatus, warnings)
  const roadLines = collectRoadLines(constraints.conceptualRoadResult, constraints.secondaryRoadNetworkResult)
  const roadRows = collectRoadRows(constraints.conceptualRoadResult, constraints.secondaryRoadNetworkResult, constraints.localStreetNetworkResult)

  const lotCells: ConceptualLot[] = []
  const buildingEnvelopes: ConceptualBuildingEnvelope[] = []
  const developmentPads: ConceptualDevelopmentPad[] = []
  const useAssignments: DevelopmentUseAssignment[] = []
  const frontageAudits: LotFrontageGenerationAudit[] = []
  const conceptualLotAudits: ConceptualLotAuditItem[] = []
  const rowAudits: RowFrontageByRoadAudit[] = []

  let apartmentResult: ApartmentGenerationResult | null = null
  let commercialResult: CommercialGenerationResult | null = null

  let lotIndex = 0
  const targetDensity = programResult.targetDensity ?? projectParameters?.zoningAndLots?.targetDensity ?? 4
  const preferredLotSize = programResult.preferredLotSize ?? projectParameters?.zoningAndLots?.minLotArea ?? 6000

  let zoneIndex = 0
  for (const zone of zones) {
    if (signal?.aborted) throw new Error('Generation aborted')
    if (zoneIndex % 2 === 0) await yieldIfNeeded(signal)
    zoneIndex++
    const use = assignments.get(zone.id)
    if (!use) {
      useAssignments.push({
        zoneId: zone.id,
        assignedUse: null,
        compatibility: zone.bestCompatibility,
        roadRelationship: zone.roadRelationship,
        zoneAcres: round3(zone.areaAcres),
        generatedFeatureCount: 0,
        generatedAreaAcres: 0,
        terrain: zone.terrainAssessment,
        reason: 'No selected use was suitable for this conceptual development zone.'
      })
      continue
    }

    const available = computeAvailableGeometry(zone.geometry, constraints.candidateOpenAreaGeometry, allConstraints)
    if (!available || areaSqFt(available) < 1000) {
      useAssignments.push({
        zoneId: zone.id,
        assignedUse: use,
        compatibility: zone.compatibilityByUse[use] ?? 'WEAK',
        roadRelationship: zone.roadRelationship,
        zoneAcres: round3(zone.areaAcres),
        generatedFeatureCount: 0,
        generatedAreaAcres: 0,
        terrain: zone.terrainAssessment,
        reason: 'Suitable conceptual use assigned, but no usable geometry remained after hard constraints.'
      })
      continue
    }

    const { bearing } = nearestRoadBearing(zone, roadLines)
    const conflictGroups = { rows: rowConstraints, buildings: buildingConstraints, hydrology: hydrologyConstraints, pavement: pavementConstraints, candidateOpenAreaGeometry: constraints.candidateOpenAreaGeometry }

    if (use === 'single-family') {
      const result = await generateSingleFamilyLots(zone, available, roadRows, conflictGroups, preferredLotSize, lotIndex, mcpi, false, signal, constraints.terrainSuitability)
      lotCells.push(...result.lots)
      buildingEnvelopes.push(...result.envelopes)
      lotIndex = result.nextIndex
      frontageAudits.push(result.audit)
      conceptualLotAudits.push(...result.lotAudit)
      rowAudits.push(...result.rowAudits)

      useAssignments.push({
        zoneId: zone.id,
        assignedUse: use,
        compatibility: zone.compatibilityByUse[use] ?? 'WEAK',
        roadRelationship: zone.roadRelationship,
        zoneAcres: round3(zone.areaAcres),
        generatedFeatureCount: result.lots.length,
        generatedAreaAcres: round3(sqFtToAcres(result.lots.reduce((s, l) => s + l.areaSqFt, 0))),
        terrain: zone.terrainAssessment,
        reason: result.lots.length === 0
          ? `Assigned to single-family concept, but no valid road-frontage segments could be lotized in ${zone.id}.`
          : `Assigned to single-family concept because the zone is ${zone.roadRelationship.toLowerCase().replace('_', ' ')} with ${zone.compatibilityByUse[use] ?? 'WEAK'} single-family compatibility.`
      })

      if (zone.terrainAssessment === 'CHALLENGING' && result.lots.length > 0) {
        if (isTerrainDataAvailable(constraints.terrainData)) {
          warnings.push(`Conceptual single-family lots in ${zone.id} are on challenging terrain; layout is for feasibility visualization only.`)
        } else {
          warnings.push(`Terrain data is insufficient for a current-run terrain quality conclusion for ${zone.id}; conceptual zone terrain is a fallback.`)
        }
      }
    } else if (use === 'multifamily' || use === 'commercial') {
      const acResult = generateApartmentCommercialPads({
        use,
        zone,
        available,
        roadBearing: bearing,
        targetDensity,
        mcpi,
        alternativeId: layoutSemanticKey,
        selectedDevelopmentTypes: selected,
        conflictGroups,
        parcelBoundary: constraints.parcelBoundary,
        buildingEnvelopes,
        developmentPads,
        terrainSuitability: constraints.terrainSuitability
      })
      const pad = acResult.pads[0] ?? null
      if (pad) {
        developmentPads.push(pad)
        buildingEnvelopes.push(...acResult.buildings)
      }
      acResult.placementAudit.renderedPadCount = developmentPads.filter(p => p.useType === use).length
      acResult.placementAudit.renderedBuildingCount = buildingEnvelopes.filter(e => {
        const parentPad = developmentPads.find(p => p.id === e.parentLotId)
        return parentPad?.useType === use
      }).length
      const renderedPad = acResult.pads[0]
      if (renderedPad) {
        acResult.placementAudit.renderedPadGeometryType = renderedPad.geometry.type
        acResult.placementAudit.renderedPadComponentCount = componentCountForGeometry(renderedPad.geometry.geometry)
        acResult.placementAudit.auditedPadMatchesRenderedPad =
          acResult.placementAudit.padGeometryType === renderedPad.geometry.type &&
          acResult.placementAudit.padComponentCount === componentCountForGeometry(renderedPad.geometry.geometry) &&
          acResult.placementAudit.padAreaAcres === round3(sqFtToAcres(renderedPad.areaSqFt))
      }
      if (use === 'multifamily') apartmentResult = acResult
      if (use === 'commercial') commercialResult = acResult

      useAssignments.push({
        zoneId: zone.id,
        assignedUse: use,
        compatibility: zone.compatibilityByUse[use] ?? 'WEAK',
        roadRelationship: zone.roadRelationship,
        zoneAcres: round3(zone.areaAcres),
        generatedFeatureCount: acResult.padCount + acResult.buildingCount,
        generatedAreaAcres: round3(acResult.placementAudit.padAreaAcres + acResult.placementAudit.footprintAreaAcres),
        terrain: zone.terrainAssessment,
        reason: pad
          ? `Assigned to ${use} concept because the zone has ${zone.roadRelationship.toLowerCase().replace('_', ' ')} and ${zone.compatibilityByUse[use] ?? 'WEAK'} ${use} compatibility.`
          : `Assigned to ${use} concept, but a suitable conceptual pad could not be drawn within the usable zone geometry.`
      })

      if (pad && zone.terrainAssessment === 'CHALLENGING') {
        if (isTerrainDataAvailable(constraints.terrainData)) {
          warnings.push(`Conceptual ${use} pad in ${zone.id} is on challenging terrain; layout is for feasibility visualization only.`)
        } else {
          warnings.push(`Terrain data is insufficient for a current-run terrain quality conclusion for ${zone.id}; conceptual zone terrain is a fallback.`)
        }
      }
    } else {
      const { pad, remaining } = generatePad(zone, available, bearing, use, targetDensity, `PAD-${zone.id}-${use}`)
      if (pad) {
        developmentPads.push(pad)
      }

      useAssignments.push({
        zoneId: zone.id,
        assignedUse: use,
        compatibility: zone.compatibilityByUse[use] ?? 'WEAK',
        roadRelationship: zone.roadRelationship,
        zoneAcres: round3(zone.areaAcres),
        generatedFeatureCount: pad ? 1 : 0,
        generatedAreaAcres: round3(sqFtToAcres(pad ? pad.areaSqFt : 0)),
        terrain: zone.terrainAssessment,
        reason: pad
          ? `Assigned to ${use} concept because the zone has ${zone.roadRelationship.toLowerCase().replace('_', ' ')} and ${zone.compatibilityByUse[use] ?? 'WEAK'} ${use} compatibility.`
          : `Assigned to ${use} concept, but a suitable conceptual pad could not be drawn within the usable zone geometry.`
      })

      if (remaining && areaSqFt(remaining) > 0 && pad && zone.terrainAssessment === 'CHALLENGING') {
        if (isTerrainDataAvailable(constraints.terrainData)) {
          warnings.push(`Conceptual ${use} pad in ${zone.id} is on challenging terrain; layout is for feasibility visualization only.`)
        } else {
          warnings.push(`Terrain data is insufficient for a current-run terrain quality conclusion for ${zone.id}; conceptual zone terrain is a fallback.`)
        }
      }
    }
  }

  const layoutAreaSqFt = lotCells.reduce((s, l) => s + l.areaSqFt, 0) + developmentPads.reduce((s, p) => s + p.areaSqFt, 0)
  const layoutAreaAcres = sqFtToAcres(layoutAreaSqFt)
  const unusedProgrammableAreaAcres = Math.max(0, programResult.programmableAreaAcres - layoutAreaAcres)
  const utilizationPercent = programResult.programmableAreaAcres > 0 ? (layoutAreaAcres / programResult.programmableAreaAcres) * 100 : 0

  const drawableResidentialCapacity = lotCells.length + developmentPads.filter(p => p.useType === 'townhomes' || p.useType === 'multifamily').reduce((s, p) => s + p.estimatedUnits, 0)

  const audit: LayoutAudit = {
    overlaps: 0,
    outsideZoneSqFt: 0,
    rowConflictSqFt: 0,
    buildingConflictSqFt: 0,
    hydrologyConflictSqFt: 0,
    pavementConflictSqFt: 0
  }

  const conflictGroups = { rows: rowConstraints, buildings: buildingConstraints, hydrology: hydrologyConstraints, pavement: pavementConstraints }
  const allFeatures = [...lotCells, ...developmentPads]
  for (const f of allFeatures) {
    const conflicts = computeConflicts(f.geometry, conflictGroups)
    audit.rowConflictSqFt += round3(conflicts.row)
    audit.buildingConflictSqFt += round3(conflicts.building)
    audit.hydrologyConflictSqFt += round3(conflicts.hydrology)
    audit.pavementConflictSqFt += round3(conflicts.pavement)
  }

  for (let i = 0; i < allFeatures.length; i++) {
    for (let j = i + 1; j < allFeatures.length; j++) {
      const inter = safeTurfOp(() => turfIntersect(allFeatures[i].geometry as any, allFeatures[j].geometry as any) as GeoJSON.Feature<GeoJSON.Polygon> | null, null)
      if (inter && areaSqFt(inter) > 0.1) {
        audit.overlaps++
      }
    }
  }

  if (lotCells.length === 0 && developmentPads.length === 0) {
    warnings.push('No conceptual lots or pads could be drawn within the network-supported programmable zones.')
  }

  const allRejectionReasons: Record<string, number> = {}
  for (const a of frontageAudits) {
    for (const [k, v] of Object.entries(a.rejectionCountsByReason)) {
      allRejectionReasons[k] = (allRejectionReasons[k] || 0) + v
    }
  }

  const lotFrontageGenerationAudit: LotFrontageGenerationAudit = {
    mcpi,
    assignedSingleFamilyZoneCount: frontageAudits.length,
    eligibleRoadCount: frontageAudits.reduce((s, a) => s + a.eligibleRoadCount, 0),
    eligibleRowBoundaryFt: round3(frontageAudits.reduce((s, a) => s + a.eligibleRowBoundaryFt, 0)),
    candidateRowEdgeSegments: frontageAudits.reduce((s, a) => s + a.candidateRowEdgeSegments, 0),
    buildableSideSegments: frontageAudits.reduce((s, a) => s + a.buildableSideSegments, 0),
    directRowFrontageSegments: frontageAudits.reduce((s, a) => s + a.directRowFrontageSegments, 0),
    validConnectorSegments: frontageAudits.reduce((s, a) => s + a.validConnectorSegments, 0),
    proximityOnlySegments: frontageAudits.reduce((s, a) => s + a.proximityOnlySegments, 0),
    noAccessSegments: frontageAudits.reduce((s, a) => s + a.noAccessSegments, 0),
    rejectedRowSegments: frontageAudits.reduce((s, a) => s + a.rejectedRowSegments, 0),
    frontageCandidates: frontageAudits.reduce((s, a) => s + a.frontageCandidates, 0),
    frontageSegmentCount: frontageAudits.reduce((s, a) => s + a.frontageSegmentCount, 0),
    totalUsableFrontageFt: round3(frontageAudits.reduce((s, a) => s + a.totalUsableFrontageFt, 0)),
    totalLotFrontageFt: round3(frontageAudits.reduce((s, a) => s + a.totalLotFrontageFt, 0)),
    lotCandidatesGenerated: frontageAudits.reduce((s, a) => s + a.lotCandidatesGenerated, 0),
    lotsAccepted: frontageAudits.reduce((s, a) => s + a.lotsAccepted, 0),
    lotsRejected: frontageAudits.reduce((s, a) => s + a.lotsRejected, 0),
    lotsFromDirectRowFrontage: frontageAudits.reduce((s, a) => s + a.lotsFromDirectRowFrontage, 0),
    lotsFromValidConnector: frontageAudits.reduce((s, a) => s + a.lotsFromValidConnector, 0),
    lotsFromProximityOnly: frontageAudits.reduce((s, a) => s + a.lotsFromProximityOnly, 0),
    rejectionCountsByReason: allRejectionReasons,
    medianLotAreaSqFt: median(conceptualLotAudits.map(a => a.areaSqFt)),
    medianFrontageFt: median(conceptualLotAudits.map(a => a.frontageFt)),
    medianDepthFt: median(conceptualLotAudits.map(a => a.depthFt)),
    medianLotFrontageFt: median(conceptualLotAudits.map(a => a.frontageFt)),
    medianLotDepthFt: median(conceptualLotAudits.map(a => a.depthFt)),
    medianFrontageToRowDistanceFt: median(conceptualLotAudits.map(a => a.frontageToRowDistanceFt)),
    maxFrontageToRowDistanceFt: conceptualLotAudits.length ? Math.max(...conceptualLotAudits.map(a => a.frontageToRowDistanceFt)) : null,
    medianConnectorLengthFt: median(conceptualLotAudits.map(a => a.connectorLengthFt)),
    maxConnectorLengthFt: conceptualLotAudits.length ? Math.max(...conceptualLotAudits.map(a => a.connectorLengthFt)) : null,
    unusedProgrammableAreaAcres: round3(frontageAudits.reduce((s, a) => s + a.unusedProgrammableAreaAcres, 0)),
    terrainQueryCount: frontageAudits.reduce((s, a) => s + a.terrainQueryCount, 0),
    terrainQueryMs: round3(frontageAudits.reduce((s, a) => s + a.terrainQueryMs, 0)),
    terrainRejectedCount: frontageAudits.reduce((s, a) => s + a.terrainRejectedCount, 0),
    preferredAcceptedCount: frontageAudits.reduce((s, a) => s + a.preferredAcceptedCount, 0),
    moderateAcceptedCount: frontageAudits.reduce((s, a) => s + a.moderateAcceptedCount, 0),
    challengingAcceptedCount: frontageAudits.reduce((s, a) => s + a.challengingAcceptedCount, 0),
    insufficientAcceptedCount: frontageAudits.reduce((s, a) => s + a.insufficientAcceptedCount, 0),
    avoidOverlapRejectedCount: frontageAudits.reduce((s, a) => s + a.avoidOverlapRejectedCount, 0),
    meanTerrainPlacementScore: (() => {
      const scores = frontageAudits.map(a => a.meanTerrainPlacementScore).filter((x): x is number => x !== null)
      return scores.length ? round3(scores.reduce((s, v) => s + v, 0) / scores.length) : null
    })(),
    maxAcceptedAvoidPercent: round3(frontageAudits.reduce((s, a) => Math.max(s, a.maxAcceptedAvoidPercent), 0))
  }

  const conceptualLotAudit: ConceptualLotAuditItem[] = conceptualLotAudits

  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[LotFrontageGenerationAudit]', lotFrontageGenerationAudit)
    console.log('[RowFrontageByRoadAudit]', { mcpi, roadCount: rowAudits.length, rows: rowAudits })
    console.log('[ConceptualLotAudit]', {
      mcpi,
      sampleSize: Math.min(conceptualLotAudit.length, 20),
      lots: conceptualLotAudit.slice(0, 20)
    })
  }

  // Townhome generation is now computed once by App.tsx from stable inputs.
  // Cap generated townhome units to the townhome-share of the road-served area at the selected density.
  const townhomeTargetDensity = programResult.targetDensity ?? projectParameters?.zoningAndLots?.targetDensity ?? 6
  const townhomeServedAreaAcres = zones
    .filter(z => assignments.get(z.id) === 'townhomes')
    .reduce((s, z) => s + (z.actualRoadServedAreaAcres ?? 0), 0)
  const townhomeTargetUnitCount =
    townhomeServedAreaAcres > 0 && townhomeTargetDensity > 0
      ? Math.round(townhomeServedAreaAcres * townhomeTargetDensity)
      : null

  const townhomeInputs = {
    mcpi,
    zones: zones,
    roadRows,
    assignments,
    conflictGroups,
    allConstraints,
    parcelBoundary: constraints.parcelBoundary ?? null,
    candidateOpenAreaGeometry: constraints.candidateOpenAreaGeometry,
    targetUnitCount: townhomeTargetUnitCount,
    terrainSuitability: constraints.terrainSuitability
  }

  // Single-family target and authoritative placement result
  const singleFamilyTargetDensity = targetDensity
  const singleFamilyServedAreaAcres = zones
    .filter(z => assignments.get(z.id) === 'single-family')
    .reduce((s, z) => s + (z.actualRoadServedAreaAcres ?? 0), 0)
  const singleFamilyTargetUnitCount =
    singleFamilyServedAreaAcres > 0 && singleFamilyTargetDensity > 0
      ? Math.round(singleFamilyServedAreaAcres * singleFamilyTargetDensity)
      : null

  const selectedSingleFamily = selectedCanonical.includes('single-family')
  const singleFamilyZones = zones.filter(z => assignments.get(z.id) === 'single-family')
  const eligibleZoneCount = singleFamilyZones.length
  const assignedSingleFamilyZoneCount = singleFamilyZones.length
  const acceptedLotCount = lotCells.length
  const attemptedLotCount = frontageAudits.reduce((s, a) => s + a.lotCandidatesGenerated, 0)
  const rejectedLotCount = attemptedLotCount - acceptedLotCount
  const homeCount = buildingEnvelopes.length

  const TOL = 1
  const zoneById = new Map(zones.map(z => [z.id, z]))

  const allLotsInsideParcel = lotCells.every(l =>
    !constraints.parcelBoundary || outsideAreaSqFt(l.geometry, constraints.parcelBoundary) <= TOL
  )
  const allLotsInsideCandidateArea = lotCells.every(l =>
    !constraints.candidateOpenAreaGeometry || outsideAreaSqFt(l.geometry, constraints.candidateOpenAreaGeometry) <= TOL
  )
  const allLotsInsideAssignedZones = lotCells.every(l => {
    const zone = zoneById.get(l.zoneId)
    return !zone || outsideAreaSqFt(l.geometry, zone.geometry) <= TOL
  })

  let lotOverlapCount = 0
  for (let i = 0; i < lotCells.length; i++) {
    for (let j = i + 1; j < lotCells.length; j++) {
      if (overlapAreaSqFt(lotCells[i].geometry, lotCells[j].geometry) > TOL) lotOverlapCount++
    }
  }

  const allBuildingsInsideLots = buildingEnvelopes.every(e => {
    const lot = lotCells.find(l => l.id === e.parentLotId)
    return !lot || outsideAreaSqFt(e.geometry, lot.geometry) <= TOL
  })
  const allBuildingsInsideCandidateArea = buildingEnvelopes.every(e =>
    !constraints.candidateOpenAreaGeometry || outsideAreaSqFt(e.geometry, constraints.candidateOpenAreaGeometry) <= TOL
  )

  let buildingOverlapCount = 0
  for (let i = 0; i < buildingEnvelopes.length; i++) {
    for (let j = i + 1; j < buildingEnvelopes.length; j++) {
      if (overlapAreaSqFt(buildingEnvelopes[i].geometry, buildingEnvelopes[j].geometry) > TOL) buildingOverlapCount++
    }
  }

  const singleFamilyRejectionReasons: Record<string, number> = {}
  for (const a of frontageAudits) {
    for (const [reason, count] of Object.entries(a.rejectionCountsByReason)) {
      singleFamilyRejectionReasons[reason] = (singleFamilyRejectionReasons[reason] || 0) + count
    }
  }

  const placementStatus: SingleFamilyGenerationResult['placementStatus'] = !selectedSingleFamily
    ? 'NOT_APPLICABLE'
    : homeCount === 0
      ? 'NO_VALID_PLACEMENT'
      : singleFamilyTargetUnitCount == null || homeCount === singleFamilyTargetUnitCount
        ? 'FULL_TARGET_MET'
        : 'PARTIAL_TARGET'

  const terrainQueryCount = frontageAudits.reduce((s, a) => s + a.terrainQueryCount, 0)
  const terrainQueryMs = frontageAudits.reduce((s, a) => s + a.terrainQueryMs, 0)
  const terrainRejectedCount = frontageAudits.reduce((s, a) => s + a.terrainRejectedCount, 0)
  const preferredAcceptedCount = frontageAudits.reduce((s, a) => s + a.preferredAcceptedCount, 0)
  const moderateAcceptedCount = frontageAudits.reduce((s, a) => s + a.moderateAcceptedCount, 0)
  const challengingAcceptedCount = frontageAudits.reduce((s, a) => s + a.challengingAcceptedCount, 0)
  const insufficientAcceptedCount = frontageAudits.reduce((s, a) => s + a.insufficientAcceptedCount, 0)
  const avoidOverlapRejectedCount = frontageAudits.reduce((s, a) => s + a.avoidOverlapRejectedCount, 0)
  const meanTerrainPlacementScore = lotFrontageGenerationAudit.meanTerrainPlacementScore
  const maxAcceptedAvoidPercent = lotFrontageGenerationAudit.maxAcceptedAvoidPercent

  const placementAudit: SingleFamilyPlacementAudit = {
    mcpi,
    alternativeId: 'BALANCED',
    selectedDevelopmentTypes: selected,
    targetUnitCount: singleFamilyTargetUnitCount,
    assignedSingleFamilyZoneCount,
    eligibleZoneCount,
    attemptedLotCount,
    acceptedLotCount,
    rejectedLotCount,
    generatedSingleFamilyHomes: homeCount,
    placementStatus,
    rejectionReasons: singleFamilyRejectionReasons,
    capacityRespected: singleFamilyTargetUnitCount == null || homeCount <= singleFamilyTargetUnitCount,
    allLotsInsideParcel,
    allLotsInsideCandidateArea,
    allLotsInsideAssignedZones,
    lotOverlapCount,
    buildingOverlapCount,
    allBuildingsInsideLots,
    allBuildingsInsideCandidateArea,
    terrainQueryCount,
    terrainQueryMs,
    terrainRejectedCount,
    preferredAcceptedCount,
    moderateAcceptedCount,
    challengingAcceptedCount,
    insufficientAcceptedCount,
    avoidOverlapRejectedCount,
    meanTerrainPlacementScore,
    maxAcceptedAvoidPercent
  }

  if (import.meta.env.DEV) {
    console.log('[SingleFamilyPlacementAudit]', placementAudit)
  }

  const singleFamilyGenerationResult: SingleFamilyGenerationResult = {
    mcpi,
    status: selectedSingleFamily ? (homeCount > 0 ? 'generated' : 'empty') : 'skipped',
    placementStatus,
    targetUnitCount: singleFamilyTargetUnitCount,
    lotCount: acceptedLotCount,
    homeCount,
    acceptedLotCount,
    rejectedLotCount,
    attemptedLotCount,
    lots: lotCells,
    envelopes: buildingEnvelopes,
    placementAudit
  }

  return {
    mcpi,
    status: 'generated',
    selectedDevelopmentTypes: selected,
    assignedZoneCount: useAssignments.filter(a => a.assignedUse !== null).length,
    lotCount: lotCells.length,
    buildingEnvelopeCount: buildingEnvelopes.length,
    developmentPadCount: developmentPads.length,
    drawableResidentialCapacity,
    densityCapacityProxy: programResult.conceptualCapacity?.densityUnits ?? null,
    lotCapacityProxy: programResult.conceptualCapacity?.lotUnits ?? null,
    layoutAreaAcres: round3(layoutAreaAcres),
    layoutAreaSqFt: round3(layoutAreaSqFt),
    unusedProgrammableAreaAcres: round3(unusedProgrammableAreaAcres),
    utilizationPercent: round3(utilizationPercent),
    lotCells,
    buildingEnvelopes,
    developmentPads,
    useAssignments,
    audit,
    lotFrontageGenerationAudit,
    conceptualLotAudit,
    warnings,
    townhomeGenerationResult: null,
    townhomeInputs,
    singleFamilyGenerationResult,
    apartmentGenerationResult: apartmentResult,
    commercialGenerationResult: commercialResult
  }
} finally {
  turfCounter.clearCaller()
  generationPerformance.finish('layout')
}
}
