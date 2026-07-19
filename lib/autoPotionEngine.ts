"use client";

export type AutoPotionLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface AutoPotionRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "SKIPPED" | "PARTIAL_ERROR" | "ERROR";
  hpPercent: number | null;
  mpPercent: number | null;
  usedHp: boolean;
  usedMp: boolean;
  errors: string[];
  results: any[];
}

export interface AutoPotionOptions {
  characterId: string;
  accessToken: string;
  hp?: number | string;
  maxHp?: number | string;
  mp?: number | string;
  maxMp?: number | string;
  settings?: Record<string, any>;
  onLog?: (level: AutoPotionLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB".replace("q9nKB", "q9nKB");

function percent(current: any, max: any) {
  const c = Number(current);
  const m = Number(max);
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return null;
  return Math.round((c / m) * 100);
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
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const error: any = new Error(`[${name}] HTTP ${res.status}: ${text}`);
    error.data = data;
    throw error;
  }
  if (data && data.ok === false) {
    const error: any = new Error(`[${name}] ${data.error || data.reason || data.message || "ok_false"}`);
    error.data = data;
    throw error;
  }
  return data;
}

async function useItem(accessToken: string, characterId: string, itemCode: string) {
  const payloads = [
    { p_character_id: characterId, p_item_code: itemCode },
    { p_character_id: characterId, p_code: itemCode },
    { p_character_id: characterId, p_item_id: itemCode },
  ];

  let lastError: any = null;
  for (const payload of payloads) {
    try {
      return await rpc("rpc_use_item", payload, accessToken);
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function runAutoPotionCheck(options: AutoPotionOptions): Promise<AutoPotionRunSummary> {
  const settings = options.settings || {};
  const hpThreshold = Math.max(1, Math.min(99, Number(settings.hp_percent || 20)));
  const mpThreshold = Math.max(1, Math.min(99, Number(settings.mp_percent || 20)));
  const hpItemCode = String(settings.hp_item_code || "pill_lk_hp").trim();
  const mpItemCode = String(settings.mp_item_code || "pill_lk_mp").trim();

  const summary: AutoPotionRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "SKIPPED",
    hpPercent: percent(options.hp, options.maxHp),
    mpPercent: percent(options.mp, options.maxMp),
    usedHp: false,
    usedMp: false,
    errors: [],
    results: [],
  };

  options.onLog?.("INFO", `Kiểm tra HP/MP: HP=${summary.hpPercent ?? "?"}%, MP=${summary.mpPercent ?? "?"}%. Ngưỡng HP=${hpThreshold}%, MP=${mpThreshold}%.`);

  if (summary.hpPercent !== null && summary.hpPercent <= hpThreshold && hpItemCode) {
    try {
      const data = await useItem(options.accessToken, options.characterId, hpItemCode);
      summary.usedHp = true;
      summary.results.push({ type: "hp", itemCode: hpItemCode, data });
      options.onLog?.("SUCCESS", `Đã dùng bình HP: ${hpItemCode}.`, data);
    } catch (error: any) {
      summary.errors.push(error?.message || "Dùng HP lỗi");
      options.onLog?.("ERROR", `Dùng bình HP lỗi: ${error?.message || "unknown"}`, error?.data);
    }
  }

  if (summary.mpPercent !== null && summary.mpPercent <= mpThreshold && mpItemCode) {
    try {
      const data = await useItem(options.accessToken, options.characterId, mpItemCode);
      summary.usedMp = true;
      summary.results.push({ type: "mp", itemCode: mpItemCode, data });
      options.onLog?.("SUCCESS", `Đã dùng bình MP: ${mpItemCode}.`, data);
    } catch (error: any) {
      summary.errors.push(error?.message || "Dùng MP lỗi");
      options.onLog?.("ERROR", `Dùng bình MP lỗi: ${error?.message || "unknown"}`, error?.data);
    }
  }

  summary.finishedAt = new Date().toISOString();
  if (summary.errors.length && !summary.usedHp && !summary.usedMp) summary.status = "ERROR";
  else if (summary.errors.length) summary.status = "PARTIAL_ERROR";
  else if (summary.usedHp || summary.usedMp) summary.status = "DONE";
  else summary.status = "SKIPPED";

  options.onLog?.(summary.status === "ERROR" ? "ERROR" : summary.status === "DONE" ? "SUCCESS" : "INFO", "Kết thúc kiểm tra HP/MP.", {
    status: summary.status,
    hpPercent: summary.hpPercent,
    mpPercent: summary.mpPercent,
    usedHp: summary.usedHp,
    usedMp: summary.usedMp,
  });

  return summary;
}
