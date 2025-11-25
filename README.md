# Nabis Inventory Service

Production-grade inventory service with PostgreSQL, RabbitMQ, and microservices architecture. Deployed on Azure Kubernetes Service (AKS) with automated CI/CD.

## Architecture

This is a microservices-based inventory system designed to prevent overselling and integrate asynchronously with a WMS:

- **inventory-api**: Order-path API for reserving/releasing inventory
- **admin-api**: Control-plane API for operations and force-sync
- **event-dispatcher**: Worker that moves domain events from DB to RabbitMQ (outbox pattern)
- **wms-outbound-worker**: Worker that calls WMS API based on inventory events
- **wms-sync-worker**: Worker that syncs WMS inventory snapshots and reconciles
- **shared**: Shared database, messaging, and business logic

**Infrastructure**: Containerized PostgreSQL 15 and RabbitMQ 3.12 with persistent volumes in Kubernetes

## Prerequisites

- **Docker & Docker Compose**: For local development
- **Node.js 18+**: For running services locally
- **Azure Account**: For production deployment (AKS, ACR)
- **kubectl**: For Kubernetes management
- **Azure CLI**: For Azure resource management
- **GitHub CLI** (optional): For setting up secrets

## Quick Start

### Option 1: Docker Compose (Recommended)

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env

# 3. Start all services with docker-compose
docker-compose up -d

# 4. View logs
docker-compose logs -f

# 5. Access services
# - Inventory API: http://localhost:3000
# - Inventory API Docs: http://localhost:3000/docs
# - Admin API: http://localhost:3100
# - Admin API Docs: http://localhost:3100/docs
# - RabbitMQ Management: http://localhost:15672 (user: nabis, pass: nabis_dev_password)
```

### Option 2: Local Development

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env with your database and RabbitMQ connection details

# 3. Start infrastructure only
docker-compose up -d postgres rabbitmq

# 4. Run migrations
npm run migrate

# 5. Seed test data (optional)
npm run seed

# 6. Start services in separate terminals:

# Inventory API
cd services/inventory-api && npm run dev

# Admin API
cd services/admin-api && npm run dev

# Event Dispatcher
cd services/event-dispatcher && npm run dev

# WMS Outbound Worker
cd services/wms-outbound-worker && npm run dev

# WMS Sync Worker
cd services/wms-sync-worker && npm run dev
```

## API Documentation

### Inventory API (Order Path)

- **Swagger UI**: http://localhost:3000/docs
- **Production**: https://inventory-api.brandonkorous.com/docs
- **OpenAPI JSON**: http://localhost:3000/docs/json

**Endpoints:**

- `POST /inventory/reserve` - Reserve inventory for an order
- `POST /inventory/release` - Release reserved inventory
- `GET /inventory/:sku` - Get available inventory for a SKU
- `GET /health` - Health check
- `GET /health/ready` - Readiness check with dependency validation

### Admin API (Control Plane)

- **Swagger UI**: http://localhost:3100/docs
- **Production**: https://admin-api.brandonkorous.com/docs
- **OpenAPI JSON**: http://localhost:3100/docs/json

**Endpoints:**

- `POST /admin/wms/sync` - Force WMS synchronization
- `GET /admin/wms/sync/:requestId` - Check sync status
- `POST /admin/inventory/adjust` - Manual inventory adjustment
- `GET /health` - Health check
- `GET /health/ready` - Readiness check

## Project Structure

