import { turfc as turf, safeTurfOp } from './perf'
import type {
  DevelopmentApproach,
  RedevelopmentBuildingTreatment,
  RedevelopmentPavementTreatment,
  RedevelopmentInternalRoadTreatment,
  GenerationPriorities,
} from '../types/parameters'
import type { ConceptStrategy } from '../types/conceptAlternatives'
import type { AuthoritativeConceptInput, AuthoritativeConceptResult } from '../services/authoritativeConceptService'

export interface RedevelopmentImpactMetrics {
  eligibleBuildingAreaImpactedSqFt: number
  eligiblePavementAreaImpactedSqFt: number
  redevelopmentImpactLevel: 'LOW' | 'MODERATE' | 'HIGH'
  estimatedBuildingFootprintImpacted: boolean
  estimatedPavementFootprintImpacted: boolean
}

export interface RedevelopmentOpportunityContext {
  isRedevelopment: boolean
  developmentApproach: DevelopmentApproach
  buildingTreatment: RedevelopmentBuildingTreatment | null
  pavementTreatment: RedevelopmentPavementTreatment | null
  internalRoadTreatment: RedevelopmentInternalRoadTreatment | null
  strategy: ConceptStrategy
  priorities: GenerationPriorities
  preservedBuildingGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  eligibleBuildingGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  preservedPavementGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  eligiblePavementGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  totalEligibleBuildingAreaSqFt: number
  totalEligiblePavementAreaSqFt: number
}

interface RedevelopmentDisturbanceOptions {
  servedDevelopableAreaSqFt?: number
  unlocksAdditionalAcreage?: boolean
  isDirectAccess?: boolean
}

// Centralized, named weights per strategy.  Units are penalty points per square foot.
const STRATEGY_BUILDING_PENALTY_PER_SQFT: Record<ConceptStrategy, number> = {
  BALANCED: 0.008,
  MAX_YIELD: 0.002,
  CONSTRAINT_CONSERVATIVE: 0.020,
}

const STRATEGY_PAVEMENT_PENALTY_PER_SQFT: Record<ConceptStrategy, number> = {
  BALANCED: 0.002,
  MAX_YIELD: 0.0005,
  CONSTRAINT_CONSERVATIVE: 0.006,
}

const PRESERVE_EXISTING_PRIORITY_MULTIPLIER: Record<'low' | 'medium' | 'high', number> = {
  low: 1.0,
  medium: 1.5,
  high: 2.5,
}

const ROAD_CONNECTIVITY_DISCOUNT_PER_SERVED_ACRE: Record<'low' | 'medium' | 'high', number> = {
  low: 120,
  medium: 240,
  high: 400,
}

const YIELD_BONUS_PER_UNLOCKED_ACRE: Record<ConceptStrategy, number> = {
  BALANCED: 80,
  MAX_YIELD: 200,
  CONSTRAINT_CONSERVATIVE: 20,
}

let activeContext: RedevelopmentOpportunityContext | null = null

export function setActiveRedevelopmentContext(ctx: RedevelopmentOpportunityContext | null): void {
  activeContext = ctx
}

export function getActiveRedevelopmentContext(): RedevelopmentOpportunityContext | null {
  return activeContext
}

export function createRedevelopmentOpportunityContext(input: AuthoritativeConceptInput): RedevelopmentOpportunityContext {
  const projectParameters = input.projectParameters
  const candidate = input.candidateOpenArea
  const buildingClassification = candidate.buildingClassification
  const pavementClassification = candidate.pavementClassification

  return {
    isRedevelopment: projectParameters.developmentApproach === 'REDEVELOPMENT',
    developmentApproach: projectParameters.developmentApproach,
    buildingTreatment: buildingClassification?.buildingTreatment ?? null,
    pavementTreatment: pavementClassification?.pavementTreatment ?? null,
    internalRoadTreatment: projectParameters.redevelopment?.internalRoadTreatment ?? null,
    strategy: input.targetAlternativeId,
    priorities: projectParameters.priorities,
    preservedBuildingGeometry: candidate.buildingUnionGeometry ?? null,
    eligibleBuildingGeometry: candidate.eligibleBuildingGeometry ?? null,
    preservedPavementGeometry: candidate.pavementGeometry ?? null,
    eligiblePavementGeometry: candidate.eligiblePavementGeometry ?? null,
    totalEligibleBuildingAreaSqFt: buildingClassification?.redevelopmentEligibleBuildingAreaSqFt ?? 0,
    totalEligiblePavementAreaSqFt: pavementClassification?.reconfigurationEligiblePavementAreaSqFt ?? 0,
  }
}

