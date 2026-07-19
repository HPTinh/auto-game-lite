import { config, type FeatureId } from "./config";
import { ensureRuntime, loginAccount, refreshAccountInfo } from "./auth";
import { logGate, shouldAcceptEngineLog } from "./logGate";
import { store } from "./store";
import {
  clearFarmRuntimeLocks,
  runAchievementClaimAuto,
  runAutoBuffCheck,
  runAutoEquipCheck,
  runBodyCultAuto,
  runBreakthroughAuto,
  runClaimExpAuto,
  runCraftAuto,
  runFarmAuto,
  runMailClaimAll,
  runMazeAuto,
  runOnboardingClaimAuto,
  runPvpAuto,
  runWorldBossAuto,
  runWorldCupCheckinAuto,
} from "./engines";

/** Map UI farm settings → engine farmEngine */
function buildFarmEngineSettings(settings: Record<string, any>): Record<string, any> {
  const multi = settings.multi_channel === true || settings.multi_channel === "true";
  const channel = Math.max(1, Math.floor(Number(settings.channel || settings.from_channel || 3)) || 3);
  const from = multi
    ? Math.max(1, Math.floor(Number(settings.from_channel || channel)) || channel)
    : channel;
  const to = multi
    ? Math.max(from, Math.floor(Number(settings.to_channel || from)) || from)
    : channel;

  // Ưu tiên mob tinh gọn
  const order = String(settings.target_order || settings.priority || "boss_elite").toLowerCase();
  let mode = "boss";
  let priority = "boss_elite";
  let boss_priority_mode = true;
  let boss_priority_fast = true;
  let absolute_boss_only = false;

  if (order === "boss" || order === "boss_only") {
    mode = "boss";
    priority = "boss";
    boss_priority_mode = true;
    boss_priority_fast = true;
    absolute_boss_only = true;
  } else if (order === "boss_elite" || order === "boss_elite_fast") {
    mode = "boss";
    priority = "boss_elite";
    boss_priority_mode = true;
    boss_priority_fast = true;
  } else if (order === "boss_elite_normal" || order === "ben") {
    mode = "all";
    priority = "boss_elite_normal";
    boss_priority_mode = false;
    boss_priority_fast = false;
  } else if (order === "elite") {
    mode = "elite";
    priority = "elite";
    boss_priority_mode = false;
    boss_priority_fast = false;
  } else if (order === "normal") {
    mode = "normal";
    priority = "normal";
    boss_priority_mode = false;
    boss_priority_fast = false;
  } else if (order === "elite_normal") {
    mode = "all";
    priority = "elite_normal";
    boss_priority_mode = false;
    boss_priority_fast = false;
  } else if (order === "smart") {
    mode = "smart";
    priority = "boss_elite_normal";
    boss_priority_mode = false;
    boss_priority_fast = false;
  }

  return {
    ...settings,
    multi_channel: multi,
    channel,
    from_channel: from,
    to_channel: to,
    mode,
    priority,
    boss_priority_mode,
    boss_priority_fast,
    absolute_boss_only,
    farm_log_mode: "summary",
    summary_log_interval_seconds: Math.max(1800, Number(settings.summary_log_interval_seconds || 3600)),
    smart_rebirth_farm: settings.smart_rebirth_farm !== false,
  };
}

type TimerMap = Map<string, NodeJS.Timeout>;

/** key = `${accountId}::${featureId}` */
const timers: TimerMap = new Map();
const runTokens = new Map<string, number>();
const featureBusy = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function timerKey(accountId: string, featureId: string) {
  return `${accountId}::${featureId}`;
}

function clearTimer(accountId: string, featureId?: string) {
  if (featureId) {
    const k = timerKey(accountId, featureId);
    const t = timers.get(k);
    if (t) clearTimeout(t);
    timers.delete(k);
    return;
  }
  for (const [k, t] of timers) {
    if (k.startsWith(`${accountId}::`)) {
      clearTimeout(t);
      timers.delete(k);
    }
  }
}

