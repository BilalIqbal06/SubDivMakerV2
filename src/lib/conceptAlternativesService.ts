import { getSimplifiedFromProjectParameters, applySimplifiedToProjectParameters } from '../services/recommendedParametersService'
import type { ProjectParameters } from '../types/parameters'
import type { ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, CandidateOpenAreaResult } from '../types/parameters'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import { yieldToMainThread } from '../lib/cooperativeScheduler'
import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import type { TerrainData } from '../types/terrain'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'
import type {
  ConceptStrategy,
  ConceptAlternativeMetrics,
  ConceptAlternativeMetricSources,
  ConceptAlternativeMetricSource,
  ConceptAlternativeResult,
  ConceptAlternativeEvaluation,
  ConceptAlternativesAudit,
  ConceptAlternativeAuditItem
} from '../types/conceptAlternatives'

const SQFT_PER_ACRE = 43560

type StrategyLabel = { label: string; shortLabel: string; baseExplanation: string }

const STRATEGY_INFO: Record<ConceptStrategy, StrategyLabel> = {
  'MAX_YIELD': {
    label: 'MAX YIELD',
    shortLabel: 'Max Yield',
    baseExplanation: 'Prioritizes conceptual unit yield and serviced land while remaining inside mapped hard constraints.'
  },
  'BALANCED': {
    label: 'BALANCED',
    shortLabel: 'Balanced',
    baseExplanation: 'Balances conceptual yield, road efficiency, and mapped site constraints.'
  },
  'CONSTRAINT_CONSERVATIVE': {
    label: 'CONSTRAINT CONSERVATIVE',
    shortLabel: 'Constraint Conservative',
    baseExplanation: 'Reduces infrastructure intensity and preserves more residual opportunity where practical.'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function nextIntensity(i: 'LOW' | 'MEDIUM' | 'HIGH'): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (i === 'LOW') return 'MEDIUM'
  if (i === 'MEDIUM') return 'HIGH'
  return 'HIGH'
}

function prevIntensity(i: 'LOW' | 'MEDIUM' | 'HIGH'): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (i === 'HIGH') return 'MEDIUM'
  if (i === 'MEDIUM') return 'LOW'
  return 'LOW'
}

export function deriveStrategyParameters(
  baseParameters: ProjectParameters,
  strategy: ConceptStrategy,
  _assessment: ParcelFeasibilityAssessment | null
): ProjectParameters {
  const updated = clone(baseParameters)
  const simplified = getSimplifiedFromProjectParameters(updated)

  if (strategy === 'MAX_YIELD') {
    simplified.developmentIntensity = nextIntensity(simplified.developmentIntensity)
  } else if (strategy === 'CONSTRAINT_CONSERVATIVE') {
    simplified.developmentIntensity = prevIntensity(simplified.developmentIntensity)
    simplified.preserveBuildings = true
    simplified.preservePavement = true
    simplified.avoidSteepSlopes = true
    simplified.minimizeStreamCrossings = true
    simplified.prioritizeDirectAccess = true
  }

  let result = applySimplifiedToProjectParameters(simplified, updated)

  // Map each strategy to a concrete existing road network preference
  result.roads.networkPreference =
    strategy === 'MAX_YIELD'
      ? 'connected-grid'
      : strategy === 'CONSTRAINT_CONSERVATIVE'
        ? 'loop-culdesacs'
        : 'modified-grid'

  // Adjust generation priorities deterministically without inventing new fields
  if (strategy === 'MAX_YIELD') {
    result.priorities.maxUnitYield = 'high'
    result.priorities.maxOpenSpace = 'low'
    result.priorities.minRoadLength = 'low'
    result.priorities.lowestConstructionImpact = 'low'
    result.priorities.preserveExistingDevelopment = 'low'
  } else if (strategy === 'CONSTRAINT_CONSERVATIVE') {
    result.priorities.maxUnitYield = 'low'
    result.priorities.maxOpenSpace = 'high'
    result.priorities.minRoadLength = 'high'
    result.priorities.lowestConstructionImpact = 'high'
    result.priorities.preserveExistingDevelopment = 'high'
  }

  // For conservative, also strengthen hard-preservation toggles where supported
  if (strategy === 'CONSTRAINT_CONSERVATIVE') {
    result.existingFeatures.buildingTreatment = result.existingFeatures.buildingTreatment === 'preserve-all' ? 'preserve-all' : 'preserve-all'
    result.existingFeatures.roadTreatment = result.existingFeatures.roadTreatment === 'preserve-all' ? 'preserve-all' : 'preserve-all'
    result.existingFeatures.preserveParking = true
    result.terrainConstraints.avoidSteepSlopes = true
    result.terrainConstraints.avoidStreams = true
    result.terrainConstraints.avoidWetlands = true
  }

  return result
}