function bboxOverlaps(
  a: GeoJSON.Feature<GeoJSON.Geometry>,
  b: GeoJSON.Feature<GeoJSON.Geometry>
): boolean {
  try {
    const ab = turf.bbox(a) as number[]
    const bb = turf.bbox(b) as number[]
    return ab[0] <= bb[2] && ab[2] >= bb[0] && ab[1] <= bb[3] && ab[3] >= bb[1]
  } catch {
    return true
  }
}

function safeIntersect(
  a: GeoJSON.Feature<GeoJSON.Geometry> | null,
  b: GeoJSON.Feature<GeoJSON.Geometry> | null
): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!a || !b) return null
  if (!bboxOverlaps(a, b)) return null
  try {
    const fc = turf.featureCollection([a, b]) as any
    const result = turf.intersect(fc) as GeoJSON.Feature<GeoJSON.Geometry> | null
    return result
  } catch {
    return null
  }
}

function featureAreaSqFt(feature: GeoJSON.Feature<GeoJSON.Geometry> | null): number {
  if (!feature || !feature.geometry) return 0
  try {
    return turf.area(feature) * 10.7639
  } catch {
    return 0
  }
}

function priorityMultiplier(priority: 'low' | 'medium' | 'high' | undefined, defaultValue: number): number {
  return priority ? PRESERVE_EXISTING_PRIORITY_MULTIPLIER[priority] : defaultValue
}

export interface RedevelopmentDisturbanceScore {
  totalPenalty: number
  eligibleBuildingAreaSqFt: number
  eligiblePavementAreaSqFt: number
  openLandAreaSqFt: number
  impactLevel: 'LOW' | 'MODERATE' | 'HIGH'
  preservedOverlap: boolean
}

export function computeRedevelopmentDisturbance(
  footprint: GeoJSON.Feature<GeoJSON.Geometry> | null,
  options: RedevelopmentDisturbanceOptions = {}
): RedevelopmentDisturbanceScore {
  const defaultScore: RedevelopmentDisturbanceScore = {
    totalPenalty: 0,
    eligibleBuildingAreaSqFt: 0,
    eligiblePavementAreaSqFt: 0,
    openLandAreaSqFt: 0,
    impactLevel: 'LOW',
    preservedOverlap: false,
  }

  if (!footprint) return defaultScore

  const ctx = activeContext
  if (!ctx || !ctx.isRedevelopment) return defaultScore

  // New_DEVELOPMENT: no redevelopment opportunity model is applied.
  if (ctx.developmentApproach === 'NEW_DEVELOPMENT') return defaultScore

  const preservePriority = ctx.priorities.preserveExistingDevelopment
  const baseBuildingPenalty = STRATEGY_BUILDING_PENALTY_PER_SQFT[ctx.strategy]
  const basePavementPenalty = STRATEGY_PAVEMENT_PENALTY_PER_SQFT[ctx.strategy]
  const multiplier = priorityMultiplier(preservePriority, 1.0)

  const buildingIntersection = safeIntersect(footprint, ctx.eligibleBuildingGeometry)
  const buildingArea = featureAreaSqFt(buildingIntersection)
  const pavementIntersection = safeIntersect(footprint, ctx.eligiblePavementGeometry)
  const pavementArea = featureAreaSqFt(pavementIntersection)

  const preservedBuildingOverlap = safeIntersect(footprint, ctx.preservedBuildingGeometry) !== null
  const preservedPavementOverlap = safeIntersect(footprint, ctx.preservedPavementGeometry) !== null

  let buildingPenalty = buildingArea * baseBuildingPenalty * multiplier
  let pavementPenalty = pavementArea * basePavementPenalty * multiplier

  // Direct-access / connectivity discount
  const roadConnectivity = ctx.priorities.roadConnectivity
  const servedSqFt = options.servedDevelopableAreaSqFt ?? 0
  const servedAcres = servedSqFt / 43560
  const accessDiscountCap = (buildingPenalty + pavementPenalty) * 0.75
  const accessDiscount = Math.min(
    accessDiscountCap,
    servedAcres * ROAD_CONNECTIVITY_DISCOUNT_PER_SERVED_ACRE[roadConnectivity ?? 'medium']
  )

  if (options.isDirectAccess) {
    buildingPenalty *= 0.75
    pavementPenalty *= 0.75
  }

  const netPenalty = buildingPenalty + pavementPenalty - accessDiscount

  // Unlock bonus
  const unlockedAcres = options.unlocksAdditionalAcreage ? servedAcres : 0
  const yieldBonus = Math.min(netPenalty, unlockedAcres * YIELD_BONUS_PER_UNLOCKED_ACRE[ctx.strategy])

  const totalPenalty = Math.max(0, netPenalty - yieldBonus)

  const totalEligible = ctx.totalEligibleBuildingAreaSqFt + ctx.totalEligiblePavementAreaSqFt
  const impacted = buildingArea + pavementArea
  const impactLevel: 'LOW' | 'MODERATE' | 'HIGH' =
    totalEligible === 0 ? 'LOW' :
    impacted / totalEligible > 0.50 ? 'HIGH' :
    impacted / totalEligible > 0.15 ? 'MODERATE' : 'LOW'

  return {
    totalPenalty,
    eligibleBuildingAreaSqFt: buildingArea,
    eligiblePavementAreaSqFt: pavementArea,
    openLandAreaSqFt: Math.max(0, featureAreaSqFt(footprint) - buildingArea - pavementArea),
    impactLevel,
    preservedOverlap: preservedBuildingOverlap || preservedPavementOverlap,
  }
}

