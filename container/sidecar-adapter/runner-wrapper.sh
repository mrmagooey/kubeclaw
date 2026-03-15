#!/bin/sh
# Runner wrapper script for user container
# This script is mounted into the user container via ConfigMap
# It watches /workspace/input/ for task files, runs the user command, and writes results

set -e

INPUT_DIR="${NANOCLAW_INPUT_DIR:-/workspace/input}"
OUTPUT_DIR="${NANOCLAW_OUTPUT_DIR:-/workspace/output}"
POLL_INTERVAL="${NANOCLAW_POLL_INTERVAL:-1}"

log() {
    echo "[runner-wrapper] $*" >&2
}

log "Runner wrapper starting..."
log "Input dir: $INPUT_DIR"
log "Output dir: $OUTPUT_DIR"
log "Poll interval: ${POLL_INTERVAL}s"

# Ensure directories exist
mkdir -p "$INPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Function to process a task file
process_task() {
    local task_file="$1"
    log "Processing task: $task_file"

    # Read the prompt from the task file
    local prompt
    prompt=$(cat "$task_file" | jq -r '.prompt // empty')

    if [ -z "$prompt" ]; then
        log "No prompt found in task file"
        write_error "No prompt in task file"
        return 1
    fi

    log "Running user command with prompt: ${prompt:0:100}..."

    # Run the user's command with the prompt
    # User command is passed via environment variable NANOCLAW_USER_COMMAND
    if [ -n "$NANOCLAW_USER_COMMAND" ]; then
        # Execute the user command and capture output
        local result
        if result=$(eval "$NANOCLAW_USER_COMMAND" <<< "$prompt" 2>&1); then
            log "Command executed successfully"
            write_output "$result"
        else
            log "Command failed: $result"
            write_error "$result"
        fi
    else
        # Default: echo the prompt back
        log "No NANOCLAW_USER_COMMAND set, echoing prompt"
        write_output "$prompt"
    fi
}

# Function to write output
write_output() {
    local result="$1"
    log "Writing output (${#result} chars)"

    cat > "$OUTPUT_DIR/result.json" << EOF
{
    "status": "success",
    "result": $(echo "$result" | jq -Rs '.')
}
EOF
}

# Function to write error
write_error() {
    local error="$1"
    log "Writing error: $error"

    cat > "$OUTPUT_DIR/result.json" << EOF
{
    "status": "error",
    "error": $(echo "$error" | jq -Rs '.')
}
EOF
}

# Main loop
log "Starting main loop..."
while true; do
    # Check for task files
    for task_file in "$INPUT_DIR"/task*.json; do
        if [ -f "$task_file" ]; then
            process_task "$task_file"

            # Remove processed task file
            rm -f "$task_file"

            # Wait a bit before checking for more
            sleep "$POLL_INTERVAL"
        fi
    done

    # Sleep before next poll
    sleep "$POLL_INTERVAL"
done
