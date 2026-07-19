/**
 * Auto PVP / Arena — dựa trên rpc_arena_opponent_list + rpc_arena_attack
 * Khi thắng: lưu defender_id vào hunt list để ưu tiên bem lại.
 */

export type PvpLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface PvpHuntTarget {
  id: string;
  name?: string;
  wins: number;
  losses: number;
  lastWinAt?: string;
  lastAt?: string;
}

export interface PvpFightResult {
  defenderId: string;
  defenderName?: string;
  ok: boolean;
  victory?: boolean;
  points?: number;
  attacksRemaining?: number;
  error?: string;
}

export interface PvpRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "PARTIAL" | "ERROR" | "NO_OPPONENT" | "NO_ATTACKS";
  requested: number;
  fought: number;
  wins: number;
  losses: number;
  attacksRemaining?: number;
  huntCount: number;
  fights: PvpFightResult[];
  reason?: string;
}

export interface PvpAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  /** hunt list hiện tại (sẽ mutate/return bản mới) */
  huntList?: PvpHuntTarget[];
  onLog?: (level: PvpLogLevel, message: string, meta?: any) => void;
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
  return data;
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.opponents)) return v.opponents;
  if (Array.isArray(v?.data)) return v.data;
  if (Array.isArray(v?.items)) return v.items;
  return [];
}

function oppId(o: any): string {
  return String(o?.character_id || o?.defender_id || o?.id || "").trim();
}

function oppName(o: any): string {
  return String(o?.character_name || o?.name || o?.title_vi || "").trim();
}

function isVictory(data: any): boolean {
  if (data?.is_victory === true) return true;
  if (data?.winner === "attacker") return true;
  if (data?.battle?.winner === "attacker") return true;
  if (data?.battle?.ok === true && data?.battle?.final?.defender_hp === 0) return true;
  return false;
}

function normalizeHunt(list: any): PvpHuntTarget[] {
  if (!Array.isArray(list)) return [];
  const out: PvpHuntTarget[] = [];
  for (const item of list) {
    const id = String(item?.id || item?.character_id || "").trim();
    if (!id) continue;
    out.push({
      id,
      name: item?.name || item?.character_name,
      wins: Number(item?.wins || 0) || 0,
      losses: Number(item?.losses || 0) || 0,
      lastWinAt: item?.lastWinAt,
      lastAt: item?.lastAt,
    });
  }
  return out;
}

/**
 * Chọn thứ tự đánh:
 * 1) Mục tiêu hunt còn attackable
 * 2) Còn lại (tuỳ prefer_weaker: power thấp trước)
 */
function pickQueue(opponents: any[], hunt: PvpHuntTarget[], preferWeaker: boolean): any[] {
  const byId = new Map<string, any>();
  for (const o of opponents) {
    const id = oppId(o);
    if (!id) continue;
    if (o?.attackable === false) continue;
    byId.set(id, o);
  }

  const queue: any[] = [];
  const used = new Set<string>();

  for (const h of hunt) {
    const o = byId.get(h.id);
    if (o) {
      queue.push(o);
      used.add(h.id);
    }
  }

  let rest = opponents.filter((o) => {
    const id = oppId(o);
    return id && !used.has(id) && o?.attackable !== false;
  });

  if (preferWeaker) {
    rest = rest.slice().sort((a, b) => {
      const pa = Number(a?.power_rating || a?.power || 0);
      const pb = Number(b?.power_rating || b?.power || 0);
      return pa - pb;
    });
  }

  return [...queue, ...rest];
}

