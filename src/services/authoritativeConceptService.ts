import { startCpuSlice, resetYieldCount, yieldToMainThread, getYieldCount, getYieldWallClockMs } from '../lib/cooperativeScheduler'
import { recomputeCounter, turfc as turf, safeTurfOp, ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS } from '../lib/perf'
import { generateAuthoritativeConceptInWorker } from '../lib/generationWorkerService'
import {
  setActiveRedevelopmentContext,
  getActiveRedevelopmentContext,
  createRedevelopmentOpportunityContext,
  computeRedevelopmentImpactMetrics,
} from '../lib/redevelopmentContext'
import type { RedevelopmentImpactMetrics } from '../lib/redevelopmentContext'
import type { RoadData } from './gisService'
import { runTerrainQueryAudit, getTerrainLineQueryAudit, resetTerrainLineQueryCache } from './terrainSuitabilityQuery'
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

// Phase 7.1 — Expensive DEV terrain-query audit is opt-in only.
// It does NOT affect generated geometry or scoring and is excluded from the
// normal authoritative-generation critical path. Toggle to true for deliberate
// diagnostic work only.
const ENABLE_EXPENSIVE_TERRAIN_QUERY_AUDIT = false

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
    if (import.meta.env.DEV) {
      console.log('[ConceptAlternativeCacheAudit]', {
        mcpi,
        strategy: targetAlternativeId,
        cacheHit: true,
        primaryRoadExecutions: 0,
        secondaryRoadExecutions: 0,
        localStreetExecutions: 0,
        townhomeExecutions: 0,
        conceptCacheKey
      })
    }
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

  if (import.meta.env.DEV) {
    console.log('[GenerationWorkerAudit]', {
      transactionId,
      alternativeId: targetAlternativeId,
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
  }

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
    if (import.meta.env.DEV) {
      console.log('[ConceptAlternativeCacheAudit]', {
        mcpi,
        strategy: targetAlternativeId,
        cacheHit: true,
        primaryRoadExecutions: 0,
        secondaryRoadExecutions: 0,
        localStreetExecutions: 0,
        townhomeExecutions: 0,
        conceptCacheKey
      })
    }
    return structuredClone(cachedConcept)
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  resetYieldCount()
  resetTerrainLineQueryCache()
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

  if (import.meta.env.DEV) {
    const secondaryRoads = secondaryResult.status !== 'unavailable' ? secondaryResult.roads : []
    const localStreets = lsResult.localStreetNetworkResult.localStreets
    const allAlternatives = (primaryResult.terrainAlternatives as any[] | undefined) ?? []
    const contour = allAlternatives.filter((a: any) => a.terrainRoadMode === 'CONTOUR_FOLLOWING')
    const fallLine = allAlternatives.filter((a: any) => a.terrainRoadMode === 'FALL_LINE')
    const direct = allAlternatives.filter((a: any) => a.terrainRoadMode === 'DIRECT_FALLBACK')
    const firstValidContour = contour.filter((a: any) => a.hardValid)[0]
    const firstValidFallLine = fallLine.filter((a: any) => a.hardValid)[0]
    const bestContour = contour.filter((a: any) => a.hardValid).sort((a: any, b: any) => (b.terrainAlignmentScore ?? 0) - (a.terrainAlignmentScore ?? 0))[0]
    const bestFallLine = fallLine.filter((a: any) => a.hardValid).sort((a: any, b: any) => (b.terrainAlignmentScore ?? 0) - (a.terrainAlignmentScore ?? 0))[0]
    const contourValidCount = contour.filter((a: any) => a.hardValid).length
    const fallLineValidCount = fallLine.filter((a: any) => a.hardValid).length
    const rejectionReasons = (mode: string) => {
      const counts: Record<string, number> = {}
      for (const a of allAlternatives) {
        if (a.terrainRoadMode !== mode || !a.rejectionCategory || a.hardValid) continue
        counts[a.rejectionCategory] = (counts[a.rejectionCategory] || 0) + 1
      }
      return counts
    }
    const selectedMode = primaryResult.terrainRoadMode ?? 'DIRECT_FALLBACK'
    const fallbackReason = selectedMode === 'DIRECT_FALLBACK'
      ? (primaryResult.terrainFallbackReason ?? 'NO_VALID_TERRAIN_CANDIDATES')
      : null
    const fallbackReasonDetail = selectedMode === 'DIRECT_FALLBACK'
      ? (primaryResult.terrainFallbackReasonDetail ?? primaryResult.terrainSelectionReason ?? null)
      : null
    const primaryRowWidthFt = projectParameters.roads?.rightOfWayWidth ?? 50
    const requiredCenterlineInsetFt = (primaryRowWidthFt / 2) + 5
    const rowSafety = primaryResult.primaryRoadRowSafety ?? {
      primaryRowWidthFt,
      requiredCenterlineInsetFt,
      safeCenterlineAreaAvailable: allAlternatives.length > 0,
      safeCenterlineMethod: allAlternatives.length > 0 ? 'BOUNDARY_DISTANCE_FALLBACK' : 'UNAVAILABLE',
      safeCenterlineAreaGeometryType: null,
      safeCenterlineAreaSqFt: null,
      safeCenterlineFailureReason: null
    }
    const collapseReasons = (mode: string) => {
      const counts: Record<string, number> = {}
      for (const a of allAlternatives) {
        if (a.terrainRoadMode !== mode || a.rejectionCategory !== 'COLLAPSED_TO_BASELINE' || a.hardValid) continue
        counts[a.rejectionReason] = (counts[a.rejectionReason] || 0) + 1
      }
      return counts
    }
    const meanSecondaryAngle = secondaryRoads.length
      ? secondaryRoads.reduce((s, r) => s + (r.junctionAngle ?? 0), 0) / secondaryRoads.length
      : null
    const meanSecondaryGrammar = secondaryRoads.length
      ? secondaryRoads.reduce((s, r) => s + (r.grammarPenalty ?? 0), 0) / secondaryRoads.length
      : null
    const meanLocalAngle = localStreets.length
      ? 90
      : null
    const meanLocalGrammar = localStreets.length
      ? localStreets.reduce((s, r) => s + (r.localGrammarPenalty ?? 0), 0) / localStreets.length
      : null
    console.log('[RoadGrammarAudit]', {
      mcpi,
      primaryMode: primaryResult.terrainRoadMode ?? 'DIRECT_FALLBACK',
      primaryGrammar: {
        contourGeneratedCount: contour.length,
        contourValidCount,
        fallLineGeneratedCount: fallLine.length,
        fallLineValidCount,
        directGeneratedCount: direct.length + (selectedMode === 'DIRECT_FALLBACK' ? 1 : 0),
        selectedMode,
        selectedTerrainAlignmentScore: primaryResult.terrainAlignmentScore ?? null,
        selectedRoadPrecedentScore: primaryResult.roadPrecedentScore ?? null,
        bestContourScore: bestContour?.terrainAlignmentScore ?? null,
        bestFallLineScore: bestFallLine?.terrainAlignmentScore ?? null,
        bestDirectScore: null,
        firstValidContourCandidate: firstValidContour
          ? { id: firstValidContour.id, roadLengthFt: firstValidContour.lengthFt, terrainAlignmentScore: firstValidContour.terrainAlignmentScore }
          : null,
        firstValidFallLineCandidate: firstValidFallLine
          ? { id: firstValidFallLine.id, roadLengthFt: firstValidFallLine.lengthFt, terrainAlignmentScore: firstValidFallLine.terrainAlignmentScore }
          : null,
        rejectionReasons: {
          contour: rejectionReasons('CONTOUR_FOLLOWING'),
          fallLine: rejectionReasons('FALL_LINE')
        },
        fallbackReason,
        fallbackReasonDetail,
        rowSafety,
        collapseReasons: {
          contour: collapseReasons('CONTOUR_FOLLOWING'),
          fallLine: collapseReasons('FALL_LINE')
        }
      },
      secondaryGrammar: {
        modeReceived: primaryResult.terrainRoadMode ?? 'DIRECT_FALLBACK',
        candidateCount: secondaryRoads.length,
        selectedBranchCount: secondaryRoads.length,
        meanIntersectionAngleDeg: meanSecondaryAngle,
        meanTerrainAlignmentScore: meanSecondaryGrammar,
        grammarPreference: primaryResult.terrainRoadMode === 'CONTOUR_FOLLOWING'
          ? 'FALL_LINE_BIASED'
          : primaryResult.terrainRoadMode === 'FALL_LINE'
            ? 'CONTOUR_BIASED'
            : 'EXISTING_LOGIC'
      },
      localGrammar: {
        modeReceived: primaryResult.terrainRoadMode ?? 'DIRECT_FALLBACK',
        candidateCount: localStreets.length,
        selectedLocalStreetCount: localStreets.length,
        meanIntersectionAngleDeg: meanLocalAngle,
        meanTerrainAlignmentScore: meanLocalGrammar,
        grammarPreference: primaryResult.terrainRoadMode === 'CONTOUR_FOLLOWING'
          ? 'FRONTAGE_WITH_CONTOUR_BIAS'
          : primaryResult.terrainRoadMode === 'FALL_LINE'
            ? 'FRONTAGE_WITH_CROSS_CONTOUR_BIAS'
            : 'EXISTING_LOGIC'
      }
    })
  }

  // Townhomes — the target unit count is computed from the townhome share of road-served area in the layout.
  let townhomeResult: TownhomeGenerationResult | null = null
  const thInput = lsResult.finalLayout.townhomeInputs
  const tTownhome = performance.now()
  if (thInput) {
    townhomeResult = await generateConceptualTownhomes({ ...thInput, alternativeId: 'BALANCED', signal })

    if (import.meta.env.DEV && townhomeResult) {
      const capacity = thInput.targetUnitCount ?? null
      const targetDensity = programResult.targetDensity ?? projectParameters.zoningAndLots?.targetDensity ?? 6
      const totalNetworkServedAcres = programResult.actualTotalNetworkServedAreaAcres
      const townhomeAssignedZones = thInput.zones.filter(z => thInput.assignments.get(z.id) === 'townhomes')
      const townhomeAssignedServedAcres = townhomeAssignedZones.reduce((s, z) => s + (z.actualRoadServedAreaAcres ?? 0), 0)
      const townhomeAssignedZoneCount = townhomeAssignedZones.length
      const authoritativeConceptualUnits = Math.round(totalNetworkServedAcres * targetDensity)
      console.log('[TownhomeCapacityAudit]', {
        mcpi,
        selectedDevelopmentTypes: programResult.selectedDevelopmentTypes,
        totalNetworkServedAcres,
        townhomeAssignedServedAcres,
        townhomeAssignedZoneCount,
        targetDensity,
        authoritativeConceptualUnits,
        targetUnitCount: thInput.targetUnitCount,
        generatedTownhomeUnits: townhomeResult.unitCount,
        generatedTownhomeRows: townhomeResult.rowCount,
        capacityRespected: capacity == null || townhomeResult.unitCount <= capacity
      })
    }
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

  // Phase 7B.1 — DEV-only expensive terrain query audit, opt-in only.
  // This is outside the production finalAssembly timing boundary and must
  // never affect geometry, scoring, or cache behavior.
  let terrainAudit: any = null
  let terrainAuditExecutions = 0

  if (ENABLE_EXPENSIVE_TERRAIN_QUERY_AUDIT && import.meta.env.DEV && terrainSuitability && terrainSuitability.status === 'completed') {
    try {
      const parcelCenter = safeTurfOp(() => turf.centroid(parcelGeometry), null)
      const primaryRoadCenterline = primaryResult?.proposedRoadCenterline ?? null
      const zoneGeometry = programResult?.zones?.[0]?.geometry ?? null
      terrainAudit = runTerrainQueryAudit(mcpi, terrainSuitability, parcelCenter, primaryRoadCenterline, zoneGeometry)
      terrainAuditExecutions = 1
      if (terrainAudit) {
        console.log('[TerrainQueryAudit]', {
          mcpi,
          pointQuery: {
            available: terrainAudit.pointQuery.available,
            class: terrainAudit.pointQuery.class,
            slopePct: terrainAudit.pointQuery.slopePct,
            queryMs: terrainAudit.pointQuery.queryMs
          },
          primaryRoadQuery: {
            dominantClass: terrainAudit.primaryRoadQuery.dominantClass,
            preferredFraction: terrainAudit.primaryRoadQuery.preferredFraction,
            moderateFraction: terrainAudit.primaryRoadQuery.moderateFraction,
            challengingFraction: terrainAudit.primaryRoadQuery.challengingFraction,
            avoidFraction: terrainAudit.primaryRoadQuery.avoidFraction,
            insufficientDataFraction: terrainAudit.primaryRoadQuery.insufficientDataFraction,
            meanSlopePct: terrainAudit.primaryRoadQuery.meanSlopePct,
            maxSlopePct: terrainAudit.primaryRoadQuery.maxSlopePct,
            queryMs: terrainAudit.primaryRoadQuery.queryMs
          },
          zoneQuery: {
            dominantClass: terrainAudit.zoneQuery.dominantClass,
            preferredPercent: terrainAudit.zoneQuery.preferredPercent,
            moderatePercent: terrainAudit.zoneQuery.moderatePercent,
            challengingPercent: terrainAudit.zoneQuery.challengingPercent,
            avoidPercent: terrainAudit.zoneQuery.avoidPercent,
            insufficientDataPercent: terrainAudit.zoneQuery.insufficientDataPercent,
            meanSlopePct: terrainAudit.zoneQuery.meanSlopePct,
            maxSlopePct: terrainAudit.zoneQuery.maxSlopePct,
            queryMs: terrainAudit.zoneQuery.queryMs
          },
          percentageReconciliation: terrainAudit.percentageReconciliation,
          totalQueryMs: terrainAudit.pointQuery.queryMs + terrainAudit.primaryRoadQuery.queryMs + terrainAudit.zoneQuery.queryMs
        })
      }
    } catch {
      // Terrain query audit errors must never fail the concept transaction.
    }
  }

  const totalTransactionMs = performance.now() - transactionStart

  if (import.meta.env.DEV) {
    console.log('[FinalAssemblyOptimizationAudit]', {
      mcpi,
      alternativeId: targetAlternativeId,
      expensiveTerrainAuditEnabled: ENABLE_EXPENSIVE_TERRAIN_QUERY_AUDIT,
      expensiveTerrainAuditExecutions: terrainAuditExecutions,
      finalAssemblyMs: Math.round(bundleConstructionMs * 100) / 100,
      bundleConstructionMs: Math.round(bundleConstructionMs * 100) / 100
    })

    console.log('[FinalAssemblyEquivalenceSnapshot]', {
      mcpi,
      selectedAlternativeId: targetAlternativeId,
      recommendedAlternativeId: nextRecommendedAlternativeId,
      totalTransactionMs,
      generatedUnits: bundle.selectedFinalLayout?.lotCount ?? 0,
      conceptualTarget: bundle.conceptualProgram?.targetDensity ?? null,
      servedDevelopableAcres: bundle.selectedFinalLayout?.layoutAreaAcres ?? 0,
      totalRoadLengthFt: (bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0) + (bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0) + (bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0),
      primaryRoadLengthFt: bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0,
      secondaryRoadCount: bundle.secondaryRoadNetworkResult?.roads?.length ?? 0,
      secondaryRoadTotalLengthFt: bundle.secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? 0,
      localStreetCount: bundle.localStreetNetworkResult?.localStreetCount ?? 0,
      localStreetTotalLengthFt: bundle.localStreetNetworkResult?.totalLocalStreetLengthFt ?? 0,
      developmentZoneCount: bundle.conceptualProgram?.zones?.length ?? 0,
      developmentPadCount: bundle.selectedFinalLayout?.developmentPadCount ?? 0,
      buildingEnvelopeCount: bundle.selectedFinalLayout?.buildingEnvelopeCount ?? 0,
      townhomeRowCount: bundle.townhomeGenerationResult?.rowCount ?? 0,
      townhomeUnitCount: bundle.townhomeGenerationResult?.unitCount ?? 0
    })
  }

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

  if (import.meta.env.DEV) {
    console.log('[ConceptAlternativesPerformanceAudit]', conceptAlternativesPerformanceAudit)
  }

  const counts = recomputeCounter.get()

  const largestStage = stageTimings.reduce((max, s) => s.totalMs > max.totalMs ? s : max, stageTimings[0] ?? { name: 'none', totalMs: 0, executions: 0 })
  const largestStagePercent = totalTransactionMs > 0 ? Math.round((largestStage.totalMs / totalTransactionMs) * 1000) / 10 : 0

  if (import.meta.env.DEV) {
    const transactionFinishTimestamp = new Date().toISOString()
    const visibilityAtFinish = typeof document !== 'undefined' ? document.visibilityState : 'unknown'
    const selectedDevelopmentTypes = projectParameters.developmentProgram?.filter(u => u.enabled).map(u => u.useType) ?? []
    const rankedStages = [...stageTimings]
      .sort((a, b) => b.totalMs - a.totalMs)
      .map((s, i) => ({
        rank: i + 1,
        name: s.name,
        totalMs: s.totalMs,
        percentOfGeneration: totalTransactionMs > 0 ? (s.totalMs / totalTransactionMs) * 100 : 0
      }))
    const accountedMs = rankedStages.reduce((s, r) => s + r.totalMs, 0)
    const unaccountedMs = Math.max(0, totalTransactionMs - accountedMs)
    console.log('[GenerationBottleneckAudit]', {
      mcpi,
      alternativeId: targetAlternativeId,
      totalMs: totalTransactionMs,
      rankedStages,
      accountedMs,
      unaccountedMs,
      unaccountedPercent: totalTransactionMs > 0 ? (unaccountedMs / totalTransactionMs) * 100 : 0
    })

    console.log('[AuthoritativeStageTimingAudit]', {
      mcpi,
      totalMs: totalTransactionMs,
      stages: stageTimings,
      largestStage: largestStage.name,
      largestStageMs: largestStage.totalMs,
      largestStagePercent,
      selectedDevelopmentTypes,
      developmentIntensity: projectParameters.zoningAndLots?.targetDensity ?? null,
      candidateFullLayouts: counts['layout-candidate'] ?? 0
    })

    console.log('[AuthoritativeGenerationPerformanceAudit]', {
      mcpi,
      alternativeId: targetAlternativeId,
      startTime: transactionStartTimestamp,
      finishTime: transactionFinishTimestamp,
      totalMs: totalTransactionMs,
      visibilityAtStart,
      visibilityAtFinish,
      yieldCount: getYieldCount(),
      yieldWallClockMs: getYieldWallClockMs(),
      stages: stageTimings,
      slowestStage: largestStage.name,
      slowestStageMs: largestStage.totalMs,
      slowestStagePercent: largestStagePercent
    })

    const stageByName = Object.fromEntries(stageTimings.map(s => [s.name, s.totalMs]))
    const primaryRoadId = bundle.primaryRoadResult?.proposedRoadCenterline?.properties?.roadId
      ?? bundle.primaryRoadResult?.proposedRoadCenterline?.properties?.id
      ?? null
    console.log('[GenerationPerformanceCompletionAudit]', {
      mcpi,
      alternativeId: targetAlternativeId,
      totalMs: totalTransactionMs,
      stages: {
        terrainSuitability: stageByName['terrainSuitability'] ?? 0,
        primaryRoad: stageByName['primaryRoad'] ?? 0,
        secondaryRoad: stageByName['secondaryRoad'] ?? 0,
        opportunityBlocks: stageByName['opportunityBlocks'] ?? 0,
        developmentProgram: stageByName['developmentProgram'] ?? 0,
        localStreetEvaluation: stageByName['localStreetEvaluation'] ?? 0,
        townhomeGeneration: stageByName['townhomeGeneration'] ?? 0,
        baselineLayout: stageByName['baselineLayout'] ?? 0,
        selectedFinalLayout: stageByName['selectedFinalLayout'] ?? 0,
        alternatives: stageByName['alternatives'] ?? 0,
        finalAssembly: stageByName['finalAssembly'] ?? 0
      },
      expensiveDiagnosticsEnabled: ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS,
      expensiveDiagnosticExecutionCount: 0,
      cacheStats: counts,
      resultFingerprint: {
        primaryRoadId,
        primaryRoadLengthFt: bundle.primaryRoadResult?.proposedRoadLengthFeet ?? 0,
        secondaryRoadCount: bundle.secondaryRoadNetworkResult?.roads?.length ?? 0,
        localStreetCount: bundle.localStreetNetworkResult?.localStreetCount ?? 0,
        generatedUnits: (bundle.selectedFinalLayout?.lotCount ?? 0) + (bundle.townhomeGenerationResult?.unitCount ?? 0),
        townhomeUnits: bundle.townhomeGenerationResult?.unitCount ?? 0,
        opportunityBlockCount: bundle.developmentOpportunityBlockResult?.blocks?.length ?? 0
      }
    })

    console.log('[TerrainLineQueryCacheAudit]', {
      mcpi,
      ...getTerrainLineQueryAudit()
    })
  }

  // Compute redevelopment impact for the final selected concept.
  bundle.redevelopmentImpact = computeRedevelopmentImpactMetrics(bundle, getActiveRedevelopmentContext())

  return bundle
  } finally {
    setActiveRedevelopmentContext(null)
  }
}
