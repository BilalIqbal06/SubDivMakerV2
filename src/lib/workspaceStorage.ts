import type { ParcelData } from '../services/gisService'
import type { SubmittedParameters, ProjectParameters, CandidateOpenAreaResult } from '../types/parameters'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'
import type { ConceptStrategy, ConceptAlternativeResult } from '../types/conceptAlternatives'

type AppStep = 'explore' | 'select' | 'parameters' | 'generate'

export interface WorkspaceAnalysisSummary {
  mcpi: string
  parcelAreaAcres: number | null
  developablePercent: number | null
  buildingCount: number
  hydrologyFeatureCount: number
  pavementFeatureCount: number
  hasCandidateOpenArea: boolean
  hasParcelFeasibility: boolean
  hasSubmittedParameters: boolean
  hasGeneratedConcept: boolean
  hasConceptAlternatives: boolean
}

export interface WorkspaceSelectedParcel {
  id: string
  feature: ParcelData
  details: Record<string, any> | null
  addresses: any[]
  selectionRequestId?: number
}

export interface WorkspaceGeneratedConceptSummary {
  mcpi: string
  alternativeId: ConceptStrategy | null
  lotCount: number | null
  unitCount: number | null
  rowCount: number | null
  primaryRoadLengthFt: number | null
  secondaryRoadCount: number | null
  secondaryRoadLengthFt: number | null
  localStreetCount: number | null
  finalLotCount: number | null
  generationStatus: 'idle' | 'generating' | 'complete' | 'failed' | 'aborted'
  generatedAt: string | null
}

export interface WorkspaceSavePayload {
  workflowStep: AppStep
  selectedMCPI: string
  selectedParcel: WorkspaceSelectedParcel | null
  currentParameters: ProjectParameters | null
  submittedParameters: SubmittedParameters | null
  parcelFeasibilityAssessment: ParcelFeasibilityAssessment | null
  analysisRunId: number
  candidateOpenAreaResult: CandidateOpenAreaResult | null
  authoritativeAlternativeId: ConceptStrategy | null
  recommendedAlternativeId: ConceptStrategy | null
  selectedAlternativeId: ConceptStrategy | null
  conceptAlternatives: Array<Partial<ConceptAlternativeResult>> | null
  analysisSummary: WorkspaceAnalysisSummary | null
  generatedConceptData: WorkspaceGeneratedConceptSummary | null
  requiresRegeneration: boolean
}

export interface WorkspaceV1 extends WorkspaceSavePayload {
  schemaVersion: number
  savedAt: string
}

export const ACTIVE_WORKSPACE_STORAGE_KEY = 'subdivmaker-v2-active-workspace'
export const ACTIVE_WORKSPACE_SCHEMA_VERSION = 1
export const ACTIVE_WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const SAFE_LOCAL_STORAGE_SIZE_BYTES = 2 * 1024 * 1024

export type SaveWorkspaceResult =
  | { ok: true; size: number }
  | { ok: false; error: string }

function isQuotaExceededError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'QuotaExceededError' ||
      error.message?.toLowerCase().includes('quota') ||
      error.message?.toLowerCase().includes('exceeded'))
  )
}

function hasSerializableShape(value: unknown): value is WorkspaceV1 {
  if (!value || typeof value !== 'object') return false
  const ws = value as Record<string, unknown>
  return (
    ws.schemaVersion === ACTIVE_WORKSPACE_SCHEMA_VERSION &&
    typeof ws.savedAt === 'string' &&
    typeof ws.workflowStep === 'string' &&
    typeof ws.selectedMCPI === 'string' &&
    typeof ws.analysisRunId === 'number' &&
    typeof ws.requiresRegeneration === 'boolean'
  )
}

function stripCandidateOpenAreaGeometry(
  result: CandidateOpenAreaResult
): CandidateOpenAreaResult {
  const {
    candidateGeometry,
    buildingUnionGeometry,
    roadCorridorGeometry,
    hydrologyGeometry,
    pavementGeometry,
    ...rest
  } = result
  return rest as CandidateOpenAreaResult
}

