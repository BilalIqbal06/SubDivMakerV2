// Component Development Opportunity Audit — diagnostic only
// This is a feasibility profiler, not a production ranking score.
// It uses whatever geometry and access-suitability data are already in scope.

import * as turf from '@turf/turf'
import type { ConceptualAccessSuitability } from './conceptualAccessSuitability'

const SQ_M_TO_SQ_FT = 10.7639
const SQ_M_TO_ACRES = 0.000247105
const M_TO_FT = 3.28084

function squareMetersToSquareFeet(v: number): number { return v * SQ_M_TO_SQ_FT }
function squareMetersToAcres(v: number): number { return v * SQ_M_TO_ACRES }
function metersToFeet(v: number): number { return v * M_TO_FT }

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function polygonPerimeterMeters(geometry: any): number {
  if (!geometry || !geometry.coordinates) return 0
  const rings: number[][][] = []
  if (geometry.type === 'Polygon') rings.push(geometry.coordinates[0])
  else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) rings.push(poly[0])
  } else return 0
  let total = 0
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = turf.point(ring[i])
      const p2 = turf.point(ring[i + 1])
      total += safeTurfOp(() => turf.distance(p1, p2, { units: 'meters' }), 0)
    }
  }
  return total
}

function bufferInwardFeet(feature: any, feet: number): any | null {
  if (!feature || !feature.geometry) return null
  try {
    const meters = -feet / M_TO_FT
    const result = (turf.buffer as any)(feature, meters, { units: 'meters', steps: 4 })
    if (!result || !result.geometry) return null
    const area = safeTurfOp(() => turf.area(result), 0)
    if (area <= 0) return null
    if (result.geometry.type !== 'Polygon' && result.geometry.type !== 'MultiPolygon') return null
    return result
  } catch {
    return null
  }
}

function bboxDimensionsFt(bbox: number[]): { widthFt: number; heightFt: number } {
  const [minX, minY, maxX, maxY] = bbox
  const sw = turf.point([minX, minY])
  const se = turf.point([maxX, minY])
  const nw = turf.point([minX, maxY])
  const widthM = safeTurfOp(() => turf.distance(sw, se, { units: 'meters' }), 0)
  const heightM = safeTurfOp(() => turf.distance(sw, nw, { units: 'meters' }), 0)
  return { widthFt: widthM * M_TO_FT, heightFt: heightM * M_TO_FT }
}

function unionFreeSpace(parts: any[]): any | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0].feature
  try {
    const fc = turf.featureCollection(parts.map((p) => p.feature))
    return (turf.union as any)(fc)
  } catch {
    // If union fails, fall back to the largest single part to keep diagnostics stable.
    const largest = parts.reduce((a, b) => (a.areaSqM > b.areaSqM ? a : b), parts[0])
    return largest ? largest.feature : null
  }
}

function intersects(feature: any, obstacle: any): boolean {
  if (!feature || !obstacle || !feature.geometry || !obstacle.geometry) return false
  return safeTurfOp(() => turf.booleanIntersects(feature, obstacle as any), false)
}

function centroidDistanceFt(point: any, target: any): number | null {
  if (!point || !target || !point.geometry || !target.geometry) return null
  const targetCentroid = safeTurfOp(() => turf.centroid(target as any), null)
  if (!targetCentroid) return null
  const m = safeTurfOp(() => turf.distance(point, targetCentroid, { units: 'meters' }), null)
  return m === null ? null : m * M_TO_FT
}

function nearestStreetDistanceFt(centroid: any, streetLines: any[]): number | null {
  if (!centroid || !streetLines.length) return null
  let best: number | null = null
  for (const line of streetLines) {
    const np = safeTurfOp(() => turf.nearestPointOnLine(line, centroid), null)
    if (!np) continue
    const d = safeTurfOp(() => turf.distance(centroid, np, { units: 'meters' }), null)
    if (d !== null && (best === null || d < best)) best = d
  }
  return best === null ? null : best * M_TO_FT
}

