import { turfc as turf, safeTurfOp, recomputeCounter, generationPerformance, VERBOSE_GIS_DIAGNOSTICS } from '../lib/perf'
import { computeRedevelopmentDisturbance } from '../lib/redevelopmentContext'
import { fastAlong, fastRhumbDestination } from './fastAlong'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type { ConceptualDevelopmentZone } from './conceptualDevelopmentProgram'
import { extractFrontageRuns, FrontageRun } from './conceptualDevelopmentLayout'
import type { TerrainSuitabilityResult, TerrainPlacementEvaluation } from '../types/terrain'
import { computeTerrainPlacementEvaluation } from './terrainSuitabilityQuery'

const SQFT_PER_ACRE = 43560

function sqMetersToSqFt(m2: number): number { return m2 * 10.7639 }
function sqFtToAcres(sqft: number): number { return sqft / SQFT_PER_ACRE }

function round3(n: number): number { return Math.round(n * 1000) / 1000 }

function areaSqFt(feature: any): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

function turfIntersect(a: any, b: any): any {
  if (!a || !b) return null
  const aBbox = getFeatureBbox(a)
  const bBbox = getFeatureBbox(b)
  if (!bboxesOverlap(aBbox, bBbox)) return null
  return safeTurfOp(() => (turf as any).intersect((turf as any).featureCollection([a, b])) as any, null)
}

function turfDifference(a: any, b: any): any {
  if (!a || !b) return null
  const aBbox = getFeatureBbox(a)
  const bBbox = getFeatureBbox(b)
  if (!bboxesOverlap(aBbox, bBbox)) return a
  return safeTurfOp(() => (turf as any).difference((turf as any).featureCollection([a, b])) as any, null)
}

function overlapAreaSqFt(a: any, b: any): number {
  if (!a || !b) return 0
  const intersection = turfIntersect(a, b)
  return intersection ? areaSqFt(intersection) : 0
}

function outsideAreaSqFt(a: any, parcel: any): number {
  if (!a || !parcel) return 0
  const diff = turfDifference(a, parcel)
  return diff ? areaSqFt(diff) : 0
}

const GEOMETRY_VALIDATION_TOLERANCE_SQFT = 1

const featureBboxCache = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.Geometry, number[]>()

function getFeatureBbox(feature: any): number[] | null {
  if (!feature) return null
  const target = feature.geometry ?? feature
  if (!target) return null
  const cached = featureBboxCache.get(target)
  if (cached) return cached
  const b = safeTurfOp(() => turf.bbox(feature), null)
  if (b) {
    featureBboxCache.set(target, b)
    return b
  }
  return null
}

function bboxesOverlap(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return true
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

export interface TownhomeUnitEnvelope {
  id: string
  rowId: string
  geometry: GeoJSON.Feature<GeoJSON.Polygon>
  unitIndex: number
  frontageFt: number
  depthFt: number
  areaSqFt: number
  areaAcres: number
  frontageRoadId: string
  frontageRoadType: string
  accepted: boolean
  terrainPlacement?: TerrainPlacementEvaluation
}

export interface TownhomeRow {
  id: string
  zoneId: string
  frontageRoadId: string
  frontageRoadType: 'primary' | 'secondary' | 'existing' | 'local'
  geometry: GeoJSON.Feature<GeoJSON.Polygon>
  rowLengthFt: number
  rowDepthFt: number
  unitCount: number
  unitWidthFt: number
  orientationBearing: number
  terrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
  sourceUse: 'townhomes'
  unitEnvelopes: TownhomeUnitEnvelope[]
  areaSqFt: number
  areaAcres: number
  accepted: boolean
  rejectionReason?: string
  hardConflictCount: number
  terrainPlacement?: TerrainPlacementEvaluation
}

export interface TownhomeRowAudit {
  rowId: string
  zoneId: string
  frontageRoadId: string
  frontageRoadType: 'primary' | 'secondary' | 'existing' | 'local'
  frontageLengthFt: number
  usableRowLengthFt: number
  practicalDepthFt: number
  rowDepthFt: number
  unitWidthFt: number
  unitCount: number
  terrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
  terrainAwareType?: 'FLAT' | 'SLOPING' | 'HILLY' | 'MOUNTAINOUS'
  hardConflictCount: number
  terrainPlacement?: TerrainPlacementEvaluation
  terrainPlacementScore?: number
  accepted: boolean
  rejectionReason?: string
  discoveryIndex: number
  qualityScore: number
  selectionRank?: number
}

export interface TownhomeFrontageAudit {
  rawRoadBoundarySegments: number
  frontageRunCountBeforeMerging: number
  frontageRunCountAfterMerging: number
  totalFrontageLengthFt: number
  medianFrontageRunLengthFt: number
  minFrontageRunLengthFt: number
  maxFrontageRunLengthFt: number
  frontageRunsByRoadType: Record<string, number>
  adjacentRunsOnSameRoadCount: number
  mergeableAdjacentRunsCount: number
}

export interface TownhomeRowAdjacencyAudit {
  acceptedRowCount: number
  adjacentSameRoadPairs: number
  potentiallyMergeableRowGroups: number
  isolatedRows: number
  rowGroups: number
}

export interface TownhomeRankingEntry {
  rank: number
  roadType: 'primary' | 'secondary' | 'existing' | 'local'
  usableRowLengthFt: number
  practicalDepthFt: number
  unitCount: number
  terrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
  qualityScore: number
  terrainPlacementScore?: number
  acceptedUnderCurrentLogic: boolean
  discoveryIndex: number
}

export interface TownhomeRoadHierarchyAudit {
  primaryAcceptedRows: number
  secondaryAcceptedRows: number
  localAcceptedRows: number
  existingAcceptedRows: number
  primaryRowsWithBetterLocalOrSecondaryAlternative: number
}

export interface TownhomeTerrainAudit {
  terrainSourceMethod: string
  zoneTerrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
  rowTerrainAssessmentMethod: string
  rowTerrainSampleCount: number
  rowsWithIndependentTerrainProfile: number
  rowsUsingZoneFallback: number
}

export interface TownhomeAcceptanceRateAudit {
  candidateCount: number
  acceptedCount: number
  rejectedCount: number
  acceptanceRate: number
  rejectionReasons: Record<string, number>
  explanation?: string
}

export interface TownhomeRowGroup {
  groupId: string
  roadId: string
  roadType: 'primary' | 'secondary' | 'existing' | 'local'
  rowCount: number
  unitCount: number
  totalRowLengthFt: number
  averageGapFt: number
  terrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
}

export interface TownhomeVisualSanitySummary {
  acceptedRows: number
  units: number
  rowGroups: number
  byRoadType: Record<string, number>
  averageUnitsPerRow: number
  medianUnitsPerRow: number
  averageRowLengthFt: number
  medianRowLengthFt: number
  averageGapBetweenSameRoadRowsFt: number
  rowsOnChallengingTerrain: number
  rowsOnFavorableTerrain: number
  rowsOnModerateTerrain: number
  rowsOnLocalFrontage: number
  rowsOnSecondaryFrontage: number
  rowsOnPrimaryFrontage: number
}

export interface TownhomePlacementAudit {
  mcpi: string
  alternativeId: string
  targetUnitCount: number | null
  generatedTownhomeUnits: number
  generatedTownhomeRows: number
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  eligibleZoneCount: number
  attemptedUnitCount: number
  acceptedUnitCount: number
  rejectedUnitCount: number
  rejectionReasons: Record<string, number>
  capacityRespected: boolean
  allUnitsInsideParcel: boolean
  allUnitsInsideCandidateArea: boolean
  allUnitsInsideAssignedZones: boolean
  unitOverlapCount: number
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

export interface TownhomeGenerationResult {
  mcpi: string
  status: 'generated' | 'empty' | 'skipped'
  placementStatus: 'FULL_TARGET_MET' | 'PARTIAL_TARGET' | 'NO_VALID_PLACEMENT' | 'NOT_APPLICABLE'
  rowCount: number
  unitCount: number
  totalRowLengthFt: number
  totalLayoutAreaAcres: number
  rows: TownhomeRow[]
  unitEnvelopes: TownhomeUnitEnvelope[]
  warnings: string[]
  audit: {
    mcpi: string
    selectedTownhomes: boolean
    eligibleZoneCount: number
    frontageRunCount: number
    rowCandidates: number
    acceptedRows: number
    rejectedRows: number
    unitCount: number
    totalRowLengthFt: number
    totalLayoutAreaAcres: number
    byRoadType: Record<string, number>
    byTerrainClass: Record<string, number>
    rejectionReasons: Record<string, number>
    rowAudits: TownhomeRowAudit[]
    frontageAudit: TownhomeFrontageAudit
    adjacencyAudit: TownhomeRowAdjacencyAudit
    rankingAudit: TownhomeRankingEntry[]
    roadHierarchyAudit: TownhomeRoadHierarchyAudit
    terrainAudit: TownhomeTerrainAudit
    acceptanceRateAudit: TownhomeAcceptanceRateAudit
    rowGroups: TownhomeRowGroup[]
    visualSanitySummary: TownhomeVisualSanitySummary
  }
}

export interface TownhomeGeneratorInput {
  mcpi: string
  zones: ConceptualDevelopmentZone[]
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[]
  assignments: Map<string, string | null>
  conflictGroups: { rows: any[]; buildings: any[]; hydrology: any[]; pavement: any[] }
  allConstraints: GeoJSON.Feature<GeoJSON.Polygon>[]
  parcelBoundary?: GeoJSON.Feature<GeoJSON.Geometry> | null
  candidateOpenAreaGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  alternativeId?: string
  signal?: AbortSignal
  targetUnitCount?: number | null
  terrainSuitability?: TerrainSuitabilityResult | null
}

// Conceptual constants (not legal/zoning standards)
const CONCEPTUAL_FRONT_SETBACK_FT = 10
const CONCEPTUAL_ROW_DEPTH_FT = 45
const CONCEPTUAL_UNIT_WIDTH_FT = 22
const CONCEPTUAL_MIN_ROW_LENGTH_FT = 40
const CONCEPTUAL_MIN_UNITS_PER_ROW = 2
const CONCEPTUAL_MAX_UNITS_PER_ROW = 8

function computeAvailableGeometry(
  zone: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  constraints: GeoJSON.Feature<GeoJSON.Polygon>[],
  candidateOpenAreaGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  let current: any = zone
  if (candidateOpenAreaGeometry?.geometry) {
    const clipped = turfIntersect(current, candidateOpenAreaGeometry)
    if (clipped && areaSqFt(clipped) > 0) current = clipped
    else if (!clipped) return null
  }
  for (const c of constraints) {
    if (!c.geometry) continue
    const next = turfDifference(current, c)
    if (next && areaSqFt(next) > 0) {
      current = next
    } else if (!next) {
      return null
    }
  }
  return current
}

function offsetPoint(coord: number[], distanceFt: number, bearing: number): number[] {
  const dest = fastRhumbDestination(coord, distanceFt, 'feet', bearing)
  return dest ? (dest as any).geometry.coordinates : coord
}

function buildRowPolygon(run: FrontageRun): GeoJSON.Feature<GeoJSON.Polygon> | null {
  const coords = run.geometry.coordinates
  if (coords.length < 2) return null
  const p0 = coords[0]
  const p1 = coords[coords.length - 1]
  const inward = run.properties.inwardBearing
  const frontSetback = CONCEPTUAL_FRONT_SETBACK_FT
  const depth = CONCEPTUAL_ROW_DEPTH_FT
  const f0 = offsetPoint(p0, frontSetback, inward)
  const f1 = offsetPoint(p1, frontSetback, inward)
  const r0 = offsetPoint(p0, frontSetback + depth, inward)
  const r1 = offsetPoint(p1, frontSetback + depth, inward)
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[f0, f1, r1, r0, f0]] }
  }
}

