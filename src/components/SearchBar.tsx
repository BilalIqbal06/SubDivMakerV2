import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X, Loader2 } from 'lucide-react'
import L from 'leaflet'
import { searchAddresses, fetchParcelByMCPI, fetchParcelByGeometry } from '../services/gisService'

interface SearchBarProps {
  onAddressSelect: (address: any) => void
  onParcelSelect: (parcel: any, source: 'search-result') => void
  onNavigateToAddress?: (lng: number, lat: number) => void
  onRegisterClear?: (clearFn: () => void) => void
}

export default function SearchBar({ onAddressSelect, onParcelSelect, onNavigateToAddress, onRegisterClear }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)

  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const searchBarRef = useRef<HTMLDivElement>(null)

  // Expose clear function to parent
  useEffect(() => {
    if (onRegisterClear) {
      onRegisterClear(() => {
        setQuery('')
        setResults([])
        setShowResults(false)
        setSelectedIndex(-1)
      })
    }
  }, [onRegisterClear])

  // Disable Leaflet event propagation on search bar
  useEffect(() => {
    if (searchBarRef.current) {
      L.DomEvent.disableClickPropagation(searchBarRef.current)
      L.DomEvent.disableScrollPropagation(searchBarRef.current)
    }
  }, [])

  const performSearch = useCallback(async (searchQuery: string, currentRequestId: number) => {
    // Strip optional "MCPI:" prefix (case-insensitive) and surrounding whitespace
    const normalizedQuery = searchQuery.replace(/^MCPI:\s*/i, '').trim()
    
    if (normalizedQuery.length < 3) {
      if (currentRequestId === requestIdRef.current) {
        setResults([])
        setShowResults(false)
      }
      return
    }

    if (currentRequestId !== requestIdRef.current) {
      return // Stale request
    }

    setLoading(true)
    setShowResults(true)

    try {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      abortControllerRef.current = new AbortController()

      let searchResults: any[] = []

      // Check if it's an MCPI (numeric)
      if (/^\d+$/.test(normalizedQuery)) {
        const parcel = await fetchParcelByMCPI(normalizedQuery, abortControllerRef.current.signal)
        if (parcel && currentRequestId === requestIdRef.current) {
          searchResults = [{ type: 'parcel', data: parcel }]
        }
      } else {
        // Search addresses with token-based query
        const addresses = await searchAddresses(normalizedQuery, abortControllerRef.current.signal)
        if (currentRequestId === requestIdRef.current) {
          searchResults = addresses.map((addr: any) => ({ type: 'address', data: addr }))
        }
      }

      if (currentRequestId === requestIdRef.current) {
        setResults(searchResults)
      }
    } catch (error: any) {
      if (error.name !== 'AbortError' && currentRequestId === requestIdRef.current) {
        console.error('Search failed:', error)
        setResults([])
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const handleSearch = (searchQuery: string) => {
    setQuery(searchQuery)
    
    // Clear previous debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Increment request ID
    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current

    // Debounce by 300ms
    debounceRef.current = setTimeout(() => {
      performSearch(searchQuery, currentRequestId)
    }, 300)
  }

  const handleSelect = async (result: any) => {
    setShowResults(false)
    setQuery(result.type === 'address' ? result.data.properties.FULL_ADDRESS : result.data.properties.PA_MCPI)
    setSelectedIndex(-1)

    if (result.type === 'address') {
      onAddressSelect(result.data)
      
      // Navigate to the address location
      if (result.data.geometry && result.data.geometry.coordinates && onNavigateToAddress) {
        const [lng, lat] = result.data.geometry.coordinates
        onNavigateToAddress(lng, lat)
      }
      
      // Find the parcel for this address
      let parcel = null
      if (result.data.properties && result.data.properties.AD_MCPI) {
        parcel = await fetchParcelByMCPI(result.data.properties.AD_MCPI)
      }
      
      // Fallback to spatial query if MCPI fails
      if (!parcel && result.data.geometry && result.data.geometry.coordinates) {
        const [lng, lat] = result.data.geometry.coordinates
        parcel = await fetchParcelByGeometry(lng, lat)
      }
      
      if (parcel) {
        onParcelSelect(parcel, 'search-result')
      }
    } else if (result.type === 'parcel') {
      onParcelSelect(result.data, 'search-result')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showResults || results.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev => (prev < results.length - 1 ? prev + 1 : prev))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1))
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          handleSelect(results[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        setShowResults(false)
        setSelectedIndex(-1)
        break
    }
  }

  const handleClear = () => {
    setQuery('')
    setResults([])
    setShowResults(false)
    setSelectedIndex(-1)
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    // Don't close if clicking on a result
    setTimeout(() => {
      if (!resultsRef.current?.contains(e.relatedTarget as Node)) {
        setShowResults(false)
        setSelectedIndex(-1)
      }
    }, 100)
  }

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selectedElement = resultsRef.current.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  return (
    <div ref={searchBarRef} className="relative z-[1000] search-bar" data-map-ui="true">
      <div className="rounded-lg shadow-lg flex items-center p-2 w-80 border transition-colors" style={{ background: 'var(--search-gradient)', borderColor: 'var(--viridian)' }}>
        <Search className="w-5 h-5 ml-2" style={{ color: 'var(--seafoam)' }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onFocus={() => setShowResults(results.length > 0)}
          placeholder="Search address or MCPI (optional)"
          className="flex-1 px-3 py-2 outline-none text-[15px] leading-[1.45]"
          style={{ color: '#ffffff' }}
          data-placeholder-style="color: var(--soft-seafoam)"
        />
        {loading && (
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
        )}
        {query && !loading && (
          <button
            onClick={handleClear}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(64, 130, 109, 0.13)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {showResults && (
        <div 
          ref={resultsRef}
          className="absolute top-full left-0 right-0 mt-2 rounded-lg shadow-lg max-h-96 overflow-y-auto border"
          style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
        >
          {loading ? (
            <div className="p-4 text-center flex items-center justify-center gap-2 text-[15px] leading-[1.45]" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading...
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-[15px] leading-[1.45]" style={{ color: 'var(--text-muted)' }}>No results found</div>
          ) : (
            results.map((result, index) => (
              <button
                key={index}
                onClick={() => handleSelect(result)}
                className="w-full text-left px-4 py-3 border-b last:border-b-0 text-[15px] leading-[1.45] transition-colors"
                style={
                  index === selectedIndex
                    ? { background: 'linear-gradient(90deg, rgba(64,130,109,0.78), rgba(147,233,190,0.88))', color: 'var(--brand-black)', borderColor: 'var(--card-border)' }
                    : { background: 'transparent', color: '#ffffff', borderColor: 'var(--card-border)' }
                }
                onMouseEnter={(e) => {
                  if (index !== selectedIndex) {
                    e.currentTarget.style.background = 'rgba(64, 130, 109, 0.13)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (index !== selectedIndex) {
                    e.currentTarget.style.background = 'transparent'
                  }
                }}
              >
                {result.type === 'address' ? (
                  <div style={{ color: index === selectedIndex ? 'var(--brand-black)' : '#ffffff' }}>
                    {result.data.properties.FULL_ADDRESS}
                  </div>
                ) : (
                  <div style={{ color: index === selectedIndex ? 'var(--brand-black)' : '#ffffff' }}>
                    MCPI: {result.data.properties.PA_MCPI}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
