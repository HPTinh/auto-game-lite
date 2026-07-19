import express, { type Request, type Response, type NextFunction } from "express";
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
app.use(express.json({ limit: "256kb" }));

// ---- keep-alive / health (không cần API key để cron ping được) ----
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
    stats: getRuntimeStats(),
  });
});

app.get("/ping", (_req, res) => {
  lastPingAt = Date.now();
  pingCount += 1;
  res.status(200).send("pong");
});

app.head("/ping", (_req, res) => {
  lastPingAt = Date.now();
  pingCount += 1;
  res.status(200).end();
});

// ---- auth middleware cho API + UI (optional nếu không set key) ----
function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKey) return next();
  const key =
    String(req.headers["x-api-key"] || "") ||
    String(req.query.key || "") ||
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (key !== config.apiKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized. Gửi x-api-key hoặc ?key=" });
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
  // body: { farm: { enabled: true, settings: {...} }, ... }
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

// UI: inject API key từ query vào localStorage helper page
app.get("/", requireKey, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

// self-ping để giảm sleep (Render free vẫn NÊN dùng cron ngoài)
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

app.listen(config.port, () => {
  console.log(`\n=== Auto Game LITE ===`);
  console.log(`Port: ${config.port}`);
  console.log(`API key: ${config.apiKey ? "ON" : "OFF (dev only)"}`);
  console.log(`Accounts: ${store.list().length}`);
  console.log(`Health: /health  |  Ping: /ping`);
  console.log(`UI: /${config.apiKey ? "?key=YOUR_KEY" : ""}`);
  console.log(`======================\n`);
  startSelfPing();
  // Delay nhẹ để health check Render pass trước, rồi resume treo
  setTimeout(() => {
    void resumeWantedAccounts();
  }, 2500);
});
