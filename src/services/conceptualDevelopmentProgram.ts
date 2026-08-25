import { turfc as turf, recomputeCounter, generationPerformance, turfCounter } from '../lib/perf'
import { yieldIfNeeded } from '../lib/cooperativeScheduler'
import type { TerrainSuitabilityResult } from '../types/terrain'
import type {
  DevelopmentOpportunityBlockResult,
  DevelopmentOpportunityBlock,
  ProjectParameters,
  DevelopmentUse,
  DevelopmentOpportunityClassification,
  SecondaryRoadNetworkResult
} from '../types/parameters'

export type DevelopmentZoneRoadRelationship =
  | 'PRIMARY_FRONTAGE'
  | 'SECONDARY_FRONTAGE'
  | 'NEAR_NETWORK'
  | 'LATENT'

export type ProgramCompatibilityLevel = 'STRONG' | 'MODERATE' | 'WEAK' | 'UNSUITABLE'

export interface ProgramCompatibility {
  useType: string
  category: 'residential' | 'commercial' | 'civic'
  level: ProgramCompatibilityLevel
  reasons: string[]
}

export interface ConceptualDevelopmentZone {
  id: string
  sourceBlockId: string
  geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  areaSqFt: number
  areaAcres: number
  perimeterFt: number
  compactness: number
  dominantDimensionFt: number
  shapeProxy: 'compact' | 'elongated' | 'irregular' | 'fragment'
  programStatus: 'PROGRAMMABLE' | 'RESIDUAL'
  roadRelationship: DevelopmentZoneRoadRelationship
  roadFrontageFt: number
  distanceToPrimaryRoadFt: number | null
  distanceToSecondaryRoadFt: number | null
  distanceToNearestRoadFt: number | null
  actualRoadServedAreaAcres: number | null
  roadServedFraction: number | null
  terrainAssessment: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'
  opportunityClass: DevelopmentOpportunityClassification
  constraintProximities: {
    nearestBuildingFt: number | null
    nearestHydrologyFt: number | null
    nearestPavementFt: number | null
  }
  programCompatibilities: ProgramCompatibility[]
  compatibilityByUse: Record<string, ProgramCompatibilityLevel>
  bestCompatibleUse: string | null
  bestCompatibility: ProgramCompatibilityLevel
  capacityStatus: 'ROAD_SUPPORTED' | 'PARTIALLY_NETWORK_SUPPORTED' | 'LATENT_ACCESS_CONSTRAINED' | 'UNAVAILABLE'
  densityCapacity?: number
  lotCapacity?: number
  reasons: string[]
}

export interface ConceptualDevelopmentProgramResult {
  mcpi: string
  status: 'generated' | 'empty' | 'latent' | 'unavailable'
  capacityStatus: 'ROAD_SUPPORTED' | 'PARTIALLY_NETWORK_SUPPORTED' | 'LATENT_ACCESS_CONSTRAINED' | 'UNAVAILABLE'
  sourceOpportunityBlockCount: number
  zoneCount: number
  totalOpportunityBlockAreaAcres: number
  programmableAreaSqFt: number
  programmableAreaAcres: number
  residualAreaSqFt: number
  residualAreaAcres: number
  programmableRoadServedAreaSqFt: number
  programmableRoadServedAreaAcres: number
  programmableNearNetworkAreaSqFt: number
  programmableNearNetworkAreaAcres: number
  programmableLatentAreaSqFt: number
  programmableLatentAreaAcres: number
  programmableAccountingDifferenceSqFt: number
  actualPrimaryServedAreaAcres: number
  actualSecondaryNewServedAreaAcres: number
  actualTotalNetworkServedAreaAcres: number
  networkServiceDifferenceSqFt: number
  residentialCompatibleAreaSqFt: number
  residentialCompatibleAreaAcres: number
  commercialCompatibleAreaSqFt: number
  commercialCompatibleAreaAcres: number
  selectedDevelopmentTypes: string[]
  targetDensity?: number
  preferredLotSize?: number
  conceptualCapacity: {
    densityUnits: number
    lotUnits?: number
  } | null
  conservationDifferenceSqFt: number
  conservationPassed: boolean
  zones: ConceptualDevelopmentZone[]
  parametersApplied: { parameter: string; used: boolean; value: any }[]
  warnings: string[]
}

