FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p public/uploads public/uploads/absen
EXPOSE 3000
ENV NODE_ENV=production
# Railway akan override PORT, jangan hardcode
CMD ["node", "server.js"]
