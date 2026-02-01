FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
CMD ["node","dist/index.js"]