function splitRowIntoUnits(row: TownhomeRow, frontLine: number[][], rearLine: number[][], frontLength: number): TownhomeUnitEnvelope[] {
  const maxUnits = Math.min(CONCEPTUAL_MAX_UNITS_PER_ROW, Math.floor(frontLength / CONCEPTUAL_UNIT_WIDTH_FT))
  if (maxUnits < CONCEPTUAL_MIN_UNITS_PER_ROW) return []
  const adjustedWidth = frontLength / maxUnits
  const frontLineString = (turf as any).lineString(frontLine)
  const rearLineString = (turf as any).lineString(rearLine)
  const units: TownhomeUnitEnvelope[] = []
  for (let i = 0; i < maxUnits; i++) {
    const start = i * adjustedWidth
    const end = (i + 1) * adjustedWidth
    const fS = fastAlong(frontLineString, start, 'feet')
    const fE = fastAlong(frontLineString, end, 'feet')
    const rS = fastAlong(rearLineString, start, 'feet')
    const rE = fastAlong(rearLineString, end, 'feet')
    if (!fS || !fE || !rS || !rE) continue
    const geom = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          fS.geometry.coordinates,
          fE.geometry.coordinates,
          rE.geometry.coordinates,
          rS.geometry.coordinates,
          fS.geometry.coordinates
        ]]
      }
    } as GeoJSON.Feature<GeoJSON.Polygon>
    units.push({
      id: `${row.id}-U${i}`,
      rowId: row.id,
      geometry: geom,
      unitIndex: i,
      frontageFt: round3(adjustedWidth),
      depthFt: row.rowDepthFt,
      areaSqFt: round3(areaSqFt(geom)),
      areaAcres: round3(sqFtToAcres(areaSqFt(geom))),
      frontageRoadId: row.frontageRoadId,
      frontageRoadType: row.frontageRoadType,
      accepted: true
    })
  }
  return units
}

function computeQualityScore(
  frontLengthFt: number,
  practicalDepthFt: number,
  unitCount: number,
  roadType: string,
  terrainAssessment: string,
  hardConflictCount: number,
  terrainPlacementScore?: number,
  rowGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
): number {
  let score = 0
  score += Math.min(frontLengthFt / 200, 1) * 25
  score += Math.min(practicalDepthFt / 45, 1) * 20
  score += (Math.min(unitCount, 8) / 8) * 20
  if (roadType === 'local') score += 10
  else if (roadType === 'secondary') score += 5
  if (terrainAssessment === 'FAVORABLE') score += 15
  else if (terrainAssessment === 'MODERATE') score += 10
  else if (terrainAssessment === 'INSUFFICIENT_DATA') score += 2
  if (roadType === 'primary') score -= 5
  if (frontLengthFt < 60) score -= 5
  if (terrainAssessment === 'CHALLENGING') score -= 5
  if (typeof terrainPlacementScore === 'number') {
    score += terrainPlacementScore * 15
  }
  score -= Math.min(hardConflictCount, 5) * 2

  if (rowGeometry) {
    const rd = computeRedevelopmentDisturbance(rowGeometry)
    score -= rd.totalPenalty * 0.01
  }

  return Math.max(0, round3(score))
}

