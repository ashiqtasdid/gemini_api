#!/bin/bash
set -eo pipefail  # Exit on error, pipe failure

# Define colors for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Set up trap to clean temporary files on exit
cleanup() {
    echo -e "${BLUE}🧹 Cleaning up temporary files...${NC}"
    [ -n "$TEMP_JSON_FILE" ] && [ -f "$TEMP_JSON_FILE" ] && rm -f "$TEMP_JSON_FILE"
    [ -n "$CURRENT_DIR" ] && [ "$PWD" != "$CURRENT_DIR" ] && cd "$CURRENT_DIR"
}
trap cleanup EXIT INT TERM

# Function to display a spinner during long operations
spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='|/-\'
    echo -n "   "
    while [ "$(ps a | awk '{print $1}' | grep -w $pid)" ]; do
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
    esac
    
    echo -e "${color}[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message${NC}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message" >> "$LOG_FILE"
}

# Check for required dependencies
REQUIRED_TOOLS=("mvn" "jq" "curl")
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
    echo "Example: $0 /path/to/plugin-directory my-token http://localhost:5000"
    echo ""
    echo "Options:"
    echo "  --verbose       Enable verbose output"
    echo "  --no-color      Disable colored output"
    echo "  --max-attempts N  Set maximum AI fix attempts (default: 5)"
    echo "  --parallel N    Set Maven parallel threads (default: available CPU cores)"
    echo "  --timeout N     Set API request timeout in seconds (default: 600)"
    exit 1
fi

# Parse required arguments
PLUGIN_DIR="$1"
TOKEN="$2"
API_HOST="${3:-http://localhost:3001}"
API_URL_FIX="${API_HOST}/api/fix"

# Default options
VERBOSE=false
MAX_AI_FIX_ATTEMPTS=5
MAVEN_PARALLEL=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
API_TIMEOUT=600

# Parse optional arguments
shift 3 || shift "$#"
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --no-color)
            RED=''
            GREEN=''
            YELLOW=''
            BLUE=''
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
        *)
            echo -e "${RED}❌ Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Set up logging
LOG_FILE="$PLUGIN_DIR/build.log"
echo "" > "$LOG_FILE"  # Initialize log file

# Output setup information
log "INFO" "Starting build process for plugin in $PLUGIN_DIR"
log "INFO" "Using $API_HOST for AI assistance"
$VERBOSE && log "INFO" "Maven parallel threads: $MAVEN_PARALLEL"
$VERBOSE && log "INFO" "Maximum AI fix attempts: $MAX_AI_FIX_ATTEMPTS"

# Check if directory exists
if [ ! -d "$PLUGIN_DIR" ]; then
    log "ERROR" "Plugin directory does not exist: $PLUGIN_DIR"
    exit 1
fi

# Check if pom.xml exists
if [ ! -f "$PLUGIN_DIR/pom.xml" ]; then
    log "ERROR" "No pom.xml found in $PLUGIN_DIR"
    exit 1
fi

log "INFO" "----------------------------------------"
log "INFO" "🔨 Building plugin with Maven..."
log "INFO" "----------------------------------------"

# Save current directory to return later
CURRENT_DIR=$(pwd)

# Change to the plugin directory
cd "$PLUGIN_DIR"

# Cross-platform command helper
find_command() {
    if command -v "$1" &> /dev/null; then
        eval "$2"
    else
        eval "$3"
    fi
}

# More efficient Maven build process
build_plugin() {
    local build_type=$1
    log "INFO" "🧹 Cleaning previous build artifacts..."
    rm -rf target/

    case $build_type in
        "normal")
            log "INFO" "🏗️ Running Maven build..."
            if $VERBOSE; then
                mvn clean package -T "$MAVEN_PARALLEL" -B
            else
                mvn clean package -T "$MAVEN_PARALLEL" -B > "$PLUGIN_DIR/maven.log" 2>&1
            fi
            ;;
        "no-shade")
            log "INFO" "🏗️ Running Maven build without shading..."
            if $VERBOSE; then
                mvn clean package -Dmaven.shade.skip=true -T "$MAVEN_PARALLEL" -B
            else
                mvn clean package -Dmaven.shade.skip=true -T "$MAVEN_PARALLEL" -B > "$PLUGIN_DIR/maven-no-shade.log" 2>&1
            fi
            ;;
        "compile-only")
            log "INFO" "🏗️ Compiling only (for error checking)..."
            mvn clean compile -e -T "$MAVEN_PARALLEL" -B 2>&1
            ;;
    esac
    
    return $?
}

