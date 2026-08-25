import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ProjectParameters } from '../types/parameters'
import { formatParameterSummary } from '../utils/parameterSummary'

const MULTI_DRAFT_STORAGE_KEY = 'subdivmaker-v2-saved-drafts-v1'

export interface DraftRecord {
  draftId: string
  mcpi: string
  parcelAddress: string | null
  parcelMetadata: {
    subdivision?: string
    platNumber?: string
    platLot?: string
    gisAcreage?: number
    legalAcreage?: number
  }
  parameters: ProjectParameters
  createdAt: string
  updatedAt: string
  schemaVersion: number
}

interface DraftCollection {
  schemaVersion: number
  drafts: {
    [normalizedMCPI: string]: DraftRecord
  }
}

interface SavedDraftsCatalogProps {
  isOpen: boolean
  onClose: () => void
  onOpenDraft: (mcpi: string) => void
  onDeleteDraft: (normalizedMCPI: string) => void
  drafts: DraftRecord[]
}

function hasParameterShape(value: any): value is ProjectParameters {
  return value && typeof value === 'object' && 'schemaVersion' in value && 'developmentProgram' in value
}

function normalizeDraftRecord(raw: any): DraftRecord | null {
  if (!raw || typeof raw !== 'object') return null

  // Canonical modern record already has a valid parameters object.
  if (raw.parameters && hasParameterShape(raw.parameters)) {
    return { ...raw, parameters: raw.parameters }
  }

  // Legacy case 1: the record stored the full DraftRecord as `parameters`.
  // Try to extract the nested parameters object.
  if (raw.parameters && typeof raw.parameters === 'object' && hasParameterShape(raw.parameters.parameters)) {
    if (import.meta.env.DEV) {
      console.log('[SavedDrafts] Migrated nested parameters for MCPI', raw.mcpi, 'legacy schema:', raw.parameters.schemaVersion ?? 'unknown')
    }
    return {
      ...raw,
      schemaVersion: 2,
      parameters: raw.parameters.parameters
    }
  }

  // Legacy case 2: top-level record itself is the ProjectParameters object
  // with no separate metadata. Cannot recover MCPI or other fields, so report it.
  if (hasParameterShape(raw) && !(raw as any).draftId) {
    if (import.meta.env.DEV) {
      console.warn('[SavedDrafts] Irrecoverable legacy draft: parameters were stored without metadata', raw)
    }
    return null
  }

  if (import.meta.env.DEV) {
    console.warn('[SavedDrafts] Unrecognized draft record, skipping', raw)
  }
  return null
}

export function useSavedDrafts() {
  const [drafts, setDrafts] = useState<DraftRecord[]>([])

  const loadDrafts = () => {
    try {
      const stored = localStorage.getItem(MULTI_DRAFT_STORAGE_KEY)
      if (stored) {
        const collection: DraftCollection = JSON.parse(stored)
        if (collection.schemaVersion === 1) {
          const draftArray = Object.values(collection.drafts)
            .map(normalizeDraftRecord)
            .filter((d): d is DraftRecord => d !== null)
          setDrafts(draftArray)

          return draftArray
        }
      }
    } catch (error) {
      console.error('Failed to load drafts:', error)
    }
    return []
  }

  const saveDraft = (mcpi: string, parcelAddress: string | null, parcelMetadata: DraftRecord['parcelMetadata'], parameters: ProjectParameters) => {
    try {
      const normalizedMCPI = mcpi.replace(/\D/g, '').padStart(12, '0')
      const now = new Date().toISOString()
      
      const stored = localStorage.getItem(MULTI_DRAFT_STORAGE_KEY)
      let collection: DraftCollection = { schemaVersion: 1, drafts: {} }
      
      if (stored) {
        collection = JSON.parse(stored)
      }
      
      collection.drafts[normalizedMCPI] = {
        draftId: `${normalizedMCPI}-${Date.now()}`,
        mcpi,
        parcelAddress,
        parcelMetadata,
        parameters,
        createdAt: collection.drafts[normalizedMCPI]?.createdAt || now,
        updatedAt: now,
        schemaVersion: 1
      }
      
      localStorage.setItem(MULTI_DRAFT_STORAGE_KEY, JSON.stringify(collection))
      loadDrafts()
    } catch (error) {
      console.error('Failed to save draft:', error)
    }
  }

  const deleteDraft = (normalizedMCPI: string) => {
    try {
      const stored = localStorage.getItem(MULTI_DRAFT_STORAGE_KEY)
      if (stored) {
        const collection: DraftCollection = JSON.parse(stored)
        delete collection.drafts[normalizedMCPI]
        localStorage.setItem(MULTI_DRAFT_STORAGE_KEY, JSON.stringify(collection))
        loadDrafts()
      }
    } catch (error) {
      console.error('Failed to delete draft:', error)
    }
  }

  useEffect(() => {
    loadDrafts()
  }, [])

  return { drafts, saveDraft, deleteDraft, loadDrafts }
}

