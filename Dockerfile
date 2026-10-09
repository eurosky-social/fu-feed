# Base images come from Docker's official-image mirror on Amazon ECR Public,
# not Docker Hub: GitHub's shared runners hit Docker Hub's anonymous pull limit
# (429 on the very first manifest request), which failed the build three times
# running on 2026-10-09. Same images, same digests — only the registry differs.
# For the same reason there is no `# syntax=` line: it would fetch the
# Dockerfile frontend from Docker Hub, and the built-in one covers everything
# used here.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-slim

# ---- build: install all deps and compile TypeScript to dist/ ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps + compiled output only ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# The app migrates the DB, builds the in-memory graph, and serves on boot.
CMD ["node", "dist/index.js"]
