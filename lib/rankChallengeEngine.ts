/**
 * Buff PVP (Sect rank challenge)
 * - rpc_sect_rank_leaderboard { p_character_id, p_min_level, p_max_level, p_limit }
 * - rpc_sect_rank_challenge { p_character_id, p_board_code, p_target_slot }
 *
 * User nhập số lần WIN muốn đạt (daily_target / win_target).
 * Chỉ đếm trận win (isChallengeWin). LOSE không tính vào target.
 * 10 trận thật liên tiếp không win → dừng (an toàn, tránh spam thua).
 * Đủ win trong ngày → khóa đến 00:00 VN. Không phụ thuộc remaining_today API.
 * win → lưu defender.character_id vào hunt_list để đánh lại
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
  status: "DONE" | "LOCKED" | "NO_TARGET" | "ERROR" | "PARTIAL" | "NO_WIN";
  fought: number;
  wins: number;
  losses: number;
  /** số WIN đã có trong ngày (tiến tới target) */
  dailyCompleted: number;
  /** số WIN user muốn đạt / ngày */
  dailyTarget: number;
  /** chuỗi thua liên tiếp (reset khi win) */
  loseStreak: number;
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

/** Map realm / last board → board_code (preview win: board_code "na") */
function resolveBoardCode(settings: Record<string, any>, realmCode?: string): string {
  const raw = String(settings.board_code || settings.board || "auto").toLowerCase().trim();
  if (raw && raw !== "auto") {
    if (["lk", "tc", "kd", "na", "ht", "lh"].includes(raw)) return raw;
  }
  // Lưu từ response win lần trước
  const last = String(settings.last_board_code || "").toLowerCase().trim();
  if (["lk", "tc", "kd", "na", "ht", "lh"].includes(last)) return last;

  const realm = String(realmCode || settings.realm_code || settings.realmLabel || "").toLowerCase();
  if (realm.includes("truc") || realm.includes("trúc") || realm === "tc") return "tc";
  if (realm.includes("kim") || realm === "kd") return "kd";
  if (realm.includes("nguyen") || realm.includes("nguyên") || realm === "na") return "na";
  if (realm.includes("hoa") || realm.includes("hoá") || realm.includes("hóa") || realm === "ht") return "ht";
  if (realm.includes("luyen_hu") || realm.includes("luyện hư") || realm === "lh") return "lh";
  if (realm.includes("luyen_khi") || realm.includes("luyện khí") || realm === "lk") return "lk";
  return "lk";
}

/** Preview win: win=true | battle.winner=attacker | defender_hp=0 */
function isChallengeWin(res: any): boolean {
  if (!res) return false;
  if (res.win === true) return true;
  if (res.battle?.winner === "attacker") return true;
  if (res.battle?.simulation?.winner === "attacker") return true;
  const defHp = Number(res.battle?.final?.defender_hp);
  if (Number.isFinite(defHp) && defHp <= 0) return true;
  return false;
}

