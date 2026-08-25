import { useMap } from 'react-leaflet'
import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { Plus, Minus, Home, Layers } from 'lucide-react'
import type { BasemapType } from './MapComponent'

interface MapControlsProps {
  basemap: BasemapType
  onBasemapChange: (basemap: BasemapType) => void
  isRoadGenerating?: boolean
}

export default function MapControls({ basemap, onBasemapChange, isRoadGenerating = false }: MapControlsProps) {
  const map = useMap()
  const controlsRef = useRef<HTMLDivElement>(null)

  // Disable Leaflet event propagation on controls
  useEffect(() => {
    if (controlsRef.current) {
      L.DomEvent.disableClickPropagation(controlsRef.current)
      L.DomEvent.disableScrollPropagation(controlsRef.current)
    }
  }, [])

  const handleZoomIn = () => {
    if (isRoadGenerating) return
    map.zoomIn()
  }

  const handleZoomOut = () => {
    if (isRoadGenerating) return
    map.zoomOut()
  }

  const handleReset = () => {
    if (isRoadGenerating) return
    map.setView([39.09, -77.64], 10)
  }

  const handleBasemapChange = () => {
    if (isRoadGenerating) return
    const basemaps: BasemapType[] = ['osm', 'voyager', 'aerial']
    const currentIndex = basemaps.indexOf(basemap)
    const nextIndex = (currentIndex + 1) % basemaps.length
    onBasemapChange(basemaps[nextIndex])
  }

  const getBasemapLabel = () => {
    switch (basemap) {
      case 'osm':
        return 'Detailed Map'
      case 'voyager':
        return 'Simple Map'
      case 'aerial':
        return 'Satellite'
      default:
        return 'Detailed Map'
    }
  }

  const getNextBasemapLabel = () => {
    const basemaps: BasemapType[] = ['osm', 'voyager', 'aerial']
    const currentIndex = basemaps.indexOf(basemap)
    const nextIndex = (currentIndex + 1) % basemaps.length
    const nextBasemap = basemaps[nextIndex]
    switch (nextBasemap) {
      case 'osm':
        return 'Detailed Map'
      case 'voyager':
        return 'Simple Map'
      case 'aerial':
        return 'Satellite'
      default:
        return 'Detailed Map'
    }
  }

  return (
    <div ref={controlsRef} className="absolute bottom-4 right-4 z-[1000] flex flex-col gap-2 map-controls" data-map-ui="true">
      <button
        type="button"
        onClick={handleZoomIn}
        className="rounded-lg shadow-lg p-2 w-10 h-10 flex items-center justify-center border transition-colors"
        style={{ background: 'var(--brand-black)', borderColor: 'var(--viridian)', color: 'var(--seafoam)' }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--deep-viridian)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--brand-black)'}
        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--seafoam)'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'var(--viridian)'}
        title="Zoom in"
      >
        <Plus className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={handleZoomOut}
        className="rounded-lg shadow-lg p-2 w-10 h-10 flex items-center justify-center border transition-colors"
        style={{ background: 'var(--brand-black)', borderColor: 'var(--viridian)', color: 'var(--seafoam)' }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--deep-viridian)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--brand-black)'}
        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--seafoam)'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'var(--viridian)'}
        title="Zoom out"
      >
        <Minus className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={handleReset}
        className="rounded-lg shadow-lg p-2 w-10 h-10 flex items-center justify-center border transition-colors"
        style={{ background: 'var(--brand-black)', borderColor: 'var(--viridian)', color: 'var(--seafoam)' }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--deep-viridian)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--brand-black)'}
        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--seafoam)'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'var(--viridian)'}
        title="Reset to Loudoun County"
      >
        <Home className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={handleBasemapChange}
        className="rounded-lg shadow-lg p-2 w-10 h-10 flex items-center justify-center border transition-colors"
        style={{ background: 'var(--brand-black)', borderColor: 'var(--viridian)', color: 'var(--seafoam)' }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--deep-viridian)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--brand-black)'}
        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--seafoam)'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'var(--viridian)'}
        title={`Current: ${getBasemapLabel()} → Next: ${getNextBasemapLabel()}`}
        aria-label={`Switch from ${getBasemapLabel()} to ${getNextBasemapLabel()}`}
      >
        <Layers className="w-5 h-5" />
      </button>
    </div>
  )
}
