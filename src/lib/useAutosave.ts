import { useEffect, useRef } from 'react'
import type { WorkspaceSavePayload, SaveWorkspaceResult } from './workspaceStorage'
import { saveActiveWorkspace } from './workspaceStorage'

interface UseAutosaveOptions {
  enabled: boolean
  workspace: WorkspaceSavePayload
  isAnalysisRunning: boolean
  isRoadGenerating: boolean
  isAlternativeGenerating: boolean
  debounceMs?: number
  onResult?: (result: SaveWorkspaceResult) => void
}

export function useAutosave({
  enabled,
  workspace,
  isAnalysisRunning,
  isRoadGenerating,
  isAlternativeGenerating,
  debounceMs = 750,
  onResult
}: UseAutosaveOptions) {
  const lastSavedKeyRef = useRef<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWorkspaceRef = useRef<WorkspaceSavePayload | null>(null)

  useEffect(() => {
    if (!enabled) return

    // Do not save an empty/explore-only workspace; we persist once there is
    // meaningful state (parcel selected or further).
    if (workspace.workflowStep === 'explore' && !workspace.selectedParcel) {
      return
    }

    // Block saves while expensive or in-flight operations are running.
    if (isAnalysisRunning || isRoadGenerating || isAlternativeGenerating) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      return
    }

    const serialized = JSON.stringify(workspace)

    // Avoid redundant saves if the workspace has not meaningfully changed.
    if (lastSavedKeyRef.current === serialized) return

    // Avoid rapid successive saves with a trailing debounce.
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    lastWorkspaceRef.current = workspace

    timeoutRef.current = setTimeout(() => {
      if (
        isAnalysisRunning ||
        isRoadGenerating ||
        isAlternativeGenerating
      ) {
        // Guard against state changes that occurred during the debounce window.
        return
      }
      const result = saveActiveWorkspace(workspace)
      if (result.ok) {
        lastSavedKeyRef.current = JSON.stringify(workspace)
      }
      onResult?.(result)
    }, debounceMs)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [enabled, workspace, isAnalysisRunning, isRoadGenerating, isAlternativeGenerating, debounceMs, onResult])

  return {
    lastWorkspace: lastWorkspaceRef.current
  }
}
