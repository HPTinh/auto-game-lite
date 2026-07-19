/**
 * VIP Daily Claim
 * - rpc_get_vip_daily_status { p_character_id } → claimed_today, today, rewards, vip_level
 * - rpc_claim_vip_daily { p_character_id } → claim quà/điểm VIP trong ngày
 *
 * claimed_today = false → chưa claim, gọi claim
 * claimed_today = true  → đã claim, chờ 00:00 VN ngày mới
 */

export type VipDailyLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface VipDailyRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "CLAIMED" | "ALREADY" | "ERROR" | "SKIPPED";
  claimedToday: boolean;
  today?: string;
  vipLevel?: number;
  vipPoints?: number;
  spiritStones?: number;
  battleMerit?: number;
  rewards?: any;
  nextDelayMs: number;
  reason?: string;
  /** lưu vào settings */
  persist: {
    claimed_today: boolean;
    daily_date: string;
    last_claim_at?: string;
    vip_level?: number;
    last_rewards?: any;
  };
}

export interface VipDailyAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: VipDailyLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
  /** ms đến 00:00 VN — caller có thể truyền sẵn */
  msUntilNextMidnight?: number;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

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

/** YYYY-MM-DD theo giờ VN */
export function vnDateString(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** ms đến 00:00 VN tiếp theo (+5s đệm) */
export function msUntilNextVnMidnight(nowMs = Date.now()): number {
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const vnNow = new Date(nowMs + vnOffsetMs);
  const y = vnNow.getUTCFullYear();
  const m = vnNow.getUTCMonth();
  const day = vnNow.getUTCDate();
  const nextMidnightUtcMs = Date.UTC(y, m, day + 1, 0, 0, 0, 0) - vnOffsetMs;
  return Math.max(60_000, nextMidnightUtcMs - nowMs + 5_000);
}

function pickRewards(data: any) {
  const rewards = data?.rewards || data?.reward || {};
  return {
    vipPoints: Number(rewards?.vip_points ?? data?.vip_points) || undefined,
    spiritStones: Number(rewards?.spirit_stones ?? data?.spirit_stones) || undefined,
    battleMerit: Number(rewards?.battle_merit ?? data?.battle_merit) || undefined,
    items: Array.isArray(rewards?.items) ? rewards.items : [],
    raw: rewards,
  };
}

function formatRewards(r: ReturnType<typeof pickRewards>): string {
  const parts: string[] = [];
  if (r.vipPoints) parts.push(`+${r.vipPoints} VIP pt`);
  if (r.spiritStones) parts.push(`+${r.spiritStones} LS`);
  if (r.battleMerit) parts.push(`+${r.battleMerit} merit`);
  if (r.items?.length) {
    parts.push(r.items.map((i: any) => `${i.code || "?"}x${i.qty || 1}`).join(","));
  }
  return parts.join(" · ") || "ok";
}

export async function runVipDailyAuto(options: VipDailyAutoOptions): Promise<VipDailyRunSummary> {
  const onLog = options.onLog;
  const settings = options.settings || {};
  const nextMidnight =
    Math.max(60_000, Number(options.msUntilNextMidnight || msUntilNextVnMidnight()));
  const todayVn = vnDateString();

  const summary: VipDailyRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "SKIPPED",
    claimedToday: false,
    today: todayVn,
    nextDelayMs: nextMidnight,
    persist: {
      claimed_today: false,
      daily_date: todayVn,
    },
  };

  try {
    if (options.shouldStop?.()) {
      summary.status = "SKIPPED";
      summary.reason = "stopped";
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // Cache local: cùng ngày VN + claimed_today → không gọi claim lại (vẫn check status thỉnh thoảng)
    const cachedDate = String(settings.daily_date || "");
    const cachedClaimed = settings.claimed_today === true;

    onLog?.("INFO", `VIP daily: check status (rpc_get_vip_daily_status)...`);
    const status = await rpc(
      "rpc_get_vip_daily_status",
      { p_character_id: options.characterId },
      options.accessToken
    );

    const serverToday = String(status?.today || todayVn);
    const claimedToday = status?.claimed_today === true;
    const vipLevel = Number(status?.vip_level ?? settings.vip_level);
    summary.today = serverToday;
    summary.claimedToday = claimedToday;
    summary.vipLevel = Number.isFinite(vipLevel) ? vipLevel : undefined;

    const preview = pickRewards(status);
    summary.vipPoints = preview.vipPoints;
    summary.spiritStones = preview.spiritStones;
    summary.battleMerit = preview.battleMerit;
    summary.rewards = preview.raw;

    // Đã claim (server hoặc cache cùng ngày)
    if (claimedToday || (cachedClaimed && cachedDate === serverToday)) {
      summary.status = "ALREADY";
      summary.claimedToday = true;
      summary.nextDelayMs = nextMidnight;
      summary.reason = `Hôm nay đã claim (${serverToday})`;
      summary.persist = {
        claimed_today: true,
        daily_date: serverToday,
        last_claim_at: settings.last_claim_at || undefined,
        vip_level: summary.vipLevel,
        last_rewards: settings.last_rewards || preview.raw,
      };
      onLog?.(
        "INFO",
        `VIP daily: hôm nay đã claim rồi (${serverToday}) · VIP ${summary.vipLevel ?? "?"} · chờ 00:00 VN`
      );
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    // claimed_today = false → claim
    onLog?.("INFO", `VIP daily: chưa claim (${serverToday}) · đang rpc_claim_vip_daily...`);
    const claim = await rpc(
      "rpc_claim_vip_daily",
      { p_character_id: options.characterId },
      options.accessToken
    );

    const got = pickRewards(claim);
    const newVip = Number(claim?.new_vip_level ?? claim?.vip_level ?? vipLevel);
    summary.status = "CLAIMED";
    summary.claimedToday = true;
    summary.vipLevel = Number.isFinite(newVip) ? newVip : summary.vipLevel;
    summary.vipPoints = got.vipPoints ?? preview.vipPoints;
    summary.spiritStones = got.spiritStones;
    summary.battleMerit = got.battleMerit;
    summary.rewards = got.raw;
    summary.nextDelayMs = nextMidnight;
    summary.reason = formatRewards(got);
    summary.persist = {
      claimed_today: true,
      daily_date: serverToday,
      last_claim_at: new Date().toISOString(),
      vip_level: summary.vipLevel,
      last_rewards: got.raw,
    };

    onLog?.(
      "SUCCESS",
      `VIP daily: claim OK · ${formatRewards(got)} · VIP ${summary.vipLevel ?? "?"} · chờ 00:00 VN`
    );

    // Optional: auto claim artifacts (nếu API có) — lỗi mềm bỏ qua
    try {
      if (settings.auto_claim_artifacts !== false) {
        const art = await rpc(
          "rpc_vip_auto_claim_artifacts",
          { p_character_id: options.characterId },
          options.accessToken
        );
        const n = Array.isArray(art?.claimed) ? art.claimed.length : 0;
        if (n > 0) onLog?.("SUCCESS", `VIP artifacts: claim ${n} item`, art);
      }
    } catch {
      /* soft */
    }

    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error: any) {
    const msg = error?.message || String(error);
    const soft = /already|claimed|đã nhận|da nhan|daily/i.test(msg + JSON.stringify(error?.data || {}));
    if (soft) {
      summary.status = "ALREADY";
      summary.claimedToday = true;
      summary.nextDelayMs = nextMidnight;
      summary.reason = msg;
      summary.persist = {
        claimed_today: true,
        daily_date: todayVn,
        last_claim_at: new Date().toISOString(),
        vip_level: summary.vipLevel,
      };
      onLog?.("WARN", `VIP daily: ${msg} → đánh dấu đã claim hôm nay`);
    } else {
      summary.status = "ERROR";
      summary.reason = msg;
      summary.nextDelayMs = Math.min(nextMidnight, 15 * 60_000);
      summary.persist = {
        claimed_today: Boolean(settings.claimed_today),
        daily_date: String(settings.daily_date || todayVn),
        vip_level: summary.vipLevel,
      };
      onLog?.("ERROR", `VIP daily: ${msg}`, error?.data);
    }
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
}
