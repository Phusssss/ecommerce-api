FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY schema.sql ./schema.sql
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "node scripts/init-db.js && npm start"]
