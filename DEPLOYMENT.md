# Deployment Guide

This guide covers deploying SubDivMaker V2 to production.

## Prerequisites

- Node.js 18+
- npm or yarn
- Git
- Vercel account (for Vercel deployment) or
- Docker (for containerized deployment)

## Environment Variables

Create a `.env` file based on `.env.example`:

```env
VITE_API_URL=http://localhost:3000/api
VITE_API_KEY=your_api_key_here
VITE_GIS_TIMEOUT=30000
VITE_ENABLE_MOCK_DATA=false
VITE_ENABLE_MAP_INTEGRATION=false
VITE_ENABLE_LAYOUT_GENERATION=false
```

## Local Deployment

### Development

```bash
npm install
npm run dev
```

The application will be available at `http://localhost:3000`

### Production Build

```bash
npm run build
npm run preview
```

The production build will be in the `dist` directory.

## Vercel Deployment

### Automatic Deployment

1. Push your code to GitHub/GitLab/Bitbucket
2. Import the project in Vercel
3. Vercel will automatically detect the Vite configuration
4. Configure environment variables in Vercel dashboard
5. Deploy

### Manual Deployment

```bash
npm install -g vercel
vercel
```

Follow the prompts to configure your deployment.

### Environment Variables in Vercel

Add the following environment variables in your Vercel project settings:

- `VITE_API_URL`: Your API endpoint URL
- `VITE_API_KEY`: Your API key
- `VITE_GIS_TIMEOUT`: GIS request timeout in milliseconds
- `VITE_ENABLE_MOCK_DATA`: Enable/disable mock data
- `VITE_ENABLE_MAP_INTEGRATION`: Enable/disable map features
- `VITE_ENABLE_LAYOUT_GENERATION`: Enable/disable layout generation

## Docker Deployment

### Build Docker Image

```bash
docker build -t subdivmaker-v2 .
```

### Run Docker Container

```bash
docker run -p 3000:80 subdivmaker-v2
```

### Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:80"
    environment:
      - VITE_API_URL=${VITE_API_URL}
      - VITE_API_KEY=${VITE_API_KEY}
```

Run with:

```bash
docker-compose up -d
```

## Database Setup

### PostgreSQL Setup

1. Create a PostgreSQL database
2. Run the schema from `DATABASE_SCHEMA.md`

```bash
psql -U your_user -d your_database -f schema.sql
```

3. Configure connection in your environment variables

### Supabase Setup

1. Create a Supabase project
2. Run the SQL schema in the Supabase SQL editor
3. Copy your Supabase URL and anon key to environment variables

## CI/CD

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.ORG_ID }}
          vercel-project-id: ${{ secrets.PROJECT_ID }}
          vercel-args: '--prod'
```

## Performance Optimization

### Build Optimization

The Vite configuration includes:
- Code splitting
- Tree shaking
- Minification
- Asset optimization

### CDN Configuration

For production, consider:
- Enable CDN for static assets
- Configure caching headers
- Use gzip/brotli compression

## Monitoring

### Error Tracking

Consider integrating:
- Sentry for error tracking
- LogRocket for session replay
- Google Analytics for usage analytics

### Performance Monitoring

- Use Vercel Analytics
- Configure Web Vitals tracking
- Monitor API response times

## Security

### Headers

The `vercel.json` includes security headers:
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- X-XSS-Protection: 1; mode=block

### Additional Security Measures

- Enable HTTPS
- Configure CORS policies
- Implement rate limiting
- Use environment variables for sensitive data
- Regular dependency updates

## Troubleshooting

### Build Errors

If you encounter build errors:

1. Clear node_modules and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

2. Check TypeScript errors:
```bash
npm run type-check
```

3. Check ESLint errors:
```bash
npm run lint
```

### Runtime Errors

1. Check browser console for errors
2. Verify environment variables are set
3. Check API connectivity
4. Review network tab for failed requests

### GIS Data Issues

1. Verify GIS API endpoints are accessible
2. Check CORS configuration
3. Review API rate limits
4. Test with mock data enabled

## Rollback

### Vercel Rollback

1. Go to Vercel dashboard
2. Select your project
3. Go to Deployments
4. Click on a previous deployment
5. Click "Promote to Production"

### Manual Rollback

```bash
git checkout <previous-commit>
git push origin main
```

## Maintenance

### Regular Tasks

- Update dependencies monthly
- Review and apply security patches
- Monitor database performance
- Check API rate limits
- Review error logs

### Dependency Updates

```bash
npm outdated
npm update
```

## Support

For deployment issues:
1. Check the logs in your deployment platform
2. Review this documentation
3. Open an issue on GitHub
