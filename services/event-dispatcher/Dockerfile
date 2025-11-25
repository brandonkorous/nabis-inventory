# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy shared package
COPY services/shared ./services/shared

# Copy event-dispatcher package
COPY services/event-dispatcher ./services/event-dispatcher

# Install dependencies
RUN npm ci --workspaces

# Build shared library
RUN npm run build --workspace=@nabis/shared

# Build event-dispatcher
RUN npm run build --workspace=@nabis/event-dispatcher

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
COPY --from=builder /app/services/shared/src/db/migrations ./services/shared/src/db/migrations
COPY --from=builder /app/services/event-dispatcher/dist ./services/event-dispatcher/dist
COPY --from=builder /app/services/event-dispatcher/package.json ./services/event-dispatcher/

# Install production dependencies only
RUN npm ci --workspaces --omit=dev

# Change ownership
RUN chown -R nabis:nabis /app

# Switch to non-root user
USER nabis

# Start with dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "services/event-dispatcher/dist/index.js"]
