# OpenRouter Support for KubeClaw

KubeClaw supports dual LLM providers: **Claude** (Anthropic's Claude via Claude Code) and **OpenRouter** (unified API for multiple models).

## Overview

OpenRouter is a unified API gateway that provides access to hundreds of LLMs from different providers through a single OpenAI-compatible API. This allows you to:

- Use models like GPT-4, GPT-3.5, Claude, Llama, and many others
- Pay only for what you use with OpenRouter's unified billing
- Switch between models without changing code
- Access models that may be more cost-effective for your use case

## How OpenRouter Differs from Claude

| Aspect                 | Claude (Claude Code)                     | OpenRouter                          |
| ---------------------- | ---------------------------------------- | ----------------------------------- |
| **SDK**                | Claude Agent SDK                         | OpenAI SDK                          |
| **Architecture**       | Recursive agent loop with built-in tools | Manual conversation loop            |
| **Tool Calling**       | Built-in (Bash, Read, Write, Edit, etc.) | Via MCP (Model Context Protocol)    |
| **Cost Model**         | Anthropic API pricing                    | OpenRouter unified pricing          |
| **Model Selection**    | Claude models only                       | 100+ models from multiple providers |
| **Session Management** | Built-in session persistence             | Custom session tracking             |
| **Streaming**          | Partial message streaming                | Response streaming                  |

### Key Differences

1. **Tool Implementation**: Claude Code has built-in tools; OpenRouter uses MCP (Model Context Protocol) which provides the same tools but via a standardized interface

2. **Conversation Loop**: Claude Code handles the conversation loop internally; OpenRouter implementation manages the loop manually, calling the API and handling tool results explicitly

3. **Response Format**: Claude returns structured events; OpenRouter returns standard OpenAI chat completions format

4. **Session Management**: Claude SDK manages session IDs automatically; OpenRouter implementation tracks sessions manually via SQLite

## Configuration Options

### Environment Variables

Configure OpenRouter globally via your `.env` file:

```bash
# Required: Your OpenRouter API key
# Get one at: https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-...

# Optional: Default model (defaults to openai/gpt-4o)
OPENROUTER_MODEL=openai/gpt-4o

# Optional: Custom OpenRouter base URL
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Optional: HTTP referer header (identifies your app)
OPENROUTER_HTTP_REFERER=https://yourdomain.com

# Optional: App title (shown in OpenRouter dashboard)
OPENROUTER_X_TITLE=My KubeClaw Instance

# Optional: Container image for OpenRouter agents
OPENROUTER_CONTAINER_IMAGE=kubeclaw-agent:openrouter

# Optional: Default LLM provider for all groups
DEFAULT_LLM_PROVIDER=openrouter
```

### Per-Group Configuration

Each group can independently choose which provider to use. Set a group's provider when registering:

```typescript
// Via the register_group tool in conversation
{
  "jid": "1234567890@g.us",
  "name": "My Group",
  "folder": "my-group",
  "trigger": "@Andy",
  "llmProvider": "openrouter"
}
```

Or for new groups via natural language:

```
@Andy register this group and use OpenRouter instead of Claude
```

### Default Provider

If not specified, groups use the default provider (configured via `DEFAULT_LLM_PROVIDER` environment variable, defaults to `claude`).

Existing groups continue using their current provider when you upgrade KubeClaw.

## Model Selection Guide

OpenRouter supports 100+ models from various providers. Model IDs follow the format: `provider/model-name`.

### Recommended Models

| Model                 | ID                                  | Best For                               | Cost |
| --------------------- | ----------------------------------- | -------------------------------------- | ---- |
| **GPT-4o**            | `openai/gpt-4o`                     | General purpose, coding, complex tasks | $$$  |
| **GPT-4o Mini**       | `openai/gpt-4o-mini`                | Cost-effective, fast responses         | $    |
| **Claude 3.5 Sonnet** | `anthropic/claude-3.5-sonnet`       | Long context, nuanced reasoning        | $$$  |
| **Claude 3 Haiku**    | `anthropic/claude-3-haiku`          | Fast, cost-effective                   | $    |
| **Llama 3.1 70B**     | `meta-llama/llama-3.1-70b-instruct` | Open source, capable                   | $$   |
| **Llama 3.1 8B**      | `meta-llama/llama-3.1-8b-instruct`  | Fast, very cheap                       | $    |

### Finding Models

Browse all available models at: https://openrouter.ai/models

Filter by:

- **Provider**: OpenAI, Anthropic, Meta, Google, etc.
- **Capabilities**: Function calling, JSON mode, vision
- **Pricing**: Free, cheap, or premium
- **Context length**: Up to 2M tokens on some models

### Testing Models

Switch models temporarily for testing:

```bash
# Test with a cheaper model
OPENROUTER_MODEL=openai/gpt-4o-mini npm run dev
```

## Troubleshooting

### Common Issues

#### "401 Unauthorized" Error

**Cause**: Invalid or missing OpenRouter API key.

**Solution**:

1. Check that `OPENROUTER_API_KEY` is set in your `.env` file
2. Verify the key is valid at https://openrouter.ai/keys
3. Ensure the key has the correct format: `sk-or-v1-...`

#### "429 Rate Limit Exceeded" Error

**Cause**: Too many requests to OpenRouter API.

**Solution**:

1. Wait a moment and retry
2. Check your rate limits at https://openrouter.ai/settings
3. Consider upgrading your plan for higher limits
4. Reduce `MAX_CONCURRENT_CONTAINERS` to limit parallel requests

#### "402 Payment Required" Error

**Cause**: Insufficient credits in your OpenRouter account.

**Solution**:

1. Add credits at https://openrouter.ai/settings/credits
2. Check your usage and billing at https://openrouter.ai/settings/usage

#### "500 Internal Server Error" Error

**Cause**: OpenRouter or upstream provider experiencing issues.

**Solution**:

1. Check OpenRouter status at https://status.openrouter.ai
2. Try a different model temporarily
3. Wait and retry later

#### Model Returns Empty Responses

**Cause**: Some models don't support tool calling well.

**Solution**:

1. Switch to a model with better tool support (GPT-4o, Claude 3.5 Sonnet)
2. Check if the model supports function calling at https://openrouter.ai/models

#### Container Fails to Start

**Cause**: OpenRouter container image not built.

**Solution**:

```bash
# Build the OpenRouter container
./container/build.sh openrouter
```

### Network Timeouts

If requests are timing out:

1. Check your internet connection
2. Verify OpenRouter is accessible: `curl https://openrouter.ai/api/v1/models`
3. Consider increasing `CONTAINER_TIMEOUT` in your `.env`:
   ```bash
   CONTAINER_TIMEOUT=300000  # 5 minutes
   ```

### Invalid Model Names

OpenRouter will return an error if the model ID is invalid.

**Valid format**: `provider/model-name` (e.g., `openai/gpt-4o`)

**Invalid formats**:

- `gpt-4o` (missing provider)
- `openai/gpt-4` (wrong model name)
- `GPT-4O` (case sensitive)

### Debugging

Enable debug logging to see detailed OpenRouter communication:

```bash
LOG_LEVEL=debug npm run dev
```

This will log:

- API requests and responses
- Tool execution details
- Session management events
- Container spawn/exit events

### Getting Help

If you encounter issues not covered here:

1. Check the OpenRouter documentation: https://openrouter.ai/docs
2. Review container logs: `groups/{folder}/logs/container-*.log`
3. Run the test script: `./scripts/test-openrouter.sh`
4. Ask in the KubeClaw Discord: https://discord.gg/VDdww8qS42

## Performance Considerations

### Latency

Different models have different latencies. Generally:

- **Fastest**: Llama 3.1 8B, Claude 3 Haiku, GPT-4o Mini
- **Medium**: GPT-4o, Llama 3.1 70B
- **Slower**: Claude 3.5 Sonnet, GPT-4 Turbo

### Cost Optimization

1. **Use smaller models for simple tasks**:

   ```bash
   OPENROUTER_MODEL=openai/gpt-4o-mini
   ```

2. **Set budget limits**:

   ```bash
   # Coming soon: per-query budget limiting
   ```

3. **Monitor usage**:
   - Check OpenRouter dashboard for spending
   - Review container logs for token usage

### Concurrency

OpenRouter has rate limits. If you have many groups:

```bash
# Limit concurrent containers to avoid rate limiting
MAX_CONCURRENT_CONTAINERS=3
```

## Security Considerations

### API Key Storage

- Store `OPENROUTER_API_KEY` in `.env` (gitignored)
- Never commit the API key to version control
- Rotate keys regularly at https://openrouter.ai/keys

### Data Privacy

- OpenRouter processes your requests according to their privacy policy
- Review at: https://openrouter.ai/privacy
- Some models may have different data retention policies

### Container Isolation

OpenRouter agents run in the same isolated containers as Claude agents:

- Filesystem isolation
- Network restrictions
- Resource limits
- Secrets never mounted, passed via stdin only

## Migration Notes

See [MIGRATING_TO_OPENROUTER.md](./MIGRATING_TO_OPENROUTER.md) for detailed migration guidance.

## Advanced Configuration

### Custom Headers

Add custom headers to all OpenRouter requests:

```bash
# In .env
OPENROUTER_HTTP_REFERER=https://mycompany.com
OPENROUTER_X_TITLE=Company Bot
```

These headers help identify your usage in OpenRouter analytics.

### Provider Routing

OpenRouter automatically routes to the best available provider for your chosen model. You can sometimes force specific providers via model ID variants (check OpenRouter docs for availability).

### Fallback Models

The OpenRouter implementation currently doesn't support automatic fallback. To switch models, update `OPENROUTER_MODEL` and restart.

Future versions may support fallback chains like:

```bash
OPENROUTER_FALLBACK_MODELS=openai/gpt-4o,anthropic/claude-3.5-sonnet
```
