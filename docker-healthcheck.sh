#!/bin/bash
# Simple script to verify Docker environment

echo "Checking Docker build environment..."
echo "========================================"
echo "Current directory: $(pwd)"
echo "========================================"
echo "Java version:"
java -version
echo "========================================"
echo "Maven version:"
mvn --version
echo "========================================"
echo "Node version:"
node --version
echo "========================================"
echo "npm version:"
npm --version
echo "========================================"
echo "Bash version:"
bash --version
echo "========================================"
echo "File permissions for bash.sh:"
ls -la bash.sh
echo "========================================"
echo "Redis connection:"
nc -zv redis 6379 2>&1 || echo "Redis not reachable"
echo "========================================"