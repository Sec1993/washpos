FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tzdata
ENV TZ=Asia/Makassar
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
