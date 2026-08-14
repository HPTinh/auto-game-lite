/**
 * Hoàng Cổ — 1 feature, nhiều mục tiêu (setting):
 * - Cắm cờ + Xây cờ → expand (is_built=false)
 * - Thủ cờ → siege_flag side=defend
 * - Thủ mỏ → defend_position central (stack_order chỉ là hàng, không quan trọng)
 * - Phá cờ → siege_flag side=attack
 * - Công central → attack_position kind=central (hết lock / địch giữ)
 * - leave_defense khi rời pin
 *
 * Central: còn lock_until → Thủ; hết lock → Công.
 * runHoangCoAuto: Mở rộng → Thủ cờ → Thủ central → Phá cờ → Công central.
 */

export type HoangCoLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface HoangCoRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "WAITING" | "SKIPPED" | "ERROR" | "NO_EVENT";
  action?: string;
  reason?: string;
  nextDelayMs: number;
  placed?: number;
  built?: number;
  moved?: boolean;
  flagId?: number;
  /** cờ đang focus xây tới 600 */
  focusFlagId?: number | null;
  /** id cờ do acc này cắm (persist) */
  selfPlacedFlagIds?: number[];
  siegePoints?: number;
  siegeMax?: number;
  dest?: { x: number; y: number };
  etaSeconds?: number;
  myRegion?: string;
  clanFlags?: number;
  buildingFlags?: number;
  threatenedCount?: number;
  side?: string;
  /** expand | defend | defend_mine | attack | attack_central | break_flag */
  phase?: string;
  /** node_id mỏ đang thủ */
  mineId?: string | number;
  /** settings merge (reclaim pos sau phá cờ, …) */
  persistHint?: Record<string, any>;
}

export interface HoangCoAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: HoangCoLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
  /** Shared map_state từ scanner tập trung (bể chung). Nếu có, dùng làm global data;
   *  vị trí bản thân (my_position) sẽ được ensureSelf() lấy riêng khi cần hành động. */
  mapOverride?: any;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function rpc(name: string, payload: Record<string, any> | null, accessToken: string) {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "auto-lite/1.0",
    },
    body: JSON.stringify(payload === null ? null : payload ?? {}),
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
  if (data && typeof data === "object" && !Array.isArray(data) && data.ok === false) {
    const reason = data.error || data.reason || data.message || data.code || "ok_false";
    const err: any = new Error(`[${name}] ${reason}`);
    err.data = data;
    throw err;
  }
  return data;
}

/** Rời stack thủ/xây — gọi trước khi move sang việc khác (khi đang pin) */
async function leaveDefense(
  characterId: string,
  accessToken: string,
  onLog?: HoangCoAutoOptions["onLog"]
) {
  try {
    await rpc("rpc_hoang_co_leave_defense", { p_character_id: characterId }, accessToken);
    onLog?.("INFO", "HoàngCổ leave_defense");
    return true;
  } catch (e: any) {
    onLog?.("DEBUG", `leave_defense: ${(e?.message || "").slice(0, 80)}`);
    return false;
  }
}

function n(v: any, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function manhattan(ax: number, ay: number, bx: number, by: number) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Bán kính ô vuông (3×3 = chebyshev ≤ 1) */
function chebyshev(ax: number, ay: number, bx: number, by: number) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Quy tắc cắm cờ MỚI (game rule 2026-08):
 * - CẤM đặt đè lên TÂM cờ địch (cheby 0 với center cờ địch).
 * - CHO PHÉP đặt vành cheby≤1 (3×3 ring) sát cờ địch → tạo "near" tức thì.
 * - CẤM ô đã occupied / ngoài grid.
 * Trả { ok, reason }.
 */
function canPlaceAt(opts: {
  x: number;
  y: number;
  flags: Flag[];
  myClanId: string;
  gridW: number;
  gridH: number;
  occ: Set<string>;
}): { ok: boolean; reason?: string } {
  const { x, y, flags, occ, gridW, gridH, myClanId } = opts;
  if (x < 0 || y < 0 || x >= gridW || y >= gridH) return { ok: false, reason: "out_of_grid" };
  if (occ.has(cellKey(x, y))) return { ok: false, reason: "occupied" };
  // Cấm đè tâm cờ địch (cheby 0 với center). Vành cheby≥1 được phép.
  for (const f of flags) {
    if (!isEnemyFlag(f, myClanId)) continue;
    // Cấm đặt tâm cờ mình trong vùng 3×3 của địch (cách tâm địch ≤1 → vùng toả mình phủ tâm địch)
    if (chebyshev(f.pos_x, f.pos_y, x, y) <= 1) return { ok: false, reason: "too_close_enemy_center" };
  }
  return { ok: true };
}

function cellKey(x: number, y: number) {
  return `${x},${y}`;
}

type Flag = {
  flag_id: number;
  pos_x: number;
  pos_y: number;
  clan_id?: string;
  /** Tên bang hội — map_state.flags[].clan_name */
  clan_name?: string;
  is_built?: boolean;
  /** tiến độ xây — API: siege_points (0 → siege_max, thường 600) */
  siege_points: number;
  siege_max: number;
  build_progress?: number;
  hp_current?: number;
  hp_max?: number;
  region_code?: string;
  decay_active?: boolean;
};

type Pos = { x: number; y: number };

type MapPlayer = {
  character_id?: string;
  clan_id?: string;
  clan_name?: string;
  name?: string;
  x: number;
  y: number;
};

/** Lấy mảng flags từ map_state — API trả root.flags (full map, không fog) */
function rawFlagsArray(map: any): any[] {
  if (Array.isArray(map?.flags)) return map.flags;
  if (Array.isArray(map?.data?.flags)) return map.data.flags;
  if (Array.isArray(map?.map?.flags)) return map.map.flags;
  // đôi khi flags là object id→flag
  const obj = map?.flags;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.values(obj);
  }
  return [];
}

function parseFlags(map: any): Flag[] {
  const raw = rawFlagsArray(map);
  return raw
    .map((f: any) => {
      if (!f || typeof f !== "object") return null;
      const siegeMax = Math.max(1, n(f.siege_max, 600) || 600);
      // siege_points: lúc xây = tiến độ; sau is_built=true = độ bền (bị phá thì tụt, địch có thể đã đi)
      const siegePts = n(f.siege_points, 0);
      const buildProg = n(f.build_progress, siegePts);
      const flagId = Math.floor(n(firstDefined(f.flag_id, f.id), 0));
      const posX = Math.floor(n(firstDefined(f.pos_x, f.x, f.posX), 0));
      const posY = Math.floor(n(firstDefined(f.pos_y, f.y, f.posY), 0));
      return {
        flag_id: flagId,
        pos_x: posX,
        pos_y: posY,
        clan_id: f.clan_id ? String(f.clan_id) : undefined,
        clan_name: f.clan_name ? String(f.clan_name) : undefined,
        is_built: f.is_built === true || f.is_built === 1 || f.is_built === "true",
        siege_points: siegePts,
        siege_max: siegeMax,
        build_progress: buildProg,
        hp_current: n(f.hp_current, 0),
        hp_max: n(f.hp_max, 10000),
        region_code: f.region_code ? String(f.region_code) : undefined,
        decay_active: f.decay_active === true,
      } as Flag;
    })
    .filter((f: Flag | null): f is Flag => !!f && f.flag_id > 0);
}

function parseMapPlayers(map: any): MapPlayer[] {
  const raw = Array.isArray(map?.players) ? map.players : [];
  return raw
    .map((p: any) => {
      const x = Math.floor(n(firstDefined(p?.pos_x, p?.x, p?.posX), -999));
      const y = Math.floor(n(firstDefined(p?.pos_y, p?.y, p?.posY), -999));
      if (x < -100 || y < -100) return null;
      return {
        character_id: p?.character_id ? String(p.character_id) : p?.id ? String(p.id) : undefined,
        clan_id: p?.clan_id ? String(p.clan_id) : undefined,
        clan_name: p?.clan_name ? String(p.clan_name) : undefined,
        name: p?.name || p?.character_name || p?.display_name,
        x,
        y,
      } as MapPlayer;
    })
    .filter(Boolean) as MapPlayer[];
}

function firstDefined(...values: any[]) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function normText(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Cờ địch: khác clan_id mình (hoặc có clan_name mà không phải mình) */
function isEnemyFlag(f: Flag, myClanId: string): boolean {
  if (!myClanId) return !!(f.clan_id || f.clan_name);
  if (f.clan_id) return f.clan_id !== myClanId;
  // thiếu clan_id nhưng có tên → vẫn coi địch (tránh drop “cờ ẩn”)
  return !!(f.clan_name && f.clan_name.trim());
}

/** Lọc cờ địch theo tên bang (partial, không dấu) hoặc clan_id */
function filterEnemyFlags(flags: Flag[], myClanId: string, targetClan?: string): Flag[] {
  const enemies = flags.filter((f) => isEnemyFlag(f, myClanId));
  const t = String(targetClan || "").trim();
  if (!t) return enemies;
  const tNorm = normText(t);
  const tRaw = t.toLowerCase();
  return enemies.filter((f) => {
    const id = String(f.clan_id || "").toLowerCase();
    const name = normText(f.clan_name || "");
    const nameRaw = String(f.clan_name || "").toLowerCase();
    return (
      id === tRaw ||
      id === tNorm ||
      name === tNorm ||
      nameRaw === tRaw ||
      name.includes(tNorm) ||
      nameRaw.includes(tRaw) ||
      // UI đôi khi lưu "The Fear (12)" — strip (N)
      normText(t.replace(/\s*\(\d+\)\s*$/, "")) === name
    );
  });
}

/** Log quét full map — mọi cờ map_state (không fog) */
function logFlagScan(
  onLog: HoangCoAutoOptions["onLog"],
  flags: Flag[],
  myClanId: string,
  enemyFlags: Flag[],
  targetClan: string
) {
  const own = flags.filter((f) => f.clan_id && f.clan_id === myClanId);
  const allEnemy = flags.filter((f) => isEnemyFlag(f, myClanId));
  const byClan = new Map<string, number>();
  for (const f of allEnemy) {
    const k = (f.clan_name || f.clan_id || "?").trim() || "?";
    byClan.set(k, (byClan.get(k) || 0) + 1);
  }
  const clanSummary = [...byClan.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([name, c]) => `${name}×${c}`)
    .join(" · ");
  const ownBuiltN = own.filter((f) => f.is_built === true).length;
  const ownBuildingN = own.length - ownBuiltN;
  onLog?.(
    "INFO",
    `HC Phá cờ · SCAN map_state: total=${flags.length} own=${own.length} (built ${ownBuiltN} / dở ${ownBuildingN}) enemy=${allEnemy.length}` +
      (targetClan ? ` · target="${targetClan}"→${enemyFlags.length}` : ` · target=*→${enemyFlags.length}`) +
      (clanSummary ? ` · bang: ${clanSummary}${byClan.size > 14 ? "…" : ""}` : "")
  );
  // Liệt kê cờ đang nhắm (tối đa 20) — user check tay map_state
  if (enemyFlags.length > 0) {
    const sample = [...enemyFlags]
      .sort((a, b) => {
        const ba = a.is_built === true ? 0 : 1;
        const bb = b.is_built === true ? 0 : 1;
        if (ba !== bb) return ba - bb;
        return a.flag_id - b.flag_id;
      })
      .slice(0, 20)
      .map(
        (f) =>
          `#${f.flag_id}@(${f.pos_x},${f.pos_y})${f.is_built ? "" : "d"}[${(f.clan_name || "?").slice(0, 16)}]`
      )
      .join(" ");
    onLog?.(
      "INFO",
      `HC Phá cờ · list ${Math.min(20, enemyFlags.length)}/${enemyFlags.length}: ${sample}${
        enemyFlags.length > 20 ? " …" : ""
      }`
    );
  }
}

/** Người địch trong bán kính chebyshev (3×3 = radius 1) quanh (x,y) */
function hostilesNear(
  map: any,
  myClanId: string,
  x: number,
  y: number,
  radius = 1,
  myCharacterId?: string
): MapPlayer[] {
  return parseMapPlayers(map).filter((p) => {
    if (myCharacterId && p.character_id === myCharacterId) return false;
    if (p.clan_id && p.clan_id === myClanId) return false;
    // không clan_id: vẫn coi là địch nếu khác vị trí
    return chebyshev(p.x, p.y, x, y) <= radius;
  });
}

/** Chạy về cờ mình khác — ưu tiên cờ built xa địch / ít hostiles */
function pickFleeOwnFlag(
  ownBuilt: Flag[],
  me: Pos,
  map: any,
  myClanId: string,
  avoidFlagId?: number
): Flag | null {
  const list = ownBuilt.filter((f) => f.flag_id !== avoidFlagId);
  if (!list.length) return null;
  const scored = list.map((f) => {
    const hostiles = hostilesNear(map, myClanId, f.pos_x, f.pos_y, 1).length;
    const distMe = manhattan(f.pos_x, f.pos_y, me.x, me.y);
    // an toàn trước, xa hiện tại một chút (tránh đứng yên)
    const score = hostiles * 100 + (distMe === 0 ? 50 : 0) - Math.min(distMe, 5);
    return { f, score, hostiles, distMe };
  });
  scored.sort((a, b) => a.score - b.score || b.distMe - a.distMe);
  return scored[0]?.f || null;
}

/** Ô an toàn: không có player địch trong safeR */
function isPosSafeFromHostiles(
  map: any,
  myClanId: string,
  x: number,
  y: number,
  safeR: number,
  myCharacterId?: string
): boolean {
  return hostilesNear(map, myClanId, x, y, safeR, myCharacterId).length === 0;
}

/** Khoảng cách cheby tới player địch gần nhất (99 nếu không có) */
function minHostileCheby(
  map: any,
  myClanId: string,
  x: number,
  y: number,
  myCharacterId?: string
): number {
  const all = parseMapPlayers(map).filter((p) => {
    if (myCharacterId && p.character_id === myCharacterId) return false;
    if (p.clan_id && p.clan_id === myClanId) return false;
    return true;
  });
  if (!all.length) return 99;
  let m = 99;
  for (const p of all) {
    const d = chebyshev(p.x, p.y, x, y);
    if (d < m) m = d;
  }
  return m;
}

type SafeDest = {
  x: number;
  y: number;
  label: string;
  kind: "flee_own" | "build" | "assault" | "kite";
};

/**
 * Né linh hoạt: chạy bất kỳ đâu miễn xa địch + đích trống.
 * Ưu: cờ mình an toàn → cờ dở an toàn (xây) → cờ địch near an toàn (phá) → ô kite.
 */
function pickSmartSafeDest(opts: {
  map: any;
  me: Pos;
  myClanId: string;
  myCharacterId?: string;
  ownBuilt: Flag[];
  building: Flag[];
  nearEnemies: Flag[];
  safeR?: number;
  preferWork?: boolean;
}): SafeDest | null {
  const {
    map,
    me,
    myClanId,
    myCharacterId,
    ownBuilt,
    building,
    nearEnemies,
    safeR = 2,
    preferWork = true,
  } = opts;
  const cands: Array<SafeDest & { score: number }> = [];

  const push = (x: number, y: number, label: string, kind: SafeDest["kind"], bonus = 0) => {
    if (x === me.x && y === me.y) return;
    if (!isPosSafeFromHostiles(map, myClanId, x, y, safeR, myCharacterId)) return;
    const minH = minHostileCheby(map, myClanId, x, y, myCharacterId);
    const distMe = manhattan(x, y, me.x, me.y);
    // an toàn (xa địch) quan trọng nhất; dist vừa phải; bonus công việc
    const score = minH * -20 + distMe * 0.5 + bonus + (minH < safeR + 1 ? 200 : 0);
    cands.push({ x, y, label, kind, score });
  };

  for (const f of ownBuilt) {
    push(f.pos_x, f.pos_y, `cờ mình #${f.flag_id}`, "flee_own", preferWork ? -5 : 0);
  }
  for (const f of building) {
    push(f.pos_x, f.pos_y, `xây #${f.flag_id}`, "build", preferWork ? -40 : 0);
  }
  for (const f of nearEnemies) {
    push(f.pos_x, f.pos_y, `phá #${f.flag_id}`, "assault", preferWork ? -60 : 0);
  }
  // Ô kite: lùi xa cụm địch quanh me (4 hướng + chéo)
  const hostiles = parseMapPlayers(map).filter((p) => {
    if (myCharacterId && p.character_id === myCharacterId) return false;
    if (p.clan_id && p.clan_id === myClanId) return false;
    return chebyshev(p.x, p.y, me.x, me.y) <= 4;
  });
  if (hostiles.length) {
    let cx = 0,
      cy = 0;
    for (const h of hostiles) {
      cx += h.x;
      cy += h.y;
    }
    cx = Math.round(cx / hostiles.length);
    cy = Math.round(cy / hostiles.length);
    // vector từ địch → me, bước 2–4 ô
    const dx = me.x - cx;
    const dy = me.y - cy;
    const steps = [2, 3, 4];
    for (const s of steps) {
      const len = Math.max(1, Math.abs(dx) + Math.abs(dy));
      const ox = Math.round((dx / len) * s) || (dx >= 0 ? s : -s);
      const oy = Math.round((dy / len) * s);
      push(me.x + ox, me.y + oy, `kite@(${me.x + ox},${me.y + oy})`, "kite", 10);
      push(me.x + ox, me.y, `kite@(${me.x + ox},${me.y})`, "kite", 12);
      push(me.x, me.y + (oy || (dy >= 0 ? s : -s)), `kite@(${me.x},${me.y + (oy || 1)})`, "kite", 12);
    }
  }

  if (!cands.length) {
    // fallback: cờ mình dù có 1 hostile xa
    const fb = pickFleeOwnFlag(ownBuilt, me, map, myClanId);
    if (fb) return { x: fb.pos_x, y: fb.pos_y, label: `cờ mình #${fb.flag_id}`, kind: "flee_own" };
    return null;
  }
  cands.sort((a, b) => a.score - b.score);
  return cands[0];
}

/** siege_points hiện tại */
function flagProgress(f: Flag): number {
  return Math.max(0, n(f.siege_points, 0));
}

/**
 * Đã XÂY XONG (cắm xong giai trình build): is_built === true
 * (kể cả đang bị phá — siege_points < 600 vẫn is_built true)
 */
function isFlagBuildComplete(f: Flag): boolean {
  return f.is_built === true;
}

/**
 * Cờ cần XÂY / tiếp quản: đã cắm, chưa build xong
 * → is_built === false (siege_points đang 0→600)
 */
function incompleteClanFlags(flags: Flag[], clanId: string): Flag[] {
  return flags
    .filter((f) => f.clan_id === clanId && f.is_built !== true)
    .sort((a, b) => flagProgress(b) - flagProgress(a));
}

/**
 * Cờ đã xây xong nhưng BỊ PHÁ (địch có thể đã đi):
 * is_built === true && siege_points < siege_max
 * (build_progress thường vẫn 600)
 */
function damagedClanFlags(flags: Flag[], clanId: string): Flag[] {
  return flags
    .filter((f) => {
      if (f.clan_id !== clanId) return false;
      if (f.is_built !== true) return false;
      const max = Math.max(1, n(f.siege_max, 600) || 600);
      return flagProgress(f) < max;
    })
    .sort((a, b) => flagProgress(a) - flagProgress(b)); // hư nặng trước
}

function isFlagDamaged(f: Flag): boolean {
  if (f.is_built !== true) return false;
  const max = Math.max(1, n(f.siege_max, 600) || 600);
  return flagProgress(f) < max;
}

/**
 * Nguy tại chỗ (địch đang đứng) — dùng khi đang XÂY (is_built false)
 * Không dùng một mình để biết "bị phá": địch có thể đã rời sau khi siege.
 */
function isFlagSiteDangerous(
  map: any,
  flag: Flag,
  myClanId: string,
  threatRadius: number
): { danger: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const besiegers = Array.isArray(map?.besiegers) ? map.besiegers : [];
  const onFlag = besiegers.filter((b: any) => Math.floor(n(b.flag_id)) === flag.flag_id);
  if (onFlag.length > 0) {
    reasons.push(`${onFlag.length} người đang siege cờ`);
  }

  const players = Array.isArray(map?.players) ? map.players : [];
  let enemyNear = 0;
  for (const p of players) {
    const pid = String(p?.clan_id || "");
    if (pid && pid === myClanId) continue;
    if (p?.is_ally === true) continue;
    const px = Math.floor(n(p?.pos_x, -999));
    const py = Math.floor(n(p?.pos_y, -999));
    if (px < -100) continue;
    if (manhattan(px, py, flag.pos_x, flag.pos_y) <= threatRadius) enemyNear += 1;
  }
  if (enemyNear > 0) reasons.push(`${enemyNear} địch trong ${threatRadius} ô`);

  if (flag.decay_active) reasons.push("decay_active");
  const hpMax = Math.max(1, n(flag.hp_max, 10000));
  if (n(flag.hp_current, hpMax) < hpMax * 0.85) reasons.push(`HP cờ ${flag.hp_current}/${hpMax}`);

  return { danger: reasons.length > 0, reasons };
}

function myPos(map: any): {
  x: number;
  y: number;
  inTransit: boolean;
  eta: number;
  dead: boolean;
  /** đích đang đi (map_state / sau move) */
  destX?: number;
  destY?: number;
} | null {
  const p = map?.my_position;
  if (!p || p.has_pos === false) return null;
  const hasDest =
    p.dest_x !== undefined &&
    p.dest_x !== null &&
    p.dest_y !== undefined &&
    p.dest_y !== null &&
    Number.isFinite(Number(p.dest_x)) &&
    Number.isFinite(Number(p.dest_y));
  return {
    x: Math.floor(n(p.pos_x)),
    y: Math.floor(n(p.pos_y)),
    inTransit: p.in_transit === true,
    eta: Math.max(0, Math.floor(n(p.eta_seconds, 0))),
    dead: p.is_dead === true,
    destX: hasDest ? Math.floor(n(p.dest_x)) : undefined,
    destY: hasDest ? Math.floor(n(p.dest_y)) : undefined,
  };
}

function homeForRegion(map: any, region: string): Pos | null {
  const homes = Array.isArray(map?.home_cities) ? map.home_cities : [];
  const h = homes.find((c: any) => String(c.vuc || c.region_code || "") === region);
  if (!h) return null;
  return { x: Math.floor(n(h.pos_x)), y: Math.floor(n(h.pos_y)) };
}

function occupiedCells(map: any): Set<string> {
  const set = new Set<string>();
  for (const f of parseFlags(map)) set.add(cellKey(f.pos_x, f.pos_y));
  for (const r of Array.isArray(map?.resources) ? map.resources : []) {
    set.add(cellKey(Math.floor(n(r.pos_x)), Math.floor(n(r.pos_y))));
  }
  for (const s of Array.isArray(map?.satellites) ? map.satellites : []) {
    set.add(cellKey(Math.floor(n(s.pos_x)), Math.floor(n(s.pos_y))));
  }
  // tránh trung tâm (center)
  const cx = Math.floor(n(map?.config?.center_x, 42));
  const cy = Math.floor(n(map?.config?.center_y, 42));
  const inner = Math.max(2, Math.floor(n(map?.config?.inner_radius, 6)));
  for (let x = cx - inner; x <= cx + inner; x++) {
    for (let y = cy - inner; y <= cy + inner; y++) {
      if (manhattan(x, y, cx, cy) <= inner) set.add(cellKey(x, y));
    }
  }
  return set;
}

/**
 * Chọn ô cắm cờ:
 * - Ưu tiên vùng myRegion
 * - Gần home / gần cụm cờ clan (cách 1–maxGap ô, không đè)
 * - Trong grid
 */
function pickPlaceCell(opts: {
  map: any;
  clanId: string;
  myRegion: string;
  me: Pos;
  maxGap: number;
  preferOwnRegion: boolean;
}): Pos | null {
  const { map, clanId, myRegion, me, maxGap, preferOwnRegion } = opts;
  const gridW = Math.max(20, Math.floor(n(map?.config?.grid_w, 85)));
  const gridH = Math.max(20, Math.floor(n(map?.config?.grid_h, 85)));
  const occ = occupiedCells(map);
  const flags = parseFlags(map);
  const mine = flags.filter((f) => f.clan_id === clanId);
  const home = homeForRegion(map, myRegion) || me;

  // Ưu tiên cắm quanh vị trí hiện tại (mở rộng chỗ đang đứng), rồi cụm cờ / home
  const anchors: Pos[] = [{ x: me.x, y: me.y }];
  for (const f of mine) anchors.push({ x: f.pos_x, y: f.pos_y });
  anchors.push({ x: home.x, y: home.y });

  type Cand = { x: number; y: number; score: number };
  const cands: Cand[] = [];

  for (const a of anchors) {
    for (let dx = -maxGap; dx <= maxGap; dx++) {
      for (let dy = -maxGap; dy <= maxGap; dy++) {
        if (dx === 0 && dy === 0) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < 1 || dist > maxGap) continue;
        const x = a.x + dx;
        const y = a.y + dy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        if (occ.has(cellKey(x, y))) continue;

        // Heuristic region: dong right, tay left, bac top, nam bottom
        let regionOk = true;
        if (preferOwnRegion && myRegion) {
          if (myRegion === "dong_vuc" && x < gridW * 0.45) regionOk = false;
          if (myRegion === "tay_vuc" && x > gridW * 0.55) regionOk = false;
          if (myRegion === "bac_vuc" && y > gridH * 0.55) regionOk = false;
          if (myRegion === "nam_hoang" && y < gridH * 0.45) regionOk = false;
        }
        if (!regionOk) continue;

        // Ưu: gần anchor, gần me, gần home
        const score =
          dist * 3 +
          manhattan(x, y, me.x, me.y) * 1.2 +
          manhattan(x, y, home.x, home.y) * 0.5;
        cands.push({ x, y, score });
      }
    }
  }

  // Mở rộng: vòng quanh home nếu chưa có cand
  if (!cands.length) {
    for (let r = 1; r <= Math.max(8, maxGap + 4); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) + Math.abs(dy) !== r) continue;
          const x = home.x + dx;
          const y = home.y + dy;
          if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
          if (occ.has(cellKey(x, y))) continue;
          cands.push({
            x,
            y,
            score: r * 2 + manhattan(x, y, me.x, me.y),
          });
        }
      }
      if (cands.length) break;
    }
  }

  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  return { x: cands[0].x, y: cands[0].y };
}