function computeConstraintImpact(primary: ConceptualRoadSkeletonResult | null, _metrics?: Partial<ConceptAlternativeMetrics>): 'LOW' | 'MODERATE' | 'HIGH' {
  if (!primary || primary.status === 'failed') return 'HIGH'

  const conflicts =
    (primary.buildingIntersectionCount ?? 0) +
    (primary.rightOfWayBuildingIntersectionCount ?? 0) +
    (primary.waterIntersectionCount ?? 0) +
    (primary.rightOfWayWaterIntersectionCount ?? 0) +
    (primary.pavementIntersectionCount ?? 0) +
    (primary.rightOfWayPavementIntersectionCount ?? 0)

  if (conflicts > 0) return 'HIGH'

  const terrain = primary.terrainProfile?.terrainAssessment
  if (terrain === 'CHALLENGING') return 'HIGH'

  const adequacy = primary.primarySpineAdequacy?.status
  if (adequacy === 'INVALID' || adequacy === 'ACCESS_STUB') return 'HIGH'
  if (adequacy === 'LIMITED_PRIMARY_SPINE') return 'MODERATE'

  if (terrain === 'MODERATE') return 'MODERATE'

  return 'LOW'
}

function computeFeasibilityStatus(primary: ConceptualRoadSkeletonResult | null, impact: 'LOW' | 'MODERATE' | 'HIGH'): 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' {
  if (!primary || primary.status === 'failed') return 'CHALLENGING'

  const conflicts =
    (primary.buildingIntersectionCount ?? 0) +
    (primary.rightOfWayBuildingIntersectionCount ?? 0) +
    (primary.waterIntersectionCount ?? 0) +
    (primary.rightOfWayWaterIntersectionCount ?? 0) +
    (primary.pavementIntersectionCount ?? 0) +
    (primary.rightOfWayPavementIntersectionCount ?? 0)

  if (conflicts > 0 || impact === 'HIGH') return 'CHALLENGING'

  const terrain = primary.terrainProfile?.terrainAssessment
  const adequacy = primary.primarySpineAdequacy?.status
  const isFavorable = terrain === 'FAVORABLE' && adequacy === 'MEANINGFUL_PRIMARY_SPINE'
  if (isFavorable) return 'FAVORABLE'

  if (terrain === 'MODERATE' || adequacy === 'LIMITED_PRIMARY_SPINE') return 'MODERATE'

  return 'CHALLENGING'
}

