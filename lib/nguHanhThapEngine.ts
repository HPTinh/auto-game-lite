/**
 * Auto Ngũ Hành Tháp
 * - rpc_tower_challenge_floor { p_character_id, p_floor_number }
 * - Thắng → leo tiếp floor+1
 * - Thua → ngưng (pause)
 * - not_enough_stamina → rpc_use_item pill_{tier}_sta (giống craft / use_item.txt)
 *
 * Capture: ngu_hanh_thap.txt
 */

export type TowerLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export type TowerStatus =
  | "DONE"
  | "LOST"
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
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const TIER_ORDER = ["lk", "tc", "kd", "na", "ht", "lh"] as const;
type PillTier = (typeof TIER_ORDER)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const clamp = (n: number, min: number, max: number, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
};

const reasonOf = (data: any) =>
  String(data?.message || data?.reason || data?.error || data?.code || data?.details || "").toLowerCase();

const hasAny = (text: string, keywords: string[]) => keywords.some((k) => text.includes(k));

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

function normalizePillTier(raw: any, fallback: PillTier = "tc"): PillTier {
  const t = String(raw || "").toLowerCase().trim();
  if ((TIER_ORDER as readonly string[]).includes(t)) return t as PillTier;
  return fallback;
}

function staminaItemCode(settings: Record<string, any>): string {
  const custom = String(settings.stamina_item_code || settings.recover_stamina_item_code || "").trim();
  if (custom) return custom;
  const tier = normalizePillTier(settings.stamina_pill_tier || settings.sta_pill_tier || "tc");
  return `pill_${tier}_sta`;
}

function spiritItemCode(settings: Record<string, any>): string {
  const custom = String(settings.spirit_item_code || settings.soul_item_code || "").trim();
  if (custom) return custom;
  const tier = normalizePillTier(settings.spirit_pill_tier || settings.soul_pill_tier || "tc");
  return `pill_${tier}_spirit`;
}

