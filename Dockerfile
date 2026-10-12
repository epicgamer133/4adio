FROM node:22-alpine

# ffmpeg lives inside the container only; nothing is installed on the host.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY views ./views

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV HOST=0.0.0.0 PORT=8090 DATA_DIR=/app/data
EXPOSE 8090
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
