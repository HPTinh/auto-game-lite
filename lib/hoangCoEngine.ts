/**
 * Hoàng Cổ — 1 feature, nhiều mục tiêu (setting):
 * - Cắm cờ + Xây cờ → expand (is_built=false)
 * - Thủ cờ → siege_flag side=defend
 * - Thủ mỏ → defend_position kind=resource (mỏ clan mình)
 * - Phá cờ → siege_flag side=attack
 * - leave_defense khi rời pin
 *
 * runHoangCoAuto: 1 timer. Thứ tự: Mở rộng → Thủ cờ → Thủ mỏ → Phá.
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
  /** expand | defend | defend_mine | attack */
  phase?: string;
  /** node_id mỏ đang thủ */
  mineId?: string | number;
}

export interface HoangCoAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: HoangCoLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
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

function cellKey(x: number, y: number) {
  return `${x},${y}`;
}

type Flag = {
  flag_id: number;
  pos_x: number;
  pos_y: number;
  clan_id?: string;
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

function parseFlags(map: any): Flag[] {
  const raw = Array.isArray(map?.flags) ? map.flags : [];
  return raw
    .map((f: any) => {
      const siegeMax = Math.max(1, n(f.siege_max, 600) || 600);
      // siege_points: lúc xây = tiến độ; sau is_built=true = độ bền (bị phá thì tụt, địch có thể đã đi)
      const siegePts = n(f.siege_points, 0);
      const buildProg = n(f.build_progress, siegePts);
      return {
        flag_id: Math.floor(n(f.flag_id)),
        pos_x: Math.floor(n(f.pos_x)),
        pos_y: Math.floor(n(f.pos_y)),
        clan_id: f.clan_id ? String(f.clan_id) : undefined,
        is_built: f.is_built === true,
        siege_points: siegePts,
        siege_max: siegeMax,
        build_progress: buildProg,
        hp_current: n(f.hp_current, 0),
        hp_max: n(f.hp_max, 10000),
        region_code: f.region_code ? String(f.region_code) : undefined,
        decay_active: f.decay_active === true,
      } as Flag;
    })
    .filter((f: Flag) => f.flag_id > 0);
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

function myPos(map: any): { x: number; y: number; inTransit: boolean; eta: number; dead: boolean } | null {
  const p = map?.my_position;
  if (!p || p.has_pos === false) return null;
  return {
    x: Math.floor(n(p.pos_x)),
    y: Math.floor(n(p.pos_y)),
    inTransit: p.in_transit === true,
    eta: Math.max(0, Math.floor(n(p.eta_seconds, 0))),
    dead: p.is_dead === true,
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
    const map = await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
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
      const mapNow = i === 0 ? map : await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
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

    const map = await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    const me = myPos(map);
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
  if (r.action && /defend_mine|move_to_mine|flee_mine|flee_to_safe|resource/i.test(r.action || ""))
    return true;
  return false;
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
 * Địch trong bán kính threatRadius ô quanh mỏ?
 * Chỉ đếm player địch (không ally / khác clan) — không dựa HP mỏ / HP mình.
 */
function enemiesNearMine(
  map: any,
  mine: MineNode,
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
    if (manhattan(px, py, mine.pos_x, mine.pos_y) <= threatRadius) {
      names.push(String(p?.name || p?.character_id || "?").slice(0, 24));
    }
  }
  return { count: names.length, names };
}

/**
 * Thủ mỏ — chỉ ghim mỏ AN TOÀN (không địch trong 3 ô).
 * Có địch trong 3 ô → leave_defense + chạy sang mỏ khác an toàn, KHÔNG ở lại đánh
 * (kể cả máu đầy).
 */
export async function runHoangCoDefendMineAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const characterId = options.characterId;
  const accessToken = options.accessToken;

  const threatRadius = 3; // địch trong 3 ô → bỏ chạy
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

    const map = await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    const me = myPos(map);
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

    const mines = parseMines(map).filter((m) => m.holder_clan_id === clanId);
    if (!mines.length) {
      summary.status = "DONE";
      summary.reason = "Clan không giữ mỏ nào";
      summary.nextDelayMs = 30_000;
      onLog?.("INFO", "HC Thủ mỏ: không có mỏ");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    type Tagged = { m: MineNode; enemyCount: number; enemyNames: string[]; safe: boolean };
    const tagged: Tagged[] = mines.map((m) => {
      const e = enemiesNearMine(map, m, clanId, threatRadius);
      return { m, enemyCount: e.count, enemyNames: e.names, safe: e.count === 0 };
    });

    const safeMines = tagged.filter((t) => t.safe);
    const unsafeHere = tagged.find(
      (t) => t.m.pos_x === me.x && t.m.pos_y === me.y && !t.safe
    );

    // Đang đứng mỏ có địch trong 3 ô → bỏ chạy sang mỏ an toàn (không đánh)
    if (unsafeHere) {
      onLog?.(
        "WARN",
        `HC Thủ mỏ: #${unsafeHere.m.node_id} có ${unsafeHere.enemyCount} địch trong ${threatRadius} ô (${unsafeHere.enemyNames.slice(0, 3).join(",")}) · bỏ chạy · máu full cũng không ở lại`
      );
      await leaveDefense(characterId, accessToken, onLog);

      const nextSafe = safeMines
        .filter((t) => String(t.m.node_id) !== String(unsafeHere.m.node_id))
        .sort(
          (a, b) =>
            manhattan(a.m.pos_x, a.m.pos_y, me.x, me.y) - manhattan(b.m.pos_x, b.m.pos_y, me.x, me.y)
        )[0];

      if (!nextSafe) {
        // Không mỏ an toàn → chạy về home vùng mình
        const homes = Array.isArray(map?.home_cities) ? map.home_cities : [];
        const region = String(map?.my_region_code || "");
        const home = homes.find((h: any) => String(h.vuc || h.region_code) === region) || homes[0];
        if (home) {
          const hx = Math.floor(n(home.pos_x));
          const hy = Math.floor(n(home.pos_y));
          const mv = await rpc(
            "rpc_hoang_co_move",
            { p_character_id: characterId, p_dest_x: hx, p_dest_y: hy },
            accessToken
          );
          const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
          summary.moved = true;
          summary.action = "flee_mine_home";
          summary.status = "WAITING";
          summary.etaSeconds = eta;
          summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
          summary.reason = `Flee mỏ #${unsafeHere.m.node_id} · không mỏ an toàn · về home (${hx},${hy}) · ETA ${eta}s`;
          onLog?.("WARN", summary.reason);
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
        summary.status = "WAITING";
        summary.action = "flee_mine_no_target";
        summary.nextDelayMs = 10_000;
        summary.reason = `Flee mỏ #${unsafeHere.m.node_id} · không chỗ an toàn`;
        summary.finishedAt = new Date().toISOString();
        return summary;
      }

      const dest = nextSafe.m;
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: dest.pos_x, p_dest_y: dest.pos_y },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.mineId = dest.node_id;
      summary.dest = { x: dest.pos_x, y: dest.pos_y };
      summary.action = "flee_to_safe_mine";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Flee #${unsafeHere.m.node_id} → mỏ an toàn #${dest.node_id} · ETA ${eta}s`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Chỉ chọn mỏ AN TOÀN (0 địch trong 3 ô)
    if (!safeMines.length) {
      summary.status = "DONE";
      summary.reason = `Mọi mỏ clan đều có địch trong ${threatRadius} ô · không ghim · tránh đánh`;
      summary.nextDelayMs = 20_000;
      onLog?.("WARN", `HC Thủ mỏ: ${summary.reason}`);
      // Nếu đang pin đâu đó → leave
      await leaveDefense(characterId, accessToken, onLog);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Ưu tiên: đang đứng mỏ an toàn → ghim; else mỏ an toàn gần nhất / stronghold
    const onSafe = safeMines.find((t) => t.m.pos_x === me.x && t.m.pos_y === me.y);
    const pick =
      onSafe ||
      [...safeMines].sort((a, b) => {
        if (a.m.is_stronghold !== b.m.is_stronghold) return a.m.is_stronghold ? -1 : 1;
        return (
          manhattan(a.m.pos_x, a.m.pos_y, me.x, me.y) - manhattan(b.m.pos_x, b.m.pos_y, me.x, me.y)
        );
      })[0];

    const mine = pick.m;
    summary.mineId = mine.node_id;
    summary.dest = { x: mine.pos_x, y: mine.pos_y };

    onLog?.(
      "INFO",
      `HC Thủ mỏ: ghim #${mine.node_id} ${mine.label || ""} @(${mine.pos_x},${mine.pos_y}) · an toàn (0 địch trong ${threatRadius} ô)`
    );

    const dist = manhattan(mine.pos_x, mine.pos_y, me.x, me.y);
    if (dist > 0) {
      await leaveDefense(characterId, accessToken, onLog);
      const mv = await rpc(
        "rpc_hoang_co_move",
        { p_character_id: characterId, p_dest_x: mine.pos_x, p_dest_y: mine.pos_y },
        accessToken
      );
      const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
      summary.moved = true;
      summary.action = "move_to_mine";
      summary.status = "WAITING";
      summary.etaSeconds = eta;
      summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
      summary.reason = `Đi thủ mỏ an toàn #${mine.node_id} · ETA ${eta}s`;
      onLog?.("INFO", summary.reason);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Đứng mỏ an toàn → defend_position
    try {
      const res = await rpc(
        "rpc_hoang_co_defend_position",
        {
          p_character_id: characterId,
          p_target_kind: "resource",
          p_target_id: String(mine.node_id),
        },
        accessToken
      );
      summary.action = "defend_mine";
      summary.status = "WAITING";
      summary.nextDelayMs = pollMs;
      summary.reason = `Thủ mỏ #${mine.node_id} · stack ${n(res?.stack_order)}/${n(res?.stack_size)} · an toàn`;
      onLog?.("SUCCESS", summary.reason, { res });
    } catch (e: any) {
      summary.status = "ERROR";
      summary.reason = `defend_position mỏ #${mine.node_id} fail: ${(e?.message || e).toString().slice(0, 120)}`;
      summary.nextDelayMs = 20_000;
      onLog?.("ERROR", `HC Thủ mỏ: ${summary.reason}`);
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
    onLog?.("ERROR", `HC Thủ mỏ error: ${summary.reason}`);
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

    const map = await rpc("rpc_hoang_co_map_state", { p_character_id: characterId }, accessToken);
    const me = myPos(map);
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

/**
 * Entry 1 feature Hoàng Cổ (1 timer):
 * 1) Cắm/Xây → 2) Thủ → 3) Phá cờ địch
 * Rời pin: leave_defense khi move sang việc khác
 */
export async function runHoangCoAuto(options: HoangCoAutoOptions): Promise<HoangCoRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;

  const placeOn = settings.auto_place !== false;
  const buildOn = settings.auto_build !== false;
  const defendOn = settings.auto_defend !== false;
  const mineOn = settings.auto_defend_mine !== false;
  const attackOn = settings.auto_attack === true; // phá cờ — mặc định tắt
  const expandOn = placeOn || buildOn;

  if (!expandOn && !defendOn && !mineOn && !attackOn) {
    return {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "SKIPPED",
      reason: "Chưa bật Cắm/Xây/Thủ cờ/Thủ mỏ/Phá",
      nextDelayMs: 60_000,
      phase: "idle",
    };
  }

  // 1) Mở rộng
  if (expandOn) {
    const exp = await runHoangCoExpandAuto(options);
    exp.phase = "expand";
    if (expandStillBusy(exp) || exp.status === "NO_EVENT" || exp.status === "SKIPPED") {
      return exp;
    }
    if (!defendOn && !mineOn && !attackOn) {
      exp.reason = exp.reason || "Mở rộng xong / không còn việc";
      return exp;
    }
    onLog?.("INFO", "HoàngCổ: mở rộng xong → phase sau");
  }

  // 2) Thủ cờ mình
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
    if (!mineOn && !attackOn) return def;
    onLog?.("INFO", "HoàngCổ: không cờ cần thủ → phase sau");
  }

  // 3) Thủ mỏ (defend_position resource)
  if (mineOn) {
    const mine = await runHoangCoDefendMineAuto(options);
    mine.phase = "defend_mine";
    if (mine.status === "NO_EVENT" || mine.status === "SKIPPED") return mine;
    if (defendMineStillBusy(mine)) {
      return mine;
    }
    // DONE không mỏ bị đe dọa (và không garrison) → sang phá
    if (!attackOn) return mine;
    onLog?.("INFO", "HoàngCổ: thủ mỏ xong / không mỏ nguy → Phá cờ");
  }

  // 4) Phá cờ địch
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