function safeUnionFeatures(features: GeoJSON.Feature[]): GeoJSON.Feature | null {
  if (features.length === 0) return null
  if (features.length === 1) return features[0]
  return safeTurfOp(() => {
    const fc = turf.featureCollection(features) as any
    return turf.union(fc) as GeoJSON.Feature | null
  }, null)
}

function collectConceptFootprint(result: AuthoritativeConceptResult): GeoJSON.Feature | null {
  const features: GeoJSON.Feature[] = []

  const layout = result.selectedFinalLayout
  if (layout) {
    if (layout.lotCells?.length) features.push(...layout.lotCells.map((l: any) => l.geometry ? { ...l.geometry } : l).filter(Boolean))
    if (layout.buildingEnvelopes?.length) features.push(...layout.buildingEnvelopes.map((b: any) => b.geometry ? { ...b.geometry } : b).filter(Boolean))
  }

  const townhomes = result.townhomeGenerationResult
  if (townhomes?.unitEnvelopes?.length) {
    features.push(...townhomes.unitEnvelopes.map((u: any) => u.geometry ? { ...u.geometry } : u).filter(Boolean))
  }

  if (result.primaryRoadResult?.proposedRoadCenterline?.geometry) {
    const buffered = safeTurfOp(
      () => (turf.buffer as any)(result.primaryRoadResult!.proposedRoadCenterline as any, 6, { units: 'meters' }) as GeoJSON.Feature | null,
      null
    )
    if (buffered) features.push(buffered)
  }

  if (result.secondaryRoadNetworkResult?.roads?.length) {
    for (const r of result.secondaryRoadNetworkResult.roads) {
      if (r) {
        const buffered = safeTurfOp(() => (turf.buffer as any)(r as any, 4, { units: 'meters' }) as GeoJSON.Feature | null, null)
        if (buffered) features.push(buffered)
      }
    }
  }

  if (result.localStreetNetworkResult?.localStreets?.length) {
    for (const s of result.localStreetNetworkResult.localStreets) {
      if (s) {
        const buffered = safeTurfOp(() => (turf.buffer as any)(s as any, 3, { units: 'meters' }) as GeoJSON.Feature | null, null)
        if (buffered) features.push(buffered)
      }
    }
  }

  return safeUnionFeatures(features)
}

export function computeRedevelopmentImpactMetrics(
  result: AuthoritativeConceptResult,
  ctx: RedevelopmentOpportunityContext | null
): RedevelopmentImpactMetrics {
  const defaultMetrics: RedevelopmentImpactMetrics = {
    eligibleBuildingAreaImpactedSqFt: 0,
    eligiblePavementAreaImpactedSqFt: 0,
    redevelopmentImpactLevel: 'LOW',
    estimatedBuildingFootprintImpacted: false,
    estimatedPavementFootprintImpacted: false,
  }

  if (!ctx || !ctx.isRedevelopment || ctx.developmentApproach === 'NEW_DEVELOPMENT') {
    return defaultMetrics
  }

  const footprint = collectConceptFootprint(result)
  const buildingArea = featureAreaSqFt(safeIntersect(ctx.eligibleBuildingGeometry, footprint))
  const pavementArea = featureAreaSqFt(safeIntersect(ctx.eligiblePavementGeometry, footprint))

  const totalEligible = ctx.totalEligibleBuildingAreaSqFt + ctx.totalEligiblePavementAreaSqFt
  const impacted = buildingArea + pavementArea
  const impactLevel: 'LOW' | 'MODERATE' | 'HIGH' =
    totalEligible === 0 ? 'LOW' :
    impacted / totalEligible > 0.50 ? 'HIGH' :
    impacted / totalEligible > 0.15 ? 'MODERATE' : 'LOW'

  return {
    eligibleBuildingAreaImpactedSqFt: buildingArea,
    eligiblePavementAreaImpactedSqFt: pavementArea,
    redevelopmentImpactLevel: impactLevel,
    estimatedBuildingFootprintImpacted: buildingArea > 0,
    estimatedPavementFootprintImpacted: pavementArea > 0,
  }
}