```
services/
├── shared/                      # Shared libraries
│   ├── src/
│   │   ├── db/                 # Database client, migrations, seeds
│   │   ├── messaging/          # RabbitMQ client and setup
│   │   ├── services/           # Business logic (InventoryService, etc.)
│   │   ├── clients/            # WMS client (mock and HTTP)
│   │   ├── types/              # TypeScript types
│   │   └── utils/              # Logger, errors
│   ├── tests/                  # Comprehensive test suite
│   └── package.json
│
├── inventory-api/              # Order-path API
│   ├── src/
│   │   ├── routes/            # API routes
│   │   ├── schemas/           # OpenAPI schemas
│   │   └── index.ts           # Server setup with Fastify
│   ├── tests/                 # Integration tests
│   ├── Dockerfile             # Production container
│   └── package.json
│
├── admin-api/                  # Admin/control API
│   ├── src/
│   │   ├── routes/            # Admin routes
│   │   ├── schemas/           # OpenAPI schemas
│   │   └── index.ts           # Server setup
│   ├── Dockerfile
│   └── package.json
│
├── event-dispatcher/           # Outbox worker
│   ├── src/
│   │   └── index.ts           # Event polling and dispatch
│   ├── Dockerfile
│   └── package.json
│
├── wms-outbound-worker/        # WMS integration worker
│   ├── src/
│   │   └── index.ts           # Process inventory events
│   ├── Dockerfile
│   └── package.json
│
└── wms-sync-worker/            # WMS sync worker
    ├── src/
    │   └── index.ts           # WMS reconciliation
    ├── Dockerfile
    └── package.json

.github/workflows/              # CI/CD pipelines
├── ci.yml                     # Build, test, and push images
└── deploy.yml                 # Manual deployment to staging/production

k8s/                            # Kubernetes manifests
├── base/                      # Core config (namespaces, ConfigMaps, Secrets)
├── infrastructure/            # PostgreSQL and RabbitMQ
└── services/                  # Microservice deployments

docs/
├── azure-setup.md             # Azure resource setup guide
├── deployment-variables.md    # Complete variables reference
├── deployment.md              # Kubernetes deployment guide
└── nabis-inventory-*.md       # Architecture and implementation docs
```

## Development

### Run Linting

```bash
npm run lint
```

### Run Formatting

```bash
npm run format
```

### Build All Services

```bash
npm run build
```

### Run Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- services/shared/tests/unit/inventoryService.reserve.test.ts
```

### Environment Variables

See [deployment-variables.md](./docs/deployment-variables.md) for complete list. Key variables:

- `DATABASE_URL` - PostgreSQL connection string
- `AMQP_URL` - RabbitMQ connection string
- `NODE_ENV` - Environment (development, staging, production)
- `WMS_CLIENT_TYPE` - `mock` or `http` for real WMS integration

## Key Features

**Oversell Prevention**: Row-level locking in PostgreSQL prevents race conditions  
**Outbox Pattern**: Atomic event emission with domain state changes  
**OpenAPI Documentation**: Complete API specs with Swagger UI  
**Microservices Architecture**: Each service independently deployable  
**Async WMS Integration**: WMS never in the order hot path  
**Concurrency Safe**: Database transactions with `FOR UPDATE SKIP LOCKED`  
**Event-Driven**: RabbitMQ for reliable async processing  
**Mock WMS**: Built-in mock for local development  
**Azure Native**: Deployed on AKS with ACR  
**CI/CD Pipeline**: Automated testing, building, and deployment  
**Canary Deployments**: Safe production rollouts with automatic rollback  
**Comprehensive Testing**: Unit, integration, and smoke tests

## Implementation Status

### Completed

- Project structure and monorepo setup
- Database schema with migrations and indexes
- PostgreSQL client with connection pooling and transactions
- RabbitMQ messaging infrastructure with exchanges, queues, and DLQ
- Core inventory service logic (reserve/release/query)
- Inventory API with OpenAPI documentation
- Admin API with force sync and manual adjustments
- Event Dispatcher worker (outbox pattern)
- WMS Outbound worker (event-driven WMS integration)
- WMS Sync worker (reconciliation)
- WMS client with mock and HTTP implementations
- Docker Compose for local development
- Comprehensive test suite (55 tests passing)
- Dockerfiles for all services
- GitHub Actions CI/CD workflows (simplified to 2 files)
- Kubernetes manifests for all services (production + staging)
- Containerized PostgreSQL and RabbitMQ with persistent volumes
- Azure service principal authentication
- Database migration job manifests

### Future Enhancements

- Kubernetes Ingress configuration
- Observability (Prometheus metrics, distributed tracing)
- Performance and load testing
- Circuit breakers and retry policies
- Rate limiting and throttling
- API authentication and authorization

## Architecture Overview

```
Order Flow (Hot Path):
Order Service → Inventory API → PostgreSQL
                     ↓ (atomic write)
                domain_event table

Async Flow:
domain_event → Event Dispatcher → RabbitMQ → WMS Workers → WMS API

