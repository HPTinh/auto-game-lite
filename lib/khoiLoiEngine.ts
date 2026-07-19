/**
 * Auto Claim Khôi Lỗi (Puppet idle farm)
 * - rpc_get_puppets { p_character_id } → list puppets + pending
 * - rpc_claim_puppet_idle { p_puppet_id } → claim drops
 *
 * Chạy định kỳ tối thiểu 2 giờ/lần (setting interval_hours).
 */

export type KhoiLoiLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface KhoiLoiClaimResult {
  puppetId: string;
  tier?: number;
  ok: boolean;
  drops?: { qty: number; mob_kind?: string; item_code?: string }[];
  error?: string;
}

export interface KhoiLoiRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "SKIPPED" | "PARTIAL" | "ERROR" | "EMPTY";
  ownedCount: number;
  claimedCount: number;
  skipCount: number;
  totalDrops: number;
  results: KhoiLoiClaimResult[];
  nextDelayMs: number;
  reason?: string;
}

export interface KhoiLoiAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: KhoiLoiLogLevel, message: string, meta?: any) => void;
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

function pendingTotal(pending: any): number {
  if (!pending || typeof pending !== "object") return 0;
  const n = Number(pending.boss || 0) + Number(pending.elite || 0) + Number(pending.normal || 0);
  return Number.isFinite(n) ? n : 0;
}

function dropTotal(drops: any[]): number {
  if (!Array.isArray(drops)) return 0;
  return drops.reduce((s, d) => s + (Number(d?.qty) || 0), 0);
}

export async function runKhoiLoiAuto(options: KhoiLoiAutoOptions): Promise<KhoiLoiRunSummary> {
  const settings = options.settings || {};
  // Tối thiểu 2 giờ, mặc định 2 giờ
  const intervalHours = Math.max(2, Math.min(48, Number(settings.interval_hours ?? 2) || 2));
  const nextDelayMs = intervalHours * 60 * 60_000;
  const onlyWithPending = settings.only_with_pending !== false;
  const claimDelayMs = Math.max(200, Number(settings.claim_delay_ms || 500));

  const summary: KhoiLoiRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    ownedCount: 0,
    claimedCount: 0,
    skipCount: 0,
    totalDrops: 0,
    results: [],
    nextDelayMs,
  };

  const onLog = options.onLog;

  try {
    onLog?.("INFO", `Khôi Lỗi: lấy danh sách puppet (rpc_get_puppets)...`);
    const data = await rpc(
      "rpc_get_puppets",
      { p_character_id: options.characterId },
      options.accessToken
    );

    const puppets = Array.isArray(data?.puppets) ? data.puppets : [];
    const owned = puppets.filter((p: any) => p?.owned === true && p?.unlocked !== false && p?.puppet_id);
    summary.ownedCount = owned.length;

    onLog?.(
      "INFO",
      `Khôi Lỗi: ${owned.length} puppet sở hữu · VIP ${data?.vip_level ?? "?"} · claim mỗi ≥${intervalHours}h`
    );

    if (owned.length === 0) {
      summary.status = "EMPTY";
      summary.reason = "Không có puppet";
      onLog?.("WARN", "Khôi Lỗi: chưa có puppet nào");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    for (const p of owned) {
      if (options.shouldStop?.()) break;

      const puppetId = String(p.puppet_id);
      const tier = Number(p.tier);
      const pending = p.pending || {};
      const total = pendingTotal(pending);

      if (onlyWithPending && total <= 0) {
        summary.skipCount += 1;
        onLog?.("DEBUG", `KL tier ${tier}: pending 0 · bỏ qua`);
        continue;
      }

      try {
        onLog?.(
          "INFO",
          `KL claim tier ${tier} · pending B${pending.boss || 0}/E${pending.elite || 0}/N${pending.normal || 0}`
        );
        const claim = await rpc(
          "rpc_claim_puppet_idle",
          { p_puppet_id: puppetId },
          options.accessToken
        );

        const drops = Array.isArray(claim?.drops) ? claim.drops : [];
        const qty = dropTotal(drops);
        summary.claimedCount += 1;
        summary.totalDrops += qty;
        summary.results.push({
          puppetId,
          tier,
          ok: true,
          drops: drops.map((d: any) => ({
            qty: Number(d?.qty) || 0,
            mob_kind: d?.mob_kind,
            item_code: d?.item_code,
          })),
        });

        const dropStr = drops
          .map((d: any) => `${d.mob_kind || "?"}×${d.qty || 0}`)
          .join(", ");
        onLog?.("SUCCESS", `KL tier ${tier}: claim OK · ${dropStr || "no drops"} · settled=${claim?.settled}`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        summary.results.push({ puppetId, tier, ok: false, error: msg });
        // empty pending soft
        if (/no.?pending|empty|nothing|already|không có/i.test(msg)) {
          summary.skipCount += 1;
          onLog?.("WARN", `KL tier ${tier}: ${msg.slice(0, 80)}`);
        } else {
          summary.status = "PARTIAL";
          onLog?.("ERROR", `KL tier ${tier}: ${msg.slice(0, 120)}`);
        }
      }

      await sleep(claimDelayMs);
    }

    if (summary.claimedCount === 0 && summary.status === "DONE") {
      summary.status = "EMPTY";
      summary.reason = "Không có pending để claim";
      onLog?.("INFO", "Khôi Lỗi: không có gì để claim");
    } else {
      onLog?.(
        "SUCCESS",
        `Khôi Lỗi xong · claim ${summary.claimedCount}/${summary.ownedCount} · drops ${summary.totalDrops} · next ${intervalHours}h`
      );
    }
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    onLog?.("ERROR", `Khôi Lỗi fail: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  summary.nextDelayMs = nextDelayMs;
  return summary;
}
