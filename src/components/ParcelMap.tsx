import { Map, ArrowRight, Info, Download } from 'lucide-react'
import { Parcel } from '../types/gis'

interface ParcelMapProps {
  parcel: Parcel
  onNext: () => void
}

export default function ParcelMap({ parcel, onNext }: ParcelMapProps) {
  return (
    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Parcel Map</h2>
          <p className="text-slate-400">Review parcel boundaries and location</p>
        </div>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors"
        >
          Next Step
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-slate-900 rounded-lg border border-slate-700 h-96 flex items-center justify-center relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900" />
            <div className="relative z-10 text-center">
              <Map className="w-16 h-16 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">Interactive map will be implemented with a mapping library</p>
              <p className="text-sm text-slate-500 mt-2">Leaflet or Mapbox integration planned</p>
            </div>
            
            {/* Placeholder for actual map implementation */}
            <div className="absolute bottom-4 left-4 right-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-3 border border-slate-600">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Info className="w-4 h-4 text-emerald-400" />
                <span>Map integration coming soon - displaying parcel geometry</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-3">Parcel Details</h3>
            <div className="space-y-3">
              <DetailRow label="Parcel ID" value={parcel.parcelId} />
              <DetailRow label="Address" value={parcel.address} />
              <DetailRow label="Acreage" value={`${parcel.acreage.toFixed(2)} acres`} />
              <DetailRow label="Jurisdiction" value={parcel.jurisdiction} />
              {parcel.zoningCode && (
                <DetailRow label="Zoning Code" value={parcel.zoningCode} />
              )}
              {parcel.owner && (
                <DetailRow label="Owner" value={parcel.owner} />
              )}
            </div>
          </div>

          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-3">Coordinates</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Latitude</span>
                <span className="text-white">{parcel.centroid.latitude.toFixed(6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Longitude</span>
                <span className="text-white">{parcel.centroid.longitude.toFixed(6)}</span>
              </div>
            </div>
          </div>

          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-3">Bounding Box</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">North</span>
                <span className="text-white">{parcel.boundingBox.north.toFixed(6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">South</span>
                <span className="text-white">{parcel.boundingBox.south.toFixed(6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">East</span>
                <span className="text-white">{parcel.boundingBox.east.toFixed(6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">West</span>
                <span className="text-white">{parcel.boundingBox.west.toFixed(6)}</span>
              </div>
            </div>
          </div>

          <button className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors border border-slate-600">
            <Download className="w-4 h-4" />
            Export Parcel Data
          </button>
        </div>
      </div>
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
