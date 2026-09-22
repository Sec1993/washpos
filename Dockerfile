FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p public/uploads public/uploads/absen
# Railway akan healthcheck otomatis ke / — hapus HEALTHCHECK custom biar tidak 502
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
