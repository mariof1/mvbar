FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip py3-virtualenv && \
    python3 -m virtualenv /opt/mvbar-metadata && \
    /opt/mvbar-metadata/bin/pip install --no-cache-dir mutagen==1.47.0
ENV METADATA_PYTHON=/opt/mvbar-metadata/bin/python
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
EXPOSE 3000
CMD ["node","dist/index.js"]
