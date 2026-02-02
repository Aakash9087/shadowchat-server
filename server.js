/* ======================================================
   SHADOWCHAT SERVER – UPDATED STABLE RELAY
   For Render / Node 18+
   ====================================================== */

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  // Serve static files (HTML, CSS, JS)
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
  const ext = path.extname(filePath);
  let contentType = "text/html";

  if (ext === ".js") contentType = "text/javascript";
  else if (ext === ".css") contentType = "text/css";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ShadowChat Relay Online");
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});
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

        if (!accept) {
          // Handle Rejection
          const requester = users.get(toId);
          if (requester) {
            safeSend(requester.socket, {
              type: "request-rejected",
              fromId,
              fromName: users.get(fromId)?.name || "User",
            });
          }
          return;
        }

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

      /* ========== WEBRTC SIGNALING (VIDEO/AUDIO) ========== */
      case "signal": {
        const { toId, signalData } = data;
        const target = users.get(toId);

        if (target) {
          safeSend(target.socket, {
            type: "signal",
            fromId: currentUserId,
            signalData,
          });
        }
        break;
      }

      /* ========== TYPING INDICATOR ========== */
      case "typing": {
        const { sessionId, fromId, isTyping } = data;
        if (!sessions.has(sessionId)) return;

        broadcastToSession(sessionId, {
          type: "typing",
          fromId,
          isTyping
        });
        break;
      }

      /* ========== KEY EXCHANGE (E2EE) ========== */
      case "key-exchange": {
        const { toId, keyData } = data;
        const target = users.get(toId);
        if (target) {
          safeSend(target.socket, {
            type: "key-exchange",
            fromId: currentUserId,
            keyData
          });
        }
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
        const { sessionId, messageId, newText, fromId } = data;
        
        if (!sessions.has(sessionId)) return;

        broadcastToSession(sessionId, {
          type: "edit-message",
          id: messageId,
          fromId,
          newText,
        });

        break;
      }

      case "delete-message": {
        const { sessionId, id } = data;
        broadcastToSession(sessionId, {
          type: "delete-message",
          id,
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

      /* ========== GROUP CHAT ========== */
      case "create-group": {
        const { fromId, groupName } = data;
        const groupId = "G-" + Math.random().toString(36).substring(2, 8).toUpperCase();

        groups.set(groupId, {
          name: groupName || "Group Chat",
          members: [fromId],
          owner: fromId
        });

        safeSend(ws, {
          type: "group-created",
          groupId,
          groupName: groupName || "Group Chat"
        });
        console.log("Group created:", groupId);
        break;
      }

      case "join-group": {
        const { fromId, groupId } = data;
        const group = groups.get(groupId);
        
        if (!group) {
          safeSend(ws, { type: "error", message: "Group not found" });
          return;
        }
        
        // If already a member, just sync
        if (group.members.includes(fromId)) {
          safeSend(ws, {
            type: "group-joined",
            groupId,
            groupName: group.name,
            members: group.members
          });
          return;
        }

        // Auto-join: Add to members directly
        group.members.push(fromId);

        // Notify Requester (Success)
        safeSend(ws, {
          type: "group-joined",
          groupId,
          groupName: group.name,
          members: group.members
        });

        // Notify Others in the group
        group.members.forEach(uid => {
          if (uid !== fromId) {
            const u = users.get(uid);
            if (u) safeSend(u.socket, { 
              type: "group-user-joined", 
              groupId,
              userId: fromId, 
              userName: users.get(fromId)?.name,
              memberCount: group.members.length
            });
          }
        });
        break;
      }

      case "group-message": {
        const { groupId, fromId, text } = data;
        const group = groups.get(groupId);
        if (!group) return;

        const payload = {
          type: "group-message",
          groupId,
          from: fromId,
          fromName: users.get(fromId)?.name || "Unknown",
          text,
          timestamp: Date.now()
        };

        group.members.forEach(uid => {
          if (uid !== fromId) {
            const u = users.get(uid);
            if (u) safeSend(u.socket, payload);
          }
        });
        break;
      }

    }
  });

  /* ========== DISCONNECT CLEANUP ========== */
  ws.on("close", () => {
    if (currentUserId) {
      const user = users.get(currentUserId);
      
      // Fix: Only delete if the closing socket is the current active one
      // This prevents deleting the user if they quickly reconnected (page refresh)
      if (user && user.socket === ws) {
        users.delete(currentUserId);

        // Remove from sessions (P2P only)
        for (const [sid, session] of sessions.entries()) {
          if (session.users.includes(currentUserId)) {
            broadcastToSession(sid, { type: "session-ended", sessionId: sid });
            sessions.delete(sid);
          }
        }
        console.log("Disconnected:", currentUserId);
      }
    }
  });
});

/* ================= START ================= */

server.listen(PORT, () => {
  console.log("ShadowChat Relay running on port", PORT);
});