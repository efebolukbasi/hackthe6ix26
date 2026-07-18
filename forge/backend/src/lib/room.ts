// Meeting room: WebSocket hub for (a) WebRTC signaling between the two human
// peers — media itself flows browser-to-browser, P2P — and (b) Forge sync
// events (utterances, whiteboard steps, hand state) so both sides share one
// meeting. One global room, capped at two humans (hackathon scope).
import { WebSocketServer, WebSocket } from "ws";
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

export function attachRoom(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const members = new Map<number, Member>();
  let nextId = 1;

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: unknown, except?: number) => {
    for (const m of members.values()) if (m.id !== except) send(m.ws, msg);
  };

  wss.on("connection", (ws) => {
    let me: Member | null = null;

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
