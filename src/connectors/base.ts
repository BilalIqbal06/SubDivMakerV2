import { JurisdictionConnector, Parcel, ZoningDistrict, ParcelGeometry } from '../types/gis'

/**
 * Base class for jurisdiction connectors
 * Provides common functionality and enforces interface compliance
 */
export abstract class BaseJurisdictionConnector implements JurisdictionConnector {
  abstract name: string
  abstract jurisdiction: string

  abstract searchParcels(query: string): Promise<Parcel[]>
  abstract getParcelById(parcelId: string): Promise<Parcel | null>
  abstract getZoningForParcel(parcelId: string): Promise<ZoningDistrict | null>
  abstract getParcelGeometry(parcelId: string): Promise<ParcelGeometry | null>

  /**
   * Validate parcel data structure
   */
  protected validateParcel(parcel: any): boolean {
    return !!(
      parcel.id &&
      parcel.parcelId &&
      parcel.address &&
      parcel.acreage &&
      parcel.geometry &&
      parcel.centroid &&
      parcel.boundingBox
    )
  }

  /**
   * Calculate bounding box from geometry
   */
  protected calculateBoundingBox(geometry: ParcelGeometry) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    const processCoordinates = (coords: number[][][]) => {
      coords.forEach(ring => {
        ring.forEach(coord => {
          minX = Math.min(minX, coord[0])
          minY = Math.min(minY, coord[1])
          maxX = Math.max(maxX, coord[0])
          maxY = Math.max(maxY, coord[1])
        })
      })
    }

    if (geometry.type === 'Polygon') {
      processCoordinates(geometry.coordinates as number[][][])
    } else {
      (geometry.coordinates as number[][][][]).forEach(polygon => {
        processCoordinates(polygon)
      })
    }

    return {
      north: maxY,
      south: minY,
      east: maxX,
      west: minX
    }
  }

  /**
   * Calculate centroid from geometry
   */
  protected calculateCentroid(geometry: ParcelGeometry) {
    let sumX = 0
    let sumY = 0
    let count = 0

    const processCoordinates = (coords: number[][][]) => {
      coords.forEach(ring => {
        ring.forEach(coord => {
          sumX += coord[0]
          sumY += coord[1]
          count++
        })
      })
    }

    if (geometry.type === 'Polygon') {
      processCoordinates(geometry.coordinates as number[][][])
    } else {
      (geometry.coordinates as number[][][][]).forEach(polygon => {
        processCoordinates(polygon)
      })
    }

    return {
      latitude: sumY / count,
      longitude: sumX / count
    }
  }
}
