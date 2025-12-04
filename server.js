// ============================================================
// ShadowChat Relay Server (FINAL FIXED VERSION – By Jack for Jamin)
// Ultra-stable WebSocket relay with sessions + media support
// ============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// ==============================
// In-memory state
// ==============================

// userId -> { ws, name }
const clients = new Map();

// sessionId -> { aId, bId }
const sessions = new Map();

let activeConnections = 0;
let totalConnections = 0;
let totalSessionsStarted = 0;

// ==============================
// Helpers
// ==============================

function makeSessionId(a, b) {
  return [a, b].sort().join("#");
}

function sendToUser(userId, payload) {
  const c = clients.get(userId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  c.ws.send(JSON.stringify(payload));
}

function cleanPayload(obj) {
  return JSON.stringify(obj);
}

// ==============================
// HTTP server (health + metrics)
// ==============================

const server = http.createServer((req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        activeConnections,
        totalConnections,
        totalSessionsStarted,
        uptime: Math.floor(process.uptime()),
      })
    );
  }

  res.writeHead(200);
  res.end("ShadowChat Relay OK");
});

// ==============================
// WebSocket Server
// ==============================

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  activeConnections++;
  totalConnections++;

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let currentUserId = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = data.type;

    // ----------------------------
    // 1) HELLO = Register User
    // ----------------------------
    if (type === "hello") {
      const { userId, name } = data;
      if (!userId) return;

      currentUserId = userId;
      clients.set(userId, { ws, name: name || "User" });

      sendToUser(userId, { type: "hello-ack", ok: true });
      return;
    }

    // Ignore everything else until hello registered
    if (!currentUserId) return;

    // ----------------------------
    // 2) REQUEST CHAT
    // ----------------------------
    if (type === "request-chat") {
      const { fromId, toId } = data;

      if (!fromId || !toId) return;
      if (!clients.has(toId)) {
        return sendToUser(fromId, {
          type: "request-failed",
          reason: "Target user not online.",
        });
      }

      const target = clients.get(toId);

      sendToUser(toId, {
        type: "incoming-request",
        fromId,
        fromName: clients.get(fromId)?.name || "User",
      });

      sendToUser(fromId, {
        type: "request-sent",
        toId,
      });

      return;
    }

    // ----------------------------
    // 3) RESPONSE CHAT
    // ----------------------------
    if (type === "response-chat") {
      const { fromId, toId, accept } = data;

      if (!accept) {
        return sendToUser(toId, {
          type: "request-failed",
          reason: "Request rejected.",
        });
      }

      const sid = makeSessionId(fromId, toId);
      sessions.set(sid, { aId: fromId, bId: toId });
      totalSessionsStarted++;

      const aName = clients.get(fromId)?.name || "User";
      const bName = clients.get(toId)?.name || "User";

      sendToUser(fromId, {
        type: "chat-start",
        sessionId: sid,
        peerId: toId,
        peerName: bName,
      });

      sendToUser(toId, {
        type: "chat-start",
        sessionId: sid,
        peerId: fromId,
        peerName: aName,
      });

      return;
    }

    // ----------------------------
    // 4) MESSAGE RELAY
    // ----------------------------
    if (type === "message") {
      const { sessionId, fromId, text, selfDestruct, encrypted } = data;

      if (!sessionId || !fromId) return;
      const s = sessions.get(sessionId);
      if (!s) return;

      const toId = s.aId === fromId ? s.bId : s.aId;

      const msgId = `${sessionId}:${Date.now()}:${Math.random()
        .toString(16)
        .slice(2)}`;

      const payload = {
        type: "message",
        id: msgId,
        from: fromId,
        to: toId,
        text,
        selfDestruct: Number(selfDestruct || 0),
        encrypted: !!encrypted,
        timestamp: Date.now(),
      };

      // send BOTH directions (frontend filters self)
      sendToUser(fromId, payload);
      sendToUser(toId, payload);

      // Self-destruct timer
      const ttl = Number(selfDestruct || 0);
      if (ttl > 0 && ttl <= 5 * 60 * 1000) {
        setTimeout(() => {
          const del = {
            type: "delete-message",
            id: msgId,
            sessionId,
          };
          sendToUser(fromId, del);
          sendToUser(toId, del);
        }, ttl);
      }
      return;
    }

    // ----------------------------
    // 5) EDIT MESSAGE (optional)
    // ----------------------------
    if (type === "edit-message") {
      const { sessionId, messageId, newText } = data;
      const s = sessions.get(sessionId);
      if (!s) return;

      const payload = {
        type: "edit-message",
        id: messageId,
        sessionId,
        newText,
      };

      sendToUser(s.aId, payload);
      sendToUser(s.bId, payload);
      return;
    }

    // ----------------------------
    // 6) END SESSION
    // ----------------------------
    if (type === "end-session") {
      const { sessionId } = data;
      const s = sessions.get(sessionId);
      if (!s) return;

      sessions.delete(sessionId);

      sendToUser(s.aId, { type: "session-ended", sessionId });
      sendToUser(s.bId, { type: "session-ended", sessionId });
      return;
    }
  });

  // ----------------------------
  // DISCONNECT
  // ----------------------------
  ws.on("close", () => {
    activeConnections--;
    if (currentUserId) clients.delete(currentUserId);
  });
});

// ==============================
// Heartbeat (Render keep-alive)
// ==============================

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log("ShadowChat Relay running on", PORT);
});