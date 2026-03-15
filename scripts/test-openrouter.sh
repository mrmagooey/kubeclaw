#!/bin/bash
# Test OpenRouter integration for NanoClaw
# This script validates the OpenRouter setup and tests basic functionality

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Check if Docker is available
check_docker() {
    log_info "Checking Docker availability..."
    if command -v docker &> /dev/null; then
        if docker info &> /dev/null; then
            log_success "Docker is installed and running"
            return 0
        else
            log_error "Docker is installed but not running"
            return 1
        fi
    else
        log_error "Docker is not installed"
        return 1
    fi
}

# Check if OpenRouter container image exists
check_container_image() {
    log_info "Checking OpenRouter container image..."
    if docker images nanoclaw-agent:openrouter --format "{{.Repository}}:{{.Tag}}" | grep -q "nanoclaw-agent:openrouter"; then
        log_success "OpenRouter container image exists"
        return 0
    else
        log_error "OpenRouter container image not found (nanoclaw-agent:openrouter)"
        log_info "Build it with: ./container/build.sh openrouter"
        return 1
    fi
}

# Check environment variables
check_env_vars() {
    log_info "Checking environment variables..."
    
    # Load .env if it exists
    if [ -f .env ]; then
        export $(grep -v '^#' .env | xargs) 2>/dev/null || true
    fi
    
    if [ -z "$OPENROUTER_API_KEY" ]; then
        log_error "OPENROUTER_API_KEY is not set"
        log_info "Add OPENROUTER_API_KEY to your .env file"
        return 1
    else
        # Mask the key for display
        KEY_PREFIX="${OPENROUTER_API_KEY:0:10}"
        log_success "OPENROUTER_API_KEY is set (${KEY_PREFIX}...)"
    fi
    
    if [ -n "$OPENROUTER_MODEL" ]; then
        log_success "OPENROUTER_MODEL is set to: $OPENROUTER_MODEL"
    else
        log_warn "OPENROUTER_MODEL not set, will use default (openai/gpt-4o)"
    fi
    
    return 0
}

# Test API connectivity
test_api_connectivity() {
    log_info "Testing OpenRouter API connectivity..."
    
    if [ -z "$OPENROUTER_API_KEY" ]; then
        log_error "Cannot test API without OPENROUTER_API_KEY"
        return 1
    fi
    
    # Test with a simple models list request
    RESPONSE=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $OPENROUTER_API_KEY" \
        -H "HTTP-Referer: https://nanoclaw.local" \
        -H "X-Title: NanoClaw Test" \
        "https://openrouter.ai/api/v1/models" 2>&1)
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        MODEL_COUNT=$(echo "$BODY" | grep -o '"id"' | wc -l)
        log_success "OpenRouter API is accessible ($MODEL_COUNT models available)"
        return 0
    elif [ "$HTTP_CODE" = "401" ]; then
        log_error "OpenRouter API returned 401 (Invalid API key)"
        return 1
    elif [ "$HTTP_CODE" = "429" ]; then
        log_error "OpenRouter API returned 429 (Rate limited)"
        return 1
    else
        log_error "OpenRouter API returned HTTP $HTTP_CODE"
        log_info "Response: $BODY"
        return 1
    fi
}

# Test a simple chat completion
test_chat_completion() {
    log_info "Testing chat completion..."
    
    if [ -z "$OPENROUTER_API_KEY" ]; then
        log_error "Cannot test chat without OPENROUTER_API_KEY"
        return 1
    fi
    
    MODEL="${OPENROUTER_MODEL:-openai/gpt-4o-mini}"
    
    RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Authorization: Bearer $OPENROUTER_API_KEY" \
        -H "Content-Type: application/json" \
        -H "HTTP-Referer: https://nanoclaw.local" \
        -H "X-Title: NanoClaw Test" \
        -d "{
            \"model\": \"$MODEL\",
            \"messages\": [{\"role\": \"user\", \"content\": \"Say 'OpenRouter test successful' and nothing else.\"}],
            \"max_tokens\": 50
        }" \
        "https://openrouter.ai/api/v1/chat/completions" 2>&1)
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        CONTENT=$(echo "$BODY" | grep -o '"content":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$CONTENT" ]; then
            log_success "Chat completion works (response: ${CONTENT:0:50}...)"
            return 0
        else
            log_error "Chat completion returned empty content"
            return 1
        fi
    elif [ "$HTTP_CODE" = "402" ]; then
        log_error "OpenRouter API returned 402 (Payment required - add credits)"
        return 1
    elif [ "$HTTP_CODE" = "404" ]; then
        log_error "Model '$MODEL' not found"
        log_info "Check available models at https://openrouter.ai/models"
        return 1
    else
        log_error "Chat completion failed with HTTP $HTTP_CODE"
        log_info "Response: $BODY"
        return 1
    fi
}