export function saveActiveWorkspace(payload: WorkspaceSavePayload): SaveWorkspaceResult {
  try {
    let workspace: WorkspaceV1 = {
      ...payload,
      schemaVersion: ACTIVE_WORKSPACE_SCHEMA_VERSION,
      savedAt: new Date().toISOString()
    }

    let serialized = JSON.stringify(workspace)
    let size = new Blob([serialized]).size

    if (size > SAFE_LOCAL_STORAGE_SIZE_BYTES) {
      // Optional GeoJSON geometry fields can be large; strip them once and retry.
      if (
        workspace.candidateOpenAreaResult &&
        (workspace.candidateOpenAreaResult.candidateGeometry ||
          workspace.candidateOpenAreaResult.buildingUnionGeometry ||
          workspace.candidateOpenAreaResult.roadCorridorGeometry ||
          workspace.candidateOpenAreaResult.hydrologyGeometry ||
          workspace.candidateOpenAreaResult.pavementGeometry)
      ) {
        workspace = {
          ...workspace,
          candidateOpenAreaResult: stripCandidateOpenAreaGeometry(workspace.candidateOpenAreaResult)
        }
        serialized = JSON.stringify(workspace)
        size = new Blob([serialized]).size
      }

      if (size > SAFE_LOCAL_STORAGE_SIZE_BYTES) {
        return {
          ok: false,
          error: `Workspace too large to persist (~${Math.round(size / 1024)} KB). Skipped to avoid localStorage quota errors.`
        }
      }
    }

    const cp = (workspace as any).currentParameters
    if (import.meta.env.DEV) {
      console.log('[WorkspaceStorage] save', {
        mcpi: workspace.selectedMCPI,
        hasCurrentParameters: !!cp,
        developmentTypes: cp?.developmentProgram?.filter((d: any) => d?.enabled).map((d: any) => d?.useType) || [],
        size
      })
    }
    localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, serialized)
    return { ok: true, size }
  } catch (error) {
    console.error('[workspaceStorage] Failed to save active workspace:', error)
    if (isQuotaExceededError(error)) {
      return { ok: false, error: 'Storage quota exceeded. Workspace not saved.' }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown save error' }
  }
}

export function loadActiveWorkspace(): WorkspaceV1 | null {
  try {
    const stored = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)
    if (!stored) return null

    const parsed = JSON.parse(stored)
    if (!hasSerializableShape(parsed)) {
      console.warn('[workspaceStorage] Active workspace failed validation; clearing.')
      clearActiveWorkspace()
      return null
    }

    const cp = parsed.currentParameters
    if (import.meta.env.DEV) {
      console.log('[WorkspaceStorage] load', {
        mcpi: parsed.selectedMCPI,
        hasCurrentParameters: !!cp,
        developmentTypes: cp?.developmentProgram?.filter((d: any) => d?.enabled).map((d: any) => d?.useType) || []
      })
    }

    return parsed as WorkspaceV1
  } catch (error) {
    console.error('[workspaceStorage] Failed to load active workspace:', error)
    clearActiveWorkspace()
    return null
  }
}

export function clearActiveWorkspace(): void {
  try {
    localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY)
  } catch (error) {
    console.error('[workspaceStorage] Failed to clear active workspace:', error)
  }
}

export function isWorkspaceExpired(workspace: WorkspaceV1): boolean {
  const savedAt = new Date(workspace.savedAt).getTime()
  return Number.isNaN(savedAt) || Date.now() - savedAt > ACTIVE_WORKSPACE_MAX_AGE_MS
}

export function getActiveWorkspaceSize(): number {
  try {
    const stored = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)
    if (!stored) return 0
    return new Blob([stored]).size
  } catch {
    return 0
  }
}
