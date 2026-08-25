import { ProjectParameters } from '../types/parameters'
import type { ParcelFeasibilityAssessment } from './parcelFeasibilityService'

export type SimplifiedDevelopmentIntensity = 'LOW' | 'MEDIUM' | 'HIGH'

export interface SimplifiedParameters {
  developmentIntensity: SimplifiedDevelopmentIntensity
  roadNetwork: 'AUTO'
  avoidSteepSlopes: boolean
  minimizeStreamCrossings: boolean
  preserveBuildings: boolean
  preservePavement: boolean
  prioritizeDirectAccess: boolean
  explanation: string
}

export interface RecommendedParametersAudit {
  mcpi: string
  overallRating: string
  hydrologyStatus: string
  terrainStatus: string
  buildingStatus: string
  pavementStatus: string
  accessStatus: string
  recommendedDevelopmentIntensity: SimplifiedDevelopmentIntensity
  recommendedRoadNetwork: 'AUTO'
  recommendedAvoidSteepSlopes: boolean
  recommendedMinimizeStreamCrossings: boolean
  recommendedPreserveBuildings: boolean
  recommendedPreservePavement: boolean
  recommendedPrioritizeDirectAccess: boolean
  userOverrides: string[]
}

export interface DeriveRecommendedParametersResult {
  parameters: ProjectParameters
  simplified: SimplifiedParameters
  audit: RecommendedParametersAudit
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function buildExplanation(simplified: SimplifiedParameters, assessment: ParcelFeasibilityAssessment | null): string {
  if (!assessment) return 'Set defaults for the selected parcel to get started.'
  const intensity = simplified.developmentIntensity.toLowerCase()
  const reasons: string[] = []
  if (assessment.overallRating === 'CHALLENGING') {
    reasons.push('mapped constraints suggest a conservative starting point')
  } else if (assessment.overallRating === 'MODERATE') {
    reasons.push('moderate existing constraints are present')
  } else if (assessment.overallRating === 'FAVORABLE') {
    reasons.push('the parcel appears relatively open')
  }
  if (simplified.preserveBuildings) reasons.push('existing buildings are being preserved')
  if (simplified.preservePavement) reasons.push('existing pavement is being preserved')
  if (simplified.avoidSteepSlopes) reasons.push('steep slopes are being avoided')
  if (simplified.minimizeStreamCrossings) reasons.push('stream/wetland crossings are being minimized')
  if (simplified.prioritizeDirectAccess) reasons.push('direct road access is being prioritized')
  const reasonText = reasons.length ? `${reasons.slice(0, 2).join(' and ')}.` : 'based on the parcel feasibility screening.'
  return `Recommended ${intensity} development intensity. ${reasonText}`
}

export function applySimplifiedToProjectParameters(simplified: SimplifiedParameters, p: ProjectParameters): ProjectParameters {
  const updated = clone(p)
  // Road network is always AUTO -> map to the current internal default
  updated.roads.networkPreference = 'modified-grid'
  updated.roads.prioritizeExistingConnections = simplified.prioritizeDirectAccess
  updated.roads.avoidSteepSlopes = simplified.avoidSteepSlopes
  updated.roads.minimizeStreamCrossings = simplified.minimizeStreamCrossings

  // Terrain constraints mirror the site planning preferences
  updated.terrainConstraints.avoidSteepSlopes = simplified.avoidSteepSlopes
  updated.terrainConstraints.avoidStreams = simplified.minimizeStreamCrossings
  updated.terrainConstraints.avoidWetlands = simplified.minimizeStreamCrossings

  // Existing feature preservation
  updated.existingFeatures.buildingTreatment = simplified.preserveBuildings ? 'preserve-all' : 'allow-removal'
  updated.existingFeatures.roadTreatment = simplified.preservePavement ? 'preserve-all' : 'select-modify'
  updated.existingFeatures.preserveParking = simplified.preservePavement

  // Development intensity maps to existing internal numeric values
  switch (simplified.developmentIntensity) {
    case 'LOW':
      updated.zoningAndLots.targetDensity = 2
      ;(updated.zoningAndLots as any).preferredLotSize = 20000
      updated.priorities.maxUnitYield = 'low'
      updated.priorities.maxOpenSpace = 'high'
      break
    case 'HIGH':
      updated.zoningAndLots.targetDensity = 10
      ;(updated.zoningAndLots as any).preferredLotSize = 5000
      updated.priorities.maxUnitYield = 'high'
      updated.priorities.maxOpenSpace = 'low'
      break
    default:
      updated.zoningAndLots.targetDensity = 6
      ;(updated.zoningAndLots as any).preferredLotSize = 8000
      updated.priorities.maxUnitYield = 'medium'
      updated.priorities.maxOpenSpace = 'medium'
      break
  }

  return updated
}

export function getSimplifiedFromProjectParameters(p: ProjectParameters): SimplifiedParameters {
  const buildingTreatment = p.existingFeatures?.buildingTreatment || 'allow-removal'
  const roadTreatment = p.existingFeatures?.roadTreatment || 'select-modify'
  const targetDensity = p.zoningAndLots?.targetDensity ?? 6
  const preferredLotSize = (p.zoningAndLots as any)?.preferredLotSize ?? 8000

  let developmentIntensity: SimplifiedDevelopmentIntensity = 'MEDIUM'
  if (targetDensity <= 3 || preferredLotSize >= 15000) {
    developmentIntensity = 'LOW'
  } else if (targetDensity >= 8 || preferredLotSize <= 6000) {
    developmentIntensity = 'HIGH'
  }

  return {
    developmentIntensity,
    roadNetwork: 'AUTO',
    avoidSteepSlopes: p.roads?.avoidSteepSlopes ?? true,
    minimizeStreamCrossings: p.roads?.minimizeStreamCrossings ?? true,
    preserveBuildings: buildingTreatment === 'preserve-all',
    preservePavement: roadTreatment === 'preserve-all' || p.existingFeatures?.preserveParking === true,
    prioritizeDirectAccess: p.roads?.prioritizeExistingConnections ?? true,
    explanation: ''
  }
}

export function deriveRecommendedParameters(
  assessment: ParcelFeasibilityAssessment | null,
  base: ProjectParameters
): DeriveRecommendedParametersResult {
  const simplified: SimplifiedParameters = {
    developmentIntensity: 'MEDIUM',
    roadNetwork: 'AUTO',
    avoidSteepSlopes: true,
    minimizeStreamCrossings: true,
    preserveBuildings: false,
    preservePavement: false,
    prioritizeDirectAccess: true,
    explanation: ''
  }

  if (assessment) {
    if (assessment.overallRating === 'CHALLENGING') {
      simplified.developmentIntensity = 'LOW'
      simplified.preserveBuildings = true
      simplified.preservePavement = true
      simplified.avoidSteepSlopes = true
      simplified.minimizeStreamCrossings = true
      simplified.prioritizeDirectAccess = true
    } else if (assessment.overallRating === 'MODERATE') {
      simplified.developmentIntensity = 'MEDIUM'
      simplified.preserveBuildings = true
      simplified.preservePavement = true
      simplified.avoidSteepSlopes = true
      simplified.minimizeStreamCrossings = true
      simplified.prioritizeDirectAccess = true
    } else if (assessment.overallRating === 'FAVORABLE') {
      simplified.developmentIntensity = 'MEDIUM'
      simplified.preserveBuildings = false
      simplified.preservePavement = false
      simplified.avoidSteepSlopes = true
      simplified.minimizeStreamCrossings = true
      simplified.prioritizeDirectAccess = true
    }

    if (assessment.hydrologyStatus === 'SIGNIFICANT' || assessment.hydrologyStatus === 'PRESENT') {
      simplified.minimizeStreamCrossings = true
    }
    if (assessment.terrainStatus === 'CHALLENGING') {
      simplified.avoidSteepSlopes = true
    }
    if (assessment.buildingStatus === 'SIGNIFICANT' || assessment.buildingStatus === 'PRESENT') {
      simplified.preserveBuildings = true
    }
    if (assessment.pavementStatus === 'SIGNIFICANT' || assessment.pavementStatus === 'PRESENT') {
      simplified.preservePavement = true
    }
    if (assessment.accessStatus === 'LIMITED' || assessment.accessStatus === 'CONSTRAINED') {
      simplified.prioritizeDirectAccess = true
    }
  }

  simplified.explanation = buildExplanation(simplified, assessment)

  const parameters = applySimplifiedToProjectParameters(simplified, base)

  const audit: RecommendedParametersAudit = {
    mcpi: assessment?.mcpi || '',
    overallRating: assessment?.overallRating || 'INSUFFICIENT DATA',
    hydrologyStatus: assessment?.hydrologyStatus || 'UNKNOWN',
    terrainStatus: assessment?.terrainStatus || 'UNKNOWN',
    buildingStatus: assessment?.buildingStatus || 'UNKNOWN',
    pavementStatus: assessment?.pavementStatus || 'UNKNOWN',
    accessStatus: assessment?.accessStatus || 'UNKNOWN',
    recommendedDevelopmentIntensity: simplified.developmentIntensity,
    recommendedRoadNetwork: 'AUTO',
    recommendedAvoidSteepSlopes: simplified.avoidSteepSlopes,
    recommendedMinimizeStreamCrossings: simplified.minimizeStreamCrossings,
    recommendedPreserveBuildings: simplified.preserveBuildings,
    recommendedPreservePavement: simplified.preservePavement,
    recommendedPrioritizeDirectAccess: simplified.prioritizeDirectAccess,
    userOverrides: []
  }

  if (import.meta.env.DEV) {
    console.log('[RecommendedParametersAudit]', audit)
  }

  return { parameters, simplified, audit }
}