function countVerticesInside(sourceGeometry: any, target: any): number {
  if (!sourceGeometry || !target || !target.geometry) return 0
  let count = 0
  const rings: number[][][] = []
  if (sourceGeometry.type === 'Polygon') rings.push(sourceGeometry.coordinates[0])
  else if (sourceGeometry.type === 'MultiPolygon') {
    for (const poly of sourceGeometry.coordinates) rings.push(poly[0])
  }
  for (const ring of rings) {
    for (const coord of ring) {
      const pt = turf.point(coord)
      if (safeTurfOp(() => turf.booleanPointInPolygon(pt, target as any), false)) count++
    }
  }
  return count
}

function componentHydrologyRelationship(component: any, hydrologyObstaclesGeometry: any): {
  relationshipType: string
  booleanIntersects: boolean
  overlapAreaSqFt: number
  componentVerticesInsideHydrology: number
  hydrologyVerticesInsideComponent: number
  minimumBoundaryDistanceFt: number | null
} {
  if (!hydrologyObstaclesGeometry || !hydrologyObstaclesGeometry.geometry) {
    return {
      relationshipType: 'no-hydrology-data',
      booleanIntersects: false,
      overlapAreaSqFt: 0,
      componentVerticesInsideHydrology: 0,
      hydrologyVerticesInsideComponent: 0,
      minimumBoundaryDistanceFt: null
    }
  }
  const comp = component.feature
  const bool = safeTurfOp(() => turf.booleanIntersects(comp as any, hydrologyObstaclesGeometry as any), false)
  let overlapAreaSqFt = 0
  let relationshipType = bool ? 'boundary-touch' : 'no-relationship'
  if (bool) {
    try {
      const intersect = (turf.intersect as any)(turf.featureCollection([comp as any, hydrologyObstaclesGeometry as any]) as any)
      if (intersect && intersect.geometry) {
        const areaSqM = turf.area(intersect)
        overlapAreaSqFt = squareMetersToSquareFeet(areaSqM)
        if (areaSqM > 0.01) relationshipType = 'true-area-overlap'
      }
    } catch {
      // keep relationshipType as boundary-touch
    }
  }
  if (relationshipType === 'no-relationship') {
    const c1 = safeTurfOp(() => turf.centroid(comp as any), null)
    const c2 = safeTurfOp(() => turf.centroid(hydrologyObstaclesGeometry as any), null)
    const d = c1 && c2 ? safeTurfOp(() => turf.distance(c1, c2, { units: 'meters' }), null) : null
    if (d !== null) relationshipType = 'proximity-only'
    return {
      relationshipType,
      booleanIntersects: false,
      overlapAreaSqFt,
      componentVerticesInsideHydrology: 0,
      hydrologyVerticesInsideComponent: 0,
      minimumBoundaryDistanceFt: d === null ? null : d * M_TO_FT
    }
  }
  return {
    relationshipType,
    booleanIntersects: bool,
    overlapAreaSqFt,
    componentVerticesInsideHydrology: countVerticesInside(comp.geometry, hydrologyObstaclesGeometry),
    hydrologyVerticesInsideComponent: countVerticesInside(hydrologyObstaclesGeometry.geometry, comp),
    minimumBoundaryDistanceFt: 0
  }
}

function componentToRoadDistances(compCandidates: any[]): { street: string; connectionMethod: string; distanceFt: number }[] {
  const seen = new Map<string, number>()
  for (const c of compCandidates) {
    const key = `${c.name}::${c.connectionMethod}`
    const dist = c.distanceMeters * M_TO_FT
    if (!seen.has(key) || dist < seen.get(key)!) seen.set(key, dist)
  }
  return Array.from(seen.entries()).map(([key, distanceFt]) => {
    const [street, connectionMethod] = key.split('::')
    return { street, connectionMethod, distanceFt }
  })
}

