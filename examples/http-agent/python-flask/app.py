"""
Example NanoClaw HTTP Agent - Python Flask

A minimal agent that echoes back the prompt with some processing.
Implements the required /agent/health and /agent/task endpoints.
"""

import os
from flask import Flask, request, jsonify

app = Flask(__name__)

# Track sessions in memory (for demonstration)
sessions = {}


@app.route("/agent/health", methods=["GET"])
def health():
    """Health check endpoint. Return 200 when ready."""
    return jsonify({"status": "healthy"})


@app.route("/agent/task", methods=["POST"])
def task():
    """
    Execute a task.

    Expected request body:
    {
        "prompt": "user message",
        "sessionId": "optional",
        "context": {
            "groupFolder": "name",
            "chatJid": "jid",
            "isMain": false,
            "assistantName": "Andy"
        },
        "secrets": {"KEY": "value"}
    }
    """
    data = request.get_json()

    if not data or "prompt" not in data:
        return jsonify({"status": "error", "error": "Missing prompt"}), 400

    prompt = data["prompt"]
    session_id = data.get("sessionId")
    context = data.get("context", {})

    # Simple echo agent with context
    group = context.get("groupFolder", "unknown")
    assistant = context.get("assistantName", "Agent")

    result = f"[{assistant}] Received in group '{group}': {prompt}"

    # Track session
    if session_id:
        sessions[session_id] = sessions.get(session_id, 0) + 1
        result += f" (session message #{sessions[session_id]})"

    return jsonify({"status": "success", "result": result, "sessionId": session_id})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