const SQFT_PER_ACRE = 43560

function safeTurfOp<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function shapeProxy(areaSqFt: number, perimeterFt: number, compactness: number, dominantDimensionFt: number): 'compact' | 'elongated' | 'irregular' | 'fragment' {
  if (areaSqFt < 2000 || perimeterFt < 100) return 'fragment'
  if (compactness >= 0.55) return 'compact'
  const ratio = dominantDimensionFt > 0 ? perimeterFt / (4 * dominantDimensionFt) : 1
  if (ratio > 1.6) return 'elongated'
  return 'irregular'
}

function dominantDimensionFt(geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): number {
  const bbox = safeTurfOp(() => turf.bbox(geometry) as [number, number, number, number], [0, 0, 0, 0])
  const [minX, minY, maxX, maxY] = bbox
  const w = safeTurfOp(() => turf.distance(turf.point([minX, minY]), turf.point([maxX, minY]), { units: 'feet' }), 0)
  const h = safeTurfOp(() => turf.distance(turf.point([minX, minY]), turf.point([minX, maxY]), { units: 'feet' }), 0)
  return Math.max(w, h)
}

function terrainAssessmentFromClass(classification: DevelopmentOpportunityClassification): 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA' {
  switch (classification) {
    case 'HIGH': return 'FAVORABLE'
    case 'MODERATE': return 'MODERATE'
    case 'LOW': return 'CHALLENGING'
    case 'RESIDUAL': return 'INSUFFICIENT_DATA'
    default: return 'INSUFFICIENT_DATA'
  }
}

function roadRelationshipFor(block: DevelopmentOpportunityBlock): DevelopmentZoneRoadRelationship {
  const r = block.roadRelationship
  if (r.touchesPrimaryROW) return 'PRIMARY_FRONTAGE'
  if (r.touchesSecondaryROW) return 'SECONDARY_FRONTAGE'
  if (r.distanceToProposedRoadFt <= 150) return 'NEAR_NETWORK'
  return 'LATENT'
}

function roadFrontageFt(block: DevelopmentOpportunityBlock, relationship: DevelopmentZoneRoadRelationship): number {
  if (relationship === 'PRIMARY_FRONTAGE' || relationship === 'SECONDARY_FRONTAGE') {
    // Approximate frontage as a share of the block perimeter where it meets a road ROW.
    // This is a conceptual heuristic, not a survey measurement.
    return Math.min(block.perimeterFt * 0.25, 200)
  }
  if (relationship === 'NEAR_NETWORK') return Math.min(block.perimeterFt * 0.1, 75)
  return 0
}

function distanceToPrimaryOrNull(block: DevelopmentOpportunityBlock): number | null {
  if (block.roadRelationship.touchesPrimaryROW || block.roadRelationship.nearestRoadType === 'primary') {
    return block.roadRelationship.distanceToProposedRoadFt
  }
  return null
}

function distanceToSecondaryOrNull(block: DevelopmentOpportunityBlock): number | null {
  if (block.roadRelationship.touchesSecondaryROW || block.roadRelationship.nearestRoadType === 'secondary') {
    return block.roadRelationship.distanceToProposedRoadFt
  }
  return null
}

const RESIDENTIAL_USES = ['single-family', 'townhomes', 'multifamily', 'cottage', 'duplex']

