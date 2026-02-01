/* ======================================================
   SHADOWCHAT SERVER – UPDATED STABLE RELAY
   For Render / Node 18+
   ====================================================== */

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

/* ================= STATE ================= */

const users = new Map();      
// userId -> { socket, name }

const sessions = new Map();   
// sessionId -> { users: [id1,id2] }

const groups = new Map();     
// groupId -> { owner, members: [] }

/* ================= UTIL ================= */

function generateSessionId() {
  return (
    "S-" +
    Math.random().toString(36).substring(2, 6).toUpperCase() +
    "-" +
    Math.random().toString(36).substring(2, 6).toUpperCase()
  );
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToSession(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.users.forEach((uid) => {
    const user = users.get(uid);
    if (user) safeSend(user.socket, payload);
  });
}

/* ================= CONNECTION ================= */

wss.on("connection", (ws) => {
  console.log("New connection");

  let currentUserId = null;

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    switch (data.type) {

      /* ========== HELLO REGISTER ========== */
      case "hello": {
        const { userId, name } = data;
        if (!userId) return;

        currentUserId = userId;
        users.set(userId, {
          socket: ws,
          name: name || "User",
        });

        safeSend(ws, { type: "hello-ack", ok: true });
        console.log("Registered:", userId);
        break;
      }

      /* ========== REQUEST CHAT ========== */
      case "request-chat": {
        const { fromId, toId } = data;
        const target = users.get(toId);

        if (!target) {
          safeSend(ws, {
            type: "request-failed",
            reason: "User not online",
          });
          return;
        }

        safeSend(target.socket, {
          type: "incoming-request",
          fromId,
          fromName: users.get(fromId)?.name || "User",
        });

        break;
      }

      /* ========== RESPONSE CHAT ========== */
      case "response-chat": {
        const { fromId, toId, accept } = data;

        if (!accept) return;

        const sessionId = generateSessionId();

        sessions.set(sessionId, {
          users: [fromId, toId],
        });

        const userA = users.get(fromId);
        const userB = users.get(toId);

        if (userA)
          safeSend(userA.socket, {
            type: "chat-start",
            sessionId,
            peerId: toId,
            peerName: users.get(toId)?.name || "User",
          });

        if (userB)
          safeSend(userB.socket, {
            type: "chat-start",
            sessionId,
            peerId: fromId,
            peerName: users.get(fromId)?.name || "User",
          });

        console.log("Session started:", sessionId);
        break;
      }

      /* ========== MESSAGE RELAY ========== */
      case "message": {
        const { sessionId, fromId, text, selfDestruct } = data;

        if (!sessions.has(sessionId)) return;

        const payload = {
          type: "message",
          sessionId,
          from: fromId,
          text,
          timestamp: Date.now(),
        };

        broadcastToSession(sessionId, payload);

        // Self destruct timer (server side sync)
        if (selfDestruct && Number(selfDestruct) > 0) {
          setTimeout(() => {
            broadcastToSession(sessionId, {
              type: "delete-message",
              id: payload.timestamp,
            });
          }, Number(selfDestruct));
        }

        break;
      }

      /* ========== EDIT MESSAGE ========== */
      case "edit-message": {
        const { sessionId, messageId, newText } = data;

        broadcastToSession(sessionId, {
          type: "edit-message",
          id: messageId,
          newText,
        });

        break;
      }

      /* ========== END SESSION ========== */
      case "end-session": {
        const { sessionId } = data;

        broadcastToSession(sessionId, {
          type: "session-ended",
          sessionId,
        });

        sessions.delete(sessionId);
        console.log("Session ended:", sessionId);
        break;
      }

      /* ========== BASIC GROUP BASE (FUTURE READY) ========== */
      case "create-group": {
        const { groupId, owner } = data;

        groups.set(groupId, {
          owner,
          members: [owner],
        });

        break;
      }

      case "group-join-request": {
        const { groupId, userId } = data;
        const group = groups.get(groupId);
        if (!group) return;

        const ownerUser = users.get(group.owner);
        if (!ownerUser) return;

        safeSend(ownerUser.socket, {
          type: "group-join-request",
          groupId,
          userId,
        });

        break;
      }

      case "group-approve": {
        const { groupId, userId } = data;
        const group = groups.get(groupId);
        if (!group) return;

        group.members.push(userId);

        const user = users.get(userId);
        if (user) {
          safeSend(user.socket, {
            type: "group-joined",
            groupId,
          });
        }

        break;
      }

    }
  });

  /* ========== DISCONNECT CLEANUP ========== */
  ws.on("close", () => {
    if (currentUserId) {
      users.delete(currentUserId);

      // Remove from sessions
      for (const [sid, session] of sessions.entries()) {
        if (session.users.includes(currentUserId)) {
          broadcastToSession(sid, {
            type: "session-ended",
            sessionId: sid,
          });
          sessions.delete(sid);
        }
      }

      console.log("Disconnected:", currentUserId);
    }
  });
});

/* ================= START ================= */

server.listen(PORT, () => {
  console.log("ShadowChat Relay running on port", PORT);
});