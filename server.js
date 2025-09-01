// server.js
// Railway backend: healthcheck, Recall webhooks + bot control, and WS bridge to OpenAI Realtime.
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
  RECALL_API_KEY,
  RECALL_API_BASE = "https://api.recall.ai/v1",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}
if (!RECALL_API_KEY) {
  console.error("Missing RECALL_API_KEY env var.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",") }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---------- Recall helper (tenta 'Bearer' e 'Token') ----------
async function recallFetch(method, path, body) {
  const url = `${RECALL_API_BASE}${path}`;
  const tries = [
    { Authorization: `Bearer ${RECALL_API_KEY}` },
    { Authorization: `Token ${RECALL_API_KEY}` },
  ];
  let last;
  for (const h of tries) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...h },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 401) {
      last = res;
      break;
    }
    last = res;
  }
  return last;
}

// ---------- Recall webhook (eventos Zoom/Recall) ----------
app.post("/api/recall/webhook", async (req, res) => {
  try {
    console.log("[Recall webhook]", JSON.stringify(req.body || {}, null, 2).slice(0, 2000));
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ---------- Recall create/list/end endpoints ----------

// POST /api/recall/create  { "meeting_url": "https://zoom.us/j/..." }
app.post("/api/recall/create", async (req, res) => {
  try {
    const meetingUrl = (req.body?.meeting_url || "").trim();
    if (!meetingUrl) return res.status(400).json({ error: "missing meeting_url" });

    // Config pede bi-directional audio e encaminha mídia para o nosso WS /ws/agent
    const payload = {
      name: AGENT_NAME,
      join_behavior: "auto",                  // entrar sozinho
      capabilities: {
        transcription: false,                 // evita virar "note-taker"
        bi_directional_audio: true
      },
      webhook_url: `${req.protocol}://${req.get("host")}/api/recall/webhook`,
      media_relay: {
        type: "websocket",
        endpoint: `${req.protocol === "http" ? "ws" : "wss"}://${req.get("host")}/ws/agent`,
        audio_format: "pcm16"
      },
      meeting_url: meetingUrl,               // link da call (Zoom/Meet/Teams)
      // extras comuns; ignore se sua conta não usa
      metadata: { source: "railway-demo", persona: AGENT_NAME }
    };

    const r = await recallFetch("POST", "/meeting-bots", payload);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: "recall_error", body: safeJson(text) });
    return res.status(201).json(safeJson(text));
  } catch (e) {
    console.error("create-bot error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// GET /api/recall/list
app.get("/api/recall/list", async (_req, res) => {
  try {
    const r = await recallFetch("GET", "/meeting-bots", null);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: "recall_error", body: safeJson(text) });
    return res.json(safeJson(text));
  } catch (e) {
    console.error("list-bots error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/recall/end/:id
app.post("/api/recall/end/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing id" });
    // dependendo da API, pode ser DELETE /meeting-bots/:id ou POST /meeting-bots/:id/end
    let r = await recallFetch("POST", `/meeting-bots/${id}/end`, {});
    if (r.status === 404) r = await recallFetch("DELETE", `/meeting-bots/${id}`, null);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: "recall_error", body: safeJson(text) });
    return res.json(safeJson(text));
  } catch (e) {
    console.error("end-bot error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

function safeJson(t) { try { return JSON.parse(t); } catch { return { raw: t }; } }

// ---------- WS bridge to OpenAI Realtime ----------
const server = http.createServer(app);
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
  const aiWs = new wsPkg(openaiUrl, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    },
    perMessageDeflate: false
  });

  const KA_MS = 25000;
  const log = (...args) => console.log("[WS]", ...args);
  const logClose = (who, code, reason) =>
    console.warn(`[WS] ${who} closed: code=${code} reason=${reason?.toString() || ""}`);

  let kaClient = setInterval(() => { try { clientWs.ping(); } catch {} }, KA_MS);
  let kaAi = null;

  clientWs.on("close", (code, reason) => {
    logClose("client", code, reason);
    try { aiWs.close(); } catch {}
    clearInterval(kaClient);
    if (kaAi) clearInterval(kaAi);
  });
  clientWs.on("error", (e) => console.error("[WS] client error:", e));

  aiWs.on("open", () => {
    log("AI connected");
    kaAi = setInterval(() => { try { aiWs.ping(); } catch {} }, KA_MS);

    const sessionUpdate = {
      type: "session.update",
      session: {
        voice: VOICE,
        instructions: `${PERSONA_PROMPT}\n\nName: ${AGENT_NAME}`
      }
    };
    aiWs.send(JSON.stringify(sessionUpdate));
  });

  aiWs.on("close", (code, reason) => {
    logClose("AI", code, reason);
    try { clientWs.close(); } catch {}
    if (kaAi) clearInterval(kaAi);
  });
  aiWs.on("error", (e) => console.error("[WS] AI error:", e));

  clientWs.on("message", (data, isBinary) => {
    try {
      if (!isBinary) {
        const text = data.toString("utf8");
        log("client→AI text:", text.slice(0, 200));
        aiWs.send(text);
      } else {
        const b64 = Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data).toString("base64");
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        // lembre: o cliente deve enviar {"type":"input_audio_buffer.commit"} ao final do chunk
      }
    } catch (err) {
      console.error("[WS] client→AI forward error:", err);
    }
  });

  aiWs.on("message", (msg, isBinary) => {
    try {
      if (!isBinary) {
        const text = msg.toString("utf8");
        log("AI→client text:", text.slice(0, 200));
        clientWs.send(text);
      } else {
        clientWs.send(msg, { binary: true });
      }
    } catch (err) {
      console.error("[WS] AI→client forward error:", err);
    }
  });
}

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server up on :${PORT}`);
});
