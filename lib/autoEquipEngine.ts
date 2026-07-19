"use client";

export type AutoEquipLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";
export type AutoEquipStatus = "DONE" | "NO_CHANGE" | "PARTIAL_ERROR" | "ERROR";

export interface AutoEquipCandidate {
  itemId: string;
  itemCode?: string;
  name?: string;
  slot: string;
  score: number;
  stats: Record<string, number>;
  raw?: any;
}

export interface AutoEquipChange {
  slot: string;
  before?: AutoEquipCandidate | null;
  after: AutoEquipCandidate;
  scoreGain: number;
  equipResult?: any;
  status: "EQUIPPED" | "DRY_RUN" | "SKIPPED" | "ERROR";
  error?: string;
}

export interface AutoEquipRunSummary {
  startedAt: string;
  finishedAt: string;
  status: AutoEquipStatus;
  scannedCount: number;
  equipmentCount: number;
  equippedCount: number;
  skippedCount: number;
  bestScore: number;
  currentScore: number;
  totalGain: number;
  slots: string[];
  changes: AutoEquipChange[];
  errors: string[];
  inventoryRpc?: string;
  equipmentRpc?: string;
  equipRpc?: string;
}

export interface AutoEquipOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: AutoEquipLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const DEFAULT_SLOT_ALIASES: Record<string, string> = {
  weapon: "weapon",
  vu_khi: "weapon",
  vukhi: "weapon",
  sword: "weapon",
  blade: "weapon",
  staff: "weapon",
  armor: "armor",
  ao: "armor",
  robe: "armor",
  chest: "armor",
  helmet: "helmet",
  helm: "helmet",
  mu: "helmet",
  boots: "boots",
  shoe: "boots",
  shoes: "boots",
  giay: "boots",
  ring: "ring",
  nhan: "ring",
  necklace: "necklace",
  amulet: "necklace",
  day_chuyen: "necklace",
  talisman: "talisman",
  charm: "talisman",
  bua: "talisman",
  accessory: "accessory",
  accessories: "accessory",
  phu_kien: "accessory",
};

function normalizeKey(value: any) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toNumber(value: any): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function firstDefined(...values: any[]) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function firstArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.inventory)) return value.inventory;
  if (Array.isArray(value?.bag)) return value.bag;
  if (Array.isArray(value?.equipments)) return value.equipments;
  if (Array.isArray(value?.equipment)) return value.equipment;
  if (Array.isArray(value?.equipped)) return value.equipped;
  if (Array.isArray(value?.gear)) return value.gear;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.result)) return value.result;

  if (value?.data && typeof value.data === "object") {
    const nested = firstArray(value.data);
    if (nested.length) return nested;
  }

  if (value && typeof value === "object") {
    const values = Object.values(value);
    const objectValues = values.filter(item => item && typeof item === "object");
    if (objectValues.length > 0 && objectValues.some(item => Boolean(getItemId(item) || detectSlot(item)))) {
      return objectValues;
    }
  }

  return [];
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
    const error: any = new Error(`[${name}] HTTP ${res.status}: ${text || res.statusText}`);
    error.data = data;
    error.status = res.status;
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

async function tryRpc(names: string[], payload: Record<string, any>, accessToken: string, onError?: (name: string, error: any) => void) {
  let lastError: any = null;
  for (const name of names) {
    try {
      const data = await rpc(name, payload, accessToken);
      return { name, data };
    } catch (error: any) {
      lastError = error;
      onError?.(name, error);
    }
  }
  throw lastError || new Error(`Không RPC nào chạy được: ${names.join(", ")}`);
}

