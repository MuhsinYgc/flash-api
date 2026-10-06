import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { WebSocketServer } from "ws";
import { fetchYouTubeTitle, isVideoId, loadYouTubeAudio } from "./youtube-audio.mjs";

const PORT = Number(process.env.SHOW_WS_PORT ?? 3202);
const MIN_FLASH_GAP_MS = 334;
const PLAY_LEAD_MS = 420;
const MANUAL_FLASH_LEAD_MS = 280;
const DEFAULT_ROOM = "main";
const MAX_TRACK_MS = 3 * 60 * 60 * 1000;
const MAX_COMMAND_BYTES = 1_500_000;
const OPERATOR_USER = process.env.SHOW_OPERATOR_USER || "istiklal_admin";
const OPERATOR_PASS = process.env.SHOW_OPERATOR_PASS || "istiklal2024_dj";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** @typedef {"beat" | "pulse" | "hold" | "timeline"} Pattern */
/** @typedef {{ atMs: number, onMs: number, color?: string }} TimelineCue */
/** @typedef {{ playing: boolean, startedAtServerMs: number | null, bpm: number, color: string, pattern: Pattern, timeline: TimelineCue[] }} ShowState */
/** @typedef {{ ws: import("ws").WebSocket, id: string, role: "audience" | "operator", roomId: string }} Client */

const ALLOWED_COLORS = {
  white: "#ffffff",
  gold: "#ffe566",
  cyan: "#7ee0ff",
  green: "#8cffb0",
};

function sanitizeColor(value) {
  if (typeof value !== "string") return "#ffffff";
  const named = ALLOWED_COLORS[value.toLowerCase()];
  if (named) return named;
  const hex = value.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return "#ffffff";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (r > 180 && g < 80 && b < 80) return "#ffe566";
  return hex;
}

function sanitizeRoomId(value) {
  if (typeof value !== "string") return DEFAULT_ROOM;
  const id = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return id || DEFAULT_ROOM;
}

function clampBpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 120;
  return Math.min(170, Math.max(60, Math.round(n)));
}

function clampAnchor(value, now) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return null;
  return Math.min(now + 4000, Math.max(now - MAX_TRACK_MS, Math.round(requested)));
}

function demoTimeline(bpm = 120) {
  const beat = 60000 / bpm;
  /** @type {TimelineCue[]} */
  const cues = [];
  for (let i = 0; i < 16; i += 1) {
    cues.push({ atMs: Math.round(i * beat), onMs: 80, color: "#ffffff" });
  }
  for (let i = 0; i < 4; i += 1) {
    cues.push({
      atMs: Math.round(16 * beat + i * beat * 2),
      onMs: 160,
      color: "#ffe566",
    });
  }
  return cues;
}

function sanitizeTimeline(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 4096)
    .map((cue) => {
      const atMs = Number(cue?.atMs);
      const onMs = Number(cue?.onMs);
      if (!Number.isFinite(atMs) || !Number.isFinite(onMs)) return null;
      return {
        atMs: Math.max(0, Math.round(atMs)),
        onMs: Math.min(2000, Math.max(40, Math.round(onMs))),
        color: sanitizeColor(cue?.color),
      };
    })
    .filter(Boolean);
}

function defaultState() {
  /** @type {ShowState} */
  const state = {
    playing: false,
    startedAtServerMs: null,
    bpm: 120,
    color: "#ffffff",
    pattern: "timeline",
    timeline: [],
  };
  return state;
}

/** @type {Map<string, { lastSeen: number, roomId: string }>} */
const httpViewers = new Map();

/** @type {Map<string, { expires: number }>} */
const operatorTokens = new Map();

/** @type {Map<string, { count: number, windowStart: number }>} */
const rateBuckets = new Map();

/** @type {Map<string, { clients: Set<Client>, state: ShowState, lastFlashAt: number, flashes: { atServerMs: number, onMs: number, color: string }[] }>} */
const rooms = new Map();

function getRoom(roomId) {
  const id = sanitizeRoomId(roomId);
  let room = rooms.get(id);
  if (!room) {
    room = { clients: new Set(), state: defaultState(), lastFlashAt: 0, flashes: [] };
    rooms.set(id, room);
  }
  return { id, room };
}

