# Sendblue OpenClaw Plugin

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that connects to [Sendblue](https://sendblue.com/) for iMessage integration — with **typing indicators**, **read receipts**, and **HEIC image conversion**.

## Features

- 💬 **Send & receive iMessages** via Sendblue's REST API
- ⌨️ **Typing indicators** — shows the "..." bubble while the AI is thinking
- ✅ **Read receipts** — marks conversations as read immediately on inbound
- 🖼️ **HEIC → JPEG conversion** — auto-converts Apple HEIC photos for agent processing
- 🔒 **Allowlist-based access control** — restrict who can message the bot
- 🔗 **Webhook-based inbound** — real-time message delivery via Sendblue webhooks
- 📦 **Native OpenClaw plugin** — uses the official plugin SDK, routes through the dispatcher

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A [Sendblue](https://sendblue.com/) account with API credentials
- A publicly accessible URL for webhooks (e.g., ngrok, Cloudflare Tunnel)
- Python 3 with `pillow` and `pillow-heif` (for HEIC conversion)

### Install HEIC dependencies

```bash
# Ubuntu/Debian
apt-get install -y libheif-examples python3-pip
pip3 install pillow pillow-heif

# macOS
brew install libheif
pip3 install pillow pillow-heif
```

## Installation

### Option 1: OpenClaw plugins install (recommended)

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/sendblue-openclaw-plugin.git

# Install as OpenClaw plugin
openclaw plugins install ./sendblue-openclaw-plugin
```

### Option 2: Manual extension install

```bash
# Copy to extensions directory
cp -r sendblue-openclaw-plugin ~/.openclaw/extensions/sendblue

# Or add to config load paths
```

Then add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json5
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["~/.openclaw/extensions/sendblue"]
    },
    "entries": {
      "sendblue": {
        "enabled": true
      }
    }
  }
}
```

## Configuration

Add the following to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json5
{
  "channels": {
    "sendblue": {
      "enabled": true,
      "apiKey": "YOUR_SENDBLUE_API_KEY",
      "apiSecret": "YOUR_SENDBLUE_API_SECRET",
      "fromNumber": "+1XXXXXXXXXX",       // Your Sendblue line number (E.164)
      "allowFrom": ["+1YYYYYYYYYY"],      // Allowed phone numbers (E.164)
      "webhookPath": "/webhooks/sendblue", // Webhook endpoint path
      "webhookSecret": "",                 // Optional: verify webhook requests
      "sendReadReceipts": true,            // Send read receipts on inbound (default: true)
      "sendTypingIndicators": true,        // Show typing bubble while AI thinks (default: true)
      "typingIntervalMs": 50000,           // Re-fire typing every N ms (default: 50000)
      "textChunkLimit": 4000,              // Max chars per outbound message (default: 4000)
      "dmPolicy": "allowlist"              // "allowlist" or "open" (default: "allowlist")
    }
  }
}
```

## Webhook Setup

### 1. Expose your gateway

Use ngrok, Cloudflare Tunnel, or any reverse proxy to make your OpenClaw gateway publicly accessible:

```bash
ngrok http 18789
```

### 2. Register webhooks with Sendblue

```bash
# Register inbound message webhook
curl -X POST 'https://api.sendblue.co/api/account/webhooks' \
  -H 'sb-api-key-id: YOUR_API_KEY' \
  -H 'sb-api-secret-key: YOUR_API_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{
    "webhooks": ["https://YOUR_TUNNEL_URL/webhooks/sendblue"],
    "type": "receive"
  }'

# Register outbound status webhook (optional)
curl -X POST 'https://api.sendblue.co/api/account/webhooks' \
  -H 'sb-api-key-id: YOUR_API_KEY' \
  -H 'sb-api-secret-key: YOUR_API_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{
    "webhooks": ["https://YOUR_TUNNEL_URL/webhooks/sendblue"],
    "type": "outbound"
  }'
```

### 3. Send an initial message

Sendblue requires an existing conversation before typing indicators work:

```bash
curl -X POST 'https://api.sendblue.co/api/send-message' \
  -H 'sb-api-key-id: YOUR_API_KEY' \
  -H 'sb-api-secret-key: YOUR_API_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{
    "number": "+1YYYYYYYYYY",
    "content": "Hello from OpenClaw!",
    "from_number": "+1XXXXXXXXXX"
  }'
```

### 4. Restart the gateway

```bash
openclaw gateway restart
```

## How It Works

### Message Flow

```
iPhone → iMessage → Sendblue Cloud → Webhook POST → OpenClaw Gateway → Agent
                                                                          ↓
iPhone ← iMessage ← Sendblue API  ← Send Message  ← OpenClaw Gateway ← Agent
```

### Typing Indicators

1. Inbound message received via webhook
2. **Read receipt** sent immediately (`POST /api/mark-read`)
3. **Typing indicator** fired (`POST /api/send-typing-indicator`)
4. Typing re-fires every ~50 seconds (iMessage typing bubbles expire after ~60s)
5. Agent processes and generates response
6. Typing loop stops, message sent

### HEIC Conversion

When a photo is received:
1. Plugin checks if the media URL points to a HEIC/HEIF file
2. Downloads and converts to JPEG using `pillow-heif`
3. Passes the converted local path to the agent for processing
4. Non-HEIC files are passed through as-is

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the Sendblue channel |
| `apiKey` | string | — | Sendblue API key (`sb-api-key-id`) |
| `apiSecret` | string | — | Sendblue API secret (`sb-api-secret-key`) |
| `fromNumber` | string | — | Your Sendblue line number (E.164 format) |
| `allowFrom` | string[] | `[]` | Allowed sender phone numbers (E.164) |
| `webhookPath` | string | `/webhooks/sendblue` | Webhook endpoint path |
| `webhookSecret` | string | `""` | Secret for webhook verification |
| `sendReadReceipts` | boolean | `true` | Send read receipts on inbound messages |
| `sendTypingIndicators` | boolean | `true` | Show typing bubble during AI processing |
| `typingIntervalMs` | number | `50000` | Typing indicator refresh interval (ms) |
| `textChunkLimit` | number | `4000` | Max characters per outbound message |
| `dmPolicy` | string | `"allowlist"` | Access policy: `"allowlist"` or `"open"` |

## Notes

- **iMessage only**: Typing indicators and read receipts only work for iMessage conversations, not SMS.
- **Free plan**: On Sendblue's free plan, recipients must be added as verified contacts in the dashboard.
- **Webhook URL stability**: If using ngrok free tier, the URL changes on restart — you'll need to re-register webhooks.
- **Prior conversation**: Typing indicators require an existing conversation with the recipient.

## License

MIT
