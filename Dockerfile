FROM node:18-slim

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    maven \
    openjdk-17-jdk \
    jq \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for better caching)
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Make bash script executable
RUN chmod +x bash.sh
RUN chmod +x docker-healthcheck.sh
# Build TypeScript to JavaScript
RUN npm run build

# Create necessary directories
RUN mkdir -p logs
RUN mkdir -p plugins

# Expose the port the app runs on
EXPOSE 3001

# Start the server
CMD ["node", "dist/index.js"]