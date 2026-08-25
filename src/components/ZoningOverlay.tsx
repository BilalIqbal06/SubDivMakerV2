import { useState } from 'react'
import { Layers, ArrowRight, AlertCircle, CheckCircle } from 'lucide-react'
import { Parcel, ZoningDistrict } from '../types/gis'
import { LoudounCountyConnector } from '../connectors/loudounCounty'

interface ZoningOverlayProps {
  parcel: Parcel
  onNext: () => void
}

export default function ZoningOverlay({ parcel, onNext }: ZoningOverlayProps) {
  const [zoning, setZoning] = useState<ZoningDistrict | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connector = new LoudounCountyConnector()

  const loadZoning = async () => {
    setLoading(true)
    setError(null)
    
    try {
      const zoningData = await connector.getZoningForParcel(parcel.parcelId)
      if (zoningData) {
        setZoning(zoningData)
      } else {
        setError('No zoning information found for this parcel')
      }
    } catch (err) {
      setError('Failed to load zoning information')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Load zoning on mount
  useState(() => {
    loadZoning()
  })

  return (
    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Zoning Overlay</h2>
          <p className="text-slate-400">Review zoning regulations and constraints</p>
        </div>
        <button
          onClick={onNext}
          disabled={!zoning}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          Next Step
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-slate-400">Loading zoning information...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/50 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-red-400">{error}</p>
            <button
              onClick={loadZoning}
              className="mt-2 text-sm text-red-300 hover:text-red-200 underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {zoning && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <div className="bg-slate-900 rounded-lg border border-slate-700 h-96 flex items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900" />
              <div className="relative z-10 text-center">
                <Layers className="w-16 h-16 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">Zoning map overlay will be implemented</p>
                <p className="text-sm text-slate-500 mt-2">Showing {zoning.code} zoning district</p>
              </div>
              
              <div className="absolute top-4 left-4 bg-emerald-500/90 backdrop-blur-sm rounded-lg px-3 py-2 border border-emerald-400">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-white" />
                  <span className="text-white font-medium">{zoning.code}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
              <h3 className="text-lg font-semibold text-white mb-3">Zoning District</h3>
              <div className="space-y-3">
                <DetailRow label="Code" value={zoning.code} />
                <DetailRow label="Name" value={zoning.name} />
                <DetailRow label="Description" value={zoning.description} />
              </div>
            </div>

            <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
              <h3 className="text-lg font-semibold text-white mb-3">Size Requirements</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Min Lot Size</span>
                  <span className="text-white">{zoning.regulations.minLotSize} acres</span>
                </div>
                {zoning.regulations.maxLotSize && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Max Lot Size</span>
                    <span className="text-white">{zoning.regulations.maxLotSize} acres</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-400">Min Frontage</span>
                  <span className="text-white">{zoning.regulations.minFrontage} ft</span>
                </div>
              </div>
            </div>

            <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
              <h3 className="text-lg font-semibold text-white mb-3">Setbacks (ft)</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Front</span>
                  <span className="text-white">{zoning.regulations.setbacks.front}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Side</span>
                  <span className="text-white">{zoning.regulations.setbacks.side}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Rear</span>
                  <span className="text-white">{zoning.regulations.setbacks.rear}</span>
                </div>
              </div>
            </div>

            <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
              <h3 className="text-lg font-semibold text-white mb-3">Other Regulations</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Max Height</span>
                  <span className="text-white">{zoning.regulations.maxHeight} ft</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Max Coverage</span>
                  <span className="text-white">{zoning.regulations.maxCoverage}%</span>
                </div>
              </div>
            </div>

            {zoning.regulations.allowedUses.length > 0 && (
              <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
                <h3 className="text-lg font-semibold text-white mb-3">Allowed Uses</h3>
                <div className="flex flex-wrap gap-2">
                  {zoning.regulations.allowedUses.map((use, index) => (
                    <span
                      key={index}
                      className="px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded text-xs"
                    >
                      {use}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className="text-white text-sm text-right max-w-[180px] break-words">{value}</span>
    </div>
  )
}