function computeTownhomeGeometryIntegrityAudit(
  rows: TownhomeRow[],
  unitEnvelopes: TownhomeUnitEnvelope[],
  parcelBoundary: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[],
  hardConstraints: GeoJSON.Feature<GeoJSON.Polygon>[]
) {
  const TOL = GEOMETRY_VALIDATION_TOLERANCE_SQFT

  const roadsByType = (type: string) => roadRows.filter(r => r.roadType === type).map(r => r.row)
  const primaryROW = roadsByType('primary')
  const secondaryROW = roadsByType('secondary')
  const localROW = roadsByType('local')

  function outsideArea(feature: any): number {
    return parcelBoundary ? outsideAreaSqFt(feature, parcelBoundary) : 0
  }

  function roadOverlapOfType(feature: any, type: string): number {
    const roads = type === 'primary' ? primaryROW : type === 'secondary' ? secondaryROW : type === 'local' ? localROW : []
    return roads.reduce((s, r) => s + overlapAreaSqFt(feature, r), 0)
  }

  function hardConstraintOverlap(feature: any): number {
    return hardConstraints.reduce((s, c) => s + overlapAreaSqFt(feature, c), 0)
  }

  let rowOutsideParcelAreaSqFt = 0
  let unitOutsideParcelAreaSqFt = 0
  let rowPrimaryROWOverlapAreaSqFt = 0
  let rowSecondaryROWOverlapAreaSqFt = 0
  let rowLocalROWOverlapAreaSqFt = 0
  let unitPrimaryROWOverlapAreaSqFt = 0
  let unitSecondaryROWOverlapAreaSqFt = 0
  let unitLocalROWOverlapAreaSqFt = 0

  const invalidDetails: { id: string; type: 'row' | 'unit'; violation: string; areaSqFt: number }[] = []
  const invalidRowIds = new Set<string>()

  for (const r of rows) {
    const outside = outsideArea(r.geometry)
    const primary = roadOverlapOfType(r.geometry, 'primary')
    const secondary = roadOverlapOfType(r.geometry, 'secondary')
    const local = roadOverlapOfType(r.geometry, 'local')
    const hard = hardConstraintOverlap(r.geometry)

    rowOutsideParcelAreaSqFt += outside
    rowPrimaryROWOverlapAreaSqFt += primary
    rowSecondaryROWOverlapAreaSqFt += secondary
    rowLocalROWOverlapAreaSqFt += local

    if (outside > TOL || primary > TOL || secondary > TOL || local > TOL || hard > TOL) {
      invalidRowIds.add(r.id)
      if (outside > TOL) invalidDetails.push({ id: r.id, type: 'row', violation: 'outside-parcel', areaSqFt: round3(outside) })
      if (primary > TOL) invalidDetails.push({ id: r.id, type: 'row', violation: 'overlap-primary-row', areaSqFt: round3(primary) })
      if (secondary > TOL) invalidDetails.push({ id: r.id, type: 'row', violation: 'overlap-secondary-row', areaSqFt: round3(secondary) })
      if (local > TOL) invalidDetails.push({ id: r.id, type: 'row', violation: 'overlap-local-row', areaSqFt: round3(local) })
      if (hard > TOL) invalidDetails.push({ id: r.id, type: 'row', violation: 'hard-constraint', areaSqFt: round3(hard) })
    }
  }

  const rowById = new Map(rows.map(r => [r.id, r]))
  const invalidUnitIds = new Set<string>()

  for (const u of unitEnvelopes) {
    const outside = outsideArea(u.geometry)
    const primary = roadOverlapOfType(u.geometry, 'primary')
    const secondary = roadOverlapOfType(u.geometry, 'secondary')
    const local = roadOverlapOfType(u.geometry, 'local')
    const hard = hardConstraintOverlap(u.geometry)
    const parentRow = rowById.get(u.rowId)
    const outsideParent = parentRow ? outsideAreaSqFt(u.geometry, parentRow.geometry) : 0

    unitOutsideParcelAreaSqFt += outside
    unitPrimaryROWOverlapAreaSqFt += primary
    unitSecondaryROWOverlapAreaSqFt += secondary
    unitLocalROWOverlapAreaSqFt += local

    if (outside > TOL || primary > TOL || secondary > TOL || local > TOL || hard > TOL || outsideParent > TOL) {
      invalidUnitIds.add(u.id)
      if (outside > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'outside-parcel', areaSqFt: round3(outside) })
      if (primary > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'overlap-primary-row', areaSqFt: round3(primary) })
      if (secondary > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'overlap-secondary-row', areaSqFt: round3(secondary) })
      if (local > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'overlap-local-row', areaSqFt: round3(local) })
      if (hard > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'hard-constraint', areaSqFt: round3(hard) })
      if (outsideParent > TOL) invalidDetails.push({ id: u.id, type: 'unit', violation: 'outside-parent-row', areaSqFt: round3(outsideParent) })
    }
  }

  let rowsOverlappingRows = 0
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (overlapAreaSqFt(rows[i].geometry, rows[j].geometry) > TOL) rowsOverlappingRows++
    }
  }

  let unitsOverlappingUnits = 0
  for (let i = 0; i < unitEnvelopes.length; i++) {
    for (let j = i + 1; j < unitEnvelopes.length; j++) {
      if (overlapAreaSqFt(unitEnvelopes[i].geometry, unitEnvelopes[j].geometry) > TOL) unitsOverlappingUnits++
    }
  }

  const rowGeometryStrings = rows.map(r => JSON.stringify(r.geometry.geometry?.coordinates))
  const duplicateRowGeometryCount = rowGeometryStrings.length - new Set(rowGeometryStrings).size

  const unitGeometryStrings = unitEnvelopes.map(u => JSON.stringify(u.geometry.geometry?.coordinates))
  const duplicateUnitGeometryCount = unitGeometryStrings.length - new Set(unitGeometryStrings).size

  const countOverlapByType = (feature: any, type: string) => roadOverlapOfType(feature, type) > TOL ? 1 : 0

  const allValid =
    rowOutsideParcelAreaSqFt <= TOL &&
    unitOutsideParcelAreaSqFt <= TOL &&
    rowPrimaryROWOverlapAreaSqFt <= TOL &&
    rowSecondaryROWOverlapAreaSqFt <= TOL &&
    rowLocalROWOverlapAreaSqFt <= TOL &&
    unitPrimaryROWOverlapAreaSqFt <= TOL &&
    unitSecondaryROWOverlapAreaSqFt <= TOL &&
    unitLocalROWOverlapAreaSqFt <= TOL &&
    rowsOverlappingRows === 0 &&
    unitsOverlappingUnits === 0 &&
    duplicateRowGeometryCount === 0 &&
    duplicateUnitGeometryCount === 0

  return {
    rowsOutsideParcel: invalidRowIds.size,
    unitsOutsideParcel: invalidUnitIds.size,
    rowOutsideParcelAreaSqFt: round3(rowOutsideParcelAreaSqFt),
    unitOutsideParcelAreaSqFt: round3(unitOutsideParcelAreaSqFt),
    rowsOverlappingPrimaryROW: rows.reduce((s, r) => s + countOverlapByType(r.geometry, 'primary'), 0),
    rowsOverlappingSecondaryROW: rows.reduce((s, r) => s + countOverlapByType(r.geometry, 'secondary'), 0),
    rowsOverlappingLocalROW: rows.reduce((s, r) => s + countOverlapByType(r.geometry, 'local'), 0),
    unitsOverlappingPrimaryROW: unitEnvelopes.reduce((s, u) => s + countOverlapByType(u.geometry, 'primary'), 0),
    unitsOverlappingSecondaryROW: unitEnvelopes.reduce((s, u) => s + countOverlapByType(u.geometry, 'secondary'), 0),
    unitsOverlappingLocalROW: unitEnvelopes.reduce((s, u) => s + countOverlapByType(u.geometry, 'local'), 0),
    rowPrimaryROWOverlapAreaSqFt: round3(rowPrimaryROWOverlapAreaSqFt),
    rowSecondaryROWOverlapAreaSqFt: round3(rowSecondaryROWOverlapAreaSqFt),
    rowLocalROWOverlapAreaSqFt: round3(rowLocalROWOverlapAreaSqFt),
    unitPrimaryROWOverlapAreaSqFt: round3(unitPrimaryROWOverlapAreaSqFt),
    unitSecondaryROWOverlapAreaSqFt: round3(unitSecondaryROWOverlapAreaSqFt),
    unitLocalROWOverlapAreaSqFt: round3(unitLocalROWOverlapAreaSqFt),
    rowsOverlappingRows,
    unitsOverlappingUnits,
    duplicateRowGeometryCount,
    duplicateUnitGeometryCount,
    invalidRowIds: [...invalidRowIds],
    invalidUnitIds: [...invalidUnitIds],
    invalidDetails,
    allValid
  }
}

function validateTownhomeRow(
  row: TownhomeRow,
  zoneGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null | undefined,
  candidateOpenAreaGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  parcelBoundary: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[],
  hardConstraints: GeoJSON.Feature<GeoJSON.Polygon>[]
): { valid: boolean; reason?: string; details: { outsideSqFt: number; outsideZoneSqFt: number; outsideCandidateSqFt: number; primaryOverlapSqFt: number; secondaryOverlapSqFt: number; localOverlapSqFt: number; hardOverlapSqFt: number } } {
  const TOL = GEOMETRY_VALIDATION_TOLERANCE_SQFT
  const outsideSqFt = parcelBoundary ? outsideAreaSqFt(row.geometry, parcelBoundary) : 0
  const outsideZoneSqFt = zoneGeometry ? outsideAreaSqFt(row.geometry, zoneGeometry) : 0
  const outsideCandidateSqFt = candidateOpenAreaGeometry ? outsideAreaSqFt(row.geometry, candidateOpenAreaGeometry) : 0
  const rowBbox = safeTurfOp(() => (turf as any).bbox(row.geometry), null)

  function rowMayOverlap(_other: any, otherBbox: any): boolean {
    if (!rowBbox || !otherBbox) return true
    return bboxesOverlap(rowBbox, otherBbox)
  }

  const primaryOverlapSqFt = roadRows
    .filter(r => r.roadType === 'primary' && rowMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(row.geometry, r.row), 0)
  const secondaryOverlapSqFt = roadRows
    .filter(r => r.roadType === 'secondary' && rowMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(row.geometry, r.row), 0)
  const localOverlapSqFt = roadRows
    .filter(r => r.roadType === 'local' && rowMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(row.geometry, r.row), 0)
  const hardOverlapSqFt = hardConstraints
    .filter(c => rowMayOverlap(c, (c as any).bbox))
    .reduce((s, c) => s + overlapAreaSqFt(row.geometry, c), 0)

  const details = {
    outsideSqFt: round3(outsideSqFt),
    outsideZoneSqFt: round3(outsideZoneSqFt),
    outsideCandidateSqFt: round3(outsideCandidateSqFt),
    primaryOverlapSqFt: round3(primaryOverlapSqFt),
    secondaryOverlapSqFt: round3(secondaryOverlapSqFt),
    localOverlapSqFt: round3(localOverlapSqFt),
    hardOverlapSqFt: round3(hardOverlapSqFt)
  }

  if (outsideSqFt > TOL) return { valid: false, reason: 'outside-parcel', details }
  if (outsideZoneSqFt > TOL) return { valid: false, reason: 'outside-assigned-zone', details }
  if (outsideCandidateSqFt > TOL) return { valid: false, reason: 'outside-candidate-area', details }
  if (primaryOverlapSqFt > TOL) return { valid: false, reason: 'overlap-primary-row', details }
  if (secondaryOverlapSqFt > TOL) return { valid: false, reason: 'overlap-secondary-row', details }
  if (localOverlapSqFt > TOL) return { valid: false, reason: 'overlap-local-row', details }
  if (hardOverlapSqFt > TOL) return { valid: false, reason: 'hard-constraint', details }

  return { valid: true, details }
}

