require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const MAX_MESSAGE_SIZE = 1024 * 200;
const SESSION_TTL = 30 * 60 * 1000;

const TURN_SECRET = process.env.TURN_SECRET || "CHANGE_ME";
const TURN_HOST = process.env.TURN_HOST || "turn.yourdomain.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

const clients = new Map();
const sessions = new Map();
const rateLimits = new Map();
const recentMessages = new Set();

/* ================= Helpers ================= */

function makeSessionId(a, b) {
  return [a, b].sort().join("#");
}

function sendToUser(userId, payload) {
  const c = clients.get(userId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) return;
  c.ws.send(JSON.stringify(payload));
}

function rateLimitCheck(userId) {
  const now = Date.now();
  const limit = rateLimits.get(userId) || { count: 0, time: now };

  if (now - limit.time > 5000) {
    rateLimits.set(userId, { count: 1, time: now });
    return true;
  }

  if (limit.count > 40) return false;

  limit.count++;
  rateLimits.set(userId, limit);
  return true;
}

function generateTurnCredentials() {
  const username = Math.floor(Date.now() / 1000) + 3600;
  const hmac = crypto.createHmac("sha1", TURN_SECRET);
  hmac.update(username.toString());
  const password = hmac.digest("base64");

  return {
    username: username.toString(),
    credential: password,
    urls: `turn:${TURN_HOST}:3478`
  };
}

/* ================= HTTP Server ================= */

const server = http.createServer((req, res) => {

  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("ETag", "");

  res.writeHead(200);
  res.end("ShadowChat Secure Backend v4 Running");
});

/* ================= WebSocket ================= */

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_MESSAGE_SIZE
});

wss.on("connection", (ws, req) => {

  if (ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN) {
    ws.terminate();
    return;
  }

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let currentUserId = null;

  ws.on("message", (raw) => {

    if (raw.length > MAX_MESSAGE_SIZE) return;

    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    if (!data.type) return;

    const type = data.type;

    // HELLO
    if (type === "hello") {
      currentUserId = data.userId;
      if (!currentUserId) return;

      clients.set(currentUserId, { ws });
      sendToUser(currentUserId, { type: "hello-ack", ok: true });
      return;
    }

    if (!currentUserId) return;
    if (!rateLimitCheck(currentUserId)) {
      ws.terminate();
      return;
    }

    // REQUEST CHAT
    if (type === "request-chat") {
      const { fromId, toId } = data;
      if (!clients.has(toId)) return;

      sendToUser(toId, {
        type: "incoming-request",
        fromId
      });
      return;
    }

    // RESPONSE CHAT
    if (type === "response-chat") {
      const { fromId, toId, accept } = data;
      if (!accept) return;

      const sid = makeSessionId(fromId, toId);

      sessions.set(sid, {
        aId: fromId,
        bId: toId,
        createdAt: Date.now()
      });

      sendToUser(fromId, { type: "chat-start", sessionId: sid, peerId: toId });
      sendToUser(toId, { type: "chat-start", sessionId: sid, peerId: fromId });
      return;
    }

    // MESSAGE RELAY
    if (type === "message") {
      const s = sessions.get(data.sessionId);
      if (!s) return;

      if (recentMessages.has(data.id)) return;
      recentMessages.add(data.id);
      setTimeout(() => recentMessages.delete(data.id), 60000);

      const target =
        currentUserId === s.aId ? s.bId : s.aId;

      sendToUser(target, data);
      return;
    }

    // TURN TOKEN
    if (type === "get-turn") {
      sendToUser(currentUserId, {
        type: "turn-credentials",
        creds: generateTurnCredentials()
      });
    }

  });

  ws.on("close", () => {
    if (currentUserId) {
      clients.delete(currentUserId);
    }
  });
});

/* ================= Cleanup ================= */

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL) {
      sessions.delete(sid);
    }
  }
}, 60000);

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log("ShadowChat Secure Backend v4 running on", PORT);
});
