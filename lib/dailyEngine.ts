"use client";

export type DailyLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface DailyTaskResult {
  key: string;
  label: string;
  status: "SUCCESS" | "WARN" | "ERROR" | "SKIPPED";
  message: string;
  data?: any;
}

export interface DailyRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "PARTIAL_ERROR" | "ERROR";
  successCount: number;
  warnCount: number;
  errorCount: number;
  skippedCount: number;
  tasks: DailyTaskResult[];
}

export interface DailyAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: DailyLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

function normalizeBool(value: any, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
  }
  return Boolean(value);
}

function firstArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.achievements)) return value.achievements;
  return [];
}

function isClaimableAchievement(item: any) {
  if (!item || typeof item !== "object") return false;
  if (item.claimed === true || item.is_claimed === true || item.claimed_at) return false;
  if (item.claimable === true || item.can_claim === true || item.status === "claimable" || item.completed === true) return true;
  return false;
}

function getAchievementCode(item: any) {
  return item?.achievement_code || item?.code || item?.id || item?.achievementId;
}

function isSoftDailyError(error: any) {
  const msg = String(error?.message || "").toLowerCase();
  const raw = JSON.stringify(error?.data || {}).toLowerCase();
  const text = `${msg} ${raw}`;
  return [
    "already",
    "claimed",
    "no_reward",
    "no reward",
    "not_available",
    "not available",
    "cooldown",
    "daily_limit",
    "limit",
    "không có",
    "da nhan",
    "đã nhận",
  ].some(key => text.includes(key));
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
    credentials: "omit",
    mode: "cors",
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error: any = new Error(`[${name}] HTTP ${res.status}: ${text}`);
    error.data = data;
    throw error;
  }

  if (data && data.ok === false) {
    const reason = data.error || data.reason || data.message || data.code || "ok_false";
    const error: any = new Error(`[${name}] ${reason}`);
    error.data = data;
    throw error;
  }

  return data;
}

function makeSummary(): DailyRunSummary {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    successCount: 0,
    warnCount: 0,
    errorCount: 0,
    skippedCount: 0,
    tasks: [],
  };
}

function finishSummary(summary: DailyRunSummary) {
  summary.finishedAt = new Date().toISOString();
  if (summary.errorCount > 0 && summary.successCount === 0 && summary.warnCount === 0) summary.status = "ERROR";
  else if (summary.errorCount > 0 || summary.warnCount > 0) summary.status = "PARTIAL_ERROR";
  else summary.status = "DONE";
  return summary;
}

async function runSingleTask(
  options: DailyAutoOptions,
  key: string,
  label: string,
  fn: () => Promise<{ message: string; data?: any; status?: "SUCCESS" | "WARN" }>
): Promise<DailyRunSummary> {
  const summary = makeSummary();
  const onLog = options.onLog;

  try {
    onLog?.("INFO", `${label}: đang chạy...`);
    const result = await fn();
    const status = result.status || "SUCCESS";
    summary.tasks.push({ key, label, status, message: result.message, data: result.data });

    if (status === "SUCCESS") {
      summary.successCount += 1;
      onLog?.("SUCCESS", `${label}: ${result.message}`, result.data);
    } else {
      summary.warnCount += 1;
      onLog?.("WARN", `${label}: ${result.message}`, result.data);
    }
  } catch (error: any) {
    const soft = isSoftDailyError(error);
    summary.tasks.push({
      key,
      label,
      status: soft ? "WARN" : "ERROR",
      message: error?.message || "Lỗi không xác định.",
      data: error?.data,
    });
    if (soft) {
      summary.warnCount += 1;
      onLog?.("WARN", `${label}: ${error?.message || "soft error"}`, error?.data);
    } else {
      summary.errorCount += 1;
      onLog?.("ERROR", `${label}: ${error?.message || "error"}`, error?.data);
    }
  }

  return finishSummary(summary);
}

