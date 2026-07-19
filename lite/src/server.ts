import express, { type Request, type Response, type NextFunction } from "express";
import fs from "fs";
import path from "path";
import { config, FEATURE_LABELS, defaultFeatureSettings, type FeatureId } from "./config";
import { store } from "./store";
import { loginAccount, refreshAccountInfo } from "./auth";
import {
  getRuntimeStats,
  resumeWantedAccounts,
  startAccount,
  startAll,
  stopAccount,
  stopAll,
} from "./orchestrator";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

/** Tìm thư mục public (tsx/__dirname vs cwd khác nhau trên Render) */
function resolvePublicDir(): string {
  const candidates = [
    path.join(__dirname, "..", "public"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "lite", "public"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}

const publicDir = resolvePublicDir();
const indexHtml = path.join(publicDir, "index.html");

// ---- keep-alive / health (public, không cần API key) ----
const startedAt = Date.now();
let lastPingAt = 0;
let pingCount = 0;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "auto-game-lite",
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(startedAt).toISOString(),
    lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
    pingCount,
    publicDir,
    indexHtmlExists: fs.existsSync(indexHtml),
    cwd: process.cwd(),
    stats: getRuntimeStats(),
  });
});

app.get("/ping", (_req, res) => {
  lastPingAt = Date.now();
  pingCount += 1;
  res.status(200).type("text").send("pong");
});

app.head("/ping", (_req, res) => {
  lastPingAt = Date.now();
  pingCount += 1;
  res.status(200).end();
});

// ---- auth middleware chỉ cho /api ----
function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKey) return next();
  const key =
    String(req.headers["x-api-key"] || "") ||
    String(req.query.key || "") ||
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (key !== config.apiKey) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Gửi header x-api-key hoặc ?key=LITE_API_KEY",
    });
  }
  return next();
}

app.use("/api", requireKey);

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    features: FEATURE_LABELS,
    defaultSettings: defaultFeatureSettings(),
    stats: getRuntimeStats(),
    lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
    pingCount,
    hasApiKey: Boolean(config.apiKey),
  });
});

app.get("/api/accounts", (_req, res) => {
  res.json({ ok: true, accounts: store.listPublic() });
});

app.post("/api/accounts", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  const enabled: FeatureId[] | undefined = Array.isArray(req.body?.enabled)
    ? req.body.enabled
    : undefined;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Thiếu email/password" });
  }
  const acc = store.addAccount(email, password, enabled);
  return res.json({ ok: true, account: store.toPublic(acc) });
});

app.delete("/api/accounts/:id", (req, res) => {
  stopAccount(req.params.id);
  store.removeAccount(req.params.id);
  res.json({ ok: true });
});

app.post("/api/accounts/:id/check", async (req, res) => {
  try {
    await loginAccount(req.params.id, true);
    await refreshAccountInfo(req.params.id);
    const acc = store.get(req.params.id);
    res.json({ ok: true, account: acc ? store.toPublic(acc) : null });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "Check fail" });
  }
});

app.post("/api/accounts/:id/start", async (req, res) => {
  try {
    await startAccount(req.params.id);
    const acc = store.get(req.params.id);
    res.json({ ok: true, account: acc ? store.toPublic(acc) : null });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "Start fail" });
  }
});

app.post("/api/accounts/:id/stop", (req, res) => {
  stopAccount(req.params.id);
  const acc = store.get(req.params.id);
  res.json({ ok: true, account: acc ? store.toPublic(acc) : null });
});

app.patch("/api/accounts/:id/features", (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  for (const [featureId, patch] of Object.entries(body)) {
    if (typeof patch !== "object" || !patch) continue;
    store.setFeature(id, featureId as FeatureId, patch as any);
  }
  const acc = store.get(id);
  res.json({ ok: true, account: acc ? store.toPublic(acc) : null });
});

app.post("/api/start-all", async (_req, res) => {
  await startAll();
  res.json({ ok: true, accounts: store.listPublic() });
});

app.post("/api/stop-all", (_req, res) => {
  stopAll();
  res.json({ ok: true, accounts: store.listPublic() });
});

// UI luôn mở được (không khóa bằng key). API vẫn cần key nếu set LITE_API_KEY.
app.get("/", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(500)
      .type("html")
      .send(
        `<h1>Auto Game LITE</h1><p>Không tìm thấy index.html</p><pre>cwd=${process.cwd()}\npublicDir=${publicDir}</pre><p><a href="/health">/health</a> · <a href="/ping">/ping</a></p>`
      );
  }
  return res.sendFile(indexHtml);
});

app.use(express.static(publicDir));

// Trang lỗi rõ ràng thay vì Not Found trống
app.use((req, res) => {
  res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/><title>404</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;padding:24px}</style></head>
<body>
  <h1>404 — Không có route này</h1>
  <p>Path: <code>${req.path}</code></p>
  <ul>
    <li><a href="/" style="color:#8cf">UI chính /</a></li>
    <li><a href="/health" style="color:#8cf">/health</a></li>
    <li><a href="/ping" style="color:#8cf">/ping</a></li>
  </ul>
  <p>Nếu mở domain gốc vẫn 404 của Render (không phải trang này) → service chưa chạy / deploy fail. Xem Logs trên Render.</p>
</body></html>`);
});

function startSelfPing() {
  if (!config.selfPingMinutes || config.selfPingMinutes <= 0) return;
  const base = config.publicUrl || `http://127.0.0.1:${config.port}`;
  const url = `${base}/ping`;
  console.log(`[keep-alive] self-ping every ${config.selfPingMinutes}m -> ${url}`);
  setInterval(async () => {
    try {
      await fetch(url, { method: "GET" });
    } catch (e: any) {
      console.warn("[keep-alive] self-ping fail:", e?.message || e);
    }
  }, config.selfPingMinutes * 60_000);
}

store.load();

const host = "0.0.0.0";
app.listen(config.port, host, () => {
  console.log(`\n=== Auto Game LITE ===`);
  console.log(`Listen: ${host}:${config.port}`);
  console.log(`cwd: ${process.cwd()}`);
  console.log(`public: ${publicDir} (index=${fs.existsSync(indexHtml)})`);
  console.log(`API key: ${config.apiKey ? "ON" : "OFF"}`);
  console.log(`Accounts: ${store.list().length}`);
  console.log(`Health: /health  |  Ping: /ping  |  UI: /`);
  console.log(`======================\n`);
  startSelfPing();
  setTimeout(() => {
    void resumeWantedAccounts();
  }, 2500);
});
