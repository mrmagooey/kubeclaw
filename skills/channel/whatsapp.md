---
name: whatsapp
description: WhatsApp channel via Baileys (QR code auth)
dependencies:
  - "@whiskeysockets/baileys"
  - qrcode
  - qrcode-terminal
env: []
---

# WhatsApp Channel

Connects to WhatsApp Web using the Baileys library. Authentication via QR code or pairing code.

## Setup

1. Start the channel pod — it will display a QR code in logs
2. Scan the QR code with WhatsApp on your phone (Linked Devices)
3. Credentials persist in `store/auth/creds.json`

## Configuration

No env vars required. Credentials are stored on the sessions PVC.

## Auth Methods

- **QR code (browser)**: default, displayed in pod logs
- **QR code (terminal)**: for kubectl exec sessions
- **Pairing code**: set `WHATSAPP_PHONE_NUMBER` to use phone number pairing instead

## JID Format

- `{number}@s.whatsapp.net` for direct messages
- `{number}-{timestamp}@g.us` for groups

## Notes

- Auto-reconnect on disconnect
- Supports voice message, image, and document attachments (with appropriate capability skills)
- Group sync discovers chat names from WhatsApp
