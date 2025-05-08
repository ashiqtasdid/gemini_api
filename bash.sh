#!/bin/bash
# filepath: d:\Codespace\api\gemini_api\bash.sh
set -eo pipefail  # Exit on error, pipe failure

# Define colors for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Support Docker logging
if [ "$DOCKER_ENV" = "true" ] || [ -n "$VERBOSE" ]; then
    # Force instant log flushing for Docker logs
    export PYTHONUNBUFFERED=1
    export PYTHONIOENCODING=UTF-8
    
    # Modify log function for Docker
    log() {
        local level=$1
        local message=$2
        local color=$NC
        
        case $level in
            "INFO") color=$BLUE ;;
            "SUCCESS") color=$GREEN ;;
            "WARNING") color=$YELLOW ;;
            "ERROR") color=$RED ;;
        esac
        
        echo -e "${color}[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message${NC}"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message" >> "$LOG_FILE"
        
        # Also log to stderr for Docker to capture
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message" >&2
    }
fi

# Set up trap to clean temporary files on exit
cleanup() {
    echo -e "${BLUE}🧹 Cleaning up temporary files...${NC}"
    [ -n "$TEMP_JSON_FILE" ] && [ -f "$TEMP_JSON_FILE" ] && rm -f "$TEMP_JSON_FILE"
    [ -n "$TEMP_RESPONSE_FILE" ] && [ -f "$TEMP_RESPONSE_FILE" ] && rm -f "$TEMP_RESPONSE_FILE"
    [ -n "$CURRENT_DIR" ] && [ "$PWD" != "$CURRENT_DIR" ] && cd "$CURRENT_DIR"
}
trap cleanup EXIT INT TERM

# Function to display a spinner during long operations
spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='|/-\'
    echo -n "   "
    # Docker-compatible process check
    while ps -p $pid > /dev/null 2>&1; do
        local temp=${spinstr#?}
        printf "\b\b\b[%c]" "$spinstr"
        local spinstr=$temp${spinstr%"$temp"}
        sleep $delay
    done
    printf "\b\b\b   \b\b\b"
}

# Function to log messages to both console and log file
log() {
    local level=$1
    local message=$2
    local color=$NC
    
    case $level in
        "INFO") color=$BLUE ;;
        "SUCCESS") color=$GREEN ;;
        "WARNING") color=$YELLOW ;;
        "ERROR") color=$RED ;;
        "DEBUG") color=$CYAN ;;
    esac
    
    echo -e "${color}[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message${NC}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message" >> "$LOG_FILE"
}

# Check for required dependencies
REQUIRED_TOOLS=("mvn" "jq" "curl" "java")
MISSING_TOOLS=()

for tool in "${REQUIRED_TOOLS[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
        MISSING_TOOLS+=("$tool")
    fi
done

if [ ${#MISSING_TOOLS[@]} -ne 0 ]; then
    echo -e "${RED}❌ Error: The following required tools are missing:${NC}"
    for tool in "${MISSING_TOOLS[@]}"; do
        echo "  - $tool"
    done
    echo "Please install them before continuing."
    exit 1
fi

# Handle command line arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <plugin_directory> <bearer_token> [api_host] [options]"
    echo "Example: $0 /path/to/plugin-directory my-token http://localhost:3001"
    echo ""
    echo "Options:"
    echo "  --verbose       Enable verbose output"
    echo "  --no-color      Disable colored output"
    echo "  --max-attempts N  Set maximum AI fix attempts (default: 5)"
    echo "  --parallel N    Set Maven parallel threads (default: available CPU cores)"
    echo "  --timeout N     Set API request timeout in seconds (default: 600)"
    echo "  --debug         Enable debug mode with additional logging"
    echo "  --skip-verify   Skip JAR verification step"
    exit 1
fi

# Parse required arguments
PLUGIN_DIR=$(realpath "$1" 2>/dev/null || echo "$1")
TOKEN="$2"
API_HOST="${3:-http://localhost:3001}"
API_URL_FIX="${API_HOST}/api/fix"

# Default options
VERBOSE=false
DEBUG=false
MAX_AI_FIX_ATTEMPTS=5
MAVEN_PARALLEL=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
API_TIMEOUT=600
SKIP_VERIFY=false

# Parse optional arguments
shift 3 || shift "$#"
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --debug)
            DEBUG=true
            VERBOSE=true
            shift
            ;;
        --no-color)
            RED=''
            GREEN=''
            YELLOW=''
            BLUE=''
            CYAN=''
            NC=''
            shift
            ;;
        --max-attempts)
            MAX_AI_FIX_ATTEMPTS="$2"
            shift 2
            ;;
        --parallel)
            MAVEN_PARALLEL="$2"
            shift 2
            ;;
        --timeout)
            API_TIMEOUT="$2"
            shift 2
            ;;
        --skip-verify)
            SKIP_VERIFY=true
            shift
            ;;
        *)
            echo -e "${RED}❌ Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Extract plugin name from directory
