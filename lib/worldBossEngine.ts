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
    "respawn", "cooldown", "cool_down", "not_alive", "not alive", "not_spawned",
    "spawn", "wait", "waiting", "boss_dead", "boss dead", "đang chờ", "cho hoi sinh",
    "hồi sinh", "hoi sinh", "idle",
  ].some(key => text.includes(key));
}

function isAttackStopSoft(value: any) {
  const text = textOf(value);
  return isClaimRewardLike(value) || isWaitingRespawnLike(value) || [
    "no_hp", "low_hp", "dead_player", "not_enough_hp", "not_enough_mp",
    "cooldown", "too_fast", "rate", "turn", "not_available", "unavailable", "rank",
  ].some(key => text.includes(key));
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
 * Đánh liên tục 1 tier khi boss sống.
 * - Giữa các đòn: chỉ chờ cooldown_sec (~3s) từ API — KHÔNG chờ check_interval.
 * - maxAttacks = giới hạn số đòn trong 1 đợt DPS (vd 999).
 * - bossStillAlive=true → caller phải tiếp tục đợt mới ngay (không chờ interval).
 * - bossStillAlive=false (chết) → caller chờ check_interval rồi re-check channel.
 */
async function dpsTierContinuous(
  options: WorldBossAutoOptions,
  tier: string,
  channel: WorldBossChannelInfo | undefined,
  maxAttacks: number
): Promise<WorldBossTierResult & { bossStillAlive: boolean }> {
  const fixedDelayMs = Number(options.attackDelayMs);
  const defaultCdMs = Number.isFinite(fixedDelayMs) && fixedDelayMs > 0 ? fixedDelayMs : 3000;
  const onLog = options.onLog;

  const tierResult: WorldBossTierResult & { bossStillAlive: boolean } = {
    tier,
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    status: "DONE",
    errors: [],
    channel,
    bossStillAlive: true,
  };

  if (channel && channel.available === false) {
    tierResult.status = "SKIPPED";
    tierResult.bossStillAlive = false;
    onLog?.("WARN", `Boss ${tier}: rank chưa đủ`);
    return tierResult;
  }

  if (channel && !isWorldBossAlive(channel)) {
    tierResult.status = "DEAD";
    tierResult.bossStillAlive = false;
    onLog?.("INFO", `Boss ${tier}: đã chết/chờ (channel)`);
    await tryClaimTier(options, tier, tierResult, "dead_channel_claim");
    return tierResult;
  }

  await tryClaimTier(options, tier, tierResult, "pre_dps_claim");

  let lastCdMs = defaultCdMs;
  onLog?.("INFO", `Boss ${tier}: bắt đầu DPS · max ${maxAttacks} đòn · cd≈${Math.round(defaultCdMs / 1000)}s/đòn`);

  for (let i = 1; i <= maxAttacks; i++) {
    if (options.shouldStop?.()) {
      tierResult.status = "DONE";
      tierResult.bossStillAlive = true;
      onLog?.("WARN", `Boss ${tier}: dừng giữa DPS (stop) · đã ${tierResult.attackCount} đòn`);
      break;
    }

    try {
      const attack = await rpc("rpc_wb_attack", { p_character_id: options.characterId, p_tier: tier }, options.accessToken);
      tierResult.lastAttack = attack;
      tierResult.attackCount += 1;
      lastCdMs = attackCooldownMs(attack, defaultCdMs);

      const dmg = Number(attack?.damage);
      const hpAfter = Number(attack?.hp_after);

      if (i === 1 || i === maxAttacks || i % 10 === 0) {
        onLog?.(
          "INFO",
          `Boss ${tier}: đòn ${i}/${maxAttacks} · dmg ${Number.isFinite(dmg) ? dmg.toLocaleString() : "?"} · hp ${Number.isFinite(hpAfter) ? hpAfter.toLocaleString() : "?"} · cd ${Math.round(lastCdMs / 1000)}s`
        );
      }

      // Boss chết → claim → hết DPS, chờ check interval (respawn)
      if (isBossKilledByAttack(attack) || attack?.can_claim === true || attack?.claimable === true) {
        onLog?.("SUCCESS", `Boss ${tier}: GIẾT · ${tierResult.attackCount} đòn · claim`);
        await tryClaimTier(options, tier, tierResult, "attack_killed");
        tierResult.status = "WAITING_RESPAWN";
        tierResult.bossStillAlive = false;
        break;
      }

      if (isWaitingRespawnLike(attack)) {
        tierResult.status = "WAITING_RESPAWN";
        tierResult.bossStillAlive = false;
        onLog?.("WARN", `Boss ${tier}: API báo chờ hồi sinh`);
        break;
      }

      // Còn sống → chờ đúng cd game rồi đánh tiếp (độc lập với check interval)
      if (i < maxAttacks) await sleep(lastCdMs);
    } catch (error: any) {
      tierResult.lastAttack = error?.data;

      if (isClaimRewardLike(error)) {
        await tryClaimTier(options, tier, tierResult, "attack_error_claimable");
        tierResult.status = "WAITING_RESPAWN";
        tierResult.bossStillAlive = false;
        break;
      }

      if (isWaitingRespawnLike(error)) {
        tierResult.status = "WAITING_RESPAWN";
        tierResult.bossStillAlive = false;
        onLog?.("WARN", `Boss ${tier}: cooldown/chờ hồi — ${error?.message || ""}`.slice(0, 120));
        break;
      }

      // Soft rate limit: chờ cd rồi thử lại cùng vòng
      if (isAttackStopSoft(error) && /cool|rate|fast|turn/i.test(String(error?.message || ""))) {
        onLog?.("WARN", `Boss ${tier}: soft CD · chờ ${Math.round(lastCdMs / 1000)}s rồi đánh tiếp`);
        await sleep(lastCdMs);
        i -= 1; // không tính đòn fail
        continue;
      }

      if (isAttackStopSoft(error)) {
        tierResult.status = tierResult.attackCount > 0 ? "DONE" : "NO_REWARD";
        tierResult.bossStillAlive = true;
        onLog?.("WARN", `Boss ${tier}: soft stop · ${error?.message || ""}`.slice(0, 100));
        break;
      }

      const message = error?.message || "attack error";
      tierResult.errors.push(message);
      tierResult.status = tierResult.attackCount > 0 ? "PARTIAL_ERROR" : "ERROR";
      tierResult.bossStillAlive = tierResult.attackCount > 0;
      onLog?.("ERROR", `Boss ${tier}: lỗi đánh: ${message}`);
      break;
    }
  }

  await tryClaimTier(options, tier, tierResult, "post_dps_claim");

  if (tierResult.claimed && tierResult.bossStillAlive !== false) {
    tierResult.status = "WAITING_RESPAWN";
    tierResult.bossStillAlive = false;
  }

  // Hết max đòn mà chưa chết → bossStillAlive=true → caller DPS tiếp ngay
  if (tierResult.bossStillAlive && tierResult.status === "DONE" && tierResult.attackCount >= maxAttacks) {
    onLog?.("INFO", `Boss ${tier}: hết ${maxAttacks} đòn, boss còn sống → DPS tiếp ngay`);
  }

  return tierResult;
}

export async function runWorldBossAuto(options: WorldBossAutoOptions): Promise<WorldBossRunSummary> {
  // check_interval: chỉ dùng khi boss CHẾT / không có boss — re-check channel
  const checkIntervalMs = clamp(Number(options.checkIntervalMinutes ?? 10), 1, 24 * 60, 10) * 60_000;
  // max_attacks: số đòn liên tục khi boss SỐNG (vd 999) — độc lập với check interval
  const maxAttacks = clamp(options.maxAttacksPerCheck ?? 30, 1, 999, 30);
  /** Khi boss còn sống, hẹn lại DPS ngay (không chờ check interval) */
  const CONTINUE_DPS_MS = 800;

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
    nextCheckReason: "default_interval",
  };

  const onLog = options.onLog;
  const applyResult = (result: WorldBossTierResult) => {
    summary.tierResults.push(result);
    summary.attackCount += result.attackCount;
    summary.claimCount += result.claimCount;
    summary.claimStones += result.claimStones || 0;
    summary.claimed = summary.claimed || result.claimed;
    summary.errors.push(...result.errors);
  };

  try {
    // 1) Check channels + rank (độc lập)
    onLog?.("INFO", "World Boss: check channels + rank...");
    const { myTier, channels } = await fetchChannels(options.characterId, options.accessToken);
    summary.myTier = myTier;
    summary.channels = channels;

    const alive = channels.filter(c => c.available === true && isWorldBossAlive(c)).map(c => c.tier);
    const dead = channels.filter(c => c.available === true && !isWorldBossAlive(c)).map(c => `${c.tier}(${c.status})`);
    onLog?.(
      "INFO",
      `WB my_tier=${myTier || "?"} · sống+đánh được: [${alive.join(",") || "—"}] · chết: [${dead.join(",") || "—"}] · DPS max ${maxAttacks} đòn (cd≈3s) · check chết ${checkIntervalMs / 60000}p`
    );

    const { fight, skipped } = pickTiersToFight(channels, myTier, options);
    summary.tiers = fight.slice();
    for (const s of skipped) {
      onLog?.("DEBUG", `WB skip ${s.tier}: ${s.reason}`);
    }

    // Claim quà treo
    const preSweep: WorldBossTierResult = {
      tier: "pending",
      attackCount: 0,
      claimCount: 0,
      claimStones: 0,
      claimed: false,
      status: "DONE",
      errors: [],
    };
    await tryClaimTier(options, "", preSweep, "pre_run_global");
    if (preSweep.claimed || preSweep.errors.length) applyResult(preSweep);

    // Không có boss sống → chỉ khi này mới chờ check_interval
    if (fight.length === 0) {
      summary.status = summary.claimed ? "CLAIMED" : "WAITING_RESPAWN";
      summary.nextCheckMs = checkIntervalMs;
      summary.nextCheckReason = "no_alive_boss";
      onLog?.("WARN", `WB: không có boss sống · check lại sau ${checkIntervalMs / 60000}p (không DPS)`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // 2) DPS liên tục từng tier — boss sống thì đánh max đòn; còn sống thì hẹn DPS ngay
    const byTier = new Map(channels.map(c => [c.tier, c]));
    let anyStillAlive = false;
    let anyKilled = false;

    for (const tier of fight) {
      if (options.shouldStop?.()) break;

      const result = await dpsTierContinuous(options, tier, byTier.get(tier), maxAttacks);
      applyResult(result);

      if (result.bossStillAlive) {
        anyStillAlive = true;
      } else if (result.status === "WAITING_RESPAWN" || result.claimed) {
        anyKilled = true;
      }
    }

    // Claim cuối
    const postSweep: WorldBossTierResult = {
      tier: "pending_final",
      attackCount: 0,
      claimCount: 0,
      claimStones: 0,
      claimed: false,
      status: "DONE",
      errors: [],
    };
    await tryClaimTier(options, "", postSweep, "post_run_global");
    if (postSweep.claimed || postSweep.errors.length) applyResult(postSweep);

    const hasError = summary.tierResults.some(item => item.status === "ERROR");
    if (hasError && summary.attackCount === 0 && !summary.claimed) {
      summary.status = "ERROR";
      summary.nextCheckMs = 30_000;
      summary.nextCheckReason = "error_retry";
    } else if (anyStillAlive) {
      // Boss còn sống sau max đòn → DPS tiếp NGAY (không chờ check interval)
      summary.status = "DONE";
      summary.nextCheckMs = CONTINUE_DPS_MS;
      summary.nextCheckReason = "boss_still_alive_continue_dps";
      onLog?.(
        "INFO",
        `WB DPS tạm nghỉ ${CONTINUE_DPS_MS}ms rồi đánh tiếp (boss còn sống) · atk ${summary.attackCount}`
      );
    } else if (anyKilled || summary.claimed) {
      // Boss chết → chờ check_interval để re-check channel (sống lại)
      summary.status = "WAITING_RESPAWN";
      summary.nextCheckMs = checkIntervalMs;
      summary.nextCheckReason = "boss_dead_wait_check";
      onLog?.(
        "SUCCESS",
        `WB boss chết/claim · +${summary.claimStones || 0} LS · check sống lại sau ${checkIntervalMs / 60000}p`
      );
    } else {
      summary.status = "WAITING_RESPAWN";
      summary.nextCheckMs = checkIntervalMs;
      summary.nextCheckReason = "no_more_targets";
      onLog?.("INFO", `WB hết target · check sau ${checkIntervalMs / 60000}p`);
    }

    onLog?.(
      "SUCCESS",
      `WB session · atk ${summary.attackCount} · claim ${summary.claimCount} · next ${summary.nextCheckMs! < 5000 ? summary.nextCheckMs + "ms (DPS)" : Math.round(summary.nextCheckMs! / 60000) + "p (check)"}`
    );
  } catch (e: any) {
    summary.status = "ERROR";
    summary.errors.push(e?.message || String(e));
    summary.nextCheckMs = 30_000;
    onLog?.("ERROR", `WB fail: ${e?.message || e}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