function cleanPayload(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function uniqueStrings(values: any[]) {
  const seen = new Set<string>();
  return values
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .filter(value => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function uniquePayloads(payloads: Record<string, any>[]) {
  const seen = new Set<string>();
  return payloads
    .map(cleanPayload)
    .filter(payload => Object.keys(payload).length > 0)
    .filter(payload => {
      const key = JSON.stringify(payload, Object.keys(payload).sort());
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function deepFindValue(source: any, names: string[], depth = 0): any {
  if (!source || depth > 5) return undefined;
  if (typeof source !== "object") return undefined;

  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null && source[name] !== "") return source[name];
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = deepFindValue(item, names, depth + 1);
      if (found !== undefined && found !== null && found !== "") return found;
    }
    return undefined;
  }

  for (const value of Object.values(source)) {
    const found = deepFindValue(value, names, depth + 1);
    if (found !== undefined && found !== null && found !== "") return found;
  }

  return undefined;
}

function normalizeBodyCultStatus(value: any) {
  return String(value || "").trim().toLowerCase();
}

function looksLikeBodyCultSession(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).map(key => key.toLowerCase());
  return [
    "remaining_seconds",
    "remainingseconds",
    "seconds_left",
    "time_left",
    "status",
    "session_status",
    "training_status",
    "training_session_id",
    "next_harvest_at",
    "complete_at",
    "completed_at",
    "ends_at",
    "expires_at",
  ].some(key => keys.includes(key));
}

function deepFindBodyCultSession(source: any, depth = 0): any {
  if (!source || depth > 6) return null;
  if (looksLikeBodyCultSession(source)) return source;

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = deepFindBodyCultSession(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof source === "object") {
    for (const value of Object.values(source)) {
      const found = deepFindBodyCultSession(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function getBodyCultSession(data: any) {
  return (
    data?.training_session ||
    data?.body_cultivation?.training_session ||
    data?.bodyCultivation?.trainingSession ||
    data?.data?.training_session ||
    data?.session ||
    data?.current_session ||
    deepFindBodyCultSession(data) ||
    null
  );
}

function getBodyCultStatus(session: any, fallbackData?: any) {
  return normalizeBodyCultStatus(
    session?.status ||
      session?.session_status ||
      session?.training_status ||
      fallbackData?.status ||
      fallbackData?.session_status ||
      fallbackData?.training_status
  );
}

function isBodyCultActive(session: any, fallbackData?: any) {
  const status = getBodyCultStatus(session, fallbackData);
  const completed = session?.completed === true || session?.is_completed === true || status === "completed" || status === "claimable";
  if (completed) return false;
  if (["active", "running", "training", "in_progress", "processing"].includes(status)) return true;
  return getRemainingSeconds(session, fallbackData) > 0 && !completed;
}

function isBodyCultClaimable(session: any, fallbackData?: any) {
  const status = getBodyCultStatus(session, fallbackData);
  return (
    session?.completed === true ||
    session?.is_completed === true ||
    session?.claimable === true ||
    session?.can_claim === true ||
    fallbackData?.claimable === true ||
    fallbackData?.can_claim === true ||
    ["completed", "claimable", "done", "finished", "ready_to_claim"].includes(status)
  );
}

function secondsUntil(value: any) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

function getRemainingSeconds(session: any, fallbackData?: any) {
  const direct =
    session?.remaining_seconds ??
    session?.remainingSeconds ??
    session?.seconds_left ??
    session?.secondsLeft ??
    session?.time_left ??
    session?.timeLeft ??
    fallbackData?.remaining_seconds ??
    fallbackData?.remainingSeconds ??
    fallbackData?.seconds_left ??
    fallbackData?.time_left;

  const numeric = Number(direct);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(0, Math.floor(numeric));

  return Math.max(
    secondsUntil(session?.next_harvest_at || session?.nextHarvestAt || fallbackData?.next_harvest_at),
    secondsUntil(session?.complete_at || session?.completeAt || session?.completed_at || fallbackData?.complete_at),
    secondsUntil(session?.ends_at || session?.endsAt || fallbackData?.ends_at),
    secondsUntil(session?.expires_at || session?.expiresAt || fallbackData?.expires_at)
  );
}

function bodyCultNextDelayMs(status: any, fallbackMinutes = 10) {
  const session = getBodyCultSession(status);
  if (isBodyCultActive(session, status)) {
    const remaining = getRemainingSeconds(session, status);
    return Math.max(60_000, (remaining + 5) * 1000);
  }

  return Math.max(60_000, fallbackMinutes * 60_000);
}

function bodyCultNextHarvestAt(delayMs: number) {
  return new Date(Date.now() + Math.max(60_000, delayMs)).toISOString();
}

function makeBodyCultStartPayloads(options: DailyAutoOptions, statusData: any) {
  const settings = options.settings || {};
  const statusElement = deepFindValue(statusData, [
    "p_element",
    "element",
    "dominant_element",
    "dominantElement",
    "body_element",
    "bodyElement",
  ]);

  const element = settings.p_element || settings.element || settings.body_element || settings.bodyElement || statusElement;
  const sessionType = settings.p_session_type || settings.session_type || settings.training_type || settings.training_mode || settings.mode || "long";
  const durationMinutes = settings.p_duration_minutes || settings.duration_minutes || settings.training_minutes;
  const durationSeconds = settings.p_duration_sec || settings.duration_sec || settings.training_seconds;
  const mode = settings.p_mode || settings.mode || sessionType;

  return uniquePayloads([
    { p_character_id: options.characterId },
    { p_character_id: options.characterId, p_session_type: sessionType },
    { p_character_id: options.characterId, p_training_type: sessionType },
    { p_character_id: options.characterId, p_training_mode: sessionType },
    { p_character_id: options.characterId, p_type: sessionType },
    { p_character_id: options.characterId, p_mode: mode },
    { p_character_id: options.characterId, p_duration_type: sessionType },
    { p_character_id: options.characterId, p_element: element },
    { p_character_id: options.characterId, p_element: element, p_session_type: sessionType },
    { p_character_id: options.characterId, p_element: element, p_training_type: sessionType },
    { p_character_id: options.characterId, p_element: element, p_training_mode: sessionType },
    { p_character_id: options.characterId, p_element: element, p_mode: mode },
    { p_character_id: options.characterId, p_duration_minutes: durationMinutes },
    { p_character_id: options.characterId, p_minutes: durationMinutes },
    { p_character_id: options.characterId, p_training_minutes: durationMinutes },
    { p_character_id: options.characterId, p_duration_sec: durationSeconds },
    { p_character_id: options.characterId, p_duration_seconds: durationSeconds },
  ]);
}

function makeBodyCultStartRpcNames(settings: Record<string, any> = {}) {
  return uniqueStrings([
    settings.body_cult_start_rpc,
    settings.start_rpc,
    settings.rpc_start,
    "rpc_body_cult_start_training",
    "rpc_start_body_cultivation",
    "rpc_body_cultivation_start",
    "rpc_body_cult_start",
    "rpc_start_body_training",
    "rpc_body_cult_start_session",
    "rpc_start_training_session",
  ]);
}

function makeBodyCultClaimRpcNames(settings: Record<string, any> = {}) {
  return uniqueStrings([
    settings.body_cult_claim_rpc,
    settings.claim_rpc,
    settings.rpc_claim,
    "rpc_body_cult_claim_training",
    "rpc_claim_body_cultivation",
    "rpc_body_cultivation_claim",
    "rpc_body_cult_claim",
    "rpc_claim_training_session",
  ]);
}

async function tryBodyCultClaim(options: DailyAutoOptions) {
  const names = makeBodyCultClaimRpcNames(options.settings || {});
  const errors: any[] = [];

  for (const rpcName of names) {
    const payload = { p_character_id: options.characterId };
    try {
      options.onLog?.("DEBUG", `Thử claim thể tu qua ${rpcName}.`, { rpcName, payload });
      const data = await rpc(rpcName, payload, options.accessToken);
      options.onLog?.("SUCCESS", `Claim thể tu thành công qua ${rpcName}.`, { rpcName, payload, data });
      return { ok: true, rpcName, payload, data, errors };
    } catch (error: any) {
      errors.push({ rpcName, payload, error: error?.message, data: error?.data });
      options.onLog?.("WARN", `Claim thể tu lỗi qua ${rpcName}.`, { rpcName, payload, error: error?.message, data: error?.data });
    }
  }

  return { ok: false, data: null, errors };
}

async function tryBodyCultStart(options: DailyAutoOptions, statusData: any) {
  const rpcNames = makeBodyCultStartRpcNames(options.settings || {});
  const payloads = makeBodyCultStartPayloads(options, statusData);
  const errors: any[] = [];

  for (const rpcName of rpcNames) {
    for (const payload of payloads) {
      try {
        options.onLog?.("DEBUG", `Thử start thể tu qua ${rpcName}.`, { rpcName, payload });
        const data = await rpc(rpcName, payload, options.accessToken);
        options.onLog?.("SUCCESS", `Start thể tu thành công qua ${rpcName}.`, { rpcName, payload, data });
        return { ok: true, rpcName, payload, data, errors };
      } catch (error: any) {
        errors.push({ rpcName, payload, error: error?.message, data: error?.data });
        options.onLog?.("WARN", `Start thể tu lỗi qua ${rpcName}.`, { rpcName, payload, error: error?.message, data: error?.data });
      }
    }
  }

  return { ok: false, data: null, errors };
}

export async function runBodyCultAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  return runSingleTask(options, "body_cult", "Thể tu", async () => {
    // Không cần người dùng cài giờ claim thủ công nữa:
    // luôn đọc status thật từ rpc_get_body_cultivation, rồi cache remaining_seconds/next_harvest_at ở page.tsx.
    const fallbackMinutes = Math.max(1, Number(options.settings?.retry_minutes || 10));
    const before = await rpc("rpc_get_body_cultivation", { p_character_id: options.characterId }, options.accessToken);
    const beforeSession = getBodyCultSession(before);

    if (isBodyCultActive(beforeSession, before)) {
      const remaining = getRemainingSeconds(beforeSession, before);
      const nextDelayMs = bodyCultNextDelayMs(before, fallbackMinutes);
      return {
        message: `Thể tu đang active, còn khoảng ${remaining}s.`,
        status: "SUCCESS",
        data: {
          before,
          detectedSession: beforeSession,
          nextDelayMs,
          nextHarvestAt: bodyCultNextHarvestAt(nextDelayMs),
          remainingSeconds: remaining,
          mode: "already_active",
        },
      };
    }

    let claim: any = null;
    let start: any = null;
    const canTryClaim = isBodyCultClaimable(beforeSession, before) || !beforeSession;

    if (canTryClaim) {
      claim = await tryBodyCultClaim(options);
    }

    if (normalizeBool(options.settings?.auto_start, true)) {
      start = await tryBodyCultStart(options, before);
    }

    let after: any = null;
    try {
      after = await rpc("rpc_get_body_cultivation", { p_character_id: options.characterId }, options.accessToken);
    } catch (error: any) {
      options.onLog?.("WARN", "Không đọc lại được trạng thái thể tu sau claim/start.", error?.data);
    }

    const afterSession = getBodyCultSession(after || before);
    const nextDelayMs = bodyCultNextDelayMs(after || before, fallbackMinutes);
    const remainingSeconds = getRemainingSeconds(afterSession, after || before);
    const isActive = isBodyCultActive(afterSession, after || before);

    return {
      message: isActive
        ? `Thể tu active, hẹn thu hoạch/check lại sau ${Math.ceil(nextDelayMs / 60000)} phút.`
        : "Thể tu chưa active. Đã ghi rõ RPC/payload start lỗi để đối chiếu Network.",
      status: isActive ? "SUCCESS" : "WARN",
      data: {
        before,
        beforeSession,
        claim,
        start,
        after,
        afterSession,
        nextDelayMs,
        nextHarvestAt: bodyCultNextHarvestAt(nextDelayMs),
        remainingSeconds,
        mode: isActive ? (start?.ok ? "started" : "claim_then_active") : "claim_start_failed_or_not_ready",
      },
    };
  });
}

export async function runClaimExpAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  return runSingleTask(options, "claim_exp", "Claim EXP", async () => {
    const data = await rpc("rpc_claim_auto_cultivation_v4_v2", { p_character_id: options.characterId }, options.accessToken);
    return { message: "Đã gọi claim EXP.", data };
  });
}

export async function runWorldCupCheckinAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  return runSingleTask(options, "world_cup_checkin", "World Cup checkin", async () => {
    let statusData: any = null;
    try {
      statusData = await rpc("rpc_wc_status", { p_character_id: options.characterId }, options.accessToken);
    } catch (error: any) {
      options.onLog?.("WARN", "World Cup status lỗi, vẫn thử checkin.", error?.data);
    }
    const data = await rpc("rpc_wc_checkin", { p_character_id: options.characterId }, options.accessToken);
    return { message: "Đã gọi World Cup checkin.", data: { status: statusData, checkin: data } };
  });
}

export async function runOnboardingClaimAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  return runSingleTask(options, "onboarding_claim", "Onboarding claim", async () => {
    let statusData: any = null;
    try {
      statusData = await rpc("rpc_onboarding_get_status", { p_character_id: options.characterId }, options.accessToken);
    } catch (error: any) {
      options.onLog?.("WARN", "Onboarding status lỗi, vẫn thử claim.", error?.data);
    }
    const data = await rpc("rpc_onboarding_claim_reward", { p_character_id: options.characterId }, options.accessToken);
    return { message: "Đã gọi onboarding claim reward.", data: { status: statusData, claim: data } };
  });
}

export async function runAchievementClaimAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  return runSingleTask(options, "achievement", "Claim Thành tựu", async () => {
    const listData = await rpc("rpc_list_achievements", { p_character_id: options.characterId }, options.accessToken);
    const items = firstArray(listData);
    const claimable = items.filter(isClaimableAchievement);
    let claimed = 0;
    const results: any[] = [];

    for (const item of claimable) {
      const code = getAchievementCode(item);
      if (!code) continue;
      try {
        const data = await rpc("rpc_claim_achievement", {
          p_character_id: options.characterId,
          p_achievement_code: code,
        }, options.accessToken);
        claimed += 1;
        results.push({ code, ok: true, data });
      } catch (error: any) {
        results.push({ code, ok: false, error: error?.message, data: error?.data });
      }
    }

    return {
      message: claimed > 0 ? `Đã claim ${claimed}/${claimable.length} thành tựu.` : "Không có thành tựu claimable.",
      status: claimed > 0 || claimable.length === 0 ? "SUCCESS" : "WARN",
      data: { total: items.length, claimable: claimable.length, claimed, results },
    };
  });
}

export async function runDailyAuto(options: DailyAutoOptions): Promise<DailyRunSummary> {
  const summary = makeSummary();
  const tasks = [
    options.settings?.auto_cultivation !== false ? runClaimExpAuto(options) : null,
    options.settings?.world_cup_checkin !== false ? runWorldCupCheckinAuto(options) : null,
    options.settings?.onboarding_claim !== false ? runOnboardingClaimAuto(options) : null,
    options.settings?.body_cult_claim !== false ? runBodyCultAuto(options) : null,
    options.settings?.achievement_claim === true ? runAchievementClaimAuto(options) : null,
  ].filter(Boolean) as Promise<DailyRunSummary>[];

  for (const task of tasks) {
    const result = await task;
    summary.tasks.push(...result.tasks);
    summary.successCount += result.successCount;
    summary.warnCount += result.warnCount;
    summary.errorCount += result.errorCount;
    summary.skippedCount += result.skippedCount;
  }

  return finishSummary(summary);
}
