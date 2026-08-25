function ExistingConditions() {
  return (
    <div className="h-full flex flex-col bg-[#0f172a] text-[#cbd5e1] p-6">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white mb-2">Existing Conditions</h2>
        <p className="text-sm text-slate-400">Site analysis and GIS data processing</p>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[#8ED8C0]/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-[#8ED8C0]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Coming in Phase 2</h3>
          <p className="text-sm text-slate-400 mb-4">
            GIS analysis and site data processing will be implemented in Phase 2, including:
          </p>
          <ul className="text-left text-sm text-slate-400 space-y-2 inline-block">
            <li>• Elevation and terrain analysis</li>
            <li>• Slope calculation and mapping</li>
            <li>• Floodplain and wetland detection</li>
            <li>• Stream and water body identification</li>
            <li>• Existing building footprint analysis</li>
            <li>• Impervious surface calculation</li>
            <li>• Zoning district detection</li>
            <li>• Utility infrastructure mapping</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

export default ExistingConditions