Admin Flow:
Admin Client → Admin API → RabbitMQ → WMS Sync Worker → WMS API → PostgreSQL
```

## Deployment

This project is configured for deployment to **Azure Kubernetes Service (AKS)** with **Azure Container Registry (ACR)**.

### GitHub Secrets Required

Configure these in **Settings → Secrets and variables → Actions**. See [.github/SECRETS.md](./.github/SECRETS.md) for exact values.

| Secret                     | Description                        | Example                              |
| -------------------------- | ---------------------------------- | ------------------------------------ |
| `AZURE_CREDENTIALS`        | Service principal JSON credentials | See SECRETS.md for command           |
| `AZURE_RESOURCE_GROUP`     | Azure resource group name          | `rg-korous-kube-wu2`                 |
| `ACR_LOGIN_SERVER`         | Azure Container Registry server    | `brandonkorouscontainers.azurecr.io` |
| `AKS_CLUSTER_NAME_PROD`    | Production AKS cluster name        | `aks-korous-kube-wu2`                |
| `AKS_CLUSTER_NAME_STAGING` | Staging AKS cluster name           | `aks-stage-korous-kube-wu2`          |

**Note:** ACR authentication is handled through the Azure service principal - no separate ACR credentials needed.

### Kubernetes Environment Variables

These must be configured in Kubernetes ConfigMaps and Secrets. See [docs/deployment-variables.md](./docs/deployment-variables.md) for complete reference.

#### Required Variables (All Services)

- `DATABASE_URL` (Secret) - PostgreSQL connection string
     - Production: `postgresql://nabis:nabis_password@postgres.nabis-production.svc.cluster.local:5432/nabis_inventory`
     - Staging: `postgresql://nabis:nabis_password@postgres.nabis-staging.svc.cluster.local:5432/nabis_inventory`
- `AMQP_URL` (Secret) - RabbitMQ connection string
     - Production: `amqp://nabis:nabis_password@rabbitmq.nabis-production.svc.cluster.local:5672`
     - Staging: `amqp://nabis:nabis_password@rabbitmq.nabis-staging.svc.cluster.local:5672`
- `NODE_ENV` (ConfigMap) - Runtime environment: `production`, `staging`, `development`
- `LOG_LEVEL` (ConfigMap) - Logging level: `info`, `debug`, `warn`, `error`

#### Service-Specific Variables

**Inventory API:**

- `INVENTORY_API_PORT` - Default: `3000`
- `INVENTORY_API_HOST` - Default: `0.0.0.0`

**Admin API:**

- `ADMIN_API_PORT` - Default: `3100`
- `ADMIN_API_HOST` - Default: `0.0.0.0`

**Database Pool:**

- `DB_POOL_MIN` - Default: `2`
- `DB_POOL_MAX` - Default: `10`
- `DB_IDLE_TIMEOUT_MS` - Default: `10000`
- `DB_CONNECTION_TIMEOUT_MS` - Default: `5000`

**Event Dispatcher:**

- `EVENT_BATCH_SIZE` - Default: `100`
- `EVENT_POLL_INTERVAL_MS` - Default: `200`

**Workers:**

- `AMQP_PREFETCH` - Default: `10`

**WMS Client:**

- `WMS_CLIENT_TYPE` - `mock` or `http`
- `WMS_API_URL` (Secret) - WMS API base URL (required if `http`)
- `WMS_API_KEY` (Secret) - WMS API key (required if `http`)
- `WMS_RATE_LIMIT_PER_MINUTE` - Default: `60`

**Observability:**

- `SERVICE_NAME` - Default: `nabis-inventory`
- `METRICS_ENABLED` - Default: `true`

### Deployment Workflows

#### 1. CI Workflow (`.github/workflows/ci.yml`)

**Trigger:** Push to `main` or `develop` branches

- Lints code
- Runs all tests with PostgreSQL and RabbitMQ
- Builds Docker images for all services
- Pushes images to Azure Container Registry with branch-specific tags
- Uses Azure service principal authentication

#### 2. Deploy Workflow (`.github/workflows/deploy.yml`)

**Trigger:** Manual workflow dispatch only

- Deploy to staging or production environment (selected at runtime)
- Connects to specified AKS cluster
- Applies Kubernetes manifests:
     - Infrastructure (PostgreSQL, RabbitMQ)
     - Database migrations
     - Application services with environment-specific configs
- Controlled deployments - no automatic deploys

### Quick Deployment Setup

