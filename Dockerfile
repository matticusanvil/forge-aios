# Stage 1: build the web app.
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY shared shared
COPY web web
RUN npm run build

# Stage 2: the server, the pinned claude CLI and the built web app.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep gh \
 && rm -rf /var/lib/apt/lists/*
# What the Android emulator needs to run headless; the SDK itself is the server's, mounted by deploy/start.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpulse0 libnss3 libnspr4 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
      libxrandr2 libxkbfile1 libxkbcommon0 libx11-xcb1 libgl1 libegl1 libgbm1 libdrm2 libasound2 libdbus-1-3 libfontconfig1 libbsd0 \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/android-emulator /usr/local/bin/android-emulator
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_ADB_SERVER_PORT=5038 ANDROID_SERIAL=emulator-5600 \
    PATH=/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH
# GitHub over HTTPS through gh, using the server's gh login (mounted read only by deploy/run.sh): wikis clone and publish.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'
# Pinned CLI; upgrades are deliberate and re-run the captured fixtures first (plan: Risks).
RUN npm install -g @anthropic-ai/claude-code@2.1.296
ENV DISABLE_AUTOUPDATER=1 NODE_ENV=production PORT=3200 FORGE_DATA=/data GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 \
    GIT_AUTHOR_NAME='Forge AIOS' GIT_COMMITTER_NAME='Forge AIOS'
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server server
COPY shared shared
COPY --from=web /app/web/dist web/dist
USER node
EXPOSE 3200
# node:sqlite is still flagged experimental in Node 22; its warning on every start is noise.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/main.ts"]