function deepCollectStats(item: any) {
  // Chấm điểm theo chỉ số THẬT của item. Không lấy affix_caps/*_max vì đó là trần roll, không phải chỉ số đang có.
  const stats: Record<string, number> = {};

  const add = (name: string, value: any) => {
    const key = normalizeKey(name);
    if (!key || key.includes("max") || key.includes("cap")) return;
    const n = toNumber(value);
    if (!Number.isFinite(n) || n === 0) return;

    const setMax = (stat: string, raw = n) => {
      stats[stat] = Math.max(stats[stat] || 0, Math.abs(raw));
    };

    if (["atk", "attack", "cong", "damage", "dmg"].includes(key)) setMax("atk");
    else if (["def", "defense", "defence", "thu"].includes(key)) setMax("def");
    else if (["hp", "health", "mau"].includes(key)) setMax("hp");
    else if (["mp", "mana", "linh_luc"].includes(key)) setMax("mp");
    else if (["score", "power", "power_score", "total_score", "rating", "combat_power", "luc_chien"].includes(key)) setMax("score");
    else if (["crit", "crit_pct", "crit_rate", "critical"].includes(key)) setMax("crit");
    else if (["crit_dmg", "crit_dmg_pct", "critical_damage", "crit_mult"].includes(key)) setMax("critDmg");
    else if (["crit_resist", "crit_resist_pct"].includes(key)) setMax("critResist");
    else if (["crit_dmg_reduction", "crit_dmg_reduction_pct"].includes(key)) setMax("critReduction");
    else if (["dodge", "dodge_pct", "ne_tranh"].includes(key)) setMax("dodge");
    else if (["accuracy", "accuracy_pct", "chinh_xac"].includes(key)) setMax("accuracy");
    else if (["armor_pen", "armor_pen_pct", "xuyen_giap"].includes(key)) setMax("armorPen");
    else if (["speed", "spd", "toc_do", "atk_speed", "atk_speed_sec"].includes(key)) setMax("speed");
  };

  const addObject = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object") continue;
      add(key, value);
    }
  };

  // Ưu tiên rolled_stats vì preview rpc_get_equipment trả chỉ số thật ở đây.
  addObject(item?.rolled_stats);
  addObject(item?.stats);
  addObject(item?.effects);
  addObject(item?.bonus_stats);
  addObject(item?.affixes);
  addObject(item?.attributes);
  addObject(item?.final_stats);
  addObject(item?.finalStats);

  // Fallback top-level scalar nếu API khác trả chỉ số trực tiếp trên item.
  addObject(item);
  return stats;
}

function getItemId(item: any) {
  return String(firstDefined(
    item?.instance_id,
    item?.inventory_item_id,
    item?.equipment_instance_id,
    item?.item_instance_id,
    item?.item_id,
    item?.equipment_id,
    item?.id,
    item?.uid,
    item?.uuid,
    ""
  ));
}

function getItemCode(item: any) {
  return firstDefined(item?.item_code, item?.code, item?.equipment_code, item?.template_code, item?.base_code, item?.slug);
}

function getItemName(item: any) {
  return firstDefined(item?.name, item?.item_name, item?.equipment_name, item?.title, item?.label, getItemCode(item));
}

function normalizeSlot(raw: any): string {
  const key = normalizeKey(raw);
  if (!key) return "";
  return DEFAULT_SLOT_ALIASES[key] || key;
}

function detectSlot(item: any) {
  const direct = normalizeSlot(firstDefined(
    item?.slot,
    item?.equipment_slot,
    item?.equip_slot,
    item?.gear_slot,
    item?.position,
    item?.part,
    item?.wear_slot,
    item?.type_slot,
    item?.metadata?.slot,
    item?.meta?.slot,
    item?.template?.slot,
    item?.item?.slot,
  ));
  if (direct) return direct;

  const text = normalizeKey([
    item?.type,
    item?.item_type,
    item?.equipment_type,
    item?.category,
    item?.kind,
    item?.rarity_type,
    item?.item_code,
    item?.code,
    item?.name,
    item?.item_name,
  ].filter(Boolean).join(" "));

  for (const [alias, slot] of Object.entries(DEFAULT_SLOT_ALIASES)) {
    if (text.includes(alias)) return slot;
  }
  return "";
}

function isEquippable(item: any, settings: Record<string, any>) {
  if (!item || typeof item !== "object") return false;
  if (item.is_equipped === true || item.equipped === true || item.isEquipped === true) return true;
  const slot = detectSlot(item);
  if (slot) return true;

  const text = normalizeKey([
    item?.type,
    item?.item_type,
    item?.category,
    item?.kind,
    item?.source_type,
    item?.item_code,
    item?.code,
    item?.name,
  ].filter(Boolean).join(" "));

  if (["pill", "potion", "resource", "stone", "blood", "material", "fragment", "gift", "mail", "token"].some(k => text.includes(k))) return false;
  if (["equipment", "equip", "gear", "weapon", "armor", "helmet", "boots", "ring", "necklace", "talisman"].some(k => text.includes(k))) return true;

  return settings.allow_unknown_equipment === true;
}

function parseSlotFilter(settings: Record<string, any>) {
  const raw = String(settings.slot_filter || "").trim();
  if (!raw) return [];
  return raw.split(/[\n,;|]+/).map(normalizeSlot).filter(Boolean);
}

