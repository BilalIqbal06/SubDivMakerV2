import { startCpuSlice, resetYieldCount, yieldToMainThread, getYieldCount, getYieldWallClockMs } from '../lib/cooperativeScheduler'
import { PipCache, getActivePipCache, setActivePipCache } from '../lib/perf'

import { generateAuthoritativeConceptInWorker } from '../lib/generationWorkerService'
import {
  setActiveRedevelopmentContext,
  getActiveRedevelopmentContext,
  createRedevelopmentOpportunityContext,
  computeRedevelopmentImpactMetrics,
} from '../lib/redevelopmentContext'
import type { RedevelopmentImpactMetrics } from '../lib/redevelopmentContext'
import type { RoadData } from './gisService'
import { resetTerrainLineQueryCache, resetTerrainQueryCounters } from './terrainSuitabilityQuery'
import type {
  ProjectParameters,
  CandidateOpenAreaResult,
  ExistingConditionsData,
  ConceptualRoadSkeletonResult,
  SecondaryRoadNetworkResult,
  DevelopmentOpportunityBlockResult
} from '../types/parameters'
import type { TerrainData } from '../types/terrain'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import type { ParcelFeasibilityAssessment } from './parcelFeasibilityService'
import { generateConceptualRoadSkeleton } from './conceptualRoadGenerator'
import { generateSecondaryRoadNetwork } from './secondaryRoadGenerator'
import { generateDevelopmentOpportunityBlocks } from './developmentOpportunityBlockGenerator'
import { generateConceptualDevelopmentProgram, type ConceptualDevelopmentProgramResult } from './conceptualDevelopmentProgram'
import { ConceptualDevelopmentLayoutResult, LayoutConstraints } from './conceptualDevelopmentLayout'
import { generateLocalDevelopmentStreetExpansion } from './localDevelopmentStreetGenerator'
import { generateConceptualTownhomes, type TownhomeGenerationResult } from './conceptualTownhomeGenerator'
import { fetchRoadPrecedentStreets } from './gisService'
import { buildAuthoritativeAlternative, evaluateConceptAlternatives, scoreAlternative, recommendAlternativeId } from '../lib/conceptAlternativesService'
import type { ConceptAlternativeResult, ConceptStrategy } from '../types/conceptAlternatives'
import { computeTerrainSuitability } from './terrainBuildabilityService'
import type { TerrainSuitabilityResult } from '../types/terrain'

let authoritativeConceptInvocationCount = 0


const conceptResultCache = new Map<string, AuthoritativeConceptResult>()

function buildConceptCacheKey(
  mcpi: string,
  strategy: ConceptStrategy,
  projectParameters: ProjectParameters,
  analysisRunId: number
): string {
  return `${mcpi}|${strategy}|${analysisRunId}|${JSON.stringify(projectParameters)}`
}

export function getCachedAuthoritativeConcept(
  mcpi: string,
  strategy: ConceptStrategy,
  projectParameters: ProjectParameters,
  analysisRunId: number
): AuthoritativeConceptResult | undefined {
  const key = buildConceptCacheKey(mcpi, strategy, projectParameters, analysisRunId)
  return conceptResultCache.get(key)
}

export function getConceptCacheKeysForMcpi(mcpi: string): string[] {
  const prefix = `${mcpi}|`
  return Array.from(conceptResultCache.keys()).filter(k => k.startsWith(prefix))
}

export interface AuthoritativeConceptResult {
  generationRunId: number
  parameters: ProjectParameters
  primaryRoadResult: ConceptualRoadSkeletonResult
  secondaryRoadNetworkResult: SecondaryRoadNetworkResult
  developmentOpportunityBlockResult: DevelopmentOpportunityBlockResult
  conceptualProgram: ConceptualDevelopmentProgramResult
  baselineLayout: ConceptualDevelopmentLayoutResult
  localStreetNetworkResult: LocalStreetNetworkResult
  selectedFinalLayout: ConceptualDevelopmentLayoutResult
  townhomeGenerationResult: TownhomeGenerationResult | null
  alternatives: ConceptAlternativeResult[] | null
  recommendedAlternativeId: ConceptStrategy | null
  selectedAlternativeId: ConceptStrategy
  authoritativeAlternativeId: ConceptStrategy
  terrainSuitability: TerrainSuitabilityResult | null
  redevelopmentImpact?: RedevelopmentImpactMetrics
}