function pruneHttpViewers(now = Date.now()) {
  for (const [id, viewer] of httpViewers) {
    if (now - viewer.lastSeen > 10_000) httpViewers.delete(id);
  }
}

function audienceCount(room, roomId) {
  pruneHttpViewers();
  let count = 0;
  for (const client of room.clients) {
    if (client.role === "audience") count += 1;
  }
  for (const viewer of httpViewers.values()) {
    if (viewer.roomId === roomId) count += 1;
  }
  return count;
}

function send(ws, payload) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, except) {
  const raw = JSON.stringify(payload);
  for (const client of room.clients) {
    if (except && client.id === except) continue;
    if (client.ws.readyState === 1) client.ws.send(raw);
  }
}

function statePayload(room, roomId, extra = {}) {
  return {
    type: "state",
    state: room.state,
    audienceCount: audienceCount(room, roomId),
    serverNow: Date.now(),
    ...extra,
  };
}

function applyOperatorCommand(entry, roomId, msg) {
  const now = Date.now();

  if (msg.type === "play") {
    entry.state.playing = true;
    entry.state.startedAtServerMs = now + PLAY_LEAD_MS;
    if (entry.state.pattern === "timeline" && entry.state.timeline.length === 0) {
      entry.state.timeline = demoTimeline(entry.state.bpm);
    }
    broadcast(entry, statePayload(entry, roomId));
    return "play";
  }

  if (msg.type === "stop") {
    entry.state.playing = false;
    entry.state.startedAtServerMs = null;
    broadcast(entry, statePayload(entry, roomId));
    return "stop";
  }

  if (msg.type === "setBpm") {
    entry.state.bpm = clampBpm(msg.bpm);
    broadcast(entry, statePayload(entry, roomId));
    return "setBpm";
  }

  if (msg.type === "setColor") {
    entry.state.color = sanitizeColor(msg.color);
    broadcast(entry, statePayload(entry, roomId));
    return "setColor";
  }

  if (msg.type === "setPattern") {
    const next = msg.pattern;
    if (next === "beat" || next === "pulse" || next === "hold" || next === "timeline") {
      entry.state.pattern = next;
      if (next === "timeline" && entry.state.timeline.length === 0) {
        entry.state.timeline = demoTimeline(entry.state.bpm);
      }
      broadcast(entry, statePayload(entry, roomId));
      return "setPattern";
    }
    return "ignored";
  }

  if (msg.type === "setTimeline") {
    entry.state.timeline = sanitizeTimeline(msg.cues);
    entry.state.pattern = "timeline";
    broadcast(entry, statePayload(entry, roomId));
    return "setTimeline";
  }

  if (msg.type === "playTrack") {
    if (Array.isArray(msg.cues) && msg.cues.length > 0) {
      entry.state.timeline = sanitizeTimeline(msg.cues);
    }
    entry.state.startedAtServerMs = clampAnchor(msg.startedAtServerMs, now) ?? now + PLAY_LEAD_MS;
    if (msg.bpm != null) entry.state.bpm = clampBpm(msg.bpm);
    entry.state.pattern = "timeline";
    entry.state.playing = true;
    broadcast(entry, statePayload(entry, roomId));
    return "playTrack";
  }

  if (msg.type === "reanchor") {
    if (!entry.state.playing) return "ignored";
    const anchored = clampAnchor(msg.startedAtServerMs, now);
    if (anchored == null) return "ignored";
    entry.state.startedAtServerMs = anchored;
    broadcast(entry, statePayload(entry, roomId));
    return "reanchor";
  }

  if (msg.type === "flash") {
    if (now - entry.lastFlashAt < MIN_FLASH_GAP_MS) return "rate-limited";
    entry.lastFlashAt = now;
    const onMs = Math.min(400, Math.max(80, Number(msg.onMs) || 160));
    const flash = {
      type: "flash",
      atServerMs: now + MANUAL_FLASH_LEAD_MS,
      onMs,
      color: entry.state.color,
    };
    entry.flashes.push(flash);
    broadcast(entry, flash);
    return "flash";
  }

  return "unknown";
}

