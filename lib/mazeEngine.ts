import type { LogLevel } from "./logEngine";

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

type MazeLogFn = (level: LogLevel, message: string, meta?: Record<string, any>) => void;

export interface MazeAutoOptions {
  characterId: string;
  accessToken: string;
  tier: number;
  autoBoss?: boolean;
  autoClaimFinal?: boolean;
  bossHpReserve?: number;
  maxPasses?: number;
  delayMs?: number;
  onLog?: MazeLogFn;
}

export interface MazeRunSummary {
  runId?: string;
  tier: number;
  status?: string;
  hp?: number;
  maxHp?: number;
  coins?: number;
  keys?: number;
  bossKilled?: boolean;
  claimed?: boolean;
  coTe?: number;
  minted?: number;
  paid?: string;
  freeLeft?: number;
  lsLeft?: number;
  startedAt: number;
  finishedAt?: number;
}

interface MazeEvent {
  t?: string;
  rar?: string;
  loot?: number;
  success?: boolean;
  open?: boolean;
  cleared?: boolean;
  hidden?: boolean;
  elite?: boolean;
  [key: string]: any;
}

interface MazeRun {
  run_id?: string;
  status?: string;
  hp?: number;
  max_hp?: number;
  coins?: number;
  keys?: number;
  tier?: number;
  events?: Record<string, MazeEvent>;
  boss_cost?: number;
  boss_bonus?: number;
  boss_killed?: boolean;
  [key: string]: any;
}

interface MazeTarget {
  pos: string;
  r: number;
  c: number;
  event: MazeEvent;
  score: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parsePos = (pos: string) => {
  const [r, c] = pos.split(",").map(Number);
  return { r, c };
};

const isCleared = (event?: MazeEvent) => !!event?.cleared || !!event?.open;

const isClosedDoor = (event?: MazeEvent) => event?.t === "door" && event.open !== true && event.cleared !== true;

const rewardScore = (event?: MazeEvent) => {
  if (!event || isCleared(event)) return -9999;

  if (event.t === "chest") {
    const rarBonus =
      event.rar === "A" ? 1000 :
      event.rar === "B" ? 600 :
      event.rar === "C" ? 300 :
      100;
    return 5000 + rarBonus + Number(event.loot || 0);
  }

  if (event.t === "fortune" && event.success) return 4500 + Number(event.loot || 0);
  if (event.t === "spring") return 2500;
  if (event.t === "key") return 2200;
  if (event.t === "door") return 2000;
  if (event.t === "boss") return 100;

  return 0;
};

const listKnownEvents = (run: MazeRun): MazeTarget[] => {
  return Object.entries(run.events || {}).map(([pos, event]) => {
    const { r, c } = parsePos(pos);
    return {
      pos,
      r,
      c,
      event,
      score: rewardScore(event),
    };
  });
};

const sortTargets = (targets: MazeTarget[]) => {
  return targets.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.r !== b.r) return a.r - b.r;
    return a.c - b.c;
  });
};

const getRewardTargets = (run: MazeRun) => {
  return sortTargets(listKnownEvents(run).filter(target => {
    const event = target.event;
    if (!event || isCleared(event)) return false;
    if (event.t === "chest") return true;
    if (event.t === "fortune" && event.success) return true;
    if (event.t === "spring") return true;
    return false;
  }));
};

const getKeyTargets = (run: MazeRun) => {
  return sortTargets(listKnownEvents(run).filter(target => target.event?.t === "key" && !isCleared(target.event)));
};

const getDoorTargets = (run: MazeRun) => {
  return sortTargets(listKnownEvents(run).filter(target => isClosedDoor(target.event)));
};

const getBossTargets = (run: MazeRun) => {
  return sortTargets(listKnownEvents(run).filter(target => target.event?.t === "boss" && !isCleared(target.event)));
};

const shouldSkipTarget = (target: MazeTarget, label: string) => {
  const type = target.event?.t;
  if (!type) return true;
  if (isCleared(target.event)) return true;
  if (type === "monster") return true;
  if (type === "trap") return true;
  if (type === "fire") return true;
  if (type === "merchant") return true;
  if (type === "boss" && label !== "BOSS") return true;
  return false;
};

