/**
 * Auto Ngũ Hành Tháp — zero-config (chỉ bật feature)
 *
 * RPC (ngu_hanh_thap.txt):
 * - rpc_tower_get_status  { p_character_id } → highest_cleared, sweep_charges, floors[]
 * - rpc_tower_challenge_floor { p_character_id, p_floor_number }
 * - rpc_tower_sweep { p_character_id } — càn quét free (sweep_charges)
 * - hết STA → rpc_use_item pill lk→lh (thấp→cao)
 *
 * Vòng lặp ngày:
 * 1) Lấy status → biết highest / tầng kế
 * 2) Leo thắng → tiếp; thua → ngưng leo trong ngày
 * 3) Thua / không leo được → càn quét free 1 lần (nếu còn charge)
 * 4) Chờ 00:00 VN → ngày mới lặp lại
 */

import { tryUsePillsLowToHigh } from "./pillUse";

export type TowerLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export type TowerStatus =
  | "DONE"
  | "LOST"
  | "SWEPT"
  | "NO_STA"
  | "WAITING"
  | "ERROR"
  | "SKIPPED"
  | "PARTIAL";

export interface TowerFloorResult {
  floor: number;
  ok: boolean;
  result?: string;
  reason?: string;
  rewards?: any;
  newHighest?: number;
  element?: string;
  raw?: any;
}

export interface TowerRunSummary {
  startedAt: string;
  finishedAt: string;
  status: TowerStatus;
  wins: number;
  losses: number;
  floorsTried: number;
  startFloor: number;
  endFloor: number;
  currentFloor: number;
  highestFloor: number;
  nextFloor: number;
  sweepCharges: number;
  swept: boolean;
  sweepRewards?: any;
  nextDelayMs: number;
  reason?: string;
  usedItems: Array<{ itemCode: string; ok: boolean; raw?: any }>;
  floors: TowerFloorResult[];
  persist: Record<string, any>;
}

export interface TowerAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: TowerLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
  /** ms đến 00:00 VN — orchestrator có thể truyền */
  msUntilNextMidnight?: number;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const clamp = (n: number, min: number, max: number, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
};

const reasonOf = (data: any) =>
  String(data?.message || data?.reason || data?.error || data?.code || data?.details || "").toLowerCase();

const hasAny = (text: string, keywords: string[]) => keywords.some((k) => text.includes(k));

/** 00:00 theo giờ Việt Nam (UTC+7) */
export function vnDateString(d = new Date()): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function msUntilNextVnMidnight(nowMs = Date.now()): number {
  const vnNow = new Date(nowMs + 7 * 3600_000);
  const y = vnNow.getUTCFullYear();
  const m = vnNow.getUTCMonth();
  const day = vnNow.getUTCDate();
  const nextMidnightUtc = Date.UTC(y, m, day + 1, 0, 0, 0) - 7 * 3600_000;
  return Math.max(60_000, nextMidnightUtc - nowMs);
}

