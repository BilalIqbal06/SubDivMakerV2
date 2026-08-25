import { ProjectParameters, DevelopmentUse, AmenityParameters, GenerationPriorities } from '../types/parameters'

export interface ParameterSummaryRow {
  label: string
  value: string
  category?: string
}

// Default values for comparison
const DEFAULT_PARAMETERS: any = {
  projectMode: 'greenfield',
  targetDensity: undefined,
  buildingFootprintPreference: 'detached',
  networkPreference: 'connected-grid',
  sidewalkWidth: undefined,
  trailWidth: undefined,
  onStreetParking: false,
  roadsidePlantingStrip: false,
  prioritizeExistingConnections: true,
  avoidSteepSlopes: false,
  minimizeStreamCrossings: false,
  minimizeTotalPavement: false,
  emergencyAccessPreference: 'medium',
  parkingType: 'surface',
  sharedParkingAllowed: false,
  bicycleParking: false,
  minOpenSpaceAcreage: undefined,
  minOpenSpacePercentage: undefined,
  park: false,
  playground: false,
  trailNetwork: false,
  communityGreen: false,
  retentionPond: false,
  detentionFacility: false,
  bioretention: false,
  preservedForest: false,
  landscapingBuffer: false,
  treeCanopyTarget: undefined,
  streamBuffer: false,
  wetlandBuffer: false,
  maxUnitYield: 'medium',
  minGrading: 'medium',
  minRoadLength: 'medium',
  maxOpenSpace: 'medium',
  preserveExistingDevelopment: 'medium',
  walkability: 'medium',
  roadConnectivity: 'medium',
  stormwaterEfficiency: 'medium',
  buildingViewsOrientation: 'medium',
  lowestConstructionImpact: 'medium',
  notes: ''
}