function buildExplanation(strategy: ConceptStrategy, assessment: ParcelFeasibilityAssessment | null, _metrics: ConceptAlternativeMetrics): string {
  const info = STRATEGY_INFO[strategy]
  const reasons: string[] = []

  if (assessment) {
    if (assessment.dominantConstraint) {
      reasons.push(`the dominant mapped constraint is ${assessment.dominantConstraint}`)
    } else if (assessment.overallRating === 'CHALLENGING') {
      reasons.push('mapped constraints suggest a conservative starting point')
    } else if (assessment.overallRating === 'FAVORABLE') {
      reasons.push('the parcel appears relatively open')
    } else if (assessment.overallRating === 'MODERATE') {
      reasons.push('moderate existing constraints are present')
    }

    if (assessment.terrainStatus === 'CHALLENGING') {
      reasons.push('challenging terrain is present')
    } else if (assessment.hydrologyStatus === 'SIGNIFICANT' || assessment.hydrologyStatus === 'PRESENT') {
      reasons.push('significant hydrology/wetlands are mapped')
    } else if (assessment.buildingStatus === 'SIGNIFICANT' || assessment.buildingStatus === 'PRESENT') {
      reasons.push('existing buildings are present')
    } else if (assessment.pavementStatus === 'SIGNIFICANT' || assessment.pavementStatus === 'PRESENT') {
      reasons.push('existing pavement is present')
    } else if (assessment.accessStatus === 'LIMITED' || assessment.accessStatus === 'CONSTRAINED') {
      reasons.push('access is constrained')
    }
  }

  const siteReason = reasons.length ? ` ${reasons[0].charAt(0).toUpperCase() + reasons[0].slice(1)}.` : ''
  return `${info.baseExplanation}${siteReason}`
}


function buildMetricSources(isAuthoritative: boolean, primary: ConceptualRoadSkeletonResult | null, secondary: SecondaryRoadNetworkResult | null, localStreet: LocalStreetNetworkResult | null): ConceptAlternativeMetricSources {
  const primarySource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : primary ? 'ESTIMATE' : 'UNAVAILABLE'
  const secondarySource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : secondary ? 'ESTIMATE' : 'UNAVAILABLE'
  const localSource: ConceptAlternativeMetricSource = localStreet ? 'AUTHORITATIVE' : 'UNAVAILABLE'
  const roadTotalSource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : (primary && secondary) ? 'ESTIMATE' : 'UNAVAILABLE'
  const servedSource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : secondary ? 'ESTIMATE' : 'UNAVAILABLE'
  const unitsSource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : (secondary ? 'ESTIMATE' : 'UNAVAILABLE')
  const remainingSource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : (secondary ? 'ESTIMATE' : 'UNAVAILABLE')
  const constraintSource: ConceptAlternativeMetricSource = isAuthoritative ? 'AUTHORITATIVE' : primary ? 'ESTIMATE' : 'UNAVAILABLE'

  return {
    conceptualUnits: unitsSource,
    networkServedAcres: servedSource,
    remainingOpportunityAcres: remainingSource,
    primaryRoadLengthFt: primarySource,
    secondaryRoadLengthFt: secondarySource,
    localStreetLengthFt: localSource,
    totalRoadLengthFt: roadTotalSource,
    constraintImpact: constraintSource,
    feasibilityStatus: constraintSource
  }
}

function shiftConstraintImpact(
  base: 'LOW' | 'MODERATE' | 'HIGH',
  strategy: ConceptStrategy
): 'LOW' | 'MODERATE' | 'HIGH' {
  if (strategy === 'MAX_YIELD') {
    if (base === 'LOW') return 'MODERATE'
    return 'HIGH'
  }
  if (base === 'HIGH') return 'MODERATE'
  return 'LOW'
}

function shiftFeasibilityStatus(
  base: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING',
  strategy: ConceptStrategy
): 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' {
  if (strategy === 'MAX_YIELD') {
    if (base === 'FAVORABLE') return 'MODERATE'
    return 'CHALLENGING'
  }
  if (base === 'CHALLENGING') return 'MODERATE'
  return 'FAVORABLE'
}

