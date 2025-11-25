# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy shared package
COPY services/shared ./services/shared

# Copy admin-api package
COPY services/admin-api ./services/admin-api

# Install dependencies
RUN npm ci --workspaces

# Build shared library
RUN npm run build --workspace=@nabis/shared

# Build admin-api
RUN npm run build --workspace=@nabis/admin-api

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nabis && \
    adduser -S nabis -u 1001

# Copy package files
COPY package*.json ./

# Copy built artifacts
COPY --from=builder /app/services/shared/dist ./services/shared/dist
COPY --from=builder /app/services/shared/package.json ./services/shared/
COPY --from=builder /app/services/admin-api/dist ./services/admin-api/dist
COPY --from=builder /app/services/admin-api/package.json ./services/admin-api/

# Install production dependencies only
RUN npm ci --workspaces --omit=dev

# Change ownership
RUN chown -R nabis:nabis /app

# Switch to non-root user
USER nabis

# Expose port
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start with dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "services/admin-api/dist/index.js"]
