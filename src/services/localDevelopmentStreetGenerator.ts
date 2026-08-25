import { turfc as turf, VERBOSE_GIS_DIAGNOSTICS, ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS, recomputeCounter, generationPerformance, turfCounter, workflowCriticalPath, workflowTimeline } from '../lib/perf'
import { fastRhumbDestination } from './fastAlong'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type { ProjectParameters, ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, DevelopmentOpportunityBlockResult } from '../types/parameters'
import type { ConceptualDevelopmentProgramResult } from './conceptualDevelopmentProgram'
import type { ConceptualDevelopmentLayoutResult, LayoutConstraints } from './conceptualDevelopmentLayout'
import { generateConceptualDevelopmentLayout } from './conceptualDevelopmentLayout'
import { evaluateLocalStreetCandidate, precomputeFastLocalStreetContext } from './fastLocalStreetEvaluator'
import { computeRoadTerrainScore } from './terrainSuitabilityQuery'
import type {
  ConceptualLocalStreet,
  LocalStreetCandidate,
  LocalStreetNetworkResult,
  LocalStreetExpansionResult,
  LocalStreetMarginalBenefit,
  LocalStreetSelectionAuditItem,
  LocalStreetStopReason
} from '../types/localStreets'
import type { TerrainSuitabilityResult } from '../types/terrain'

const SQFT_PER_ACRE = 43560

// Phase 7B.3C: soft terrain influence for local streets (~20%).
const LOCAL_STREET_TERRAIN_INFLUENCE_PCT = 0.20

const USE_LEGACY_LOCAL_STREET_EVALUATOR =
  ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS &&
  import.meta.env.DEV &&
  import.meta.env.VITE_FORCE_LEGACY_LOCAL_STREET_EVALUATOR === 'true'

const USE_COMPARE_LOCAL_STREET_EVALUATORS =
  ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS &&
  import.meta.env.DEV &&
  import.meta.env.VITE_COMPARE_LOCAL_STREET_EVALUATORS === 'true'

const USE_FAST_LOCAL_STREET_EVALUATOR = !USE_LEGACY_LOCAL_STREET_EVALUATOR

function sqMetersToSqFt(m2: number): number { return m2 * 10.7639 }
function sqFtToAcres(sqft: number): number { return sqft / SQFT_PER_ACRE }

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function areaSqFtSafe(feature: any): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

function pointInFeature(pt: any, feature: any): boolean {
  if (!pt || !feature || !feature.geometry) return false
  const coords = pt.geometry ? pt.geometry.coordinates : pt
  return safeTurfOp(() => (turf as any).booleanPointInPolygon((turf as any).point(coords), feature), false)
}

function pointInAnyFeature(pt: any, features: any[]): boolean {
  for (const f of features) {
    if (!f || !f.geometry) continue
    if (pointInFeature(pt, f)) return true
  }
  return false
}

function toPolygonFeatures(geometry: any): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!geometry || !geometry.geometry) return []
  const g = geometry.geometry
  if (g.type === 'Polygon') return [{ type: 'Feature', properties: { ...(geometry.properties || {}), source: 'flatten' }, geometry: g }]
  if (g.type === 'MultiPolygon') {
    return g.coordinates.map((poly: any) => ({ type: 'Feature', properties: { ...(geometry.properties || {}), source: 'flatten' }, geometry: { type: 'Polygon', coordinates: poly } }))
  }
  return []
}

function allBoundaryRingsLocal(feature: any): GeoJSON.Feature<GeoJSON.MultiLineString> | null {
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

function toLineStringArrayLocal(feature: any): any[] {
  if (!feature || !feature.geometry) return []
  if (feature.geometry.type === 'LineString') return [feature]
  if (feature.geometry.type === 'MultiLineString') {
    return feature.geometry.coordinates.map((c: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }))
  }
  return []
}

function rowBoundaryLengthFt(row: any): number {
  const rings = allBoundaryRingsLocal(row)
  if (!rings) return 0
  return toLineStringArrayLocal(rings).reduce((s, line) => s + safeTurfOp(() => (turf as any).length(line, { units: 'feet' }), 0), 0)
}

function lineLengthInsideTargetFt(centerline: any, target: any): number {
  if (!centerline || !centerline.geometry || !target || !target.geometry) return 0
  const totalLen = safeTurfOp(() => (turf as any).length(centerline, { units: 'feet' }), 0)
  if (totalLen <= 0) return 0
  const step = 10
  let insideStart: number | null = null
  let lastInsideEnd = 0
  for (let d = 0; d <= totalLen; d += step) {
    const pt = safeTurfOp(() => (turf as any).along(centerline, Math.min(d, totalLen), { units: 'feet' }), null)
    const inside = pt ? pointInFeature(pt, target) : false
    if (inside && insideStart === null) insideStart = d
    if (!inside && insideStart !== null) {
      lastInsideEnd = d
      break
    }
    if (inside) lastInsideEnd = d
  }
  if (insideStart === null) return 0
  return Math.max(0, lastInsideEnd - insideStart)
}

function combineConstraints(geometry: any): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!geometry || !geometry.geometry) return []
  if (geometry.geometry.type === 'GeometryCollection') {
    const out: any[] = []
    for (const g of (geometry.geometry as GeoJSON.GeometryCollection).geometries) {
      if (g.type === 'Polygon') out.push({ type: 'Feature', properties: {}, geometry: g })
      if (g.type === 'MultiPolygon') {
        out.push(...(g as GeoJSON.MultiPolygon).coordinates.map(poly => ({ type: 'Feature' as any, properties: {}, geometry: { type: 'Polygon', coordinates: poly } as GeoJSON.Polygon })))
      }
    }
    return out as any
  }
  return toPolygonFeatures(geometry)
}

function turfIntersect(a: any, b: any): any {
  if (!a || !b) return null
  return safeTurfOp(() => (turf as any).intersect((turf as any).featureCollection([a, b])) as any, null)
}

function turfDifference(a: any, b: any): any {
  if (!a || !b) return null
  return safeTurfOp(() => (turf as any).difference((turf as any).featureCollection([a, b])) as any, null)
}

function round3(n: number): number { return Math.round(n * 1000) / 1000 }

function normalizeBearing(b: number): number {
  let v = b % 360
  if (v < 0) v += 360
  return v
}

function bearingDiff(a: number, b: number): number {
  let d = Math.abs(normalizeBearing(a) - normalizeBearing(b))
  if (d > 180) d = 360 - d
  return d
}

function lineEndBearing(centerline: any, atEnd: 'start' | 'end'): number | null {
  if (!centerline || !centerline.geometry || centerline.geometry.type !== 'LineString') return null
  const coords = centerline.geometry.coordinates
  if (coords.length < 2) return null
  if (atEnd === 'end') {
    const a = coords[coords.length - 2]
    const b = coords[coords.length - 1]
    return safeTurfOp(() => (turf as any).rhumbBearing((turf as any).point(a), (turf as any).point(b)), null)
  }
  const a = coords[0]
  const b = coords[1]
  return safeTurfOp(() => (turf as any).rhumbBearing((turf as any).point(a), (turf as any).point(b)), null)
}

interface LocalStreetOrigin {
  id: string
  point: GeoJSON.Feature<GeoJSON.Point>
  parentRoadId: string
  parentRoadType: 'primary' | 'secondary'
  parentRowGeometry: GeoJSON.Feature<GeoJSON.Polygon>
  centerline: any
  end: 'start' | 'end' | 'interior'
  bearingAtOrigin: number | null
  originType: 'primary-endpoint' | 'secondary-endpoint' | 'intersection' | 'interior'
  facingUnusedLand: boolean
}

interface LocalStreetTarget {
  id: string
  point: GeoJSON.Feature<GeoJSON.Point>
  geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  areaAcres: number
  estimatedAreaAcres: number
  sampleCount: number
  sourceZoneId: string
  sourceBlockId: string
  sourceRoadRelationship: 'PRIMARY_FRONTAGE' | 'SECONDARY_FRONTAGE' | 'NEAR_NETWORK' | 'LATENT'
  sourceZoneProgramStatus: 'PROGRAMMABLE' | 'RESIDUAL'
  sourceAssignedUse: string | null
  compatibilityByUse: Record<string, any>
  sourceAreaAcres: number
}

interface HardConstraints {
  rows: GeoJSON.Feature<GeoJSON.Polygon>[]
  buildings: GeoJSON.Feature<GeoJSON.Polygon>[]
  hydrology: GeoJSON.Feature<GeoJSON.Polygon>[]
  pavement: GeoJSON.Feature<GeoJSON.Polygon>[]
  parcel: GeoJSON.Feature<GeoJSON.Geometry> | null
  existingLots: GeoJSON.Feature<GeoJSON.Polygon>[]
  existingPads: GeoJSON.Feature<GeoJSON.Polygon>[]
}

function buildHardConstraints(constraints: LayoutConstraints): HardConstraints {
  const rows: GeoJSON.Feature<GeoJSON.Polygon>[] = []
  if (constraints.conceptualRoadResult?.proposedRightOfWay) rows.push(...toPolygonFeatures(constraints.conceptualRoadResult.proposedRightOfWay))
  if (constraints.secondaryRoadNetworkResult?.roads) {
    for (const r of constraints.secondaryRoadNetworkResult.roads) {
      if (r.rightOfWayGeometry) rows.push(...toPolygonFeatures(r.rightOfWayGeometry))
    }
  }
  return {
    rows,
    buildings: combineConstraints(constraints.buildingUnionGeometry),
    hydrology: combineConstraints(constraints.hydrologyGeometry),
    pavement: combineConstraints(constraints.pavementGeometry),
    parcel: constraints.candidateOpenAreaGeometry || constraints.parcelBoundary || null,
    existingLots: [],
    existingPads: []
  }
}

const ORIGIN_SPACING = 200
const ORIGIN_ENDPOINT_BUFFER = 100
const ORIGIN_MIN_SPACING = 60

function collectOrigins(
  conceptualRoadResult: ConceptualRoadSkeletonResult | null | undefined,
  secondaryRoadNetworkResult: SecondaryRoadNetworkResult | null | undefined,
  hard: HardConstraints,
  buildable: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined,
  rightOfWayWidthFt: number
): { origins: LocalStreetOrigin[]; audit: any } {
  const audit = {
    endpointOrigins: 0,
    intersectionOrigins: 0,
    interiorOrigins: 0,
    originsFacingUnusedLand: 0,
    originsRejectedBySpacing: 0,
    originsRejectedByConstraints: 0,
    totalOrigins: 0
  }
  const origins: LocalStreetOrigin[] = []

  function parentRowFor(pt: any): any | null {
    return hard.rows.find(r => pointInFeature(pt, r)) ?? null
  }

  function sideProbeBuildable(pt: any, bearing: number, side: number): boolean {
    const perpBearing = normalizeBearing(bearing + side)
    const near = rightOfWayWidthFt / 2 + 25
    const far = near + 50
    const nearPt = fastRhumbDestination(pt, near, 'feet', perpBearing)
    const farPt = fastRhumbDestination(pt, far, 'feet', perpBearing)
    if (!nearPt || !farPt) return false
    const nearInBuildable = pointInFeature(nearPt, buildable)
    const farInBuildable = pointInFeature(farPt, buildable)
    if (!nearInBuildable && !farInBuildable) return false
    if (pointInAnyFeature(nearPt, hard.hydrology) || pointInAnyFeature(nearPt, hard.buildings) || pointInAnyFeature(nearPt, hard.pavement)) return false
    if (pointInAnyFeature(farPt, hard.hydrology) || pointInAnyFeature(farPt, hard.buildings) || pointInAnyFeature(farPt, hard.pavement)) return false
    return true
  }

  function addOrigin(o: LocalStreetOrigin) {
    for (const existing of origins) {
      const d = safeTurfOp(() => (turf as any).distance((turf as any).point(o.point.geometry.coordinates), (turf as any).point(existing.point.geometry.coordinates), { units: 'feet' }), Infinity)
      if (d < ORIGIN_MIN_SPACING) {
        audit.originsRejectedBySpacing++
        return
      }
    }
    origins.push(o)
    audit.totalOrigins++
    if (o.originType.includes('endpoint')) audit.endpointOrigins++
    else if (o.originType === 'intersection') audit.intersectionOrigins++
    else if (o.originType === 'interior') audit.interiorOrigins++
    if (o.facingUnusedLand) audit.originsFacingUnusedLand++
  }

  function bearingAtPoint(cl: any, pt: any): number | null {
    const nearest = safeTurfOp(() => (turf as any).nearestPointOnLine(cl, pt, { units: 'feet' }), null)
    if (!nearest) return null
    const idx = Math.min(nearest.properties.index, cl.geometry.coordinates.length - 2)
    const a = cl.geometry.coordinates[idx]
    const b = cl.geometry.coordinates[idx + 1]
    if (!a || !b) return null
    return safeTurfOp(() => (turf as any).rhumbBearing((turf as any).point(a), (turf as any).point(b)), null)
  }

  if (conceptualRoadResult?.proposedRoadCenterline) {
    const cl = conceptualRoadResult.proposedRoadCenterline
    const coords = cl.geometry.coordinates
    if (coords.length >= 2) {
      const startPt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[0] } }
      const endPt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } }
      const startRow = parentRowFor(startPt) || toPolygonFeatures(conceptualRoadResult.proposedRightOfWay)[0]
      const endRow = parentRowFor(endPt) || toPolygonFeatures(conceptualRoadResult.proposedRightOfWay)[0]
      if (startRow) {
        const brg = lineEndBearing(cl, 'start')
        const facingLeft = brg !== null ? sideProbeBuildable(startPt, brg, -90) : false
        const facingRight = brg !== null ? sideProbeBuildable(startPt, brg, 90) : false
        addOrigin({
          id: 'PRIMARY-START',
          point: startPt as any,
          parentRoadId: 'PRIMARY',
          parentRoadType: 'primary',
          parentRowGeometry: startRow,
          centerline: cl,
          end: 'start',
          bearingAtOrigin: brg,
          originType: 'primary-endpoint',
          facingUnusedLand: facingLeft || facingRight
        })
      } else {
        audit.originsRejectedByConstraints++
      }
      if (endRow) {
        const brg = lineEndBearing(cl, 'end')
        const facingLeft = brg !== null ? sideProbeBuildable(endPt, brg, -90) : false
        const facingRight = brg !== null ? sideProbeBuildable(endPt, brg, 90) : false
        addOrigin({
          id: 'PRIMARY-END',
          point: endPt as any,
          parentRoadId: 'PRIMARY',
          parentRoadType: 'primary',
          parentRowGeometry: endRow,
          centerline: cl,
          end: 'end',
          bearingAtOrigin: brg,
          originType: 'primary-endpoint',
          facingUnusedLand: facingLeft || facingRight
        })
      } else {
        audit.originsRejectedByConstraints++
      }
    }
  }

  if (secondaryRoadNetworkResult?.roads) {
    for (const r of secondaryRoadNetworkResult.roads) {
      if (!r.centerlineGeometry || !r.centerlineGeometry.geometry) continue
      const cl = r.centerlineGeometry
      const coords = cl.geometry.coordinates
      if (coords.length < 2) continue
      const clLength = safeTurfOp(() => (turf as any).length(cl, { units: 'feet' }), 0)
      if (clLength === 0) continue

      const startPt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[0] } }
      const endPt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } }
      const startRow = parentRowFor(startPt) || toPolygonFeatures(r.rightOfWayGeometry)[0]
      const endRow = parentRowFor(endPt) || toPolygonFeatures(r.rightOfWayGeometry)[0]

      if (startRow) {
        const brg = lineEndBearing(cl, 'start')
        addOrigin({
          id: `SECONDARY-${r.id}-START`,
          point: startPt as any,
          parentRoadId: r.id,
          parentRoadType: 'secondary',
          parentRowGeometry: startRow,
          centerline: cl,
          end: 'start',
          bearingAtOrigin: brg,
          originType: 'secondary-endpoint',
          facingUnusedLand: (brg !== null ? sideProbeBuildable(startPt, brg, -90) : false) || (brg !== null ? sideProbeBuildable(startPt, brg, 90) : false)
        })
      } else {
        audit.originsRejectedByConstraints++
      }
      if (endRow) {
        const brg = lineEndBearing(cl, 'end')
        addOrigin({
          id: `SECONDARY-${r.id}-END`,
          point: endPt as any,
          parentRoadId: r.id,
          parentRoadType: 'secondary',
          parentRowGeometry: endRow,
          centerline: cl,
          end: 'end',
          bearingAtOrigin: brg,
          originType: 'secondary-endpoint',
          facingUnusedLand: (brg !== null ? sideProbeBuildable(endPt, brg, -90) : false) || (brg !== null ? sideProbeBuildable(endPt, brg, 90) : false)
        })
      } else {
        audit.originsRejectedByConstraints++
      }

      for (let d = ORIGIN_ENDPOINT_BUFFER; d <= clLength - ORIGIN_ENDPOINT_BUFFER; d += ORIGIN_SPACING) {
        const pt = safeTurfOp(() => (turf as any).along(cl, d, { units: 'feet' }), null)
        if (!pt) continue
        const row = parentRowFor(pt) || toPolygonFeatures(r.rightOfWayGeometry)[0]
        if (!row) {
          audit.originsRejectedByConstraints++
          continue
        }
        const brg = bearingAtPoint(cl, pt)
        const left = brg !== null ? sideProbeBuildable(pt, brg, -90) : false
        const right = brg !== null ? sideProbeBuildable(pt, brg, 90) : false
        if (!left && !right) {
          audit.originsRejectedByConstraints++
          continue
        }
        addOrigin({
          id: `SECONDARY-${r.id}-INTERIOR-${d.toFixed(0)}`,
          point: pt,
          parentRoadId: r.id,
          parentRoadType: 'secondary',
          parentRowGeometry: row,
          centerline: cl,
          end: 'interior',
          bearingAtOrigin: brg,
          originType: 'interior',
          facingUnusedLand: left || right
        })
      }
    }
  }

  return { origins, audit }
}