# Find the JAR file more efficiently
find_jar_file() {
    find_command "find" \
        "JAR_FILE=\$(find target -name \"*.jar\" | grep -v \"original\" | head -n 1)" \
        "JAR_FILE=\$(dir /s /b target\\*.jar | findstr /v \"original\" | head -n 1 | tr '\\\\' '/')"
    echo "$JAR_FILE"
}

# Verify JAR file integrity
verify_jar() {
    local jar_file=$1
    log "INFO" "🔍 Verifying JAR file integrity..."
    
    if ! jar -tf "$jar_file" > /dev/null 2>&1; then
        log "ERROR" "JAR file verification failed - file may be corrupted"
        return 1
    fi
    
    # Check for plugin.yml in the JAR
    if ! jar -tf "$jar_file" | grep -q "plugin.yml"; then
        log "WARNING" "JAR file may be missing plugin.yml"
    fi
    
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

# Collect file contents for AI fix more efficiently
collect_file_contents() {
    local first=true
    local file_data=""

    find_command "find" \
        "FILE_LIST=\$(find . -type f \\( -name \"*.java\" -o -name \"pom.xml\" -o -name \"plugin.yml\" -o -name \"config.yml\" \\) -not -path \"./target/*\" 2>/dev/null)" \
        "FILE_LIST=\$(dir /s /b *.java *.xml *.yml | findstr /v /i target)"

    for file in $FILE_LIST; do
        # Skip target directory files
        [[ "$file" == *"target/"* ]] && continue

        if [ "$first" = true ]; then
            first=false
        else
            file_data+=","
        fi

        # Get relative path
        find_command "realpath" \
            "REL_PATH=\$(realpath --relative-to=\".\" \"$file\")" \
            "REL_PATH=\"$file\""

        file_data+="\"$REL_PATH\": $(jq -Rs . < "$file")"
    done

    echo "$file_data"
}

# Analyze build errors to give better feedback
analyze_build_errors() {
    local build_output=$1
    log "INFO" "🔎 Analyzing build errors..."
    
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
            echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
            exit 0
        else
            log "ERROR" "JAR verification failed for $JAR_FILE"
            echo "{\"success\":false,\"error\":\"JAR verification failed\",\"jarPath\":\"$JAR_FILE\"}" > "$PLUGIN_DIR/build_result.json"
            exit 1
        fi
    else
        log "WARNING" "⚠️ Plugin JAR file not found in target directory."
        echo "{\"success\":false,\"error\":\"JAR file not found\"}" > "$PLUGIN_DIR/build_result.json"
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
        
        # Analyze errors to provide better feedback
        analyze_build_errors "$BUILD_ERRORS"

        log "INFO" "🔍 Packaging build errors for analysis..."

        # Prepare the JSON payload with errors and file contents
        TEMP_JSON_FILE=$(mktemp)
        echo "{" > "$TEMP_JSON_FILE"
        echo "  \"buildErrors\": $(jq -Rs . <<< "$BUILD_ERRORS")," >> "$TEMP_JSON_FILE"
        echo "  \"files\": {" >> "$TEMP_JSON_FILE"
        collect_file_contents >> "$TEMP_JSON_FILE"
        echo "  }" >> "$TEMP_JSON_FILE"
        echo "}" >> "$TEMP_JSON_FILE"

        log "INFO" "🔄 Sending build errors to API for fixing (this may take a few minutes)..."
        
        # Make API request to fix issues with progress indicator
        log "INFO" "Waiting for API response..."
        (curl -s --connect-timeout 30 --max-time "$API_TIMEOUT" -X POST "$API_URL_FIX" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d @"$TEMP_JSON_FILE" > "${TEMP_JSON_FILE}.response") &
        CURL_PID=$!
        
        # Show spinner if not in verbose mode
        if ! $VERBOSE; then
            spinner $CURL_PID
        else
            wait $CURL_PID
        fi
        
        FIX_RESPONSE=$(cat "${TEMP_JSON_FILE}.response")
        rm -f "${TEMP_JSON_FILE}.response"

        # Validate fix API response
        if ! echo "$FIX_RESPONSE" | jq -e '.status == "success"' > /dev/null 2>&1; then
            ERROR_MSG=$(echo "$FIX_RESPONSE" | jq -r '.message // "Unknown error"')
            log "ERROR" "❌ Error from fix API: $ERROR_MSG"
            log "INFO" "Continuing with next fix attempt..."
            rm -f "$TEMP_JSON_FILE"
            continue
        fi

        log "SUCCESS" "✅ Received fixes from API!"

        # Extract the fixed files
        FIXED_FILES=$(echo "$FIX_RESPONSE" | jq '.data')
        
        # Count how many files were fixed
        FIXED_COUNT=$(echo "$FIXED_FILES" | jq 'length')
        log "INFO" "Received fixes for $FIXED_COUNT file(s)"

        # Process each fixed file
        for FILE_PATH in $(echo "$FIXED_FILES" | jq -r 'keys[]'); do
            # Create directory if it doesn't exist
            mkdir -p "$(dirname "$FILE_PATH")"
            
            # Write content directly to file
            echo "$FIXED_FILES" | jq -r --arg path "$FILE_PATH" '.[$path]' > "$FILE_PATH"
            log "INFO" "🔧 Updated: $FILE_PATH"
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
                    echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"fixes\":$AI_FIX_ATTEMPTS,\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
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
            fi
        fi

        # Clean up temp file for this attempt
        rm -f "$TEMP_JSON_FILE"
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

            find_command "find" \
                "JAR_FILE=\$(find target -name \"*.jar\" | head -n 1)" \
                "JAR_FILE=\$(dir /s /b target\\*.jar | head -n 1 | tr '\\\\' '/')"

            if [ -n "$JAR_FILE" ]; then
                # Verify JAR integrity
                if verify_jar "$JAR_FILE"; then
                    log "SUCCESS" "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                    log "WARNING" "Note: This JAR may not include all dependencies."
                    echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"noShade\":true,\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
                else
                    log "ERROR" "JAR verification failed for $JAR_FILE"
                    echo "{\"success\":false,\"error\":\"JAR verification failed\",\"jarPath\":\"$JAR_FILE\"}" > "$PLUGIN_DIR/build_result.json"
                fi
            else
                log "ERROR" "No JAR file created even with shade skipping"
                echo "{\"success\":false,\"error\":\"No JAR file created even with shade skipping\"}" > "$PLUGIN_DIR/build_result.json"
            fi
        else
            log "ERROR" "----------------------------------------"
            log "ERROR" "❌ Maven build failed with all approaches."
            log "ERROR" "Common issues to check:"
            log "ERROR" "1. Incorrect plugin dependencies"
            log "ERROR" "2. Maven Shade Plugin configuration issues"
            log "ERROR" "3. Java version compatibility problems"
            log "ERROR" "4. File permission issues in the target directory"
            log "ERROR" "----------------------------------------"
            echo "{\"success\":false,\"error\":\"All build attempts failed\",\"buildErrors\":$(jq -Rs . <<< "$BUILD_ERRORS"),\"buildLog\":\"$LOG_FILE\"}" > "$PLUGIN_DIR/build_result.json"
            exit 1
        fi
    fi
fi

# Return to original directory
cd "$CURRENT_DIR"

log "SUCCESS" "----------------------------------------"
log "SUCCESS" "✨ Process completed"
log "SUCCESS" "----------------------------------------"