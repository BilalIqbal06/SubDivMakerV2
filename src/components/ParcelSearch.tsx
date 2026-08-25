import { useState } from 'react'
import { Search, MapPin, Loader2, AlertCircle } from 'lucide-react'
import { Parcel } from '../types/gis'
import { LoudounCountyConnector } from '../connectors/loudounCounty'

interface ParcelSearchProps {
  onParcelSelect: (parcel: Parcel) => void
}

export default function ParcelSearch({ onParcelSelect }: ParcelSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Parcel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connector = new LoudounCountyConnector()

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setError(null)
    setResults([])

    try {
      const parcels = await connector.searchParcels(query)
      if (parcels.length === 0) {
        setError('No parcels found. Try a different search term.')
      } else {
        setResults(parcels)
      }
    } catch (err) {
      setError('Failed to search parcels. Please try again.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <h2 className="text-2xl font-bold text-white mb-2">Search Parcels</h2>
      <p className="text-slate-400 mb-6">
        Search by address, parcel ID, or owner name in Loudoun County, VA
      </p>

      <form onSubmit={handleSearch} className="mb-6">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter address, parcel ID, or owner name..."
            className="w-full pl-12 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="absolute right-2 top-1/2 transform -translate-y-1/2 px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-md transition-colors"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              'Search'
            )}
          </button>
        </div>
      </form>

      {error && (
        <div className="mb-4 p-4 bg-red-500/10 border border-red-500/50 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {results.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-4">
            {results.length} {results.length === 1 ? 'Result' : 'Results'}
          </h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {results.map((parcel) => (
              <ParcelResultCard
                key={parcel.id}
                parcel={parcel}
                onSelect={() => onParcelSelect(parcel)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-slate-700/50 rounded-lg border border-slate-600">
        <h4 className="text-sm font-semibold text-slate-300 mb-2">Search Tips</h4>
        <ul className="text-xs text-slate-400 space-y-1">
          <li>• Enter a full or partial street address</li>
          <li>• Use the parcel ID (e.g., 1234-56-7890)</li>
          <li>• Search by property owner name</li>
          <li>• Results are limited to Loudoun County, VA</li>
        </ul>
      </div>
    </div>
  )
}

function ParcelResultCard({ parcel, onSelect }: { parcel: Parcel; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left p-4 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 hover:border-emerald-500/50 rounded-lg transition-all group"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-emerald-500/20 rounded-lg flex items-center justify-center flex-shrink-0 group-hover:bg-emerald-500/30 transition-colors">
          <MapPin className="w-5 h-5 text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-white font-medium truncate group-hover:text-emerald-400 transition-colors">
            {parcel.address}
          </h4>
          <p className="text-sm text-slate-400 mt-1">Parcel ID: {parcel.parcelId}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
            <span>{parcel.acreage.toFixed(2)} acres</span>
            {parcel.zoningCode && <span>Zoning: {parcel.zoningCode}</span>}
          </div>
        </div>
      </div>
    </button>
  )
}
