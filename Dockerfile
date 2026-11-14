FROM node:alpine AS node-builder

WORKDIR /backend

COPY package*.json .
RUN npm install

COPY . .
RUN npm run build

FROM heroiclabs/nakama:3.32.0

COPY --from=node-builder /backend/build/*.js /nakama/data/modules/
COPY local.yml prod.yml /nakama/data/