function compatibilityFor(use: DevelopmentUse, block: DevelopmentOpportunityBlock, road: DevelopmentZoneRoadRelationship, terrain: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'): ProgramCompatibility {
  const area = block.areaAcres
  const compact = block.compactness
  const frontage = road === 'PRIMARY_FRONTAGE' || road === 'SECONDARY_FRONTAGE'
  const near = road === 'NEAR_NETWORK'
  const isResidual = block.classification === 'RESIDUAL'
  const isLow = block.classification === 'LOW'
  const reasons: string[] = []
  let level: ProgramCompatibilityLevel = 'STRONG'

  const useType = use.useType.toLowerCase()

  // Terrain evidence downgrades only; it does not unilaterally reject.
  if (terrain === 'CHALLENGING') {
    reasons.push('Terrain is challenging; grading/site design needed')
    if (level === 'STRONG') level = 'MODERATE'
  }
  if (terrain === 'INSUFFICIENT_DATA') {
    reasons.push('Insufficient terrain data')
    if (level === 'STRONG' || level === 'MODERATE') level = 'WEAK'
  }

  if (isResidual) {
    reasons.push('Residual/unprogrammed opportunity block')
    level = 'UNSUITABLE'
  }

  if (useType.includes('single-family')) {
    if (area < 0.25) { reasons.push(`Area ${area.toFixed(2)} ac < 0.25 ac threshold for single-family`); level = down(level) }
    if (compact < 0.3) { reasons.push('Compactness below single-family heuristic'); level = down(level) }
    if (!frontage && !near) { reasons.push('No road frontage or near-network access'); level = down(level) }
    else if (!frontage) { reasons.push('Near network but no direct frontage'); level = down(level) }
  } else if (useType.includes('townhome') || useType.includes('townhouse')) {
    if (area < 0.2) { reasons.push(`Area ${area.toFixed(2)} ac < 0.2 ac threshold for townhomes`); level = down(level) }
    if (compact < 0.25) { reasons.push('Compactness below townhome heuristic'); level = down(level) }
    if (!frontage && !near) { reasons.push('No road frontage or near-network access'); level = down(level) }
  } else if (useType.includes('multifamily') || useType.includes('apartment')) {
    if (area < 0.4) { reasons.push(`Area ${area.toFixed(2)} ac < 0.4 ac threshold for multifamily`); level = down(level) }
    if (compact < 0.35) { reasons.push('Compactness below multifamily heuristic'); level = down(level) }
    if (!frontage && !near) { reasons.push('No road frontage or near-network access'); level = down(level) }
    else if (!frontage) { reasons.push('Near network but no direct frontage'); level = down(level) }
  } else if (useType.includes('commercial') || useType.includes('retail') || useType.includes('office')) {
    if (area < 0.25) { reasons.push(`Area ${area.toFixed(2)} ac < 0.25 ac threshold for commercial`); level = down(level) }
    if (!frontage) { reasons.push('Commercial uses prefer direct road frontage'); level = down(level) }
    if (isLow) { reasons.push('LOW opportunity block is less suitable for commercial'); level = down(level) }
  } else if (useType.includes('mixed-use')) {
    if (area < 0.4) { reasons.push(`Area ${area.toFixed(2)} ac < 0.4 ac threshold for mixed-use`); level = down(level) }
    if (!frontage) { reasons.push('Mixed-use prefers direct road frontage'); level = down(level) }
    if (isLow) { reasons.push('LOW opportunity block is less suitable for mixed-use'); level = down(level) }
  } else {
    // Civic / other
    if (area < 0.5) { reasons.push(`Area ${area.toFixed(2)} ac < 0.5 ac threshold for civic uses`); level = down(level) }
    if (!frontage && !near) { reasons.push('Civic uses prefer network visibility'); level = down(level) }
  }

  if (level === 'WEAK' && reasons.length === 0) reasons.push('Marginally suited to selected use')
  if (level === 'MODERATE' && reasons.length === 0) reasons.push('Suitable with design refinement')
  if (level === 'STRONG' && reasons.length === 0) reasons.push('Well-suited to selected use')

  return { useType: use.useType, category: use.category, level, reasons }
}