function validateTownhomeUnit(
  unit: TownhomeUnitEnvelope,
  parentRow: TownhomeRow,
  zoneGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null | undefined,
  candidateOpenAreaGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  parcelBoundary: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  roadRows: { roadId: string; roadType: 'primary' | 'secondary' | 'existing' | 'local'; row: any; centerline: any }[],
  hardConstraints: GeoJSON.Feature<GeoJSON.Polygon>[]
): { valid: boolean; reason?: string; details: { outsideSqFt: number; outsideZoneSqFt: number; outsideCandidateSqFt: number; outsideParentSqFt: number; primaryOverlapSqFt: number; secondaryOverlapSqFt: number; localOverlapSqFt: number; hardOverlapSqFt: number } } {
  const TOL = GEOMETRY_VALIDATION_TOLERANCE_SQFT
  const outsideSqFt = parcelBoundary ? outsideAreaSqFt(unit.geometry, parcelBoundary) : 0
  const outsideZoneSqFt = zoneGeometry ? outsideAreaSqFt(unit.geometry, zoneGeometry) : 0
  const outsideCandidateSqFt = candidateOpenAreaGeometry ? outsideAreaSqFt(unit.geometry, candidateOpenAreaGeometry) : 0
  const outsideParentSqFt = outsideAreaSqFt(unit.geometry, parentRow.geometry)
  const unitBbox = safeTurfOp(() => (turf as any).bbox(unit.geometry), null)

  function unitMayOverlap(_other: any, otherBbox: any): boolean {
    if (!unitBbox || !otherBbox) return true
    return bboxesOverlap(unitBbox, otherBbox)
  }

  const primaryOverlapSqFt = roadRows
    .filter(r => r.roadType === 'primary' && unitMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(unit.geometry, r.row), 0)
  const secondaryOverlapSqFt = roadRows
    .filter(r => r.roadType === 'secondary' && unitMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(unit.geometry, r.row), 0)
  const localOverlapSqFt = roadRows
    .filter(r => r.roadType === 'local' && unitMayOverlap(r, (r as any).bbox))
    .reduce((s, r) => s + overlapAreaSqFt(unit.geometry, r.row), 0)
  const hardOverlapSqFt = hardConstraints
    .filter(c => unitMayOverlap(c, (c as any).bbox))
    .reduce((s, c) => s + overlapAreaSqFt(unit.geometry, c), 0)

  const details = {
    outsideSqFt: round3(outsideSqFt),
    outsideZoneSqFt: round3(outsideZoneSqFt),
    outsideCandidateSqFt: round3(outsideCandidateSqFt),
    outsideParentSqFt: round3(outsideParentSqFt),
    primaryOverlapSqFt: round3(primaryOverlapSqFt),
    secondaryOverlapSqFt: round3(secondaryOverlapSqFt),
    localOverlapSqFt: round3(localOverlapSqFt),
    hardOverlapSqFt: round3(hardOverlapSqFt)
  }

  if (outsideSqFt > TOL) return { valid: false, reason: 'outside-parcel', details }
  if (outsideZoneSqFt > TOL) return { valid: false, reason: 'outside-assigned-zone', details }
  if (outsideCandidateSqFt > TOL) return { valid: false, reason: 'outside-candidate-area', details }
  if (outsideParentSqFt > TOL) return { valid: false, reason: 'outside-parent-row', details }
  if (primaryOverlapSqFt > TOL) return { valid: false, reason: 'overlap-primary-row', details }
  if (secondaryOverlapSqFt > TOL) return { valid: false, reason: 'overlap-secondary-row', details }
  if (localOverlapSqFt > TOL) return { valid: false, reason: 'overlap-local-row', details }
  if (hardOverlapSqFt > TOL) return { valid: false, reason: 'hard-constraint', details }

  return { valid: true, details }
}