function buildLightweightMetrics(
  strategy: ConceptStrategy,
  params: ProjectParameters,
  baseMetrics: ConceptAlternativeMetrics,
  evaluationMs: number,
  candidateAreaAcres: number
): ConceptAlternativeMetrics {
  const isMax = strategy === 'MAX_YIELD'
  const servedFactor = isMax ? 1.08 : 0.85
  const roadFactor = isMax ? 1.05 : 0.92
  const remainingFactor = isMax ? 0.85 : 1.15

  const baseServed = baseMetrics.networkServedAcres ?? 0
  const baseTotalRoad = baseMetrics.totalRoadLengthFt ?? 0
  const basePrimary = baseMetrics.primaryRoadLengthFt ?? 0
  const baseSecondary = baseMetrics.secondaryRoadLengthFt ?? 0

  const networkServedAcres = baseServed > 0 ? Math.min(baseServed * servedFactor, candidateAreaAcres) : 0
  const remainingOpportunityAcres = Math.max(0, (baseMetrics.remainingOpportunityAcres ?? 0) * remainingFactor)
  const totalRoadLength = baseTotalRoad > 0 ? baseTotalRoad * roadFactor : 0
  const primaryRoadLengthFt = baseTotalRoad > 0 ? totalRoadLength * (basePrimary / baseTotalRoad) : null
  const secondaryRoadLengthFt = baseTotalRoad > 0 ? totalRoadLength * (baseSecondary / baseTotalRoad) : null

  const targetDensity = params.zoningAndLots.targetDensity ?? 6
  const conceptualUnits = networkServedAcres > 0 ? Math.round(networkServedAcres * targetDensity) : null

  const constraintImpact = shiftConstraintImpact(baseMetrics.constraintImpact, strategy)
  const feasibilityStatus = shiftFeasibilityStatus(baseMetrics.feasibilityStatus, strategy)

  const estimateSource: ConceptAlternativeMetricSource = 'ESTIMATE'
  const unavailableSource: ConceptAlternativeMetricSource = 'UNAVAILABLE'

  return {
    conceptualUnits,
    networkServedAcres,
    remainingOpportunityAcres,
    primaryRoadLengthFt,
    secondaryRoadLengthFt,
    localStreetLengthFt: null,
    totalRoadLengthFt: totalRoadLength || null,
    constraintImpact,
    feasibilityStatus,
    evaluationMs,
    isAuthoritative: false,
    metricSources: {
      conceptualUnits: conceptualUnits != null ? estimateSource : unavailableSource,
      networkServedAcres: networkServedAcres != null ? estimateSource : unavailableSource,
      remainingOpportunityAcres: remainingOpportunityAcres != null ? estimateSource : unavailableSource,
      primaryRoadLengthFt: primaryRoadLengthFt != null ? estimateSource : unavailableSource,
      secondaryRoadLengthFt: secondaryRoadLengthFt != null ? estimateSource : unavailableSource,
      localStreetLengthFt: unavailableSource,
      totalRoadLengthFt: totalRoadLength > 0 ? estimateSource : unavailableSource,
      constraintImpact: estimateSource,
      feasibilityStatus: estimateSource
    }
  }
}


export interface ConceptAlternativeSharedContext {
  mcpi: string
  workflowRunId: number
  analysisRunId: number
  parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  candidateOpenArea: CandidateOpenAreaResult
  candidateOpenAreaGeometry: GeoJSON.Feature<GeoJSON.Geometry>
  buildingUnionGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  hydrologyObstaclesGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  existingPavementGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  streetFeatures: any[]
  terrainData: TerrainData | null
  submittedParameters: ProjectParameters
  parameterStableKey: string
  parcelFeasibilityAssessment: ParcelFeasibilityAssessment | null
  parentParcelAreaAcres: number | null
  signal?: AbortSignal
  nextGenerationRunId: () => number
}


