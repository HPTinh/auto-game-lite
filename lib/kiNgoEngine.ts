/**
 * Auto Kì ngộ
 * - rpc_trigger_ki_ngo { p_character_id }
 * - Loop đến khi đạt daily_count >= daily_limit, API stop-like, hoặc max_runs
 * - Reset lượt theo mốc 12:00 giờ Việt Nam (caller schedule nextDelayMs)
 */

export type KiNgoLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface KiNgoRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "WAITING" | "ERROR" | "PARTIAL";
  successCount: number;
  failCount: number;
  used?: number;
  limit?: number;
  completedToday: boolean;
  stoppedBeforeLimit: boolean;
  nextDelayMs: number;
  reason?: string;
  lastData?: any;
}

export interface KiNgoAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: KiNgoLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
  /** ms đến mốc 12h VN tiếp theo — nếu không truyền, engine tự tính */
  msUntilNextNoon?: number;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function toProgressNumber(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickFirst(...values: any[]): any {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function findNumberDeep(data: any, keys: string[], seen: any[] = []): number | undefined {
  if (data == null || typeof data !== "object") return undefined;
  if (seen.includes(data)) return undefined;
  seen.push(data);

  if (Array.isArray(data)) {
    for (const item of data) {
      const n = findNumberDeep(item, keys, seen);
      if (n !== undefined) return n;
    }
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const n = toProgressNumber(data[key]);
      if (n !== undefined) return n;
    }
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const n = findNumberDeep(value, keys, seen);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

function extractKiNgoProgress(data: any, fallbackUsed?: number, fallbackLimit?: number) {
  const used = toProgressNumber(
    pickFirst(
      data?.daily_count,
      data?.today_count,
      data?.used_count,
      data?.current_count,
      data?.trigger_count,
      data?.count,
      data?.ki_ngo_count,
      findNumberDeep(data, ["daily_count", "today_count", "used_count", "current_count", "trigger_count", "ki_ngo_count"]),
      fallbackUsed
    )
  );

  const limit = toProgressNumber(
    pickFirst(
      data?.daily_limit,
      data?.today_limit,
      data?.max_count,
      data?.limit_count,
      data?.limit,
      data?.cap,
      data?.ki_ngo_limit,
      findNumberDeep(data, ["daily_limit", "today_limit", "max_count", "limit_count", "ki_ngo_limit"]),
      fallbackLimit
    )
  );

  return { used, limit };
}

function isKiNgoStopLike(errorOrData: any): boolean {
  const text = `${String(errorOrData?.message || "").toLowerCase()} ${JSON.stringify(errorOrData?.data || errorOrData || {}).toLowerCase()}`;
  return ["limit", "daily", "max", "cooldown", "already", "hết", "het", "no encounter", "not_available"].some((key) =>
    text.includes(key)
  );
}

function isKiNgoDailyLimitReached(usedValue: any, limitValue: any): boolean {
  const usedNumber = Number(usedValue);
  const limitNumber = Number(limitValue);
  // Chỉ DONE khi có số rõ ràng và count chạm limit — không tin cooldown/can_continue=false
  return Number.isFinite(usedNumber) && Number.isFinite(limitNumber) && limitNumber > 0 && usedNumber >= limitNumber;
}

/** ms đến 12:00 giờ Việt Nam tiếp theo */
export function msUntilNextVietnamNoon(nowMs = Date.now()): number {
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnNow = new Date(nowMs + vnOffset);
  let nextUtcMs = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), 12, 0, 0) - vnOffset;
  if (nextUtcMs <= nowMs) {
    nextUtcMs = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate() + 1, 12, 0, 0) - vnOffset;
  }
  return Math.max(60_000, nextUtcMs - nowMs);
}