const SUITABILITY_ORDER: Record<ConceptualAccessSuitability, number> = {
  preferred: 0,
  conditional: 1,
  discouraged: 2,
  excluded: 3
}

function bestSuitability(values: (ConceptualAccessSuitability | undefined)[]): ConceptualAccessSuitability | null {
  let best: ConceptualAccessSuitability | null = null
  for (const v of values) {
    if (!v) continue
    if (best === null || SUITABILITY_ORDER[v] < SUITABILITY_ORDER[best]) best = v
  }
  return best
}

function classifyShape(afterAreaSqFt: number, largestPartRatio: number, widthFt: number, heightFt: number, compactness: number): string {
  const maxSpan = Math.max(widthFt, heightFt)
  const minSpan = Math.min(widthFt, heightFt)
  const aspect = maxSpan > 0 ? minSpan / maxSpan : 0
  if (afterAreaSqFt < 1000) return 'sliver'
  if (largestPartRatio < 0.5) return 'fragmented remainder'
  if (minSpan < 100 || aspect < 0.25) return 'narrow corridor'
  if (afterAreaSqFt > 43560 && compactness > 0.4) return 'large development block'
  if (afterAreaSqFt > 21780) return 'moderate development block'
  return 'isolated pocket'
}

function landInteriorCapacityCategory(freeSpaceAcres: number, buffer75Percent: number | null, largestPartRatio: number, narrowNeck: boolean): string {
  let category: string
  if (freeSpaceAcres < 0.5) category = 'VERY LOW'
  else if (freeSpaceAcres < 1.5) category = 'LOW'
  else if (freeSpaceAcres < 4.0) category = 'MODERATE'
  else if (freeSpaceAcres < 10.0) category = 'HIGH'
  else category = 'VERY HIGH'

  if (buffer75Percent !== null && buffer75Percent < 20) {
    category = bumpDown(category)
  }
  if (largestPartRatio < 0.5) {
    category = bumpDown(category)
  }
  if (narrowNeck) {
    category = bumpDown(category)
  }
  return category
}

function accessPotentialCategory(bestSuitability: ConceptualAccessSuitability | null, candidateCount: number): string {
  if (candidateCount === 0) return 'none'
  if (bestSuitability === 'excluded') return 'excluded'
  if (bestSuitability === 'discouraged') return 'discouraged'
  if (bestSuitability === 'conditional') return 'conditional'
  if (bestSuitability === 'preferred') return 'preferred'
  return 'unknown'
}

function currentRoutability(routedCount: number, validRoutedCount: number, candidateCount: number): string {
  if (routedCount > 0 && validRoutedCount > 0) return 'valid-routed'
  if (routedCount > 0) return 'rejected-after-routing'
  if (candidateCount === 0) return 'no-candidates'
  return 'not-routed'
}

function bumpDown(category: string): string {
  const order = ['VERY HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY LOW']
  const i = order.indexOf(category)
  if (i === -1 || i === order.length - 1) return category
  return order[i + 1]
}

function secondaryNetworkPotential(freeSpaceAcres: number, buffer75Percent: number | null, widthFt: number, heightFt: number, fragmented: boolean, obstaclesDivide: boolean, hasAccess: boolean): string {
  if (!hasAccess || freeSpaceAcres < 0.5) return 'very low'
  if (freeSpaceAcres > 3.0 && widthFt > 150 && heightFt > 150 && !fragmented && !obstaclesDivide && (buffer75Percent === null || buffer75Percent > 30)) return 'high'
  if (freeSpaceAcres > 1.0 && widthFt > 100 && heightFt > 100 && !fragmented) return 'moderate'
  if (fragmented || obstaclesDivide || (buffer75Percent !== null && buffer75Percent < 30)) return 'low'
  return 'unknown'
}

