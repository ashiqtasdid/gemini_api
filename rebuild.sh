#!/bin/bash
# Save as rebuild-with-cleanup.sh

# Set color variables
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧹 Cleaning Docker resources...${NC}"
# Remove all stopped containers
docker container prune -f
# Remove unused images
docker image prune -a -f
# Remove unused volumes
docker volume prune -f
# Remove build cache
docker builder prune -a -f

echo -e "${BLUE}📊 Current disk space:${NC}"
df -h /

echo -e "${BLUE}🛑 Stopping containers...${NC}"
docker compose down --remove-orphans

echo -e "${BLUE}🔄 Rebuilding images...${NC}"
docker compose build --no-cache

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Build failed! See errors above.${NC}"
  exit 1
fi

echo -e "${BLUE}🚀 Starting containers...${NC}"
docker compose up -d

# Wait for container to be healthy
echo -e "${YELLOW}⏳ Waiting for service to start...${NC}"
sleep 5

# Check if service is running
if [ "$(docker compose ps --status running | grep app)" ]; then
  echo -e "${GREEN}✅ Service is running!${NC}"
  
  # Show container status
  echo -e "${BLUE}📊 Container status:${NC}"
  docker compose ps
  
  echo -e "${GREEN}✅ Rebuild complete!${NC}"
  echo -e "${BLUE}📋 Container logs:${NC}"
  docker compose logs -f
else
  echo -e "${YELLOW}⚠️ Service may not have started properly. Checking logs:${NC}"
  docker compose logs
fi