function videoIdFrom(url) {
  const videoId = url.searchParams.get("videoId") ?? "";
  return isVideoId(videoId) ? videoId : "";
}

async function serveYouTubeInfo(res, url) {
  const videoId = videoIdFrom(url);
  if (!videoId) {
    json(res, 400, { ok: false, error: "YouTube linki değil." });
    return;
  }
  try {
    const title = await fetchYouTubeTitle(videoId);
    json(res, 200, { ok: true, videoId, title });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Video bulunamadı.";
    json(res, 404, { ok: false, error: message });
  }
}

async function serveYouTubeAudio(res, url) {
  const videoId = videoIdFrom(url);
  if (!videoId) {
    json(res, 400, { ok: false, error: "YouTube linki değil." });
    return;
  }
  try {
    const audio = await loadYouTubeAudio(videoId);
    if (res.destroyed) return;
    res.writeHead(200, {
      "content-type": audio.contentType,
      "content-length": audio.size,
      "cache-control": "private, max-age=1800",
      "access-control-allow-origin": "*",
    });
    const stream = createReadStream(audio.filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        json(res, 502, { ok: false, error: "Ses okunamadı." });
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const message = error instanceof Error ? error.message : "Ses indirilemedi.";
    json(res, 502, { ok: false, error: message });
  }
}

function ipScore(address) {
  if (address.startsWith("192.168.")) return 30;
  if (address.startsWith("10.")) return 20;
  if (address.startsWith("172.")) return 10;
  return 0;
}

function lanIpv4Addresses() {
  /** @type {string[]} */
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      out.push(addr.address);
    }
  }
  return [...new Set(out)].sort((a, b) => ipScore(b) - ipScore(a));
}

