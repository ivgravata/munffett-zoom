// server.js — Railway: Recall API (create/list/end/ping) + webhook + WS bridge to OpenAI Realtime
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

  // === Recall API setup ===
  RECALL_API_KEY,
  RECALL_API_BASE = "https://api.recall.ai", // sem /v1
  // paths padrão (Django/DRF costumam aceitar barra no final)
  RECALL_PATH_LIST = "/v1/meeting-bots/",
  RECALL_PATH_CREATE = "/v1/meeting-bots/",
  RECALL_PATH_END_POST = "/v1/meeting-bots/:id/end/",
  RECALL_PATH_DELETE = "/v1/meeting-bots/:id/",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!RECALL_API_KEY) {
  console.error("Missing RECALL_API_KEY");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",") }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---------- Helpers ----------
const buildUrl = (path) => `${RECALL_API_BASE}${path}`;
const tryHeaders = [
  () => ({ Authorization: `Bearer ${RECALL_API_KEY}`, "Content-Type": "application/json" }),
  () => ({ Authorization: `Token ${RECALL_API_KEY}`, "Content-Type": "application/json" }),
];

async function recallFetch(method, path, body) {
  const url = buildUrl(path);
  let last = null;
  for (const hdr of tryHeaders) {
    const headers = hdr();
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 401) {
      last = res;
      break;
    }
    last = res;
  }
  const text = await last.text();
  console.log(`[Recall ${method}] ${url} -> ${last.status} ${last.statusText} :: ${text.slice(0, 180)}...`);
  return { status: last.status, ok: last.ok, text };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return { raw: t }; } };
const subId = (tpl, id) => tpl.replace(":id", id);

// ---------- Webhook ----------
app.post("/api/recall/webhook", async (req, res) => {
  console.log("[Recall webhook]", JSON.stringify(req.body || {}, null, 2).slice(0, 2000));
  res.sendStatus(200);
});

// ---------- Diagnóstico ----------
app.get("/api/recall/debug", (req, res) => {
  res.json({
    BASE: RECALL_API_BASE,
    PATHS: { LIST: RECALL_PATH_LIST, CREATE: RECALL_PATH_CREATE, END_POST: RECALL_PATH_END_POST, DELETE: RECALL_PATH_DELETE },
    HAS_KEY: !!RECALL_API_KEY,
  });
});

app.get("/api/recall/ping", async (req, res) => {
  const r = await recallFetch("GET", RECALL_PATH_LIST, null);
  res.status(r.ok ? 200 : 500).json({ ok: r.ok, status: r.status, body: safeJson(r.text) });
});

// ---------- Bot control ----------
app.get("/api/recall/list", async (_req, res) => {
  const r = await recallFetch("GET", RECALL_PATH_LIST, null);
  res.status(r.ok ? 200 : r.status).json(r.ok ? safeJson(r.text) : { error: "recall_error", body: safeJson(r.text) });
});

// POST /api/recall/create  { meeting_url: "https://..." }
app.post("/api/recall/create", async (req, res) => {
  const meetingUrl = (req.body?.meeting_url || "").trim();
  if (!meetingUrl) return res.status(400).json({ error: "missing meeting_url" });

  const wsProto = req.protocol === "http" ? "ws" : "wss";
  const host = req.get("host");
  const payload = {
    name: AGENT_NAME,
    join_behavior: "auto",
    capabilities: { transcription: false, bi_directional_audio: true },
    webhook_url: `${req.protocol}://${host}/api/recall/webhook`,
    media_relay: { type: "websocket", endpoint: `${wsProto}://${host}/ws/agent`, audio_format: "pcm16" },
    meeting_url: meetingUrl,
    metadata: { source: "railway", persona: AGENT_NAME }
  };

  const r = await recallFetch("POST", RECALL_PATH_CREATE, payload);
  res.status(r.ok ? 201 : r.status).json(r.ok ? safeJson(r.text) : { error: "recall_error", body: safeJson(r.text) });
});

// POST /api/recall/end/:id
app.post("/api/recall/end/:id", async (req, res) => {
  const id = req.params.id?.trim();
  if (!id) return res.status(400).json({ error: "missing id" });

  let r = await recallFetch("POST", subId(RECALL_PATH_END_POST, id), {});
  if (r.status === 404) r = await recallFetch("DELETE", subId(RECALL_PATH_DELETE, id), null);
  res.status(r.ok ? 200 : r.status).json(r.ok ? safeJson(r.text) : { error: "recall_error", body: safeJson(r.text) });
});

// ---------- WS bridge ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws/agent")) wss.handleUpgrade(req, socket, head, (ws) => wsAgent(ws));
  else socket.destroy();
});

function wsAgent(clientWs) {
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const aiWs = new wsPkg(openaiUrl, {
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false
  });

  const KA_MS = 25000;
  let kaClient = setInterval(() => { try { clientWs.ping(); } catch {} }, KA_MS);
  let kaAi = null;

  aiWs.on("open", () => {
    kaAi = setInterval(() => { try { aiWs.ping(); } catch {} }, KA_MS);
    aiWs.send(JSON.stringify({
      type: "session.update",
      session: { voice: VOICE, instructions: `${PERSONA_PROMPT}\n\nName: ${AGENT_NAME}` }
    }));
  });

  clientWs.on("message", (data, isBinary) => {
    try {
      if (!isBinary) aiWs.send(data.toString("utf8"));
      else {
        const b64 = Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data).toString("base64");
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      }
    } catch (e) { console.error("[WS] client→AI error:", e); }
  });

  aiWs.on("message", (msg, isBinary) => {
    try { clientWs.send(msg, { binary: !!isBinary }); } catch (e) { console.error("[WS] AI→client error:", e); }
  });

  const closeBoth = () => { try { aiWs.close(); } catch {} try { clientWs.close(); } catch {} };
  aiWs.on("close", () => { clearInterval(kaAi); clearInterval(kaClient); closeBoth(); });
  clientWs.on("close", () => { clearInterval(kaAi); clearInterval(kaClient); closeBoth(); });

  aiWs.on("error", e => console.error("[WS] AI error:", e));
  clientWs.on("error", e => console.error("[WS] client error:", e));
}

server.listen(Number(PORT), "0.0.0.0", () => console.log(`server up on :${PORT}`));
