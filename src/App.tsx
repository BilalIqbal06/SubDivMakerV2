import { useState, useRef, useEffect, useMemo } from 'react'
import { generationPerformance, recomputeCounter, networkCounter, turfCounter, workflowTimeline, mapRenderPerformance, workflowCriticalPath, workflowResultCache, diagnosticOverhead, userPerceivedWorkflow, VERBOSE_GIS_DIAGNOSTICS } from './lib/perf'
import { MapPin } from 'lucide-react'
import L from 'leaflet'
import * as turf from '@turf/turf'
import MapComponent from './components/MapComponent'
import SearchBar from './components/SearchBar'
import Sidebar from './components/Sidebar'
import ZoomMessage from './components/ZoomMessage'
import MapErrorBoundary from './components/MapErrorBoundary'
import ParametersPanel from './components/ParametersPanel'
import AuditPage from './components/AuditPage'
import SavedDraftsCatalog, { useSavedDrafts } from './components/SavedDraftsCatalog'
import type { DraftRecord } from './components/SavedDraftsCatalog'
import { ParcelData, fetchAddressesByMCPI, fetchBuildingsByParcel, fetchExistingPavementSurfaces, fetchHydrologyObstacles, fetchIntersectingStreets, fetchNearbyStreets, fetchParcelByMCPI } from './services/gisService'
import { calculateCandidateOpenArea, createFailedResult } from './services/candidateOpenAreaService'
import { fetchTerrainContours } from './services/terrainService'
import type { TerrainData } from './types/terrain'
import { ProjectParameters, SelectedSiteInfo, ExistingConditionsData, CandidateOpenAreaResult, SubmittedParameters, ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, DevelopmentOpportunityBlockResult } from './types/parameters'
import type { ConceptualDevelopmentProgramResult } from './services/conceptualDevelopmentProgram'
import { ConceptualDevelopmentLayoutResult } from './services/conceptualDevelopmentLayout'
import type { LocalStreetNetworkResult } from './types/localStreets'
import { generateAuthoritativeConcept, getCachedAuthoritativeConcept, getConceptCacheKeysForMcpi, type AuthoritativeConceptResult } from './services/authoritativeConceptService'
import type { RedevelopmentImpactMetrics } from './lib/redevelopmentContext'
import { calculateParcelFeasibility, getParcelScreeningReadiness, buildParcelScreeningInputSignature } from './services/parcelFeasibilityService'
import type { ParcelFeasibilityAssessment, TerrainScreeningStatus } from './services/parcelFeasibilityService'
import { deriveStrategyParameters, scoreAlternative, recommendAlternativeId } from './lib/conceptAlternativesService'
import type { ConceptAlternativeResult, ConceptStrategy } from './types/conceptAlternatives'

type AppStep = 'explore' | 'select' | 'parameters' | 'generate'

interface SelectedParcel {
  id: string
  feature: ParcelData
  details: any
  addresses: any[]
  selectionRequestId?: number
}