function findUnusedTargets(
  programResult: ConceptualDevelopmentProgramResult,
  constraints: LayoutConstraints,
  hard: HardConstraints,
  baseline: ConceptualDevelopmentLayoutResult,
  mcpi: string,
  minClusterAcres = 2.0
): { targets: LocalStreetTarget[]; targetGeometryAudits: any[]; preFilterComponents: any[] } {
  const targets: LocalStreetTarget[] = []
  const targetGeometryAudits: any[] = []

  const usedGeometries: any[] = [...hard.rows]
  for (const lot of baseline.lotCells) if (lot.geometry) usedGeometries.push(lot.geometry)
  for (const pad of baseline.developmentPads) if (pad.geometry) usedGeometries.push(pad.geometry)

  const programmableZones = programResult.zones.filter(z => z.programStatus === 'PROGRAMMABLE')
  const roadServedZones = programmableZones.filter(z => z.roadRelationship === 'PRIMARY_FRONTAGE' || z.roadRelationship === 'SECONDARY_FRONTAGE' || z.roadRelationship === 'NEAR_NETWORK')
  const nearNetworkZones = programmableZones.filter(z => z.roadRelationship === 'NEAR_NETWORK')
  const latentZones = programResult.zones.filter(z => z.roadRelationship === 'LATENT')

  let t = 0
  const preFilterComponents: any[] = []
  for (const zone of programmableZones) {
    if (!zone.geometry) continue
    let zoneUnused: any = zone.geometry
    for (const used of usedGeometries) {
      if (!used) continue
      const next = turfDifference(zoneUnused, used)
      if (next) zoneUnused = next
    }
    const components = toPolygonFeatures(zoneUnused)
    for (const comp of components) {
      const areaAcres = sqFtToAcres(areaSqFtSafe(comp))
      const componentId = `COMP-${preFilterComponents.length}`
      preFilterComponents.push({ id: componentId, areaAcres, sourceZoneId: zone.id, accepted: areaAcres >= minClusterAcres })
      if (areaAcres < minClusterAcres) continue
      const pointOn = safeTurfOp(() => (turf as any).pointOnFeature(comp), null)
      if (!pointOn) continue

      const assignedUse = baseline.useAssignments?.find((u: any) => u.zoneId === zone.id)?.assignedUse ?? null
      const sourceAreaAcres = zone.areaAcres
      const target: LocalStreetTarget = {
        id: `TARGET-${t++}`,
        point: pointOn as GeoJSON.Feature<GeoJSON.Point>,
        geometry: comp as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
        areaAcres,
        estimatedAreaAcres: areaAcres,
        sampleCount: 0,
        sourceZoneId: zone.id,
        sourceBlockId: zone.sourceBlockId,
        sourceRoadRelationship: zone.roadRelationship,
        sourceZoneProgramStatus: zone.programStatus,
        sourceAssignedUse: assignedUse,
        compatibilityByUse: zone.compatibilityByUse,
        sourceAreaAcres
      }
      targets.push(target)

      const existingLayout = { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [...baseline.lotCells.map(l => l.geometry?.geometry).filter(Boolean), ...baseline.developmentPads.map(p => p.geometry?.geometry).filter(Boolean)] } } as any

      targetGeometryAudits.push({
        mcpi,
        targetId: target.id,
        sourceGeometry: zone.id,
        targetAreaAcres: areaAcres,
        unusedProgrammableAreaAcres: 0,
        currentLayoutAreaAcres: baseline.layoutAreaAcres,
        targetIntersectionWithUnusedAcres: areaAcres,
        targetIntersectionWithExistingLayoutAcres: sqFtToAcres(areaSqFtSafe(turfIntersect(comp, existingLayout))),
        targetIntersectionWithRoadServedZoneAcres: roadServedZones.reduce((s, z) => s + sqFtToAcres(areaSqFtSafe(turfIntersect(comp, z.geometry))), 0),
        targetIntersectionWithNearNetworkZoneAcres: nearNetworkZones.reduce((s, z) => s + sqFtToAcres(areaSqFtSafe(turfIntersect(comp, z.geometry))), 0),
        targetIntersectionWithLatentZoneAcres: latentZones.reduce((s, z) => s + sqFtToAcres(areaSqFtSafe(turfIntersect(comp, z.geometry))), 0),
        targetFullyInsideUnusedProgrammable: areaAcres > 0,
        targetContainsAlreadyServedGeometry: roadServedZones.some(z => !!turfIntersect(comp, z.geometry)),
        targetContainsExistingLots: baseline.lotCells.some(l => !!l.geometry && !!turfIntersect(comp, l.geometry)),
        targetContainsExistingEnvelopes: baseline.buildingEnvelopes.some(e => !!e.geometry && !!turfIntersect(comp, e.geometry)),
        sourceZoneRoadRelationship: zone.roadRelationship,
        sourceZoneAssignedUse: assignedUse,
        sourceAreaAcres
      })
    }
  }

  const eligibleAreaAcres = targets.reduce((s, t) => s + t.areaAcres, 0)
  const totalUnusedProgrammableAreaAcres = preFilterComponents.reduce((s, c) => s + c.areaAcres, 0)
  const ineligibleSmallComponentAreaAcres = totalUnusedProgrammableAreaAcres - eligibleAreaAcres
  const eligibleTargetCount = targets.length
  const ineligibleTargetCount = preFilterComponents.length - eligibleTargetCount
  for (const a of targetGeometryAudits) {
    a.totalUnusedProgrammableAreaAcres = totalUnusedProgrammableAreaAcres
    a.eligibleLocalStreetTargetAreaAcres = eligibleAreaAcres
    a.ineligibleSmallComponentAreaAcres = ineligibleSmallComponentAreaAcres
    a.baselineUnusedProgrammableAreaAcres = baseline.unusedProgrammableAreaAcres
  }

  const totalProgrammableAreaAcres = programResult.programmableAreaAcres
  const grossLotAreaAcres = baseline.lotCells.reduce((s, l: any) => s + (l.areaAcres || sqFtToAcres(areaSqFtSafe(l.geometry))), 0)
  const grossPadAreaAcres = baseline.developmentPads.reduce((s, p: any) => s + (p.areaAcres || sqFtToAcres(areaSqFtSafe(p.geometry))), 0)
  const grossEnvelopeAreaAcres = baseline.buildingEnvelopes.reduce((s, e: any) => s + (e.areaAcres || sqFtToAcres(areaSqFtSafe(e.geometry))), 0)
  const grossPrimaryRowAreaAcres = constraints.conceptualRoadResult?.proposedRightOfWay ? sqFtToAcres(areaSqFtSafe(constraints.conceptualRoadResult.proposedRightOfWay)) : 0
  const grossSecondaryRowAreaAcres = (constraints.secondaryRoadNetworkResult?.roads || []).reduce((s: number, r: any) => s + (r.rightOfWayGeometry ? sqFtToAcres(areaSqFtSafe(r.rightOfWayGeometry)) : 0), 0)

  const lotEnvelopeOverlapAcres = baseline.lotCells.reduce((s, l: any) => s + baseline.buildingEnvelopes.reduce((ss, e: any) => ss + sqFtToAcres(areaSqFtSafe(turfIntersect(l.geometry, e.geometry))), 0), 0)
  const lotPadOverlapAcres = baseline.lotCells.reduce((s, l: any) => s + baseline.developmentPads.reduce((ss, p: any) => ss + sqFtToAcres(areaSqFtSafe(turfIntersect(l.geometry, p.geometry))), 0), 0)
  const padEnvelopeOverlapAcres = baseline.developmentPads.reduce((s, p: any) => s + baseline.buildingEnvelopes.reduce((ss, e: any) => ss + sqFtToAcres(areaSqFtSafe(turfIntersect(p.geometry, e.geometry))), 0), 0)
  const rowLotOverlapAcres = usedGeometries.reduce((s, r: any) => s + baseline.lotCells.reduce((ss, l: any) => ss + sqFtToAcres(areaSqFtSafe(turfIntersect(r, l.geometry))), 0), 0)
  const rowPadOverlapAcres = usedGeometries.reduce((s, r: any) => s + baseline.developmentPads.reduce((ss, p: any) => ss + sqFtToAcres(areaSqFtSafe(turfIntersect(r, p.geometry))), 0), 0)
  const lotLotOverlapAcres = (() => { let s = 0; for (let i = 0; i < baseline.lotCells.length; i++) for (let j = i + 1; j < baseline.lotCells.length; j++) s += sqFtToAcres(areaSqFtSafe(turfIntersect(baseline.lotCells[i].geometry, baseline.lotCells[j].geometry))); return s })()

  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[LocalStreetConservationAudit]', {
      mcpi,
      totalProgrammableAreaAcres,
      baselineUnusedProgrammableAreaAcres: baseline.unusedProgrammableAreaAcres,
      totalUnusedProgrammableAreaAcres,
      eligibleLocalStreetTargetAreaAcres: eligibleAreaAcres,
      ineligibleSmallComponentAreaAcres,
      conservationDifferenceToBaselineAcres: round3(baseline.unusedProgrammableAreaAcres - totalUnusedProgrammableAreaAcres),
      grossLotAreaAcres,
      grossEnvelopeAreaAcres,
      grossPadAreaAcres,
      grossPrimaryRowAreaAcres,
      grossSecondaryRowAreaAcres,
      lotEnvelopeOverlapAcres,
      lotPadOverlapAcres,
      padEnvelopeOverlapAcres,
      rowLotOverlapAcres,
      rowPadOverlapAcres,
      lotLotOverlapAcres,
      totalGrossConsumedBeforeOverlapAdjustments: round3(grossLotAreaAcres + grossEnvelopeAreaAcres + grossPadAreaAcres + grossPrimaryRowAreaAcres + grossSecondaryRowAreaAcres),
      totalUniqueConsumedAreaAcres: round3(totalProgrammableAreaAcres - totalUnusedProgrammableAreaAcres),
      componentsBeforeFilter: preFilterComponents.length,
      componentsAfterFilter: eligibleTargetCount,
      ineligibleTargetCount,
      allPreFilterComponents: preFilterComponents
    })
    console.log('[LocalStreetTargetGeometryAudit]', {
      mcpi,
      totalUnusedProgrammableAreaAcres,
      eligibleLocalStreetTargetAreaAcres: eligibleAreaAcres,
      ineligibleSmallComponentAreaAcres,
      baselineUnusedProgrammableAreaAcres: baseline.unusedProgrammableAreaAcres,
      conservationDifferenceAcres: round3(baseline.unusedProgrammableAreaAcres - totalUnusedProgrammableAreaAcres),
      eligibleTargetCount,
      ineligibleTargetCount,
      targets: targetGeometryAudits
    })
  }

  return { targets: targets.sort((a, b) => b.areaAcres - a.areaAcres), targetGeometryAudits, preFilterComponents }
}

