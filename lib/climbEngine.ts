/**
 * Auto Vân Thê Lộ (climb) — feature riêng, KHÔNG dùng code Ngũ Hành Tháp.
 *
 * RPC (vanthelo.txt):
 * - rpc_climb_maps            { p_character_id }
 *      → realm_level, reward_cap, soul_balance, maps[] (code/name/unlocked/min_realm_level/cleared_today/clears_total/quota/zones/hp_mult/boss_name/top_reward)
 * - rpc_climb_run_start       { p_character_id, p_map_code }
 *      → trả layout chặng (run_id, spawns[], platforms[], buffs[], seed, hp_mult, reward_cap, rewarded_today, fire_interval_sec ...)
 * - rpc_climb_run_progress     { p_character_id, p_run_id, p_spawn_idx/p_idx/p_mob_id/p_x/p_wave/p_progress/p_kills }
 *      → gọi mỗi khi quái chết; server advance wave; response có thể báo completed/rank/rewards
 *
 * Đặc điểm: run_start trả toàn bộ layout (spawns có idx/tọa độ, platforms, buffs). Nhân vật tự đánh,
 * player di chuyển tới đợt quái (local client, không thành RPC). Mỗi quái chết client gọi
 * rpc_climb_run_progress. Bot mô phỏng bằng cách gọi run_progress cho từng spawn theo thứ tự idx.
 *
 * Luồng:
 * 1) maps → lọc map unlocked + min_realm_level <= realm_level + cleared_today == 0
 * 2) với mỗi map: run_start → log layout (spawns theo kind, buffs, seed, run_id)
 * 3) drive: gọi rpc_climb_run_progress cho từng spawn (payload tolerant, log raw để dò hình dạng)
 * 4) re-check maps: cleared_today == 1 (hoặc rewarded_today tăng) → XONG (thắng)
 * 5) hết map khả dụng / đã clear → chờ 00:00 VN (dùng msUntilNextVnMidnight)
 */

import { msUntilNextVnMidnight, vnDateString } from "./nguHanhThapEngine";

export type ClimbLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export type ClimbStatus = "DONE" | "PARTIAL" | "WAITING" | "ERROR" | "SKIPPED";

export interface ClimbRunResult {
  mapCode: string;
  mapName?: string;
  runId?: string;
  cleared?: boolean;
  rank?: string;
  rewards?: any;
  spawns?: { normal: number; elite: number; boss: number };
  progressCalls?: number;
  raw?: any;
}

export interface ClimbRunSummary {
  startedAt: string;
  finishedAt: string;
  status: ClimbStatus;
  realmLevel: number;
  rewardCap: number;
  mapsTried: number;
  mapsCleared: number;
  runs: ClimbRunResult[];
  nextDelayMs: number;
  reason?: string;
  persist: Record<string, any>;
}

export interface ClimbAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: ClimbLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
  /** ms đến 00:00 VN — orchestrator truyền */
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

interface ClimbMap {
  code: string;
  name: string;
  unlocked: boolean;
  min_realm_level: number;
  cleared_today: number;
  clears_total: number;
  boss_name?: string;
  mob_level?: number;
  hp_mult?: number;
  quota?: any;
  top_reward?: any;
  zones?: any[];
}

function spawnSummaryOf(runStart: any) {
  const spawns = Array.isArray(runStart?.spawns) ? runStart.spawns : [];
  return {
    normal: spawns.filter((s: any) => s.kind === "normal").length,
    elite: spawns.filter((s: any) => s.kind === "elite").length,
    boss: spawns.filter((s: any) => s.kind === "boss").length,
  };
}