export function buildAuthoritativeAlternative(
  id: ConceptStrategy,
  params: ProjectParameters,
  primary: ConceptualRoadSkeletonResult | null,
  secondary: SecondaryRoadNetworkResult | null,
  conceptualProgram: ConceptualDevelopmentProgramResult | null,
  developmentLayout: ConceptualDevelopmentLayoutResult | null,
  localStreet: LocalStreetNetworkResult | null,
  assessment: ParcelFeasibilityAssessment | null,
  evaluationMs: number
): ConceptAlternativeResult {
  const strategy = id
  const targetDensity = params.zoningAndLots.targetDensity ?? 6
  const networkServedAcres = conceptualProgram?.actualTotalNetworkServedAreaAcres ?? (secondary ? secondary.totalNetworkServedAreaSqFt / SQFT_PER_ACRE : null)
  const remainingOpportunity = conceptualProgram?.residualAreaAcres ?? null
  const primaryRoadLength = primary?.proposedRoadLengthFeet ?? null
  const secondaryRoadLength = secondary?.totalSecondaryRoadLengthFt ?? null
  const localStreetLength = localStreet?.totalLocalStreetLengthFt ?? null
  const totalRoadLength = (primaryRoadLength ?? 0) + (secondaryRoadLength ?? 0) + (localStreetLength ?? 0)

  // Comparison-card units use the same density x served-area formula so all
  // three strategies are scored on the same semantic definition. The actual
  // townhome unit count from the full layout is shown in the Development Yield
  // section, not in this comparison metric.
  const conceptualUnits = (networkServedAcres != null && networkServedAcres > 0)
    ? Math.round(networkServedAcres * targetDensity)
    : null

  const constraintImpact = computeConstraintImpact(primary)
  const feasibilityStatus = computeFeasibilityStatus(primary, constraintImpact)

  const metrics: ConceptAlternativeMetrics = {
    conceptualUnits,
    networkServedAcres,
    remainingOpportunityAcres: remainingOpportunity,
    primaryRoadLengthFt: primaryRoadLength,
    secondaryRoadLengthFt: secondaryRoadLength,
    localStreetLengthFt: localStreetLength,
    totalRoadLengthFt: totalRoadLength || null,
    constraintImpact,
    feasibilityStatus,
    evaluationMs,
    isAuthoritative: true,
    metricSources: buildMetricSources(true, primary, secondary, localStreet)
  }

  return {
    id,
    strategy,
    label: STRATEGY_INFO[strategy].label,
    shortLabel: STRATEGY_INFO[strategy].shortLabel,
    status: 'authoritative',
    parametersUsed: structuredClone(params),
    primaryRoadResult: primary,
    secondaryRoadResult: secondary,
    conceptualProgram,
    developmentLayout,
    localStreetResult: localStreet,
    metrics,
    recommendationReason: buildExplanation(strategy, assessment, metrics),
    comparisonScore: 0,
    recommended: false,
    selected: false
  }
}

export interface ConceptAlternativeStateIds {
  selectedAlternativeId: ConceptStrategy | null
  authoritativeAlternativeId: ConceptStrategy | null
  generatingAlternativeId: ConceptStrategy | null
}

