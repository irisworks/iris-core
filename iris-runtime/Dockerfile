FROM node:22-slim

# Install tools sub-agents need for bash execution
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

WORKDIR /app

# Copy built dist and package files
COPY dist/ ./dist/
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev --prefer-offline

# iris-runtime reads workspace from argv[2]
ENTRYPOINT ["node", "dist/main.js"]
