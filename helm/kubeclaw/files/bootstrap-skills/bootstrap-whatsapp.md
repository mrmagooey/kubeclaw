---
bootstrap:
  channelType: whatsapp
  manifestVersion: '1'
  expectedQuestions:
    - 'What is your WhatsApp Business Cloud API access token?'
    - 'What is your Phone Number ID from Meta?'
    - 'What verify token would you like to use for the webhook?'
    - 'What is your App Secret from Meta App Settings?'
---

# Bootstrap: WhatsApp Channel

You are setting up a WhatsApp channel for KubeClaw using the Meta WhatsApp Business Cloud API. Follow these steps exactly.

## HTTPS / TLS Requirement

**IMPORTANT:** Meta requires that your webhook URL uses HTTPS. You MUST configure TLS for the Ingress resource of this channel. In your `values.yaml`, include an `ingress.tls` section for the whatsapp channel instance. Without HTTPS, Meta's webhook verification will fail.

Example `values.yaml` snippet:

```yaml
channels:
  my-whatsapp:
    type: whatsapp
    httpPort: 4080
    enabled: true
    ingress:
      enabled: true
      host: whatsapp.example.com
      tls:
        - secretName: whatsapp-tls
          hosts:
            - whatsapp.example.com
```

## Step 1: Install packages

The WhatsApp adapter uses NO npm packages (native fetch/http/crypto only). Run the install step to confirm the manifest is ready:

```
local_bash("cp /workspace/manifests/whatsapp/package.json /workspace/manifests/whatsapp/package-lock.json /runtime/ && cd /runtime && npm ci --omit=dev --ignore-scripts 2>&1")
```

If this fails, report the full error to the admin and stop.

## Step 2: Gather credentials

Ask the admin for the following four values from Meta's App Dashboard (https://developers.facebook.com/):

1. **Access Token** — the long-lived access token for your WhatsApp Business Account (System User token recommended). Looks like `EAAxxxxxxxx...`
2. **Phone Number ID** — the numeric ID for the registered phone number. Found under WhatsApp > API Setup.
3. **Verify Token** — a random secret string YOU choose; you will enter this in Meta's App Dashboard when registering the webhook. Can be any string (e.g. a random 32-char hex value).
4. **App Secret** — found under App Settings > Basic in the Meta App Dashboard. Used to verify webhook HMAC signatures.

Wait for the admin to reply with all four values.

## Step 3: Validate the access token

Once you have the credentials, validate the access token against the Graph API:

```
local_bash("curl -s 'https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}?access_token=${ACCESS_TOKEN}' 2>&1")
```

(Replace `${PHONE_NUMBER_ID}` and `${ACCESS_TOKEN}` with the values from step 2.)

Check that the response contains an `"id"` field and no `"error"` field. If validation fails, tell the admin the token or phone number ID appears invalid. Do not proceed until validation succeeds.

## Step 4: Compute manifest lock hash

Compute the sha256 hash of the installed manifests (advisory — the orchestrator independently verifies):

```
local_bash("node -e \"const{createHash}=require('crypto'),{readFileSync}=require('fs');const lock=readFileSync('/runtime/package-lock.json','utf-8');const pkg=readFileSync('/runtime/package.json','utf-8');console.log(createHash('sha256').update(pkg+'\\n'+lock).digest('hex'))\"")
```

Save the hash output.

## Step 5: Register the webhook in Meta App Dashboard

Tell the admin:

"After I create the channel, you will need to register the webhook in the Meta App Dashboard:

1. Go to your App → WhatsApp → Configuration
2. Click 'Edit' in the Webhook section
3. Set **Callback URL** to: `https://<your-domain>/webhook` (must use HTTPS)
4. Set **Verify Token** to the verify token you provided in step 2
5. Click Verify and Save
6. Subscribe to the **messages** webhook field

The channel must be deployed and accessible via HTTPS before Meta will accept the webhook registration."

## Step 6: Hand off to orchestrator

Call `commit_channel_config` with:

- `channel_type`: "whatsapp"
- `instance_name`: the instance name provided to you in the context
- `secret_data`: `{"WHATSAPP_ACCESS_TOKEN": "<token>", "WHATSAPP_PHONE_NUMBER_ID": "<phone-number-id>", "WHATSAPP_VERIFY_TOKEN": "<verify-token>", "WHATSAPP_APP_SECRET": "<app-secret>"}`
- `runtime_pvc_lock_hash`: the hash from step 4

The orchestrator will create the steady-state channel Deployment. You will receive a confirmation message.

Remind the admin to complete the webhook registration in Meta's App Dashboard (step 5) after the Deployment is ready and HTTPS is configured.