export async function evaluateConceptAlternatives(
  shared: ConceptAlternativeSharedContext,
  stateIds: ConceptAlternativeStateIds,
  balancedAlternative?: ConceptAlternativeResult | null
): Promise<ConceptAlternativeEvaluation> {
  const t0 = performance.now()

  const alternatives: ConceptAlternativeResult[] = []
  const balanced: ConceptAlternativeResult = balancedAlternative ?? buildAuthoritativeAlternative(
    'BALANCED',
    shared.submittedParameters,
    null,
    null,
    null,
    null,
    null,
    shared.parcelFeasibilityAssessment,
    0
  )
  if (!balancedAlternative) {
    balanced.recommendationReason = buildExplanation('BALANCED', shared.parcelFeasibilityAssessment, balanced.metrics)
  }

  const strategies: ConceptStrategy[] = ['MAX_YIELD', 'CONSTRAINT_CONSERVATIVE']

  for (const strategy of strategies) {
    await yieldToMainThread()
    const strategyParams = deriveStrategyParameters(shared.submittedParameters, strategy, shared.parcelFeasibilityAssessment)
    const tStart = performance.now()

    // Initial concept comparison estimates are derived from the authoritative
    // BALANCED metrics and the strategy-specific parameter fingerprint. No road,
    // local street, or townhome generators run for the cards at this stage.
    const metrics = buildLightweightMetrics(strategy, strategyParams, balanced.metrics, performance.now() - tStart, shared.candidateOpenArea.candidateAreaAcres)

    const alt: ConceptAlternativeResult = {
      id: strategy,
      strategy,
      label: STRATEGY_INFO[strategy].label,
      shortLabel: STRATEGY_INFO[strategy].shortLabel,
      status: 'evaluated',
      parametersUsed: strategyParams,
      primaryRoadResult: null,
      secondaryRoadResult: null,
      conceptualProgram: null,
      developmentLayout: null,
      localStreetResult: null,
      metrics,
      recommendationReason: buildExplanation(strategy, shared.parcelFeasibilityAssessment, metrics),
      comparisonScore: 0,
      recommended: false,
      selected: false,
      errorMessage: null
    }

    alternatives.push(alt)
  }

  // Add BALANCED at the front for UI ordering
  alternatives.unshift(balanced)

  const scored = alternatives.map(a => ({ ...a, comparisonScore: scoreAlternative(a, shared.candidateOpenArea.candidateAreaAcres) }))
  const recommendedId = recommendAlternativeId(scored, shared.parcelFeasibilityAssessment)

  const final = scored.map(a => ({
    ...a,
    recommended: a.id === recommendedId
  }))

  const totalEvaluationMs = performance.now() - t0

  const audit: ConceptAlternativesAudit = {
    mcpi: shared.mcpi,
    workflowRunId: shared.workflowRunId,
    alternatives: final.map(toAuditItem),
    recommendedAlternativeId: recommendedId,
    selectedAlternativeId: stateIds.selectedAlternativeId,
    authoritativeAlternativeId: stateIds.authoritativeAlternativeId,
    generatingAlternativeId: stateIds.generatingAlternativeId,
    sharedContextBuildMs: 0,
    totalAlternativeEvaluationMs: totalEvaluationMs,
    cacheHits: 0,
    cacheMisses: 0,
    singleConceptBaselineMs: balanced.metrics.evaluationMs || null,
    alternativeEvaluationOverheadMs: totalEvaluationMs - (balanced.metrics.evaluationMs || 0)
  }

  if (import.meta.env.DEV) {
    console.log('[ConceptAlternativesAudit]', audit)
  }

  return {
    alternatives: final,
    recommendedAlternativeId: recommendedId
  }
}

function normalizeScore(value: number, min: number, max: number): number {
  if (max <= min) return value >= max ? 1 : 0
  return Math.max(0, Math.min(1, (value - min) / (max - min)))
}

export function scoreAlternative(alt: ConceptAlternativeResult, candidateAreaAcres: number): number {
  const m = alt.metrics
  const maxYieldW = { yield: 0.45, servedArea: 0.25, roadEfficiency: 0.15, constraint: 0.05, remaining: 0.05, feasibility: 0.05 }
  const balancedW = { yield: 0.2, servedArea: 0.2, roadEfficiency: 0.25, constraint: 0.2, remaining: 0.1, feasibility: 0.05 }
  const conservativeW = { yield: 0.05, servedArea: 0.15, roadEfficiency: 0.25, constraint: 0.35, remaining: 0.15, feasibility: 0.05 }

  const w = alt.strategy === 'MAX_YIELD' ? maxYieldW : alt.strategy === 'CONSTRAINT_CONSERVATIVE' ? conservativeW : balancedW

  const units = m.conceptualUnits ?? 0
  const served = m.networkServedAcres ?? 0
  const roadFt = m.totalRoadLengthFt ?? 0
  const remaining = m.remainingOpportunityAcres ?? 0
  const impact = m.constraintImpact === 'LOW' ? 1 : m.constraintImpact === 'MODERATE' ? 0.6 : 0.2
  const feasibility = m.feasibilityStatus === 'FAVORABLE' ? 1 : m.feasibilityStatus === 'MODERATE' ? 0.7 : 0.3

  const yieldScore = normalizeScore(units, 0, 250)
  const servedAreaScore = candidateAreaAcres > 0 ? normalizeScore(served, 0, candidateAreaAcres) : 0
  const roadEfficiencyScore = roadFt > 0 ? normalizeScore(served, 0, (roadFt / 1000) * 5) : 0
  const remainingScore = candidateAreaAcres > 0 ? normalizeScore(remaining, 0, candidateAreaAcres) : 0

  return (
    yieldScore * w.yield +
    servedAreaScore * w.servedArea +
    roadEfficiencyScore * w.roadEfficiency +
    impact * w.constraint +
    remainingScore * w.remaining +
    feasibility * w.feasibility
  )
}

