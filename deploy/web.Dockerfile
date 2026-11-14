# Клиент прототипа: сборка из CTG-Proto (контекст сборки — папка прототипа) → раздача через Caddy.
# Адрес сервера в клиент не зашивается: страница, открытая с домена, ходит на тот же домен (см. src/net/client.ts).
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
ARG VITE_NAKAMA_KEY=defaultkey
ENV VITE_NAKAMA_KEY=$VITE_NAKAMA_KEY
RUN npm run build

FROM caddy:2-alpine

COPY --from=build /app/dist /srv