/**
 * Cắm cờ hướng phá: hop tối ưu về cờ địch (chebyshev hop ≤ 2).
 * Ưu: ô chạm địch (≤2) · tiến nhiều nhất · gần bridge built.
 * Ưu tiên đặc biệt: ô = vị trí cờ địch vừa phá (reclaimPos) nếu trống.
 */
function pickSiegePlaceCell(opts: {
  map: any;
  clanId: string;
  me: Pos;
  enemy: Flag;
  maxHop?: number;
  /** Ô ưu tiên cắm (vd vị trí cờ địch vừa phá) */
  reclaimPos?: Pos | null;
  /** Ô đã not_adjacent / fail — bỏ qua */
  excludeCells?: Set<string>;
}): Pos | null {
  const { map, clanId, me, enemy, maxHop = 3, reclaimPos, excludeCells } = opts;
  const gridW = Math.max(20, Math.floor(n(map?.config?.grid_w, 85)));
  const gridH = Math.max(20, Math.floor(n(map?.config?.grid_h, 85)));
  const occ = occupiedCells(map);
  const flags = parseFlags(map);
  const ownBuilt = flags.filter((f) => f.clan_id === clanId && f.is_built === true);
  const ownAll = flags.filter((f) => f.clan_id === clanId);
  const excluded = excludeCells || new Set<string>();

  // Khoảng cách gần nhất từ 1 ô tới cờ ĐÃ XÂY của mình (mốc neo cắm, luật: cheby≤3)
  const friendlyDist = (x: number, y: number): number => {
    if (!ownBuilt.length) return 99;
    return Math.min(...ownBuilt.map((f) => chebyshev(f.pos_x, f.pos_y, x, y)));
  };

  // Reclaim: cắm ngay ô cờ địch vừa mất nếu trống & kề cờ built mình (cheby≤3)
  if (reclaimPos) {
    const rx = Math.floor(reclaimPos.x);
    const ry = Math.floor(reclaimPos.y);
    if (rx >= 0 && ry >= 0 && rx < gridW && ry < gridH && !occ.has(cellKey(rx, ry))) {
      if (ownBuilt.length > 0 && ownBuilt.some((f) => chebyshev(f.pos_x, f.pos_y, rx, ry) <= 3)) {
        return { x: rx, y: ry };
      }
    }
  }

  // Anchor từ cờ built (chỉ cờ built làm mốc neo). Nếu không có built → không cắm
  // (phải xây trước). Mốc dở/me chỉ fallback, nhưng friendlyDist≤3 sẽ loại bỏ ô
  // không kề cờ built.
  const anchors: Pos[] = [];
  if (ownBuilt.length) {
    for (const f of ownBuilt) anchors.push({ x: f.pos_x, y: f.pos_y });
  } else if (ownAll.length) {
    for (const f of ownAll) anchors.push({ x: f.pos_x, y: f.pos_y });
  } else {
    anchors.push({ x: me.x, y: me.y });
  }

  anchors.sort(
    (a, b) =>
      chebyshev(a.x, a.y, enemy.pos_x, enemy.pos_y) - chebyshev(b.x, b.y, enemy.pos_x, enemy.pos_y)
  );

  // Mặt trận = cờ built mình gần địch nhất; minBuiltToEnemy = khoảng cách mặt trận tới địch
  let frontier: Pos | null = null;
  let minBuiltToEnemy = 99;
  if (ownBuilt.length) {
    const fb = [...ownBuilt].sort(
      (a, b) =>
        chebyshev(a.pos_x, a.pos_y, enemy.pos_x, enemy.pos_y) -
        chebyshev(b.pos_x, b.pos_y, enemy.pos_x, enemy.pos_y)
    )[0];
    frontier = { x: fb.pos_x, y: fb.pos_y };
    minBuiltToEnemy = chebyshev(frontier.x, frontier.y, enemy.pos_x, enemy.pos_y);
  }

  type Cand = { x: number; y: number; score: number };
  const cands: Cand[] = [];
  const seen = new Set<string>();

  for (const a of anchors) {
    for (let dx = -maxHop; dx <= maxHop; dx++) {
      for (let dy = -maxHop; dy <= maxHop; dy++) {
        const hop = Math.max(Math.abs(dx), Math.abs(dy));
        if (hop < 1 || hop > maxHop) continue;
        const x = a.x + dx;
        const y = a.y + dy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        const k = cellKey(x, y);
        if (seen.has(k) || occ.has(k) || excluded.has(k)) continue;
        seen.add(k);

        const toEnemy = chebyshev(x, y, enemy.pos_x, enemy.pos_y);
        // Quy tắc 3×3: cấm đặt tâm cờ mình cách tâm địch ≤1 (vùng toả sẽ phủ tâm địch)
        if (toEnemy <= 1) continue;
        // canPlaceAt: cấm occupied / đè tâm địch (cheby≤1) / ngoài grid
        if (!canPlaceAt({ x, y, flags, myClanId: clanId, gridW, gridH, occ }).ok) continue;
        // CHỈ nhận ô TIẾN GẦN địch hơn mặt trận hiện tại (toEnemy < minBuiltToEnemy).
        // Cấm đặt ngang hàng / lùi → tránh cắm cờ sát nhau chồng chất vô nghĩa.
        if (toEnemy >= minBuiltToEnemy) continue;
        // Ô cắm phải gần cờ đồng minh ĐÃ XÂY (cheby≤3, bằng tầm phá) — luật mốc neo
        const fd = friendlyDist(x, y);
        if (fd > 3) continue;
        // Không cắm đúng ô me đang đứng quanh địch nếu me không phải trên cờ mình (tránh vòng)
        if (x === me.x && y === me.y && hop > 0) continue;

        // Tối ưu khoảng cách: ưu tiên ô GẦN ĐỊCH NHẤT (toEnemy nhỏ nhất, weight áp đảo),
        // rồi kề sát cờ built (fd nhỏ), cuối là ít di chuyển. Luôn kéo gần cờ địch.
        let score = toEnemy * 1000 + fd * 30 + manhattan(x, y, me.x, me.y) * 0.1;
        if (fd <= 1) score -= 40;
        if (x === enemy.pos_x && y === enemy.pos_y) score -= 500;
        cands.push({ x, y, score });
      }
    }
    if (cands.some((c) => chebyshev(c.x, c.y, enemy.pos_x, enemy.pos_y) <= 1)) break;
  }

  // Fallback: ô xung quanh cờ địch — vẫn phải TIẾN GẦN mặt trận & kề cờ built (cheby≤3)
  if (!cands.length) {
    for (let r = 1; r <= 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = enemy.pos_x + dx;
          const y = enemy.pos_y + dy;
          if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
          if (occ.has(cellKey(x, y))) continue;
          // Fallback vẫn phải TIẾN GẦN địch hơn mặt trận (tránh cắm lùi/vô nghĩa)
          if (r >= minBuiltToEnemy) continue;
          if (!canPlaceAt({ x, y, flags, myClanId: clanId, gridW, gridH, occ }).ok) continue;
          const fd = friendlyDist(x, y);
          if (fd > 3) continue;
          cands.push({
            x,
            y,
            score: r * 1000 + fd * 25 + manhattan(x, y, me.x, me.y) * 0.1 - (r <= 2 ? 40 : 0),
          });
        }
      }
      if (cands.length) break;
    }
  }

  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  return { x: cands[0].x, y: cands[0].y };
}

/**
 * Chọn ô cắm để bridge tiến tới central (tâm cx,cy).
 * Quy tắc (2026-08, user xác nhận): cờ chiếm central phải CHẠM central (cheby≤1,
 * vùng 3×3 phủ tâm central). Ô cắm phải:
 *   (1) cách tâm central ≥1 (không đặt trên tâm),
 *   (2) TIẾN GẦN central hơn mặt trận (toC < minBuiltToCentral),
 *   (3) kề cờ đồng minh ĐÃ XÂY (friendlyDist≤3, bằng tầm phá), ưu tiên kề (cheby≤1).
 */
/**
 * Chọn ô cắm tiến dần tới mục tiêu (tx,ty).
 * Dùng chung cho: central (allowOnTarget=false) và resource (allowOnTarget=true).
 * Ràng buộc: canPlaceAt.ok + kề cờ built cheby≤3 + tiến gần mục tiêu (toT < minBuiltToTarget).
 */
function pickPlaceCellTowardTarget(opts: {
  map: any;
  clanId: string;
  me: Pos;
  tx: number;
  ty: number;
  maxHop?: number;
  /** true: cho phép đặt TRÊN ô mục tiêu (resource). false: cấm (central) */
  allowOnTarget?: boolean;
}): Pos | null {
  const { map, clanId, me, tx, ty, maxHop = 3, allowOnTarget = false } = opts;
  const gridW = Math.max(20, Math.floor(n(map?.config?.grid_w, 85)));
  const gridH = Math.max(20, Math.floor(n(map?.config?.grid_h, 85)));
  const occ = occupiedCells(map);
  const flags = parseFlags(map);
  const ownBuilt = flags.filter((f) => f.clan_id === clanId && f.is_built === true);
  const friendlyDist = (x: number, y: number): number => {
    // Chưa có cờ built → neo từ vị trí bot (bootstrap cờ đầu tiên từ chỗ đứng)
    if (!ownBuilt.length) return chebyshev(me.x, me.y, x, y);
    return Math.min(...ownBuilt.map((f) => chebyshev(f.pos_x, f.pos_y, x, y)));
  };
  // Mốc neo: ƯU TIÊN cờ built GẦN MỤC TIÊU NHẤT (frontier) để bridge thành 1 hàng thẳng
  // hướng tới mục tiêu (tránh cắm lung tung từ cờ lề). Fallback: mọi cờ built nếu frontier bị chặn.
  const sortedBuilt = [...ownBuilt].sort(
    (a, b) => chebyshev(a.pos_x, a.pos_y, tx, ty) - chebyshev(b.pos_x, b.pos_y, tx, ty)
  );
  const frontierBuilt = sortedBuilt[0] || null;
  const anchorSets: Pos[][] = [];
  if (frontierBuilt) {
    anchorSets.push([{ x: frontierBuilt.pos_x, y: frontierBuilt.pos_y }, { x: me.x, y: me.y }]);
    anchorSets.push([...sortedBuilt.map((f) => ({ x: f.pos_x, y: f.pos_y })), { x: me.x, y: me.y }]);
  } else {
    anchorSets.push([{ x: me.x, y: me.y }]);
  }

  type Cand = { x: number; y: number; score: number };

  const genCands = (anchors: Pos[]): Cand[] => {
    const out: Cand[] = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      for (let dx = -maxHop; dx <= maxHop; dx++) {
        for (let dy = -maxHop; dy <= maxHop; dy++) {
          const hop = Math.max(Math.abs(dx), Math.abs(dy));
          if (hop < 1 || hop > maxHop) continue;
          const x = a.x + dx;
          const y = a.y + dy;
          if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
          const k = cellKey(x, y);
          if (seen.has(k) || occ.has(k)) continue;
          seen.add(k);
          const toT = chebyshev(x, y, tx, ty);
          if (!allowOnTarget && toT < 1) continue; // không đặt trên tâm (central)
          if (!canPlaceAt({ x, y, flags, myClanId: clanId, gridW, gridH, occ }).ok) continue;
          // Bỏ qua ô có player địch đè lên (tránh cắm vào chỗ bị chiếm); vẫn cho phép địch cự ly 1 (vùng tranh chấp)
          if (!isPosSafeFromHostiles(map, clanId, x, y, 0)) continue;
          // Tiến gần mục tiêu theo TỪNG anchor (không bị kẹt bởi mốc toàn cục)
          if (toT >= chebyshev(a.x, a.y, tx, ty)) continue; // tiến gần mục tiêu
          const fd = friendlyDist(x, y);
          if (fd > 3) continue; // mốc neo: kề cờ built (cheby≤3)
          // Tối ưu khoảng cách: ưu tiên ô GẦN MỤC TIÊU NHẤT (toT nhỏ nhất, weight áp đảo),
          // rồi kề sát cờ built (fd nhỏ), cuối là ít di chuyển. Luôn tiến gần mục tiêu.
          let score = toT * 1000 + fd * 30 + manhattan(x, y, me.x, me.y) * 0.1;
          if (fd <= 1) score -= 40;
          if (x === tx && y === ty) score -= allowOnTarget ? 500 : 800;
          out.push({ x, y, score });
        }
      }
    }
    return out;
  };

  let cands: Cand[] = [];
  for (const set of anchorSets) {
    cands = genCands(set);
    if (cands.length) break;
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  return { x: cands[0].x, y: cands[0].y };
}

function pickCentralPlaceCell(opts: {
  map: any;
  clanId: string;
  me: Pos;
  cx: number;
  cy: number;
  maxHop?: number;
}): Pos | null {
  return pickPlaceCellTowardTarget({
    map: opts.map,
    clanId: opts.clanId,
    me: opts.me,
    tx: opts.cx,
    ty: opts.cy,
    maxHop: opts.maxHop,
    allowOnTarget: false,
  });
}

/**
 * Cờ clan built chạm 3×3 cờ địch.
 * 3×3 = ô giữa cờ + 8 ô quanh → chebyshev ≤ 1 (KHÔNG dùng ≤2 — dễ “đứng vành” không vào giữa).
 */
function canReachEnemyFlag(ownBuilt: Flag[], enemy: Flag): boolean {
  // Luật 3×3: cờ đồng minh (ĐÃ XÂY) có vùng toả chạm vùng cờ địch khi 2 tâm cách ≤3
  // → đủ điều kiện phá (không cần vùng toả đè lên tâm địch).
  return ownBuilt.some((f) => chebyshev(f.pos_x, f.pos_y, enemy.pos_x, enemy.pos_y) <= 3);
}

/** Số cờ địch đã chạm được từ cờ built mình */
function countReachableEnemies(ownBuilt: Flag[], enemies: Flag[]): number {
  if (!ownBuilt.length) return 0;
  return enemies.filter((e) => canReachEnemyFlag(ownBuilt, e)).length;
}

/**
 * Người đang THỦ cờ (map_state.defenders: target_kind=flag, target_id=flag_id).
 * myClanId: chỉ đếm người clan khác (né thủ địch / PVP).
 */
function flagDefenders(
  map: any,
  flagId: number,
  myClanId?: string
): Array<{ name: string; clan_id?: string; clan_name?: string; character_id?: string }> {
  const raw = Array.isArray(map?.defenders) ? map.defenders : [];
  const idStr = String(flagId);
  const out: Array<{ name: string; clan_id?: string; clan_name?: string; character_id?: string }> = [];
  for (const d of raw) {
    const kind = String(d?.target_kind || "").toLowerCase();
    if (kind && kind !== "flag") continue;
    const tid = String(d?.target_id ?? d?.flag_id ?? "");
    if (tid !== idStr && Math.floor(n(d?.flag_id, 0)) !== flagId) continue;
    const cid = d?.clan_id ? String(d.clan_id) : undefined;
    if (myClanId && cid && cid === myClanId) continue; // mình/đồng minh thủ — không tính “thủ địch”
    out.push({
      name: String(d?.name || d?.character_name || "?"),
      clan_id: cid,
      clan_name: d?.clan_name ? String(d.clan_name) : undefined,
      character_id: d?.character_id ? String(d.character_id) : undefined,
    });
  }
  return out;
}

/** Người đang CÔNG/phá cờ (map_state.besiegers[].flag_id) — clan khác */
function flagBesiegers(
  map: any,
  flagId: number,
  myClanId?: string
): Array<{ name: string; clan_id?: string; clan_name?: string }> {
  const raw = Array.isArray(map?.besiegers) ? map.besiegers : [];
  return raw
    .filter((b: any) => Math.floor(n(b?.flag_id, 0)) === flagId)
    .filter((b: any) => {
      const cid = b?.clan_id ? String(b.clan_id) : "";
      if (myClanId && cid && cid === myClanId) return false;
      return true;
    })
    .map((b: any) => ({
      name: String(b?.name || "?"),
      clan_id: b?.clan_id ? String(b.clan_id) : undefined,
      clan_name: b?.clan_name ? String(b.clan_name) : undefined,
    }));
}

/** Cờ có người thủ clan khác → né, không phá (tránh dính combat) */
function isFlagDefendedByOtherClan(map: any, flagId: number, myClanId: string): boolean {
  return flagDefenders(map, flagId, myClanId).length > 0;
}

/**
 * Kế hoạch bridge cờ mình → cờ địch (not_near).
 * - Cần cờ built mình cheby ≤ 1 với địch mới siege được
 * - Mỗi lần cắm hop tối đa maxHop ô (mặc định 3) từ cờ built / dở gần nhất
 * - hopsLeft ≈ ceil((bridgeCheby - 1) / maxHop)
 */
function planBridgeToEnemy(
  ownBuilt: Flag[],
  building: Flag[],
  enemy: Flag,
  maxHop = 3
): {
  anchor: Flag | null;
  bridgeCheby: number;
  needNear: boolean;
  hopsLeft: number;
  maxHop: number;
  buildingTowardEnemy: Flag[];
} {
  const allOwn = [...ownBuilt, ...building];
  let anchor: Flag | null = null;
  let bridgeCheby = 99;
  for (const f of ownBuilt) {
    const d = chebyshev(f.pos_x, f.pos_y, enemy.pos_x, enemy.pos_y);
    if (d < bridgeCheby) {
      bridgeCheby = d;
      anchor = f;
    }
  }
  // Nếu chưa có built, neo từ cờ dở gần địch nhất
  if (!anchor && building.length) {
    for (const f of building) {
      const d = chebyshev(f.pos_x, f.pos_y, enemy.pos_x, enemy.pos_y);
      if (d < bridgeCheby) {
        bridgeCheby = d;
        anchor = f;
      }
    }
  }
  const needNear = bridgeCheby > 1;
  const hopsLeft = needNear
    ? Math.max(1, Math.ceil((bridgeCheby - 1) / Math.max(1, maxHop)))
    : 0;
  const buildingTowardEnemy = [...building].sort(
    (a, b) =>
      chebyshev(a.pos_x, a.pos_y, enemy.pos_x, enemy.pos_y) -
      chebyshev(b.pos_x, b.pos_y, enemy.pos_x, enemy.pos_y)
  );
  void allOwn;
  return { anchor, bridgeCheby: bridgeCheby === 99 ? 99 : bridgeCheby, needNear, hopsLeft, maxHop, buildingTowardEnemy };
}

