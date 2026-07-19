"use client";

export type GiftcodeLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export type GiftcodeMode =
  | "until_success_count"
  | "try_all_for_each_account"
  | "shared_pool_remove_attempted";

export interface GiftcodeResult {
  code: string;
  ok: boolean;
  error?: string;
  data?: any;
}

export interface GiftcodeRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "NO_SUCCESS" | "PARTIAL_ERROR";
  mode: GiftcodeMode;
  totalCodes: number;
  attemptedCount: number;
  successCount: number;
  failCount: number;
  targetSuccessCount: number;
  attemptedCodes: string[];
  remainingCodes: string[];
  results: GiftcodeResult[];
}

export interface GiftcodeAutoOptions {
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: GiftcodeLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

function normalizeGiftcodes(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map(s => s.trim()).filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];

  String(input)
    .split(/[\n,;|]+/g)
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(code => {
      const key = code.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(code);
    });

  return result;
}

function normalizeMode(value: any): GiftcodeMode {
  const mode = String(value || "until_success_count");
  if (mode === "try_all_for_each_account") return "try_all_for_each_account";
  if (mode === "shared_pool_remove_attempted") return "shared_pool_remove_attempted";
  return "until_success_count";
}

async function rpc(name: string, payload: Record<string, any>, accessToken: string) {
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
    mode: "cors",
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error: any = new Error(`[${name}] HTTP ${res.status}: ${text}`);
    error.data = data;
    throw error;
  }

  if (data && data.ok === false) {
    const reason = data.error || data.reason || data.message || data.code || "ok_false";
    const error: any = new Error(`[${name}] ${reason}`);
    error.data = data;
    throw error;
  }

  return data;
}

export async function runGiftcodeAuto(options: GiftcodeAutoOptions): Promise<GiftcodeRunSummary> {
  const settings = options.settings || {};
  const mode = normalizeMode(settings.mode);
  const codes = normalizeGiftcodes(settings.giftcodes);
  const targetSuccessCount = Math.max(1, Number(settings.success_target || settings.targetSuccessCount || 1) || 1);

  const summary: GiftcodeRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "NO_SUCCESS",
    mode,
    totalCodes: codes.length,
    attemptedCount: 0,
    successCount: 0,
    failCount: 0,
    targetSuccessCount,
    attemptedCodes: [],
    remainingCodes: [...codes],
    results: [],
  };

  const { accessToken, onLog } = options;

  if (!codes.length) {
    summary.finishedAt = new Date().toISOString();
    onLog?.("WARN", "Giftcode list trống, không có code để nhập.");
    return summary;
  }

  onLog?.("INFO", `Bắt đầu nhập giftcode. Mode=${mode}, total=${codes.length}, targetSuccess=${targetSuccessCount}.`);

  for (const code of codes) {
    try {
      onLog?.("INFO", `Thử giftcode: ${code}`);
      const data = await rpc("rpc_redeem_token_code", { p_code: code }, accessToken);

      summary.successCount += 1;
      summary.attemptedCount += 1;
      summary.attemptedCodes.push(code);
      summary.results.push({ code, ok: true, data });

      onLog?.("SUCCESS", `Giftcode thành công: ${code}`, data);

      if (mode === "until_success_count" && summary.successCount >= targetSuccessCount) {
        onLog?.("SUCCESS", `Đã đủ ${summary.successCount}/${targetSuccessCount} code thành công, dừng.`);
        break;
      }

      if (mode === "shared_pool_remove_attempted" && summary.successCount >= targetSuccessCount) {
        onLog?.("SUCCESS", `Pool mode đã đủ ${summary.successCount}/${targetSuccessCount} code thành công, dừng account này.`);
        break;
      }
    } catch (error: any) {
      summary.failCount += 1;
      summary.attemptedCount += 1;
      summary.attemptedCodes.push(code);
      summary.results.push({ code, ok: false, error: error?.message, data: error?.data });

      onLog?.("WARN", `Giftcode thất bại: ${code} — ${error?.message || "unknown"}`, error?.data);
    }
  }

  const attemptedSet = new Set(summary.attemptedCodes.map(c => c.toUpperCase()));
  summary.remainingCodes = codes.filter(code => !attemptedSet.has(code.toUpperCase()));

  summary.finishedAt = new Date().toISOString();

  if (summary.successCount > 0 && summary.failCount > 0) {
    summary.status = "PARTIAL_ERROR";
  } else if (summary.successCount > 0) {
    summary.status = "DONE";
  } else {
    summary.status = "NO_SUCCESS";
  }

  onLog?.(summary.successCount > 0 ? "SUCCESS" : "WARN", "Kết thúc nhập giftcode.", {
    status: summary.status,
    mode: summary.mode,
    attempted: summary.attemptedCount,
    success: summary.successCount,
    fail: summary.failCount,
    remaining: summary.remainingCodes.length,
  });

  return summary;
}