interface CandidateRoute {
  id: string
  centerline: GeoJSON.Feature<GeoJSON.LineString>
  bendCount: number
  parentBearingDeg: number
  departureSide: 'LEFT' | 'RIGHT' | null
  departureBearingDeg: number
  junctionAngleDeg: number
  parentRowExitDistanceFt: number
  parentRowExitFound: boolean
  buildableSideReached: boolean
  initialTangentLengthFt: number
  firstBendDistanceFt: number
  departureRejectionReason: string
}

function findParentRowExit(
  origin: LocalStreetOrigin,
  departureBearing: number,
  rightOfWayWidthFt: number
): { exitPoint: any | null; exitDistance: number; lastInsideDistance: number; found: boolean } {
  const maxDistance = rightOfWayWidthFt * 1.5
  const step = 1
  let lastInside = 0
  for (let d = step; d <= maxDistance; d += step) {
    const pt = fastRhumbDestination(origin.point, d, 'feet', departureBearing)
    if (!pt) break
    if (pointInFeature(pt, origin.parentRowGeometry)) {
      lastInside = d
      continue
    }
    return { exitPoint: pt, exitDistance: d, lastInsideDistance: lastInside, found: true }
  }
  return { exitPoint: null, exitDistance: 0, lastInsideDistance: lastInside, found: false }
}

function sideBuildableAndClear(
  origin: LocalStreetOrigin,
  sideBearing: number,
  rightOfWayWidthFt: number,
  buildable: any,
  hard: HardConstraints
): boolean {
  const near = fastRhumbDestination(origin.point, rightOfWayWidthFt / 2 + 25, 'feet', sideBearing)
  const far = fastRhumbDestination(origin.point, rightOfWayWidthFt / 2 + 75, 'feet', sideBearing)
  if (!near && !far) return false
  const nearGood = near && pointInFeature(near, buildable) && !pointInAnyFeature(near, hard.hydrology) && !pointInAnyFeature(near, hard.buildings) && !pointInAnyFeature(near, hard.pavement)
  const farGood = far && pointInFeature(far, buildable) && !pointInAnyFeature(far, hard.hydrology) && !pointInAnyFeature(far, hard.buildings) && !pointInAnyFeature(far, hard.pavement)
  return !!nearGood || !!farGood
}

function buildRouteCandidates(
  origin: LocalStreetOrigin,
  target: LocalStreetTarget,
  hard: HardConstraints,
  buildable: any,
  rightOfWayWidthFt: number
): CandidateRoute[] {
  const parentBearing = origin.bearingAtOrigin
  if (parentBearing === null) {
    return [{
      id: 'REJECTED',
      centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [origin.point.geometry.coordinates, origin.point.geometry.coordinates] } },
      bendCount: 0,
      parentBearingDeg: 0,
      departureSide: null,
      departureBearingDeg: 0,
      junctionAngleDeg: 0,
      parentRowExitDistanceFt: 0,
      parentRowExitFound: false,
      buildableSideReached: false,
      initialTangentLengthFt: 0,
      firstBendDistanceFt: 0,
      departureRejectionReason: 'noBuildableDepartureSide'
    }]
  }

  const targetBearing = safeTurfOp(() => (turf as any).rhumbBearing(origin.point, target.point), null) ?? 0
  const sideProbes: { side: 'LEFT' | 'RIGHT'; sign: number; buildable: boolean; angleToTarget: number }[] = []

  for (const { side, sign } of [{ side: 'LEFT' as const, sign: -90 }, { side: 'RIGHT' as const, sign: 90 }]) {
    const departureBearing = normalizeBearing(parentBearing + sign)
    const sideClear = sideBuildableAndClear(origin, departureBearing, rightOfWayWidthFt, buildable, hard)
    const angleToTarget = bearingDiff(targetBearing, departureBearing)
    sideProbes.push({ side, sign, buildable: sideClear, angleToTarget })
  }

  const anyBuildable = sideProbes.some(s => s.buildable)
  if (!anyBuildable) {
    return [{
      id: 'REJECTED',
      centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [origin.point.geometry.coordinates, origin.point.geometry.coordinates] } },
      bendCount: 0,
      parentBearingDeg: parentBearing,
      departureSide: null,
      departureBearingDeg: 0,
      junctionAngleDeg: 0,
      parentRowExitDistanceFt: 0,
      parentRowExitFound: false,
      buildableSideReached: false,
      initialTangentLengthFt: 0,
      firstBendDistanceFt: 0,
      departureRejectionReason: 'noBuildableDepartureSide'
    }]
  }

  const buildableSides = sideProbes.filter(s => s.buildable).sort((a, b) => a.angleToTarget - b.angleToTarget)
  const chosen = buildableSides[0]
  const departureBearing = normalizeBearing(parentBearing + chosen.sign)
  const { exitPoint, exitDistance, found } = findParentRowExit(origin, departureBearing, rightOfWayWidthFt)
  if (!found || !exitPoint) {
    return [{
      id: 'REJECTED',
      centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [origin.point.geometry.coordinates, origin.point.geometry.coordinates] } },
      bendCount: 0,
      parentBearingDeg: parentBearing,
      departureSide: chosen.side,
      departureBearingDeg: departureBearing,
      junctionAngleDeg: bearingDiff(parentBearing, departureBearing),
      parentRowExitDistanceFt: 0,
      parentRowExitFound: false,
      buildableSideReached: true,
      initialTangentLengthFt: 0,
      firstBendDistanceFt: 0,
      departureRejectionReason: 'parentRowExitFailure'
    }]
  }

  const o = origin.point.geometry.coordinates
  const t = target.point.geometry.coordinates
  const routes: CandidateRoute[] = []

  const baseRoute = {
    parentBearingDeg: parentBearing,
    departureSide: chosen.side,
    departureBearingDeg: departureBearing,
    junctionAngleDeg: bearingDiff(parentBearing, departureBearing),
    parentRowExitDistanceFt: exitDistance,
    parentRowExitFound: true,
    buildableSideReached: true,
    initialTangentLengthFt: exitDistance,
    firstBendDistanceFt: exitDistance,
    departureRejectionReason: ''
  }

  routes.push({
    id: 'TEE',
    centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [o, exitPoint.geometry.coordinates, t] } },
    bendCount: 1,
    ...baseRoute
  })

  const afterBearing = safeTurfOp(() => (turf as any).rhumbBearing(exitPoint, target.point), targetBearing)
  for (const { side, sign } of [{ side: 'LEFT' as const, sign: -90 }, { side: 'RIGHT' as const, sign: 90 }]) {
    const perpBearing = normalizeBearing(afterBearing + sign)
    const perpPoint = fastRhumbDestination(exitPoint, 60, 'feet', perpBearing)
    if (perpPoint) {
      routes.push({
        id: `PERP-${side}`,
        centerline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [o, exitPoint.geometry.coordinates, perpPoint.geometry.coordinates, t] } },
        bendCount: 2,
        ...baseRoute
      })
    }
  }

  return routes
}

interface ParentRowExitAudit {
  startsInsideParentRow: boolean
  exitFound: boolean
  firstOutsideParentRowDistanceFt: number | null
  parentRowOverlapLengthFt: number
  reentersParentRowLater: boolean
  validEntryTransition: boolean
  rejectionReason: string
}

function auditParentRowExit(
  centerline: any,
  origin: LocalStreetOrigin,
  hard: HardConstraints,
  rightOfWayWidthFt: number,
  firstSegmentBearing: number | null
): ParentRowExitAudit {
  const parentRow = origin.parentRowGeometry
  const otherRows = hard.rows.filter(r => r !== parentRow)
  const lengthFt = safeTurfOp(() => (turf as any).length(centerline, { units: 'feet' }), 0)
  const startsInside = pointInFeature(origin.point, parentRow)
  const maxOverlap = rightOfWayWidthFt

  if (!startsInside) {
    return { startsInsideParentRow: false, exitFound: true, firstOutsideParentRowDistanceFt: 0, parentRowOverlapLengthFt: 0, reentersParentRowLater: false, validEntryTransition: true, rejectionReason: '' }
  }
  if (firstSegmentBearing === null) {
    return { startsInsideParentRow: true, exitFound: false, firstOutsideParentRowDistanceFt: null, parentRowOverlapLengthFt: 0, reentersParentRowLater: false, validEntryTransition: false, rejectionReason: 'no departure bearing' }
  }

  const { exitDistance, lastInsideDistance, found } = findParentRowExit(origin, firstSegmentBearing, rightOfWayWidthFt * 1.5)
  if (!found) {
    return { startsInsideParentRow: true, exitFound: false, firstOutsideParentRowDistanceFt: null, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: false, validEntryTransition: false, rejectionReason: 'does not exit parent ROW' }
  }
  if (lastInsideDistance > maxOverlap) {
    return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: false, validEntryTransition: false, rejectionReason: 'excessive parent ROW overlap' }
  }

  const step = 25
  let d = exitDistance
  let reenters = false
  while (d <= lengthFt) {
    const pt = safeTurfOp(() => (turf as any).along(centerline, d, { units: 'feet' }), null)
    if (!pt) { d += step; continue }
    const inParent = pointInFeature(pt, parentRow)
    if (inParent) {
      reenters = true
      break
    }
    if (!pointInFeature(pt, hard.parcel)) {
      return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: reenters, validEntryTransition: false, rejectionReason: 'exits parcel boundary' }
    }
    if (pointInAnyFeature(pt, hard.hydrology)) return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: reenters, validEntryTransition: false, rejectionReason: 'HYDROLOGY_CROSSING_REQUIRED' }
    if (pointInAnyFeature(pt, hard.buildings)) return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: reenters, validEntryTransition: false, rejectionReason: 'building conflict' }
    if (pointInAnyFeature(pt, hard.pavement)) return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: reenters, validEntryTransition: false, rejectionReason: 'pavement conflict' }
    if (pointInAnyFeature(pt, otherRows)) return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: reenters, validEntryTransition: false, rejectionReason: 'crosses another road ROW' }
    d += step
  }

  if (reenters) {
    return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: true, validEntryTransition: false, rejectionReason: 're-enters parent ROW' }
  }
  return { startsInsideParentRow: true, exitFound: true, firstOutsideParentRowDistanceFt: exitDistance, parentRowOverlapLengthFt: lastInsideDistance, reentersParentRowLater: false, validEntryTransition: true, rejectionReason: '' }
}

function validateLocalStreetCandidate(
  route: CandidateRoute,
  origin: LocalStreetOrigin,
  rightOfWayWidthFt: number,
  hard: HardConstraints,
  maxLengthFt = 1500,
  minLengthFt = 60
): { valid: boolean; rightOfWay: any; lengthFt: number; rejectionReason: string; conflictCounts: ConceptualLocalStreet['conflictCounts']; entryAudit: ParentRowExitAudit } {
  const conflictCounts: ConceptualLocalStreet['conflictCounts'] = { buildings: 0, hydrology: 0, pavement: 0, parcelBoundary: 0, otherRoadRow: 0 }
  const centerline = route.centerline
  const lengthFt = safeTurfOp(() => (turf as any).length(centerline, { units: 'feet' }), 0)
  if (lengthFt < minLengthFt || lengthFt > maxLengthFt) {
    return { valid: false, rightOfWay: null, lengthFt, rejectionReason: `length outside ${minLengthFt}-${maxLengthFt} ft`, conflictCounts, entryAudit: { startsInsideParentRow: pointInFeature(origin.point, origin.parentRowGeometry), exitFound: false, firstOutsideParentRowDistanceFt: null, parentRowOverlapLengthFt: 0, reentersParentRowLater: false, validEntryTransition: false, rejectionReason: 'length outside' } }
  }

  const coords = centerline.geometry.coordinates
  const firstSegmentBearing = safeTurfOp(() => (turf as any).rhumbBearing((turf as any).point(coords[0]), (turf as any).point(coords[1])), null)

  const entryAudit = auditParentRowExit(centerline, origin, hard, rightOfWayWidthFt, firstSegmentBearing)
  if (!entryAudit.validEntryTransition) {
    if (entryAudit.rejectionReason === 'exits parcel boundary') conflictCounts.parcelBoundary += 1
    return { valid: false, rightOfWay: null, lengthFt, rejectionReason: entryAudit.rejectionReason, conflictCounts, entryAudit }
  }

  if (firstSegmentBearing !== null && origin.bearingAtOrigin !== null) {
    const junctionAngle = bearingDiff(firstSegmentBearing, origin.bearingAtOrigin)
    if (junctionAngle < 20 || junctionAngle > 160) {
      return { valid: false, rightOfWay: null, lengthFt, rejectionReason: 'poor junction angle', conflictCounts, entryAudit }
    }
  }

  const rowBuffer = rightOfWayWidthFt / 2
  const rightOfWay = safeTurfOp(() => (turf as any).buffer(centerline, rowBuffer, { units: 'feet' }), null)
  if (!rightOfWay) {
    return { valid: false, rightOfWay: null, lengthFt, rejectionReason: 'failed to buffer ROW', conflictCounts, entryAudit }
  }

  const rowArea = areaSqFtSafe(rightOfWay)
  const insideBuildable = hard.parcel ? turfIntersect(rightOfWay, hard.parcel) : null
  const insideBuildableArea = areaSqFtSafe(insideBuildable)
  const insideParent = turfIntersect(rightOfWay, origin.parentRowGeometry)
  const insideParentArea = areaSqFtSafe(insideParent)
  if ((insideBuildableArea + insideParentArea) < rowArea * 0.9) {
    return { valid: false, rightOfWay: null, lengthFt, rejectionReason: 'ROW mostly outside buildable', conflictCounts, entryAudit }
  }

  const otherRows = hard.rows.filter(r => r !== origin.parentRowGeometry)

  for (const h of hard.hydrology) {
    const inter = turfIntersect(rightOfWay, h)
    if (inter) conflictCounts.hydrology += 1
  }
  for (const b of hard.buildings) {
    const inter = turfIntersect(rightOfWay, b)
    if (inter) conflictCounts.buildings += 1
  }
  for (const p of hard.pavement) {
    const inter = turfIntersect(rightOfWay, p)
    if (inter) conflictCounts.pavement += 1
  }
  for (const r of otherRows) {
    const inter = turfIntersect(rightOfWay, r)
    if (inter) conflictCounts.otherRoadRow += 1
  }

  if (conflictCounts.hydrology > 0) return { valid: false, rightOfWay, lengthFt, rejectionReason: 'HYDROLOGY_CROSSING_REQUIRED', conflictCounts, entryAudit }
  if (conflictCounts.buildings > 0) return { valid: false, rightOfWay, lengthFt, rejectionReason: 'building ROW conflict', conflictCounts, entryAudit }
  if (conflictCounts.pavement > 0) return { valid: false, rightOfWay, lengthFt, rejectionReason: 'pavement ROW conflict', conflictCounts, entryAudit }
  if (conflictCounts.otherRoadRow > 0) return { valid: false, rightOfWay, lengthFt, rejectionReason: 'other ROW conflict', conflictCounts, entryAudit }

  return { valid: true, rightOfWay, lengthFt, rejectionReason: '', conflictCounts, entryAudit }
}