export interface CentralPlan {
  central: { x: number; y: number; holder_clan_id?: string; lock_until?: string };
  /** Cờ địch trong box central_radius×central_radius quanh central */
  enemyAround: Flag[];
  /** Có cờ mình (built) cheby≤1 với central chưa */
  ownReachCentral: boolean;
  /** Cần xây bridge từ cờ mình tới central */
  needBridgeToCentral: boolean;
  /** Chuỗi ô cắm tiến dần tới central (cheby≤1 nhau) */
  steps: Array<{ x: number; y: number }>;
}

/**
 * Lập kế hoạch chiếm central:
 * 1) Tìm cờ địch trong box central_radius×central_radius quanh central.
 * 2) Kiểm tra cờ mình đã chạm central (cheby≤1) chưa.
 * 3) Nếu chưa → plan bridge: chuỗi ô cheby≤1 tiến dần từ cờ mình gần central nhất tới sát central.
 * Điều kiện tiên quyết để phá/siege/attack: own flag phải cheby≤1 với target (near).
 */
export function planCentralCapture(opts: {
  map: any;
  clanId: string;
  centralRadius?: number;
}): CentralPlan {
  const { map, clanId } = opts;
  const centralRadius = Math.max(4, Math.floor(n(opts.centralRadius, 12)) || 12);
  const cx = Math.floor(n(map?.config?.center_x, 42));
  const cy = Math.floor(n(map?.config?.center_y, 42));
  const central = map?.central || {};
  const flags = parseFlags(map);
  const enemyFlags = flags.filter((f) => isEnemyFlag(f, clanId));
  // Box central_radius×central_radius → |dx|≤half, |dy|≤half (half = centralRadius/2)
  const half = Math.floor(centralRadius / 2);
  const enemyAround = enemyFlags.filter(
    (f) => Math.abs(f.pos_x - cx) <= half && Math.abs(f.pos_y - cy) <= half
  );
  const ownBuilt = flags.filter((f) => f.clan_id === clanId && f.is_built === true);
  const ownReachCentral = ownBuilt.some((f) => chebyshev(f.pos_x, f.pos_y, cx, cy) <= 1);

  let steps: Array<{ x: number; y: number }> = [];
  const needBridgeToCentral = !ownReachCentral;
  if (needBridgeToCentral) {
    const anchor = [...ownBuilt].sort(
      (a, b) => chebyshev(a.pos_x, a.pos_y, cx, cy) - chebyshev(b.pos_x, b.pos_y, cx, cy)
    )[0];
    if (anchor) {
      let x2 = anchor.pos_x;
      let y2 = anchor.pos_y;
      while (chebyshev(x2, y2, cx, cy) > 1) {
        const nx = x2 + Math.sign(cx - x2);
        const ny = y2 + Math.sign(cy - y2);
        steps.push({ x: nx, y: ny });
        x2 = nx;
        y2 = ny;
      }
    }
  }
  return {
    central: { x: cx, y: cy, holder_clan_id: central.holder_clan_id, lock_until: central.lock_until },
    enemyAround,
    ownReachCentral,
    needBridgeToCentral,
    steps,
  };
}

/**
 * Scan tập trung: lấy map_state + đếm cờ từng clan (dùng cho bể chung).
 * Scanner gọi 1 lần, publish vào store; các acc khác đọc từ store.
 */
export async function scanHoangCoState(options: {
  characterId: string;
  accessToken: string;
}): Promise<{
  map: any;
  myClanId: string;
  clanCounts: Array<{ clan_id: string; clan_name: string; flag_count: number }>;
}> {
  const status = await rpc("rpc_hoang_co_status", { p_character_id: options.characterId }, options.accessToken);
  const myClanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");
  const map = await rpc("rpc_hoang_co_map_state", { p_character_id: options.characterId }, options.accessToken);
  const flags = parseFlags(map);
  const by = new Map<string, { clan_id: string; clan_name: string; flag_count: number }>();
  for (const f of flags) {
    const key = f.clan_id || (f.clan_name || "?");
    const name = (f.clan_name || f.clan_id || "?").trim() || "?";
    const cur = by.get(key);
    if (cur) cur.flag_count += 1;
    else by.set(key, { clan_id: f.clan_id || key, clan_name: name, flag_count: 1 });
  }
  const clanCounts = [...by.values()].sort(
    (a, b) => b.flag_count - a.flag_count || a.clan_name.localeCompare(b.clan_name, "vi")
  );
  return { map, myClanId, clanCounts };
}

function placeErrorText(e: any): string {
  return (
    String(e?.message || e || "") +
    " " +
    String(e?.data?.message || e?.data?.error || e?.data?.hint || "")
  ).toLowerCase();
}

function isPlaceFullError(e: any): boolean {
  const s = placeErrorText(e);
  return (
    s.includes("max_flag") ||
    s.includes("flag_limit") ||
    s.includes("too_many") ||
    s.includes("full") ||
    s.includes("used_flags") ||
    s.includes("không thể cắm") ||
    s.includes("max flags") ||
    s.includes("quota")
  );
}

/** Cắm không kề cờ mình (server P0001 not_adjacent) */
function isNotAdjacentError(e: any): boolean {
  return placeErrorText(e).includes("not_adjacent");
}

/**
 * Cắm quá gần cờ địch / vị trí không hợp lệ vì sát địch
 * → dừng cắm, chuyển sang PHÁ (vòng tròn tử thần hay dính lỗi này)
 */
/**
 * Quy tắc MỚI: được cắm VÀNH cheby≤1 sát cờ địch.
 * Chỉ coi là lỗi cấm khi đặt ĐÈ lên tâm cờ địch (occupied/trùng ô) —
 * không còn coi "near_enemy/adjacent" là lỗi (vành được phép).
 */
function isPlaceTooCloseToEnemyError(e: any): boolean {
  const s = placeErrorText(e);
  return (
    s.includes("on_flag") ||
    s.includes("flag_center") ||
    s.includes("occupied") ||
    s.includes("trùng") ||
    s.includes("overlap") ||
    s.includes("collision")
  );
}

function sortBreakTargets(
  pool: Flag[],
  me: { x: number; y: number },
  ownBuilt: Flag[],
  focusAttackId: number,
  cfgSiegeMax: number
): Flag[] {
  // Khoảng cách gần nhất từ cờ built mình tới 1 cờ địch (mặt trận)
  const minBuiltDist = (f: Flag): number => {
    if (!ownBuilt.length) return 99;
    return Math.min(...ownBuilt.map((o) => chebyshev(o.pos_x, o.pos_y, f.pos_x, f.pos_y)));
  };
  return [...pool].sort((a, b) => {
    // 1) Ưu tiên cờ ĐÃ THỰC SỰ sát (cờ built mình cheby≤1) → xông ngay
    const pa = ownBuilt.some((o) => chebyshev(o.pos_x, o.pos_y, a.pos_x, a.pos_y) <= 1) ? 0 : 1;
    const pb = ownBuilt.some((o) => chebyshev(o.pos_x, o.pos_y, b.pos_x, b.pos_y) <= 1) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // 2) Ưu tiên cờ GẦN MẶT TRẬN mình nhất (đảm bảo bridge đi đúng hướng, không lạc)
    const da = minBuiltDist(a);
    const db = minBuiltDist(b);
    if (da !== db) return da - db;
    // 3) Gần nhân vật (tốc độ) làm tie-break
    const ma = manhattan(a.pos_x, a.pos_y, me.x, me.y);
    const mb = manhattan(b.pos_x, b.pos_y, me.x, me.y);
    if (ma !== mb) return ma - mb;
    const ba = a.is_built === true ? 0 : 1;
    const bb = b.is_built === true ? 0 : 1;
    if (ba !== bb) return ba - bb;
    const sa = flagProgress(a);
    const sb = flagProgress(b);
    const aDamaged = a.is_built === true && sa < (a.siege_max || cfgSiegeMax);
    const bDamaged = b.is_built === true && sb < (b.siege_max || cfgSiegeMax);
    if (aDamaged !== bDamaged) return aDamaged ? -1 : 1;
    if (aDamaged && bDamaged && sa !== sb) return sa - sb;
    if (focusAttackId > 0) {
      const fa = a.flag_id === focusAttackId ? 0 : 1;
      const fb = b.flag_id === focusAttackId ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    return 0;
  });
}

/** Resource đang bị clan khác thủ (map.defenders target_kind=resource) */
function resourceDefendedByOtherClan(map: any, nodeId: string | number, myClanId: string): boolean {
  const idStr = String(nodeId);
  const raw = Array.isArray(map?.defenders) ? map.defenders : [];
  for (const d of raw) {
    const kind = String(d?.target_kind || "").toLowerCase();
    if (kind !== "resource") continue;
    if (String(d?.target_id ?? d?.node_id ?? "") !== idStr) continue;
    const cid = d?.clan_id ? String(d.clan_id) : "";
    if (cid && cid !== myClanId) return true;
    if (!cid) return true; // có người thủ, không rõ clan → né
  }
  return false;
}

/** Resource gần để chip (attack_position) — còn HP, không mình giữ, không có thủ clan khác */
function pickNearResourceToChip(
  map: any,
  me: Pos,
  myClanId: string,
  maxDist = 3
): { node_id: string | number; pos_x: number; pos_y: number; label: string; hp: number; maxHp: number } | null {
  const mines = parseMines(map);
  const now = Date.now();
  const cands = mines
    .map((m) => {
      const raw = (Array.isArray(map?.resources) ? map.resources : []).find(
        (r: any) => String(r?.node_id ?? r?.id) === String(m.node_id)
      );
      const prot = raw?.protection_until ? Date.parse(String(raw.protection_until)) : 0;
      const protectedNow = Number.isFinite(prot) && prot > now;
      const hp = m.struct_hp_current;
      const maxHp = m.struct_hp_max || 1;
      const dist = manhattan(m.pos_x, m.pos_y, me.x, me.y);
      const mine = myClanId && m.holder_clan_id === myClanId;
      const defOther = resourceDefendedByOtherClan(map, m.node_id, myClanId);
      return { m, hp, maxHp, dist, protectedNow, mine, defOther };
    })
    .filter((x) => x.dist <= maxDist && x.hp > 0 && !x.protectedNow && !x.mine && !x.defOther)
    .sort((a, b) => a.dist - b.dist || a.hp - b.hp);
  if (!cands.length) return null;
  const c = cands[0];
  return {
    node_id: c.m.node_id,
    pos_x: c.m.pos_x,
    pos_y: c.m.pos_y,
    label: c.m.label || String(c.m.node_id),
    hp: c.hp,
    maxHp: c.maxHp,
  };
}

/**
 * Chip resource gần — chỉ gọi khi rảnh việc cờ (không chen trước phá/cắm/xây).
 * Trả summary đã fill nếu đã action; null nếu không có resource.
 */
async function tryChipNearResource(
  opts: {
    map: any;
    me: Pos;
    clanId: string;
    characterId: string;
    accessToken: string;
    settings: Record<string, any>;
    onLog?: HoangCoAutoOptions["onLog"];
    summary: HoangCoRunSummary;
  }
): Promise<HoangCoRunSummary | null> {
  const { map, me, clanId, characterId, accessToken, settings, onLog, summary } = opts;
  if (settings.attack_near_resource === false) return null;
  const resNear = pickNearResourceToChip(
    map,
    me,
    clanId,
    Math.max(2, Math.min(5, n(settings.resource_attack_radius, 3) || 3))
  );
  if (!resNear) return null;
  const onRes = me.x === resNear.pos_x && me.y === resNear.pos_y;
  if (!onRes) {
    await leaveDefense(characterId, accessToken, onLog);
    const mv = await rpc(
      "rpc_hoang_co_move",
      { p_character_id: characterId, p_dest_x: resNear.pos_x, p_dest_y: resNear.pos_y },
      accessToken
    );
    const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
    summary.moved = true;
    summary.dest = { x: resNear.pos_x, y: resNear.pos_y };
    summary.action = "move_to_resource";
    summary.status = "WAITING";
    summary.etaSeconds = eta;
    summary.nextDelayMs = Math.max(2_500, eta * 1000 + 1500);
    summary.reason = `Phá cờ · (rảnh cờ) resource ${resNear.label} #${resNear.node_id} HP ${resNear.hp}/${resNear.maxHp} → đi chip · ETA ${eta}s`;
    onLog?.("INFO", summary.reason);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  try {
    await leaveDefense(characterId, accessToken, onLog);
    const res = await rpc(
      "rpc_hoang_co_attack_position",
      {
        p_character_id: characterId,
        p_target_kind: "resource",
        p_target_id: String(resNear.node_id),
      },
      accessToken
    );
    const rem = n(res?.remaining_hp, resNear.hp);
    const cap = res?.captured === true || rem <= 0;
    summary.action = "attack_resource";
    summary.status = "WAITING";
    summary.nextDelayMs = cap ? 5_000 : 2_500;
    summary.reason = cap
      ? `Phá cờ · resource #${resNear.node_id} ${resNear.label} CAPTURED · chip ${n(res?.chip)}`
      : `Phá cờ · chip resource #${resNear.node_id} ${resNear.label} · HP còn ${rem}/${resNear.maxHp}`;
    onLog?.(cap ? "SUCCESS" : "INFO", summary.reason, { res });
  } catch (e: any) {
    summary.status = "WAITING";
    summary.nextDelayMs = 8_000;
    summary.reason = `attack_position resource: ${(e?.message || e).toString().slice(0, 100)}`;
    onLog?.("WARN", summary.reason);
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** Chọn mỏ để chiếm: ƯU TIÊN MỎ GẦN TRƯỚC (gần bot nhất), rồi LAN XA DẦN.
 *  Loại: đã của mình / đang protected / có thủ clan khác / hết HP.
 *  Thứ tự: (1) gần bot nhất → (2) sát lãnh thổ ta (cheby≤3 cờ built) để mở rộng liền mạch
 *  → (3) stronghold → (4) tier cao → (5) ít HP hơn. */
function pickResourceToCapture(map: any, me: Pos, clanId: string, maxDist = 999): ReturnType<typeof parseMines>[number] | null {
  const mines = parseMines(map);
  const now = Date.now();
  const ownBuilt = parseFlags(map).filter((f) => f.clan_id === clanId && f.is_built === true);
  const cands = mines
    .map((m) => {
      const mx = Math.floor(n(m.pos_x));
      const my = Math.floor(n(m.pos_y));
      const raw = (Array.isArray(map?.resources) ? map.resources : []).find(
        (r: any) => String(r?.node_id ?? r?.id) === String(m.node_id)
      );
      const prot = raw?.protection_until ? Date.parse(String(raw.protection_until)) : 0;
      const protectedNow = Number.isFinite(prot) && prot > now;
      const hp = m.struct_hp_current;
      const dist = manhattan(mx, my, me.x, me.y);
      const adj = ownBuilt.some((f) => chebyshev(Math.floor(n(f.pos_x)), Math.floor(n(f.pos_y)), mx, my) <= 3) ? 0 : 1;
      const mine = clanId && m.holder_clan_id === clanId;
      const defOther = resourceDefendedByOtherClan(map, m.node_id, clanId);
      return { m, hp, dist, adj, protectedNow, mine, defOther };
    })
    .filter((x) => x.dist <= maxDist && x.hp > 0 && !x.protectedNow && !x.mine && !x.defOther)
    .sort(
      (a, b) =>
        a.dist - b.dist ||
        a.adj - b.adj ||
        (b.m.is_stronghold ? 1 : 0) - (a.m.is_stronghold ? 1 : 0) ||
        (b.m.tier || 0) - (a.m.tier || 0) ||
        a.hp - b.hp
    );
  return cands.length ? cands[0].m : null;
}

/**
 * Chiếm resource (mỏ): đứng trên ô mỏ + attack_position lặp tới captured.
 * BẮT BUỘC có cờ đồng minh ĐÃ XÂY cheby≤1 với mỏ (như central).
 * Nếu chưa → tự bridge chuỗi cờ tiến tới sát mỏ, rồi mới công.
 * Chỉ gọi khi không còn cờ địch để phá (ưu tiên phá cờ trước).
 */
async function runHoangCoCaptureResource(options: HoangCoAutoOptions): Promise<HoangCoRunSummary | null> {
  const settings = options.settings || {};
  if (settings.auto_capture_resource === false) return null;
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;
  const pollMs = 12_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;
  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");
    if (onlyWhenEventLive && !eventLive) return null;
    if (!eligible || !clanId) return null;
    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    const me = myPos(map);
    if (!me || me.dead) return null;
    const target = pickResourceToCapture(map, me, clanId, 999);
    if (!target) return null;
    const resTile = { x: Math.floor(n(target.pos_x)), y: Math.floor(n(target.pos_y)) };
    const flags = parseFlags(map);
    const ownBuilt = flags.filter((f) => f.clan_id === clanId && f.is_built === true);
    const building = incompleteClanFlags(flags, clanId);
    const touched = ownBuilt.some((f) => chebyshev(f.pos_x, f.pos_y, resTile.x, resTile.y) <= 1);

    const baseSummary = (over: Partial<HoangCoRunSummary>): HoangCoRunSummary => ({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "WAITING",
      nextDelayMs: pollMs,
      phase: "capture_resource",
      ...over,
    });

    // ── Đã có cờ chạm mỏ → đi tới ô mỏ + attack_position (reuse loop chip)
    if (touched) {
      const chip = await tryChipNearResource({
        map,
        me,
        clanId,
        characterId,
        accessToken,
        settings: { ...settings, resource_attack_radius: 999 },
        onLog,
        summary: baseSummary({}),
      });
      return chip;
    }

    // ── Chưa có cờ chạm → bridge chuỗi cờ tới sát mỏ
    const cfgMaxBuild = Math.max(1, Math.floor(n(map?.config?.max_simultaneous_build, 3)) || 3);
    const usedFlags = flags.filter((f) => f.clan_id === clanId).length;
    const maxFlags = Math.floor(n(map?.config?.flag_limit, 30)) || 30;

    // Ưu tiên xây tiếp cờ dở đang tiến gần mỏ (khi đã đủ slot xây)
    const buildingToward = [...building]
      .map((f) => ({ f, d: chebyshev(f.pos_x, f.pos_y, resTile.x, resTile.y) }))
      .sort((a, b) => a.d - b.d);
    if (buildingToward.length > 0 && building.length >= cfgMaxBuild) {
      const focus = buildingToward[0].f;
      const dist = manhattan(focus.pos_x, focus.pos_y, me.x, me.y);
      if (dist > 0) {
          if (!isPosSafeFromHostiles(map, clanId, focus.pos_x, focus.pos_y, 0, characterId)) {
          const smart = pickSmartSafeDest({ map, me, myClanId: clanId, myCharacterId: characterId, ownBuilt, building, nearEnemies: [], safeR: 2 });
          if (smart && (smart.x !== me.x || smart.y !== me.y)) {
            await leaveDefense(characterId, accessToken, onLog);
            const mv = await rpc("rpc_hoang_co_move", { p_character_id: characterId, p_dest_x: smart.x, p_dest_y: smart.y }, accessToken);
            const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
            return baseSummary({ moved: true, dest: { x: smart.x, y: smart.y }, action: "flee_smart_resource_bridge", etaSeconds: eta, nextDelayMs: Math.max(2500, eta * 1000 + 1500), reason: `Resource ${target.label}: ô bridge có địch → né ${smart.label} @(${smart.x},${smart.y})` });
          }
        }
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc("rpc_hoang_co_move", { p_character_id: characterId, p_dest_x: focus.pos_x, p_dest_y: focus.pos_y }, accessToken);
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, dist * 3)));
        return baseSummary({ moved: true, dest: { x: focus.pos_x, y: focus.pos_y }, action: "move_to_build_resource_bridge", etaSeconds: eta, nextDelayMs: Math.max(3000, eta * 1000 + 2000), reason: `Resource ${target.label}: đi xây tiếp bridge #${focus.flag_id} @(${focus.pos_x},${focus.pos_y}) → sát mỏ` });
      }
      await leaveDefense(characterId, accessToken, onLog);
      try {
        await rpc("rpc_hoang_co_start_build", { p_character_id: characterId, p_flag_id: focus.flag_id }, accessToken);
      } catch (be: any) {
        onLog?.("WARN", `Resource bridge start_build: ${(be?.message || "").slice(0, 100)}`);
      }
      return baseSummary({ built: 1, flagId: focus.flag_id, action: "start_build_resource_bridge", reason: `Resource ${target.label}: xây tiếp bridge #${focus.flag_id} @(${focus.pos_x},${focus.pos_y})` });
    }

    if (usedFlags >= maxFlags) {
      return baseSummary({ reason: `Resource ${target.label}: flags FULL ${usedFlags}/${maxFlags} · chờ slot để bridge`, nextDelayMs: 25000 });
    }

    const cell = pickPlaceCellTowardTarget({ map, clanId, me, tx: resTile.x, ty: resTile.y, maxHop: 3, allowOnTarget: true });
    if (!cell) {
      return baseSummary({ reason: `Resource ${target.label}: chưa có cờ chạm (cheby≤1) · không tìm được ô bridge`, nextDelayMs: 10000 });
    }
    const cellToT = chebyshev(cell.x, cell.y, resTile.x, resTile.y);
    // ── CẮM CỜ TỪ XA: không cần đứng tại ô, chỉ cần ô hợp lệ (kề cờ built, trong tầm).
    try {
      const res = await rpc("rpc_hoang_co_place_flag", { p_character_id: characterId, p_pos_x: cell.x, p_pos_y: cell.y }, accessToken);
      const flagId = Math.floor(n(res?.flag?.flag_id || res?.flag_id, 0));
      let selfPlaced = Array.isArray(settings.self_placed_flag_ids)
        ? settings.self_placed_flag_ids.map((x: any) => Math.floor(n(x))).filter((x: number) => x > 0)
        : [];
      const selfPlacedSet = new Set(selfPlaced);
      if (flagId && !selfPlacedSet.has(flagId)) selfPlaced.push(flagId);
      if (flagId) {
        try {
          await rpc("rpc_hoang_co_start_build", { p_character_id: characterId, p_flag_id: flagId }, accessToken);
        } catch (be: any) {
          onLog?.("WARN", `Resource bridge start_build: ${(be?.message || "").slice(0, 100)}`);
        }
      }
      return baseSummary({
        placed: 1,
        built: flagId ? 1 : 0,
        flagId,
        selfPlacedFlagIds: [...selfPlaced],
        dest: { x: cell.x, y: cell.y },
        action: "place_resource_bridge",
        reason: `Resource ${target.label}: cắm TỪ XA #${flagId} @(${cell.x},${cell.y}) (cách mỏ ${cellToT}) · xong check chạm mỏ`,
      });
    } catch (e: any) {
      if (isPlaceFullError(e)) return baseSummary({ reason: `Resource ${target.label}: flags FULL · chờ slot bridge`, nextDelayMs: 25000 });
      if (isNotAdjacentError(e)) return baseSummary({ reason: `Resource ${target.label}: not_adjacent @(${cell.x},${cell.y}) · thử ô khác`, nextDelayMs: 10000 });
      if (isPlaceTooCloseToEnemyError(e)) return baseSummary({ reason: `Resource ${target.label}: đè tâm địch @(${cell.x},${cell.y}) · thử ô khác`, nextDelayMs: 10000 });
      // Lỗi khác (có thể server bắt đứng gần ô) → fallback đi tới ô rồi cắm
      const distPlace = manhattan(cell.x, cell.y, me.x, me.y);
      if (distPlace > 0) {
        if (me.inTransit && me.destX === cell.x && me.destY === cell.y && me.eta > 0) {
          return baseSummary({ status: "WAITING", action: "transit_to_place_resource", etaSeconds: me.eta, dest: { x: cell.x, y: cell.y }, nextDelayMs: Math.max(2000, me.eta * 1000 + 1500), reason: `Resource ${target.label}: (fallback) chờ tới ô @(${cell.x},${cell.y})` });
        }
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc("rpc_hoang_co_move", { p_character_id: characterId, p_dest_x: cell.x, p_dest_y: cell.y }, accessToken);
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distPlace * 3)));
        return baseSummary({ moved: true, dest: { x: cell.x, y: cell.y }, action: "move_to_place_resource_bridge", etaSeconds: eta, nextDelayMs: Math.max(3000, eta * 1000 + 2000), reason: `Resource ${target.label}: (fallback) đi tới ô rồi cắm @(${cell.x},${cell.y}) (cách mỏ ${cellToT})` });
      }
      onLog?.("WARN", `Resource bridge place: ${(e?.message || e).toString().slice(0, 100)}`);
      return baseSummary({ reason: `Resource ${target.label}: place bridge lỗi · chờ`, nextDelayMs: 10000 });
    }
  } catch (e: any) {
    onLog?.("WARN", `runHoangCoCaptureResource: ${(e?.message || e).toString().slice(0, 120)}`);
    return null;
  }
}

