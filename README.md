# SubDivMaker V2

A GIS-powered conceptual land-development platform that enables users to search for existing parcels, retrieve real government-published parcel boundary and zoning data, enter subdivision and site-design parameters, and generate conceptual layouts.

## Features

- **Parcel Search**: Search for parcels by address, parcel ID, or owner name
- **GIS Integration**: Real-time data from government GIS sources
- **Zoning Analysis**: View zoning regulations and constraints
- **Coordinate System Support**: Handle multiple coordinate reference systems
- **Subdivision Planning**: Configure subdivision parameters and constraints
- **Data Export**: Export parcel data in GeoJSON and CSV formats

## Pilot Jurisdiction

**Loudoun County, Virginia** - The initial pilot jurisdiction with full GIS integration for parcel boundaries, zoning information, and property data.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: TailwindCSS
- **Icons**: Lucide React
- **GIS**: Custom jurisdiction connector architecture
- **Database**: PostgreSQL (schema provided)

## Project Structure

```
subdivmaker-v2/
├── src/
│   ├── components/          # React components
│   │   ├── ParcelSearch.tsx
│   │   ├── ParcelMap.tsx
│   │   ├── ZoningOverlay.tsx
│   │   └── SubdivisionParams.tsx
│   ├── connectors/          # GIS jurisdiction connectors
│   │   ├── base.ts
│   │   └── loudounCounty.ts
│   ├── services/            # Business logic services
│   │   └── gisImportService.ts
│   ├── lib/                 # Utility libraries
│   │   └── coordinates.ts
│   ├── types/               # TypeScript type definitions
│   │   └── gis.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── public/                  # Static assets
├── DATABASE_SCHEMA.md       # Database schema documentation
├── DEPLOYMENT.md            # Deployment guide
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vercel.json
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser to `http://localhost:3000`

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Jurisdiction Connectors

SubDivMaker V2 uses a modular connector architecture to support different GIS data sources. Each jurisdiction implements a standard interface:

```typescript
interface JurisdictionConnector {
  name: string
  jurisdiction: string
  searchParcels(query: string): Promise<Parcel[]>
  getParcelById(parcelId: string): Promise<Parcel | null>
  getZoningForParcel(parcelId: string): Promise<ZoningDistrict | null>
  getParcelGeometry(parcelId: string): Promise<ParcelGeometry | null>
}
```

### Adding a New Jurisdiction

1. Create a new connector in `src/connectors/` extending `BaseJurisdictionConnector`
2. Implement the required methods
3. Register the connector in `GISImportService`

## Database Setup

See `DATABASE_SCHEMA.md` for the complete database schema and setup instructions.

## Coordinate Systems

The platform supports multiple coordinate reference systems:

- **WGS84 (EPSG:4326)**: Standard GPS coordinates
- **NAD83 Virginia State Plane South (EPSG:2285)**: Common in Loudoun County
- **UTM Zone 17N (EPSG:32617)**: Covers Virginia area

Coordinate transformations are handled in `src/lib/coordinates.ts`.

## Workflow

1. **Search Parcel**: Search by address, parcel ID, or owner name
2. **Select Parcel**: Review parcel boundaries and details
3. **Zoning Overlay**: View zoning regulations and constraints
4. **Parameters**: Configure subdivision parameters
5. **Generate**: Create conceptual layout (coming soon)

## Deployment

### Vercel

The project is configured for Vercel deployment. Simply connect your repository and deploy.

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
VITE_API_URL=your_api_url
VITE_API_KEY=your_api_key
```

## Development Notes

- The current implementation focuses on the core GIS workflow (parcel search, selection, zoning overlay, coordinate handling)
- Advanced layout generation will be implemented after the core workflow is stable
- Map integration (Leaflet/Mapbox) is planned for future releases
- The Loudoun County connector uses placeholder URLs - update with actual GIS endpoints

## Future Enhancements

- [ ] Interactive map integration (Leaflet/Mapbox)
- [ ] Advanced layout generation algorithms
- [ ] Additional jurisdiction connectors
- [ ] User authentication and project saving
- [ ] CAD export functionality
- [ ] 3D visualization
- [ ] Collaboration features

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Support

For issues and questions, please open an issue on the repository.
