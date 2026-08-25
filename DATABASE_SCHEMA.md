# SubDivMaker V2 Database Schema

## Overview
This document describes the database schema for SubDivMaker V2, a GIS-powered land development platform.

## Tables

### parcels
Stores parcel data retrieved from GIS sources.

```sql
CREATE TABLE parcels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id VARCHAR(255) NOT NULL,
  jurisdiction VARCHAR(255) NOT NULL,
  address TEXT,
  owner TEXT,
  acreage DECIMAL(10,4),
  geometry JSONB NOT NULL,
  centroid_lat DECIMAL(10,6),
  centroid_lon DECIMAL(10,6),
  bounding_box JSONB,
  zoning_code VARCHAR(50),
  zoning_description TEXT,
  source_url TEXT,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(parcel_id, jurisdiction)
);

CREATE INDEX idx_parcels_parcel_id ON parcels(parcel_id);
CREATE INDEX idx_parcels_jurisdiction ON parcels(jurisdiction);
CREATE INDEX idx_parcels_geometry ON parcels USING GIN(geometry);
CREATE INDEX idx_parcels_centroid ON parcels(centroid_lat, centroid_lon);
```

### zoning_districts
Stores zoning district information.

```sql
CREATE TABLE zoning_districts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction VARCHAR(255) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  geometry JSONB NOT NULL,
  regulations JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(jurisdiction, code)
);

CREATE INDEX idx_zoning_jurisdiction ON zoning_districts(jurisdiction);
CREATE INDEX idx_zoning_code ON zoning_districts(code);
CREATE INDEX idx_zoning_geometry ON zoning_districts USING GIN(geometry);
```

### subdivisions
Stores subdivision project data.

```sql
CREATE TABLE subdivisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  user_id VARCHAR(255),
  name VARCHAR(255),
  parameters JSONB NOT NULL,
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_subdivisions_parcel_id ON subdivisions(parcel_id);
CREATE INDEX idx_subdivisions_user_id ON subdivisions(user_id);
CREATE INDEX idx_subdivisions_status ON subdivisions(status);
```

### subdivision_lots
Stores individual lot data within a subdivision.

```sql
CREATE TABLE subdivision_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subdivision_id UUID NOT NULL REFERENCES subdivisions(id) ON DELETE CASCADE,
  lot_number INTEGER NOT NULL,
  geometry JSONB NOT NULL,
  acreage DECIMAL(10,4),
  centroid_lat DECIMAL(10,6),
  centroid_lon DECIMAL(10,6),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_lots_subdivision_id ON subdivision_lots(subdivision_id);
CREATE INDEX idx_lots_geometry ON subdivision_lots USING GIN(geometry);
```

### gis_sources
Stores configuration for different GIS data sources.

```sql
CREATE TABLE gis_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  jurisdiction VARCHAR(255) NOT NULL,
  connector_type VARCHAR(100) NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_gis_sources_jurisdiction ON gis_sources(jurisdiction);
CREATE INDEX idx_gis_sources_active ON gis_sources(is_active);
```

### api_logs
Stores API call logs for monitoring and debugging.

```sql
CREATE TABLE api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  user_id VARCHAR(255),
  request_data JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_api_logs_endpoint ON api_logs(endpoint);
CREATE INDEX idx_api_logs_created_at ON api_logs(created_at);
CREATE INDEX idx_api_logs_user_id ON api_logs(user_id);
```

## JSONB Schema Examples

### Parcel Geometry
```json
{
  "type": "Polygon",
  "coordinates": [
    [
      [-77.5, 38.9],
      [-77.4, 38.9],
      [-77.4, 38.8],
      [-77.5, 38.8],
      [-77.5, 38.9]
    ]
  ]
}
```

### Zoning Regulations
```json
{
  "minLotSize": 0.5,
  "maxLotSize": 10.0,
  "minFrontage": 50,
  "maxHeight": 35,
  "maxCoverage": 40,
  "setbacks": {
    "front": 25,
    "side": 10,
    "rear": 25
  },
  "allowedUses": [
    "Single Family",
    "Duplex",
    "Townhouse"
  ]
}
```

### Subdivision Parameters
```json
{
  "numLots": 4,
  "minLotSize": 0.5,
  "targetLotSize": 1.0,
  "preserveFeatures": ["Trees", "Wetlands"],
  "roadAccess": true,
  "utilityAccess": true,
  "setbacks": {
    "front": 25,
    "side": 10,
    "rear": 25
  }
}
```

## Row Level Security (RLS)

Enable RLS on all tables:

```sql
ALTER TABLE parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoning_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subdivisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subdivision_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE gis_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;
```

### RLS Policies

```sql
-- Public read access to parcels and zoning
CREATE POLICY "Public read access to parcels" ON parcels
  FOR SELECT USING (true);

CREATE POLICY "Public read access to zoning" ON zoning_districts
  FOR SELECT USING (true);

-- User-specific access to subdivisions
CREATE POLICY "User access to own subdivisions" ON subdivisions
  FOR ALL USING (user_id = current_user_id() OR user_id IS NULL);

-- Service role can modify all data
CREATE POLICY "Service role full access" ON ALL TABLES
  TO service_role
  USING (true) WITH CHECK (true);
```
