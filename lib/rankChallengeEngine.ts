/**
 * Buff PVP (Sect rank challenge)
 * - rpc_sect_rank_leaderboard / rpc_sect_rank_challenge
 *
 * Target logic:
 * - WIN → lưu vào hunt_list (tối đa 2–3 người), đánh loanh quanh những người này
 * - LOSE → skip_list (blacklist) trong ngày, không đánh lại người đó hôm nay
 * - Hôm sau: nếu 2–3 người hunt không còn trên bảng → xóa hunt, lấy danh sách mới
 * - Chỉ đếm WIN vào daily_target; N trận liên tiếp không WIN → dừng
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

export interface RankSkipEntry {
  id: string;
  name?: string;
  at?: string;
}

export interface RankFightTarget {
  slot: number;
  characterId: string;
  name?: string;
  fromHunt: boolean;
}

export interface RankChallengeRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "LOCKED" | "NO_TARGET" | "ERROR" | "PARTIAL" | "NO_WIN";
  fought: number;
  wins: number;
  losses: number;
  /** số WIN đã có trong ngày */
  dailyCompleted: number;
  /** số WIN user muốn đạt / ngày */
  dailyTarget: number;
  loseStreak: number;
  dailyLocked: boolean;
  dailyDate: string;
  huntList: RankHuntTarget[];
  /** id đã thua hôm nay — không đánh lại */
  skipList: RankSkipEntry[];
  /** index round-robin trong farm 2–3 người */
  huntRotate?: number;
  nextDelayMs: number;
  reason?: string;
  boardCode?: string;
}

export interface RankChallengeAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
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

function resolveBoardCode(settings: Record<string, any>, realmCode?: string): string {
  const raw = String(settings.board_code || settings.board || "auto").toLowerCase().trim();
  if (raw && raw !== "auto") {
    if (["lk", "tc", "kd", "na", "ht", "lh"].includes(raw)) return raw;
  }
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

function normalizeSkip(list: any): RankSkipEntry[] {
  if (!Array.isArray(list)) return [];
  const out: RankSkipEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = String(item?.id || item?.character_id || item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof item === "object" ? item?.name || item?.character_name : undefined,
      at: typeof item === "object" ? item?.at : undefined,
    });
  }
  return out;
}

function skipIds(skip: RankSkipEntry[]): Set<string> {
  return new Set(skip.map((s) => s.id).filter(Boolean));
}

/** WIN: thêm/cập nhật hunt, giữ tối đa maxHunt (2–3) người win được */
function rememberWin(
  hunt: RankHuntTarget[],
  defenderId: string,
  name?: string,
  slot?: number,
  maxHunt = 3
): RankHuntTarget[] {
  const id = String(defenderId || "").trim();
  if (!id) return hunt;
  const cap = Math.max(1, Math.min(5, maxHunt));
  const next = [...hunt];
  const i = next.findIndex((h) => h.id === id);
  if (i >= 0) {
    const [row] = next.splice(i, 1);
    next.unshift({
      ...row,
      name: name || row.name,
      wins: (row.wins || 0) + 1,
      lastWinAt: new Date().toISOString(),
      lastSlot: slot ?? row.lastSlot,
    });
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
  return next.slice(0, cap);
}

/** LOSE: gỡ khỏi hunt + thêm skip hôm nay */
function applyLoss(
  hunt: RankHuntTarget[],
  skip: RankSkipEntry[],
  defenderId: string,
  name?: string
): { hunt: RankHuntTarget[]; skip: RankSkipEntry[] } {
  const id = String(defenderId || "").trim();
  if (!id) return { hunt, skip };
  const nextHunt = hunt.filter((h) => h.id !== id);
  const nextSkip = [...skip];
  if (!nextSkip.some((s) => s.id === id)) {
    nextSkip.push({ id, name, at: new Date().toISOString() });
  }
  return { hunt: nextHunt, skip: nextSkip };
}

function boardRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.leaderboard)) return data.leaderboard;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

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