const toNumberOrUndefined = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export async function runMazeAuto(options: MazeAutoOptions): Promise<MazeRunSummary> {
  const tier = Math.min(6, Math.max(1, Number(options.tier || 1)));
  const delayMs = Number(options.delayMs ?? 500);
  const maxPasses = Number(options.maxPasses ?? 5);
  const autoBoss = options.autoBoss !== false;
  const autoClaimFinal = options.autoClaimFinal !== false;
  const bossHpReserve = Number(options.bossHpReserve ?? 5);
  const log: MazeLogFn = options.onLog || (() => undefined);

  const summary: MazeRunSummary = {
    tier,
    startedAt: Date.now(),
  };

  async function rpc(name: string, payload: Record<string, any>) {
    const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: GAME_API_KEY,
        authorization: `Bearer ${options.accessToken}`,
        "content-profile": "public",
        "content-type": "application/json",
        "x-client-info": "supabase-flutter/2.12.0",
      },
      body: JSON.stringify(payload),
      credentials: "omit",
      mode: "cors",
    });

    const text = await res.text();
    let data: any;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(`[${name}] HTTP ${res.status}: ${text}`);
      (err as any).data = data;
      throw err;
    }

    if (data && data.ok === false) {
      const reason = data.error || data.reason || data.message || data.code || "ok_false";
      const err = new Error(`[${name}] ${reason}`);
      (err as any).data = data;
      throw err;
    }

    return data;
  }

  async function resolveTarget(run: MazeRun, target: MazeTarget, label: string): Promise<MazeRun> {
    if (shouldSkipTarget(target, label)) {
      log("DEBUG", `Bỏ qua ô ${target.pos} type=${target.event?.t || "unknown"}.`);
      return run;
    }

    log("INFO", `${label}: resolve ${target.pos} type=${target.event.t}${target.event.rar ? ` rar=${target.event.rar}` : ""}${target.event.loot !== undefined ? ` loot=${target.event.loot}` : ""}.`);

    const data = await rpc("rpc_me_cung_resolve_event", {
      p_character_id: options.characterId,
      p_run_id: run.run_id,
      p_r: target.r,
      p_c: target.c,
      p_choice: null,
    });

    const newRun: MazeRun = data?.run || run;

    log("SUCCESS", `${label}: OK ${target.pos}, outcome=${data?.outcome || "-"}, coins=${newRun.coins ?? "?"}, keys=${newRun.keys ?? "?"}, hp=${newRun.hp ?? "?"}/${newRun.max_hp ?? "?"}.`, {
      pos: target.pos,
      type: target.event.t,
      outcome: data?.outcome,
      coins: newRun.coins,
      keys: newRun.keys,
      hp: newRun.hp,
      bossKilled: newRun.boss_killed,
    });

    await sleep(delayMs);
    return newRun;
  }

  async function processTargets(run: MazeRun, targets: MazeTarget[], label: string): Promise<MazeRun> {
    for (const rawTarget of targets) {
      const latestEvent = run.events?.[rawTarget.pos];
      if (!latestEvent || isCleared(latestEvent)) continue;

      const target = {
        ...rawTarget,
        event: latestEvent,
        score: rewardScore(latestEvent),
      };

      run = await resolveTarget(run, target, label);
    }

    return run;
  }

  log("INFO", `Bắt đầu Mê Cung tier ${tier}.`);

  const startData = await rpc("rpc_me_cung_start", {
    p_character_id: options.characterId,
    p_tier: tier,
  });

  let run: MazeRun = startData?.run;

  if (!run?.run_id) {
    throw new Error("Không nhận được run_id từ rpc_me_cung_start.");
  }

  Object.assign(summary, {
    runId: run.run_id,
    tier,
    paid: startData?.paid,
    freeLeft: toNumberOrUndefined(startData?.free_left),
    lsLeft: toNumberOrUndefined(startData?.ls_left),
    status: run.status,
    hp: toNumberOrUndefined(run.hp),
    maxHp: toNumberOrUndefined(run.max_hp),
    coins: toNumberOrUndefined(run.coins),
    keys: toNumberOrUndefined(run.keys),
    bossKilled: !!run.boss_killed,
  });

  log("SUCCESS", `Start OK run_id=${run.run_id}, paid=${startData?.paid || "?"}, free_left=${startData?.free_left ?? "?"}, hp=${run.hp ?? "?"}/${run.max_hp ?? "?"}.`, {
    runId: run.run_id,
    paid: startData?.paid,
    freeLeft: startData?.free_left,
    lsLeft: startData?.ls_left,
  });

  for (let pass = 1; pass <= maxPasses; pass++) {
    const rewardCount = getRewardTargets(run).length;
    const keyCount = getKeyTargets(run).length;
    const doorCount = getDoorTargets(run).length;

    log("INFO", `Pass ${pass}/${maxPasses}: reward=${rewardCount}, key=${keyCount}, door=${doorCount}.`);

    if (rewardCount === 0 && keyCount === 0 && doorCount === 0) {
      break;
    }

    run = await processTargets(run, getRewardTargets(run), "REWARD");
    run = await processTargets(run, getKeyTargets(run), "KEY");
    run = await processTargets(run, getDoorTargets(run), "DOOR");
    run = await processTargets(run, getRewardTargets(run), "REWARD_AFTER_DOOR");
  }

  if (autoBoss) {
    const bosses = getBossTargets(run);
    if (bosses.length === 0) {
      log("WARN", "Không thấy boss hoặc boss đã được xử lý.");
    } else {
      const bossCost = Number(run.boss_cost || 0);
      const hp = Number(run.hp || 0);
      if (bossCost > 0 && hp < bossCost + bossHpReserve) {
        log("WARN", `Không đánh boss vì HP chưa đủ an toàn: hp=${hp}, boss_cost=${bossCost}, reserve=${bossHpReserve}.`);
      } else {
        run = await processTargets(run, bosses, "BOSS");
      }
    }
  } else {
    log("WARN", "autoBoss=false, bỏ qua boss.");
  }

  summary.status = run.status;
  summary.hp = toNumberOrUndefined(run.hp);
  summary.maxHp = toNumberOrUndefined(run.max_hp);
  summary.coins = toNumberOrUndefined(run.coins);
  summary.keys = toNumberOrUndefined(run.keys);
  summary.bossKilled = !!run.boss_killed;

  if (autoClaimFinal) {
    const canClaim = run.boss_killed === true || ["cleared", "complete", "completed"].includes(String(run.status || ""));

    if (canClaim) {
      log("INFO", "Đang claim thưởng cuối mê cung bằng rpc_me_cung_claim.");

      const claimData = await rpc("rpc_me_cung_claim", {
        p_character_id: options.characterId,
        p_run_id: run.run_id,
      });

      summary.claimed = !!claimData?.ok;
      summary.coTe = toNumberOrUndefined(claimData?.co_te);
      summary.minted = toNumberOrUndefined(claimData?.minted);
      summary.status = claimData?.status || summary.status;
      summary.bossKilled = claimData?.boss_killed ?? summary.bossKilled;

      log("SUCCESS", `Claim final OK: co_te=${claimData?.co_te ?? "?"}, minted=${claimData?.minted ?? "?"}, status=${claimData?.status || "?"}.`, {
        coTe: claimData?.co_te,
        minted: claimData?.minted,
        status: claimData?.status,
      });
    } else {
      summary.claimed = false;
      log("WARN", `Chưa claim cuối vì boss_killed=${run.boss_killed} status=${run.status}.`);
    }
  } else {
    summary.claimed = false;
    log("WARN", "autoClaimFinal=false, bỏ qua claim cuối.");
  }

  summary.finishedAt = Date.now();
  log("SUCCESS", `Mê Cung hoàn tất: status=${summary.status || "?"}, coins=${summary.coins ?? "?"}, boss=${summary.bossKilled ? "killed" : "not_killed"}, claimed=${summary.claimed ? "yes" : "no"}.`);

  return summary;
}
