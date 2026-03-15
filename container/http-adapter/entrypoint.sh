#!/bin/sh
# Entrypoint for NanoClaw HTTP Adapter
# Reads JSON from stdin and passes to the adapter

# Optional: Read from file if INPUT_FILE is set
if [ -n "$INPUT_FILE" ] && [ -f "$INPUT_FILE" ]; then
    cat "$INPUT_FILE" | node /app/dist/index.js
else
    # Read from stdin (default)
    node /app/dist/index.js
fi