async function triggerKiNgo(characterId: string, accessToken: string): Promise<{ ok: boolean; status: number; data: any; message?: string }> {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_trigger_ki_ngo`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "auto-lite/1.0",
    },
    body: JSON.stringify({ p_character_id: characterId }),
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok || data?.ok === false) {
    const message = data?.error || data?.reason || data?.message || text || `HTTP ${res.status}`;
    return { ok: false, status: res.status, data, message };
  }
  return { ok: true, status: res.status, data };
}

export async function runKiNgoAuto(options: KiNgoAutoOptions): Promise<KiNgoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const maxLoops = Math.max(1, Math.min(100, Math.floor(Number(settings.max_runs_per_check || 30)) || 30));
  const continueDelayMs = Math.max(30_000, Number(settings.continue_delay_seconds || 60) * 1000);
  const loopDelayMs = Math.max(200, Number(settings.loop_delay_ms || 400));
  const nextNoonMs = Math.max(60_000, Number(options.msUntilNextNoon || msUntilNextVietnamNoon()));

  let used = toProgressNumber(settings.daily_count ?? settings.used_count ?? settings.current_count);
  let limit = toProgressNumber(settings.daily_limit ?? settings.max_count ?? settings.limit_count);

  const summary: KiNgoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "WAITING",
    successCount: 0,
    failCount: 0,
    used,
    limit,
    completedToday: false,
    stoppedBeforeLimit: false,
    nextDelayMs: continueDelayMs,
  };

  let lastData: any = null;
  let stoppedByStopLike = false;
  let stoppedByApiContinueFalse = false;

  onLog?.(
    "INFO",
    `Kì ngộ: bắt đầu · max ${maxLoops} lần · tiến độ ${used ?? "?"}/${limit ?? "?"}`
  );

  for (let i = 1; i <= maxLoops; i++) {
    if (options.shouldStop?.()) {
      onLog?.("WARN", "Kì ngộ: dừng theo yêu cầu");
      break;
    }

    try {
      const res = await triggerKiNgo(options.characterId, options.accessToken);

      if (!res.ok) {
        const progress = extractKiNgoProgress(res.data, used, limit);
        if (Number.isFinite(progress.used as number)) used = progress.used;
        if (Number.isFinite(progress.limit as number)) limit = progress.limit;

        if (isKiNgoStopLike({ message: res.message, data: res.data })) {
          stoppedByStopLike = true;
          onLog?.("WARN", `Kì ngộ tạm dừng: ${res.message}`, {
            ...(res.data || {}),
            daily_count: used,
            daily_limit: limit,
          });
          break;
        }

        summary.failCount += 1;
        onLog?.("ERROR", `Kì ngộ lỗi: ${res.message}`, res.data);
        break;
      }

      summary.successCount += 1;
      lastData = res.data;

      const progress = extractKiNgoProgress(res.data, used, limit);
      if (Number.isFinite(progress.used as number)) used = progress.used;
      else used = (used || 0) + 1;
      if (Number.isFinite(progress.limit as number)) limit = progress.limit;

      onLog?.(
        "SUCCESS",
        `Kì ngộ OK ${Number.isFinite(used as number) && Number.isFinite(limit as number) ? `${used}/${limit}` : `lần ${summary.successCount}`}`
      );

      if (Number.isFinite(used as number) && Number.isFinite(limit as number) && (limit as number) > 0 && (used as number) >= (limit as number)) {
        onLog?.("SUCCESS", `Kì ngộ đủ ngày: ${used}/${limit}`);
        break;
      }

      const canContinue = res.data?.can_continue ?? res.data?.canContinue ?? res.data?.continue;
      if (canContinue === false) {
        stoppedByApiContinueFalse = true;
        onLog?.("INFO", "API báo không còn Kì ngộ để chạy tiếp", res.data);
        break;
      }

      if (i < maxLoops) await sleep(loopDelayMs);
    } catch (error: any) {
      if (isKiNgoStopLike(error)) {
        stoppedByStopLike = true;
        onLog?.("WARN", error.message || "Kì ngộ tạm dừng (cooldown/hết lượt)", error?.data);
      } else {
        summary.failCount += 1;
        onLog?.("ERROR", error.message || "Kì ngộ lỗi không xác định", error?.data);
      }
      break;
    }
  }

  const safeUsed = Number.isFinite(used as number) ? Number(used) : summary.successCount;
  const safeLimit = Number.isFinite(limit as number) ? Number(limit) : undefined;
  const completedToday = isKiNgoDailyLimitReached(safeUsed, safeLimit);
  const stoppedBeforeLimit = (stoppedByStopLike || stoppedByApiContinueFalse) && !completedToday;

  summary.used = safeUsed;
  summary.limit = safeLimit;
  summary.completedToday = completedToday;
  summary.stoppedBeforeLimit = stoppedBeforeLimit;
  summary.lastData = lastData;

  if (summary.failCount > 0 && summary.successCount === 0 && !completedToday && !stoppedBeforeLimit) {
    summary.status = "ERROR";
    summary.nextDelayMs = Math.max(45_000, continueDelayMs);
    summary.reason = "Kì ngộ lỗi";
  } else if (completedToday) {
    summary.status = "DONE";
    summary.nextDelayMs = nextNoonMs;
    summary.reason = `Đủ ${safeUsed}/${safeLimit} · chờ 12h VN`;
  } else {
    summary.status = summary.successCount > 0 || stoppedBeforeLimit ? "WAITING" : "PARTIAL";
    summary.nextDelayMs = continueDelayMs;
    summary.reason = stoppedBeforeLimit
      ? `Chưa đủ · ${safeUsed}/${safeLimit ?? "?"} · hẹn lại`
      : `Hết vòng · ${safeUsed}/${safeLimit ?? "?"}`;
  }

  summary.finishedAt = new Date().toISOString();

  onLog?.(
    completedToday || summary.successCount > 0 ? "SUCCESS" : summary.status === "ERROR" ? "ERROR" : "WARN",
    `Kì ngộ xong · ${summary.status} · ${safeUsed}/${safeLimit ?? "?"} · ok ${summary.successCount} fail ${summary.failCount} · next ${Math.round(summary.nextDelayMs / 60000)}p`
  );

  return summary;
}
