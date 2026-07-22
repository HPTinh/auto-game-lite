/**
 * Buff PVP (Sect rank challenge) — theo VỊ TRÍ / SLOT bảng
 *
 * Nhanh & đơn giản:
 * - Thử slot theo thứ tự: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9
 * - THUA slot X → không đánh lại slot X hôm nay, nhảy xuống slot kế (vd thua 1,2 → đánh 3,4…)
 * - THẮNG slot X → nhớ slot đó, farm loanh quanh 2–3 slot đã win
 * - Hôm sau: reset skip; nếu slot farm không còn win được thì discovery lại từ slot 1
 * - Chỉ đếm WIN vào target; N trận liên tiếp không WIN → dừng
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
  dailyCompleted: number;
  dailyTarget: number;
  loseStreak: number;
  dailyLocked: boolean;
  dailyDate: string;
  /** slot đã WIN — farm loanh quanh */
  huntList: RankHuntTarget[];
  /** slot đã THUA hôm nay — không đánh lại */
  skipSlots: number[];
  farmRotate?: number;
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

/** Thứ tự đánh: hạng 1,2 trước; thua thì xuống 3…9 */
const DEFAULT_SLOT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9];

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

function normalizeHunt(list: any): RankHuntTarget[] {
  if (!Array.isArray(list)) return [];
  const out: RankHuntTarget[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const slot = item?.lastSlot != null ? Number(item.lastSlot) : Number(item?.slot);
    const id = String(item?.id || item?.character_id || (Number.isFinite(slot) ? `slot:${slot}` : "")).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: item?.name || item?.character_name || (Number.isFinite(slot) ? `slot#${slot}` : undefined),
      wins: Number(item?.wins || 0) || 0,
      losses: Number(item?.losses || 0) || 0,
      lastWinAt: item?.lastWinAt,
      lastSlot: Number.isFinite(slot) && slot >= 1 ? Math.floor(slot) : undefined,
    });
  }
  return out;
}

