// Meeting room: WebSocket hub for (a) WebRTC signaling between the human
// peers — media itself flows browser-to-browser, P2P mesh — and (b) Forge
// sync events (utterances, whiteboard steps, hand state) so everyone shares
// one meeting. One global room, human count capped by FORGE_MAX_HUMANS.
import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import * as github from "./github.ts";

interface Member {
  id: number;
  name: string;
  /** the browser session id, linking room presence to GitHub sign-ins */
  sid?: string;
  ws: WebSocket;
}

interface JoinMsg { t: "join"; name?: string; sid?: string }
interface SignalMsg { t: "signal"; to: number; data: unknown }
interface CastMsg { t: "cast"; event: unknown }
type ClientMsg = JoinMsg | SignalMsg | CastMsg;

// P2P mesh: every participant streams to every other, so keep this modest —
// upload bandwidth scales linearly with the human count.
const MAX_HUMANS = Math.max(2, Number(process.env.FORGE_MAX_HUMANS) || 6);

// Server-originated room events (repo switches). Wired up by attachRoom;
// a no-op until the room exists.
let roomBroadcast: ((msg: unknown) => void) | null = null;

/** Cast an event to every participant, as if from the server (from: 0). */
export function castToRoom(event: unknown): void {
  roomBroadcast?.({ t: "cast", from: 0, event });
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachRoom(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const members = new Map<number, Member>();
  // When each session was last seen leaving — a sign-in whose session left
  // the room long ago must not hold the meeting's GitHub lock forever.
  const lastLeft = new Map<string, number>();
  let nextId = 1;

  github.setPresenceCheck((sid) => {
    for (const m of members.values()) if (m.sid === sid) return true;
    const left = lastLeft.get(sid);
    // Unknown sessions (never joined the room, e.g. API clients) count as
    // present; a session that left gets a 60s grace for page refreshes.
    return left === undefined ? true : Date.now() - left < 60_000;
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return socket.destroy();
    const expectedToken = process.env.FORGE_ACCESS_TOKEN;
    if (expectedToken) {
      const token = new URL(req.url, "http://localhost").searchParams.get("token");
      if (!tokenMatches(token, expectedToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: unknown, except?: number) => {
    for (const m of members.values()) if (m.id !== except) send(m.ws, msg);
  };
  roomBroadcast = (msg) => broadcast(msg);

  // Heartbeat: Render/Cloudflare proxies drop idle sockets, and silently dead
  // connections would otherwise hold a seat in the two-human room forever.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) { client.terminate(); continue; }
      alive.set(client, false);
      client.ping();
    }
  }, 30_000);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws) => {
    let me: Member | null = null;
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)) as ClientMsg; } catch { return; }

      if (msg.t === "join" && !me) {
        if (members.size >= MAX_HUMANS) { send(ws, { t: "full" }); ws.close(); return; }
        const sid = typeof msg.sid === "string" && /^[\w-]{8,64}$/.test(msg.sid) ? msg.sid : undefined;
        me = { id: nextId++, name: String(msg.name || "Guest").slice(0, 24), sid, ws };
        members.set(me.id, me);
        if (sid) lastLeft.delete(sid);
        send(ws, { t: "welcome", id: me.id, peers: [...members.values()].filter((m) => m.id !== me!.id).map((m) => ({ id: m.id, name: m.name })) });
        broadcast({ t: "peer-joined", id: me.id, name: me.name }, me.id);
        console.log(`room: ${me.name}#${me.id} joined (${members.size}/${MAX_HUMANS})`);
        return;
      }
      if (!me) return;

      if (msg.t === "signal") {
        const target = members.get(msg.to);
        if (target) send(target.ws, { t: "signal", from: me.id, data: msg.data });
      } else if (msg.t === "cast") {
        broadcast({ t: "cast", from: me.id, event: msg.event }, me.id);
      }
    });

    ws.on("close", () => {
      if (!me) return;
      members.delete(me.id);
      // Only stamp the departure if no other tab of the same session remains.
      if (me.sid && ![...members.values()].some((m) => m.sid === me!.sid)) lastLeft.set(me.sid, Date.now());
      broadcast({ t: "peer-left", id: me.id });
      console.log(`room: ${me.name}#${me.id} left (${members.size}/${MAX_HUMANS})`);
    });
  });
}
