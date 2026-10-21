// Simulates a stadium: N phones on WebSocket (+ the backup snapshot poll), one operator
// starting a track and re-anchoring. Reports how long each broadcast takes to reach phones.
//
//   node scripts/load-test.mjs --url http://127.0.0.1:3202 --clients 1000
//   node scripts/load-test.mjs --url https://flash-api-dkiqeq.fly.dev --clients 1000
//
// Uses its own room (default "loadtest") so a live show in "main" is not touched.
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg("url", "http://127.0.0.1:3202").replace(/\/$/, "");
const WS_URL = BASE.replace(/^http/, "ws");
const CLIENTS = Number(arg("clients", "1000"));
const RAMP_MS = Number(arg("ramp-ms", "15000"));
const ROOM = arg("room", "loadtest");
const POLL_MS = Number(arg("poll-ms", "4000"));
const REANCHORS = Number(arg("reanchors", "5"));
const FULL_CUES = arg("full-cues", "0") === "1";
const USER = arg("user", process.env.SHOW_OPERATOR_USER || "istiklal_admin");
const PASS = arg("pass", process.env.SHOW_OPERATOR_PASS || "istiklal2024_dj");
const isRemote = !BASE.includes("127.0.0.1") && !BASE.includes("localhost");
const DEADLINE_MS = Number(arg("deadline-ms", isRemote ? "60000" : "10000"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stats(values) {
  if (values.length === 0) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return `n=${sorted.length} p50=${at(0.5).toFixed(0)}ms p95=${at(0.95).toFixed(0)}ms max=${sorted.at(-1).toFixed(0)}ms`;
}

const phones = [];
const welcomeMs = [];
const snapshotMs = [];
let snapshotErrors = 0;
let connectErrors = 0;
let disconnects = 0;
let operatorCount = 0;

/** Pending broadcast probe: version we wait for → send time and per-phone arrival. */
let probe = null;

function openPhone(index) {
  return new Promise((resolve) => {
    const started = performance.now();
    const ws = new WebSocket(WS_URL);
    const phone = { index, ws, version: 0, open: false, pollTimer: null, syncTimer: null };
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok) connectErrors += 1;
      resolve(ok ? phone : null);
    };
    const timeout = setTimeout(() => {
      ws.terminate();
      done(false);
    }, 15_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", role: "audience", roomId: ROOM }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "welcome") {
        clearTimeout(timeout);
        phone.open = true;
        phone.version = msg.version ?? 0;
        welcomeMs.push(performance.now() - started);
        startPhoneTimers(phone);
        done(true);
        return;
      }
      if ((msg.type === "state" || msg.type === "anchor") && typeof msg.version === "number") {
        phone.version = msg.version;
        if (probe && msg.version >= probe.version && !probe.arrived.has(index)) {
          probe.arrived.set(index, performance.now() - probe.sentAt);
        }
      }
    });
    ws.on("close", () => {
      if (phone.open) disconnects += 1;
      phone.open = false;
      clearInterval(phone.pollTimer);
      clearInterval(phone.syncTimer);
    });
    ws.on("error", () => {
      clearTimeout(timeout);
      done(false);
    });
  });
}

function startPhoneTimers(phone) {
  phone.syncTimer = setInterval(() => {
    if (phone.ws.readyState === 1) phone.ws.send(JSON.stringify({ type: "sync", t0: Date.now() }));
  }, 4000);
  if (POLL_MS <= 0) return;
  setTimeout(() => {
    phone.pollTimer = setInterval(() => void pollSnapshot(phone), POLL_MS);
  }, Math.random() * POLL_MS);
}

async function pollSnapshot(phone) {
  const started = performance.now();
  const query = new URLSearchParams({
    room: ROOM,
    clientId: `lt${phone.index}`,
    t0: String(Date.now()),
    v: String(phone.version),
    ws: "1",
  });
  try {
    const res = await fetch(`${BASE}/snapshot?${query}`, { cache: "no-store" });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(String(res.status));
    snapshotMs.push(performance.now() - started);
  } catch {
    snapshotErrors += 1;
  }
}

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const data = await res.json();
  if (!data.token) {
    throw new Error(
      `Giriş başarısız: ${data.error ?? res.status}. ` +
        `Fly'daki SHOW_OPERATOR_USER / SHOW_OPERATOR_PASS ile aynı olmalı. ` +
        `Örnek: npm run load-test -- --url ${BASE} --clients 1000 --user KULLANICI --pass SIFRE`,
    );
  }
  return data.token;
}

