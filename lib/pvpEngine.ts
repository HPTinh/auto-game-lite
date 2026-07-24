/**
 * Auto PVP / Arena — rpc_arena_opponent_list + rpc_arena_attack
 *
 * Free: attacks_remaining (thường 30/ngày), used_pk_token=false
 * PK: hết free → server có thể trừ pk_token (used_pk_token=true) nếu còn thẻ
 *
 * Thắng → lưu character_id vào hunt_list, ưu tiên bem dí lại (tỉ lệ thắng cao).
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
  usedPkToken?: boolean;
  error?: string;
}

export interface PvpRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "PARTIAL" | "ERROR" | "NO_OPPONENT" | "NO_ATTACKS" | "NO_PK";
  requested: number;
  fought: number;
  wins: number;
  losses: number;
  attacksRemaining?: number;
  usedPkCount: number;
  huntCount: number;
  fights: PvpFightResult[];
  reason?: string;
  /** free | pk */
  mode?: string;
}

export interface PvpAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
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
      lastAt: item?.lastAt,
    });
  }
  return out;
}

/**
 * free = chỉ lượt free (attacks_remaining)
 * pk   = free xong vẫn đánh tiếp (dùng thẻ pk_token nếu server/auto cho)
 */
function resolveMode(settings: Record<string, any>): "free" | "pk" {
  const m = String(settings.pvp_mode || settings.mode || "").toLowerCase();
  if (m === "pk" || m === "use_pk" || m === "free_and_pk" || m === "ticket") return "pk";
  if (settings.use_pk_token === true || settings.use_pk === true) return "pk";
  return "free";
}

/**
 * Queue: 1) hunt (bem dí người đã thắng) 2) yếu hơn (power thấp)
 * Có hunt → ưu tiên chỉ đánh hunt (tỉ lệ thắng cao), trừ khi allow_discover
 */
