import React, { useState, useEffect, useRef, useMemo } from 'react'
import { userPerceivedWorkflow, workflowCriticalPath } from '../lib/perf'
import { 
  ProjectParameters, 
  DevelopmentUse,
  ZoningLotParameters,
  RoadParameters,
  RoadNetworkPreference,
  AmenityParameters,
  ParkingParameters,
  GenerationPriorities,
  SelectedSiteInfo,
  CandidateOpenAreaResult,
  ConceptualRoadSkeletonResult,
  SecondaryRoadNetworkResult,
  DevelopmentOpportunityBlockResult,
  SubmittedParameters,
  DevelopmentApproach,
  RedevelopmentPreferences
} from '../types/parameters'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'
import type { TerrainSuitabilityResult } from '../types/terrain'
import { deriveRecommendedParameters, getSimplifiedFromProjectParameters, applySimplifiedToProjectParameters, SimplifiedParameters, SimplifiedDevelopmentIntensity } from '../services/recommendedParametersService'
import GenerateExportPanel from './GenerateExportPanel'
import { calculateCandidateOpenArea, createFailedResult } from '../services/candidateOpenAreaService'
import type { ConceptAlternativeResult, ConceptStrategy } from '../types/conceptAlternatives'
import type { RedevelopmentImpactMetrics } from '../lib/redevelopmentContext'
import ThemedSelect from './ThemedSelect'
import { flushSync } from 'react-dom'

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false

  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false

  for (const key of aKeys) {
    if (!bKeys.includes(key)) return false
    if (!deepEqual(a[key], b[key])) return false
  }
  return true
}

// Returns a plain, serializable object containing only the user-editable
// parameter values from a ProjectParameters record.  All non-editable and
// auto-generated fields are excluded, and optional values are normalized so
// the fingerprint is stable for equality checks.
function createEditableAnalysisFingerprint(parameters: ProjectParameters): any {
  const normalizeNum = (v: number | undefined): number | null => (v === undefined ? null : v)
  const normalizeStr = (v: string | undefined): string => (v ?? '')
  const normalizeBool = (v: boolean | undefined): boolean => !!v
  const normalizeArr = <T,>(arr: T[] | undefined): T[] => (arr ?? [])

  const zoningAndLots: any = parameters.zoningAndLots || {}
  const roads: any = parameters.roads || {}
  const parking: any = parameters.parking || {}
  const amenities: any = parameters.amenities || {}
  const terrainConstraints: any = parameters.terrainConstraints || {}
  const priorities: any = parameters.priorities || {}
  const existingFeatures: any = parameters.existingFeatures || {}

  const developmentProgram = normalizeArr(parameters.developmentProgram)
    .map((u: any) => ({
      category: normalizeStr(u.category),
      useType: normalizeStr(u.useType),
      enabled: normalizeBool(u.enabled),
      targetCount: normalizeNum(u.targetCount),
      minCount: normalizeNum(u.minCount),
      maxCount: normalizeNum(u.maxCount),
      priority: normalizeStr(u.priority),
      notes: normalizeStr(u.notes)
    }))
    .sort((a: any, b: any) => {
      const t = a.useType.localeCompare(b.useType)
      if (t !== 0) return t
      const c = a.category.localeCompare(b.category)
      if (c !== 0) return c
      const p = a.priority.localeCompare(b.priority)
      if (p !== 0) return p
      return a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1
    })

  return {
    developmentApproach: parameters.developmentApproach ?? 'NEW_DEVELOPMENT',
    redevelopment: {
      buildingTreatment: parameters.redevelopment?.buildingTreatment ?? 'SELECTIVE_REPLACEMENT',
      pavementTreatment: parameters.redevelopment?.pavementTreatment ?? 'SELECTIVE_RECONFIGURATION',
      internalRoadTreatment: parameters.redevelopment?.internalRoadTreatment ?? 'PRESERVE_ACCESS'
    },
    developmentProgram,
    zoningAndLots: {
      standardsSource: normalizeStr(zoningAndLots.standardsSource),
      targetDensity: normalizeNum(zoningAndLots.targetDensity),
      preferredLotSize: normalizeNum(zoningAndLots.preferredLotSize),
      buildingFootprintPreference: normalizeStr(zoningAndLots.buildingFootprintPreference),
      minLotArea: normalizeNum(zoningAndLots.minLotArea),
      minLotWidth: normalizeNum(zoningAndLots.minLotWidth),
      minFrontage: normalizeNum(zoningAndLots.minFrontage),
      frontSetback: normalizeNum(zoningAndLots.frontSetback),
      rearSetback: normalizeNum(zoningAndLots.rearSetback),
      sideSetback: normalizeNum(zoningAndLots.sideSetback),
      maxLotCoverage: normalizeNum(zoningAndLots.maxLotCoverage),
      floorAreaRatio: normalizeNum(zoningAndLots.floorAreaRatio),
      maxBuildingHeight: normalizeNum(zoningAndLots.maxBuildingHeight),
      maxStories: normalizeNum(zoningAndLots.maxStories),
      buildingSeparation: normalizeNum(zoningAndLots.buildingSeparation)
    },
    roads: {
      networkPreference: normalizeStr(roads.networkPreference),
      rightOfWayWidth: normalizeNum(roads.rightOfWayWidth),
      pavementWidth: normalizeNum(roads.pavementWidth),
      designSpeed: normalizeNum(roads.designSpeed),
      maxRoadGrade: normalizeNum(roads.maxRoadGrade),
      crossSlope: normalizeNum(roads.crossSlope),
      minCenterlineRadius: normalizeNum(roads.minCenterlineRadius),
      curbReturnRadius: normalizeNum(roads.curbReturnRadius),
      culdesacRadius: normalizeNum(roads.culdesacRadius),
      sidewalkWidth: normalizeNum(roads.sidewalkWidth),
      trailWidth: normalizeNum(roads.trailWidth),
      onStreetParking: normalizeBool(roads.onStreetParking),
      roadsidePlantingStrip: normalizeBool(roads.roadsidePlantingStrip),
      externalConnections: normalizeNum(roads.externalConnections),
      prioritizeExistingConnections: normalizeBool(roads.prioritizeExistingConnections),
      avoidSteepSlopes: normalizeBool(roads.avoidSteepSlopes),
      minimizeStreamCrossings: normalizeBool(roads.minimizeStreamCrossings),
      minimizeTotalPavement: normalizeBool(roads.minimizeTotalPavement),
      emergencyAccessPreference: normalizeStr(roads.emergencyAccessPreference)
    },
    parking: {
      parkingType: normalizeStr(parking.parkingType),
      spacesPerResidentialUnit: normalizeNum(parking.spacesPerResidentialUnit),
      spacesPer1000CommercialSqft: normalizeNum(parking.spacesPer1000CommercialSqft),
      accessibleSpaceTarget: normalizeNum(parking.accessibleSpaceTarget),
      garagePreference: normalizeStr(parking.garagePreference),
      surfaceParkingMax: normalizeNum(parking.surfaceParkingMax),
      sharedParkingAllowed: normalizeBool(parking.sharedParkingAllowed),
      bicycleParking: normalizeBool(parking.bicycleParking),
      evReadyPercentage: normalizeNum(parking.evReadyPercentage)
    },
    amenities: {
      minOpenSpaceAcreage: normalizeNum(amenities.minOpenSpaceAcreage),
      minOpenSpacePercentage: normalizeNum(amenities.minOpenSpacePercentage),
      park: normalizeBool(amenities.park),
      playground: normalizeBool(amenities.playground),
      trailNetwork: normalizeBool(amenities.trailNetwork),
      communityGreen: normalizeBool(amenities.communityGreen),
      retentionPond: normalizeBool(amenities.retentionPond),
      detentionFacility: normalizeBool(amenities.detentionFacility),
      bioretention: normalizeBool(amenities.bioretention),
      preservedForest: normalizeBool(amenities.preservedForest),
      landscapingBuffer: normalizeBool(amenities.landscapingBuffer),
      treeCanopyTarget: normalizeNum(amenities.treeCanopyTarget),
      streamBuffer: normalizeBool(amenities.streamBuffer),
      wetlandBuffer: normalizeBool(amenities.wetlandBuffer)
    },
    terrainConstraints: {
      maxDevelopableSlope: normalizeNum(terrainConstraints.maxDevelopableSlope),
      maxPreferredRoadGrade: normalizeNum(terrainConstraints.maxPreferredRoadGrade),
      avoidFloodplain: normalizeBool(terrainConstraints.avoidFloodplain),
      avoidWetlands: normalizeBool(terrainConstraints.avoidWetlands),
      avoidStreams: normalizeBool(terrainConstraints.avoidStreams),
      avoidSteepSlopes: normalizeBool(terrainConstraints.avoidSteepSlopes),
      minimizeCutAndFill: normalizeBool(terrainConstraints.minimizeCutAndFill),
      balanceCutAndFill: normalizeBool(terrainConstraints.balanceCutAndFill),
      preserveLowImpactAreas: normalizeBool(terrainConstraints.preserveLowImpactAreas)
    },
    priorities: {
      maxUnitYield: normalizeStr(priorities.maxUnitYield),
      minGrading: normalizeStr(priorities.minGrading),
      minRoadLength: normalizeStr(priorities.minRoadLength),
      maxOpenSpace: normalizeStr(priorities.maxOpenSpace),
      preserveExistingDevelopment: normalizeStr(priorities.preserveExistingDevelopment),
      walkability: normalizeStr(priorities.walkability),
      roadConnectivity: normalizeStr(priorities.roadConnectivity),
      stormwaterEfficiency: normalizeStr(priorities.stormwaterEfficiency),
      buildingViewsOrientation: normalizeStr(priorities.buildingViewsOrientation),
      lowestConstructionImpact: normalizeStr(priorities.lowestConstructionImpact)
    },
    existingFeatures: {
      buildingTreatment: normalizeStr(existingFeatures.buildingTreatment),
      roadTreatment: normalizeStr(existingFeatures.roadTreatment),
      preserveParking: normalizeBool(existingFeatures.preserveParking),
      preservePonds: normalizeBool(existingFeatures.preservePonds),
      preserveStreams: normalizeBool(existingFeatures.preserveStreams),
      preserveParks: normalizeBool(existingFeatures.preserveParks),
      preserveTreeCover: normalizeBool(existingFeatures.preserveTreeCover),
      preserveUtilities: normalizeBool(existingFeatures.preserveUtilities)
    },
    notes: normalizeStr(parameters.notes)
  }
}

// Development-only helper for pinpointing exactly which raw ProjectParameters
// paths differ when the dirty check unexpectedly marks an analysis as dirty.
function getDifferingPaths(a: any, b: any, path = ''): string[] {
  if (a === b) return []
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) {
    return path ? [path] : ['(root)']
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  const all = new Set([...aKeys, ...bKeys])
  const diffs: string[] = []
  for (const key of all) {
    const childPath = path ? `${path}.${key}` : key
    if (!aKeys.includes(key) || !bKeys.includes(key)) {
      diffs.push(childPath)
      continue
    }
    const childA = a[key]
    const childB = b[key]
    if (childA === childB) continue
    if (Array.isArray(childA) && Array.isArray(childB)) {
      if (childA.length !== childB.length) {
        diffs.push(`${childPath}[]`)
      } else {
        for (let i = 0; i < childA.length; i++) {
          diffs.push(...getDifferingPaths(childA[i], childB[i], `${childPath}[${i}]`))
        }
      }
    } else if (typeof childA === 'object' && childA != null && typeof childB === 'object' && childB != null) {
      diffs.push(...getDifferingPaths(childA, childB, childPath))
    } else {
      diffs.push(childPath)
    }
  }
  return diffs
}

function deepMerge(defaults: any, saved: any): any {
  if (saved === undefined) return defaults
  if (saved === null) return null
  if (Array.isArray(saved)) return saved
  if (typeof saved !== 'object' || typeof defaults !== 'object') return saved

  const result: any = { ...defaults }
  for (const key of Object.keys(saved)) {
    const savedVal = saved[key]
    if (savedVal === undefined) continue
    result[key] = deepMerge(defaults ? defaults[key] : undefined, savedVal)
  }
  return result
}

interface ParametersPanelProps {
  parcelId: string
  selectedSiteInfo: SelectedSiteInfo
  onParametersSaved?: (parameters: ProjectParameters) => void
  onMapResize?: () => void
  onAnalysisStart?: () => { runId: number, signal: AbortSignal } | null
  onCandidateOpenAreaResult?: (result: CandidateOpenAreaResult | null, runId: number) => void
  onConfirmedAnalysisReset?: () => void
  onSaveDraft?: (mcpi: string, parcelAddress: string | null, parcelMetadata: any, parameters: ProjectParameters) => void
  analysisRunId?: number
  parameterResetVersion?: number
  submittedParameters?: SubmittedParameters | null
  parcelGeometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon
  existingConditions?: any
  parentParcelAreaAcres?: number | null
  parcelFeasibilityAssessment?: ParcelFeasibilityAssessment | null
  draftParametersToRestore?: ProjectParameters | null
  draftRestoreMCPI?: string | null
  draftRestoreVersion?: number
  onDraftRestored?: () => void
  suppressAnalysisUntilManualRun?: boolean
  isAnalysisRunning?: boolean
  onAnalysisButtonStatusChange?: (status: 'idle' | 'running' | 'complete' | 'dirty' | 'error') => void
  onGenerateRoadSkeleton?: () => void
  conceptualRoadResult?: ConceptualRoadSkeletonResult | null
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null
  isRoadGenerating?: boolean
  roadGenerationError?: string | null
  developmentOpportunityBlockResult?: DevelopmentOpportunityBlockResult | null
  conceptualProgram?: ConceptualDevelopmentProgramResult | null
  conceptualLayout?: ConceptualDevelopmentLayoutResult | null
  redevelopmentImpact?: RedevelopmentImpactMetrics | null
  localStreetNetworkResult?: LocalStreetNetworkResult | null
  terrainSuitability?: TerrainSuitabilityResult | null
  conceptAlternatives?: ConceptAlternativeResult[] | null
  recommendedAlternativeId?: ConceptStrategy | null
  authoritativeAlternativeId?: ConceptStrategy | null
  generatingAlternativeId?: ConceptStrategy | null
  isAlternativeGenerating?: boolean
  onSelectAlternative?: (id: ConceptStrategy) => void
  onGenerateExportVisibilityChange?: (visible: boolean) => void
}

