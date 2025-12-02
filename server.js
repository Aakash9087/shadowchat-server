// server.js
// ShadowChat relay server + basic metrics + DEBUG LOG
// Concept by Jamin – coded by Jack

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// ========= In-memory state =========

// userId -> { ws, name }
const clients = new Map();

// sessionId -> { aId, bId }
const sessions = new Map();

// simple counters (no user-identifying logs)
let activeConnections = 0;
let totalConnections = 0;
let totalSessionsStarted = 0;

// ========= Helpers =========

function makeSessionId(aId, bId) {
  return [aId, bId].sort().join("#");
}

function sendToUser(userId, payload) {
  const c = clients.get(userId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) {
    console.log("[SEND FAIL]", userId, "not connected");
    return;
  }
  console.log("[SEND]", "→", userId, payload.type);
  c.ws.send(JSON.stringify(payload));
}

function broadcastStats() {
  const data = JSON.stringify({
    type: "stats",
    activeConnections,
  });
  for (const [uid, { ws }] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ========= HTTP server (/metrics) =========

const server = http.createServer((req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        activeConnections,
        totalConnections,
        totalSessionsStarted,
        uptimeSeconds: Math.floor(process.uptime()),
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

// ========= WebSocket logic =========

wss.on("connection", (ws) => {
  activeConnections++;
  totalConnections++;

  let currentUserId = null;
  console.log("🔗 New WS connection. Active:", activeConnections);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.log("Bad JSON:", msg.toString());
      return;
    }

    const type = data.type;
    console.log("[WS IN]", type, "from", currentUserId);

    // 1) hello: register userId + name
    if (type === "hello") {
      const { userId, name } = data;
      if (!userId) return;

      currentUserId = userId;
      clients.set(userId, { ws, name: name || "User" });

      console.log("👤 Registered user:", userId, "name:", name);

      sendToUser(userId, {
        type: "hello-ack",
        ok: true,
      });

      broadcastStats();
      return;
    }

    // Without userId ignore others
    if (!currentUserId) {
      console.log("Ignoring msg without hello");
      return;
    }

    // 2) request chat
    if (type === "request-chat") {
      const { fromId, toId } = data;
      if (!fromId || !toId) return;

      console.log("📩 Chat request", fromId, "→", toId);

      if (!/^SC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(toId)) {
        sendToUser(fromId, {
          type: "request-failed",
          reason: "Invalid Chat ID format.",
        });
        return;
      }

      const target = clients.get(toId);
      if (!target) {
        sendToUser(fromId, {
          type: "request-failed",
          reason: "Target user not online.",
        });
        return;
      }

      sendToUser(toId, {
        type: "incoming-request",
        fromId,
        fromName: clients.get(fromId)?.name || "Anonymous",
      });

      sendToUser(fromId, {
        type: "request-sent",
        toId,
      });

      return;
    }

    // 3) response chat: accept / reject
    if (type === "response-chat") {
      const { fromId, toId, accept } = data;
      if (!fromId || !toId) return;

      console.log("✅ Chat response from", fromId, "→", toId, "accept?", accept);

      if (!accept) {
        sendToUser(toId, {
          type: "request-failed",
          reason: "Request rejected.",
        });
        return;
      }

      const sid = makeSessionId(fromId, toId);
      sessions.set(sid, { aId: fromId, bId: toId });
      totalSessionsStarted++;

      console.log("🔐 Session started:", sid);

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

    // 4) message relay (MAIN)
    if (type === "message") {
      const { sessionId, fromId, text, selfDestruct, encrypted } = data;
      if (!sessionId || !fromId || typeof text !== "string") return;

      const s = sessions.get(sessionId);
      if (!s) {
        console.log("No session found for", sessionId);
        return;
      }

      const toId = s.aId === fromId ? s.bId : s.aId;
      if (!toId) {
        console.log("No peer found for", sessionId, "from", fromId);
        return;
      }

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

      console.log("✉ Relay", msgId, "from", fromId, "to", toId);

      // দু’দিকেই পাঠাচ্ছে
      sendToUser(fromId, payload);
      sendToUser(toId, payload);

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

    // 5) edit message
    if (type === "edit-message") {
      const { sessionId, messageId, newText } = data;
      if (!sessionId || !messageId || typeof newText !== "string") return;

      const s = sessions.get(sessionId);
      if (!s) return;
      const { aId, bId } = s;

      const payload = {
        type: "edit-message",
        id: messageId,
        sessionId,
        newText,
      };
      sendToUser(aId, payload);
      sendToUser(bId, payload);
      return;
    }

    // 6) end session
    if (type === "end-session") {
      const { sessionId } = data;
      if (!sessionId) return;
      const s = sessions.get(sessionId);
      if (!s) return;

      const { aId, bId } = s;
      sessions.delete(sessionId);

      console.log("🔚 Session ended:", sessionId);

      const payload = { type: "session-ended", sessionId };
      sendToUser(aId, payload);
      sendToUser(bId, payload);
      return;
    }

    // 7) client stats request
    if (type === "get-stats") {
      sendToUser(currentUserId, {
        type: "stats",
        activeConnections,
      });
      return;
    }
  });

  ws.on("close", () => {
    activeConnections--;
    if (activeConnections < 0) activeConnections = 0;

    if (currentUserId && clients.has(currentUserId)) {
      clients.delete(currentUserId);
    }

    console.log("❌ WS closed:", currentUserId);
    broadcastStats();
  });
});

server.listen(PORT, () => {
  console.log(`ShadowChat relay listening on port ${PORT}`);
});