export async function runHoangCoExpandAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  // Tham số nội bộ — UI chỉ bật/tắt cắm + xây
  const maxPlacePerTick = 1;
  const maxGap = 3;
  const preferOwnRegion = true;
  const onlyWhenEventLive = settings.only_when_event_live !== false;
  const maxConcurrentBuild = 3;
  const threatRadius = 3;
  const buildPollMs = 15_000;
  const defaultPollMs = 20_000;
  const finishOneFirst = true;

  let selfPlaced: number[] = [];
  if (Array.isArray(settings.self_placed_flag_ids)) {
    selfPlaced = settings.self_placed_flag_ids
      .map((x: any) => Math.floor(Number(x)))
      .filter((x: number) => Number.isFinite(x) && x > 0);
  }
  const selfPlacedSet = new Set(selfPlaced);

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: defaultPollMs,
    placed: 0,
    built: 0,
    moved: false,
  };

  try {
    // 1) Status
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const myRegion = String(
      status?.eligibility?.region_code || status?.my_clan_score?.region_code || ""
    );
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");

    summary.myRegion = myRegion || undefined;

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Sự kiện Hoàng Cổ chưa live";
      summary.nextDelayMs = 5 * 60_000;
      onLog?.("INFO", "HoàngCổ: event chưa live · chờ 5p");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible) {
      summary.status = "SKIPPED";
      summary.reason = `Không eligible: ${status?.eligibility?.reason || "?"}`;
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", `HoàngCổ: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không có clan_id";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", "HoàngCổ: chưa có gia tộc");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // 2) Map
    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    const region = myRegion || String(map?.my_region_code || "");
    summary.myRegion = region || summary.myRegion;

    const me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí trên map (vào map Hoàng Cổ trước)";
      summary.nextDelayMs = 60_000;
      onLog?.("WARN", "HoàngCổ: chưa có my_position — vào map in-game 1 lần");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Nhân vật đang chết";
      summary.nextDelayMs = 90_000;
      onLog?.("WARN", "HoàngCổ: đang chết · chờ hồi");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Đang đi → chờ ETA
    if (me.inTransit && me.eta > 0) {
      const wait = Math.max(3_000, me.eta * 1000 + 1500);
      summary.status = "WAITING";
      summary.action = "transit";
      summary.etaSeconds = me.eta;
      summary.nextDelayMs = wait;
      summary.reason = `Đang di chuyển · ETA ${me.eta}s`;
      onLog?.("INFO", `HoàngCổ: đang đi · ETA ${me.eta}s · (${me.x},${me.y})`);
      try {
        await rpc(
          "rpc_hoang_co_heartbeat",
          { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
          accessToken
        );
      } catch {
        /* ignore */
      }
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const flags = parseFlags(map);
    const cfgSiegeMax = Math.max(100, Math.floor(n(map?.config?.siege_max, 600)) || 600);
    const clanFlags = flags.filter((f) => f.clan_id === clanId);
    const building = incompleteClanFlags(flags, clanId);
    summary.clanFlags = clanFlags.length;
    summary.buildingFlags = building.length;

    const cfgMaxBuild = Math.max(
      1,
      Math.floor(n(map?.config?.flag_building_max, maxConcurrentBuild)) || maxConcurrentBuild
    );

    // Dọn self_placed đã xong / không còn
    selfPlaced = selfPlaced.filter((id) => {
      const f = flags.find((x) => x.flag_id === id);
      return f && f.clan_id === clanId && !isFlagBuildComplete(f);
    });
    selfPlacedSet.clear();
    selfPlaced.forEach((id) => selfPlacedSet.add(id));
    summary.selfPlacedFlagIds = [...selfPlaced];

    /**
     * Ưu tiên focus xây:
     * 1) Cờ mình cắm (self_placed) — an toàn — gần / progress cao
     * 2) Cờ dở gần mình + an toàn
     * (Thủ cờ xử lý sau khi không bám build)
     */
    let focusFlagId = Math.floor(n(settings.focus_flag_id, 0)) || 0;
    let focus =
      focusFlagId > 0 ? building.find((f) => f.flag_id === focusFlagId) : undefined;

    if (focus && isFlagBuildComplete(focus)) {
      onLog?.(
        "SUCCESS",
        `HoàngCổ cờ #${focus.flag_id} XÂY XONG (is_built=true) · siege ${flagProgress(focus)}/${focus.siege_max || cfgSiegeMax}`
      );
      focus = undefined;
      focusFlagId = 0;
    }
    // Focus nguy hiểm → bỏ, chọn lại
    if (focus && isFlagSiteDangerous(map, focus, clanId, threatRadius).danger) {
      onLog?.("WARN", `HoàngCổ focus #${focus.flag_id} nguy hiểm · chọn cờ khác`);
      focus = undefined;
      focusFlagId = 0;
    }

    if (!focus && building.length > 0) {
      const byNear = (a: Flag, b: Flag) =>
        manhattan(a.pos_x, a.pos_y, me.x, me.y) - manhattan(b.pos_x, b.pos_y, me.x, me.y);

      const safe = (f: Flag) => !isFlagSiteDangerous(map, f, clanId, threatRadius).danger;

      // 1) Cờ bản thân cắm
      const mineSafe = building.filter((f) => selfPlacedSet.has(f.flag_id) && safe(f)).sort(byNear);
      // 2) Cờ dở gần + an toàn (mọi cờ clan)
      const nearSafe = building.filter((f) => safe(f)).sort(byNear);
      // Đứng trên cờ dở an toàn
      const onCell = building.find((f) => f.pos_x === me.x && f.pos_y === me.y && safe(f));

      focus = onCell || mineSafe[0] || nearSafe[0];
      focusFlagId = focus?.flag_id || 0;
    }

    summary.focusFlagId = focusFlagId || null;

    onLog?.(
      "INFO",
      `HoàngCổ · vùng ${region || "?"} · dở ${building.length} · focus #${focusFlagId || "—"} · pos (${me.x},${me.y})`
    );

    // 3) Bám xây 1 cờ tới siege_points >= siege_max (600) nếu an toàn
    if (settings.auto_build !== false && focus) {
      const maxPts = Math.max(1, n(focus.siege_max, cfgSiegeMax) || cfgSiegeMax);
      const pts = flagProgress(focus);
      summary.flagId = focus.flag_id;
      summary.siegePoints = pts;
      summary.siegeMax = maxPts;
      summary.focusFlagId = focus.flag_id;

      const threat = isFlagSiteDangerous(map, focus, clanId, threatRadius);
      if (threat.danger && finishOneFirst) {
        onLog?.(
          "WARN",
          `HoàngCổ cờ #${focus.flag_id} nguy hiểm (${threat.reasons.join("; ")}) · siege ${pts}/${maxPts} · bỏ focus, chọn việc khác`
        );
        summary.focusFlagId = null;
        // không return — rơi xuống place hoặc cờ khác
      } else {
        // An toàn (hoặc không bật finish_one) → bám tới xong
        if (threat.danger) {
          onLog?.("WARN", `HoàngCổ cờ #${focus.flag_id} có nguy (${threat.reasons.join("; ")}) nhưng vẫn build`);
        } else {
          onLog?.(
            "INFO",
            `HoàngCổ bám xây cờ #${focus.flag_id} · siege_points ${pts}/${maxPts} · an toàn · chưa xong thì không chuyển`
          );
        }

        const dist = manhattan(focus.pos_x, focus.pos_y, me.x, me.y);
        if (dist > 0 && settings.move_before_build !== false) {
          await leaveDefense(characterId, accessToken, onLog);
          const mv = await rpc(
            "rpc_hoang_co_move",
            { p_character_id: characterId, p_dest_x: focus.pos_x, p_dest_y: focus.pos_y },
            accessToken
          );
          const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
          summary.moved = true;
          summary.dest = { x: focus.pos_x, y: focus.pos_y };
          summary.action = "move_to_build";
          summary.status = "WAITING";
          summary.etaSeconds = eta;
          summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
          summary.reason = `Đi xây #${focus.flag_id} (${focus.pos_x},${focus.pos_y}) · siege ${pts}/${maxPts} · ETA ${eta}s`;
          onLog?.("INFO", summary.reason);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }

        try {
          const res = await rpc(
            "rpc_hoang_co_start_build",
            { p_character_id: characterId, p_flag_id: focus.flag_id },
            accessToken
          );
          summary.built = 1;
          summary.action = "start_build";
          const eta = Math.max(0, Math.floor(n(res?.eta_seconds, 0)));
          if (eta > 0) {
            summary.status = "WAITING";
            summary.moved = true;
            summary.etaSeconds = eta;
            summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
            summary.reason = `start_build #${focus.flag_id} · siege ${pts}/${maxPts} · ETA ${eta}s`;
            onLog?.("SUCCESS", summary.reason, { res });
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          // Đứng xây — chờ is_built=true (siege_points tăng 0→600), KHÔNG place mới
          summary.status = "WAITING";
          summary.nextDelayMs = buildPollMs;
          summary.reason = `Đang xây #${focus.flag_id} · is_built=false · siege ${pts}/${maxPts} · tới khi is_built=true`;
          onLog?.("SUCCESS", summary.reason, { res });
          try {
            await rpc(
              "rpc_hoang_co_heartbeat",
              { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
              accessToken
            );
          } catch {
            /* ignore */
          }
          summary.finishedAt = new Date().toISOString();
          return summary;
        } catch (e: any) {
          onLog?.(
            "WARN",
            `HoàngCổ start_build #${focus.flag_id} fail: ${(e?.message || e).toString().slice(0, 120)} · siege ${pts}/${maxPts}`
          );
          // fail tạm — vẫn giữ focus, poll lại
          summary.status = "WAITING";
          summary.focusFlagId = focus.flag_id;
          summary.nextDelayMs = buildPollMs;
          summary.reason = `start_build fail · giữ focus #${focus.flag_id} · siege ${pts}/${maxPts}`;
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
      }
    }

    // 4) place_flag — gần mình; chỉ khi không còn cờ dở an toàn (không trộn thủ cờ)
    const safeIncomplete = building.filter((f) => !isFlagSiteDangerous(map, f, clanId, threatRadius).danger);
    if (finishOneFirst && safeIncomplete.length > 0 && settings.auto_build !== false) {
      const f = [...safeIncomplete].sort(
        (a, b) => manhattan(a.pos_x, a.pos_y, me.x, me.y) - manhattan(b.pos_x, b.pos_y, me.x, me.y)
      )[0];
      summary.focusFlagId = f.flag_id;
      summary.status = "WAITING";
      summary.siegePoints = flagProgress(f);
      summary.siegeMax = f.siege_max || cfgSiegeMax;
      summary.nextDelayMs = 5_000;
      summary.reason = `Còn cờ #${f.flag_id} siege ${flagProgress(f)}/${f.siege_max} · chưa place mới`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    if (settings.auto_place === false) {
      summary.status = "DONE";
      summary.reason = "Tắt cắm cờ";
      summary.focusFlagId = null;
      summary.selfPlacedFlagIds = selfPlaced;
      summary.nextDelayMs = defaultPollMs;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    if (building.length >= cfgMaxBuild) {
      summary.status = "WAITING";
      summary.reason = `Đang có ${building.length} cờ dở · chờ xong mới cắm`;
      summary.nextDelayMs = Math.max(15_000, buildPollMs);
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    let placed = 0;
    for (let i = 0; i < maxPlacePerTick; i++) {
      if (options.shouldStop?.()) break;

      // refresh map nhẹ giữa các lần place
      const mapNow = i === 0 ? map : await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken); // luôn lấy live khi đang cắm
      const meNow = myPos(mapNow) || me;

      const cell = pickPlaceCell({
        map: mapNow,
        clanId,
        myRegion: region,
        me: { x: meNow.x, y: meNow.y },
        maxGap,
        preferOwnRegion,
      });

      if (!cell) {
        summary.reason = "Không tìm được ô trống để cắm cờ";
        onLog?.("WARN", `HoàngCổ: ${summary.reason}`);
        break;
      }

      const dist = manhattan(cell.x, cell.y, meNow.x, meNow.y);
      if (dist > 0) {
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc(
          "rpc_hoang_co_move",
          { p_character_id: characterId, p_dest_x: cell.x, p_dest_y: cell.y },
          accessToken
        );
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, dist * 3)));
        summary.moved = true;
        summary.dest = cell;
        summary.action = "move_to_place";
        summary.status = "WAITING";
        summary.etaSeconds = eta;
        summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
        summary.reason = `Đi cắm cờ @(${cell.x},${cell.y}) · ETA ${eta}s`;
        onLog?.("INFO", summary.reason, { mv });
        summary.finishedAt = new Date().toISOString();
        return summary;
      }

      // Đã đứng đúng ô → place
      try {
        const res = await rpc(
          "rpc_hoang_co_place_flag",
          { p_character_id: characterId, p_pos_x: cell.x, p_pos_y: cell.y },
          accessToken
        );
        placed += 1;
        summary.placed = placed;
        summary.action = "place_flag";
        summary.dest = cell;
        const flagId = Math.floor(n(res?.flag?.flag_id || res?.flag_id, 0));
        if (flagId) {
          summary.flagId = flagId;
          summary.focusFlagId = flagId;
          if (!selfPlacedSet.has(flagId)) {
            selfPlaced.push(flagId);
            selfPlacedSet.add(flagId);
          }
        }
        summary.selfPlacedFlagIds = [...selfPlaced];
        const used = n(res?.used_flags, 0);
        const maxF = n(res?.max_flags, 0);
        const sp = n(res?.flag?.siege_points, 0);
        const sm = n(res?.flag?.siege_max, cfgSiegeMax) || cfgSiegeMax;
        summary.siegePoints = sp;
        summary.siegeMax = sm;
        onLog?.(
          "SUCCESS",
          `HoàngCổ cắm #${flagId || "?"} @(${cell.x},${cell.y}) · siege ${sp}/${sm} · bám tới 600`,
          { res, used, maxF }
        );

        // place xong → start_build rồi đứng bám (không place tiếp trong tick)
        if (flagId && settings.auto_build !== false) {
          try {
            await rpc(
              "rpc_hoang_co_start_build",
              { p_character_id: characterId, p_flag_id: flagId },
              accessToken
            );
            summary.built = (summary.built || 0) + 1;
            onLog?.("SUCCESS", `HoàngCổ start_build ngay sau place #${flagId} · siege ${sp}/${sm}`);
          } catch (be: any) {
            onLog?.("WARN", `HoàngCổ start_build sau place fail: ${(be?.message || "").slice(0, 100)}`);
          }
        }

        summary.status = "WAITING";
        summary.nextDelayMs = buildPollMs;
        summary.reason = `Đã place #${flagId} · bám siege_points tới ${sm}`;
        summary.finishedAt = new Date().toISOString();
        return summary;
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 160);
        onLog?.("WARN", `HoàngCổ place @(${cell.x},${cell.y}) fail: ${msg}`);
        // ô hỏng → đánh dấu bằng cách không retry ngay: delay và thoát tick
        summary.reason = `place fail: ${msg}`;
        summary.status = "ERROR";
        summary.nextDelayMs = 20_000;
        break;
      }
    }

    if (placed > 0) {
      summary.status = "DONE";
      summary.reason = `Đã place ${placed} cờ`;
      summary.nextDelayMs = Math.max(10_000, defaultPollMs);
    } else if (!summary.reason) {
      summary.status = "DONE";
      summary.reason = "Không place/build được trong tick";
      summary.nextDelayMs = defaultPollMs;
    }

    summary.selfPlacedFlagIds = [...selfPlaced];
    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    summary.selfPlacedFlagIds = summary.selfPlacedFlagIds || [];
    onLog?.("ERROR", `HoàngCổ error: ${summary.reason}`);
  }

  if (!summary.selfPlacedFlagIds) summary.selfPlacedFlagIds = [...selfPlaced];
  summary.finishedAt = new Date().toISOString();
  return summary;
}

/**
 * Chức năng 2 — THỦ / CỨU CỜ GIA TỘC
 * - Tìm cờ clan bị địch áp (besiegers / địch gần / HP tụt)
 * - move tới cờ → rpc_hoang_co_siege_flag { p_flag_id } → side=defend
 */
export async function runHoangCoDefendAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  const threatRadius = 3;
  const pollMs = 15_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: pollMs,
    threatenedCount: 0,
  };

  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Event chưa live";
      summary.nextDelayMs = 5 * 60_000;
      onLog?.("INFO", "HC Thủ: event chưa live");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible || !clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không eligible / chưa có clan";
      summary.nextDelayMs = 10 * 60_000;
      onLog?.("WARN", `HC Thủ: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    let me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí map";
      summary.nextDelayMs = 60_000;
      onLog?.("WARN", "HC Thủ: vào map Hoàng Cổ 1 lần");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Đang chết";
      summary.nextDelayMs = 90_000;
      onLog?.("WARN", "HC Thủ: đang chết");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.inTransit && me.eta > 0) {
      summary.status = "WAITING";
      summary.action = "transit";
      summary.etaSeconds = me.eta;
      summary.nextDelayMs = Math.max(3_000, me.eta * 1000 + 1500);
      summary.reason = `Đang đi · ETA ${me.eta}s`;
      onLog?.("INFO", `HC Thủ: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const flags = parseFlags(map);
    const clanFlags = flags.filter((f) => f.clan_id === clanId);
    const besiegers = Array.isArray(map?.besiegers) ? map.besiegers : [];

    /**
     * Cờ cần cứu / khôi phục:
     * 1) is_built=true && siege_points < 600 → đã bị phá (địch có thể đã đi) — chính
     * 2) đang có besieger / địch gần — đang bị công
     * Không nhầm với cờ is_built=false (đó là việc XÂY của expand)
     */
    const threatened = clanFlags
      .map((f) => {
        const siegeHit = besiegers.filter((b: any) => Math.floor(n(b.flag_id)) === f.flag_id);
        const danger = isFlagSiteDangerous(map, f, clanId, threatRadius);
        const damaged = isFlagDamaged(f); // is_built + siege < max
        const max = Math.max(1, n(f.siege_max, 600) || 600);
        const missing = damaged ? max - flagProgress(f) : 0;
        const score =
          (damaged ? 200 : 0) +
          missing * 0.5 +
          siegeHit.length * 80 +
          (danger.danger ? 15 : 0);
        return { f, siegeHit, danger, damaged, score };
      })
      .filter((x) => x.damaged || x.siegeHit.length > 0 || x.danger.danger)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return manhattan(a.f.pos_x, a.f.pos_y, me.x, me.y) - manhattan(b.f.pos_x, b.f.pos_y, me.x, me.y);
      });

    summary.threatenedCount = threatened.length;
    summary.clanFlags = clanFlags.length;

    if (!threatened.length) {
      summary.status = "DONE";
      summary.reason = "Không cờ bị phá / bị áp";
      summary.nextDelayMs = 25_000;
      onLog?.("INFO", "HC Thủ: yên · không cờ is_built+siege<600 / besieger");
      try {
        await rpc(
          "rpc_hoang_co_heartbeat",
          { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
          accessToken
        );
      } catch {
        /* ignore */
      }
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const pick = threatened[0];
    const tf = pick.f;
    summary.flagId = tf.flag_id;
    summary.siegePoints = flagProgress(tf);
    summary.siegeMax = tf.siege_max;

    onLog?.(
      "INFO",
      `HC Thủ: ${threatened.length} cờ cần cứu · #${tf.flag_id} is_built=${tf.is_built} siege ${flagProgress(tf)}/${tf.siege_max} · damaged=${pick.damaged} · besieger ${pick.siegeHit.length}`
    );

    const dist = manhattan(tf.pos_x, tf.pos_y, me.x, me.y);
    if (dist > 0) {
      await leaveDefense(characterId, accessToken, onLog);
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: tf.pos_x, p_dest_y: tf.pos_y },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.dest = { x: tf.pos_x, y: tf.pos_y };
      summary.action = "move_to_rescue";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Chạy cứu cờ #${tf.flag_id} · ETA ${eta}s`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Đúng ô / đã tới → siege_flag (phe defend)
    try {
      const res = await rpc(
        "rpc_hoang_co_siege_flag",
        { p_character_id: characterId, p_flag_id: tf.flag_id },
        accessToken
      );
      const side = String(res?.side || "");
      summary.side = side || undefined;
      summary.action = "siege_flag_defend";
      summary.siegePoints = n(res?.siege_points, flagProgress(tf));
      summary.siegeMax = n(res?.siege_max, tf.siege_max);
      summary.status = "WAITING";
      summary.nextDelayMs = pollMs;
      summary.reason = `Cứu cờ #${tf.flag_id} · side=${side || "?"} · def ${n(res?.defender_count)} / atk ${n(res?.besieger_count)} · siege ${summary.siegePoints}/${summary.siegeMax}`;
      onLog?.("SUCCESS", summary.reason, { res });
    } catch (e: any) {
      summary.status = "ERROR";
      summary.reason = `siege_flag #${tf.flag_id} fail: ${(e?.message || e).toString().slice(0, 120)}`;
      summary.nextDelayMs = 20_000;
      onLog?.("ERROR", `HC Thủ: ${summary.reason}`);
    }

    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    onLog?.("ERROR", `HC Thủ error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** Expand còn việc (đang build/place/đi) → chưa chuyển phase sau */
function expandStillBusy(r: HoangCoRunSummary): boolean {
  if (r.status === "WAITING") return true;
  if (r.status === "ERROR") return true;
  if ((r.placed || 0) > 0 || (r.built || 0) > 0) return true;
  if (r.moved) return true;
  if (r.action && /place|build|move_to_place|move_to_build|start_build|transit/i.test(r.action)) return true;
  if (r.focusFlagId && r.buildingFlags && r.buildingFlags > 0) return true;
  if (r.buildingFlags && r.buildingFlags > 0 && /còn cờ|đang xây|chưa place|chờ xong|is_built/i.test(r.reason || ""))
    return true;
  return false;
}

/** Thủ cờ còn việc */
function defendStillBusy(r: HoangCoRunSummary): boolean {
  if (r.status === "WAITING") return true;
  if (r.status === "ERROR") return true;
  if (r.moved) return true;
  if (r.action && /rescue|defend|siege_flag_defend|move_to_rescue/i.test(r.action || "")) return true;
  return false;
}

/** Thủ mỏ còn việc (ghim / đang flee sang mỏ khác) */
function defendMineStillBusy(r: HoangCoRunSummary): boolean {
  if (r.status === "WAITING") return true;
  if (r.status === "ERROR") return true;
  if (r.moved) return true;
  if (
    r.action &&
    /defend_mine|defend_central|move_to_mine|move_to_central|flee_mine|flee_central|flee_to_safe|resource/i.test(
      r.action || ""
    )
  )
    return true;
  return false;
}

function attackStillBusy(r: HoangCoRunSummary): boolean {
  if (r.status === "WAITING") return true;
  if (r.status === "ERROR") return true;
  if (r.moved) return true;
  if (r.action && /siege_flag_attack|move_to_attack|attack_central|attack_position/i.test(r.action || ""))
    return true;
  return false;
}

/** Còn bao lâu central lock (ms). null = không có lock_until */
function centralLockRemainingMs(central: any, nowMs = Date.now()): number | null {
  const lockUntil = central?.lock_until;
  if (!lockUntil) return null;
  const t = new Date(lockUntil).getTime();
  if (!Number.isFinite(t)) return null;
  return t - nowMs;
}

/**
 * Công central — rpc_hoang_co_attack_position
 * p_target_kind: "central", p_target_id: "central"
 * (resource cũng cùng RPC, phase sau)
 *
 * Công khi: địch giữ central, HOẶC mình giữ nhưng hết lock_until (cần đánh lại).
 */
export async function runHoangCoAttackCentralAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  const pollMs = 12_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: pollMs,
    phase: "attack_central",
  };

  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Event chưa live";
      summary.nextDelayMs = 5 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible || !clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không eligible / chưa clan";
      summary.nextDelayMs = 10 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    let me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí map";
      summary.nextDelayMs = 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Đang chết";
      summary.nextDelayMs = 90_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.inTransit && me.eta > 0) {
      summary.status = "WAITING";
      summary.action = "transit";
      summary.etaSeconds = me.eta;
      summary.nextDelayMs = Math.max(3_000, me.eta * 1000 + 1500);
      summary.reason = `Đang đi · ETA ${me.eta}s`;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const cx = Math.floor(n(map?.config?.center_x, 42));
    const cy = Math.floor(n(map?.config?.center_y, 42));
    // central có thể ở map.central hoặc status.central
    const central = map?.central || status?.central || {};
    const holder = String(central.holder_clan_id || "");
    const weHold = holder === clanId;
    const lockLeft = centralLockRemainingMs(central);
    const lockActive = lockLeft != null && lockLeft > 0;

    // Mình đang giữ + còn lock → để phase Thủ central, không công
    if (weHold && lockActive) {
      const mins = Math.ceil(lockLeft! / 60_000);
      summary.status = "DONE";
      summary.reason = `Central mình giữ · còn lock ~${mins}p · ưu tiên Thủ`;
      summary.nextDelayMs = Math.min(60_000, Math.max(15_000, lockLeft!));
      onLog?.("INFO", `HC Công central: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const why =
      !weHold
        ? `holder địch/khác`
        : lockLeft != null && lockLeft <= 0
          ? `hết lock_until · cần công lại`
          : `cần công`;

    summary.mineId = "central";
    summary.dest = { x: cx, y: cy };
    onLog?.(
      "INFO",
      `HC Công central: ${why} · phase=${central.phase || "?"} · bossHP ${n(central.boss_hp_current)}/${n(central.boss_hp_max)} · lock_until=${central.lock_until || "—"}`
    );

    const atCenter = manhattan(me.x, me.y, cx, cy) <= 1;
    if (!atCenter) {
      await leaveDefense(characterId, accessToken, onLog);
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: cx, p_dest_y: cy },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.action = "move_to_attack_central";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Đi công central (${cx},${cy}) · ${why} · ETA ${eta}s`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Đứng tại central → attack_position
    try {
      const res = await rpc(
        "rpc_hoang_co_attack_position",
        {
          p_character_id: characterId,
          p_target_kind: "central",
          p_target_id: "central",
        },
        accessToken
      );
      summary.action = "attack_position_central";
      summary.status = "WAITING";
      // captured / remaining_hp giống resource
      const captured = res?.captured === true;
      const rem = n(res?.remaining_hp, -1);
      const maxHp = n(res?.struct_hp_max || res?.boss_hp_max, 0);
      if (captured || rem === 0) {
        summary.reason = `Công central OK · captured · chip ${n(res?.chip)}`;
        summary.nextDelayMs = 10_000;
      } else {
        summary.reason = `Công central · HP còn ${rem}${maxHp ? "/" + maxHp : ""} · chip ${n(res?.chip)}`;
        summary.nextDelayMs = pollMs;
      }
      onLog?.("SUCCESS", summary.reason, { res });
    } catch (e: any) {
      summary.status = "ERROR";
      summary.reason = `attack_position central fail: ${(e?.message || e).toString().slice(0, 140)}`;
      summary.nextDelayMs = 20_000;
      onLog?.("ERROR", `HC Công central: ${summary.reason}`);
    }

    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    onLog?.("ERROR", `HC Công central error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

type MineNode = {
  node_id: number | string;
  pos_x: number;
  pos_y: number;
  holder_clan_id?: string;
  label?: string;
  struct_hp_current: number;
  struct_hp_max: number;
  is_stronghold?: boolean;
  tier?: number;
};

function parseMines(map: any): MineNode[] {
  const raw = Array.isArray(map?.resources) ? map.resources : [];
  return raw
    .map((r: any) => ({
      node_id: r.node_id != null ? r.node_id : r.id,
      pos_x: Math.floor(n(r.pos_x)),
      pos_y: Math.floor(n(r.pos_y)),
      holder_clan_id: r.holder_clan_id ? String(r.holder_clan_id) : undefined,
      label: String(r.label_vi || r.label_en || r.name || ""),
      struct_hp_current: n(r.struct_hp_current, n(r.hp_current, 0)),
      struct_hp_max: n(r.struct_hp_max, n(r.hp_max, 1)) || 1,
      is_stronghold: r.is_stronghold === true,
      tier: n(r.tier, 0),
    }))
    .filter((m: MineNode) => m.node_id != null && m.node_id !== "");
}

/**
 * Địch trong bán kính threatRadius quanh (x,y)
 * Chỉ player địch — không dựa HP.
 */
function enemiesNearPoint(
  map: any,
  x: number,
  y: number,
  myClanId: string,
  threatRadius: number
): { count: number; names: string[] } {
  const players = Array.isArray(map?.players) ? map.players : [];
  const names: string[] = [];
  for (const p of players) {
    const pid = String(p?.clan_id || "");
    if (pid && pid === myClanId) continue;
    if (p?.is_ally === true) continue;
    const px = Math.floor(n(p?.pos_x, -999));
    const py = Math.floor(n(p?.pos_y, -999));
    if (px < -100) continue;
    if (manhattan(px, py, x, y) <= threatRadius) {
      names.push(String(p?.name || p?.character_id || "?").slice(0, 24));
    }
  }
  return { count: names.length, names };
}

/**
 * Thủ mỏ = ghim **CENTRAL** (trung tâm)
 * - defend_position { kind: "central", id: "central" }
 * - stack_order / stack_size chỉ là thứ tự hàng (1,2,3…) — không dùng để quyết định
 * - Địch trong 3 ô quanh central → leave + chạy về home, KHÔNG ở lại đánh
 * - An toàn → quay lại ghim central
 */
export async function runHoangCoDefendMineAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  const threatRadius = 3;
  const pollMs = 15_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: pollMs,
  };

  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Event chưa live";
      summary.nextDelayMs = 5 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible || !clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không eligible / chưa clan";
      summary.nextDelayMs = 10 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    let me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí map";
      summary.nextDelayMs = 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Đang chết";
      summary.nextDelayMs = 90_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.inTransit && me.eta > 0) {
      summary.status = "WAITING";
      summary.action = "transit";
      summary.etaSeconds = me.eta;
      summary.nextDelayMs = Math.max(3_000, me.eta * 1000 + 1500);
      summary.reason = `Đang đi · ETA ${me.eta}s`;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Tọa độ central
    const cx = Math.floor(n(map?.config?.center_x, 42));
    const cy = Math.floor(n(map?.config?.center_y, 42));
    const central = map?.central || status?.central || {};
    const holder = String(central.holder_clan_id || "");
    const weHoldCentral = holder === clanId;
    const lockLeft = centralLockRemainingMs(central);
    const lockActive = lockLeft != null && lockLeft > 0;
    const lockMins = lockLeft != null ? Math.max(0, Math.ceil(lockLeft / 60_000)) : null;

    // Chỉ thủ khi mình giữ + còn lock_until (còn thời gian thủ)
    if (!weHoldCentral && settings.mine_require_hold !== false) {
      summary.status = "DONE";
      summary.reason = `Central không phải clan mình · nhường Công central`;
      summary.nextDelayMs = 15_000;
      onLog?.("INFO", `HC Thủ central: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Hết lock → không thủ nữa, chuyển phase Công (attack_position)
    if (weHoldCentral && lockLeft != null && lockLeft <= 0) {
      summary.status = "DONE";
      summary.reason = `Hết lock_until (${central.lock_until}) · chuyển Công central`;
      summary.nextDelayMs = 8_000;
      onLog?.("WARN", `HC Thủ central: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    summary.mineId = "central";
    summary.dest = { x: cx, y: cy };
    if (lockMins != null) {
      onLog?.("INFO", `HC Thủ central: còn lock ~${lockMins}p · lock_until=${central.lock_until}`);
    }

    const near = enemiesNearPoint(map, cx, cy, clanId, threatRadius);
    const atCentral = manhattan(me.x, me.y, cx, cy) <= 1; // gần tâm (0–1 ô)

    // Địch trong 3 ô quanh central → không ở lại đánh, flee về home
    if (near.count > 0) {
      onLog?.(
        "WARN",
        `HC Central: ${near.count} địch trong ${threatRadius} ô (${near.names.slice(0, 3).join(",")}) · leave + chạy · không đánh`
      );
      await leaveDefense(characterId, accessToken, onLog);

      const homes = Array.isArray(map?.home_cities) ? map.home_cities : [];
      const region = String(map?.my_region_code || "");
      const home = homes.find((h: any) => String(h.vuc || h.region_code) === region) || homes[0];
      if (home) {
        const hx = Math.floor(n(home.pos_x));
        const hy = Math.floor(n(home.pos_y));
        // Đã ở home → chờ địch tan
        if (manhattan(me.x, me.y, hx, hy) <= 1) {
          summary.status = "WAITING";
          summary.action = "flee_central_wait";
          summary.nextDelayMs = pollMs;
          summary.reason = `Central có địch · đang tránh ở home · chờ an toàn rồi quay lại`;
          onLog?.("INFO", summary.reason);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
        const mv = await rpc(
          "rpc_hoang_co_move",
          { p_character_id: characterId, p_dest_x: hx, p_dest_y: hy },
          accessToken
        );
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
        summary.moved = true;
        summary.action = "flee_central_home";
        summary.status = "WAITING";
        summary.etaSeconds = eta;
        summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
        summary.reason = `Flee central · về home (${hx},${hy}) · ETA ${eta}s`;
        onLog?.("WARN", summary.reason);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      summary.status = "WAITING";
      summary.action = "flee_central_no_home";
      summary.nextDelayMs = 12_000;
      summary.reason = "Central có địch · không có home để chạy";
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Central an toàn → tới và ghim (stack_order chỉ là hàng, không quan trọng)
    if (!atCentral) {
      await leaveDefense(characterId, accessToken, onLog);
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: cx, p_dest_y: cy },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.action = "move_to_central";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Đi thủ central (${cx},${cy}) · ETA ${eta}s · an toàn`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    try {
      const res = await rpc(
        "rpc_hoang_co_defend_position",
        {
          p_character_id: characterId,
          p_target_kind: "central",
          p_target_id: "central",
        },
        accessToken
      );
      // stack_order/size = thứ tự hàng (1,2,3…) — log nhẹ, không dùng logic
      summary.action = "defend_central";
      summary.status = "WAITING";
      // Poll theo lock còn lại (tối đa 60s)
      const nextByLock =
        lockLeft != null && lockLeft > 0 ? Math.min(60_000, Math.max(pollMs, Math.floor(lockLeft / 3))) : pollMs;
      summary.nextDelayMs = nextByLock;
      summary.reason = `Thủ central · ghim OK${lockMins != null ? ` · còn ~${lockMins}p` : ""}`;
      onLog?.("SUCCESS", summary.reason, {
        // stack chỉ là hàng 1,2,3… — không dùng quyết định
        stack_order: res?.stack_order,
        stack_size: res?.stack_size,
        lock_until: central.lock_until,
      });
    } catch (e: any) {
      summary.status = "ERROR";
      summary.reason = `defend_position central fail: ${(e?.message || e).toString().slice(0, 120)}`;
      summary.nextDelayMs = 20_000;
      onLog?.("ERROR", `HC Thủ central: ${summary.reason}`);
    }

    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    onLog?.("ERROR", `HC Thủ mỏ/central error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/**
 * Phá cờ địch — clan_id khác mình
 * rpc_hoang_co_siege_flag → side: "attack"
 */
export async function runHoangCoAttackAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  const pollMs = 15_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;
  const focusAttackId = Math.floor(n(settings.focus_attack_flag_id, 0)) || 0;

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: pollMs,
  };

  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");
    const myClanName = String(status?.my_clan_score?.clan_name || "").trim();

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Event chưa live";
      summary.nextDelayMs = 5 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible || !clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không eligible / chưa clan";
      summary.nextDelayMs = 10 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    let me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí map";
      summary.nextDelayMs = 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Đang chết";
      summary.nextDelayMs = 90_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.inTransit && me.eta > 0) {
      summary.status = "WAITING";
      summary.action = "transit";
      summary.etaSeconds = me.eta;
      summary.nextDelayMs = Math.max(3_000, me.eta * 1000 + 1500);
      summary.reason = `Đang đi · ETA ${me.eta}s`;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const flags = parseFlags(map);
    // Cờ địch: clan_id khác (clan_name khác mình)
    const enemyFlags = flags.filter((f) => f.clan_id && f.clan_id !== clanId);

    if (!enemyFlags.length) {
      summary.status = "DONE";
      summary.reason = "Không còn cờ địch trên map";
      summary.nextDelayMs = 30_000;
      onLog?.("INFO", "HC Phá: không cờ địch");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Ưu tiên: focus_attack đang bám; rồi gần mình; ưu tiên is_built (đang đứng cờ) + siege còn
    let target: Flag | undefined =
      focusAttackId > 0 ? enemyFlags.find((f) => f.flag_id === focusAttackId) : undefined;

    if (target && flagProgress(target) <= 0 && target.is_built !== true) {
      // cờ gần chết / lạ — chọn lại
      target = undefined;
    }

    if (!target) {
      target = [...enemyFlags].sort((a, b) => {
        // Ưu is_built (đang tồn tại), rồi gần, rồi siege cao (vẫn còn)
        const ba = a.is_built === true ? 0 : 1;
        const bb = b.is_built === true ? 0 : 1;
        if (ba !== bb) return ba - bb;
        const da = manhattan(a.pos_x, a.pos_y, me.x, me.y);
        const db = manhattan(b.pos_x, b.pos_y, me.x, me.y);
        if (da !== db) return da - db;
        return flagProgress(b) - flagProgress(a);
      })[0];
    }

    if (!target) {
      summary.status = "DONE";
      summary.reason = "Không chọn được cờ địch";
      summary.nextDelayMs = 30_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    summary.flagId = target.flag_id;
    summary.siegePoints = flagProgress(target);
    summary.siegeMax = target.siege_max;
    summary.focusFlagId = target.flag_id; // reuse field = attack focus

    const enemyName = String(
      (map.flags || []).find((x: any) => Math.floor(n(x.flag_id)) === target!.flag_id)?.clan_name || "?"
    );

    onLog?.(
      "INFO",
      `HC Phá: #${target.flag_id} · ${enemyName} · is_built=${target.is_built} · siege ${flagProgress(target)}/${target.siege_max} · pos (${target.pos_x},${target.pos_y})`
    );

    const dist = manhattan(target.pos_x, target.pos_y, me.x, me.y);
    if (dist > 0) {
      await leaveDefense(characterId, accessToken, onLog);
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: target.pos_x, p_dest_y: target.pos_y },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.dest = { x: target.pos_x, y: target.pos_y };
      summary.action = "move_to_attack";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Đi phá cờ #${target.flag_id} (${enemyName}) · ETA ${eta}s`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Đứng tại cờ địch → siege_flag attack
    try {
      const res = await rpc(
        "rpc_hoang_co_siege_flag",
        { p_character_id: characterId, p_flag_id: target.flag_id },
        accessToken
      );
      const side = String(res?.side || "");
      summary.side = side || undefined;
      summary.action = "siege_flag_attack";
      summary.siegePoints = n(res?.siege_points, flagProgress(target));
      summary.siegeMax = n(res?.siege_max, target.siege_max);
      summary.status = "WAITING";
      summary.nextDelayMs = pollMs;

      if (side && side !== "attack") {
        onLog?.(
          "WARN",
          `HC Phá: server trả side=${side} (kỳ vọng attack) · flag #${target.flag_id} · có thể nhầm cờ mình?`
        );
      }

      summary.reason = `Phá cờ #${target.flag_id} · ${enemyName} · side=${side || "?"} · atk ${n(res?.besieger_count)} / def ${n(res?.defender_count)} · siege ${summary.siegePoints}/${summary.siegeMax}`;
      onLog?.("SUCCESS", summary.reason, { res, myClan: myClanName || clanId });
    } catch (e: any) {
      summary.status = "ERROR";
      summary.reason = `siege_flag attack #${target.flag_id} fail: ${(e?.message || e).toString().slice(0, 120)}`;
      summary.nextDelayMs = 20_000;
      onLog?.("ERROR", `HC Phá: ${summary.reason}`);
    }

    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    onLog?.("ERROR", `HC Phá error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** Danh sách bang hội địch trên map (để UI chọn, không gõ tay) */
export async function listHoangCoEnemyClans(options: {
  characterId: string;
  accessToken: string;
}): Promise<{
  clans: Array<{ clan_id: string; clan_name: string; flag_count: number }>;
  myClanId?: string;
  myClanName?: string;
}> {
  const status = await rpc("rpc_hoang_co_status", { p_character_id: options.characterId }, options.accessToken);
  const myClanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");
  const myClanName = String(status?.my_clan_score?.clan_name || "").trim() || undefined;
  const map = await rpc("rpc_hoang_co_map_state", { p_character_id: options.characterId }, options.accessToken);
  const flags = parseFlags(map);
  const by = new Map<string, { clan_id: string; clan_name: string; flag_count: number }>();
  for (const f of flags) {
    if (!isEnemyFlag(f, myClanId)) continue;
    const name = (f.clan_name || f.clan_id || "?").trim() || "?";
    const key = f.clan_id || name;
    const cur = by.get(key);
    if (cur) cur.flag_count += 1;
    else by.set(key, { clan_id: f.clan_id || key, clan_name: name, flag_count: 1 });
  }
  const clans = [...by.values()].sort(
    (a, b) => b.flag_count - a.flag_count || a.clan_name.localeCompare(b.clan_name, "vi")
  );
  return { clans, myClanId: myClanId || undefined, myClanName };
}

/** Server: siege khi chưa có cờ mình chạm 3×3 → message "not_near" (P0001) */
function isNotNearError(e: any): boolean {
  const msg = String(e?.message || e || "").toLowerCase();
  const dataMsg = String(e?.data?.message || e?.data?.error || e?.data?.hint || "").toLowerCase();
  return msg.includes("not_near") || dataMsg.includes("not_near");
}

/**
 * Phá cờ — state machine (tránh vòng tròn tử thần):
 *
 * Mỗi tick SCAN map_state lại:
 *   NEAR (cờ built mình cheby≤1 địch) → khóa ASSAULT: chỉ MOVE flag.pos + siege
 *     (cấm cắm/xây vòng / chip resource / hop)
 *   CỜ DỞ SÁT (cheby≤1, chưa built) → chỉ XÂY cờ đó
 *   XA → PLAN bridge: cắm kề + xây
 *   BỊ DÍ (player địch gần) → né tạm (cooldown, không spam flee tạo vòng)
 */
export async function runHoangCoBreakFlagAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;
  const pollMs = 12_000;
  const onlyWhenEventLive = settings.only_when_event_live !== false;
  const targetClan = String(settings.target_clan_name || settings.target_clan || settings.focus_clan_name || "").trim();
  const breakMode = String(settings.break_mode || "any").toLowerCase();
  let centralPlan: any = null;
  // Flee mặc định TẮT — chỉ né khi user BẬT rõ ràng (flee_on_enemy_near === true).
  // Trước đây mặc định BẬT (flee_on_enemy_near !== false) nên dù user không tích vẫn né người
  // → trong mode central bot cứ lùi né thay vì cắm bridge tới central.
  const fleeOn = settings.flee_on_enemy_near === true;
  const fleeRadius = Math.max(1, Math.min(3, Math.floor(n(settings.flee_radius, 2)) || 2));
  // Cắm hop mở rộng khi chưa near — mặc định BẬT
  const hopOn = settings.break_hop !== false;
  const nowMs = Date.now();

  let selfPlaced: number[] = [];
  if (Array.isArray(settings.self_placed_flag_ids)) {
    selfPlaced = settings.self_placed_flag_ids.map((x: any) => Math.floor(n(x))).filter((x: number) => x > 0);
  }
  const selfPlacedSet = new Set(selfPlaced);

  const summary: HoangCoRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    nextDelayMs: pollMs,
    phase: "break_flag",
    selfPlacedFlagIds: selfPlaced,
  };

  try {
    const status = await rpc("rpc_hoang_co_status", { p_character_id: characterId }, accessToken);
    const eventLive = status?.is_event_live === true || status?.season?.status === "event_live";
    const eligible = status?.eligibility?.eligible !== false;
    const clanId = String(status?.eligibility?.clan_id || status?.my_clan_score?.clan_id || "");

    if (onlyWhenEventLive && !eventLive) {
      summary.status = "NO_EVENT";
      summary.reason = "Event chưa live";
      summary.nextDelayMs = 5 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (!eligible || !clanId) {
      summary.status = "SKIPPED";
      summary.reason = "Không eligible / chưa clan";
      summary.nextDelayMs = 10 * 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const map = options.mapOverride ?? await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    let me = myPos(map);
    if (!me) {
      summary.status = "WAITING";
      summary.reason = "Chưa có vị trí map";
      summary.nextDelayMs = 60_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (me.dead) {
      summary.status = "WAITING";
      summary.reason = "Đang chết — chờ hồi";
      summary.nextDelayMs = 90_000;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    const flags = parseFlags(map);
    const cfgSiegeMax = Math.max(100, Math.floor(n(map?.config?.siege_max, 600)) || 600);
    const ownBuilt = flags.filter((f) => f.clan_id === clanId && f.is_built === true);
    const building = incompleteClanFlags(flags, clanId);
    // ── LUẬT chung: số cờ dở tối đa được phép cắm trước khi BẮT BUỘC xây xong ít nhất 1.
    const centralDowCap = 3;
    const allEnemy = flags.filter((f) => isEnemyFlag(f, clanId));
    let enemyFlags: any[] = filterEnemyFlags(flags, clanId, targetClan);
    // Mode central: phá SẠCH cờ địch trong box central trước, rồi chiếm central
    centralPlan = planCentralCapture({ map, clanId, centralRadius: settings.central_radius });
    if (breakMode === "central") {
      enemyFlags = centralPlan.enemyAround.filter((f: any) => isEnemyFlag(f, clanId));
    }
    // Luôn thử chiếm central khi: (1) đang ở mode central, HOẶC (2) hết cờ địch để phá mà central chưa chạm.
    // Fix: tránh bot cắm loang ra (expand) mãi mà không bao giờ đóng cầu vào tâm.
    const wantCentral = breakMode === "central" || (!enemyFlags.length && !centralPlan.ownReachCentral);

    logFlagScan(onLog, flags, clanId, enemyFlags, targetClan);

    // Transit: chỉ chờ nếu đang đi ĐÚNG chỗ; nếu near mà dest ≠ tâm cờ → hủy đường cũ (xử lý sau khi chọn enemy)

    if (!enemyFlags.length) {
      // Mode central: phá sạch cờ địch box central → tiến lên chiếm central
      if (wantCentral) {
        const cx = centralPlan.central.x;
        const cy = centralPlan.central.y;
        const holder = (centralPlan.central.holder_clan_id || "").toString();
        const distC = chebyshev(me.x, me.y, cx, cy);
        const ownReachCentral = centralPlan.ownReachCentral;

        // ── Chiếm central BẮT BUỘC phải có cờ đồng minh CHẠM central (cheby≤1).
        // Nếu chưa có → tự bridge: cắm chuỗi cờ tiến dần tới sát central, rồi mới công.
        if (!ownReachCentral) {
          // ── LUẬT: đủ centralDowCap cờ dở → BẮT BUỘC xây xong ít nhất 1 (gần central nhất) TRƯỚC KHI cắm tiếp.
          // Nếu không, bot sẽ cắm dở lung tung từ frontier cũ mà không bao giờ tiến được tới central.
          if (building.length >= centralDowCap && building.length > 0) {
            const buildFocus = [...building].sort(
              (a, b) =>
                chebyshev(a.pos_x, a.pos_y, cx, cy) - chebyshev(b.pos_x, b.pos_y, cx, cy)
            )[0];
            // XÂY TỪ XA trước; chỉ đi tới ô khi server bắt buộc đứng gần
            try {
              await rpc(
                "rpc_hoang_co_start_build",
                { p_character_id: characterId, p_flag_id: buildFocus.flag_id },
                accessToken
              );
              summary.built = 1;
            } catch (be: any) {
              const msg = String(be?.message || be?.data?.error || be?.data?.reason || "");
              const needMove = /quá xa|too far|khoảng cách|distance|gần|near|stand|adjac|kề/i.test(msg);
              if (needMove) {
                const bdist = manhattan(buildFocus.pos_x, buildFocus.pos_y, me.x, me.y);
                if (bdist > 0) {
                  await leaveDefense(characterId, accessToken, onLog);
                  const mv = await rpc(
                    "rpc_hoang_co_move",
                    { p_character_id: characterId, p_dest_x: buildFocus.pos_x, p_dest_y: buildFocus.pos_y },
                    accessToken
                  );
                  const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, bdist * 3)));
                  summary.moved = true;
                  summary.dest = { x: buildFocus.pos_x, y: buildFocus.pos_y };
                  summary.action = "move_to_build_central_bridge";
                  summary.status = "WAITING";
                  summary.etaSeconds = eta;
                  summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
                  summary.reason = `Central · đủ ${building.length}/${centralDowCap} cờ dở → (fallback) đi xây #${buildFocus.flag_id} @(${buildFocus.pos_x},${buildFocus.pos_y})`;
                  summary.finishedAt = new Date().toISOString();
                  return summary;
                }
                try {
                  await rpc("rpc_hoang_co_start_build", { p_character_id: characterId, p_flag_id: buildFocus.flag_id }, accessToken);
                  summary.built = 1;
                } catch (be2: any) {
                  onLog?.("WARN", `Central · start_build #${buildFocus.flag_id}: ${String(be2?.message || "").slice(0, 100)}`);
                }
              } else {
                onLog?.("WARN", `Central · start_build #${buildFocus.flag_id}: ${msg.slice(0, 100)}`);
              }
            }
            summary.action = "start_build_central_bridge";
            summary.status = "WAITING";
            summary.nextDelayMs = pollMs;
            summary.reason = `Central · đủ ${building.length}/${centralDowCap} cờ dở → xây #${buildFocus.flag_id} @(${buildFocus.pos_x},${buildFocus.pos_y}) trước khi cắm tiếp`;
            onLog?.("SUCCESS", summary.reason);
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          const cell = pickCentralPlaceCell({ map, clanId, me, cx, cy, maxHop: 3 });
          if (!cell) {
            // Không tìm được ô bridge: có thể CHƯA CÓ cờ BUILT làm mốc → ưu tiên xây cờ dở gần central nhất
            if (building.length > 0) {
              const buildFocus = [...building].sort(
                (a, b) =>
                  chebyshev(a.pos_x, a.pos_y, cx, cy) - chebyshev(b.pos_x, b.pos_y, cx, cy)
              )[0];
              // XÂY TỪ XA trước; chỉ đi tới ô khi server bắt buộc đứng gần
              try {
                await rpc(
                  "rpc_hoang_co_start_build",
                  { p_character_id: characterId, p_flag_id: buildFocus.flag_id },
                  accessToken
                );
                summary.built = 1;
              } catch (be: any) {
                const msg = String(be?.message || be?.data?.error || be?.data?.reason || "");
                const needMove = /quá xa|too far|khoảng cách|distance|gần|near|stand|adjac|kề/i.test(msg);
                if (needMove) {
                  const bdist = manhattan(buildFocus.pos_x, buildFocus.pos_y, me.x, me.y);
                  if (bdist > 0) {
                    await leaveDefense(characterId, accessToken, onLog);
                    const mv = await rpc(
                      "rpc_hoang_co_move",
                      { p_character_id: characterId, p_dest_x: buildFocus.pos_x, p_dest_y: buildFocus.pos_y },
                      accessToken
                    );
                    const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, bdist * 3)));
                    summary.moved = true;
                    summary.dest = { x: buildFocus.pos_x, y: buildFocus.pos_y };
                    summary.action = "move_to_build_central_bridge";
                    summary.status = "WAITING";
                    summary.etaSeconds = eta;
                    summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
                    summary.reason = `Central · bridge: (fallback) đi xây cờ dở #${buildFocus.flag_id} @(${buildFocus.pos_x},${buildFocus.pos_y}) → làm mốc chạm central`;
                    summary.finishedAt = new Date().toISOString();
                    return summary;
                  }
                  try {
                    await rpc("rpc_hoang_co_start_build", { p_character_id: characterId, p_flag_id: buildFocus.flag_id }, accessToken);
                    summary.built = 1;
                  } catch (be2: any) {
                    onLog?.("WARN", `Central · start_build #${buildFocus.flag_id}: ${String(be2?.message || "").slice(0, 100)}`);
                  }
                } else {
                  onLog?.("WARN", `Central · start_build #${buildFocus.flag_id}: ${msg.slice(0, 100)}`);
                }
              }
              summary.action = "start_build_central_bridge";
              summary.status = "WAITING";
              summary.nextDelayMs = pollMs;
              summary.reason = `Central · bridge: xây cờ dở #${buildFocus.flag_id} @(${buildFocus.pos_x},${buildFocus.pos_y}) → làm mốc chạm central`;
              onLog?.("SUCCESS", summary.reason);
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
            // Không có ô bridge & không cờ dở → tiến gần central để tái neo từ vị trí bot
            if (distC > 1) {
              await leaveDefense(characterId, accessToken, onLog);
              const mv = await rpc(
                "rpc_hoang_co_move",
                { p_character_id: characterId, p_dest_x: cx, p_dest_y: cy },
                accessToken
              );
              const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distC * 3)));
              summary.moved = true;
              summary.dest = { x: cx, y: cy };
              summary.action = "move_to_central_no_bridge";
              summary.status = "WAITING";
              summary.etaSeconds = eta;
              summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
              summary.reason = `Central · chưa có ô bridge & không cờ dở · tiến gần central @(${cx},${cy}) để cắm bridge`;
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
            summary.status = "WAITING";
            summary.reason = `Central · đã sát central nhưng chưa có cờ chạm (cheby≤1) · không tìm được ô bridge · chờ`;
            summary.nextDelayMs = 10_000;
            onLog?.("WARN", summary.reason);
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          const cellToC = chebyshev(cell.x, cell.y, cx, cy);
          // Chỉ xét né nếu địch ĐÈ LÊN ô bridge (safeR=0); địch cự ly 1 ở vùng central tranh chấp là bình thường → vẫn cắm.
          // Nếu fleeOn=false (user không bật né người) → KHÔNG chạy xa, chỉ chờ ô trống.
          if (!isPosSafeFromHostiles(map, clanId, cell.x, cell.y, 0, characterId)) {
            if (fleeOn) {
              const smart = pickSmartSafeDest({
                map, me, myClanId: clanId, myCharacterId: characterId,
                ownBuilt, building, nearEnemies: [], safeR: 2,
              });
              if (smart && (smart.x !== me.x || smart.y !== me.y)) {
                await leaveDefense(characterId, accessToken, onLog);
                const mv = await rpc(
                  "rpc_hoang_co_move",
                  { p_character_id: characterId, p_dest_x: smart.x, p_dest_y: smart.y },
                  accessToken
                );
                const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
                summary.moved = true;
                summary.dest = { x: smart.x, y: smart.y };
                summary.action = "flee_smart_central_bridge";
                summary.status = "WAITING";
                summary.etaSeconds = eta;
                summary.nextDelayMs = Math.max(2_500, eta * 1000 + 1500);
                summary.reason = `Central · ô bridge (${cell.x},${cell.y}) có địch đè → né ${smart.label} @(${smart.x},${smart.y})`;
                summary.finishedAt = new Date().toISOString();
                return summary;
              }
            }
            // fleeOn=false: địch đè lên ô → chờ địch dời thay vì chạy xa (giữ vị trí tiến central)
            summary.status = "WAITING";
            summary.reason = `Central · ô bridge (${cell.x},${cell.y}) có địch đè · chờ địch dời (không né)`;
            summary.nextDelayMs = 4_000;
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          // ── CẮM CỜ TỪ XA: game cho phép cắm tại ô hợp lệ mà KHÔNG cần đứng tại ô đó.
          // Thử cắm từ xa trước; chỉ fallback di chuyển tới ô khi server bắt buộc (lỗi quá xa/cần đứng gần).
          try {
            const res = await rpc(
              "rpc_hoang_co_place_flag",
              { p_character_id: characterId, p_pos_x: cell.x, p_pos_y: cell.y },
              accessToken
            );
            const flagId = Math.floor(n(res?.flag?.flag_id || res?.flag_id, 0));
            summary.placed = 1;
            summary.action = "place_central_bridge";
            summary.dest = cell;
            if (flagId) {
              summary.flagId = flagId;
              if (!selfPlacedSet.has(flagId)) {
                selfPlaced.push(flagId);
                selfPlacedSet.add(flagId);
              }
            }
            summary.selfPlacedFlagIds = [...selfPlaced];
            if (flagId) {
              try {
                await rpc(
                  "rpc_hoang_co_start_build",
                  { p_character_id: characterId, p_flag_id: flagId },
                  accessToken
                );
                summary.built = 1;
              } catch (be: any) {
                onLog?.("WARN", `Central · start_build fail: ${(be?.message || "").slice(0, 100)}`);
              }
            }
            summary.status = "WAITING";
            summary.nextDelayMs = pollMs;
            summary.reason = `Central · cắm TỪ XA @(${cell.x},${cell.y}) (cách central ${cellToC}) · xong check chạm central`;
            onLog?.("SUCCESS", summary.reason);
            summary.finishedAt = new Date().toISOString();
            return summary;
          } catch (pe: any) {
            const msg = String(pe?.message || pe?.data?.error || pe?.data?.reason || "");
            if (isPlaceFullError(pe)) {
              summary.status = "WAITING";
              summary.reason = `Central · flags FULL · chờ slot rảnh để bridge`;
              summary.nextDelayMs = 25_000;
              onLog?.("WARN", summary.reason);
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
            if (isPlaceTooCloseToEnemyError(pe) || isNotAdjacentError(pe)) {
              onLog?.("WARN", `Central · place @(${cell.x},${cell.y}) không hợp lệ (đè tâm/không kề) · thử ô khác`);
              summary.status = "WAITING";
              summary.nextDelayMs = 10_000;
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
            // Lỗi khác (có thể server bắt đứng gần ô) → fallback di chuyển tới ô rồi cắm
            const distPlace = manhattan(cell.x, cell.y, me.x, me.y);
            if (distPlace > 0) {
              if (me.inTransit && me.destX === cell.x && me.destY === cell.y && me.eta > 0) {
                summary.status = "WAITING";
                summary.action = "transit_to_place_central";
                summary.dest = cell;
                summary.etaSeconds = me.eta;
                summary.nextDelayMs = Math.max(2_000, me.eta * 1000 + 1500);
                summary.reason = `Central · (fallback) chờ tới ô bridge @(${cell.x},${cell.y}) (cách central ${cellToC}) · ETA ${me.eta}s`;
                summary.finishedAt = new Date().toISOString();
                return summary;
              }
              await leaveDefense(characterId, accessToken, onLog);
              const mv = await rpc(
                "rpc_hoang_co_move",
                { p_character_id: characterId, p_dest_x: cell.x, p_dest_y: cell.y },
                accessToken
              );
              const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distPlace * 3)));
              summary.moved = true;
              summary.dest = cell;
              summary.action = "move_to_place_central_bridge";
              summary.status = "WAITING";
              summary.etaSeconds = eta;
              summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
              summary.reason = `Central · (fallback) đi tới ô rồi cắm @(${cell.x},${cell.y}) (cách central ${cellToC})`;
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
            onLog?.("WARN", `Central · place @(${cell.x},${cell.y}) lỗi: ${msg.slice(0, 100)}`);
            summary.status = "WAITING";
            summary.nextDelayMs = 10_000;
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
        }

        // CÔNG CENTRAL TỪ XA trước; chỉ đi tới tâm khi server bắt buộc đứng gần
        try {
          const res = await rpc(
            "rpc_hoang_co_attack_position",
            { p_character_id: characterId, p_target_kind: "central", p_target_id: "central" },
            accessToken
          );
          const captured = res?.captured === true;
          const rem = n(res?.remaining_hp, -1);
          summary.action = "attack_position_central";
          summary.status = captured || rem === 0 ? "DONE" : "WAITING";
          summary.reason = captured || rem === 0
            ? `Central · đã chiếm central @(${cx},${cy})`
            : `Central · công central HP còn ${rem} · chờ tick sau`;
          summary.nextDelayMs = captured || rem === 0 ? 45_000 : 12_000;
        } catch (ce: any) {
          const msg = String(ce?.message || ce?.data?.error || ce?.data?.reason || "");
          const needMove = /quá xa|too far|khoảng cách|distance|gần|near|stand|adjac|kề|phải/i.test(msg);
          if (needMove && distC > 1) {
            await leaveDefense(characterId, accessToken, onLog);
            const mv = await rpc(
              "rpc_hoang_co_move",
              { p_character_id: characterId, p_dest_x: cx, p_dest_y: cy },
              accessToken
            );
            const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distC * 3)));
            summary.moved = true;
            summary.dest = { x: cx, y: cy };
            summary.action = "move_to_attack_central";
            summary.status = "WAITING";
            summary.etaSeconds = eta;
            summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
            summary.reason = `Central · (fallback) đi chiếm central @(${cx},${cy}) · ETA ${eta}s`;
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          summary.action = "attack_position_central";
          summary.status = "WAITING";
          summary.reason = `Central · công central lỗi: ${msg.slice(0, 120)}`;
          summary.nextDelayMs = 15_000;
        }
        onLog?.("INFO", `HC Phá cờ: ${summary.reason}`);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      // ── Chiếm resource (ưu tiên mỏ gần trước, rồi lan xa dần) — sau khi hết cờ địch (hoặc xong central)
      if (settings.auto_capture_resource !== false) {
        const resSum = await runHoangCoCaptureResource(options);
        if (resSum) return resSum;
      }

      summary.status = "DONE";
      summary.reason = targetClan
        ? `Không còn cờ bang "${targetClan}" (map có ${allEnemy.length} cờ địch khác / total ${flags.length})`
        : `Không còn cờ địch — Phá cờ nghỉ (total flags ${flags.length})`;
      summary.nextDelayMs = 45_000;
      onLog?.("INFO", `HC Phá cờ: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // ── Né cờ có người thủ clan khác (map.defenders) — tránh dính combat, qua cờ trống
    const skipDefended = settings.skip_defended_flags !== false;
    const defendedList = skipDefended
      ? enemyFlags.filter((f) => isFlagDefendedByOtherClan(map, f.flag_id, clanId))
      : [];
    const undefended = skipDefended
      ? enemyFlags.filter((f) => !isFlagDefendedByOtherClan(map, f.flag_id, clanId))
      : enemyFlags;

    if (defendedList.length > 0) {
      const sample = defendedList
        .slice(0, 5)
        .map((f) => {
          const defs = flagDefenders(map, f.flag_id, clanId);
          const names = defs
            .slice(0, 2)
            .map((d) => d.name)
            .join(",");
          return `#${f.flag_id}(${names || "?"}×${defs.length})`;
        })
        .join(" · ");
      onLog?.(
        "INFO",
        `HC Phá cờ · NÉ ${defendedList.length} cờ có thủ địch: ${sample}${defendedList.length > 5 ? "…" : ""} · còn ${undefended.length} cờ trống`
      );
    }

    if (!undefended.length) {
      summary.status = "WAITING";
      summary.reason = `Phá cờ · mọi cờ địch (${enemyFlags.length}) đều có người thủ clan khác · chờ trống / không xông`;
      summary.nextDelayMs = 15_000;
      // clear focus attack để không bám cờ có thủ
      summary.persistHint = { focus_attack_flag_id: null };
      onLog?.("WARN", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // ── ƯU TIÊN 1: mọi cờ địch ĐÃ NEAR (cờ built mình cheby≤1) → CHỈ PHÁ, cấm expand
    const focusAttackId = Math.floor(n(settings.focus_attack_flag_id, 0)) || 0;
    const nearPool = undefended.filter((f) => canReachEnemyFlag(ownBuilt, f));
    const forceAssaultFromPlace = settings.break_force_assault === true;
    let enemy: Flag;
    let assaultOnly = false;

    if (nearPool.length > 0 || forceAssaultFromPlace) {
      const pool = nearPool.length > 0 ? nearPool : undefended;
      enemy = sortBreakTargets(pool, me, ownBuilt, focusAttackId, cfgSiegeMax)[0];
      assaultOnly = nearPool.length > 0;
      onLog?.(
        "INFO",
        `HC Phá cờ · ⭐ ƯU TIÊN PHÁ: ${nearPool.length} cờ near` +
          (forceAssaultFromPlace && !nearPool.length ? " (force sau place-too-close)" : "") +
          ` · chọn #${enemy.flag_id} @(${enemy.pos_x},${enemy.pos_y}) [${enemy.clan_name || "?"}]`
      );
    } else {
      enemy = sortBreakTargets(undefended, me, ownBuilt, focusAttackId, cfgSiegeMax)[0];
    }

    const enemyName = enemy.clan_name || "?";
    const destX = enemy.pos_x;
    const destY = enemy.pos_y;
    const chebyMe = chebyshev(me.x, me.y, destX, destY);
    const distMe = manhattan(destX, destY, me.x, me.y);
    const onSpot = me.x === destX && me.y === destY;
    // territoryNear = cờ built mình chạm 3×3 địch (cheby≤1)
    const territoryNear = canReachEnemyFlag(ownBuilt, enemy) || assaultOnly;
    // Cờ dở đã sát địch — chỉ XÂY xong, KHÔNG cắm thêm vòng
    const ringBuilding = building.filter(
      (f) => chebyshev(f.pos_x, f.pos_y, destX, destY) <= 1
    );
    const reachableN = countReachableEnemies(ownBuilt, undefended);
    const siegeNow = flagProgress(enemy);
    const siegeMax = enemy.siege_max || cfgSiegeMax;
    const breakPct =
      enemy.is_built === true && siegeMax > 0
        ? Math.max(0, Math.min(100, Math.round(((siegeMax - siegeNow) / siegeMax) * 100)))
        : 0;
    const bridgeDist = ownBuilt.length
      ? Math.min(...ownBuilt.map((o) => chebyshev(o.pos_x, o.pos_y, destX, destY)))
      : 99;
    const defsHere = flagDefenders(map, enemy.flag_id, clanId);
    const atkHere = flagBesiegers(map, enemy.flag_id, clanId);

    /**
     * VÒNG TRÒN TỬ THẦN (log 07:28):
     * me@(13,52) chebyMe=1 CENTER@(14,53) near=false → CẮM @(13,53) thay vì MOVE tâm.
     * Fix: đứng kề tâm (chebyMe≤1) → LUÔN thử vào giữa + siege TRƯỚC, không cắm vành.
     */
    const standingByCenter = chebyMe <= 1;
    const near = territoryNear;
    // Khóa ASSAULT: territory near HOẶC đang đứng kề/tâm cờ địch
    const assaultLock = near || standingByCenter;
    const phaseLabel = assaultLock
      ? onSpot
        ? "ASSAULT_SIEGE"
        : "ASSAULT_MOVE_CENTER"
      : ringBuilding.length
        ? "BUILD_RING_ONLY"
        : "EXPAND_BRIDGE";

    onLog?.(
      "INFO",
      `HC Phá cờ · RESCAN #${enemy.flag_id} [${enemyName}] CENTER@(${destX},${destY})` +
        ` · me@(${me.x},${me.y}) chebyMe=${chebyMe}` +
        ` · territoryNear=${territoryNear} standByCenter=${standingByCenter}` +
        ` · bridgeCheby=${bridgeDist === 99 ? "∞" : bridgeDist}` +
        ` · dởSát=${ringBuilding.length} · lockAssault=${assaultLock}` +
        ` · thủ ${defsHere.length} · công ${atkHere.length}` +
        ` · trống ${undefended.length}/${enemyFlags.length}` +
        ` · siege ${siegeNow}/${siegeMax}` +
        (enemy.is_built === true ? ` · phá ${breakPct}%` : "") +
        ` · phase=${phaseLabel}`
    );

    summary.flagId = enemy.flag_id;
    summary.focusFlagId = enemy.flag_id;
    summary.siegePoints = siegeNow;
    summary.siegeMax = siegeMax;
    // Sticky target khi assault — orchestrator persist focus_attack_flag_id
    summary.persistHint = {
      ...(summary.persistHint || {}),
      focus_attack_flag_id: enemy.flag_id,
      break_phase: phaseLabel,
    };

    /**
     * EXPAND death circle (log 07:41): mỗi tick leave+move @(16,54) ETA 17s
     * → không bao giờ đứng yên place. Phải CHỜ transit xong (trừ ASSAULT hủy dest sai).
     */
    if (!assaultLock && me.inTransit && me.eta > 0) {
      summary.status = "WAITING";
      summary.action = "transit_expand";
      summary.etaSeconds = me.eta;
      summary.dest =
        me.destX !== undefined && me.destY !== undefined
          ? { x: me.destX, y: me.destY }
          : undefined;
      summary.nextDelayMs = Math.max(2_000, me.eta * 1000 + 1500);
      summary.reason =
        `Phá cờ · chờ tới nơi dest@(${me.destX ?? "?"},${me.destY ?? "?"})` +
        ` · ETA ${me.eta}s · (không spam move — tránh vòng quanh cửa mình)`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // ── 0) Né linh hoạt: địch gần → chạy GIỮ KHOẢNG CÁCH, đích an toàn (có thể xây/phá chỗ khác)
    const fleeCdUntil = n(settings.break_flee_cooldown_until, 0);
    const fleeReady = !fleeCdUntil || nowMs >= fleeCdUntil;
    const safeR = Math.max(fleeRadius, 2);
    if (fleeOn && fleeReady) {
      const hostiles = hostilesNear(map, clanId, me.x, me.y, fleeRadius, characterId);
      const hostilesClose = hostilesNear(map, clanId, me.x, me.y, 1, characterId);
      const assaultEmpty = assaultLock && defsHere.length === 0;
      // ASSAULT cờ trống: chỉ né khi địch dính sát; còn lại: địch trong r
      const shouldFlee = assaultEmpty ? hostilesClose.length >= 1 : hostiles.length > 0;
      if (shouldFlee) {
        const names = (assaultEmpty ? hostilesClose : hostiles)
          .slice(0, 3)
          .map((h) => h.name || h.clan_name || "?")
          .join(",");
        const smart = pickSmartSafeDest({
          map,
          me,
          myClanId: clanId,
          myCharacterId: characterId,
          ownBuilt,
          building,
          nearEnemies: nearPool.filter((f) => f.flag_id !== enemy.flag_id),
          safeR,
          preferWork: true,
        });
        if (smart && (smart.x !== me.x || smart.y !== me.y)) {
          await leaveDefense(characterId, accessToken, onLog);
          const mv = await rpc(
            "rpc_hoang_co_move",
            { p_character_id: characterId, p_dest_x: smart.x, p_dest_y: smart.y },
            accessToken
          );
          const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
          summary.moved = true;
          summary.dest = { x: smart.x, y: smart.y };
          summary.action = `flee_smart_${smart.kind}`;
          summary.status = "WAITING";
          summary.etaSeconds = eta;
          summary.nextDelayMs = Math.max(2_500, eta * 1000 + 1500);
          summary.reason =
            `Phá cờ · NÉ linh hoạt (${names}) → ${smart.label} @(${smart.x},${smart.y})` +
            ` · kind=${smart.kind} · ETA ${eta}s · an toàn r≥${safeR} · CD 12s rồi làm việc`;
          summary.persistHint = {
            focus_attack_flag_id: enemy.flag_id,
            break_flee_cooldown_until: nowMs + 12_000,
            break_phase: "FLEE_SMART",
          };
          onLog?.("WARN", summary.reason);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
      }
    }

    // Đích việc (phá/xây/cắm): từ chối nếu còn địch bám tại đích
    const destBlocked = (x: number, y: number) =>
      !isPosSafeFromHostiles(map, clanId, x, y, 1, characterId);

    // ── A) ASSAULT LOCK: territory near HOẶC me kề tâm (chebyMe≤1)
    // Log death circle: me kề tâm mà CẮM hop — SAI. Phải MOVE dest=CENTER trước.
    if (assaultLock) {
      onLog?.(
        "INFO",
        `HC Phá cờ · 🔒 ASSAULT #${enemy.flag_id} CENTER@(${destX},${destY}) me@(${me.x},${me.y})` +
          ` · territoryNear=${territoryNear} standByCenter=${standingByCenter}` +
          ` · ${onSpot ? "đúng tâm → SIEGE" : "FORCE MOVE tâm (cấm cắm vành)"}`
      );

      // Đang đi chỗ khác (hop/vành/resource) → hủy, ép về tâm
      if (
        me.inTransit &&
        me.destX !== undefined &&
        me.destY !== undefined &&
        (me.destX !== destX || me.destY !== destY)
      ) {
        onLog?.(
          "WARN",
          `HC Phá cờ · 🔒 hủy dest@(${me.destX},${me.destY}) → FORCE CENTER@(${destX},${destY})`
        );
      } else if (me.inTransit && me.destX === destX && me.destY === destY && me.eta > 0) {
        summary.status = "WAITING";
        summary.action = "transit";
        summary.etaSeconds = me.eta;
        summary.dest = { x: destX, y: destY };
        summary.nextDelayMs = Math.max(2_000, me.eta * 1000 + 1200);
        summary.reason = `Phá cờ · 🔒 đang vào GIỮA #${enemy.flag_id} @(${destX},${destY}) · ETA ${me.eta}s`;
        onLog?.("INFO", summary.reason);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }

      if (!onSpot) {
        // Tâm cờ còn địch bám (player) → không xông; chuyển cờ near khác hoặc né
        if (destBlocked(destX, destY) && defsHere.length > 0) {
          const alt = nearPool.find(
            (f) =>
              f.flag_id !== enemy.flag_id &&
              !destBlocked(f.pos_x, f.pos_y) &&
              !isFlagDefendedByOtherClan(map, f.flag_id, clanId)
          );
          if (alt) {
            summary.status = "WAITING";
            summary.reason = `Phá cờ · tâm #${enemy.flag_id} có địch · chuyển #${alt.flag_id} an toàn`;
            summary.nextDelayMs = 3_000;
            summary.persistHint = { focus_attack_flag_id: alt.flag_id, break_force_assault: true };
            onLog?.("WARN", summary.reason);
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
        }
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc(
          "rpc_hoang_co_move",
          { p_character_id: characterId, p_dest_x: destX, p_dest_y: destY },
          accessToken
        );
        const gotX = Math.floor(n(mv?.dest_x, destX));
        const gotY = Math.floor(n(mv?.dest_y, destY));
        const fromX = Math.floor(n(mv?.from_x, me.x));
        const fromY = Math.floor(n(mv?.from_y, me.y));
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distMe * 3)));
        const distMv = Math.floor(n(mv?.distance, distMe));
        summary.moved = true;
        summary.dest = { x: gotX, y: gotY };
        summary.action = "move_to_enemy_flag_center";
        summary.status = "WAITING";
        summary.etaSeconds = eta;
        summary.nextDelayMs = Math.max(2_000, eta * 1000 + 1200);
        const destMismatch = gotX !== destX || gotY !== destY;
        summary.reason =
          `Phá cờ · 🔒 FORCE GIỮA #${enemy.flag_id}` +
          ` from@(${fromX},${fromY}) → dest@(${gotX},${gotY}) = flag@(${destX},${destY})` +
          (destMismatch ? ` ⚠` : " ✓") +
          ` · ETA ${eta}s dist ${distMv}`;
        summary.persistHint = {
          focus_attack_flag_id: enemy.flag_id,
          break_phase: "ASSAULT_MOVE_CENTER",
        };
        onLog?.(destMismatch ? "WARN" : "INFO", summary.reason, { mv });
        summary.finishedAt = new Date().toISOString();
        return summary;
      }

      try {
        // QUAN TRỌNG: KHÔNG leave_defense khi đang đứng tâm siege tiếp.
        // leave_defense gỡ pin → siege bị ngắt → siege_points kẹt 600 (log 09:04).
        // Chỉ leave khi rời cờ / đổi target / flee.
        const res = await rpc(
          "rpc_hoang_co_siege_flag",
          { p_character_id: characterId, p_flag_id: enemy.flag_id },
          accessToken
        );
        const side = String(res?.side || "");
        const defN = Math.floor(n(res?.defender_count, 0));
        const atkN = Math.floor(n(res?.besieger_count, 0));
        const pinned = res?.pinned === true;
        summary.side = side || undefined;
        summary.siegePoints = n(res?.siege_points, siegeNow);
        summary.siegeMax = n(res?.siege_max, siegeMax);
        summary.status = "WAITING";
        const sp = summary.siegePoints ?? siegeNow;
        const sm = summary.siegeMax ?? siegeMax;
        const pct =
          enemy.is_built === true && sm > 0
            ? Math.max(0, Math.min(100, Math.round(((sm - sp) / sm) * 100)))
            : 0;

        if (skipDefended && side === "attack" && defN > 0) {
          await leaveDefense(characterId, accessToken, onLog);
          summary.action = "skip_defended_flag";
          summary.nextDelayMs = 5_000;
          summary.reason = `Phá cờ · NÉ #${enemy.flag_id} có ${defN} thủ · leave → cờ trống`;
          summary.persistHint = { focus_attack_flag_id: null };
          onLog?.("WARN", summary.reason, { res });
          summary.finishedAt = new Date().toISOString();
          return summary;
        }

        summary.action = "siege_flag_attack";
        // Cờ sắp vỡ: chip nhanh, bám focus
        const almostDead = sp > 0 && sp <= Math.max(80, sm * 0.15);
        // Giữ pin: delay vừa phải, không leave
        summary.nextDelayMs = almostDead ? 4_000 : Math.max(5_000, pollMs - 3_000);
        if (side && side !== "attack") {
          onLog?.("WARN", `HC Phá cờ · side=${side} (cần attack) · #${enemy.flag_id}`);
        }
        summary.reason =
          `SIEGE 🔒 #${enemy.flag_id} [${enemyName}] @(${destX},${destY})` +
          ` · side=${side || "?"} · atk ${atkN} / def ${defN}` +
          ` · pinned=${pinned}` +
          ` · siege còn ${sp}/${sm}` +
          (enemy.is_built === true ? ` · phá ${pct}%` : "") +
          (almostDead ? " · dứt điểm" : "") +
          " · giữ pin (no leave)";
        onLog?.("SUCCESS", summary.reason, { res });
        summary.persistHint = {
          last_destroyed_flag_pos: { x: destX, y: destY },
          last_destroyed_flag_id: enemy.flag_id,
          // Bám cờ đang phá đến khi biến mất (không nhảy sang expand sớm)
          focus_attack_flag_id: enemy.flag_id,
          break_phase: "ASSAULT_SIEGE",
          break_force_assault: almostDead ? true : false,
        };
        // Heartbeat nhẹ — không leave_defense
        try {
          await rpc(
            "rpc_hoang_co_heartbeat",
            { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
            accessToken
          );
        } catch {
          /* ignore */
        }
        summary.finishedAt = new Date().toISOString();
        return summary;
      } catch (e: any) {
        if (isNotNearError(e)) {
          // Đứng đúng tâm nhưng server not_near → cần bridge (cờ mình cheby>1)
          // CHỈ expand nếu !territoryNear; nếu territoryNear thì chờ sync, không cắm vòng
          onLog?.(
            "WARN",
            `HC Phá cờ · server not_near #${enemy.flag_id} @ tâm` +
              ` · territoryNear=${territoryNear} bridgeCheby=${bridgeDist}` +
              (territoryNear
                ? " · chờ sync (không cắm vòng)"
                : " · expand bridge từ cờ mình (không đứng vành cắm)")
          );
          if (territoryNear && ringBuilding.length === 0) {
            summary.status = "WAITING";
            summary.reason = `Phá cờ · not_near #${enemy.flag_id} @ tâm · territoryNear nhưng server từ chối · chờ 10s`;
            summary.nextDelayMs = 10_000;
            summary.persistHint = {
              focus_attack_flag_id: enemy.flag_id,
              break_phase: "WAIT_NEAR_SYNC",
            };
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          // !territoryNear + đứng kề tâm: rời tâm, về neo cờ mình để cắm hop ĐÚNG kề built
          // (không cắm ô vành từ vị trí me — log cắm (13,53) khi me (13,52) là death circle)
          if (standingByCenter && !territoryNear && ownBuilt.length > 0) {
            const home = [...ownBuilt].sort(
              (a, b) =>
                chebyshev(a.pos_x, a.pos_y, destX, destY) -
                chebyshev(b.pos_x, b.pos_y, destX, destY)
            )[0];
            if (home && (me.x !== home.pos_x || me.y !== home.pos_y)) {
              await leaveDefense(characterId, accessToken, onLog);
              const mv = await rpc(
                "rpc_hoang_co_move",
                { p_character_id: characterId, p_dest_x: home.pos_x, p_dest_y: home.pos_y },
                accessToken
              );
              const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
              summary.moved = true;
              summary.dest = { x: home.pos_x, y: home.pos_y };
              summary.action = "move_to_bridge_anchor";
              summary.status = "WAITING";
              summary.etaSeconds = eta;
              summary.nextDelayMs = Math.max(2_500, eta * 1000 + 1500);
              summary.reason =
                `Phá cờ · not_near @ tâm #${enemy.flag_id} → về neo #${home.flag_id}` +
                ` @(${home.pos_x},${home.pos_y}) cắm hop kề · ETA ${eta}s`;
              onLog?.("INFO", summary.reason);
              summary.finishedAt = new Date().toISOString();
              return summary;
            }
          }
          // fall through expand (build ring / place from anchor)
        } else {
          summary.status = "ERROR";
          summary.reason = `siege_flag #${enemy.flag_id}: ${(e?.message || e).toString().slice(0, 140)}`;
          summary.nextDelayMs = 12_000;
          onLog?.("ERROR", summary.reason);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
      }
    } else {
      onLog?.(
        "INFO",
        `HC Phá cờ · xa cờ địch #${enemy.flag_id} · bridgeCheby=${bridgeDist === 99 ? "∞" : bridgeDist}` +
          (ringBuilding.length
            ? ` · dở sát ${ringBuilding.length} → chỉ XÂY`
            : ` · expand bridge`)
      );
    }

    // Có BẤT KỲ cờ near khác → không expand, đợi tick (assault pool)
    if (nearPool.length > 0 && !canReachEnemyFlag(ownBuilt, enemy) && ringBuilding.length === 0) {
      summary.status = "WAITING";
      summary.reason = `Phá cờ · còn ${nearPool.length} cờ near · ưu tiên phá, không expand`;
      summary.nextDelayMs = 5_000;
      summary.persistHint = { focus_attack_flag_id: nearPool[0].flag_id, break_force_assault: false };
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // ── B) CHƯA NEAR → bridge (cấm khi assaultOnly / nearPool đang có built)
    // Có cờ dở sát: CHỈ xây. Place fail too_close_enemy → force assault.
    const chipOpts = {
      map,
      me,
      clanId,
      characterId,
      accessToken,
      settings: { ...settings, attack_near_resource: settings.attack_near_resource !== false },
      onLog,
      summary,
    };

    if (!hopOn) {
      summary.status = "WAITING";
      summary.reason =
        `Phá cờ · not_near #${enemy.flag_id} · bật break_hop để cắm/xây mở địa bàn`;
      summary.nextDelayMs = 20_000;
      onLog?.("WARN", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Server not_adjacent: CHỈ hop=1 (kề cờ built). Bỏ hop=2 (log hop≤2 → cắm (13,53) từ neo (14,51) cheby=2 = sai)
    const hopMax = 1;
    const plan = planBridgeToEnemy(ownBuilt, building, enemy, hopMax);
    const cfgMaxBuild = Math.max(1, Math.floor(n(map?.config?.flag_building_max, 3)) || 3);
    const usedFlags = Math.floor(n(map?.config?.used_flags ?? map?.used_flags, ownBuilt.length + building.length));
    const maxFlags = Math.floor(n(map?.config?.max_flags ?? map?.max_flags, 0));
    const flagsFull = maxFlags > 0 && usedFlags >= maxFlags;
    const buildSlotsFull = building.length >= cfgMaxBuild;

    /**
     * Chỉ XÂY cờ dở GIÚP bridge tới địch (log 08:46: xây #9939 cheby=4 trong khi neo cheby=3 = sai).
     * - dở sát (cheby≤1): luôn xây
     * - dở cheby ≤ bridgeCheby hiện tại: có ích (tiến/giữ)
     * - dở xa hơn neo built: BỎ QUA → ưu tiên CẮM hop từ neo
     */
    const bridgeChebyNow = plan.bridgeCheby < 99 ? plan.bridgeCheby : 99;
    const helpfulBuilding = building.filter((f) => {
      const d = chebyshev(f.pos_x, f.pos_y, destX, destY);
      if (d <= 1) return true;
      if (bridgeChebyNow >= 99) return true;
      return d <= bridgeChebyNow;
    });
    const buildingToward = [...helpfulBuilding].sort((a, b) => {
      const da = chebyshev(a.pos_x, a.pos_y, destX, destY);
      const db = chebyshev(b.pos_x, b.pos_y, destX, destY);
      if (da !== db) return da - db;
      const sa = selfPlacedSet.has(a.flag_id) ? 0 : 1;
      const sb = selfPlacedSet.has(b.flag_id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      // gần me hơn (đỡ đi xa)
      return manhattan(a.pos_x, a.pos_y, me.x, me.y) - manhattan(b.pos_x, b.pos_y, me.x, me.y);
    });
    const skippedFarBuild = building.length - helpfulBuilding.length;

    const anchor = plan.anchor;
    const noMorePlace = ringBuilding.length > 0; // đã có dở sát → không cắm vòng nữa
    onLog?.(
      "INFO",
      `HC Phá cờ · PLAN bridge → #${enemy.flag_id} @(${destX},${destY})` +
        ` · neo ${anchor ? `#${anchor.flag_id}@(${anchor.pos_x},${anchor.pos_y})` : "không"}` +
        ` cheby=${plan.bridgeCheby === 99 ? "∞" : plan.bridgeCheby}` +
        ` · cần ~${plan.hopsLeft} hop (≤${hopMax} ô/lần)` +
        ` · dở hữu ích ${helpfulBuilding.length}/${building.length}` +
        (skippedFarBuild > 0 ? ` (bỏ ${skippedFarBuild} dở xa hơn neo)` : "") +
        ` · flags ${usedFlags}${maxFlags ? `/${maxFlags}` : ""}` +
        (flagsFull ? " FULL" : "") +
        ` · phase: ${buildingToward.length ? "XÂY" : noMorePlace ? "CHỜ_XÂY" : flagsFull || buildSlotsFull ? "XÂY/CHỜ" : "CẮM"}`
    );

    // Resource chip khi expand — không chen nếu đang có cờ dở sát (ưu tiên xây xong để phá)
    if (!ringBuilding.length) {
      const chip = await tryChipNearResource(chipOpts);
      if (chip) return chip;
    }

    // Helper: build 1 cờ dở
    const doBuildBridge = async (focus: Flag): Promise<HoangCoRunSummary> => {
      const toE = chebyshev(focus.pos_x, focus.pos_y, destX, destY);
      summary.focusFlagId = focus.flag_id;
      summary.flagId = focus.flag_id;
      summary.siegePoints = flagProgress(focus);
      summary.siegeMax = focus.siege_max || cfgSiegeMax;
      onLog?.(
        "INFO",
        `HC Phá cờ · XÂY bridge #${focus.flag_id} @(${focus.pos_x},${focus.pos_y})` +
          ` ${flagProgress(focus)}/${focus.siege_max || cfgSiegeMax}` +
          ` · cheby→địch ${toE} · plan còn ~${plan.hopsLeft} hop sau khi built`
      );
      const dist = manhattan(focus.pos_x, focus.pos_y, me.x, me.y);
      if (dist > 0) {
        if (destBlocked(focus.pos_x, focus.pos_y)) {
          onLog?.(
            "WARN",
            `HC Phá cờ · ô xây #${focus.flag_id} @(${focus.pos_x},${focus.pos_y}) có địch · chọn cờ dở khác / né`
          );
          const altBuild = buildingToward.find(
            (b) =>
              b.flag_id !== focus.flag_id &&
              !destBlocked(b.pos_x, b.pos_y)
          );
          if (altBuild) return await doBuildBridge(altBuild);
          const smart = pickSmartSafeDest({
            map,
            me,
            myClanId: clanId,
            myCharacterId: characterId,
            ownBuilt,
            building: buildingToward.filter((b) => b.flag_id !== focus.flag_id),
            nearEnemies: nearPool,
            safeR: 2,
          });
          if (smart) {
            await leaveDefense(characterId, accessToken, onLog);
            const mv = await rpc(
              "rpc_hoang_co_move",
              { p_character_id: characterId, p_dest_x: smart.x, p_dest_y: smart.y },
              accessToken
            );
            const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
            summary.moved = true;
            summary.dest = { x: smart.x, y: smart.y };
            summary.action = "flee_smart_build_blocked";
            summary.status = "WAITING";
            summary.etaSeconds = eta;
            summary.nextDelayMs = Math.max(2_500, eta * 1000 + 1500);
            summary.reason = `Phá cờ · xây bị chặn → ${smart.label} @(${smart.x},${smart.y}) · ETA ${eta}s`;
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
        }
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc(
          "rpc_hoang_co_move",
          { p_character_id: characterId, p_dest_x: focus.pos_x, p_dest_y: focus.pos_y },
          accessToken
        );
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
        summary.moved = true;
        summary.dest = { x: focus.pos_x, y: focus.pos_y };
        summary.action = "move_to_build_bridge";
        summary.status = "WAITING";
        summary.etaSeconds = eta;
        summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
        summary.reason = `Phá cờ · đi xây #${focus.flag_id} @(${focus.pos_x},${focus.pos_y}) bridge→#${enemy.flag_id} · ETA ${eta}s`;
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      // Đang đứng cờ dở: resource kề (không thủ địch) → chip rồi mới start_build
      {
        const chipOnBuild = await tryChipNearResource(chipOpts);
        if (chipOnBuild) return chipOnBuild;
      }
      try {
        await rpc(
          "rpc_hoang_co_start_build",
          { p_character_id: characterId, p_flag_id: focus.flag_id },
          accessToken
        );
        summary.built = 1;
        summary.action = "start_build_bridge";
        summary.status = "WAITING";
        summary.nextDelayMs = pollMs;
        summary.reason = `Phá cờ · đang xây bridge #${focus.flag_id} · ${flagProgress(focus)}/${focus.siege_max || cfgSiegeMax} · xong check near #${enemy.flag_id}`;
        onLog?.("SUCCESS", summary.reason);
      } catch (e: any) {
        summary.status = "WAITING";
        summary.nextDelayMs = pollMs;
        summary.reason = `Phá cờ · start_build #${focus.flag_id}: ${(e?.message || "").slice(0, 100)}`;
        onLog?.("WARN", summary.reason);
      }
      try {
        await rpc(
          "rpc_hoang_co_heartbeat",
          { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
          accessToken
        );
      } catch {
        /* ignore */
      }
      summary.finishedAt = new Date().toISOString();
      return summary;
    };

    // (1) Có cờ dở → XÂY trước; cờ dở sát địch → bắt buộc xong rồi phá (không cắm vòng)
    if (buildingToward.length > 0) {
      return await doBuildBridge(buildingToward[0]);
    }

    // (1b) Vừa có dở sát nhưng list rỗng race → chờ
    if (noMorePlace) {
      summary.status = "WAITING";
      summary.reason = `Phá cờ · cờ sát #${enemy.flag_id} đang xử lý · chờ built → near → vào giữa phá`;
      summary.nextDelayMs = 8_000;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // (2) Slot xây full (đủ 3 cờ đồng minh CHƯA xây xong) → KHÔNG THỂ cắm thêm.
    // Server cấm đặt khi đã có 3 cờ dở. Ưu tiên XÂY XONG ít nhất 1 cờ dở (gần địch
    // nhất) để có cờ built làm mỏ neo mở rộng, tiếp cận cờ đối phương rồi mới phá tiếp.
    if (buildSlotsFull) {
      const buildToFree = [...building].sort((a, b) => {
        const da = chebyshev(a.pos_x, a.pos_y, destX, destY);
        const db = chebyshev(b.pos_x, b.pos_y, destX, destY);
        if (da !== db) return da - db;
        const sa = selfPlacedSet.has(a.flag_id) ? 0 : 1;
        const sb = selfPlacedSet.has(b.flag_id) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return manhattan(a.pos_x, a.pos_y, me.x, me.y) - manhattan(b.pos_x, b.pos_y, me.x, me.y);
      })[0];
      if (buildToFree) {
        onLog?.(
          "INFO",
          `Phá cờ · 3 cờ dở đủ slot (limit ${cfgMaxBuild}) · ƯU TIÊN xây xong #${buildToFree.flag_id}` +
            ` @(${buildToFree.pos_x},${buildToFree.pos_y}) (gần địch nhất) để có cờ built mở rộng → rồi phá tiếp`
        );
        return await doBuildBridge(buildToFree);
      }
      summary.status = "WAITING";
      summary.reason = `Phá cờ · đủ ${building.length}/${cfgMaxBuild} cờ đang xây · chờ built → #${enemy.flag_id}`;
      summary.nextDelayMs = pollMs;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    if (flagsFull) {
      summary.status = "WAITING";
      summary.reason = `Phá cờ · flags FULL ${usedFlags}/${maxFlags} · không cắm · chờ · cheby=${plan.bridgeCheby}`;
      summary.nextDelayMs = 25_000;
      onLog?.("WARN", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // (3) Cắm 1 hop KỀ cờ mình — chỉ khi chưa có bridge sát
    let reclaimPos: Pos | null = null;
    const ld = settings.last_destroyed_flag_pos;
    if (ld && Number.isFinite(Number(ld.x)) && Number.isFinite(Number(ld.y))) {
      reclaimPos = { x: Math.floor(Number(ld.x)), y: Math.floor(Number(ld.y)) };
    }

    const excludePlace = new Set<string>();
    // Ô đã fail not_adjacent trong session (persist nhẹ qua settings)
    if (Array.isArray(settings.break_place_exclude)) {
      for (const k of settings.break_place_exclude) {
        if (k) excludePlace.add(String(k));
      }
    }

    const tryPlaceAt = async (
      cell: Pos
    ): Promise<"ok" | "not_adjacent" | "full" | "other" | "too_close_enemy"> => {
      const cellToEnemy = chebyshev(cell.x, cell.y, destX, destY);
      const progressNote =
        plan.bridgeCheby < 99 && cellToEnemy < plan.bridgeCheby
          ? `tiến ${plan.bridgeCheby}→${cellToEnemy}`
          : `cheby→địch ${cellToEnemy}`;
      onLog?.(
        "INFO",
        `HC Phá cờ · CẮM hop @(${cell.x},${cell.y}) · ${progressNote}` +
          ` · kề cờ mình (hop≤${hopMax}) · sau built ${cellToEnemy <= 1 ? "NEAR phá" : "hop tiếp"} #${enemy.flag_id}`
      );

      const distPlace = manhattan(cell.x, cell.y, me.x, me.y);

      if (distPlace > 0) {
        // Ô cắm còn địch → không chạy vào
        if (destBlocked(cell.x, cell.y)) {
          onLog?.("WARN", `HC Phá cờ · ô cắm @(${cell.x},${cell.y}) có địch · bỏ`);
          return "other";
        }
        // Đang transit đúng ô → chờ (không leave_defense / move lại)
        if (
          me.inTransit &&
          me.destX === cell.x &&
          me.destY === cell.y &&
          me.eta > 0
        ) {
          summary.status = "WAITING";
          summary.action = "transit_to_place";
          summary.dest = cell;
          summary.etaSeconds = me.eta;
          summary.nextDelayMs = Math.max(2_000, me.eta * 1000 + 1500);
          summary.reason = `Phá cờ · chờ tới ô cắm @(${cell.x},${cell.y}) · ETA ${me.eta}s`;
          summary.persistHint = {
            break_pending_place: { x: cell.x, y: cell.y },
            focus_attack_flag_id: enemy.flag_id,
          };
          summary.finishedAt = new Date().toISOString();
          return "ok";
        }
        await leaveDefense(characterId, accessToken, onLog);
        const mv = await rpc(
          "rpc_hoang_co_move",
          { p_character_id: characterId, p_dest_x: cell.x, p_dest_y: cell.y },
          accessToken
        );
        const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, distPlace * 3)));
        summary.moved = true;
        summary.dest = cell;
        summary.action = "move_to_place_bridge";
        summary.status = "WAITING";
        summary.etaSeconds = eta;
        summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
        summary.reason = `Phá cờ · đi cắm hop @(${cell.x},${cell.y}) → #${enemy.flag_id} · ETA ${eta}s · (1 lần, chờ tới)`;
        summary.persistHint = {
          break_pending_place: { x: cell.x, y: cell.y },
          focus_attack_flag_id: enemy.flag_id,
          break_phase: "MOVE_PLACE",
        };
        summary.finishedAt = new Date().toISOString();
        return "ok";
      }

      // Đứng đúng ô → place ngay (clear pending)
      try {
        const res = await rpc(
          "rpc_hoang_co_place_flag",
          { p_character_id: characterId, p_pos_x: cell.x, p_pos_y: cell.y },
          accessToken
        );
        const flagId = Math.floor(n(res?.flag?.flag_id || res?.flag_id, 0));
        summary.placed = 1;
        summary.action = "place_bridge";
        summary.dest = cell;
        if (flagId) {
          summary.flagId = flagId;
          summary.focusFlagId = flagId;
          if (!selfPlacedSet.has(flagId)) {
            selfPlaced.push(flagId);
            selfPlacedSet.add(flagId);
          }
        }
        summary.selfPlacedFlagIds = [...selfPlaced];
        const sp = n(res?.flag?.siege_points, 0);
        const sm = n(res?.flag?.siege_max, cfgSiegeMax) || cfgSiegeMax;
        const used = n(res?.used_flags, usedFlags);
        const maxF = n(res?.max_flags, maxFlags);
        summary.siegePoints = sp;
        summary.siegeMax = sm;
        onLog?.(
          "SUCCESS",
          `Phá cờ · đã cắm hop #${flagId || "?"} @(${cell.x},${cell.y}) · ${progressNote}` +
            ` · flags ${used}${maxF ? `/${maxF}` : ""} → xây rồi check near #${enemy.flag_id}`
        );
        if (flagId) {
          try {
            await rpc(
              "rpc_hoang_co_start_build",
              { p_character_id: characterId, p_flag_id: flagId },
              accessToken
            );
            summary.built = 1;
            onLog?.("SUCCESS", `Phá cờ · start_build hop #${flagId}`);
          } catch (be: any) {
            onLog?.("WARN", `Phá cờ · start_build fail: ${(be?.message || "").slice(0, 100)}`);
          }
        }
        summary.persistHint = {
          last_destroyed_flag_pos: null,
          last_destroyed_flag_id: null,
          break_place_exclude: [],
          break_pending_place: null,
          focus_attack_flag_id: enemy.flag_id,
        };
        summary.status = "WAITING";
        summary.nextDelayMs = pollMs;
        summary.reason = `Phá cờ · cắm+xây hop #${flagId} @(${cell.x},${cell.y}) · sau built check near #${enemy.flag_id}`;
        return "ok";
      } catch (e: any) {
        if (isPlaceTooCloseToEnemyError(e)) {
          onLog?.(
            "WARN",
            `HC Phá cờ · place @(${cell.x},${cell.y}) đè tâm/trùng cờ địch (${(e?.message || "").toString().slice(0, 60)})` +
              ` → bỏ ô này, thử ô khác`
          );
          return "other";
        }
        if (isNotAdjacentError(e)) {
          onLog?.(
            "WARN",
            `HC Phá cờ · not_adjacent @(${cell.x},${cell.y}) — không kề cờ mình · thử ô khác`
          );
          return "not_adjacent";
        }
        if (isPlaceFullError(e)) return "full";
        onLog?.("WARN", `HC Phá cờ · place @(${cell.x},${cell.y}): ${(e?.message || e).toString().slice(0, 100)}`);
        return "other";
      }
    };

    // Sticky ô cắm: ưu tiên pending / reclaim, không đổi ô mỗi tick khi đang đi
    let stickyCell: Pos | null = null;
    const pend = settings.break_pending_place;
    if (pend && Number.isFinite(Number(pend.x)) && Number.isFinite(Number(pend.y))) {
      const px = Math.floor(Number(pend.x));
      const py = Math.floor(Number(pend.y));
      if (!excludePlace.has(cellKey(px, py))) {
        stickyCell = { x: px, y: py };
        onLog?.("DEBUG", `HC Phá cờ · sticky ô cắm @(${px},${py})`);
      }
    }

    // Thử tối đa 4 ô
    let placedOk = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cell =
        attempt === 0 && stickyCell
          ? stickyCell
          : pickSiegePlaceCell({
              map,
              clanId,
              me,
              enemy,
              maxHop: 3,
              reclaimPos: attempt === 0 ? reclaimPos : null,
              excludeCells: excludePlace,
            });
      if (!cell) break;

      const result = await tryPlaceAt(cell);
      if (result === "ok") {
        placedOk = true;
        if (summary.finishedAt) {
          summary.selfPlacedFlagIds = [...selfPlaced];
          return summary;
        }
        break;
      }
      // Place quá gần địch → DỪNG expand, force assault tick sau (phá vòng tròn)
      if (result === "too_close_enemy") {
        summary.status = "WAITING";
        summary.action = "place_too_close_switch_assault";
        summary.reason =
          `Phá cờ · cắm @(${cell.x},${cell.y}) quá gần địch → DỪNG CẮM · chuyển PHÁ #${enemy.flag_id}` +
          ` (và cờ near khác)`;
        summary.nextDelayMs = 3_000;
        summary.persistHint = {
          break_force_assault: true,
          focus_attack_flag_id: enemy.flag_id,
          break_place_exclude: [...excludePlace, cellKey(cell.x, cell.y)].slice(-40),
          break_phase: "SWITCH_ASSAULT",
        };
        onLog?.("WARN", summary.reason);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      if (result === "not_adjacent" || result === "other") {
        excludePlace.add(cellKey(cell.x, cell.y));
        summary.persistHint = {
          ...(summary.persistHint || {}),
          break_place_exclude: [...excludePlace].slice(-40),
        };
        if (result === "other") break;
        continue;
      }
      if (result === "full") {
        onLog?.("WARN", `HC Phá cờ · place FULL → XÂY nếu có dở`);
        if (building.length > 0) return await doBuildBridge(buildingToward[0] || building[0]);
        summary.status = "WAITING";
        summary.reason = `Phá cờ · flags FULL · không cắm · chờ slot`;
        summary.nextDelayMs = 25_000;
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
    }

    if (!placedOk && summary.action !== "place_bridge" && summary.action !== "move_to_place_bridge") {
      if (building.length > 0) {
        return await doBuildBridge(buildingToward[0] || building[0]);
      }
      // Không cắm được → nếu đang sát địch (cheby me hoặc bridge ≤2) thử assault
      if (chebyMe <= 2 || plan.bridgeCheby <= 2) {
        summary.status = "WAITING";
        summary.reason =
          `Phá cờ · không cắm được gần #${enemy.flag_id} · force PHÁ (bridgeCheby=${plan.bridgeCheby})`;
        summary.nextDelayMs = 3_000;
        summary.persistHint = {
          break_force_assault: true,
          focus_attack_flag_id: enemy.flag_id,
          break_place_exclude: [...excludePlace].slice(-40),
        };
        onLog?.("WARN", summary.reason);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      summary.status = "WAITING";
      summary.reason =
        `Phá cờ · không cắm được (not_adjacent / hết ô)` +
        ` · hop≤${hopMax} · neo cheby=${plan.bridgeCheby} · #${enemy.flag_id}`;
      summary.nextDelayMs = 20_000;
      summary.persistHint = {
        ...(summary.persistHint || {}),
        break_place_exclude: [...excludePlace].slice(-40),
      };
      onLog?.("WARN", summary.reason);
    }

    summary.selfPlacedFlagIds = [...selfPlaced];
    try {
      await rpc(
        "rpc_hoang_co_heartbeat",
        { p_character_id: characterId, p_pos_x: me.x, p_pos_y: me.y },
        accessToken
      );
    } catch {
      /* ignore */
    }
    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 45_000;
    onLog?.("ERROR", `HC Phá cờ error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/**
 * Entry 1 feature Hoàng Cổ (1 timer):
 * 0) Phá cờ (cắm-xây-phá) nếu bật auto_break_flag
 * 1) Cắm/Xây (tuỳ chọn)
 * 2) Thủ cờ map (tuỳ chọn)
 * 3) Central — 1 option auto_central: Thủ (còn lock) → hết lock → Công → Thủ lại
 */
export async function runHoangCoAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;

  // Mission riêng: Phá cờ (cắm → xây → phá cờ địch gần nhất)
  if (settings.auto_break_flag === true || settings.mission === "pha_co" || settings.mission === "break_flag") {
    onLog?.("INFO", "Hoàng Cổ · mission: Phá cờ (scan near→phá · chưa near→cắm/xây · resource an toàn chip)");
    return runHoangCoBreakFlagAuto(options);
  }

  const placeOn = settings.auto_place !== false;
  const buildOn = settings.auto_build !== false;
  const defendOn = settings.auto_defend !== false;
  // 1 option central = chu kỳ thủ ↔ công (tương thích setting cũ)
  const centralOn =
    settings.auto_central !== undefined
      ? settings.auto_central !== false
      : settings.auto_defend_mine !== false || settings.auto_attack_central !== false;
  const attackOn = settings.auto_attack === true;
  const expandOn = placeOn || buildOn;

  if (!expandOn && !defendOn && !centralOn && !attackOn) {
    return {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "SKIPPED",
      reason: "Chưa bật mục tiêu Hoàng Cổ (tick Phá cờ hoặc Mở rộng/Thủ/Central)",
      nextDelayMs: 60_000,
      phase: "idle",
    };
  }

  if (expandOn) {
    const exp = await runHoangCoExpandAuto(options);
    exp.phase = "expand";
    if (expandStillBusy(exp) || exp.status === "NO_EVENT" || exp.status === "SKIPPED") {
      return exp;
    }
    if (!defendOn && !centralOn && !attackOn) {
      exp.reason = exp.reason || "Mở rộng xong";
      return exp;
    }
    onLog?.("INFO", "HoàngCổ: mở rộng xong → phase sau");
  }

  if (defendOn) {
    const def = await runHoangCoDefendAuto(options);
    def.phase = "defend";
    if (!def.selfPlacedFlagIds && Array.isArray(settings.self_placed_flag_ids)) {
      def.selfPlacedFlagIds = settings.self_placed_flag_ids;
    }
    if (def.status === "NO_EVENT" || def.status === "SKIPPED") return def;
    if (defendStillBusy(def) || (def.threatenedCount || 0) > 0) {
      return def;
    }
    if (!centralOn && !attackOn) return def;
    onLog?.("INFO", "HoàngCổ: không cờ cần thủ → phase sau");
  }

  // Central — 1 chu kỳ (1 option)
  if (centralOn) {
    const defC = await runHoangCoDefendMineAuto(options);
    defC.phase = "defend_mine";
    if (defC.status === "NO_EVENT" || defC.status === "SKIPPED") return defC;
    if (defendMineStillBusy(defC)) return defC;

    const needCong = /hết lock|không phải clan|nhường Công|chuyển Công/i.test(defC.reason || "");
    if (!needCong) {
      // Còn cửa sổ thủ / chờ an toàn — không công
      return defC;
    }
    onLog?.("INFO", `HoàngCổ Central: ${defC.reason} → Công`);
    const ac = await runHoangCoAttackCentralAuto(options);
    ac.phase = "attack_central";
    return ac;
  }

  if (attackOn) {
    const atk = await runHoangCoAttackAuto(options);
    atk.phase = "attack";
    return atk;
  }

  return {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "DONE",
    reason: "Không còn việc",
    nextDelayMs: 20_000,
    phase: "idle",
  };
}
