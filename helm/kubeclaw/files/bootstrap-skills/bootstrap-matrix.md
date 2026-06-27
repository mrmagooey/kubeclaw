---
bootstrap:
  channelType: matrix
  manifestVersion: "1"
  expectedQuestions:
    - "What is your Matrix homeserver URL?"
    - "What is your Matrix user ID?"
    - "What is your Matrix access token?"
---

# Bootstrap: Matrix Channel

You are setting up a Matrix channel for KubeClaw. Follow these steps exactly.

**IMPORTANT — Unencrypted rooms only (v1):** This adapter connects to Matrix using
plain `/sync` without end-to-end encryption. Only use it with rooms that do NOT have
end-to-end encryption enabled. Encrypted rooms (rooms with the padlock icon in Element)
will not work — the bot will see encrypted event payloads it cannot decrypt.

## How to obtain a Matrix access token

You can obtain a long-lived access token from any Matrix client:

**Via Element Web / Desktop:**
1. Log in as the bot account.
2. Go to **Settings → Help & About → Advanced**.
3. Click **Access Token** — copy the value.

**Via curl (server-side — useful for automation):**
```
curl -XPOST -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"@botname:server","password":"secret"}' \
  https://your-homeserver/_matrix/client/v3/login
```
The `access_token` field in the JSON response is what you need.

**Note:** Access tokens do not expire unless the user explicitly logs out.
Store it in the KubeClaw secret as `MATRIX_ACCESS_TOKEN`.

## Step 1: Install npm packages

Run the following command to install the Matrix channel packages from the manifest:

```
local_bash("cp /workspace/manifests/matrix/package.json /workspace/manifests/matrix/package-lock.json /runtime/ && cd /runtime && npm ci --omit=dev --ignore-scripts 2>&1")
```

If this fails, report the full error to the admin and stop.

## Step 2: Gather credentials

Ask the admin:

1. "What is your Matrix homeserver URL? (e.g. `https://matrix.org` or `https://matrix.yourdomain.com`)"

   Wait for the reply. Confirm it starts with `https://`.

2. "What is your Matrix user ID? It should look like `@botname:homeserver.com`."

   Wait for the reply. Confirm it matches the pattern `@name:server`.

3. "What is your Matrix access token? (See the instructions above for how to obtain it.)"

   Wait for the reply.

## Step 3: Validate the credentials

Validate by calling the whoami endpoint with the access token:

```
local_bash("curl -s -H 'Authorization: Bearer ${ACCESS_TOKEN}' ${HOMESERVER_URL}/_matrix/client/v3/account/whoami")
```

(Replace `${ACCESS_TOKEN}` and `${HOMESERVER_URL}` with the values provided.)

Check that the response contains a `user_id` field matching the user ID provided by the
admin, and does NOT contain `"errcode"`. If validation fails, tell the admin and ask them
to verify the homeserver URL and access token. Do not proceed until validation succeeds.

## Step 4: Remind operator about unencrypted rooms

Instruct the admin:

> **IMPORTANT**: This Matrix channel adapter runs in **unencrypted v1 mode**.
>
> - Only add rooms that do NOT have end-to-end encryption enabled.
> - In Element, unencrypted rooms show a grey (unlocked) padlock icon.
> - Encrypted rooms (green padlock) will NOT work — the bot cannot decrypt messages.
> - Create new unencrypted rooms or use existing ones without E2EE.
>
> To create an unencrypted room in Element:
> 1. Click + next to Rooms.
> 2. In the creation dialog, **do NOT enable** "Enable end-to-end encryption".
> 3. Use that room's internal ID (visible in Settings → Advanced) as the KubeClaw group.

Ask the admin to confirm they understand before continuing.

## Step 5: Compute lock hash

Compute the sha256 hash of the installed package-lock.json (advisory — the orchestrator independently verifies):

```
local_bash("node -e \"const{createHash}=require('crypto'),{readFileSync}=require('fs');const lock=readFileSync('/runtime/package-lock.json','utf-8');const pkg=readFileSync('/runtime/package.json','utf-8');console.log(createHash('sha256').update(pkg+'\\n'+lock).digest('hex'))\"")
```

Save the hash output.

## Step 6: Hand off to orchestrator

Call `commit_channel_config` with:
- `channel_type`: "matrix"
- `instance_name`: the instance name provided to you in the context
- `secret_data`: `{"MATRIX_HOMESERVER_URL": "<homeserver URL>", "MATRIX_USER_ID": "<user ID>", "MATRIX_ACCESS_TOKEN": "<access token>"}`
- `runtime_pvc_lock_hash`: the hash from step 5

The orchestrator will create the steady-state channel Deployment. You will receive a confirmation message.
