# SubDivMaker V2

A GIS-native early land-development feasibility and conceptual-design copilot.

## Purpose

SubDivMaker V2 helps planners and developers screen parcels, configure basic site and development parameters, and quickly generate conceptual road networks, development zones, and building layouts. Output is **conceptual feasibility only** — not permit-ready, not construction-ready, and not a substitute for licensed civil engineering, survey, entitlement, or environmental review.

## Pilot Jurisdiction

**Loudoun County, Virginia** — the initial pilot with live parcel geometry and Loudoun GIS integration.

## Tech Stack

- React 18 + TypeScript + Vite
- TailwindCSS
- Lucide React
- Turf / GeoJSON
- Web Worker concept generation

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3004/`.

## Production Build

```bash
npm run build
```

Built files are emitted to `dist/`.

## Main Flow

1. **Explore** — pan and select a parcel on the map
2. **Parcel Feasibility** — automatic GIS-based site screening
3. **Parameters** — simplified development type, intensity, priorities, and advanced options
4. **Analyze Site** — post-analysis summary of site conditions and parameters
5. **Generate & Export** — generate a BALANCED concept, estimate MAX YIELD and CONSTRAINT CONSERVATIVE, generate any alternate, switch among cached concepts, and export
6. **Export** — Feasibility Summary JSON and GeoJSON for the selected fully generated concept

## Exports

- **Feasibility Summary JSON** — project, parcel, screening, selected concept, constraints, roads, development, comparison, assumptions, and disclaimer
- **GeoJSON FeatureCollection** — selected parcel, candidate open area, existing conditions, generated roads (primary, secondary, local), development zones, development pads, townhomes, and single-family lots/buildings

Both exports are in **EPSG:4326** and include a `conceptualOnly: true` flag and the engineering-review disclaimer.

## Important Disclaimer

All density, setback, yield, road geometry, and hydrology/terrain outputs are planning-level conceptual estimates. They must be reviewed and refined by a licensed civil engineer and other qualified professionals before survey, entitlement, permitting, or construction use.
