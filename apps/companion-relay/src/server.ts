import { WebSocket, WebSocketServer } from "ws";

interface PeerState {
  authenticated: boolean;
  deviceId: string;
  peerId: string;
  role: "core" | "client" | "worker" | "";
  authToken: string;
  timer: NodeJS.Timeout;
}

interface DeviceRoom {
  authToken: string;
  core: WebSocket | null;
  clients: Map<string, WebSocket>;
  workers: Map<string, WebSocket>;
}

function cleanId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,80}$/u.test(value) ? value : "";
}

function send(socket: WebSocket, event: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

export class CompanionRelayServer {
  private readonly host: string;
  private readonly port: number;
  private server: WebSocketServer | null = null;
  private readonly peers = new Map<WebSocket, PeerState>();
  private readonly rooms = new Map<string, DeviceRoom>();

  constructor({ host = "127.0.0.1", port = 8876 }: { host?: string; port?: number } = {}) {
    this.host = host;
    this.port = port;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.server) throw new Error("Companion relay is already running");
    const server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 64 * 1024 });
    this.server = server;
    server.on("connection", (socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    console.log(`[companion-relay] listening on ws://${this.host}:${this.address()?.port ?? this.port}`);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    for (const socket of this.peers.keys()) socket.close(1001, "Relay shutting down");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.peers.clear();
    this.rooms.clear();
    this.server = null;
  }

  address(): { port: number } | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? { port: address.port } : null;
  }

  private accept(socket: WebSocket): void {
    const timer = setTimeout(() => socket.close(4001, "Authentication timeout"), 5000);
    const state: PeerState = { authenticated: false, deviceId: "", peerId: "", role: "", authToken: "", timer };
    this.peers.set(socket, state);
    send(socket, { type: "relay.hello", protocol: 1 });
    socket.on("message", (raw) => this.receive(socket, state, String(raw)));
    socket.on("error", () => undefined);
    socket.on("close", () => this.remove(socket, state));
  }

  private receive(socket: WebSocket, state: PeerState, raw: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return send(socket, { type: "relay.error", code: "invalid_json" }); }
    if (!state.authenticated) return this.authenticate(socket, state, event);
    if (event.type === "relay.ping") return send(socket, { type: "relay.pong", at: Date.now() });
    if (event.type !== "relay.frame" || event.deviceId !== state.deviceId || event.senderId !== state.peerId) {
      return send(socket, { type: "relay.error", code: "invalid_frame" });
    }
    const room = this.rooms.get(state.deviceId);
    if (!room) return;
    if (state.role === "client" || state.role === "worker") {
      if (event.recipientId !== "core") return send(socket, { type: "relay.error", code: "client_route_denied" });
      if (room.core) send(room.core, event);
      else send(socket, { type: "relay.peer_offline", peerId: "core" });
      return;
    }
    const recipientId = typeof event.recipientId === "string" ? event.recipientId : "";
    if (recipientId === "*") {
      for (const client of room.clients.values()) send(client, event);
      for (const worker of room.workers.values()) send(worker, event);
    } else {
      const peer = room.clients.get(recipientId) ?? room.workers.get(recipientId);
      if (peer) send(peer, event);
    }
  }

  private authenticate(socket: WebSocket, state: PeerState, event: Record<string, unknown>): void {
    const deviceId = cleanId(event.deviceId);
    const peerId = cleanId(event.peerId);
    const role = event.role === "core" || event.role === "client" || event.role === "worker" ? event.role : "";
    const authToken = typeof event.authToken === "string" && event.authToken.length >= 32 ? event.authToken : "";
    if (event.type !== "relay.auth" || !deviceId || !peerId || !role || !authToken) {
      send(socket, { type: "relay.auth.error", message: "Relay credentials are invalid" });
      return socket.close(4003, "Authentication failed");
    }
    let room = this.rooms.get(deviceId);
    if (!room) {
      if (role !== "core") {
        send(socket, { type: "relay.auth.error", message: "Core is not registered" });
        return socket.close(4004, "Core is offline");
      }
      room = { authToken, core: null, clients: new Map(), workers: new Map() };
      this.rooms.set(deviceId, room);
    }
    if (room.authToken !== authToken) {
      send(socket, { type: "relay.auth.error", message: "Relay credentials are invalid" });
      return socket.close(4003, "Authentication failed");
    }
    if (role === "core") {
      if (room.core && room.core !== socket) room.core.close(4000, "Core reconnected");
      room.core = socket;
    } else if (role === "client") {
      const previous = room.clients.get(peerId);
      if (previous && previous !== socket) previous.close(4000, "Client reconnected");
      room.clients.set(peerId, socket);
      if (room.core) send(room.core, { type: "relay.peer_online", peerId, role });
    } else {
      const previous = room.workers.get(peerId);
      if (previous && previous !== socket) previous.close(4000, "Worker reconnected");
      room.workers.set(peerId, socket);
      if (room.core) send(room.core, { type: "relay.peer_online", peerId, role });
    }
    clearTimeout(state.timer);
    Object.assign(state, { authenticated: true, deviceId, peerId, role, authToken });
    send(socket, { type: "relay.auth.ok", deviceId, peerId, coreOnline: Boolean(room.core) });
    if (role === "core") {
      // A replacement Core needs a complete peer inventory immediately. This
      // makes a Core restart or migration independent of the order in which
      // existing clients and workers happened to reconnect.
      for (const clientId of room.clients.keys()) send(socket, { type: "relay.peer_online", peerId: clientId, role: "client" });
      for (const workerId of room.workers.keys()) send(socket, { type: "relay.peer_online", peerId: workerId, role: "worker" });
      for (const client of room.clients.values()) send(client, { type: "relay.peer_online", peerId: "core", role: "core" });
      for (const worker of room.workers.values()) send(worker, { type: "relay.peer_online", peerId: "core", role: "core" });
    }
  }

  private remove(socket: WebSocket, state: PeerState): void {
    clearTimeout(state.timer);
    this.peers.delete(socket);
    if (!state.authenticated) return;
    const room = this.rooms.get(state.deviceId);
    if (!room) return;
    if (state.role === "core" && room.core === socket) {
      room.core = null;
      for (const client of room.clients.values()) send(client, { type: "relay.peer_offline", peerId: "core" });
      for (const worker of room.workers.values()) send(worker, { type: "relay.peer_offline", peerId: "core" });
    }
    if (state.role === "client" && room.clients.get(state.peerId) === socket) {
      room.clients.delete(state.peerId);
      if (room.core) send(room.core, { type: "relay.peer_offline", peerId: state.peerId });
    }
    if (state.role === "worker" && room.workers.get(state.peerId) === socket) {
      room.workers.delete(state.peerId);
      if (room.core) send(room.core, { type: "relay.peer_offline", peerId: state.peerId, role: "worker" });
    }
    if (!room.core && room.clients.size === 0 && room.workers.size === 0) this.rooms.delete(state.deviceId);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const port = Number(process.env.COMPANION_RELAY_PORT ?? 8876);
  const relay = new CompanionRelayServer({ host: process.env.COMPANION_RELAY_HOST || "127.0.0.1", port });
  relay.run(controller.signal).catch((error) => {
    console.error(`[companion-relay] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
