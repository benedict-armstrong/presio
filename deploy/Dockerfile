# Build image for the Presio app (referenced by deploy/docker-compose.yml).
# Build context is the repo root so both client/ and server/ are available.
#
# Stage 1 builds the React client. Vite inlines VITE_* values at build time, so
# they must be present as env (not just runtime). The publishable/anon key is a
# public key and is safe to bake into the client bundle.
#
# Pinned to the build host's own architecture: the output is just JS/CSS, so
# there is nothing arch-specific to emulate. Without this, the arm64 leg of the
# multi-arch release build runs Vite under QEMU for no benefit.
FROM --platform=$BUILDPLATFORM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG VITE_SENTRY_DSN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
RUN npm run build

# Stage 2 runs the server, which serves the API, the websocket, and the built
# client from ../client/dist (see server/index.ts).
FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
# better-sqlite3 (local mode's storage backend) is a native module with no
# musl prebuilds, so it compiles from source here and needs a toolchain;
# removed again once npm ci finishes since the compiled .node binary only
# needs libstdc++/libgcc at runtime, which the base image already carries.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps
COPY server/ .
COPY --from=client-build /app/client/dist /app/client/dist
EXPOSE 3001
CMD ["npm", "start"]
