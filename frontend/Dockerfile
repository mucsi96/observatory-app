FROM node:26-bookworm-slim AS build
WORKDIR /workspace
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.31.6
LABEL org.opencontainers.image.source="https://github.com/mucsi96/observatory-app"
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/dist /usr/share/nginx/html
EXPOSE 8000
