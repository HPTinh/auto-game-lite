"use client";

/**
 * World Boss auto — dùng rpc_wb_channels để biết rank (my_tier) + channel boss sống/chết,
 * rồi rpc_wb_attack / claim theo tier phù hợp.
 */

export type WorldBossLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface WorldBossChannelInfo {
  tier: string;
  status?: string;
  available?: boolean;
  hp_current?: number;
  hp_max?: number;
  window_open?: boolean;
  participant_count?: number;
  reward_pool?: number;
  dao_co_min?: number | null;
  dao_co_max?: number | null;
  raw?: any;
}

export interface WorldBossTierResult {
  tier: string;
  attackCount: number;
  claimCount: number;
  claimStones: number;
  claimed: boolean;
  status: "DONE" | "CLAIMED" | "WAITING_RESPAWN" | "NO_REWARD" | "ERROR" | "PARTIAL_ERROR" | "SKIPPED" | "DEAD";
  nextCheckMs?: number;
  nextCheckReason?: string;
  lastAttack?: any;
  lastClaim?: any;
  errors: string[];
  channel?: WorldBossChannelInfo;
}

export interface WorldBossRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "CLAIMED" | "WAITING_RESPAWN" | "PARTIAL_ERROR" | "ERROR";
  myTier?: string;
  tiers: string[];
  channels?: WorldBossChannelInfo[];
  attackCount: number;
  claimCount: number;
  claimStones: number;
  claimed: boolean;
  nextCheckMs?: number;
  nextCheckReason?: string;
  tierResults: WorldBossTierResult[];
  errors: string[];
}

