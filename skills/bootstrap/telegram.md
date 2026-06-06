---
bootstrap:
  channelType: telegram
  manifestVersion: "1"
  expectedQuestions:
    - "What is the Telegram bot token from @BotFather?"
---

# Bootstrap: Telegram Channel

You are setting up a Telegram channel for KubeClaw. Follow these steps exactly.

## Step 1: Install npm packages

Run the following command to install the Telegram channel packages from the manifest:

```
local_bash("cp /workspace/manifests/telegram/package.json /workspace/manifests/telegram/package-lock.json /runtime/ && cd /runtime && npm ci --omit=dev --ignore-scripts 2>&1")
```

If this fails, report the full error to the admin and stop.

## Step 2: Gather credentials

Ask the admin: "Please provide your Telegram bot token (from @BotFather). It looks like: 1234567890:ABCDefghIJKlmnOPQRstu-VWXYZabcdefg"

Wait for the admin to reply with the token.

## Step 3: Validate the token

Once you have the token, validate it against the Telegram API:

```
local_bash("curl -s https://api.telegram.org/bot${TOKEN}/getMe")
```

(Replace ${TOKEN} with the actual token the admin provided.)

Check that the response contains `"ok":true`. If it does not, tell the admin the token appears invalid and ask them to check it. Do not proceed until validation succeeds.

## Step 4: Compute lock hash

Compute the sha256 hash of the installed package-lock.json (advisory — the orchestrator independently verifies):

```
local_bash("node -e \"const{createHash}=require('crypto'),{readFileSync}=require('fs');const lock=readFileSync('/runtime/package-lock.json','utf-8');const pkg=readFileSync('/runtime/package.json','utf-8');console.log(createHash('sha256').update(pkg+'\\n'+lock).digest('hex'))\"")
```

Save the hash output.

## Step 5: Hand off to orchestrator

Call `commit_channel_config` with:
- `channel_type`: "telegram"
- `instance_name`: the instance name provided to you in the context
- `secret_data`: `{"TELEGRAM_BOT_TOKEN": "<the bot token from step 2>"}`
- `runtime_pvc_lock_hash`: the hash from step 4

The orchestrator will create the steady-state channel Deployment. You will receive a confirmation message.