function isEasyNpcName(name: any): boolean {
  const n = String(name || "");
  return /\[NPC\]|\[Trấn\]|\[Tran\]|NPC|Lính|Linh #/i.test(n);
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

/** Chỉ nhận slot THẬT từ API (không bịa index → invalid_slot) */
function realSlot(row: any): number | null {
  if (row == null || row.slot == null || row.slot === "") return null;
  const s = Number(row.slot);
  if (!Number.isFinite(s) || s < 1) return null;
  return Math.floor(s);
}

function powerScore(row: any): number {
  const atk = Number(row?.atk || 0) || 0;
  const def = Number(row?.def || 0) || 0;
  const hp = Number(row?.hp_max || row?.hp || 0) || 0;
  return atk * 2 + def + hp * 0.01;
}

/**
 * Chọn slot challenge:
 * - Có field slot từ API → dùng slot đó (đúng board rank)
 * - Không có slot → probe slot 2..maxProbe (win preview: slot 2,3; rank 1 đánh gần)
 * KHÔNG dùng index mảng làm slot (gây invalid_slot 11/14/15)
 */
function pickTargets(
  rows: any[],
  hunt: RankHuntTarget[],
  selfId: string,
  preferHunt: boolean,
  maxProbeSlot = 10
): { slot: number; characterId: string; name?: string; fromHunt: boolean }[] {
  const self = String(selfId || "");
  const withSlot = rows
    .map((r) => ({
      ...r,
      _slot: realSlot(r),
      _id: String(r?.character_id || r?.id || "").trim(),
    }))
    .filter((r) => r._slot != null) as Array<any & { _slot: number; _id: string }>;

  const out: { slot: number; characterId: string; name?: string; fromHunt: boolean }[] = [];
  const usedSlots = new Set<number>();

  if (withSlot.length > 0) {
    const byId = new Map<string, (typeof withSlot)[0]>();
    for (const r of withSlot) {
      if (r._id) byId.set(r._id, r);
    }

    if (preferHunt) {
      for (const h of hunt) {
        const row = byId.get(h.id);
        const slot = row?._slot ?? (Number.isFinite(Number(h.lastSlot)) ? Number(h.lastSlot) : null);
        if (slot == null || slot < 1 || usedSlots.has(slot)) continue;
        const cid = row?._id || h.id;
        if (cid === self) continue;
        usedSlots.add(slot);
        out.push({
          slot,
          characterId: cid,
          name: row?.name || h.name,
          fromHunt: true,
        });
      }
    }

    const others = withSlot
      .filter((r) => r._id && r._id !== self && !usedSlots.has(r._slot))
      .sort((a, b) => {
        const ea = isEasyNpcName(a.name) ? 0 : 1;
        const eb = isEasyNpcName(b.name) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return powerScore(a) - powerScore(b);
      });

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

  // Không có slot trong leaderboard → probe slot gần (2..10), bỏ 1 (thường là top)
  for (let slot = 2; slot <= maxProbeSlot; slot++) {
    // Hunt gợi ý lastSlot
    const h = preferHunt ? hunt.find((x) => Number(x.lastSlot) === slot) : undefined;
    out.push({
      slot,
      characterId: h?.id || "",
      name: h?.name || `slot#${slot}`,
      fromHunt: Boolean(h),
    });
  }
  return out;
}

/** Số WIN user muốn đạt / ngày (alias win_target | daily_limit) */
function resolveWinTarget(settings: Record<string, any>): number {
  const raw = Number(settings.daily_target ?? settings.win_target ?? settings.daily_limit ?? 20);
  return Math.max(1, Math.min(200, Math.floor(Number.isFinite(raw) ? raw : 20)));
}

/** Chuỗi thua liên tiếp tối đa trước khi dừng (mặc định 10) */
function resolveMaxNoWinStreak(settings: Record<string, any>): number {
  const raw = Number(settings.max_no_win_streak ?? 10);
  return Math.max(3, Math.min(50, Math.floor(Number.isFinite(raw) ? raw : 10)));
}

export async function runRankChallengeAuto(options: RankChallengeAutoOptions): Promise<RankChallengeRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const today = vnDateString();
  const winTarget = resolveWinTarget(settings);
  const maxNoWinStreak = resolveMaxNoWinStreak(settings);
  const delayMs = Math.max(800, Number(settings.delay_ms || 1500) || 1500);
  // Mỗi tick tối đa N trận thật (win+lose); cần nhiều win thì chạy nhiều tick
  const maxPerTick = Math.max(1, Math.min(30, Math.floor(Number(settings.max_fights_per_tick || 10)) || 10));
  const preferHunt = settings.prefer_hunt !== false;
  let boardCode = resolveBoardCode(settings, options.realmCode);

  // daily_completed = số WIN trong ngày (không đếm lose)
  let dailyWins = Math.max(0, Math.floor(Number(settings.daily_completed || settings.daily_wins || 0)) || 0);
  let loseStreak = Math.max(0, Math.floor(Number(settings.lose_streak || 0)) || 0);
  let locked = settings.daily_locked === true;
  let dailyDate = String(settings.daily_date || "");
  let hunt = normalizeHunt(settings.hunt_list);
  let stopNoWin = false;

  // Sang ngày mới VN → reset đếm
  if (dailyDate !== today) {
    dailyWins = 0;
    loseStreak = 0;
    locked = false;
    dailyDate = today;
  }

  // Đủ số WIN → khóa đến 00:00
  if (locked || dailyWins >= winTarget) {
    locked = true;
  }

  const summary: RankChallengeRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    fought: 0,
    wins: 0,
    losses: 0,
    dailyCompleted: dailyWins,
    dailyTarget: winTarget,
    loseStreak,
    dailyLocked: locked,
    dailyDate,
    huntList: hunt,
    nextDelayMs: delayMs * 2,
    boardCode,
  };

  if (locked || dailyWins >= winTarget) {
    summary.status = "LOCKED";
    summary.dailyLocked = true;
    summary.nextDelayMs = msUntilNextVnMidnight();
    summary.reason = `Buff PVP đủ ${dailyWins}/${winTarget} WIN hôm nay (${today}) · chờ 00:00 VN`;
    onLog?.(
      "INFO",
      `BuffPVP: đủ ${dailyWins}/${winTarget} WIN · next ${Math.ceil(summary.nextDelayMs / 3600000)}h`
    );
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  // Đã thua liên tiếp max lần (persist) → không đánh nữa đến 00:00 (tránh spam)
  if (loseStreak >= maxNoWinStreak) {
    summary.status = "NO_WIN";
    summary.dailyLocked = true;
    locked = true;
    summary.nextDelayMs = msUntilNextVnMidnight();
    summary.reason = `Buff PVP dừng: ${loseStreak} trận liên tiếp không WIN · chờ 00:00 VN`;
    onLog?.("WARN", `BuffPVP: ${loseStreak} trận không WIN → dừng`);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  const needWins = winTarget - dailyWins;

  try {
    onLog?.(
      "INFO",
      `BuffPVP: board=${boardCode} · cần ${needWins} WIN nữa (${dailyWins}/${winTarget}) · lose_streak ${loseStreak}/${maxNoWinStreak}`
    );

    // max_level rộng — preview win realm 31–36 board na
    const board = await rpc(
      "rpc_sect_rank_leaderboard",
      {
        p_character_id: options.characterId,
        p_min_level: Math.max(1, Number(settings.min_level || 1) || 1),
        p_max_level: Math.max(1, Number(settings.max_level || 99) || 99),
        p_limit: Math.max(10, Math.min(50, Number(settings.board_limit || 20) || 20)),
      },
      options.accessToken
    );

    const rows = boardRows(board);
    if (!rows.length) {
      summary.status = "NO_TARGET";
      summary.reason = "Bảng xếp hạng trống";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", "BuffPVP: không có ai trên bảng");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const hasRealSlots = rows.some((r) => realSlot(r) != null);
    const targets = pickTargets(rows, hunt, options.characterId, preferHunt, 10);
    if (!targets.length) {
      summary.status = "NO_TARGET";
      summary.reason = "Không chọn được slot";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", `BuffPVP: không có target · rows=${rows.length} · board=${boardCode}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    if (!hasRealSlots) {
      onLog?.(
        "WARN",
        `BuffPVP: leaderboard không có field slot → probe slot 2..10 board=${boardCode}`
      );
    } else {
      onLog?.(
        "INFO",
        `BuffPVP: ${targets.length} target · đầu slot ${targets[0].slot} ${targets[0].name || ""}`
      );
    }

    // Số trận tối đa / tick (không giới hạn bằng needWins vì lose không tính WIN)
    const toFight = Math.min(maxPerTick, targets.length);
    let invalidStreak = 0;
    for (let i = 0; i < toFight; i++) {
      if (options.shouldStop?.()) break;
      if (dailyWins >= winTarget) break;
      if (loseStreak >= maxNoWinStreak) break;

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

        // ok:false invalid_slot (một số server trả 200 + ok:false) — không tính lose streak
        if (res && res.ok === false) {
          const reason = String(res.reason || res.error || res.message || "ok_false");
          onLog?.("WARN", `BuffPVP skip slot ${t.slot}: ${reason}`);
          if (/invalid_slot/i.test(reason)) {
            invalidStreak += 1;
            if (invalidStreak >= 5) break;
            continue;
          }
          continue;
        }

        invalidStreak = 0;
        summary.fought += 1;
        const win = isChallengeWin(res);

        const defId = String(
          res?.defender?.character_id || res?.battle?.defender?.character_id || t.characterId || ""
        ).trim();
        const defName = String(res?.defender?.name || res?.battle?.defender?.name || t.name || "").trim();
        const slotAfter = Number(res?.target_slot ?? t.slot);
        const resBoard = String(res?.board_code || "").toLowerCase();
        if (["lk", "tc", "kd", "na", "ht", "lh"].includes(resBoard)) {
          boardCode = resBoard;
          summary.boardCode = boardCode;
        }

        if (win) {
          summary.wins += 1;
          dailyWins += 1;
          loseStreak = 0; // reset chuỗi không win
          hunt = rememberWin(hunt, defId, defName, slotAfter);
          onLog?.(
            "SUCCESS",
            `BuffPVP WIN slot ${t.slot} · ${defName || defId.slice(0, 8)} · WIN ${dailyWins}/${winTarget} · hunt ${hunt.length}`
          );
        } else {
          summary.losses += 1;
          loseStreak += 1;
          if (defId) hunt = rememberLoss(hunt, defId);
          onLog?.(
            "WARN",
            `BuffPVP LOSE slot ${t.slot} · ${defName || "?"} · WIN ${dailyWins}/${winTarget} · streak thua ${loseStreak}/${maxNoWinStreak}`
          );
          if (loseStreak >= maxNoWinStreak) {
            stopNoWin = true;
            locked = true;
            onLog?.(
              "WARN",
              `BuffPVP dừng: ${maxNoWinStreak} trận liên tiếp không WIN`
            );
            break;
          }
        }

        if (dailyWins >= winTarget) {
          locked = true;
          break;
        }
        if (i + 1 < toFight) await sleep(delayMs);
      } catch (e: any) {
        const msg = e?.message || String(e);
        const dataStr = JSON.stringify(e?.data || {});
        onLog?.("ERROR", `BuffPVP fail slot ${t.slot}: ${msg.slice(0, 100)}`);
        if (/invalid_slot/i.test(msg + dataStr)) {
          invalidStreak += 1;
          if (invalidStreak >= 5) break;
          continue;
        }
        // Không đếm fail vào lose streak; batch partial, thử lại sau
        summary.status = "PARTIAL";
        await sleep(delayMs);
      }
    }

    summary.dailyCompleted = dailyWins;
    summary.dailyTarget = winTarget;
    summary.loseStreak = loseStreak;
    summary.dailyLocked = locked || dailyWins >= winTarget || stopNoWin;
    summary.dailyDate = today;
    summary.huntList = hunt;
    summary.boardCode = boardCode;

    if (stopNoWin || loseStreak >= maxNoWinStreak) {
      summary.status = "NO_WIN";
      summary.dailyLocked = true;
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP dừng: ${loseStreak} trận liên tiếp không WIN · WIN ${dailyWins}/${winTarget} · chờ 00:00 VN`;
      onLog?.(
        "WARN",
        `BuffPVP NO_WIN stop · ${summary.wins}W/${summary.losses}L batch · tổng WIN ${dailyWins}/${winTarget}`
      );
    } else if (summary.dailyLocked || dailyWins >= winTarget) {
      summary.status = "LOCKED";
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP xong ${dailyWins}/${winTarget} WIN · ${summary.wins}W/${summary.losses}L batch · chờ 00:00 VN`;
      onLog?.(
        "SUCCESS",
        `BuffPVP DONE · đủ ${dailyWins}/${winTarget} WIN · hunt ${hunt.length}`
      );
    } else {
      summary.status = summary.fought > 0 ? "DONE" : summary.status === "PARTIAL" ? "PARTIAL" : "NO_TARGET";
      summary.nextDelayMs = Math.max(delayMs * 2, 10_000);
      summary.reason = `Batch ${summary.wins}W/${summary.losses}L · WIN ${dailyWins}/${winTarget} · streak ${loseStreak}`;
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 60_000;
    summary.dailyCompleted = dailyWins;
    summary.dailyTarget = winTarget;
    summary.loseStreak = loseStreak;
    summary.dailyLocked = locked;
    summary.dailyDate = today;
    summary.huntList = hunt;
    onLog?.("ERROR", `BuffPVP error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