async function command(token, msg) {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...msg, token, roomId: ROOM }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`command ${msg.type} failed: ${data.error ?? res.status}`);
  return data;
}

async function measureBroadcast(label, token, msg) {
  const expected = phones.filter((p) => p.open).length;
  const current = Math.max(0, ...phones.map((p) => p.version));
  probe = { version: current + 1, sentAt: performance.now(), arrived: new Map() };
  await command(token, msg);
  const deadline = performance.now() + DEADLINE_MS;
  while (probe.arrived.size < expected && performance.now() < deadline) await sleep(25);
  const times = [...probe.arrived.values()];
  console.log(
    `  ${label.padEnd(12)} ulaştı ${String(times.length).padStart(4)}/${expected}  ${stats(times)}`,
  );
  probe = null;
  return { expected, reached: times.length, times };
}

function demoCues() {
  const cues = [];
  const count = FULL_CUES ? 208 : 48;
  for (let i = 0; i < count; i += 1) cues.push({ atMs: 13_000 + i * 395, onMs: 120 });
  return cues;
}

async function main() {
  console.log(
    `Hedef: ${BASE}  oda: ${ROOM}  telefon: ${CLIENTS}  ramp: ${RAMP_MS}ms  poll: ${POLL_MS}ms  deadline: ${DEADLINE_MS}ms`,
  );
  const health = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`${BASE}/health cevap vermiyor`);

  const token = await login();
  const operator = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    operator.on("open", () => {
      operator.send(JSON.stringify({ type: "hello", role: "operator", roomId: ROOM, token }));
      resolve();
    });
    operator.on("error", reject);
  });
  operator.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (typeof msg.audienceCount === "number") operatorCount = msg.audienceCount;
  });

  console.log("\n1) Telefonlar bağlanıyor…");
  const rampStart = performance.now();
  const gap = RAMP_MS / CLIENTS;
  const pending = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    pending.push(openPhone(i).then((phone) => phone && phones.push(phone)));
    if (gap > 0) await sleep(gap);
  }
  await Promise.all(pending);
  console.log(
    `  bağlı ${phones.length}/${CLIENTS}  hata ${connectErrors}  süre ${((performance.now() - rampStart) / 1000).toFixed(1)}s`,
  );
  console.log(`  welcome     ${stats(welcomeMs)}`);
  await sleep(2500);
  console.log(`  operatörün gördüğü izleyici sayısı: ${operatorCount}`);

  console.log("\n2) Yayın gecikmesi (komut gönderildi → telefona ulaştı)");
  const results = [];
  results.push(
    await measureBroadcast("playTrack", token, {
      type: "playTrack",
      startedAtServerMs: Date.now() + 500,
      bpm: 152,
      cues: demoCues(),
    }),
  );
  for (let i = 0; i < REANCHORS; i += 1) {
    await sleep(2000);
    results.push(
      await measureBroadcast(`reanchor ${i + 1}`, token, {
        type: "reanchor",
        startedAtServerMs: Date.now() - 1000 - i * 50,
      }),
    );
  }
  await sleep(1000);
  results.push(await measureBroadcast("stop", token, { type: "stop" }));

  console.log("\n3) Yedek snapshot poll");
  console.log(`  snapshot    ${stats(snapshotMs)}  hata ${snapshotErrors}`);
  console.log(`  bağlantı kopması: ${disconnects}`);

  const all = results.flatMap((r) => r.times);
  const missed = results.reduce((sum, r) => sum + (r.expected - r.reached), 0);
  const sorted = [...all].sort((a, b) => a - b);
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)] ?? Infinity;
  const ok =
    phones.length >= CLIENTS * 0.98 &&
    missed <= Math.max(5, Math.floor(CLIENTS * 0.02)) &&
    p95 < (isRemote ? 8000 : 1000) &&
    disconnects <= Math.max(5, Math.floor(CLIENTS * 0.05));
  console.log(`\nSONUÇ: ${ok ? "GEÇTİ" : "KALDI"}  (yayın p95 ${p95.toFixed(0)}ms, kaçırılan ${missed})`);

  for (const phone of phones) phone.ws.close();
  operator.close();
  await sleep(500);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
