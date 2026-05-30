# Build stage for frontend
# 用 BUILDPLATFORM(构建机原生架构,通常 amd64)构建,避免 arm64 在 QEMU 模拟下跑 npm ci 缓慢/网络超时。
# 前端产物(internal/web/dist)是架构无关的静态文件,只需构建一次,供各架构后端 COPY。
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-builder

WORKDIR /app

# Copy frontend package files
COPY miaomiaowux-frontend/package*.json ./miaomiaowux-frontend/

# Install dependencies
WORKDIR /app/miaomiaowux-frontend
# 加长网络超时,容忍 CI 偶发的 registry 抖动
RUN npm ci --fetch-timeout=600000

# Copy frontend source
COPY miaomiaowux-frontend/ ./

# Build frontend (will output to ../internal/web/dist)
RUN npm run build

# Build stage for backend
FROM golang:1.26-bookworm AS backend-builder

# Declare build arguments for multi-platform support
ARG TARGETOS
ARG TARGETARCH

WORKDIR /app

# Install build dependencies (gcc needed for CGO)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Copy built frontend from previous stage (vite outputs to /app/internal/web/dist)
COPY --from=frontend-builder /app/internal/web/dist ./internal/web/dist

# Build backend with optimizations (CGO enabled for SQLite WAL support)
# Use TARGETOS and TARGETARCH for multi-platform builds
RUN CGO_ENABLED=1 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /app/server \
    ./cmd/server

# Final stage - use Debian slim for better QEMU compatibility
FROM debian:bookworm-slim

WORKDIR /app

# Install ca-certificates for HTTPS requests and gosu for privilege dropping
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    gosu \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -m appuser

# Copy binary from builder
COPY --from=backend-builder /app/server /app/server

# Copy rule templates directory
COPY --from=backend-builder /app/rule_templates /app/rule_templates

# Copy entrypoint script
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set proper ownership for app files
RUN chown -R appuser:appuser /app/server /app/rule_templates

# Volume for persistent data
VOLUME ["/app/data", "/app/subscribes"]

# Bind 0.0.0.0 by default — Docker port mapping requires the server to listen on
# all interfaces inside the container. The application-layer host enforcement
# (internal/handler/host_enforcement.go) still blocks direct IP+port access when
# HTTPS is configured, so security parity with the bare-metal "bind loopback" mode
# is preserved.
ENV BIND_HOST=0.0.0.0

# Expose port
EXPOSE 12889

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:12889/ || exit 1

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Run the application
CMD ["/app/server"]
