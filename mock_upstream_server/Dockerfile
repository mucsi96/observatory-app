FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js ./
USER node
EXPOSE 3070
CMD ["node","index.js"]