function schedule(accountId: string, featureId: FeatureId, delayMs: number, fn: () => void) {
  clearTimer(accountId, featureId);
  const wait = Math.max(300, delayMs);
  const nextAt = new Date(Date.now() + wait).toISOString();
  store.setFeature(accountId, featureId, { status: "WAITING", nextRunAt: nextAt });
  const t = setTimeout(() => {
    timers.delete(timerKey(accountId, featureId));
    fn();
  }, wait);
  timers.set(timerKey(accountId, featureId), t);
}

function isAllowed(accountId: string, featureId: FeatureId, token: number) {
  const acc = store.get(accountId);
  if (!acc || !acc.running) return false;
  if (runTokens.get(accountId) !== token) return false;
  const feat = acc.features[featureId];
  if (!feat?.enabled) return false;
  return true;
}

/** Log tối ưu: filter engine + rate-limit + dedupe */
function onLog(accountId: string, module: string) {
  return (level: any, message: string) => {
    const lv = String(level || "INFO").toUpperCase() as any;
    const text = String(message || "");
    if (!shouldAcceptEngineLog(module, lv, text)) return;
    const gated = logGate.allow(accountId, module, lv, text);
    if (!gated) return;
    store.addLog(accountId, module, lv, gated);
  };
}

/** Log hệ thống lite (start/stop/summary) — vẫn qua rate-limit nhẹ */
function sysLog(accountId: string, module: string, level: any, message: string, force = false) {
  if (force) {
    store.addLog(accountId, module, level, message, { force: true });
    return;
  }
  const gated = logGate.allow(accountId, module, level, message, {
    minIntervalMs: level === "ERROR" ? 5_000 : 20_000,
  });
  if (!gated) return;
  store.addLog(accountId, module, level, gated);
}

/** Tóm tắt 1 dòng sau mỗi vòng farm — thay cho spam engine */
function farmCycleSummary(result: any, farmSettings?: Record<string, any>): string {
  const atk = result?.attackCount ?? 0;
  const kill = result?.killedCount ?? result?.observedKilledCount ?? 0;
  const boss = result?.killedBossCount ?? 0;
  const elite = result?.killedEliteCount ?? 0;
  const st = result?.status || "?";
  const mode = result?.effectiveMode || result?.mode || "?";
  const wait = Math.round(Number(result?.nextDelayMs || 0) / 1000);
  const ch = farmSettings?.multi_channel
    ? `c${farmSettings.from_channel}-${farmSettings.to_channel}`
    : `c${farmSettings?.channel ?? farmSettings?.from_channel ?? "?"}`;
  return `Farm ${st} · ${mode} · ${ch} · atk ${atk} · kill ${kill} (B${boss}/E${elite}) · next ${wait}s`;
}

