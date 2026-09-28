FROM node:22-slim

WORKDIR /app

# Install deps first so this layer caches across deploys that don't touch
# onchain/package*.json.
COPY onchain/package.json onchain/package-lock.json ./onchain/
RUN cd onchain && npm install --omit=dev

# Then bring in everything else: index.html + assets/ (served statically by
# the backend, see server/index.mjs) and the rest of onchain/.
COPY . .

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "onchain/server/index.mjs"]