export interface AuthoritativeConceptInput {
  mcpi: string
  analysisRunId: number
  parcelGeometry: any
  candidateOpenArea: CandidateOpenAreaResult
  existingConditions: ExistingConditionsData
  terrainData: TerrainData | null
  projectParameters: ProjectParameters
  parcelFeasibilityAssessment: ParcelFeasibilityAssessment | null
  parcelAreaAcres: number | null
  existingAlternatives: ConceptAlternativeResult[] | null
  targetAlternativeId: ConceptStrategy
  recommendedAlternativeId: ConceptStrategy | null
  roadPrecedentStreets?: RoadData[]
}

export async function generateAuthoritativeConcept(
  input: AuthoritativeConceptInput,
  signal?: AbortSignal,
  runId?: number
): Promise<AuthoritativeConceptResult> {
  const effectiveRunId = runId ?? Date.now()
  const transactionId = `${effectiveRunId}-${Math.random().toString(36).slice(2, 11)}`
  authoritativeConceptInvocationCount++

  console.log('[SubDivMaker Generation Invocation Audit]', {
    phase: 'start',
    invocationCount: authoritativeConceptInvocationCount,
    transactionId,
    mcpi: input.mcpi,
    strategy: input.targetAlternativeId,
    analysisRunId: input.analysisRunId,
    timestamp: new Date().toISOString()
  })

  const {
    mcpi,
    targetAlternativeId,
    projectParameters,
    analysisRunId,
    parcelGeometry
  } = input

  const conceptCacheKey = buildConceptCacheKey(mcpi, targetAlternativeId, projectParameters, analysisRunId)
  const cachedConcept = conceptResultCache.get(conceptCacheKey)
  if (cachedConcept) {
    console.log('[SubDivMaker Generation Invocation Audit]', {
      phase: 'cache-hit',
      invocationCount: authoritativeConceptInvocationCount,
      transactionId,
      mcpi,
      strategy: targetAlternativeId,
      analysisRunId,
      cacheHit: true,
      timestamp: new Date().toISOString()
    })
    return structuredClone(cachedConcept)
  }

  let enrichedInput = input
  if (!input.roadPrecedentStreets) {
    const roadPrecedentStreets = await fetchRoadPrecedentStreets(mcpi, parcelGeometry, signal)
    enrichedInput = { ...input, roadPrecedentStreets }
  }

  const transactionStart = performance.now()
  const transactionStartTimestamp = new Date().toISOString()
  const mainThreadVisibilityAtStart = typeof document !== 'undefined' ? document.visibilityState : 'unknown'

  let result: AuthoritativeConceptResult
  let workerUsed = false
  let fallbackReason: string | null = null

  if (typeof Worker !== 'undefined') {
    try {
      result = await generateAuthoritativeConceptInWorker(enrichedInput, signal, effectiveRunId, transactionId)
      workerUsed = true
    } catch (err) {
      fallbackReason = String(err)
      result = await runAuthoritativeConceptTransaction(effectiveRunId, enrichedInput, signal)
      workerUsed = false
    }
  } else {
    fallbackReason = 'Worker not supported'
    result = await runAuthoritativeConceptTransaction(effectiveRunId, enrichedInput, signal)
  }

  const transactionFinish = performance.now()
  const transactionFinishTimestamp = new Date().toISOString()
  const mainThreadVisibilityAtFinish = typeof document !== 'undefined' ? document.visibilityState : 'unknown'


  console.log('[SubDivMaker Generation Invocation Audit]', {
    phase: 'complete',
    invocationCount: authoritativeConceptInvocationCount,
    transactionId,
    mcpi,
    strategy: targetAlternativeId,
    analysisRunId,
    workerUsed,
    fallback: fallbackReason != null,
    fallbackReason,
    startTime: transactionStartTimestamp,
    finishTime: transactionFinishTimestamp,
    totalMs: Math.round(transactionFinish - transactionStart),
    cancelled: signal?.aborted ?? false,
    success: !signal?.aborted && result != null,
    mainThreadVisibilityAtStart,
    mainThreadVisibilityAtFinish
  })

  conceptResultCache.set(conceptCacheKey, result)
  return structuredClone(result)
}