```bash
# 1. Create Azure service principal
az ad sp create-for-rbac \
  --name "nabis-github-actions" \
  --role contributor \
  --scopes /subscriptions/323f07f8-930b-411b-a725-b5910fc17bc5/resourceGroups/rg-korous-kube-wu2 \
  --sdk-auth > azure-credentials.json

# 2. Configure GitHub secrets (see .github/SECRETS.md for exact values)
gh secret set AZURE_CREDENTIALS < azure-credentials.json
gh secret set AZURE_RESOURCE_GROUP --body "rg-korous-kube-wu2"
gh secret set ACR_LOGIN_SERVER --body "brandonkorouscontainers.azurecr.io"
gh secret set AKS_CLUSTER_NAME_PROD --body "aks-korous-kube-wu2"
gh secret set AKS_CLUSTER_NAME_STAGING --body "aks-stage-korous-kube-wu2"

# 3. Connect to AKS
az aks get-credentials --resource-group rg-korous-kube-wu2 --name aks-korous-kube-wu2

# 4. Create namespaces and base configuration
kubectl apply -f k8s/base/namespaces.yaml
kubectl apply -f k8s/base/configmap-production.yaml
kubectl apply -f k8s/base/secrets-production.yaml  # Create from example first

# 5. Deploy infrastructure (PostgreSQL and RabbitMQ)
kubectl apply -f k8s/infrastructure/postgres-production.yaml
kubectl apply -f k8s/infrastructure/rabbitmq-production.yaml

# Wait for infrastructure to be ready
kubectl wait --for=condition=ready pod -l app=postgres -n nabis-production --timeout=120s
kubectl wait --for=condition=ready pod -l app=rabbitmq -n nabis-production --timeout=120s

# 6. Run database migrations
kubectl apply -f k8s/base/db-migration-job.yaml
kubectl wait --for=condition=complete job/db-migration -n nabis-production --timeout=120s

# 7. Deploy application services
kubectl apply -f k8s/services/inventory-api/inventory-api-production.yaml
kubectl apply -f k8s/services/admin-api/admin-api-production.yaml
kubectl apply -f k8s/services/event-dispatcher/event-dispatcher-production.yaml
kubectl apply -f k8s/services/wms-outbound-worker/wms-outbound-worker-production.yaml
kubectl apply -f k8s/services/wms-sync-worker/wms-sync-worker-production.yaml

# 8. Verify deployment
kubectl get pods -n nabis-production
kubectl get svc -n nabis-production
```

### Documentation

- **[GitHub Secrets Setup](./.github/SECRETS.md)** - Exact values for GitHub Actions secrets
- **[Deployment Variables](./docs/deployment-variables.md)** - All required environment variables
- **[Kubernetes Deployment](./k8s/README.md)** - Kubernetes deployment guide
- **[Architecture](./docs/nabis-inventory-architecture.md)** - System architecture
- **[Implementation](./docs/nabis-inventory-implementation.md)** - Implementation details

## Testing Example Flows

### Reserve Inventory

```bash
curl -X POST http://localhost:3000/inventory/reserve \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORD-001",
    "lines": [
      {"skuBatchId": 1, "quantity": 10}
    ]
  }'
```

**Response:**

```json
{
     "orderId": "ORD-001",
     "status": "reserved",
     "reservations": [
          {
               "skuBatchId": 1,
               "quantity": 10,
               "sku": "SKU-FLOWER-001"
          }
     ]
}
```

### Check Available Inventory

```bash
curl http://localhost:3000/inventory/SKU-FLOWER-001
```

**Response:**

```json
{
     "sku": "SKU-FLOWER-001",
     "totalAvailable": 90,
     "batches": [
          {
               "id": 1,
               "availableQuantity": 90,
               "expiresAt": "2025-12-31T23:59:59Z"
          }
     ]
}
```

### Release Reserved Inventory

```bash
curl -X POST http://localhost:3000/inventory/release \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORD-001",
    "reason": "Order cancelled"
  }'
```

### Force WMS Sync (Admin API)

```bash
curl -X POST http://localhost:3100/admin/wms/sync \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Manual reconciliation",
    "skuBatchId": 1
  }'
```

**Response:**

```json
{
     "requestId": "sync-req-123",
     "status": "queued",
     "queuedAt": "2025-11-24T10:30:00Z"
}
```

### Check Sync Status

```bash
curl http://localhost:3100/admin/wms/sync/sync-req-123
```

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

For issues or questions:

- Open an issue on GitHub
- Check the [documentation](./docs/)
- Review the [architecture guide](./docs/nabis-inventory-architecture.md)

---