export async function generateConceptualTownhomes(input: TownhomeGeneratorInput): Promise<TownhomeGenerationResult> {
  recomputeCounter.increment('townhome')
  generationPerformance.start('townhome')
  try {
  const { mcpi, zones, roadRows, assignments, conflictGroups, allConstraints, parcelBoundary, candidateOpenAreaGeometry, alternativeId, signal, targetUnitCount, terrainSuitability } = input
  const zoneById = new Map(zones.map(z => [z.id, z]))

  // Precompute bounding boxes once for all road rows and hard constraints.
  // This lets overlap checks reject non-overlapping pairs before expensive Turf boolean operations.
  for (const r of roadRows as any) {
    r.bbox = safeTurfOp(() => (turf as any).bbox(r.row), null)
  }
  for (const c of allConstraints as any) {
    c.bbox = safeTurfOp(() => (turf as any).bbox(c), null)
  }

  const warnings: string[] = []
  let rows: TownhomeRow[] = []
  const rowAudits: TownhomeRowAudit[] = []
  const allFrontageRuns: { run: FrontageRun; lengthFt: number }[] = []
  let candidateId = 0
  let eligibleZoneCount = 0
  let frontageRunCount = 0
  let rowCandidates = 0
  let acceptedRows = 0
  let rejectedRows = 0
  let totalUnitCount = 0
  let attemptedUnitCount = 0
  let totalRowLength = 0
  let totalLayoutArea = 0
  let capacityLimit = targetUnitCount ?? null
  let capacityReached = false
  const byRoadType: Record<string, number> = { primary: 0, secondary: 0, existing: 0, local: 0 }
  const byTerrainClass: Record<string, number> = { FAVORABLE: 0, MODERATE: 0, CHALLENGING: 0, INSUFFICIENT_DATA: 0 }
  const rejectionReasons: Record<string, number> = {}

  let terrainQueryCount = 0
  let terrainQueryMs = 0
  let terrainRejectedCount = 0
  let preferredAcceptedCount = 0
  let moderateAcceptedCount = 0
  let challengingAcceptedCount = 0
  let insufficientAcceptedCount = 0
  let avoidOverlapRejectedCount = 0
  const rowPlacementScores: number[] = []
  let maxAcceptedAvoidPercent = 0
  let currentRowPlacement: TerrainPlacementEvaluation | undefined

  const selectedTownhomes = [...assignments.values()].some(u => u === 'townhomes')

  if (!selectedTownhomes) {
    return {
      mcpi,
      status: 'skipped',
      placementStatus: 'NOT_APPLICABLE',
      rowCount: 0,
      unitCount: 0,
      totalRowLengthFt: 0,
      totalLayoutAreaAcres: 0,
      rows: [],
      unitEnvelopes: [],
      warnings: ['Townhomes not selected for this run.'],
      audit: {
        mcpi,
        selectedTownhomes,
        eligibleZoneCount: 0,
        frontageRunCount: 0,
        rowCandidates: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        unitCount: 0,
        totalRowLengthFt: 0,
        totalLayoutAreaAcres: 0,
        byRoadType,
        byTerrainClass,
        rejectionReasons,
        rowAudits,
        frontageAudit: {
          rawRoadBoundarySegments: 0,
          frontageRunCountBeforeMerging: 0,
          frontageRunCountAfterMerging: 0,
          totalFrontageLengthFt: 0,
          medianFrontageRunLengthFt: 0,
          minFrontageRunLengthFt: 0,
          maxFrontageRunLengthFt: 0,
          frontageRunsByRoadType: { primary: 0, secondary: 0, existing: 0, local: 0 },
          adjacentRunsOnSameRoadCount: 0,
          mergeableAdjacentRunsCount: 0
        },
        adjacencyAudit: {
          acceptedRowCount: 0,
          adjacentSameRoadPairs: 0,
          potentiallyMergeableRowGroups: 0,
          isolatedRows: 0,
          rowGroups: 0
        },
        rankingAudit: [],
        roadHierarchyAudit: {
          primaryAcceptedRows: 0,
          secondaryAcceptedRows: 0,
          localAcceptedRows: 0,
          existingAcceptedRows: 0,
          primaryRowsWithBetterLocalOrSecondaryAlternative: 0
        },
        terrainAudit: {
          terrainSourceMethod: 'n/a - townhomes not selected',
          zoneTerrainAssessment: 'INSUFFICIENT_DATA',
          rowTerrainAssessmentMethod: 'n/a - townhomes not selected',
          rowTerrainSampleCount: 0,
          rowsWithIndependentTerrainProfile: 0,
          rowsUsingZoneFallback: 0
        },
        acceptanceRateAudit: {
          candidateCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          acceptanceRate: 0,
          rejectionReasons: { NO_ACCESS: 0, INSUFFICIENT_LENGTH: 0, GEOMETRY_FAILURE: 0, INSUFFICIENT_DEPTH: 0, OVERLAP: 0, NO_UNITS: 0, TERRAIN: 0, HARD_CONSTRAINT: 0, INTERSECTION_CLEARANCE: 0, OTHER: 0 }
        },
        rowGroups: [],
        visualSanitySummary: {
          acceptedRows: 0,
          units: 0,
          rowGroups: 0,
          byRoadType: { primary: 0, secondary: 0, existing: 0, local: 0 },
          averageUnitsPerRow: 0,
          medianUnitsPerRow: 0,
          averageRowLengthFt: 0,
          medianRowLengthFt: 0,
          averageGapBetweenSameRoadRowsFt: 0,
          rowsOnChallengingTerrain: 0,
          rowsOnFavorableTerrain: 0,
          rowsOnModerateTerrain: 0,
          rowsOnLocalFrontage: 0,
          rowsOnSecondaryFrontage: 0,
          rowsOnPrimaryFrontage: 0
        }
      }
    }
  }

  const placedRowGeometries: GeoJSON.Feature<GeoJSON.Polygon>[] = []

  let zoneIndex = 0
  for (const zone of zones) {
    if (capacityReached) break
    if (signal?.aborted) throw new Error('Generation aborted')
    if (zoneIndex % 2 === 0) await yieldIfNeeded(signal)
    zoneIndex++
    const assignedUse = assignments.get(zone.id)
    if (assignedUse !== 'townhomes') continue
    if (zone.programStatus !== 'PROGRAMMABLE') continue
    const compat = zone.compatibilityByUse?.townhomes
    if (compat === 'UNSUITABLE') continue
    if (zone.roadRelationship === 'LATENT') continue
    eligibleZoneCount++

    const zoneClipped = parcelBoundary
      ? turfIntersect(zone.geometry, parcelBoundary)
      : zone.geometry
    if (!zoneClipped || areaSqFt(zoneClipped) < 1000) {
      warnings.push(`Zone ${zone.id} lies outside the selected parent parcel boundary.`)
      continue
    }
    const available = computeAvailableGeometry(zoneClipped, allConstraints, candidateOpenAreaGeometry)
    if (!available || areaSqFt(available) < 1000) {
      warnings.push(`Zone ${zone.id} has no available geometry for townhome row generation.`)
      continue
    }

    const runs = extractFrontageRuns(zone, available, roadRows, conflictGroups)
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      if (capacityReached) break
      if (signal?.aborted) throw new Error('Generation aborted')
      if (runIndex % 2 === 0) await yieldIfNeeded(signal)
      const run = runs[runIndex]
      frontageRunCount++
      const frontLength = round3(safeTurfOp(() => (turf as any).length(run, { units: 'feet' }), 0))
      allFrontageRuns.push({ run, lengthFt: frontLength })
      const discoveryIndex = rowAudits.length

      if (run.properties.frontageClassification === 'NO_ACCESS') {
        rejectedRows++
        const reason = 'NO_ACCESS'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: computeQualityScore(frontLength, 0, 0, run.properties.roadType, zone.terrainAssessment, 0)
        })
        continue
      }

      rowCandidates++
      if (frontLength < CONCEPTUAL_MIN_ROW_LENGTH_FT) {
        rejectedRows++
        const reason = 'INSUFFICIENT_LENGTH'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: computeQualityScore(frontLength, 0, 0, run.properties.roadType, zone.terrainAssessment, 0)
        })
        continue
      }

      const rowGeomRaw = buildRowPolygon(run)
      if (!rowGeomRaw) {
        rejectedRows++
        const reason = 'GEOMETRY_FAILURE'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: 0
        })
        continue
      }

      let rowClipped = turfIntersect(rowGeomRaw, available)
      if (!rowClipped || areaSqFt(rowClipped) < 1) {
        rejectedRows++
        const reason = 'INSUFFICIENT_DEPTH'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: 0
        })
        continue
      }

      const rowBbox = safeTurfOp(() => (turf as any).bbox(rowClipped), null)
      for (const placed of placedRowGeometries) {
        if (rowBbox && (placed as any).bbox && !bboxesOverlap(rowBbox, (placed as any).bbox)) continue
        const noOverlap = turfDifference(rowClipped, placed)
        if (noOverlap && areaSqFt(noOverlap) > 0) {
          rowClipped = noOverlap
        } else {
          rowClipped = null
          break
        }
      }

      if (!rowClipped || areaSqFt(rowClipped) < 1) {
        rejectedRows++
        const reason = 'OVERLAP'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: 0
        })
        continue
      }

      const rowClippedBbox = getFeatureBbox(rowClipped)
      const relevantHardConstraints = (allConstraints as any[]).filter(c => bboxesOverlap(rowClippedBbox, c.bbox))
      const relevantRoadRows = (roadRows as any[]).filter(r => bboxesOverlap(rowClippedBbox, r.bbox))

      const t0 = performance.now()
      const rowPlacement = computeTerrainPlacementEvaluation(rowClipped, terrainSuitability)
      terrainQueryCount++
      terrainQueryMs += performance.now() - t0
      currentRowPlacement = rowPlacement

      if (rowPlacement.avoidRejection) {
        rejectedRows++
        const reason = 'TERRAIN'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        avoidOverlapRejectedCount++
        terrainRejectedCount++
        rowAudits.push({
          rowId: `TH-C${candidateId++}`,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: 0,
          practicalDepthFt: 0,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          terrainPlacement: rowPlacement,
          terrainPlacementScore: rowPlacement.placementScore,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: 0
        })
        if (rowPlacement.warning) warnings.push(rowPlacement.warning)
        continue
      }

      if (rowPlacement.dominantClass === 'PREFERRED') preferredAcceptedCount++
      else if (rowPlacement.dominantClass === 'MODERATE') moderateAcceptedCount++
      else if (rowPlacement.dominantClass === 'CHALLENGING') challengingAcceptedCount++
      else if (rowPlacement.dominantClass === 'INSUFFICIENT_DATA') insufficientAcceptedCount++
      rowPlacementScores.push(rowPlacement.placementScore)
      maxAcceptedAvoidPercent = Math.max(maxAcceptedAvoidPercent, rowPlacement.avoidPercent)
      if (rowPlacement.warning) warnings.push(rowPlacement.warning)

      const rowId = `TH-C${candidateId++}`
      const rowArea = areaSqFt(rowClipped)
      const rowAreaAcres = sqFtToAcres(rowArea)
      const practicalDepth = frontLength > 0 ? round3(rowArea / frontLength) : 0
      const frontLine = [rowGeomRaw.geometry.coordinates[0][0], rowGeomRaw.geometry.coordinates[0][1]]
      const rearLine = [rowGeomRaw.geometry.coordinates[0][3], rowGeomRaw.geometry.coordinates[0][2]]
      const row: TownhomeRow = {
        id: rowId,
        zoneId: zone.id,
        frontageRoadId: run.properties.roadId,
        frontageRoadType: run.properties.roadType,
        geometry: rowClipped,
        rowLengthFt: round3(frontLength),
        rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
        unitCount: 0,
        unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
        orientationBearing: run.properties.roadBearing,
        terrainAssessment: zone.terrainAssessment,
        sourceUse: 'townhomes',
        unitEnvelopes: [],
        areaSqFt: round3(rowArea),
        areaAcres: round3(rowAreaAcres),
        accepted: true,
        hardConflictCount: 0,
        terrainPlacement: currentRowPlacement
      }

      const rowZone = zoneById.get(row.zoneId)
      const rowValidation = validateTownhomeRow(row, (rowZone?.geometry ?? null) as any, candidateOpenAreaGeometry, parcelBoundary, relevantRoadRows, relevantHardConstraints)
      if (!rowValidation.valid) {
        rejectedRows++
        const reason = 'HARD_CONSTRAINT'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: round3(frontLength),
          practicalDepthFt: practicalDepth,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          terrainPlacement: currentRowPlacement,
          terrainPlacementScore: currentRowPlacement?.placementScore,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: computeQualityScore(frontLength, practicalDepth, 0, run.properties.roadType, zone.terrainAssessment, 0, currentRowPlacement?.placementScore)
        })
        continue
      }

      const rawUnits = splitRowIntoUnits(row, frontLine, rearLine, frontLength)
      attemptedUnitCount += rawUnits.length
      const units: TownhomeUnitEnvelope[] = []
      for (let unitIndex = 0; unitIndex < rawUnits.length; unitIndex++) {
        if (signal?.aborted) throw new Error('Generation aborted')
        if (unitIndex % 10 === 0) await yieldIfNeeded(signal)
        const u = rawUnits[unitIndex]
        const clipped = turfIntersect(u.geometry, rowClipped)
        if (!clipped || areaSqFt(clipped) < 1) continue
        const clippedArea = areaSqFt(clipped)
        if (clippedArea < u.areaSqFt * 0.5) continue
        const t1 = performance.now()
        const unitPlacement = computeTerrainPlacementEvaluation(clipped, terrainSuitability)
        terrainQueryCount++
        terrainQueryMs += performance.now() - t1
        if (unitPlacement.avoidRejection) {
          avoidOverlapRejectedCount++
          continue
        }
        const withGeometry = {
          ...u,
          geometry: clipped,
          areaSqFt: round3(clippedArea),
          areaAcres: round3(sqFtToAcres(clippedArea)),
          terrainPlacement: unitPlacement
        }
        const unitValidation = validateTownhomeUnit(withGeometry, row, (rowZone?.geometry ?? null) as any, candidateOpenAreaGeometry, parcelBoundary, relevantRoadRows, relevantHardConstraints)
        if (!unitValidation.valid) continue
        if (unitPlacement.warning) warnings.push(unitPlacement.warning)
        units.push(withGeometry)
      }

      // Apply authoritative unit-cap before accepting the row
      const remainingCapacity = capacityLimit != null ? Math.max(0, capacityLimit - totalUnitCount) : Infinity
      if (remainingCapacity <= 0) {
        capacityReached = true
        break
      }
      const cappedUnits = remainingCapacity < units.length ? units.slice(0, remainingCapacity) : units

      if (cappedUnits.length < CONCEPTUAL_MIN_UNITS_PER_ROW && cappedUnits.length !== remainingCapacity) {
        rejectedRows++
        const reason = 'NO_UNITS'
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
        rowAudits.push({
          rowId,
          zoneId: zone.id,
          frontageRoadId: run.properties.roadId,
          frontageRoadType: run.properties.roadType,
          frontageLengthFt: round3(frontLength),
          usableRowLengthFt: round3(frontLength),
          practicalDepthFt: practicalDepth,
          rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
          unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
          unitCount: 0,
          terrainAssessment: zone.terrainAssessment,
          hardConflictCount: 0,
          terrainPlacement: currentRowPlacement,
          terrainPlacementScore: currentRowPlacement?.placementScore,
          accepted: false,
          rejectionReason: reason,
          discoveryIndex,
          qualityScore: computeQualityScore(frontLength, practicalDepth, 0, run.properties.roadType, zone.terrainAssessment, 0, currentRowPlacement?.placementScore)
        })
        continue
      }

      row.unitCount = cappedUnits.length
      row.unitEnvelopes = cappedUnits
      rows.push(row)
      ;(rowClipped as any).bbox = rowBbox
      placedRowGeometries.push(rowClipped)
      acceptedRows++
      totalUnitCount += cappedUnits.length
      totalRowLength += frontLength
      totalLayoutArea += rowAreaAcres
      byRoadType[run.properties.roadType]++
      byTerrainClass[zone.terrainAssessment]++
      rowAudits.push({
        rowId,
        zoneId: zone.id,
        frontageRoadId: run.properties.roadId,
        frontageRoadType: run.properties.roadType,
        frontageLengthFt: round3(frontLength),
        usableRowLengthFt: round3(frontLength),
        practicalDepthFt: practicalDepth,
        rowDepthFt: CONCEPTUAL_ROW_DEPTH_FT,
        unitWidthFt: CONCEPTUAL_UNIT_WIDTH_FT,
        unitCount: cappedUnits.length,
        terrainAssessment: zone.terrainAssessment,
        hardConflictCount: 0,
        terrainPlacement: currentRowPlacement,
        terrainPlacementScore: currentRowPlacement?.placementScore,
        accepted: true,
        rejectionReason: undefined,
        discoveryIndex,
        qualityScore: computeQualityScore(frontLength, practicalDepth, cappedUnits.length, run.properties.roadType, zone.terrainAssessment, 0, currentRowPlacement?.placementScore, rowClipped)
      })

      if (capacityLimit != null && totalUnitCount >= capacityLimit) {
        capacityReached = true
        break
      }
    }
  }

  // Final authoritative geometry gate — only valid rows/units are returned
  const TOL = GEOMETRY_VALIDATION_TOLERANCE_SQFT
  const finalRows: TownhomeRow[] = []
  const allUnits: TownhomeUnitEnvelope[] = []

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (signal?.aborted) throw new Error('Generation aborted')
    if (rowIndex % 2 === 0) await yieldIfNeeded(signal)
    const row = rows[rowIndex]
    const rowZone = zoneById.get(row.zoneId)
    const rowValidation = validateTownhomeRow(row, (rowZone?.geometry ?? null) as any, candidateOpenAreaGeometry, parcelBoundary, roadRows, allConstraints)
    if (!rowValidation.valid) {
      const audit = rowAudits.find(a => a.rowId === row.id)
      if (audit) {
        audit.accepted = false
        audit.rejectionReason = 'HARD_CONSTRAINT'
      }
      rejectionReasons['HARD_CONSTRAINT'] = (rejectionReasons['HARD_CONSTRAINT'] || 0) + 1
      continue
    }

    const validUnits: TownhomeUnitEnvelope[] = []
    for (let unitIndex = 0; unitIndex < row.unitEnvelopes.length; unitIndex++) {
      if (signal?.aborted) throw new Error('Generation aborted')
      if (unitIndex % 2 === 0) await yieldIfNeeded(signal)
      const u = row.unitEnvelopes[unitIndex]
      const unitValidation = validateTownhomeUnit(u, row, (rowZone?.geometry ?? null) as any, candidateOpenAreaGeometry, parcelBoundary, roadRows, allConstraints)
      if (!unitValidation.valid) continue
      let overlaps = false
      for (const other of allUnits) {
        if (overlapAreaSqFt(u.geometry, other.geometry) > TOL) { overlaps = true; break }
      }
      if (overlaps) continue
      validUnits.push(u)
      allUnits.push(u)
    }

    if (validUnits.length < CONCEPTUAL_MIN_UNITS_PER_ROW) {
      const audit = rowAudits.find(a => a.rowId === row.id)
      if (audit) {
        audit.accepted = false
        audit.rejectionReason = 'NO_UNITS'
      }
      rejectionReasons['NO_UNITS'] = (rejectionReasons['NO_UNITS'] || 0) + 1
      continue
    }

    let rowOverlaps = false
    for (const other of finalRows) {
      if (overlapAreaSqFt(row.geometry, other.geometry) > TOL) { rowOverlaps = true; break }
    }
    if (rowOverlaps) {
      const audit = rowAudits.find(a => a.rowId === row.id)
      if (audit) {
        audit.accepted = false
        audit.rejectionReason = 'OVERLAP'
      }
      rejectionReasons['OVERLAP'] = (rejectionReasons['OVERLAP'] || 0) + 1
      continue
    }

    row.unitEnvelopes = validUnits
    row.unitCount = validUnits.length
    finalRows.push(row)
  }

  rows = finalRows

  // Recompute final counts from validated geometry
  acceptedRows = rows.length
  rejectedRows = rowAudits.filter(a => !a.accepted).length
  totalUnitCount = rows.reduce((s, r) => s + r.unitCount, 0)
  totalRowLength = rows.reduce((s, r) => s + r.rowLengthFt, 0)
  totalLayoutArea = rows.reduce((s, r) => s + r.areaAcres, 0)

  // Reset and rebuild byRoadType / byTerrainClass from final rows
  Object.keys(byRoadType).forEach(k => (byRoadType as any)[k] = 0)
  Object.keys(byTerrainClass).forEach(k => (byTerrainClass as any)[k] = 0)
  for (const r of rows) {
    byRoadType[r.frontageRoadType]++
    byTerrainClass[r.terrainAssessment]++
  }

  const unitEnvelopes = rows.flatMap(r => r.unitEnvelopes)

  const placementStatus: TownhomeGenerationResult['placementStatus'] = !selectedTownhomes
    ? 'NOT_APPLICABLE'
    : totalUnitCount === 0
      ? 'NO_VALID_PLACEMENT'
      : capacityLimit == null || totalUnitCount === capacityLimit
        ? 'FULL_TARGET_MET'
        : 'PARTIAL_TARGET'

  const rowById = new Map(rows.map(r => [r.id, r]))
  let unitOverlapCount = 0
  for (let i = 0; i < unitEnvelopes.length; i++) {
    for (let j = i + 1; j < unitEnvelopes.length; j++) {
      if (overlapAreaSqFt(unitEnvelopes[i].geometry, unitEnvelopes[j].geometry) > GEOMETRY_VALIDATION_TOLERANCE_SQFT) {
        unitOverlapCount++
      }
    }
  }

  const allUnitsInsideParcel = unitEnvelopes.every(u =>
    !parcelBoundary || outsideAreaSqFt(u.geometry, parcelBoundary) <= GEOMETRY_VALIDATION_TOLERANCE_SQFT
  )
  const allUnitsInsideCandidateArea = unitEnvelopes.every(u =>
    !candidateOpenAreaGeometry || outsideAreaSqFt(u.geometry, candidateOpenAreaGeometry) <= GEOMETRY_VALIDATION_TOLERANCE_SQFT
  )
  const allUnitsInsideAssignedZones = unitEnvelopes.every(u => {
    const parentRow = rowById.get(u.rowId)
    const parentZone = parentRow ? zoneById.get(parentRow.zoneId) : null
    return !parentZone || outsideAreaSqFt(u.geometry, parentZone.geometry) <= GEOMETRY_VALIDATION_TOLERANCE_SQFT
  })

  const meanTerrainPlacementScore = rowPlacementScores.length ? round3(rowPlacementScores.reduce((s, v) => s + v, 0) / rowPlacementScores.length) : null

  const placementAudit: TownhomePlacementAudit = {
    mcpi,
    alternativeId: alternativeId ?? 'BALANCED',
    targetUnitCount: capacityLimit,
    generatedTownhomeUnits: totalUnitCount,
    generatedTownhomeRows: rows.length,
    placementStatus,
    eligibleZoneCount,
    attemptedUnitCount,
    acceptedUnitCount: totalUnitCount,
    rejectedUnitCount: attemptedUnitCount - totalUnitCount,
    rejectionReasons: { ...rejectionReasons },
    capacityRespected: capacityLimit == null || totalUnitCount <= capacityLimit,
    allUnitsInsideParcel,
    allUnitsInsideCandidateArea,
    allUnitsInsideAssignedZones,
    unitOverlapCount,
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

  if (import.meta.env.DEV) {
    console.log('[TownhomePlacementAudit]', placementAudit)
  }

  const subAudits = buildTownhomeAudits({
    mcpi,
    zones,
    assignments,
    allFrontageRuns,
    rows,
    rowAudits,
    rowCandidates,
    acceptedRows,
    rejectedRows,
    byRoadType,
    byTerrainClass,
    rejectionReasons
  })

  if (VERBOSE_GIS_DIAGNOSTICS) {
    const integrity = computeTownhomeGeometryIntegrityAudit(rows, unitEnvelopes, parcelBoundary, roadRows, allConstraints)
    console.log('[TownhomeGeometryIntegrityAudit]', {
      mcpi,
      rowCount: rows.length,
      unitCount: totalUnitCount,
      ...integrity
    })
  }

  return {
    mcpi,
    status: rows.length > 0 ? 'generated' : 'empty',
    placementStatus,
    rowCount: rows.length,
    unitCount: totalUnitCount,
    totalRowLengthFt: round3(totalRowLength),
    totalLayoutAreaAcres: round3(totalLayoutArea),
    rows,
    unitEnvelopes,
    warnings,
    audit: {
      mcpi,
      selectedTownhomes,
      eligibleZoneCount,
      frontageRunCount,
      rowCandidates,
      acceptedRows,
      rejectedRows,
      unitCount: totalUnitCount,
      totalRowLengthFt: round3(totalRowLength),
      totalLayoutAreaAcres: round3(totalLayoutArea),
      byRoadType,
      byTerrainClass,
      rejectionReasons,
      rowAudits,
      ...subAudits
    }
  }
} finally {
  generationPerformance.finish('townhome')
}
}

