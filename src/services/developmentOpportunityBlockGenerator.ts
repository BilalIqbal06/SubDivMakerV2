import { recomputeCounter } from '../lib/perf'
import * as turf from '@turf/turf'
import {
  CandidateOpenAreaResult,
  ConceptualRoadSkeletonResult,
  SecondaryRoadNetworkResult,
  DevelopmentOpportunityBlock,
  DevelopmentOpportunityBlockResult,
  DevelopmentOpportunityClassification,
  DevelopmentOpportunityAccessState
} from '../types/parameters'

const FEET_TO_METERS = 0.3048
const METERS_TO_FEET = 3.28084
const SQ_METERS_TO_SQ_FEET = 10.7639
const ACRES_TO_SQFEET = 43560

const featureBboxCache = new WeakMap<GeoJSON.Feature<GeoJSON.Geometry>, number[]>()
const lineBboxCache = new WeakMap<GeoJSON.Feature<GeoJSON.LineString>, number[]>()

function getFeatureBbox(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number[] | null {
  if (!feature || !feature.geometry) return null
  const cached = featureBboxCache.get(feature)
  if (cached) return cached
  const b = safeTurfOp(() => turf.bbox(feature), null)
  if (b) {
    featureBboxCache.set(feature, b)
    return b
  }
  return null
}

function getLineBbox(line: GeoJSON.Feature<GeoJSON.LineString>): number[] | null {
  const cached = lineBboxCache.get(line)
  if (cached) return cached
  const b = safeTurfOp(() => turf.bbox(line), null)
  if (b) {
    lineBboxCache.set(line, b)
    return b
  }
  return null
}

function bboxesOverlap(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return true
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function bboxLowerBoundMeters(point: number[], bbox: number[]): number {
  const clamped: [number, number] = [Math.max(bbox[0], Math.min(point[0], bbox[2])), Math.max(bbox[1], Math.min(point[1], bbox[3]))]
  return safeTurfOp(() => turf.distance(turf.point(point), turf.point(clamped), { units: 'meters' }) as number, 0)
}

function expandBbox(bbox: number[], meters: number): number[] {
  const lonDelta = (meters / 111319) * (1 / Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180))
  const latDelta = meters / 111319
  return [bbox[0] - lonDelta, bbox[1] - latDelta, bbox[2] + lonDelta, bbox[3] + latDelta]
}

// Phase 2C diagnostic thresholds. These are conceptual feasibility heuristics
// and must not be interpreted as engineering, zoning, or legal standards.
const GEOMETRY_TOLERANCE_SQ_METERS = 0.1
const AREA_CONSERVATION_TOLERANCE_SQFT = 100
const INTERIOR_BUFFERS_FT = [25, 50, 75, 100]
const MIN_MEANINGFUL_BLOCK_ACRES = 0.15
const ROAD_TOUCH_TOLERANCE_FT = 2.0
const ROAD_NEAR_DISTANCE_FT = 150
const SMALL_FRAGMENT_ACRES = 0.05
const WEAK_INTERIOR_SURVIVAL_PCT = 25
const MODERATE_INTERIOR_SURVIVAL_PCT = 50
const STRONG_INTERIOR_SURVIVAL_PCT = 75
const HIGH_MIN_ACRES = 0.5
const MODERATE_MIN_ACRES = 0.2
const HIGH_COMPACTNESS = 0.55
const MODERATE_COMPACTNESS = 0.35
const CONSTRAINT_INFLUENCE_FT = 100
const IS_DEV = typeof (globalThis as any).__DEV__ === 'boolean'
  ? (globalThis as any).__DEV__
  : (typeof (import.meta as any).env !== 'undefined' ? (import.meta as any).env.DEV === true : false)

function ftToM(ft: number) { return ft * FEET_TO_METERS }
function mToFt(m: number) { return m * METERS_TO_FEET }
function sqMetersToSqFt(m2: number) { return m2 * SQ_METERS_TO_SQ_FEET }

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    return fallback
  }
}

function ensureFeature(geometry: any): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!geometry) return null
  if ((geometry as any).type === 'Feature') return geometry as GeoJSON.Feature<GeoJSON.Geometry>
  try {
    return { type: 'Feature', properties: {}, geometry: geometry as GeoJSON.Geometry } as GeoJSON.Feature<GeoJSON.Geometry>
  } catch {
    return null
  }
}