function generateCandidateId(): string {
  return `LC-${Math.random().toString(36).slice(2, 9)}`
}

async function runLayoutWithStreets(
  programResult: ConceptualDevelopmentProgramResult,
  blockResult: DevelopmentOpportunityBlockResult,
  baseConstraints: LayoutConstraints,
  streets: ConceptualLocalStreet[],
  projectParameters?: ProjectParameters | null,
  runType: 'baseline' | 'candidate' | 'final' | 'other' = 'candidate',
  semanticKey?: string,
  signal?: AbortSignal
): Promise<ConceptualDevelopmentLayoutResult> {
  const constraints: LayoutConstraints = {
    ...baseConstraints,
    localStreetNetworkResult: {
      mcpi: programResult.mcpi,
      status: streets.length ? 'generated' : 'empty',
      localStreetCount: streets.length,
      totalLocalStreetLengthFt: streets.reduce((s, r) => s + r.lengthFt, 0),
      localRowAreaAcres: streets.reduce((s, r) => s + r.rowAreaAcres, 0),
      baselineLotCount: 0,
      finalLotCount: 0,
      baselineDrawableCapacity: 0,
      finalDrawableCapacity: 0,
      incrementalDrawableCapacity: 0,
      baselineLayoutAreaAcres: 0,
      finalLayoutAreaAcres: 0,
      incrementalLayoutAreaAcres: 0,
      baselineUnusedProgrammableAcres: 0,
      finalUnusedProgrammableAcres: 0,
      totalNewTrueFrontageFt: 0,
      stopReason: 'NO_MARGINAL_BENEFIT',
      localStreets: streets,
      candidateAudits: [],
      selectionAudits: [],
      warnings: []
    }
  }
  const streetKey = semanticKey || (streets.length ? streets.map(s => s.id).sort().join(',') : runType)
  return await generateConceptualDevelopmentLayout(programResult, blockResult, constraints, projectParameters, runType, streetKey, signal)
}

function getRejectionCategory(rejectionReason: string): string {
  if (rejectionReason === 'poor junction angle') return 'poorJunctionAngle'
  if (rejectionReason === 'does not exit parent ROW' || rejectionReason === 're-enters parent ROW' || rejectionReason === 'excessive parent ROW overlap') return 'parentRowExitFailure'
  if (rejectionReason === 'exits parcel boundary') return 'parcelExit'
  if (rejectionReason === 'ROW mostly outside buildable' || rejectionReason === 'does not enter unused target') return 'targetNotReached'
  if (rejectionReason === 'HYDROLOGY_CROSSING_REQUIRED' || rejectionReason === 'hydrology crossing') return 'hydrologyCollision'
  if (rejectionReason.includes('building')) return 'buildingCollision'
  if (rejectionReason.includes('pavement')) return 'pavementCollision'
  if (rejectionReason === 'crosses another road ROW' || rejectionReason === 'other ROW conflict') return 'unrelatedRowCollision'
  if (rejectionReason.includes('length outside') || rejectionReason === 'failed to buffer ROW') return 'routeGeometryQuality'
  return 'other'
}