export async function runPvpAuto(options: PvpAutoOptions): Promise<PvpRunSummary & { huntList: PvpHuntTarget[] }> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  // max_attacks = số trận cần đánh trong lần gọi (orchestrator truyền phần còn lại trong ngày)
  const maxAttacks = Math.max(1, Math.min(100, Math.floor(Number(settings.max_attacks ?? settings.times ?? settings.daily_target ?? 5)) || 5));
  const delayMs = Math.max(400, Number(settings.delay_ms || 1500));
  const huntOnWin = settings.hunt_on_win !== false;
  const preferHunt = settings.prefer_hunt !== false;
  const preferWeaker = settings.prefer_weaker !== false;
  const maxHunt = Math.max(1, Math.min(50, Number(settings.max_hunt || 15)));
  const onlyNpc = settings.only_npc === true;

  let hunt = normalizeHunt(options.huntList ?? settings.hunt_list);
  const summary: PvpRunSummary & { huntList: PvpHuntTarget[] } = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    requested: maxAttacks,
    fought: 0,
    wins: 0,
    losses: 0,
    huntCount: hunt.length,
    fights: [],
    huntList: hunt,
  };

  try {
    onLog?.("INFO", `PVP: lấy danh sách đối thủ (max ${maxAttacks} trận)...`);
    const listData = await rpc(
      "rpc_arena_opponent_list",
      { p_character_id: options.characterId },
      options.accessToken
    );

    if (listData?.ok === false) {
      summary.status = "ERROR";
      summary.reason = listData?.reason || "opponent_list failed";
      onLog?.("ERROR", `PVP list fail: ${summary.reason}`);
      summary.finishedAt = new Date().toISOString();
      summary.huntList = hunt;
      return summary;
    }

    const opponents = asArray(listData);
    if (!opponents.length) {
      summary.status = "NO_OPPONENT";
      summary.reason = "Không có đối thủ";
      onLog?.("WARN", "PVP: không có đối thủ trong list");
      summary.finishedAt = new Date().toISOString();
      summary.huntList = hunt;
      return summary;
    }

    const queue = preferHunt
      ? pickQueue(opponents, hunt, preferWeaker)
      : pickQueue(opponents, [], preferWeaker);

    if (!queue.length) {
      summary.status = "NO_OPPONENT";
      summary.reason = "Không có đối thủ attackable";
      onLog?.("WARN", summary.reason);
      summary.finishedAt = new Date().toISOString();
      summary.huntList = hunt;
      return summary;
    }

    let attacksRemaining: number | undefined;

    for (let i = 0; i < maxAttacks; i++) {
      if (options.shouldStop?.()) break;
      if (attacksRemaining !== undefined && attacksRemaining <= 0) {
        summary.status = "NO_ATTACKS";
        summary.reason = "Hết lượt PVP";
        break;
      }

      const target = queue[i % queue.length];
      const defenderId = oppId(target);
      const defenderName = oppName(target);
      if (!defenderId) continue;

      const isHunt = hunt.some((h) => h.id === defenderId);
      try {
        const data = await rpc(
          "rpc_arena_attack",
          {
            p_character_id: options.characterId,
            p_defender_id: defenderId,
            p_is_npc: onlyNpc,
          },
          options.accessToken
        );

        const win = isVictory(data);
        const rem = data?.attacks_remaining;
        if (typeof rem === "number") attacksRemaining = rem;

        const fight: PvpFightResult = {
          defenderId,
          defenderName,
          ok: data?.ok !== false,
          victory: win,
          points: data?.points_awarded,
          attacksRemaining: typeof rem === "number" ? rem : undefined,
        };
        summary.fights.push(fight);
        summary.fought += 1;

        if (win) {
          summary.wins += 1;
          if (huntOnWin) {
            const existing = hunt.find((h) => h.id === defenderId);
            if (existing) {
              existing.wins += 1;
              existing.name = defenderName || existing.name;
              existing.lastWinAt = new Date().toISOString();
              existing.lastAt = existing.lastWinAt;
            } else {
              hunt.unshift({
                id: defenderId,
                name: defenderName,
                wins: 1,
                losses: 0,
                lastWinAt: new Date().toISOString(),
                lastAt: new Date().toISOString(),
              });
            }
            // cap hunt list
            hunt = hunt.slice(0, maxHunt);
          }
          onLog?.("SUCCESS", `PVP WIN · ${defenderName || defenderId.slice(0, 8)}${isHunt ? " [hunt]" : ""} · +${data?.points_awarded ?? "?"} · còn ${rem ?? "?"}`);
        } else {
          summary.losses += 1;
          const existing = hunt.find((h) => h.id === defenderId);
          if (existing) {
            existing.losses += 1;
            existing.lastAt = new Date().toISOString();
          }
          onLog?.("WARN", `PVP LOSS · ${defenderName || defenderId.slice(0, 8)} · còn ${rem ?? "?"}`);
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        summary.fights.push({
          defenderId,
          defenderName,
          ok: false,
          error: msg,
        });
        // hết lượt / cooldown
        if (/remaining|hết|limit|cooldown|not_allowed|không/i.test(msg)) {
          summary.status = "NO_ATTACKS";
          summary.reason = msg.slice(0, 120);
          onLog?.("WARN", `PVP dừng: ${summary.reason}`);
          break;
        }
        onLog?.("ERROR", `PVP lỗi vs ${defenderName || defenderId.slice(0, 8)}: ${msg.slice(0, 100)}`);
      }

      if (i + 1 < maxAttacks) await sleep(delayMs);
    }

    summary.attacksRemaining = attacksRemaining;
    summary.huntCount = hunt.length;
    if (summary.fought === 0 && summary.status === "DONE") {
      summary.status = "NO_OPPONENT";
    } else if (summary.losses > 0 && summary.wins === 0 && summary.fought > 0) {
      summary.status = "PARTIAL";
    }

    onLog?.(
      "INFO",
      `PVP xong · ${summary.wins}W/${summary.losses}L · ${summary.fought}/${summary.requested} · hunt ${hunt.length}`
    );
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    onLog?.("ERROR", `PVP fail: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  summary.huntList = hunt;
  return summary;
}
