/*
  ShadowChat – Relay Server
  RAM-Only, No Logs, No Storage
  Created by Jamin
*/

const WebSocket = require("ws");
const server = new WebSocket.Server({ port: 8080 });

console.log("ShadowChat Relay running on ws://localhost:8080");

let clients = {};   // userId -> ws
let names = {};     // userId -> display name
let sessions = {};  // sessionId -> { userA, userB }

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function validateID(id) {
  return !!clients[id];
}

function genSessionId() {
  return (
    "S-" +
    Math.random().toString(36).substr(2, 4).toUpperCase() +
    "-" +
    Math.random().toString(36).substr(2, 4).toUpperCase()
  );
}

server.on("connection", (ws) => {
  let myId = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // HELLO – register user
    if (data.type === "hello") {
      myId = data.userId;
      clients[myId] = ws;
      names[myId] = data.name || "User";
      return;
    }

    // REQUEST CHAT
    if (data.type === "request-chat") {
      if (!validateID(data.toId)) {
        send(ws, {
          type: "request-failed",
          reason: "User offline or Chat ID not valid.",
        });
        return;
      }

      send(clients[data.toId], {
        type: "incoming-request",
        fromId: data.fromId,
        fromName: names[data.fromId] || "User",
      });
      return;
    }

    // RESPONSE CHAT (accept / reject)
    if (data.type === "response-chat") {
      if (!validateID(data.toId)) return;

      if (!data.accept) {
        send(clients[data.toId], {
          type: "request-failed",
          reason: "Request rejected by user.",
        });
        return;
      }

      const sId = genSessionId();
      sessions[sId] = { userA: data.fromId, userB: data.toId };

      send(clients[data.fromId], {
        type: "chat-start",
        sessionId: sId,
        peerId: data.toId,
        peerName: names[data.toId] || "User",
      });

      send(clients[data.toId], {
        type: "chat-start",
        sessionId: sId,
        peerId: data.fromId,
        peerName: names[data.fromId] || "User",
      });

      return;
    }

    // MESSAGE
    if (data.type === "message") {
      const s = sessions[data.sessionId];
      if (!s) return;

      const msgObj = {
        id: "M-" + Math.random().toString(36).substr(2, 8),
        from: data.fromId,
        text: data.text,
        timestamp: Date.now(),
      };

      send(clients[s.userA], { type: "message", message: msgObj });
      send(clients[s.userB], { type: "message", message: msgObj });

      // self-destruct
      if (data.selfDestruct && data.selfDestruct > 0) {
        setTimeout(() => {
          send(clients[s.userA], {
            type: "delete-message",
            id: msgObj.id,
          });
          send(clients[s.userB], {
            type: "delete-message",
            id: msgObj.id,
          });
        }, data.selfDestruct);
      }
      return;
    }

    // EDIT MESSAGE
    if (data.type === "edit-message") {
      const s = sessions[data.sessionId];
      if (!s) return;

      send(clients[s.userA], {
        type: "edit-message",
        id: data.messageId,
        newText: data.newText,
      });
      send(clients[s.userB], {
        type: "edit-message",
        id: data.messageId,
        newText: data.newText,
      });
      return;
    }

    // END SESSION
    if (data.type === "end-session") {
      const s = sessions[data.sessionId];
      if (!s) return;

      send(clients[s.userA], { type: "session-ended" });
      send(clients[s.userB], { type: "session-ended" });

      delete sessions[data.sessionId];
      return;
    }
  });

  ws.on("close", () => {
    if (myId) {
      delete clients[myId];
      delete names[myId];
    }
  });
});
