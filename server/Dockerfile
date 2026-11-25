# Build from the repo root:  docker build -f server/Dockerfile -t job-hunt-server .
# The Playwright image ships Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.55.1-noble
WORKDIR /app
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm install --omit=dev
COPY src/jobs src/jobs
COPY src/account src/account
COPY src/apply src/apply
COPY server/src server/src
WORKDIR /app/server
# A container is reached from outside itself, so the server answers every network connection here. Left alone it
# answers its own computer only (server/src/listen.ts). A hosted copy keeps no applications (docs/applications.md).
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