async function runFeatureOnce(accountId: string, featureId: FeatureId, token: number) {
  const key = timerKey(accountId, featureId);
  if (!isAllowed(accountId, featureId, token)) return;
  if (featureBusy.has(key)) return;
  featureBusy.add(key);

  const acc = store.get(accountId)!;
  const settings = { ...(acc.features[featureId]?.settings || {}) };

  try {
    const runtime = await ensureRuntime(accountId);
    if (!runtime || !isAllowed(accountId, featureId, token)) return;

    store.setFeature(accountId, featureId, { status: "RUNNING", lastError: undefined });
    store.update(accountId, {
      state: "RUNNING",
      activeTask: featureId,
      errorMessage: undefined,
    });
    // không log "Đang chạy..." mỗi vòng — chỉ tóm tắt sau khi xong

    let nextDelayMs = 60_000;
    let status: "ok" | "error" | "done" = "ok";
    let errMsg = "";

    if (featureId === "farm") {
      const farmSettings = buildFarmEngineSettings(settings);
      const result = await runFarmAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings: farmSettings,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "FARM"),
      });
      // Mỗi vòng farm cách nhau tối thiểu 5s (cấu hình minFarmDelayMs / empty_scan_delay_ms)
      nextDelayMs = Math.max(
        config.minFarmDelayMs,
        Number(farmSettings.empty_scan_delay_ms || 5000),
        Number(result.nextDelayMs || 0)
      );
      const line = farmCycleSummary(result, farmSettings);
      if (result.status === "ERROR") {
        status = "error";
        errMsg = (result.errors || []).slice(0, 1).join("; ") || "Farm error";
        sysLog(accountId, "FARM", "ERROR", errMsg);
      } else if (
        result.status === "DONE" &&
        result.effectiveMode === "smart_done_stopped" &&
        settings.smart_stop_when_quest_done === true
      ) {
        status = "done";
        sysLog(accountId, "FARM", "SUCCESS", "Đủ nhiệm vụ trùng sinh — dừng farm", true);
      } else {
        // 1 dòng tóm tắt; vòng không đánh: thưa hơn (45s)
        const empty = !(result.attackCount > 0);
        const gated = logGate.allow(accountId, "FARM", "INFO", line, {
          minIntervalMs: empty ? 45_000 : 20_000,
        });
        if (gated) store.addLog(accountId, "FARM", "INFO", gated);
      }
    } else if (featureId === "buff") {
      const result = await runAutoBuffCheck({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "BUFF"),
      });
      nextDelayMs = Math.max(30_000, Number(result.nextDelayMs || (settings.interval_seconds || 300) * 1000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = "Buff error";
      } else {
        sysLog(accountId, "BUFF", "SUCCESS", `Buff OK · next ${Math.round(nextDelayMs / 1000)}s`);
      }
    } else if (featureId === "claim_exp") {
      await runClaimExpAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "CLAIM_EXP"),
      });
      nextDelayMs = Math.max(60_000, Number(settings.interval_minutes || 15) * 60_000);
    } else if (featureId === "achievement") {
      await runAchievementClaimAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "ACHIEVEMENT"),
      });
      nextDelayMs = Math.max(60_000, Number(settings.interval_minutes || 60) * 60_000);
    } else if (featureId === "world_cup_checkin") {
      await runWorldCupCheckinAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "WORLD_CUP"),
      });
      nextDelayMs = 6 * 60 * 60_000;
    } else if (featureId === "onboarding_claim") {
      await runOnboardingClaimAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "ONBOARDING"),
      });
      nextDelayMs = 60 * 60_000;
    } else if (featureId === "body_cult") {
      await runBodyCultAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "BODY_CULT"),
      });
      nextDelayMs = 15 * 60_000;
    } else if (featureId === "world_boss") {
      const result = await runWorldBossAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        tiers: settings.tiers || "lk,tc,kd",
        maxAttacksPerCheck: Number(settings.max_attacks_per_check || 30),
        attackDelayMs: Number(settings.attack_delay_ms || 1500),
        autoClaim: settings.auto_claim !== false,
        onLog: onLog(accountId, "WORLD_BOSS"),
      });
      nextDelayMs = Math.max(
        60_000,
        Number(result.nextCheckMs || Number(settings.check_interval_minutes || 10) * 60_000)
      );
      if (result.status === "ERROR") {
        status = "error";
        errMsg = (result.errors || []).slice(0, 1).join("; ") || "World boss error";
      } else {
        sysLog(
          accountId,
          "WORLD_BOSS",
          "INFO",
          `WB ${result.status} · atk ${result.attackCount || 0} · claim ${result.claimCount || 0}`
        );
      }
    } else if (featureId === "breakthrough") {
      const result = await runBreakthroughAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        account: {
          level: acc.level,
          expCurrent: acc.expCurrent,
          expMax: acc.expMax,
        },
        onLog: onLog(accountId, "BREAKTHROUGH"),
        shouldStop: () => !isAllowed(accountId, featureId, token),
      });
      nextDelayMs = Math.max(15_000, Number(result.nextDelayMs || (settings.interval_seconds || 90) * 1000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Breakthrough error";
      } else if (result.status === "SUCCESS") {
        sysLog(accountId, "BREAKTHROUGH", "SUCCESS", "Đột phá thành công", true);
        await refreshAccountInfo(accountId);
      }
      // WAITING (chưa đủ EXP): im lặng — khỏi spam
    } else if (featureId === "mail") {
      await runMailClaimAll({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        onLog: onLog(accountId, "MAIL"),
      });
      nextDelayMs = 30 * 60_000;
    } else if (featureId === "maze") {
      const runCount = Math.max(1, Math.min(20, Number(settings.run_count || 1)));
      const tier = Math.min(6, Math.max(1, Number(settings.tier || 1)));
      let okRuns = 0;
      for (let i = 0; i < runCount; i++) {
        if (!isAllowed(accountId, featureId, token)) break;
        await runMazeAuto({
          characterId: runtime.characterId,
          accessToken: runtime.accessToken,
          tier,
          delayMs: 500,
          maxPasses: Number(settings.max_passes || 5),
          autoBoss: settings.auto_boss !== false,
          autoClaimFinal: settings.auto_claim_final !== false,
          bossHpReserve: Number(settings.boss_hp_reserve || 5),
          onLog: onLog(accountId, "MAZE"),
        } as any);
        okRuns += 1;
        if (i + 1 < runCount) await sleep(1500);
      }
      sysLog(accountId, "MAZE", "SUCCESS", `Mê cung tier ${tier}: ${okRuns}/${runCount} lượt`, true);
      nextDelayMs = Math.max(60_000, Number(settings.repeat_interval_minutes || 60) * 60_000);
      if (settings.stop_after_batch === true) status = "done";
    } else if (featureId === "pvp") {
      const huntList = Array.isArray(settings.hunt_list) ? settings.hunt_list : [];
      const result = await runPvpAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        huntList,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "PVP"),
      });
      // lưu hunt list lại vào feature settings
      store.setFeature(accountId, "pvp", {
        settings: {
          ...settings,
          hunt_list: result.huntList || huntList,
        },
      });
      nextDelayMs = Math.max(60_000, Number(settings.interval_minutes || 30) * 60_000);
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "PVP error";
      } else if (result.status === "NO_ATTACKS") {
        // hết lượt — chờ lâu hơn
        nextDelayMs = Math.max(nextDelayMs, 60 * 60_000);
        sysLog(accountId, "PVP", "WARN", `Hết lượt PVP · ${result.wins}W/${result.losses}L`);
      } else {
        sysLog(
          accountId,
          "PVP",
          "INFO",
          `PVP ${result.wins}W/${result.losses}L · hunt ${result.huntCount} · next ${Math.round(nextDelayMs / 1000)}s`
        );
      }
    } else if (featureId === "auto_equip") {
      await runAutoEquipCheck({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "AUTO_EQUIP"),
      });
      nextDelayMs = Math.max(60_000, Number(settings.interval_seconds || 600) * 1000);
    } else if (featureId === "craft") {
      const result = await runCraftAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "CRAFT"),
        shouldStop: () => !isAllowed(accountId, featureId, token),
      } as any);
      nextDelayMs = Math.max(10_000, Number(result?.nextDelayMs || (settings.interval_seconds || 60) * 1000));
    } else {
      store.addLog(accountId, "RUN", "WARN", `Feature chưa hỗ trợ: ${featureId}`);
      store.setFeature(accountId, featureId, { status: "OFF", enabled: false });
      return;
    }

    if (!isAllowed(accountId, featureId, token)) return;

    store.setFeature(accountId, featureId, {
      status: status === "done" ? "DONE" : status === "error" ? "ERROR" : "WAITING",
      lastRunAt: new Date().toISOString(),
      lastError: status === "error" ? errMsg : undefined,
    });

    if (status === "done") {
      store.setFeature(accountId, featureId, { enabled: false, status: "DONE" });
      return;
    }

    if (status === "error") {
      nextDelayMs = Math.max(nextDelayMs, 30_000);
      // lỗi đã log ở nhánh feature — không log lại
    }

    schedule(accountId, featureId, nextDelayMs, () => {
      void runFeatureOnce(accountId, featureId, token);
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    sysLog(accountId, featureId.toUpperCase(), "ERROR", msg);
    store.setFeature(accountId, featureId, { status: "ERROR", lastError: msg });
    if (isAllowed(accountId, featureId, token)) {
      schedule(accountId, featureId, 45_000, () => {
        void runFeatureOnce(accountId, featureId, token);
      });
    }
  } finally {
    featureBusy.delete(key);
  }
}