export function formatParameterSummary(parameters: ProjectParameters): ParameterSummaryRow[] {
  const rows: ParameterSummaryRow[] = []

  // Development Program - treat as optional
  const devTypes = (parameters.developmentProgram || []).filter((d: DevelopmentUse) => d?.enabled)
  if (devTypes.length > 0) {
    rows.push({
      label: 'Development Types',
      value: devTypes.map((d: DevelopmentUse) => d?.useType || '').filter(Boolean).join(', '),
      category: 'Development'
    })
  }

  // Development Intensity - treat zoningAndLots as optional
  const zoning = parameters.zoningAndLots
  const density = zoning?.targetDensity
  if (density !== undefined && density !== DEFAULT_PARAMETERS.targetDensity) {
    let intensity = 'Not specified'
    if (density > 8) intensity = 'High'
    else if (density > 4) intensity = 'Medium'
    else if (density > 0) intensity = 'Low'
    rows.push({
      label: 'Development Intensity',
      value: intensity,
      category: 'Development'
    })
  }

  // Target Lot/Unit Count
  const targetCount = (zoning as any)?.targetLotUnitCount
  if (targetCount !== undefined && targetCount > 0) {
    rows.push({
      label: 'Target Lot/Unit Count',
      value: targetCount.toLocaleString(),
      category: 'Zoning'
    })
  }

  // Preferred Lot Size
  const preferredLotSize = (zoning as any)?.preferredLotSize
  if (preferredLotSize !== undefined && preferredLotSize !== '') {
    rows.push({
      label: 'Preferred Lot Size',
      value: `${Number(preferredLotSize).toLocaleString()} sq ft`,
      category: 'Zoning'
    })
  }

  // Preferred Building Type
  const preferredBuildingType = (zoning as any)?.preferredBuildingType
  if (preferredBuildingType !== undefined && preferredBuildingType !== '') {
    rows.push({
      label: 'Preferred Building Type',
      value: preferredBuildingType,
      category: 'Zoning'
    })
  }

  // Building Footprint Preference
  const buildingFootprint = zoning?.buildingFootprintPreference
  if (buildingFootprint !== undefined && buildingFootprint !== DEFAULT_PARAMETERS.buildingFootprintPreference) {
    rows.push({
      label: 'Building Footprint',
      value: buildingFootprint,
      category: 'Zoning'
    })
  }

  // Target Density
  if (density !== undefined && density !== DEFAULT_PARAMETERS.targetDensity) {
    rows.push({
      label: 'Target Density',
      value: `${density} units/acre`,
      category: 'Zoning'
    })
  }

  // Roads and Access - treat as optional
  const roads = parameters.roads
  if (roads) {
    // Network Preference
    if (roads.networkPreference !== undefined && 
        roads.networkPreference !== DEFAULT_PARAMETERS.networkPreference) {
      rows.push({
        label: 'Road Network',
        value: formatRoadNetworkPreference(roads.networkPreference),
        category: 'Roads'
      })
    }

    // Right of Way Width
    if (roads.rightOfWayWidth !== undefined) {
      rows.push({
        label: 'Right of Way Width',
        value: `${roads.rightOfWayWidth} ft`,
        category: 'Roads'
      })
    }

    // Pavement Width
    if (roads.pavementWidth !== undefined) {
      rows.push({
        label: 'Pavement Width',
        value: `${roads.pavementWidth} ft`,
        category: 'Roads'
      })
    }

    // Sidewalk
    if (roads.sidewalkWidth !== undefined && roads.sidewalkWidth !== DEFAULT_PARAMETERS.sidewalkWidth) {
      rows.push({
        label: 'Sidewalk',
        value: roads.sidewalkWidth > 0 ? `${roads.sidewalkWidth} ft` : 'None',
        category: 'Roads'
      })
    }

    // Trail
    if (roads.trailWidth !== undefined && roads.trailWidth !== DEFAULT_PARAMETERS.trailWidth) {
      rows.push({
        label: 'Trail',
        value: roads.trailWidth > 0 ? `${roads.trailWidth} ft` : 'None',
        category: 'Roads'
      })
    }

    // On-Street Parking
    if (roads.onStreetParking !== undefined && 
        roads.onStreetParking !== DEFAULT_PARAMETERS.onStreetParking) {
      rows.push({
        label: 'On-Street Parking',
        value: roads.onStreetParking ? 'Yes' : 'No',
        category: 'Roads'
      })
    }

    // Prioritize Existing Connections
    if (roads.prioritizeExistingConnections !== undefined && 
        roads.prioritizeExistingConnections !== DEFAULT_PARAMETERS.prioritizeExistingConnections) {
      rows.push({
        label: 'Prioritize Existing Connections',
        value: roads.prioritizeExistingConnections ? 'Yes' : 'No',
        category: 'Roads'
      })
    }

    // Minimize Total Pavement
    if (roads.minimizeTotalPavement !== undefined && 
        roads.minimizeTotalPavement !== DEFAULT_PARAMETERS.minimizeTotalPavement) {
      rows.push({
        label: 'Minimize Total Pavement',
        value: roads.minimizeTotalPavement ? 'Yes' : 'No',
        category: 'Roads'
      })
    }

    // Avoid Steep Slopes
    if (roads.avoidSteepSlopes !== undefined && 
        roads.avoidSteepSlopes !== DEFAULT_PARAMETERS.avoidSteepSlopes) {
      rows.push({
        label: 'Avoid Steep Slopes',
        value: roads.avoidSteepSlopes ? 'Yes' : 'No',
        category: 'Roads'
      })
    }

    // Minimize Stream Crossings
    if (roads.minimizeStreamCrossings !== undefined && 
        roads.minimizeStreamCrossings !== DEFAULT_PARAMETERS.minimizeStreamCrossings) {
      rows.push({
        label: 'Minimize Stream Crossings',
        value: roads.minimizeStreamCrossings ? 'Yes' : 'No',
        category: 'Roads'
      })
    }

    // Emergency Access Priority
    if (roads.emergencyAccessPreference !== undefined && 
        roads.emergencyAccessPreference !== DEFAULT_PARAMETERS.emergencyAccessPreference) {
      rows.push({
        label: 'Emergency Access Priority',
        value: capitalizeFirst(roads.emergencyAccessPreference),
        category: 'Roads'
      })
    }
  }

  // Parking - treat as optional
  const parking = parameters.parking
  if (parking) {
    // Parking Type
    if (parking.parkingType !== undefined && 
        parking.parkingType !== DEFAULT_PARAMETERS.parkingType) {
      rows.push({
        label: 'Parking Type',
        value: formatParkingType(parking.parkingType),
        category: 'Parking'
      })
    }

    // Shared Parking
    if (parking.sharedParkingAllowed !== undefined && 
        parking.sharedParkingAllowed !== DEFAULT_PARAMETERS.sharedParkingAllowed) {
      rows.push({
        label: 'Shared Parking',
        value: parking.sharedParkingAllowed ? 'Yes' : 'No',
        category: 'Parking'
      })
    }

    // Bicycle Parking
    if (parking.bicycleParking !== undefined && 
        parking.bicycleParking !== DEFAULT_PARAMETERS.bicycleParking) {
      rows.push({
        label: 'Bicycle Parking',
        value: parking.bicycleParking ? 'Yes' : 'No',
        category: 'Parking'
      })
    }

    // EV Ready Percentage
    if (parking.evReadyPercentage !== undefined) {
      rows.push({
        label: 'EV Ready',
        value: `${parking.evReadyPercentage}%`,
        category: 'Parking'
      })
    }
  }

  // Open Space and Amenities - treat as optional
  const amenities = parameters.amenities
  if (amenities) {
    // Minimum Open Space Acreage
    if (amenities.minOpenSpaceAcreage !== undefined && amenities.minOpenSpaceAcreage > 0) {
      rows.push({
        label: 'Min Open Space',
        value: `${amenities.minOpenSpaceAcreage} acres`,
        category: 'Amenities'
      })
    }

    // Minimum Open Space Percentage
    if (amenities.minOpenSpacePercentage !== undefined && amenities.minOpenSpacePercentage > 0) {
      rows.push({
        label: 'Min Open Space %',
        value: `${amenities.minOpenSpacePercentage}%`,
        category: 'Amenities'
      })
    }

    // Individual amenities
    const amenityLabels: (keyof AmenityParameters)[] = [
      'park', 'playground', 'trailNetwork', 'communityGreen',
      'retentionPond', 'detentionFacility', 'bioretention',
      'preservedForest', 'landscapingBuffer', 'streamBuffer', 'wetlandBuffer'
    ]

    amenityLabels.forEach(key => {
      const defaultValue = DEFAULT_PARAMETERS[key]
      const value = amenities[key]
      if (value !== undefined && value !== defaultValue && value === true) {
        const label = formatAmenityLabel(key)
        rows.push({
          label,
          value: 'Yes',
          category: 'Amenities'
        })
      }
    })

    // Tree Canopy Target
    if (amenities.treeCanopyTarget !== undefined && amenities.treeCanopyTarget > 0) {
      rows.push({
        label: 'Tree Canopy Target',
        value: `${amenities.treeCanopyTarget}%`,
        category: 'Amenities'
      })
    }
  }

  // Generation Priorities - treat as optional
  const priorities = parameters.priorities
  if (priorities) {
    const priorityLabels: (keyof GenerationPriorities)[] = [
      'maxUnitYield', 'minGrading', 'minRoadLength', 'maxOpenSpace',
      'preserveExistingDevelopment', 'walkability', 'roadConnectivity',
      'stormwaterEfficiency', 'buildingViewsOrientation', 'lowestConstructionImpact'
    ]

    priorityLabels.forEach(key => {
      const defaultValue = DEFAULT_PARAMETERS[key]
      const value = priorities[key]
      if (value !== undefined && value !== defaultValue && value !== 'medium') {
        const label = formatPriorityLabel(key)
        rows.push({
          label,
          value: capitalizeFirst(value),
          category: 'Priorities'
        })
      }
    })
  }

  // Notes - treat as optional
  const notes = parameters.notes
  if (notes && typeof notes === 'string' && notes.trim() !== '') {
    rows.push({
      label: 'Notes',
      value: notes.trim(),
      category: 'Other'
    })
  }

  return rows
}