function getSiteConditionBonuses(assessment: ParcelFeasibilityAssessment | null): Record<ConceptStrategy, number> {
  const bonuses: Record<ConceptStrategy, number> = {
    'MAX_YIELD': 0,
    'BALANCED': 0,
    'CONSTRAINT_CONSERVATIVE': 0
  }
  if (assessment?.overallRating === 'CHALLENGING') {
    bonuses['CONSTRAINT_CONSERVATIVE'] += 0.08
  } else if (assessment?.overallRating === 'FAVORABLE') {
    bonuses['MAX_YIELD'] += 0.08
  }
  return bonuses
}

export function getRecommendationScore(
  alternative: ConceptAlternativeResult,
  assessment: ParcelFeasibilityAssessment | null
): number {
  const bonuses = getSiteConditionBonuses(assessment)
  return alternative.comparisonScore + bonuses[alternative.id]
}

export function recommendAlternativeId(
  alternatives: ConceptAlternativeResult[],
  assessment: ParcelFeasibilityAssessment | null
): ConceptStrategy {
  const ranked = alternatives.map(a => ({
    id: a.id,
    score: getRecommendationScore(a, assessment)
  })).sort((a, b) => b.score - a.score)

  const top = ranked[0]
  const tied = ranked.filter(r => Math.abs(r.score - (top?.score ?? 0)) < 0.0001)
  if (tied.some(t => t.id === 'BALANCED')) return 'BALANCED'
  return (top?.id ?? 'BALANCED')
}

function toAuditItem(alt: ConceptAlternativeResult): ConceptAlternativeAuditItem {
  const m = alt.metrics
  const s = m.metricSources
  const overallMetricSource: ConceptAlternativeMetricSource = m.isAuthoritative ? 'AUTHORITATIVE' : 'ESTIMATE'
  return {
    id: alt.id,
    strategy: alt.strategy,
    metricSource: overallMetricSource,
    evaluationMs: m.evaluationMs,
    authoritativeGeometryGenerated: alt.status === 'authoritative',
    feasibilityStatus: m.feasibilityStatus,
    conceptualUnits: m.conceptualUnits,
    conceptualUnitsSource: s.conceptualUnits,
    networkServedAcres: m.networkServedAcres,
    networkServedAcresSource: s.networkServedAcres,
    remainingOpportunityAcres: m.remainingOpportunityAcres,
    remainingOpportunityAcresSource: s.remainingOpportunityAcres,
    primaryRoadLengthFt: m.primaryRoadLengthFt,
    primaryRoadLengthFtSource: s.primaryRoadLengthFt,
    secondaryRoadLengthFt: m.secondaryRoadLengthFt,
    secondaryRoadLengthFtSource: s.secondaryRoadLengthFt,
    localStreetLengthFt: m.localStreetLengthFt,
    localStreetLengthFtSource: s.localStreetLengthFt,
    totalRoadLengthFt: m.totalRoadLengthFt,
    totalRoadLengthFtSource: s.totalRoadLengthFt,
    constraintImpact: m.constraintImpact,
    constraintImpactSource: s.constraintImpact,
    comparisonScore: alt.comparisonScore
  }
}
