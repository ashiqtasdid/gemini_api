FROM node:18-slim

# Install build dependencies and bash
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    maven \
    openjdk-17-jdk \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or pnpm-lock.yaml)
COPY package*.json ./
# If using pnpm, uncomment the following lines
# RUN npm install -g pnpm
# COPY pnpm-lock.yaml ./
# RUN pnpm install

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Expose the port the app runs on
EXPOSE 3001

# Create log directory
RUN mkdir -p logs

# Set environment to production
ENV NODE_ENV=production

# Start the server
CMD ["node", "dist/index.js"]