export async function startAccount(accountId: string) {
  const acc = store.get(accountId);
  if (!acc) throw new Error("Account not found");

  // login trước
  await loginAccount(accountId, true);

  const token = (runTokens.get(accountId) || 0) + 1;
  runTokens.set(accountId, token);
  clearTimer(accountId);

  store.update(accountId, {
    running: true,
    wantRunning: true,
    state: "RUNNING",
    activeTask: "Khởi động",
    errorMessage: undefined,
  });
  const acc2 = store.get(accountId)!;
  const enabled = (Object.entries(acc2.features) as [FeatureId, any][])
    .filter(([, f]) => f?.enabled)
    .map(([id]) => id);

  if (enabled.length === 0) {
    sysLog(accountId, "RUN", "WARN", "Chưa bật chức năng — tick rồi Start lại", true);
    store.update(accountId, { running: true, state: "READY", activeTask: "Idle (không feature)" });
    return;
  }

  sysLog(accountId, "RUN", "SUCCESS", `▶ START · ${enabled.join(", ")}`, true);

  // stagger start để tránh burst API
  let i = 0;
  for (const featureId of enabled) {
    const delay = i * 400;
    i += 1;
    schedule(accountId, featureId, delay, () => {
      void runFeatureOnce(accountId, featureId, token);
    });
  }
}

