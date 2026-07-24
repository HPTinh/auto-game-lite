import { tryUsePillsLowToHigh, type PillKind } from "./pillUse";

export type CraftTierCode = "lk" | "tc" | "kd" | "na" | "ht" | "lh" | "unknown";
export type CraftStatus = "SUCCESS" | "RATE_FAILED" | "PAUSED" | "ERROR" | "SKIPPED";
export type CraftRecoveryKind = "material" | "stamina" | "spirit" | "unknown";

export interface CraftRecipe {
  meta?: Record<string, any>;
  category?: string;
  output_qty?: number;
  output_code?: string;
  recipe_code?: string;
  requirements?: Record<string, number>;
  success_rate?: number;
  output_rarity?: string;
  [key: string]: any;
}

export interface NormalizedCraftRecipe extends CraftRecipe {
  tierCode: CraftTierCode;
  tierLabel: string;
  kindLabel: string;
  displayName: string;
  requirementText: string;
}

export interface CraftRunSummary {
  status: CraftStatus;
  category: string;
  tierCode: CraftTierCode;
  recipeCode: string;
  outputCode?: string;
  times: number;
  successCount: number;
  failCount: number;
  rewards: Array<{ code?: string; qty?: number; [key: string]: any }>;
  rate?: number;
  masteryXp?: number;
  masteryGain?: number;
  masteryLevel?: number;
  nextDelayMs: number;
  reason?: string;
  recoveryKind?: CraftRecoveryKind;
  recoveryAction?: string;
  usedItems?: Array<{ itemCode: string; ok: boolean; raw?: any }>;
  openedContainers?: number;
  raw?: any;
}