PLUGIN_NAME=$(basename "$PLUGIN_DIR")

# Set up logging
LOG_FILE="$PLUGIN_DIR/build.log"
echo "Build started at $(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')" > "$LOG_FILE"

# Output setup information
log "INFO" "Starting build process for plugin in $PLUGIN_DIR"
log "INFO" "Using $API_HOST for AI assistance"
$VERBOSE && log "INFO" "Maven parallel threads: $MAVEN_PARALLEL"
$VERBOSE && log "INFO" "Maximum AI fix attempts: $MAX_AI_FIX_ATTEMPTS"

# Early debugging information if debug mode is enabled
if $DEBUG; then
    log "DEBUG" "Build script environment:"
    log "DEBUG" "Plugin directory: $PLUGIN_DIR"
    log "DEBUG" "API host: $API_HOST"
    log "DEBUG" "Current directory: $(pwd)"
    log "DEBUG" "Maven version: $(mvn --version 2>&1 | head -n 1)"
    log "DEBUG" "Java version: $(java -version 2>&1 | head -n 1)"
    log "DEBUG" "Operating system: $(uname -a 2>/dev/null || echo 'Unknown')"
fi

# Function to handle Docker-specific issues
fix_docker_paths() {
    # Make sure we can write to output directories
    mkdir -p "$PLUGIN_DIR/target" 2>/dev/null || true
    chmod -R 777 "$PLUGIN_DIR" 2>/dev/null || true
    
    # In Docker, ensure Maven home directories exist
    mkdir -p ~/.m2 2>/dev/null || true
    
    # Fix Maven repository permissions
    if [ -d ~/.m2/repository ]; then
        chmod -R 777 ~/.m2/repository 2>/dev/null || true
    fi
}

# Call this function early
fix_docker_paths

# Check if directory exists
if [ ! -d "$PLUGIN_DIR" ]; then
    log "ERROR" "Plugin directory does not exist: $PLUGIN_DIR"
    echo "{\"success\":false,\"error\":\"Plugin directory not found: $PLUGIN_DIR\"}" > "$PLUGIN_DIR/build_result.json"
    exit 1
fi

# Check if pom.xml exists
if [ ! -f "$PLUGIN_DIR/pom.xml" ]; then
    log "ERROR" "No pom.xml found in $PLUGIN_DIR"
    echo "{\"success\":false,\"error\":\"No pom.xml found in plugin directory\"}" > "$PLUGIN_DIR/build_result.json"
    exit 1
fi

log "INFO" "----------------------------------------"
log "INFO" "🔨 Building plugin with Maven..."
log "INFO" "----------------------------------------"

# Save current directory to return later
CURRENT_DIR=$(pwd)

# Change to the plugin directory
cd "$PLUGIN_DIR" || {
    log "ERROR" "Failed to change to plugin directory: $PLUGIN_DIR"
    echo "{\"success\":false,\"error\":\"Failed to access plugin directory\"}" > "$PLUGIN_DIR/build_result.json"
    exit 1
}

# Cross-platform command helper
find_command() {
    if command -v "$1" &> /dev/null; then
        eval "$2"
    else
        eval "$3"
    fi
}

