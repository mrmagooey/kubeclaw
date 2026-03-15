#!/bin/sh
# NanoClaw Runner Wrapper Script
# 
# This script runs inside the user container and provides the interface
# between the file-based IPC and the user's application.
#
# It watches /workspace/input/ for task files, invokes the user's command,
# and writes results to /workspace/output/result.json
#
# Environment variables:
#   NANOCLAW_INPUT_DIR    - Input directory (default: /workspace/input)
#   NANOCLAW_OUTPUT_DIR   - Output directory (default: /workspace/output)
#   NANOCLAW_POLL_INTERVAL - Poll interval in seconds (default: 1)
#   NANOCLAW_USER_COMMAND - User command to run (optional)

set -e

# Configuration
INPUT_DIR="${NANOCLAW_INPUT_DIR:-/workspace/input}"
OUTPUT_DIR="${NANOCLAW_OUTPUT_DIR:-/workspace/output}"
POLL_INTERVAL="${NANOCLAW_POLL_INTERVAL:-1}"

# Ensure directories exist
mkdir -p "$INPUT_DIR" "$OUTPUT_DIR"

log() {
    echo "[runner-wrapper] $1" >&2
}

log "Starting runner wrapper..."
log "Input dir: $INPUT_DIR"
log "Output dir: $OUTPUT_DIR"
log "Poll interval: ${POLL_INTERVAL}s"

# Function to process a task file
process_task() {
    local task_file="$1"
    local task_num="$2"
    
    log "Processing task: $task_file (task #$task_num)"
    
    # Read task content
    local task_content
    task_content=$(cat "$task_file")
    
    # Extract prompt from task
    local prompt
    prompt=$(echo "$task_content" | grep -o '"prompt"[^}]*' | cut -d'"' -f4)
    
    log "Task prompt: ${prompt:0:100}..."
    
    # Run user command if specified, otherwise use default behavior
    local result
    local status="success"
    local error_msg=""
    
    if [ -n "$NANOCLAW_USER_COMMAND" ]; then
        # Run user's command with task as environment variable
        log "Running user command: $NANOCLAW_USER_COMMAND"
        
        # Export task data as environment variables
        export NANOCLAW_TASK_FILE="$task_file"
        export NANOCLAW_TASK_CONTENT="$task_content"
        export NANOCLAW_TASK_PROMPT="$prompt"
        
        # Run command and capture output
        if result=$(eval "$NANOCLAW_USER_COMMAND" 2>&1); then
            status="success"
        else
            status="error"
            error_msg="$result"
            result=""
        fi
    else
        # Default: echo the prompt back
        log "No user command specified, using echo behavior"
        result="Echo: $prompt"
    fi
    
    # Write result
    local result_file="$OUTPUT_DIR/result.json"
    
    if [ "$status" = "success" ]; then
        cat > "$result_file" << EOF
{
  "status": "success",
  "result": $(echo "$result" | jq -Rs '.'),
  "newSessionId": null
}
EOF
    else
        cat > "$result_file" << EOF
{
  "status": "error",
  "result": null,
  "error": $(echo "$error_msg" | jq -Rs '.')
}
EOF
    fi
    
    log "Wrote result to: $result_file"
}

# Main loop
task_counter=0
running=true

while [ "$running" = true ]; do
    # Check for task files (task.json, task_1.json, task_2.json, etc.)
    task_file=""
    
    if [ $task_counter -eq 0 ]; then
        # First task
        if [ -f "$INPUT_DIR/task.json" ]; then
            task_file="$INPUT_DIR/task.json"
        fi
    else
        # Follow-up task
        if [ -f "$INPUT_DIR/task_${task_counter}.json" ]; then
            task_file="$INPUT_DIR/task_${task_counter}.json"
        fi
    fi
    
    if [ -n "$task_file" ]; then
        process_task "$task_file" "$task_counter"
        task_counter=$((task_counter + 1))
        
        # For now, exit after processing one task
        # TODO: Support continuous processing with proper shutdown signal
        log "Task processed, exiting"
        exit 0
    fi
    
    # Sleep before next poll
    sleep "$POLL_INTERVAL"
done