function pickQueue(
  opponents: any[],
  hunt: PvpHuntTarget[],
  preferWeaker: boolean,
  huntOnly: boolean
): any[] {
  const byId = new Map<string, any>();
  for (const o of opponents) {
    const id = oppId(o);
    if (!id) continue;
    if (o?.attackable === false) continue;
    byId.set(id, o);
  }

  const queue: any[] = [];
  const used = new Set<string>();

  // Hunt: người đã thua mình — đánh lại loanh quanh
  for (const h of hunt) {
    const o = byId.get(h.id);
    if (o) {
      queue.push({ ...o, _fromHunt: true });
      used.add(h.id);
    } else {
      // Không trong list server — vẫn thử đánh thẳng bằng id (như console F12)
      queue.push({
        character_id: h.id,
        character_name: h.name,
        attackable: true,
        _fromHunt: true,
        _direct: true,
      });
      used.add(h.id);
    }
  }

  if (huntOnly && queue.length > 0) {
    return queue;
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

function isOutOfAttacksError(msg: string, data?: any): boolean {
  const s = `${msg} ${JSON.stringify(data || {})}`.toLowerCase();
  return /no.?attack|hết lượt|het luot|attacks_remaining|no_ticket|no_pk|pk_token|not_enough|insufficient|limit|quota|remaining.?0/i.test(
    s
  );
}

export async function runPvpAuto(options: PvpAutoOptions): Promise<PvpRunSummary & { huntList: PvpHuntTarget[] }> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const mode = resolveMode(settings);
  const freeQuota = Math.max(1, Math.min(50, Math.floor(Number(settings.free_per_day ?? settings.free_quota ?? 30)) || 30));
  // free mode: tối đa freeQuota; pk mode: daily_target hoặc pk_max (mặc định free+50)
  const pkMax = Math.max(
    freeQuota,
    Math.min(200, Math.floor(Number(settings.daily_target ?? settings.pk_max ?? settings.max_attacks ?? freeQuota + 50)) || freeQuota + 50)
  );
  const batchMax = Math.max(
    1,
    Math.min(
      50,
      Math.floor(Number(settings.max_attacks ?? (mode === "free" ? freeQuota : Math.min(20, pkMax)))) || 10
    )
  );
  const delayMs = Math.max(400, Number(settings.delay_ms || 1500));
  const huntOnWin = settings.hunt_on_win !== false;
  const preferHunt = settings.prefer_hunt !== false;
  const preferWeaker = settings.prefer_weaker !== false;
  const maxHunt = Math.max(1, Math.min(50, Number(settings.max_hunt || 15)));
  // Có list bem dí → chỉ đánh họ (giống F12 1 id)
  const huntOnly = settings.hunt_only !== false && preferHunt;
  const onlyNpc = settings.only_npc === true;

  let hunt = normalizeHunt(options.huntList ?? settings.hunt_list);
  const summary: PvpRunSummary & { huntList: PvpHuntTarget[] } = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    requested: batchMax,
    fought: 0,
    wins: 0,
    losses: 0,
    usedPkCount: 0,
    huntCount: hunt.length,
    fights: [],
    huntList: hunt,
    mode,
  };

  try {
    onLog?.(
      "INFO",
      `PVP mode=${mode} · batch≤${batchMax} · free/ngày~${freeQuota}${mode === "pk" ? ` · pk max~${pkMax}` : " · chỉ free"} · hunt ${hunt.length}`
    );

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
    const queue = preferHunt
      ? pickQueue(opponents, hunt, preferWeaker, huntOnly)
      : pickQueue(opponents, [], preferWeaker, false);

    if (!queue.length && !hunt.length) {
      summary.status = "NO_OPPONENT";
      summary.reason = "Không có đối thủ";
      onLog?.("WARN", "PVP: không có đối thủ");
      summary.finishedAt = new Date().toISOString();
      summary.huntList = hunt;
      return summary;
    }

    let attacksRemaining: number | undefined;
    let freeExhausted = false;
    let huntIdx = 0;

    for (let i = 0; i < batchMax; i++) {
      if (options.shouldStop?.()) break;

      // Mode free: hết free (attacks_remaining=0) → dừng
      if (mode === "free" && freeExhausted) {
        summary.status = "NO_ATTACKS";
        summary.reason = "Hết lượt free hôm nay";
        break;
      }
      if (mode === "free" && attacksRemaining !== undefined && attacksRemaining <= 0) {
        summary.status = "NO_ATTACKS";
        summary.reason = "Hết lượt free (attacks_remaining=0)";
        freeExhausted = true;
        break;
      }

      // Chọn target: loanh quanh hunt trước (bem dí), rồi mới list
      let target = queue.length ? queue[huntIdx % queue.length] : null;
      huntIdx += 1;
      if (!target) {
        summary.status = "NO_OPPONENT";
        break;
      }

      const defenderId = oppId(target);
      const defenderName = oppName(target);
      if (!defenderId) continue;

      const isHunt = Boolean(target._fromHunt) || hunt.some((h) => h.id === defenderId);

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

        // Server báo lỗi business
        if (data && data.ok === false) {
          const reason = String(data.reason || data.error || data.message || "ok_false");
          if (isOutOfAttacksError(reason, data)) {
            if (mode === "pk" && /pk|token|ticket/i.test(reason)) {
              summary.status = "NO_PK";
              summary.reason = `Hết free + hết thẻ PK: ${reason.slice(0, 80)}`;
            } else {
              summary.status = "NO_ATTACKS";
              summary.reason = reason.slice(0, 120);
              freeExhausted = true;
            }
            onLog?.("WARN", `PVP dừng: ${summary.reason}`);
            break;
          }
          onLog?.("WARN", `PVP skip: ${reason.slice(0, 100)}`);
          continue;
        }

        const win = isVictory(data);
        const rem = data?.attacks_remaining;
        if (typeof rem === "number") {
          attacksRemaining = rem;
          if (rem <= 0) freeExhausted = true;
        }
        const usedPk = data?.used_pk_token === true;
        if (usedPk) summary.usedPkCount += 1;

        // Mode free: vừa hết free sau trận này
        if (mode === "free" && freeExhausted) {
          // vẫn count trận này
        }

        const fight: PvpFightResult = {
          defenderId,
          defenderName,
          ok: data?.ok !== false,
          victory: win,
          points: data?.points_awarded,
          attacksRemaining: typeof rem === "number" ? rem : undefined,
          usedPkToken: usedPk,
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
            hunt = hunt.slice(0, maxHunt);
          }
          onLog?.(
            "SUCCESS",
            `PVP WIN · ${defenderName || defenderId.slice(0, 8)}${isHunt ? " [hunt]" : ""}${usedPk ? " [PK]" : ""} · +${data?.points_awarded ?? "?"} · free còn ${rem ?? "?"}`
          );
        } else {
          summary.losses += 1;
          // Thua → bỏ khỏi hunt ưu tiên (tránh bem người mạnh)
          if (settings.drop_hunt_on_loss !== false) {
            hunt = hunt.filter((h) => h.id !== defenderId);
          } else {
            const existing = hunt.find((h) => h.id === defenderId);
            if (existing) {
              existing.losses += 1;
              existing.lastAt = new Date().toISOString();
            }
          }
          onLog?.(
            "WARN",
            `PVP LOSS · ${defenderName || defenderId.slice(0, 8)}${usedPk ? " [PK]" : ""} · free còn ${rem ?? "?"}`
          );
        }

        // free mode + hết free sau trận
        if (mode === "free" && freeExhausted) {
          summary.status = "NO_ATTACKS";
          summary.reason = "Đã xài hết lượt free hôm nay";
          onLog?.("INFO", "PVP: hết free · dừng (mode free)");
          break;
        }

        // pk mode + hết free: tiếp tục (server dùng thẻ nếu có)
        if (mode === "pk" && freeExhausted && !usedPk && rem === 0) {
          // Trận free cuối; vòng sau sẽ thử PK
          onLog?.("INFO", "PVP: hết free · tiếp tục bằng thẻ PK (nếu còn)");
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        const data = e?.data;
        summary.fights.push({
          defenderId,
          defenderName,
          ok: false,
          error: msg,
        });
        if (isOutOfAttacksError(msg, data)) {
          if (mode === "pk") {
            summary.status = "NO_PK";
            summary.reason = `Hết free/PK: ${msg.slice(0, 100)}`;
          } else {
            summary.status = "NO_ATTACKS";
            summary.reason = msg.slice(0, 120);
            freeExhausted = true;
          }
          onLog?.("WARN", `PVP dừng: ${summary.reason}`);
          break;
        }
        onLog?.("ERROR", `PVP lỗi vs ${defenderName || defenderId.slice(0, 8)}: ${msg.slice(0, 100)}`);
      }

      if (i + 1 < batchMax) await sleep(delayMs);
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
      `PVP xong · mode=${mode} · ${summary.wins}W/${summary.losses}L · ${summary.fought} trận · PK ${summary.usedPkCount} · hunt ${hunt.length} · free còn ${attacksRemaining ?? "?"}`
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