/** use_item.txt: success thường không có ok:true, có used / heal_stamina */
function isUseItemOk(used: any): boolean {
  if (!used || typeof used !== "object") return false;
  if (used.ok === false) return false;
  const reason = reasonOf(used);
  if (reason && /not_found|missing|no_item|item_not|insufficient|not_enough|không|het|hết|fail|error|invalid/.test(reason)) {
    return false;
  }
  if (used.used || used.item_code || used.itemCode) return true;
  if (used.heal_stamina != null || used.heal_spirit != null) return true;
  if (used.stamina_after != null || used.spirit_after != null) return true;
  return used.ok === true;
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

function isSpiritError(msg: string, data?: any): boolean {
  const s = `${msg} ${reasonOf(data)} ${JSON.stringify(data || {})}`.toLowerCase();
  return hasAny(s, ["not_enough_spirit", "spirit", "than_hon", "thần hồn", "linh_khi"]);
}

function isVictory(data: any): boolean {
  if (!data || data.ok === false) return false;
  const r = String(data.result || data.outcome || data.status || "").toLowerCase();
  if (["victory", "win", "won", "clear", "success", "passed"].includes(r)) return true;
  if (data.ok === true && (data.guardian_hp === 0 || data.new_highest != null || data.is_first_clear != null)) {
    // victory capture: ok + result victory; fallback nếu thiếu result
    if (!r || r === "victory") return true;
  }
  return false;
}

function isDefeat(data: any): boolean {
  if (!data) return false;
  const r = String(data.result || data.outcome || data.status || "").toLowerCase();
  if (["defeat", "loss", "lose", "lost", "fail", "failed"].includes(r)) return true;
  if (data.ok === true && data.player_hp === 0 && data.guardian_hp > 0) return true;
  return false;
}

/** Floor đã clear / không đúng thứ tự → nhảy lên */
function isSkipFloorError(msg: string, data?: any): boolean {
  const s = `${msg} ${reasonOf(data)}`.toLowerCase();
  return hasAny(s, [
    "already_cleared",
    "already_complete",
    "floor_too_low",
    "must_clear",
    "need_higher",
    "invalid_floor",
    "floor_locked",
    "not_unlocked",
    "too_low",
  ]);
}

function extractFloor(data: any, fallback: number): number {
  const n = Number(data?.floor_number ?? data?.floor ?? data?.p_floor_number ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function extractHighest(data: any, fallback: number): number {
  const n = Number(data?.new_highest ?? data?.highest ?? data?.highest_floor ?? data?.max_floor ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export async function runNguHanhThapAuto(options: TowerAutoOptions): Promise<TowerRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const delayMs = clamp(settings.delay_ms ?? settings.floor_delay_ms ?? 1500, 400, 30_000, 1500);
  const maxFloors = clamp(settings.max_floors_per_run ?? settings.max_floors ?? 40, 1, 200, 40);
  const pauseLossMin = clamp(settings.pause_on_loss_minutes ?? 60, 5, 24 * 60, 60);
  const retryDelayMs = clamp(settings.retry_delay_ms ?? 700, 200, 5000, 700);
  const maxRecoveryUses = clamp(settings.max_recovery_uses ?? 8, 1, 30, 8);
  const autoRecover = settings.auto_use_recovery_items !== false;
  const startFloorSetting = clamp(settings.start_floor ?? 1, 1, 9999, 1);
  let currentFloor = clamp(settings.current_floor ?? startFloorSetting, 1, 9999, startFloorSetting);
  let highestFloor = clamp(settings.highest_floor ?? Math.max(0, currentFloor - 1), 0, 9999, 0);

  // Nếu lần trước thua và còn trong pause → chờ
  const lossUntil = String(settings.loss_pause_until || "");
  if (lossUntil) {
    const until = Date.parse(lossUntil);
    if (Number.isFinite(until) && until > Date.now()) {
      const wait = until - Date.now();
      onLog?.("INFO", `Ngũ Hành Tháp: đang pause sau thua · còn ~${Math.ceil(wait / 60_000)}p`);
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "WAITING",
        wins: 0,
        losses: 0,
        floorsTried: 0,
        startFloor: currentFloor,
        endFloor: currentFloor,
        currentFloor,
        highestFloor,
        nextDelayMs: wait,
        reason: "loss_pause",
        usedItems: [],
        floors: [],
        persist: {
          current_floor: currentFloor,
          highest_floor: highestFloor,
          loss_pause_until: lossUntil,
        },
      };
    }
  }

  const usedItems: TowerRunSummary["usedItems"] = [];
  const floors: TowerFloorResult[] = [];
  const startFloor = currentFloor;
  let wins = 0;
  let losses = 0;

  const summary: TowerRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    wins: 0,
    losses: 0,
    floorsTried: 0,
    startFloor,
    endFloor: currentFloor,
    currentFloor,
    highestFloor,
    nextDelayMs: Math.max(delayMs, 10_000),
    usedItems,
    floors,
    persist: {},
  };

  const usePill = async (kind: "stamina" | "spirit") => {
    const itemCode = kind === "stamina" ? staminaItemCode(settings) : spiritItemCode(settings);
    onLog?.("WARN", `Tháp thiếu ${kind === "stamina" ? "STA" : "thần hồn"} → rpc_use_item ${itemCode}`);
    let used: any;
    try {
      used = await rpc(
        "rpc_use_item",
        { p_character_id: options.characterId, p_item_code: itemCode },
        options.accessToken
      );
    } catch (err: any) {
      used = err?.data || { ok: false, reason: err?.message || "use_item_error" };
    }
    const ok = isUseItemOk(used);
    usedItems.push({ itemCode, ok, raw: used });
    if (!ok) {
      onLog?.("WARN", `Dùng ${itemCode} fail: ${reasonOf(used) || "unknown"}`);
    } else {
      const extra =
        kind === "stamina" && used?.heal_stamina != null
          ? ` · +${used.heal_stamina} STA → ${used.stamina_after ?? "?"}/${used.stamina_max ?? "?"}`
          : kind === "spirit" && used?.heal_spirit != null
            ? ` · +${used.heal_spirit} spirit`
            : "";
      onLog?.("SUCCESS", `Đã dùng ${itemCode}${extra}`);
    }
    await sleep(retryDelayMs);
    return ok;
  };

  const challenge = async (floor: number): Promise<{ data?: any; error?: any }> => {
    try {
      const data = await rpc(
        "rpc_tower_challenge_floor",
        { p_character_id: options.characterId, p_floor_number: floor },
        options.accessToken
      );
      return { data };
    } catch (err: any) {
      return { error: err, data: err?.data };
    }
  };

  onLog?.(
    "INFO",
    `Ngũ Hành Tháp: bắt đầu từ tầng ${currentFloor} · max ${maxFloors}/vòng · STA pill ${staminaItemCode(settings)}`
  );

  try {
    for (let i = 0; i < maxFloors; i += 1) {
      if (options.shouldStop?.()) {
        summary.status = "PARTIAL";
        summary.reason = "stopped";
        break;
      }

      summary.floorsTried += 1;
      let data: any;
      let lastErr: any;
      let recovered = false;

      for (let attempt = 0; attempt < 1 + maxRecoveryUses; attempt += 1) {
        if (options.shouldStop?.()) break;
        const res = await challenge(currentFloor);
        data = res.data;
        lastErr = res.error;

        // PostgREST not_enough_stamina (ngu_hanh_thap.txt)
        const errMsg = lastErr?.message || reasonOf(data) || "";
        if (lastErr || (data && data.ok === false && !isVictory(data) && !isDefeat(data))) {
          if (autoRecover && isStaminaError(errMsg, data)) {
            if (attempt >= maxRecoveryUses) break;
            const ok = await usePill("stamina");
            if (!ok) {
              summary.status = "NO_STA";
              summary.reason = "not_enough_stamina_and_no_pill";
              break;
            }
            recovered = true;
            continue;
          }
          if (autoRecover && isSpiritError(errMsg, data)) {
            if (attempt >= maxRecoveryUses) break;
            const ok = await usePill("spirit");
            if (!ok) break;
            recovered = true;
            continue;
          }
        }
        break;
      }

      if (summary.status === "NO_STA") {
        onLog?.("WARN", `Tháp dừng: hết STA và không uống được pill (tầng ${currentFloor})`);
        summary.nextDelayMs = Math.max(30 * 60_000, pauseLossMin * 60_000);
        break;
      }

      const errMsg = lastErr?.message || reasonOf(data) || "";

      // Skip / jump floor
      if (lastErr && isSkipFloorError(errMsg, data)) {
        onLog?.("WARN", `Tầng ${currentFloor}: ${errMsg || "skip"} → +1`);
        floors.push({ floor: currentFloor, ok: false, reason: errMsg || "skip_floor", raw: data });
        currentFloor += 1;
        await sleep(delayMs);
        continue;
      }

      if (isVictory(data)) {
        const floorDone = extractFloor(data, currentFloor);
        highestFloor = Math.max(highestFloor, extractHighest(data, floorDone));
        wins += 1;
        const rewards = data?.rewards;
        const rewardText = rewards
          ? Object.entries(rewards)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "";
        onLog?.(
          "SUCCESS",
          `Tháp T${floorDone} WIN${data?.element_bonus ? " · hệ +" : ""}${rewardText ? " · " + rewardText : ""} · highest ${highestFloor}${recovered ? " (sau hồi STA)" : ""}`
        );
        floors.push({
          floor: floorDone,
          ok: true,
          result: "victory",
          rewards,
          newHighest: highestFloor,
          element: data?.element,
          raw: data,
        });
        currentFloor = Math.max(currentFloor + 1, floorDone + 1, highestFloor + 1);
        await sleep(delayMs);
        continue;
      }

      if (isDefeat(data) || (data && data.ok === true && !isVictory(data) && String(data.result || "").length > 0)) {
        losses += 1;
        const floorDone = extractFloor(data, currentFloor);
        onLog?.("WARN", `Tháp T${floorDone} THUA · ngưng leo · pause ${pauseLossMin}p`);
        floors.push({
          floor: floorDone,
          ok: false,
          result: String(data?.result || "defeat"),
          reason: "defeat",
          raw: data,
        });
        summary.status = "LOST";
        summary.reason = "defeat";
        summary.nextDelayMs = pauseLossMin * 60_000;
        summary.persist.loss_pause_until = new Date(Date.now() + summary.nextDelayMs).toISOString();
        // Giữ currentFloor = tầng vừa thua để lần sau thử lại
        currentFloor = floorDone;
        break;
      }

      // Lỗi khác
      if (lastErr || !data || data.ok === false) {
        const reason = errMsg || "tower_error";
        // Một số case “already at max” / hết lượt
        if (hasAny(reason, ["cooldown", "too_fast", "rate_limit"])) {
          onLog?.("WARN", `Tháp cooldown: ${reason}`);
          summary.status = "WAITING";
          summary.reason = reason;
          summary.nextDelayMs = Math.max(delayMs * 2, 15_000);
          floors.push({ floor: currentFloor, ok: false, reason, raw: data });
          break;
        }
        onLog?.("ERROR", `Tháp T${currentFloor} lỗi: ${reason}`);
        floors.push({ floor: currentFloor, ok: false, reason, raw: data });
        summary.status = "ERROR";
        summary.reason = reason;
        summary.nextDelayMs = Math.max(5 * 60_000, pauseLossMin * 30_000);
        break;
      }

      // Không parse được → dừng an toàn
      onLog?.("WARN", `Tháp T${currentFloor}: response lạ · dừng`, data);
      floors.push({ floor: currentFloor, ok: false, reason: "unknown_response", raw: data });
      summary.status = "ERROR";
      summary.reason = "unknown_response";
      break;
    }

    if (summary.status === "DONE" && wins > 0) {
      // Còn win-streak, hẹn vòng sau để leo tiếp
      summary.nextDelayMs = Math.max(delayMs, Number(settings.interval_seconds || 15) * 1000);
      onLog?.("INFO", `Tháp xong vòng: +${wins} tầng · tiếp T${currentFloor} · highest ${highestFloor}`);
    } else if (summary.status === "DONE" && wins === 0 && summary.floorsTried === 0) {
      summary.status = "SKIPPED";
      summary.reason = "no_attempt";
    }
  } catch (err: any) {
    summary.status = "ERROR";
    summary.reason = err?.message || "tower_exception";
    onLog?.("ERROR", `Tháp exception: ${summary.reason}`, err?.data);
    summary.nextDelayMs = 5 * 60_000;
  }

  summary.wins = wins;
  summary.losses = losses;
  summary.currentFloor = currentFloor;
  summary.highestFloor = highestFloor;
  summary.endFloor = currentFloor;
  summary.finishedAt = new Date().toISOString();
  summary.usedItems = usedItems;
  summary.floors = floors;
  summary.persist = {
    current_floor: currentFloor,
    highest_floor: highestFloor,
    start_floor: startFloorSetting,
    last_run_at: summary.finishedAt,
    last_status: summary.status,
    last_wins: wins,
    ...(summary.persist.loss_pause_until
      ? { loss_pause_until: summary.persist.loss_pause_until }
      : summary.status !== "LOST"
        ? { loss_pause_until: "" }
        : {}),
  };

  return summary;
}