function networkHintPayload(port, proto) {
  const safePort = /^\d{2,5}$/.test(port) ? port : "3200";
  const scheme = proto === "http" ? "http" : "https";
  const origins = lanIpv4Addresses().map((ip) => `${scheme}://${ip}:${safePort}`);
  return {
    ok: true,
    origins,
    recommended: origins[0] ?? "",
  };
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function rateLimit(ip, key, max, windowMs) {
  const id = `${key}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(id);
  if (!bucket || now - bucket.windowStart > windowMs) {
    rateBuckets.set(id, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function credentialsOk(username, password) {
  return safeEqual(username, OPERATOR_USER) && safeEqual(password, OPERATOR_PASS);
}

function pruneTokens(now = Date.now()) {
  for (const [token, row] of operatorTokens) {
    if (row.expires <= now) operatorTokens.delete(token);
  }
}

function issueToken() {
  pruneTokens();
  const token = randomBytes(24).toString("hex");
  operatorTokens.set(token, { expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

function tokenOk(token) {
  if (typeof token !== "string" || !token) return false;
  pruneTokens();
  const row = operatorTokens.get(token);
  return Boolean(row && row.expires > Date.now());
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, { ok: true, service: "show-ws", time: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/network-hint") {
    const port = url.searchParams.get("port") ?? "3200";
    const proto = url.searchParams.get("proto") ?? "https";
    json(res, 200, networkHintPayload(port, proto));
    return;
  }

  if (url.pathname === "/sync") {
    const t1 = Date.now();
    json(res, 200, {
      type: "pong",
      t0: Number(url.searchParams.get("t0")) || 0,
      t1,
      t2: Date.now(),
    });
    return;
  }

  if (url.pathname === "/snapshot") {
    const t0 = Number(url.searchParams.get("t0")) || 0;
    const t1 = Date.now();
    const { id, room } = getRoom(url.searchParams.get("room") ?? DEFAULT_ROOM);
    const clientId = String(url.searchParams.get("clientId") ?? "").slice(0, 40);
    const asOperator = url.searchParams.get("role") === "operator";
    const isNew = Boolean(clientId) && !asOperator && !httpViewers.has(clientId);
    if (clientId && !asOperator) {
      httpViewers.set(clientId, { lastSeen: Date.now(), roomId: id });
    }
    if (isNew) {
      broadcast(room, statePayload(room, id));
    }
    const now = Date.now();
    room.flashes = room.flashes.filter((flash) => flash.atServerMs + flash.onMs > now - 250);
    json(res, 200, {
      type: "state",
      clientId,
      roomId: id,
      state: room.state,
      audienceCount: audienceCount(room, id),
      serverNow: now,
      flashes: room.flashes,
      t0,
      t1,
      t2: Date.now(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const ip = clientIp(req);
    if (!rateLimit(ip, "login", 8, 60_000)) {
      json(res, 429, { ok: false, error: "Çok fazla deneme." });
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4000) req.destroy();
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        json(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      if (!credentialsOk(body.username, body.password)) {
        json(res, 401, { ok: false, error: "Kullanıcı adı veya şifre yanlış." });
        return;
      }
      json(res, 200, { ok: true, token: issueToken() });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/youtube/info") {
    if (!rateLimit(clientIp(req), "yt-info", 30, 60_000)) {
      json(res, 429, { ok: false, error: "Çok fazla istek." });
      return;
    }
    void serveYouTubeInfo(res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/youtube/audio") {
    if (!rateLimit(clientIp(req), "yt-audio", 8, 60_000)) {
      json(res, 429, { ok: false, error: "Çok fazla istek." });
      return;
    }
    void serveYouTubeAudio(res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/command") {
    const ip = clientIp(req);
    if (!rateLimit(ip, "command", 40, 10_000)) {
      json(res, 429, { ok: false, error: "Çok fazla komut." });
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_COMMAND_BYTES) req.destroy();
    });
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(raw || "{}");
      } catch {
        json(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      if (!tokenOk(msg.token)) {
        json(res, 401, { ok: false, error: "Operator girişi gerekli." });
        return;
      }
      const { id, room } = getRoom(msg.roomId ?? url.searchParams.get("room") ?? DEFAULT_ROOM);
      const result = applyOperatorCommand(room, id, msg);
      json(res, 200, { ok: true, ...statePayload(room, id), applied: result });
    });
    return;
  }

  res.writeHead(404, { "access-control-allow-origin": "*" });
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
let nextClientId = 1;

wss.on("connection", (ws) => {
  /** @type {Client} */
  const client = {
    ws,
    id: `c${nextClientId++}`,
    role: "audience",
    roomId: DEFAULT_ROOM,
  };
  let joined = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "sync") {
      const t1 = Date.now();
      send(ws, { type: "pong", t0: Number(msg.t0) || 0, t1, t2: Date.now() });
      return;
    }

    if (msg.type === "hello") {
      const { id, room } = getRoom(msg.roomId);
      if (msg.role === "operator" && !tokenOk(msg.token)) {
        send(ws, { type: "error", message: "Operator girişi gerekli." });
        return;
      }
      if (joined) {
        const prev = rooms.get(client.roomId);
        prev?.clients.delete(client);
        if (prev) broadcast(prev, statePayload(prev, client.roomId));
      }
      client.role = msg.role === "operator" ? "operator" : "audience";
      client.roomId = id;
      room.clients.add(client);
      joined = true;
      send(ws, {
        type: "welcome",
        clientId: client.id,
        roomId: id,
        serverNow: Date.now(),
        state: room.state,
        audienceCount: audienceCount(room, id),
      });
      broadcast(room, statePayload(room, id), client.id);
      return;
    }

    if (!joined) {
      send(ws, { type: "error", message: "Say hello first." });
      return;
    }

    const entry = rooms.get(client.roomId);
    if (!entry) return;

    if (client.role !== "operator") {
      send(ws, { type: "error", message: "Operator only." });
      return;
    }

    applyOperatorCommand(entry, client.roomId, msg);
  });

  ws.on("close", () => {
    const entry = rooms.get(client.roomId);
    if (!entry) return;
    entry.clients.delete(client);
    broadcast(entry, statePayload(entry, client.roomId));
    if (entry.clients.size === 0 && client.roomId !== DEFAULT_ROOM) {
      rooms.delete(client.roomId);
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`show-ws listening on ws://0.0.0.0:${PORT}`);
});
