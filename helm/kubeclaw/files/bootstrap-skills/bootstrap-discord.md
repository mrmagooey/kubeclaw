---
bootstrap:
  channelType: discord
  manifestVersion: "1"
  expectedQuestions:
    - "What is your Discord bot token from the Developer Portal?"
---

# Bootstrap: Discord Channel

You are setting up a Discord channel for KubeClaw. Follow these steps exactly.

## Step 1: Install npm packages

Run the following command to install the Discord channel packages from the manifest:

```
local_bash("cp /workspace/manifests/discord/package.json /workspace/manifests/discord/package-lock.json /runtime/ && cd /runtime && npm ci --omit=dev --ignore-scripts 2>&1")
```

If this fails, report the full error to the admin and stop.

## Step 2: Gather credentials

Ask the admin: "Please provide your Discord bot token (from the Discord Developer Portal → Your Application → Bot → Token). It looks like: MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.EXAMPLE.abc123def456"

Wait for the admin to reply with the token.

## Step 3: Validate the token

Once you have the token, validate it against the Discord API:

```
local_bash("curl -s -H 'Authorization: Bot ${TOKEN}' https://discord.com/api/v10/users/@me")
```

(Replace ${TOKEN} with the actual token the admin provided.)

Check that the response contains `"id"` and `"username"` fields and does NOT contain `"message": "401: Unauthorized"`. If it does not validate, tell the admin the token appears invalid and ask them to check it. Do not proceed until validation succeeds.

## Step 4: Remind operator to enable MessageContent intent

Instruct the admin:

> **IMPORTANT**: The Discord MessageContent privileged intent MUST be enabled for the bot to receive message text in guild (server) channels.
>
> In the Discord Developer Portal:
> 1. Go to https://discord.com/developers/applications
> 2. Select your application
> 3. Click **Bot** in the left sidebar
> 4. Scroll to **Privileged Gateway Intents**
> 5. Toggle **Message Content Intent** to **ON**
> 6. Save changes
>
> Without this, the bot will receive empty messages in servers and log a warning.

Ask the admin to confirm they have enabled this intent before continuing.

## Step 5: Compute lock hash

Compute the sha256 hash of the installed package-lock.json (advisory — the orchestrator independently verifies):

```
local_bash("node -e \"const{createHash}=require('crypto'),{readFileSync}=require('fs');const lock=readFileSync('/runtime/package-lock.json','utf-8');const pkg=readFileSync('/runtime/package.json','utf-8');console.log(createHash('sha256').update(pkg+'\\n'+lock).digest('hex'))\"")
```

Save the hash output.

## Step 6: Hand off to orchestrator

Call `commit_channel_config` with:
- `channel_type`: "discord"
- `instance_name`: the instance name provided to you in the context
- `secret_data`: `{"DISCORD_BOT_TOKEN": "<the bot token from step 2>"}`
- `runtime_pvc_lock_hash`: the hash from step 5

The orchestrator will create the steady-state channel Deployment. You will receive a confirmation message.