export async function runClimbAuto(options: ClimbAutoOptions): Promise<ClimbRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const delayMs = clamp(settings.delay_ms ?? 2000, 500, 30_000, 2000);
  const maxMapsPerRun = clamp(settings.max_maps_per_run ?? 6, 1, 12, 6);
  const preferHighestTier = settings.climb_prefer_highest_tier !== false;
  const preferTier = String(settings.climb_prefer_tier || "").trim().toLowerCase();
  const settleMs = clamp(settings.climb_settle_sec ?? 20, 0, 600, 20) * 1000;
  const waitMidnightMs = Math.max(60_000, Number(options.msUntilNextMidnight || msUntilNextVnMidnight()));
  const today = vnDateString();

  const runs: ClimbRunResult[] = [];

  const summary: ClimbRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    realmLevel: 0,
    rewardCap: 0,
    mapsTried: 0,
    mapsCleared: 0,
    runs,
    nextDelayMs: waitMidnightMs,
    persist: {},
  };

  const finish = (extra: Partial<ClimbRunSummary> = {}) => {
    Object.assign(summary, extra);
    summary.finishedAt = new Date().toISOString();
    summary.runs = runs;
    summary.persist = {
      daily_date: today,
      climb_maps_cleared_today: summary.mapsCleared,
      climb_maps_tried_today: summary.mapsTried,
      climb_last_status: summary.status,
      climb_last_run_at: summary.finishedAt,
      ...(extra.persist || {}),
    };
    return summary;
  };

  try {
    // 1) Lấy danh sách map + realm_level + reward_cap
    let mapsData: any;
    try {
      mapsData = await rpc("rpc_climb_maps", { p_character_id: options.characterId }, options.accessToken);
    } catch (err: any) {
      return finish({ status: "ERROR", reason: err?.message || "climb_maps_failed", nextDelayMs: 5 * 60_000 });
    }

    const realmLevel = Math.max(0, Math.floor(Number(mapsData?.realm_level) || 0));
    const rewardCap = Math.max(0, Math.floor(Number(mapsData?.reward_cap) || 0));
    const maps: ClimbMap[] = Array.isArray(mapsData?.maps) ? mapsData.maps : [];
    summary.realmLevel = realmLevel;
    summary.rewardCap = rewardCap;

    // 2) Lọc candidate: unlocked + đủ cảnh giới + chưa clear hôm nay
    let candidates = maps.filter(
      (m) =>
        m.unlocked &&
        Number(m.cleared_today || 0) < 1 &&
        Number(m.min_realm_level || 0) <= realmLevel
    );
    if (preferTier) {
      candidates = candidates.filter((m) => m.code === `van_the_lo_${preferTier}`);
    }
    candidates.sort((a, b) =>
      preferHighestTier
        ? Number(b.min_realm_level) - Number(a.min_realm_level)
        : Number(a.min_realm_level) - Number(b.min_realm_level)
    );
    candidates = candidates.slice(0, maxMapsPerRun);

    if (!candidates.length) {
      onLog?.(
        "INFO",
        `Vân Thê Lộ: không có map khả dụng (realm ${realmLevel}, reward_cap ${rewardCap}) · chờ 00:00 VN`
      );
      summary.status = "WAITING";
      summary.reason = "no_available_map";
      return finish({ nextDelayMs: waitMidnightMs });
    }

    onLog?.(
      "SUCCESS",
      `Vân Thê Lộ: ${candidates.length} map sẽ chạy (realm ${realmLevel}, reward_cap ${rewardCap})`
    );

    // 3) Chạy từng map
    for (const map of candidates) {
      if (options.shouldStop?.()) {
        summary.status = "PARTIAL";
        summary.reason = "stopped";
        break;
      }
      summary.mapsTried += 1;

      let runStart: any;
      try {
        runStart = await rpc(
          "rpc_climb_run_start",
          { p_character_id: options.characterId, p_map_code: map.code },
          options.accessToken
        );
      } catch (err: any) {
        onLog?.("WARN", `Vân Thê Lộ ${map.code} lỗi start: ${err?.message || "unknown"}`, err?.data);
        runs.push({ mapCode: map.code, mapName: map.name, raw: err?.data });
        continue;
      }

      if (!runStart || runStart.ok === false) {
        onLog?.("WARN", `Vân Thê Lộ ${map.code}: ok=false → bỏ qua`, runStart);
        runs.push({ mapCode: map.code, mapName: map.name, raw: runStart });
        await sleep(delayMs);
        continue;
      }

      const sp = spawnSummaryOf(runStart);
      const rewardedBefore = Number(runStart.rewarded_today || 0);
      onLog?.(
        "INFO",
        `Vân Thê Lộ ${map.code} (${map.name}) · run_id=${runStart.run_id || "?"} · mob ${sp.normal}N/${sp.elite}E/${sp.boss}B · hp_mult ${runStart.hp_mult} · reward_cap ${runStart.reward_cap} · rewarded_today ${rewardedBefore}`
      );

      // Kết quả từ run_start (nếu server trả sẵn) — tolerant
      let cleared: boolean | undefined =
        runStart.cleared === true ||
        (runStart.ok === true &&
          (runStart.result === "clear" || runStart.result === "victory" || runStart.cleared_today === 1))
          ? true
          : undefined;
      let rank = runStart.rank || runStart.result_rank;
      let rewards = runStart.rewards;

      // === Drive run qua rpc_climb_run_progress (gọi mỗi khi quái chết) ===
      // Server-sim: client báo từng con chết → server advance wave → chốt khi boss chết.
      // Gửi payload tolerant (nhiều tên trường khả dĩ) + log raw để dò hình dạng thật.
      const mobs = Array.isArray(runStart.spawns) ? runStart.spawns : [];
      const ordered = mobs
        .map((s: any, i: number) => ({ s, idx: Number(s.idx ?? s.spawn_idx ?? i) }))
        .sort((a: any, b: any) => a.idx - b.idx);

      const progressDelayMs = clamp(settings.climb_progress_delay_ms ?? 350, 0, 5000, 350);
      let progressCalls = 0;
      for (const { s, idx } of ordered) {
        if (options.shouldStop?.()) break;
        const payload: any = {
          p_character_id: options.characterId,
          p_run_id: runStart.run_id,
          p_spawn_idx: idx,
          p_idx: idx,
          p_mob_id: idx,
          p_x: s.x ?? s.min_x ?? s.max_x,
          p_y: s.y,
          p_wave: s.wave,
          p_progress: idx + 1,
          p_kills: idx + 1,
        };
        Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
        try {
          const r = await rpc("rpc_climb_run_progress", payload, options.accessToken);
          progressCalls += 1;
          onLog?.(
            "DEBUG",
            `Vân Thê Lộ ${map.code} progress idx=${idx} → ${JSON.stringify(r).slice(0, 400)}`
          );
          if (
            r?.completed === true ||
            (r?.ok === true && (r?.result === "clear" || r?.result === "victory")) ||
            r?.cleared_today === 1
          ) {
            cleared = true;
          }
          if (r?.rank) rank = r.rank;
          if (r?.rewards) rewards = r.rewards;
        } catch (e: any) {
          onLog?.("DEBUG", `Vân Thê Lộ ${map.code} progress idx=${idx} lỗi: ${e?.message || "unknown"}`);
        }
        await sleep(progressDelayMs);
      }

      // Server-sim: sau drive, kết quả phản ánh qua rpc_climb_maps (cleared_today / rewarded_today).
      // Kiểm tra ngay, nếu chưa có thì đợi climb_settle_sec rồi check lại 1 lần.
      const checkCleared = async (): Promise<boolean> => {
        if (cleared === true) return true;
        try {
          const after = await rpc("rpc_climb_maps", { p_character_id: options.characterId }, options.accessToken);
          const afterMap = Array.isArray(after?.maps)
            ? after.maps.find((m: any) => m.code === map.code)
            : null;
          const rewardedAfter = Number(after?.rewarded_today ?? afterMap?.rewarded_today ?? 0);
          if (afterMap && Number(afterMap.cleared_today || 0) >= 1) {
            cleared = true;
            if (!rewards && afterMap.top_reward) rewards = afterMap.top_reward;
          } else if (rewardedAfter > rewardedBefore) {
            cleared = true;
          }
        } catch {
          /* ignore */
        }
        return cleared === true;
      };

      if (cleared !== true) await checkCleared();
      if (cleared !== true) {
        onLog?.("DEBUG", `Vân Thê Lộ ${map.code}: chưa thấy cleared_today — đợi ${settleMs / 1000}s rồi check lại`);
        await sleep(settleMs);
        await checkCleared();
      }

      if (cleared === true) summary.mapsCleared += 1;
      runs.push({
        mapCode: map.code,
        mapName: map.name,
        runId: runStart.run_id,
        cleared: cleared === true,
        rank,
        rewards,
        spawns: sp,
        progressCalls,
        raw: runStart,
      });
      onLog?.(
        cleared ? "SUCCESS" : "WARN",
        `Vân Thê Lộ ${map.code}: ${cleared ? "XONG (clear)" : "chưa rõ kết quả — xem cleared_today/rewarded_today"} · rank ${rank || "?"} · progress_calls ${progressCalls}`
      );

      await sleep(delayMs);
    }

    // 4) Quyết định next delay
    if (summary.mapsTried === 0) {
      summary.status = "SKIPPED";
      summary.reason = "no_available_map";
      return finish({ nextDelayMs: waitMidnightMs });
    }
    if (summary.mapsCleared >= summary.mapsTried) {
      summary.status = "DONE";
      summary.reason = "all_cleared";
      return finish({ nextDelayMs: waitMidnightMs });
    }
    if (summary.mapsCleared === 0) {
      // Không map nào clear được (có thể yếu/thua) → chờ ngày mới
      summary.status = "WAITING";
      summary.reason = "none_cleared";
      return finish({ nextDelayMs: waitMidnightMs });
    }
    summary.status = "PARTIAL";
    summary.reason = "partial";
    return finish({ nextDelayMs: Math.max(delayMs, 60_000) });
  } catch (err: any) {
    onLog?.("ERROR", `Vân Thê Lộ exception: ${err?.message || "unknown"}`, err?.data);
    return finish({
      status: "ERROR",
      reason: err?.message || "climb_exception",
      nextDelayMs: 5 * 60_000,
    });
  }
}