function buildTownhomeAudits(input: {
  mcpi: string
  zones: ConceptualDevelopmentZone[]
  assignments: Map<string, string | null>
  allFrontageRuns: { run: FrontageRun; lengthFt: number }[]
  rows: TownhomeRow[]
  rowAudits: TownhomeRowAudit[]
  rowCandidates: number
  acceptedRows: number
  rejectedRows: number
  byRoadType: Record<string, number>
  byTerrainClass: Record<string, number>
  rejectionReasons: Record<string, number>
}) {
  const { zones, assignments, allFrontageRuns, rows, rowAudits, rowCandidates, acceptedRows, rejectedRows, byRoadType, byTerrainClass, rejectionReasons } = input

  // Assign selection rank by sorting all candidates by quality score descending
  const sortedByQuality = [...rowAudits].sort((a, b) => b.qualityScore - a.qualityScore)
  sortedByQuality.forEach((audit, index) => {
    const original = rowAudits.find(a => a.rowId === audit.rowId && a.discoveryIndex === audit.discoveryIndex)
    if (original) original.selectionRank = index + 1
  })

  // Frontage fragmentation
  const runLengths = allFrontageRuns.map(r => r.lengthFt)
  const sortedLengths = [...runLengths].sort((a, b) => a - b)
  const totalFrontage = runLengths.reduce((s, v) => s + v, 0)
  const medianFrontage = sortedLengths.length
    ? (sortedLengths.length % 2 === 0
      ? (sortedLengths[sortedLengths.length / 2 - 1] + sortedLengths[sortedLengths.length / 2]) / 2
      : sortedLengths[Math.floor(sortedLengths.length / 2)])
    : 0

  const frontageRunsByRoadType: Record<string, number> = { primary: 0, secondary: 0, existing: 0, local: 0 }
  allFrontageRuns.forEach(r => { frontageRunsByRoadType[r.run.properties.roadType]++ })

  let adjacentRunsOnSameRoadCount = 0
  let mergeableAdjacentRunsCount = 0
  for (let i = 0; i < allFrontageRuns.length; i++) {
    for (let j = i + 1; j < allFrontageRuns.length; j++) {
      const a = allFrontageRuns[i]
      const b = allFrontageRuns[j]
      if (a.run.properties.roadId !== b.run.properties.roadId) continue
      if (a.run.properties.side !== b.run.properties.side) continue
      const aEnd = a.run.geometry.coordinates[a.run.geometry.coordinates.length - 1]
      const bStart = b.run.geometry.coordinates[0]
      const aStart = a.run.geometry.coordinates[0]
      const bEnd = b.run.geometry.coordinates[b.run.geometry.coordinates.length - 1]
      const gap = Math.min(
        safeTurfOp(() => (turf as any).distance((turf as any).point(aEnd), (turf as any).point(bStart), { units: 'feet' }), 9999),
        safeTurfOp(() => (turf as any).distance((turf as any).point(aStart), (turf as any).point(bEnd), { units: 'feet' }), 9999)
      )
      if (gap <= 30) {
        adjacentRunsOnSameRoadCount++
        const bearingDiff = Math.abs(a.run.properties.roadBearing - b.run.properties.roadBearing)
        const normalizedBearingDiff = Math.min(bearingDiff, 360 - bearingDiff)
        if (normalizedBearingDiff <= 15) {
          mergeableAdjacentRunsCount++
        }
      }
    }
  }

  const frontageAudit: TownhomeFrontageAudit = {
    rawRoadBoundarySegments: allFrontageRuns.length,
    frontageRunCountBeforeMerging: allFrontageRuns.length,
    frontageRunCountAfterMerging: allFrontageRuns.length,
    totalFrontageLengthFt: round3(totalFrontage),
    medianFrontageRunLengthFt: round3(medianFrontage),
    minFrontageRunLengthFt: round3(runLengths.length ? Math.min(...runLengths) : 0),
    maxFrontageRunLengthFt: round3(runLengths.length ? Math.max(...runLengths) : 0),
    frontageRunsByRoadType,
    adjacentRunsOnSameRoadCount,
    mergeableAdjacentRunsCount
  }

  // Adjacency / row groups
  const acceptedAudits = rowAudits.filter(a => a.accepted)
  const rowById = new Map(rows.map(r => [r.id, r]))

  function frontMidpoint(row: TownhomeRow): number[] | null {
    const coords = row.geometry?.geometry?.coordinates?.[0]
    if (!coords || coords.length < 4) return null
    return [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2]
  }

  function bearingDiff(a: number, b: number): number {
    const d = Math.abs(a - b)
    return Math.min(d, 360 - d)
  }

  function distanceFt(a: number[] | null, b: number[] | null): number {
    if (!a || !b) return Infinity
    return safeTurfOp(() => (turf as any).distance((turf as any).point(a), (turf as any).point(b), { units: 'feet' }), 9999)
  }

  const pairs: { a: string; b: string; gap: number }[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      if (a.frontageRoadId !== b.frontageRoadId) continue
      if (a.zoneId !== b.zoneId) continue
      if (bearingDiff(a.orientationBearing, b.orientationBearing) > 15) continue
      const gap = distanceFt(frontMidpoint(a), frontMidpoint(b))
      if (gap <= 30) {
        pairs.push({ a: a.id, b: b.id, gap })
      }
    }
  }

  const parent = new Map<string, string>()
  rows.forEach(r => parent.set(r.id, r.id))
  const find = (x: string): string => parent.get(x) === x ? x : find(parent.get(x)!)
  const union = (x: string, y: string) => {
    const rx = find(x), ry = find(y)
    if (rx !== ry) parent.set(rx, ry)
  }
  pairs.forEach(p => union(p.a, p.b))
  const groupMap = new Map<string, string[]>()
  rows.forEach(r => {
    const root = find(r.id)
    if (!groupMap.has(root)) groupMap.set(root, [])
    groupMap.get(root)!.push(r.id)
  })
  const groups = [...groupMap.values()]

  const rowGroups: TownhomeRowGroup[] = groups.map((group, idx) => {
    const groupRows = group.map(id => rowById.get(id)!).filter(Boolean)
    const roadType = groupRows[0]?.frontageRoadType ?? 'local'
    const roadId = groupRows[0]?.frontageRoadId ?? 'unknown'
    const totalRowLength = groupRows.reduce((s, r) => s + r.rowLengthFt, 0)
    const unitCount = groupRows.reduce((s, r) => s + r.unitCount, 0)
    const gaps: number[] = []
    if (groupRows.length > 1) {
      const sortedMids = groupRows
        .map(r => ({ id: r.id, mid: frontMidpoint(r) }))
        .filter(x => x.mid)
        .sort((a, b) => a.mid![0] - b.mid![0])
      for (let i = 1; i < sortedMids.length; i++) {
        const g = distanceFt(sortedMids[i - 1].mid, sortedMids[i].mid)
        if (g !== Infinity) gaps.push(g)
      }
    }
    const averageGap = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0
    const terrainCounts: Record<string, number> = {}
    groupRows.forEach(r => { terrainCounts[r.terrainAssessment] = (terrainCounts[r.terrainAssessment] || 0) + 1 })
    const terrainAssessment = Object.entries(terrainCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as any ?? 'INSUFFICIENT_DATA'
    return {
      groupId: `THG-${idx}`,
      roadId,
      roadType,
      rowCount: groupRows.length,
      unitCount,
      totalRowLengthFt: round3(totalRowLength),
      averageGapFt: round3(averageGap),
      terrainAssessment
    }
  })

  const adjacencyAudit: TownhomeRowAdjacencyAudit = {
    acceptedRowCount: acceptedRows,
    adjacentSameRoadPairs: pairs.length,
    potentiallyMergeableRowGroups: groups.filter(g => g.length > 1).length,
    isolatedRows: groups.filter(g => g.length === 1).length,
    rowGroups: groups.length
  }

  // Ranking audit
  const rankingAudit: TownhomeRankingEntry[] = sortedByQuality.slice(0, 10).map((a, index) => ({
    rank: index + 1,
    roadType: a.frontageRoadType,
    usableRowLengthFt: a.usableRowLengthFt,
    practicalDepthFt: a.practicalDepthFt,
    unitCount: a.unitCount,
    terrainAssessment: a.terrainAssessment,
    qualityScore: a.qualityScore,
    acceptedUnderCurrentLogic: a.accepted,
    discoveryIndex: a.discoveryIndex
  }))

  // Road hierarchy audit
  const roadHierarchyAudit: TownhomeRoadHierarchyAudit = {
    primaryAcceptedRows: byRoadType.primary ?? 0,
    secondaryAcceptedRows: byRoadType.secondary ?? 0,
    localAcceptedRows: byRoadType.local ?? 0,
    existingAcceptedRows: byRoadType.existing ?? 0,
    primaryRowsWithBetterLocalOrSecondaryAlternative: 0
  }
  const primaryRows = rows.filter(r => r.frontageRoadType === 'primary')
  primaryRows.forEach(pr => {
    const hasAlt = rows.some(r => r.id !== pr.id && r.frontageRoadId === pr.frontageRoadId && (r.frontageRoadType === 'local' || r.frontageRoadType === 'secondary') && bearingDiff(r.orientationBearing, pr.orientationBearing) <= 15)
    if (hasAlt) roadHierarchyAudit.primaryRowsWithBetterLocalOrSecondaryAlternative++
  })

  // Terrain audit
  const eligible = zones.find(z => z.programStatus === 'PROGRAMMABLE' && assignments.get(z.id) === 'townhomes' && z.terrainAssessment)
  const zoneTerrain = eligible?.terrainAssessment ?? 'INSUFFICIENT_DATA'
  const terrainAudit: TownhomeTerrainAudit = {
    terrainSourceMethod: 'zone-level terrain assessment assigned to every row in the zone; no per-row independent terrain sampling is performed',
    zoneTerrainAssessment: zoneTerrain,
    rowTerrainAssessmentMethod: 'copied from the containing ConceptualDevelopmentZone for each row',
    rowTerrainSampleCount: 0,
    rowsWithIndependentTerrainProfile: 0,
    rowsUsingZoneFallback: acceptedRows
  }

  // Acceptance rate audit
  const candidateCount = rowCandidates + rejectedRows
  const acceptanceRate = candidateCount > 0 ? round3(acceptedRows / candidateCount) : 0
  const fullRejectionReasons = { ...rejectionReasons }
  ;['NO_ACCESS', 'INSUFFICIENT_LENGTH', 'GEOMETRY_FAILURE', 'INSUFFICIENT_DEPTH', 'OVERLAP', 'NO_UNITS', 'TERRAIN', 'HARD_CONSTRAINT', 'INTERSECTION_CLEARANCE', 'OTHER'].forEach(k => {
    if (fullRejectionReasons[k] === undefined) fullRejectionReasons[k] = 0
  })
  const acceptanceRateAudit: TownhomeAcceptanceRateAudit = {
    candidateCount,
    acceptedCount: acceptedRows,
    rejectedCount: rejectedRows,
    acceptanceRate,
    rejectionReasons: fullRejectionReasons,
    explanation: acceptanceRate > 0.8
      ? 'Acceptance is high because every extracted frontage chunk is treated as an independent candidate. Selection is discovery-order, no grouping/merging is applied, and most chunks exceed the minimum length and fit 2-8 units.'
      : undefined
  }

  // Visual sanity summary
  function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b)
    if (!s.length) return 0
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const totalUnitCount = rows.reduce((s, r) => s + r.unitCount, 0)
  const totalRowLength = rows.reduce((s, r) => s + r.rowLengthFt, 0)
  const acceptedLengths = acceptedAudits.map(a => a.usableRowLengthFt)
  const acceptedUnits = acceptedAudits.map(a => a.unitCount)
  const allGaps = pairs.map(p => p.gap)

  const visualSanitySummary: TownhomeVisualSanitySummary = {
    acceptedRows,
    units: totalUnitCount,
    rowGroups: groups.length,
    byRoadType: { ...byRoadType },
    averageUnitsPerRow: acceptedRows ? round3(totalUnitCount / acceptedRows) : 0,
    medianUnitsPerRow: round3(median(acceptedUnits)),
    averageRowLengthFt: acceptedRows ? round3(totalRowLength / acceptedRows) : 0,
    medianRowLengthFt: round3(median(acceptedLengths)),
    averageGapBetweenSameRoadRowsFt: allGaps.length ? round3(allGaps.reduce((s, v) => s + v, 0) / allGaps.length) : 0,
    rowsOnChallengingTerrain: byTerrainClass.CHALLENGING ?? 0,
    rowsOnFavorableTerrain: byTerrainClass.FAVORABLE ?? 0,
    rowsOnModerateTerrain: byTerrainClass.MODERATE ?? 0,
    rowsOnLocalFrontage: byRoadType.local ?? 0,
    rowsOnSecondaryFrontage: byRoadType.secondary ?? 0,
    rowsOnPrimaryFrontage: byRoadType.primary ?? 0
  }

  return {
    frontageAudit,
    adjacencyAudit,
    rankingAudit,
    roadHierarchyAudit,
    terrainAudit,
    acceptanceRateAudit,
    rowGroups,
    visualSanitySummary
  }
}