export function stopAccount(accountId: string) {
  const token = (runTokens.get(accountId) || 0) + 1;
  runTokens.set(accountId, token);
  clearTimer(accountId);
  clearFarmRuntimeLocks(store.get(accountId)?.characterId);

  const acc = store.get(accountId);
  if (!acc) return;

  for (const [fid, feat] of Object.entries(acc.features)) {
    if (feat?.enabled && feat.status !== "DONE") {
      store.setFeature(accountId, fid as FeatureId, { status: "PENDING", nextRunAt: undefined });
    }
  }

  store.update(accountId, {
    running: false,
    wantRunning: false,
    state: "STOPPED",
    activeTask: undefined,
  });
  sysLog(accountId, "RUN", "WARN", "Đã dừng", true);
}

/** Gọi sau boot: resume các account đang treo trước khi process chết/sleep */
export async function resumeWantedAccounts() {
  const list = store.list().filter((a) => a.wantRunning && a.password);
  if (!list.length) return;
  console.log(`[resume] ${list.length} account(s) will auto-start...`);
  for (const acc of list) {
    try {
      await startAccount(acc.id);
      await sleep(1000);
    } catch (e: any) {
      store.addLog(acc.id, "RUN", "ERROR", `Auto-resume fail: ${e?.message || e}`);
    }
  }
}

export async function startAll() {
  for (const acc of store.list()) {
    if (!acc.running) {
      try {
        await startAccount(acc.id);
        await sleep(800);
      } catch (e: any) {
        store.addLog(acc.id, "RUN", "ERROR", e?.message || "Start fail");
      }
    }
  }
}

export function stopAll() {
  for (const acc of store.list()) {
    if (acc.running) stopAccount(acc.id);
  }
}

export function getRuntimeStats() {
  return {
    timers: timers.size,
    busy: featureBusy.size,
    runningAccounts: store.list().filter((a) => a.running).length,
    totalAccounts: store.list().length,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  };
}