export interface ComponentDevelopmentOpportunity {
  componentIndex: number
  sourceAreaSqFt: number
  sourceAreaAcres: number
  freeSpaceAreaSqFt: number
  freeSpaceAreaAcres: number
  freeSpacePartCount: number
  percentAreaRemovedByObstacles: number
  geometryType: string
  perimeterFt: number
  centroid: number[]
  bbox: number[]
  maxInteriorSpanFt: number
  perpendicularSpanFt: number
  dominantAxis: string
  compactness: number
  largestFreeSpacePartSqFt: number
  largestPartToTotalRatio: number
  shapeCategory: string
  narrowNeckDetected: boolean
  buffer25: { survives: boolean; areaSqFt: number; percent: number | null; error: string | null }
  buffer50: { survives: boolean; areaSqFt: number; percent: number | null; error: string | null }
  buffer75: { survives: boolean; areaSqFt: number; percent: number | null; error: string | null }
  buffer100: { survives: boolean; areaSqFt: number; percent: number | null; error: string | null }
  accessCandidateCount: number
  accessStreets: string[]
  accessMethods: string[]
  accessSuitabilityCounts: Record<string, number>
  bestConceptualAccessSuitability: ConceptualAccessSuitability | null
  bestAccessStreet: string | null
  bestAccessRoadClass: string | number | null
  bestAccessOwner: string | null
  ownershipReviewRequired: boolean
  accessPotential: string
  minCandidateAccessDistanceFt: number | null
  maxCandidateAccessDistanceFt: number | null
  candidateToRoadDistances: { street: string; connectionMethod: string; distanceFt: number }[]
  centroidToNearestStreetFt: number | null
  intersectsBuilding: boolean
  intersectsHydrology: boolean
  hydrologyRelationshipType: string
  hydrologyOverlapAreaSqFt: number
  hydrologyComponentVerticesInside: number
  hydrologyVerticesInsideComponent: number
  hydrologyMinimumBoundaryDistanceFt: number | null
  intersectsPavement: boolean
  distanceToBuildingFt: number | null
  distanceToHydrologyFt: number | null
  distanceToPavementFt: number | null
  primaryConstraint: string
  landInteriorCapacityCategory: string
  enoughAreaForSecondaryNetwork: string
  enoughInteriorWidthForSecondary: string
  enoughInteriorDepthForSecondary: string
  fragmentedInhibitsBranching: boolean
  obstaclesLikelyDivide: boolean
  secondaryNetworkPotential: string
  currentRoutability: string
  routedCandidateCount: number
  validRoutedCandidateCount: number
  bestServedDevelopableAreaSqFt: number | null
  bestComponentServiceRatio: number | null
  bestRoadLengthFt: number | null
  bestPenetrationRatio: number | null
  bestRouteEfficiencyRatio: number | null
  bestBendCount: number | null
  bestMaxDeflectionAngle: number | null
  bestAccessSuitabilityForService: ConceptualAccessSuitability | null
  bestServiceStreet: string | null
  bestServiceConnectionMethod: string | null
}