type BoardRow = any & { _slot: number; _id: string; name?: string };

function mapBoardRows(rows: any[]): BoardRow[] {
  return rows
    .map((r) => ({
      ...r,
      _slot: realSlot(r),
      _id: String(r?.character_id || r?.id || "").trim(),
    }))
    .filter((r) => r._slot != null) as BoardRow[];
}

/**
 * Lọc hunt còn trên bảng. Không còn ai → [] (lấy list mới).
 * Còn 1–N người → giữ những người còn trên bảng (cập nhật slot).
 */
function syncHuntWithBoard(hunt: RankHuntTarget[], withSlot: BoardRow[]): RankHuntTarget[] {
  if (!hunt.length) return [];
  const byId = new Map(withSlot.filter((r) => r._id).map((r) => [r._id, r]));
  const kept: RankHuntTarget[] = [];
  for (const h of hunt) {
    const row = byId.get(h.id);
    if (!row) continue;
    kept.push({
      ...h,
      name: row.name || h.name,
      lastSlot: row._slot,
    });
  }
  return kept;
}

/**
 * Chọn 1 target cho 1 trận:
 * 1) Có hunt còn trên bảng (không skip) → round-robin loanh quanh 2–3 người
 * 2) Không → discovery: NPC/yếu trước, bỏ skip + self
 * 3) Không có field slot → probe 2..10 (trừ slot đã skip)
 */
function pickOneTarget(opts: {
  withSlot: BoardRow[];
  allRows: any[];
  hunt: RankHuntTarget[];
  skip: Set<string>;
  skipSlots: Set<number>;
  selfId: string;
  huntRotate: number;
  maxProbeSlot?: number;
}): RankFightTarget | null {
  const self = String(opts.selfId || "");
  const maxProbe = opts.maxProbeSlot ?? 10;

  if (opts.withSlot.length > 0) {
    const byId = new Map(opts.withSlot.filter((r) => r._id).map((r) => [r._id, r]));

    // 1) Farm loanh quanh hunt
    const liveHunt = opts.hunt
      .map((h) => {
        const row = byId.get(h.id);
        if (!row || opts.skip.has(h.id) || h.id === self) return null;
        return {
          slot: row._slot,
          characterId: h.id,
          name: row.name || h.name,
          fromHunt: true,
        } as RankFightTarget;
      })
      .filter(Boolean) as RankFightTarget[];

    if (liveHunt.length > 0) {
      return liveHunt[opts.huntRotate % liveHunt.length];
    }

    // 2) Discovery — người mới trên bảng
    const others = opts.withSlot
      .filter((r) => r._id && r._id !== self && !opts.skip.has(r._id) && !opts.skipSlots.has(r._slot))
      .sort((a, b) => {
        const ea = isEasyNpcName(a.name) ? 0 : 1;
        const eb = isEasyNpcName(b.name) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return powerScore(a) - powerScore(b);
      });

    if (others.length > 0) {
      const r = others[0];
      return {
        slot: r._slot,
        characterId: r._id,
        name: r.name,
        fromHunt: false,
      };
    }
    return null;
  }

  // Probe khi API không trả slot
  for (let slot = 2; slot <= maxProbe; slot++) {
    if (opts.skipSlots.has(slot)) continue;
    const h = opts.hunt.find((x) => Number(x.lastSlot) === slot && !opts.skip.has(x.id));
    return {
      slot,
      characterId: h?.id || "",
      name: h?.name || `slot#${slot}`,
      fromHunt: Boolean(h),
    };
  }
  return null;
}

function resolveWinTarget(settings: Record<string, any>): number {
  const raw = Number(settings.daily_target ?? settings.win_target ?? settings.daily_limit ?? 20);
  return Math.max(1, Math.min(200, Math.floor(Number.isFinite(raw) ? raw : 20)));
}

function resolveMaxNoWinStreak(settings: Record<string, any>): number {
  const raw = Number(settings.max_no_win_streak ?? 10);
  return Math.max(3, Math.min(50, Math.floor(Number.isFinite(raw) ? raw : 10)));
}

