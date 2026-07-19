"use client";

export type WorldBossLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface WorldBossTierResult {
  tier: string;
  attackCount: number;
  claimCount: number;
  claimStones: number;
  claimed: boolean;
  status: "DONE" | "CLAIMED" | "WAITING_RESPAWN" | "NO_REWARD" | "ERROR" | "PARTIAL_ERROR";
  nextCheckMs?: number;
  nextCheckReason?: string;
  lastAttack?: any;
  lastClaim?: any;
  errors: string[];
}

export interface WorldBossRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "CLAIMED" | "WAITING_RESPAWN" | "PARTIAL_ERROR" | "ERROR";
  tiers: string[];
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
  tiers?: string[] | string;
  maxAttacksPerCheck?: number;
  attackDelayMs?: number;
  autoClaim?: boolean;
  onLog?: (level: WorldBossLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function normalizeTiers(tiers?: string[] | string) {
  const raw = Array.isArray(tiers) ? tiers : String(tiers || "lk,tc,kd").split(/[\n,;|]+/);
  return raw.map(item => String(item).trim()).filter(Boolean);
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
    "claim",
    "reward",
    "rewards",
    "pending_reward",
    "can_claim",
    "boss_dead",
    "dead",
    "killed",
    "defeated",
    "đã chết",
    "da chet",
    "quà",
    "qua",
  ].some(key => text.includes(key));
}

function isNoRewardSoft(value: any) {
  const text = textOf(value);
  return [
    "no_reward",
    "no reward",
    "nothing",
    "empty",
    "already_claimed",
    "already claimed",
    "claimed",
    "not_eligible",
    "không có quà",
    "khong co qua",
    "đã nhận",
    "da nhan",
  ].some(key => text.includes(key));
}

function isWaitingRespawnLike(value: any) {
  const text = textOf(value);
  return [
    "respawn",
    "cooldown",
    "cool_down",
    "not_alive",
    "not alive",
    "not_spawned",
    "spawn",
    "wait",
    "waiting",
    "boss_dead",
    "boss dead",
    "đang chờ",
    "cho hoi sinh",
    "hồi sinh",
    "hoi sinh",
  ].some(key => text.includes(key));
}