function down(level: ProgramCompatibilityLevel): ProgramCompatibilityLevel {
  if (level === 'STRONG') return 'MODERATE'
  if (level === 'MODERATE') return 'WEAK'
  return 'UNSUITABLE'
}

function bestUse(compatibilities: ProgramCompatibility[]): { use: string | null; level: ProgramCompatibilityLevel } {
  const order = { 'STRONG': 4, 'MODERATE': 3, 'WEAK': 2, 'UNSUITABLE': 1 }
  const best = compatibilities.reduce((b, c) => (order[c.level] > order[b.level] ? c : b), compatibilities[0] || null)
  if (!best) return { use: null, level: 'UNSUITABLE' }
  return { use: best.useType, level: best.level }
}

export async function generateConceptualDevelopmentProgram(
  blockResult: DevelopmentOpportunityBlockResult | null | undefined,
  projectParameters: ProjectParameters | null | undefined,
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null,
  extras?: { preferredLotSize?: number; signal?: AbortSignal; terrainSuitability?: TerrainSuitabilityResult | null }
): Promise<ConceptualDevelopmentProgramResult> {
  recomputeCounter.increment('program')
  generationPerformance.start('program')
  turfCounter.setCaller('program')
  try {
  const mcpi = blockResult?.mcpi || projectParameters?.parcelId || 'unknown'
  const warnings: string[] = []

  if (extras?.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  if (!blockResult) {
    warnings.push('No Development Opportunity Block result available')
    return {
      mcpi,
      status: 'unavailable',
      capacityStatus: 'UNAVAILABLE',
      sourceOpportunityBlockCount: 0,
      zoneCount: 0,
      totalOpportunityBlockAreaAcres: 0,
      programmableAreaSqFt: 0,
      programmableAreaAcres: 0,
      residualAreaSqFt: 0,
      residualAreaAcres: 0,
      programmableRoadServedAreaSqFt: 0,
      programmableRoadServedAreaAcres: 0,
      programmableNearNetworkAreaSqFt: 0,
      programmableNearNetworkAreaAcres: 0,
      programmableLatentAreaSqFt: 0,
      programmableLatentAreaAcres: 0,
      programmableAccountingDifferenceSqFt: 0,
      actualPrimaryServedAreaAcres: 0,
      actualSecondaryNewServedAreaAcres: 0,
      actualTotalNetworkServedAreaAcres: 0,
      networkServiceDifferenceSqFt: 0,
      residentialCompatibleAreaSqFt: 0,
      residentialCompatibleAreaAcres: 0,
      commercialCompatibleAreaSqFt: 0,
      commercialCompatibleAreaAcres: 0,
      selectedDevelopmentTypes: [],
      targetDensity: undefined,
      preferredLotSize: undefined,
      conceptualCapacity: null,
      conservationDifferenceSqFt: 0,
      conservationPassed: true,
      zones: [],
      parametersApplied: [],
      warnings
    }
  }

  const selectedDevelopmentTypes = (projectParameters?.developmentProgram || [])
    .filter(u => u.enabled)
    .map(u => u.useType)

  if (selectedDevelopmentTypes.length === 0) {
    warnings.push('No development types selected; using default compatibility only')
  }

  const targetDensity = projectParameters?.zoningAndLots?.targetDensity
  const preferredLotSize = extras?.preferredLotSize ?? projectParameters?.zoningAndLots?.minLotArea

  const parametersApplied = [
    { parameter: 'developmentTypes', used: selectedDevelopmentTypes.length > 0, value: selectedDevelopmentTypes },
    { parameter: 'targetDensity', used: targetDensity !== undefined && targetDensity > 0, value: targetDensity ?? null },
    { parameter: 'preferredLotSize', used: preferredLotSize !== undefined && preferredLotSize > 0, value: preferredLotSize ?? null },
    { parameter: 'rightOfWayWidth', used: true, value: projectParameters?.roads?.rightOfWayWidth ?? 50 }
  ]

  const primaryServedSqFt = secondaryRoadNetworkResult?.primaryServedAreaSqFt ?? 0
  const secondaryServedSqFt = secondaryRoadNetworkResult?.secondaryNewlyServedAreaSqFt ?? 0
  const totalNetworkServedSqFt = secondaryRoadNetworkResult?.totalNetworkServedAreaSqFt ?? 0

  const zones: ConceptualDevelopmentZone[] = []
  let programmableAreaSqFt = 0
  let residualAreaSqFt = 0
  let programmableRoadServedAreaSqFt = 0
  let programmableNearNetworkAreaSqFt = 0
  let programmableLatentAreaSqFt = 0
  let residentialCompatibleAreaSqFt = 0
  let commercialCompatibleAreaSqFt = 0

  for (const block of blockResult.blocks) {
    const road = roadRelationshipFor(block)
    const terrain = terrainAssessmentFromClass(block.classification)
    const frontage = roadFrontageFt(block, road)
    const dom = dominantDimensionFt(block.geometry)
    const proxy = shapeProxy(block.areaSqFt, block.perimeterFt, block.compactness, dom)

    const compatibilities = selectedDevelopmentTypes.length
      ? (projectParameters!.developmentProgram.filter(u => u.enabled).map(u => compatibilityFor(u, block, road, terrain)))
      : []

    const compatibilityByUse: Record<string, ProgramCompatibilityLevel> = {}
    for (const c of compatibilities) compatibilityByUse[c.useType] = c.level

    const { use, level } = bestUse(compatibilities)
    const reasons: string[] = []
    if (block.reasons && block.reasons.length) reasons.push(...block.reasons)
    reasons.push(`Road relationship: ${road}`)
    reasons.push(`Terrain: ${terrain}`)
    if (use) reasons.push(`Best compatible use: ${use} (${level})`)
    if (compatibilities.length === 0) reasons.push('No selected development types for compatibility')

    const isProgrammable = block.classification !== 'RESIDUAL'
    const isResidual = block.classification === 'RESIDUAL'

    const hasResidentialCompatibility = isProgrammable && compatibilities.some(c => c.category === 'residential' && c.level !== 'UNSUITABLE')
    const hasCommercialCompatibility = isProgrammable && compatibilities.some(c => c.category === 'commercial' && c.level !== 'UNSUITABLE')

    let densityCapacity: number | undefined
    let lotCapacity: number | undefined
    if (hasResidentialCompatibility && targetDensity !== undefined && targetDensity > 0) {
      densityCapacity = Math.floor(block.areaAcres * targetDensity)
    }
    if (hasResidentialCompatibility && preferredLotSize !== undefined && preferredLotSize > 0) {
      lotCapacity = Math.floor(block.areaSqFt / preferredLotSize)
    }

    const zone: ConceptualDevelopmentZone = {
      id: `ZONE-${block.id}`,
      sourceBlockId: block.id,
      geometry: block.geometry,
      areaSqFt: block.areaSqFt,
      areaAcres: block.areaAcres,
      perimeterFt: block.perimeterFt,
      compactness: block.compactness,
      dominantDimensionFt: dom,
      shapeProxy: proxy,
      programStatus: isProgrammable ? 'PROGRAMMABLE' : 'RESIDUAL',
      roadRelationship: road,
      roadFrontageFt: frontage,
      distanceToPrimaryRoadFt: distanceToPrimaryOrNull(block),
      distanceToSecondaryRoadFt: distanceToSecondaryOrNull(block),
      distanceToNearestRoadFt: block.roadRelationship.distanceToProposedRoadFt,
      actualRoadServedAreaAcres: null,
      roadServedFraction: null,
      terrainAssessment: terrain,
      opportunityClass: block.classification,
      constraintProximities: block.constraintProximities,
      programCompatibilities: compatibilities,
      compatibilityByUse,
      bestCompatibleUse: use,
      bestCompatibility: level,
      capacityStatus: 'UNAVAILABLE',
      densityCapacity,
      lotCapacity,
      reasons
    }

    zones.push(zone)
    if (isProgrammable) {
      programmableAreaSqFt += block.areaSqFt
      if (hasResidentialCompatibility) residentialCompatibleAreaSqFt += block.areaSqFt
      if (hasCommercialCompatibility) commercialCompatibleAreaSqFt += block.areaSqFt
      if (road === 'PRIMARY_FRONTAGE' || road === 'SECONDARY_FRONTAGE') {
        programmableRoadServedAreaSqFt += block.areaSqFt
      } else if (road === 'NEAR_NETWORK') {
        programmableNearNetworkAreaSqFt += block.areaSqFt
      } else if (road === 'LATENT') {
        programmableLatentAreaSqFt += block.areaSqFt
      }
    }
    if (isResidual) residualAreaSqFt += block.areaSqFt
    await yieldIfNeeded(extras?.signal)
  }

  const programmableAccountingDifferenceSqFt =
    (programmableRoadServedAreaSqFt + programmableNearNetworkAreaSqFt + programmableLatentAreaSqFt) - programmableAreaSqFt

  const totalOpportunityBlockAreaAcres = (blockResult.totalBlockAreaAcres || (blockResult.opportunityBlocksSqFt ?? 0) / SQFT_PER_ACRE)
  const expectedTotal = (blockResult.opportunityBlocksSqFt || 0)
  const computedTotal = programmableAreaSqFt + residualAreaSqFt
  const conservationDifferenceSqFt = computedTotal - expectedTotal
  const conservationPassed = Math.abs(conservationDifferenceSqFt) <= 100
  if (!conservationPassed) {
    warnings.push(`Area conservation difference: ${conservationDifferenceSqFt.toFixed(0)} sqft`)
  }

  const residentialCompatibleAreaAcres = residentialCompatibleAreaSqFt / SQFT_PER_ACRE

  let conceptualCapacity: { densityUnits: number; lotUnits?: number } | null = null
  const anyResidential = selectedDevelopmentTypes.some(t => RESIDENTIAL_USES.some(r => t.toLowerCase().includes(r)))
  if (targetDensity !== undefined && targetDensity > 0 && anyResidential) {
    const densityUnits = Math.floor(residentialCompatibleAreaAcres * targetDensity)
    if (preferredLotSize !== undefined && preferredLotSize > 0) {
      const lotUnits = Math.floor(residentialCompatibleAreaSqFt / preferredLotSize)
      conceptualCapacity = { densityUnits, lotUnits }
    } else {
      conceptualCapacity = { densityUnits }
    }
  }

  const status: 'generated' | 'empty' | 'latent' | 'unavailable' =
    zones.length === 0 ? 'empty' :
    zones.every(z => z.roadRelationship === 'LATENT') ? 'latent' : 'generated'

  const actualPrimaryServedAreaAcres = primaryServedSqFt / SQFT_PER_ACRE
  const actualSecondaryNewServedAreaAcres = secondaryServedSqFt / SQFT_PER_ACRE
  const actualTotalNetworkServedAreaAcres = totalNetworkServedSqFt / SQFT_PER_ACRE

  const networkServiceDifferenceSqFt = totalNetworkServedSqFt - (programmableRoadServedAreaSqFt + programmableNearNetworkAreaSqFt)

  let capacityStatus: 'ROAD_SUPPORTED' | 'PARTIALLY_NETWORK_SUPPORTED' | 'LATENT_ACCESS_CONSTRAINED' | 'UNAVAILABLE' = 'UNAVAILABLE'
  if (zones.length === 0) {
    capacityStatus = 'UNAVAILABLE'
  } else if (totalNetworkServedSqFt === 0) {
    capacityStatus = 'LATENT_ACCESS_CONSTRAINED'
    warnings.push('No feasible conceptual road/access framework was identified; capacity is a physical development proxy only')
  } else if (totalNetworkServedSqFt >= residentialCompatibleAreaSqFt * 0.95) {
    capacityStatus = 'ROAD_SUPPORTED'
  } else {
    capacityStatus = 'PARTIALLY_NETWORK_SUPPORTED'
  }

  const programmableRoadNearAreaSqFt = programmableRoadServedAreaSqFt + programmableNearNetworkAreaSqFt
  const programmableRoadNearAreaAcres = programmableRoadNearAreaSqFt / SQFT_PER_ACRE

  for (const zone of zones) {
    if (zone.programStatus === 'RESIDUAL') {
      zone.actualRoadServedAreaAcres = 0
      zone.roadServedFraction = 0
      zone.capacityStatus = 'UNAVAILABLE'
      continue
    }

    if (zone.roadRelationship === 'LATENT' || totalNetworkServedSqFt === 0 || programmableRoadNearAreaSqFt === 0) {
      zone.actualRoadServedAreaAcres = 0
      zone.roadServedFraction = 0
      zone.capacityStatus = 'LATENT_ACCESS_CONSTRAINED'
      continue
    }

    let servedAcres = (zone.areaAcres / programmableRoadNearAreaAcres) * actualTotalNetworkServedAreaAcres
    servedAcres = Math.min(servedAcres, zone.areaAcres)
    const fraction = zone.areaAcres > 0 ? servedAcres / zone.areaAcres : 0
    zone.actualRoadServedAreaAcres = Number(servedAcres.toFixed(4))
    zone.roadServedFraction = Number(fraction.toFixed(4))

    if (zone.roadRelationship === 'PRIMARY_FRONTAGE' || zone.roadRelationship === 'SECONDARY_FRONTAGE') {
      zone.capacityStatus = fraction >= 0.5 ? 'ROAD_SUPPORTED' : 'PARTIALLY_NETWORK_SUPPORTED'
    } else {
      zone.capacityStatus = 'PARTIALLY_NETWORK_SUPPORTED'
    }
  }

  if (Math.abs(programmableAccountingDifferenceSqFt) > 100) {
    warnings.push(`Programmable access-state accounting difference: ${programmableAccountingDifferenceSqFt.toFixed(0)} sqft`)
  }

  return {
    mcpi,
    status,
    capacityStatus,
    sourceOpportunityBlockCount: blockResult.blocks.length,
    zoneCount: zones.length,
    totalOpportunityBlockAreaAcres,
    programmableAreaSqFt,
    programmableAreaAcres: programmableAreaSqFt / SQFT_PER_ACRE,
    residualAreaSqFt,
    residualAreaAcres: residualAreaSqFt / SQFT_PER_ACRE,
    programmableRoadServedAreaSqFt,
    programmableRoadServedAreaAcres: programmableRoadServedAreaSqFt / SQFT_PER_ACRE,
    programmableNearNetworkAreaSqFt,
    programmableNearNetworkAreaAcres: programmableNearNetworkAreaSqFt / SQFT_PER_ACRE,
    programmableLatentAreaSqFt,
    programmableLatentAreaAcres: programmableLatentAreaSqFt / SQFT_PER_ACRE,
    programmableAccountingDifferenceSqFt,
    actualPrimaryServedAreaAcres,
    actualSecondaryNewServedAreaAcres,
    actualTotalNetworkServedAreaAcres,
    networkServiceDifferenceSqFt,
    residentialCompatibleAreaSqFt,
    residentialCompatibleAreaAcres,
    commercialCompatibleAreaSqFt,
    commercialCompatibleAreaAcres: commercialCompatibleAreaSqFt / SQFT_PER_ACRE,
    selectedDevelopmentTypes,
    targetDensity,
    preferredLotSize,
    conceptualCapacity,
    conservationDifferenceSqFt,
    conservationPassed,
    zones,
    parametersApplied,
    warnings
  }
} finally {
  turfCounter.clearCaller()
  generationPerformance.finish('program')
}
}