function SavedDraftsCatalog({ isOpen, onClose, onOpenDraft, onDeleteDraft, drafts }: SavedDraftsCatalogProps) {
  const [draftToDelete, setDraftToDelete] = useState<string | null>(null)

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  const catalogContent = (
    <div 
      className="fixed inset-0 z-[3000] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(1px)' }}
      onClick={handleBackdropClick}
    >
      <div 
        className="border border-[#40826D] rounded-lg shadow-2xl max-w-4xl w-full mx-4 max-h-[80vh] flex flex-col"
        style={{ 
          background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.95) 0%, rgba(11, 33, 27, 0.94) 65%, rgba(24, 76, 61, 0.92) 100%)',
          maxWidth: '900px'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-600 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[#93E9BE]">Saved Drafts</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4">
          {drafts.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-slate-400 mb-4">No saved drafts yet.</p>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
                style={{ background: 'rgba(142, 216, 192, 0.2)', border: '1px solid #8ED8C0', color: '#8ED8C0' }}
              >
                Close
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {drafts.map((draft) => {
                const normalizedMCPI = draft.mcpi.replace(/\D/g, '').padStart(12, '0')
                let summaryRows: any[] = []
                
                try {
                  summaryRows = formatParameterSummary(draft.parameters)
                } catch (error) {
                  console.warn('[SavedDraftsCatalog] Failed to format parameters for draft', draft.draftId, error)
                  summaryRows = []
                }
                
                return (
                  <div key={draft.draftId} className="p-4 rounded-lg border border-[#40826D]" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)' }}>
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-base font-semibold text-[#93E9BE] mb-1 truncate">
                          {draft.parcelAddress || draft.mcpi}
                        </h4>
                        <p className="text-xs text-slate-400">MCPI: {draft.mcpi}</p>
                        {draft.parcelMetadata.subdivision && (
                          <p className="text-xs text-slate-400 truncate">Subdivision: {draft.parcelMetadata.subdivision}</p>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 ml-2 flex-shrink-0">
                        {new Date(draft.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    
                    <div className="space-y-2 text-sm max-h-60 overflow-y-auto">
                      {summaryRows.length > 0 ? (
                        summaryRows
                          .filter(row => row && row.label && row.value && row.label !== '' && row.value !== '')
                          .map((row, idx) => (
                            <div key={idx} className="flex justify-between items-start">
                              <p className="text-xs text-slate-400 flex-shrink-0">{row.label}:</p>
                              <p className="text-xs text-[#93E9BE] ml-2 text-right break-words">
                                {row.value}
                              </p>
                            </div>
                          ))
                      ) : (
                        <p className="text-xs text-slate-500 italic">No custom parameters saved</p>
                      )}
                    </div>
                    
                    <div className="flex gap-2 pt-2 mt-3">
                      <button
                        type="button"
                        onClick={() => onOpenDraft(draft.mcpi)}
                        className="flex-1 px-3 py-1 rounded text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
                        style={{ background: 'rgba(142, 216, 192, 0.2)', border: '1px solid #8ED8C0', color: '#8ED8C0' }}
                      >
                        Open Draft
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraftToDelete(normalizedMCPI)}
                        className="flex-1 px-3 py-1 rounded text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-red-400"
                        style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#ef4444' }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        
        {/* Delete confirmation dialog */}
        {draftToDelete && (
          <div className="p-4 border-t border-slate-600 bg-[#050807]">
            <p className="text-sm text-slate-300 mb-4">
              Are you sure you want to delete this draft?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDraftToDelete(null)}
                className="flex-1 px-4 py-2 rounded-md text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
                style={{ background: 'rgba(142, 216, 192, 0.2)', border: '1px solid #8ED8C0', color: '#8ED8C0' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onDeleteDraft(draftToDelete)
                  setDraftToDelete(null)
                }}
                className="flex-1 px-4 py-2 rounded-md text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-red-400"
                style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#ef4444' }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(catalogContent, document.body)
}

export default SavedDraftsCatalog