function formatRoadNetworkPreference(preference: unknown): string {
  if (typeof preference !== 'string') return ''
  const labels: Record<string, string> = {
    'connected-grid': 'Connected Grid',
    'modified-grid': 'Modified Grid',
    'loop-road': 'Loop Road',
    'loop-culdesacs': 'Loop & Cul-de-sacs',
    'branching': 'Branching',
    'minimize-new': 'Minimize New',
    'extend-existing': 'Extend Existing',
    'propose-alternatives': 'Propose Alternatives'
  }
  return labels[preference] || preference
}

function formatParkingType(type: unknown): string {
  if (typeof type !== 'string') return ''
  const labels: Record<string, string> = {
    'surface': 'Surface',
    'garage': 'Garage',
    'structured': 'Structured',
    'on-street': 'On-Street',
    'mixed': 'Mixed'
  }
  return labels[type] || type
}

function formatAmenityLabel(key: string): string {
  const labels: Record<string, string> = {
    'park': 'Park',
    'playground': 'Playground',
    'trailNetwork': 'Trail Network',
    'communityGreen': 'Community Green',
    'retentionPond': 'Retention Pond',
    'detentionFacility': 'Detention Facility',
    'bioretention': 'Bioretention',
    'preservedForest': 'Preserved Forest',
    'landscapingBuffer': 'Landscaping Buffer',
    'streamBuffer': 'Stream Buffer',
    'wetlandBuffer': 'Wetland Buffer'
  }
  return labels[key] || key
}

function formatPriorityLabel(key: string): string {
  const labels: Record<string, string> = {
    'maxUnitYield': 'Maximize Units',
    'minGrading': 'Minimize Grading',
    'minRoadLength': 'Minimize Roads',
    'maxOpenSpace': 'Maximize Open Space',
    'preserveExistingDevelopment': 'Preserve Existing',
    'walkability': 'Walkability',
    'roadConnectivity': 'Road Connectivity',
    'stormwaterEfficiency': 'Stormwater Efficiency',
    'buildingViewsOrientation': 'Building Views',
    'lowestConstructionImpact': 'Minimize Impact'
  }
  return labels[key] || key
}

function capitalizeFirst(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}
