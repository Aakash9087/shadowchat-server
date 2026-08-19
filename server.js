/* ======================================================
   SHADOWCHAT SERVER
   UPDATED STABLE RELAY
   Node 18+ / Render
   ====================================================== */

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;


/* ======================================================
   HTTP SERVER
   ====================================================== */

const server = http.createServer((req, res) => {

  let requestedPath =
    decodeURIComponent(
      (req.url || "/").split("?")[0]
    );

  if (
    requestedPath === "/" ||
    requestedPath === ""
  ) {
    requestedPath = "/index.html";
  }

  const safePath =
    path.normalize(requestedPath)
      .replace(/^(\.\.[/\\])+/, "");

  const filePath =
    path.join(
      __dirname,
      safePath
    );

  const ext =
    path.extname(filePath)
      .toLowerCase();

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  const contentType =
    contentTypes[ext] ||
    "application/octet-stream";

  fs.readFile(
    filePath,
    (err, content) => {

      if (err) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        res.end(
          "ShadowChat Relay Online"
        );

        return;
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            contentType,

          "Cache-Control":
            ext === ".html"
              ? "no-cache"
              : "public, max-age=3600"
        }
      );

      res.end(content);
    }
  );
});


/* ======================================================
   WEBSOCKET SERVER
   ====================================================== */

const wss =
  new WebSocket.Server({
    server
  });


/* ======================================================
   STATE
   ====================================================== */

const users =
  new Map();

const sessions =
  new Map();

const groups =
  new Map();

const messageTimers =
  new Map();


/* ======================================================
   UTILITIES
   ====================================================== */

function generateSessionId() {

  return (
    "S-" +
    Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase() +
    "-" +
    Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase()
  );
}


function generateMessageId() {

  return (
    Date.now().toString(36) +
    "-" +
    Math.random()
      .toString(36)
      .substring(2, 10)
  );
}


function generateGroupId() {

  return (
    "G-" +
    Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase()
  );
}


function safeSend(ws, data) {

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {

    try {

      ws.send(
        JSON.stringify(data)
      );

    } catch (err) {

      console.error(
        "WebSocket send error:",
        err.message
      );
    }
  }
}


function broadcastToSession(
  sessionId,
  payload
) {

  const session =
    sessions.get(sessionId);

  if (!session) {
    return;
  }

  session.users.forEach(
    (uid) => {

      const user =
        users.get(uid);

      if (user) {

        safeSend(
          user.socket,
          payload
        );
      }
    }
  );
}


function sendToUser(
  userId,
  payload
) {

  const user =
    users.get(userId);

  if (!user) {
    return false;
  }

  safeSend(
    user.socket,
    payload
  );

  return true;
}


function isSessionMember(
  sessionId,
  userId
) {

  const session =
    sessions.get(sessionId);

  if (!session) {
    return false;
  }

  return session.users.includes(
    userId
  );
}


function clearMessageTimer(
  sessionId,
  msgId
) {

  const key =
    `${sessionId}:${String(msgId)}`;

  const timer =
    messageTimers.get(key);

  if (timer) {

    clearTimeout(timer);

    messageTimers.delete(key);
  }
}


/* ======================================================
   SELF-DESTRUCT
   ====================================================== */

function scheduleMessageDeletion(
  sessionId,
  msgId,
  delayMs
) {

  const delay =
    Number(delayMs);

  if (
    !Number.isFinite(delay) ||
    delay <= 0
  ) {
    return;
  }

  clearMessageTimer(
    sessionId,
    msgId
  );

  const key =
    `${sessionId}:${String(msgId)}`;

  const timer =
    setTimeout(
      () => {

        broadcastToSession(
          sessionId,
          {
            type:
              "delete-message",

            id:
              msgId,

            sessionId:
              sessionId
          }
        );

        messageTimers.delete(key);

        console.log(
          "Self-destruct:",
          msgId,
          "session:",
          sessionId
        );

      },
      delay
    );

  messageTimers.set(
    key,
    timer
  );
}


/* ======================================================
   CONNECTION
   ====================================================== */

