FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data/uploads data/uploads/absen
EXPOSE ${PORT:-3000}
ENV NODE_ENV=production
CMD ["node", "server.js"]
