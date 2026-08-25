import { BaseJurisdictionConnector } from './base'
import { LOUDOUN_GIS_BASE_URL } from '../config/gis'
import { Parcel, ZoningDistrict, ParcelGeometry } from '../types/gis'

/**
 * Loudoun County, Virginia GIS Connector
 * 
 * This connector interfaces with Loudoun County's GIS data services.
 * Requests are routed through the same-origin Vite/Vercel proxy at
 * /api/loudoun-gis, which forwards to https://gis.loudoun.gov.
 * 
 * API Documentation: https://www.loudoun.gov/index.aspx?NID=2768
 * GIS Services: https://gis.loudoun.gov/
 */
export class LoudounCountyConnector extends BaseJurisdictionConnector {
  name = 'Loudoun County'
  jurisdiction = 'Loudoun County, VA'

  private readonly baseUrl = `${LOUDOUN_GIS_BASE_URL}/arcgis/rest/services`
  private readonly parcelLayer = 'Parcels/MapServer/0'
  private readonly zoningLayer = 'Zoning/MapServer/0'

  /**
   * Search for parcels by address, parcel ID, or owner name
   */
  async searchParcels(query: string): Promise<Parcel[]> {
    try {
      // Loudoun County ArcGIS REST API query
      const url = `${this.baseUrl}/${this.parcelLayer}/query`
      const params = new URLSearchParams({
        where: this.buildSearchClause(query),
        outFields: '*',
        returnGeometry: 'true',
        f: 'json'
      })

      const response = await fetch(`${url}?${params}`)
      const data = await response.json()

      if (!data.features || data.features.length === 0) {
        return []
      }

      return data.features
        .map((feature: any) => this.transformArcGISFeature(feature))
        .filter((parcel: Parcel | null) => parcel !== null) as Parcel[]
    } catch (error) {
      console.error('Error searching parcels:', error)
      return []
    }
  }

  /**
   * Get a specific parcel by its ID
   */
  async getParcelById(parcelId: string): Promise<Parcel | null> {
    try {
      const url = `${this.baseUrl}/${this.parcelLayer}/query`
      const params = new URLSearchParams({
        where: `PARCEL_ID = '${parcelId}'`,
        outFields: '*',
        returnGeometry: 'true',
        f: 'json'
      })

      const response = await fetch(`${url}?${params}`)
      const data = await response.json()

      if (!data.features || data.features.length === 0) {
        return null
      }

      return this.transformArcGISFeature(data.features[0])
    } catch (error) {
      console.error('Error getting parcel by ID:', error)
      return null
    }
  }

  /**
   * Get zoning information for a specific parcel
   */
  async getZoningForParcel(parcelId: string): Promise<ZoningDistrict | null> {
    try {
      // First get the parcel to find its location
      const parcel = await this.getParcelById(parcelId)
      if (!parcel) {
        return null
      }

      // Query zoning layer by location
      const url = `${this.baseUrl}/${this.zoningLayer}/query`
      const params = new URLSearchParams({
        geometry: `${parcel.centroid.longitude},${parcel.centroid.latitude}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'true',
        f: 'json'
      })

      const response = await fetch(`${url}?${params}`)
      const data = await response.json()

      if (!data.features || data.features.length === 0) {
        return null
      }

      return this.transformZoningFeature(data.features[0])
    } catch (error) {
      console.error('Error getting zoning for parcel:', error)
      return null
    }
  }

  /**
   * Get parcel geometry in GeoJSON format
   */
  async getParcelGeometry(parcelId: string): Promise<ParcelGeometry | null> {
    try {
      const parcel = await this.getParcelById(parcelId)
      return parcel?.geometry || null
    } catch (error) {
      console.error('Error getting parcel geometry:', error)
      return null
    }
  }

  /**
   * Build search clause for ArcGIS query
   */
  private buildSearchClause(query: string): string {
    const upperQuery = query.toUpperCase()
    
    // Try multiple fields
    return `(UPPER(ADDRESS) LIKE '%${upperQuery}%' OR 
            UPPER(PARCEL_ID) LIKE '%${upperQuery}%' OR 
            UPPER(OWNER_NAME) LIKE '%${upperQuery}%')`
  }

  /**
   * Transform ArcGIS feature to our Parcel format
   */
  private transformArcGISFeature(feature: any): Parcel | null {
    try {
      const attributes = feature.attributes
      const geometry = feature.geometry

      if (!attributes || !geometry) {
        return null
      }

      const parcelGeometry = this.transformArcGISGeometry(geometry)
      const centroid = this.calculateCentroid(parcelGeometry)
      const boundingBox = this.calculateBoundingBox(parcelGeometry)

      const parcel: Parcel = {
        id: `loudoun-${attributes.PARCEL_ID || attributes.OBJECTID}`,
        parcelId: attributes.PARCEL_ID || attributes.OBJECTID.toString(),
        address: attributes.ADDRESS || attributes.SITE_ADDRESS || 'Unknown Address',
        owner: attributes.OWNER_NAME,
        acreage: attributes.ACREAGE || attributes.SQUARE_FOOTAGE ? attributes.SQUARE_FOOTAGE / 43560 : 0,
        geometry: parcelGeometry,
        centroid,
        boundingBox,
        jurisdiction: this.jurisdiction,
        zoningCode: attributes.ZONING,
        zoningDescription: attributes.ZONING_DESC,
        lastUpdated: new Date().toISOString(),
        sourceUrl: `${this.baseUrl}/${this.parcelLayer}`
      }

      return this.validateParcel(parcel) ? parcel : null
    } catch (error) {
      console.error('Error transforming feature:', error)
      return null
    }
  }

  /**
   * Transform ArcGIS geometry to GeoJSON format
   */
  private transformArcGISGeometry(geometry: any): ParcelGeometry {
    if (geometry.type === 'polygon') {
      return {
        type: 'Polygon',
        coordinates: geometry.rings
      }
    } else if (geometry.type === 'multipolygon') {
      return {
        type: 'MultiPolygon',
        coordinates: geometry.rings
      }
    }
    
    // Default to empty polygon
    return {
      type: 'Polygon',
      coordinates: [[]]
    }
  }

  /**
   * Transform zoning feature to our ZoningDistrict format
   */
  private transformZoningFeature(feature: any): ZoningDistrict {
    const attributes = feature.attributes
    const geometry = this.transformArcGISGeometry(feature.geometry)

    return {
      id: `zoning-${attributes.OBJECTID}`,
      code: attributes.ZONING_CODE || attributes.ZONE,
      name: attributes.ZONING_NAME || attributes.ZONE_DESC,
      description: attributes.DESCRIPTION || '',
      geometry,
      regulations: {
        minLotSize: attributes.MIN_LOT_SIZE || 0.5,
        maxLotSize: attributes.MAX_LOT_SIZE,
        minFrontage: attributes.MIN_FRONTAGE || 50,
        maxHeight: attributes.MAX_HEIGHT || 35,
        maxCoverage: attributes.MAX_COVERAGE || 40,
        setbacks: {
          front: attributes.FRONT_SETBACK || 25,
          side: attributes.SIDE_SETBACK || 10,
          rear: attributes.REAR_SETBACK || 25
        },
        allowedUses: attributes.ALLOWED_USES ? attributes.ALLOWED_USES.split(',').map((u: string) => u.trim()) : []
      }
    }
  }
}