function weightPreset(settings: Record<string, any>) {
  const preset = normalizeKey(settings.weight_preset || "highest_stats");
  if (preset === "attack") return { atk: 2.5, def: 1, hp: 0.08, mp: 0.1, score: 1, crit: 1.2, critDmg: 1, critResist: 0.6, critReduction: 0.6, dodge: 0.5, accuracy: 0.5, armorPen: 0.8, speed: 0.5 };
  if (preset === "defense") return { atk: 1, def: 2.5, hp: 0.12, mp: 0.08, score: 1, crit: 0.6, critDmg: 0.6, critResist: 1, critReduction: 1, dodge: 0.8, accuracy: 0.5, armorPen: 0.4, speed: 0.4 };
  if (preset === "hp") return { atk: 1, def: 1.1, hp: 0.18, mp: 0.08, score: 1, crit: 0.6, critDmg: 0.6, critResist: 0.8, critReduction: 0.8, dodge: 0.5, accuracy: 0.5, armorPen: 0.4, speed: 0.4 };
  if (preset === "custom") return {
    atk: Number(settings.weight_atk ?? 1.5) || 1.5,
    def: Number(settings.weight_def ?? 1.2) || 1.2,
    hp: Number(settings.weight_hp ?? 0.1) || 0.1,
    mp: Number(settings.weight_mp ?? 0.05) || 0.05,
    score: Number(settings.weight_score ?? 1) || 1,
    crit: Number(settings.weight_crit ?? 1) || 1,
    critDmg: Number(settings.weight_crit_dmg ?? 1) || 1,
    critResist: Number(settings.weight_crit_resist ?? 0.8) || 0.8,
    critReduction: Number(settings.weight_crit_reduction ?? 0.8) || 0.8,
    dodge: Number(settings.weight_dodge ?? 0.6) || 0.6,
    accuracy: Number(settings.weight_accuracy ?? 0.6) || 0.6,
    armorPen: Number(settings.weight_armor_pen ?? 0.8) || 0.8,
    speed: Number(settings.weight_speed ?? 0.6) || 0.6,
  };
  // highest_stats: cộng điểm thực tế của rolled_stats/effects, không dùng affix_caps.
  return { atk: 1.5, def: 1.2, hp: 0.1, mp: 0.1, score: 1, crit: 1, critDmg: 1, critResist: 0.8, critReduction: 0.8, dodge: 0.6, accuracy: 0.6, armorPen: 0.8, speed: 0.5 };
}

function scoreItem(item: any, settings: Record<string, any>) {
  const stats = deepCollectStats(item);
  const weights = weightPreset(settings);
  const score =
    (stats.score || 0) * weights.score +
    (stats.atk || 0) * weights.atk +
    (stats.def || 0) * weights.def +
    (stats.hp || 0) * weights.hp +
    (stats.mp || 0) * weights.mp +
    (stats.crit || 0) * weights.crit +
    (stats.critDmg || 0) * weights.critDmg +
    (stats.critResist || 0) * weights.critResist +
    (stats.critReduction || 0) * weights.critReduction +
    (stats.dodge || 0) * weights.dodge +
    (stats.accuracy || 0) * weights.accuracy +
    (stats.armorPen || 0) * weights.armorPen +
    (stats.speed || 0) * weights.speed;
  return { score: Math.round(score * 100) / 100, stats };
}

function makeCandidate(item: any, settings: Record<string, any>): AutoEquipCandidate | null {
  if (!isEquippable(item, settings)) return null;
  const itemId = getItemId(item);
  const slot = detectSlot(item);
  if (!itemId || !slot) return null;
  const slotFilter = parseSlotFilter(settings);
  if (slotFilter.length > 0 && !slotFilter.includes(slot)) return null;
  const scored = scoreItem(item, settings);
  if (scored.score <= 0 && settings.allow_zero_score === false) return null;
  return {
    itemId,
    itemCode: getItemCode(item),
    name: getItemName(item),
    slot,
    score: scored.score,
    stats: scored.stats,
    raw: item,
  };
}

function isItemCurrentlyEquipped(item: any) {
  return item?.is_equipped === true ||
    item?.equipped === true ||
    item?.isEquipped === true ||
    Boolean(item?.equipped_at) ||
    Boolean(item?.equippedAt);
}

