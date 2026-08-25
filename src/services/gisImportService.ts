import { Parcel, ZoningDistrict, ParcelGeometry, JurisdictionConnector } from '../types/gis'
import { LoudounCountyConnector } from '../connectors/loudounCounty'
import { squareMetersToAcres } from '../lib/coordinates'

/**
 * GIS Import Service
 * Handles importing and processing GIS data from various sources
 */

export class GISImportService {
  private connectors: Map<string, JurisdictionConnector> = new Map()

  constructor() {
    // Register available connectors
    this.registerConnector('loudoun-county-va', new LoudounCountyConnector())
  }

  /**
   * Register a jurisdiction connector
   */
  registerConnector(key: string, connector: JurisdictionConnector): void {
    this.connectors.set(key, connector)
  }

  /**
   * Get a connector by key
   */
  getConnector(key: string): JurisdictionConnector | undefined {
    return this.connectors.get(key)
  }

  /**
   * Get all available connectors
   */
  getAvailableConnectors(): Array<{ key: string; name: string; jurisdiction: string }> {
    return Array.from(this.connectors.entries()).map(([key, connector]) => ({
      key,
      name: connector.name,
      jurisdiction: connector.jurisdiction
    }))
  }

  /**
   * Search for parcels across all connectors
   */
  async searchParcels(query: string, connectorKey?: string): Promise<Parcel[]> {
    if (connectorKey) {
      const connector = this.getConnector(connectorKey)
      if (!connector) {
        throw new Error(`Connector not found: ${connectorKey}`)
      }
      return connector.searchParcels(query)
    }

    // Search across all connectors
    const results: Parcel[] = []
    for (const connector of this.connectors.values()) {
      try {
        const parcels = await connector.searchParcels(query)
        results.push(...parcels)
      } catch (error) {
        console.error(`Error searching with ${connector.name}:`, error)
      }
    }

    return results
  }

  /**
   * Import a complete parcel with all related data
   */
  async importParcel(parcelId: string, connectorKey: string): Promise<{
    parcel: Parcel
    zoning: ZoningDistrict | null
    geometry: ParcelGeometry
  }> {
    const connector = this.getConnector(connectorKey)
    if (!connector) {
      throw new Error(`Connector not found: ${connectorKey}`)
    }

    // Get parcel data
    const parcel = await connector.getParcelById(parcelId)
    if (!parcel) {
      throw new Error(`Parcel not found: ${parcelId}`)
    }

    // Get zoning data
    const zoning = await connector.getZoningForParcel(parcelId)

    // Get geometry
    const geometry = await connector.getParcelGeometry(parcelId)
    if (!geometry) {
      throw new Error(`Geometry not found for parcel: ${parcelId}`)
    }

    return {
      parcel,
      zoning,
      geometry
    }
  }

  /**
   * Validate imported parcel data
   */
  validateParcelData(parcel: Parcel): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!parcel.parcelId) {
      errors.push('Parcel ID is required')
    }

    if (!parcel.address) {
      errors.push('Address is required')
    }

    if (!parcel.geometry || !parcel.geometry.coordinates) {
      errors.push('Valid geometry is required')
    }

    if (!parcel.centroid) {
      errors.push('Centroid is required')
    }

    if (parcel.acreage <= 0) {
      errors.push('Acreage must be greater than 0')
    }

    // Validate geometry coordinates
    if (parcel.geometry.type === 'Polygon') {
      const coords = parcel.geometry.coordinates[0]
      if (coords.length < 4) {
        errors.push('Polygon must have at least 4 coordinates')
      }
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }

  /**
   * Calculate derived properties from geometry
   */
  calculateDerivedProperties(geometry: ParcelGeometry): {
    area: number
    areaAcres: number
    perimeter: number
  } {
    let area = 0
    let perimeter = 0

    const processCoordinates = (coords: number[][]) => {
      // Calculate area using Shoelace formula
      for (let i = 0; i < coords.length; i++) {
        const j = (i + 1) % coords.length
        area += coords[i][0] * coords[j][1]
        area -= coords[j][0] * coords[i][1]
      }
      area = Math.abs(area / 2)

      // Calculate perimeter
      for (let i = 0; i < coords.length; i++) {
        const j = (i + 1) % coords.length
        const dx = coords[j][0] - coords[i][0]
        const dy = coords[j][1] - coords[i][1]
        perimeter += Math.sqrt(dx * dx + dy * dy)
      }
    }

    if (geometry.type === 'Polygon') {
      const coords = geometry.coordinates as number[][][]
      processCoordinates(coords[0])
    } else {
      // For multipolygons, sum up all polygons
      const coords = geometry.coordinates as number[][][][]
      coords.forEach(polygon => {
        processCoordinates(polygon[0])
      })
    }

    return {
      area,
      areaAcres: squareMetersToAcres(area),
      perimeter
    }
  }

  /**
   * Export parcel data to GeoJSON format
   */
  exportToGeoJSON(parcel: Parcel): string {
    return JSON.stringify({
      type: 'Feature',
      properties: {
        parcelId: parcel.parcelId,
        address: parcel.address,
        owner: parcel.owner,
        acreage: parcel.acreage,
        jurisdiction: parcel.jurisdiction,
        zoningCode: parcel.zoningCode,
        zoningDescription: parcel.zoningDescription
      },
      geometry: parcel.geometry
    }, null, 2)
  }

  /**
   * Export parcel data to CSV format
   */
  exportToCSV(parcels: Parcel[]): string {
    const headers = ['Parcel ID', 'Address', 'Owner', 'Acreage', 'Jurisdiction', 'Zoning Code', 'Latitude', 'Longitude']
    const rows = parcels.map(parcel => [
      parcel.parcelId,
      parcel.address,
      parcel.owner || '',
      parcel.acreage.toFixed(4),
      parcel.jurisdiction,
      parcel.zoningCode || '',
      parcel.centroid.latitude.toFixed(6),
      parcel.centroid.longitude.toFixed(6)
    ])

    return [headers, ...rows].map(row => row.join(',')).join('\n')
  }

  /**
   * Batch import parcels from a list of IDs
   */
  async batchImportParcels(
    parcelIds: string[],
    connectorKey: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<Array<{ parcel: Parcel; success: boolean; error?: string }>> {
    const results = []

    for (let i = 0; i < parcelIds.length; i++) {
      try {
        const data = await this.importParcel(parcelIds[i], connectorKey)
        results.push({
          parcel: data.parcel,
          success: true
        })
      } catch (error) {
        results.push({
          parcel: null as any,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }

      if (onProgress) {
        onProgress(i + 1, parcelIds.length)
      }
    }

    return results
  }
}
