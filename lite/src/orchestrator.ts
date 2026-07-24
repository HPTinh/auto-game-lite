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
  listCraftRecipes,
  normalizeCraftCategory,
  runFarmAuto,
  runMailClaimAll,
  runMazeAuto,
  runKhoiLoiAuto,
  runKiNgoAuto,
  msUntilNextVietnamNoon,
  runVipDailyAuto,
  runNhapMongAuto,
  runPvpAuto,
  runWorldBossAuto,
  runRankChallengeAuto,
  runHoangCoAuto,
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

/** Ngày hiện tại theo giờ Việt Nam YYYY-MM-DD */
function vnDateString(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** ms đến 00:00 đêm tiếp theo (giờ VN) */
function msUntilNextVnMidnight(): number {
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const vnNow = new Date(Date.now() + vnOffsetMs);
  const y = vnNow.getUTCFullYear();
  const m = vnNow.getUTCMonth();
  const day = vnNow.getUTCDate();
  const nextMidnightUtcMs = Date.UTC(y, m, day + 1, 0, 0, 0, 0) - vnOffsetMs;
  // +5s đệm sau 00:00; tối thiểu 60s
  return Math.max(60_000, nextMidnightUtcMs - Date.now() + 5_000);
}

/** Chuẩn hoá tiến độ mê cung theo ngày; reset sau 00h VN */
function normalizeMazeDaily(settings: Record<string, any>) {
  const today = vnDateString();
  const date = String(settings.daily_date || "");
  let completed = Math.max(0, Math.floor(Number(settings.daily_completed || 0)) || 0);
  let locked = settings.daily_locked === true;
  if (date !== today) {
    completed = 0;
    locked = false;
  }
  const target = Math.max(1, Math.min(50, Math.floor(Number(settings.run_count || 1)) || 1));
  return { today, completed, locked, target };
}

function persistMazeDaily(
  accountId: string,
  settings: Record<string, any>,
  daily: { today: string; completed: number; locked: boolean }
) {
  store.setFeature(accountId, "maze", {
    settings: {
      ...settings,
      daily_date: daily.today,
      daily_completed: daily.completed,
      daily_locked: daily.locked,
    },
  });
}

/** PVP quota theo ngày (00:00 VN) */
function normalizePvpDaily(settings: Record<string, any>) {
  const today = vnDateString();
  const date = String(settings.daily_date || "");
  let completed = Math.max(0, Math.floor(Number(settings.daily_completed || 0)) || 0);
  let locked = settings.daily_locked === true;
  if (date !== today) {
    completed = 0;
    locked = false;
  }
  const target = Math.max(
    1,
    Math.min(100, Math.floor(Number(settings.daily_target ?? settings.max_attacks ?? settings.times ?? 30)) || 30)
  );
  return { today, completed, locked, target };
}

function persistPvpDaily(
  accountId: string,
  settings: Record<string, any>,
  daily: { today: string; completed: number; locked: boolean },
  extra?: Record<string, any>
) {
  store.setFeature(accountId, "pvp", {
    settings: {
      ...settings,
      ...(extra || {}),
      daily_date: daily.today,
      daily_completed: daily.completed,
      daily_locked: daily.locked,
      daily_target: daily.target ?? settings.daily_target ?? settings.max_attacks,
    },
  });
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
  let settings = { ...(acc.features[featureId]?.settings || {}) };

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
      // Vòng lặp độc lập: mỗi tick farm 1 lần API → hẹn nextDelay (thường ~5s game CD)
      // Không đợi / không nhường World Boss — timer riêng
      const farmSettings = buildFarmEngineSettings(settings);
      const result = await runFarmAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings: farmSettings,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "FARM"),
      });
      // Chu kỳ farm: attack_delay (engine ~5s) hoặc empty_scan
      nextDelayMs = Math.max(
        config.minFarmDelayMs,
        Number(farmSettings.attack_delay_ms || 4000),
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
    } else if (featureId === "body_cult") {
      await runBodyCultAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "BODY_CULT"),
      });
      nextDelayMs = 15 * 60_000;
    } else if (featureId === "world_boss") {
      // Auto: 1 tick = 1 attack ~3s khi sống; chết = chờ hồi. Log thưa.
      const HIT_MS = 3000;
      let result: any;
      try {
        result = await runWorldBossAuto({
          characterId: runtime.characterId,
          accessToken: runtime.accessToken,
          autoSelectTiers: true,
          tiers: undefined,
          maxAttacksPerCheck: 1,
          attackDelayMs: HIT_MS,
          autoClaim: true,
          checkIntervalMinutes: 10,
          shouldStop: () => !isAllowed(accountId, featureId, token),
          onLog: onLog(accountId, "WORLD_BOSS"),
        });
      } catch (wbErr: any) {
        status = "error";
        errMsg = wbErr?.message || "WB crash";
        sysLog(accountId, "WORLD_BOSS", "ERROR", errMsg);
        nextDelayMs = 15_000;
        result = null;
      }
      if (result) {
        const hit = result.lastHit;
        const hpLeft = hit && Number.isFinite(Number(hit.hpAfter)) ? Number(hit.hpAfter) : null;
        const bossStillAlive = hit?.ok === true && (hpLeft === null || hpLeft > 0) && !hit.killed;

        if (bossStillAlive || (result.status === "DONE" && (result.attackCount || 0) > 0 && result.status !== "WAITING_RESPAWN")) {
          nextDelayMs = HIT_MS;
        } else if (result.status === "WAITING_RESPAWN") {
          nextDelayMs = Math.min(90_000, Math.max(60_000, Number(result.nextCheckMs || 60_000)));
        } else if (hit && hit.ok === false) {
          nextDelayMs = HIT_MS;
        } else {
          nextDelayMs = Math.min(5_000, Math.max(HIT_MS, Number(result.nextCheckMs || HIT_MS)));
        }

        if (result.status === "ERROR") {
          status = "error";
          errMsg = (result.errors || []).slice(0, 1).join("; ") || "World boss error";
        } else if (result.status === "WAITING_RESPAWN" && !bossStillAlive) {
          sysLog(accountId, "WORLD_BOSS", "INFO", `WB chờ hồi · next ${Math.ceil(nextDelayMs / 60000)}p`);
        } else if (hit?.ok && hit.killed) {
          sysLog(accountId, "WORLD_BOSS", "SUCCESS", `WB KILL · claim ${result.claimCount || 0}`);
        } else if (hit?.ok === false) {
          // cooldown fail: thưa log
          const gated = logGate.allow(accountId, "WORLD_BOSS", "WARN", "WB hit fail", { minIntervalMs: 30_000 });
          if (gated) store.addLog(accountId, "WORLD_BOSS", "WARN", gated);
        }
        // hit OK thường: không log mỗi 3s (đã ổn)

        if (result.claimed || (result.claimStones || 0) > 0) {
          try {
            await refreshAccountInfo(accountId);
          } catch {
            /* ignore */
          }
        }
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
      // Mê cung theo ngày (00:00 VN): đủ run_count thì khóa đến hết ngày.
      // Stop/Start lại vẫn nhớ daily_completed. Tăng run_count khi đã lock → vẫn chờ 00h.
      const tier = Math.min(6, Math.max(1, Number(settings.tier || 1)));
      let daily = normalizeMazeDaily(settings);
      const waitMidnight = () => {
        const wait = msUntilNextVnMidnight();
        nextDelayMs = wait;
        const hrs = Math.ceil(wait / 3600_000);
        sysLog(
          accountId,
          "MAZE",
          "INFO",
          `Mê cung đủ ${daily.completed}/${daily.target} hôm nay (${daily.today}) · chờ ~${hrs}h đến 00:00 VN`
        );
      };

      // Đồng bộ state ngày (reset nếu sang ngày mới)
      if (
        settings.daily_date !== daily.today ||
        Number(settings.daily_completed || 0) !== daily.completed ||
        Boolean(settings.daily_locked) !== daily.locked
      ) {
        persistMazeDaily(accountId, settings, daily);
        settings = {
          ...settings,
          daily_date: daily.today,
          daily_completed: daily.completed,
          daily_locked: daily.locked,
        };
      }

      // Đã khóa trong ngày, hoặc đã đủ target → không chạy thêm (kể cả khi tăng run_count)
      if (daily.locked || daily.completed >= daily.target) {
        if (!daily.locked && daily.completed >= daily.target) {
          daily = { ...daily, locked: true };
          persistMazeDaily(accountId, settings, daily);
        }
        waitMidnight();
      } else {
        const remaining = daily.target - daily.completed;
        sysLog(accountId, "MAZE", "INFO", `Mê cung tier ${tier} · còn ${remaining} lượt hôm nay (${daily.completed}/${daily.target})`);

        let okRuns = 0;
        for (let i = 0; i < remaining; i++) {
          if (!isAllowed(accountId, featureId, token)) break;

          // đọc lại target nếu user đổi setting giữa chừng (trừ khi đã lock)
          const latest = store.get(accountId)?.features?.maze?.settings || settings;
          daily = normalizeMazeDaily(latest);
          if (daily.locked || daily.completed >= daily.target) break;

          try {
            await runMazeAuto({
              characterId: runtime.characterId,
              accessToken: runtime.accessToken,
              tier,
              delayMs: 500,
              maxPasses: Number(latest.max_passes || settings.max_passes || 5),
              autoBoss: latest.auto_boss !== false,
              autoClaimFinal: latest.auto_claim_final !== false,
              bossHpReserve: Number(latest.boss_hp_reserve ?? settings.boss_hp_reserve ?? 5),
              onLog: onLog(accountId, "MAZE"),
            } as any);
            okRuns += 1;
            daily = {
              today: daily.today,
              completed: daily.completed + 1,
              locked: false,
              target: daily.target,
            };
            if (daily.completed >= daily.target) {
              daily.locked = true;
            }
            persistMazeDaily(accountId, { ...settings, ...latest }, daily);
            settings = {
              ...settings,
              ...latest,
              daily_date: daily.today,
              daily_completed: daily.completed,
              daily_locked: daily.locked,
            };
            sysLog(accountId, "MAZE", "SUCCESS", `Mê cung +1 · ${daily.completed}/${daily.target}`);
          } catch (e: any) {
            sysLog(accountId, "MAZE", "ERROR", e?.message || "Mê cung lỗi");
            // lỗi: thử lại sau 10 phút, không + completed
            nextDelayMs = 10 * 60_000;
            status = "error";
            errMsg = e?.message || "Maze error";
            break;
          }

          if (daily.locked) break;
          if (i + 1 < remaining) await sleep(1500);
        }

        if (status !== "error") {
          if (daily.locked || daily.completed >= daily.target) {
            daily.locked = true;
            persistMazeDaily(accountId, settings, daily);
            waitMidnight();
          } else {
            // chưa xong (bị stop giữa chừng) — chạy tiếp sau 30s
            nextDelayMs = 30_000;
            sysLog(accountId, "MAZE", "INFO", `Mê cung tạm dừng · ${daily.completed}/${daily.target} · tiếp sau 30s`);
          }
        }
      }
    } else if (featureId === "rank_challenge") {
      // Buff PVP: user nhập số WIN target → chỉ đếm win; 10 thua liên tiếp → dừng
      const result = await runRankChallengeAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        realmCode: String(acc.realmCode || acc.realmLabel || acc.realmTier || ""),
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "BUFF_PVP"),
      });

      store.setFeature(accountId, "rank_challenge", {
        settings: {
          ...settings,
          daily_target: result.dailyTarget ?? settings.daily_target ?? settings.daily_limit ?? 20,
          daily_completed: result.dailyCompleted ?? 0,
          lose_streak: result.loseStreak ?? 0,
          daily_date: result.dailyDate,
          daily_locked: result.dailyLocked,
          hunt_list: result.huntList || [],
          skip_slots: result.skipSlots || [],
          skip_list: [], // legacy clear
          farm_rotate: result.farmRotate ?? 0,
          board_code: settings.board_code || "auto",
          last_board_code: result.boardCode || settings.last_board_code || "",
        },
      });

      nextDelayMs = Math.max(15_000, Number(result.nextDelayMs || 60_000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Buff PVP error";
      } else if (result.status === "LOCKED") {
        sysLog(
          accountId,
          "BUFF_PVP",
          "SUCCESS",
          `Buff PVP đủ ${result.dailyCompleted}/${result.dailyTarget} WIN · farm slots ${result.huntList?.map((h) => h.lastSlot).filter(Boolean).join(",") || "—"} · chờ 00:00 VN`
        );
      } else if (result.status === "NO_WIN") {
        sysLog(
          accountId,
          "BUFF_PVP",
          "WARN",
          `Buff PVP dừng: ${result.loseStreak} trận không WIN · WIN ${result.dailyCompleted}/${result.dailyTarget} · chờ 00:00 VN`
        );
      } else {
        sysLog(
          accountId,
          "BUFF_PVP",
          "INFO",
          `Buff PVP ${result.status} · ${result.wins}W/${result.losses}L · WIN ${result.dailyCompleted}/${result.dailyTarget} · skip slots [${(result.skipSlots || []).join(",")}]`
        );
      }
    } else if (featureId === "pvp") {
      // PVP theo ngày: daily_target (vd 30) → đủ thì khóa đến 00:00 VN
      let daily = normalizePvpDaily(settings);
      const waitMidnight = () => {
        const wait = msUntilNextVnMidnight();
        nextDelayMs = wait;
        const hrs = Math.ceil(wait / 3600_000);
        sysLog(
          accountId,
          "PVP",
          "INFO",
          `PVP đủ ${daily.completed}/${daily.target} hôm nay (${daily.today}) · chờ ~${hrs}h đến 00:00 VN`
        );
      };

      // Đồng bộ state ngày
      if (
        settings.daily_date !== daily.today ||
        Number(settings.daily_completed || 0) !== daily.completed ||
        Boolean(settings.daily_locked) !== daily.locked
      ) {
        persistPvpDaily(accountId, settings, daily);
        settings = {
          ...settings,
          daily_date: daily.today,
          daily_completed: daily.completed,
          daily_locked: daily.locked,
        };
      }

      // Đã khóa / đủ target hôm nay → không đánh (kể cả tăng daily_target khi đã lock)
      if (daily.locked || daily.completed >= daily.target) {
        if (!daily.locked && daily.completed >= daily.target) {
          daily = { ...daily, locked: true };
          persistPvpDaily(accountId, settings, daily);
        }
        waitMidnight();
      } else {
        const remaining = daily.target - daily.completed;
        const huntList = Array.isArray(settings.hunt_list) ? settings.hunt_list : [];
        sysLog(accountId, "PVP", "INFO", `PVP còn ${remaining}/${daily.target} trận hôm nay`);

        const result = await runPvpAuto({
          characterId: runtime.characterId,
          accessToken: runtime.accessToken,
          settings: {
            ...settings,
            max_attacks: remaining, // chỉ đánh phần còn lại trong ngày
          },
          huntList,
          shouldStop: () => !isAllowed(accountId, featureId, token),
          onLog: onLog(accountId, "PVP"),
        });

        const fought = Math.max(0, Number(result.fought || 0));
        daily = {
          today: daily.today,
          completed: Math.min(daily.target, daily.completed + fought),
          locked: false,
          target: daily.target,
        };
        if (daily.completed >= daily.target) {
          daily.locked = true;
        }

        persistPvpDaily(accountId, settings, daily, {
          hunt_list: result.huntList || huntList,
        });
        settings = {
          ...settings,
          hunt_list: result.huntList || huntList,
          daily_date: daily.today,
          daily_completed: daily.completed,
          daily_locked: daily.locked,
        };

        if (result.status === "ERROR") {
          status = "error";
          errMsg = result.reason || "PVP error";
          // lỗi: thử lại sau 5p (vẫn trong ngày nếu chưa đủ)
          nextDelayMs = 5 * 60_000;
          sysLog(accountId, "PVP", "ERROR", errMsg);
        } else if (daily.locked || daily.completed >= daily.target) {
          waitMidnight();
        } else if (result.status === "NO_ATTACKS") {
          // hết lượt game — chờ midnight hoặc 1h
          nextDelayMs = Math.min(msUntilNextVnMidnight(), 60 * 60_000);
          sysLog(
            accountId,
            "PVP",
            "WARN",
            `Hết lượt game · đã ${daily.completed}/${daily.target} hôm nay · ${result.wins}W/${result.losses}L`
          );
        } else if (result.status === "NO_OPPONENT") {
          nextDelayMs = 15 * 60_000;
          sysLog(accountId, "PVP", "WARN", `Không có đối thủ · ${daily.completed}/${daily.target} · thử lại 15p`);
        } else {
          // Còn quota ngày nhưng batch xong (ít hơn remaining) → chạy tiếp sớm
          nextDelayMs = Math.max(10_000, Number(settings.delay_ms || 1500) * 2);
          sysLog(
            accountId,
            "PVP",
            "INFO",
            `PVP ${result.wins}W/${result.losses}L · ngày ${daily.completed}/${daily.target} · tiếp sau ${Math.round(nextDelayMs / 1000)}s`
          );
        }
      }
    } else if (featureId === "nhap_mong") {
      const result = await runNhapMongAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "NHAP_MONG"),
      });
      nextDelayMs = Math.max(30_000, Number(result.nextDelayMs || Number(settings.interval_minutes || 30) * 60_000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Nhập Mộng error";
      } else if (result.status === "WAITING") {
        sysLog(
          accountId,
          "NHAP_MONG",
          "INFO",
          `NM chờ · cur ${result.lastCurIdx ?? "?"}/${result.lastLength ?? "?"} · answers ${result.answers} · next ${Math.round(nextDelayMs / 1000)}s`
        );
      } else if (result.status === "NO_RUNS") {
        sysLog(accountId, "NHAP_MONG", "WARN", `NM hết lượt · free ${result.freeLeft ?? "?"} · next ${Math.round(nextDelayMs / 60000)}p`);
      } else {
        sysLog(
          accountId,
          "NHAP_MONG",
          "INFO",
          `NM ${result.status} · runs ${result.runsFinished}/${result.runsStarted} · answers ${result.answers} · score ${result.lastScore ?? "?"}`
        );
      }
    } else if (featureId === "khoi_loi") {
      const hours = Math.max(2, Number(settings.interval_hours ?? 2) || 2);
      const result = await runKhoiLoiAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings: { ...settings, interval_hours: hours },
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "KHOI_LOI"),
      });
      // Tối thiểu 2 giờ giữa 2 lần claim
      nextDelayMs = Math.max(2 * 60 * 60_000, Number(result.nextDelayMs || hours * 60 * 60_000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Khôi Lỗi error";
      } else {
        sysLog(
          accountId,
          "KHOI_LOI",
          "INFO",
          `KL ${result.status} · claim ${result.claimedCount}/${result.ownedCount} · drops ${result.totalDrops} · next ${hours}h`
        );
      }
    } else if (featureId === "ki_ngo") {
      // Kì ngộ: loop rpc_trigger_ki_ngo; đủ daily_count/limit → chờ mốc 12:00 VN
      const noonMs = msUntilNextVietnamNoon();
      const result = await runKiNgoAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        msUntilNextNoon: noonMs,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "KI_NGO"),
      });

      const used = Number.isFinite(result.used as number) ? Number(result.used) : Number(settings.daily_count || 0);
      const limit = Number.isFinite(result.limit as number) ? Number(result.limit) : Number(settings.daily_limit || 0) || undefined;
      const nextRunAt = new Date(Date.now() + Math.max(30_000, Number(result.nextDelayMs || 60_000))).toISOString();
      const nextResetAt = new Date(Date.now() + noonMs).toISOString();

      store.setFeature(accountId, "ki_ngo", {
        settings: {
          ...settings,
          daily_count: used,
          daily_limit: limit ?? settings.daily_limit,
          completed_today: result.completedToday,
          success_count: result.successCount,
          fail_count: result.failCount,
          next_run_at: nextRunAt,
          next_reset_at: nextResetAt,
          last_run_at: new Date().toISOString(),
        },
      });

      nextDelayMs = Math.max(30_000, Number(result.nextDelayMs || Number(settings.continue_delay_seconds || 60) * 1000));

      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Kì ngộ error";
        sysLog(accountId, "KI_NGO", "ERROR", errMsg);
      } else if (result.completedToday || result.status === "DONE") {
        // Giữ WAITING + hẹn 12h VN — không tắt feature (status "done" sẽ disable)
        const hrs = Math.ceil(nextDelayMs / 3600_000);
        sysLog(
          accountId,
          "KI_NGO",
          "SUCCESS",
          `Kì ngộ đủ ${used}/${limit ?? "?"} · chờ ~${hrs}h đến 12:00 VN`
        );
      } else {
        sysLog(
          accountId,
          "KI_NGO",
          "INFO",
          `Kì ngộ ${result.status} · ${used}/${limit ?? "?"} · ok ${result.successCount} · next ${Math.round(nextDelayMs / 1000)}s`
        );
      }
    } else if (featureId === "vip_daily") {
      // VIP daily: claimed_today false → claim; true → chờ 00:00 VN
      const result = await runVipDailyAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        msUntilNextMidnight: msUntilNextVnMidnight(),
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "VIP_DAILY"),
      });

      store.setFeature(accountId, "vip_daily", {
        settings: {
          ...settings,
          ...result.persist,
          claimed_today: result.persist.claimed_today,
          daily_date: result.persist.daily_date,
        },
      });

      nextDelayMs = Math.max(60_000, Number(result.nextDelayMs || msUntilNextVnMidnight()));

      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "VIP daily error";
        sysLog(accountId, "VIP_DAILY", "ERROR", errMsg);
      } else if (result.status === "CLAIMED") {
        const hrs = Math.ceil(nextDelayMs / 3600_000);
        sysLog(
          accountId,
          "VIP_DAILY",
          "SUCCESS",
          `VIP claim OK · ${result.reason || ""} · đã claim hôm nay · chờ ~${hrs}h đến 00:00 VN`
        );
      } else if (result.status === "ALREADY") {
        const hrs = Math.ceil(nextDelayMs / 3600_000);
        sysLog(
          accountId,
          "VIP_DAILY",
          "INFO",
          `VIP hôm nay đã claim rồi (${result.today || result.persist.daily_date}) · chờ ~${hrs}h đến 00:00 VN`
        );
      } else {
        sysLog(accountId, "VIP_DAILY", "INFO", `VIP ${result.status} · ${result.reason || ""}`);
      }
    } else if (featureId === "auto_equip") {
      await runAutoEquipCheck({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: onLog(accountId, "AUTO_EQUIP"),
      });
      nextDelayMs = Math.max(60_000, Number(settings.interval_seconds || 600) * 1000);
    } else if (featureId === "hoang_co") {
      // 1 feature: Cắm/Xây trước → hết việc mới Thủ (1 timer)
      const result = await runHoangCoAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        shouldStop: () => !isAllowed(accountId, featureId, token),
        onLog: onLog(accountId, "HOANG_CO"),
      });

      const attackFocus =
        result.phase === "attack" && result.flagId
          ? result.flagId
          : result.phase === "attack"
            ? null
            : settings.focus_attack_flag_id ?? null;

      store.setFeature(accountId, "hoang_co", {
        settings: {
          ...settings,
          focus_flag_id:
            result.phase === "expand" || result.phase === "defend"
              ? result.focusFlagId ?? settings.focus_flag_id ?? null
              : settings.focus_flag_id ?? null,
          focus_attack_flag_id: attackFocus,
          self_placed_flag_ids: result.selfPlacedFlagIds ?? settings.self_placed_flag_ids ?? [],
        },
      });

      nextDelayMs = Math.max(5_000, Number(result.nextDelayMs || 20_000));
      if (result.status === "ERROR") {
        status = "error";
        errMsg = result.reason || "Hoàng Cổ error";
      } else {
        const phaseLabel =
          result.phase === "defend"
            ? "Thủ cờ"
            : result.phase === "defend_mine"
              ? "Thủ central"
              : result.phase === "expand"
                ? "Mở rộng"
                : result.phase === "attack"
                  ? "Phá"
                  : result.phase === "attack_central"
                    ? "Công central"
                    : "";
        const lvl =
          (result.placed || 0) > 0 ||
          (result.built || 0) > 0 ||
          result.action === "siege_flag_defend" ||
          result.action === "siege_flag_attack" ||
          result.action === "defend_mine" ||
          result.action === "defend_central" ||
          result.action === "attack_central_hold" ||
          result.action === "move_to_attack_central"
            ? "SUCCESS"
            : result.status === "SKIPPED" || result.status === "NO_EVENT"
              ? "WARN"
              : "INFO";
        sysLog(
          accountId,
          "HOANG_CO",
          lvl,
          `Hoàng Cổ${phaseLabel ? " · " + phaseLabel : ""} · ${result.reason || result.status} · next ${Math.round(nextDelayMs / 1000)}s`
        );
      }
    } else if (featureId === "craft") {
      // alchemy | forging | talisman | formation + craft nhanh VIP>=5 (rpc_craft_auto)
      const category = normalizeCraftCategory(settings.category || "alchemy");
      const vipLevel = Number(acc.vipLevel ?? settings.vip_level ?? 0);
      let craftSettings = {
        ...settings,
        category,
        vip_level: Number.isFinite(vipLevel) ? vipLevel : 0,
        mode: settings.mode || "manual",
      };
      const catLabels: Record<string, string> = {
        alchemy: "luyện đan",
        forging: "luyện khí",
        talisman: "phù lục",
        formation: "trận pháp",
      };
      const catLabel = catLabels[category] || category;

      // Tự tải danh sách recipe theo category nếu cache rỗng
      if (
        craftSettings.auto_load_recipes !== false &&
        (!Array.isArray(craftSettings.recipe_cache) || craftSettings.recipe_cache.length === 0)
      ) {
        try {
          sysLog(accountId, "CRAFT", "INFO", `Craft: đang tải list ${catLabel} (${category})...`);
          const recipes = await listCraftRecipes({
            characterId: runtime.characterId,
            accessToken: runtime.accessToken,
            category,
          });
          const cacheAt = new Date().toISOString();
          craftSettings = {
            ...craftSettings,
            recipe_cache: recipes,
            recipe_cache_at: cacheAt,
          };
          store.setFeature(accountId, "craft", {
            settings: {
              ...settings,
              category,
              recipe_cache: recipes,
              recipe_cache_at: cacheAt,
            },
          });
          sysLog(accountId, "CRAFT", "SUCCESS", `Craft: đã tải ${recipes.length} recipe ${catLabel}`);
        } catch (e: any) {
          sysLog(accountId, "CRAFT", "WARN", `Craft: tải recipe fail — ${e?.message || e}`);
        }
      }

      if (!String(craftSettings.recipe_code || "").trim()) {
        status = "error";
        errMsg = `Chưa chọn recipe_code (${catLabel})`;
        nextDelayMs = Math.max(60_000, Number(craftSettings.interval_seconds || 20) * 1000);
        sysLog(accountId, "CRAFT", "WARN", `Craft: chưa chọn recipe — ⚙ Craft → ${catLabel} → Tải list → pick`);
      } else {
        const result = await runCraftAuto({
          characterId: runtime.characterId,
          accessToken: runtime.accessToken,
          settings: craftSettings,
          onLog: onLog(accountId, "CRAFT"),
          shouldStop: () => !isAllowed(accountId, featureId, token),
        } as any);

        // quick craft: min 3s; manual: min 5s
        const wantQuick = craftSettings.use_quick_craft === true || craftSettings.quick_craft === true;
        const minNext = wantQuick && vipLevel >= 5 ? 3000 : 5_000;
        nextDelayMs = Math.max(minNext, Number(result?.nextDelayMs || (craftSettings.interval_seconds || 20) * 1000));

        if (result?.status === "ERROR") {
          status = "error";
          errMsg = result.reason || "Craft error";
        } else if (result?.status === "SKIPPED" && result.reason === "missing_recipe_code") {
          status = "error";
          errMsg = "Chưa chọn recipe";
        } else {
          const rewardText =
            Array.isArray(result?.rewards) && result.rewards.length
              ? result.rewards.map((r: any) => `${r.code || "?"}x${r.qty || 1}`).join(",")
              : "-";
          const quickTag = wantQuick && vipLevel >= 5 ? "QUICK" : "manual";
          sysLog(
            accountId,
            "CRAFT",
            result?.successCount > 0 ? "SUCCESS" : result?.status === "PAUSED" || result?.status === "SKIPPED" ? "WARN" : "INFO",
            `Craft ${result?.status} · ${quickTag} · ${category} · ${result?.recipeCode || "?"} · ok ${result?.successCount || 0}/fail ${result?.failCount || 0} · ${rewardText} · next ${Math.round(nextDelayMs / 1000)}s`
          );
        }
      }
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
  if (!enabled.includes("world_boss")) {
    store.addLog(
      accountId,
      "WORLD_BOSS",
      "WARN",
      "W.Boss chưa tick bật — chỉ Farm sẽ chạy. Hãy tick W.Boss rồi Start lại.",
      { force: true }
    );
  }

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
