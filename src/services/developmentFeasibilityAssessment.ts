// Development Feasibility Assessment — diagnostic only
// Three independent assessments (land, access, road) combined into a
// qualitative development feasibility matrix.  No production logic.

import type { ComponentDevelopmentOpportunity } from './componentDevelopmentOpportunityAudit'
import type { ConceptualAccessSuitability } from './conceptualAccessSuitability'

const ACRES_TO_SQ_FT = 43560

function bumpDown(category: LandOpportunityAssessment['category']): LandOpportunityAssessment['category'] {
  const order: LandOpportunityAssessment['category'][] = ['VERY HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY LOW']
  const i = order.indexOf(category)
  if (i === -1 || i === order.length - 1) return category
  return order[i + 1]
}

export interface LandOpportunityAssessment {
  category: 'VERY HIGH' | 'HIGH' | 'MODERATE' | 'LOW' | 'VERY LOW'
  reasons: string[]
}

export interface AccessFeasibilityAssessment {
  category: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE' | 'UNKNOWN'
  bestStreet: string | null
  bestSuitability: ConceptualAccessSuitability | null
  candidateCount: number
  shortestAccessDistanceFt: number | null
  reachedRoutingStage: boolean
  reachedLocalTargetStage: boolean
  anyLocalTarget: boolean
  validRouteExists: boolean
  reasons: string[]
}

export interface PrimaryRoadQualityAssessment {
  category: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE'
  validRouteCount: number
  bestRoadLengthFt: number | null
  bestRouteEfficiency: number | null
  bestBendCount: number | null
  bestMaxDeflection: number | null
  buildingConflicts: number | null
  hydrologyConflicts: number | null
  pavementConflicts: number | null
  bestServedAreaSqFt: number | null
  bestComponentServiceRatio: number | null
  bestPrimarySpineAdequacy: string | null
  bestPrimarySpineAdequacyReasons: string[]
  reasons: string[]
}

export interface DevelopmentFeasibility {
  componentIndex: number
  freeAcres: number
  largestPartAcres: number
  largestPartToTotalRatio: number
  buffer75Percent: number | null
  landOpportunity: LandOpportunityAssessment
  accessFeasibility: AccessFeasibilityAssessment
  primaryRoadQuality: PrimaryRoadQualityAssessment
  overallStatus: 'PROMISING' | 'POTENTIAL' | 'CONSTRAINED' | 'CURRENTLY_UNSUPPORTED'
  latentLandOpportunity: boolean
  bestAccessStreet: string | null
  bestAccessSuitability: ConceptualAccessSuitability | null
  validRouteCount: number
  bestServedAreaSqFt: number | null
  primarySpineAdequacy: string | null
  primarySpineAdequacyReasons: string[]
  majorStrengths: string[]
  majorConstraints: string[]
}

export interface DevelopmentFeasibilityAudit {
  mcpi: string
  componentCount: number
  rankedFeasibleComponents: DevelopmentFeasibility[]
  latentLandOpportunities: DevelopmentFeasibility[]
  constrainedComponents: DevelopmentFeasibility[]
  unsupportedComponents: DevelopmentFeasibility[]
  components: DevelopmentFeasibility[]
}

function orderRank(v: string, order: string[]): number { return order.indexOf(v) }