wss.on(
  "connection",
  (ws) => {

    console.log(
      "New WebSocket connection"
    );

    let currentUserId =
      null;


    /* ==================================================
       MESSAGE
       ================================================== */

    ws.on(
      "message",
      (message) => {

        let data;

        try {

          data =
            JSON.parse(
              message.toString()
            );

        } catch (err) {

          console.warn(
            "Invalid JSON received."
          );

          return;
        }


        if (
          !data ||
          typeof data.type !== "string"
        ) {
          return;
        }


        switch (data.type) {


          /* ============================================
             HELLO REGISTER
             ============================================ */

          case "hello": {

            const {
              userId,
              name,
              avatar
            } = data;

            if (!userId) {
              return;
            }

            const oldUser =
              users.get(userId);

            if (
              oldUser &&
              oldUser.socket !== ws
            ) {

              try {
                oldUser.socket.close();
              } catch (e) {}
            }

            currentUserId =
              String(userId);

            users.set(
              currentUserId,
              {
                socket: ws,
                name:
                  name || "User",
                avatar:
                  avatar || null
              }
            );

            safeSend(
              ws,
              {
                type:
                  "hello-ack",
                ok:
                  true
              }
            );

            console.log(
              "Registered:",
              currentUserId
            );

            break;
          }


          /* ============================================
             REQUEST CHAT
             ============================================ */

          case "request-chat": {

            const {
              fromId,
              toId
            } = data;

            if (
              !fromId ||
              !toId
            ) {
              return;
            }

            const target =
              users.get(toId);

            if (!target) {

              safeSend(
                ws,
                {
                  type:
                    "request-failed",

                  reason:
                    "User not online"
                }
              );

              return;
            }

            safeSend(
              target.socket,
              {
                type:
                  "incoming-request",

                fromId:
                  fromId,

                fromName:
                  users.get(fromId)?.name ||
                  "User",

                fromAvatar:
                  users.get(fromId)?.avatar ||
                  null
              }
            );

            break;
          }


          /* ============================================
             RESPONSE CHAT
             ============================================ */

          case "response-chat": {

            const {
              fromId,
              toId,
              accept
            } = data;

            if (
              !fromId ||
              !toId
            ) {
              return;
            }

            if (!accept) {

              const requester =
                users.get(toId);

              if (requester) {

                safeSend(
                  requester.socket,
                  {
                    type:
                      "request-rejected",

                    fromId:
                      fromId,

                    fromName:
                      users.get(fromId)?.name ||
                      "User",

                    fromAvatar:
                      users.get(fromId)?.avatar ||
                      null
                  }
                );
              }

              return;
            }

            const sessionId =
              generateSessionId();

            sessions.set(
              sessionId,
              {
                users: [
                  fromId,
                  toId
                ]
              }
            );

            const userA =
              users.get(fromId);

            const userB =
              users.get(toId);

            if (userA) {

              safeSend(
                userA.socket,
                {
                  type:
                    "chat-start",

                  sessionId:
                    sessionId,

                  peerId:
                    toId,

                  peerName:
                    users.get(toId)?.name ||
                    "User",

                  peerAvatar:
                    users.get(toId)?.avatar ||
                    null
                }
              );
            }

            if (userB) {

              safeSend(
                userB.socket,
                {
                  type:
                    "chat-start",

                  sessionId:
                    sessionId,

                  peerId:
                    fromId,

                  peerName:
                    users.get(fromId)?.name ||
                    "User",

                  peerAvatar:
                    users.get(fromId)?.avatar ||
                    null
                }
              );
            }

            console.log(
              "Session started:",
              sessionId
            );

            break;
          }


          /* ============================================
             WEBRTC SIGNALING
             ============================================ */

          case "signal": {

            const {
              toId,
              signalData
            } = data;

            if (
              !toId ||
              !signalData
            ) {
              return;
            }

            const target =
              users.get(toId);

            if (target) {

              safeSend(
                target.socket,
                {
                  type:
                    "signal",

                  fromId:
                    currentUserId,

                  signalData:
                    signalData
                }
              );

            } else {

              safeSend(
                ws,
                {
                  type:
                    "error",

                  message:
                    "Peer is offline. Call cannot be completed."
                }
              );
            }

            break;
          }


          /* ============================================
             REACTION
             ============================================ */

          case "reaction": {

            const {
              sessionId,
              msgId,
              reaction,
              fromId
            } = data;

            if (
              !sessions.has(sessionId)
            ) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            if (
              !isSessionMember(
                sessionId,
                senderId
              )
            ) {
              return;
            }

            broadcastToSession(
              sessionId,
              {
                type:
                  "reaction",

                msgId:
                  msgId,

                reaction:
                  reaction,

                fromId:
                  senderId
              }
            );

            break;
          }


          /* ============================================
             GROUP REACTION
             ============================================ */

          case "group-reaction": {

            const {
              groupId,
              msgId,
              reaction,
              fromId
            } = data;

            const group =
              groups.get(groupId);

            if (!group) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            if (
              !group.members.includes(
                senderId
              )
            ) {
              return;
            }

            const payload = {
              type:
                "reaction",

              msgId:
                msgId,

              reaction:
                reaction,

              fromId:
                senderId,

              groupId:
                groupId
            };

            group.members.forEach(
              (uid) => {

                if (
                  uid !== senderId
                ) {

                  const user =
                    users.get(uid);

                  if (user) {

                    safeSend(
                      user.socket,
                      payload
                    );
                  }
                }
              }
            );

            break;
          }


          /* ============================================
             TYPING
             ============================================ */

          case "typing": {

            const {
              sessionId,
              fromId,
              isTyping
            } = data;

            if (
              !sessions.has(sessionId)
            ) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            if (
              !isSessionMember(
                sessionId,
                senderId
              )
            ) {
              return;
            }

            broadcastToSession(
              sessionId,
              {
                type:
                  "typing",

                fromId:
                  senderId,

                isTyping:
                  !!isTyping
              }
            );

            break;
          }


          /* ============================================
             CALL REQUEST
             ============================================ */

          case "call-request": {

            const {
              toId,
              callType
            } = data;

            const target =
              users.get(toId);

            if (!target) {

              safeSend(
                ws,
                {
                  type:
                    "call-error",

                  message:
                    "User is offline."
                }
              );

              return;
            }

            safeSend(
              target.socket,
              {
                type:
                  "call-request",

                fromId:
                  currentUserId,

                fromName:
                  users.get(currentUserId)?.name ||
                  "User",

                callType:
                  callType ||
                  "audio"
              }
            );

            break;
          }


          /* ============================================
             CALL RESPONSE
             ============================================ */

          case "call-response": {

            const {
              toId,
              accept,
              callType
            } = data;

            const target =
              users.get(toId);

            if (!target) {

              safeSend(
                ws,
                {
                  type:
                    "call-error",

                  message:
                    "Peer is offline."
                }
              );

              return;
            }

            safeSend(
              target.socket,
              {
                type:
                  "call-response",

                fromId:
                  currentUserId,

                accept:
                  !!accept,

                callType:
                  callType ||
                  null
              }
            );

            break;
          }


          /* ============================================
             MESSAGE ACK
             ============================================ */

          case "message-ack": {

            const {
              toId,
              messageId,
              status
            } = data;

            const target =
              users.get(toId);

            if (target) {

              safeSend(
                target.socket,
                {
                  type:
                    "message-ack",

                  fromId:
                    currentUserId,

                  messageId:
                    messageId,

                  status:
                    status
                }
              );
            }

            break;
          }


          /* ============================================
             KEY EXCHANGE
             ============================================ */

          case "key-exchange": {

            const {
              toId,
              keyData
            } = data;

            const target =
              users.get(toId);

            if (target) {

              safeSend(
                target.socket,
                {
                  type:
                    "key-exchange",

                  fromId:
                    currentUserId,

                  keyData:
                    keyData
                }
              );
            }

            break;
          }


          /* ============================================
             NORMAL MESSAGE
             ============================================ */

          case "message": {

            const {
              sessionId,
              fromId,
              text,
              selfDestruct
            } = data;

            if (
              !sessionId ||
              !text
            ) {
              return;
            }

            if (
              !sessions.has(sessionId)
            ) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            const msgId =
              data.msgId != null &&
              String(data.msgId).length > 0
                ? String(data.msgId)
                : generateMessageId();

            let destructMs =
              Number(selfDestruct);

            if (
              !Number.isFinite(
                destructMs
              ) ||
              destructMs <= 0
            ) {
              destructMs = 0;
            }

            destructMs =
              Math.max(
                0,
                Math.floor(
                  destructMs
                )
              );

            const createdAt =
              Date.now();

            const expiresAt =
              destructMs > 0
                ? createdAt +
                  destructMs
                : null;

            const payload = {

              type:
                "message",

              sessionId:
                sessionId,

              msgId:
                msgId,

              from:
                senderId,

              fromName:
                users.get(senderId)?.name ||
                "Unknown",

              fromAvatar:
                users.get(senderId)?.avatar ||
                null,

              text:
                text,

              timestamp:
                createdAt,

              selfDestruct:
                destructMs,

              expiresAt:
                expiresAt
            };

            broadcastToSession(
              sessionId,
              payload
            );

            if (
              destructMs > 0
            ) {

              scheduleMessageDeletion(
                sessionId,
                msgId,
                destructMs
              );
            }

            console.log(
              "Message:",
              msgId,
              destructMs > 0
                ? `expires in ${destructMs}ms`
                : "persistent"
            );

            break;
          }


          /* ============================================
             EDIT MESSAGE
             ============================================ */

          case "edit-message": {

            const {
              sessionId,
              messageId,
              newText,
              fromId
            } = data;

            if (
              !sessions.has(sessionId)
            ) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            if (
              !isSessionMember(
                sessionId,
                senderId
              )
            ) {
              return;
            }

            broadcastToSession(
              sessionId,
              {
                type:
                  "edit-message",

                id:
                  messageId,

                fromId:
                  senderId,

                newText:
                  newText
              }
            );

            break;
          }


          /* ============================================
             DELETE MESSAGE MANUALLY
             ============================================ */

          case "delete-message": {

            const {
              sessionId,
              id
            } = data;

            if (
              !sessionId ||
              id == null
            ) {
              return;
            }

            if (
              !sessions.has(sessionId)
            ) {
              return;
            }

            if (
              !isSessionMember(
                sessionId,
                currentUserId
              )
            ) {
              return;
            }

            clearMessageTimer(
              sessionId,
              id
            );

            broadcastToSession(
              sessionId,
              {
                type:
                  "delete-message",

                id:
                  id,

                sessionId:
                  sessionId
              }
            );

            break;
          }


          /* ============================================
             END SESSION
             ============================================ */

          case "end-session": {

            const {
              sessionId
            } = data;

            const session =
              sessions.get(sessionId);

            if (!session) {
              return;
            }

            if (
              !session.users.includes(
                currentUserId
              )
            ) {
              return;
            }

            for (
              const [
                key,
                timer
              ]
              of messageTimers.entries()
            ) {

              if (
                key.startsWith(
                  `${sessionId}:`
                )
              ) {

                clearTimeout(timer);

                messageTimers.delete(
                  key
                );
              }
            }

            broadcastToSession(
              sessionId,
              {
                type:
                  "session-ended",

                sessionId:
                  sessionId
              }
            );

            sessions.delete(
              sessionId
            );

            console.log(
              "Session ended:",
              sessionId
            );

            break;
          }


          /* ============================================
             CREATE GROUP
             ============================================ */

          case "create-group": {

            const {
              fromId,
              groupName
            } = data;

            const ownerId =
              fromId ||
              currentUserId;

            if (!ownerId) {
              return;
            }

            const groupId =
              generateGroupId();

            groups.set(
              groupId,
              {
                name:
                  groupName ||
                  "Group Chat",

                members:
                  [ownerId],

                owner:
                  ownerId
              }
            );

            safeSend(
              ws,
              {
                type:
                  "group-created",

                groupId:
                  groupId,

                groupName:
                  groupName ||
                  "Group Chat"
              }
            );

            console.log(
              "Group created:",
              groupId
            );

            break;
          }


          /* ============================================
             JOIN GROUP
             ============================================ */

          case "join-group": {

            const {
              fromId,
              groupId
            } = data;

            const memberId =
              fromId ||
              currentUserId;

            const group =
              groups.get(groupId);

            if (!group) {

              safeSend(
                ws,
                {
                  type:
                    "error",

                  message:
                    "Group not found"
                }
              );

              return;
            }

            if (
              group.members.includes(
                memberId
              )
            ) {

              safeSend(
                ws,
                {
                  type:
                    "group-joined",

                  groupId:
                    groupId,

                  groupName:
                    group.name,

                  members:
                    group.members
                }
              );

              return;
            }

            group.members.push(
              memberId
            );

            safeSend(
              ws,
              {
                type:
                  "group-joined",

                groupId:
                  groupId,

                groupName:
                  group.name,

                members:
                  group.members
              }
            );

            group.members.forEach(
              (uid) => {

                if (
                  uid === memberId
                ) {
                  return;
                }

                const user =
                  users.get(uid);

                if (user) {

                  safeSend(
                    user.socket,
                    {
                      type:
                        "group-user-joined",

                      groupId:
                        groupId,

                      userId:
                        memberId,

                      userName:
                        users.get(memberId)?.name ||
                        "User",

                      userAvatar:
                        users.get(memberId)?.avatar ||
                        null,

                      memberCount:
                        group.members.length
                    }
                  );
                }
              }
            );

            break;
          }


          /* ============================================
             GROUP MESSAGE
             ============================================ */

          case "group-message": {

            const {
              groupId,
              fromId,
              text,
              selfDestruct
            } = data;

            const group =
              groups.get(groupId);

            if (!group) {
              return;
            }

            const senderId =
              fromId ||
              currentUserId;

            if (
              !group.members.includes(
                senderId
              )
            ) {
              return;
            }

            const msgId =
              data.msgId != null &&
              String(data.msgId).length > 0
                ? String(data.msgId)
                : generateMessageId();

            let destructMs =
              Number(selfDestruct);

            if (
              !Number.isFinite(
                destructMs
              ) ||
              destructMs <= 0
            ) {
              destructMs = 0;
            }

            destructMs =
              Math.floor(
                destructMs
              );

            const createdAt =
              Date.now();

            const expiresAt =
              destructMs > 0
                ? createdAt +
                  destructMs
                : null;

            const payload = {

              type:
                "group-message",

              groupId:
                groupId,

              msgId:
                msgId,

              from:
                senderId,

              fromName:
                users.get(senderId)?.name ||
                "Unknown",

              fromAvatar:
                users.get(senderId)?.avatar ||
                null,

              text:
                text,

              timestamp:
                createdAt,

              selfDestruct:
                destructMs,

              expiresAt:
                expiresAt
            };

            group.members.forEach(
              (uid) => {

                if (
                  uid === senderId
                ) {
                  return;
                }

                const user =
                  users.get(uid);

                if (user) {

                  safeSend(
                    user.socket,
                    payload
                  );
                }
              }
            );

            if (
              destructMs > 0
            ) {

              const key =
                `group:${groupId}:${msgId}`;

              const timer =
                setTimeout(
                  () => {

                    group.members.forEach(
                      (uid) => {

                        const user =
                          users.get(uid);

                        if (user) {

                          safeSend(
                            user.socket,
                            {
                              type:
                                "delete-message",

                              id:
                                msgId,

                              groupId:
                                groupId
                            }
                          );
                        }
                      }
                    );

                    messageTimers.delete(
                      key
                    );

                  },
                  destructMs
                );

              messageTimers.set(
                key,
                timer
              );
            }

            break;
          }


          /* ============================================
             UNKNOWN MESSAGE
             ============================================ */

          default: {

            break;
          }
        }
      }
    );


    /* ==================================================
       DISCONNECT CLEANUP
       ================================================== */

    ws.on(
      "close",
      () => {

        if (!currentUserId) {
          return;
        }

        const user =
          users.get(currentUserId);

        if (
          user &&
          user.socket === ws
        ) {

          users.delete(
            currentUserId
          );


          for (
            const [
              sid,
              session
            ]
            of sessions.entries()
          ) {

            if (
              session.users.includes(
                currentUserId
              )
            ) {

              for (
                const [
                  key,
                  timer
                ]
                of messageTimers.entries()
              ) {

                if (
                  key.startsWith(
                    `${sid}:`
                  )
                ) {

                  clearTimeout(
                    timer
                  );

                  messageTimers.delete(
                    key
                  );
                }
              }

              broadcastToSession(
                sid,
                {
                  type:
                    "session-ended",

                  sessionId:
                    sid
                }
              );

              sessions.delete(
                sid
              );
            }
          }


          for (
            const [
              groupId,
              group
            ]
            of groups.entries()
          ) {

            const index =
              group.members.indexOf(
                currentUserId
              );

            if (
              index !== -1
            ) {

              group.members.splice(
                index,
                1
              );

              if (
                group.owner ===
                currentUserId
              ) {

                groups.delete(
                  groupId
                );

                continue;
              }

              group.members.forEach(
                (uid) => {

                  const member =
                    users.get(uid);

                  if (member) {

                    safeSend(
                      member.socket,
                      {
                        type:
                          "group-user-left",

                        groupId:
                          groupId,

                        userId:
                          currentUserId,

                        memberCount:
                          group.members.length
                      }
                    );
                  }
                }
              );

              if (
                group.members.length ===
                0
              ) {

                groups.delete(
                  groupId
                );
              }
            }
          }


          console.log(
            "Disconnected:",
            currentUserId
          );
        }
      }
    );
  }
);


/* ======================================================
   SERVER START
   ====================================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `ShadowChat Relay running on port ${PORT}`
    );

  }
);
