FROM node:20-alpine

WORKDIR /app

COPY app_bunny.js ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "app_bunny.js"]
