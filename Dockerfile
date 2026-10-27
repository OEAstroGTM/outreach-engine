FROM node:22-alpine
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN cd mcp && npm ci --omit=dev
COPY clients.json ./clients.json
COPY mcp ./mcp
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "mcp/http.js"]