async function rpc(name: string, payload: Record<string, any>, accessToken: string) {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "supabase-flutter/2.12.0",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(data?.message || data?.error || `RPC ${name} HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function isStaminaError(msg: string, data?: any): boolean {
  const s = `${msg} ${reasonOf(data)} ${JSON.stringify(data || {})}`.toLowerCase();
  return hasAny(s, [
    "not_enough_stamina",
    "not enough stamina",
    "insufficient_stamina",
    "stamina",
    "the_luc",
    "thể lực",
    "het_sta",
    "hết sta",
  ]);
}

function isVictory(data: any): boolean {
  if (!data || data.ok === false) return false;
  const r = String(data.result || data.outcome || data.status || "").toLowerCase();
  if (["victory", "win", "won", "clear", "success", "passed"].includes(r)) return true;
  if (data.ok === true && data.guardian_hp === 0 && !["defeat", "loss", "lose", "lost"].includes(r)) return true;
  return false;
}

function isDefeat(data: any): boolean {
  if (!data) return false;
  const r = String(data.result || data.outcome || data.status || "").toLowerCase();
  if (["defeat", "loss", "lose", "lost", "fail", "failed"].includes(r)) return true;
  if (data.ok === true && Number(data.player_hp) === 0 && Number(data.guardian_hp) > 0) return true;
  return false;
}

function isSkipFloorError(msg: string, data?: any): boolean {
  const s = `${msg} ${reasonOf(data)}`.toLowerCase();
  return hasAny(s, [
    "already_cleared",
    "already_complete",
    "floor_too_low",
    "must_clear",
    "too_low",
    "invalid_floor",
  ]);
}

function parseStatus(data: any) {
  const highest = Math.max(0, Math.floor(Number(data?.highest_cleared ?? data?.highest ?? 0) || 0));
  const sweepCharges = Math.max(0, Math.floor(Number(data?.sweep_charges ?? 0) || 0));
  const dailyUsed = Math.max(0, Math.floor(Number(data?.daily_challenges_used ?? 0) || 0));
  const dailyMax = Math.max(0, Math.floor(Number(data?.max_daily_challenges ?? 200) || 200));
  const sweepRewardSs = Number(data?.sweep_reward_ss ?? 0) || 0;
  const floors = Array.isArray(data?.floors) ? data.floors : [];
  // next floor = highest+1; fallback từ floors cleared
  let fromFloors = 0;
  for (const f of floors) {
    if (f?.cleared === true) {
      const n = Math.floor(Number(f.floor_number) || 0);
      if (n > fromFloors) fromFloors = n;
    }
  }
  const highestCleared = Math.max(highest, fromFloors);
  return {
    highestCleared,
    nextFloor: highestCleared + 1,
    sweepCharges,
    dailyUsed,
    dailyMax,
    challengesLeft: Math.max(0, dailyMax - dailyUsed),
    sweepRewardSs,
    raw: data,
  };
}

export async function runNguHanhThapAuto(options: TowerAutoOptions): Promise<TowerRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const delayMs = clamp(settings.delay_ms ?? 1500, 400, 15_000, 1500);
  const maxFloors = clamp(settings.max_floors_per_run ?? 80, 1, 300, 80);
  const maxRecoveryUses = clamp(settings.max_recovery_uses ?? 8, 1, 30, 8);
  const autoRecover = settings.auto_use_recovery_items !== false;
  const waitMidnightMs = Math.max(
    60_000,
    Number(options.msUntilNextMidnight || msUntilNextVnMidnight())
  );
  const today = vnDateString();
  const date = String(settings.daily_date || "");
  let lostToday = settings.lost_today === true && date === today;
  let sweptToday = settings.swept_today === true && date === today;

  if (date !== today) {
    lostToday = false;
    sweptToday = false;
  }

  const usedItems: TowerRunSummary["usedItems"] = [];
  const floors: TowerFloorResult[] = [];

  const summary: TowerRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    wins: 0,
    losses: 0,
    floorsTried: 0,
    startFloor: 1,
    endFloor: 1,
    currentFloor: 1,
    highestFloor: 0,
    nextFloor: 1,
    sweepCharges: 0,
    swept: false,
    nextDelayMs: waitMidnightMs,
    usedItems,
    floors,
    persist: {},
  };

  const finish = (extra: Partial<TowerRunSummary> = {}) => {
    Object.assign(summary, extra);
    summary.finishedAt = new Date().toISOString();
    summary.usedItems = usedItems;
    summary.floors = floors;
    summary.persist = {
      daily_date: today,
      lost_today: lostToday,
      swept_today: sweptToday,
      highest_floor: summary.highestFloor,
      highest_cleared: summary.highestFloor,
      current_floor: summary.currentFloor,
      next_floor: summary.nextFloor,
      sweep_charges: summary.sweepCharges,
      last_status: summary.status,
      last_wins: summary.wins,
      last_run_at: summary.finishedAt,
      display_highest: summary.highestFloor,
      display_next: summary.nextFloor,
      display_sweep_charges: summary.sweepCharges,
      ...(preferredStaPill ? { last_sta_pill: preferredStaPill } : {}),
    };
    return summary;
  };

  /** Nhớ pill đã OK → thử trước, vẫn cascade lk→lh */
  let preferredStaPill = String(settings.last_sta_pill || "").trim() || undefined;

  const useStaPill = async () => {
    onLog?.("WARN", `Tháp hết STA → thử đan thấp→cao (pill_lk_sta → … → pill_lh_sta)`);
    const result = await tryUsePillsLowToHigh({
      kind: "stamina",
      settings,
      preferredCode: preferredStaPill,
      sleepMs: 700,
      rpcUse: (itemCode) =>
        rpc("rpc_use_item", { p_character_id: options.characterId, p_item_code: itemCode }, options.accessToken),
      onLog: (level, message, meta) => {
        if (level === "DEBUG") onLog?.("DEBUG", message, meta);
        else onLog?.(level, message, meta);
      },
    });
    for (const t of result.tried) {
      usedItems.push({ itemCode: t.itemCode, ok: t.ok, raw: t.raw });
    }
    if (result.ok && result.itemCode) {
      preferredStaPill = result.itemCode;
    }
    return result.ok;
  };

  const doSweep = async (charges: number) => {
    if (charges <= 0 || sweptToday) return null;
    onLog?.("INFO", `Càn quét tháp free (sweep_charges=${charges})...`);
    try {
      const data = await rpc(
        "rpc_tower_sweep",
        { p_character_id: options.characterId },
        options.accessToken
      );
      if (data?.ok === false) {
        onLog?.("WARN", `Càn quét fail: ${reasonOf(data) || "ok_false"}`, data);
        return null;
      }
      sweptToday = true;
      summary.swept = true;
      summary.sweepRewards = data;
      const ss = data?.spirit_stones ?? data?.sweep_reward_ss;
      const merit = data?.battle_merit;
      const sweptN = data?.floors_swept;
      onLog?.(
        "SUCCESS",
        `Càn quét OK · floors ${sweptN ?? "?"} · SS ${ss ?? "?"} · merit ${merit ?? "?"} · charge còn ${data?.sweep_charges ?? 0}`
      );
      summary.sweepCharges = Math.max(0, Number(data?.sweep_charges ?? 0) || 0);
      return data;
    } catch (err: any) {
      onLog?.("WARN", `Càn quét lỗi: ${err?.message || "unknown"}`, err?.data);
      return null;
    }
  };

  try {
    // 1) Status
    onLog?.("INFO", "Ngũ Hành Tháp: rpc_tower_get_status...");
    let statusData: any;
    try {
      statusData = await rpc(
        "rpc_tower_get_status",
        { p_character_id: options.characterId },
        options.accessToken
      );
    } catch (err: any) {
      return finish({
        status: "ERROR",
        reason: err?.message || "get_status_failed",
        nextDelayMs: 5 * 60_000,
      });
    }

    let st = parseStatus(statusData);
    summary.highestFloor = st.highestCleared;
    summary.nextFloor = st.nextFloor;
    summary.currentFloor = st.nextFloor;
    summary.startFloor = st.nextFloor;
    summary.endFloor = st.nextFloor;
    summary.sweepCharges = st.sweepCharges;

    onLog?.(
      "INFO",
      `Tháp highest ${st.highestCleared} · sắp đánh T${st.nextFloor} · càn quét free ${st.sweepCharges} · challenge ${st.dailyUsed}/${st.dailyMax}`
    );

    // 2) Đã thua hôm nay → chỉ càn quét (nếu còn) rồi chờ 00h
    if (lostToday) {
      onLog?.("INFO", `Đã thua hôm nay (${today}) · không leo thêm`);
      if (!sweptToday && st.sweepCharges > 0) {
        await doSweep(st.sweepCharges);
        summary.status = "SWEPT";
        summary.reason = "lost_then_sweep";
      } else {
        summary.status = "WAITING";
        summary.reason = sweptToday ? "lost_already_swept" : "lost_no_sweep_charge";
      }
      const hrs = Math.ceil(waitMidnightMs / 3600_000);
      onLog?.("INFO", `Chờ ~${hrs}h đến 00:00 VN rồi leo lại`);
      return finish({ nextDelayMs: waitMidnightMs });
    }

    // 3) Hết lượt challenge ngày → sweep + chờ 00h
    if (st.challengesLeft <= 0) {
      onLog?.("WARN", `Hết lượt challenge ngày (${st.dailyUsed}/${st.dailyMax})`);
      if (!sweptToday && st.sweepCharges > 0) {
        await doSweep(st.sweepCharges);
        summary.status = "SWEPT";
        summary.reason = "daily_challenge_cap_sweep";
      } else {
        summary.status = "WAITING";
        summary.reason = "daily_challenge_cap";
      }
      return finish({ nextDelayMs: waitMidnightMs });
    }

    // 4) Leo tháp
    let floor = st.nextFloor;
    let wins = 0;
    let losses = 0;
    const challengeBudget = Math.min(maxFloors, st.challengesLeft);

    for (let i = 0; i < challengeBudget; i += 1) {
      if (options.shouldStop?.()) {
        summary.status = "PARTIAL";
        summary.reason = "stopped";
        break;
      }

      summary.floorsTried += 1;
      summary.currentFloor = floor;
      let data: any;
      let lastErr: any;

      for (let attempt = 0; attempt < 1 + maxRecoveryUses; attempt += 1) {
        if (options.shouldStop?.()) break;
        try {
          data = await rpc(
            "rpc_tower_challenge_floor",
            { p_character_id: options.characterId, p_floor_number: floor },
            options.accessToken
          );
          lastErr = undefined;
        } catch (err: any) {
          lastErr = err;
          data = err?.data;
        }

        const errMsg = lastErr?.message || reasonOf(data) || "";
        if (lastErr || (data && data.ok === false && !isVictory(data) && !isDefeat(data))) {
          if (autoRecover && isStaminaError(errMsg, data)) {
            if (attempt >= maxRecoveryUses) {
              summary.status = "NO_STA";
              summary.reason = "not_enough_stamina";
              break;
            }
            const ok = await useStaPill();
            if (!ok) {
              summary.status = "NO_STA";
              summary.reason = "not_enough_stamina_and_no_pill";
              break;
            }
            continue;
          }
        }
        break;
      }

      if (summary.status === "NO_STA") {
        onLog?.("WARN", `Tháp dừng hết STA tại T${floor} · sẽ thử lại sau 30p`);
        return finish({
          wins,
          losses,
          endFloor: floor,
          nextDelayMs: 30 * 60_000,
        });
      }

      const errMsg = lastErr?.message || reasonOf(data) || "";

      if (lastErr && isSkipFloorError(errMsg, data)) {
        onLog?.("WARN", `T${floor}: ${errMsg || "already cleared"} → +1`);
        floors.push({ floor, ok: false, reason: errMsg || "skip", raw: data });
        floor += 1;
        summary.highestFloor = Math.max(summary.highestFloor, floor - 1);
        summary.nextFloor = floor;
        await sleep(delayMs);
        continue;
      }

      if (isVictory(data)) {
        const done = Math.floor(Number(data?.floor_number ?? floor) || floor);
        const newHi = Math.floor(Number(data?.new_highest ?? done) || done);
        wins += 1;
        summary.highestFloor = Math.max(summary.highestFloor, newHi, done);
        const rewards = data?.rewards;
        const rewardText = rewards
          ? Object.entries(rewards)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "";
        onLog?.(
          "SUCCESS",
          `Tháp T${done} WIN${data?.element_bonus ? " · hệ +" : ""}${rewardText ? " · " + rewardText : ""} · highest ${summary.highestFloor}`
        );
        floors.push({
          floor: done,
          ok: true,
          result: "victory",
          rewards,
          newHighest: summary.highestFloor,
          element: data?.element,
          raw: data,
        });
        floor = Math.max(floor + 1, done + 1, summary.highestFloor + 1);
        summary.nextFloor = floor;
        summary.endFloor = floor;
        await sleep(delayMs);
        continue;
      }

      if (isDefeat(data) || (data && String(data.result || "").length > 0 && !isVictory(data))) {
        losses += 1;
        lostToday = true;
        const done = Math.floor(Number(data?.floor_number ?? floor) || floor);
        onLog?.("WARN", `Tháp T${done} THUA · ngưng leo hôm nay · highest ${summary.highestFloor}`);
        floors.push({
          floor: done,
          ok: false,
          result: String(data?.result || "defeat"),
          reason: "defeat",
          raw: data,
        });
        summary.status = "LOST";
        summary.reason = "defeat";
        summary.currentFloor = done;
        summary.nextFloor = summary.highestFloor + 1;
        summary.endFloor = done;
        break;
      }

      if (lastErr || !data || data.ok === false) {
        const reason = errMsg || "tower_error";
        if (hasAny(reason, ["cooldown", "too_fast", "rate_limit"])) {
          onLog?.("WARN", `Tháp cooldown: ${reason}`);
          return finish({
            wins,
            losses,
            status: "WAITING",
            reason,
            endFloor: floor,
            nextDelayMs: Math.max(delayMs * 2, 20_000),
          });
        }
        // daily limit mid-run
        if (hasAny(reason, ["daily", "challenge_limit", "max_daily", "no_challenge"])) {
          onLog?.("WARN", `Hết lượt challenge: ${reason}`);
          lostToday = true; // treat as done for day for climb purposes
          summary.status = "WAITING";
          summary.reason = reason;
          break;
        }
        onLog?.("ERROR", `Tháp T${floor} lỗi: ${reason}`);
        return finish({
          wins,
          losses,
          status: "ERROR",
          reason,
          endFloor: floor,
          nextDelayMs: 5 * 60_000,
        });
      }

      onLog?.("WARN", `Tháp T${floor}: response lạ · dừng`, data);
      return finish({
        wins,
        losses,
        status: "ERROR",
        reason: "unknown_response",
        endFloor: floor,
        nextDelayMs: 5 * 60_000,
      });
    }

    summary.wins = wins;
    summary.losses = losses;
    summary.endFloor = summary.currentFloor;
    summary.nextFloor = Math.max(summary.nextFloor, summary.highestFloor + 1);

    // 5) Sau thua / xong vòng mà không leo được nữa → free sweep rồi chờ 00h
    const shouldEndDay = lostToday || summary.status === "LOST" || summary.status === "WAITING";

    if (shouldEndDay) {
      // refresh charges before sweep
      try {
        const again = await rpc(
          "rpc_tower_get_status",
          { p_character_id: options.characterId },
          options.accessToken
        );
        st = parseStatus(again);
        summary.highestFloor = Math.max(summary.highestFloor, st.highestCleared);
        summary.sweepCharges = st.sweepCharges;
        summary.nextFloor = st.nextFloor;
      } catch {
        /* ignore */
      }

      if (!sweptToday && summary.sweepCharges > 0) {
        await doSweep(summary.sweepCharges);
        if (summary.status === "LOST" || summary.status === "WAITING") {
          summary.status = summary.swept ? "SWEPT" : summary.status;
        }
      }

      const hrs = Math.ceil(waitMidnightMs / 3600_000);
      onLog?.(
        "INFO",
        `Tháp xong ngày · highest ${summary.highestFloor} · WIN ${wins} · ${summary.swept ? "đã càn quét · " : ""}chờ ~${hrs}h → 00:00 VN`
      );
      return finish({ nextDelayMs: waitMidnightMs });
    }

    // Còn win-streak / budget hết vòng → hẹn ngắn leo tiếp trong ngày
    if (wins > 0 && !lostToday) {
      summary.status = "DONE";
      summary.nextDelayMs = Math.max(delayMs, 10_000);
      onLog?.(
        "INFO",
        `Tháp vòng xong · +${wins}W · highest ${summary.highestFloor} · tiếp T${summary.nextFloor}`
      );
      return finish({ nextDelayMs: summary.nextDelayMs });
    }

    // Không đánh được gì
    summary.status = "SKIPPED";
    summary.reason = "no_progress";
    summary.nextDelayMs = Math.max(delayMs, 30_000);
    return finish();
  } catch (err: any) {
    onLog?.("ERROR", `Tháp exception: ${err?.message || "unknown"}`, err?.data);
    return finish({
      status: "ERROR",
      reason: err?.message || "tower_exception",
      nextDelayMs: 5 * 60_000,
    });
  }
}
