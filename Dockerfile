FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite wget
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p public/uploads public/uploads/absen
# Railway healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget --spider -q http://localhost:$PORT/login || exit 1
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
