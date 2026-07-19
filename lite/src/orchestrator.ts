import { config, type FeatureId } from "./config";
import { ensureRuntime, loginAccount, refreshAccountInfo } from "./auth";
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
  runWorldBossAuto,
  runWorldCupCheckinAuto,
} from "./engines";

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

function onLog(accountId: string, module: string) {
  return (level: any, message: string) => {
    const lv = String(level || "INFO").toUpperCase();
    // Lite: bỏ DEBUG/soft spam để tiết kiệm RAM
    if (lv === "DEBUG") return;
    if (module === "FARM" && lv !== "ERROR" && lv !== "SUCCESS" && lv !== "WARN") {
      // farm chỉ log WARN/ERROR/SUCCESS
      if (lv === "INFO" && !String(message).includes("tóm tắt") && !String(message).includes("summary")) return;
    }
    store.addLog(accountId, module, lv as any, message);
  };
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

    let nextDelayMs = 60_000;
    let status: "ok" | "error" | "done" = "ok";
    let errMsg = "";

    if (featureId === "farm") {
      const result = await runFarmAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings: {
          ...settings,
          mode: settings.boss_priority_mode !== false ? "boss" : settings.mode,
          boss_priority_mode: settings.boss_priority_mode !== false,
          boss_priority_fast: settings.boss_priority_fast !== false,
          smart_rebirth_farm: settings.smart_rebirth_farm !== false,
          farm_log_mode: settings.farm_log_mode || "summary",
        },
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "FARM"),
      });
      nextDelayMs = Math.max(config.minFarmDelayMs, Number(result.nextDelayMs || settings.empty_scan_delay_ms || 1000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = (result.errors || []).slice(0, 2).join("; ") || "Farm error";
      } else if (
        result.status === "DONE" &&
        result.effectiveMode === "smart_done_stopped" &&
        settings.smart_stop_when_quest_done === true
      ) {
        status = "done";
        store.addLog(accountId, "FARM", "SUCCESS", "Đủ nhiệm vụ trùng sinh — dừng farm");
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
        errMsg = (result.errors || []).slice(0, 2).join("; ") || "World boss error";
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
        store.addLog(accountId, "BREAKTHROUGH", "SUCCESS", "Đột phá thành công");
        await refreshAccountInfo(accountId);
      }
    } else if (featureId === "mail") {
      await runMailClaimAll({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        onLog: onLog(accountId, "MAIL"),
      });
      nextDelayMs = 30 * 60_000;
    } else if (featureId === "maze") {
      await runMazeAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        tier: Number(settings.tier || 1),
        delayMs: 500,
        maxPasses: Number(settings.max_passes || 5),
        autoBoss: settings.auto_boss !== false,
        autoClaimFinal: settings.auto_claim_final !== false,
        bossHpReserve: Number(settings.boss_hp_reserve || 5),
        onLog: (level: any, msg: string) => onLog(accountId, "MAZE")(level, msg),
      } as any);
      // maze thường 1 lần / ngày — check lại sau 1h
      nextDelayMs = 60 * 60_000;
      status = "done";
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

    // error: vẫn retry sau delay dài hơn
    if (status === "error") {
      nextDelayMs = Math.max(nextDelayMs, 30_000);
      store.addLog(accountId, featureId.toUpperCase(), "ERROR", errMsg || "Lỗi, sẽ retry");
    }

    schedule(accountId, featureId, nextDelayMs, () => {
      void runFeatureOnce(accountId, featureId, token);
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    store.addLog(accountId, featureId.toUpperCase(), "ERROR", msg);
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
  store.addLog(accountId, "RUN", "INFO", "Bắt đầu treo (lite)");

  const enabled = (Object.entries(acc.features) as [FeatureId, any][])
    .filter(([, f]) => f?.enabled)
    .map(([id]) => id);

  if (enabled.length === 0) {
    store.addLog(accountId, "RUN", "WARN", "Chưa bật chức năng nào — chỉ login/info");
    store.update(accountId, { running: true, state: "READY", activeTask: "Idle (không feature)" });
    return;
  }

  store.addLog(accountId, "RUN", "INFO", `Chạy: ${enabled.join(", ")}`);

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
  store.addLog(accountId, "RUN", "WARN", "Đã dừng");
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