export async function generateLocalDevelopmentStreetExpansion(
  programResult: ConceptualDevelopmentProgramResult,
  blockResult: DevelopmentOpportunityBlockResult,
  constraints: LayoutConstraints,
  projectParameters?: ProjectParameters | null,
  signal?: AbortSignal
): Promise<LocalStreetExpansionResult> {
  recomputeCounter.increment('localStreet')
  generationPerformance.start('localStreet')
  turfCounter.setCaller('localStreet')
  try {
  const mcpi = programResult.mcpi
  const terrainSuitability: TerrainSuitabilityResult | null | undefined = constraints.terrainSuitability
  const warnings: string[] = []

  const pipelineAudit: any = {
    mcpi,
    stage: 'pipeline',
    baselineStatus: null,
    unusedProgrammableAreaAcres: null,
    targetBlockCount: 0,
    eligibleTargetBlockCount: 0,
    primaryOriginRoadCount: 0,
    secondaryOriginRoadCount: 0,
    originPointCount: 0,
    originPointsByType: { 'primary-endpoint': 0, 'secondary-endpoint': 0, 'intersection': 0, 'segment': 0 },
    targetPointCount: 0,
    targetPointsBySource: { centroid: 0, pointOnFeature: 0, interiorSample: 0 },
    originTargetPairCount: 0,
    routeAttempts: 0,
    routesByFamily: { TEE: 0, 'PERP-RIGHT': 0, 'PERP-LEFT': 0 },
    rawRouteCandidates: 0,
    parentRowExitValidCandidates: 0,
    junctionAngleValidCandidates: 0,
    geometryValidCandidates: 0,
    hardValidCandidates: 0,
    benefitEvaluatedCandidates: 0,
    finalCandidateCount: 0,
    benefitRejectedCount: 0,
    hardRejectionCounts: {} as Record<string, number>,
    hardRejectionCategoryCounts: {
      parcelExit: 0,
      candidateAreaExit: 0,
      programmableExit: 0,
      hydrologyCollision: 0,
      buildingCollision: 0,
      pavementCollision: 0,
      rowCollision: 0,
      roadCrossingConflict: 0,
      intersectionAngle: 0,
      excessiveLength: 0,
      excessiveBends: 0,
      targetNotReached: 0,
      duplicateNetwork: 0,
      other: 0
    },
    stopReason: null as LocalStreetStopReason | null,
    originInsideParentRowCount: 0,
    minDistanceTargetToOriginFt: null as number | null,
    medianDistanceTargetToOriginFt: null as number | null,
    maxDistanceTargetToOriginFt: null as number | null,
    largestTarget: null as any,
    largestTargetCounterfactuals: [] as any[],
    intersectionAngleMin: 20,
    intersectionAngleMax: 160,
    minLocalStreetLengthFt: 60,
    maxLocalStreetLengthFt: 1500,
    browserGeometry: {} as any
  }

  const localStreetEquivalenceComparisons: any[] = []
  const fastEvaluationResults: any[] = []
  const fastCandidateStageTimings: any[] = []

  workflowCriticalPath.start('baselineLayout')
  const tBaseline = performance.now()
  const baseline = await generateConceptualDevelopmentLayout(programResult, blockResult, constraints, projectParameters, 'baseline', `${programResult.mcpi}|baseline`, signal)
  const baselineLayoutMs = performance.now() - tBaseline
  workflowCriticalPath.ready('baselineLayout')
  workflowTimeline.mark('baselineLayoutReady')
  pipelineAudit.baselineLayoutMs = baselineLayoutMs
  const fastPrecomputed = USE_FAST_LOCAL_STREET_EVALUATOR
    ? precomputeFastLocalStreetContext(baseline, constraints, programResult, projectParameters)
    : null

  pipelineAudit.baselineStatus = baseline.status
  pipelineAudit.unusedProgrammableAreaAcres = baseline.unusedProgrammableAreaAcres
  pipelineAudit.browserGeometry = {
    parcelBoundaryExists: !!constraints.parcelBoundary,
    parcelBoundaryType: constraints.parcelBoundary?.geometry?.type ?? null,
    candidateOpenAreaGeometryExists: !!constraints.candidateOpenAreaGeometry,
    candidateOpenAreaGeometryType: constraints.candidateOpenAreaGeometry?.geometry?.type ?? null,
    buildingUnionGeometryExists: !!constraints.buildingUnionGeometry,
    hydrologyGeometryExists: !!constraints.hydrologyGeometry,
    pavementGeometryExists: !!constraints.pavementGeometry,
    conceptualRoadResultExists: !!constraints.conceptualRoadResult,
    secondaryRoadNetworkResultExists: !!constraints.secondaryRoadNetworkResult,
    terrainDataExists: !!constraints.terrainData
  }

  const localStopReason = (reason: LocalStreetStopReason): LocalStreetExpansionResult => {
    pipelineAudit.stopReason = reason
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[LocalStreetPipelineAudit]', pipelineAudit)
    }
    return {
    localStreetNetworkResult: {
      mcpi,
      status: 'empty',
      localStreetCount: 0,
      totalLocalStreetLengthFt: 0,
      localRowAreaAcres: 0,
      baselineLotCount: baseline.lotCount,
      finalLotCount: baseline.lotCount,
      baselineDrawableCapacity: baseline.drawableResidentialCapacity,
      finalDrawableCapacity: baseline.drawableResidentialCapacity,
      incrementalDrawableCapacity: 0,
      baselineLayoutAreaAcres: baseline.layoutAreaAcres,
      finalLayoutAreaAcres: baseline.layoutAreaAcres,
      incrementalLayoutAreaAcres: 0,
      baselineUnusedProgrammableAcres: baseline.unusedProgrammableAreaAcres,
      finalUnusedProgrammableAcres: baseline.unusedProgrammableAreaAcres,
      totalNewTrueFrontageFt: 0,
      stopReason: reason,
      localStreets: [],
      candidateAudits: [],
      selectionAudits: [],
      warnings
    },
    finalLayout: baseline
  }
  }

  if (baseline.status === 'ACCESS_CONSTRAINED' || baseline.status === 'unavailable') {
    return localStopReason('NO_BASELINE_ACCESS')
  }

  const rightOfWayWidthFt = projectParameters?.roads?.rightOfWayWidth ?? 50
  const MAX_LOCAL_STREETS = 4
  const MIN_TARGET_ACRES = 2.0

  const hard = buildHardConstraints(constraints)
  const buildable = constraints.candidateOpenAreaGeometry || constraints.parcelBoundary

  const { origins, audit: originAudit } = collectOrigins(constraints.conceptualRoadResult, constraints.secondaryRoadNetworkResult, hard, buildable, rightOfWayWidthFt)
  pipelineAudit.primaryOriginRoadCount = constraints.conceptualRoadResult ? 1 : 0
  pipelineAudit.secondaryOriginRoadCount = constraints.secondaryRoadNetworkResult?.roads?.length ?? 0
  pipelineAudit.originPointCount = origins.length
  pipelineAudit.endpointOriginCount = originAudit.endpointOrigins
  pipelineAudit.intersectionOriginCount = originAudit.intersectionOrigins
  pipelineAudit.interiorOriginCount = originAudit.interiorOrigins
  pipelineAudit.originsFacingUnusedLand = originAudit.originsFacingUnusedLand
  pipelineAudit.originsRejectedBySpacing = originAudit.originsRejectedBySpacing
  pipelineAudit.originsRejectedByConstraints = originAudit.originsRejectedByConstraints
  for (const o of origins) {
    if (pipelineAudit.originPointsByType[o.originType] !== undefined) {
      pipelineAudit.originPointsByType[o.originType]++
    }
  }
  pipelineAudit.originInsideParentRowCount = origins.filter(o => pointInFeature(o.point, o.parentRowGeometry)).length
  if (origins.length === 0) {
    return localStopReason('NO_CANDIDATE_ORIGINS')
  }

  const { targets, targetGeometryAudits, preFilterComponents } = findUnusedTargets(programResult, constraints, hard, baseline, mcpi, MIN_TARGET_ACRES)
  pipelineAudit.targetBlockCount = targets.length
  pipelineAudit.eligibleTargetBlockCount = targets.length
  pipelineAudit.targetPointCount = targets.length
  pipelineAudit.targetGeometryAudits = targetGeometryAudits
  pipelineAudit.preFilterComponents = preFilterComponents
  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[LocalStreetOriginAudit]', {
      mcpi,
      eligibleRoadCount: pipelineAudit.primaryOriginRoadCount + pipelineAudit.secondaryOriginRoadCount,
      eligiblePrimaryRoadCount: pipelineAudit.primaryOriginRoadCount,
      eligibleSecondaryRoadCount: pipelineAudit.secondaryOriginRoadCount,
      endpointOrigins: originAudit.endpointOrigins,
      intersectionOrigins: originAudit.intersectionOrigins,
      interiorOrigins: originAudit.interiorOrigins,
      originsFacingUnusedLand: originAudit.originsFacingUnusedLand,
      originsRejectedBySpacing: originAudit.originsRejectedBySpacing,
      originsRejectedByConstraints: originAudit.originsRejectedByConstraints,
      totalOrigins: originAudit.totalOrigins,
      originPointCount: origins.length,
      originPointsByType: pipelineAudit.originPointsByType,
      originInsideParentRowCount: pipelineAudit.originInsideParentRowCount
    })
    console.log('[LocalStreetTargetBlockAudit]', {
      mcpi,
      targetCount: targets.length,
      targets: targets.map(t => ({ id: t.id, estimatedAreaAcres: t.estimatedAreaAcres, sampleCount: t.sampleCount }))
    })
  }
  if (targets.length === 0) {
    return localStopReason('NO_TARGET_BLOCKS')
  }

  const candidateStreets: LocalStreetCandidate[] = []
  const benefitAudits: any[] = []
  let prefilterRejectedCount = 0
  let prefilterAcceptedCount = 0
  let fastEvaluatorCallCount = 0
  let bestEvaluatedExistingScore = 0
  const prefilterRejectionReasons: Record<string, number> = {}
  const rejectionCategoryCounts = {
    noBuildableDepartureSide: 0,
    parentRowExitFailure: 0,
    poorJunctionAngle: 0,
    targetNotReached: 0,
    parcelExit: 0,
    hydrologyCollision: 0,
    buildingCollision: 0,
    pavementCollision: 0,
    unrelatedRowCollision: 0,
    routeGeometryQuality: 0,
    marginalBenefit: 0,
    other: 0
  }
  let rejectedCount = 0
  let candidateIndex = 0
  for (const target of targets.slice(0, 6)) {
    if (signal?.aborted) throw new Error('Generation aborted')
    for (const origin of origins) {
      const routes = buildRouteCandidates(origin, target, hard, buildable, rightOfWayWidthFt)
      for (const route of routes) {
        if (candidateIndex % 2 === 0) {
          if (signal?.aborted) throw new Error('Generation aborted')
          await yieldIfNeeded(signal)
        }
        candidateIndex++
        pipelineAudit.routeAttempts++
        pipelineAudit.originTargetPairCount++
        if (route.id !== 'REJECTED') {
          pipelineAudit.routesByFamily[route.id] = (pipelineAudit.routesByFamily[route.id] || 0) + 1
        }
        pipelineAudit.rawRouteCandidates++

        if (!route.buildableSideReached || !route.parentRowExitFound) {
          rejectedCount++
          const cat = route.departureRejectionReason === 'noBuildableDepartureSide' ? 'noBuildableDepartureSide' : 'parentRowExitFailure'
          ;(rejectionCategoryCounts as any)[cat] = ((rejectionCategoryCounts as any)[cat] as number) + 1
          continue
        }

        const { valid, rightOfWay, lengthFt, rejectionReason, conflictCounts, entryAudit } = validateLocalStreetCandidate(route, origin, rightOfWayWidthFt, hard)

        if (entryAudit.validEntryTransition) pipelineAudit.parentRowExitValidCandidates++
        if (rejectionReason !== 'poor junction angle' && entryAudit.validEntryTransition) pipelineAudit.junctionAngleValidCandidates++

        if (!valid) {
          rejectedCount++
          const cat = getRejectionCategory(rejectionReason)
          ;(rejectionCategoryCounts as any)[cat] = ((rejectionCategoryCounts as any)[cat] as number) + 1
          pipelineAudit.hardRejectionCounts[rejectionReason] = (pipelineAudit.hardRejectionCounts[rejectionReason] || 0) + 1
          if (rejectionReason.includes('length outside')) pipelineAudit.hardRejectionCategoryCounts.excessiveLength++
          else if (rejectionReason === 'poor junction angle') pipelineAudit.hardRejectionCategoryCounts.intersectionAngle++
          else if (rejectionReason === 'exits parcel boundary' || rejectionReason === 'ROW mostly outside buildable') pipelineAudit.hardRejectionCategoryCounts.parcelExit++
          else if (rejectionReason === 'HYDROLOGY_CROSSING_REQUIRED' || rejectionReason === 'hydrology crossing') pipelineAudit.hardRejectionCategoryCounts.hydrologyCollision++
          else if (rejectionReason === 'building conflict' || rejectionReason === 'building ROW conflict') pipelineAudit.hardRejectionCategoryCounts.buildingCollision++
          else if (rejectionReason === 'pavement conflict' || rejectionReason === 'pavement ROW conflict') pipelineAudit.hardRejectionCategoryCounts.pavementCollision++
          else if (rejectionReason === 'crosses another road ROW' || rejectionReason === 'other ROW conflict') pipelineAudit.hardRejectionCategoryCounts.rowCollision++
          else if (rejectionReason === 'roadCrossingConflict') pipelineAudit.hardRejectionCategoryCounts.roadCrossingConflict++
          else pipelineAudit.hardRejectionCategoryCounts.other++
          continue
        }

        if (rightOfWay) pipelineAudit.geometryValidCandidates++

        const rowInTarget = rightOfWay ? turfIntersect(rightOfWay, target.geometry) : null
        const rowAreaInsideUnusedTargetAcres = sqFtToAcres(areaSqFtSafe(rowInTarget))
        const lengthInsideUnusedTargetFt = lineLengthInsideTargetFt(route.centerline, target.geometry)
        const entersUnusedTarget = rowAreaInsideUnusedTargetAcres > 0 || lengthInsideUnusedTargetFt > 0

        if (!entersUnusedTarget) {
          rejectedCount++
          const reason = 'does not enter unused target'
          const cat = getRejectionCategory(reason)
          ;(rejectionCategoryCounts as any)[cat] = ((rejectionCategoryCounts as any)[cat] as number) + 1
          pipelineAudit.hardRejectionCounts[reason] = (pipelineAudit.hardRejectionCounts[reason] || 0) + 1
          pipelineAudit.hardRejectionCategoryCounts.targetNotReached++
          continue
        }

        pipelineAudit.hardValidCandidates++
        const localId = generateCandidateId()
        const street: ConceptualLocalStreet = {
          id: localId,
          originRoadId: origin.parentRoadId,
          originRoadType: origin.parentRoadType,
          centerlineGeometry: route.centerline,
          rightOfWayGeometry: rightOfWay,
          lengthFt,
          rightOfWayWidthFt,
          rowAreaAcres: sqFtToAcres(areaSqFtSafe(rightOfWay)),
          targetBlockId: target.id,
          bendCount: route.bendCount,
          terrainInfluence: 'INSUFFICIENT_DATA',
          terrainSuitabilityScoring: null,
          terrainRoadScore: 1,
          terrainPenalty: 0,
          conflictCounts,
          selectionReason: ''
        }

        // Phase 7B.3C: score the centerline once using the cached terrain query before the fast layout.
        if (terrainSuitability && !street.terrainSuitabilityScoring) {
          const scoring = computeRoadTerrainScore(route.centerline, terrainSuitability)
          street.terrainSuitabilityScoring = scoring
          street.terrainRoadScore = scoring.terrainRoadScore
          street.terrainInfluence = scoring.available ? 'USED' : 'INSUFFICIENT_DATA'
        }

        // Phase 7 Pass 1: conservative fast-evaluator prefilter.
        // Maximum achievable new frontage cannot exceed twice the road length inside the unused target.
        // Compare against the best actual existingScore (frontage per road foot) seen so far,
        // which guarantees the raw/highest-frontage baseline winner is never pruned due to terrain.
        const upperBoundExistingScore = (2 * lengthInsideUnusedTargetFt) / Math.max(1, lengthFt)
        const canBeatBest = bestEvaluatedExistingScore === 0 || upperBoundExistingScore >= bestEvaluatedExistingScore
        if (!canBeatBest) {
          prefilterRejectedCount++
          prefilterRejectionReasons['upperBoundBelowBest'] = (prefilterRejectionReasons['upperBoundBelowBest'] || 0) + 1
          continue
        }
        prefilterAcceptedCount++

        // Fast evaluation is the default candidate-ranking path.
        const fastSnapshot = fastPrecomputed
          ? await evaluateLocalStreetCandidate({
              baseline,
              programResult,
              projectParameters,
              target,
              mcpi,
              precomputed: fastPrecomputed,
              candidate: street,
              localId,
              rankOnly: true,
              signal
            })
          : null
        if (fastPrecomputed) fastEvaluatorCallCount++

        // Legacy full layout per candidate is only produced for the comparison flag or legacy mode.
        const legacySnapshot = (USE_COMPARE_LOCAL_STREET_EVALUATORS || USE_LEGACY_LOCAL_STREET_EVALUATOR)
          ? await runLayoutWithStreets(programResult, blockResult, constraints, [street], projectParameters, 'candidate', `${mcpi}|candidate|${localId}`, signal)
          : null

        const withOneStreet: ConceptualDevelopmentLayoutResult = (USE_LEGACY_LOCAL_STREET_EVALUATOR ? legacySnapshot : fastSnapshot) as unknown as ConceptualDevelopmentLayoutResult
        const localGrammarPenalty = (fastSnapshot as any)?.localGrammarPenalty ?? 0
        if (!withOneStreet) {
          continue
        }
        const incrementalLots = withOneStreet.lotCount - baseline.lotCount
        const incrementalDrawables = withOneStreet.drawableResidentialCapacity - baseline.drawableResidentialCapacity
        pipelineAudit.benefitEvaluatedCandidates++

        const newFrontageEstimate = withOneStreet.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt
        const newlyUsedProgrammableAcres = baseline.unusedProgrammableAreaAcres - withOneStreet.unusedProgrammableAreaAcres

        const thisExistingScore = Math.max(0, newFrontageEstimate) / Math.max(1, lengthFt)
        bestEvaluatedExistingScore = Math.max(bestEvaluatedExistingScore, thisExistingScore)

        const localPrefix = `LOCAL-${localId}`
        const localLots = withOneStreet.lotCells.filter((l: any) => l.frontageRoadId && l.frontageRoadId.startsWith(localPrefix))
        const lotCountFromLocalRoad = localLots.length
        const localLotAudits = withOneStreet.conceptualLotAudit.filter((l: any) => l.frontageRoadId && l.frontageRoadId.startsWith(localPrefix))
        const directRowFrontageSegments = localLotAudits.filter((l: any) => l.frontageClassification === 'DIRECT_ROW_FRONTAGE').length
        const validConnectorSegments = localLotAudits.filter((l: any) => l.frontageClassification === 'VALID_ROW_CONNECTOR').length
        const proximityOnlySegments = localLotAudits.filter((l: any) => l.frontageClassification === 'PROXIMITY_ONLY').length
        const noAccessSegments = localLotAudits.filter((l: any) => l.frontageClassification === 'NO_ACCESS').length
        const localUsableFrontageFt = localLots.reduce((s: number, l: any) => s + l.frontageFt, 0)

        const newLotsInPreviouslyUnusedLand = localLots.filter((l: any) => {
          const centroid = safeTurfOp(() => (turf as any).centroid(l.geometry), null)
          return centroid && pointInFeature(centroid, target.geometry)
        })
        const newLotsInUnusedIds = new Set(newLotsInPreviouslyUnusedLand.map((l: any) => l.id))
        const newFrontageOnPreviouslyUnusedLandFt = newLotsInPreviouslyUnusedLand.reduce((s: number, l: any) => s + l.frontageFt, 0)
        const newEnvelopesInPreviouslyUnusedLand = withOneStreet.buildingEnvelopes.filter((e: any) => e.lotId && newLotsInUnusedIds.has(e.lotId)).length
        const newlyUsedPreviouslyUnusedAcres = newLotsInPreviouslyUnusedLand.reduce((s: number, l: any) => s + l.areaAcres, 0)

        const targetAssignment = withOneStreet.useAssignments.find((u: any) => u.zoneId === target.sourceZoneId)

        const minimumFrontageRequired = 0
        const minimumServedAreaRequired = 0
        const minimumDrawableGainRequired = 0
        const minimumEfficiencyRequired = 0

        const passesFrontageGate = newFrontageEstimate > minimumFrontageRequired
        const passesServedAreaGate = newlyUsedProgrammableAcres > minimumServedAreaRequired
        const passesDrawableGainGate = incrementalLots > minimumDrawableGainRequired || incrementalDrawables > minimumDrawableGainRequired
        const passesEfficiencyGate = (lengthFt > 0 && ((incrementalLots / lengthFt) * 100) > minimumEfficiencyRequired)
          || (lengthFt > 0 && (Math.max(0, newFrontageEstimate) / lengthFt) > minimumEfficiencyRequired)

        let firstFailedGate = ''
        if (!passesFrontageGate) firstFailedGate = 'frontage'
        else if (!passesServedAreaGate) firstFailedGate = 'servedArea'
        else if (!passesDrawableGainGate) firstFailedGate = 'drawableGain'
        else if (!passesEfficiencyGate) firstFailedGate = 'efficiency'

        const marginal: LocalStreetMarginalBenefit = {
          candidateId: localId,
          baselineLotCount: baseline.lotCount,
          finalLotCount: withOneStreet.lotCount,
          incrementalLots,
          baselineDrawableCapacity: baseline.drawableResidentialCapacity,
          finalDrawableCapacity: withOneStreet.drawableResidentialCapacity,
          incrementalDrawableCapacity: incrementalDrawables,
          baselineLayoutAreaAcres: baseline.layoutAreaAcres,
          finalLayoutAreaAcres: withOneStreet.layoutAreaAcres,
          incrementalLayoutAreaAcres: withOneStreet.layoutAreaAcres - baseline.layoutAreaAcres,
          baselineUnusedProgrammableAcres: baseline.unusedProgrammableAreaAcres,
          finalUnusedProgrammableAcres: withOneStreet.unusedProgrammableAreaAcres,
          newlyUsedProgrammableAcres,
          newTrueFrontageFt: Math.max(0, newFrontageEstimate),
          roadLengthFt: lengthFt,
          roadEfficiencyLotsPer100Ft: lengthFt > 0 ? (incrementalLots / lengthFt) * 100 : 0,
          roadEfficiencyFrontagePerFt: lengthFt > 0 ? Math.max(0, newFrontageEstimate) / lengthFt : 0
        }

        if (VERBOSE_GIS_DIAGNOSTICS) {
        benefitAudits.push({
          candidateId: localId,
          parentRoad: origin.parentRoadId,
          originType: origin.originType,
          routeFamily: route.id,
          roadLengthFt: lengthFt,
          rowAreaAcres: street.rowAreaAcres,
          targetBlockId: target.id,
          targetBlockAreaAcres: target.areaAcres,
          targetUnusedAcres: target.areaAcres,
          sourceAreaAcres: target.sourceAreaAcres,
          before: {
            baselineLotCount: baseline.lotCount,
            baselineEnvelopeCount: baseline.buildingEnvelopeCount,
            baselineLayoutAreaAcres: baseline.layoutAreaAcres,
            baselineUnusedProgrammableAcres: baseline.unusedProgrammableAreaAcres,
            baselineTrueFrontageFt: baseline.lotFrontageGenerationAudit.totalLotFrontageFt
          },
          after: {
            candidateLotCount: withOneStreet.lotCount,
            candidateEnvelopeCount: withOneStreet.buildingEnvelopeCount,
            candidateLayoutAreaAcres: withOneStreet.layoutAreaAcres,
            candidateUnusedProgrammableAcres: withOneStreet.unusedProgrammableAreaAcres,
            candidateTrueFrontageFt: withOneStreet.lotFrontageGenerationAudit.totalLotFrontageFt
          },
          marginal: {
            additionalLots: incrementalLots,
            additionalEnvelopes: withOneStreet.buildingEnvelopeCount - baseline.buildingEnvelopeCount,
            additionalLayoutAreaAcres: withOneStreet.layoutAreaAcres - baseline.layoutAreaAcres,
            reducedUnusedProgrammableAcres: newlyUsedProgrammableAcres,
            newTrueFrontageFt: Math.max(0, newFrontageEstimate),
            newlyServedAreaAcres: Math.max(0, newlyUsedProgrammableAcres)
          },
          trueUnused: {
            entersUnusedTarget,
            lengthInsideUnusedTargetFt,
            rowAreaInsideUnusedTargetAcres,
            grossLocalRoadLots: lotCountFromLocalRoad,
            netAdditionalLots: incrementalLots,
            newLotsInPreviouslyUnusedLand: newLotsInPreviouslyUnusedLand.length,
            newEnvelopesInPreviouslyUnusedLand,
            newFrontageOnPreviouslyUnusedLandFt,
            newlyUsedPreviouslyUnusedAcres,
            newDrawablesInPreviouslyUnusedLand: newLotsInPreviouslyUnusedLand.length
          },
          efficiency: {
            additionalLotsPer100RoadFt: lengthFt > 0 ? (incrementalLots / lengthFt) * 100 : 0,
            newFrontagePerRoadFt: lengthFt > 0 ? Math.max(0, newFrontageEstimate) / lengthFt : 0,
            newlyUsedAcresPer100RoadFt: lengthFt > 0 ? (newlyUsedProgrammableAcres / lengthFt) * 100 : 0,
            newlyUsedPreviouslyUnusedAcresPer100RoadFt: lengthFt > 0 ? (newlyUsedPreviouslyUnusedAcres / lengthFt) * 100 : 0
          },
          gates: {
            minimumFrontageRequired,
            minimumServedAreaRequired,
            minimumDrawableGainRequired,
            minimumEfficiencyRequired
          },
          final: {
            passesFrontageGate,
            passesServedAreaGate,
            passesDrawableGainGate,
            passesEfficiencyGate,
            firstFailedGate,
            acceptedForRanking: passesDrawableGainGate
          },
          integration: {
            localCenterlineIncluded: !!street.centerlineGeometry,
            localRowIncluded: !!street.rightOfWayGeometry,
            roadTypeRecognizedAsLocal: true,
            collectRoadRowsRecognizesLocal: true,
            frontageExtractorSeesLocalRow: lotCountFromLocalRoad > 0 || localLotAudits.length > 0,
            frontageSegmentCountFromLocalRoad: localLotAudits.length,
            lotCountFromLocalRoad,
            directRowFrontageSegments,
            validConnectorSegments,
            proximityOnlySegments,
            noAccessSegments,
            localRowBoundaryLengthFt: rowBoundaryLengthFt(rightOfWay),
            localUsableFrontageFt
          },
          targetBlock: {
            targetInBuildable: buildable ? pointInFeature(target.point, buildable) : false,
            localRowTouchesTarget: buildable && rightOfWay ? !!turfIntersect(rightOfWay, buildable) : false,
            targetZoneId: target.sourceZoneId,
            sourceBlockId: target.sourceBlockId,
            targetZoneRoadRelationship: target.sourceRoadRelationship,
            targetZoneProgramStatus: target.sourceZoneProgramStatus,
            targetZoneSingleFamilyCompatibility: target.compatibilityByUse?.['single-family'] || 'UNSUITABLE',
            targetZoneAssignedUse: target.sourceAssignedUse ?? targetAssignment?.assignedUse ?? null,
            targetZoneAssignmentReason: targetAssignment?.reason ?? ''
          },
          hardConflicts: conflictCounts
        })
        }

        // Fast-vs-legacy comparison is only produced when the compare flag is enabled.
        if (USE_COMPARE_LOCAL_STREET_EVALUATORS && fastSnapshot && legacySnapshot) {
          const fastIncrementalLots = fastSnapshot.lotCount - baseline.lotCount
          const fastIncrementalDrawables = fastSnapshot.drawableResidentialCapacity - baseline.drawableResidentialCapacity
          const fastNewFrontageEstimate = fastSnapshot.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt
          const fastNewlyUsedProgrammableAcres = baseline.unusedProgrammableAreaAcres - fastSnapshot.unusedProgrammableAreaAcres

          const fastPassesFrontageGate = fastNewFrontageEstimate > minimumFrontageRequired
          const fastPassesServedAreaGate = fastNewlyUsedProgrammableAcres > minimumServedAreaRequired
          const fastPassesDrawableGainGate = fastIncrementalLots > minimumDrawableGainRequired || fastIncrementalDrawables > minimumDrawableGainRequired
          const fastPassesEfficiencyGate = (lengthFt > 0 && ((fastIncrementalLots / lengthFt) * 100) > minimumEfficiencyRequired)
            || (lengthFt > 0 && (Math.max(0, fastNewFrontageEstimate) / lengthFt) > minimumEfficiencyRequired)

          const legacyIncrementalLots = legacySnapshot.lotCount - baseline.lotCount
          const legacyIncrementalDrawables = legacySnapshot.drawableResidentialCapacity - baseline.drawableResidentialCapacity
          const legacyNewFrontageEstimate = legacySnapshot.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt
          const legacyNewlyUsedProgrammableAcres = baseline.unusedProgrammableAreaAcres - legacySnapshot.unusedProgrammableAreaAcres

          const legacyPassesFrontageGate = legacyNewFrontageEstimate > minimumFrontageRequired
          const legacyPassesServedAreaGate = legacyNewlyUsedProgrammableAcres > minimumServedAreaRequired
          const legacyPassesDrawableGainGate = legacyIncrementalLots > minimumDrawableGainRequired || legacyIncrementalDrawables > minimumDrawableGainRequired
          const legacyPassesEfficiencyGate = (lengthFt > 0 && ((legacyIncrementalLots / lengthFt) * 100) > minimumEfficiencyRequired)
            || (lengthFt > 0 && (Math.max(0, legacyNewFrontageEstimate) / lengthFt) > minimumEfficiencyRequired)

          const comparison = {
            candidateId: localId,
            old: {
              incrementalLots: legacyIncrementalLots,
              incrementalDrawables: legacyIncrementalDrawables,
              newFrontageEstimate: legacyNewFrontageEstimate,
              newlyUsedProgrammableAcres: legacyNewlyUsedProgrammableAcres,
              passesFrontageGate: legacyPassesFrontageGate,
              passesServedAreaGate: legacyPassesServedAreaGate,
              passesDrawableGainGate: legacyPassesDrawableGainGate,
              passesEfficiencyGate: legacyPassesEfficiencyGate,
              acceptedForRanking: legacyPassesFrontageGate && legacyPassesServedAreaGate && legacyPassesDrawableGainGate && legacyPassesEfficiencyGate
            },
            fast: {
              incrementalLots: fastIncrementalLots,
              incrementalDrawables: fastIncrementalDrawables,
              newFrontageEstimate: fastNewFrontageEstimate,
              newlyUsedProgrammableAcres: fastNewlyUsedProgrammableAcres,
              passesFrontageGate: fastPassesFrontageGate,
              passesServedAreaGate: fastPassesServedAreaGate,
              passesDrawableGainGate: fastPassesDrawableGainGate,
              passesEfficiencyGate: fastPassesEfficiencyGate,
              acceptedForRanking: fastPassesFrontageGate && fastPassesServedAreaGate && fastPassesDrawableGainGate && fastPassesEfficiencyGate
            },
            differences: {
              incrementalLots: round3(fastIncrementalLots - legacyIncrementalLots),
              incrementalDrawables: round3(fastIncrementalDrawables - legacyIncrementalDrawables),
              newFrontageEstimate: round3(fastNewFrontageEstimate - legacyNewFrontageEstimate),
              newlyUsedProgrammableAcres: round3(fastNewlyUsedProgrammableAcres - legacyNewlyUsedProgrammableAcres)
            },
            equivalent:
              Math.abs(fastIncrementalLots - legacyIncrementalLots) < 0.5 &&
              Math.abs(fastIncrementalDrawables - legacyIncrementalDrawables) < 0.5 &&
              Math.abs(fastNewFrontageEstimate - legacyNewFrontageEstimate) < 5.0 &&
              Math.abs(fastNewlyUsedProgrammableAcres - legacyNewlyUsedProgrammableAcres) < 0.1 &&
              fastPassesFrontageGate === legacyPassesFrontageGate &&
              fastPassesServedAreaGate === legacyPassesServedAreaGate &&
              fastPassesDrawableGainGate === legacyPassesDrawableGainGate &&
              fastPassesEfficiencyGate === legacyPassesEfficiencyGate
          }
          localStreetEquivalenceComparisons.push(comparison)
        }

        if (ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS && fastSnapshot && fastSnapshot.stageTimings) {
          fastCandidateStageTimings.push(fastSnapshot.stageTimings)
        }

        if (fastSnapshot) {
          const fastIncrementalLots = fastSnapshot.lotCount - baseline.lotCount
          const fastIncrementalDrawables = fastSnapshot.drawableResidentialCapacity - baseline.drawableResidentialCapacity
          const fastNewFrontageEstimate = fastSnapshot.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt
          const fastNewlyUsedProgrammableAcres = baseline.unusedProgrammableAreaAcres - fastSnapshot.unusedProgrammableAreaAcres

          const fastPassesFrontageGate = fastNewFrontageEstimate > minimumFrontageRequired
          const fastPassesServedAreaGate = fastNewlyUsedProgrammableAcres > minimumServedAreaRequired
          const fastPassesDrawableGainGate = fastIncrementalLots > minimumDrawableGainRequired || fastIncrementalDrawables > minimumDrawableGainRequired
          const fastPassesEfficiencyGate = (lengthFt > 0 && ((fastIncrementalLots / lengthFt) * 100) > minimumEfficiencyRequired)
            || (lengthFt > 0 && (Math.max(0, fastNewFrontageEstimate) / lengthFt) > minimumEfficiencyRequired)
          const fastAcceptedForRanking = fastPassesFrontageGate && fastPassesServedAreaGate && fastPassesDrawableGainGate && fastPassesEfficiencyGate

          fastEvaluationResults.push({
          localId,
          lengthFt,
          newTrueFrontageFt: Math.max(0, fastNewFrontageEstimate),
          incrementalLots: fastIncrementalLots,
          incrementalDrawables: fastIncrementalDrawables,
          acceptedForRanking: fastAcceptedForRanking
        })

        if (incrementalLots <= 0 && incrementalDrawables <= 0) {
          rejectedCount++
          rejectionCategoryCounts.marginalBenefit = (rejectionCategoryCounts.marginalBenefit as number) + 1
          pipelineAudit.benefitRejectedCount++
          continue
        }

        // Phase 7B.3C: soft terrain penalty applied to the frontage-per-foot efficiency score.
        const existingScore = marginal.newTrueFrontageFt / Math.max(1, lengthFt)
        const terrainPenalty = existingScore * (1 - (street.terrainRoadScore ?? 1)) * LOCAL_STREET_TERRAIN_INFLUENCE_PCT
        const finalScore = Math.max(0, existingScore - terrainPenalty - localGrammarPenalty)

        candidateStreets.push({
          id: localId,
          originRoadId: origin.parentRoadId,
          originRoadType: origin.parentRoadType,
          originType: origin.parentRoadType === 'primary'
            ? 'primary-segment'
            : origin.originType === 'interior'
              ? 'secondary-segment'
              : origin.originType === 'intersection'
                ? 'secondary-node'
                : 'secondary-endpoint',
          targetBlockId: target.id,
          centerlineGeometry: street.centerlineGeometry,
          rightOfWayGeometry: street.rightOfWayGeometry,
          lengthFt,
          rightOfWayWidthFt,
          rowAreaAcres: street.rowAreaAcres,
          bendCount: route.bendCount,
          newTrueFrontageFt: marginal.newTrueFrontageFt,
          estimatedNewServedAreaAcres: marginal.newlyUsedProgrammableAcres,
          existingScore,
          terrainRoadScore: street.terrainRoadScore,
          terrainPenalty,
          localGrammarPenalty,
          finalScore,
          terrainSuitabilityScoring: street.terrainSuitabilityScoring,
          accepted: true,
          rejectionReason: '',
          conflictCounts,
          terrainInfluence: street.terrainInfluence
        })
      }
    }
  }
  }

  pipelineAudit.rejectionCategoryCounts = rejectionCategoryCounts
  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[LocalStreetRejectionAudit]', {
      mcpi,
      ...rejectionCategoryCounts,
      totalRejections: rejectedCount
    })
  }

  if (VERBOSE_GIS_DIAGNOSTICS && benefitAudits.length > 0) {
    const rankedForDiagnostic = [...benefitAudits].sort((a, b) => {
      if (b.marginal.additionalLots !== a.marginal.additionalLots) return b.marginal.additionalLots - a.marginal.additionalLots
      if (b.marginal.newTrueFrontageFt !== a.marginal.newTrueFrontageFt) return b.marginal.newTrueFrontageFt - a.marginal.newTrueFrontageFt
      if (b.marginal.newlyServedAreaAcres !== a.marginal.newlyServedAreaAcres) return b.marginal.newlyServedAreaAcres - a.marginal.newlyServedAreaAcres
      return a.roadLengthFt - b.roadLengthFt
    })

    const thresholdFreeBest = rankedForDiagnostic[0]
    const bestBenefit = rankedForDiagnostic[0]

    console.log('[LocalStreetBenefitAudit]', {
      mcpi,
      hardValidCandidates: benefitAudits.length,
      selectedCandidateId: bestBenefit?.candidateId,
      selectedNewLots: bestBenefit?.marginal?.additionalLots,
      selectedNewFrontageFt: bestBenefit?.marginal?.newTrueFrontageFt,
      selectedNewlyServedAreaAcres: bestBenefit?.marginal?.newlyServedAreaAcres,
      selectedNewLotsInPreviouslyUnusedLand: bestBenefit?.trueUnused?.newLotsInPreviouslyUnusedLand
    })

    console.log('[LocalStreetCounterfactualAudit]', {
      mcpi,
      selectedWithoutThresholds: true,
      candidateId: thresholdFreeBest.candidateId,
      parentRoad: thresholdFreeBest.parentRoad,
      originType: thresholdFreeBest.originType,
      routeFamily: thresholdFreeBest.routeFamily,
      roadLengthFt: thresholdFreeBest.roadLengthFt,
      rowAreaAcres: thresholdFreeBest.rowAreaAcres,
      targetBlockId: thresholdFreeBest.targetBlockId,
      targetBlockAreaAcres: thresholdFreeBest.targetBlockAreaAcres,
      targetUnusedAcres: thresholdFreeBest.targetUnusedAcres,
      resultingLotCount: thresholdFreeBest.after.candidateLotCount,
      resultingEnvelopeCount: thresholdFreeBest.after.candidateEnvelopeCount,
      layoutAcreage: thresholdFreeBest.after.candidateLayoutAreaAcres,
      unusedProgrammableAcres: thresholdFreeBest.after.candidateUnusedProgrammableAcres,
      newFrontage: thresholdFreeBest.marginal.newTrueFrontageFt,
      additionalLots: thresholdFreeBest.marginal.additionalLots,
      additionalEnvelopes: thresholdFreeBest.marginal.additionalEnvelopes,
      additionalLayoutAreaAcres: thresholdFreeBest.marginal.additionalLayoutAreaAcres,
      newlyServedAreaAcres: thresholdFreeBest.marginal.newlyServedAreaAcres,
      hardConflicts: thresholdFreeBest.hardConflicts,
      targetZoneRoadRelationship: thresholdFreeBest.targetBlock.targetZoneRoadRelationship,
      targetZoneAssignedUse: thresholdFreeBest.targetBlock.targetZoneAssignedUse,
      lotCountFromLocalRoad: thresholdFreeBest.integration.lotCountFromLocalRoad,
      newLotsInPreviouslyUnusedLand: thresholdFreeBest.trueUnused.newLotsInPreviouslyUnusedLand,
      newFrontageOnPreviouslyUnusedLandFt: thresholdFreeBest.trueUnused.newFrontageOnPreviouslyUnusedLandFt,
      newlyUsedPreviouslyUnusedAcres: thresholdFreeBest.trueUnused.newlyUsedPreviouslyUnusedAcres,
      trueUnused: thresholdFreeBest.trueUnused,
      integration: thresholdFreeBest.integration,
      thresholdGatesPassed: thresholdFreeBest.final
    })
  }

  if (candidateStreets.length === 0) {
    return localStopReason('NO_VALID_CANDIDATES')
  }

  candidateStreets.sort((a, b) => {
    if ((b.finalScore ?? 0) !== (a.finalScore ?? 0)) return (b.finalScore ?? 0) - (a.finalScore ?? 0)
    if ((b.existingScore ?? 0) !== (a.existingScore ?? 0)) return (b.existingScore ?? 0) - (a.existingScore ?? 0)
    if (b.newTrueFrontageFt !== a.newTrueFrontageFt) return b.newTrueFrontageFt - a.newTrueFrontageFt
    if (a.lengthFt !== b.lengthFt) return a.lengthFt - b.lengthFt
    return a.bendCount - b.bendCount
  })

  const baselineSorted = [...candidateStreets].sort((a, b) => {
    if ((b.existingScore ?? 0) !== (a.existingScore ?? 0)) return (b.existingScore ?? 0) - (a.existingScore ?? 0)
    if (b.newTrueFrontageFt !== a.newTrueFrontageFt) return b.newTrueFrontageFt - a.newTrueFrontageFt
    if (a.lengthFt !== b.lengthFt) return a.lengthFt - b.lengthFt
    return a.bendCount - b.bendCount
  })

  const selected: ConceptualLocalStreet[] = []
  const selectionAudits: LocalStreetSelectionAuditItem[] = []
  const iterationAudits: any[] = []
  let terrainChangedSelectionCount = 0
  let selectedStop: LocalStreetStopReason = 'NO_MARGINAL_BENEFIT'

  function conflictsWithSelected(cand: LocalStreetCandidate): boolean {
    for (const s of selected) {
      const inter = turfIntersect(cand.rightOfWayGeometry, s.rightOfWayGeometry)
      if (inter && areaSqFtSafe(inter) > 1) return true
    }
    return false
  }

  for (let i = 0; i < MAX_LOCAL_STREETS && i < candidateStreets.length; i++) {
    if (signal?.aborted) throw new Error('Generation aborted')
    if (i % 1 === 0) await yieldIfNeeded(signal)
    const cand = candidateStreets[i]
    let conflict = false
    for (const s of selected) {
      const inter = turfIntersect(cand.rightOfWayGeometry, s.rightOfWayGeometry)
      if (inter && areaSqFtSafe(inter) > 1) {
        conflict = true
        break
      }
    }
    if (conflict) continue

    const street: ConceptualLocalStreet = {
      id: cand.id,
      originRoadId: cand.originRoadId,
      originRoadType: cand.originRoadType,
      centerlineGeometry: cand.centerlineGeometry,
      rightOfWayGeometry: cand.rightOfWayGeometry,
      lengthFt: cand.lengthFt,
      rightOfWayWidthFt: cand.rightOfWayWidthFt,
      rowAreaAcres: cand.rowAreaAcres,
      targetBlockId: cand.targetBlockId,
      bendCount: cand.bendCount,
      terrainInfluence: cand.terrainInfluence,
      terrainRoadScore: cand.terrainRoadScore,
      terrainPenalty: cand.terrainPenalty,
      terrainSuitabilityScoring: cand.terrainSuitabilityScoring,
      conflictCounts: cand.conflictCounts,
      selectionReason: cand.rejectionReason || 'selected by terrain-adjusted frontage/road-length score (~20% terrain)'
    }

    // DEV audit computed before the candidate is added to selected, so the pre-selection pool is retained.
    if (import.meta.env.DEV) {
      const eligible: LocalStreetCandidate[] = []
      for (const c of candidateStreets) {
        if (selected.some(s => s.id === c.id)) continue
        if (conflictsWithSelected(c)) continue
        eligible.push(c)
      }

      const baselineWinner = baselineSorted.find(c => eligible.some(e => e.id === c.id))
      const winnerChanged = !!(baselineWinner && baselineWinner.id !== cand.id)
      if (winnerChanged) {
        terrainChangedSelectionCount++
      }

      const MAX_AUDIT_CANDIDATES = 5
      const auditCandidates = eligible.slice(0, MAX_AUDIT_CANDIDATES)
      const candidateOutputCapped = eligible.length > MAX_AUDIT_CANDIDATES

      const makeCandidateAudit = (c: LocalStreetCandidate) => ({
        candidateId: c.id,
        candidateType: c.originType,
        existingScore: round3(c.existingScore ?? 0),
        terrainRoadScore: round3(c.terrainRoadScore ?? 1),
        terrainPenalty: round3(c.terrainPenalty ?? 0),
        finalScore: round3(c.finalScore ?? 0),
        newlyServedAreaAcres: round3(c.estimatedNewServedAreaAcres ?? 0),
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
        hardRejected: !c.accepted
      })

      iterationAudits.push({
        iteration: i + 1,
        targetBlockId: cand.targetBlockId,
        candidateCount: eligible.length,
        reportedCandidateCount: auditCandidates.length,
        candidateOutputCapped,
        baselineWinnerWithoutSuitability: baselineWinner
          ? {
              candidateId: baselineWinner.id,
              existingScore: round3(baselineWinner.existingScore ?? 0),
              newlyServedAreaAcres: round3(baselineWinner.estimatedNewServedAreaAcres ?? 0),
              roadLengthFt: round3(baselineWinner.lengthFt)
            }
          : null,
        winnerWithSuitability: {
          candidateId: cand.id,
          existingScore: round3(cand.existingScore ?? 0),
          terrainRoadScore: round3(cand.terrainRoadScore ?? 1),
          finalScore: round3(cand.finalScore ?? 0),
          newlyServedAreaAcres: round3(cand.estimatedNewServedAreaAcres ?? 0),
          roadLengthFt: round3(cand.lengthFt)
        },
        winnerChangedBecauseOfTerrain: winnerChanged,
        candidates: auditCandidates.map(makeCandidateAudit)
      })
    }

    selected.push(street)
    selectionAudits.push({
      iteration: i + 1,
      selectedCandidateId: cand.id,
      origin: cand.originRoadId,
      targetBlock: cand.targetBlockId,
      roadLengthFt: cand.lengthFt,
      newFrontageFt: cand.newTrueFrontageFt,
      newDrawableUnits: 0,
      newUsedAcres: cand.estimatedNewServedAreaAcres,
      remainingUnusedAcres: 0,
      marginalEfficiency: cand.newTrueFrontageFt / Math.max(1, cand.lengthFt),
      selectionReason: street.selectionReason
    })

    if (selected.length >= MAX_LOCAL_STREETS) {
      selectedStop = 'MAX_LOCAL_STREETS_REACHED'
    }
  }

  if (selected.length === 0) {
    return localStopReason('NO_MARGINAL_BENEFIT')
  }

  const finalSemanticKey = `${programResult.mcpi}|final|${selected.map(s => s.id).sort().join(',')}`
  workflowCriticalPath.start('selectedFinalLayout')
  const tFinal = performance.now()
  const finalLayout = await runLayoutWithStreets(programResult, blockResult, constraints, selected, projectParameters, 'final', finalSemanticKey, signal)
  const selectedFinalLayoutMs = performance.now() - tFinal
  workflowCriticalPath.ready('selectedFinalLayout')
  workflowTimeline.mark('selectedFinalLayoutReady')
  pipelineAudit.selectedFinalLayoutMs = selectedFinalLayoutMs

  for (let i = 0; i < selectionAudits.length; i++) {
    selectionAudits[i].newDrawableUnits = finalLayout.drawableResidentialCapacity - baseline.drawableResidentialCapacity
    selectionAudits[i].remainingUnusedAcres = finalLayout.unusedProgrammableAreaAcres
  }

  const selectedRoad = selected[0]
  const finalLotsClassified: any[] = []
  let preservedCount = 0
  let removedByLocalRowCount = 0
  let removedByRelayoutCount = 0
  let newOnLocalStreetCount = 0
  let newElsewhereCount = 0

  function lotOverlapArea(a: any, b: any): number {
    if (!a?.geometry || !b?.geometry) return 0
    return sqFtToAcres(areaSqFtSafe(turfIntersect(a.geometry, b.geometry)))
  }

  if (selectedRoad) {
    const localRightOfWay = selectedRoad.rightOfWayGeometry
    const preservedBaselineIds = new Set<string>()

    for (const finalLot of finalLayout.lotCells) {
      const isLocal = finalLot.frontageRoadId && (finalLot.frontageRoadId as string).startsWith(`LOCAL-${selectedRoad.id}`)
      if (isLocal) {
        newOnLocalStreetCount++
        finalLotsClassified.push({ lotId: finalLot.id, classification: 'NEW_ON_LOCAL_STREET' })
        continue
      }
      let bestOverlap = 0
      let bestBaselineId: string | null = null
      for (const baseLot of baseline.lotCells) {
        const o = lotOverlapArea(finalLot, baseLot)
        if (o > bestOverlap) {
          bestOverlap = o
          bestBaselineId = baseLot.id
        }
      }
      if (bestOverlap > 0.01 && bestBaselineId) {
        preservedBaselineIds.add(bestBaselineId)
        finalLotsClassified.push({ lotId: finalLot.id, classification: 'PRESERVED' })
      } else {
        newElsewhereCount++
        finalLotsClassified.push({ lotId: finalLot.id, classification: 'NEW_ELSEWHERE' })
      }
    }

    for (const baseLot of baseline.lotCells) {
      if (preservedBaselineIds.has(baseLot.id)) {
        continue
      }
      const rowOverlap = localRightOfWay ? lotOverlapArea(baseLot, { geometry: localRightOfWay }) : 0
      if (rowOverlap > 0.01) {
        removedByLocalRowCount++
      } else {
        removedByRelayoutCount++
      }
    }

    preservedCount = preservedBaselineIds.size
    const finalLotCount = finalLayout.lotCells.length
    const baselineLotCount = baseline.lotCells.length
    const netLotGain = finalLotCount - baselineLotCount
    const grossGainAcres = Math.max(0, finalLayout.layoutAreaAcres - baseline.layoutAreaAcres)
    const grossLossAcres = removedByLocalRowCount > 0
      ? (() => { let s = 0; for (const bl of baseline.lotCells) { const io = localRightOfWay ? lotOverlapArea(bl, { geometry: localRightOfWay }) : 0; if (io > 0.01) s += Math.min(bl.areaAcres, io) } return s })()
      : 0
    const netLayoutGainAcres = grossGainAcres
    const baselineLotConservationPassed = (preservedCount + removedByLocalRowCount + removedByRelayoutCount) === baselineLotCount
    const finalLotConservationPassed = (preservedCount + newOnLocalStreetCount + newElsewhereCount) === finalLotCount

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[LocalStreetLotDeltaAudit]', {
        mcpi,
        baselineLotCount,
        finalLotCount,
        preservedCount,
        removedByLocalRowCount,
        removedByRelayoutCount,
        newOnLocalStreetCount,
        newElsewhereCount,
        netLotGain,
        grossGainAcres,
        grossLossAcres,
        netLayoutGainAcres,
        baselineLotConservationPassed,
        finalLotConservationPassed,
        lotDetails: finalLotsClassified
      })

      const road = selectedRoad
      const roadLengthFt = road.lengthFt
      const newTrueFrontageFt = finalLayout.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt
      const newUsedAcres = finalLayout.layoutAreaAcres - baseline.layoutAreaAcres
      console.log('[LocalStreetFrontageEfficiencyAudit]', {
        mcpi,
        candidateId: road.id,
        roadLengthFt,
        usableNewFrontageFt: newTrueFrontageFt,
        grossNewLots: newOnLocalStreetCount,
        netNewLots: netLotGain,
        newUsedAcres,
        frontagePerRoadFt: roadLengthFt > 0 ? newTrueFrontageFt / roadLengthFt : 0,
        grossLotsPer100RoadFt: roadLengthFt > 0 ? (newOnLocalStreetCount / roadLengthFt) * 100 : 0,
        netLotsPer100RoadFt: roadLengthFt > 0 ? (netLotGain / roadLengthFt) * 100 : 0,
        newlyUsedAcresPer100RoadFt: roadLengthFt > 0 ? (newUsedAcres / roadLengthFt) * 100 : 0
      })

      const selectedBenefit = benefitAudits.find((a: any) => a.candidateId === road.id)
      console.log('[LocalStreetRoadQualityAudit]', {
        mcpi,
        candidateId: road.id,
        parentRoad: road.originRoadId,
        roadLengthFt: road.lengthFt,
        rowAreaAcres: road.rowAreaAcres,
        junctionAngleDeg: null,
        parentRowExitValid: null,
        entersTrueUnusedTarget: selectedBenefit?.trueUnused?.entersUnusedTarget ?? null,
        noProximityOnlyLots: (selectedBenefit?.integration?.proximityOnlySegments || 0) === 0,
        localUsableFrontageFt: selectedBenefit?.integration?.localUsableFrontageFt ?? null,
        conflictCounts: road.conflictCounts,
        targetBlockId: road.targetBlockId,
        targetZoneRoadRelationship: selectedBenefit?.targetBlock?.targetZoneRoadRelationship ?? null,
        targetZoneAssignedUse: selectedBenefit?.targetBlock?.targetZoneAssignedUse ?? null
      })
    }
  }

  const result: LocalStreetNetworkResult = {
    mcpi,
    status: 'generated',
    localStreetCount: selected.length,
    totalLocalStreetLengthFt: selected.reduce((s, r) => s + r.lengthFt, 0),
    localRowAreaAcres: selected.reduce((s, r) => s + r.rowAreaAcres, 0),
    baselineLotCount: baseline.lotCount,
    finalLotCount: finalLayout.lotCount,
    baselineDrawableCapacity: baseline.drawableResidentialCapacity,
    finalDrawableCapacity: finalLayout.drawableResidentialCapacity,
    incrementalDrawableCapacity: finalLayout.drawableResidentialCapacity - baseline.drawableResidentialCapacity,
    baselineLayoutAreaAcres: baseline.layoutAreaAcres,
    finalLayoutAreaAcres: finalLayout.layoutAreaAcres,
    incrementalLayoutAreaAcres: finalLayout.layoutAreaAcres - baseline.layoutAreaAcres,
    baselineUnusedProgrammableAcres: baseline.unusedProgrammableAreaAcres,
    finalUnusedProgrammableAcres: finalLayout.unusedProgrammableAreaAcres,
    totalNewTrueFrontageFt: finalLayout.lotFrontageGenerationAudit.totalLotFrontageFt - baseline.lotFrontageGenerationAudit.totalLotFrontageFt,
    stopReason: selectedStop,
    localStreets: selected,
    candidateAudits: candidateStreets.map(c => ({
      id: c.id,
      originRoad: c.originRoadId,
      originType: c.originType,
      targetBlockId: c.targetBlockId,
      roadLengthFt: c.lengthFt,
      bendCount: c.bendCount,
      rowAreaAcres: c.rowAreaAcres,
      newTrueFrontageFt: c.newTrueFrontageFt,
      newlyServedAreaAcres: c.estimatedNewServedAreaAcres,
      additionalDrawableUnits: 0,
      additionalPads: 0,
      newlyUsedLayoutAreaAcres: c.estimatedNewServedAreaAcres,
      efficiency: c.newTrueFrontageFt / Math.max(1, c.lengthFt),
      terrainAssessment: c.terrainInfluence,
      conflictCounts: c.conflictCounts,
      accepted: c.accepted,
      rejectionReason: c.rejectionReason,
      score: c.newTrueFrontageFt / Math.max(1, c.lengthFt)
    })),
    selectionAudits,
    warnings
  }

  if (import.meta.env.DEV && ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS) {
    const allQueryMs = candidateStreets.map(c => c.terrainSuitabilityScoring?.queryMs ?? 0)
    const totalTerrainQueryMs = round3(allQueryMs.reduce((a, b) => a + b, 0))
    const meanTerrainQueryMs = round3(totalTerrainQueryMs / (allQueryMs.length || 1))
    const maxTerrainQueryMs = round3(Math.max(...allQueryMs))

    console.log('[LocalStreetTerrainScoringAudit]', {
      mcpi,
      targetBlockCount: targets.length,
      iterationCount: iterationAudits.length,
      totalCandidateCount: candidateStreets.length,
      selectedLocalStreetCount: selected.length,
      terrainQueryCount: allQueryMs.length,
      totalTerrainQueryMs,
      meanTerrainQueryMs,
      maxTerrainQueryMs,
      terrainChangedAnySelection: terrainChangedSelectionCount > 0,
      terrainChangedSelectionCount,
      iterations: iterationAudits
    })
  }

  const allEquivalent = localStreetEquivalenceComparisons.length > 0 && localStreetEquivalenceComparisons.every(c => c.equivalent)
  const mismatchCount = localStreetEquivalenceComparisons.filter(c => !c.equivalent).length

  const fastAccepted = fastEvaluationResults.filter((r: any) => r.acceptedForRanking)
  fastAccepted.sort((a: any, b: any) => (b.newTrueFrontageFt / Math.max(1, b.lengthFt)) - (a.newTrueFrontageFt / Math.max(1, a.lengthFt)))
  const fastWinner = fastAccepted[0]
  const fastStopReason: LocalStreetStopReason | null = fastWinner ? selectedStop : (fastEvaluationResults.length > 0 ? 'NO_MARGINAL_BENEFIT' : null)
  const oldWinner = selected[0]

  // A. Test 4 input identity audit
  const primaryRoad = constraints.conceptualRoadResult
  const primaryRoadCandidateId = primaryRoad?.proposedRoadCenterline?.properties?.roadId
    ?? primaryRoad?.proposedRoadCenterline?.properties?.id
    ?? null
  const secondaryRoads = constraints.secondaryRoadNetworkResult?.roads || []
  const secondaryRoadIds = secondaryRoads.map((r: any) => r.id).filter(Boolean)
  const candidateOpenAreaAcres = constraints.candidateOpenAreaGeometry
    ? Math.round(sqFtToAcres(areaSqFtSafe(constraints.candidateOpenAreaGeometry)) * 1000) / 1000
    : null

  const parameterSnapshotSemanticKey = 'mcpi=' + mcpi + ';types=' + (programResult.selectedDevelopmentTypes || []).join(',') + ';density=' + (programResult.targetDensity ?? 'default') + ';lot=' + (programResult.preferredLotSize ?? 'default')
  const roadNetworkSemanticKey = 'primary=' + (primaryRoadCandidateId ?? 'none') + ';secondary=' + secondaryRoadIds.join(',')
  const layoutSemanticKey = 'baselineLots=' + baseline.lotCount + ';finalLots=' + finalLayout.lotCount + ';baselineAcres=' + baseline.layoutAreaAcres + ';finalAcres=' + finalLayout.layoutAreaAcres

  console.log('[Test4InputIdentityAudit]', {
    mcpi,
    workflowRunId: mcpi,
    selectedDevelopmentTypes: programResult.selectedDevelopmentTypes,
    targetDensity: programResult.targetDensity ?? null,
    preferredLotSize: programResult.preferredLotSize ?? null,
    roadNetworkPreference: (projectParameters as any)?.roads?.networkPreference ?? null,
    primaryRoadCandidateId,
    secondaryRoadCount: secondaryRoadIds.length,
    secondaryRoadIds,
    localStreetCandidateCount: fastEvaluationResults.length || benefitAudits.length,
    selectedLocalStreetCandidateId: selected[0]?.id ?? null,
    candidateOpenAreaAcres,
    programZones: programResult.zones.map((z: any) => ({ id: z.id, bestCompatibleUse: z.bestCompatibleUse, areaAcres: z.areaAcres })),
    parameterSnapshotSemanticKey,
    roadNetworkSemanticKey,
    layoutSemanticKey,
    frozenReferenceMatch: 'no-frozen-data-in-workspace'
  })

  if (import.meta.env.DEV) {
    console.log('[LocalStreetPrefilterAudit]', {
      mcpi,
      rawCandidateCount: candidateIndex,
      hardValidCandidateCount: pipelineAudit.hardValidCandidates,
      prefilterAcceptedCount,
      prefilterRejectedCount,
      fastEvaluatorCallCount,
      estimatedEvaluatorCallsAvoided: prefilterRejectedCount,
      rejectionReasons: prefilterRejectionReasons,
      baselineWinnerPreserved: true
    })
  }

  // F. Fast-evaluator hotspot audit
  if (ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS && fastCandidateStageTimings.length > 0) {
    const totalFastEvaluatorMs = fastCandidateStageTimings.reduce((s, t) => s + t.totalMs, 0)
    const byStage = {
      baselineLotIntersectionMs: fastCandidateStageTimings.reduce((s, t) => s + t.baselineLotIntersectionMs, 0),
      preservedConstraintMs: fastCandidateStageTimings.reduce((s, t) => s + t.preservedConstraintMs, 0),
      computeAvailableGeometryMs: fastCandidateStageTimings.reduce((s, t) => s + t.computeAvailableGeometryMs, 0),
      generateSingleFamilyLotsMs: fastCandidateStageTimings.reduce((s, t) => s + t.generateSingleFamilyLotsMs, 0),
      frontageExtractionMs: fastCandidateStageTimings.reduce((s, t) => s + t.frontageExtractionMs, 0),
      metricAssemblyMs: fastCandidateStageTimings.reduce((s, t) => s + t.metricAssemblyMs, 0)
    }
    const slowestStage = (Object.entries(byStage) as [string, number][]).sort((a, b) => b[1] - a[1])[0][0]
    console.log('[FastLocalStreetHotspotAudit]', {
      mcpi,
      candidateCount: fastCandidateStageTimings.length,
      totalFastEvaluatorMs: Math.round(totalFastEvaluatorMs * 100) / 100,
      averageCandidateMs: Math.round((totalFastEvaluatorMs / fastCandidateStageTimings.length) * 100) / 100,
      maxCandidateMs: Math.round(Math.max(...fastCandidateStageTimings.map(t => t.totalMs)) * 100) / 100,
      byStage,
      slowestStage,
      baselineLotIntersectionAttempts: fastCandidateStageTimings.reduce((s, t) => s + t.baselineLotIntersectionAttempts, 0),
      baselineLotIntersectionActualIntersects: fastCandidateStageTimings.reduce((s, t) => s + t.baselineLotIntersectionActualIntersects, 0)
    })
  }

  // F. Fast-evaluator Turf audit
  if (ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS) {
    const fastTurf = turfCounter.getByStage()['fastLocalStreetEvaluator'] || {}
    console.log('[FastLocalStreetTurfAudit]', {
    mcpi,
    booleanPointInPolygon: fastTurf['booleanPointInPolygon'] ?? 0,
    intersect: fastTurf['intersect'] ?? 0,
    difference: fastTurf['difference'] ?? 0,
    featureCollection: fastTurf['featureCollection'] ?? 0,
    nearestPointOnLine: fastTurf['nearestPointOnLine'] ?? 0,
    distance: fastTurf['distance'] ?? 0,
    buffer: fastTurf['buffer'] ?? 0,
    area: fastTurf['area'] ?? 0
  })
  }

  // G. Lot-generation Turf breakdown (next hotspot)
  if (ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS) {
    const lotGenTurf = turfCounter.getByCaller()['generateSingleFamilyLots'] || {}
    console.log('[FastLocalStreetLotGenerationTurfAudit]', {
      mcpi,
      booleanPointInPolygon: lotGenTurf['booleanPointInPolygon'] ?? 0,
      nearestPointOnLine: lotGenTurf['nearestPointOnLine'] ?? 0,
      intersect: lotGenTurf['intersect'] ?? 0,
      difference: lotGenTurf['difference'] ?? 0,
      distance: lotGenTurf['distance'] ?? 0,
      length: lotGenTurf['length'] ?? 0,
      buffer: lotGenTurf['buffer'] ?? 0,
      area: lotGenTurf['area'] ?? 0
    })
  }

  // F. Layout run breakdown
  const rc = recomputeCounter.get()
  console.log('[LayoutRunBreakdownAudit]', {
    mcpi,
    baselineFullLayouts: rc['layout-baseline'] ?? 0,
    candidateFastEvaluations: fastCandidateStageTimings.length,
    candidateFullLayouts: rc['layout-candidate'] ?? 0,
    selectedFinalFullLayouts: rc['layout-final'] ?? 0,
    totalFullLayouts: rc['layout'] ?? 0
  })

  // F. Generation performance and recompute summary
  console.log('[GenerationPerformanceAudit]', generationPerformance.get())
  console.log('[GenerationRecomputeAudit]', recomputeCounter.get())

  // B. Equivalence and regression audits (only when comparison is enabled)
  if (USE_COMPARE_LOCAL_STREET_EVALUATORS) {
    console.log('[LocalStreetEvaluatorEquivalenceAudit]', {
      mcpi,
      useFast: USE_FAST_LOCAL_STREET_EVALUATOR,
      comparisonCount: localStreetEquivalenceComparisons.length,
      allEquivalent,
      mismatchCount
    })

    if (oldWinner && fastWinner) {
      console.log('[LocalStreetWinnerEquivalenceAudit]', {
        mcpi,
        oldWinnerCandidateId: oldWinner.id,
        fastWinnerCandidateId: fastWinner.localId,
        sameWinner: oldWinner.id === fastWinner.localId,
        oldStopReason: selectedStop,
        fastStopReason,
        sameStopReason: selectedStop === fastStopReason
      })
    }

    if (mcpi === '083103527000') {
      const sameWinner = oldWinner?.id === fastWinner?.localId
      const sameStopReason = selectedStop === fastStopReason
      const regressionPassed = allEquivalent && mismatchCount === 0 && sameWinner && sameStopReason
      console.log('[FastLocalStreetRegressionAudit]', {
        mcpi,
        regressionPassed,
        allEquivalent,
        mismatchCount,
        sameWinner,
        sameStopReason,
        oldWinnerCandidateId: oldWinner?.id ?? null,
        fastWinnerCandidateId: fastWinner?.localId ?? null,
        selectedLocalStreetCandidateId: oldWinner?.id ?? null
      })
      if (!regressionPassed) {
        console.warn('[FastLocalStreetRegressionWarning]', {
          mcpi,
          regressionPassed,
          allEquivalent,
          mismatchCount,
          sameWinner,
          sameStopReason
        })
      }
    }
  }

  return { localStreetNetworkResult: result, finalLayout }
} finally {
  turfCounter.clearCaller()
  generationPerformance.finish('localStreet')
}
}
