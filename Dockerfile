# Stage 1: Build the frontend
FROM oven/bun:latest AS builder
WORKDIR /app

# Copy package files and lockfile
COPY package.json bun.lock ./
RUN bun install

# Copy all source files
COPY . .

# Build Vite frontend
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:latest
WORKDIR /app

# Copy dependencies and built assets
COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./

# Expose the port from server.ts (default 3000)
EXPOSE 3000

# Start the server using bun
# We use bun to run the .ts file directly or we could compile it.
# Bun handles .ts files natively.
CMD ["bun", "run", "server.ts"]
