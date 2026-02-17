# Imagem oficial do Playwright já vem com TODAS as libs do Chromium
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Copia package.json primeiro para aproveitar cache
COPY package*.json ./

# Instala dependências do Node
RUN npm ci --omit=dev || npm install --omit=dev

# Copia o restante do projeto
COPY . .

# Railway usa a porta 8080 normalmente, mas seu app deve ler process.env.PORT
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