# Function to log to container logs
container_log() {
    local level=$1
    local message=$2
    
    # Write directly to stderr for container logs
    echo "[CONTAINER] [$level] $message" >&2
    
    # Also log to regular log file
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CONTAINER] [$level] $message" >> "$LOG_FILE"
}

# Critical messages go to container log
container_log "INFO" "Starting build process for plugin $PLUGIN_NAME"

# Enhanced Maven build process with additional error handling
build_plugin() {
    local build_type=$1
    local build_output=""
    local exit_code=0
    
    log "INFO" "🧹 Cleaning previous build artifacts..."
    rm -rf target/

    case $build_type in
        "normal")
            log "INFO" "🏗️ Running Maven build..."
            if $VERBOSE; then
                mvn clean package -T "$MAVEN_PARALLEL" -B
                exit_code=$?
            else
                build_output=$(mvn clean package -T "$MAVEN_PARALLEL" -B 2>&1) || exit_code=$?
                echo "$build_output" > "$PLUGIN_DIR/maven.log"
            fi
            ;;
        "no-shade")
            log "INFO" "🏗️ Running Maven build without shading..."
            if $VERBOSE; then
                mvn clean package -Dmaven.shade.skip=true -T "$MAVEN_PARALLEL" -B
                exit_code=$?
            else
                build_output=$(mvn clean package -Dmaven.shade.skip=true -T "$MAVEN_PARALLEL" -B 2>&1) || exit_code=$?
                echo "$build_output" > "$PLUGIN_DIR/maven-no-shade.log"
            fi
            ;;
        "compile-only")
            log "INFO" "🏗️ Compiling only (for error checking)..."
            build_output=$(mvn clean compile -e -T "$MAVEN_PARALLEL" -B 2>&1) || exit_code=$?
            echo "$build_output"
            return $exit_code
            ;;
    esac
    
    # Log key info from the build output even in non-verbose mode
    if [ -n "$build_output" ] && ! $VERBOSE; then
        # Extract and log errors
        echo "$build_output" | grep -E '\[ERROR\]|\[WARN\]' | while read -r line; do
            log "WARNING" "$line"
        done
    fi
    
    return $exit_code
}

# Improved JAR file finder
find_jar_file() {
    local jar_file=""
    
    # Try different methods to find the JAR
    if command -v find &> /dev/null; then
        jar_file=$(find target -name "*.jar" -not -name "*-sources.jar" -not -name "*-javadoc.jar" -not -name "*-original*.jar" -type f | head -n 1)
    else
        # Windows alternative using dir
        jar_file=$(dir /s /b target\\*.jar 2>/dev/null | grep -v "original" | grep -v "sources" | grep -v "javadoc" | head -n 1 | tr '\\' '/')
    fi
    
    # If not found, try a more permissive search
    if [ -z "$jar_file" ]; then
        jar_file=$(find target -name "*.jar" -type f | head -n 1 2>/dev/null)
    fi
    
    echo "$jar_file"
}

# Enhanced JAR verification with more checks
verify_jar() {
    local jar_file=$1
    
    if $SKIP_VERIFY; then
        log "INFO" "Skipping JAR verification as requested"
        return 0
    fi
    
    log "INFO" "🔍 Verifying JAR file integrity..."
    
    # Check if JAR exists
    if [ ! -f "$jar_file" ]; then
        log "ERROR" "JAR file does not exist: $jar_file"
        return 1
    fi
    
    # Check if JAR is readable
    if [ ! -r "$jar_file" ]; then
        log "ERROR" "JAR file is not readable: $jar_file"
        return 1
    fi
    
    # Check JAR structure
    if ! jar -tf "$jar_file" > /dev/null 2>&1; then
        log "ERROR" "JAR file verification failed - file may be corrupted"
        return 1
    fi
    
    # Check for plugin.yml in the JAR
    if ! jar -tf "$jar_file" | grep -q "plugin.yml"; then
        log "WARNING" "JAR file may be missing plugin.yml"
    fi
    
    # Calculate file size
    local file_size=$(du -h "$jar_file" 2>/dev/null | cut -f1 || echo "unknown")
    log "INFO" "JAR file size: $file_size"
    
    # Calculate and record checksum
    local checksum
    if command -v sha256sum > /dev/null; then
        checksum=$(sha256sum "$jar_file" | cut -d' ' -f1)
    elif command -v shasum > /dev/null; then
        checksum=$(shasum -a 256 "$jar_file" | cut -d' ' -f1)
    else
        checksum="unavailable"
    fi
    
    log "INFO" "JAR file checksum (SHA-256): $checksum"
    echo "$checksum" > "${jar_file}.sha256"
    return 0
}

