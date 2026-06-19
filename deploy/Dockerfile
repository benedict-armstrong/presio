# Build image for the Presio app (referenced by deploy/docker-compose.yml).
# Build context is the repo root so both client/ and server/ are available.
#
# Stage 1 builds the React client. Vite inlines VITE_* values at build time, so
# they must be present as env (not just runtime). The publishable/anon key is a
# public key and is safe to bake into the client bundle.
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
RUN npm run build

# Stage 2 runs the server, which serves the API, the websocket, and the built
# client from ../client/dist (see server/index.ts).
FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ .
COPY --from=client-build /app/client/dist /app/client/dist
EXPOSE 3001
CMD ["npm", "start"]