function mergeUniqueItems(...groups: any[][]) {
  const map = new Map<string, any>();
  for (const group of groups) {
    for (const item of group || []) {
      if (!item || typeof item !== "object") continue;
      const key = getItemId(item) || `${getItemCode(item) || "unknown"}:${detectSlot(item) || "slot"}:${JSON.stringify(item?.rolled_stats || item?.stats || {})}`;
      if (!map.has(key)) map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function currentEquippedMap(inventoryItems: any[], equippedData: any, settings: Record<string, any>) {
  const map = new Map<string, AutoEquipCandidate>();
  const sources = [...firstArray(equippedData), ...inventoryItems.filter(isItemCurrentlyEquipped)];

  for (const item of sources) {
    const candidate = makeCandidate(item, { ...settings, allow_zero_score: true });
    if (!candidate) continue;
    const current = map.get(candidate.slot);
    if (!current || candidate.score > current.score) map.set(candidate.slot, candidate);
  }
  return map;
}

function bestBySlot(items: any[], settings: Record<string, any>) {
  const map = new Map<string, AutoEquipCandidate>();
  let equipmentCount = 0;
  for (const item of items) {
    const candidate = makeCandidate(item, settings);
    if (!candidate) continue;
    equipmentCount += 1;
    const current = map.get(candidate.slot);
    if (!current || candidate.score > current.score) map.set(candidate.slot, candidate);
  }
  return { map, equipmentCount };
}

async function equipCandidate(candidate: AutoEquipCandidate, accessToken: string, settings: Record<string, any>) {
  const payloads = [
    { p_character_id: settings.characterId, p_instance_id: candidate.itemId },
    { p_character_id: settings.characterId, p_equipment_instance_id: candidate.itemId },
    { p_character_id: settings.characterId, p_item_instance_id: candidate.itemId },
    { p_character_id: settings.characterId, p_item_id: candidate.itemId },
    { p_character_id: settings.characterId, p_inventory_item_id: candidate.itemId },
    { p_character_id: settings.characterId, p_equipment_id: candidate.itemId },
    { p_character_id: settings.characterId, p_item_code: candidate.itemCode, p_slot: candidate.slot },
    { p_character_id: settings.characterId, p_instance_id: candidate.itemId, p_slot: candidate.slot },
    { p_character_id: settings.characterId, p_item_id: candidate.itemId, p_slot: candidate.slot },
  ].filter(payload => Object.values(payload).every(value => value !== undefined && value !== null && value !== ""));

  const rpcNames = String(settings.equip_rpc || "")
    .split(/[\n,;|]+/)
    .map(item => item.trim())
    .filter(Boolean);

  const names = rpcNames.length > 0 ? rpcNames : [
    "rpc_equip_equipment",
    "rpc_equip_item",
    "rpc_character_equip_item",
    "rpc_wear_equipment",
    "rpc_use_equipment",
    "rpc_use_item",
  ];

  let lastError: any = null;
  for (const payload of payloads) {
    try {
      const result = await tryRpc(names, payload, accessToken);
      return { ...result, payload };
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError || new Error("Không equip được item.");
}

async function readAllSourceRpcs(names: string[], payload: Record<string, any>, accessToken: string, onLog?: AutoEquipOptions["onLog"]) {
  const results: { name: string; data: any }[] = [];
  const errors: string[] = [];
  for (const name of names) {
    try {
      const data = await rpc(name, payload, accessToken);
      results.push({ name, data });
    } catch (error: any) {
      errors.push(`${name}: ${error?.message || "error"}`);
      onLog?.("DEBUG", `Auto mặc đồ: source RPC ${name} lỗi, bỏ qua.`, error?.data);
    }
  }
  return { results, errors };
}

export async function runAutoEquipCheck(options: AutoEquipOptions): Promise<AutoEquipRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const summary: AutoEquipRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "NO_CHANGE",
    scannedCount: 0,
    equipmentCount: 0,
    equippedCount: 0,
    skippedCount: 0,
    bestScore: 0,
    currentScore: 0,
    totalGain: 0,
    slots: [],
    changes: [],
    errors: [],
  };

  const inventoryRpcNames = String(settings.inventory_rpc || "")
    .split(/[\n,;|]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const equipmentRpcNames = String(settings.equipment_rpc || "")
    .split(/[\n,;|]+/)
    .map(item => item.trim())
    .filter(Boolean);

  try {
    onLog?.("INFO", "Auto mặc đồ: đang đọc danh sách trang bị và đồ đang mặc...");

    const candidateRpcNames = inventoryRpcNames.length > 0
      ? inventoryRpcNames
      : ["rpc_get_equipment", "rpc_list_inventory", "rpc_get_inventory", "rpc_inventory_list"];
    const candidateResults = await readAllSourceRpcs(candidateRpcNames, { p_character_id: options.characterId }, options.accessToken, onLog);
    if (candidateResults.results.length === 0) {
      throw new Error(`Không đọc được danh sách trang bị: ${candidateResults.errors.join(" | ")}`);
    }
    summary.inventoryRpc = candidateResults.results.map(item => item.name).join(", ");

    let equippedResult: { name: string; data: any } | null = null;
    try {
      equippedResult = await tryRpc(
        equipmentRpcNames.length > 0 ? equipmentRpcNames : ["rpc_get_equipment", "rpc_get_character_equipment", "rpc_list_equipped_items", "rpc_equipment_get"],
        { p_character_id: options.characterId },
        options.accessToken,
        (name, error) => onLog?.("DEBUG", `Equipment RPC ${name} lỗi, thử RPC khác.`, error?.data)
      );
      summary.equipmentRpc = equippedResult.name;
    } catch (error: any) {
      // Một số API trả cả đồ đang mặc trong source list; không xem đây là lỗi cứng.
      onLog?.("WARN", "Không đọc được RPC trang bị đang mặc, sẽ so sánh theo equipped_at/is_equipped trong danh sách item nếu có.", error?.data);
    }

    const inventoryItems = mergeUniqueItems(...candidateResults.results.map(result => firstArray(result.data)));
    summary.scannedCount = inventoryItems.length;

    const currentMap = currentEquippedMap(inventoryItems, equippedResult?.data, settings);
    const best = bestBySlot(inventoryItems, settings);
    summary.equipmentCount = best.equipmentCount;
    summary.slots = Array.from(best.map.keys()).sort();

    const minGain = Math.max(0, Number(settings.min_score_gain ?? 1) || 0);
    const dryRun = settings.dry_run === true || settings.dry_run === "true";
    const autoEquip = settings.auto_equip !== false;

    for (const [slot, candidate] of best.map.entries()) {
      const current = currentMap.get(slot) || null;
      summary.bestScore += candidate.score;
      summary.currentScore += current?.score || 0;

      const gain = candidate.score - (current?.score || 0);
      if (current?.itemId === candidate.itemId || gain < minGain || !autoEquip) {
        summary.skippedCount += 1;
        continue;
      }

      const change: AutoEquipChange = {
        slot,
        before: current,
        after: candidate,
        scoreGain: Math.round(gain * 100) / 100,
        status: dryRun ? "DRY_RUN" : "EQUIPPED",
      };

      if (dryRun) {
        summary.changes.push(change);
        summary.totalGain += change.scoreGain;
        continue;
      }

      try {
        const equipResult = await equipCandidate(candidate, options.accessToken, { ...settings, characterId: options.characterId });
        change.equipResult = equipResult.data;
        summary.equipRpc = equipResult.name;
        summary.equippedCount += 1;
        summary.totalGain += change.scoreGain;
        summary.changes.push(change);
        onLog?.("SUCCESS", `Auto mặc đồ: đã mặc ${candidate.name || candidate.itemId} cho slot ${slot} (+${change.scoreGain}).`, { slot, item: candidate, rpc: equipResult.name });
      } catch (error: any) {
        change.status = "ERROR";
        change.error = error?.message || "Equip lỗi";
        summary.errors.push(`${slot}: ${change.error}`);
        summary.changes.push(change);
        onLog?.("ERROR", `Auto mặc đồ: lỗi equip slot ${slot}: ${change.error}`, error?.data);
      }
    }

    summary.totalGain = Math.round(summary.totalGain * 100) / 100;
    summary.bestScore = Math.round(summary.bestScore * 100) / 100;
    summary.currentScore = Math.round(summary.currentScore * 100) / 100;

    if (summary.errors.length > 0 && summary.equippedCount === 0 && summary.changes.length > 0) summary.status = "ERROR";
    else if (summary.errors.length > 0) summary.status = "PARTIAL_ERROR";
    else if (summary.equippedCount > 0 || summary.changes.some(item => item.status === "DRY_RUN")) summary.status = "DONE";
    else summary.status = "NO_CHANGE";

    if (summary.status === "NO_CHANGE") {
      onLog?.("INFO", `Auto mặc đồ: không có món nào tốt hơn hoặc slot trống cần mặc. Đã scan ${summary.scannedCount} item, nhận diện ${summary.equipmentCount} trang bị.`);
    } else {
      onLog?.("SUCCESS", `Auto mặc đồ: đã xử lý ${summary.equippedCount}/${summary.changes.length} slot, tăng tổng ${summary.totalGain} điểm.`);
    }
  } catch (error: any) {
    summary.status = "ERROR";
    summary.errors.push(error?.message || "Auto mặc đồ lỗi không xác định.");
    onLog?.("ERROR", error?.message || "Auto mặc đồ lỗi không xác định.", error?.data);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
