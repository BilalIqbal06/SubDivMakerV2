// Concept alternatives / strategy comparison v1 types

import type { ProjectParameters } from './parameters'
import type { ConceptualRoadSkeletonResult } from './parameters'
import type { SecondaryRoadNetworkResult } from './parameters'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import type { LocalStreetNetworkResult } from './localStreets'

export type ConceptStrategy = 'MAX_YIELD' | 'BALANCED' | 'CONSTRAINT_CONSERVATIVE'

export type ConceptAlternativeMetricSource =
  | 'AUTHORITATIVE'
  | 'ESTIMATE'
  | 'UNAVAILABLE'

export interface ConceptAlternativeMetricSources {
  conceptualUnits: ConceptAlternativeMetricSource
  networkServedAcres: ConceptAlternativeMetricSource
  remainingOpportunityAcres: ConceptAlternativeMetricSource
  primaryRoadLengthFt: ConceptAlternativeMetricSource
  secondaryRoadLengthFt: ConceptAlternativeMetricSource
  localStreetLengthFt: ConceptAlternativeMetricSource
  totalRoadLengthFt: ConceptAlternativeMetricSource
  constraintImpact: ConceptAlternativeMetricSource
  feasibilityStatus: ConceptAlternativeMetricSource
}

export interface ConceptAlternativeMetrics {
  conceptualUnits: number | null
  networkServedAcres: number | null
  remainingOpportunityAcres: number | null
  primaryRoadLengthFt: number | null
  secondaryRoadLengthFt: number | null
  localStreetLengthFt: number | null
  totalRoadLengthFt: number | null
  constraintImpact: 'LOW' | 'MODERATE' | 'HIGH'
  feasibilityStatus: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING'
  evaluationMs: number
  isAuthoritative: boolean
  metricSources: ConceptAlternativeMetricSources
}

export interface ConceptAlternativeResult {
  id: ConceptStrategy
  strategy: ConceptStrategy
  label: string
  shortLabel: string
  status: 'evaluated' | 'authoritative' | 'limited'
  parametersUsed: ProjectParameters
  primaryRoadResult: ConceptualRoadSkeletonResult | null
  secondaryRoadResult: SecondaryRoadNetworkResult | null
  conceptualProgram: ConceptualDevelopmentProgramResult | null
  developmentLayout: ConceptualDevelopmentLayoutResult | null
  localStreetResult: LocalStreetNetworkResult | null
  metrics: ConceptAlternativeMetrics
  recommendationReason: string
  comparisonScore: number
  recommended: boolean
  selected: boolean
  errorMessage?: string | null
}

export interface ConceptAlternativeEvaluation {
  alternatives: ConceptAlternativeResult[]
  recommendedAlternativeId: ConceptStrategy
}

export interface ConceptAlternativeAuditItem {
  id: ConceptStrategy
  strategy: ConceptStrategy
  metricSource: ConceptAlternativeMetricSource
  evaluationMs: number
  authoritativeGeometryGenerated: boolean
  feasibilityStatus: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING'
  conceptualUnits: number | null
  conceptualUnitsSource: ConceptAlternativeMetricSource
  networkServedAcres: number | null
  networkServedAcresSource: ConceptAlternativeMetricSource
  remainingOpportunityAcres: number | null
  remainingOpportunityAcresSource: ConceptAlternativeMetricSource
  primaryRoadLengthFt: number | null
  primaryRoadLengthFtSource: ConceptAlternativeMetricSource
  secondaryRoadLengthFt: number | null
  secondaryRoadLengthFtSource: ConceptAlternativeMetricSource
  localStreetLengthFt: number | null
  localStreetLengthFtSource: ConceptAlternativeMetricSource
  totalRoadLengthFt: number | null
  totalRoadLengthFtSource: ConceptAlternativeMetricSource
  constraintImpact: 'LOW' | 'MODERATE' | 'HIGH'
  constraintImpactSource: ConceptAlternativeMetricSource
  comparisonScore: number
}

export interface ConceptAlternativesAudit {
  mcpi: string
  workflowRunId: number
  alternatives: ConceptAlternativeAuditItem[]
  recommendedAlternativeId: ConceptStrategy
  selectedAlternativeId: ConceptStrategy | null
  authoritativeAlternativeId: ConceptStrategy | null
  generatingAlternativeId: ConceptStrategy | null
  sharedContextBuildMs: number
  totalAlternativeEvaluationMs: number
  cacheHits: number
  cacheMisses: number
  singleConceptBaselineMs: number | null
  alternativeEvaluationOverheadMs: number | null
}