function resolveMaxHunt(settings: Record<string, any>): number {
  const raw = Number(settings.max_hunt ?? 3);
  return Math.max(1, Math.min(5, Math.floor(Number.isFinite(raw) ? raw : 3)));
}

export async function runRankChallengeAuto(options: RankChallengeAutoOptions): Promise<RankChallengeRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const today = vnDateString();
  const winTarget = resolveWinTarget(settings);
  const maxNoWinStreak = resolveMaxNoWinStreak(settings);
  const maxHunt = resolveMaxHunt(settings);
  const delayMs = Math.max(800, Number(settings.delay_ms || 1500) || 1500);
  const maxPerTick = Math.max(1, Math.min(30, Math.floor(Number(settings.max_fights_per_tick || 10)) || 10));
  let boardCode = resolveBoardCode(settings, options.realmCode);

  let dailyWins = Math.max(0, Math.floor(Number(settings.daily_completed || settings.daily_wins || 0)) || 0);
  let loseStreak = Math.max(0, Math.floor(Number(settings.lose_streak || 0)) || 0);
  let locked = settings.daily_locked === true;
  let dailyDate = String(settings.daily_date || "");
  let hunt = normalizeHunt(settings.hunt_list);
  let skip = normalizeSkip(settings.skip_list);
  let stopNoWin = false;
  const sessionSkipSlots = new Set<number>();

  // Sang ngày mới: reset win/streak/skip; hunt giữ đến khi check bảng
  if (dailyDate !== today) {
    dailyWins = 0;
    loseStreak = 0;
    locked = false;
    skip = []; // blacklist chỉ trong ngày
    dailyDate = today;
  }

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
    skipList: skip,
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
      `BuffPVP: board=${boardCode} · cần ${needWins} WIN (${dailyWins}/${winTarget}) · hunt ${hunt.length} · skip ${skip.length} · streak ${loseStreak}/${maxNoWinStreak}`
    );

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

    const withSlot = mapBoardRows(rows);
    const prevHuntCount = hunt.length;

    // Hunt cũ: chỉ giữ người còn trên bảng. Không còn ai → list mới
    if (withSlot.length > 0 && hunt.length > 0) {
      const synced = syncHuntWithBoard(hunt, withSlot);
      if (synced.length === 0) {
        onLog?.(
          "INFO",
          `BuffPVP: ${prevHuntCount} người hunt cũ không còn trên bảng → lấy danh sách mới`
        );
        hunt = [];
      } else {
        if (synced.length < prevHuntCount) {
          onLog?.(
            "INFO",
            `BuffPVP: hunt còn ${synced.length}/${prevHuntCount} trên bảng · farm: ${synced.map((h) => h.name || h.id.slice(0, 6)).join(", ")}`
          );
        }
        hunt = synced;
      }
    }

    const hasRealSlots = withSlot.length > 0;
    if (!hasRealSlots) {
      onLog?.(
        "WARN",
        `BuffPVP: leaderboard không có field slot → probe slot 2..10 board=${boardCode}`
      );
    } else if (hunt.length > 0) {
      onLog?.(
        "INFO",
        `BuffPVP: farm loanh quanh ${hunt.length} người WIN · ${hunt.map((h) => h.name || h.id.slice(0, 6)).join(" | ")}`
      );
    } else {
      onLog?.("INFO", `BuffPVP: discovery — tìm người mới (skip ${skip.length})`);
    }

    let huntRotate = Math.max(0, Math.floor(Number(settings.hunt_rotate || 0)) || 0);
    let invalidStreak = 0;
    const blocked = skipIds(skip);

    for (let i = 0; i < maxPerTick; i++) {
      if (options.shouldStop?.()) break;
      if (dailyWins >= winTarget) break;
      if (loseStreak >= maxNoWinStreak) break;

      const t = pickOneTarget({
        withSlot,
        allRows: rows,
        hunt,
        skip: blocked,
        skipSlots: sessionSkipSlots,
        selfId: options.characterId,
        huntRotate,
        maxProbeSlot: 10,
      });

      if (!t) {
        onLog?.("WARN", "BuffPVP: hết target (đã skip hết / bảng rỗng logic)");
        break;
      }

      if (t.fromHunt) huntRotate += 1;

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

        if (res && res.ok === false) {
          const reason = String(res.reason || res.error || res.message || "ok_false");
          onLog?.("WARN", `BuffPVP skip slot ${t.slot}: ${reason}`);
          if (/invalid_slot/i.test(reason)) {
            sessionSkipSlots.add(t.slot);
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
          loseStreak = 0;
          // Không skip người vừa win; lưu hunt 2–3
          if (defId) blocked.delete(defId);
          hunt = rememberWin(hunt, defId, defName, slotAfter, maxHunt);
          onLog?.(
            "SUCCESS",
            `BuffPVP WIN · ${defName || defId.slice(0, 8)} · WIN ${dailyWins}/${winTarget} · farm [${hunt.map((h) => h.name || h.id.slice(0, 6)).join(", ")}]`
          );
        } else {
          summary.losses += 1;
          loseStreak += 1;
          // Thua → không đánh lại hôm nay + gỡ khỏi hunt
          if (defId) {
            const applied = applyLoss(hunt, skip, defId, defName);
            hunt = applied.hunt;
            skip = applied.skip;
            blocked.add(defId);
          } else {
            sessionSkipSlots.add(t.slot);
          }
          onLog?.(
            "WARN",
            `BuffPVP LOSE · ${defName || "?"} · không đánh lại hôm nay · WIN ${dailyWins}/${winTarget} · streak ${loseStreak}/${maxNoWinStreak}`
          );
          if (loseStreak >= maxNoWinStreak) {
            stopNoWin = true;
            locked = true;
            onLog?.("WARN", `BuffPVP dừng: ${maxNoWinStreak} trận liên tiếp không WIN`);
            break;
          }
        }

        if (dailyWins >= winTarget) {
          locked = true;
          break;
        }
        if (i + 1 < maxPerTick) await sleep(delayMs);
      } catch (e: any) {
        const msg = e?.message || String(e);
        const dataStr = JSON.stringify(e?.data || {});
        onLog?.("ERROR", `BuffPVP fail slot ${t.slot}: ${msg.slice(0, 100)}`);
        if (/invalid_slot/i.test(msg + dataStr)) {
          sessionSkipSlots.add(t.slot);
          invalidStreak += 1;
          if (invalidStreak >= 5) break;
          continue;
        }
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
    summary.skipList = skip;
    summary.huntRotate = huntRotate;
    summary.boardCode = boardCode;

    if (stopNoWin || loseStreak >= maxNoWinStreak) {
      summary.status = "NO_WIN";
      summary.dailyLocked = true;
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP dừng: ${loseStreak} trận liên tiếp không WIN · WIN ${dailyWins}/${winTarget}`;
      onLog?.(
        "WARN",
        `BuffPVP NO_WIN stop · batch ${summary.wins}W/${summary.losses}L · tổng WIN ${dailyWins}/${winTarget}`
      );
    } else if (summary.dailyLocked || dailyWins >= winTarget) {
      summary.status = "LOCKED";
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP xong ${dailyWins}/${winTarget} WIN · farm ${hunt.length} · chờ 00:00 VN`;
      onLog?.("SUCCESS", `BuffPVP DONE · đủ ${dailyWins}/${winTarget} WIN · hunt ${hunt.length}`);
    } else {
      summary.status = summary.fought > 0 ? "DONE" : summary.status === "PARTIAL" ? "PARTIAL" : "NO_TARGET";
      summary.nextDelayMs = Math.max(delayMs * 2, 10_000);
      summary.reason = `Batch ${summary.wins}W/${summary.losses}L · WIN ${dailyWins}/${winTarget} · hunt ${hunt.length} · skip ${skip.length}`;
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
    summary.skipList = skip;
    onLog?.("ERROR", `BuffPVP error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