function App() {
  const [currentStep, setCurrentStep] = useState<AppStep>('explore')
  const [showGenerateExport, setShowGenerateExport] = useState(false)
  const [selectedParcel, setSelectedParcel] = useState<SelectedParcel | null>(null)
  const [mapZoom, setMapZoom] = useState(10)
  const [sidebarWidth, setSidebarWidth] = useState(320)
  const [existingConditions, setExistingConditions] = useState<ExistingConditionsData | null>(null)
  const [candidateOpenAreaResult, setCandidateOpenAreaResult] = useState<CandidateOpenAreaResult | null>(null)
  const [analysisRunId, setAnalysisRunId] = useState(0)
  const [parameterResetVersion, setParameterResetVersion] = useState(0)
  const [submittedParameters, setSubmittedParameters] = useState<SubmittedParameters | null>(null)
  const [isAnalysisRunning, setIsAnalysisRunning] = useState(false)
  const [conceptualRoadResult, setConceptualRoadResult] = useState<ConceptualRoadSkeletonResult | null>(null)
  const [secondaryRoadNetworkResult, setSecondaryRoadNetworkResult] = useState<SecondaryRoadNetworkResult | null>(null)
  const [developmentOpportunityBlockResult, setDevelopmentOpportunityBlockResult] = useState<DevelopmentOpportunityBlockResult | null>(null)
  const [conceptualProgram, setConceptualProgram] = useState<ConceptualDevelopmentProgramResult | null>(null)
  const [redevelopmentImpact, setRedevelopmentImpact] = useState<RedevelopmentImpactMetrics | null>(null)
  const [terrainData, setTerrainData] = useState<TerrainData | null>(null)
  const [isRoadGenerating, setIsRoadGenerating] = useState(false)
  const [roadGenerationError, setRoadGenerationError] = useState<string | null>(null)
  const [generationStatus, setGenerationStatus] = useState<'idle' | 'generating' | 'complete' | 'failed' | 'aborted'>('idle')
  const [localStreetExpansion, setLocalStreetExpansion] = useState<{ localStreetNetworkResult: LocalStreetNetworkResult; finalLayout: ConceptualDevelopmentLayoutResult } | null>(null)
  const [townhomeGenerationResult, setTownhomeGenerationResult] = useState<import('./services/conceptualTownhomeGenerator').TownhomeGenerationResult | null>(null)
  const [parcelFeasibilityAssessment, setParcelFeasibilityAssessment] = useState<ParcelFeasibilityAssessment | null>(null)
  const [terrainSuitability, setTerrainSuitability] = useState<import('./types/terrain').TerrainSuitabilityResult | null>(null)
  const [terrainScreeningStatus, setTerrainScreeningStatus] = useState<TerrainScreeningStatus>('pending')
  const [parcelAreaAcres, setParcelAreaAcres] = useState<number | null>(null)
  const parcelFeasibilityInputSignatureRef = useRef<string | null>(null)
  const parcelFeasibilityCalculationCountRef = useRef(0)
  const parcelFeasibilityRecalculationReasonsRef = useRef<string[]>([])
  const prevParcelScreeningInputRef = useRef<any>(null)
  const [conceptAlternatives, setConceptAlternatives] = useState<ConceptAlternativeResult[] | null>(null)
  const [selectedAlternativeId, setSelectedAlternativeId] = useState<ConceptStrategy | null>(null)
  const [recommendedAlternativeId, setRecommendedAlternativeId] = useState<ConceptStrategy | null>(null)
  const [authoritativeAlternativeId, setAuthoritativeAlternativeId] = useState<ConceptStrategy | null>(null)
  const [generatingAlternativeId, setGeneratingAlternativeId] = useState<ConceptStrategy | null>(null)
  const [isAlternativeGenerating, setIsAlternativeGenerating] = useState(false)
  const [pendingParcelChange, setPendingParcelChange] = useState<{ feature: ParcelData; source: 'parcel-click' | 'map-point-query' | 'search-result' } | null>(null)
  const [showParcelChangeDialog, setShowParcelChangeDialog] = useState(false)
  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [showDraftsCatalog, setShowDraftsCatalog] = useState(false)
  const [pendingDraftToRestore, setPendingDraftToRestore] = useState<DraftRecord | null>(null)
  const [draftRestoreVersion, setDraftRestoreVersion] = useState(0)
  const [suppressAnalysisUntilManualRun, setSuppressAnalysisUntilManualRun] = useState(false)
  const suppressAnalysisUntilManualRunRef = useRef(false)
  const balancedSnapshotRef = useRef<AuthoritativeConceptResult | null>(null)
  const searchClearRef = useRef<(() => void) | null>(null)
  const mapRef = useRef<any>(null)
  const lastTownhomeAuditKeyRef = useRef<string | null>(null)
  const lastPipelineAuditKeyRef = useRef<string | null>(null)
  const canonicalProjectParametersRef = useRef<ProjectParameters | null>(null)
  const strictModeExecutionInputsRef = useRef<{ program: any[]; localStreet: any[]; townhome: any[] }>({ program: [], localStreet: [], townhome: [] })
  const selectParcelRef = useRef<(feature: ParcelData, source: 'parcel-click' | 'map-point-query' | 'search-result') => void>()
  const selectionRequestIdRef = useRef(0)
  const analysisRequestIdRef = useRef(0)
  const parcelSelectedAtRef = useRef<number | null>(null)
  const isAutoCalculatingOpenAreaRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const analysisInFlightRef = useRef(false)
  const analysisAbortControllerRef = useRef<AbortController | null>(null)
  const analysisStartTimeRef = useRef(0)
  const currentAnalysisRunIdRef = useRef(0)
  const currentRoadGenerationRunIdRef = useRef(0)
  const roadGenerationInFlightRef = useRef(false)
  const roadGenerationAbortControllerRef = useRef<AbortController | null>(null)
  const currentLocalStreetRunIdRef = useRef(0)
  const localStreetAbortControllerRef = useRef<AbortController | null>(null)

  const setSuppressAnalysis = (value: boolean) => {
    suppressAnalysisUntilManualRunRef.current = value
    setSuppressAnalysisUntilManualRun(value)
  }
  const { drafts, saveDraft, deleteDraft } = useSavedDrafts()
  
  // Development-only audit route
  const isAuditRoute = import.meta.env.DEV && window.location.pathname === '/audit'
  if (isAuditRoute) {
    return <AuditPage />
  }
  
  // Clear analysis state on mount to prevent stale overlays after refresh
  useEffect(() => {
    setCandidateOpenAreaResult(null)
    setExistingConditions(null)
    setSubmittedParameters(null)
    setConceptualRoadResult(null)
    setSecondaryRoadNetworkResult(null)
    setDevelopmentOpportunityBlockResult(null)
    setConceptualProgram(null)
    setRedevelopmentImpact(null)
    setIsAnalysisRunning(false)
  }, [])

  // Derive parcel feasibility assessment once authoritative screening inputs are stable
  useEffect(() => {
    const mcpi = selectedParcel?.feature?.properties?.PA_MCPI || ''
    const { ready, blockingReasons } = getParcelScreeningReadiness(existingConditions, candidateOpenAreaResult, terrainScreeningStatus)

    if (import.meta.env.DEV) {
      const elapsedMsSinceParcelSelected = parcelSelectedAtRef.current ? Date.now() - parcelSelectedAtRef.current : 0
      console.log('[ParcelScreeningReadinessAudit]', {
        mcpi,
        ready,
        buildingsState: existingConditions?.buildings?.state ?? null,
        hydrologyState: existingConditions?.hydrology?.state ?? null,
        pavementState: existingConditions?.pavement?.state ?? null,
        intersectingStreetsState: existingConditions?.intersectingStreets?.state ?? null,
        nearbyStreetsState: existingConditions?.nearbyStreets?.state ?? null,
        parcelBoundaryState: existingConditions?.parcelBoundary?.state ?? null,
        candidateOpenAreaReady: !!candidateOpenAreaResult,
        terrainScreeningStatus,
        blockingReasons,
        elapsedMsSinceParcelSelected
      })
    }

    const currentInput = {
      mcpi,
      existingConditions,
      terrainData,
      candidateOpenAreaResult,
      terrainScreeningStatus
    }

    const prevInput = prevParcelScreeningInputRef.current
    if (prevInput) {
      const reasons: string[] = []
      if (prevInput.mcpi !== mcpi) reasons.push('selectedParcel changed')
      if (prevInput.existingConditions !== existingConditions) reasons.push('existingConditions updated')
      if (prevInput.terrainData !== terrainData) reasons.push('terrainData updated')
      if (prevInput.candidateOpenAreaResult !== candidateOpenAreaResult) reasons.push('candidateOpenAreaResult updated')
      if (prevInput.terrainScreeningStatus !== terrainScreeningStatus) reasons.push('terrainScreeningStatus updated')
      if (reasons.length > 0) {
        parcelFeasibilityRecalculationReasonsRef.current = [...parcelFeasibilityRecalculationReasonsRef.current, ...reasons]
      }
    }
    prevParcelScreeningInputRef.current = currentInput

    if (!ready) {
      setParcelFeasibilityAssessment(null)
      if (VERBOSE_GIS_DIAGNOSTICS) {
        console.log('[ParcelScreeningStabilityAudit]', {
          mcpi,
          analysisRunId: currentAnalysisRunIdRef.current,
          parcelScreeningReady: false,
          calculationCount: parcelFeasibilityCalculationCountRef.current,
          inputSignature: null,
          candidateOpenAreaAcres: candidateOpenAreaResult?.candidateAreaAcres ?? null,
          parcelAreaAcres: existingConditions?.parcelBoundary?.parcelAreaAcres ?? null,
          developablePercent: null,
          buildingStatus: null,
          hydrologyStatus: null,
          pavementStatus: null,
          terrainStatus: null,
          accessStatus: null,
          overallRating: null,
          confidence: null,
          recalculationReasons: parcelFeasibilityRecalculationReasonsRef.current
        })
      }
      return
    }

    const inputSignature = buildParcelScreeningInputSignature(currentInput as any)
    if (inputSignature === parcelFeasibilityInputSignatureRef.current) return

    parcelFeasibilityInputSignatureRef.current = inputSignature
    parcelFeasibilityCalculationCountRef.current += 1

    const assessment = calculateParcelFeasibility({
      mcpi,
      parcelFeature: selectedParcel!.feature as any,
      existingConditions: existingConditions!,
      terrainData,
      candidateOpenAreaResult
    })

    setParcelFeasibilityAssessment(assessment)

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[ParcelScreeningStabilityAudit]', {
        mcpi,
        analysisRunId: currentAnalysisRunIdRef.current,
        parcelScreeningReady: true,
        calculationCount: parcelFeasibilityCalculationCountRef.current,
        inputSignature,
        candidateOpenAreaAcres: candidateOpenAreaResult?.candidateAreaAcres ?? null,
        parcelAreaAcres: assessment.parcelAreaAcres,
        developablePercent: assessment.developablePercent,
        buildingStatus: assessment.buildingStatus,
        hydrologyStatus: assessment.hydrologyStatus,
        pavementStatus: assessment.pavementStatus,
        terrainStatus: assessment.terrainStatus,
        accessStatus: assessment.accessStatus,
        overallRating: assessment.overallRating,
        confidence: assessment.confidence,
        recalculationReasons: parcelFeasibilityRecalculationReasonsRef.current
      })
      if (parcelFeasibilityCalculationCountRef.current > 1 && inputSignature === parcelFeasibilityInputSignatureRef.current) {
        console.warn('[ParcelScreeningStabilityAudit] Duplicate calculation detected for same input signature', { mcpi, inputSignature })
      }
    }
  }, [selectedParcel, existingConditions, terrainData, candidateOpenAreaResult, terrainScreeningStatus])

  // Handle deep-link MCPI parameter for audit review workflow
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const mcpiParam = urlParams.get('mcpi')
    
    if (mcpiParam && selectParcelRef.current) {
      // Fetch and select the parcel by MCPI
      fetchParcelByMCPI(mcpiParam).then(feature => {
        if (feature && feature.geometry) {
          selectParcelRef.current!(feature, 'search-result')
          // Remove the parameter from URL after selection
          const newUrl = window.location.pathname
          window.history.replaceState({}, '', newUrl)
        } else {
          console.error('Failed to fetch parcel for MCPI:', mcpiParam)
        }
      }).catch(err => {
        console.error('Error fetching parcel by MCPI:', err)
      })
    }
  }, [])

  // Derive stable parcel ID from feature
  const getParcelId = (feature: ParcelData): string => {
    return feature.properties?.OBJECTID?.toString() || feature.properties?.PA_MCPI || ''
  }

  // Get current MCPI from selected parcel
  const getCurrentMCPI = (): string => {
    return selectedParcel?.feature.properties?.PA_MCPI || ''
  }

  const clearRoadGeneration = () => {
    if (roadGenerationAbortControllerRef.current) {
      roadGenerationAbortControllerRef.current.abort()
      roadGenerationAbortControllerRef.current = null
    }
    setConceptualRoadResult(null)
    setSecondaryRoadNetworkResult(null)
    setDevelopmentOpportunityBlockResult(null)
    setConceptualProgram(null)
    setRedevelopmentImpact(null)
    setLocalStreetExpansion(null)
    setTownhomeGenerationResult(null)
    setRoadGenerationError(null)
    setIsRoadGenerating(false)
    setGenerationStatus('idle')
    setConceptAlternatives(null)
    setSelectedAlternativeId(null)
    setRecommendedAlternativeId(null)
    setAuthoritativeAlternativeId(null)
    setGeneratingAlternativeId(null)
    setIsAlternativeGenerating(false)
    balancedSnapshotRef.current = null
    roadGenerationInFlightRef.current = false
    currentRoadGenerationRunIdRef.current += 1
  }

  // Centralized parcel workflow reset function
  const resetParcelWorkflow = (
    reason: 'parcel-change' | 'refresh' | 'explicit-reset' = 'parcel-change',
    nextMcpi: string | null = null
  ) => {
    const previousMcpi = selectedParcel?.feature.properties?.PA_MCPI || null

    // Abort all active requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    if (analysisAbortControllerRef.current) {
      analysisAbortControllerRef.current.abort()
    }

    // Invalidate request IDs
    selectionRequestIdRef.current += 1
    analysisRequestIdRef.current += 1

    // Clear analysis state
    setCandidateOpenAreaResult(null)
    const newRunId = currentAnalysisRunIdRef.current + 1
    currentAnalysisRunIdRef.current = newRunId
    setAnalysisRunId(newRunId)
    setIsAnalysisRunning(false)
    analysisInFlightRef.current = false
    analysisAbortControllerRef.current = null
    setSubmittedParameters(null)

    // Increment parameter reset version to trigger form reset
    const nextResetVersion = parameterResetVersion + 1
    setParameterResetVersion(nextResetVersion)

    // Clear all generated results (Phases 2A–3D.1)
    clearRoadGeneration()
    setSecondaryRoadNetworkResult(null)
    setDevelopmentOpportunityBlockResult(null)

    // Clear existing conditions, terrain data, and parcel feasibility
    setExistingConditions(null)
    setTerrainData(null)
    setTerrainScreeningStatus('pending')
    setParcelFeasibilityAssessment(null)
    parcelFeasibilityInputSignatureRef.current = null
    parcelFeasibilityCalculationCountRef.current = 0
    parcelFeasibilityRecalculationReasonsRef.current = []
    prevParcelScreeningInputRef.current = null
    setParcelAreaAcres(null)

    // Reset workflow step to selected parcel
    setCurrentStep('select')

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[WorkflowReset]', {
        reason,
        workflowRunId: nextResetVersion,
        previousMcpi,
        nextMcpi,
        submittedParametersCleared: true,
        analysisCleared: true,
        parameterSource: 'canonical-defaults'
      })
    }
  }

  const M2_PER_ACRE = 4046.8564224

  function computeParcelAreaAcres(geometry: any): number | null {
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null
    try {
      const sqMeters = turf.area(geometry)
      return sqMeters / M2_PER_ACRE
    } catch {
      return null
    }
  }

  // Begin new parcel workflow (called after successful MCPI search or confirmed parcel change)
  const beginNewParcelWorkflow = (feature: ParcelData, source: 'parcel-click' | 'map-point-query' | 'search-result') => {
    const parcelId = getParcelId(feature)
    const nextMcpi = feature.properties?.PA_MCPI || null

    // Reset the previous workflow
    resetParcelWorkflow('parcel-change', nextMcpi)

    // Clear search text if parcel was selected manually (not from search)
    if (source !== 'search-result' && searchClearRef.current) {
      searchClearRef.current()
    }

    // Validate geometry
    if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
      console.error('Invalid parcel geometry:', feature.geometry?.type)
      return
    }

    const computedParcelAreaAcres = computeParcelAreaAcres(feature.geometry)
    setParcelAreaAcres(computedParcelAreaAcres)

    // Create new abort controller for this selection
    const requestId = ++selectionRequestIdRef.current
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const conditionMcpi = normalizeMCPI(feature.properties?.PA_MCPI || '')
    const conditionRunId = requestId

    // Immediately set the new selection with the feature
    setSelectedParcel({
      id: parcelId,
      feature,
      details: null,
      addresses: [],
      selectionRequestId: requestId
    })
    parcelSelectedAtRef.current = Date.now()
    setCurrentStep('select')
    setExistingConditions(null)

    // Fit map to parcel bounds (allowed during explicit selection; suppressed during generation)
    if ((source || !roadGenerationInFlightRef.current) && mapRef.current && feature.geometry) {
      const geoJSONLayer = L.geoJSON(feature as any)
      const bounds = geoJSONLayer.getBounds()
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 })
      }
    }

    // Load details, addresses, and existing conditions
    const analysisTimestamp = new Date().toISOString()
    
    // Initialize existing conditions in loading state
    setTerrainData(null)
    setTerrainScreeningStatus('pending')

    setExistingConditions({
      buildings: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
        state: 'loading',
        count: 0,
        features: [],
        timestamp: analysisTimestamp
      },
      intersectingStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
        state: 'loading',
        count: 0,
        features: [],
        uniqueNames: [],
        timestamp: analysisTimestamp
      },
      nearbyStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
        state: 'loading',
        count: 0,
        additionalCount: 0,
        features: [],
        uniqueNames: [],
        timestamp: analysisTimestamp
      },
      hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
        state: 'loading',
        count: 0,
        waterFeatureCount: 0,
        wetlandFeatureCount: 0,
        streamDrainCount: 0,
        hydrologyCoverageAvailable: false,
        features: { source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false },
        timestamp: analysisTimestamp
      },
      pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
        state: 'loading',
        count: 0,
        parkingLotFeatureCount: 0,
        drivewayFeatureCount: 0,
        pavementCoverageAvailable: false,
        features: { source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false },
        timestamp: analysisTimestamp
      },
      parcelBoundary: {
        state: 'success',
        parcelAreaAcres: computedParcelAreaAcres ?? undefined,
        timestamp: analysisTimestamp
      },
      analysisTimestamp
    })
    
    // Helper to extract unique street names
    const extractUniqueStreetNames = (features: any[]): string[] => {
      const names = new Set<string>()
      features.forEach(f => {
        const name = f.properties?.ST_FULLNAME || f.properties?.ST_STR_NAME
        if (name) names.add(name)
      })
      return Array.from(names).sort()
    }
    
    Promise.all([
      Promise.resolve(feature), // Already have full feature from point query
      fetchAddressesByMCPI(feature.properties?.PA_MCPI, abortController.signal).catch(err => {
        if (err.name !== 'AbortError') console.error('Failed to fetch addresses:', err)
        return []
      }),
      fetchBuildingsByParcel(feature.geometry, abortController.signal).then(buildings => {
        const state: 'success' | 'success-zero' = buildings.length > 0 ? 'success' : 'success-zero'
        return { buildings, state, error: undefined as string | undefined }
      }).catch(err => {
        if (err.name === 'AbortError') {
          return { buildings: [], state: 'aborted' as const, error: undefined as string | undefined }
        }
        console.error('Failed to fetch buildings:', err)
        return { buildings: [], state: 'error' as const, error: err.message as string }
      }),
      fetchIntersectingStreets(feature.geometry, abortController.signal).then(streets => {
        const state: 'success' | 'success-zero' = streets.length > 0 ? 'success' : 'success-zero'
        const uniqueNames = extractUniqueStreetNames(streets)
        return { streets, state, uniqueNames, error: undefined as string | undefined }
      }).catch(err => {
        if (err.name === 'AbortError') {
          return { streets: [], state: 'aborted' as const, uniqueNames: [], error: undefined as string | undefined }
        }
        console.error('Failed to fetch intersecting streets:', err)
        return { streets: [], state: 'error' as const, uniqueNames: [], error: err.message as string }
      }),
      fetchNearbyStreets(feature.geometry, abortController.signal).then(streets => {
        const state: 'success' | 'success-zero' = streets.length > 0 ? 'success' : 'success-zero'
        const uniqueNames = extractUniqueStreetNames(streets)
        return { streets, state, uniqueNames, error: undefined as string | undefined }
      }).catch(err => {
        if (err.name === 'AbortError') {
          return { streets: [], state: 'aborted' as const, uniqueNames: [], error: undefined as string | undefined }
        }
        console.error('Failed to fetch nearby streets:', err)
        return { streets: [], state: 'error' as const, uniqueNames: [], error: err.message as string }
      }),
      (() => {
        const mcpi = feature.properties?.PA_MCPI
        
        return fetchHydrologyObstacles(feature.geometry, mcpi || '', abortController.signal)
      })().then(hydrology => {
        
        const state: 'success' | 'success-zero' | 'error' = hydrology.hydrologyCoverageAvailable ? 'success' : 'error'
        return { hydrology, state, error: hydrology.fetchError as string | undefined }
      }).catch(err => {
        if (err.name === 'AbortError') {
          return { hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false }, state: 'aborted' as const, error: undefined as string | undefined }
        }
        console.error('Failed to fetch hydrology:', err)
        return { hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false }, state: 'error' as const, error: err.message as string }
      }),
      (() => {
        const mcpi = feature.properties?.PA_MCPI
        
        return fetchExistingPavementSurfaces(feature.geometry, mcpi || '', abortController.signal)
      })().then(pavement => {
        
        const state: 'success' | 'success-zero' | 'error' = pavement.pavementCoverageAvailable ? 'success' : 'error'
        return { pavement, state, error: pavement.fetchError as string | undefined }
      }).catch(err => {
        if (err.name === 'AbortError') {
          return { pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false }, state: 'aborted' as const, error: undefined as string | undefined }
        }
        console.error('Failed to fetch pavement:', err)
        return { pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false }, state: 'error' as const, error: err.message as string }
      })
    ]).then(([_, addresses, buildingsResult, intersectingResult, nearbyResult, hydrologyResult, pavementResult]) => {
      // Only update if this is still the current selection
      if (requestId === selectionRequestIdRef.current) {
        // Calculate additional nearby streets (exclude intersecting by OBJECTID)
        const intersectingObjectIds = new Set(intersectingResult.streets.map((s: any) => s.properties?.OBJECTID))
        const additionalStreets = nearbyResult.streets.filter((s: any) => !intersectingObjectIds.has(s.properties?.OBJECTID))
        
        setSelectedParcel(prev => {
          if (prev && prev.id === parcelId) {
            return {
              ...prev,
              details: feature.properties,
              addresses
            }
          }
          return prev
        })

        setExistingConditions({
          buildings: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: buildingsResult.state,
            count: buildingsResult.buildings.length,
            features: buildingsResult.buildings,
            timestamp: analysisTimestamp,
            error: buildingsResult.error
          },
          intersectingStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: intersectingResult.state,
            count: intersectingResult.streets.length,
            features: intersectingResult.streets,
            uniqueNames: intersectingResult.uniqueNames,
            timestamp: analysisTimestamp,
            error: intersectingResult.error
          },
          nearbyStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: nearbyResult.state,
            count: nearbyResult.streets.length,
            additionalCount: additionalStreets.length,
            features: nearbyResult.streets,
            uniqueNames: nearbyResult.uniqueNames,
            timestamp: analysisTimestamp,
            error: nearbyResult.error
          },
          hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: hydrologyResult.state,
            count: hydrologyResult.hydrology.waterBodyFeatures.length + hydrologyResult.hydrology.wetlandFeatures.length + hydrologyResult.hydrology.streamDrainFeatures.length,
            waterFeatureCount: hydrologyResult.hydrology.waterBodyFeatures.length,
            wetlandFeatureCount: hydrologyResult.hydrology.wetlandFeatures.length,
            streamDrainCount: hydrologyResult.hydrology.streamDrainFeatures.length,
            hydrologyCoverageAvailable: hydrologyResult.hydrology.hydrologyCoverageAvailable,
            features: hydrologyResult.hydrology,
            timestamp: analysisTimestamp,
            error: hydrologyResult.error
          },
          pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: pavementResult.state,
            count: pavementResult.pavement.totalFeatureCount,
            parkingLotFeatureCount: pavementResult.pavement.parkingLotFeatureCount,
            drivewayFeatureCount: pavementResult.pavement.drivewayFeatureCount,
            pavementCoverageAvailable: pavementResult.pavement.pavementCoverageAvailable,
            features: pavementResult.pavement,
            timestamp: analysisTimestamp,
            error: pavementResult.error
          },
          parcelBoundary: {
            state: 'success',
            parcelAreaAcres: computedParcelAreaAcres ?? undefined,
            timestamp: analysisTimestamp
          },
          analysisTimestamp
        })

        const TERRAIN_TIMEOUT_MS = 10000
        let terrainTimeoutId: number | undefined
        const terrainTimeout = new Promise<never>((_, reject) => {
          terrainTimeoutId = window.setTimeout(() => reject(new DOMException('Terrain fetch timed out', 'TimeoutError')), TERRAIN_TIMEOUT_MS)
        })

        Promise.race([
          fetchTerrainContours(conditionMcpi, feature.geometry, abortControllerRef.current?.signal),
          terrainTimeout
        ])
          .then(terrain => {
            window.clearTimeout(terrainTimeoutId)
            if (requestId === selectionRequestIdRef.current) {
              setTerrainData(terrain)
              setTerrainScreeningStatus(terrain?.coverageAvailable ? 'complete' : 'unavailable')
            }
          })
          .catch(err => {
            window.clearTimeout(terrainTimeoutId)
            if (err.name !== 'AbortError') {
              console.error('[Terrain] Fetch failed:', err)
            }
            if (requestId === selectionRequestIdRef.current) {
              setTerrainData(null)
              setTerrainScreeningStatus('unavailable')
            }
          })
      }
    }).catch(err => {
      if (err.name !== 'AbortError') {
        console.error('Failed to load parcel details:', err)
        // Set error state for all queries
        setExistingConditions({
          buildings: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'error',
            count: 0,
            features: [],
            timestamp: analysisTimestamp,
            error: err.message
          },
          intersectingStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'error',
            count: 0,
            features: [],
            uniqueNames: [],
            timestamp: analysisTimestamp,
            error: err.message
          },
          nearbyStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'error',
            count: 0,
            additionalCount: 0,
            features: [],
            uniqueNames: [],
            timestamp: analysisTimestamp,
            error: err.message
          },
          hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'error',
            count: 0,
            waterFeatureCount: 0,
            wetlandFeatureCount: 0,
            streamDrainCount: 0,
            hydrologyCoverageAvailable: false,
            features: { source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false },
            timestamp: analysisTimestamp,
            error: err.message
          },
          pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'error',
            count: 0,
            parkingLotFeatureCount: 0,
            drivewayFeatureCount: 0,
            pavementCoverageAvailable: false,
            features: { source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false },
            timestamp: analysisTimestamp,
            error: err.message
          },
          parcelBoundary: {
            state: 'success',
            parcelAreaAcres: computedParcelAreaAcres ?? undefined,
            timestamp: analysisTimestamp
          },
          analysisTimestamp
        })
      }
      if (requestId === selectionRequestIdRef.current) {
        setTerrainData(null)
        setTerrainScreeningStatus('unavailable')
      }
    })
  }

  // Unified parcel selection function with source tracking (now handles confirmation dialog)
  const selectParcel = (feature: ParcelData, source: 'parcel-click' | 'map-point-query' | 'search-result') => {
    const currentMCPI = getCurrentMCPI()
    const newMCPI = feature.properties?.PA_MCPI || ''

    // If no parcel is currently selected, proceed directly
    if (!selectedParcel) {
      beginNewParcelWorkflow(feature, source)
      return
    }

    // If clicking the same parcel (same MCPI), show restart dialog
    if (newMCPI === currentMCPI) {
      setShowRestartDialog(true)
      return
    }

    // If clicking a different parcel, show confirmation dialog
    setPendingParcelChange({ feature, source })
    setShowParcelChangeDialog(true)
  }

  // Handle parcel change confirmation
  const handleConfirmParcelChange = () => {
    if (pendingParcelChange) {
      setShowParcelChangeDialog(false)
      beginNewParcelWorkflow(pendingParcelChange.feature, pendingParcelChange.source)
      setPendingParcelChange(null)
    }
  }

  // Handle parcel change cancellation
  const handleCancelParcelChange = () => {
    setShowParcelChangeDialog(false)
    setPendingParcelChange(null)
  }

  // Handle same-parcel restart confirmation
  const handleConfirmRestart = () => {
    setShowRestartDialog(false)
    // Reset workflow for the same parcel
    if (selectedParcel) {
      resetParcelWorkflow()
      // Reload the same parcel
      beginNewParcelWorkflow(selectedParcel.feature, 'search-result')
    }
  }

  // Handle same-parcel restart cancellation
  const handleCancelRestart = () => {
    setShowRestartDialog(false)
    // Preserve everything - do nothing
  }
  
  // Store selectParcel in ref for deep-link access
  selectParcelRef.current = selectParcel

  // Clear selection function
  const clearSelectedParcel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    setSelectedParcel(null)
    setExistingConditions(null)
    setCurrentStep('explore')
    // Clear search text
    if (searchClearRef.current) {
      searchClearRef.current()
    }
  }

  // Escape key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedParcel) {
        clearSelectedParcel()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [selectedParcel])

  // Legacy handler for backward compatibility
  const handleParcelSelect = (parcel: ParcelData, source?: 'parcel-click' | 'map-point-query' | 'search-result') => {
    selectParcel(parcel, source || 'parcel-click')
  }

  const handleStepChange = (step: string) => {
    setCurrentStep(step as AppStep)
  }

  const handleZoomChange = (zoom: number) => {
    setMapZoom(zoom)
  }

  const handleNavigateToAddress = (lng: number, lat: number) => {
    if (mapRef.current) {
      mapRef.current.setView([lat, lng], 18)
    }
  }

  const handleMapReady = (map: any) => {
    mapRef.current = map
    // Invalidate size after sidebar mounts
    requestAnimationFrame(() => {
      map.invalidateSize()
    })
  }

  // Convert selected parcel to SelectedSiteInfo for ParametersPanel
  const getSelectedSiteInfo = (): SelectedSiteInfo => {
    if (!selectedParcel) {
      return {
        mcpi: '',
        addresses: [],
        geometryStatus: 'No parcel selected',
        hasParcel: false,
        eligibilityState: 'analysis-required'
      }
    }

    const props = selectedParcel.feature.properties
    const geometry = selectedParcel.feature.geometry

    return {
      mcpi: props?.PA_MCPI || '',
      selectionRequestId: selectedParcel.selectionRequestId,
      addresses: selectedParcel.addresses.map((a: any) => a.properties?.FULL_ADDRESS || a.properties?.ADDRESS || '').filter(Boolean),
      gisAcreage: props?.PA_GIS_ACRE,
      legalAcreage: props?.PA_LEGAL_ACRE,
      subdivision: props?.PA_SUBD_NAME,
      platNumber: props?.PA_PLAT_NUM,
      platLot: props?.PA_PLAT_LOT,
      parcelType: props?.PA_TYPE,
      geometryStatus: geometry ? 'Valid geometry' : 'Invalid geometry',
      hasParcel: true,
      eligibilityState: 'analysis-required',
      existingConditions: existingConditions || undefined
    }
  }

  // Handle candidate open area result
  const handleCandidateOpenAreaResult = (result: CandidateOpenAreaResult | null, runId: number) => {
    // If analysis is suppressed during draft restoration, discard any results
    const isSuppressed = suppressAnalysisUntilManualRunRef.current
    if (isSuppressed) {
      setIsAnalysisRunning(false)
      analysisInFlightRef.current = false
      analysisAbortControllerRef.current = null
      return
    }

    // Ignore stale or superseded results
    if (runId !== currentAnalysisRunIdRef.current) {
      return
    }

    setCandidateOpenAreaResult(result)
    if (result && result.mcpi) {
      const semanticKey = `${result.mcpi}|${result.status}|${(result.candidateGeometry as any)?.geometry?.type ?? 'none'}`
      recomputeCounter.increment('candidateOpenArea', semanticKey)
    }

    // Keep the loading state visible for a minimum duration while allowing the
    // result to be consumed immediately by map/legend rendering.
    const thisRunId = runId
    const elapsed = Date.now() - (analysisStartTimeRef.current || 0)
    const remaining = Math.max(0, 300 - elapsed)

    const clearRunning = () => {
      if (currentAnalysisRunIdRef.current === thisRunId) {
        setIsAnalysisRunning(false)
        analysisInFlightRef.current = false
        analysisAbortControllerRef.current = null
      }
    }

    if (remaining > 0) {
      setTimeout(clearRunning, remaining)
    } else {
      clearRunning()
    }

    // Development logging for analysis completion
    if (VERBOSE_GIS_DIAGNOSTICS) {
      if (result?.status === 'loaded') {
        console.log('[App] Analysis successfully loaded', { mcpi: result.mcpi, runId, status: result.status })
      } else if (result) {
        console.log('[App] Analysis finished without success', { mcpi: result.mcpi, runId, status: result.status, errors: result.errors })
      } else {
        console.log('[App] Analysis inputs not ready; result discarded', { runId })
      }
    }
  }

  // Auto-calculate candidate open area once all screening inputs are terminal
  useEffect(() => {
    const mcpi = selectedParcel?.feature?.properties?.PA_MCPI || ''
    if (!mcpi || !selectedParcel || !existingConditions || isAutoCalculatingOpenAreaRef.current) return

    const terminal =
      existingConditions.buildings?.state !== 'loading' && existingConditions.buildings?.state != null &&
      existingConditions.hydrology?.state !== 'loading' && existingConditions.hydrology?.state != null &&
      existingConditions.pavement?.state !== 'loading' && existingConditions.pavement?.state != null &&
      existingConditions.intersectingStreets?.state !== 'loading' && existingConditions.intersectingStreets?.state != null &&
      existingConditions.nearbyStreets?.state !== 'loading' && existingConditions.nearbyStreets?.state != null &&
      existingConditions.parcelBoundary?.state !== 'loading' && existingConditions.parcelBoundary?.state != null &&
      terrainScreeningStatus !== 'pending'

    if (!terminal) return

    // Already have a result for this parcel
    if (candidateOpenAreaResult && candidateOpenAreaResult.mcpi === mcpi) return

    const runId = currentAnalysisRunIdRef.current + 1
    currentAnalysisRunIdRef.current = runId
    setAnalysisRunId(runId)
    isAutoCalculatingOpenAreaRef.current = true

    const coaInputs = {
      parcelGeometry: selectedParcel.feature.geometry,
      parcelGisAcreage: selectedParcel.feature.properties?.PA_GIS_ACRE ?? null,
      mcpi,
      buildingFeatures: existingConditions.buildings?.features || [],
      streetFeatures: [
        ...(existingConditions.intersectingStreets?.features || []),
        ...(existingConditions.nearbyStreets?.features || [])
      ],
      hydrologyFeatures: existingConditions.hydrology?.features || null,
      pavementFeatures: existingConditions.pavement?.features || null,
      analysisRunId: runId
    }

    calculateCandidateOpenArea(coaInputs)
      .then(result => {
        if (runId === currentAnalysisRunIdRef.current) {
          handleCandidateOpenAreaResult(result, runId)
        }
      })
      .catch(err => {
        if (runId === currentAnalysisRunIdRef.current) {
          const failed = createFailedResult(
            mcpi,
            coaInputs.parcelGisAcreage,
            [String(err?.message || err || 'Candidate open area auto-calculation failed')],
            runId
          )
          handleCandidateOpenAreaResult(failed, runId)
        }
      })
      .finally(() => {
        isAutoCalculatingOpenAreaRef.current = false
      })
  }, [selectedParcel, existingConditions, terrainScreeningStatus, candidateOpenAreaResult])

  // Handle analysis start - generate and store authoritative run ID before analysis begins
  const handleAnalysisStart = (): { runId: number, signal: AbortSignal } | null => {
    // Reject duplicate clicks synchronously before any state or controller is created
    if (analysisInFlightRef.current) {
      return null
    }

    workflowCriticalPath.start('analysisInitialization')

    // Abort any older analysis before starting a new run
    if (analysisAbortControllerRef.current) {
      analysisAbortControllerRef.current.abort()
      analysisAbortControllerRef.current = null
    }

    const newRunId = currentAnalysisRunIdRef.current + 1
    currentAnalysisRunIdRef.current = newRunId
    setAnalysisRunId(newRunId)
    setIsAnalysisRunning(true)
    analysisStartTimeRef.current = Date.now()
    analysisInFlightRef.current = true

    generationPerformance.reset()
    recomputeCounter.reset(newRunId)
    recomputeCounter.setWorkflowRunId(newRunId)
    workflowResultCache.reset(newRunId)
    workflowResultCache.setWorkflowRunId(newRunId)
    diagnosticOverhead.reset()
    networkCounter.reset()
    turfCounter.reset()
    workflowTimeline.reset()
    workflowCriticalPath.reset()
    strictModeExecutionInputsRef.current = { program: [], localStreet: [], townhome: [] }
    workflowCriticalPath.mark('userAnalyzeClick', userPerceivedWorkflow.get().userAnalyzeClickTimestamp)
    workflowCriticalPath.start('analyzeClicked')
    workflowTimeline.mark('analyzeClick')
    if (existingConditions) {
      workflowCriticalPath.mark('existingConditions')
      workflowTimeline.mark('existingConditionsReady')
    }
    generationPerformance.startTotal()
    generationPerformance.start('parcelAnalysis')

    const controller = new AbortController()
    analysisAbortControllerRef.current = controller

    workflowCriticalPath.ready('analysisInitialization')
    return { runId: newRunId, signal: controller.signal }
  }

  const logConceptSelectionState = (
    event: string,
    requestedAlternativeId: ConceptStrategy | null,
    alternatives: ConceptAlternativeResult[] | null,
    overrides: {
      generatingAlternativeId?: ConceptStrategy | null
      authoritativeAlternativeId?: ConceptStrategy | null
      selectedAlternativeId?: ConceptStrategy | null
      recommendedAlternativeId?: ConceptStrategy | null
      runId?: number | null
    } = {}
  ) => {
    if (!import.meta.env.DEV) return
    const currentMCPI = normalizeMCPI(getCurrentMCPI())
    const gen = overrides.generatingAlternativeId ?? generatingAlternativeId
    const auth = overrides.authoritativeAlternativeId ?? authoritativeAlternativeId
    const sel = overrides.selectedAlternativeId ?? selectedAlternativeId
    const rec = overrides.recommendedAlternativeId ?? recommendedAlternativeId
    const cacheKeys = getConceptCacheKeysForMcpi(currentMCPI)
    const alts = (alternatives ?? []).map(a => ({
      id: a.id,
      status: a.status,
      isAuthoritative: a.metrics.isAuthoritative,
      isSelected: a.id === auth,
      cached: cacheKeys.some(k => k.split('|')[1] === a.id)
    }))
    const visibleSelectedCount = alts.filter(a => a.isSelected).length
    const audit = {
      event,
      requestedAlternativeId,
      generatingAlternativeId: gen,
      authoritativeAlternativeId: auth,
      selectedAlternativeId: sel,
      recommendedAlternativeId: rec,
      alternatives: alts,
      cacheKeysForCurrentParcel: cacheKeys,
      runId: overrides.runId ?? null,
      visibleSelectedCount,
      invariant: visibleSelectedCount === 1 ? 'OK' : 'VIOLATION'
    }
    
    if (visibleSelectedCount !== 1) {
      console.error('[ConceptSelectionInvariantViolation]', {
        expectedSelectedId: auth,
        visibleSelectedCount
      })
    }
  }

  const activateAuthoritativeConcept = (bundle: AuthoritativeConceptResult, requestedId: ConceptStrategy) => {
    if (!bundle) return
    setConceptualRoadResult(bundle.primaryRoadResult)
    setSecondaryRoadNetworkResult(bundle.secondaryRoadNetworkResult)
    setDevelopmentOpportunityBlockResult(bundle.developmentOpportunityBlockResult)
    setConceptualProgram(bundle.conceptualProgram)
    setRedevelopmentImpact(bundle.redevelopmentImpact ?? null)
    setLocalStreetExpansion({ localStreetNetworkResult: bundle.localStreetNetworkResult, finalLayout: bundle.selectedFinalLayout })
    setTownhomeGenerationResult(bundle.townhomeGenerationResult)
    setTerrainSuitability(bundle.terrainSuitability)
    canonicalProjectParametersRef.current = bundle.parameters
    const currentAlternatives = conceptAlternatives ?? []
    const bundleAlternatives = bundle.alternatives ?? []
    const byId = new Map<ConceptStrategy, ConceptAlternativeResult>()
    for (const a of currentAlternatives) byId.set(a.id, a)
    for (const a of bundleAlternatives) {
      if (a.id === requestedId || !byId.has(a.id)) byId.set(a.id, a)
    }
    const merged = Array.from(byId.values())
    const candidateArea = candidateOpenAreaResult?.candidateAreaAcres ?? 0
    const scored = merged.map(a => ({
      ...a,
      comparisonScore: scoreAlternative(a, candidateArea)
    }))
    const nextRecommended = recommendAlternativeId(scored, parcelFeasibilityAssessment)
    const final = scored.map(a => ({
      ...a,
      selected: a.id === requestedId,
      recommended: a.id === nextRecommended
    }))
    setConceptAlternatives(final)
    setRecommendedAlternativeId(nextRecommended)
    setSelectedAlternativeId(requestedId)
    setAuthoritativeAlternativeId(requestedId)
    if (requestedId === 'BALANCED') {
      balancedSnapshotRef.current = bundle
    }
    logConceptSelectionState('activate-authoritative', requestedId, final, {
      generatingAlternativeId: null,
      authoritativeAlternativeId: requestedId,
      selectedAlternativeId: requestedId,
      recommendedAlternativeId: nextRecommended,
      runId: bundle.generationRunId
    })
  }

  const commitAuthoritativeConceptResult = (bundle: AuthoritativeConceptResult, runId: number, controller: AbortController) => {
    if (controller.signal.aborted) {
      if (VERBOSE_GIS_DIAGNOSTICS) console.log('[AuthoritativeConcept] commit skipped: aborted', { runId })
      setGenerationStatus('aborted')
      return
    }
    if (runId !== currentRoadGenerationRunIdRef.current) {
      if (VERBOSE_GIS_DIAGNOSTICS) console.log('[AuthoritativeConcept] commit skipped: stale', { runId, current: currentRoadGenerationRunIdRef.current })
      return
    }
    activateAuthoritativeConcept(bundle, bundle.authoritativeAlternativeId)
    setRoadGenerationError(null)
    setGenerationStatus('complete')
    roadGenerationInFlightRef.current = false
    setIsRoadGenerating(false)
    setIsAlternativeGenerating(false)
    setGeneratingAlternativeId(null)
  }

  const failAuthoritativeConceptResult = (runId: number, error: any, controller: AbortController) => {
    if (controller.signal.aborted) {
      setGenerationStatus('aborted')
      return
    }
    if (runId !== currentRoadGenerationRunIdRef.current) return
    setRoadGenerationError(error?.message || 'Concept generation failed.')
    setGenerationStatus('failed')
    roadGenerationInFlightRef.current = false
    setIsRoadGenerating(false)
    setIsAlternativeGenerating(false)
    setGeneratingAlternativeId(null)
  }

  // Handle road skeleton generation
  const handleGenerateRoadSkeleton = async (targetAlternativeId: ConceptStrategy = 'BALANCED') => {
    if (
      roadGenerationInFlightRef.current ||
      !candidateOpenAreaResult ||
      !selectedParcel ||
      !existingConditions ||
      !submittedParameters
    ) {
      return
    }

    const parameters = canonicalProjectParametersRef.current ?? submittedParameters.parameters
    const currentMCPI = normalizeMCPI(getCurrentMCPI())
    const candidateMCPI = normalizeMCPI(candidateOpenAreaResult.mcpi)
    if (currentMCPI !== candidateMCPI) {
      setRoadGenerationError('Candidate Open Area does not match the selected parcel.')
      return
    }

    if (roadGenerationAbortControllerRef.current) {
      roadGenerationAbortControllerRef.current.abort()
      roadGenerationAbortControllerRef.current = null
    }
    if (localStreetAbortControllerRef.current) {
      localStreetAbortControllerRef.current.abort()
      localStreetAbortControllerRef.current = null
    }
    currentLocalStreetRunIdRef.current += 1

    setGenerationStatus('generating')
    setLocalStreetExpansion(null)
    setTownhomeGenerationResult(null)

    const newRunId = currentRoadGenerationRunIdRef.current + 1
    currentRoadGenerationRunIdRef.current = newRunId
    roadGenerationInFlightRef.current = true
    setIsRoadGenerating(true)
    setRoadGenerationError(null)

    const controller = new AbortController()
    roadGenerationAbortControllerRef.current = controller

    const target: ConceptStrategy = targetAlternativeId
    const startingAlternatives = conceptAlternatives
    const startingRecommended = recommendedAlternativeId

    try {
      const bundle = await generateAuthoritativeConcept({
        mcpi: currentMCPI,
        analysisRunId: candidateOpenAreaResult.analysisRunId,
        parcelGeometry: selectedParcel.feature.geometry,
        candidateOpenArea: candidateOpenAreaResult,
        existingConditions,
        terrainData,
        projectParameters: parameters,
        parcelFeasibilityAssessment,
        parcelAreaAcres,
        existingAlternatives: startingAlternatives,
        targetAlternativeId: target,
        recommendedAlternativeId: startingRecommended
      }, controller.signal, newRunId)
      commitAuthoritativeConceptResult(bundle, newRunId, controller)
    } catch (error: any) {
      failAuthoritativeConceptResult(newRunId, error, controller)
    } finally {
      if (roadGenerationAbortControllerRef.current === controller) {
        roadGenerationAbortControllerRef.current = null
      }
      if (localStreetAbortControllerRef.current === controller) {
        localStreetAbortControllerRef.current = null
      }
    }
  }

  // Handle confirmed analysis reset (called when user confirms Reset button in ParametersPanel)
  const handleConfirmedAnalysisReset = () => {
    // Abort any in-flight analysis requests
    if (analysisAbortControllerRef.current) {
      analysisAbortControllerRef.current.abort()
      analysisAbortControllerRef.current = null
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // Invalidate analysis request ID
    analysisRequestIdRef.current += 1
    
    // Clear analysis output state
    setCandidateOpenAreaResult(null)
    setSubmittedParameters(null)
    setIsAnalysisRunning(false)
    analysisInFlightRef.current = false

    // Clear any generated road skeleton
    clearRoadGeneration()
    
    // Keep selectedParcel and currentStep unchanged
    // The local form is already reset by ParametersPanel
  }

  // Handle open draft (called when user opens a draft from gallery)
  const handleOpenDraft = async (mcpi: string) => {
    try {
      // Find the draft in the drafts array
      const draft = drafts.find(d => d.mcpi === mcpi)
      if (!draft) {
        console.error('[App] Draft not found for MCPI:', mcpi)
        alert('Could not find the draft for this parcel.')
        return
      }

      // Clear any previous pending draft so the currently mounted ParametersPanel
      // does not consume a new draft before the view transitions.
      setPendingDraftToRestore(null)
      
      // Close the catalog
      setShowDraftsCatalog(false)
      
      // Block analysis until manual run
      setSuppressAnalysis(true)
      
      // Abort any ongoing analysis
      if (analysisAbortControllerRef.current) {
        analysisAbortControllerRef.current.abort()
        analysisAbortControllerRef.current = null
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      // Clear analysis state and invalidate any previous analysis run
      setCandidateOpenAreaResult(null)
      setSubmittedParameters(null)
      setIsAnalysisRunning(false)
      analysisInFlightRef.current = false
      analysisAbortControllerRef.current = null
      analysisRequestIdRef.current += 1
      const newAnalysisRunId = currentAnalysisRunIdRef.current + 1
      currentAnalysisRunIdRef.current = newAnalysisRunId
      setAnalysisRunId(newAnalysisRunId)

      // Clear any generated road skeleton and invalidate the generation run
      clearRoadGeneration()
      setSecondaryRoadNetworkResult(null)
      setDevelopmentOpportunityBlockResult(null)

      if (VERBOSE_GIS_DIAGNOSTICS) {
        console.log('[DraftLoad]', {
          draftId: draft.draftId,
          mcpi: draft.mcpi,
          parameterSource: 'explicit-draft'
        })
      }
      
      // DO NOT call resetParcelWorkflow() - this triggers default parameter loading
      // which would overwrite the draft parameters
      // DO NOT call beginNewParcelWorkflow() - this also calls resetParcelWorkflow()
      
      // Fetch and select the parcel directly
      const feature = await fetchParcelByMCPI(mcpi)
      if (feature && feature.geometry) {
        // Manually select the parcel without triggering workflow reset
        const parcelId = getParcelId(feature)
        
        // Abort any ongoing selection requests
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
        }
        
        // Invalidate selection request ID
        selectionRequestIdRef.current += 1
        
        // Create new abort controller for this selection
        const requestId = ++selectionRequestIdRef.current
        const abortController = new AbortController()
        abortControllerRef.current = abortController
        
        const conditionMcpi = normalizeMCPI(feature.properties?.PA_MCPI || mcpi)
        const conditionRunId = requestId

        // Immediately set the new selection with the feature
        setSelectedParcel({
          id: parcelId,
          feature,
          details: null,
          addresses: [],
          selectionRequestId: requestId
        })
        setCurrentStep('select')
        setExistingConditions(null)
        
        // Fit map to parcel bounds (suppressed while a generation is in-flight)
        if (!roadGenerationInFlightRef.current && mapRef.current && feature.geometry) {
          const geoJSONLayer = L.geoJSON(feature as any)
          const bounds = geoJSONLayer.getBounds()
          if (bounds.isValid()) {
            mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 })
          }
        }
        
        // Create initial existing conditions placeholder
        const analysisTimestamp = new Date().toISOString()
        setExistingConditions({
          buildings: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'loading',
            count: 0,
            features: [],
            timestamp: analysisTimestamp
          },
          intersectingStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'loading',
            count: 0,
            features: [],
            uniqueNames: [],
            timestamp: analysisTimestamp
          },
          nearbyStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'loading',
            count: 0,
            additionalCount: 0,
            features: [],
            uniqueNames: [],
            timestamp: analysisTimestamp
          },
          hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'loading',
            count: 0,
            waterFeatureCount: 0,
            wetlandFeatureCount: 0,
            streamDrainCount: 0,
            hydrologyCoverageAvailable: false,
            features: { source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false },
            timestamp: analysisTimestamp
          },
          pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
            state: 'loading',
            count: 0,
            parkingLotFeatureCount: 0,
            drivewayFeatureCount: 0,
            pavementCoverageAvailable: false,
            features: { source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false },
            timestamp: analysisTimestamp
          },
          parcelBoundary: {
            state: 'loading',
            timestamp: analysisTimestamp
          },
          analysisTimestamp
        })
        
        // Helper to extract unique street names
        const extractUniqueStreetNames = (features: any[]): string[] => {
          const names = new Set<string>()
          features.forEach(f => {
            const name = f.properties?.ST_FULLNAME || f.properties?.ST_STR_NAME
            if (name) names.add(name)
          })
          return Array.from(names).sort()
        }
        
        // Fetch existing conditions data
        Promise.all([
          Promise.resolve(feature),
          fetchAddressesByMCPI(feature.properties?.PA_MCPI, abortController.signal),
          fetchBuildingsByParcel(feature.geometry, abortController.signal).then(buildings => {
            const state: 'success' | 'success-zero' = buildings.length > 0 ? 'success' : 'success-zero'
            return { buildings, state, error: undefined as string | undefined }
          }).catch(err => {
            if (err.name === 'AbortError') {
              return { buildings: [], state: 'aborted' as const, error: undefined as string | undefined }
            }
            console.error('Failed to fetch buildings:', err)
            return { buildings: [], state: 'error' as const, error: err.message as string }
          }),
          fetchIntersectingStreets(feature.geometry, abortController.signal).then(streets => {
            const state: 'success' | 'success-zero' = streets.length > 0 ? 'success' : 'success-zero'
            const uniqueNames = extractUniqueStreetNames(streets)
            return { streets, state, uniqueNames, error: undefined as string | undefined }
          }).catch(err => {
            if (err.name === 'AbortError') {
              return { streets: [], state: 'aborted' as const, uniqueNames: [], error: undefined as string | undefined }
            }
            console.error('Failed to fetch intersecting streets:', err)
            return { streets: [], state: 'error' as const, uniqueNames: [], error: err.message as string }
          }),
          fetchNearbyStreets(feature.geometry, abortController.signal).then(streets => {
            const state: 'success' | 'success-zero' = streets.length > 0 ? 'success' : 'success-zero'
            const uniqueNames = extractUniqueStreetNames(streets)
            return { streets, state, uniqueNames, error: undefined as string | undefined }
          }).catch(err => {
            if (err.name === 'AbortError') {
              return { streets: [], state: 'aborted' as const, uniqueNames: [], error: undefined as string | undefined }
            }
            console.error('Failed to fetch nearby streets:', err)
            return { streets: [], state: 'error' as const, uniqueNames: [], error: err.message as string }
          }),
          (() => {
            const draftMcpi = mcpi
            
            return fetchHydrologyObstacles(feature.geometry, feature.properties?.PA_MCPI || draftMcpi, abortController.signal)
          })().then(hydrology => {
            
            const state: 'success' | 'success-zero' | 'error' = hydrology.hydrologyCoverageAvailable ? 'success' : 'error'
            return { hydrology, state, error: hydrology.fetchError as string | undefined }
          }).catch(err => {
            if (err.name === 'AbortError') {
              return { hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false }, state: 'aborted' as const, error: undefined as string | undefined }
            }
            console.error('Failed to fetch hydrology:', err)
            return { hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', waterBodyFeatures: [], wetlandFeatures: [], streamDrainFeatures: [], hydrologyCoverageAvailable: false }, state: 'error' as const, error: err.message as string }
          }),
        (() => {
            
            return fetchExistingPavementSurfaces(feature.geometry, mcpi || '', abortController.signal)
          })().then(pavement => {
            
            const state: 'success' | 'success-zero' | 'error' = pavement.pavementCoverageAvailable ? 'success' : 'error'
            return { pavement, state, error: pavement.fetchError as string | undefined }
          }).catch(err => {
            if (err.name === 'AbortError') {
              return { pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false }, state: 'aborted' as const, error: undefined as string | undefined }
            }
            console.error('Failed to fetch pavement:', err)
            return { pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId, source: 'loudoun-gis', features: [], parkingLotFeatureCount: 0, drivewayFeatureCount: 0, totalFeatureCount: 0, pavementCoverageAvailable: false }, state: 'error' as const, error: err.message as string }
          })
        ]).then(([_, addresses, buildingsResult, intersectingResult, nearbyResult, hydrologyResult, pavementResult]) => {
          // Only update if this is still the current selection
          if (requestId === selectionRequestIdRef.current) {
            // Calculate additional nearby streets (exclude intersecting by OBJECTID)
            const intersectingObjectIds = new Set(intersectingResult.streets.map((s: any) => s.properties?.OBJECTID))
            const additionalStreets = nearbyResult.streets.filter((s: any) => !intersectingObjectIds.has(s.properties?.OBJECTID))
            
            setSelectedParcel(prev => {
              if (prev && prev.id === parcelId) {
                return {
                  ...prev,
                  details: feature.properties,
                  addresses
                }
              }
              return prev
            })

            setExistingConditions({
              buildings: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
                state: buildingsResult.state,
                count: buildingsResult.buildings.length,
                features: buildingsResult.buildings,
                timestamp: analysisTimestamp,
                error: buildingsResult.error
              },
              intersectingStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
                state: intersectingResult.state,
                count: intersectingResult.streets.length,
                features: intersectingResult.streets,
                uniqueNames: intersectingResult.uniqueNames,
                timestamp: analysisTimestamp,
                error: intersectingResult.error
              },
              nearbyStreets: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
                state: nearbyResult.state,
                count: nearbyResult.streets.length,
                additionalCount: additionalStreets.length,
                features: nearbyResult.streets,
                uniqueNames: nearbyResult.uniqueNames,
                timestamp: analysisTimestamp,
                error: nearbyResult.error
              },
              hydrology: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
                state: hydrologyResult.state,
                count: hydrologyResult.hydrology.waterBodyFeatures.length + hydrologyResult.hydrology.wetlandFeatures.length + hydrologyResult.hydrology.streamDrainFeatures.length,
                waterFeatureCount: hydrologyResult.hydrology.waterBodyFeatures.length,
                wetlandFeatureCount: hydrologyResult.hydrology.wetlandFeatures.length,
                streamDrainCount: hydrologyResult.hydrology.streamDrainFeatures.length,
                hydrologyCoverageAvailable: hydrologyResult.hydrology.hydrologyCoverageAvailable,
                features: hydrologyResult.hydrology,
                timestamp: analysisTimestamp,
                error: hydrologyResult.error
              },
              pavement: { mcpi: conditionMcpi, selectionRequestId: conditionRunId,
                state: pavementResult.state,
                count: pavementResult.pavement.totalFeatureCount,
                parkingLotFeatureCount: pavementResult.pavement.parkingLotFeatureCount,
                drivewayFeatureCount: pavementResult.pavement.drivewayFeatureCount,
                pavementCoverageAvailable: pavementResult.pavement.pavementCoverageAvailable,
                features: pavementResult.pavement,
                timestamp: analysisTimestamp,
                error: pavementResult.error
              },
              parcelBoundary: {
                state: 'success',
                timestamp: analysisTimestamp
              },
              analysisTimestamp
            })

            // Stage the draft and bump the restoration transaction only now,
            // after the old ParametersPanel has unmounted and the new one is
            // about to mount. This prevents the old panel from consuming the
            // transaction before the view transition completes.
            setPendingDraftToRestore(draft)
            setDraftRestoreVersion((prev: number) => prev + 1)

            // Navigate to Parameters step after data is loaded
            setCurrentStep('parameters')
          }
        }).catch(err => {
          if (err.name !== 'AbortError') {
            console.error('Failed to fetch existing conditions for draft:', err)
          }
        })
      } else {
        console.error('[App] Failed to load parcel for draft: invalid geometry or no feature')
        alert('Could not load the parcel for this draft. The parcel may no longer exist in the database.')
        setPendingDraftToRestore(null)
        setSuppressAnalysis(false)
        setCurrentStep('select')
        return
      }
      
    } catch (error) {
      console.error('[App] Failed to load parcel for draft:', error)
      alert('Could not load the parcel for this draft. Please try again later.')
      setPendingDraftToRestore(null)
      setSuppressAnalysis(false)
      setCurrentStep('select')
    }
  }

  // Draft save handler (delegated to SavedDraftsCatalog)
  const handleSaveDraft = (mcpi: string, parcelAddress: string | null, parcelMetadata: any, parameters: ProjectParameters) => {
    saveDraft(mcpi, parcelAddress, parcelMetadata, parameters)
  }

  // Handle draft restoration confirmation from ParametersPanel
  const handleDraftRestored = () => {
    setPendingDraftToRestore(null)
    setDraftRestoreVersion((prev: number) => prev + 1)
    
  }

  const handleAnalysisButtonStatusChange = (status: 'idle' | 'running' | 'complete' | 'dirty' | 'error') => {
    if (status !== 'complete') {
      clearRoadGeneration()
    }
  }

  // Handle parameters saved - capture submitted parameters for analysis
  const handleParametersSaved = (parameters: ProjectParameters) => {
    // Keep current step as 'parameters' to allow analysis to run in place
    // Do not navigate to 'existing-conditions' placeholder

    // Clear analysis suppression - user explicitly requested analysis
    setSuppressAnalysis(false)

    // Capture submitted parameters snapshot
    const currentMCPI = getCurrentMCPI()
    if (currentMCPI) {
      setSubmittedParameters({
        parameters,
        mcpi: currentMCPI,
        analysisRunId: currentAnalysisRunIdRef.current,
        submittedAt: new Date().toISOString()
      })
      canonicalProjectParametersRef.current = parameters
    }
  }

  // Clear candidate open area when parcel changes
  useEffect(() => {
    setCandidateOpenAreaResult(null)
  }, [selectedParcel?.id])

  // Update sidebar width based on current step
  useEffect(() => {
    if (currentStep === 'parameters') {
      setSidebarWidth(400)
    } else {
      setSidebarWidth(320)
    }
  }, [currentStep])

  // Invalidate map size when sidebar width changes - with safety guards
  useEffect(() => {
    const safelyInvalidateMap = () => {
      const map = mapRef.current
      if (!map) return

      const container = map.getContainer?.()

      if (
        !container ||
        !container.isConnected ||
        !map.getPane("mapPane")
      ) {
        console.warn("[App] Skipped invalidateSize: map is not mounted")
        return
      }

      requestAnimationFrame(() => {
        const currentMap = mapRef.current
        const currentContainer = currentMap?.getContainer?.()

        if (
          currentMap &&
          currentContainer?.isConnected &&
          currentMap.getPane("mapPane")
        ) {
          currentMap.invalidateSize({
            pan: false,
            animate: false
          })
        }
      })
    }

    safelyInvalidateMap()
  }, [sidebarWidth])

  // Normalize MCPI values for comparison
  const normalizeMCPI = (value: unknown) =>
    String(value ?? '').replace(/\D/g, '').padStart(12, '0')
  const round2 = (n: number) => Math.round(n * 100) / 100


  const baseLayout: ConceptualDevelopmentLayoutResult | null = localStreetExpansion?.finalLayout ?? null
  const localStreetNetworkResult: LocalStreetNetworkResult | null = localStreetExpansion?.localStreetNetworkResult ?? null


  const conceptualLayout: ConceptualDevelopmentLayoutResult | null = useMemo(
    () => (baseLayout ? { ...baseLayout, townhomeGenerationResult } : null),
    [baseLayout, townhomeGenerationResult]
  )

  useEffect(() => {
    if (!import.meta.env.DEV) return

    const local = localStreetNetworkResult
    if (local) {
      const candidateCount = local.candidateAudits?.length ?? 0
      const hardValidCandidateCount = local.candidateAudits?.filter(c => !c.rejectionReason || c.rejectionReason === '').length ?? 0
      
    }

    if (conceptualLayout) {
      
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    localStreetNetworkResult?.mcpi,
    localStreetNetworkResult?.status,
    localStreetNetworkResult?.localStreetCount,
    localStreetNetworkResult?.candidateAudits?.length,
    localStreetNetworkResult?.stopReason,
    conceptualLayout?.mcpi,
    conceptualLayout?.status,
    conceptualLayout?.lotCount,
    conceptualLayout?.buildingEnvelopeCount,
    conceptualLayout?.unusedProgrammableAreaAcres
  ])

  // Stable townhome generation audit logging (once per meaningful result)
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const th = conceptualLayout?.townhomeGenerationResult
    if (!th || th.status === 'skipped') return

    const key = `${th.mcpi}|${th.rowCount}|${th.unitCount}|${th.audit?.acceptedRows ?? -1}`
    if (lastTownhomeAuditKeyRef.current === key) return
    lastTownhomeAuditKeyRef.current = key

    const a = th.audit
    

    const accepted = a.rowAudits.filter(r => r.accepted)
    const rejected = a.rowAudits.filter(r => !r.accepted)
    

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[TownhomeFrontageAudit]', a.frontageAudit)
      console.log('[TownhomeRowAdjacencyAudit]', a.adjacencyAudit)
      console.log('[TownhomeCandidateRankingAudit]', a.rankingAudit)
      console.log('[TownhomeRoadHierarchyAudit]', a.roadHierarchyAudit)
      console.log('[TownhomeTerrainAudit]', a.terrainAudit)
      console.log('[TownhomeAcceptanceRateAudit]', a.acceptanceRateAudit)
      console.log('[TownhomeRowGroupAudit]', a.rowGroups)
      console.log('[TownhomeVisualSanitySummary]', a.visualSanitySummary)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conceptualLayout?.townhomeGenerationResult?.mcpi,
    conceptualLayout?.townhomeGenerationResult?.rowCount,
    conceptualLayout?.townhomeGenerationResult?.unitCount,
    conceptualLayout?.townhomeGenerationResult?.audit?.acceptedRows
  ])

  // Stable end-of-pipeline consolidated audit logging (one per workflowRunId)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const workflowRunId = currentAnalysisRunIdRef.current
    const mcpi = localStreetExpansion?.finalLayout?.mcpi ?? conceptualLayout?.mcpi ?? selectedParcel?.feature?.properties?.PA_MCPI
    if (!mcpi || isRoadGenerating || isAnalysisRunning) return
    if (!localStreetExpansion?.finalLayout) return
    if (lastPipelineAuditKeyRef.current === String(workflowRunId)) return
    lastPipelineAuditKeyRef.current = String(workflowRunId)

    const timings = generationPerformance.get()
    const allStages = Object.entries(timings)
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
    const slowestCumulativeStage = allStages[0]?.[0] ?? ''
    const secondSlowestStage = allStages[1]?.[0] ?? ''

    

    

    const rc = recomputeCounter.get()
    const observedDevFullLayouts = rc.layout ?? 0
    const baselineFullLayouts = rc['layout-baseline'] ?? 0
    const candidateFullLayouts = rc['layout-candidate'] ?? 0
    const selectedFinalFullLayouts = rc['layout-final'] ?? 0
    const otherFullLayouts = rc['layout-other'] ?? 0
    const uniqueSemanticFullLayouts = recomputeCounter.getUniqueCount('layout')
    const strictModeDuplicateFullLayouts = Math.max(0, observedDevFullLayouts - uniqueSemanticFullLayouts)
    const productionEquivalentFullLayouts = uniqueSemanticFullLayouts
    

    const network = networkCounter.get()
    

    workflowCriticalPath.start('mapLayerPreparation')
    workflowTimeline.mark('mapLayersReady')
    workflowCriticalPath.ready('mapLayerPreparation')
    userPerceivedWorkflow.markGenerateExportReady()
    workflowCriticalPath.ready('generateExportReady')
    workflowTimeline.mark('workflowReady')

    const upwForCompletion = userPerceivedWorkflow.get()
    
    const recomputeSnapshot = recomputeCounter.get()
    const bottleneckStages = Object.entries(timings)
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([stage, totalMs]) => ({
        stage,
        totalMs,
        percentOfWorkflow: upwForCompletion.userPerceivedWallClockMs > 0
          ? round2((totalMs / upwForCompletion.userPerceivedWallClockMs) * 100)
          : 0,
        executions: recomputeSnapshot[stage as keyof typeof recomputeSnapshot] ?? 0,
        uniqueSemanticExecutions: recomputeCounter.getUniqueCount(stage) ?? 0
      }))
    const largest = bottleneckStages[0]
    

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[TurfOperationAudit]', turfCounter.get())
      console.log('[TurfByStageAudit]', turfCounter.getByStage())
      console.log('[BooleanPipCallerAudit]', turfCounter.getByCaller())
    }
    const ordered = ['analyzeClick', 'existingConditionsReady', 'primaryRoadReady', 'secondaryRoadReady', 'developmentOpportunityReady', 'programReady', 'baselineLayoutReady', 'localStreetReady', 'selectedFinalLayoutReady', 'townhomeReady', 'mapLayersReady', 'workflowReady']
    if (VERBOSE_GIS_DIAGNOSTICS) {
      const tl = workflowTimeline.get()
      const marks = tl.marks
      const durations: Record<string, number> = {}
      for (let i = 1; i < ordered.length; i++) {
        const from = ordered[i - 1]
        const to = ordered[i]
        if (marks[from] !== undefined && marks[to] !== undefined) {
          durations[`${from}->${to}`] = round2(marks[to] - marks[from])
        }
      }
      const totalWallClockMs = marks.analyzeClick !== undefined && marks.workflowReady !== undefined
        ? round2(marks.workflowReady - marks.analyzeClick)
        : 0
      const cumulativeMeasuredGeneratorMs = round2(generationPerformance.getTotalMs())
      const unaccountedWallClockMs = round2(Math.max(0, totalWallClockMs - cumulativeMeasuredGeneratorMs))

      console.log('[EndToEndWorkflowAudit]', {
        workflowRunId,
        mcpi,
        durations,
        totalWallClockMs,
        largestGapMs: round2(tl.largestGapMs),
        largestGapBetween: tl.largestGapBetween,
        cumulativeMeasuredGeneratorMs,
        unaccountedWallClockMs
      })

      console.log('[WorkflowCriticalPathAudit]', {
        workflowRunId,
        mcpi,
        ...workflowCriticalPath.get()
      })
    }

    const upw = userPerceivedWorkflow.get()
    const wcp = workflowCriticalPath.get()
    const criticalPathStart = wcp.timestamps.userAnalyzeClick?.start ?? upw.userAnalyzeClickTimestamp
    const instrumentedCriticalPathMs = wcp.accountedWallClockMs
    const missingBeforeCriticalPathMs = round2(criticalPathStart - upw.userAnalyzeClickTimestamp)
    const idleGapMs = wcp.unaccountedWallClockMs
    const overlapMs = wcp.overlappingMeasuredMs
    const accountedStageMs = instrumentedCriticalPathMs
    const measurementErrorMs = round2(Math.max(0, upw.userPerceivedWallClockMs - (accountedStageMs + idleGapMs)))
    

    const tl = workflowTimeline.get()
    const stageKeys = Object.keys(tl.marks).sort((a, b) => tl.marks[a] - tl.marks[b])
    const endToEndStages = stageKeys.map((name, i) => {
      const startMs = tl.marks[name]
      const endMs = i < stageKeys.length - 1 ? tl.marks[stageKeys[i + 1]] : upw.generateExportReadyTimestamp || startMs
      return { name, startMs, endMs, durationMs: round2(endMs - startMs) }
    })
    

    

    const identityStages = ['existingConditions', 'candidateOpenArea', 'terrain', 'primaryRoad', 'secondaryRoad', 'opportunity', 'program', 'baselineLayout', 'localStreet', 'selectedFinalLayout', 'townhome', 'mapLayerPreparation']
    const identity = identityStages.map(stage => {
      const info = recomputeCounter.getAll()[stage]
      const exec = info?.requestCount ?? 0
      const unique = info?.uniqueSemanticRequestCount ?? 0
      const duplicates = Math.max(0, exec - unique)
      const primaryCause = duplicates <= 0 ? null : (info?.causes.strictModeReplay ?? 0) >= duplicates ? 'StrictMode' : 'stateDependencyRecompute'
      return {
        stage,
        executed: exec > 0,
        requestCount: exec,
        uniqueSemanticRequestCount: unique,
        actualGeneratorExecutionCount: info?.actualGeneratorExecutionCount ?? 0,
        cacheHitCount: info?.cacheHitCount ?? 0,
        duplicateSemanticExecutionCount: duplicates,
        semanticKeys: info?.uniqueKeys ?? [],
        causeOfEachDuplicate: duplicates > 0 ? primaryCause : null,
        strictModeReplayCount: info?.strictModeReplayCount ?? 0,
        stateDependencyRecomputeCount: info?.stateDependencyRecomputeCount ?? 0,
        actualProductionDuplicateCount: info?.actualProductionDuplicateCount ?? 0
      }
    })
    

    const dupOpt = workflowResultCache.getAudit()
    

    

    const pipeline = ordered.map((stage) => {
      const all = recomputeCounter.getAll()
      const info = all[stage]
      const exec = info?.requestCount ?? (generationPerformance.get()[stage] > 0 ? 1 : 0)
      const unique = info?.uniqueSemanticRequestCount ?? (exec > 0 ? 1 : 0)
      return {
        stage,
        executionCount: exec,
        uniqueSemanticInputCount: unique,
        duplicateSemanticExecutionCount: Math.max(0, exec - unique),
        cumulativeMs: round2(generationPerformance.get()[stage] ?? 0),
        maxSingleExecutionMs: round2(generationPerformance.getMax()[stage] ?? 0),
        semanticKeys: info?.uniqueKeys ?? [],
        callers: ['App.tsx']
      }
    })
    

    const turfByStage = turfCounter.getByStage()
    const perf = generationPerformance.get()
    const primaryTurf = turfByStage['primaryRoad'] || {}
    const primaryMs = perf['primaryRoad'] ?? 0
    const totalPrimaryTurf = Object.values(primaryTurf).reduce((s, v) => s + (v as number), 0)
    

    const stageDurations = wcp.stageDurations as { stage: string; durationMs: number }[]
    const baselineLayoutMs = stageDurations.find((s: { stage: string; durationMs: number }) => s.stage === 'baselineLayout')?.durationMs ?? perf['baselineLayout'] ?? 0
    const secondaryRoadMs = stageDurations.find((s: { stage: string; durationMs: number }) => s.stage === 'secondaryRoad')?.durationMs ?? perf['secondaryRoad'] ?? 0
    
    

    const townhomeTurf = turfByStage['townhome'] || {}
    const townhomeMs = perf['townhome'] ?? 0
    const acceptedRows = (townhomeGenerationResult as any)?.rows?.filter((r: any) => r.accepted)?.length ?? 0
    const totalUnits = (townhomeGenerationResult as any)?.rows?.reduce((sum: number, r: any) => sum + (r.unitEnvelopes?.length || 0), 0) ?? 0
    

    const baselineTurf = turfByStage['baselineLayout'] || {}
    const finalTurf = turfByStage['finalLayout'] || {}
    

    const map = mapRenderPerformance.get()
    

    const net = networkCounter.get()
    const netCategories = Object.keys(net.byCategory).map((cat) => {
      const count = net.byCategory[cat]
      const duplicateCount = net.duplicates[cat] ?? 0
      const totalMs = net.byCategoryMs[cat] ?? 0
      return {
        category: cat,
        requestCount: count,
        uniqueRequestCount: Math.max(0, count - duplicateCount),
        duplicateRequestCount: duplicateCount,
        totalNetworkMs: round2(totalMs),
        maxRequestMs: round2(net.byCategoryMaxMs[cat] ?? 0),
        averageRequestMs: count > 0 ? round2(totalMs / count) : 0
      }
    })
    

    const sm = strictModeExecutionInputsRef.current
    const buildStageAudit = (stage: 'program' | 'localStreet' | 'townhome') => {
      const inputs = sm[stage]
      const executionCount = inputs.length
      const unique = new Set(inputs.map(i => i.semanticInputKey))
      const uniqueSemanticInputCount = unique.size
      const sameSemanticInputsOnBothExecutions = executionCount === 2 && uniqueSemanticInputCount === 1
      return {
        workflowRunId,
        semanticInputKey: uniqueSemanticInputCount === 1 ? inputs[0]?.semanticInputKey ?? '' : [...unique].slice(0, 2).join(' || '),
        executionCount,
        uniqueSemanticInputCount,
        sameSemanticInputsOnBothExecutions,
        likelyStrictModeDoubleInvoke: sameSemanticInputsOnBothExecutions,
        likelyStrictModeDoubleInvokeReason: sameSemanticInputsOnBothExecutions ? 'STRICT_MODE_DEV_DOUBLE_INVOKE' : 'INPUTS_DIFFER_OR_COUNT_NE_2'
      }
    }
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStreetExpansion, isRoadGenerating, isAnalysisRunning])

  // Calculate whether the analysis bundle is current
  const analysisBundleIsCurrent = useMemo(() => {
    const currentRunId = currentAnalysisRunIdRef.current
    return (
      candidateOpenAreaResult !== null &&
      normalizeMCPI(candidateOpenAreaResult.mcpi) === normalizeMCPI(selectedParcel?.feature.properties?.PA_MCPI) &&
      candidateOpenAreaResult.analysisRunId === currentRunId &&
      !isAnalysisRunning
    )
  }, [candidateOpenAreaResult, selectedParcel, isAnalysisRunning, analysisRunId])

  // Clear road skeleton when the analysis bundle it depends on is no longer current
  useEffect(() => {
    if (!analysisBundleIsCurrent) {
      clearRoadGeneration()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisBundleIsCurrent])

  // Switch to a different strategy alternative
  const handleSelectAlternative = async (id: ConceptStrategy) => {
    if (!submittedParameters || !candidateOpenAreaResult || !selectedParcel || !existingConditions) return
    if (id === authoritativeAlternativeId) return

    if (id === 'BALANCED') {
      const snapshot = balancedSnapshotRef.current
      if (!snapshot) return
      activateAuthoritativeConcept(snapshot, 'BALANCED')
      setIsAlternativeGenerating(false)
      setGeneratingAlternativeId(null)
      return
    }

    const currentMCPI = normalizeMCPI(getCurrentMCPI())
    const strategyParams = deriveStrategyParameters(submittedParameters.parameters, id, parcelFeasibilityAssessment)
    const cached = getCachedAuthoritativeConcept(currentMCPI, id, strategyParams, candidateOpenAreaResult.analysisRunId)
    if (cached) {
      activateAuthoritativeConcept(cached, id)
      setIsAlternativeGenerating(false)
      setGeneratingAlternativeId(null)
      return
    }

    logConceptSelectionState('before-generation', id, conceptAlternatives, { generatingAlternativeId: id })
    setIsAlternativeGenerating(true)
    setGeneratingAlternativeId(id)
    canonicalProjectParametersRef.current = strategyParams
    await handleGenerateRoadSkeleton(id)
  }

  return (
    <div id="app-workspace" className="h-[100dvh] w-screen overflow-hidden bg-slate-900 flex flex-col">
      <header className="flex-shrink-0 z-50" style={{ background: 'var(--brand-gradient)' }}>
        <div className="px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--brand-black)' }}>
              <MapPin className="w-6 h-6" style={{ color: 'var(--seafoam)' }} />
            </div>
            <div>
              <h1 className="text-xl font-bold" style={{ color: '#ffffff' }}>SubDivMaker V2</h1>
              <p className="text-sm" style={{ color: 'var(--soft-seafoam)' }}>GIS Land Development Platform</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-sm" style={{ background: 'var(--brand-black)', color: 'var(--seafoam)', border: '1px solid var(--viridian)' }}>
              Pilot: Loudoun County, VA
            </span>
            <button
              type="button"
              onClick={() => setShowDraftsCatalog(true)}
              className="px-3 py-1 rounded-full text-sm transition-colors hover:opacity-80"
              style={{ background: 'var(--brand-black)', color: 'var(--seafoam)', border: '1px solid var(--viridian)' }}
            >
              Saved Drafts ({drafts.length})
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden flex">
        {/* Left sidebar - Sidebar for explore/select, ParametersPanel for parameters */}
        {currentStep === 'parameters' ? (
          <div className="w-[380px] min-w-[380px] flex-shrink-0 h-full overflow-hidden">
            <ParametersPanel
              parcelId={selectedParcel?.feature.properties?.PA_MCPI || ''}
              selectedSiteInfo={getSelectedSiteInfo()}
              onParametersSaved={handleParametersSaved}
              onMapResize={() => {}}
              onCandidateOpenAreaResult={handleCandidateOpenAreaResult}
              onAnalysisStart={handleAnalysisStart}
              onConfirmedAnalysisReset={handleConfirmedAnalysisReset}
              onSaveDraft={handleSaveDraft}
              analysisRunId={analysisRunId}
              parameterResetVersion={parameterResetVersion}
              submittedParameters={submittedParameters}
              isAnalysisRunning={isAnalysisRunning}
              parcelGeometry={selectedParcel?.feature.geometry || null}
              existingConditions={existingConditions}
              parentParcelAreaAcres={parcelAreaAcres}
              parcelFeasibilityAssessment={parcelFeasibilityAssessment}
              draftParametersToRestore={pendingDraftToRestore?.parameters ?? null}
              draftRestoreMCPI={pendingDraftToRestore?.mcpi ?? null}
              draftRestoreVersion={draftRestoreVersion}
              onDraftRestored={handleDraftRestored}
              suppressAnalysisUntilManualRun={suppressAnalysisUntilManualRun}
              onAnalysisButtonStatusChange={handleAnalysisButtonStatusChange}
              onGenerateRoadSkeleton={handleGenerateRoadSkeleton}
              onGenerateExportVisibilityChange={setShowGenerateExport}
              conceptualRoadResult={conceptualRoadResult}
              secondaryRoadNetworkResult={secondaryRoadNetworkResult}
              developmentOpportunityBlockResult={developmentOpportunityBlockResult}
              isRoadGenerating={isRoadGenerating || generationStatus === 'generating'}
              roadGenerationError={roadGenerationError}
              conceptualProgram={conceptualProgram}
              conceptualLayout={conceptualLayout}
              redevelopmentImpact={redevelopmentImpact}
              localStreetNetworkResult={localStreetNetworkResult}
              terrainSuitability={terrainSuitability}
              conceptAlternatives={conceptAlternatives}
              recommendedAlternativeId={recommendedAlternativeId}
              authoritativeAlternativeId={authoritativeAlternativeId}
              generatingAlternativeId={generatingAlternativeId}
              isAlternativeGenerating={isAlternativeGenerating}
              onSelectAlternative={handleSelectAlternative}
            />
          </div>
        ) : (
          <Sidebar
            selectedParcel={selectedParcel}
            onParcelSelect={handleParcelSelect}
            currentStep={currentStep}
            onStepChange={handleStepChange}
            canGenerate={analysisBundleIsCurrent}
            onGenerateRoadSkeleton={handleGenerateRoadSkeleton}
            conceptualRoadResult={conceptualRoadResult}
            secondaryRoadNetworkResult={secondaryRoadNetworkResult}
            developmentOpportunityBlockResult={developmentOpportunityBlockResult}
            isRoadGenerating={isRoadGenerating || generationStatus === 'generating'}
            roadGenerationError={roadGenerationError}
            conceptualProgram={conceptualProgram}
            conceptualLayout={conceptualLayout}
            redevelopmentImpact={redevelopmentImpact}
            terrainSuitability={terrainSuitability}
            parcelFeasibilityAssessment={parcelFeasibilityAssessment}
            parentParcelAreaAcres={parcelAreaAcres}
            conceptAlternatives={conceptAlternatives}
            recommendedAlternativeId={recommendedAlternativeId}
            authoritativeAlternativeId={authoritativeAlternativeId}
            generatingAlternativeId={generatingAlternativeId}
            isAlternativeGenerating={isAlternativeGenerating}
            onSelectAlternative={handleSelectAlternative}
          />
        )}

        {/* MapComponent - always mounted on the right */}
        <div className="min-w-0 flex-1 relative">
          <MapErrorBoundary>
            <MapComponent
              isRoadGenerating={isRoadGenerating || generationStatus === 'generating'}
              onParcelSelect={handleParcelSelect}
              selectedParcel={selectedParcel?.feature || null}
              onZoomChange={handleZoomChange}
              onMapReady={handleMapReady}
              existingConditions={existingConditions ? {
                buildings: existingConditions.buildings.features,
                intersectingStreets: existingConditions.intersectingStreets.features,
                nearbyStreets: existingConditions.nearbyStreets.features,
                pavement: existingConditions.pavement.features
              } : null}
              candidateOpenAreaGeometry={candidateOpenAreaResult?.candidateGeometry || null}
              buildingUnionGeometry={candidateOpenAreaResult?.buildingUnionGeometry || null}
              roadCorridorGeometry={candidateOpenAreaResult?.roadCorridorGeometry || null}
              hydrologyGeometry={candidateOpenAreaResult?.hydrologyGeometry || null}
              pavementGeometry={candidateOpenAreaResult?.pavementGeometry || null}
              candidateOpenAreaResult={candidateOpenAreaResult}
              showGeneralParcelOutlines={currentStep === 'explore'}
              selectedParcelMCPI={selectedParcel?.feature.properties?.PA_MCPI || ''}
              isAnalysisRunning={isAnalysisRunning}
              analysisBundleIsCurrent={analysisBundleIsCurrent}
              conceptualRoadResult={showGenerateExport ? conceptualRoadResult : null}
              secondaryRoadNetworkResult={showGenerateExport ? secondaryRoadNetworkResult : null}
              developmentOpportunityBlockResult={showGenerateExport ? developmentOpportunityBlockResult : null}
              terrainData={terrainData}
              terrainSuitability={terrainSuitability}
              conceptualProgram={showGenerateExport ? conceptualProgram : null}
              conceptualLayout={showGenerateExport ? conceptualLayout : null}
              localStreetNetworkResult={showGenerateExport ? localStreetNetworkResult : null}
            />
          </MapErrorBoundary>

          {/* Floating Search Bar - only show when not in parameters */}
          {currentStep !== 'parameters' && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000]">
              <SearchBar
                onAddressSelect={() => {}}
                onParcelSelect={handleParcelSelect}
                onNavigateToAddress={handleNavigateToAddress}
                onRegisterClear={(clearFn) => { searchClearRef.current = clearFn }}
              />
            </div>
          )}

          {/* Zoom Message - only show when not in parameters */}
          {currentStep !== 'parameters' && mapZoom < 15 && <ZoomMessage />}
        </div>
      </main>

      {/* Parcel Change Confirmation Dialog */}
      {showParcelChangeDialog && pendingParcelChange && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-[#0f172a] border border-slate-600 rounded-lg p-6 max-w-md w-full mx-4" style={{ background: 'var(--sidebar-gradient)', borderColor: 'var(--card-border)' }}>
            <h3 className="text-lg font-bold mb-4" style={{ color: '#ffffff' }}>Change selected parcel?</h3>
            <p className="text-sm mb-6" style={{ color: '#cbd5e1' }}>
              You currently have MCPI <span className="font-mono" style={{ color: 'var(--soft-seafoam)' }}>{getCurrentMCPI()}</span> selected. 
              Changing to MCPI <span className="font-mono" style={{ color: 'var(--soft-seafoam)' }}>{pendingParcelChange.feature.properties?.PA_MCPI || 'unknown'}</span> will clear the current parameters and analysis.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleCancelParcelChange}
                className="px-4 py-2 rounded border text-sm"
                style={{ 
                  background: 'transparent',
                  color: '#cbd5e1',
                  borderColor: 'var(--viridian)'
                }}
              >
                Keep Current Parcel
              </button>
              <button
                onClick={handleConfirmParcelChange}
                className="px-4 py-2 rounded text-sm font-medium"
                style={{ 
                  background: 'var(--seafoam)',
                  color: 'var(--brand-black)',
                  border: '1px solid var(--viridian)'
                }}
              >
                Change Parcel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Same-Parcel Restart Confirmation Dialog */}
      {showRestartDialog && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-[#0f172a] border border-slate-600 rounded-lg p-6 max-w-md w-full mx-4" style={{ background: 'var(--sidebar-gradient)', borderColor: 'var(--card-border)' }}>
            <h3 className="text-lg font-bold mb-4" style={{ color: '#ffffff' }}>Restart this parcel?</h3>
            <p className="text-sm mb-6" style={{ color: '#cbd5e1' }}>
              MCPI <span className="font-mono" style={{ color: 'var(--soft-seafoam)' }}>{getCurrentMCPI()}</span> is already selected. 
              Restarting will clear the current parameters and analysis and return you to the beginning of this parcel's workflow.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleCancelRestart}
                className="px-4 py-2 rounded border text-sm"
                style={{ 
                  background: 'transparent',
                  color: '#cbd5e1',
                  borderColor: 'var(--viridian)'
                }}
              >
                Keep Current Work
              </button>
              <button
                onClick={handleConfirmRestart}
                className="px-4 py-2 rounded text-sm font-medium"
                style={{ 
                  background: 'var(--seafoam)',
                  color: 'var(--brand-black)',
                  border: '1px solid var(--viridian)'
                }}
              >
                Restart Parcel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Saved Drafts Catalog */}
      <SavedDraftsCatalog
        isOpen={showDraftsCatalog}
        onClose={() => setShowDraftsCatalog(false)}
        onOpenDraft={handleOpenDraft}
        onDeleteDraft={deleteDraft}
        drafts={drafts}
      />
    </div>
  )
}

export default App
