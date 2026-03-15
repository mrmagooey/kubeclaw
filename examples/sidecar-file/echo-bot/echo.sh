#!/bin/sh
# Echo Bot - Simple example for file-based sidecar
#
# This script watches /workspace/input/ for task files,
# reads the prompt, and echoes it back to /workspace/output/result.json

set -e

INPUT_DIR="${NANOCLAW_INPUT_DIR:-/workspace/input}"
OUTPUT_DIR="${NANOCLAW_OUTPUT_DIR:-/workspace/output}"
POLL_INTERVAL="${NANOCLAW_POLL_INTERVAL:-1}"

mkdir -p "$INPUT_DIR" "$OUTPUT_DIR"

echo "[echo-bot] Starting echo bot..."
echo "[echo-bot] Input dir: $INPUT_DIR"
echo "[echo-bot] Output dir: $OUTPUT_DIR"
echo "[echo-bot] Poll interval: ${POLL_INTERVAL}s"

# Process a single task
process_task() {
    local task_file="$1"
    
    echo "[echo-bot] Processing task: $task_file"
    
    # Read and parse the task
    local task_content
    task_content=$(cat "$task_file")
    
    # Extract prompt using jq
    local prompt
    prompt=$(echo "$task_content" | jq -r '.prompt // "No prompt provided"')
    
    echo "[echo-bot] Received prompt: $prompt"
    
    # Create echo response
    local result="Echo: $prompt"
    
    # Write result
    local result_file="$OUTPUT_DIR/result.json"
    echo "[echo-bot] Writing result to: $result_file"
    
    cat > "$result_file" << EOF
{
  "status": "success",
  "result": $(echo "$result" | jq -Rs '.'),
  "newSessionId": null
}
EOF
    
    echo "[echo-bot] Task complete!"
}

# Main loop - look for task.json
while true; do
    task_file="$INPUT_DIR/task.json"
    
    if [ -f "$task_file" ]; then
        process_task "$task_file"
        # Exit after processing one task (file adapter handles one task per run)
        exit 0
    fi
    
    sleep "$POLL_INTERVAL"
done
