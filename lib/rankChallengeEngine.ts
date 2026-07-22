/**
 * Rank Challenge (Sect rank PVP)
 * - rpc_sect_rank_leaderboard { p_character_id, p_min_level, p_max_level, p_limit }
 * - rpc_sect_rank_challenge { p_character_id, p_board_code, p_target_slot }
 *
 * remaining_today: số lượt còn trong ngày (max 20)
 * win=true → lưu defender.character_id vào hunt_list để đánh lại
 */

export type RankChLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface RankHuntTarget {
  id: string;
  name?: string;
  wins: number;
  losses: number;
  lastWinAt?: string;
  lastSlot?: number;
}

export interface RankChallengeRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "LOCKED" | "NO_TARGET" | "ERROR" | "PARTIAL";
  fought: number;
  wins: number;
  losses: number;
  remainingToday?: number;
  dailyLocked: boolean;
  dailyDate: string;
  huntList: RankHuntTarget[];
  nextDelayMs: number;
  reason?: string;
  boardCode?: string;
}

export interface RankChallengeAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  /** realm tier account — map board_code auto */
  realmCode?: string;
  onLog?: (level: RankChLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function rpc(name: string, payload: Record<string, any>, accessToken: string) {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "auto-lite/1.0",
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
    const err: any = new Error(`[${name}] HTTP ${res.status}: ${text || res.statusText}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  if (data && data.ok === false) {
    const reason = data.error || data.reason || data.message || data.code || "ok_false";
    const err: any = new Error(`[${name}] ${reason}`);
    err.data = data;
    throw err;
  }
  return data;
}

export function vnDateString(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

export function msUntilNextVnMidnight(nowMs = Date.now()): number {
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const vnNow = new Date(nowMs + vnOffsetMs);
  const y = vnNow.getUTCFullYear();
  const m = vnNow.getUTCMonth();
  const day = vnNow.getUTCDate();
  const nextMidnightUtcMs = Date.UTC(y, m, day + 1, 0, 0, 0, 0) - vnOffsetMs;
  return Math.max(60_000, nextMidnightUtcMs - nowMs + 5_000);
}

/** Map realm → board_code (lk/tc/kd/…) */
function resolveBoardCode(settings: Record<string, any>, realmCode?: string): string {
  const raw = String(settings.board_code || settings.board || "auto").toLowerCase().trim();
  if (raw && raw !== "auto") {
    if (["lk", "tc", "kd", "na", "ht", "lh"].includes(raw)) return raw;
  }
  const realm = String(realmCode || settings.realm_code || "").toLowerCase();
  if (realm.includes("truc") || realm === "tc") return "tc";
  if (realm.includes("kim") || realm === "kd") return "kd";
  if (realm.includes("nguyen") || realm === "na") return "na";
  if (realm.includes("hoa") || realm === "ht") return "ht";
  if (realm.includes("luyen_hu") || realm === "lh") return "lh";
  return "lk";
}

function normalizeHunt(list: any): RankHuntTarget[] {
  if (!Array.isArray(list)) return [];
  const out: RankHuntTarget[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = String(item?.id || item?.character_id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: item?.name || item?.character_name,
      wins: Number(item?.wins || 0) || 0,
      losses: Number(item?.losses || 0) || 0,
      lastWinAt: item?.lastWinAt,
      lastSlot: item?.lastSlot != null ? Number(item.lastSlot) : undefined,
    });
  }
  return out;
}

function rememberWin(hunt: RankHuntTarget[], defenderId: string, name?: string, slot?: number): RankHuntTarget[] {
  const id = String(defenderId || "").trim();
  if (!id) return hunt;
  const next = [...hunt];
  const i = next.findIndex((h) => h.id === id);
  if (i >= 0) {
    next[i] = {
      ...next[i],
      name: name || next[i].name,
      wins: (next[i].wins || 0) + 1,
      lastWinAt: new Date().toISOString(),
      lastSlot: slot ?? next[i].lastSlot,
    };
  } else {
    next.unshift({
      id,
      name,
      wins: 1,
      losses: 0,
      lastWinAt: new Date().toISOString(),
      lastSlot: slot,
    });
  }
  // giữ tối đa 30 id
  return next.slice(0, 30);
}

function rememberLoss(hunt: RankHuntTarget[], defenderId: string): RankHuntTarget[] {
  const id = String(defenderId || "").trim();
  if (!id) return hunt;
  return hunt.map((h) => (h.id === id ? { ...h, losses: (h.losses || 0) + 1 } : h));
}

function boardRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.leaderboard)) return data.leaderboard;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/** API đôi khi không trả slot — dùng thứ tự trên bảng (1-based) */
function resolveSlot(row: any, index: number): number {
  const s = Number(row?.slot ?? row?.rank ?? row?.pos ?? row?.position);
  if (Number.isFinite(s) && s >= 1) return Math.floor(s);
  return index + 1;
}

function powerScore(row: any): number {
  const atk = Number(row?.atk || 0) || 0;
  const def = Number(row?.def || 0) || 0;
  const hp = Number(row?.hp_max || row?.hp || 0) || 0;
  return atk * 2 + def + hp * 0.01;
}

/**
 * Chọn slot để challenge:
 * 1) Hunt list (đã thắng) — tìm character_id trên bảng → slot
 * 2) Đối thủ yếu hơn (atk/hp thấp), slot khác mình
 */
function pickTargets(
  rows: any[],
  hunt: RankHuntTarget[],
  selfId: string,
  preferHunt: boolean
): { slot: number; characterId: string; name?: string; fromHunt: boolean }[] {
  const self = String(selfId || "");
  // Gắn slot ổn định theo index
  const normalized = rows.map((r, idx) => ({
    ...r,
    _slot: resolveSlot(r, idx),
    _id: String(r?.character_id || r?.id || "").trim(),
  }));

  const byId = new Map<string, (typeof normalized)[0]>();
  for (const r of normalized) {
    if (r._id) byId.set(r._id, r);
  }

  const out: { slot: number; characterId: string; name?: string; fromHunt: boolean }[] = [];
  const usedSlots = new Set<number>();

  if (preferHunt) {
    for (const h of hunt) {
      const row = byId.get(h.id);
      if (!row) continue;
      const slot = row._slot || Number(h.lastSlot);
      if (!Number.isFinite(slot) || slot < 1) continue;
      if (usedSlots.has(slot)) continue;
      if (row._id === self) continue;
      usedSlots.add(slot);
      out.push({
        slot,
        characterId: row._id,
        name: row.name || h.name,
        fromHunt: true,
      });
    }
  }

  // Ưu tiên yếu (power thấp)
  const others = normalized
    .filter((r) => r._id && r._id !== self && r._slot >= 1 && !usedSlots.has(r._slot))
    .sort((a, b) => powerScore(a) - powerScore(b));

  for (const r of others) {
    if (usedSlots.has(r._slot)) continue;
    usedSlots.add(r._slot);
    out.push({
      slot: r._slot,
      characterId: r._id,
      name: r.name,
      fromHunt: false,
    });
  }

  return out;
}

export async function runRankChallengeAuto(options: RankChallengeAutoOptions): Promise<RankChallengeRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const today = vnDateString();
  const dailyLimit = Math.max(1, Math.min(20, Math.floor(Number(settings.daily_limit ?? 20)) || 20));
  const delayMs = Math.max(800, Number(settings.delay_ms || 1500) || 1500);
  const maxPerTick = Math.max(1, Math.min(20, Math.floor(Number(settings.max_fights_per_tick || 5)) || 5));
  const preferHunt = settings.prefer_hunt !== false;
  const boardCode = resolveBoardCode(settings, options.realmCode);

  let remaining = Math.max(0, Math.floor(Number(settings.remaining_today ?? dailyLimit)));
  let locked = settings.daily_locked === true;
  let dailyDate = String(settings.daily_date || "");
  let hunt = normalizeHunt(settings.hunt_list);

  if (dailyDate !== today) {
    remaining = dailyLimit;
    locked = false;
    dailyDate = today;
  }

  const summary: RankChallengeRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    fought: 0,
    wins: 0,
    losses: 0,
    remainingToday: remaining,
    dailyLocked: locked,
    dailyDate,
    huntList: hunt,
    nextDelayMs: delayMs * 2,
    boardCode,
  };

  if (locked || remaining <= 0) {
    summary.status = "LOCKED";
    summary.dailyLocked = true;
    summary.remainingToday = 0;
    summary.nextDelayMs = msUntilNextVnMidnight();
    summary.reason = `Hôm nay đã xong (${today}) · chờ 00:00 VN`;
    onLog?.("INFO", `RankCh: đủ ngày · remaining 0 · next ${Math.ceil(summary.nextDelayMs / 3600000)}h`);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  try {
    onLog?.("INFO", `RankCh: leaderboard board=${boardCode} · còn ${remaining}/${dailyLimit}`);

    const board = await rpc(
      "rpc_sect_rank_leaderboard",
      {
        p_character_id: options.characterId,
        p_min_level: Math.max(1, Number(settings.min_level || 1) || 1),
        p_max_level: Math.max(1, Number(settings.max_level || 20) || 20),
        p_limit: Math.max(10, Math.min(50, Number(settings.board_limit || 20) || 20)),
      },
      options.accessToken
    );

    const rows = boardRows(board);
    if (!rows.length) {
      summary.status = "NO_TARGET";
      summary.reason = "Bảng xếp hạng trống";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", "RankCh: không có ai trên bảng");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const targets = pickTargets(rows, hunt, options.characterId, preferHunt);
    if (!targets.length) {
      summary.status = "NO_TARGET";
      summary.reason = "Không chọn được slot";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", "RankCh: không có target");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const toFight = Math.min(maxPerTick, remaining, targets.length);
    for (let i = 0; i < toFight; i++) {
      if (options.shouldStop?.()) break;
      if (remaining <= 0) break;

      const t = targets[i];
      try {
        const res = await rpc(
          "rpc_sect_rank_challenge",
          {
            p_character_id: options.characterId,
            p_board_code: boardCode,
            p_target_slot: t.slot,
          },
          options.accessToken
        );

        summary.fought += 1;
        const win = res?.win === true || res?.battle?.winner === "attacker";
        const rem = Number(res?.remaining_today);
        if (Number.isFinite(rem)) remaining = Math.max(0, rem);
        else remaining = Math.max(0, remaining - 1);

        const defId = String(res?.defender?.character_id || t.characterId || "").trim();
        const defName = String(res?.defender?.name || t.name || "").trim();
        const slotAfter = Number(res?.target_slot ?? t.slot);

        if (win) {
          summary.wins += 1;
          hunt = rememberWin(hunt, defId, defName, slotAfter);
          onLog?.(
            "SUCCESS",
            `RankCh WIN slot ${t.slot} · ${defName || defId.slice(0, 8)} · còn ${remaining} · hunt ${hunt.length}`
          );
        } else {
          summary.losses += 1;
          hunt = rememberLoss(hunt, defId);
          onLog?.("WARN", `RankCh LOSE slot ${t.slot} · ${defName || "?"} · còn ${remaining}`);
        }

        if (remaining <= 0) {
          locked = true;
          break;
        }
        if (i + 1 < toFight) await sleep(delayMs);
      } catch (e: any) {
        const msg = e?.message || String(e);
        onLog?.("ERROR", `RankCh fail slot ${t.slot}: ${msg.slice(0, 100)}`);
        // Hết lượt?
        if (/remaining|limit|daily|hết|het lượt|no.?challenge/i.test(msg + JSON.stringify(e?.data || {}))) {
          remaining = 0;
          locked = true;
          break;
        }
        summary.status = "PARTIAL";
        await sleep(delayMs);
      }
    }

    summary.remainingToday = remaining;
    summary.dailyLocked = locked || remaining <= 0;
    summary.dailyDate = today;
    summary.huntList = hunt;

    if (summary.dailyLocked) {
      summary.status = "LOCKED";
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Xong hôm nay · ${summary.wins}W/${summary.losses}L · chờ 00:00 VN`;
      onLog?.("SUCCESS", `RankCh DONE hôm nay · ${summary.wins}W/${summary.losses}L · hunt ${hunt.length}`);
    } else {
      summary.status = summary.fought > 0 ? "DONE" : "NO_TARGET";
      summary.nextDelayMs = Math.max(delayMs * 2, 10_000);
      summary.reason = `Batch ${summary.wins}W/${summary.losses}L · còn ${remaining}`;
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 60_000;
    summary.remainingToday = remaining;
    summary.dailyLocked = locked;
    summary.dailyDate = today;
    summary.huntList = hunt;
    onLog?.("ERROR", `RankCh error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
