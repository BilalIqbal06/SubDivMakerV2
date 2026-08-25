import { useState } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import { Parcel, SubdivisionParameters } from '../types/gis'

interface SubdivisionParamsProps {
  parcel: Parcel
  onNext: () => void
}

export default function SubdivisionParams({ parcel, onNext }: SubdivisionParamsProps) {
  const [params, setParams] = useState<SubdivisionParameters>({
    numLots: 2,
    minLotSize: 0.5,
    targetLotSize: 1.0,
    preserveFeatures: [],
    roadAccess: true,
    utilityAccess: true,
    setbacks: {
      front: 25,
      side: 10,
      rear: 25
    }
  })

  return (
    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Subdivision Parameters</h2>
          <p className="text-slate-400">Configure subdivision design parameters</p>
        </div>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors"
        >
          Next Step
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-4">Lot Configuration</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Number of Lots
                </label>
                <input
                  type="number"
                  min="2"
                  max="50"
                  value={params.numLots}
                  onChange={(e) => setParams({ ...params, numLots: parseInt(e.target.value) || 2 })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Minimum Lot Size (acres)
                </label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={params.minLotSize}
                  onChange={(e) => setParams({ ...params, minLotSize: parseFloat(e.target.value) || 0.5 })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Target Lot Size (acres)
                </label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={params.targetLotSize}
                  onChange={(e) => setParams({ ...params, targetLotSize: parseFloat(e.target.value) || 1.0 })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          </div>

          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-4">Setbacks (ft)</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Front Setback
                </label>
                <input
                  type="number"
                  min="0"
                  value={params.setbacks.front}
                  onChange={(e) => setParams({
                    ...params,
                    setbacks: { ...params.setbacks, front: parseInt(e.target.value) || 0 }
                  })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Side Setback
                </label>
                <input
                  type="number"
                  min="0"
                  value={params.setbacks.side}
                  onChange={(e) => setParams({
                    ...params,
                    setbacks: { ...params.setbacks, side: parseInt(e.target.value) || 0 }
                  })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Rear Setback
                </label>
                <input
                  type="number"
                  min="0"
                  value={params.setbacks.rear}
                  onChange={(e) => setParams({
                    ...params,
                    setbacks: { ...params.setbacks, rear: parseInt(e.target.value) || 0 }
                  })}
                  className="w-full px-4 py-2 bg-slate-600 border border-slate-500 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-4">Infrastructure</h3>
            
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.roadAccess}
                  onChange={(e) => setParams({ ...params, roadAccess: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-white">Road Access Required</span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.utilityAccess}
                  onChange={(e) => setParams({ ...params, utilityAccess: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-white">Utility Access Required</span>
              </label>
            </div>
          </div>

          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-4">Features to Preserve</h3>
            
            <div className="space-y-3">
              {['Trees', 'Wetlands', 'Slopes', 'Historical Structures', 'Water Features'].map((feature) => (
                <label key={feature} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={params.preserveFeatures.includes(feature)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setParams({
                          ...params,
                          preserveFeatures: [...params.preserveFeatures, feature]
                        })
                      } else {
                        setParams({
                          ...params,
                          preserveFeatures: params.preserveFeatures.filter(f => f !== feature)
                        })
                      }
                    }}
                    className="w-5 h-5 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-white">{feature}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
            <h3 className="text-lg font-semibold text-white mb-4">Parcel Summary</h3>
            
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Total Acreage</span>
                <span className="text-white">{parcel.acreage.toFixed(2)} acres</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Proposed Lots</span>
                <span className="text-white">{params.numLots}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Avg Lot Size</span>
                <span className="text-white">{(parcel.acreage / params.numLots).toFixed(2)} acres</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Target Lot Size</span>
                <span className="text-white">{params.targetLotSize} acres</span>
              </div>
            </div>

            {(parcel.acreage / params.numLots) < params.minLotSize && (
              <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500/50 rounded-lg flex items-start gap-2">
                <Info className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                <p className="text-yellow-400 text-sm">
                  Average lot size is below minimum. Consider reducing the number of lots.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
