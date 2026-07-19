export type BreakthroughStatus = "WAITING" | "SUCCESS" | "FAILED_ROLL" | "PAUSED" | "ERROR" | "SKIPPED";

export interface BreakthroughRunSummary {
  status: BreakthroughStatus;
  checkedAt: string;
  level?: number | string;
  expCurrent?: number | string;
  expMax?: number | string;
  expPercent?: number;
  isFullExp: boolean;
  pillItemCode?: string;
  pillInstanceId?: string;
  boughtPill?: boolean;
  buyResult?: any;
  fromLevel?: number | string;
  toLevel?: number | string;
  success?: boolean;
  chancePct?: number | string;
  roll?: number | string;
  nextDelayMs: number;
  reason?: string;
  raw?: any;
}

export interface BreakthroughAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  account?: Record<string, any>;
  snapshot?: any;
  onLog?: (level: "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR", message: string, meta?: any) => void;
  shouldStop?: () => boolean;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

const clampNumber = (value: any, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const firstDefined = (...values: any[]) => values.find(value => value !== undefined && value !== null && value !== "");

const normalizeKey = (value: any) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const toNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const direct = Number(raw.replace(/,/g, ""));
  if (Number.isFinite(direct)) return direct;
  const compact = raw.replace(/\s+/g, "").replace(/\./g, "").replace(/,/g, ".");
  const n = Number(compact);
  return Number.isFinite(n) ? n : null;
};

const asArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.inventory)) return value.inventory;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
};

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

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err: any = new Error(data?.message || data?.error || data?.reason || `RPC ${name} HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }

  if (data && data.ok === false) {
    const err: any = new Error(data?.reason || data?.message || data?.error || `${name} ok=false`);
    err.data = data;
    throw err;
  }

  return data;
};

const reasonOf = (value: any) => normalizeKey([
  value?.message,
  value?.error,
  value?.reason,
  value?.code,
  value?.details,
  value?.hint,
  JSON.stringify(value || {}),
].filter(Boolean).join(" "));

const isNotEnoughPillReason = (value: any) => {
  const raw = reasonOf(value);
  return raw.includes("pill")
    || raw.includes("dan")
    || raw.includes("item")
    || raw.includes("inventory")
    || raw.includes("not_found")
    || raw.includes("not_enough")
    || raw.includes("insufficient")
    || raw.includes("missing");
};

const parseCodeList = (value: any, fallback: string[] = []) => {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  const items = raw
    .split(/[\n,;\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const item of items.length ? items : fallback) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

const getInventoryItemCode = (item: any): string => String(firstDefined(
  item?.item_code,
  item?.code,
  item?.itemCode,
  item?.item?.code,
  item?.template_code,
  item?.source_code,
  item?.base_code,
  ""
));

const getInventoryItemId = (item: any): string => String(firstDefined(
  item?.id,
  item?.instance_id,
  item?.item_instance_id,
  item?.inventory_item_id,
  item?.inventory_id,
  item?.item_id,
  item?.itemId,
  item?.item?.id,
  ""
));

const getInventoryQty = (item: any): number | null => toNumber(firstDefined(
  item?.qty,
  item?.quantity,
  item?.count,
  item?.amount,
  item?.stack,
  item?.stack_count,
  item?.num,
));

const findInventoryItemByCode = (inventoryData: any, itemCode: string) => {
  const target = normalizeKey(itemCode);
  return asArray(inventoryData).find(item => {
    const code = normalizeKey(getInventoryItemCode(item));
    const id = getInventoryItemId(item);
    const qty = getInventoryQty(item);
    return code === target && id && (qty === null || qty > 0);
  });
};

const listInventory = async (characterId: string, accessToken: string) => {
  try {
    return await rpc(accessToken, "rpc_list_inventory", { p_character_id: characterId, p_locale: "vi" });
  } catch (error) {
    return await rpc(accessToken, "rpc_list_inventory", { p_character_id: characterId });
  }
};

const getSnapshot = async (characterId: string, accessToken: string) => rpc(accessToken, "rpc_get_home_snapshot", { p_character_id: characterId });

const parseProgressPair = (value: any): { current: number; max: number } | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/([0-9][0-9,.\s]*)\s*\/\s*([0-9][0-9,.\s]*)/);
  if (!match) return null;
  const current = toNumber(match[1]);
  const max = toNumber(match[2]);
  if (current === null || max === null || max <= 0) return null;
  return { current, max };
};

const findExpPairDeep = (snapshot: any): { current: number | null; max: number | null } => {
  const explicitCurrent = firstDefined(
    snapshot?.character?.cultivation_exp_progress,
    snapshot?.character?.exp_current,
    snapshot?.character?.current_exp,
    snapshot?.resources?.exp_current,
    snapshot?.exp_current,
    snapshot?.current_exp,
  );
  const explicitMax = firstDefined(
    snapshot?.character?.cultivation_exp_required,
    snapshot?.character?.cultivation_exp_max,
    snapshot?.character?.exp_max,
    snapshot?.character?.required_exp,
    snapshot?.resources?.exp_max,
    snapshot?.exp_max,
    snapshot?.required_exp,
  );
  let current = toNumber(explicitCurrent);
  let max = toNumber(explicitMax);
  if (current !== null && max !== null) return { current, max };

  const seen = new Set<any>();
  const walk = (value: any, path: string[] = []): { current: number | null; max: number | null } | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);

    for (const [key, raw] of Object.entries(value)) {
      const nkey = normalizeKey(key);
      const joined = [...path, nkey].join("_");
      const pair = parseProgressPair(raw);
      if (pair && (joined.includes("exp") || joined.includes("xp") || joined.includes("cultivation"))) return pair;

      if (raw && typeof raw === "object") {
        const directCurrent = toNumber(firstDefined((raw as any).current, (raw as any).current_exp, (raw as any).exp_current, (raw as any).progress));
        const directMax = toNumber(firstDefined((raw as any).max, (raw as any).max_exp, (raw as any).exp_max, (raw as any).required, (raw as any).required_exp));
        const rawPath = [...path, nkey].join("_");
        if (directCurrent !== null && directMax !== null && directMax > 0 && (rawPath.includes("exp") || rawPath.includes("xp") || rawPath.includes("cultivation") || nkey.includes("progress"))) {
          return { current: directCurrent, max: directMax };
        }
        const nested = walk(raw, [...path, nkey]);
        if (nested) return nested;
      }
    }
    return null;
  };

  const found = walk(snapshot);
  if (found) return found;
  return { current, max };
};

const getLevelFromSnapshot = (snapshot: any, fallback: any) => firstDefined(
  snapshot?.character?.level_reach,
  snapshot?.character?.level,
  snapshot?.level_reach,
  snapshot?.level,
  fallback,
);

const isFullExp = (current: number | null, max: number | null, thresholdPercent: number) => {
  if (current === null || max === null || max <= 0) return false;
  return (current / max) * 100 >= thresholdPercent;
};

const findPillInstance = async (characterId: string, accessToken: string, itemCodes: string[], onLog?: BreakthroughAutoOptions["onLog"]) => {
  const inventory = await listInventory(characterId, accessToken);
  for (const itemCode of itemCodes) {
    const item = findInventoryItemByCode(inventory, itemCode);
    if (item) {
      const instanceId = getInventoryItemId(item);
      if (instanceId) return { itemCode, instanceId, item, inventory };
    }
  }
  onLog?.("DEBUG", "Không tìm thấy đan đột phá trong túi theo danh sách item code đã cấu hình.", { itemCodes, inventorySample: asArray(inventory).slice(0, 10) });
  return null;
};

export const runBreakthroughAuto = async ({
  characterId,
  accessToken,
  settings = {},
  account = {},
  snapshot,
  onLog,
  shouldStop,
}: BreakthroughAutoOptions): Promise<BreakthroughRunSummary> => {
  const intervalMs = clampNumber(settings.interval_seconds ?? 60, 10, 86400, 60) * 1000;
  const pauseMs = clampNumber(settings.pause_on_fail_minutes ?? 30, 1, 1440, 30) * 60_000;
  const thresholdPercent = clampNumber(settings.full_exp_threshold_percent ?? 99.99, 1, 100, 99.99);
  const itemCodes = parseCodeList(settings.pill_item_codes || settings.pill_item_code, ["pill_lk_minor"]);
  const shopCode = String(settings.shop_code || "alchemy");
  const buyQty = clampNumber(settings.buy_qty ?? 1, 1, 99, 1);
  const autoBuy = settings.auto_buy_pill !== false;
  const retryDelayMs = clampNumber(settings.retry_delay_ms ?? 700, 100, 10_000, 700);
  const checkedAt = new Date().toISOString();

  try {
    const snap = snapshot || await getSnapshot(characterId, accessToken);
    const level = getLevelFromSnapshot(snap, account?.level);
    const expPair = findExpPairDeep(snap);
    const current = expPair.current ?? toNumber(account?.expCurrent);
    const max = expPair.max ?? toNumber(account?.expMax);
    const percent = current !== null && max !== null && max > 0 ? (current / max) * 100 : undefined;
    const full = isFullExp(current, max, thresholdPercent);

    if (!full) {
      onLog?.("INFO", `Chưa đủ EXP đột phá: ${current ?? "?"}/${max ?? "?"}${percent !== undefined ? ` (${percent.toFixed(2)}%)` : ""}.`, { level, current, max, percent, thresholdPercent });
      return {
        status: "WAITING",
        checkedAt,
        level,
        expCurrent: current ?? undefined,
        expMax: max ?? undefined,
        expPercent: percent,
        isFullExp: false,
        nextDelayMs: intervalMs,
        reason: "exp_not_full",
      };
    }

    if (shouldStop?.()) {
      return { status: "SKIPPED", checkedAt, level, expCurrent: current ?? undefined, expMax: max ?? undefined, expPercent: percent, isFullExp: true, nextDelayMs: intervalMs, reason: "stopped" };
    }

    onLog?.("WARN", `EXP đã đầy ${percent !== undefined ? percent.toFixed(2) : "100"}%, bắt đầu đột phá level.`, { level, current, max, itemCodes });

    let pill = await findPillInstance(characterId, accessToken, itemCodes, onLog);
    let boughtPill = false;
    let buyResult: any = null;

    if (!pill && autoBuy) {
      for (const itemCode of itemCodes) {
        if (shouldStop?.()) break;
        try {
          onLog?.("INFO", `Không có ${itemCode}, mua ${buyQty} viên từ shop ${shopCode}.`, { itemCode, shopCode, buyQty });
          buyResult = await rpc(accessToken, "rpc_nh_shop_buy", {
            p_character_id: characterId,
            p_shop_code: shopCode,
            p_item_code: itemCode,
            p_qty: buyQty,
          });
          boughtPill = buyResult?.ok !== false;
          await sleep(retryDelayMs);
          pill = await findPillInstance(characterId, accessToken, [itemCode], onLog);
          if (pill) break;
        } catch (buyError: any) {
          onLog?.("WARN", `Mua đan ${itemCode} thất bại: ${buyError.message || "unknown"}.`, buyError?.data || { message: buyError.message });
          buyResult = buyError?.data || { ok: false, message: buyError.message };
        }
      }
    }

    if (!pill) {
      onLog?.("WARN", `Không có đan đột phá hợp lệ để lấy p_pill_instance_id. Pause ${Math.ceil(pauseMs / 60000)} phút.`, { itemCodes, autoBuy, buyResult });
      return {
        status: "PAUSED",
        checkedAt,
        level,
        expCurrent: current ?? undefined,
        expMax: max ?? undefined,
        expPercent: percent,
        isFullExp: true,
        boughtPill,
        buyResult,
        nextDelayMs: pauseMs,
        reason: "missing_pill_instance",
      };
    }

    let result: any;
    try {
      result = await rpc(accessToken, "rpc_breakthrough_v1", {
        p_character_id: characterId,
        p_pill_instance_id: pill.instanceId,
      });
    } catch (error: any) {
      const raw = error?.data || { message: error.message };
      const reason = reasonOf(raw) || String(error.message || "breakthrough_error");
      if (isNotEnoughPillReason(raw) && autoBuy) {
        onLog?.("WARN", `Đột phá báo thiếu đan/instance không hợp lệ, mua và thử lại một lần.`, { reason, raw });
        try {
          buyResult = await rpc(accessToken, "rpc_nh_shop_buy", {
            p_character_id: characterId,
            p_shop_code: shopCode,
            p_item_code: pill.itemCode || itemCodes[0],
            p_qty: buyQty,
          });
          boughtPill = true;
          await sleep(retryDelayMs);
          const retryPill = await findPillInstance(characterId, accessToken, [pill.itemCode || itemCodes[0]], onLog);
          if (retryPill) {
            pill = retryPill;
            result = await rpc(accessToken, "rpc_breakthrough_v1", {
              p_character_id: characterId,
              p_pill_instance_id: retryPill.instanceId,
            });
          } else {
            throw error;
          }
        } catch (retryError: any) {
          onLog?.("WARN", `Đột phá vẫn lỗi sau khi mua đan: ${retryError.message || "unknown"}.`, retryError?.data || { message: retryError.message });
          return {
            status: "PAUSED",
            checkedAt,
            level,
            expCurrent: current ?? undefined,
            expMax: max ?? undefined,
            expPercent: percent,
            isFullExp: true,
            pillItemCode: pill.itemCode,
            pillInstanceId: pill.instanceId,
            boughtPill,
            buyResult,
            nextDelayMs: pauseMs,
            reason: retryError.message || "breakthrough_retry_error",
            raw: retryError?.data,
          };
        }
      } else {
        onLog?.("ERROR", `Đột phá lỗi: ${error.message || "unknown"}.`, raw);
        return {
          status: "ERROR",
          checkedAt,
          level,
          expCurrent: current ?? undefined,
          expMax: max ?? undefined,
          expPercent: percent,
          isFullExp: true,
          pillItemCode: pill.itemCode,
          pillInstanceId: pill.instanceId,
          boughtPill,
          buyResult,
          nextDelayMs: pauseMs,
          reason: error.message || "breakthrough_error",
          raw,
        };
      }
    }

    const success = result?.success === true || result?.ok === true || Number(result?.to_level || 0) > Number(result?.from_level || level || 0);
    const status: BreakthroughStatus = success ? "SUCCESS" : "FAILED_ROLL";
    onLog?.(success ? "SUCCESS" : "WARN", success
      ? `Đột phá thành công: level ${result?.from_level ?? level} → ${result?.to_level ?? "?"}.`
      : `Đột phá trượt do tỉ lệ, không pause dài; chờ vòng sau.`,
      { result, pillItemCode: pill.itemCode, pillInstanceId: pill.instanceId, boughtPill });

    return {
      status,
      checkedAt,
      level,
      expCurrent: current ?? undefined,
      expMax: max ?? undefined,
      expPercent: percent,
      isFullExp: true,
      pillItemCode: pill.itemCode,
      pillInstanceId: pill.instanceId,
      boughtPill,
      buyResult,
      fromLevel: result?.from_level,
      toLevel: result?.to_level,
      success,
      chancePct: result?.chance_pct,
      roll: result?.roll,
      nextDelayMs: success ? intervalMs : intervalMs,
      reason: success ? "breakthrough_success" : "rate_failed",
      raw: result,
    };
  } catch (error: any) {
    onLog?.("ERROR", `Auto đột phá lỗi: ${error.message || "unknown"}.`, error?.data || { message: error.message });
    return {
      status: "ERROR",
      checkedAt,
      isFullExp: false,
      nextDelayMs: pauseMs,
      reason: error.message || "breakthrough_auto_error",
      raw: error?.data,
    };
  }
};
