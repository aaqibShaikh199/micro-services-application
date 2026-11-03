# node:22-alpine is published for linux/amd64 and linux/arm64.
# This service has no native addons, so one build runs on Apple Silicon and Ubuntu.
FROM node:22-alpine
LABEL org.opencontainers.image.title="robot-legs" \
      org.opencontainers.image.description="Legs microservice"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node app.js index.html style.css script.js package.json ./
ENV NODE_ENV=production \
    PORT=3001
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app.js"]
