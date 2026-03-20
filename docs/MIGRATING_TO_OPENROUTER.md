# Migrating to OpenRouter

This guide helps you switch from Claude to OpenRouter for specific groups or your entire KubeClaw installation.

## Overview

KubeClaw supports running different groups on different LLM providers. You can:

- Keep existing groups on Claude
- Register new groups with OpenRouter
- Switch existing groups to OpenRouter
- Run a mix of both providers

## What to Expect

### Behavioral Differences

| Aspect                    | Claude                             | OpenRouter                                              |
| ------------------------- | ---------------------------------- | ------------------------------------------------------- |
| **Response style**        | Concise, asks clarifying questions | Varies by model; GPT-4o tends to be more verbose        |
| **Tool usage**            | Smart about when to use tools      | Depends on model; some models tool-call more eagerly    |
| **Context understanding** | Excellent at maintaining context   | Varies; Claude 3.5 Sonnet on OpenRouter ≈ native Claude |
| **Error handling**        | Graceful degradation               | May require retry on provider errors                    |
| **Cost**                  | Anthropic API pricing              | Varies widely by model                                  |

### Cost Differences

Example costs per 1K tokens (approximate, check OpenRouter for current pricing):

| Model                              | Input | Output |
| ---------------------------------- | ----- | ------ |
| Claude 3.5 Sonnet (direct)         | $3    | $15    |
| Claude 3.5 Sonnet (via OpenRouter) | $3    | $15    |
| GPT-4o                             | $5    | $15    |
| GPT-4o Mini                        | $0.15 | $0.60  |
| Llama 3.1 70B                      | $0.90 | $0.90  |

**Note**: OpenRouter adds a small markup (typically 0-5%) on top of provider costs.

### Performance Differences

- **Latency**: GPT-4o Mini and Llama 3.1 8B are significantly faster than Claude
- **Quality**: Claude 3.5 Sonnet excels at complex reasoning and coding
- **Reliability**: Claude (direct) has fewer provider-related errors

## Prerequisites

1. **OpenRouter Account**: Sign up at https://openrouter.ai
2. **API Key**: Generate at https://openrouter.ai/keys
3. **Credits**: Add payment method at https://openrouter.ai/settings/credits

## Migration Steps

### Step 1: Configure OpenRouter

Add to your `.env` file:

```bash
# Required
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Optional: Choose a default model
OPENROUTER_MODEL=openai/gpt-4o

# Optional: Set as default provider for new groups
DEFAULT_LLM_PROVIDER=openrouter
```

### Step 2: Build OpenRouter Container

```bash
./container/build.sh openrouter
```

Or if using Docker directly:

```bash
docker build -t kubeclaw-agent:openrouter -f container/Dockerfile.openrouter .
```

### Step 3: Test the Setup

Run the test script to verify everything works:

```bash
./scripts/test-openrouter.sh
```

This will:

- Check the container image is built
- Test API connectivity
- Test a simple conversation
- Verify tool calling works

### Step 4: Migrate Groups

#### Option A: New Group with OpenRouter

From your main channel:

```
@Andy register this group with OpenRouter as the provider
```

Or specify the model:

```
@Andy add this group using OpenRouter with GPT-4o Mini
```

#### Option B: Switch Existing Group to OpenRouter

From the group's channel:

```
@Andy switch this group to use OpenRouter
```

Or from main channel:

```
@Andy switch the "Family Chat" group to use OpenRouter
```

**Note**: Session history is not preserved when switching providers. The group will start fresh.

#### Option C: Batch Migration

To migrate multiple groups at once, edit the database directly:

```bash
# List current groups
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups;"

# Update specific group to OpenRouter
sqlite3 store/messages.db "UPDATE registered_groups SET llm_provider = 'openrouter' WHERE folder = 'family-chat';"
```

Restart KubeClaw after database changes.

## Model Selection Strategy

### Recommended Models by Use Case

**General chat and quick responses:**

```
openai/gpt-4o-mini
```

- Very cheap
- Fast
- Good for simple queries

**Coding and technical tasks:**

```
anthropic/claude-3.5-sonnet
```

- Best-in-class for code
- Long context (200K tokens)
- Excellent reasoning

**Balanced performance/cost:**

```
openai/gpt-4o
```

- Good all-rounder
- Vision support
- Reliable tool calling

**Budget-conscious:**

```
meta-llama/llama-3.1-70b-instruct
```

- Open source
- Capable for most tasks
- Cheaper than GPT-4o

### Testing Different Models

You can temporarily test a model without changing the group configuration:

```bash
# Start with a specific model
OPENROUTER_MODEL=openai/gpt-4o-mini npm run dev
```

