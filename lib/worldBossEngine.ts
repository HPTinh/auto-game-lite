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
  if (["idle", "dead", "closed", "down", "respawn", "waiting"].includes(status)) return false;
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
 * State machine World Boss:
 *
 * MODE ATTACK (boss sống):
 *   - Đánh mỗi ~3s (cooldown_sec API) đến đủ maxAttacks (vd 999)
 *   - Lỗi attack (window close, …) → CHECK channel ngay
 *   - killed / hp_after=0 → claim → chuyển MODE CHECK
 *
 * MODE CHECK (boss chết / window đóng):
 *   - KHÔNG attack
 *   - Chỉ rpc_wb_channels theo check_interval
 *   - Khi available + sống lại → MODE ATTACK
 */
export async function runWorldBossAuto(options: WorldBossAutoOptions): Promise<WorldBossRunSummary> {
  const checkIntervalMs = clamp(Number(options.checkIntervalMinutes ?? 10), 1, 24 * 60, 10) * 60_000;
  const maxAttacks = clamp(options.maxAttacksPerCheck ?? 30, 1, 999, 30);
  const fixedDelayMs = Number(options.attackDelayMs);
  const defaultCdMs = Number.isFinite(fixedDelayMs) && fixedDelayMs > 0 ? fixedDelayMs : 3000;
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
    nextCheckMs: checkIntervalMs,
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

  try {
    // ── CHECK channel + rank ──────────────────────────────────────
    onLog?.("INFO", "WB: check channels (rpc_wb_channels)...");
    let { myTier, channels } = await fetchChannels(options.characterId, options.accessToken);
    summary.myTier = myTier;
    summary.channels = channels;

    let { fight } = pickTiersToFight(channels, myTier, options);
    summary.tiers = fight.slice();

    const aliveStr = channels
      .filter(c => c.available === true && isWorldBossAlive(c))
      .map(c => c.tier)
      .join(",") || "—";
    const deadStr = channels
      .filter(c => c.available === true && !isWorldBossAlive(c))
      .map(c => `${c.tier}/${c.status}`)
      .join(",") || "—";

    onLog?.(
      "INFO",
      `WB my_tier=${myTier || "?"} · sống: [${aliveStr}] · chết/đóng: [${deadStr}] · max ${maxAttacks} đòn · cd≈3s · check chết ${checkIntervalMs / 60000}p`
    );

    // Claim quà treo (luôn thử)
    await tryClaimTier(options, "", tierBag, "session_start_claim");
    if (tierBag.claimed) {
      summary.claimed = true;
      summary.claimCount += tierBag.claimCount;
      summary.claimStones += tierBag.claimStones;
    }

    // ── MODE CHECK: không có boss sống → chỉ hẹn check, KHÔNG attack ──
    if (fight.length === 0) {
      summary.status = summary.claimed ? "CLAIMED" : "WAITING_RESPAWN";
      summary.nextCheckMs = checkIntervalMs;
      summary.nextCheckReason = "check_only_boss_dead";
      summary.tierResults.push({ ...tierBag, tier: myTier || "none", status: "DEAD" });
      onLog?.("WARN", `WB MODE=CHECK · không có boss sống · ${checkIntervalMs / 60000}p sau check lại (không attack)`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // ── MODE ATTACK: đánh mỗi 3s đến maxAttacks hoặc lỗi ──────────
    const tier = fight[0];
    const ch0 = channels.find(c => c.tier === tier);
    tierBag.tier = tier;
    tierBag.channel = ch0;

    onLog?.("INFO", `WB MODE=ATTACK · tier ${tier} · đánh mỗi ~3s đến ${maxAttacks} đòn (hoặc lỗi/window close)`);

    let lastCdMs = defaultCdMs;
    let attackError: any = null;

    for (let i = 1; i <= maxAttacks; i++) {
      if (options.shouldStop?.()) {
        onLog?.("WARN", `WB dừng (stop) sau ${tierBag.attackCount} đòn`);
        break;
      }

      try {
        const attack = await rpc(
          "rpc_wb_attack",
          { p_character_id: options.characterId, p_tier: tier },
          options.accessToken
        );
        tierBag.lastAttack = attack;
        tierBag.attackCount += 1;
        summary.attackCount += 1;
        lastCdMs = attackCooldownMs(attack, defaultCdMs);

        const dmg = Number(attack?.damage);
        const hpAfter = Number(attack?.hp_after);

        if (i === 1 || i === maxAttacks || i % 10 === 0) {
          onLog?.(
            "INFO",
            `WB ${tier} đòn ${i}/${maxAttacks} · dmg ${Number.isFinite(dmg) ? dmg.toLocaleString() : "?"} · hp ${Number.isFinite(hpAfter) ? hpAfter.toLocaleString() : "?"} · next ${Math.round(lastCdMs / 1000)}s`
          );
        }

        // Giết boss
        if (isBossKilledByAttack(attack) || attack?.can_claim === true || attack?.claimable === true) {
          onLog?.("SUCCESS", `WB ${tier}: GIẾT sau ${tierBag.attackCount} đòn → claim → MODE CHECK`);
          await tryClaimTier(options, tier, tierBag, "killed");
          summary.claimed = summary.claimed || tierBag.claimed;
          summary.claimCount += tierBag.claimCount;
          summary.claimStones += tierBag.claimStones;
          tierBag.status = "WAITING_RESPAWN";
          summary.status = "WAITING_RESPAWN";
          summary.nextCheckMs = checkIntervalMs;
          summary.nextCheckReason = "boss_killed_check_only";
          summary.tierResults.push(tierBag);
          onLog?.("INFO", `WB MODE=CHECK · boss chết · check sống lại sau ${checkIntervalMs / 60000}p`);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }

        // Response báo window/chờ
        if (isWaitingRespawnLike(attack) || isAttackBlockedError(attack)) {
          attackError = attack;
          onLog?.("WARN", `WB ${tier}: response chặn attack (window/dead) sau đòn ${i} → CHECK channel`);
          break;
        }

        // Boss còn sống → chờ đúng 3s (cooldown API) rồi đánh tiếp
        if (i < maxAttacks) await sleep(lastCdMs);
      } catch (error: any) {
        attackError = error;
        tierBag.lastAttack = error?.data;

        // Rate limit thuần → chờ cd, không tính đòn, đánh lại
        if (isRateLimitOnly(error)) {
          onLog?.("WARN", `WB ${tier}: rate/cd · chờ ${Math.round(lastCdMs / 1000)}s đánh lại`);
          await sleep(lastCdMs);
          i -= 1;
          continue;
        }

        // Claimable error
        if (isClaimRewardLike(error)) {
          onLog?.("SUCCESS", `WB ${tier}: lỗi kiểu claimable → claim → MODE CHECK`);
          await tryClaimTier(options, tier, tierBag, "error_claimable");
          summary.claimed = summary.claimed || tierBag.claimed;
          summary.claimCount += tierBag.claimCount;
          summary.claimStones += tierBag.claimStones;
          tierBag.status = "WAITING_RESPAWN";
          summary.status = "WAITING_RESPAWN";
          summary.nextCheckMs = checkIntervalMs;
          summary.nextCheckReason = "claimable_error_check_only";
          summary.tierResults.push(tierBag);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }

        // Window close / blocked → thoát vòng attack, CHECK channel
        if (isAttackBlockedError(error) || isWaitingRespawnLike(error) || isAttackStopSoft(error)) {
          onLog?.("WARN", `WB ${tier}: lỗi attack đòn ~${i}: ${(error?.message || "blocked").slice(0, 100)} → CHECK channel`);
          break;
        }

        // Lỗi cứng
        const msg = error?.message || "attack error";
        tierBag.errors.push(msg);
        summary.errors.push(msg);
        onLog?.("ERROR", `WB ${tier}: lỗi cứng: ${msg.slice(0, 120)} → CHECK channel`);
        break;
      }
    }

    // ── Sau lỗi attack hoặc hết max đòn: CHECK channel thật ─────────
    onLog?.("INFO", "WB: re-check channels sau attack (xác nhận boss sống/chết)...");
    try {
      const again = await fetchChannels(options.characterId, options.accessToken);
      myTier = again.myTier;
      channels = again.channels;
      summary.myTier = myTier;
      summary.channels = channels;
      fight = pickTiersToFight(channels, myTier, options).fight;
    } catch (e: any) {
      onLog?.("WARN", `WB re-check fail: ${e?.message || e}`);
      fight = [];
    }

    await tryClaimTier(options, "", tierBag, "after_attack_claim");
    summary.claimed = summary.claimed || tierBag.claimed;
    summary.claimCount += tierBag.claimCount;
    summary.claimStones += tierBag.claimStones;
    summary.tierResults.push(tierBag);

    if (fight.length === 0) {
      // Boss thật sự chết / window đóng → CHỈ CHECK, không attack
      summary.status = "WAITING_RESPAWN";
      summary.nextCheckMs = checkIntervalMs;
      summary.nextCheckReason = "boss_dead_check_only";
      onLog?.(
        "WARN",
        `WB MODE=CHECK · boss đã chết/đóng (atk ${summary.attackCount}) · chỉ check mỗi ${checkIntervalMs / 60000}p đến khi sống`
      );
    } else if (tierBag.attackCount >= maxAttacks) {
      // Đủ max đòn, channel vẫn sống → DPS tiếp ngay (đợt mới)
      summary.status = "DONE";
      summary.nextCheckMs = lastCdMs;
      summary.nextCheckReason = "max_hits_continue_attack";
      onLog?.(
        "INFO",
        `WB đủ ${maxAttacks} đòn, boss vẫn sống → đợt DPS mới sau ${Math.round(lastCdMs / 1000)}s`
      );
    } else if (attackError) {
      // Lỗi nhưng channel vẫn sống → thử attack lại sau cd
      summary.status = "DONE";
      summary.nextCheckMs = lastCdMs;
      summary.nextCheckReason = "error_but_alive_retry_attack";
      onLog?.("INFO", `WB lỗi attack nhưng channel còn sống → attack lại sau ${Math.round(lastCdMs / 1000)}s`);
    } else {
      summary.status = "DONE";
      summary.nextCheckMs = lastCdMs;
      summary.nextCheckReason = "continue_attack";
    }

    onLog?.(
      "SUCCESS",
      `WB xong session · atk ${summary.attackCount} · claim ${summary.claimCount} · +${summary.claimStones || 0}LS · next ${
        (summary.nextCheckMs || 0) >= 60_000
          ? Math.round((summary.nextCheckMs || 0) / 60000) + "p CHECK"
          : Math.round((summary.nextCheckMs || 0) / 1000) + "s ATTACK"
      }`
    );
  } catch (e: any) {
    summary.status = "ERROR";
    summary.errors.push(e?.message || String(e));
    summary.nextCheckMs = checkIntervalMs;
    onLog?.("ERROR", `WB fail: ${e?.message || e}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