export function runComponentDevelopmentOpportunityAudit(options: {
  mcpi: string
  allComponents: any[]
  freeSpaceComponents: any[]
  candidates: any[]
  candidateResults: any[]
  buildingUnionGeometry: any
  hydrologyObstaclesGeometry: any
  existingPavementGeometry: any
  streetLines: any[]
  parcelFeature: any
}): { mcpi: string; componentCount: number; components: ComponentDevelopmentOpportunity[]; hydrologyAudit: any[] } {
  const components: ComponentDevelopmentOpportunity[] = []
  const hydrologyAudit: any[] = []

  for (const comp of options.allComponents) {
    if (comp.areaSqM < 100) continue

    const parts = options.freeSpaceComponents.filter((p) => p.sourceComponent?.index === comp.index)
    const sourceAreaSqFt = squareMetersToSquareFeet(comp.areaSqM)
    const freeSpaceAreaSqM = parts.reduce((s, p) => s + p.areaSqM, 0)
    const freeSpaceAreaSqFt = squareMetersToSquareFeet(freeSpaceAreaSqM)
    const percentRemoved = sourceAreaSqFt > 0 ? ((sourceAreaSqFt - freeSpaceAreaSqFt) / sourceAreaSqFt) * 100 : 0
    const freeSpacePartCount = parts.length
    const largestPart = parts.length ? parts.reduce((a, b) => (a.areaSqM > b.areaSqM ? a : b), parts[0]) : null
    const largestPartSqFt = largestPart ? squareMetersToSquareFeet(largestPart.areaSqM) : 0
    const largestPartRatio = freeSpaceAreaSqFt > 0 ? largestPartSqFt / freeSpaceAreaSqFt : 0

    const bbox = safeTurfOp(() => turf.bbox(comp.feature), [0, 0, 0, 0])
    const centroid = safeTurfOp(() => turf.centroid(comp.feature).geometry.coordinates, [0, 0])
    const dims = bboxDimensionsFt(bbox)
    const perimeterM = polygonPerimeterMeters(comp.feature.geometry)
    const compactness = perimeterM > 0 ? (4 * Math.PI * comp.areaSqM) / (perimeterM * perimeterM) : 0
    const aspect = dims.widthFt > 0 ? dims.heightFt / dims.widthFt : 0
    const narrowNeck = dims.widthFt < 100 || dims.heightFt < 100 || Math.min(aspect, 1 / aspect) < 0.25
    const shapeCategory = classifyShape(freeSpaceAreaSqFt, largestPartRatio, dims.widthFt, dims.heightFt, compactness)

    const freeSpaceUnion = unionFreeSpace(parts)
    const buffers: Record<number, { survives: boolean; areaSqFt: number; percent: number | null; error: string | null }> = {}
    for (const d of [25, 50, 75, 100]) {
      const buf = freeSpaceUnion ? bufferInwardFeet(freeSpaceUnion, d) : null
      if (!freeSpaceUnion) {
        buffers[d] = { survives: false, areaSqFt: 0, percent: null, error: 'No free-space geometry to buffer' }
      } else if (!buf) {
        buffers[d] = { survives: false, areaSqFt: 0, percent: null, error: `Inward ${d}-ft buffer collapsed or produced no surviving geometry` }
      } else {
        const areaSqM = safeTurfOp(() => turf.area(buf), 0)
        const areaSqFt = squareMetersToSquareFeet(areaSqM)
        const percent = freeSpaceAreaSqFt > 0 ? (areaSqFt / freeSpaceAreaSqFt) * 100 : 0
        buffers[d] = { survives: areaSqFt > 0, areaSqFt, percent, error: null }
      }
    }

    const compCandidates = options.candidates.filter((c) => c.sourceComponent?.index === comp.index)
    const accessStreets = Array.from(new Set(compCandidates.map((c) => c.name).filter(Boolean)))
    const accessMethods = Array.from(new Set(compCandidates.map((c) => c.connectionMethod).filter(Boolean)))
    const counts: Record<string, number> = { preferred: 0, conditional: 0, discouraged: 0, excluded: 0 }
    for (const c of compCandidates) {
      const s = c.accessSuitability?.suitability
      if (s) counts[s] = (counts[s] || 0) + 1
    }
    const bestSuit = bestSuitability(compCandidates.map((c) => c.accessSuitability?.suitability))
    const bestAccess = compCandidates.length
      ? (compCandidates.find((c) => c.accessSuitability?.suitability === bestSuit) ?? null)
      : null

    const intersectsBuilding = intersects(comp.feature, options.buildingUnionGeometry)
    const intersectsHydrology = intersects(comp.feature, options.hydrologyObstaclesGeometry)
    const intersectsPavement = intersects(comp.feature, options.existingPavementGeometry)
    const distanceToBuilding = centroidDistanceFt(turf.point(centroid), options.buildingUnionGeometry)
    const distanceToHydrology = centroidDistanceFt(turf.point(centroid), options.hydrologyObstaclesGeometry)
    const distanceToPavement = centroidDistanceFt(turf.point(centroid), options.existingPavementGeometry)

    const waterConstrained = intersectsHydrology || (distanceToHydrology !== null && distanceToHydrology < 100)
    const buildingConstrained = intersectsBuilding || percentRemoved > 50
    const pavementConstrained = intersectsPavement
    let primaryConstraint = 'relatively open'
    if (waterConstrained) primaryConstraint = 'heavily constrained by water'
    else if (buildingConstrained) primaryConstraint = 'heavily constrained by buildings'
    else if (pavementConstrained) primaryConstraint = 'heavily constrained by pavement'
    else if (percentRemoved > 25) primaryConstraint = 'constrained mainly by parcel geometry'

    const hasAccess = compCandidates.length > 0
    const buffer75Percent = buffers[75].survives ? buffers[75].percent : null
    const freeSpaceAcres = squareMetersToAcres(freeSpaceAreaSqM)
    const landInteriorCapacity = landInteriorCapacityCategory(
      freeSpaceAcres,
      buffer75Percent,
      largestPartRatio,
      narrowNeck
    )
    const accessPotential = accessPotentialCategory(bestSuit, compCandidates.length)

    const candidateToRoadDistances = componentToRoadDistances(compCandidates)
    const minCandidateAccessDistanceFt = candidateToRoadDistances.length ? Math.min(...candidateToRoadDistances.map((d) => d.distanceFt)) : null
    const maxCandidateAccessDistanceFt = candidateToRoadDistances.length ? Math.max(...candidateToRoadDistances.map((d) => d.distanceFt)) : null
    const centroidToNearestStreet = nearestStreetDistanceFt(turf.point(centroid), options.streetLines)
    const hydrology = componentHydrologyRelationship(comp, options.hydrologyObstaclesGeometry)

    const fragmented = freeSpacePartCount > 2 || largestPartRatio < 0.5
    const obstaclesDivide = percentRemoved > 35 || intersectsHydrology || intersectsBuilding || intersectsPavement
    const enoughArea = freeSpaceAreaSqM > 0 && freeSpaceAcres > 1.5 && (buffers[75].survives ? squareMetersToAcres(buffers[75].areaSqFt / SQ_M_TO_SQ_FT) > 0.5 : false)
    const enoughWidth = dims.widthFt >= 150
    const enoughDepth = dims.heightFt >= 150
    const secondaryPotential = secondaryNetworkPotential(
      freeSpaceAcres,
      buffer75Percent,
      dims.widthFt,
      dims.heightFt,
      fragmented,
      obstaclesDivide,
      hasAccess
    )

    const compRouted = options.candidateResults.filter((cr) => cr.candidate.sourceComponent?.index === comp.index)
    let bestService = null
    if (compRouted.length) {
      // Use the generator's own ordering (score/served-area/penetration) but surface best absolute service and best ratio.
      bestService = compRouted.reduce((best, cr) => {
        if (!best) return cr
        if ((cr.result.servedDevelopableAreaSqFt ?? 0) > (best.result.servedDevelopableAreaSqFt ?? 0)) return cr
        return best
      })
    }
    const routability = currentRoutability(compRouted.length, compRouted.length, compCandidates.length)

    hydrologyAudit.push({
      componentIndex: comp.index,
      ...hydrology
    })

    components.push({
      componentIndex: comp.index,
      sourceAreaSqFt,
      sourceAreaAcres: squareMetersToAcres(comp.areaSqM),
      freeSpaceAreaSqFt,
      freeSpaceAreaAcres: squareMetersToAcres(freeSpaceAreaSqM),
      freeSpacePartCount,
      percentAreaRemovedByObstacles: percentRemoved,
      geometryType: comp.feature.geometry.type,
      perimeterFt: metersToFeet(perimeterM),
      centroid,
      bbox,
      maxInteriorSpanFt: Math.max(dims.widthFt, dims.heightFt),
      perpendicularSpanFt: Math.min(dims.widthFt, dims.heightFt),
      dominantAxis: dims.widthFt >= dims.heightFt ? 'east-west' : 'north-south',
      compactness,
      largestFreeSpacePartSqFt: largestPartSqFt,
      largestPartToTotalRatio: largestPartRatio,
      shapeCategory,
      narrowNeckDetected: narrowNeck,
      buffer25: buffers[25],
      buffer50: buffers[50],
      buffer75: buffers[75],
      buffer100: buffers[100],
      accessCandidateCount: compCandidates.length,
      accessStreets,
      accessMethods,
      accessSuitabilityCounts: counts,
      bestConceptualAccessSuitability: bestAccess?.accessSuitability?.suitability ?? null,
      bestAccessStreet: bestAccess?.name ?? null,
      bestAccessRoadClass: bestAccess?.accessSuitability?.roadClass ?? null,
      bestAccessOwner: bestAccess?.accessSuitability?.owner ?? null,
      ownershipReviewRequired: compCandidates.some((c) => c.accessSuitability?.reviewRequired),
      accessPotential,
      minCandidateAccessDistanceFt,
      maxCandidateAccessDistanceFt,
      candidateToRoadDistances,
      centroidToNearestStreetFt: centroidToNearestStreet,
      intersectsBuilding,
      intersectsHydrology,
      hydrologyRelationshipType: hydrology.relationshipType,
      hydrologyOverlapAreaSqFt: hydrology.overlapAreaSqFt,
      hydrologyComponentVerticesInside: hydrology.componentVerticesInsideHydrology,
      hydrologyVerticesInsideComponent: hydrology.hydrologyVerticesInsideComponent,
      hydrologyMinimumBoundaryDistanceFt: hydrology.minimumBoundaryDistanceFt,
      intersectsPavement,
      distanceToBuildingFt: distanceToBuilding,
      distanceToHydrologyFt: distanceToHydrology,
      distanceToPavementFt: distanceToPavement,
      primaryConstraint,
      landInteriorCapacityCategory: landInteriorCapacity,
      enoughAreaForSecondaryNetwork: enoughArea ? 'yes' : 'no',
      enoughInteriorWidthForSecondary: enoughWidth ? 'yes' : 'no',
      enoughInteriorDepthForSecondary: enoughDepth ? 'yes' : 'no',
      fragmentedInhibitsBranching: fragmented,
      obstaclesLikelyDivide: obstaclesDivide,
      secondaryNetworkPotential: secondaryPotential,
      currentRoutability: routability,
      routedCandidateCount: compRouted.length,
      validRoutedCandidateCount: compRouted.length,
      bestServedDevelopableAreaSqFt: bestService ? bestService.result.servedDevelopableAreaSqFt ?? null : null,
      bestComponentServiceRatio: bestService ? bestService.result.componentServiceRatio ?? null : null,
      bestRoadLengthFt: bestService ? bestService.result.proposedRoadLengthFeet ?? null : null,
      bestPenetrationRatio: bestService ? bestService.result.penetrationRatio ?? null : null,
      bestRouteEfficiencyRatio: bestService ? bestService.metrics?.routeEfficiencyRatio ?? null : null,
      bestBendCount: bestService ? bestService.result.bendCount ?? null : null,
      bestMaxDeflectionAngle: bestService ? bestService.result.maxDeflectionAngle ?? null : null,
      bestAccessSuitabilityForService: bestService ? bestService.candidate?.accessSuitability?.suitability ?? null : null,
      bestServiceStreet: bestService ? bestService.result.connectionStreetName ?? null : null,
      bestServiceConnectionMethod: bestService ? bestService.result.connectionMethod ?? null : null
    })
  }

  // Sort by descending free-space area so the report is easy to read.
  components.sort((a, b) => b.freeSpaceAreaSqFt - a.freeSpaceAreaSqFt)

  return { mcpi: options.mcpi, componentCount: components.length, components, hydrologyAudit }
}
