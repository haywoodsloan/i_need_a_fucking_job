# Build from the repo root:  docker build -f server/Dockerfile -t job-hunt-server .
# The Playwright image ships Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.55.1-noble
WORKDIR /app
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm install --omit=dev
COPY src/jobs src/jobs
COPY server/src server/src
WORKDIR /app/server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