function landCategoryWeight(v: LandOpportunityAssessment['category']): number {
  return orderRank(v, ['VERY LOW', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'])
}

function accessCategoryWeight(v: AccessFeasibilityAssessment['category']): number {
  return orderRank(v, ['NONE', 'UNKNOWN', 'WEAK', 'MODERATE', 'STRONG'])
}

function roadCategoryWeight(v: PrimaryRoadQualityAssessment['category']): number {
  return orderRank(v, ['NONE', 'WEAK', 'MODERATE', 'STRONG'])
}

function statusRank(v: DevelopmentFeasibility['overallStatus']): number {
  return orderRank(v, ['CURRENTLY_UNSUPPORTED', 'CONSTRAINED', 'POTENTIAL', 'PROMISING'])
}

function assessLandOpportunity(c: ComponentDevelopmentOpportunity): LandOpportunityAssessment {
  const reasons: string[] = []
  const acres = c.freeSpaceAreaAcres
  const largestPartAcres = c.largestFreeSpacePartSqFt / ACRES_TO_SQ_FT
  const buffer75Percent = c.buffer75.percent

  let category: LandOpportunityAssessment['category']
  if (acres < 0.5 || c.shapeCategory === 'sliver') {
    category = 'VERY LOW'
  } else if (acres < 1.5 || c.shapeCategory.includes('fragmented remainder')) {
    category = 'LOW'
  } else if (acres < 4.0) {
    category = 'MODERATE'
  } else if (acres < 10.0) {
    category = 'HIGH'
  } else {
    category = 'VERY HIGH'
  }

  if (c.narrowNeckDetected) {
    category = bumpDown(category)
    reasons.push('narrow neck or small perpendicular span')
  }
  if (c.largestPartToTotalRatio < 0.5) {
    category = bumpDown(category)
    reasons.push(`largest contiguous part is only ${(c.largestPartToTotalRatio * 100).toFixed(0)}% of total free space`)
  }
  if (buffer75Percent !== null && buffer75Percent < 20) {
    category = bumpDown(category)
    reasons.push(`75-ft inward buffer survival only ${buffer75Percent.toFixed(1)}%`)
  }

  reasons.push(`${acres.toFixed(2)} free acres, ${largestPartAcres.toFixed(2)}-acre largest contiguous part, shape ${c.shapeCategory}`)
  if (category !== 'VERY LOW' && category !== 'LOW' && c.compactness > 0.3) {
    reasons.push(`compactness ${c.compactness.toFixed(2)}`)
  }

  return { category, reasons }
}

function assessAccessFeasibility(
  c: ComponentDevelopmentOpportunity,
  compCandidates: any[]
): AccessFeasibilityAssessment {
  const reasons: string[] = []
  const candidateCount = c.accessCandidateCount
  const bestStreet = c.bestAccessStreet
  const bestSuitability = c.bestConceptualAccessSuitability
  const shortest = c.minCandidateAccessDistanceFt
  const validRouteExists = c.routedCandidateCount > 0

  const reachedRoutingStage = compCandidates.some((cd) => cd.trace?.shortlisted && (cd.trace?.localTargetsGenerated || cd.trace?.routingAttempts > 0))
  const reachedLocalTargetStage = compCandidates.some((cd) => cd.trace?.localTargetCount > 0)
  const anyLocalTarget = compCandidates.some((cd) => cd.trace?.localTargetCount && cd.trace.localTargetCount > 0)

  let category: AccessFeasibilityAssessment['category']
  if (candidateCount === 0) {
    category = 'NONE'
    reasons.push('no existing-road connection candidates')
  } else if (validRouteExists) {
    if (bestSuitability === 'excluded' || bestSuitability === 'discouraged') {
      category = 'MODERATE'
      reasons.push(`valid route exists but best conceptual access is ${bestSuitability}`)
    } else if (shortest !== null && shortest < 100) {
      category = 'STRONG'
      reasons.push(`valid route exists, access distance ${shortest.toFixed(0)} ft, ${bestSuitability || 'unknown'} access`)
    } else {
      category = 'MODERATE'
      reasons.push(`valid route exists, access distance ${(shortest ?? 0).toFixed(0)} ft`)
    }
  } else if (reachedLocalTargetStage && anyLocalTarget) {
    if (bestSuitability === 'excluded' || bestSuitability === 'discouraged') {
      category = 'WEAK'
      reasons.push(`candidates reach local targets but conceptual access is ${bestSuitability}`)
    } else if (shortest !== null && shortest < 300) {
      category = 'MODERATE'
      reasons.push(`candidates reach local targets, access distance ${shortest.toFixed(0)} ft`)
    } else {
      category = 'WEAK'
      reasons.push(`candidates reach local targets but access distance is ${(shortest ?? 0).toFixed(0)} ft`)
    }
  } else if (reachedRoutingStage) {
    category = 'WEAK'
    reasons.push('candidates are shortlisted but produce no local targets under current target-fan rules')
  } else if (shortest !== null && shortest < 300 && (bestSuitability === 'preferred' || bestSuitability === 'conditional')) {
    category = 'WEAK'
    reasons.push('candidate relationship exists but no valid local target or route under current generator')
  } else {
    category = 'WEAK'
    reasons.push('candidate street relationship exists, but no local target, no route, and/or large street distance')
  }

  if (bestSuitability === 'excluded') {
    reasons.push('best conceptual access is excluded (e.g., limited access road)')
  }

  return {
    category,
    bestStreet,
    bestSuitability,
    candidateCount,
    shortestAccessDistanceFt: shortest,
    reachedRoutingStage,
    reachedLocalTargetStage,
    anyLocalTarget,
    validRouteExists,
    reasons
  }
}

function assessPrimaryRoadQuality(
  compRouted: any[]
): PrimaryRoadQualityAssessment {
  if (compRouted.length === 0) {
    return {
      category: 'NONE',
      validRouteCount: 0,
      bestRoadLengthFt: null,
      bestRouteEfficiency: null,
      bestBendCount: null,
      bestMaxDeflection: null,
      buildingConflicts: null,
      hydrologyConflicts: null,
      pavementConflicts: null,
      bestServedAreaSqFt: null,
      bestComponentServiceRatio: null,
      bestPrimarySpineAdequacy: null,
      bestPrimarySpineAdequacyReasons: [],
      reasons: ['no valid routed primary road']
    }
  }

  const adequacyRank: Record<string, number> = { INVALID: 0, 'ACCESS_STUB': 1, 'LIMITED_PRIMARY_SPINE': 2, 'MEANINGFUL_PRIMARY_SPINE': 3 }
  const best = compRouted.reduce((a: any, b: any) => {
    const aAdeq = adequacyRank[a.result.primarySpineAdequacy?.status ?? 'INVALID'] ?? 0
    const bAdeq = adequacyRank[b.result.primarySpineAdequacy?.status ?? 'INVALID'] ?? 0
    if (aAdeq !== bAdeq) return bAdeq > aAdeq ? b : a
    const aSvc = a.result.servedDevelopableAreaSqFt ?? 0
    const bSvc = b.result.servedDevelopableAreaSqFt ?? 0
    return bSvc > aSvc ? b : a
  })

  const r = best.result
  const m = best.metrics
  const roadLength = r.proposedRoadLengthFeet
  const efficiency = m?.routeEfficiencyRatio ?? 0
  const bends = r.bendCount ?? 0
  const maxDeflection = r.maxDeflectionAngle ?? 0
  const building = (r.buildingIntersectionCount ?? 0) + (r.rightOfWayBuildingIntersectionCount ?? 0)
  const hydrology = (r.waterIntersectionCount ?? 0) + (r.rightOfWayWaterIntersectionCount ?? 0)
  const pavement = (r.pavementIntersectionCount ?? 0) + (r.rightOfWayPavementIntersectionCount ?? 0)
  const served = r.servedDevelopableAreaSqFt ?? 0
  const serviceRatio = r.componentServiceRatio ?? 0
  const adequacy = r.primarySpineAdequacy?.status ?? 'INVALID'
  const adequacyReasons = r.primarySpineAdequacy?.reasons ?? []

  const reasons: string[] = []
  let category: PrimaryRoadQualityAssessment['category']

  if (r.primarySpineAdequacy?.status === 'MEANINGFUL_PRIMARY_SPINE' && building === 0 && hydrology === 0 && pavement === 0) {
    category = 'STRONG'
    reasons.push(`meaningful primary spine: ${roadLength.toFixed(0)} ft, clean, served ${served.toFixed(0)} sq ft`)
  } else if (r.primarySpineAdequacy?.status === 'LIMITED_PRIMARY_SPINE' && building === 0 && hydrology === 0 && pavement === 0) {
    category = 'MODERATE'
    reasons.push(`limited but usable primary spine: ${roadLength.toFixed(0)} ft, served ${served.toFixed(0)} sq ft`)
  } else if (r.primarySpineAdequacy?.status === 'ACCESS_STUB') {
    category = 'WEAK'
    reasons.push(`routed but behaves as an access stub: ${roadLength.toFixed(0)} ft, served ${served.toFixed(0)} sq ft`)
  } else if (served > 10000) {
    category = 'WEAK'
    reasons.push('routed but road length, geometry, or conflict count is suboptimal')
  } else {
    category = 'WEAK'
    reasons.push('routed but serves a small developable area')
  }

  if (building > 0) reasons.push(`${building} building/ROW conflict(s)`)
  if (hydrology > 0) reasons.push(`${hydrology} hydrology conflict(s)`)
  if (pavement > 0) reasons.push(`${pavement} pavement conflict(s)`)
  if (bends > 4) reasons.push(`${bends} bends`)
  if (maxDeflection > 60) reasons.push(`max deflection ${maxDeflection.toFixed(1)}°`)

  return {
    category,
    validRouteCount: compRouted.length,
    bestRoadLengthFt: roadLength,
    bestRouteEfficiency: efficiency,
    bestBendCount: bends,
    bestMaxDeflection: maxDeflection,
    buildingConflicts: building,
    hydrologyConflicts: hydrology,
    pavementConflicts: pavement,
    bestServedAreaSqFt: served,
    bestComponentServiceRatio: serviceRatio,
    bestPrimarySpineAdequacy: adequacy,
    bestPrimarySpineAdequacyReasons: adequacyReasons,
    reasons
  }
}

// Deterministic overall development feasibility status.
// This is intentionally not an average; land, access and road must all support
// a meaningful current development opportunity.
function determineOverallStatus(
  land: LandOpportunityAssessment,
  access: AccessFeasibilityAssessment,
  road: PrimaryRoadQualityAssessment
): DevelopmentFeasibility['overallStatus'] {
  // Tiny or very poor land cannot be a primary development target, even if a road exists.
  if (land.category === 'VERY LOW' || land.category === 'LOW') {
    return road.category !== 'NONE' ? 'CONSTRAINED' : 'CURRENTLY_UNSUPPORTED'
  }

  // No access or no road means the site is not currently reachable.
  if (access.category === 'NONE' || road.category === 'NONE') {
    return 'CURRENTLY_UNSUPPORTED'
  }

  // Strong land + strong access + meaningful or limited primary spine = PROMISING
  if ((land.category === 'VERY HIGH' || land.category === 'HIGH') && access.category === 'STRONG' && (road.category === 'STRONG' || road.category === 'MODERATE')) {
    return 'PROMISING'
  }

  // High or very high land with moderate access and at least moderate road
  if ((land.category === 'VERY HIGH' || land.category === 'HIGH') && access.category === 'MODERATE' && (road.category === 'STRONG' || road.category === 'MODERATE')) {
    return 'PROMISING'
  }

  // Moderate land with moderate/strong access and a valid road
  if (land.category === 'MODERATE' && (access.category === 'MODERATE' || access.category === 'STRONG') && (road.category === 'STRONG' || road.category === 'MODERATE')) {
    return 'POTENTIAL'
  }

  // High land but weak access is latent/constrained, not currently feasible
  if ((land.category === 'VERY HIGH' || land.category === 'HIGH') && access.category === 'WEAK') {
    return 'CURRENTLY_UNSUPPORTED'
  }

  return 'CONSTRAINED'
}

function majorStrengths(
  land: LandOpportunityAssessment,
  access: AccessFeasibilityAssessment,
  road: PrimaryRoadQualityAssessment
): string[] {
  const out: string[] = []
  if (land.category === 'VERY HIGH' || land.category === 'HIGH') out.push(`Land opportunity: ${land.category}`)
  if (access.category === 'STRONG') out.push('Strong conceptual access')
  if (road.category === 'STRONG' || road.category === 'MODERATE') {
    out.push(`Valid primary road: ${road.category}`)
    if (road.bestServedAreaSqFt) out.push(`Serves ${road.bestServedAreaSqFt.toFixed(0)} sq ft`)
  }
  return out
}

function majorConstraints(
  c: ComponentDevelopmentOpportunity,
  land: LandOpportunityAssessment,
  access: AccessFeasibilityAssessment,
  road: PrimaryRoadQualityAssessment
): string[] {
  const out: string[] = []
  if (land.category === 'VERY LOW' || land.category === 'LOW') out.push(`Land opportunity: ${land.category}`)
  if (c.freeSpacePartCount > 2) out.push(`Fragmented into ${c.freeSpacePartCount} free-space parts`)
  if (c.narrowNeckDetected) out.push('Narrow/sliver geometry')
  if (c.buffer75.percent !== null && c.buffer75.percent < 20) out.push(`75-ft buffer survival only ${c.buffer75.percent.toFixed(1)}%`)
  if (access.category === 'NONE') out.push('No conceptual road connection candidates')
  if (access.category === 'WEAK') out.push('Conceptual access exists but is weak under current routing model')
  if (road.category === 'NONE') out.push('No valid routed primary road')
  if (c.primaryConstraint && c.primaryConstraint !== 'relatively open') out.push(`Existing conditions: ${c.primaryConstraint}`)
  return out
}

export function runDevelopmentFeasibilityAudit(options: {
  mcpi: string
  opportunityComponents: ComponentDevelopmentOpportunity[]
  candidates: any[]
  candidateResults: any[]
}): DevelopmentFeasibilityAudit {
  const { mcpi, opportunityComponents, candidates, candidateResults } = options

  const components: DevelopmentFeasibility[] = opportunityComponents
    .filter((c) => c.freeSpaceAreaAcres >= 0.05)
    .map((c) => {
      const compCandidates = candidates.filter((cd) => cd.sourceComponent?.index === c.componentIndex)
      const compRouted = candidateResults.filter((cr) => cr.candidate.sourceComponent?.index === c.componentIndex)

      const land = assessLandOpportunity(c)
      const access = assessAccessFeasibility(c, compCandidates)
      const road = assessPrimaryRoadQuality(compRouted)
      const overall = determineOverallStatus(land, access, road)
      const latent = (land.category === 'VERY HIGH' || land.category === 'HIGH') &&
        (access.category === 'NONE' || access.category === 'WEAK' || road.category === 'NONE')

      return {
        componentIndex: c.componentIndex,
        freeAcres: c.freeSpaceAreaAcres,
        largestPartAcres: c.largestFreeSpacePartSqFt / ACRES_TO_SQ_FT,
        largestPartToTotalRatio: c.largestPartToTotalRatio,
        buffer75Percent: c.buffer75.percent,
        landOpportunity: land,
        accessFeasibility: access,
        primaryRoadQuality: road,
        overallStatus: overall,
        latentLandOpportunity: latent,
        bestAccessStreet: c.bestAccessStreet,
        bestAccessSuitability: c.bestConceptualAccessSuitability,
        validRouteCount: c.routedCandidateCount,
        bestServedAreaSqFt: c.bestServedDevelopableAreaSqFt,
        primarySpineAdequacy: road.bestPrimarySpineAdequacy,
        primarySpineAdequacyReasons: road.bestPrimarySpineAdequacyReasons,
        majorStrengths: majorStrengths(land, access, road),
        majorConstraints: majorConstraints(c, land, access, road)
      }
    })

  const rankedFeasible = components
    .filter((c) => c.overallStatus === 'PROMISING' || c.overallStatus === 'POTENTIAL')
    .sort((a, b) => {
      const s = statusRank(b.overallStatus) - statusRank(a.overallStatus)
      if (s !== 0) return s
      const l = landCategoryWeight(b.landOpportunity.category) - landCategoryWeight(a.landOpportunity.category)
      if (l !== 0) return l
      const f = b.freeAcres - a.freeAcres
      if (f !== 0) return f
      const lp = b.largestPartAcres - a.largestPartAcres
      if (lp !== 0) return lp
      const b75a = a.buffer75Percent ?? -1
      const b75b = b.buffer75Percent ?? -1
      const buf = b75b - b75a
      if (buf !== 0) return buf
      const frag = b.largestPartToTotalRatio - a.largestPartToTotalRatio
      if (frag !== 0) return frag
      const svc = (b.bestServedAreaSqFt ?? 0) - (a.bestServedAreaSqFt ?? 0)
      if (svc !== 0) return svc
      const ac = accessCategoryWeight(b.accessFeasibility.category) - accessCategoryWeight(a.accessFeasibility.category)
      if (ac !== 0) return ac
      const r = roadCategoryWeight(b.primaryRoadQuality.category) - roadCategoryWeight(a.primaryRoadQuality.category)
      if (r !== 0) return r
      const sr = (b.primaryRoadQuality.bestComponentServiceRatio ?? 0) - (a.primaryRoadQuality.bestComponentServiceRatio ?? 0)
      if (sr !== 0) return sr
      return b.componentIndex - a.componentIndex
    })

  const latent = components
    .filter((c) => c.latentLandOpportunity)
    .sort((a, b) => landCategoryWeight(b.landOpportunity.category) - landCategoryWeight(a.landOpportunity.category) || b.freeAcres - a.freeAcres)

  const constrained = components
    .filter((c) => c.overallStatus === 'CONSTRAINED')
    .sort((a, b) => landCategoryWeight(b.landOpportunity.category) - landCategoryWeight(a.landOpportunity.category) || b.freeAcres - a.freeAcres)

  const unsupported = components
    .filter((c) => c.overallStatus === 'CURRENTLY_UNSUPPORTED' && !c.latentLandOpportunity)
    .sort((a, b) => landCategoryWeight(b.landOpportunity.category) - landCategoryWeight(a.landOpportunity.category) || b.freeAcres - a.freeAcres)

  return {
    mcpi,
    componentCount: components.length,
    rankedFeasibleComponents: rankedFeasible,
    latentLandOpportunities: latent,
    constrainedComponents: constrained,
    unsupportedComponents: unsupported,
    components
  }
}
