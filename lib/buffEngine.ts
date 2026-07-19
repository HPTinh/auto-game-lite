export type BuffStatus = "SUCCESS" | "SKIPPED" | "ERROR";
export type BuffKind = "formation" | "talisman";

export interface BuffItemResult {
  kind: BuffKind;
  label: string;
  rpcName: string;
  itemCode: string;
  enabled: boolean;
  ok: boolean;
  used: boolean;
  replaced?: boolean;
  durationSec?: number;
  rolled?: Record<string, any>;
  error?: string;
  raw?: any;
}

export interface BuffRunSummary {
  status: BuffStatus;
  checkedCount: number;
  usedCount: number;
  skippedCount: number;
  failedCount: number;
  nextDelayMs: number;
  results: BuffItemResult[];
  reason?: string;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const clampNumber = (value: any, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const toBool = (value: any, fallback = true) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "bat", "bật"].includes(s)) return true;
  if (["0", "false", "no", "n", "off", "tat", "tắt"].includes(s)) return false;
  return fallback;
};

const parseLegacyBuffCodes = (settings: Record<string, any>) => String(settings?.buff_codes || "")
  .split(/[\n,;]+/)
  .map(item => item.trim())
  .filter(Boolean);

const rpc = async (accessToken: string, name: string, payload: Record<string, any>) => {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "supabase-flutter/2.12.0",
    },
    body: JSON.stringify(payload),
    credentials: "omit",
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err: any = new Error(data?.message || data?.error || `RPC ${name} HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
};

const isAlreadyActiveOrNoNeed = (data: any, errorText = "") => {
  const text = String(
    errorText ||
    data?.reason ||
    data?.message ||
    data?.error ||
    data?.code ||
    data?.details ||
    ""
  ).toLowerCase();
  return [
    "already",
    "active",
    "dang hieu luc",
    "đang hiệu lực",
    "chua het han",
    "chưa hết hạn",
    "not expired",
    "cooldown",
  ].some(keyword => text.includes(keyword));
};

const normalizeSuccess = (kind: BuffKind, label: string, rpcName: string, itemCode: string, data: any): BuffItemResult => {
  const ok = data?.ok !== false;
  const durationSec = Number(data?.duration_sec ?? data?.durationSec ?? data?.rolled?.duration_sec);
  return {
    kind,
    label,
    rpcName,
    itemCode,
    enabled: true,
    ok,
    used: ok && !isAlreadyActiveOrNoNeed(data),
    replaced: data?.replaced,
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    rolled: data?.rolled,
    raw: data,
  };
};

const runSingleBuff = async ({
  characterId,
  accessToken,
  kind,
  label,
  rpcName,
  itemCode,
}: {
  characterId: string;
  accessToken: string;
  kind: BuffKind;
  label: string;
  rpcName: string;
  itemCode: string;
}): Promise<BuffItemResult> => {
  if (!itemCode) {
    return {
      kind,
      label,
      rpcName,
      itemCode,
      enabled: true,
      ok: false,
      used: false,
      error: "Thiếu item_code",
    };
  }

  try {
    const data = await rpc(accessToken, rpcName, {
      p_character_id: characterId,
      p_item_code: itemCode,
    });
    return normalizeSuccess(kind, label, rpcName, itemCode, data);
  } catch (error: any) {
    const raw = error?.data;
    const msg = raw?.message || raw?.error || error?.message || "Buff lỗi không xác định";
    // guarded RPC có thể trả lỗi mềm khi buff còn hiệu lực; trường hợp này không nên xem là lỗi chết.
    if (isAlreadyActiveOrNoNeed(raw, msg)) {
      return {
        kind,
        label,
        rpcName,
        itemCode,
        enabled: true,
        ok: true,
        used: false,
        error: msg,
        raw,
      };
    }
    return {
      kind,
      label,
      rpcName,
      itemCode,
      enabled: true,
      ok: false,
      used: false,
      error: msg,
      raw,
    };
  }
};

export async function runAutoBuffCheck({
  characterId,
  accessToken,
  settings = {},
  onLog,
}: {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR", message: string, meta?: Record<string, any>) => void;
}): Promise<BuffRunSummary> {
  const intervalSeconds = clampNumber(settings.interval_seconds, 30, 24 * 3600, 300);
  const nextDelayMs = intervalSeconds * 1000;

  const enableFormation = toBool(settings.enable_formation_buff, true);
  const enableTalisman = toBool(settings.enable_talisman_buff, true);
  const formationItemCode = String(settings.formation_item_code || "formation_lk_dragon").trim();
  const talismanItemCode = String(settings.talisman_item_code || "talisman_lk_crit").trim();

  const tasks: Array<{ kind: BuffKind; label: string; rpcName: string; itemCode: string; enabled: boolean }> = [
    {
      kind: "formation",
      label: "Trận pháp",
      rpcName: "rpc_activate_formation_guarded",
      itemCode: formationItemCode,
      enabled: enableFormation,
    },
    {
      kind: "talisman",
      label: "Phù",
      rpcName: "rpc_activate_talisman_guarded",
      itemCode: talismanItemCode,
      enabled: enableTalisman,
    },
  ];

  // Tương thích dữ liệu cũ: nếu user còn lưu buff_codes thì tự suy ra checkbox/code.
  const legacyCodes = parseLegacyBuffCodes(settings);
  if (legacyCodes.length && !settings.formation_item_code && !settings.talisman_item_code) {
    for (const code of legacyCodes) {
      if (code.startsWith("formation_") && !tasks[0].itemCode) tasks[0].itemCode = code;
      if (code.startsWith("talisman_") && !tasks[1].itemCode) tasks[1].itemCode = code;
    }
  }

  const results: BuffItemResult[] = [];
  for (const task of tasks) {
    if (!task.enabled) {
      results.push({
        kind: task.kind,
        label: task.label,
        rpcName: task.rpcName,
        itemCode: task.itemCode,
        enabled: false,
        ok: true,
        used: false,
      });
      onLog?.("INFO", `Bỏ qua buff ${task.label} vì checkbox đang tắt.`, { itemCode: task.itemCode });
      continue;
    }

    onLog?.("INFO", `Đang buff ${task.label}: ${task.itemCode}`);
    const result = await runSingleBuff({
      characterId,
      accessToken,
      kind: task.kind,
      label: task.label,
      rpcName: task.rpcName,
      itemCode: task.itemCode,
    });
    results.push(result);

    if (result.ok && result.used) {
      onLog?.("SUCCESS", `Buff ${task.label} OK: ${task.itemCode}${result.durationSec ? ` (${result.durationSec}s)` : ""}.`, {
        itemCode: result.itemCode,
        rpcName: result.rpcName,
        durationSec: result.durationSec,
        replaced: result.replaced,
        rolled: result.rolled,
      });
    } else if (result.ok) {
      onLog?.("INFO", `Buff ${task.label} chưa cần dùng lại hoặc đã active: ${task.itemCode}.`, {
        itemCode: result.itemCode,
        rpcName: result.rpcName,
        raw: result.raw,
      });
    } else {
      onLog?.("WARN", `Buff ${task.label} lỗi: ${result.error || result.itemCode}.`, {
        itemCode: result.itemCode,
        rpcName: result.rpcName,
        error: result.error,
        raw: result.raw,
      });
    }
  }

  const enabledResults = results.filter(item => item.enabled);
  const usedCount = enabledResults.filter(item => item.ok && item.used).length;
  const failedCount = enabledResults.filter(item => !item.ok).length;
  const skippedCount = results.length - usedCount - failedCount;

  let status: BuffStatus = "SUCCESS";
  let reason: string | undefined;
  if (!enabledResults.length) {
    status = "SKIPPED";
    reason = "Chưa tick vật phẩm buff nào.";
  } else if (failedCount >= enabledResults.length && settings.stop_on_all_failed === true) {
    status = "ERROR";
    reason = "Tất cả buff đã chọn đều lỗi.";
  }

  return {
    status,
    checkedCount: enabledResults.length,
    usedCount,
    skippedCount,
    failedCount,
    nextDelayMs,
    results,
    reason,
  };
}
