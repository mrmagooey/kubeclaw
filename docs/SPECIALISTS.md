# Specialist Agents

KubeClaw supports **specialist sub-agents** within a group — separate Claude instances that handle specific types of requests. Specialists are defined in an `agents.json` file in the group folder and are invoked when mentioned in messages using `@name` syntax.

## Quick Start

Create a file at `groups/{groupname}/agents.json`:

```json
{
  "specialists": [
    {
      "name": "Research",
      "prompt": "You are a research specialist. Focus on finding and analyzing information from authoritative sources."
    },
    {
      "name": "Writer",
      "prompt": "You are a writing specialist. Create clear, engaging content in various styles and formats.",
      "triggers": ["@Content", "@Author"]
    }
  ]
}
```

Then mention them in messages:

```
@Research find recent AI trends
@Writer polish this text: ...
@Content write a blog post about...
```

## How Specialists Work

### Message Flow

1. **Detection**: When a message arrives, the orchestrator scans it for `@SpecialistName` mentions
2. **Matching**: Each mentioned specialist is looked up in the `agents.json` file
3. **Routing**: Instead of running a single agent, the orchestrator spawns **one agent per mentioned specialist**
4. **Output**: Each specialist's response is sent back to the group separately
5. **Fallback**: If no specialists are mentioned, the main group agent runs instead

### Name Matching

Names are matched **case-insensitively**. These are equivalent:

```
@Research
@research
@RESEARCH
@rESeArCh
```

You can also define custom trigger aliases using the `triggers` field (see below).

## Configuration Format

### agents.json Structure

The file must contain a top-level `specialists` array with at least one entry:

```json
{
  "specialists": [
    {
      "name": "SpecialistName",
      "prompt": "Role and behavioral instructions for this specialist.",
      "triggers": ["@Alias1", "@Alias2"],
      "llmProvider": "claude",
      "containerConfig": {
        "timeout": 600000,
        "memoryLimit": "2Gi"
      },
      "memory": {
        "isolated": true
      },
      "claudemd": "Additional system prompt content."
    }
  ]
}
```

### Fields

#### Required

- **`name`** (string, non-empty)
  - Display name for the specialist
  - Used for `@mentions` in messages
  - Example: `"Research"`, `"CodeReview"`, `"Editor"`

- **`prompt`** (string, non-empty)
  - Complete system prompt for this specialist
  - Defines role, behavior, and constraints
  - Example: `"You are a code review specialist. Focus on security, performance, and maintainability."`

#### Optional

- **`triggers`** (array of strings)
  - Alternative names/aliases for this specialist
  - Useful for friendly shorthand or domain-specific naming
  - Matching is case-insensitive and strips leading `@` if present
  - Example: `["@CodeReviewer", "@QA", "@Security"]`
  - When mentioned: `@CodeReviewer`, `@qa`, `@SECURITY` all work

- **`llmProvider`** (string)
  - Override the default LLM provider for this specialist
  - Allowed values depend on your KubeClaw configuration (typically `"claude"`, `"openrouter"`, etc.)
  - When omitted, uses the group's default LLM provider
  - Useful for cost optimization (cheaper model for simple tasks) or capability specialization
  - Example: `"claude"` (use Claude Opus), or `"openrouter"` (use cost-effective alternative)