export async function runAuthoritativeConceptTransaction(
  runId: number,
  input: AuthoritativeConceptInput,
  signal?: AbortSignal
): Promise<AuthoritativeConceptResult> {
  const {
    mcpi,
    analysisRunId,
    parcelGeometry,
    candidateOpenArea,
    existingConditions,
    terrainData,
    parcelFeasibilityAssessment,
    parcelAreaAcres,
    existingAlternatives,
    targetAlternativeId,
    recommendedAlternativeId
  } = input

  // Deep clone the submitted parameters so alternatives or post-processing
  // cannot mutate the authoritative snapshot used by this run.
  const projectParameters = JSON.parse(JSON.stringify(input.projectParameters)) as ProjectParameters

  // Set up the redevelopment opportunity model for all downstream scorers.
  const redevelopmentContext = createRedevelopmentOpportunityContext(input)
  setActiveRedevelopmentContext(redevelopmentContext)

  try {
  const conceptCacheKey = buildConceptCacheKey(mcpi, targetAlternativeId, projectParameters, analysisRunId)
  const cachedConcept = conceptResultCache.get(conceptCacheKey)
  if (cachedConcept) {
    return structuredClone(cachedConcept)
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  resetYieldCount()
  resetTerrainLineQueryCache()
  resetTerrainQueryCounters()
  setActivePipCache(new PipCache())
  const transactionStart = performance.now()
  const transactionStartTimestamp = new Date().toISOString()
  const visibilityAtStart = typeof document !== 'undefined' ? document.visibilityState : 'unknown'

  await yieldToMainThread()
  startCpuSlice()

  const stageTimings: { name: string; totalMs: number; executions: number }[] = []

  const recordStage = (name: string, start: number, executions = 1) => {
    const existing = stageTimings.find(s => s.name === name)
    if (existing) {
      existing.totalMs += performance.now() - start
      existing.executions += executions
    } else {
      stageTimings.push({ name, totalMs: performance.now() - start, executions })
    }
  }

  // Phase 7A: parcel-area terrain suitability (read-only, no generation impact)
  const tSuitability = performance.now()
  const terrainSuitability = await computeTerrainSuitability({
    mcpi,
    candidateOpenArea,
    terrainData,
    signal
  })
  recordStage('terrainSuitability', tSuitability)


  const roadPrecedentStreets = input.roadPrecedentStreets ?? await fetchRoadPrecedentStreets(mcpi, parcelGeometry, signal)

  // Primary road skeleton
  const tPrimary = performance.now()
  const primaryResult = await generateConceptualRoadSkeleton({
    mcpi,
    analysisRunId,
    generationRunId: runId,
    parcelGeometry,
    candidateOpenAreaGeometry: candidateOpenArea.candidateGeometry as GeoJSON.Feature<GeoJSON.Geometry>,
    buildingUnionGeometry: candidateOpenArea.buildingUnionGeometry,
    hydrologyObstaclesGeometry: candidateOpenArea.hydrologyGeometry,
    existingPavementGeometry: candidateOpenArea.pavementGeometry || null,
    streetFeatures: [
      ...existingConditions.intersectingStreets.features,
      ...existingConditions.nearbyStreets.features
    ],
    roadPrecedentStreets,
    roadParameters: projectParameters.roads,
    terrainData,
    terrainSuitability,
    signal
  })

  recordStage('primaryRoad', tPrimary)

  if (primaryResult.status === 'failed') {
    throw new Error(primaryResult.errorMessage || 'Primary road generation failed.')
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  // Secondary road network
  const tSecondary = performance.now()
  const secondaryResult = await generateSecondaryRoadNetwork({
    mcpi,
    analysisRunId,
    generationRunId: runId,
    parcelGeometry,
    primaryRoad: primaryResult,
    candidateOpenArea,
    roadParameters: projectParameters.roads,
    terrainData,
    terrainSuitability,
    primaryTerrainMode: primaryResult.terrainRoadMode ?? 'DIRECT_FALLBACK',
    signal
  })

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  recordStage('secondaryRoad', tSecondary)

  // Development opportunity blocks
  const tOpportunity = performance.now()
  const opportunityResult = generateDevelopmentOpportunityBlocks({
    mcpi,
    candidateOpenArea,
    primaryRoad: primaryResult,
    secondaryRoads: secondaryResult
  })

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  recordStage('opportunityBlocks', tOpportunity)

  // Conceptual development program
  const tProgram = performance.now()
  const programResult = await generateConceptualDevelopmentProgram(
    opportunityResult,
    projectParameters,
    secondaryResult,
    { signal, terrainSuitability }
  )

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  recordStage('developmentProgram', tProgram)


  // Local street constraints
  const localStreetConstraints: LayoutConstraints = {
    conceptualRoadResult: primaryResult,
    secondaryRoadNetworkResult: secondaryResult,
    localStreetNetworkResult: null,
    candidateOpenAreaGeometry: candidateOpenArea.candidateGeometry ?? null,
    parcelBoundary: {
      type: 'Feature',
      properties: { PA_MCPI: mcpi },
      geometry: parcelGeometry
    } as any,
    buildingUnionGeometry: candidateOpenArea.buildingUnionGeometry ?? null,
    hydrologyGeometry: candidateOpenArea.hydrologyGeometry ?? null,
    pavementGeometry: candidateOpenArea.pavementGeometry ?? null,
    terrainData,
    terrainSuitability
  }

  // Local street and lot expansion
  const tLocalStreet = performance.now()
  const lsResult = await generateLocalDevelopmentStreetExpansion(
    programResult,
    opportunityResult,
    localStreetConstraints,
    projectParameters,
    signal
  )

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  recordStage('localStreetEvaluation', tLocalStreet)


  // Townhomes — the target unit count is computed from the townhome share of road-served area in the layout.
  let townhomeResult: TownhomeGenerationResult | null = null
  const thInput = lsResult.finalLayout.townhomeInputs
  const tTownhome = performance.now()
  if (thInput) {
    const townhomeTargetDensity = programResult.targetDensity ?? projectParameters.zoningAndLots?.targetDensity ?? 6
    const townhomeAssignedZones = thInput.zones.filter(z => thInput.assignments.get(z.id) === 'townhomes')
    const townhomeServedAreaAcres = townhomeAssignedZones.reduce((s, z) => s + (z.actualRoadServedAreaAcres ?? 0), 0)
    const townhomeTargetUnitCount =
      townhomeServedAreaAcres > 0 && townhomeTargetDensity > 0
        ? Math.round(townhomeServedAreaAcres * townhomeTargetDensity)
        : null


    townhomeResult = await generateConceptualTownhomes({ ...thInput, alternativeId: 'BALANCED', signal })


  }
  recordStage('townhomeGeneration', tTownhome)

  const tBaseline = performance.now()
  const baselineLayout = lsResult.finalLayout
  recordStage('baselineLayout', tBaseline)

  const tSelectedFinal = performance.now()
  const selectedFinalLayout: ConceptualDevelopmentLayoutResult = townhomeResult
    ? { ...baselineLayout, townhomeGenerationResult: townhomeResult }
    : baselineLayout
  recordStage('selectedFinalLayout', tSelectedFinal)

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await yieldToMainThread()

  // Concept alternatives (only recomputed for the BALANCED transaction)
  const tAlternatives = performance.now()
  let alternatives: ConceptAlternativeResult[] | null = existingAlternatives
  let nextRecommendedAlternativeId: ConceptStrategy | null = recommendedAlternativeId

  if (targetAlternativeId === 'BALANCED') {
    const shared: import('../lib/conceptAlternativesService').ConceptAlternativeSharedContext = {
      mcpi,
      workflowRunId: analysisRunId,
      analysisRunId: candidateOpenArea.analysisRunId,
      parcelGeometry,
      candidateOpenArea,
      candidateOpenAreaGeometry: candidateOpenArea.candidateGeometry as any,
      buildingUnionGeometry: candidateOpenArea.buildingUnionGeometry,
      hydrologyObstaclesGeometry: candidateOpenArea.hydrologyGeometry,
      existingPavementGeometry: candidateOpenArea.pavementGeometry,
      streetFeatures: [
        ...existingConditions.intersectingStreets.features,
        ...existingConditions.nearbyStreets.features
      ],
      terrainData,
      submittedParameters: projectParameters,
      parameterStableKey: JSON.stringify(projectParameters),
      parcelFeasibilityAssessment,
      parentParcelAreaAcres: parcelAreaAcres,
      signal,
      nextGenerationRunId: () => runId
    }

    const balancedAlternative = buildAuthoritativeAlternative(
      'BALANCED',
      projectParameters,
      primaryResult,
      secondaryResult,
      programResult,
      selectedFinalLayout,
      lsResult.localStreetNetworkResult,
      parcelFeasibilityAssessment,
      0
    )

    const { alternatives: computedAlternatives, recommendedAlternativeId: computedRecommended } = await evaluateConceptAlternatives(
      shared,
      {
        selectedAlternativeId: 'BALANCED',
        authoritativeAlternativeId: 'BALANCED',
        generatingAlternativeId: null
      },
      balancedAlternative
    )

    alternatives = computedAlternatives
    nextRecommendedAlternativeId = computedRecommended
  } else {
    const targetAlternative = buildAuthoritativeAlternative(
      targetAlternativeId,
      projectParameters,
      primaryResult,
      secondaryResult,
      programResult,
      selectedFinalLayout,
      lsResult.localStreetNetworkResult,
      parcelFeasibilityAssessment,
      0
    )
    const baseAlternatives = existingAlternatives ?? [targetAlternative]
    const mergedAlternatives = baseAlternatives.map(a => a.id === targetAlternativeId ? targetAlternative : a)
    const scoredAlternatives = mergedAlternatives.map(a => ({
      ...a,
      comparisonScore: scoreAlternative(a, candidateOpenArea.candidateAreaAcres)
    }))
    nextRecommendedAlternativeId = recommendAlternativeId(scoredAlternatives, parcelFeasibilityAssessment)
    alternatives = scoredAlternatives.map(a => ({
      ...a,
      recommended: a.id === nextRecommendedAlternativeId
    }))
  }
  recordStage('alternatives', tAlternatives)

  // Final assembly: construct result bundle and record production timing.
  // The expensive DEV-only terrain query audit is intentionally outside this
  // timer so that finalAssembly measures only real bundle assembly work.
  const tFinalAssembly = performance.now()
  const bundle: AuthoritativeConceptResult = {
    generationRunId: runId,
    parameters: projectParameters,
    primaryRoadResult: primaryResult,
    secondaryRoadNetworkResult: secondaryResult,
    developmentOpportunityBlockResult: opportunityResult,
    conceptualProgram: programResult,
    baselineLayout,
    localStreetNetworkResult: lsResult.localStreetNetworkResult,
    selectedFinalLayout,
    townhomeGenerationResult: townhomeResult,
    alternatives,
    recommendedAlternativeId: nextRecommendedAlternativeId,
    selectedAlternativeId: targetAlternativeId,
    authoritativeAlternativeId: targetAlternativeId,
    terrainSuitability
  }
  const bundleConstructionMs = performance.now() - tFinalAssembly
  recordStage('finalAssembly', tFinalAssembly)

  const totalTransactionMs = performance.now() - transactionStart

  conceptResultCache.set(conceptCacheKey, bundle)

  const altStage = stageTimings.find(s => s.name === 'alternatives')
  const townhomeGenerated = townhomeResult ? 1 : 0
  const conceptAlternativesPerformanceAudit = {
    mcpi,
    initialAlternativeEvaluationMs: altStage?.totalMs ?? 0,
    fullAlternativeGeneratorExecutions: 0,
    lightweightEstimateCount: (alternatives ?? []).filter(a => a.status !== 'authoritative').length,
    balancedCached: conceptResultCache.has(buildConceptCacheKey(mcpi, 'BALANCED', projectParameters, analysisRunId)),
    maxYieldCached: conceptResultCache.has(buildConceptCacheKey(mcpi, 'MAX_YIELD', projectParameters, analysisRunId)),
    constraintConservativeCached: conceptResultCache.has(buildConceptCacheKey(mcpi, 'CONSTRAINT_CONSERVATIVE', projectParameters, analysisRunId)),
    strategies: (alternatives ?? []).map(alt => ({
      id: alt.id,
      mode: (alt.status === 'authoritative' ? 'AUTHORITATIVE' : 'LIGHTWEIGHT_ESTIMATE') as 'AUTHORITATIVE' | 'LIGHTWEIGHT_ESTIMATE',
      evaluationMs: alt.metrics.evaluationMs,
      primaryRoadExecutions: alt.status === 'authoritative' ? 1 : 0,
      secondaryRoadExecutions: alt.status === 'authoritative' ? 1 : 0,
      localStreetExecutions: alt.status === 'authoritative' ? 1 : 0,
      townhomeExecutions: alt.status === 'authoritative' ? townhomeGenerated : 0
    }))
  }

  const largestStage = stageTimings.reduce((max, s) => s.totalMs > max.totalMs ? s : max, stageTimings[0] ?? { name: 'none', totalMs: 0, executions: 0 })
  const largestStagePercent = totalTransactionMs > 0 ? Math.round((largestStage.totalMs / totalTransactionMs) * 1000) / 10 : 0



  // Compute redevelopment impact for the final selected concept.
  bundle.redevelopmentImpact = computeRedevelopmentImpactMetrics(bundle, getActiveRedevelopmentContext())

  console.log('[SubDivMaker Regression Fingerprint]', {
    mcpi,
    alternativeId: targetAlternativeId,
    primaryRoadLengthFt: bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0,
    primaryCoordinateCount: bundle.primaryRoadResult?.proposedRoadCenterline?.geometry?.coordinates?.length ?? 0,
    secondaryRoadCount: bundle.secondaryRoadNetworkResult?.roads?.length ?? 0,
    secondaryTotalLengthFt: bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0,
    localStreetCount: bundle.localStreetNetworkResult?.localStreetCount ?? 0,
    localTotalLengthFt: bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0,
    conceptualUnits: (bundle.selectedFinalLayout?.lotCount ?? 0) + (bundle.townhomeGenerationResult?.unitCount ?? 0),
    servedAreaAcres: (bundle.primaryRoadResult?.servedDevelopableAreaSqFt ?? 0) / 43560,
    totalRoadLengthFt: (bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0) + (bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0) + (bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0),
    developmentZoneCount: bundle.conceptualProgram?.zones?.length ?? 0,
    townhomeRowCount: bundle.townhomeGenerationResult?.rowCount ?? 0,
    redevelopmentImpactLevel: (bundle.redevelopmentImpact as any)?.impactLevel ?? null,
    totalGenerationMs: totalTransactionMs,
    stages: stageTimings,
    largestStage: largestStage.name,
    largestStageMs: largestStage.totalMs,
    largestStagePercent
  })

  console.log('[SubDivMaker Downstream Regression Fingerprint]', {
    mcpi,
    alternativeId: targetAlternativeId,
    primaryRoadLengthFt: bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0,
    secondaryRoadCount: bundle.secondaryRoadNetworkResult?.roads?.length ?? 0,
    secondaryTotalLengthFt: bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0,
    localStreetCount: bundle.localStreetNetworkResult?.localStreetCount ?? 0,
    localTotalLengthFt: bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0,
    developmentZoneCount: bundle.conceptualProgram?.zones?.length ?? 0,
    developmentPadCount: bundle.selectedFinalLayout?.developmentPadCount ?? 0,
    candidateOpenAreaAcres: (candidateOpenArea as any).candidateAreaAcres ?? (candidateOpenArea as any).candidateGeometry ? (bundle.primaryRoadResult?.servedDevelopableAreaSqFt ?? 0) / 43560 : null,
    networkServedAreaAcres: (bundle.selectedFinalLayout?.layoutAreaAcres ?? 0) || ((bundle.primaryRoadResult?.servedDevelopableAreaSqFt ?? 0) / 43560),
    townhomeFrontageRunCount: (townhomeResult as any)?.frontageRuns?.length ?? null,
    townhomeRowCandidateCount: (townhomeResult as any)?.rowCandidates?.length ?? null,
    townhomeRowCount: bundle.townhomeGenerationResult?.rowCount ?? 0,
    townhomeUnitsAttempted: (townhomeResult as any)?.unitsAttempted ?? null,
    townhomeUnitCount: bundle.townhomeGenerationResult?.unitCount ?? 0,
    conceptualUnits: (bundle.selectedFinalLayout?.lotCount ?? 0) + (bundle.townhomeGenerationResult?.unitCount ?? 0),
    townhomeRejectionReasons: (townhomeResult as any)?.rejectionReasons ?? {},
    totalRoadLengthFt: (bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0) + (bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0) + (bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0)
  })

  return bundle
  } finally {
    const pipCache = getActivePipCache()
    if (pipCache) setActivePipCache(null)
    setActiveRedevelopmentContext(null)
  }
}
