FROM node:22-slim

# Install tools sub-agents need for bash execution
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    wkhtmltopdf \
    xvfb \
    fontconfig \
    fonts-liberation \
    python3 \
    python3-pip \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libcairo2 \
    && pip3 install weasyprint pypdf requests --break-system-packages --quiet \
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