function ParametersPanel({ 
  parcelId, 
  selectedSiteInfo, 
  onParametersSaved,
  onMapResize,
  onCandidateOpenAreaResult,
  onAnalysisStart,
  onConfirmedAnalysisReset,
  onSaveDraft,
  parameterResetVersion = 0,
  submittedParameters = null,
  parcelGeometry,
  existingConditions,
  parentParcelAreaAcres = null,
  parcelFeasibilityAssessment = null,
  draftParametersToRestore = null,
  draftRestoreMCPI = null,
  draftRestoreVersion = 0,
  onDraftRestored,
  suppressAnalysisUntilManualRun = false,
  isAnalysisRunning = false,
  onAnalysisButtonStatusChange,
  onGenerateRoadSkeleton,
  conceptualRoadResult,
  isRoadGenerating = false,
  roadGenerationError = null,
  secondaryRoadNetworkResult = null,
  developmentOpportunityBlockResult = null,
  conceptualProgram = null,
  conceptualLayout = null,
  redevelopmentImpact = null,
  localStreetNetworkResult = null,
  terrainSuitability = null,
  conceptAlternatives,
  recommendedAlternativeId,
  authoritativeAlternativeId,
  generatingAlternativeId,
  isAlternativeGenerating,
  onSelectAlternative,
  onGenerateExportVisibilityChange
}: ParametersPanelProps) {
  const [expandedSections, setExpandedSections] = useState<string[]>(['dev-approach', 'dev-type', 'intensity', 'site-prefs'])
  const [parameters, setParameters] = useState<ProjectParameters | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [candidateOpenArea, setCandidateOpenArea] = useState<CandidateOpenAreaResult | null>(null)
  const isAnalyzing = isAnalysisRunning
  const [toast, setToast] = useState<{ message: string; mcpi?: string } | null>(null)
  const [analysisButtonStatus, setAnalysisButtonStatus] = useState<'idle' | 'running' | 'complete' | 'dirty' | 'error'>('idle')
  const [showGenerateExport, setShowGenerateExport] = useState(false)
  const [isEditMode, setIsEditMode] = useState(false)
  const [userSimplifiedOverrides, setUserSimplifiedOverrides] = useState<Record<string, boolean>>({})
  const [recommendedSimplified, setRecommendedSimplified] = useState<SimplifiedParameters | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const loadedDraftMCPIRef = useRef<string | null>(null)
  const lastHandledParameterResetVersionRef = useRef<number>(0)
  const lastHandledDraftRestoreVersionRef = useRef<number>(0)
  const analysisButtonTimerRef = useRef<number | null>(null)
  const lastAnalyzedSnapshotRef = useRef<{
    mcpi: string
    parameters: ProjectParameters
    editableFingerprint: any
    analysisRunId: number
  } | null>(null)

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  // Propagate analysis button status so App can invalidate dependent work
  useEffect(() => {
    if (onAnalysisButtonStatusChange) {
      onAnalysisButtonStatusChange(analysisButtonStatus)
    }
  }, [analysisButtonStatus])

  // Close the Generate & Export panel when the current analysis is no longer valid
  useEffect(() => {
    if (
      showGenerateExport &&
      (
        analysisButtonStatus !== 'complete' ||
        !candidateOpenArea ||
        candidateOpenArea.analysisRunId !== (lastAnalyzedSnapshotRef.current?.analysisRunId ?? -1) ||
        !parcelId
      )
    ) {
      setShowGenerateExport(false)
    }
  }, [analysisButtonStatus, candidateOpenArea, parcelId, showGenerateExport])

  // Notify the parent when the Generate & Export panel opens/closes so the map
  // can show generated concept layers only when that workflow page is active.
  useEffect(() => {
    if (onGenerateExportVisibilityChange) {
      onGenerateExportVisibilityChange(showGenerateExport)
    }
  }, [showGenerateExport, onGenerateExportVisibilityChange])

  // Exit edit mode when a new/updated analysis result is submitted.
  useEffect(() => {
    setIsEditMode(false)
  }, [submittedParameters?.mcpi, submittedParameters?.analysisRunId])

  // Initialize the editor to canonical defaults when a fresh parcel is selected.
  // Draft parameters are ONLY applied through the explicit draft-restoration effect below.
  useEffect(() => {
    if (!selectedSiteInfo.mcpi) {
      return
    }

    // Only act once per distinct MCPI to avoid overriding explicit resets
    if (loadedDraftMCPIRef.current === selectedSiteInfo.mcpi) {
      return
    }

    // If an explicit draft is being restored for this MCPI, do not touch parameters
    // (the draft restoration effect will handle it)
    if (draftParametersToRestore && draftRestoreMCPI) {
      const normalizedCurrentMCPI = normalizeMCPI(selectedSiteInfo.mcpi)
      const normalizedDraftMCPI = normalizeMCPI(draftRestoreMCPI)
      if (normalizedCurrentMCPI === normalizedDraftMCPI) {
        return
      }
    }

    // Suppress default initialization while an explicit draft is still pending
    if (suppressAnalysisUntilManualRun) {
      return
    }

    applyRecommendations(createDefaultParameters())
    loadedDraftMCPIRef.current = selectedSiteInfo.mcpi
  }, [parcelId, selectedSiteInfo.mcpi, draftParametersToRestore, draftRestoreMCPI, suppressAnalysisUntilManualRun, parcelFeasibilityAssessment])

  // Reset parameters when parameterResetVersion changes (parcel workflow restart only)
  useEffect(() => {
    // Ignore if version hasn't actually changed (protects against StrictMode double-run)
    if (parameterResetVersion === lastHandledParameterResetVersionRef.current) {
      return
    }
    
    // Update ref to track that we've handled this version
    lastHandledParameterResetVersionRef.current = parameterResetVersion
    
    // Reset to default parameters (do NOT call onResetParameters - that would cause infinite loop)
    applyRecommendations(createDefaultParameters())
    // Clear analysis result and the in-memory analyzed baseline
    setCandidateOpenArea(null)
    lastAnalyzedSnapshotRef.current = null
  }, [parameterResetVersion])

  // Restore draft parameters when pending draft exists and MCPI matches
  useEffect(() => {
    // Ignore if restore version hasn't changed (prevents duplicate restoration in StrictMode)
    if (draftRestoreVersion === lastHandledDraftRestoreVersionRef.current) {
      return
    }

    // Only proceed if we have pending draft parameters
    if (!draftParametersToRestore) {
      return
    }

    // Check if the selected MCPI matches the draft MCPI
    const currentMCPI = selectedSiteInfo.mcpi
    const draftMCPI = draftRestoreMCPI
    
    if (!currentMCPI || !draftMCPI) {
      return
    }

    // Normalize both MCPIs for comparison
    const normalizedCurrentMCPI = normalizeMCPI(currentMCPI)
    const normalizedDraftMCPI = normalizeMCPI(draftMCPI)

    if (normalizedCurrentMCPI !== normalizedDraftMCPI) {
      // MCPI doesn't match yet, wait for parcel selection to complete
      return
    }

    // Update ref to track that we've handled this version
    lastHandledDraftRestoreVersionRef.current = draftRestoreVersion

    // Normalize the draft parameters for editor
    const normalizedParameters = normalizeDraftParametersForEditor(draftParametersToRestore)

    // Set the normalized parameters and derive simplified for the UI
    setParameters(normalizedParameters)
    setRecommendedSimplified(getSimplifiedFromProjectParameters(normalizedParameters))
    setUserSimplifiedOverrides({
      developmentIntensity: true,
      roadNetwork: true,
      avoidSteepSlopes: true,
      minimizeStreamCrossings: true,
      preserveBuildings: true,
      preservePavement: true,
      prioritizeDirectAccess: true
    })
    loadedDraftMCPIRef.current = currentMCPI

  }, [draftParametersToRestore, draftRestoreMCPI, selectedSiteInfo.mcpi, draftRestoreVersion])

  // Verify committed state matches expected restoration before clearing pending draft
  useEffect(() => {
    // Only verify if we have pending draft parameters and they haven't been cleared yet
    if (!draftParametersToRestore || !draftRestoreMCPI) {
      return
    }

    // Wait for parameters to be set
    if (!parameters) {
      return
    }

    // Check if the selected MCPI matches
    const currentMCPI = selectedSiteInfo.mcpi
    const normalizedCurrentMCPI = normalizeMCPI(currentMCPI)
    const normalizedDraftMCPI = normalizeMCPI(draftRestoreMCPI)

    if (normalizedCurrentMCPI !== normalizedDraftMCPI) {
      return
    }

    // Verify the committed state contains the expected saved values
    const expectedDevTypes = draftParametersToRestore.developmentProgram?.filter((d: any) => d?.enabled).map((d: any) => d?.useType) || []
    const actualDevTypes = parameters.developmentProgram?.filter((d: any) => d?.enabled).map((d: any) => d?.useType) || []
    
    const devTypesMatch = 
      expectedDevTypes.length === actualDevTypes.length &&
      expectedDevTypes.every((type: string) => actualDevTypes.includes(type))

    const densityMatch = parameters.zoningAndLots?.targetDensity === draftParametersToRestore.zoningAndLots?.targetDensity
    const lotSizeMatch = (parameters.zoningAndLots as any)?.preferredLotSize === (draftParametersToRestore.zoningAndLots as any)?.preferredLotSize
    const buildingTypeMatch = parameters.zoningAndLots?.buildingFootprintPreference === draftParametersToRestore.zoningAndLots?.buildingFootprintPreference

    if (devTypesMatch && densityMatch && lotSizeMatch && buildingTypeMatch) {
      // Committed state matches expected values
      if (onDraftRestored) {
        onDraftRestored()
      }

      if (import.meta.env.DEV) {
        console.log('[ParametersPanel] Draft restoration committed', {
          mcpi: currentMCPI,
          draftRestoreVersion,
          developmentTypes: actualDevTypes,
          targetDensity: parameters.zoningAndLots?.targetDensity,
          preferredLotSize: (parameters.zoningAndLots as any)?.preferredLotSize,
          buildingFootprintPreference: parameters.zoningAndLots?.buildingFootprintPreference
        })
      }
    }
  }, [draftParametersToRestore, draftRestoreMCPI, parameters, selectedSiteInfo.mcpi, onDraftRestored])

  // Notify parent of panel resize
  useEffect(() => {
    if (onMapResize) {
      onMapResize()
    }
  }, [expandedSections, onMapResize])

  const createDefaultParameters = (): ProjectParameters => ({
    schemaVersion: 1,
    parcelId,
    projectMode: 'selective-redevelopment',
    developmentApproach: 'NEW_DEVELOPMENT',
    redevelopment: {
      buildingTreatment: 'SELECTIVE_REPLACEMENT',
      pavementTreatment: 'SELECTIVE_RECONFIGURATION',
      internalRoadTreatment: 'PRESERVE_ACCESS'
    },
    existingFeatures: {
      buildingTreatment: 'preserve-all',
      roadTreatment: 'preserve-all',
      preserveParking: true,
      preservePonds: true,
      preserveStreams: true,
      preserveParks: true,
      preserveTreeCover: true,
      preserveUtilities: true
    },
    developmentProgram: [],
    zoningAndLots: {
      standardsSource: 'custom',
      targetDensity: 6
    },
    roads: {
      networkPreference: 'modified-grid',
      prioritizeExistingConnections: true,
      avoidSteepSlopes: true,
      minimizeStreamCrossings: true,
      minimizeTotalPavement: false,
      emergencyAccessPreference: 'medium'
    },
    parking: {
      parkingType: 'mixed',
      sharedParkingAllowed: true
    },
    amenities: {
      park: false,
      playground: false,
      trailNetwork: false,
      communityGreen: false,
      retentionPond: false,
      detentionFacility: false,
      bioretention: false,
      preservedForest: false,
      landscapingBuffer: false,
      streamBuffer: true,
      wetlandBuffer: true
    },
    terrainConstraints: {
      detected: {},
      avoidFloodplain: true,
      avoidWetlands: true,
      avoidStreams: true,
      avoidSteepSlopes: true,
      minimizeCutAndFill: false,
      balanceCutAndFill: false,
      preserveLowImpactAreas: false
    },
    priorities: {
      maxUnitYield: 'medium',
      minGrading: 'medium',
      minRoadLength: 'medium',
      maxOpenSpace: 'medium',
      preserveExistingDevelopment: 'medium',
      walkability: 'medium',
      roadConnectivity: 'medium',
      stormwaterEfficiency: 'medium',
      buildingViewsOrientation: 'low',
      lowestConstructionImpact: 'medium'
    },
    notes: '',
    updatedAt: new Date().toISOString()
  })

  const applyRecommendations = (base: ProjectParameters) => {
    const result = deriveRecommendedParameters(parcelFeasibilityAssessment ?? null, base)
    setParameters(result.parameters)
    setRecommendedSimplified(result.simplified)
    setUserSimplifiedOverrides({})
  }

  const currentSimplified: SimplifiedParameters | null = parameters ? getSimplifiedFromProjectParameters(parameters) : null

  const groupKeys = (key: keyof SimplifiedParameters): (keyof SimplifiedParameters)[] => {
    if (key === 'avoidSteepSlopes') return ['avoidSteepSlopes', 'minimizeStreamCrossings']
    if (key === 'preserveBuildings') return ['preserveBuildings', 'preservePavement']
    return [key]
  }

  const showRecommendedBadge = (key: keyof SimplifiedParameters): boolean => {
    if (recommendedSimplified == null || currentSimplified == null) return false
    const keys = groupKeys(key)
    if (keys.some(k => userSimplifiedOverrides[k])) return false
    return keys.every(k => recommendedSimplified![k] === currentSimplified![k])
  }

  const setSimplifiedValue = (key: keyof SimplifiedParameters, nextValue: any) => {
    if (!currentSimplified || !parameters) return
    const updates: Partial<SimplifiedParameters> = { [key]: nextValue }
    groupKeys(key).forEach(k => { if (k !== key) updates[k] = nextValue })
    const newSimplified = { ...currentSimplified, ...updates }
    const newParams = applySimplifiedToProjectParameters(newSimplified, parameters)
    setParameters(newParams)
    setUserSimplifiedOverrides(prev => ({ ...prev, ...Object.keys(updates).reduce((acc, k) => ({ ...acc, [k]: true }), {}) }))
  }

  // Normalize draft parameters for editor restoration.
  // Starts from defaults, then deep-merges the saved snapshot so that
  // false, 0, empty arrays, and empty strings are preserved exactly.
  const normalizeDraftParametersForEditor = (saved: any): ProjectParameters => {
    const defaults = createDefaultParameters()
    const merged = deepMerge(defaults, saved)

    // Always tie the restored object to the currently selected parcel.
    merged.parcelId = saved?.parcelId || parcelId
    merged.schemaVersion = 1
    merged.updatedAt = saved?.updatedAt ?? new Date().toISOString()

    // Defensive guard: a saved draft record must not contain DraftRecord metadata
    // inside its parameters payload.
    if ('draftId' in merged || 'mcpi' in merged || 'parcelMetadata' in merged) {
      console.error('[ParametersPanel] Invalid restoration payload - contains DraftRecord metadata', merged)
      throw new Error('Invalid restoration payload: contains DraftRecord metadata')
    }

    return merged as ProjectParameters
  }

  const toggleSection = (sectionId: string) => {
    setExpandedSections(prev =>
      prev.includes(sectionId)
        ? prev.filter(id => id !== sectionId)
        : [sectionId] // Only one section open at a time
    )
  }

  const normalizeMCPI = (value: unknown) =>
    String(value ?? '').replace(/\D/g, '').padStart(12, '0')

  const saveDraft = () => {
    if (parameters && onSaveDraft) {
      // Concise log when a draft is saved
      if (import.meta.env.DEV) {
        const devTypes = parameters.developmentProgram?.filter((d: any) => d?.enabled).map((d: any) => d?.useType) || []
        console.log('[Draft Save] Canonical snapshot', {
          developmentTypes: devTypes,
          targetDensity: parameters.zoningAndLots?.targetDensity,
          preferredLotSize: (parameters.zoningAndLots as any)?.preferredLotSize,
          buildingFootprintPreference: parameters.zoningAndLots?.buildingFootprintPreference
        })
      }
      
      // Save the full ProjectParameters snapshot, not a custom partial object
      // This ensures we save all fields including targetDensity, preferredLotSize, etc.
      const parcelMetadata = {
        subdivision: selectedSiteInfo.subdivision || undefined,
        platNumber: selectedSiteInfo.platNumber || undefined,
        platLot: selectedSiteInfo.platLot || undefined,
        gisAcreage: selectedSiteInfo.gisAcreage || undefined,
        legalAcreage: selectedSiteInfo.legalAcreage || undefined
      }
      
      onSaveDraft(
        selectedSiteInfo.mcpi,
        selectedSiteInfo.addresses?.[0] || null,
        parcelMetadata,
        // Deep-clone the current editable parameters so the saved record
        // is independent of component state and previous parcels.
        JSON.parse(JSON.stringify(parameters)) as ProjectParameters
      )
      
      setToast({ message: 'Draft saved', mcpi: selectedSiteInfo.mcpi })
    }
  }

  const resetToDefaults = () => {
    if (showResetConfirm) {
      // Reset to recommended defaults for the current parcel
      applyRecommendations(createDefaultParameters())
      setShowResetConfirm(false)
      
      // Clear local analysis state and the in-memory analyzed baseline
      setCandidateOpenArea(null)
      if (analysisButtonTimerRef.current) {
        window.clearTimeout(analysisButtonTimerRef.current)
        analysisButtonTimerRef.current = null
      }
      setAnalysisButtonStatus('idle')
      lastAnalyzedSnapshotRef.current = null
      
      // Notify parent to clear analysis output state
      if (onConfirmedAnalysisReset) {
        onConfirmedAnalysisReset()
      }
    } else {
      setShowResetConfirm(true)
    }
  }

  // Clear candidate open area and analyzed baseline when parcel changes or when parent clears analysis state
  useEffect(() => {
    setCandidateOpenArea(null)
    loadedDraftMCPIRef.current = null
    lastAnalyzedSnapshotRef.current = null
    if (analysisButtonTimerRef.current) {
      window.clearTimeout(analysisButtonTimerRef.current)
      analysisButtonTimerRef.current = null
    }
    setAnalysisButtonStatus('idle')
  }, [parcelId])

  // Reset analysis state at the start/end of every draft open transaction.
  // This runs before parameters are committed so the button never briefly
  // shows dirty/complete from a previous workflow.
  useEffect(() => {
    if (draftRestoreVersion === 0) return
    if (analysisButtonTimerRef.current) {
      window.clearTimeout(analysisButtonTimerRef.current)
      analysisButtonTimerRef.current = null
    }
    setAnalysisButtonStatus('idle')
    setCandidateOpenArea(null)
    setShowGenerateExport(false)
    lastAnalyzedSnapshotRef.current = null
    loadedDraftMCPIRef.current = null
  }, [draftRestoreVersion])

  // Synchronize the synchronous analyzed snapshot from App's submittedParameters
  // only when it represents a completed analysis for the currently selected parcel
  // and is not older than the snapshot we already hold.  We recompute the
  // editable fingerprint from the incoming parameters so the comparison shape
  // is always consistent.
  useEffect(() => {
    if (!submittedParameters?.parameters || !selectedSiteInfo.mcpi) return

    const currentMCPI = normalizeMCPI(selectedSiteInfo.mcpi)
    const baselineMCPI = normalizeMCPI(submittedParameters.mcpi)
    if (baselineMCPI !== currentMCPI) return

    // Do not clobber a draft restoration with a stale previously-analyzed
    // snapshot for the same parcel.  When the user explicitly opens a draft,
    // the draft restoration effect is the authoritative source for the editor
    // state until the next analysis.
    if (draftParametersToRestore && draftRestoreMCPI) {
      const normalizedDraftMCPI = normalizeMCPI(draftRestoreMCPI)
      if (normalizedDraftMCPI === baselineMCPI) {
        return
      }
    }

    const incomingRunId = submittedParameters.analysisRunId ?? -1
    const currentRunId = lastAnalyzedSnapshotRef.current?.analysisRunId ?? -1
    if (incomingRunId >= currentRunId) {
      const incomingFingerprint = createEditableAnalysisFingerprint(submittedParameters.parameters)
      lastAnalyzedSnapshotRef.current = {
        mcpi: baselineMCPI,
        parameters: submittedParameters.parameters,
        editableFingerprint: incomingFingerprint,
        analysisRunId: incomingRunId
      }
      // Mark this MCPI as initialized so the default-initialization effect
      // does not later overwrite the canonical analyzed snapshot.
      loadedDraftMCPIRef.current = baselineMCPI
      // The editable parameter state MUST be the canonical analyzed snapshot after
      // a successful analysis. The previous deepEqual guard against the *current*
      // parameters failed because other effects (default init/reset) queue a
      // default-override in the same render; the later effect would see the old
      // parameters value and decide not to overwrite. Always apply the incoming
      // snapshot for the current MCPI and run so it wins as the final update.
      setParameters(submittedParameters.parameters)
    }
  }, [submittedParameters, selectedSiteInfo.mcpi])

  // Authoritative per-MCPI dirty detection.
  // Compares only the editable parameter fingerprint to the synchronous analyzed
  // snapshot so the button never flickers from complete → dirty after the first
  // successful analysis.
  useEffect(() => {
    if (!parameters) return

    const currentMCPI = normalizeMCPI(selectedSiteInfo.mcpi)
    const snapshot = lastAnalyzedSnapshotRef.current

    // No valid baseline for this parcel -> idle.
    if (!snapshot?.editableFingerprint || snapshot.mcpi !== currentMCPI) {
      if (analysisButtonStatus === 'complete' || analysisButtonStatus === 'dirty') {
        setAnalysisButtonStatus('idle')
      }
      return
    }

    const currentFingerprint = createEditableAnalysisFingerprint(parameters)

    // Baseline matches this exact parcel: compare current form to it.
    if (analysisButtonStatus === 'complete') {
      if (!deepEqual(currentFingerprint, snapshot.editableFingerprint)) {
        // Development-only diagnostic to pinpoint any remaining false dirty.
        if (import.meta.env.DEV) {
          const differingPaths = getDifferingPaths(parameters, snapshot.parameters).slice(0, 20)
          console.log('[Analysis Dirty Check] unexpected mismatch after completion', {
            mcpi: currentMCPI,
            differingPaths,
            currentEditableFingerprint: currentFingerprint,
            analyzedFingerprint: snapshot.editableFingerprint
          })
        }
        setAnalysisButtonStatus('dirty')
      }
    } else if (analysisButtonStatus === 'dirty') {
      if (deepEqual(currentFingerprint, snapshot.editableFingerprint)) {
        setAnalysisButtonStatus('complete')
      }
    }
  }, [parameters, selectedSiteInfo.mcpi, analysisButtonStatus])

  const saveAndAnalyze = async () => {
    // Authoritative user-perceived start: first synchronous instruction.
    userPerceivedWorkflow.markUserAnalyzeClick(performance.now())

    // Block duplicate or sequential clicks while any feedback state is showing.
    // App's in-flight ref and AbortController handle the authoritative run.
    if (
      analysisButtonStatus === 'running' ||
      analysisButtonStatus === 'complete' ||
      analysisButtonStatus === 'error' ||
      !parameters ||
      !onAnalysisStart
    ) return

    if (!parameters.developmentProgram.some(u => u.enabled)) return

    const startCtx = onAnalysisStart()
    if (!startCtx) return

    const { runId: newAnalysisRunId, signal } = startCtx

    // Commit the running state synchronously so the browser must paint it before
    // the heavy GIS work begins. This also flushes App's isAnalysisRunning.
    flushSync(() => setAnalysisButtonStatus('running'))

    const runningMinMs = 600
    const errorMs = 1500
    const runningStartTime = Date.now()

    if (analysisButtonTimerRef.current) {
      window.clearTimeout(analysisButtonTimerRef.current)
      analysisButtonTimerRef.current = null
    }

    // Save draft before analysis (uses the current editable parameters)
    saveDraft()

    // Clear previous local result preview
    setCandidateOpenArea(null)

    // Deep-clone the exact parameters that will be used for this analysis.
    // This ref is the authoritative baseline for dirty detection so the
    // button state does not flicker while App's submittedParameters prop
    // propagates through React.
    const analysisSnapshot = JSON.parse(JSON.stringify(parameters)) as ProjectParameters
    const currentMCPI = normalizeMCPI(selectedSiteInfo.mcpi)
    lastAnalyzedSnapshotRef.current = {
      mcpi: currentMCPI,
      parameters: analysisSnapshot,
      editableFingerprint: createEditableAnalysisFingerprint(parameters),
      analysisRunId: newAnalysisRunId
    }

    // Wait for the next paint so the user sees "Analyzing..." before the
    // synchronous calculation blocks the main thread.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    try {
      if (!parcelGeometry || !existingConditions) {
        throw new Error('Parcel geometry or existing conditions not available')
      }

      const coaInputs = {
        parcelGeometry,
        parcelGisAcreage: selectedSiteInfo.gisAcreage || null,
        mcpi: selectedSiteInfo.mcpi,
        buildingFeatures: existingConditions.buildings.features || [],
        streetFeatures: [
          ...(existingConditions.intersectingStreets.features || []),
          ...(existingConditions.nearbyStreets.features || [])
        ],
        hydrologyFeatures: existingConditions.hydrology?.features || null,
        pavementFeatures: existingConditions.pavement?.features || null,
        projectParameters: parameters,
        signal,
        analysisRunId: newAnalysisRunId
      }

      const currentSelectionId = selectedSiteInfo.selectionRequestId
      const blockingInputs: string[] = []

      if (!existingConditions.buildings || (existingConditions.buildings.state !== 'success' && existingConditions.buildings.state !== 'success-zero')) {
        blockingInputs.push('buildings:state')
      } else if (normalizeMCPI(existingConditions.buildings.mcpi) !== currentMCPI) {
        blockingInputs.push('buildings:mcpi')
      } else if (currentSelectionId !== undefined && existingConditions.buildings.selectionRequestId !== currentSelectionId) {
        blockingInputs.push('buildings:runId')
      }

      if (!existingConditions.intersectingStreets || (existingConditions.intersectingStreets.state !== 'success' && existingConditions.intersectingStreets.state !== 'success-zero')) {
        blockingInputs.push('intersectingStreets:state')
      } else if (normalizeMCPI(existingConditions.intersectingStreets.mcpi) !== currentMCPI) {
        blockingInputs.push('intersectingStreets:mcpi')
      } else if (currentSelectionId !== undefined && existingConditions.intersectingStreets.selectionRequestId !== currentSelectionId) {
        blockingInputs.push('intersectingStreets:runId')
      }

      if (!existingConditions.nearbyStreets || (existingConditions.nearbyStreets.state !== 'success' && existingConditions.nearbyStreets.state !== 'success-zero')) {
        blockingInputs.push('nearbyStreets:state')
      } else if (normalizeMCPI(existingConditions.nearbyStreets.mcpi) !== currentMCPI) {
        blockingInputs.push('nearbyStreets:mcpi')
      } else if (currentSelectionId !== undefined && existingConditions.nearbyStreets.selectionRequestId !== currentSelectionId) {
        blockingInputs.push('nearbyStreets:runId')
      }

      if (!existingConditions.hydrology || existingConditions.hydrology.state !== 'success') {
        blockingInputs.push('hydrology:state')
      } else if (normalizeMCPI(existingConditions.hydrology.mcpi) !== currentMCPI) {
        blockingInputs.push('hydrology:mcpi')
      } else if (currentSelectionId !== undefined && existingConditions.hydrology.selectionRequestId !== currentSelectionId) {
        blockingInputs.push('hydrology:runId')
      }

      if (!existingConditions.pavement || existingConditions.pavement.state !== 'success') {
        blockingInputs.push('pavement:state')
      } else if (normalizeMCPI(existingConditions.pavement.mcpi) !== currentMCPI) {
        blockingInputs.push('pavement:mcpi')
      } else if (currentSelectionId !== undefined && existingConditions.pavement.selectionRequestId !== currentSelectionId) {
        blockingInputs.push('pavement:runId')
      }

      if (blockingInputs.length > 0) {
        if (import.meta.env.DEV) {
          console.log('[CandidateOpenAreaInputGuard]', {
            selectedMcpi: currentMCPI,
            activeRunId: newAnalysisRunId,
            parcelGeometryMcpi: currentMCPI,
            parcelGeometryRunId: currentSelectionId,
            buildingMcpi: existingConditions.buildings?.mcpi,
            buildingRunId: existingConditions.buildings?.selectionRequestId,
            hydrologyMcpi: existingConditions.hydrology?.mcpi,
            hydrologyRunId: existingConditions.hydrology?.selectionRequestId,
            pavementMcpi: existingConditions.pavement?.mcpi,
            pavementRunId: existingConditions.pavement?.selectionRequestId,
            roadCorridorMcpi: existingConditions.intersectingStreets?.mcpi,
            roadCorridorRunId: existingConditions.intersectingStreets?.selectionRequestId,
            blockingInputs,
            action: 'waiting-for-current-analysis-inputs'
          })
        }

        setToast({ message: 'Analysis inputs still loading' })
        lastAnalyzedSnapshotRef.current = null
        if (onCandidateOpenAreaResult) {
          onCandidateOpenAreaResult(null, newAnalysisRunId)
        }
        setAnalysisButtonStatus('idle')
        return
      }

      if (import.meta.env.DEV) {
        console.log('[ParametersPanelCOAInputs]', {
          runId: newAnalysisRunId,
          mcpi: selectedSiteInfo.mcpi,
          hasParcelGeometry: !!coaInputs.parcelGeometry,
          buildingCount: coaInputs.buildingFeatures.length,
          streetCount: coaInputs.streetFeatures.length,
          hydrologyFeaturesIsNull: coaInputs.hydrologyFeatures === null,
          hydrologyCoverageAvailable: (coaInputs.hydrologyFeatures as any)?.hydrologyCoverageAvailable,
          hydrologyWaterCount: (coaInputs.hydrologyFeatures as any)?.waterBodyFeatures?.length,
          hydrologyWetlandCount: (coaInputs.hydrologyFeatures as any)?.wetlandFeatures?.length,
          hydrologyStreamCount: (coaInputs.hydrologyFeatures as any)?.streamDrainFeatures?.length,
          pavementFeaturesIsNull: coaInputs.pavementFeatures === null,
          pavementCoverageAvailable: (coaInputs.pavementFeatures as any)?.pavementCoverageAvailable,
          pavementFeatureCount: (coaInputs.pavementFeatures as any)?.features?.length,
          existingConditionsHydrologyKeys: existingConditions.hydrology ? Object.keys(existingConditions.hydrology) : null
        })
      }

      // Capture submitted parameters only after all inputs are identity-verified
      if (onParametersSaved) {
        onParametersSaved(analysisSnapshot)
      }

      workflowCriticalPath.start('candidateOpenArea')
      const result = await calculateCandidateOpenArea(coaInputs)
      workflowCriticalPath.ready('candidateOpenArea')

      if (import.meta.env.DEV) {
        console.log('[ParametersPanelCOAResult]', {
          runId: newAnalysisRunId,
          status: result.status,
          errors: result.errors,
          warnings: result.warnings,
          candidateAreaSqFt: result.candidateAreaSqFt,
          componentCount: result.componentCount,
          hydrologyCoverageAvailable: result.hydrologyCoverageAvailable
        })
      }

      setCandidateOpenArea(result)
      if (onCandidateOpenAreaResult) {
        onCandidateOpenAreaResult(result, newAnalysisRunId)
      }

      const elapsed = Date.now() - runningStartTime
      const remaining = Math.max(0, runningMinMs - elapsed)

      if (analysisButtonTimerRef.current) {
        window.clearTimeout(analysisButtonTimerRef.current)
      }
      analysisButtonTimerRef.current = window.setTimeout(() => {
        setAnalysisButtonStatus('complete')
        analysisButtonTimerRef.current = null
      }, remaining)
    } catch (error) {
      console.error('Candidate open area analysis failed:', error)
      const failedResult = createFailedResult(
        selectedSiteInfo.mcpi,
        selectedSiteInfo.gisAcreage || null,
        [String(error)],
        newAnalysisRunId
      )
      setCandidateOpenArea(failedResult)
      if (onCandidateOpenAreaResult) {
        onCandidateOpenAreaResult(failedResult, newAnalysisRunId)
      }

      const elapsed = Date.now() - runningStartTime
      const remaining = Math.max(0, runningMinMs - elapsed)

      const resolveButtonAfterError = () => {
        const hasCompleted = submittedParameters?.parameters != null
        if (hasCompleted && parameters && !deepEqual(parameters, submittedParameters.parameters)) {
          setAnalysisButtonStatus('dirty')
        } else {
          setAnalysisButtonStatus('idle')
        }
        analysisButtonTimerRef.current = null
      }

      if (signal.aborted) {
        // Expected abort (parcel change, reset, or newer run); do not flash error.
        if (analysisButtonTimerRef.current) {
          window.clearTimeout(analysisButtonTimerRef.current)
        }
        analysisButtonTimerRef.current = window.setTimeout(() => {
          resolveButtonAfterError()
        }, remaining)
      } else {
        if (analysisButtonTimerRef.current) {
          window.clearTimeout(analysisButtonTimerRef.current)
        }
        analysisButtonTimerRef.current = window.setTimeout(() => {
          setAnalysisButtonStatus('error')
          analysisButtonTimerRef.current = window.setTimeout(() => {
            resolveButtonAfterError()
          }, errorMs)
        }, remaining)
      }
    }
  }

  const currentMCPI = normalizeMCPI(selectedSiteInfo.mcpi)
  const runId = lastAnalyzedSnapshotRef.current?.analysisRunId
  const submittedRunId = submittedParameters?.analysisRunId

  const canContinueToGenerate = !!(
    parcelId &&
    currentMCPI &&
    !!parameters &&
    !!candidateOpenArea &&
    runId != null &&
    candidateOpenArea.analysisRunId === runId &&
    submittedRunId === runId &&
    !!submittedParameters &&
    normalizeMCPI(submittedParameters.mcpi) === currentMCPI &&
    !!lastAnalyzedSnapshotRef.current &&
    normalizeMCPI(lastAnalyzedSnapshotRef.current.mcpi) === currentMCPI &&
    analysisButtonStatus === 'complete' &&
    !isAnalysisRunning &&
    deepEqual(createEditableAnalysisFingerprint(parameters), lastAnalyzedSnapshotRef.current.editableFingerprint)
  )

  useEffect(() => {
    if (showGenerateExport && !canContinueToGenerate) {
      setShowGenerateExport(false)
    }
  }, [showGenerateExport, canContinueToGenerate])

  // Assemble authoritative in-memory GeoJSON sources for export.
  // These are not refetched; they are the same parcel/analysis data already
  // loaded for the map and candidate-open-area calculation.
  const exportContextGeoJSON = useMemo(() => {
    const selectedParentParcel = parcelGeometry && parcelId
      ? ({ type: 'Feature', properties: { PA_MCPI: parcelId, source: 'selected_parcel' }, geometry: parcelGeometry } as GeoJSON.Feature<GeoJSON.Geometry>)
      : null

    const candidateOpenAreaGeometry = candidateOpenArea?.candidateGeometry || null

    const getFeatureObjectId = (f: any): string | undefined => {
      const id = f?.properties?.OBJECTID ?? f?.properties?.objectid ?? f?.properties?.id
      return id == null ? undefined : String(id)
    }

    const buildingClassification = candidateOpenArea?.buildingClassification
    const preservedBuildingIds = new Set((buildingClassification?.preservedBuildingObjectIds ?? []).map(String))
    const eligibleBuildingIds = new Set((buildingClassification?.redevelopmentEligibleObjectIds ?? []).map(String))

    const existingBuildings = existingConditions?.buildings?.features?.length
      ? ({ type: 'FeatureCollection', features: existingConditions.buildings.features.filter((f: any) => f && f.geometry).map((f: any) => {
          const id = getFeatureObjectId(f)
          const extra: Record<string, any> = {}
          if (buildingClassification?.buildingTreatment) extra.redevelopmentTreatment = buildingClassification.buildingTreatment
          if (id != null) {
            if (preservedBuildingIds.has(id)) extra.redevelopmentDisposition = 'PRESERVED'
            else if (eligibleBuildingIds.has(id)) extra.redevelopmentDisposition = 'REDEVELOPMENT_ELIGIBLE'
          }
          return { ...f, properties: { ...(f.properties || {}), ...extra } }
        }) } as GeoJSON.FeatureCollection<GeoJSON.Geometry>)
      : null

    const hydrology = existingConditions?.hydrology?.features
    const waterWetlandFeatures = [
      ...(hydrology?.waterBodyFeatures || []),
      ...(hydrology?.wetlandFeatures || []),
      ...(hydrology?.streamDrainFeatures || [])
    ].filter((f: any) => f && f.geometry)

    const waterWetlands = waterWetlandFeatures.length
      ? ({ type: 'FeatureCollection', features: waterWetlandFeatures.map((f: any) => ({ ...f, properties: f.properties || {} })) } as GeoJSON.FeatureCollection<GeoJSON.Geometry>)
      : null

    const pavementClassification = candidateOpenArea?.pavementClassification
    const preservedPavementIds = new Set((pavementClassification?.preservedPavementObjectIds ?? []).map(String))
    const eligiblePavementIds = new Set((pavementClassification?.reconfigurationEligiblePavementObjectIds ?? []).map(String))

    const pavementFeatureArray = existingConditions?.pavement?.features?.features
    const existingPavement = pavementFeatureArray?.length
      ? ({ type: 'FeatureCollection', features: pavementFeatureArray.filter((f: any) => f && f.geometry).map((f: any) => {
          const id = getFeatureObjectId(f)
          const extra: Record<string, any> = {}
          if (pavementClassification?.pavementTreatment) extra.redevelopmentTreatment = pavementClassification.pavementTreatment
          if (id != null) {
            if (preservedPavementIds.has(id)) extra.redevelopmentDisposition = 'PRESERVED'
            else if (eligiblePavementIds.has(id)) extra.redevelopmentDisposition = 'RECONFIGURATION_ELIGIBLE'
          }
          return { ...f, properties: { ...(f.properties || {}), ...extra } }
        }) } as GeoJSON.FeatureCollection<GeoJSON.Geometry>)
      : null

    return {
      selectedParentParcel,
      candidateOpenAreaGeometry,
      existingBuildings,
      waterWetlands,
      existingPavement
    }
  }, [parcelGeometry, parcelId, candidateOpenArea, existingConditions])

  if (!parameters) {
    return <div className="p-4">Loading parameters...</div>
  }

  const hasDevelopmentType = parameters.developmentProgram.some(u => u.enabled)

  if (showGenerateExport) {
    return (
      <div ref={panelRef} data-parameters-panel="true" className="h-full flex flex-col text-[#cbd5e1] w-full overflow-y-auto p-4" style={{ background: 'linear-gradient(160deg, #050807 0%, #0B211B 45%, #184C3D 78%, rgba(147, 233, 190, 0.35) 100%)' }}>
        <GenerateExportPanel
          canGenerate={canContinueToGenerate}
          onGenerateRoadSkeleton={() => {
            if (onGenerateRoadSkeleton) onGenerateRoadSkeleton()
          }}
          conceptualRoadResult={conceptualRoadResult}
          secondaryRoadNetworkResult={secondaryRoadNetworkResult}
          isRoadGenerating={isRoadGenerating}
          roadGenerationError={roadGenerationError}
          onBackToParameters={() => setShowGenerateExport(false)}
          developmentOpportunityBlockResult={developmentOpportunityBlockResult}
          conceptualProgram={conceptualProgram}
          conceptualLayout={conceptualLayout}
          redevelopmentImpact={redevelopmentImpact}
          localStreetNetworkResult={localStreetNetworkResult}
          terrainSuitability={terrainSuitability}
          parentParcelAreaAcres={parentParcelAreaAcres}
          selectedParcel={exportContextGeoJSON.selectedParentParcel}
          candidateOpenArea={exportContextGeoJSON.candidateOpenAreaGeometry}
          candidateOpenAreaResult={candidateOpenArea}
          existingBuildings={exportContextGeoJSON.existingBuildings}
          waterWetlands={exportContextGeoJSON.waterWetlands}
          existingPavement={exportContextGeoJSON.existingPavement}
          conceptAlternatives={conceptAlternatives}
          recommendedAlternativeId={recommendedAlternativeId}
          authoritativeAlternativeId={authoritativeAlternativeId}
          generatingAlternativeId={generatingAlternativeId}
          isAlternativeGenerating={isAlternativeGenerating}
          onSelectAlternative={onSelectAlternative}
          parcelFeasibilityAssessment={parcelFeasibilityAssessment}
          submittedParameters={submittedParameters}
          onSaveDraft={saveDraft}
        />
      </div>
    )
  }

  return (
    <div ref={panelRef} data-parameters-panel="true" className="h-full flex flex-col text-[#cbd5e1] w-full" style={{ background: 'linear-gradient(160deg, #050807 0%, #0B211B 45%, #184C3D 78%, rgba(147, 233, 190, 0.35) 100%)' }}>
      <div className="p-4 border-b border-slate-600 flex-shrink-0 relative">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Development Parameters</h2>
        </div>
        
        {/* Toast notification - positioned relative within header */}
        {toast && (
          <div className="absolute top-4 right-4 z-10 px-3 py-2 rounded-lg shadow-lg border border-[#8ED8C0] bg-[#0B211B] text-[#93E9BE] text-sm whitespace-nowrap">
            <div className="text-center">
              {toast.message}
              {toast.mcpi && <div className="text-xs text-slate-400 mt-1">{toast.mcpi}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Applied Parameters (shows after analysis, hidden while editing) */}
      {submittedParameters && !isEditMode && (
        <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin', scrollbarColor: '#40826D #0B211B' }}>
          <AppliedParametersSection
            submittedParameters={submittedParameters}
            candidateOpenArea={candidateOpenArea}
            parcelFeasibilityAssessment={parcelFeasibilityAssessment}
            onEdit={() => setIsEditMode(true)}
          />
        </div>
      )}

      {(!submittedParameters || isEditMode) && (
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ scrollbarWidth: 'thin', scrollbarColor: '#40826D #0B211B' }}>
        {/* Section 1: Selected Parcel (Read-only) */}
        <CollapsibleSection
          id="site"
          title="Selected Parcel"
          expanded={expandedSections.includes('site')}
          onToggle={toggleSection}
        >
          <SelectedSiteSection
            siteInfo={selectedSiteInfo}
            isAnalyzing={isAnalyzing}
            candidateOpenArea={candidateOpenArea}
          />
        </CollapsibleSection>

        {/* Section 1.5: Development Approach */}
        <CollapsibleSection
          id="dev-approach"
          title="Development Approach"
          expanded={expandedSections.includes('dev-approach')}
          onToggle={toggleSection}
        >
          <DevelopmentApproachSection
            value={parameters.developmentApproach}
            onChange={(v) => setParameters({ ...parameters, developmentApproach: v })}
          />
          {parameters.developmentApproach === 'REDEVELOPMENT' && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
              <RedevelopmentTreatmentSection
                value={parameters.redevelopment}
                onChange={(updates) => setParameters({ ...parameters, redevelopment: { ...parameters.redevelopment, ...updates } })}
              />
            </div>
          )}
        </CollapsibleSection>

        {/* Recommended Starting Point */}
        <RecommendedStartingPointCard
          simplified={recommendedSimplified}
          assessment={parcelFeasibilityAssessment}
        />

        {/* Section 2: Development Type */}
        <CollapsibleSection
          id="dev-type"
          title="Development Type"
          expanded={expandedSections.includes('dev-type')}
          onToggle={toggleSection}
        >
          <DevelopmentTypeSection
            value={parameters.developmentProgram}
            onChange={(program) => setParameters({ ...parameters, developmentProgram: program })}
          />
        </CollapsibleSection>

        {/* Section 3: Development Intensity */}
        <CollapsibleSection
          id="intensity"
          title="Development Intensity"
          expanded={expandedSections.includes('intensity')}
          onToggle={toggleSection}
        >
          {currentSimplified && (
            <SimplifiedDevelopmentIntensitySection
              value={currentSimplified.developmentIntensity}
              showRecommended={showRecommendedBadge('developmentIntensity')}
              onChange={(intensity) => setSimplifiedValue('developmentIntensity', intensity)}
            />
          )}
        </CollapsibleSection>

        {/* Section 4: Site Priorities */}
        <CollapsibleSection
          id="site-prefs"
          title="Site Priorities"
          expanded={expandedSections.includes('site-prefs')}
          onToggle={toggleSection}
        >
          {currentSimplified && (
            <SitePlanningPreferencesSection
              value={currentSimplified}
              showRecommended={showRecommendedBadge}
              onToggle={(key, next) => setSimplifiedValue(key, next)}
            />
          )}
        </CollapsibleSection>

        {/* Section 5: Advanced Options */}
        <CollapsibleSection
          id="advanced"
          title="Advanced Options"
          expanded={expandedSections.includes('advanced')}
          onToggle={toggleSection}
        >
          <AdvancedOptionsSection
            parameters={parameters}
            onChange={(p) => {
              setParameters(p)
              // Mark all simplified keys as user-overridden once advanced values are touched
              setUserSimplifiedOverrides(prev => ({
                ...prev,
                developmentIntensity: true,
                roadNetwork: true,
                avoidSteepSlopes: true,
                minimizeStreamCrossings: true,
                preserveBuildings: true,
                preservePavement: true,
                prioritizeDirectAccess: true
              }))
            }}
          />
        </CollapsibleSection>

        {/* Section 7: Notes */}
        <CollapsibleSection
          id="notes"
          title="Notes"
          expanded={expandedSections.includes('notes')}
          onToggle={toggleSection}
        >
          <NotesSection
            value={parameters.notes}
            onChange={(notes) => setParameters({ ...parameters, notes })}
          />
        </CollapsibleSection>
      </div>
      )}

      {/* Action Buttons */}
      <div className="p-4 border-t border-slate-600 space-y-3 flex-shrink-0">
        {canContinueToGenerate ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setShowGenerateExport(true)
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[15px] font-bold transition-all"
            style={{
              background: 'var(--button-gradient)',
              color: 'var(--brand-black)',
              border: '1px solid var(--viridian)'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)' }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
          >
            Continue to Generate & Export
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
          </button>
        ) : (
          <button
            type="button"
            disabled={
              analysisButtonStatus === 'running' ||
              analysisButtonStatus === 'complete' ||
              analysisButtonStatus === 'error' ||
              !hasDevelopmentType
            }
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              saveAndAnalyze()
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[15px] font-bold transition-all"
            style={{
              background: analysisButtonStatus === 'error'
                ? 'rgba(220, 38, 38, 0.9)'
                : analysisButtonStatus === 'running' || !hasDevelopmentType
                ? 'rgba(64, 130, 109, 0.25)'
                : 'var(--button-gradient)',
              color: analysisButtonStatus === 'error' || analysisButtonStatus === 'running' || !hasDevelopmentType ? 'var(--text-secondary)' : 'var(--brand-black)',
              border: '1px solid var(--viridian)'
            }}
          >
            {analysisButtonStatus === 'running' && (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Analyzing Site…
              </>
            )}
            {analysisButtonStatus === 'complete' && 'Analysis Complete'}
            {analysisButtonStatus === 'dirty' && 'Save Changes & Re-analyze Site'}
            {analysisButtonStatus === 'error' && 'Analysis Failed'}
            {analysisButtonStatus === 'idle' && hasDevelopmentType && 'Save Parameters & Analyze Site'}
            {analysisButtonStatus === 'idle' && !hasDevelopmentType && 'Select a Development Type First'}
          </button>
        )}

        {!hasDevelopmentType && (
          <p className="text-xs text-center" style={{ color: '#fbbf24' }}>Select at least one development type to continue.</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={saveDraft}
            className="flex-1 px-3 py-2 rounded-md text-[13px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
            style={{ background: 'transparent', border: '1px solid rgba(64, 130, 109, 0.45)', color: 'var(--soft-seafoam)' }}
          >
            Save Draft
          </button>
          <button
            type="button"
            onClick={resetToDefaults}
            className="flex-1 px-3 py-2 rounded-md text-[13px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
            style={{ background: 'transparent', border: '1px solid rgba(64, 130, 109, 0.45)', color: 'var(--soft-seafoam)' }}
          >
            {showResetConfirm ? 'Confirm Reset' : 'Reset'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Collapsible Section Component
function CollapsibleSection({ 
  id, 
  title, 
  expanded, 
  onToggle, 
  children 
}: { 
  id: string
  title: string
  expanded: boolean
  onToggle: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="border border-[#184C3D] rounded-lg overflow-hidden">
      <button
        onClick={() => onToggle(id)}
        className="w-full px-4 py-2.5 flex items-center justify-between transition-all focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:ring-offset-2 focus:ring-offset-[#050807]"
        style={{
          background: expanded 
            ? 'linear-gradient(135deg, #202429 0%, #1e1b2e 55%, #2e1065 85%, rgba(190, 24, 93, 0.35) 100%)'
            : 'linear-gradient(135deg, #202429 0%, #1a1d21 55%, #1e2127 100%)'
        }}
        onMouseEnter={(e) => {
          if (!expanded) {
            e.currentTarget.style.background = 'linear-gradient(135deg, #202429 0%, #1e1b2e 55%, #2e1065 100%)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = expanded
            ? 'linear-gradient(135deg, #202429 0%, #1e1b2e 55%, #2e1065 85%, rgba(190, 24, 93, 0.35) 100%)'
            : 'linear-gradient(135deg, #202429 0%, #1a1d21 55%, #1e2127 100%)'
        }}
      >
        <span className="font-medium text-white">{title}</span>
        <span className="text-[#db2777] transition-transform">
          {expanded ? '▼' : '▶'}
        </span>
      </button>
      {expanded && (
        <div className="p-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  )
}

// Section 1: Selected Parcel (Read-only)
function SelectedSiteSection({ 
  siteInfo, 
  isAnalyzing,
  candidateOpenArea 
}: { 
  siteInfo: SelectedSiteInfo
  isAnalyzing: boolean
  candidateOpenArea: CandidateOpenAreaResult | null
}) {
  if (!siteInfo.hasParcel) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-slate-400">
          Select a parcel on the map or search by address or MCPI to begin.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Parcel Identity */}
      <div>
        <h4 className="text-sm font-medium text-[#8ED8C0] mb-3">Parcel Identity</h4>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Address</label>
            <div className="px-3 py-2 rounded text-sm max-h-20 overflow-y-auto" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>
              {siteInfo.addresses.length === 0 ? (
                <span className="text-slate-500">Not provided by parcel service</span>
              ) : siteInfo.addresses.length === 1 ? (
                siteInfo.addresses[0]
              ) : siteInfo.addresses.length <= 3 ? (
                <div className="space-y-1">
                  {siteInfo.addresses.map((addr, idx) => (
                    <div key={idx}>{addr}</div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {siteInfo.addresses.slice(0, 3).map((addr, idx) => (
                    <div key={idx}>{addr}</div>
                  ))}
                  <div className="text-slate-400 text-xs">
                    +{siteInfo.addresses.length - 3} more addresses
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">MCPI</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>{siteInfo.mcpi}</div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Parcel Type</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>{siteInfo.parcelType || 'N/A'}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">GIS Acreage</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>
                {siteInfo.gisAcreage ? siteInfo.gisAcreage.toFixed(2) : 'Not available'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Legal Acreage</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>
                {siteInfo.legalAcreage ? siteInfo.legalAcreage.toFixed(2) : 'Not available'}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Subdivision</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>{siteInfo.subdivision || 'N/A'}</div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Plat Number</label>
              <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>{siteInfo.platNumber || 'N/A'}</div>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Plat Lot</label>
            <div className="px-3 py-2 rounded text-sm" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>{siteInfo.platLot || 'N/A'}</div>
          </div>
        </div>
      </div>

      {/* Analysis Status */}
      <div className="border-t border-slate-600 pt-4">
        <h4 className="text-sm font-medium text-[#8ED8C0] mb-3">Analysis Status</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Parcel boundary</span>
            <span className="text-xs text-[#8ED8C0]">Loaded</span>
          </div>
          {siteInfo.existingConditions ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Existing buildings</span>
                <span className="text-xs">
                  {siteInfo.existingConditions.buildings.state === 'loading' && (
                    <span className="text-slate-400">Loading…</span>
                  )}
                  {siteInfo.existingConditions.buildings.state === 'success' && (
                    <span className="text-[#8ED8C0]">{siteInfo.existingConditions.buildings.count} loaded</span>
                  )}
                  {siteInfo.existingConditions.buildings.state === 'success-zero' && (
                    <span className="text-[#8ED8C0]">None found</span>
                  )}
                  {siteInfo.existingConditions.buildings.state === 'error' && (
                    <span className="text-red-400">Load failed</span>
                  )}
                  {siteInfo.existingConditions.buildings.state === 'aborted' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                  {siteInfo.existingConditions.buildings.state === 'idle' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Intersecting streets</span>
                <span className="text-xs">
                  {siteInfo.existingConditions.intersectingStreets.state === 'loading' && (
                    <span className="text-slate-400">Loading…</span>
                  )}
                  {siteInfo.existingConditions.intersectingStreets.state === 'success' && (
                    <span className="text-[#8ED8C0]">{siteInfo.existingConditions.intersectingStreets.count} loaded</span>
                  )}
                  {siteInfo.existingConditions.intersectingStreets.state === 'success-zero' && (
                    <span className="text-[#8ED8C0]">None found</span>
                  )}
                  {siteInfo.existingConditions.intersectingStreets.state === 'error' && (
                    <span className="text-red-400">Load failed</span>
                  )}
                  {siteInfo.existingConditions.intersectingStreets.state === 'aborted' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                  {siteInfo.existingConditions.intersectingStreets.state === 'idle' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Additional nearby streets (100 ft)</span>
                <span className="text-xs">
                  {siteInfo.existingConditions.nearbyStreets.state === 'loading' && (
                    <span className="text-slate-400">Loading…</span>
                  )}
                  {siteInfo.existingConditions.nearbyStreets.state === 'success' && (
                    <span className="text-[#8ED8C0]">{siteInfo.existingConditions.nearbyStreets.additionalCount} loaded</span>
                  )}
                  {siteInfo.existingConditions.nearbyStreets.state === 'success-zero' && (
                    <span className="text-[#8ED8C0]">None found</span>
                  )}
                  {siteInfo.existingConditions.nearbyStreets.state === 'error' && (
                    <span className="text-red-400">Load failed</span>
                  )}
                  {siteInfo.existingConditions.nearbyStreets.state === 'aborted' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                  {siteInfo.existingConditions.nearbyStreets.state === 'idle' && (
                    <span className="text-slate-500">Not yet analyzed</span>
                  )}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Existing buildings</span>
                <span className="text-xs text-slate-500">Not yet analyzed</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Intersecting streets</span>
                <span className="text-xs text-slate-500">Not yet analyzed</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Additional nearby streets (100 ft)</span>
                <span className="text-xs text-slate-500">Not yet analyzed</span>
              </div>
            </>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Remaining open area</span>
            <span className="text-xs">
              {isAnalyzing && (
                <span className="text-slate-400">Analyzing…</span>
              )}
              {!isAnalyzing && !candidateOpenArea && (
                <span className="text-slate-500">Not yet analyzed</span>
              )}
              {!isAnalyzing && candidateOpenArea && (
                <span className={candidateOpenArea.status === 'failed' ? 'text-red-400' : candidateOpenArea.status === 'warning' ? 'text-yellow-400' : 'text-[#8ED8C0]'}>
                  {candidateOpenArea.status === 'failed' ? 'Failed' : candidateOpenArea.status === 'warning' ? 'Loaded with warnings' : candidateOpenArea.status === 'empty' ? 'Empty' : 'Loaded'}
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Zoning and setbacks</span>
            <span className="text-xs text-slate-500">Not yet analyzed</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Terrain and slope</span>
            <span className="text-xs text-slate-500">Not yet analyzed</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Environmental constraints</span>
            <span className="text-xs text-slate-500">Not yet analyzed</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Development eligibility</span>
            <span className="text-xs text-slate-500">Not yet determined</span>
          </div>
        </div>
        
        {/* Error message if any query failed */}
        {siteInfo.existingConditions && 
         (siteInfo.existingConditions.buildings.state === 'error' || 
          siteInfo.existingConditions.intersectingStreets.state === 'error' ||
          siteInfo.existingConditions.nearbyStreets.state === 'error') && (
          <div className="mt-3 p-2 bg-red-900/20 border border-red-800 rounded">
            <p className="text-xs text-red-300">
              Existing-condition data could not be loaded. Development eligibility cannot be evaluated.
            </p>
          </div>
        )}
      </div>

      {/* Development Purpose */}
      <div className="border-t border-slate-600 pt-4">
        <h4 className="text-sm font-medium text-[#8ED8C0] mb-3">Development Purpose</h4>
        <p className="text-xs text-slate-400 leading-relaxed">
          Existing roads, buildings, and parcel boundaries will remain locked. Future development may only be added within verified developable portions of the selected parcel.
        </p>
      </div>

      {/* Existing Locked Features */}
      {siteInfo.existingConditions && 
       (siteInfo.existingConditions.buildings.state === 'success' || 
        siteInfo.existingConditions.buildings.state === 'success-zero') && (
        <div className="border-t border-slate-600 pt-4">
          <h4 className="text-sm font-medium text-[#8ED8C0] mb-3">Existing Locked Features</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Existing developed area</span>
              <span className="text-xs text-[#8ED8C0]">{siteInfo.existingConditions.buildings.count} building footprints</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Intersecting streets</span>
              <span className="text-xs text-[#8ED8C0]">{siteInfo.existingConditions.intersectingStreets.count} street segments</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Additional nearby streets (100 ft)</span>
              <span className="text-xs text-[#8ED8C0]">{siteInfo.existingConditions.nearbyStreets.additionalCount} street segments</span>
            </div>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed mt-3">
            Candidate open area represents land not currently covered by the loaded existing-condition features. It is not confirmed developable until zoning, access, terrain, environmental, ownership, easement, and other constraints are evaluated.
          </p>
        </div>
      )}

      {/* Candidate Open Area */}
      {candidateOpenArea && (
        <div className="border-t border-slate-600 pt-4">
          <h4 className="text-sm font-medium text-[#8ED8C0] mb-3">Candidate Open Area</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Status</span>
              <span className={`text-xs ${candidateOpenArea.status === 'failed' ? 'text-red-400' : candidateOpenArea.status === 'warning' ? 'text-yellow-400' : 'text-[#8ED8C0]'}`}>
                {candidateOpenArea.status === 'failed' ? 'Failed' : candidateOpenArea.status === 'warning' ? 'Loaded with warnings' : candidateOpenArea.status === 'empty' ? 'Empty' : 'Loaded'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate open acres</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.candidateAreaAcres.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate open sq ft</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.candidateAreaSqFt.toFixed(0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate open percentage</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.candidatePercent.toFixed(1)}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Number of components</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.componentCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Largest contiguous component</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.largestComponentAcres.toFixed(2)} acres</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Building exclusion area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.buildingAreaAcres.toFixed(2)} acres</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Estimated road-corridor exclusion area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.roadAreaAcres.toFixed(2)} acres</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Total unique locked-feature area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.totalLockedAreaAcres.toFixed(2)} acres</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Road corridor assumption</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.roadHalfWidthFeet} ft each side</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Geometry-quality result</span>
              <span className={`text-xs ${candidateOpenArea.conservationWithinTolerance ? 'text-[#8ED8C0]' : 'text-yellow-400'}`}>
                {candidateOpenArea.conservationWithinTolerance ? 'Within tolerance' : 'Warning'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Calculated parcel area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.parcelAreaSqFt.toFixed(0)} sq ft</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.candidateAreaSqFt.toFixed(0)} sq ft</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Unique locked area</span>
              <span className="text-xs text-[#8ED8C0]">{candidateOpenArea.totalLockedAreaSqFt.toFixed(0)} sq ft</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate + locked area</span>
              <span className="text-xs text-[#8ED8C0]">{(candidateOpenArea.candidateAreaSqFt + candidateOpenArea.totalLockedAreaSqFt).toFixed(0)} sq ft</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Area-conservation difference</span>
              <span className={`text-xs ${candidateOpenArea.conservationWithinTolerance ? 'text-[#8ED8C0]' : 'text-yellow-400'}`}>
                {candidateOpenArea.conservationDifferenceSqFt.toFixed(0)} sq ft
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Area-conservation tolerance</span>
              <span className="text-xs text-slate-400">{Math.max(candidateOpenArea.parcelAreaSqFt * 0.01, 250).toFixed(0)} sq ft</span>
            </div>
            {candidateOpenArea.gisAcreage && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300">GIS acreage</span>
                  <span className="text-xs text-slate-400">{candidateOpenArea.gisAcreage.toFixed(2)} acres</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300">GIS comparison difference</span>
                  <span className={`text-xs ${Math.abs(candidateOpenArea.parcelAreaAcres - candidateOpenArea.gisAcreage) / candidateOpenArea.gisAcreage * 100 <= 5 ? 'text-[#8ED8C0]' : 'text-yellow-400'}`}>
                    {Math.abs(candidateOpenArea.parcelAreaAcres - candidateOpenArea.gisAcreage).toFixed(2)} acres ({(Math.abs(candidateOpenArea.parcelAreaAcres - candidateOpenArea.gisAcreage) / candidateOpenArea.gisAcreage * 100).toFixed(1)}%)
                  </span>
                </div>
              </>
            )}
          </div>
          
          {/* Warnings */}
          {candidateOpenArea.warnings.length > 0 && (
            <div className="mt-3 p-2 bg-yellow-900/20 border border-yellow-700 rounded">
              {candidateOpenArea.warnings.map((warning: string, idx: number) => (
                <p key={idx} className="text-xs text-yellow-200">{warning}</p>
              ))}
            </div>
          )}
          
          {/* Errors */}
          {candidateOpenArea.errors.length > 0 && (
            <div className="mt-3 p-2 bg-red-900/20 border border-red-800 rounded">
              {candidateOpenArea.errors.map((error: string, idx: number) => (
                <p key={idx} className="text-xs text-red-300">{error}</p>
              ))}
            </div>
          )}
          
          {/* Disclosure */}
          <div className="mt-3 p-2 bg-blue-900/20 border border-blue-700 rounded">
            <p className="text-xs text-blue-200 leading-relaxed">
              Candidate Open Area is preliminary. It represents land not covered by the currently loaded building footprints and estimated road corridors. It has not been evaluated for zoning, setbacks, access, terrain, environmental constraints, easements, ownership, utilities, or engineering feasibility.
            </p>
          </div>
        </div>
      )}

      {/* Development Diagnostics */}
      {import.meta.env.DEV && candidateOpenArea && (
        <div className="border-t border-slate-600 pt-4 mt-4">
          <h4 className="text-sm font-medium text-yellow-400 mb-3">Analysis Map Layers (Dev Only)</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Building geometry</span>
              <span className={`text-xs ${candidateOpenArea.buildingUnionGeometry ? 'text-[#8ED8C0]' : 'text-red-400'}`}>
                {candidateOpenArea.buildingUnionGeometry ? 'Loaded' : 'Missing'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Road corridor geometry</span>
              <span className={`text-xs ${candidateOpenArea.roadCorridorGeometry ? 'text-[#8ED8C0]' : 'text-red-400'}`}>
                {candidateOpenArea.roadCorridorGeometry ? 'Loaded' : 'Missing'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate geometry</span>
              <span className={`text-xs ${candidateOpenArea.candidateGeometry ? 'text-[#8ED8C0]' : 'text-red-400'}`}>
                {candidateOpenArea.candidateGeometry ? 'Loaded' : 'Missing'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Building geometry type</span>
              <span className="text-xs text-slate-400">{candidateOpenArea.buildingUnionGeometry?.geometry?.type || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Road geometry type</span>
              <span className="text-xs text-slate-400">{candidateOpenArea.roadCorridorGeometry?.geometry?.type || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Candidate geometry type</span>
              <span className="text-xs text-slate-400">{candidateOpenArea.candidateGeometry?.geometry?.type || 'N/A'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Data Source */}
      <div className="border-t border-slate-600 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Data source</span>
          <span className="text-xs text-slate-400">Loudoun County GIS</span>
        </div>
        {siteInfo.existingConditions && (
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-slate-500">Analysis timestamp</span>
            <span className="text-xs text-slate-400">
              {new Date(siteInfo.existingConditions.analysisTimestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// Section 2: Development Type
function DevelopmentTypeSection({ value, onChange }: { value: DevelopmentUse[], onChange: (program: DevelopmentUse[]) => void }) {
  const devTypes = [
    { id: 'single-family', label: 'Single-family homes' },
    { id: 'townhomes', label: 'Townhomes' },
    { id: 'apartments', label: 'Apartments' },
    { id: 'commercial', label: 'Commercial' },
    { id: 'mixed-use', label: 'Mixed-use' }
  ]

  const toggleType = (typeId: string) => {
    const existing = value.find(u => u.id === typeId)
    if (existing) {
      onChange(value.filter(u => u.id !== typeId))
    } else {
      onChange([...value, {
        id: typeId,
        category: 'residential' as any,
        useType: typeId,
        enabled: true,
        priority: 'medium'
      }])
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      {devTypes.map((type) => {
        const enabled = value.some(u => u.id === type.id)
        return (
          <label
            key={type.id}
            className="flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors"
            style={{
              background: enabled
                ? 'rgba(64, 130, 109, 0.18)'
                : 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
              border: enabled ? '1px solid var(--seafoam)' : '1px solid #40826D'
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => toggleType(type.id)}
              className="w-4 h-4 rounded border-slate-500"
            />
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{type.label}</span>
          </label>
        )
      })}
    </div>
  )
}

// Section 3: Development Intensity
function DevelopmentIntensitySection({ value, onChange }: { value: ZoningLotParameters, onChange: (zoning: ZoningLotParameters) => void }) {
  const getIntensityFromDensity = (density: number | undefined) => {
    if (!density) return 'medium'
    if (density > 8) return 'high'
    if (density > 4) return 'medium'
    return 'low'
  }

  const getDensityFromIntensity = (intensity: string) => {
    switch (intensity) {
      case 'high': return 10
      case 'medium': return 6
      case 'low': return 2
      default: return 6
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Intensity Level</label>
        <ThemedSelect
          value={getIntensityFromDensity(value.targetDensity)}
          onChange={(intensity) => {
            const density = getDensityFromIntensity(intensity)
            onChange({ ...value, targetDensity: density })
          }}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
          className="w-full"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Optional Target Lot/Unit Count</label>
        <input
          type="number"
          min="0"
          value={(value as any).targetLotUnitCount || ''}
          onChange={(e) => onChange({ ...value, targetLotUnitCount: e.target.value ? parseInt(e.target.value) : undefined } as any)}
          className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:border-[#93E9BE]"
          style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
          placeholder="Optional"
        />
      </div>
      <div className="bg-yellow-900/20 border border-yellow-700 rounded p-3">
        <p className="text-xs text-yellow-200">
          These density options are planning preferences. Confirm zoning requirements with the governing jurisdiction.
        </p>
      </div>
    </div>
  )
}

// Section 4: Lot and Building Preferences
function LotPreferencesSection({ value, onChange }: { value: ZoningLotParameters, onChange: (zoning: ZoningLotParameters) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Preferred Lot Size (sq ft)</label>
        <input
          type="number"
          min="0"
          value={(value as any).preferredLotSize || ''}
          onChange={(e) => onChange({ ...value, preferredLotSize: e.target.value ? parseInt(e.target.value) : undefined } as any)}
          className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:border-[#93E9BE]"
          style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
          placeholder="Optional"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Preferred Building Type</label>
        <ThemedSelect
          value={value.buildingFootprintPreference || 'detached'}
          onChange={(buildingType) => onChange({ ...value, buildingFootprintPreference: buildingType })}
          options={[
            { value: 'detached', label: 'Detached' },
            { value: 'attached', label: 'Attached' },
            { value: 'mixed', label: 'Mixed' },
          ]}
          className="w-full"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Additional Notes</label>
        <textarea
          className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:border-[#93E9BE] resize-none"
          style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
          rows={2}
          placeholder="Optional preferences..."
        />
      </div>
    </div>
  )
}

// Section 5: Roads and Access
function RoadsAccessSection({ value, onChange }: { value: RoadParameters, onChange: (roads: RoadParameters) => void }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={(value as any).minimizeTotalPavement || false}
            onChange={(e) => onChange({ ...value, minimizeTotalPavement: e.target.checked } as any)}
            className="mr-2"
          />
          <span className="text-sm">Minimize new road length</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={(value as any).prioritizeExistingConnections !== false}
            onChange={(e) => onChange({ ...value, prioritizeExistingConnections: e.target.checked } as any)}
            className="mr-2"
          />
          <span className="text-sm">Prefer multiple connections</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={(value as any).allowCuldesac || false}
            onChange={(e) => onChange({ ...value, allowCuldesac: e.target.checked } as any)}
            className="mr-2"
          />
          <span className="text-sm">Allow cul-de-sac</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={(value as any).sidewalkEnabled || false}
            onChange={(e) => onChange({ ...value, sidewalkEnabled: e.target.checked } as any)}
            className="mr-2"
          />
          <span className="text-sm">Sidewalk preference</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={(value as any).trailEnabled || false}
            onChange={(e) => onChange({ ...value, trailEnabled: e.target.checked } as any)}
            className="mr-2"
          />
          <span className="text-sm">Shared-use path preference</span>
        </label>
      </div>
      <div className="rounded p-3" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>
        <p className="text-xs text-[#93E9BE]">
          New roads must connect to the existing road network. Existing roads cannot be changed.
        </p>
      </div>
    </div>
  )
}

// Section 6: Open Space and Amenities
function OpenSpaceSection({ value, onChange }: { value: AmenityParameters, onChange: (amenities: AmenityParameters) => void }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={value.minOpenSpacePercentage ? value.minOpenSpacePercentage > 0 : true}
            onChange={(e) => onChange({ ...value, minOpenSpacePercentage: e.target.checked ? 15 : undefined })}
            className="mr-2"
          />
          <span className="text-sm">Preserve open space where possible</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={value.communityGreen}
            onChange={(e) => onChange({ ...value, communityGreen: e.target.checked })}
            className="mr-2"
          />
          <span className="text-sm">Community green</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={value.playground}
            onChange={(e) => onChange({ ...value, playground: e.target.checked })}
            className="mr-2"
          />
          <span className="text-sm">Playground</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={value.trailNetwork}
            onChange={(e) => onChange({ ...value, trailNetwork: e.target.checked })}
            className="mr-2"
          />
          <span className="text-sm">Trail</span>
        </label>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={value.park}
            onChange={(e) => onChange({ ...value, park: e.target.checked })}
            className="mr-2"
          />
          <span className="text-sm">Other amenity</span>
        </label>
      </div>
      <div className="bg-green-900/20 border border-green-700 rounded p-3">
        <p className="text-xs text-green-200">
          Do not call visually open land developable until analysis verifies it.
        </p>
      </div>
    </div>
  )
}

// Section 7: Generation Goal
function GenerationGoalSection({ value, onChange }: { value: GenerationPriorities, onChange: (priorities: GenerationPriorities) => void }) {
  const goals = [
    { key: 'balanced', label: 'Balanced plan' },
    { key: 'max-yield', label: 'Maximize lots or units' },
    { key: 'min-road', label: 'Minimize road construction' },
    { key: 'min-grading', label: 'Minimize grading' },
    { key: 'max-open-space', label: 'Maximize open space' }
  ]

  const selectedGoal = goals.find(g => {
    if (g.key === 'balanced') return value.maxOpenSpace === 'medium' && value.minGrading === 'medium'
    if (g.key === 'max-yield') return value.maxUnitYield === 'high'
    if (g.key === 'min-road') return value.minRoadLength === 'high'
    if (g.key === 'min-grading') return value.minGrading === 'high'
    if (g.key === 'max-open-space') return value.maxOpenSpace === 'high'
    return false
  })

  const setGoal = (goalKey: string) => {
    const newPriorities = { ...value }
    if (goalKey === 'balanced') {
      newPriorities.maxUnitYield = 'medium'
      newPriorities.minGrading = 'medium'
      newPriorities.minRoadLength = 'medium'
      newPriorities.maxOpenSpace = 'medium'
    } else if (goalKey === 'max-yield') {
      newPriorities.maxUnitYield = 'high'
      newPriorities.minGrading = 'low'
      newPriorities.minRoadLength = 'low'
      newPriorities.maxOpenSpace = 'low'
    } else if (goalKey === 'min-road') {
      newPriorities.maxUnitYield = 'medium'
      newPriorities.minGrading = 'medium'
      newPriorities.minRoadLength = 'high'
      newPriorities.maxOpenSpace = 'medium'
    } else if (goalKey === 'min-grading') {
      newPriorities.maxUnitYield = 'medium'
      newPriorities.minGrading = 'high'
      newPriorities.minRoadLength = 'medium'
      newPriorities.maxOpenSpace = 'medium'
    } else if (goalKey === 'max-open-space') {
      newPriorities.maxUnitYield = 'low'
      newPriorities.minGrading = 'medium'
      newPriorities.minRoadLength = 'medium'
      newPriorities.maxOpenSpace = 'high'
    }
    onChange(newPriorities)
  }

  return (
    <div className="space-y-2">
      {goals.map((goal) => (
        <label
          key={goal.key}
          className={`flex items-center p-3 rounded-lg cursor-pointer border transition-colors ${
            selectedGoal?.key === goal.key
              ? 'bg-[#8ED8C0]/20 border-[#8ED8C0]'
              : ''
          }`}
          style={selectedGoal?.key !== goal.key ? {
            background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
            border: '1px solid #40826D'
          } : undefined}
        >
          <input
            type="radio"
            name="generationGoal"
            value={goal.key}
            checked={selectedGoal?.key === goal.key}
            onChange={() => setGoal(goal.key)}
            className="mr-3"
          />
          <span className="text-sm">{goal.label}</span>
        </label>
      ))}
    </div>
  )
}

// Section 1A: Development Approach
function DevelopmentApproachSection({
  value,
  onChange
}: {
  value: DevelopmentApproach
  onChange: (v: DevelopmentApproach) => void
}) {
  const options = [
    {
      key: 'NEW_DEVELOPMENT',
      label: 'New Development',
      description: 'Plan primarily within available/developable land while preserving existing development.'
    },
    {
      key: 'REDEVELOPMENT',
      label: 'Redevelopment',
      description: 'Evaluate conceptual replacement or reconfiguration of existing development within the selected parcel.'
    }
  ]

  return (
    <div className="space-y-2">
      {options.map((opt) => (
        <label
          key={opt.key}
          className={`flex flex-col p-3 rounded-lg cursor-pointer border transition-colors ${
            value === opt.key ? 'bg-[#8ED8C0]/20 border-[#8ED8C0]' : ''
          }`}
          style={value !== opt.key ? {
            background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
            border: '1px solid #40826D'
          } : undefined}
        >
          <div className="flex items-center">
            <input
              type="radio"
              name="developmentApproach"
              value={opt.key}
              checked={value === opt.key}
              onChange={() => onChange(opt.key as DevelopmentApproach)}
              className="mr-3"
            />
            <span className="text-sm font-semibold">{opt.label}</span>
          </div>
          <span className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{opt.description}</span>
        </label>
      ))}
    </div>
  )
}

// Section 1B: Redevelopment Site Treatment
function RedevelopmentTreatmentSection({
  value,
  onChange
}: {
  value: RedevelopmentPreferences
  onChange: (updates: Partial<RedevelopmentPreferences>) => void
}) {
  const groups = [
    {
      key: 'buildingTreatment',
      label: 'Existing Buildings',
      options: [
        { value: 'PRESERVE_ALL', label: 'Preserve All' },
        { value: 'SELECTIVE_REPLACEMENT', label: 'Allow Selective Replacement' },
        { value: 'BROAD_REDEVELOPMENT', label: 'Allow Broad Redevelopment' }
      ]
    },
    {
      key: 'pavementTreatment',
      label: 'Existing Pavement',
      options: [
        { value: 'PRESERVE_ALL', label: 'Preserve All' },
        { value: 'SELECTIVE_RECONFIGURATION', label: 'Allow Selective Reconfiguration' },
        { value: 'BROAD_REDEVELOPMENT', label: 'Allow Broad Redevelopment' }
      ]
    },
    {
      key: 'internalRoadTreatment',
      label: 'Existing Internal Roads / Access',
      options: [
        { value: 'PRESERVE_ACCESS', label: 'Preserve Existing Access' },
        { value: 'ALLOW_RECONFIGURATION', label: 'Allow Internal Road Reconfiguration' }
      ]
    }
  ]

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-secondary)' }}>
        Redevelopment settings describe which existing site elements may be considered for conceptual replacement in future redevelopment generation. Current mapped constraints remain enforced unless explicitly supported by the generation engine.
      </p>
      {groups.map((g) => (
        <div key={g.key} className="space-y-2">
          <h5 className="text-sm font-semibold">{g.label}</h5>
          <div className="space-y-1">
            {g.options.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-center p-2 rounded-lg cursor-pointer border transition-colors ${
                  value[g.key as keyof RedevelopmentPreferences] === opt.value ? 'bg-[#8ED8C0]/20 border-[#8ED8C0]' : ''
                }`}
                style={value[g.key as keyof RedevelopmentPreferences] !== opt.value ? {
                  background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
                  border: '1px solid #40826D'
                } : undefined}
              >
                <input
                  type="radio"
                  name={g.key}
                  value={opt.value}
                  checked={value[g.key as keyof RedevelopmentPreferences] === opt.value}
                  onChange={() => onChange({ [g.key]: opt.value } as Partial<RedevelopmentPreferences>)}
                  className="mr-3"
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Section 9: Applied Parameters (shows submitted parameters after analysis)
function AppliedParametersSection({
  submittedParameters,
  candidateOpenArea,
  parcelFeasibilityAssessment,
  onEdit
}: {
  submittedParameters: SubmittedParameters | null
  candidateOpenArea: CandidateOpenAreaResult | null
  parcelFeasibilityAssessment: ParcelFeasibilityAssessment | null
  onEdit?: () => void
}) {
  if (!submittedParameters) return null

  const { parameters } = submittedParameters
  const simplified = getSimplifiedFromProjectParameters(parameters)

  const fmtAc = (n?: number | null) =>
    n == null || isNaN(n) ? '—' : `${n.toFixed(2)} ac`
  const fmtPct = (n?: number | null) =>
    n == null || isNaN(n) ? '—' : `${(n > 1 ? n : n * 100).toFixed(1)}%`
  const fmtCount = (n?: number | null) =>
    n == null || isNaN(n) ? '—' : `${Math.round(n).toLocaleString()}`
  const fmtFt = (n?: number | null) =>
    n == null || isNaN(n) ? '—' : `${Math.round(n).toLocaleString()} ft`

  const status = candidateOpenArea?.status ?? 'analysis-required'
  const sitePriorities = [
    simplified.avoidSteepSlopes && 'Preserve environmental',
    simplified.preserveBuildings && 'Preserve existing',
    simplified.prioritizeDirectAccess && 'Direct access'
  ].filter(Boolean).join(', ') || 'None'

  const [open, setOpen] = useState({
    siteConditions: false,
    devParams: false,
    advanced: false,
    redevelopmentEffect: false
  })

  const toggle = (key: keyof typeof open) => {
    setOpen(prev => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="rounded-lg p-3 mb-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
      <h3 className="text-sm font-semibold text-[#93E9BE] mb-2">Analysis Summary</h3>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase text-slate-400">Candidate developable area</p>
          <p className="text-sm font-semibold text-white">{fmtAc(candidateOpenArea?.candidateAreaAcres)}</p>
        </div>
        <div className="p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase text-slate-400">Candidate %</p>
          <p className="text-sm font-semibold text-white">{fmtPct(candidateOpenArea?.candidatePercent)}</p>
        </div>
        <div className="p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase text-slate-400">Major mapped constraint</p>
          <p className="text-sm font-semibold text-white">{parcelFeasibilityAssessment?.dominantConstraint ?? '—'}</p>
        </div>
        <div className="p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase text-slate-400">Analysis status</p>
          <p className="text-sm font-semibold text-white">{status}</p>
        </div>
      </div>

      <CollapsibleSection
        id="post-site-conditions"
        title="Site Conditions"
        expanded={open.siteConditions}
        onToggle={() => toggle('siteConditions')}
      >
        <div className="space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-slate-400">Buildings</span><span className="text-white">{parcelFeasibilityAssessment?.buildingStatus ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Water / wetlands</span><span className="text-white">{parcelFeasibilityAssessment?.hydrologyStatus ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Pavement</span><span className="text-white">{parcelFeasibilityAssessment?.pavementStatus ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Terrain</span><span className="text-white">{parcelFeasibilityAssessment?.terrainStatus ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Access</span><span className="text-white">{parcelFeasibilityAssessment?.accessStatus ?? '—'}</span></div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="post-dev-params"
        title="Development Parameters"
        expanded={open.devParams}
        onToggle={() => toggle('devParams')}
      >
        <div className="space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-slate-400">Development approach</span><span className="text-white">{parameters.developmentApproach?.replace(/_/g, ' ') ?? 'New Development'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Development type</span><span className="text-white">{parameters.developmentProgram?.filter(d => d.enabled).map(d => d.useType).join(', ') || 'None'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Intensity</span><span className="text-white">{simplified.developmentIntensity}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Site priorities</span><span className="text-white text-right">{sitePriorities}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Road network</span><span className="text-white">{simplified.roadNetwork}</span></div>
          {parameters.developmentApproach === 'REDEVELOPMENT' && (
            <>
              <div className="flex justify-between"><span className="text-slate-400">Existing building treatment</span><span className="text-white">{parameters.redevelopment?.buildingTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Existing pavement treatment</span><span className="text-white">{parameters.redevelopment?.pavementTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Internal road treatment</span><span className="text-white">{parameters.redevelopment?.internalRoadTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
              <p className="text-[10px] leading-[1.3] mt-2" style={{ color: 'var(--text-secondary)' }}>
                Redevelopment settings describe which existing site elements may be considered for conceptual replacement in future redevelopment generation. Current mapped constraints remain enforced unless explicitly supported by the generation engine.
              </p>
            </>
          )}
        </div>
      </CollapsibleSection>

      {parameters.developmentApproach === 'REDEVELOPMENT' && (
        <CollapsibleSection
          id="post-redevelopment-effect"
          title="Redevelopment Effect"
          expanded={open.redevelopmentEffect}
          onToggle={() => toggle('redevelopmentEffect')}
        >
          <p className="text-[10px] leading-[1.3] mb-2" style={{ color: 'var(--text-secondary)' }}>
            Redevelopment treatment changes which mapped existing features act as hard constraints. Original mapped features remain visible and exportable.
          </p>

          {candidateOpenArea?.buildingClassification && (
            <div className="mb-2 p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
              <p className="text-[10px] uppercase text-slate-400 mb-1">Buildings</p>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Treatment</span><span className="text-white">{candidateOpenArea.buildingClassification.buildingTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Preserved</span><span className="text-white">{fmtCount(candidateOpenArea.buildingClassification.preservedBuildingCount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Redevelopment-eligible</span><span className="text-white">{fmtCount(candidateOpenArea.buildingClassification.redevelopmentEligibleBuildingCount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Preserved area</span><span className="text-white">{fmtAc(candidateOpenArea.buildingClassification.preservedBuildingAreaSqFt / 43560)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Eligible area</span><span className="text-white">{fmtAc(candidateOpenArea.buildingClassification.redevelopmentEligibleBuildingAreaSqFt / 43560)}</span></div>
              </div>
            </div>
          )}

          {candidateOpenArea?.pavementClassification && (
            <div className="mb-2 p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
              <p className="text-[10px] uppercase text-slate-400 mb-1">Pavement</p>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Treatment</span><span className="text-white">{candidateOpenArea.pavementClassification.pavementTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Preserved</span><span className="text-white">{fmtCount(candidateOpenArea.pavementClassification.preservedPavementCount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Reconfiguration-eligible</span><span className="text-white">{fmtCount(candidateOpenArea.pavementClassification.reconfigurationEligiblePavementCount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Preserved area</span><span className="text-white">{fmtAc(candidateOpenArea.pavementClassification.preservedPavementAreaSqFt / 43560)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Eligible area</span><span className="text-white">{fmtAc(candidateOpenArea.pavementClassification.reconfigurationEligiblePavementAreaSqFt / 43560)}</span></div>
              </div>
            </div>
          )}

          {candidateOpenArea?.internalRoadClassification && (
            <div className="mb-2 p-2 rounded" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
              <p className="text-[10px] uppercase text-slate-400 mb-1">Internal Roads / Access</p>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Treatment</span><span className="text-white">{candidateOpenArea.internalRoadClassification.internalRoadTreatment?.replace(/_/g, ' ') ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Protected external roads</span><span className="text-white">{fmtCount(candidateOpenArea.internalRoadClassification.protectedExternalRoadCount)} ({fmtFt(candidateOpenArea.internalRoadClassification.protectedExternalRoadLengthFt)})</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Reconfiguration-eligible internal roads</span><span className="text-white">{fmtCount(candidateOpenArea.internalRoadClassification.reconfigurationEligibleInternalRoadCount)} ({fmtFt(candidateOpenArea.internalRoadClassification.reconfigurationEligibleInternalRoadLengthFt)})</span></div>
                {candidateOpenArea.internalRoadClassification.classificationBasis === 'CONSERVATIVE_NO_RELIABLE_INTERNAL_CLASSIFICATION' && (
                  <p className="text-[10px] leading-[1.3] mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Internal road reconfiguration requested, but current GIS data cannot reliably distinguish private/internal circulation from the public road network. External/public access constraints remain protected.
                  </p>
                )}
              </div>
            </div>
          )}

          {candidateOpenArea?.buildingClassification && candidateOpenArea?.pavementClassification && (
            <div className="p-2 rounded" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid #f59e0b' }}>
              <p className="text-[10px] uppercase text-amber-400 mb-1">Hard constraints relaxed</p>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Building area released</span><span className="text-white">{fmtAc(candidateOpenArea.buildingClassification.redevelopmentEligibleBuildingAreaSqFt / 43560)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Pavement area released</span><span className="text-white">{fmtAc(candidateOpenArea.pavementClassification.reconfigurationEligiblePavementAreaSqFt / 43560)}</span></div>
              </div>
            </div>
          )}
        </CollapsibleSection>
      )}

      <CollapsibleSection
        id="post-advanced"
        title="Advanced Analysis Details"
        expanded={open.advanced}
        onToggle={() => toggle('advanced')}
      >
        <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
          <div className="flex justify-between"><span className="text-slate-400">Parcel area</span><span className="text-white">{fmtAc(candidateOpenArea?.parcelAreaAcres)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Locked area</span><span className="text-white">{fmtAc(candidateOpenArea?.totalLockedAreaAcres)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Building area</span><span className="text-white">{fmtAc(candidateOpenArea?.buildingAreaAcres)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Pavement area</span><span className="text-white">{fmtAc(candidateOpenArea?.pavementAreaAcres)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Hydrology area</span><span className="text-white">{fmtAc(candidateOpenArea?.hydrologyAreaAcres)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Components</span><span className="text-white">{candidateOpenArea?.componentCount ?? '—'}</span></div>
        </div>
      </CollapsibleSection>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="w-full mt-3 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[13px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
          style={{ background: 'transparent', border: '1px solid rgba(64, 130, 109, 0.45)', color: 'var(--soft-seafoam)' }}
        >
          Edit Parameters
        </button>
      )}
    </div>
  )
}

// Section 8: Notes
function NotesSection({ value, onChange }: { value: string, onChange: (notes: string) => void }) {
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:border-[#93E9BE] resize-none"
        style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
        rows={6}
        placeholder="Add any additional notes or requirements..."
      />
    </div>
  )
}

function RecommendedBadge() {
  return (
    <span
      className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap"
      style={{ background: 'rgba(64, 130, 109, 0.2)', color: 'var(--soft-seafoam)', border: '1px solid rgba(64, 130, 109, 0.45)' }}
    >
      Recommended
    </span>
  )
}

function RecommendedStartingPointCard({
  simplified,
  assessment
}: {
  simplified: SimplifiedParameters | null
  assessment: ParcelFeasibilityAssessment | null
}) {
  if (!simplified) return null

  return (
    <div className="rounded-lg p-4 mb-3" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}>
      <h3 className="text-sm font-semibold text-[#93E9BE] mb-2">Recommended Starting Point</h3>
      <div className="space-y-1 mb-2">
        <div className="flex justify-between text-sm">
          <span className="text-slate-400">Development intensity</span>
          <span className="text-white font-medium">{simplified.developmentIntensity}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-400">Road network</span>
          <span className="text-white font-medium">{simplified.roadNetwork}</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--seafoam)' }}>
        {simplified.explanation}
      </p>
      {assessment?.overallRating === 'CHALLENGING' && (
        <p className="text-xs text-yellow-200 mt-2">
          Mapped constraints may substantially limit development flexibility. Recommended settings are intentionally conservative.
        </p>
      )}
    </div>
  )
}

function SimplifiedDevelopmentIntensitySection({
  value,
  showRecommended,
  onChange
}: {
  value: SimplifiedDevelopmentIntensity
  showRecommended: boolean
  onChange: (v: SimplifiedDevelopmentIntensity) => void
}) {
  const options: { key: SimplifiedDevelopmentIntensity; label: string; description: string }[] = [
    { key: 'LOW', label: 'LOW', description: 'More open space / larger development footprints' },
    { key: 'MEDIUM', label: 'MEDIUM', description: 'Balanced' },
    { key: 'HIGH', label: 'HIGH', description: 'Greater yield emphasis' }
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Development Intensity</label>
        {showRecommended && <RecommendedBadge />}
      </div>
      <div className="space-y-2">
        {options.map((opt) => {
          const selected = value === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              className="w-full text-left p-3 rounded-lg transition-colors"
              style={{
                background: selected
                  ? 'rgba(64, 130, 109, 0.18)'
                  : 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
                border: selected ? '1px solid var(--seafoam)' : '1px solid #40826D'
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-4 h-4 rounded-full border flex-shrink-0"
                  style={{
                    borderColor: selected ? 'var(--seafoam)' : 'rgba(201, 244, 226, 0.35)',
                    background: selected ? 'var(--seafoam)' : 'transparent'
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>— {opt.description}</span>
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SitePlanningPreferencesSection({
  value,
  showRecommended,
  onToggle
}: {
  value: SimplifiedParameters
  showRecommended: (key: keyof SimplifiedParameters) => boolean
  onToggle: (key: keyof SimplifiedParameters, next: boolean) => void
}) {
  const items: { key: keyof SimplifiedParameters; label: string }[] = [
    { key: 'avoidSteepSlopes', label: 'Preserve environmental constraints' },
    { key: 'preserveBuildings', label: 'Preserve existing development' },
    { key: 'prioritizeDirectAccess', label: 'Prioritize direct road access' }
  ]

  return (
    <div className="space-y-2">
      {items.map(({ key, label }) => (
        <label
          key={String(key)}
          className="flex items-start gap-3 p-3 rounded-lg"
          style={{ background: 'rgba(5, 8, 7, 0.55)', border: '1px solid rgba(64, 130, 109, 0.45)' }}
        >
          <input
            type="checkbox"
            checked={!!(value as any)[key]}
            onChange={(e) => onToggle(key, e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-slate-500 flex-shrink-0"
          />
          <div className="min-w-0 flex-1 flex items-center justify-between gap-2">
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</span>
            {showRecommended(key) && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap flex-shrink-0"
                style={{ background: 'rgba(64, 130, 109, 0.2)', color: 'var(--soft-seafoam)', border: '1px solid rgba(64, 130, 109, 0.45)' }}
              >
                Recommended
              </span>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

function RoadNetworkAdvancedSelect({
  value,
  onChange
}: {
  value: RoadNetworkPreference
  onChange: (v: RoadNetworkPreference) => void
}) {
  return (
    <ThemedSelect
      value={value}
      onChange={(v) => onChange(v as RoadNetworkPreference)}
      options={[
        { value: 'connected-grid', label: 'Connected grid' },
        { value: 'modified-grid', label: 'Modified grid' },
        { value: 'loop-road', label: 'Loop road' },
        { value: 'loop-culdesacs', label: 'Loop & cul-de-sacs' },
        { value: 'branching', label: 'Branching' },
        { value: 'minimize-new', label: 'Minimize new' },
        { value: 'extend-existing', label: 'Extend existing' },
        { value: 'propose-alternatives', label: 'Propose alternatives' }
      ]}
      className="w-full"
    />
  )
}

function ParkingSection({
  value,
  onChange
}: {
  value: ParkingParameters
  onChange: (v: ParkingParameters) => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Parking Type</label>
        <ThemedSelect
          value={value.parkingType}
          onChange={(v) => onChange({ ...value, parkingType: v as any })}
          options={[
            { value: 'surface', label: 'Surface' },
            { value: 'garage', label: 'Garage' },
            { value: 'structured', label: 'Structured' },
            { value: 'on-street', label: 'On-street' },
            { value: 'mixed', label: 'Mixed' }
          ]}
          className="w-full"
        />
      </div>
      <label className="flex items-center">
        <input
          type="checkbox"
          checked={value.sharedParkingAllowed}
          onChange={(e) => onChange({ ...value, sharedParkingAllowed: e.target.checked })}
          className="mr-2"
        />
        <span className="text-sm">Allow shared parking</span>
      </label>
    </div>
  )
}

function SitePlanningAdvancedSection({
  parameters,
  onChange
}: {
  parameters: ProjectParameters
  onChange: (p: ProjectParameters) => void
}) {
  const simplified = getSimplifiedFromProjectParameters(parameters)
  const items: { key: keyof SimplifiedParameters; label: string }[] = [
    { key: 'avoidSteepSlopes', label: 'Avoid steep slopes' },
    { key: 'minimizeStreamCrossings', label: 'Minimize stream / wetland crossings' },
    { key: 'preserveBuildings', label: 'Preserve existing buildings' },
    { key: 'preservePavement', label: 'Preserve existing pavement' },
    { key: 'prioritizeDirectAccess', label: 'Prioritize direct road access' }
  ]

  const toggle = (key: keyof SimplifiedParameters, next: boolean) => {
    const nextSimplified = { ...simplified, [key]: next }
    onChange(applySimplifiedToProjectParameters(nextSimplified, parameters))
  }

  return (
    <div className="space-y-2">
      {items.map(({ key, label }) => (
        <label key={String(key)} className="flex items-center p-2 rounded-lg" style={{ background: 'rgba(5, 8, 7, 0.55)', border: '1px solid rgba(64, 130, 109, 0.45)' }}>
          <input
            type="checkbox"
            checked={!!(simplified as any)[key]}
            onChange={(e) => toggle(key, e.target.checked)}
            className="mr-3"
          />
          <span className="text-sm">{label}</span>
        </label>
      ))}
    </div>
  )
}

function AdvancedOptionsSection({
  parameters,
  onChange
}: {
  parameters: ProjectParameters
  onChange: (p: ProjectParameters) => void
}) {
  return (
    <div className="space-y-5" style={{ borderLeft: '2px solid var(--plum-soft)', paddingLeft: '12px' }}>
      <p className="text-[12px] leading-[1.45]" style={{ color: 'var(--text-muted)' }}>
        Optional technical controls. Adjust only if you have specific engineering or design requirements.
      </p>
      <div>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--seafoam)' }}>Site Priorities (individual)</h4>
        <SitePlanningAdvancedSection parameters={parameters} onChange={onChange} />
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Development Intensity (advanced)</h4>
        <DevelopmentIntensitySection
          value={parameters.zoningAndLots}
          onChange={(zoning) => onChange({ ...parameters, zoningAndLots: zoning })}
        />
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Lot and Building</h4>
        <LotPreferencesSection
          value={parameters.zoningAndLots}
          onChange={(zoning) => onChange({ ...parameters, zoningAndLots: zoning })}
        />
        <div className="mt-3">
          <label className="block text-sm font-medium text-slate-300 mb-2">Minimum frontage (ft)</label>
          <input
            type="number"
            min="0"
            value={parameters.zoningAndLots.minFrontage || ''}
            onChange={(e) => onChange({ ...parameters, zoningAndLots: { ...parameters.zoningAndLots, minFrontage: e.target.value ? parseInt(e.target.value) : undefined } })}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
            placeholder="Optional"
          />
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Road Network Type</h4>
        <RoadNetworkAdvancedSelect
          value={parameters.roads.networkPreference}
          onChange={(network) => onChange({ ...parameters, roads: { ...parameters.roads, networkPreference: network } })}
        />
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Roads and Access</h4>
        <RoadsAccessSection
          value={parameters.roads}
          onChange={(roads) => onChange({ ...parameters, roads })}
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Road width (ft)</label>
            <input
              type="number"
              min="0"
              value={parameters.roads.rightOfWayWidth || ''}
              onChange={(e) => onChange({ ...parameters, roads: { ...parameters.roads, rightOfWayWidth: e.target.value ? parseInt(e.target.value) : undefined } })}
              className="w-full px-3 py-2 rounded-md text-sm"
              style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Pavement width (ft)</label>
            <input
              type="number"
              min="0"
              value={parameters.roads.pavementWidth || ''}
              onChange={(e) => onChange({ ...parameters, roads: { ...parameters.roads, pavementWidth: e.target.value ? parseInt(e.target.value) : undefined } })}
              className="w-full px-3 py-2 rounded-md text-sm"
              style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)', border: '1px solid #40826D' }}
              placeholder="Optional"
            />
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Open Space and Amenities</h4>
        <OpenSpaceSection
          value={parameters.amenities}
          onChange={(amenities) => onChange({ ...parameters, amenities })}
        />
        <div className="mt-3 space-y-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={parameters.amenities.streamBuffer}
              onChange={(e) => onChange({ ...parameters, amenities: { ...parameters.amenities, streamBuffer: e.target.checked } })}
              className="mr-2"
            />
            <span className="text-sm">Stream buffer</span>
          </label>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={parameters.amenities.wetlandBuffer}
              onChange={(e) => onChange({ ...parameters, amenities: { ...parameters.amenities, wetlandBuffer: e.target.checked } })}
              className="mr-2"
            />
            <span className="text-sm">Wetland buffer</span>
          </label>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Parking</h4>
        <ParkingSection
          value={parameters.parking}
          onChange={(parking) => onChange({ ...parameters, parking })}
        />
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[#8ED8C0] mb-2">Generation Goal</h4>
        <GenerationGoalSection
          value={parameters.priorities}
          onChange={(priorities) => onChange({ ...parameters, priorities })}
        />
      </div>
    </div>
  )
}

export default ParametersPanel
