# The editor: Vite, the bridge, and the ffmpeg it runs every cut through.
FROM node:22-bookworm-slim

# ffmpeg and ffprobe are not optional extras here -- every trim, every
# segment handed to a backend and every composite back onto the source goes
# through them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so editing source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 127.0.0.1 inside a container is the container. The port mapping does the
# rest; see the comment in vite.config.ts.
ENV SHOULDERCUT_HOST=0.0.0.0
EXPOSE 5173

# Dev server rather than `vite preview`: the bridge installs itself in
# configureServer, so preview serves the front-end and 404s every /api call.
CMD ["npm", "run", "dev"]