- **`containerConfig`** (object)
  - Partial overrides to the group's container configuration
  - Merged with group-level settings (specialist settings win on conflict)
  - See [ContainerConfig documentation](../src/types.ts#L90-L123) for all available options
  - Common use cases:
    - `timeout`: Increase for long-running analyses, or decrease to save resources
    - `memoryLimit`, `memoryRequest`: Request more memory for compute-intensive specialists
    - `cpuLimit`, `cpuRequest`: Allocate more CPU for parallel processing
  - Example:
    ```json
    "containerConfig": {
      "timeout": 900000,
      "memoryLimit": "4Gi",
      "cpuLimit": "2000m"
    }
    ```

- **`memory`** (object)
  - Controls whether this specialist has isolated conversational memory
  - Properties:
    - `isolated` (boolean): If `true`, specialist maintains its own separate session
  - Default: `false` (specialist shares group's memory)
  - When `isolated: true`:
    - Specialist gets its own session key: `groupfolder:specialistname`
    - First message to this specialist is fresh context (no group history)
    - Subsequent messages build specialist's own conversation thread
    - Useful for stateless specialists or separate conversations within a group
  - Example:
    ```json
    "memory": {
      "isolated": true
    }
    ```

- **`claudemd`** (string)
  - Extra system prompt content appended after the main `prompt`
  - Useful for dynamically generated instructions or complex formatting
  - Example:
    ```json
    "claudemd": "Current time: 2026-04-06\nAlways include timestamps in your analysis."
    ```

### Validation Rules

- `agents.json` must be valid JSON
- Top level must be an object with a `specialists` key
- `specialists` must be a non-empty array
- Each specialist entry must have non-empty `name` and `prompt` strings
- Optional fields are validated by type (ignored if wrong type, not an error)
- Invalid files log a warning but do not crash the orchestrator

## Complete Example

```json
{
  "specialists": [
    {
      "name": "Research",
      "prompt": "You are a research specialist. Your role is to find, analyze, and summarize information from authoritative sources. Be thorough and cite your sources. Always verify claims with multiple sources when possible.",
      "triggers": ["@Researcher", "@Analysis"],
      "containerConfig": {
        "timeout": 600000,
        "memoryLimit": "2Gi"
      }
    },
    {
      "name": "Writer",
      "prompt": "You are a writing specialist. Create clear, engaging, and well-structured content. Adapt tone and style to the audience. Proofread carefully.",
      "triggers": ["@Content", "@Copy", "@Author"],
      "memory": {
        "isolated": true
      }
    },
    {
      "name": "CodeReview",
      "prompt": "You are a code review specialist. Focus on security vulnerabilities, performance optimization, maintainability, and following best practices. Provide actionable feedback.",
      "llmProvider": "openrouter",
      "containerConfig": {
        "timeout": 300000,
        "memoryLimit": "1Gi"
      }
    },
    {
      "name": "QuestionAnswerer",
      "prompt": "Answer user questions concisely and accurately. If you don't know something, say so.",
      "memory": {
        "isolated": true
      },
      "claudemd": "Keep answers to 2-3 sentences unless the user asks for more detail."
    }
  ]
}
```

Usage in messages:

```
@Research what are the latest trends in quantum computing?
@Writer turn my notes into a formal report
@CodeReview check this SQL injection vulnerability: ...
@qa review the authentication logic in this code
```

## Session Isolation

By default, all specialists in a group share the same conversation memory (session). This allows follow-up context to flow between them.

When `memory.isolated: true`, a specialist gets its own session key and conversational thread:

```json
"memory": { "isolated": true }
```

**Shared memory (default):**
```
User: @Research find X
Research: Here's X...
User: Can you @Writer summarize that?
Writer: [sees Research's answer in context]
```

**Isolated memory:**
```
"memory": { "isolated": true }

User: @Research find X
Research: Here's X...
User: Can you @Writer summarize that?
Writer: [does NOT see Research's answer; fresh context]
```

Use isolation for:
- Stateless specialists (question answerers, formatters)
- Preventing context pollution in long conversations
- Specialized tasks that shouldn't inherit group history

## Execution Model

### Multiple Specialists in One Message

If a message mentions multiple specialists, they all run:

```
@Research analyze this @Writer summarize it
→ Both Research and Writer run (parallelized where possible)
→ Both responses sent to group
```

### Specialist vs. Main Agent

- **Specialists mentioned** → Only specialists run
- **No specialists mentioned** → Main group agent runs (or does nothing if no trigger)

Example: If a group has both specialists and a main agent prompt:

```json
{
  "specialists": [
    { "name": "Research", "prompt": "..." }
  ]
}
```

```
User: @Research find X            → Research runs only
User: general question            → Main agent runs (if group has trigger + isMain flag)
```

## Practical Use Cases

### Case 1: Multi-Role Team

A project management group with specialists:

```json
{
  "specialists": [
    {
      "name": "ProjectManager",
      "prompt": "Track project milestones and timelines. Summarize status on demand."
    },
    {
      "name": "DevLead",
      "prompt": "Review technical design. Provide architecture advice.",
      "triggers": ["@Tech", "@Architecture"]
    },
    {
      "name": "QALead",
      "prompt": "Define test plans and quality criteria. Review test coverage."
    }
  ]
}
```

Usage:
```
Team: @ProjectManager what's our blockers?
Team: @DevLead should we refactor the API?
Team: @QALead what's our test coverage target?
```

### Case 2: Cost Optimization with Different Models

```json
{
  "specialists": [
    {
      "name": "Expert",
      "prompt": "Solve complex problems with thorough analysis.",
      "llmProvider": "claude"
    },
    {
      "name": "Helper",
      "prompt": "Answer simple questions and format text quickly.",
      "llmProvider": "openrouter"
    }
  ]
}
```

Usage:
```
@Expert solve this algorithm problem
@Helper format this JSON
```

### Case 3: Isolated Q&A Bot

```json
{
  "specialists": [
    {
      "name": "FAQ",
      "prompt": "Answer questions concisely. Be friendly.",
      "memory": { "isolated": true }
    }
  ]
}
```

The FAQ specialist never sees previous group conversation — each question is fresh context. This prevents context window waste on long group histories.

## Troubleshooting

### Specialist Not Running

**Check these in order:**

1. **File exists and is valid**: Is `agents.json` in `groups/{groupname}/`? Test with `cat` or a JSON validator.
2. **Syntax**: Run `jq . groups/{groupname}/agents.json` to validate JSON.
3. **Structure**: Ensure `specialists` is a non-empty array with `name` and `prompt` fields.
4. **Mention syntax**: Must be `@ExactName` or `@triggeralias`, case-insensitive. Check logs for detection output.
5. **Permissions**: Ensure the orchestrator can read the file (`ls -la`).

**Example validation:**
```bash
# Check file exists
ls -la groups/mygroup/agents.json

# Validate JSON
jq empty groups/mygroup/agents.json

# Check if orchestrator sees it
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw | grep -i specialist
```

### Specialist Errors

Check orchestrator logs for parsing errors:

```bash
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=100 \
  | grep -E 'agents\.json|specialist|warn'
```

Common errors:
- `agents.json missing "specialists" array` → Add `"specialists": [ ... ]`
- `Specialist entry missing non-empty "name" string` → Each specialist needs `"name": "..."`
- `Failed to parse agents.json` → Check JSON syntax with `jq`

### Session Key Issues

If isolated memory isn't working:

1. Verify `"memory": { "isolated": true }` is present in specialist config
2. Check that specialist is actually running (verify container output)
3. Session isolation requires the specialist to be invoked; if another agent doesn't mention it, the specialist doesn't run

## Security Notes

- Specialists are defined per-group — they cannot access specialists from other groups
- Specialist prompts run with the same permissions as the group agent
- Container overrides (`containerConfig`) are validated like group config overrides
- File paths in `claudemd` are read-only and scoped to the group folder

## File Location

```
groups/
├── {groupname}/
│   ├── agents.json              ← Specialists for this group
│   ├── CLAUDE.md                ← Group memory (optional)
│   ├── logs/
│   └── attachments/
```

- Must be in the group's root folder
- Filename is exactly `agents.json` (lowercase, no variations)
- If absent, group has no specialists (main agent only)

## Integration with CLAUDE.md

Group memory (`CLAUDE.md`) and specialists work together:

- Both specialists and the main agent can read/update `CLAUDE.md`
- Specialists with `isolated: true` get separate session memory but still access shared `CLAUDE.md`
- Use `CLAUDE.md` for persistent group knowledge, session for conversational context

Example:
```
groups/mygroup/
├── CLAUDE.md (contains shared facts, team knowledge)
├── agents.json (defines specialists)
└── logs/
```

## Performance Considerations

- Each mentioned specialist spawns a separate agent job
- Multiple specialists in one message may run in parallel (depends on cluster capacity)
- Each specialist gets its own container with its own timeout and resource limits
- Use `containerConfig.timeout` to prevent specialists from blocking the group

Recommended timeout strategy:
```json
{
  "name": "QuickHelper",
  "prompt": "...",
  "containerConfig": {
    "timeout": 120000
  }
}
```

## See Also

- [CLAUDE.md](./CLAUDE.md) — Group memory documentation
- [REQUIREMENTS.md](./REQUIREMENTS.md) — Architecture overview
- [src/specialists.ts](../src/specialists.ts) — Implementation details
