
# Voice Agent Railway Template

This is a minimal Node.js server to deploy on Railway for an OpenAI Realtime (speech-to-speech) agent.
It provides:

- `GET /health` (healthcheck)
- `POST /api/recall/webhook` (placeholder for Recall/Zoom events)
- `WS /ws/agent` (server-side bridge to OpenAI Realtime)

## Env Vars

- `OPENAI_API_KEY` (required)
- `REALTIME_MODEL` (default: `gpt-4o-realtime-preview`)
- `AGENT_NAME` (default: `Munffett`)
- `VOICE` (default: `verse`)
- `PERSONA_PROMPT` (short description of your persona)
- `ALLOWED_ORIGINS` (default: `*`)

## Run locally

```bash
npm i
OPENAI_API_KEY=sk-... node server.js
# visit http://localhost:3000/health
```

## WebSocket smoke test (optional)

```bash
npx wscat -c ws://localhost:3000/ws/agent
# then paste a JSON event like:
# {"type":"response.create","response":{"instructions":"Say hello briefly","modalities":["text"]}}
```

Deploy to Railway and point your Recall/Zoom media relay to:
- `wss://<your-domain>.up.railway.app/ws/agent`
- Webhook: `https://<your-domain>.up.railway.app/api/recall/webhook`