interface CraftAnalysis {
  ok: boolean;
  status: CraftStatus;
  reason?: string;
  successCount: number;
  failCount: number;
  rewards: Array<{ code?: string; qty?: number; [key: string]: any }>;
  data: any;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const TIER_ORDER: CraftTierCode[] = ["lk", "tc", "kd", "na", "ht", "lh"];
const TIER_LABELS: Record<string, string> = {
  lk: "Tier 1 - Luyện Khí (lk)",
  tc: "Tier 2 - Trúc Cơ (tc)",
  kd: "Tier 3 - Kim Đan (kd)",
  na: "Tier 4 - Nguyên Anh (na)",
  ht: "Tier 5 - Hoá Thần (ht)",
  lh: "Tier 6 - Luyện Hư (lh)",
  unknown: "Không rõ tier",
};

const CATEGORY_LABELS: Record<string, string> = {
  alchemy: "Luyện đan (hệ Mộc)",
  /** API: forging (không phải forge) */
  forging: "Luyện khí",
  forge: "Luyện khí",
  /** API: formation (không phải array) */
  formation: "Trận pháp",
  array: "Trận pháp",
  /** API: talisman */
  talisman: "Phù lục",
};

/** Category list + craft hiện hỗ trợ (rpc_list_recipes p_category) */
export const CRAFT_SUPPORTED_CATEGORIES = ["alchemy", "forging", "talisman", "formation"] as const;
export type CraftSupportedCategory = (typeof CRAFT_SUPPORTED_CATEGORIES)[number];

/** VIP tối thiểu để dùng rpc_craft_auto (craft nhanh) */
export const CRAFT_QUICK_MIN_VIP = 5;
/** Delay mặc định craft nhanh (ms) — craft.txt ~3s/lần */
export const CRAFT_QUICK_DEFAULT_DELAY_MS = 3000;

/**
 * Chuẩn hoá category gửi RPC (craft.txt):
 * - alchemy | forging | talisman | formation
 */
export const normalizeCraftCategory = (category: any): CraftSupportedCategory => {
  const raw = String(category || "alchemy").toLowerCase().trim();
  if (raw === "forging" || raw === "forge" || raw === "luyen_khi" || raw === "luyện khí" || raw === "luyen khi") {
    return "forging";
  }
  if (raw === "alchemy" || raw === "luyen_dan" || raw === "luyện đan" || raw === "luyen dan") {
    return "alchemy";
  }
  if (raw === "talisman" || raw === "phu_luc" || raw === "phù lục" || raw === "phu luc") {
    return "talisman";
  }
  if (
    raw === "formation" ||
    raw === "array" ||
    raw === "tran_phap" ||
    raw === "trận pháp" ||
    raw === "tran phap"
  ) {
    return "formation";
  }
  if ((CRAFT_SUPPORTED_CATEGORIES as readonly string[]).includes(raw)) return raw as CraftSupportedCategory;
  return "alchemy";
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const clampNumber = (value: any, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const getCraftTierLabel = (tier: any) => TIER_LABELS[String(tier || "unknown").toLowerCase()] || String(tier || "?");
export const getCraftCategoryLabel = (category: any) => {
  const norm = normalizeCraftCategory(category);
  return CATEGORY_LABELS[norm] || CATEGORY_LABELS[String(category || "alchemy")] || String(category || "alchemy");
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

export const inferCraftTier = (recipe: any): CraftTierCode => {
  const metaTier = String(recipe?.meta?.realm_code || recipe?.meta?.tier || "").toLowerCase().trim();
  if (TIER_ORDER.includes(metaTier as CraftTierCode)) return metaTier as CraftTierCode;

  const values = [
    recipe?.recipe_code,
    recipe?.output_code,
    ...Object.keys(recipe?.requirements || {}),
  ].map(value => String(value || "").toLowerCase());

  for (const tier of TIER_ORDER) {
    const re = new RegExp(`(^|_)${tier}(_|$)`);
    if (values.some(value => re.test(value))) return tier;
  }

  return "unknown";
};

const inferTierFromCode = (recipeCode: string, settingsTier: any): CraftTierCode => {
  const tierFromSetting = String(settingsTier || "").toLowerCase().trim();
  if (TIER_ORDER.includes(tierFromSetting as CraftTierCode)) return tierFromSetting as CraftTierCode;
  return inferCraftTier({ recipe_code: recipeCode });
};

const inferKindLabel = (recipe: any) => {
  const code = String(recipe?.recipe_code || recipe?.output_code || "").toLowerCase();
  const meta = recipe?.meta || {};
  const cat = String(recipe?.category || "").toLowerCase();
  // Formation / trận pháp
  if (cat === "formation" || code.includes("formation") || code.includes("tran") || code.includes("array")) {
    if (code.includes("dragon")) return "Trận Rồng";
    if (code.includes("tiger")) return "Trận Hổ";
    if (code.includes("turtle")) return "Trận Rùa";
    if (code.includes("tu_linh")) return "Trận Tứ Linh";
    if (code.includes("ngu_hanh")) return "Ngũ Hành Trận";
    return "Trận pháp";
  }
  // Talisman / phù lục
  if (cat === "talisman" || code.includes("talisman") || code.includes("phu")) {
    if (code.includes("_atk") || code.includes("atk")) return "Phù ATK";
    if (code.includes("crit")) return "Phù Crit";
    if (code.includes("_def") || code.includes("def")) return "Phù DEF";
    if (code.includes("_hp") || code.includes("hp")) return "Phù HP";
    if (code.includes("tu_linh")) return "Phù Tứ Linh";
    if (code.includes("tay_tuy")) return "Tẩy tuỷ phù";
    return "Phù lục";
  }
  // Forging / luyện khí
  if (meta.dao_khi || code.includes("dao_khi") || code.includes("dao_quang") || code.includes("dao_tinh") || code.includes("dao_hon")) {
    return "Đạo khí";
  }
  if (code.includes("eq_weapon") || code.includes("_weapon_")) return "Vũ khí";
  if (code.includes("eq_armor") || code.includes("_armor_")) return "Giáp";
  if (code.includes("eq_boots") || code.includes("_boots_")) return "Giày";
  if (code.includes("eq_accessory") || code.includes("_accessory_")) return "Phụ kiện";
  // Alchemy / luyện đan
  if (meta.kind === "tu_vi" || code.includes("tu_vi")) return "Đan tu vi";
  if (code.includes("linh_thu")) return "Linh thú đan";
  if (code.includes("_realm")) return "Đan đột phá";
  if (code.includes("_hp")) return "Đan HP";
  if (code.includes("_mp")) return "Đan MP";
  if (code.includes("_sta")) return "Đan thể lực";
  if (code.includes("_spirit")) return "Đan thần hồn / linh khí";
  if (code.includes("major")) return "Đại đan";
  if (code.includes("minor")) return "Tiểu đan";
  return "Khác";
};

const formatRequirements = (requirements: any) => {
  const rows = Object.entries(requirements || {});
  if (!rows.length) return "Không rõ nguyên liệu";
  return rows.map(([code, qty]) => `${code} x${qty}`).join(", ");
};

export const normalizeCraftRecipe = (recipe: CraftRecipe): NormalizedCraftRecipe => {
  const tierCode = inferCraftTier(recipe);
  const outputCode = String(recipe?.output_code || "?");
  const recipeCode = String(recipe?.recipe_code || "?");
  return {
    ...recipe,
    tierCode,
    tierLabel: getCraftTierLabel(tierCode),
    kindLabel: inferKindLabel(recipe),
    displayName: `${outputCode} · ${recipeCode}`,
    requirementText: formatRequirements(recipe?.requirements),
  };
};

export const filterCraftRecipes = (recipes: CraftRecipe[], tier: string, search = "") => {
  const wantedTier = String(tier || "all").toLowerCase();
  const keyword = String(search || "").trim().toLowerCase();
  return (recipes || [])
    .map(normalizeCraftRecipe)
    .filter(recipe => wantedTier === "all" || recipe.tierCode === wantedTier)
    .filter(recipe => {
      if (!keyword) return true;
      return [recipe.output_code, recipe.recipe_code, recipe.kindLabel, recipe.output_rarity, recipe.requirementText]
        .map(value => String(value || "").toLowerCase())
        .some(value => value.includes(keyword));
    })
    .sort((a, b) => {
      const aTier = TIER_ORDER.indexOf(a.tierCode);
      const bTier = TIER_ORDER.indexOf(b.tierCode);
      const tierCmp = (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
      if (tierCmp) return tierCmp;
      return String(a.recipe_code || "").localeCompare(String(b.recipe_code || ""));
    });
};

export const listCraftRecipes = async ({
  characterId,
  accessToken,
  category = "alchemy",
}: {
  characterId?: string;
  accessToken: string;
  category?: string;
}) => {
  // API: p_category = alchemy | forging (luyện khí — craft.txt)
  const pCategory = normalizeCraftCategory(category);
  // characterId giữ lại nếu RPC sau này cần
  void characterId;
  const data = await rpc(accessToken, "rpc_list_recipes", { p_category: pCategory });
  const rows = Array.isArray(data) ? data : Array.isArray(data?.recipes) ? data.recipes : Array.isArray(data?.items) ? data.items : [];
  return rows.map((row) => {
    const normalized = normalizeCraftRecipe(row);
    // gắn category chuẩn nếu row thiếu
    if (!normalized.category) normalized.category = pCategory;
    return normalized;
  });
};

const reasonOf = (data: any) => String(data?.reason || data?.message || data?.error || data?.code || data?.details || "").toLowerCase();

const hasAny = (text: string, keywords: string[]) => keywords.some(keyword => text.includes(keyword));

const isMaterialReason = (reason: string) => hasAny(reason, [
  "missing_material",
  "not_enough_material",
  "insufficient_material",
  "material_not_enough",
  "no_material",
  "ingredient",
  "missing_ingredient",
  "not_enough_item",
  "item_not_enough",
  "nguyen_lieu",
  "nguyên liệu",
  "thieu_nguyen_lieu",
  "thiếu nguyên liệu",
]);

const isSpiritReason = (reason: string) => hasAny(reason, [
  "spirit",
  "soul",
  "than_hon",
  "thần hồn",
  "shenhun",
  "linh_khi",
  "linh khí",
]);

const isStaminaReason = (reason: string) => hasAny(reason, [
  "stamina",
  "sta",
  "the_luc",
  "thể lực",
  "energy",
  "not_enough_resources",
  "insufficient_resources",
  "resource_not_enough",
  "resources_not_enough",
]);

const recoveryKindsForReason = (reason: string): CraftRecoveryKind[] => {
  const kinds: CraftRecoveryKind[] = [];
  if (isStaminaReason(reason)) kinds.push("stamina");
  if (isSpiritReason(reason)) kinds.push("spirit");
  // Một số server chỉ trả not_enough_resources, không nói rõ là thể lực hay thần hồn.
  // Thử thể lực trước, rồi thần hồn nếu vẫn chưa craft được.
  if (hasAny(reason, ["not_enough_resources", "insufficient_resources", "resource_not_enough", "resources_not_enough"]) && !kinds.includes("spirit")) {
    kinds.push("spirit");
  }
  return kinds.length ? kinds : ["unknown"];
};

const analyzeCraftData = (data: any): CraftAnalysis => {
  const successCount = Number(data?.success ?? data?.success_count ?? 0) || 0;
  const failCount = Number(data?.fail ?? data?.fail_count ?? 0) || 0;
  const rewards = Array.isArray(data?.rewards) ? data.rewards : [];

  if (data?.ok !== false && successCount > 0) {
    return { ok: true, status: "SUCCESS", successCount, failCount, rewards, data };
  }

  if (data?.ok !== false && successCount <= 0 && failCount > 0) {
    return {
      ok: true,
      status: "RATE_FAILED",
      reason: "craft_rate_failed",
      successCount,
      failCount,
      rewards,
      data,
    };
  }

  return {
    ok: false,
    status: "PAUSED",
    reason: reasonOf(data) || "craft_no_success",
    successCount,
    failCount,
    rewards,
    data,
  };
};

const summaryFromAnalysis = ({
  analysis,
  status,
  category,
  tierCode,
  recipeCode,
  times,
  nextDelayMs,
  reason,
  recoveryKind,
  recoveryAction,
  usedItems = [],
  openedContainers = 0,
}: {
  analysis: CraftAnalysis;
  status?: CraftStatus;
  category: string;
  tierCode: CraftTierCode;
  recipeCode: string;
  times: number;
  nextDelayMs: number;
  reason?: string;
  recoveryKind?: CraftRecoveryKind;
  recoveryAction?: string;
  usedItems?: Array<{ itemCode: string; ok: boolean; raw?: any }>;
  openedContainers?: number;
}): CraftRunSummary => {
  const data = analysis.data || {};
  return {
    status: status || analysis.status,
    category: String(data?.category || category),
    tierCode,
    recipeCode: String(data?.recipe_code || recipeCode),
    outputCode: analysis.rewards?.[0]?.code,
    times,
    successCount: analysis.successCount,
    failCount: analysis.failCount,
    rewards: analysis.rewards,
    rate: Number(data?.rate ?? data?.success_rate ?? 0) || undefined,
    masteryXp: Number(data?.mastery_xp ?? 0) || undefined,
    masteryGain: Number(data?.mastery_gain ?? 0) || undefined,
    masteryLevel: Number(data?.mastery_level ?? 0) || undefined,
    nextDelayMs,
    reason: reason || analysis.reason,
    recoveryKind,
    recoveryAction,
    usedItems,
    openedContainers,
    raw: data,
  };
};

export const runCraftAuto = async ({
  characterId,
  accessToken,
  settings = {},
  onLog,
  shouldStop,
}: {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR", message: string, meta?: Record<string, any>) => void;
  shouldStop?: () => boolean;
}): Promise<CraftRunSummary> => {
  const category = normalizeCraftCategory(settings.category || settings.craft_category || "alchemy");
  const recipeCode = String(settings.recipe_code || settings.selected_recipe_code || "").trim();
  const tierCode = inferTierFromCode(recipeCode, settings.tier || settings.realm_code || settings.selected_recipe_tier);
  const times = clampNumber(settings.times_per_run ?? settings.p_times ?? 1, 1, 50, 1);
  const pauseMinutes = clampNumber(settings.pause_on_fail_minutes ?? 30, 1, 24 * 60, 30);
  const pauseMs = pauseMinutes * 60_000;
  const autoOpenContainers = settings.auto_open_containers !== false;
  const autoUseRecoveryItems = settings.auto_use_recovery_items !== false;
  const retryDelayMs = clampNumber(settings.retry_delay_ms ?? 700, 200, 5000, 700);
  /** Mỗi loại (STA/spirit) tối đa N lần uống nếu 1 viên chưa đủ (vd heal_stamina=5) */
  const maxRecoveryUses = clampNumber(settings.max_recovery_uses ?? settings.recovery_max_uses ?? 8, 1, 30, 8);

  // VIP >= 5 + bật quick → rpc_craft_auto, delay ~3s (craft.txt)
  const vipLevel = Number(settings.vip_level ?? settings.vipLevel ?? settings.vip ?? 0);
  const wantQuick =
    settings.use_quick_craft === true ||
    settings.quick_craft === true ||
    String(settings.mode || "").toLowerCase() === "auto" ||
    String(settings.mode || "").toLowerCase() === "quick";
  const canQuick = wantQuick && Number.isFinite(vipLevel) && vipLevel >= CRAFT_QUICK_MIN_VIP;
  const craftRpc = canQuick ? "rpc_craft_auto" : "rpc_craft_manual";

  // Delay: quick min 3s; manual theo interval_seconds (default 20)
  const quickDelayMs = Math.max(
    CRAFT_QUICK_DEFAULT_DELAY_MS,
    clampNumber(settings.quick_craft_delay_ms ?? settings.quick_delay_ms ?? CRAFT_QUICK_DEFAULT_DELAY_MS, 3000, 60_000, CRAFT_QUICK_DEFAULT_DELAY_MS)
  );
  const intervalSeconds = clampNumber(settings.interval_seconds ?? 20, 3, 24 * 60 * 60, 20);
  const intervalMs = canQuick ? quickDelayMs : intervalSeconds * 1000;

  if (!recipeCode) {
    onLog?.("WARN", "Auto Craft chưa chọn recipe_code.", { category, tierCode });
    return {
      status: "SKIPPED",
      category,
      tierCode,
      recipeCode: "",
      times,
      successCount: 0,
      failCount: 0,
      rewards: [],
      nextDelayMs: intervalMs,
      reason: "missing_recipe_code",
    };
  }

  if (shouldStop?.()) {
    return {
      status: "SKIPPED",
      category,
      tierCode,
      recipeCode,
      times,
      successCount: 0,
      failCount: 0,
      rewards: [],
      nextDelayMs: intervalMs,
      reason: "stopped",
    };
  }

  if (wantQuick && !canQuick) {
    onLog?.(
      "WARN",
      `Craft nhanh cần VIP >= ${CRAFT_QUICK_MIN_VIP} (hiện VIP ${Number.isFinite(vipLevel) ? vipLevel : "?"}) → dùng rpc_craft_manual`
    );
  }

  const usedItems: Array<{ itemCode: string; ok: boolean; raw?: any }> = [];
  let openedContainers = 0;

  const craftOnce = async () => {
    // craft.txt: rpc_craft_auto (VIP nhanh) / rpc_craft_manual (thủ công)
    // body: p_character_id, p_recipe_code, p_times
    const data = await rpc(accessToken, craftRpc, {
      p_character_id: characterId,
      p_recipe_code: recipeCode,
      p_times: times,
    });
    return analyzeCraftData(data);
  };

  const openContainers = async () => {
    onLog?.("WARN", `Craft thiếu nguyên liệu cho ${recipeCode}, mở toàn bộ rương rồi thử lại.`, { recipeCode });
    const opened = await rpc(accessToken, "rpc_open_all_containers", { p_character_id: characterId });
    openedContainers = Number(opened?.opened || opened?.count || opened?.opened_count || 0) || 0;
    onLog?.("INFO", `Mở rương xong: opened=${openedContainers}.`, { opened });
    await sleep(retryDelayMs);
    return opened;
  };

  /** Nhớ mã đan đã OK trong phiên → lần sau thử trước, vẫn fallback thấp→cao */
  const preferredPill: Partial<Record<"stamina" | "spirit", string>> = {};

  const useRecoveryItem = async (kind: CraftRecoveryKind) => {
    if (kind !== "stamina" && kind !== "spirit") {
      return { ok: false, reason: "unsupported_recovery_kind" };
    }
    const pillKind = kind as PillKind;
    const label = kind === "spirit" ? "thần hồn/linh khí" : "thể lực (STA)";
    onLog?.("WARN", `Craft thiếu ${label} → thử đan thấp→cao (lk→…→lh)`, { recipeCode, kind });

    const result = await tryUsePillsLowToHigh({
      kind: pillKind,
      settings,
      preferredCode: preferredPill[pillKind],
      sleepMs: retryDelayMs,
      rpcUse: (itemCode) => rpc(accessToken, "rpc_use_item", { p_character_id: characterId, p_item_code: itemCode }),
      onLog: (level, message, meta) => onLog?.(level === "DEBUG" ? "DEBUG" : level, message, meta),
    });

    for (const t of result.tried) {
      usedItems.push({ itemCode: t.itemCode, ok: t.ok, raw: t.raw });
    }
    if (result.ok && result.itemCode) {
      preferredPill[pillKind] = result.itemCode;
      return { ...(result.used || {}), ok: true, itemCode: result.itemCode };
    }
    return { ok: false, reason: "no_pill_worked" };
  };

  /** Uống đan (có thể nhiều viên) rồi craft lại cho đến khi OK / hết lý do thiếu / hết pill */
  const recoverAndRetryCraft = async (reason: string): Promise<CraftAnalysis | null> => {
    if (!autoUseRecoveryItems) return null;
    if (!isStaminaReason(reason) && !isSpiritReason(reason)) return null;
    const kinds = recoveryKindsForReason(reason).filter((k) => k === "stamina" || k === "spirit") as CraftRecoveryKind[];
    let lastAnalysis: CraftAnalysis | null = null;
    let currentReason = reason;

    for (const kind of kinds) {
      if (shouldStop?.()) break;
      for (let u = 0; u < maxRecoveryUses; u += 1) {
        if (shouldStop?.()) break;
        // Chỉ tiếp tục kind này nếu reason vẫn khớp
        if (kind === "stamina" && !isStaminaReason(currentReason) && !hasAny(currentReason, ["not_enough_resources", "insufficient_resources"])) break;
        if (kind === "spirit" && !isSpiritReason(currentReason) && !hasAny(currentReason, ["not_enough_resources", "insufficient_resources"])) break;

        const used = await useRecoveryItem(kind);
        if (used?.ok === false) break; // hết pill / lỗi → thử kind khác hoặc pause

        lastAnalysis = await craftOnce();
        if (lastAnalysis.status === "SUCCESS" || lastAnalysis.status === "RATE_FAILED") {
          return lastAnalysis;
        }
        currentReason = lastAnalysis.reason || currentReason;

        // Hết thiếu STA/spirit → nếu thiếu NL thì mở rương
        if (autoOpenContainers && isMaterialReason(currentReason)) {
          await openContainers();
          lastAnalysis = await craftOnce();
          if (lastAnalysis.status === "SUCCESS" || lastAnalysis.status === "RATE_FAILED") {
            return lastAnalysis;
          }
          currentReason = lastAnalysis.reason || currentReason;
        }

        // Reason đã khác (vd hết STA rồi sang spirit) → thoát vòng use, vòng kind ngoài xử lý
        if (kind === "stamina" && isSpiritReason(currentReason) && !isStaminaReason(currentReason)) break;
        if (kind === "spirit" && isStaminaReason(currentReason) && !isSpiritReason(currentReason)) break;
        if (!isStaminaReason(currentReason) && !isSpiritReason(currentReason) && !hasAny(currentReason, ["not_enough_resources", "insufficient_resources"])) {
          break;
        }
      }
    }
    return lastAnalysis;
  };

  onLog?.(
    "INFO",
    `Craft ${recipeCode} x${times} · ${getCraftCategoryLabel(category)} · ${canQuick ? "QUICK rpc_craft_auto" : "manual rpc_craft_manual"} · VIP ${Number.isFinite(vipLevel) ? vipLevel : "?"} · next ${Math.round(intervalMs / 1000)}s`,
    { recipeCode, times, category, tierCode, craftRpc, vipLevel, canQuick }
  );

  try {
    let analysis = await craftOnce();

    if (analysis.status === "SUCCESS") {
      onLog?.("SUCCESS", `Craft OK ${recipeCode}: success=${analysis.successCount}, fail=${analysis.failCount}.`, { recipeCode, rewards: analysis.rewards, raw: analysis.data });
      return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, usedItems, openedContainers });
    }

    if (analysis.status === "RATE_FAILED") {
      onLog?.("WARN", `Craft trượt do tỉ lệ ${recipeCode}: success=0, fail=${analysis.failCount}. Không pause, chờ vòng tiếp theo.`, { recipeCode, raw: analysis.data });
      return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, reason: "craft_rate_failed", usedItems, openedContainers });
    }

    let reason = analysis.reason || "craft_no_success";

    if (autoOpenContainers && isMaterialReason(reason)) {
      await openContainers();
      analysis = await craftOnce();
      if (analysis.status === "SUCCESS") {
        onLog?.("SUCCESS", `Craft OK sau khi mở rương ${recipeCode}: success=${analysis.successCount}, fail=${analysis.failCount}.`, { recipeCode, rewards: analysis.rewards, raw: analysis.data });
        return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, recoveryKind: "material", recoveryAction: "open_containers", usedItems, openedContainers });
      }
      if (analysis.status === "RATE_FAILED") {
        onLog?.("WARN", `Mở rương xong nhưng craft trượt do tỉ lệ ${recipeCode}; không pause.`, { recipeCode, raw: analysis.data });
        return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, reason: "craft_rate_failed_after_open_containers", recoveryKind: "material", recoveryAction: "open_containers", usedItems, openedContainers });
      }
      reason = analysis.reason || reason;
    }

    if (autoUseRecoveryItems && (isStaminaReason(reason) || isSpiritReason(reason))) {
      const recovered = await recoverAndRetryCraft(reason);
      if (recovered) {
        analysis = recovered;
        if (analysis.status === "SUCCESS") {
          const lastKind = usedItems.length ? (String(usedItems[usedItems.length - 1]?.itemCode || "").includes("spirit") ? "spirit" : "stamina") : "stamina";
          onLog?.("SUCCESS", `Craft OK sau khi hồi STA/thần hồn ${recipeCode}.`, { recipeCode, rewards: analysis.rewards, raw: analysis.data, usedItems });
          return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, recoveryKind: lastKind, recoveryAction: "use_item", usedItems, openedContainers });
        }
        if (analysis.status === "RATE_FAILED") {
          onLog?.("WARN", `Hồi STA/thần hồn xong nhưng craft trượt do tỉ lệ ${recipeCode}; không pause.`, { recipeCode, raw: analysis.data, usedItems });
          return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, reason: "craft_rate_failed_after_recovery", recoveryKind: "stamina", recoveryAction: "use_item", usedItems, openedContainers });
        }
        reason = analysis.reason || reason;
      }
    }

    const recoveryKind: CraftRecoveryKind = isMaterialReason(reason) ? "material" : isSpiritReason(reason) ? "spirit" : isStaminaReason(reason) ? "stamina" : "unknown";
    onLog?.("WARN", `Craft pause ${Math.ceil(pauseMs / 60000)} phút ${recipeCode}: ${reason}.`, { recipeCode, reason, raw: analysis.data, usedItems, openedContainers });
    return summaryFromAnalysis({
      analysis,
      status: "PAUSED",
      category,
      tierCode,
      recipeCode,
      times,
      nextDelayMs: pauseMs,
      reason,
      recoveryKind,
      usedItems,
      openedContainers,
    });
  } catch (error: any) {
    const raw = error?.data;
    const reason = reasonOf(raw) || String(error.message || "craft_error").toLowerCase();

    // HTTP/RPC lỗi vẫn có thể là thiếu nguyên liệu/thể lực/thần hồn. Xử lý như response ok=false.
    try {
      if (autoOpenContainers && isMaterialReason(reason)) {
        await openContainers();
        const analysis = await craftOnce();
        if (analysis.status === "SUCCESS" || analysis.status === "RATE_FAILED") {
          const isRate = analysis.status === "RATE_FAILED";
          onLog?.(isRate ? "WARN" : "SUCCESS", isRate ? `Mở rương xong nhưng craft trượt do tỉ lệ ${recipeCode}; không pause.` : `Craft OK sau khi mở rương ${recipeCode}.`, { recipeCode, raw: analysis.data });
          return summaryFromAnalysis({ analysis, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, reason: isRate ? "craft_rate_failed_after_open_containers" : undefined, recoveryKind: "material", recoveryAction: "open_containers", usedItems, openedContainers });
        }
      }

      if (autoUseRecoveryItems && (isStaminaReason(reason) || isSpiritReason(reason))) {
        const fallbackAnalysis = analyzeCraftData(raw || { ok: false, reason });
        const recovered = await recoverAndRetryCraft(reason);
        if (recovered && (recovered.status === "SUCCESS" || recovered.status === "RATE_FAILED")) {
          const isRate = recovered.status === "RATE_FAILED";
          const lastKind = usedItems.length ? (String(usedItems[usedItems.length - 1]?.itemCode || "").includes("spirit") ? "spirit" : "stamina") : "stamina";
          onLog?.(isRate ? "WARN" : "SUCCESS", isRate ? `Hồi STA/thần hồn xong nhưng craft trượt do tỉ lệ; không pause.` : `Craft OK sau khi hồi STA/thần hồn ${recipeCode}.`, { recipeCode, raw: recovered.data, usedItems });
          return summaryFromAnalysis({ analysis: recovered, category, tierCode, recipeCode, times, nextDelayMs: intervalMs, reason: isRate ? "craft_rate_failed_after_recovery" : undefined, recoveryKind: lastKind as CraftRecoveryKind, recoveryAction: "use_item", usedItems, openedContainers });
        }
        onLog?.("WARN", `Craft pause ${Math.ceil(pauseMs / 60000)} phút ${recipeCode}: ${reason}.`, { recipeCode, reason, raw, usedItems });
        return summaryFromAnalysis({ analysis: fallbackAnalysis, status: "PAUSED", category, tierCode, recipeCode, times, nextDelayMs: pauseMs, reason, recoveryKind: isSpiritReason(reason) ? "spirit" : "stamina", usedItems, openedContainers });
      }
    } catch (recoverError: any) {
      onLog?.("WARN", `Phục hồi Craft thất bại ${recipeCode}: ${recoverError.message || "unknown"}.`, recoverError?.data || { message: recoverError.message });
    }

    onLog?.("ERROR", `Craft lỗi ${recipeCode}: ${error.message || "unknown"}.`, raw || { message: error.message });
    return {
      status: "ERROR",
      category,
      tierCode,
      recipeCode,
      times,
      successCount: 0,
      failCount: 1,
      rewards: [],
      nextDelayMs: pauseMs,
      reason: error.message || "craft_error",
      recoveryKind: isMaterialReason(reason) ? "material" : isSpiritReason(reason) ? "spirit" : isStaminaReason(reason) ? "stamina" : "unknown",
      usedItems,
      openedContainers,
      raw,
    };
  }
};