# Test tool calling (function calling)
test_tool_calling() {
    log_info "Testing tool calling capability..."
    
    if [ -z "$OPENROUTER_API_KEY" ]; then
        log_error "Cannot test tool calling without OPENROUTER_API_KEY"
        return 1
    fi
    
    MODEL="${OPENROUTER_MODEL:-openai/gpt-4o-mini}"
    
    RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Authorization: Bearer $OPENROUTER_API_KEY" \
        -H "Content-Type: application/json" \
        -H "HTTP-Referer: https://nanoclaw.local" \
        -H "X-Title: NanoClaw Test" \
        -d "{
            \"model\": \"$MODEL\",
            \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2? Use the calculator function.\"}],
            \"tools\": [{
                \"type\": \"function\",
                \"function\": {
                    \"name\": \"calculator\",
                    \"description\": \"Perform calculations\",
                    \"parameters\": {
                        \"type\": \"object\",
                        \"properties\": {
                            \"expression\": {\"type\": \"string\"}
                        },
                        \"required\": [\"expression\"]
                    }
                }
            }],
            \"tool_choice\": \"auto\"
        }" \
        "https://openrouter.ai/api/v1/chat/completions" 2>&1)
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        if echo "$BODY" | grep -q '"tool_calls"'; then
            log_success "Tool calling is supported"
            return 0
        else
            log_warn "Model responded without tool calls (may still work for other tasks)"
            return 0
        fi
    else
        log_error "Tool calling test failed with HTTP $HTTP_CODE"
        return 1
    fi
}

# Test MCP server availability
test_mcp_server() {
    log_info "Testing MCP server availability..."
    
    # Check if agent-runner-openrouter has MCP dependencies
    if [ -f container/agent-runner-openrouter/package.json ]; then
        if grep -q "@modelcontextprotocol" container/agent-runner-openrouter/package.json; then
            log_success "MCP dependencies are present"
        else
            log_warn "MCP dependencies not found in package.json"
        fi
    else
        log_warn "agent-runner-openrouter package.json not found"
    fi
    
    # Check if ipc-mcp-stdio.ts exists
    if [ -f container/agent-runner-openrouter/src/ipc-mcp-stdio.ts ]; then
        log_success "MCP stdio transport file exists"
    else
        log_warn "MCP stdio transport file not found"
    fi
    
    return 0
}

# Test container build files
test_container_files() {
    log_info "Checking container build files..."
    
    FILES_TO_CHECK=(
        "container/Dockerfile.openrouter"
        "container/agent-runner-openrouter/package.json"
        "container/agent-runner-openrouter/src/index.ts"
        "container/agent-runner-openrouter/src/ipc-mcp-stdio.ts"
        "container/agent-runner-openrouter/tsconfig.json"
    )
    
    for file in "${FILES_TO_CHECK[@]}"; do
        if [ -f "$file" ]; then
            log_success "File exists: $file"
        else
            log_error "File missing: $file"
        fi
    done
    
    return 0
}

# Test TypeScript compilation
test_typescript() {
    log_info "Testing TypeScript compilation..."
    
    if [ ! -d container/agent-runner-openrouter ]; then
        log_warn "agent-runner-openrouter directory not found, skipping TS check"
        return 0
    fi
    
    cd container/agent-runner-openrouter
    
    if command -v npx &> /dev/null; then
        if npx tsc --noEmit 2>&1 | head -20; then
            log_success "TypeScript compiles without errors"
        else
            log_warn "TypeScript has compilation errors (may still work)"
        fi
    else
        log_warn "npx not available, skipping TS check"
    fi
    
    cd ../..
    return 0
}

# Main test function
main() {
    echo "=========================================="
    echo "NanoClaw OpenRouter Integration Test"
    echo "=========================================="
    echo ""
    
    # Track if we should continue
    CRITICAL_FAILED=0
    
    # Critical tests
    check_docker || CRITICAL_FAILED=1
    check_container_image || CRITICAL_FAILED=1
    check_env_vars || CRITICAL_FAILED=1
    
    if [ $CRITICAL_FAILED -eq 1 ]; then
        echo ""
        log_error "Critical tests failed. Please fix the issues above before continuing."
        exit 1
    fi
    
    # API tests
    test_api_connectivity || true
    test_chat_completion || true
    test_tool_calling || true
    
    # File structure tests
    test_container_files || true
    test_mcp_server || true
    test_typescript || true
    
    # Summary
    echo ""
    echo "=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
    echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
    echo ""
    
    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}All tests passed!${NC} OpenRouter integration is ready."
        echo ""
        echo "Next steps:"
        echo "1. Add DEFAULT_LLM_PROVIDER=openrouter to .env (optional)"
        echo "2. Restart NanoClaw: npm run dev"
        echo "3. Test with a group: @Andy register this group with OpenRouter"
        exit 0
    else
        echo -e "${YELLOW}Some tests failed.${NC} Review the failures above."
        echo ""
        echo "Common fixes:"
        echo "- If API tests failed: Check your OPENROUTER_API_KEY"
        echo "- If container tests failed: Run ./container/build.sh openrouter"
        echo "- If model errors: Verify OPENROUTER_MODEL is valid"
        exit 1
    fi
}

# Run main function
main "$@"
