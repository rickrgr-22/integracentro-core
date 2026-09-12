FROM node:18-alpine

WORKDIR /app

# Copilar dependencias
COPY package*.json ./
RUN npm install

# Copiar el código fuente
COPY . .

EXPOSE 3000

# Comando de inicio para desarrollo con ts-node
CMD ["npx", "ts-node", "src/server.ts"]
