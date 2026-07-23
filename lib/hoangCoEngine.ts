/**
 * Hoàng Cổ — phase 1: MỞ RỘNG ĐẤT
 * - rpc_hoang_co_status / map_state / heartbeat
 * - rpc_hoang_co_move → tới ô
 * - rpc_hoang_co_place_flag → cắm cờ mới (x,y)
 * - rpc_hoang_co_start_build → xây tiếp cờ đã có (flag_id)
 *
 * Ưu tiên mỗi tick:
 * 1) Cờ clan chưa build xong → start_build (gần mình trước)
 * 2) Còn slot → chọn ô an toàn vùng mình → move (nếu cần) → place_flag
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
  dest?: { x: number; y: number };
  etaSeconds?: number;
  myRegion?: string;
  clanFlags?: number;
  buildingFlags?: number;
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
  build_progress?: number;
  siege_points?: number;
  siege_max?: number;
  hp_current?: number;
  region_code?: string;
};

type Pos = { x: number; y: number };

function parseFlags(map: any): Flag[] {
  const raw = Array.isArray(map?.flags) ? map.flags : [];
  return raw
    .map((f: any) => ({
      flag_id: Math.floor(n(f.flag_id)),
      pos_x: Math.floor(n(f.pos_x)),
      pos_y: Math.floor(n(f.pos_y)),
      clan_id: f.clan_id ? String(f.clan_id) : undefined,
      is_built: f.is_built === true,
      build_progress: n(f.build_progress ?? f.siege_points, 0),
      siege_points: n(f.siege_points, 0),
      siege_max: n(f.siege_max, 600) || 600,
      hp_current: n(f.hp_current, 0),
      region_code: f.region_code ? String(f.region_code) : undefined,
    }))
    .filter((f: Flag) => f.flag_id > 0);
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

/** Cờ clan đang xây dở (chưa full progress) */
function incompleteClanFlags(flags: Flag[], clanId: string, siegeMax: number): Flag[] {
  return flags
    .filter((f) => f.clan_id === clanId)
    .filter((f) => {
      if (f.is_built === true && n(f.build_progress) >= siegeMax) return false;
      // chưa built hoặc progress < max → cần start_build / tiếp quản
      return f.is_built !== true || n(f.build_progress) < siegeMax;
    })
    .sort((a, b) => n(b.build_progress) - n(a.build_progress));
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

  const anchors: Pos[] =
    mine.length > 0
      ? mine.map((f) => ({ x: f.pos_x, y: f.pos_y }))
      : [{ x: home.x, y: home.y }];

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

  const maxPlacePerTick = Math.max(1, Math.min(3, Math.floor(n(settings.max_place_per_tick, 1)) || 1));
  const maxBuildPerTick = Math.max(1, Math.min(5, Math.floor(n(settings.max_build_per_tick, 2)) || 2));
  const maxGap = Math.max(1, Math.min(8, Math.floor(n(settings.place_gap, 3)) || 3));
  const preferOwnRegion = settings.prefer_own_region !== false;
  const onlyWhenEventLive = settings.only_when_event_live !== false;
  const maxConcurrentBuild = Math.max(1, Math.min(10, Math.floor(n(settings.max_concurrent_build, 3)) || 3));
  const defaultPollMs = Math.max(8_000, Math.floor(n(settings.poll_ms, 20_000)) || 20_000);

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
    const siegeMax = Math.max(100, Math.floor(n(map?.config?.siege_max, 600)) || 600);
    const clanFlags = flags.filter((f) => f.clan_id === clanId);
    const building = incompleteClanFlags(flags, clanId, siegeMax);
    summary.clanFlags = clanFlags.length;
    summary.buildingFlags = building.length;

    const cfgMaxBuild = Math.max(
      1,
      Math.floor(n(settings.max_concurrent_build ?? map?.config?.flag_building_max, maxConcurrentBuild)) ||
        maxConcurrentBuild
    );

    onLog?.(
      "INFO",
      `HoàngCổ expand · vùng ${region || "?"} · cờ clan ${clanFlags.length} · đang xây ${building.length}/${cfgMaxBuild} · pos (${me.x},${me.y})`
    );

    // 3) Ưu tiên: start_build cờ dở (gần mình trước)
    if (settings.auto_build !== false && building.length > 0) {
      const nearBuild = [...building].sort(
        (a, b) => manhattan(a.pos_x, a.pos_y, me.x, me.y) - manhattan(b.pos_x, b.pos_y, me.x, me.y)
      );
      let built = 0;
      for (const f of nearBuild.slice(0, maxBuildPerTick)) {
        if (options.shouldStop?.()) break;
        try {
          // Nếu còn xa cờ → move trước
          const dist = manhattan(f.pos_x, f.pos_y, me.x, me.y);
          if (dist > 0 && settings.move_before_build !== false) {
            const mv = await rpc(
              "rpc_hoang_co_move",
              { p_character_id: characterId, p_dest_x: f.pos_x, p_dest_y: f.pos_y },
              accessToken
            );
            const eta = Math.max(0, Math.floor(n(mv?.eta_seconds, 0)));
            summary.moved = true;
            summary.dest = { x: f.pos_x, y: f.pos_y };
            summary.action = "move_to_build";
            summary.flagId = f.flag_id;
            summary.status = "WAITING";
            summary.etaSeconds = eta;
            summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
            summary.reason = `Đi xây cờ #${f.flag_id} (${f.pos_x},${f.pos_y}) · ETA ${eta}s · progress ${f.build_progress}/${siegeMax}`;
            onLog?.("INFO", summary.reason);
            summary.finishedAt = new Date().toISOString();
            return summary;
          }

          const res = await rpc(
            "rpc_hoang_co_start_build",
            { p_character_id: characterId, p_flag_id: f.flag_id },
            accessToken
          );
          built += 1;
          summary.built = built;
          summary.flagId = f.flag_id;
          summary.action = "start_build";
          const eta = Math.max(0, Math.floor(n(res?.eta_seconds, 0)));
          if (eta > 0) {
            summary.status = "WAITING";
            summary.moved = true;
            summary.etaSeconds = eta;
            summary.nextDelayMs = Math.max(3_000, eta * 1000 + 2000);
            summary.reason = `start_build #${f.flag_id} · server di chuyển ETA ${eta}s`;
            onLog?.("SUCCESS", summary.reason, { res });
            summary.finishedAt = new Date().toISOString();
            return summary;
          }
          onLog?.(
            "SUCCESS",
            `HoàngCổ start_build cờ #${f.flag_id} @(${f.pos_x},${f.pos_y}) · progress ${f.build_progress}/${siegeMax}`,
            { res }
          );
          await sleep(600);
        } catch (e: any) {
          onLog?.("WARN", `HoàngCổ start_build #${f.flag_id} fail: ${(e?.message || e).toString().slice(0, 120)}`);
        }
      }
      if (built > 0) {
        summary.status = "DONE";
        summary.reason = `Đã start_build ${built} cờ`;
        summary.nextDelayMs = Math.max(8_000, defaultPollMs);
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
    }

    // 4) place_flag — chỉ khi chưa quá concurrent build
    const activeBuilding = building.filter((f) => n(f.build_progress) < siegeMax).length;
    if (settings.auto_place === false) {
      summary.status = "DONE";
      summary.reason = "auto_place tắt · không cắm cờ mới";
      summary.nextDelayMs = defaultPollMs;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    if (activeBuilding >= cfgMaxBuild) {
      summary.status = "WAITING";
      summary.reason = `Đang xây ${activeBuilding}/${cfgMaxBuild} cờ · chờ build xong mới cắm thêm`;
      summary.nextDelayMs = Math.max(15_000, defaultPollMs);
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
        if (flagId) summary.flagId = flagId;
        const used = n(res?.used_flags, 0);
        const maxF = n(res?.max_flags, 0);
        onLog?.(
          "SUCCESS",
          `HoàngCổ PLACE cờ #${flagId || "?"} @(${cell.x},${cell.y}) · +${n(res?.score_delta, 0)} điểm · flags ${used}/${maxF || "?"}`,
          { res }
        );

        // place xong nếu server chưa building, thử start_build
        if (flagId && res?.building !== true && settings.auto_build !== false) {
          try {
            await rpc(
              "rpc_hoang_co_start_build",
              { p_character_id: characterId, p_flag_id: flagId },
              accessToken
            );
            summary.built = (summary.built || 0) + 1;
            onLog?.("SUCCESS", `HoàngCổ start_build ngay sau place #${flagId}`);
          } catch (be: any) {
            onLog?.("WARN", `HoàngCổ start_build sau place fail: ${(be?.message || "").slice(0, 100)}`);
          }
        }

        await sleep(800);
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
    onLog?.("ERROR", `HoàngCổ error: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