function isAttackStopSoft(value: any) {
  const text = textOf(value);
  return isClaimRewardLike(value) || isWaitingRespawnLike(value) || [
    "no_hp",
    "low_hp",
    "dead_player",
    "not_enough_hp",
    "not_enough_mp",
    "cooldown",
    "too_fast",
    "rate",
    "turn",
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
    "next_check_seconds",
    "nextcheckseconds",
    "wait_seconds",
    "cooldown_seconds",
    "remaining_seconds",
    "respawn_seconds",
    "seconds_until_respawn",
    "respawn_in",
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
  const rewards = normalizeRewardList(data);
  if (rewards.length > 0) return true;
  return false;
}

async function checkPendingRewards(options: WorldBossAutoOptions) {
  return rpc("rpc_wb_my_pending_rewards", { p_character_id: options.characterId }, options.accessToken);
}

async function tryClaimTier(options: WorldBossAutoOptions, tier: string, tierResult: WorldBossTierResult, reason: string) {
  const onLog = options.onLog;
  if (options.autoClaim === false) return false;

  const normalizedTier = String(tier || "").trim().toLowerCase();

  try {
    onLog?.("INFO", `Boss ${tier}: check quà treo trước khi claim (${reason}).`, { tier, reason });
    const pending = await checkPendingRewards(options);
    tierResult.lastClaim = { pending };

    const pendingRewards = normalizeRewardList(pending);
    const pendingCount = countRewards(pending);
    const pendingTiers = Array.from(new Set(pendingRewards.map(rewardTier).filter(Boolean)));

    if (!pending?.ok || pendingCount <= 0 || pendingRewards.length === 0) {
      tierResult.status = tierResult.status === "DONE" ? "NO_REWARD" : tierResult.status;
      onLog?.("DEBUG", `Boss ${tier}: không có quà treo để claim.`, pending);
      return false;
    }

    const hasThisTier = pendingRewards.some(item => rewardTier(item) === normalizedTier);
    if (normalizedTier && !hasThisTier) {
      onLog?.("DEBUG", `Boss ${tier}: chưa có quà treo cho tier này. Quà đang có: ${pendingTiers.join(", ") || "không rõ"}.`, pending);
      return false;
    }

    onLog?.("INFO", `Boss ${tier}: phát hiện ${pendingCount} quà treo (${pendingTiers.join(", ") || "không rõ tier"}), bắt đầu claim.`, pending);

    // Payload đúng của game: chỉ truyền p_character_id, KHÔNG truyền p_tier.
    const claim = await rpc("rpc_wb_claim_rewards", { p_character_id: options.characterId }, options.accessToken);
    tierResult.lastClaim = { pending, claim };

    if (isClaimSuccess(claim)) {
      const claimedCount = Math.max(1, countRewards(claim));
      const claimedStones = extractClaimStones(claim);
      tierResult.claimCount += claimedCount;
      tierResult.claimStones += claimedStones;
      tierResult.claimed = true;
      tierResult.status = "CLAIMED";
      onLog?.("SUCCESS", `Boss ${tier}: đã claim ${claimedCount} quà boss thành công.`, claim);
      return true;
    }

    tierResult.status = tierResult.status === "DONE" ? "NO_REWARD" : tierResult.status;
    onLog?.("WARN", `Boss ${tier}: có quà treo nhưng claim chưa xác nhận thành công.`, claim);
    return false;
  } catch (error: any) {
    tierResult.lastClaim = error?.data;
    if (isNoRewardSoft(error)) {
      onLog?.("WARN", `Boss ${tier}: không có quà hoặc đã claim trước đó.`, error?.data);
      return false;
    }

    if (isWaitingRespawnLike(error) || isClaimRewardLike(error)) {
      const wait = extractNextCheckMs(error?.data, undefined);
      if (wait) {
        tierResult.nextCheckMs = Math.max(tierResult.nextCheckMs || 0, wait);
        tierResult.nextCheckReason = "claim_wait_response";
        tierResult.status = "WAITING_RESPAWN";
      }
      onLog?.("WARN", `Boss ${tier}: claim chưa được, đang chờ trạng thái boss/quà.`, error?.data);
      return false;
    }

    const message = error?.message || "claim error";
    tierResult.errors.push(message);
    tierResult.status = tierResult.attackCount > 0 || tierResult.claimed ? "PARTIAL_ERROR" : "ERROR";
    onLog?.("ERROR", `Boss ${tier}: lỗi check/claim quà: ${message}`, error?.data);
    return false;
  }
}

async function runTier(options: WorldBossAutoOptions, tier: string): Promise<WorldBossTierResult> {
  const maxAttacks = Math.max(1, Number(options.maxAttacksPerCheck || 30));
  const attackDelayMs = Math.max(0, Number(options.attackDelayMs || 1500));
  const onLog = options.onLog;

  const tierResult: WorldBossTierResult = {
    tier,
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    status: "DONE",
    errors: [],
  };

  // Quan trọng: claim trước khi đánh để gom quà còn treo từ lượt trước.
  await tryClaimTier(options, tier, tierResult, "pre_check_pending_reward");

  for (let i = 1; i <= maxAttacks; i++) {
    try {
      const attack = await rpc("rpc_wb_attack", { p_character_id: options.characterId, p_tier: tier }, options.accessToken);
      tierResult.lastAttack = attack;
      tierResult.attackCount += 1;
      onLog?.("SUCCESS", `Boss ${tier}: đánh lần ${i}/${maxAttacks}.`, attack);

      const wait = extractNextCheckMs(attack, undefined);
      if (wait) {
        tierResult.nextCheckMs = Math.max(tierResult.nextCheckMs || 0, wait);
        tierResult.nextCheckReason = "attack_response_wait";
      }

      // Nếu response đánh báo boss chết/có quà thì claim ngay, không đợi lần check sau.
      if (isClaimRewardLike(attack) || attack?.can_claim === true || attack?.claimable === true || attack?.boss_dead === true || attack?.dead === true) {
        await tryClaimTier(options, tier, tierResult, "attack_result_claimable");
        tierResult.status = tierResult.claimed ? "WAITING_RESPAWN" : tierResult.status;
        break;
      }

      if (isWaitingRespawnLike(attack)) {
        tierResult.status = "WAITING_RESPAWN";
        break;
      }

      if (attackDelayMs > 0 && i < maxAttacks) await sleep(attackDelayMs);
    } catch (error: any) {
      tierResult.lastAttack = error?.data;

      if (isClaimRewardLike(error)) {
        onLog?.("WARN", `Boss ${tier}: API đánh báo có quà/boss đã chết, chuyển sang claim.`, error?.data);
        await tryClaimTier(options, tier, tierResult, "attack_error_claimable");
        tierResult.status = tierResult.claimed ? "WAITING_RESPAWN" : "WAITING_RESPAWN";
        const wait = extractNextCheckMs(error?.data, tierResult.nextCheckMs);
        if (wait) {
          tierResult.nextCheckMs = wait;
          tierResult.nextCheckReason = "attack_error_claim_wait";
        }
        break;
      }

      if (isWaitingRespawnLike(error)) {
        const wait = extractNextCheckMs(error?.data, tierResult.nextCheckMs);
        if (wait) {
          tierResult.nextCheckMs = wait;
          tierResult.nextCheckReason = "attack_error_respawn_wait";
        }
        tierResult.status = "WAITING_RESPAWN";
        onLog?.("WARN", `Boss ${tier}: boss đang cooldown/chờ hồi sinh.`, error?.data);
        break;
      }

      if (isAttackStopSoft(error)) {
        tierResult.status = tierResult.attackCount > 0 ? "DONE" : "NO_REWARD";
        onLog?.("WARN", `Boss ${tier}: dừng đánh do điều kiện mềm: ${error?.message || "soft stop"}`, error?.data);
        break;
      }

      const message = error?.message || "attack error";
      tierResult.errors.push(message);
      tierResult.status = tierResult.attackCount > 0 || tierResult.claimed ? "PARTIAL_ERROR" : "ERROR";
      onLog?.("ERROR", `Boss ${tier}: lỗi đánh boss: ${message}`, error?.data);
      break;
    }
  }

  // Quan trọng: claim lần cuối sau vòng đánh. Đây là phần tránh lỗi “đánh xong nhưng chưa tự nhận quà”.
  await tryClaimTier(options, tier, tierResult, "post_attack_sweep");

  if (tierResult.claimed && tierResult.status !== "ERROR" && tierResult.status !== "PARTIAL_ERROR") {
    tierResult.status = "WAITING_RESPAWN";
    tierResult.nextCheckReason = tierResult.nextCheckReason || "claimed_reward_wait_respawn";
  }

  return tierResult;
}

export async function runWorldBossAuto(options: WorldBossAutoOptions): Promise<WorldBossRunSummary> {
  const tiers = normalizeTiers(options.tiers);
  const summary: WorldBossRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    tiers,
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    tierResults: [],
    errors: [],
  };

  if (tiers.length === 0) {
    summary.status = "ERROR";
    summary.finishedAt = new Date().toISOString();
    summary.errors.push("Không có tier Boss Thế Giới để chạy.");
    options.onLog?.("ERROR", "Boss Thế Giới: chưa khai báo tier.");
    return summary;
  }

  options.onLog?.("INFO", `Boss Thế Giới: bắt đầu chạy ${tiers.length} tier: ${tiers.join(", ")}.`);

  const applyTierResult = (result: WorldBossTierResult, includeInList = true) => {
    if (includeInList) summary.tierResults.push(result);
    summary.attackCount += result.attackCount;
    summary.claimCount += result.claimCount;
    summary.claimStones += result.claimStones || 0;
    summary.claimed = summary.claimed || result.claimed;
    summary.errors.push(...result.errors);

    if (result.nextCheckMs) {
      summary.nextCheckMs = Math.max(summary.nextCheckMs || 0, result.nextCheckMs);
      summary.nextCheckReason = result.nextCheckReason || summary.nextCheckReason;
    }
  };

  // Check/claim quà treo toàn bộ trước, vì rpc_wb_claim_rewards claim theo character, không claim theo tier.
  const preSweep: WorldBossTierResult = {
    tier: "pending",
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    status: "DONE",
    errors: [],
  };
  await tryClaimTier(options, "", preSweep, "pre_run_global_pending_reward");
  if (preSweep.claimed || preSweep.errors.length > 0) applyTierResult(preSweep, true);

  for (const tier of tiers) {
    const result = await runTier(options, tier);
    applyTierResult(result, true);
  }

  // Quét thêm lần cuối để không bỏ sót quà vừa phát sinh sau vòng đánh.
  const postSweep: WorldBossTierResult = {
    tier: "pending_final",
    attackCount: 0,
    claimCount: 0,
    claimStones: 0,
    claimed: false,
    status: "DONE",
    errors: [],
  };
  await tryClaimTier(options, "", postSweep, "post_run_global_pending_reward");
  if (postSweep.claimed || postSweep.errors.length > 0) applyTierResult(postSweep, true);

  const hasError = summary.tierResults.some(item => item.status === "ERROR");
  const hasPartial = summary.tierResults.some(item => item.status === "PARTIAL_ERROR");
  const hasWaiting = summary.tierResults.some(item => item.status === "WAITING_RESPAWN" || item.claimed);

  if (hasError && summary.attackCount === 0 && !summary.claimed) summary.status = "ERROR";
  else if (hasError || hasPartial || summary.errors.length > 0) summary.status = "PARTIAL_ERROR";
  else if (hasWaiting) summary.status = "WAITING_RESPAWN";
  else if (summary.claimed) summary.status = "CLAIMED";
  else summary.status = "DONE";

  summary.finishedAt = new Date().toISOString();

  options.onLog?.(
    summary.status === "ERROR" ? "ERROR" : summary.status === "PARTIAL_ERROR" ? "WARN" : "SUCCESS",
    `Boss Thế Giới: đã claim tổng ${summary.claimStones || 0} linh thạch từ boss.`,
    summary as any,
  );

  return summary;
}