function areaSqFt(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number {
  if (!feature || !feature.geometry) return 0
  return sqMetersToSqFt(safeTurfOp(() => turf.area(feature), 0))
}

function geometryDifference(a: GeoJSON.Feature<GeoJSON.Geometry> | null, b: GeoJSON.Feature<GeoJSON.Geometry> | null): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!a || !a.geometry) return null
  if (!b || !b.geometry) return a
  const aBbox = getFeatureBbox(a)
  const bBbox = getFeatureBbox(b)
  if (!bboxesOverlap(aBbox, bBbox)) return a
  return safeTurfOp(() => (turf.difference as any)(turf.featureCollection([a as any, b as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
}

function geometryIntersection(a: GeoJSON.Feature<GeoJSON.Geometry> | null, b: GeoJSON.Feature<GeoJSON.Geometry> | null): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!a || !a.geometry || !b || !b.geometry) return null
  const aBbox = getFeatureBbox(a)
  const bBbox = getFeatureBbox(b)
  if (!bboxesOverlap(aBbox, bBbox)) return null
  return safeTurfOp(() => (turf.intersect as any)(turf.featureCollection([a as any, b as any]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
}

function geometryUnion(features: GeoJSON.Feature<GeoJSON.Geometry>[]): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (features.length === 0) return null
  if (features.length === 1) return features[0]
  const polys = features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
  if (polys.length === 0) return null
  if (polys.length === 1) return polys[0]
  try {
    const fc = turf.featureCollection(polys as any) as any
    return safeTurfOp(() => (turf.union as any)(fc) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
  } catch {
    return null
  }
}

function flattenGeometry(feature: GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!feature || !feature.geometry) return []
  const geom = feature.geometry
  if (geom.type === 'Polygon') return [{ ...feature, geometry: geom as GeoJSON.Polygon }]
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.map((coords, i) => ({
      ...feature,
      id: `${(feature as any).id ?? 'f'}-${i}`,
      geometry: { type: 'Polygon', coordinates: coords } as GeoJSON.Polygon
    }))
  }
  return []
}

function perimeterFt(feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): number {
  if (!feature || !feature.geometry) return 0
  const geom = feature.geometry
  if (geom.type === 'Polygon') {
    const ring = safeTurfOp(() => turf.lineString(geom.coordinates[0]), null)
    return ring ? mToFt(safeTurfOp(() => turf.length(ring, { units: 'meters' }), 0)) : 0
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((sum, polygon) => {
      const ring = safeTurfOp(() => turf.lineString(polygon[0]), null)
      return sum + (ring ? mToFt(safeTurfOp(() => turf.length(ring, { units: 'meters' }), 0)) : 0)
    }, 0)
  }
  return 0
}

function compactness(feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): number {
  const a = safeTurfOp(() => turf.area(feature), 0)
  const p = safeTurfOp(() => perimeterFt(feature), 0)
  if (a <= 0 || p <= 0) return 0
  // p is in feet, a is in square meters; convert to consistent units
  const aM2 = a
  const pM = p / METERS_TO_FEET
  return 4 * Math.PI * aM2 / (pM * pM)
}

function centroid(feature: GeoJSON.Feature<GeoJSON.Geometry>): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!feature || !feature.geometry) return null
  return safeTurfOp(() => turf.centroid(feature), null)
}

function sampleFeatureEdges(feature: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): GeoJSON.Feature<GeoJSON.LineString>[] {
  if (!feature || !feature.geometry) return []
  const lines: GeoJSON.Feature<GeoJSON.LineString>[] = []
  const geom = feature.geometry
  if (geom.type === 'Point') return []
  if (geom.type === 'LineString') {
    lines.push(turf.lineString(geom.coordinates))
  } else if (geom.type === 'MultiLineString') {
    geom.coordinates.forEach((c) => lines.push(turf.lineString(c)))
  } else if (geom.type === 'Polygon') {
    geom.coordinates.forEach((c) => lines.push(turf.lineString(c)))
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates.forEach((poly) => poly.forEach((c) => lines.push(turf.lineString(c))))
  }
  return lines
}