# More efficient file content collection
collect_file_contents() {
    local first=true
    local file_data=""
    local file_list=""
    
    # Find all relevant source files
    if command -v find &> /dev/null; then
        file_list=$(find . -type f \( -name "*.java" -o -name "pom.xml" -o -name "plugin.yml" -o -name "config.yml" \) -not -path "./target/*" 2>/dev/null)
    else
        # Windows fallback
        file_list=$(dir /s /b *.java *.xml *.yml 2>/dev/null | grep -v /target/ | grep -v \\target\\)
    fi
    
    for file in $file_list; do
        # Skip target directory files
        [[ "$file" == *"target/"* ]] && continue
        [[ "$file" == *"target\\"* ]] && continue
        
        # Skip files that don't exist or aren't readable
        [ ! -f "$file" ] && continue
        [ ! -r "$file" ] && continue

        if [ "$first" = true ]; then
            first=false
        else
            file_data+=","
        fi

        # Get relative path
        local rel_path
        if command -v realpath &> /dev/null; then
            rel_path=$(realpath --relative-to="." "$file")
        else
            # Simple fallback
            rel_path="$file"
            # Remove leading ./ if present
            rel_path="${rel_path#./}"
        fi

        # Use jq to properly escape the file content
        if command -v jq &> /dev/null; then
            file_data+="\"$rel_path\": $(jq -Rs . < "$file")"
        else
            # Fallback for systems without jq (less reliable)
            local content
            content=$(cat "$file" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr -d '\r' | tr '\n' ' ')
            file_data+="\"$rel_path\": \"$content\""
        fi
    done

    echo "$file_data"
}

# Enhanced build error analysis
analyze_build_errors() {
    local build_output=$1
    log "INFO" "🔎 Analyzing build errors..."
    
    # Create a summary of error types
    local error_count=$(echo "$build_output" | grep -c "\[ERROR\]" || echo "0")
    local warning_count=$(echo "$build_output" | grep -c "\[WARNING\]" || echo "0")
    
    log "INFO" "Found $error_count errors and $warning_count warnings"
    
    # Check for common error patterns
    if echo "$build_output" | grep -q "No compiler is provided in this environment"; then
        log "ERROR" "Java compiler not found. Please ensure JDK is installed and JAVA_HOME is set."
    fi
    
    if echo "$build_output" | grep -q "package .* does not exist"; then
        log "ERROR" "Missing package dependencies. Maven may be unable to resolve all dependencies."
    fi
    
    if echo "$build_output" | grep -q "cannot find symbol"; then
        log "ERROR" "Code contains references to undefined symbols or classes."
    fi
    
    if echo "$build_output" | grep -q "error: release version"; then
        log "ERROR" "Java version mismatch. Check your Java version against the one specified in pom.xml."
    fi
    
    if echo "$build_output" | grep -q "Could not resolve dependencies"; then
        log "ERROR" "Dependency resolution failed. Check your internet connection and repository settings."
    fi
    
    if echo "$build_output" | grep -q "Failed to execute goal org.apache.maven.plugins:maven-shade-plugin"; then
        log "ERROR" "Shade plugin execution failed. May need to try without shading."
    fi
    
    if echo "$build_output" | grep -q "OutOfMemoryError"; then
        log "ERROR" "Maven build ran out of memory. Try increasing JVM heap size."
    fi
    
    # Check for specific file errors
    echo "$build_output" | grep -E "\[ERROR\] (.+\.java):\[([0-9]+),([0-9]+)\]" | head -n 5 | while read -r line; do
        log "WARNING" "Source error: $line"
    done
}