This only affects new containers spawned while this instance is running.

## Rollback Procedure

If you need to switch back to Claude:

### From a Group Channel

```
@Andy switch back to Claude
```

### From Main Channel

```
@Andy switch "Family Chat" back to Claude
```

### Manual Rollback (Database)

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET llm_provider = 'claude' WHERE folder = 'family-chat';"
```

### Complete Rollback (All Groups)

```bash
# Revert all groups to Claude
sqlite3 store/messages.db "UPDATE registered_groups SET llm_provider = 'claude';"

# Or remove the column override entirely
sqlite3 store/messages.db "UPDATE registered_groups SET llm_provider = NULL;"
```

### Rollback Environment

Remove or comment out OpenRouter configuration:

```bash
# .env
# OPENROUTER_API_KEY=...
# DEFAULT_LLM_PROVIDER=openrouter
```

## Monitoring and Validation

### Check Current Provider

From main channel:

```
@Andy which provider is this group using?
```

### Monitor Costs

1. **OpenRouter Dashboard**: https://openrouter.ai/settings/usage
2. **Container Logs**: Check `groups/{folder}/logs/container-*.log` for token usage
3. **SQLite Queries**:
   ```bash
   sqlite3 store/messages.db "SELECT name, folder, llm_provider FROM registered_groups;"
   ```

### Performance Monitoring

Watch for:

- **Latency**: Time to first response
- **Error rates**: 429 (rate limit), 402 (payment), 500 (provider errors)
- **Quality**: Appropriateness of responses

## Troubleshooting Migration Issues

### "Provider not found" Error

**Cause**: Group's `llmProvider` field has invalid value.

**Fix**:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET llm_provider = 'openrouter' WHERE folder = 'my-group';"
```

### Session Lost After Migration

**Expected**: Sessions don't transfer between providers.

**Solution**: The group starts fresh. Previous conversations are archived in `groups/{folder}/conversations/`.

### Different Response Quality

**Cause**: Model capabilities differ from Claude.

**Solution**: Try different models:

```
@Andy try using Claude 3.5 Sonnet via OpenRouter instead
```

### Rate Limiting

**Cause**: Too many requests to OpenRouter.

**Solution**:

1. Reduce `MAX_CONCURRENT_CONTAINERS`
2. Upgrade OpenRouter plan
3. Switch some groups back to Claude

### Container Image Issues

**Error**: `Error: No such image: kubeclaw-agent:openrouter`

**Fix**:

```bash
./container/build.sh openrouter
```

## Best Practices

### 1. Gradual Migration

Don't migrate all groups at once. Start with one or two test groups to validate the setup.

### 2. Keep Main on Claude (Initially)

Your main channel handles system tasks. Keep it on Claude for stability while testing OpenRouter on other groups.

### 3. Use Appropriate Models

Don't use expensive models for simple tasks. Match the model to the use case:

- Simple Q&A → GPT-4o Mini or Llama 3.1 8B
- Complex coding → Claude 3.5 Sonnet
- Image analysis → GPT-4o (vision-capable)

### 4. Monitor Costs

OpenRouter costs can vary significantly. Set up billing alerts at https://openrouter.ai/settings/credits

### 5. Hybrid Approach

It's perfectly fine to run a mix:

- Main channel: Claude (reliability)
- Development group: OpenRouter with Claude 3.5 Sonnet
- Family chat: OpenRouter with GPT-4o Mini (cost-effective)

## FAQ

**Q: Can I use the same group with both providers?**

A: No, each group uses one provider at a time. Switching clears the session.

**Q: Will my conversation history be lost?**

A: No, conversations are archived in `groups/{folder}/conversations/` regardless of provider. But the current session context is lost when switching.

**Q: Do all features work with OpenRouter?**

A: Most features work, but some Claude-specific features (like agent teams with subagents) may have limitations. Tool calling, MCP servers, and scheduled tasks all work.

**Q: Can I use custom fine-tuned models?**

A: Yes, if they're available on OpenRouter. Use the model ID format: `provider/model-name`.

**Q: Is my data shared with OpenRouter?**

A: Yes, OpenRouter processes requests according to their privacy policy. Review at https://openrouter.ai/privacy.

**Q: Can I migrate back to Claude later?**

A: Yes, you can switch at any time. See the rollback procedure above.

## Getting Help

If you encounter issues during migration:

1. Check container logs: `groups/{folder}/logs/`
2. Run the test script: `./scripts/test-openrouter.sh`
3. Enable debug logging: `LOG_LEVEL=debug npm run dev`
4. Join the Discord: https://discord.gg/VDdww8qS42
