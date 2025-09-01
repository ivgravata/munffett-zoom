// server.js
// Minimal backend for Railway: healthcheck, Recall webhook, and WS bridge to OpenAI Realtime.
import express from "express";
import http from "http";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import wsPkg from "ws";

const {
  PORT = 3000,
  OPENAI_API_KEY,
  REALTIME_MODEL = "gpt-4o-realtime-preview",
  AGENT_NAME = "Munffett",
  VOICE = "verse",
  PERSONA_PROMPT = "You are Munffett, a concise, helpful investment co-analyst. Speak briefly and clearly.",
  ALLOWED_ORIGINS = "*",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",") }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Basic webhook endpoint for Recall/Zoom events (customize to your payload later)
app.post("/api/recall/webhook", async (req, res) => {
  try {
    console.log("Recall webhook event:", req.body?.type ?? Object.keys(req.body || {}));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

const server = http.createServer(app);

// WebSocket endpoint used by your media relay (Recall/Zoom) to reach OpenAI Realtime
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws/agent")) {
    wss.handleUpgrade(req, socket, head, (ws) => wsAgent(ws));
  } else {
    socket.destroy();
  }
});

function wsAgent(clientWs) {
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;

  // Connect server-side to OpenAI Realtime
  const aiWs = new wsPkg(openaiUrl, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // When connected to Realtime, set voice and persona
  aiWs.on("open", () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        voice: VOICE,
        instructions: `${PERSONA_PROMPT}\n\nName: ${AGENT_NAME}`
      }
    };
    aiWs.send(JSON.stringify(sessionUpdate));
  });

  // Forward messages from client → OpenAI
  // Trate texto vs binário corretamente (o ws passa Buffer + flag isBinary)
  clientWs.on("message", (data, isBinary) => {
    try {
      if (!isBinary) {
        // Texto (JSON) vindo do cliente (ex.: wscat)
        const text = data.toString("utf8");
        aiWs.send(text);
        return;
      }

      // Binário = frames de áudio: empacota como input_audio_buffer.append
      const b64 = Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data).toString("base64");
      aiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      // lembrando: o cliente deve enviar também {"type":"input_audio_buffer.commit"} ao fim de cada chunk
    } catch (err) {
      console.error("Client→AI forward error:", err);
    }
  });

  clientWs.on("close", () => {
    try { aiWs.close(); } catch {}
  });
  clientWs.on("error", (e) => console.error("Client WS error:", e));

  // Forward messages from OpenAI → client
  aiWs.on("message", (msg) => {
    try { clientWs.send(msg); } catch {}
  });
  aiWs.on("close", () => {
    try { clientWs.close(); } catch {}
  });
  aiWs.on("error", (e) => {
    console.error("OpenAI WS error:", e);
    try { clientWs.close(); } catch {}
  });
}

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server up on :${PORT}`);
});