function distancePointToFeatureFt(from: GeoJSON.Feature<GeoJSON.Point> | null | undefined, to: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number | null {
  if (!from || !to || !to.geometry) return null
  const lines = sampleFeatureEdges(to)
  if (lines.length === 0) return null
  const pt = from.geometry.coordinates
  const ptBbox: number[] = [pt[0], pt[1], pt[0], pt[1]]
  let min: number | null = null
  for (const line of lines) {
    const lb = getLineBbox(line)
    if (lb) {
      const lowerM = bboxLowerBoundMeters(ptBbox, lb)
      if (min !== null && lowerM >= min) continue
    }
    const d = safeTurfOp(() => (turf.pointToLineDistance as any)(turf.point(pt), line, { units: 'meters' }) as number | null, null)
    if (d !== null && (min === null || d < min)) min = d
  }
  if (min === null) return null
  return mToFt(min)
}

function distanceFeatureToFeatureFt(a: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined, b: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined): number | null {
  if (!a || !a.geometry || !b || !b.geometry) return null
  const aLines = sampleFeatureEdges(a)
  const bLines = sampleFeatureEdges(b)
  if (aLines.length === 0 || bLines.length === 0) return null
  const aBboxes = aLines.map(getLineBbox)
  const bBboxes = bLines.map(getLineBbox)
  let min: number | null = null
  // Distance from every vertex of A to every edge of B, and vice versa
  for (let ai = 0; ai < aLines.length; ai++) {
    const aLine = aLines[ai]
    const aBbox = aBboxes[ai]
    for (const coord of aLine.geometry!.coordinates) {
      const ptBbox: number[] = [coord[0], coord[1], coord[0], coord[1]]
      for (let bi = 0; bi < bLines.length; bi++) {
        const bLine = bLines[bi]
        const bBbox = bBboxes[bi]
        if (aBbox && bBbox) {
          const lowerM = bboxLowerBoundMeters(ptBbox, bBbox)
          if (min !== null && lowerM >= min) continue
        }
        const d = safeTurfOp(() => (turf.pointToLineDistance as any)(turf.point(coord), bLine, { units: 'meters' }) as number | null, null)
        if (d !== null && (min === null || d < min)) min = d
      }
    }
  }
  for (let bi = 0; bi < bLines.length; bi++) {
    const bLine = bLines[bi]
    const bBbox = bBboxes[bi]
    for (const coord of bLine.geometry!.coordinates) {
      const ptBbox: number[] = [coord[0], coord[1], coord[0], coord[1]]
      for (let ai = 0; ai < aLines.length; ai++) {
        const aLine = aLines[ai]
        const aBbox = aBboxes[ai]
        if (aBbox && bBbox) {
          const lowerM = bboxLowerBoundMeters(ptBbox, aBbox)
          if (min !== null && lowerM >= min) continue
        }
        const d = safeTurfOp(() => (turf.pointToLineDistance as any)(turf.point(coord), aLine, { units: 'meters' }) as number | null, null)
        if (d !== null && (min === null || d < min)) min = d
      }
    }
  }
  if (min === null) return null
  return mToFt(min)
}

function touchesGeometry(block: GeoJSON.Feature<GeoJSON.Polygon>, target: GeoJSON.Feature<GeoJSON.Geometry> | null | undefined, toleranceM: number): boolean {
  if (!target || !target.geometry) return false
  const blockBbox = getFeatureBbox(block)
  const targetBbox = getFeatureBbox(target)
  if (blockBbox && targetBbox && !bboxesOverlap(expandBbox(blockBbox, toleranceM), targetBbox)) return false
  // Positive buffer on the block to bridge small floating-point gaps after difference/union
  const expanded = safeTurfOp(() => (turf.buffer as any)(block, toleranceM, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
  if (!expanded || !expanded.geometry) return false
  const overlap = geometryIntersection(expanded as any, target as any)
  if (!overlap || !overlap.geometry) return false
  return safeTurfOp(() => turf.area(overlap), 0) > GEOMETRY_TOLERANCE_SQ_METERS
}

function inwardBufferAreaSqFt(block: GeoJSON.Feature<GeoJSON.Polygon>, feet: number): number {
  if (feet <= 0) return 0
  const m = ftToM(feet)
  const buffered = safeTurfOp(() => (turf.buffer as any)(block, -m, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Geometry> | null, null)
  if (!buffered || !buffered.geometry) return 0
  return areaSqFt(buffered)
}

function buildRoadRowUnion(
  primaryRoad: ConceptualRoadSkeletonResult,
  secondaryRoads: SecondaryRoadNetworkResult | null
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const parts: GeoJSON.Feature<GeoJSON.Geometry>[] = []
  if (primaryRoad.proposedRightOfWay) parts.push(ensureFeature(primaryRoad.proposedRightOfWay) as any)
  if (secondaryRoads && secondaryRoads.roads) {
    for (const road of secondaryRoads.roads) {
      if (road.rightOfWayGeometry) parts.push(ensureFeature(road.rightOfWayGeometry) as any)
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  return geometryUnion(parts)
}

function convertToPolygonFeatures(geometry: GeoJSON.Feature<GeoJSON.Geometry> | null): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (!geometry || !geometry.geometry) return []
  return flattenGeometry(geometry)
}

export interface GenerateDevelopmentOpportunityBlocksOptions {
  mcpi: string
  candidateOpenArea: CandidateOpenAreaResult
  primaryRoad: ConceptualRoadSkeletonResult | null
  secondaryRoads: SecondaryRoadNetworkResult | null
}

export function generateDevelopmentOpportunityBlocks(
  options: GenerateDevelopmentOpportunityBlocksOptions
): DevelopmentOpportunityBlockResult {
  recomputeCounter.increment('opportunity')
  const { mcpi, candidateOpenArea, primaryRoad, secondaryRoads } = options

  const emptyResult: DevelopmentOpportunityBlockResult = {
    mcpi,
    status: 'unavailable',
    blockCount: 0,
    highCount: 0,
    moderateCount: 0,
    lowCount: 0,
    residualCount: 0,
    candidateOpenAreaSqFt: 0,
    proposedROWInsideCOASqFt: 0,
    opportunityBlocksSqFt: 0,
    conservationDifferenceSqFt: 0,
    conservationToleranceSqFt: AREA_CONSERVATION_TOLERANCE_SQFT,
    conservationPassed: false,
    totalBlockAreaAcres: 0,
    roadServeableAreaAcres: 0,
    nearNetworkAreaAcres: 0,
    latentNoNetworkAreaAcres: 0,
    largestBlockAcres: 0,
    blocks: [],
    warnings: [],
    explanation: 'Development opportunity blocks are unavailable because Candidate Open Area was not found.'
  }

  if (!candidateOpenArea || !candidateOpenArea.candidateGeometry) {
    return emptyResult
  }

  const coa = ensureFeature(candidateOpenArea.candidateGeometry)
  if (!coa) {
    return emptyResult
  }

  const candidateOpenAreaSqFt = areaSqFt(coa)

  let proposedROWInsideCOASqFt = 0
  let postRoadGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null = null

  const roadRowUnion = buildRoadRowUnion(primaryRoad ?? {} as any, secondaryRoads)
  if (roadRowUnion && roadRowUnion.geometry) {
    const roadRowInsideCOA = geometryIntersection(coa, roadRowUnion)
    if (roadRowInsideCOA && roadRowInsideCOA.geometry) {
      proposedROWInsideCOASqFt = areaSqFt(roadRowInsideCOA)
      postRoadGeometry = geometryDifference(coa, roadRowInsideCOA)
    } else {
      postRoadGeometry = coa
    }
  } else {
    postRoadGeometry = coa
  }

  if (!postRoadGeometry || !postRoadGeometry.geometry) {
    return {
      ...emptyResult,
      status: 'latent',
      candidateOpenAreaSqFt,
      explanation: 'No Candidate Open Area remains after road allowance.'
    }
  }

  const postRoadAreaSqFt = areaSqFt(postRoadGeometry)
  if (postRoadAreaSqFt < AREA_CONSERVATION_TOLERANCE_SQFT) {
    const noRoads = !roadRowUnion
    return {
      ...emptyResult,
      status: noRoads ? 'latent' : 'empty',
      candidateOpenAreaSqFt,
      proposedROWInsideCOASqFt,
      opportunityBlocksSqFt: postRoadAreaSqFt,
      explanation: noRoads
        ? 'No conceptual road network was generated. Remaining land is described as latent opportunity without network access.'
        : 'Remaining Candidate Open Area after road allowance is too small for meaningful blocks.'
    }
  }

  const rawPolygons = convertToPolygonFeatures(postRoadGeometry)
  const blocks: DevelopmentOpportunityBlock[] = []

  for (let i = 0; i < rawPolygons.length; i++) {
    const poly = rawPolygons[i]
    const area = areaSqFt(poly)
    if (area <= 0) continue

    const id = `dev-block-${i}`
    const areaAcres = area / ACRES_TO_SQFEET
    const perim = perimeterFt(poly)
    const comp = compactness(poly)
    const center = centroid(poly) ?? undefined

    // Interior capacity
    const interiorSurvival = INTERIOR_BUFFERS_FT.map(feet => {
      const surviving = inwardBufferAreaSqFt(poly, feet)
      const pct = area > 0 ? (surviving / area) * 100 : 0
      return { bufferFeet: feet, survivingAreaSqFt: Math.round(surviving), survivalPercent: Number(pct.toFixed(1)) }
    })

    // Road relationship
    const touchesPrimary = primaryRoad?.proposedRightOfWay
      ? touchesGeometry(poly, ensureFeature(primaryRoad.proposedRightOfWay), ftToM(ROAD_TOUCH_TOLERANCE_FT))
      : false
    let touchesSecondary = false
    let nearestSecondaryFt: number | null = null
    if (secondaryRoads && secondaryRoads.roads.length > 0) {
      for (const road of secondaryRoads.roads) {
        if (road.rightOfWayGeometry && touchesGeometry(poly, ensureFeature(road.rightOfWayGeometry), ftToM(ROAD_TOUCH_TOLERANCE_FT))) {
          touchesSecondary = true
          break
        }
      }
      const rightOfWays = secondaryRoads.roads
        .filter(r => r.rightOfWayGeometry)
        .map(r => ensureFeature(r.rightOfWayGeometry))
        .filter(Boolean) as GeoJSON.Feature<GeoJSON.Geometry>[]
      if (rightOfWays.length > 0) {
        const distances = rightOfWays
          .map(row => distanceFeatureToFeatureFt(poly, row))
          .filter(d => d !== null) as number[]
        if (distances.length > 0) {
          nearestSecondaryFt = Math.min(...distances)
        }
      }
    }
    let nearestPrimaryFt: number | null = null
    if (primaryRoad?.proposedRightOfWay) {
      nearestPrimaryFt = distanceFeatureToFeatureFt(poly, ensureFeature(primaryRoad.proposedRightOfWay))
    }

    const touchesAny = touchesPrimary || touchesSecondary
    let nearestRoadType: 'primary' | 'secondary' | 'none' = 'none'
    let distanceToProposedRoadFt = Infinity
    if (touchesPrimary) {
      nearestRoadType = 'primary'
      distanceToProposedRoadFt = 0
    } else if (touchesSecondary) {
      nearestRoadType = 'secondary'
      distanceToProposedRoadFt = 0
    } else {
      const candidates: number[] = []
      if (nearestPrimaryFt !== null && isFinite(nearestPrimaryFt)) candidates.push(nearestPrimaryFt)
      if (nearestSecondaryFt !== null && isFinite(nearestSecondaryFt)) candidates.push(nearestSecondaryFt)
      if (candidates.length > 0) {
        distanceToProposedRoadFt = Math.min(...candidates)
        nearestRoadType = nearestPrimaryFt !== null && nearestSecondaryFt !== null
          ? (nearestPrimaryFt <= nearestSecondaryFt ? 'primary' : 'secondary')
          : nearestPrimaryFt !== null ? 'primary' : 'secondary'
      } else {
        distanceToProposedRoadFt = Infinity
      }
    }

    let accessState: DevelopmentOpportunityAccessState = 'LATENT_NO_NETWORK_ACCESS'
    if (touchesAny) {
      accessState = 'ROAD_SERVEABLE'
    } else if (isFinite(distanceToProposedRoadFt) && distanceToProposedRoadFt <= ROAD_NEAR_DISTANCE_FT) {
      accessState = 'NEAR_NETWORK'
    }

    // Existing-condition proximity
    const constraintProximities = {
      nearestBuildingFt: center ? distancePointToFeatureFt(center, candidateOpenArea.buildingUnionGeometry) : null,
      nearestHydrologyFt: center ? distancePointToFeatureFt(center, candidateOpenArea.hydrologyGeometry) : null,
      nearestPavementFt: center ? distancePointToFeatureFt(center, candidateOpenArea.pavementGeometry) : null
    }

    // Classification + score + reasons
    const classification = classifyBlock({
      areaAcres,
      compactness: comp,
      interiorSurvival,
      accessState,
      constraintProximities
    })

    const score = scoreBlock({
      areaAcres,
      compactness: comp,
      interiorSurvival,
      accessState,
      classification,
      constraintProximities
    })

    const reasons = buildReasons({
      areaAcres,
      classification,
      accessState,
      interiorSurvival,
      compactness: comp,
      constraintProximities,
      touchesPrimary,
      touchesSecondary,
      distanceToProposedRoadFt
    })

    blocks.push({
      id,
      rank: 0, // set after sorting
      classification,
      geometry: poly,
      areaSqFt: Math.round(area),
      areaAcres,
      perimeterFt: Math.round(perim),
      compactness: Number(comp.toFixed(3)),
      interiorSurvival,
      roadRelationship: {
        touchesPrimaryROW: touchesPrimary,
        touchesSecondaryROW: touchesSecondary,
        touchesAnyProposedROW: touchesAny,
        distanceToProposedRoadFt: isFinite(distanceToProposedRoadFt) ? Math.round(distanceToProposedRoadFt) : Infinity,
        nearestRoadType
      },
      constraintProximities,
      accessState,
      opportunityScore: Number(score.toFixed(1)),
      reasons
    })
  }

  // Rank by score descending, then area descending
  blocks.sort((a, b) => {
    if (b.opportunityScore !== a.opportunityScore) return b.opportunityScore - a.opportunityScore
    return b.areaSqFt - a.areaSqFt
  })
  blocks.forEach((b, i) => { b.rank = i + 1 })

  const opportunityBlocksSqFt = blocks.reduce((sum, b) => sum + b.areaSqFt, 0)
  const conservationDifferenceSqFt = candidateOpenAreaSqFt - (proposedROWInsideCOASqFt + opportunityBlocksSqFt)
  const conservationPassed = Math.abs(conservationDifferenceSqFt) <= AREA_CONSERVATION_TOLERANCE_SQFT

  const highCount = blocks.filter(b => b.classification === 'HIGH').length
  const moderateCount = blocks.filter(b => b.classification === 'MODERATE').length
  const lowCount = blocks.filter(b => b.classification === 'LOW').length
  const residualCount = blocks.filter(b => b.classification === 'RESIDUAL').length

  const totalBlockAreaAcres = blocks.reduce((sum, b) => sum + b.areaAcres, 0)
  const roadServeableAreaAcres = blocks
    .filter(b => b.accessState === 'ROAD_SERVEABLE')
    .reduce((sum, b) => sum + b.areaAcres, 0)
  const nearNetworkAreaAcres = blocks
    .filter(b => b.accessState === 'NEAR_NETWORK')
    .reduce((sum, b) => sum + b.areaAcres, 0)
  const latentNoNetworkAreaAcres = blocks
    .filter(b => b.accessState === 'LATENT_NO_NETWORK_ACCESS')
    .reduce((sum, b) => sum + b.areaAcres, 0)
  const largestBlockAcres = blocks.length > 0 ? Math.max(...blocks.map(b => b.areaAcres)) : 0

  const warnings: string[] = []
  if (!conservationPassed) {
    warnings.push(`Area conservation check exceeded tolerance by ${Math.abs(conservationDifferenceSqFt).toFixed(0)} sq ft.`)
  }
  if (blocks.length === 0) {
    warnings.push('No meaningful development opportunity blocks were identified.')
  }

  const result: DevelopmentOpportunityBlockResult = {
    mcpi,
    status: 'generated',
    blockCount: blocks.length,
    highCount,
    moderateCount,
    lowCount,
    residualCount,
    candidateOpenAreaSqFt: Math.round(candidateOpenAreaSqFt),
    proposedROWInsideCOASqFt: Math.round(proposedROWInsideCOASqFt),
    opportunityBlocksSqFt: Math.round(opportunityBlocksSqFt),
    conservationDifferenceSqFt: Math.round(conservationDifferenceSqFt),
    conservationToleranceSqFt: AREA_CONSERVATION_TOLERANCE_SQFT,
    conservationPassed,
    totalBlockAreaAcres: Number(totalBlockAreaAcres.toFixed(2)),
    roadServeableAreaAcres: Number(roadServeableAreaAcres.toFixed(2)),
    nearNetworkAreaAcres: Number(nearNetworkAreaAcres.toFixed(2)),
    latentNoNetworkAreaAcres: Number(latentNoNetworkAreaAcres.toFixed(2)),
    largestBlockAcres: Number(largestBlockAcres.toFixed(2)),
    blocks,
    warnings,
    explanation: blocks.length > 0
      ? `Identified ${blocks.length} conceptual development opportunity block${blocks.length === 1 ? '' : 's'} from Candidate Open Area after proposed conceptual road network.`
      : 'No conceptual development opportunity blocks were identified after applying the proposed road network.'
  }

  if (IS_DEV) {
    logDevelopmentOpportunityBlocks(result)
  }

  return result
}

interface ClassificationInputs {
  areaAcres: number
  compactness: number
  interiorSurvival: { bufferFeet: number; survivingAreaSqFt: number; survivalPercent: number }[]
  accessState: DevelopmentOpportunityAccessState
  constraintProximities: { nearestBuildingFt: number | null; nearestHydrologyFt: number | null; nearestPavementFt: number | null }
}

function classifyBlock(inputs: ClassificationInputs): DevelopmentOpportunityClassification {
  const { areaAcres, compactness, interiorSurvival, accessState, constraintProximities } = inputs

  // Very small or degenerate fragments are RESIDUAL
  if (areaAcres < SMALL_FRAGMENT_ACRES) return 'RESIDUAL'

  const strongInterior = interiorSurvival.some(s => s.bufferFeet === 75 && s.survivalPercent >= STRONG_INTERIOR_SURVIVAL_PCT) ||
                         interiorSurvival.some(s => s.bufferFeet === 100 && s.survivalPercent >= MODERATE_INTERIOR_SURVIVAL_PCT)
  const moderateInterior = interiorSurvival.some(s => s.bufferFeet === 50 && s.survivalPercent >= MODERATE_INTERIOR_SURVIVAL_PCT)
  const constrained = isConstrained(constraintProximities)

  // HIGH
  if (
    areaAcres >= HIGH_MIN_ACRES &&
    compactness >= HIGH_COMPACTNESS &&
    strongInterior &&
    (accessState === 'ROAD_SERVEABLE' || accessState === 'NEAR_NETWORK') &&
    !constrained
  ) {
    return 'HIGH'
  }

  // MODERATE
  if (
    areaAcres >= MODERATE_MIN_ACRES &&
    compactness >= MODERATE_COMPACTNESS &&
    moderateInterior &&
    (accessState === 'ROAD_SERVEABLE' || accessState === 'NEAR_NETWORK') &&
    !constrained
  ) {
    return 'MODERATE'
  }

  // LOW
  if (areaAcres >= MIN_MEANINGFUL_BLOCK_ACRES) {
    return 'LOW'
  }

  return 'RESIDUAL'
}

function isConstrained(proximities: { nearestBuildingFt: number | null; nearestHydrologyFt: number | null; nearestPavementFt: number | null }): boolean {
  const anyVeryClose = [proximities.nearestBuildingFt, proximities.nearestHydrologyFt, proximities.nearestPavementFt].some(d =>
    d !== null && d < CONSTRAINT_INFLUENCE_FT
  )
  return anyVeryClose
}

interface ScoreInputs {
  areaAcres: number
  compactness: number
  interiorSurvival: { bufferFeet: number; survivingAreaSqFt: number; survivalPercent: number }[]
  accessState: DevelopmentOpportunityAccessState
  classification: DevelopmentOpportunityClassification
  constraintProximities: { nearestBuildingFt: number | null; nearestHydrologyFt: number | null; nearestPavementFt: number | null }
}

function scoreBlock(inputs: ScoreInputs): number {
  const { areaAcres, compactness, interiorSurvival, accessState, classification, constraintProximities } = inputs

  let score = 0
  score += Math.min(areaAcres * 20, 60) // cap area contribution at 60
  score += compactness * 40
  score += (interiorSurvival.find(s => s.bufferFeet === 75)?.survivalPercent ?? 0) * 0.3

  if (accessState === 'ROAD_SERVEABLE') score += 25
  if (accessState === 'NEAR_NETWORK') score += 10

  if (classification === 'HIGH') score += 20
  if (classification === 'MODERATE') score += 10
  if (classification === 'LOW') score += 0
  if (classification === 'RESIDUAL') score -= 15

  if (isConstrained(constraintProximities)) score -= 15

  return Math.max(0, score)
}

interface ReasonInputs {
  areaAcres: number
  classification: DevelopmentOpportunityClassification
  accessState: DevelopmentOpportunityAccessState
  interiorSurvival: { bufferFeet: number; survivingAreaSqFt: number; survivalPercent: number }[]
  compactness: number
  constraintProximities: { nearestBuildingFt: number | null; nearestHydrologyFt: number | null; nearestPavementFt: number | null }
  touchesPrimary: boolean
  touchesSecondary: boolean
  distanceToProposedRoadFt: number
}

function buildReasons(inputs: ReasonInputs): string[] {
  const { areaAcres, classification, interiorSurvival, compactness, constraintProximities, touchesPrimary, touchesSecondary, distanceToProposedRoadFt } = inputs
  const reasons: string[] = []

  const s75 = interiorSurvival.find(s => s.bufferFeet === 75)
  if (s75 && s75.survivalPercent >= STRONG_INTERIOR_SURVIVAL_PCT) {
    reasons.push(`Strong 75-ft interior capacity (${s75.survivalPercent.toFixed(0)}% survival)`)
  } else if (s75 && s75.survivalPercent >= MODERATE_INTERIOR_SURVIVAL_PCT) {
    reasons.push(`Moderate 75-ft interior capacity (${s75.survivalPercent.toFixed(0)}% survival)`)
  } else if (s75 && s75.survivalPercent >= WEAK_INTERIOR_SURVIVAL_PCT) {
    reasons.push(`Limited 75-ft interior capacity (${s75.survivalPercent.toFixed(0)}% survival)`)
  }

  if (areaAcres >= HIGH_MIN_ACRES) {
    reasons.push(`${areaAcres.toFixed(2)} acres of contiguous area`)
  } else if (areaAcres >= MIN_MEANINGFUL_BLOCK_ACRES) {
    reasons.push(`${areaAcres.toFixed(2)} acres of usable area`)
  }

  if (touchesPrimary) {
    reasons.push('Touches proposed primary road right-of-way')
  } else if (touchesSecondary) {
    reasons.push('Touches proposed secondary road right-of-way')
  } else if (isFinite(distanceToProposedRoadFt) && distanceToProposedRoadFt <= ROAD_NEAR_DISTANCE_FT) {
    reasons.push(`${Math.round(distanceToProposedRoadFt)} ft to nearest conceptual road`)
  } else {
    reasons.push('No conceptual road access currently available')
  }

  if (compactness >= HIGH_COMPACTNESS) {
    reasons.push('Compact, efficient geometry')
  } else if (compactness >= MODERATE_COMPACTNESS) {
    reasons.push('Reasonably regular geometry')
  } else {
    reasons.push('Fragmented or irregular geometry')
  }

  const constrainedBy: string[] = []
  if (constraintProximities.nearestBuildingFt !== null && constraintProximities.nearestBuildingFt < CONSTRAINT_INFLUENCE_FT) constrainedBy.push('building')
  if (constraintProximities.nearestHydrologyFt !== null && constraintProximities.nearestHydrologyFt < CONSTRAINT_INFLUENCE_FT) constrainedBy.push('hydrology')
  if (constraintProximities.nearestPavementFt !== null && constraintProximities.nearestPavementFt < CONSTRAINT_INFLUENCE_FT) constrainedBy.push('pavement')
  if (constrainedBy.length > 0) {
    reasons.push(`Constrained by nearby ${constrainedBy.join('/')}`)
  }

  if (classification === 'RESIDUAL') {
    reasons.push('Very small or shallow fragment')
  }

  return reasons
}

function logDevelopmentOpportunityBlocks(result: DevelopmentOpportunityBlockResult) {
  const topBlocks = result.blocks.slice(0, 3).map(b => ({
    id: b.id,
    rank: b.rank,
    classification: b.classification,
    areaAcres: b.areaAcres,
    opportunityScore: b.opportunityScore,
    accessState: b.accessState,
    survival25: b.interiorSurvival.find(s => s.bufferFeet === 25)?.survivalPercent ?? null,
    survival50: b.interiorSurvival.find(s => s.bufferFeet === 50)?.survivalPercent ?? null,
    survival75: b.interiorSurvival.find(s => s.bufferFeet === 75)?.survivalPercent ?? null,
    survival100: b.interiorSurvival.find(s => s.bufferFeet === 100)?.survivalPercent ?? null,
    compactness: b.compactness,
    reasons: b.reasons
  }))

  console.log('[DevelopmentOpportunityBlocks]', {
    mcpi: result.mcpi,
    status: result.status,
    blockCount: result.blockCount,
    highCount: result.highCount,
    moderateCount: result.moderateCount,
    lowCount: result.lowCount,
    residualCount: result.residualCount,
    totalBlockAreaAcres: result.totalBlockAreaAcres,
    candidateOpenAreaSqFt: result.candidateOpenAreaSqFt,
    proposedROWInsideCOASqFt: result.proposedROWInsideCOASqFt,
    opportunityBlocksSqFt: result.opportunityBlocksSqFt,
    conservationDifferenceSqFt: result.conservationDifferenceSqFt,
    conservationPassed: result.conservationPassed,
    roadServeableAreaAcres: result.roadServeableAreaAcres,
    nearNetworkAreaAcres: result.nearNetworkAreaAcres,
    latentNoNetworkAreaAcres: result.latentNoNetworkAreaAcres,
    topBlocks
  })
}