/** skip_slots: number[] (và migrate skip_list cũ nếu có slot) */
function normalizeSkipSlots(settings: Record<string, any>): number[] {
  const out = new Set<number>();
  const raw = settings.skip_slots;
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const n = Number(x);
      if (Number.isFinite(n) && n >= 1) out.add(Math.floor(n));
    }
  }
  // migrate skip_list cũ (id dạng slot:N hoặc lastSlot)
  if (Array.isArray(settings.skip_list)) {
    for (const item of settings.skip_list) {
      if (typeof item === "number") {
        if (item >= 1) out.add(Math.floor(item));
        continue;
      }
      const id = String(item?.id || "").trim();
      const m = /^slot:(\d+)$/i.exec(id);
      if (m) out.add(Number(m[1]));
      const ls = Number(item?.lastSlot ?? item?.slot);
      if (Number.isFinite(ls) && ls >= 1) out.add(Math.floor(ls));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function resolveSlotOrder(settings: Record<string, any>): number[] {
  const min = Math.max(1, Math.floor(Number(settings.slot_min || 1)) || 1);
  const max = Math.max(min, Math.min(20, Math.floor(Number(settings.slot_max || 9)) || 9));
  const custom = settings.slot_order;
  if (Array.isArray(custom) && custom.length) {
    const arr = custom
      .map((x: any) => Math.floor(Number(x)))
      .filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 20);
    if (arr.length) return [...new Set(arr)];
  }
  const order: number[] = [];
  for (let s = min; s <= max; s++) order.push(s);
  return order.length ? order : [...DEFAULT_SLOT_ORDER];
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

/** WIN: nhớ slot (và id nếu có), giữ tối đa maxHunt slot farm */
function rememberWinSlot(
  hunt: RankHuntTarget[],
  slot: number,
  defenderId?: string,
  name?: string,
  maxHunt = 3
): RankHuntTarget[] {
  const s = Math.floor(Number(slot));
  if (!Number.isFinite(s) || s < 1) return hunt;
  const id = String(defenderId || "").trim() || `slot:${s}`;
  const cap = Math.max(1, Math.min(5, maxHunt));
  const next = hunt.filter((h) => h.lastSlot !== s && h.id !== id);
  next.unshift({
    id,
    name: name || `slot#${s}`,
    wins: (hunt.find((h) => h.lastSlot === s || h.id === id)?.wins || 0) + 1,
    losses: 0,
    lastWinAt: new Date().toISOString(),
    lastSlot: s,
  });
  return next.slice(0, cap);
}

/** Bỏ slot khỏi farm khi thua */
function dropHuntSlot(hunt: RankHuntTarget[], slot: number): RankHuntTarget[] {
  const s = Math.floor(Number(slot));
  return hunt.filter((h) => h.lastSlot !== s);
}

/**
 * Chọn slot tiếp theo:
 * 1) Có farm slots (đã win) → round-robin trong các slot đó (không nằm skip)
 * 2) Không → lấy slot nhỏ nhất trong order chưa skip (1,2 rồi 3…9)
 */
function pickNextSlot(opts: {
  farmSlots: number[];
  skipSlots: Set<number>;
  slotOrder: number[];
  farmRotate: number;
}): { slot: number; fromFarm: boolean; rotate: number } | null {
  const liveFarm = opts.farmSlots.filter((s) => !opts.skipSlots.has(s));
  if (liveFarm.length > 0) {
    const idx = opts.farmRotate % liveFarm.length;
    return { slot: liveFarm[idx], fromFarm: true, rotate: opts.farmRotate + 1 };
  }
  for (const s of opts.slotOrder) {
    if (!opts.skipSlots.has(s)) {
      return { slot: s, fromFarm: false, rotate: opts.farmRotate };
    }
  }
  return null;
}

export async function runRankChallengeAuto(options: RankChallengeAutoOptions): Promise<RankChallengeRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const today = vnDateString();
  const winTarget = resolveWinTarget(settings);
  const maxNoWinStreak = resolveMaxNoWinStreak(settings);
  const maxHunt = resolveMaxHunt(settings);
  const slotOrder = resolveSlotOrder(settings);
  const delayMs = Math.max(800, Number(settings.delay_ms || 1500) || 1500);
  const maxPerTick = Math.max(1, Math.min(30, Math.floor(Number(settings.max_fights_per_tick || 10)) || 10));
  let boardCode = resolveBoardCode(settings, options.realmCode);

  let dailyWins = Math.max(0, Math.floor(Number(settings.daily_completed || settings.daily_wins || 0)) || 0);
  let loseStreak = Math.max(0, Math.floor(Number(settings.lose_streak || 0)) || 0);
  let locked = settings.daily_locked === true;
  let dailyDate = String(settings.daily_date || "");
  let hunt = normalizeHunt(settings.hunt_list);
  let skipSlots = normalizeSkipSlots(settings);
  let farmRotate = Math.max(0, Math.floor(Number(settings.farm_rotate ?? settings.hunt_rotate ?? 0)) || 0);
  let stopNoWin = false;

  // Sang ngày mới: reset skip + win count; farm slot giữ (thử lại hôm sau)
  if (dailyDate !== today) {
    dailyWins = 0;
    loseStreak = 0;
    locked = false;
    skipSlots = [];
    dailyDate = today;
  }

  if (locked || dailyWins >= winTarget) locked = true;

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
    skipSlots: [...skipSlots],
    farmRotate,
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

  const skipSet = new Set(skipSlots);
  const needWins = winTarget - dailyWins;

  try {
    // Leaderboard optional — chủ yếu challenge theo slot số
    try {
      await rpc(
        "rpc_sect_rank_leaderboard",
        {
          p_character_id: options.characterId,
          p_min_level: Math.max(1, Number(settings.min_level || 1) || 1),
          p_max_level: Math.max(1, Number(settings.max_level || 99) || 99),
          p_limit: Math.max(10, Math.min(50, Number(settings.board_limit || 20) || 20)),
        },
        options.accessToken
      );
    } catch {
      // không chặn — vẫn challenge theo slot
    }

    const farmSlots = hunt
      .map((h) => Number(h.lastSlot))
      .filter((s) => Number.isFinite(s) && s >= 1 && !skipSet.has(s)) as number[];

    onLog?.(
      "INFO",
      `BuffPVP: board=${boardCode} · cần ${needWins} WIN (${dailyWins}/${winTarget}) · farm slots [${farmSlots.join(",") || "—"}] · skip thua [${[...skipSet].sort((a, b) => a - b).join(",") || "—"}] · ladder ${slotOrder[0]}→${slotOrder[slotOrder.length - 1]}`
    );

    for (let i = 0; i < maxPerTick; i++) {
      if (options.shouldStop?.()) break;
      if (dailyWins >= winTarget) break;
      if (loseStreak >= maxNoWinStreak) break;

      const liveFarm = hunt
        .map((h) => Number(h.lastSlot))
        .filter((s) => Number.isFinite(s) && s >= 1 && !skipSet.has(s)) as number[];

      const picked = pickNextSlot({
        farmSlots: liveFarm,
        skipSlots: skipSet,
        slotOrder,
        farmRotate,
      });

      if (!picked) {
        onLog?.("WARN", `BuffPVP: hết slot (đã skip 1→9 hoặc invalid) · skip=[${[...skipSet].sort((a, b) => a - b).join(",")}]`);
        break;
      }

      const slot = picked.slot;
      if (picked.fromFarm) farmRotate = picked.rotate;

      try {
        const res = await rpc(
          "rpc_sect_rank_challenge",
          {
            p_character_id: options.characterId,
            p_board_code: boardCode,
            p_target_slot: slot,
          },
          options.accessToken
        );

        // ok:false
        if (res && res.ok === false) {
          const reason = String(res.reason || res.error || res.message || "ok_false");
          onLog?.("WARN", `BuffPVP slot ${slot} FAIL: ${reason} → bỏ slot, xuống slot sau`);
          // invalid_slot / bất kỳ lỗi slot → coi như không đánh được, nhảy slot
          skipSet.add(slot);
          hunt = dropHuntSlot(hunt, slot);
          continue;
        }

        summary.fought += 1;
        const win = isChallengeWin(res);
        const defId = String(
          res?.defender?.character_id || res?.battle?.defender?.character_id || ""
        ).trim();
        const defName = String(res?.defender?.name || res?.battle?.defender?.name || `slot#${slot}`).trim();
        const slotAfter = Number(res?.target_slot ?? slot);
        const useSlot = Number.isFinite(slotAfter) && slotAfter >= 1 ? Math.floor(slotAfter) : slot;

        const resBoard = String(res?.board_code || "").toLowerCase();
        if (["lk", "tc", "kd", "na", "ht", "lh"].includes(resBoard)) {
          boardCode = resBoard;
          summary.boardCode = boardCode;
        }

        if (win) {
          summary.wins += 1;
          dailyWins += 1;
          loseStreak = 0;
          // Không skip slot win; nhớ farm
          skipSet.delete(useSlot);
          hunt = rememberWinSlot(hunt, useSlot, defId, defName, maxHunt);
          onLog?.(
            "SUCCESS",
            `BuffPVP WIN slot ${useSlot} · ${defName} · WIN ${dailyWins}/${winTarget} · farm [${hunt.map((h) => h.lastSlot).filter(Boolean).join(",")}]`
          );
        } else {
          summary.losses += 1;
          loseStreak += 1;
          // THUA → bỏ slot này hôm nay, đánh xuống slot sau (3,4,5…)
          skipSet.add(useSlot);
          hunt = dropHuntSlot(hunt, useSlot);
          onLog?.(
            "WARN",
            `BuffPVP LOSE slot ${useSlot} · ${defName} · không đánh lại slot này hôm nay → xuống slot sau · WIN ${dailyWins}/${winTarget} · streak ${loseStreak}/${maxNoWinStreak}`
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
        onLog?.("ERROR", `BuffPVP fail slot ${slot}: ${msg.slice(0, 100)}`);
        // Lỗi slot / invalid → bỏ slot, thử slot dưới — KHÔNG đánh lại cùng slot
        if (/invalid_slot|slot|not.?found|target/i.test(msg + dataStr)) {
          skipSet.add(slot);
          hunt = dropHuntSlot(hunt, slot);
          continue;
        }
        summary.status = "PARTIAL";
        await sleep(delayMs);
      }
    }

    skipSlots = [...skipSet].sort((a, b) => a - b);
    summary.dailyCompleted = dailyWins;
    summary.dailyTarget = winTarget;
    summary.loseStreak = loseStreak;
    summary.dailyLocked = locked || dailyWins >= winTarget || stopNoWin;
    summary.dailyDate = today;
    summary.huntList = hunt;
    summary.skipSlots = skipSlots;
    summary.farmRotate = farmRotate;
    summary.boardCode = boardCode;

    if (stopNoWin || loseStreak >= maxNoWinStreak) {
      summary.status = "NO_WIN";
      summary.dailyLocked = true;
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP dừng: ${loseStreak} trận liên tiếp không WIN · WIN ${dailyWins}/${winTarget}`;
      onLog?.("WARN", `BuffPVP NO_WIN · batch ${summary.wins}W/${summary.losses}L · WIN ${dailyWins}/${winTarget}`);
    } else if (summary.dailyLocked || dailyWins >= winTarget) {
      summary.status = "LOCKED";
      summary.nextDelayMs = msUntilNextVnMidnight();
      summary.reason = `Buff PVP xong ${dailyWins}/${winTarget} WIN · chờ 00:00 VN`;
      onLog?.("SUCCESS", `BuffPVP DONE · đủ ${dailyWins}/${winTarget} WIN · farm slots [${hunt.map((h) => h.lastSlot).join(",")}]`);
    } else {
      summary.status = summary.fought > 0 ? "DONE" : summary.status === "PARTIAL" ? "PARTIAL" : "NO_TARGET";
      summary.nextDelayMs = Math.max(delayMs * 2, 10_000);
      summary.reason = `Batch ${summary.wins}W/${summary.losses}L · WIN ${dailyWins}/${winTarget} · skip slots [${skipSlots.join(",")}]`;
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
    summary.skipSlots = [...skipSet].sort((a, b) => a - b);
    summary.farmRotate = farmRotate;
    onLog?.("ERROR", `BuffPVP error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