# Try to build the plugin
if build_plugin "normal"; then
    log "SUCCESS" "----------------------------------------"
    log "SUCCESS" "✅ Maven build successful!"
    log "SUCCESS" "----------------------------------------"

    # Find the generated JAR file
    JAR_FILE=$(find_jar_file)

    if [ -n "$JAR_FILE" ]; then
        # Verify JAR integrity
        if verify_jar "$JAR_FILE"; then
            log "SUCCESS" "🎮 Plugin JAR file created: $JAR_FILE"
            log "INFO" "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
            # Add standardized output for the server to parse
            echo "PLUGIN_JAR_PATH:$JAR_FILE"
            echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"buildLog\":\"$LOG_FILE\",\"message\":\"Build completed successfully\"}" > "$PLUGIN_DIR/build_result.json"
            exit 0
        else
            log "ERROR" "JAR verification failed for $JAR_FILE"
            echo "{\"success\":false,\"error\":\"JAR verification failed\",\"jarPath\":\"$JAR_FILE\",\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
            exit 1
        fi
    else
        log "WARNING" "⚠️ Plugin JAR file not found in target directory."
        echo "{\"success\":false,\"error\":\"JAR file not found\",\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
        exit 1
    fi
else
    log "WARNING" "----------------------------------------"
    log "WARNING" "❌ Maven build failed. Attempting to fix issues with AI..."
    log "WARNING" "----------------------------------------"

    # Initialize attempt counter
    AI_FIX_ATTEMPTS=0
    BUILD_SUCCESS=false

    # Start AI fix loop
    while [ $AI_FIX_ATTEMPTS -lt $MAX_AI_FIX_ATTEMPTS ] && [ "$BUILD_SUCCESS" = false ]; do
        AI_FIX_ATTEMPTS=$((AI_FIX_ATTEMPTS + 1))
        log "INFO" "----------------------------------------"
        log "INFO" "🔄 AI Fix Attempt #$AI_FIX_ATTEMPTS of $MAX_AI_FIX_ATTEMPTS"
        log "INFO" "----------------------------------------"

        # Capture the build errors
        BUILD_ERRORS=$(build_plugin "compile-only")
        BUILD_EXIT_CODE=$?
        
        # Analyze errors to provide better feedback
        analyze_build_errors "$BUILD_ERRORS"

        log "INFO" "🔍 Packaging build errors for analysis..."

        # Create temp files with unique names to avoid conflicts
        TEMP_JSON_FILE=$(mktemp)
        TEMP_RESPONSE_FILE=$(mktemp)
        
        # Prepare the JSON payload with errors and file contents
        echo "{" > "$TEMP_JSON_FILE"
        echo "  \"buildErrors\": $(jq -Rs . <<< "$BUILD_ERRORS")," >> "$TEMP_JSON_FILE"
        echo "  \"files\": {" >> "$TEMP_JSON_FILE"
        collect_file_contents >> "$TEMP_JSON_FILE"
        echo "  }," >> "$TEMP_JSON_FILE"
        echo "  \"pluginDir\": \"$PLUGIN_DIR\"" >> "$TEMP_JSON_FILE"
        echo "}" >> "$TEMP_JSON_FILE"

        log "INFO" "🔄 Sending build errors to API for fixing (this may take a few minutes)..."
        
        # Make API request to fix issues with progress indicator
        log "INFO" "Waiting for API response..."
        (curl -s --connect-timeout 30 --max-time "$API_TIMEOUT" -X POST "$API_URL_FIX" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d @"$TEMP_JSON_FILE" > "$TEMP_RESPONSE_FILE") &
        CURL_PID=$!
        
        # Show spinner if not in verbose mode
        if ! $VERBOSE; then
            spinner $CURL_PID
        else
            wait $CURL_PID
        fi
        
        # Check if the curl command succeeded
        CURL_STATUS=$?
        if [ $CURL_STATUS -ne 0 ]; then
            log "ERROR" "❌ API request failed with status $CURL_STATUS"
            log "INFO" "Continuing with next fix attempt..."
            rm -f "$TEMP_JSON_FILE" "$TEMP_RESPONSE_FILE"
            continue
        fi
        
        # Check if response is empty
        if [ ! -s "$TEMP_RESPONSE_FILE" ]; then
            log "ERROR" "❌ Received empty response from API"
            log "INFO" "Continuing with next fix attempt..."
            rm -f "$TEMP_JSON_FILE" "$TEMP_RESPONSE_FILE"
            continue
        fi
        
        FIX_RESPONSE=$(cat "$TEMP_RESPONSE_FILE")
        
        # Validate fix API response
        if ! echo "$FIX_RESPONSE" | jq -e '.status == "success"' > /dev/null 2>&1; then
            ERROR_MSG=$(echo "$FIX_RESPONSE" | jq -r '.message // "Unknown error"')
            log "ERROR" "❌ Error from fix API: $ERROR_MSG"
            log "INFO" "Continuing with next fix attempt..."
            rm -f "$TEMP_JSON_FILE" "$TEMP_RESPONSE_FILE"
            continue
        fi

        log "SUCCESS" "✅ Received fixes from API!"

        # Extract the fixed files
        FIXED_FILES=$(echo "$FIX_RESPONSE" | jq '.data')
        
        # Count how many files were fixed
        FIXED_COUNT=$(echo "$FIXED_FILES" | jq 'length')
        log "INFO" "Received fixes for $FIXED_COUNT file(s)"
        
        # Check if any files were fixed
        if [ "$FIXED_COUNT" -eq 0 ]; then
            log "WARNING" "No files were fixed by the API"
            log "INFO" "Continuing with next fix attempt with a different approach..."
            rm -f "$TEMP_JSON_FILE" "$TEMP_RESPONSE_FILE"
            continue
        }

        # Process each fixed file
        for FILE_PATH in $(echo "$FIXED_FILES" | jq -r 'keys[]'); do
            # Make sure path is safe
            if [[ "$FILE_PATH" == *".."* ]] || [[ "$FILE_PATH" == "/"* ]]; then
                log "WARNING" "Skipping suspicious file path: $FILE_PATH"
                continue
            }
            
            # Create directory if it doesn't exist
            mkdir -p "$(dirname "$FILE_PATH")"
            
            # Write content directly to file
            echo "$FIXED_FILES" | jq -r --arg path "$FILE_PATH" '.[$path]' > "$FILE_PATH"
            log "INFO" "🔧 Updated: $FILE_PATH"
            
            # Verify file was written
            if [ ! -f "$FILE_PATH" ]; then
                log "WARNING" "Failed to write file: $FILE_PATH"
            elif [ ! -s "$FILE_PATH" ]; then
                log "WARNING" "File is empty after update: $FILE_PATH"
            fi
        done

        log "INFO" "----------------------------------------"
        log "INFO" "🔄 Retrying build with fixed files..."
        log "INFO" "----------------------------------------"

        # Try to build again with the fixed files
        if build_plugin "normal"; then
            log "SUCCESS" "----------------------------------------"
            log "SUCCESS" "✅ Build successful after $AI_FIX_ATTEMPTS AI fix attempts!"
            log "SUCCESS" "----------------------------------------"

            # Find the generated JAR file
            JAR_FILE=$(find_jar_file)

            if [ -n "$JAR_FILE" ]; then
                # Verify JAR integrity
                if verify_jar "$JAR_FILE"; then
                    log "SUCCESS" "🎮 Plugin JAR file created: $JAR_FILE"
                    log "INFO" "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
                    # Add standardized output for the server to parse
                    echo "PLUGIN_JAR_PATH:$JAR_FILE"
                    echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"fixes\":$AI_FIX_ATTEMPTS,\"buildLog\":\"$LOG_FILE\",\"message\":\"Build completed after $AI_FIX_ATTEMPTS fix attempts\"}" > "$PLUGIN_DIR/build_result.json"
                    BUILD_SUCCESS=true
                    break
                else
                    log "ERROR" "JAR verification failed for $JAR_FILE"
                fi
            else
                log "WARNING" "⚠️ Plugin JAR file not found in target directory."
            fi
        else
            log "WARNING" "❌ Build still failing after fix attempt #$AI_FIX_ATTEMPTS"
            if [ $AI_FIX_ATTEMPTS -ge $MAX_AI_FIX_ATTEMPTS ]; then
                log "WARNING" "Maximum fix attempts reached."
            else
                log "INFO" "Continuing with next fix attempt..."
            }
        fi

        # Clean up temp files for this attempt
        rm -f "$TEMP_JSON_FILE" "$TEMP_RESPONSE_FILE"
    done

    # If all AI fix attempts failed, try manual approach
    if [ "$BUILD_SUCCESS" = false ]; then
        log "WARNING" "----------------------------------------"
        log "WARNING" "❌ AI-based fixes unsuccessful after $MAX_AI_FIX_ATTEMPTS attempts."
        log "WARNING" "🔧 Attempting manual fixes..."
        log "WARNING" "----------------------------------------"

        # Try with skip shade option as a fallback
        log "INFO" "Attempting build with -Dmaven.shade.skip=true..."
        if build_plugin "no-shade"; then
            log "WARNING" "⚠️ Basic build succeeded without shading."

            # Find JAR after no-shade build
            JAR_FILE=$(find_jar_file)

            if [ -n "$JAR_FILE" ]; then
                # Verify JAR integrity
                if verify_jar "$JAR_FILE"; then
                    log "SUCCESS" "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                    log "WARNING" "Note: This JAR may not include all dependencies."
                    echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"noShade\":true,\"buildLog\":\"$LOG_FILE\",\"message\":\"Build succeeded without shading\"}" > "$PLUGIN_DIR/build_result.json"
                    exit 0
                else
                    log "ERROR" "JAR verification failed for $JAR_FILE"
                    echo "{\"success\":false,\"error\":\"JAR verification failed\",\"jarPath\":\"$JAR_FILE\",\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
                    exit 1
                }
            else
                log "ERROR" "No JAR file created even with shade skipping"
                echo "{\"success\":false,\"error\":\"No JAR file created even with shade skipping\",\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
                exit 1
            }
        else
            log "ERROR" "----------------------------------------"
            log "ERROR" "❌ Maven build failed with all approaches."
            log "ERROR" "Common issues to check:"
            log "ERROR" "1. Incorrect plugin dependencies"
            log "ERROR" "2. Maven Shade Plugin configuration issues"
            log "ERROR" "3. Java version compatibility problems"
            log "ERROR" "4. File permission issues in the target directory"
            log "ERROR" "----------------------------------------"
            
            # Create detailed error report
            ERROR_REPORT=$(mktemp)
            echo "# Build Error Report" > "$ERROR_REPORT"
            echo "Date: $(date)" >> "$ERROR_REPORT"
            echo "Plugin: $PLUGIN_NAME" >> "$ERROR_REPORT"
            echo "AI Fix Attempts: $AI_FIX_ATTEMPTS" >> "$ERROR_REPORT"
            echo "" >> "$ERROR_REPORT"
            echo "## Last Build Errors" >> "$ERROR_REPORT"
            echo '```' >> "$ERROR_REPORT"
            echo "$BUILD_ERRORS" | grep -E '\[ERROR\]|\[FATAL\]' | tail -n 20 >> "$ERROR_REPORT"
            echo '```' >> "$ERROR_REPORT"
            
            cp "$ERROR_REPORT" "$PLUGIN_DIR/error-report.md"
            rm -f "$ERROR_REPORT"
            
            echo "{\"success\":false,\"error\":\"All build attempts failed\",\"buildErrors\":$(jq -Rs . <<< "$BUILD_ERRORS"),\"buildLog\":\"$LOG_FILE\",\"errorReport\":\"$PLUGIN_DIR/error-report.md\"}" > "$PLUGIN_DIR/build_result.json"
            exit 1
        }
    }
fi

# Return to original directory
cd "$CURRENT_DIR"

log "SUCCESS" "----------------------------------------"
log "SUCCESS" "✨ Process completed"
log "SUCCESS" "----------------------------------------"