export interface WorldBossAutoOptions {
  characterId: string;
  accessToken: string;
  /** manual tiers; nếu autoSelectTiers=true thì bỏ qua / chỉ filter */
  tiers?: string[] | string;
  /** true (mặc định): chọn tier theo my_tier + channel available + boss sống */
  autoSelectTiers?: boolean;
  /** số đòn tối đa / lần check — 1..999, mặc định 30 */
  maxAttacksPerCheck?: number;
  attackDelayMs?: number;
  autoClaim?: boolean;
  /** chu kỳ check boss sống/chết — phút, min 1, mặc định 10 (chỉ khi boss chết / không có boss) */
  checkIntervalMinutes?: number;
  onLog?: (level: WorldBossLogLevel, message: string, meta?: Record<string, any>) => void;
  shouldStop?: () => boolean;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function clamp(n: number, min: number, max: number, fallback: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normalizeTiers(tiers?: string[] | string) {
  const raw = Array.isArray(tiers) ? tiers : String(tiers || "").split(/[\n,;|]+/);
  return raw.map(item => String(item).trim().toLowerCase()).filter(Boolean);
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
    const error: any = new Error(`[${name}] HTTP ${res.status}: ${text || res.statusText}`);
    error.data = data;
    error.status = res.status;
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

function textOf(value: any) {
  try {
    return `${String(value?.message || value?.error || value?.reason || "").toLowerCase()} ${JSON.stringify(value?.data || value || {}).toLowerCase()}`;
  } catch {
    return String(value || "").toLowerCase();
  }
}

function isClaimRewardLike(value: any) {
  const text = textOf(value);
  return [
    "claim", "reward", "rewards", "pending_reward", "can_claim",
    "boss_dead", "dead", "killed", "defeated", "đã chết", "da chet", "quà", "qua",
  ].some(key => text.includes(key));
}

function isNoRewardSoft(value: any) {
  const text = textOf(value);
  return [
    "no_reward", "no reward", "nothing", "empty", "already_claimed", "already claimed",
    "claimed", "not_eligible", "không có quà", "khong co qua", "đã nhận", "da nhan",
  ].some(key => text.includes(key));
}

function isWaitingRespawnLike(value: any) {
  const text = textOf(value);
  return [
    "respawn", "not_alive", "not alive", "not_spawned", "boss_dead", "boss dead",
    "cho hoi sinh", "hồi sinh", "hoi sinh", "window_close", "window close", "window_closed",
    "closed", "not_open", "window_open\":false",
  ].some(key => text.includes(key));
}

/** Lỗi attack kiểu window close / boss không đánh được → phải re-check channel */
function isAttackBlockedError(value: any) {
  const text = textOf(value);
  return [
    "window_close", "window close", "window_closed", "closed", "not_open",
    "window_open", "not available", "not_available", "unavailable",
    "boss_dead", "boss dead", "not_alive", "idle", "respawn",
    "cannot_attack", "cant_attack", "no_boss", "ended", "finished",
    "không thể", "khong the", "đóng", "dong cua so",
  ].some(key => text.includes(key));
}

function isAttackStopSoft(value: any) {
  const text = textOf(value);
  return isClaimRewardLike(value) || isWaitingRespawnLike(value) || isAttackBlockedError(value) || [
    "no_hp", "low_hp", "dead_player", "not_enough_hp", "not_enough_mp",
    "cooldown", "cool_down", "too_fast", "rate", "turn", "rank",
  ].some(key => text.includes(key));
}

function isRateLimitOnly(value: any) {
  const text = textOf(value);
  if (isAttackBlockedError(value) || isClaimRewardLike(value)) return false;
  return ["cooldown", "cool_down", "too_fast", "rate", "turn", "slow"].some(k => text.includes(k));
}

function deepFindNumber(obj: any, includes: string[], excludes: string[] = []): number | null {
  const seen = new Set<any>();
  const walk = (value: any): number | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (includes.some(item => lower.includes(item)) && !excludes.some(item => lower.includes(item))) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
    }
    for (const raw of Object.values(value)) {
      const found = walk(raw);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(obj);
}

function extractNextCheckMs(data: any, fallbackMs?: number) {
  const directMs = deepFindNumber(data, ["next_check_ms", "nextcheckms", "wait_ms", "cooldown_ms", "respawn_ms"], []);
  if (directMs !== null && directMs > 0) return Math.max(60_000, directMs);

  const seconds = deepFindNumber(data, [
    "next_check_seconds", "nextcheckseconds", "wait_seconds", "cooldown_seconds",
    "remaining_seconds", "respawn_seconds", "seconds_until_respawn", "respawn_in",
  ], []);
  if (seconds !== null && seconds > 0) return Math.max(60_000, seconds * 1000);

  const dateValue = findDateLike(data, ["respawn_at", "next_spawn_at", "spawn_at", "cooldown_until", "next_check_at"]);
  if (dateValue) {
    const ms = new Date(dateValue).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.max(60_000, ms);
  }

  return fallbackMs;
}

function findDateLike(obj: any, includes: string[]): string | null {
  const seen = new Set<any>();
  const walk = (value: any): string | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (includes.some(item => lower.includes(item)) && typeof raw === "string") {
        const t = new Date(raw).getTime();
        if (Number.isFinite(t)) return raw;
      }
    }
    for (const raw of Object.values(value)) {
      const found = walk(raw);
      if (found) return found;
    }
    return null;
  };
  return walk(obj);
}

function normalizeRewardList(data: any): any[] {
  const rewards = data?.rewards || data?.reward || data?.pending_rewards || data?.items || data?.drops;
  if (Array.isArray(rewards)) return rewards;
  return [];
}

function rewardTier(reward: any) {
  return String(reward?.tier || reward?.p_tier || reward?.boss_tier || reward?.code || "").trim().toLowerCase();
}

function countRewards(data: any) {
  const direct = Number(data?.claimed_count ?? data?.count ?? data?.reward_count ?? data?.total_count);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return normalizeRewardList(data).length;
}

function extractClaimStones(data: any) {
  const direct = Number(data?.total_stones ?? data?.stones_total ?? data?.claimed_stones ?? data?.spirit_stones ?? data?.totalSpiritStones);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const rewards = normalizeRewardList(data);
  let sum = 0;
  for (const reward of rewards) {
    const n = Number(reward?.stones ?? reward?.spirit_stones ?? reward?.stone_qty ?? reward?.amount ?? 0);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

function isClaimSuccess(data: any) {
  if (!data) return false;
  if (data.ok === true && (countRewards(data) > 0 || data.claimed === true || data.success === true)) return true;
  if (data.success === true) return true;
  if (data.claimed === true || data.reward_claimed === true) return true;
  if (normalizeRewardList(data).length > 0) return true;
  return false;
}

/** Boss còn sống trên channel (có thể đánh) */
export function isWorldBossAlive(ch: WorldBossChannelInfo | any): boolean {
  if (!ch) return false;
  const status = String(ch.status || "").toLowerCase();
  if (["idle", "dead", "closed", "down", "respawn", "waiting", "expired"].includes(status)) return false;
  if (ch.window_open === false) return false;
  const hp = Number(ch.hp_current);
  if (Number.isFinite(hp) && hp <= 0) return false;
  // open / alive + còn HP
  if (status === "open" || status === "alive" || ch.window_open === true) {
    if (Number.isFinite(hp)) return hp > 0;
    return true;
  }
  // status lạ nhưng available + hp > 0
  if (ch.available === true && Number.isFinite(hp) && hp > 0) return true;
  return false;
}

/**
 * Snapshot chi tiết 1 tier (rpc_wb_snapshot) — chuẩn để biết window đóng/boss chết.
 * window_open: false | event.status: expired/idle/dead | hp_current <= 0 | died_at
 */
export interface WorldBossSnapshot {
  ok: boolean;
  tier: string;
  windowOpen: boolean;
  eventStatus?: string;
  hpCurrent?: number;
  hpMax?: number;
  diedAt?: string | null;
  windowStart?: string;
  windowEnd?: string;
  attackCooldownSec: number;
  canAttack: boolean;
  reason?: string;
  me?: { rank?: number; attack_count?: number; total_damage?: number };
  raw?: any;
}

function normalizeChannel(raw: any): WorldBossChannelInfo {
  return {
    tier: String(raw?.tier || raw?.code || "").trim().toLowerCase(),
    status: raw?.status,
    available: raw?.available,
    hp_current: raw?.hp_current != null ? Number(raw.hp_current) : undefined,
    hp_max: raw?.hp_max != null ? Number(raw.hp_max) : undefined,
    window_open: raw?.window_open,
    participant_count: raw?.participant_count,
    reward_pool: raw?.reward_pool,
    dao_co_min: raw?.dao_co_min,
    dao_co_max: raw?.dao_co_max,
    raw,
  };
}

async function fetchChannels(characterId: string, accessToken: string) {
  const data = await rpc("rpc_wb_channels", { p_character_id: characterId }, accessToken);
  const list = Array.isArray(data?.channels) ? data.channels : Array.isArray(data) ? data : [];
  const channels = list.map(normalizeChannel).filter((c: WorldBossChannelInfo) => c.tier);
  const myTier = String(data?.my_tier || data?.tier || "").trim().toLowerCase() || undefined;
  return { myTier, channels, buffTotal: data?.my_buff_total, raw: data };
}

/**
 * rpc_wb_snapshot — check window boss theo tier (chuẩn khi window close / boss die)
 * body: { p_character_id, p_tier }
 */
export async function fetchWorldBossSnapshot(
  characterId: string,
  accessToken: string,
  tier: string
): Promise<WorldBossSnapshot> {
  const data = await rpc(
    "rpc_wb_snapshot",
    { p_character_id: characterId, p_tier: String(tier).toLowerCase() },
    accessToken
  );

  const event = data?.event || {};
  const config = data?.config || {};
  const windowOpen = data?.window_open === true;
  const eventStatus = String(event?.status || "").toLowerCase();
  const hpCurrent = event?.hp_current != null ? Number(event.hp_current) : undefined;
  const hpMax = event?.hp_max != null ? Number(event.hp_max) : undefined;
  const diedAt = event?.died_at ?? null;
  const attackCooldownSec = Math.max(
    1,
    Number(config?.attack_cooldown_sec || config?.cooldown_sec || 3) || 3
  );

  // Rule đơn giản (theo game): window_open = true → còn boss, CỨ ĐÁNH
  // window_open = false → đóng window, chỉ CHECK
  let canAttack = false;
  let reason = "";

  if (windowOpen === true) {
    canAttack = true;
    reason = `window_open=true · status=${eventStatus || "?"} · hp=${hpCurrent ?? "?"}`;
  } else {
    reason = `window_open=false · status=${eventStatus || "?"} · end ${data?.window_end || event?.window_end || "?"}`;
  }

  return {
    ok: data?.ok !== false,
    tier: String(event?.tier || tier).toLowerCase(),
    windowOpen,
    eventStatus,
    hpCurrent,
    hpMax,
    diedAt,
    windowStart: data?.window_start || event?.window_start,
    windowEnd: data?.window_end || event?.window_end,
    attackCooldownSec,
    canAttack,
    reason,
    me: data?.me,
    raw: data,
  };
}

/**
 * Boss World hồi sinh mỗi **giờ chẵn** (VN): 1h, 2h, 3h, 4h...
 * Chết 5h30 → 6h00 ra lại; chết 5h59 → vẫn 6h00.
 *
 * window_open=false → chờ đến đầu giờ tiếp theo (Asia/Ho_Chi_Minh).
 * window_start / window_end chỉ để log; lịch hồi = giờ chẵn.
 */
export function msUntilNextFullHourVn(nowMs = Date.now(), bufferMs = 2000): {
  waitMs: number;
  nextOpenAt: string;
  reason: string;
} {
  // VN = UTC+7
  const VN = 7 * 60 * 60 * 1000;
  const vn = new Date(nowMs + VN);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const d = vn.getUTCDate();
  const h = vn.getUTCHours();
  // Đầu giờ kế tiếp theo đồng hồ VN
  let nextHourVnAsUtc = Date.UTC(y, m, d, h + 1, 0, 0, 0);
  // Nếu còn < 2s đến đầu giờ (vừa sang giờ), nhảy thêm 1 giờ tránh wake quá sớm
  let waitMs = nextHourVnAsUtc - VN - nowMs + bufferMs;
  if (waitMs < 3000) {
    nextHourVnAsUtc += 60 * 60 * 1000;
    waitMs = nextHourVnAsUtc - VN - nowMs + bufferMs;
  }
  const nextOpenAt = new Date(nextHourVnAsUtc - VN).toISOString();
  return {
    waitMs: Math.max(5_000, waitMs),
    nextOpenAt,
    reason: "next_full_hour_vn",
  };
}

/**
 * Khi window đóng: ưu tiên giờ chẵn VN; fallback checkIntervalMs.
 */
export function msUntilWindowReopen(
  snap: Pick<WorldBossSnapshot, "windowOpen" | "windowStart" | "windowEnd">,
  fallbackMs = 10 * 60_000
): { waitMs: number; nextOpenAt: string | null; reason: string } {
  if (snap.windowOpen === true) {
    return { waitMs: 0, nextOpenAt: null, reason: "window_already_open" };
  }

  // Logic game: mỗi giờ chẵn boss ra lại
  const hour = msUntilNextFullHourVn(Date.now(), 2000);
  return {
    waitMs: hour.waitMs,
    nextOpenAt: hour.nextOpenAt,
    reason: hour.reason,
  };
}

function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}p`;
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return m > 0 ? `${h}h${m}p` : `${h}h`;
}

/**
 * Tự chọn tier từ rpc_wb_channels:
 * - available === true (đủ rank → vd my_tier=kd thì channel kd available)
 * - boss còn sống (status open + hp > 0)
 * Ưu tiên my_tier trước, rồi tier available khác.
 * Không cần nhập thủ công.
 */
function pickTiersToFight(
  channels: WorldBossChannelInfo[],
  myTier: string | undefined,
  options: WorldBossAutoOptions
): { fight: string[]; skipped: { tier: string; reason: string }[] } {
  const manual = normalizeTiers(options.tiers);
  // Chỉ khi user tắt auto VÀ nhập tiers thủ công mới filter; mặc định luôn auto theo channel
  const forceManual = options.autoSelectTiers === false && manual.length > 0;
  const byTier = new Map(channels.map(c => [c.tier, c]));
  const skipped: { tier: string; reason: string }[] = [];
  const fight: string[] = [];

  const candidates = forceManual
    ? manual
    : channels.map(c => c.tier);

  const unique = Array.from(new Set(candidates));

  for (const tier of unique) {
    const ch = byTier.get(tier);
    if (!ch) {
      skipped.push({ tier, reason: "không có channel" });
      continue;
    }
    if (ch.available === false) {
      skipped.push({ tier, reason: "rank chưa đủ / unavailable" });
      continue;
    }
    if (!isWorldBossAlive(ch)) {
      skipped.push({ tier, reason: `boss chết/chờ (status=${ch.status}, hp=${ch.hp_current ?? "?"})` });
      continue;
    }
    fight.push(tier);
  }

  // Ưu tiên my_tier (rank hiện tại) — game set available=true đúng tier mình đánh được
  if (myTier && fight.includes(myTier)) {
    fight.sort((a, b) => (a === myTier ? -1 : b === myTier ? 1 : a.localeCompare(b)));
  } else {
    // sort theo độ khó tăng: lk < tc < kd < na < ht < lh
    const order = ["lk", "tc", "kd", "na", "ht", "lh"];
    fight.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  return { fight, skipped };
}

/** Cooldown giữa 2 đòn từ response attack (mặc định game: 3s) */
function attackCooldownMs(attack: any, fallbackMs: number): number {
  const cd = Number(attack?.cooldown_sec ?? attack?.atk_speed_sec ?? attack?.cooldown ?? attack?.atk_speed);
  if (Number.isFinite(cd) && cd > 0) return Math.max(200, Math.round(cd * 1000));
  // atk_speed_sec ưu tiên nếu có cả hai
  const speed = Number(attack?.atk_speed_sec);
  const cool = Number(attack?.cooldown_sec);
  if (Number.isFinite(speed) && Number.isFinite(cool)) {
    return Math.max(200, Math.round(Math.max(speed, cool) * 1000));
  }
  return Math.max(200, fallbackMs || 3000);
}

function isBossKilledByAttack(attack: any): boolean {
  if (!attack) return false;
  if (attack.killed === true || attack.boss_dead === true || attack.dead === true) return true;
  const hpAfter = Number(attack.hp_after);
  if (Number.isFinite(hpAfter) && hpAfter <= 0) return true;
  return isClaimRewardLike(attack);
}

async function checkPendingRewards(options: WorldBossAutoOptions) {
  return rpc("rpc_wb_my_pending_rewards", { p_character_id: options.characterId }, options.accessToken);
}

async function tryClaimTier(options: WorldBossAutoOptions, tier: string, tierResult: WorldBossTierResult, reason: string) {
  const onLog = options.onLog;
  if (options.autoClaim === false) return false;

  const normalizedTier = String(tier || "").trim().toLowerCase();

  try {
    onLog?.("DEBUG", `Boss ${tier || "all"}: check quà treo (${reason}).`);
    const pending = await checkPendingRewards(options);
    tierResult.lastClaim = { pending };

    const pendingRewards = normalizeRewardList(pending);
    const pendingCount = countRewards(pending);
    const pendingTiers = Array.from(new Set(pendingRewards.map(rewardTier).filter(Boolean)));

    if (!pending?.ok || pendingCount <= 0 || pendingRewards.length === 0) {
      tierResult.status = tierResult.status === "DONE" ? "NO_REWARD" : tierResult.status;
      return false;
    }

    const hasThisTier = pendingRewards.some(item => rewardTier(item) === normalizedTier);
    if (normalizedTier && !hasThisTier) {
      return false;
    }

    onLog?.("INFO", `Boss ${tier || "all"}: ${pendingCount} quà treo (${pendingTiers.join(", ") || "?"}), claim...`);

    const claim = await rpc("rpc_wb_claim_rewards", { p_character_id: options.characterId }, options.accessToken);
    tierResult.lastClaim = { pending, claim };

    if (isClaimSuccess(claim)) {
      const claimedCount = Math.max(1, countRewards(claim));
      const claimedStones = extractClaimStones(claim);
      tierResult.claimCount += claimedCount;
      tierResult.claimStones += claimedStones;
      tierResult.claimed = true;
      tierResult.status = "CLAIMED";
      onLog?.("SUCCESS", `Boss ${tier || "all"}: claim ${claimedCount} quà · +${claimedStones || "?"} LS`, claim);
      return true;
    }

    tierResult.status = tierResult.status === "DONE" ? "NO_REWARD" : tierResult.status;
    onLog?.("WARN", `Boss ${tier}: có quà treo nhưng claim chưa OK.`, claim);
    return false;
  } catch (error: any) {
    tierResult.lastClaim = error?.data;
    if (isNoRewardSoft(error)) return false;

    if (isWaitingRespawnLike(error) || isClaimRewardLike(error)) {
      const wait = extractNextCheckMs(error?.data, undefined);
      if (wait) {
        tierResult.nextCheckMs = Math.max(tierResult.nextCheckMs || 0, wait);
        tierResult.nextCheckReason = "claim_wait_response";
        tierResult.status = "WAITING_RESPAWN";
      }
      return false;
    }

    const message = error?.message || "claim error";
    tierResult.errors.push(message);
    tierResult.status = tierResult.attackCount > 0 || tierResult.claimed ? "PARTIAL_ERROR" : "ERROR";
    onLog?.("ERROR", `Boss ${tier}: lỗi claim: ${message}`, error?.data);
    return false;
  }
}

/**
 * World Boss — logic gọn:
 *
 * Mỗi lần đánh:
 *   1) rpc_wb_snapshot(tier)
 *   2) window_open === true  → rpc_wb_attack → sleep(delay) → lặp
 *   3) window_open === false → tính giờ mở lại từ window_start/window_end, ngủ đến đó (không poll)
 *
 * delay mặc định 3000ms, setting 1500 = nhanh.
 */
export async function runWorldBossAuto(options: WorldBossAutoOptions): Promise<WorldBossRunSummary> {
  const checkIntervalMs = clamp(Number(options.checkIntervalMinutes ?? 10), 1, 24 * 60, 10) * 60_000;
  const maxAttacks = clamp(options.maxAttacksPerCheck ?? 999, 1, 999, 999);
  const fixedDelayMs = Number(options.attackDelayMs);
  // Mặc định 3s; set 1500 = nhanh
  const hitDelayMs =
    Number.isFinite(fixedDelayMs) && fixedDelayMs > 0 ? Math.max(200, fixedDelayMs) : 3000;
  const onLog = options.onLog;

  const summary: WorldBossRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    tiers: [],
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    tierResults: [],
    errors: [],
    nextCheckMs: hitDelayMs,
    nextCheckReason: "default",
  };

  const tierBag: WorldBossTierResult = {
    tier: "?",
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    status: "DONE",
    errors: [],
  };

  /** window_open=false → chờ giờ chẵn kế tiếp (VN): 5h30 chết → 6h00 hồi */
  const scheduleWhenClosed = (snap: WorldBossSnapshot) => {
    const { waitMs, nextOpenAt, reason } = msUntilWindowReopen(snap, checkIntervalMs);
    summary.status = "WAITING_RESPAWN";
    summary.nextCheckMs = waitMs;
    summary.nextCheckReason = reason;
    const when = nextOpenAt
      ? new Date(nextOpenAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
      : "?";
    onLog?.(
      "WARN",
      `WB window đóng · start=${snap.windowStart || "?"} end=${snap.windowEnd || "?"} · hồi giờ chẵn ~${when} (chờ ${formatWait(waitMs)}) · không poll`
    );
  };

  try {
    // 1) Chọn tier từ channels (rank available)
    onLog?.("INFO", "WB: channels...");
    const { myTier, channels } = await fetchChannels(options.characterId, options.accessToken);
    summary.myTier = myTier;
    summary.channels = channels;

    const { fight } = pickTiersToFight(channels, myTier, options);
    const tier =
      fight[0] ||
      channels.find(c => c.available === true)?.tier ||
      myTier ||
      "lk";
    summary.tiers = [tier];
    tierBag.tier = tier;
    tierBag.channel = channels.find(c => c.tier === tier);

    // Claim quà treo
    await tryClaimTier(options, "", tierBag, "start_claim");
    if (tierBag.claimed) {
      summary.claimed = true;
      summary.claimCount += tierBag.claimCount;
      summary.claimStones += tierBag.claimStones;
    }

    onLog?.(
      "INFO",
      `WB tier=${tier} my_tier=${myTier || "?"} · delay ${hitDelayMs}ms · max ${maxAttacks} · check_interval ${checkIntervalMs / 60000}p (chỉ khi window đóng)`
    );

    // 2) Vòng đánh: MỖI ĐÒN = snapshot trước → attack nếu open
    for (let i = 1; i <= maxAttacks; i++) {
      if (options.shouldStop?.()) {
        onLog?.("WARN", `WB stop · đã ${tierBag.attackCount} đòn`);
        break;
      }

      // —— snapshot TRƯỚC attack ——
      let snap: WorldBossSnapshot;
      try {
        snap = await fetchWorldBossSnapshot(options.characterId, options.accessToken, tier);
      } catch (e: any) {
        // Snapshot lỗi: chờ delay đòn rồi thử lại (không chờ check interval)
        onLog?.("WARN", `WB snapshot lỗi: ${e?.message || e} · thử lại sau ${hitDelayMs}ms`);
        await sleep(hitDelayMs);
        i -= 1;
        continue;
      }

      // window đóng → không attack; hẹn đúng giờ mở lại (window_start / window_end)
      if (snap.windowOpen !== true) {
        await tryClaimTier(options, "", tierBag, "window_closed_claim");
        summary.claimed = summary.claimed || tierBag.claimed;
        summary.claimCount += tierBag.claimCount;
        summary.claimStones += tierBag.claimStones;
        tierBag.status = "WAITING_RESPAWN";
        summary.tierResults.push(tierBag);
        scheduleWhenClosed(snap);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }

      // window_open=true → ATTACK ngay
      try {
        const attack = await rpc(
          "rpc_wb_attack",
          { p_character_id: options.characterId, p_tier: tier },
          options.accessToken
        );
        tierBag.lastAttack = attack;
        tierBag.attackCount += 1;
        summary.attackCount += 1;

        const dmg = Number(attack?.damage);
        const hpAfter = Number(attack?.hp_after);

        if (i === 1 || i === maxAttacks || i % 5 === 0) {
          onLog?.(
            "INFO",
            `WB ${tier} #${i}/${maxAttacks} · dmg ${Number.isFinite(dmg) ? dmg.toLocaleString() : "?"} · hp ${Number.isFinite(hpAfter) ? hpAfter.toLocaleString() : "?"} · next ${hitDelayMs}ms`
          );
        }

        // Boss chết / claimable → claim + hẹn giờ mở lại từ window_start/end
        if (isBossKilledByAttack(attack) || attack?.can_claim === true || attack?.claimable === true) {
          onLog?.("SUCCESS", `WB ${tier}: GIẾT · ${tierBag.attackCount} đòn → claim → hẹn mở cửa`);
          await tryClaimTier(options, tier, tierBag, "killed");
          summary.claimed = summary.claimed || tierBag.claimed;
          summary.claimCount += tierBag.claimCount;
          summary.claimStones += tierBag.claimStones;
          tierBag.status = "WAITING_RESPAWN";
          summary.tierResults.push(tierBag);
          try {
            const after = await fetchWorldBossSnapshot(options.characterId, options.accessToken, tier);
            // Ép closed để tính next open từ start/end
            scheduleWhenClosed({ ...after, windowOpen: false });
          } catch {
            summary.status = "WAITING_RESPAWN";
            summary.nextCheckMs = checkIntervalMs;
            summary.nextCheckReason = "boss_killed_fallback";
          }
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
      } catch (error: any) {
        // Attack lỗi: KHÔNG chờ check interval — vòng sau snapshot lại sau hitDelay
        const msg = error?.message || "attack error";
        tierBag.lastAttack = error?.data;
        onLog?.("WARN", `WB attack lỗi #${i}: ${msg.slice(0, 100)} · ${hitDelayMs}ms sau snapshot+retry`);

        if (isClaimRewardLike(error)) {
          await tryClaimTier(options, tier, tierBag, "error_claimable");
          summary.claimed = summary.claimed || tierBag.claimed;
          summary.claimCount += tierBag.claimCount;
          summary.claimStones += tierBag.claimStones;
        }
        // tiếp tục vòng: sleep rồi snapshot lại (có thể window đã đóng)
      }

      // Chờ đúng delay đòn rồi lặp (snapshot lại ở đầu vòng)
      if (i < maxAttacks) await sleep(hitDelayMs);
    }

    // Hết max đòn — hẹn DPS tiếp sau hitDelay (session sau sẽ snapshot lại)
    await tryClaimTier(options, "", tierBag, "after_batch");
    summary.claimed = summary.claimed || tierBag.claimed;
    summary.claimCount += tierBag.claimCount;
    summary.claimStones += tierBag.claimStones;
    summary.tierResults.push(tierBag);

    summary.status = "DONE";
    summary.nextCheckMs = hitDelayMs;
    summary.nextCheckReason = "batch_done_continue";
    onLog?.(
      "SUCCESS",
      `WB đợt xong · atk ${summary.attackCount} · claim ${summary.claimCount} · +${summary.claimStones || 0}LS · next ${hitDelayMs}ms ATTACK`
    );
  } catch (e: any) {
    summary.status = "ERROR";
    summary.errors.push(e?.message || String(e));
    summary.nextCheckMs = hitDelayMs;
    onLog?.("ERROR", `WB fail: ${e?.message || e} · retry ${hitDelayMs}ms`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
