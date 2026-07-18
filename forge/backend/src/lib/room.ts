// Meeting room: WebSocket hub for (a) WebRTC signaling between the two human
// peers — media itself flows browser-to-browser, P2P — and (b) Forge sync
// events (utterances, whiteboard steps, hand state) so both sides share one
// meeting. One global room, capped at two humans (hackathon scope).
import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";

interface Member {
  id: number;
  name: string;
  ws: WebSocket;
}

interface JoinMsg { t: "join"; name?: string }
interface SignalMsg { t: "signal"; to: number; data: unknown }
interface CastMsg { t: "cast"; event: unknown }
type ClientMsg = JoinMsg | SignalMsg | CastMsg;

const MAX_HUMANS = 2;

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachRoom(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const members = new Map<number, Member>();
  let nextId = 1;

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
        me = { id: nextId++, name: String(msg.name || "Guest").slice(0, 24), ws };
        members.set(me.id, me);
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
      broadcast({ t: "peer-left", id: me.id });
      console.log(`room: ${me.name}#${me.id} left (${members.size}/${MAX_HUMANS})`);
    });
  });
}
