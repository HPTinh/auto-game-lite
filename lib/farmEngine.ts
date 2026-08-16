"use client";

export type FarmLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";
export type FarmMobType = "normal" | "elite" | "boss";
type FarmMobKind = FarmMobType | "unknown";
export type FarmMode = "all" | "normal" | "elite" | "boss" | "smart";

export interface FarmRegionSummary {
  baseCode: string;
  label: string;
  scannedChannels: number[];
  attackCount: number;
  targetCount: number;
}

export interface FarmAttackSummary {
  baseCode: string;
  realmCode: string;
  realmId: string;
  channelNo: number;
  mobId: string;
  mobName?: string;
  mobType: FarmMobType;
  killed?: boolean;
  mobHpAfter?: number | null;
  dropItemCode?: string;
  attackSpeedSec?: number | null;
  attackResult?: any;
  responseKilled?: boolean;
  observedKilled?: boolean;
  observedKind?: FarmMobType | null;
  observedConfidence?: string;
  observedReason?: string;
  beforeCounts?: Record<FarmMobType | "alive", number>;
  afterCounts?: Record<FarmMobType | "alive", number>;
  countDelta?: Record<FarmMobType | "alive" | "totalTyped", number>;
}

export interface FarmRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "RUNNING" | "WAITING" | "DONE" | "ERROR" | "PARTIAL_ERROR";
  mode: FarmMode;
  effectiveMode: FarmMode | "all_after_smart_done" | "smart_done_stopped";
  priority: FarmMobType[];
  neededTypes: FarmMobType[];
  bossPriorityFast?: boolean;
  smartRebirthEnabled?: boolean;
  channels: number[];
  regions: FarmRegionSummary[];
  realmTier?: string;
  realmTierLabel?: string;
  availableBaseCodes: string[];
  skippedBaseCodes: string[];
  attackCount: number;
  killedCount?: number;
  killedBossCount?: number;
  killedEliteCount?: number;
  killedNormalCount?: number;
  observedKilledCount?: number;
  observedKilledBossCount?: number;
  observedKilledEliteCount?: number;
  observedKilledNormalCount?: number;
  intendedObservedMismatchCount?: number;
  mpPotionUsedCount: number;
  mpPotionFailedCount: number;
  mpPotionBoughtCount: number;
  mpPotionBuySpent: number;
  lastMpPotionResult?: any;
  skippedLockedCount: number;
  scannedRealmCount: number;
  lastTarget?: FarmAttackSummary;
  nextDelayMs: number;
  /**
   * soft_rescan: orchestrator cho delay ngắn (mob_dead / lệch kênh),
   * không ép min 5s farm CD.
   */
  softRescan?: boolean;
  rescanReason?: string;
  /** Lưu setting farm (learned counter, không cần chỉnh tay) */
  persist?: Record<string, any>;
  errors: string[];
  questProgress?: any;
}

export interface FarmAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: FarmLogLevel, message: string, meta?: Record<string, any>) => void;
  claimMobLock?: (lockKey: string, mobInfo: Record<string, any>, ttlMs: number) => boolean;
  onRegionAvailability?: (baseCode: string, isAvailable: boolean, meta?: Record<string, any>) => void;
  shouldStop?: () => boolean;
}

interface FarmSnapshotSummary {
  realmCode?: string;
  realmId?: string;
  channelNo?: number;
  boss: number;
  elite: number;
  normal: number;
  alive: number;
  firstBoss?: any;
}

interface FarmRuntimeState {
  realmTier?: FarmRealmTier;
  availableBaseCodes: Set<string>;
  skippedBaseCodes: Set<string>;
  scanCursor: number;
  currentRealm: null | {
    baseCode: string;
    label: string;
    realmCode: string;
    realmId: string;
    channelNo: number;
  };
  mobQueue: FarmQueueMob[];
  mobQueueAt: number;
  currentMob: FarmQueueMob | null;
  currentMobHits: number;
  noMobCount: number;
  lastQuestAt: number;
  questCache: any;
  channelCache: Record<string, { at: number; channels: RealmChannelInfo[] }>;
  lastSnapshot?: any;
  lastSnapshotSummary?: FarmSnapshotSummary;
  lastSnapshotConflictAt?: number;
  lastSnapshotConflictCount?: number;
  /** mobId → expireAt ms — không pick lại mob vừa dead */
  deadMobUntil: Record<string, number>;
  /** Chuỗi mob_dead liên tiếp → rotate kênh */
  mobDeadStreak: number;
  /** Chuỗi lỗi kênh/realm → hard rejoin / rotate */
  channelErrorStreak: number;
  /** Máu tự thân lần gần nhất (để quyết định skill hồi máu khi < threshold) */
  lastSelfHp?: number;
  lastSelfHpMax?: number;
}

interface RealmChannelInfo {
  baseCode: string;
  label: string;
  realmId?: string;
  realmCode: string;
  channelNo: number;
  activeCount?: number;
  hostileCount?: number;
  raw?: any;
}

interface FarmQueueMob {
  id: string;
  kind: FarmMobType;
  name?: string;
  raw: any;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

type FarmRealmTier = "lk" | "tc" | "kd" | "na" | "ht" | "lh";

const REALM_TIER_LABELS: Record<FarmRealmTier, string> = {
  lk: "Luyện Khí",
  tc: "Trúc Cơ",
  kd: "Kim Đan",
  na: "Nguyên Anh",
  ht: "Hoá Thần",
  lh: "Luyện Hư",
};

const BASE_REGION_ROOTS = [
  { root: "bf_tay_bac", label: "Tây Bắc" },
  { root: "bf_dong_bac", label: "Đông Bắc" },
  { root: "bf_tay_nam", label: "Tây Nam" },
  { root: "bf_dong_nam", label: "Đông Nam" },
] as const;

const REALM_TIER_SUFFIX: Record<FarmRealmTier, string> = {
  lk: "",
  tc: "_tc",
  kd: "_kd",
  na: "_na",
  ht: "_ht",
  lh: "_lh",
};

function baseCodeForTier(root: string, tier: FarmRealmTier) {
  return `${root}${REALM_TIER_SUFFIX[tier] || ""}`;
}

function makeTierRegions(tier: FarmRealmTier): { baseCode: string; label: string }[] {
  const tierLabel = REALM_TIER_LABELS[tier] || tier.toUpperCase();
  return BASE_REGION_ROOTS.map(region => ({
    baseCode: baseCodeForTier(region.root, tier),
    label: `${region.label} ${tierLabel}`,
  }));
}

const BASE_REGIONS_BY_TIER: Record<FarmRealmTier, { baseCode: string; label: string }[]> = {
  lk: makeTierRegions("lk"),
  tc: makeTierRegions("tc"),
  kd: makeTierRegions("kd"),
  na: makeTierRegions("na"),
  ht: makeTierRegions("ht"),
  lh: makeTierRegions("lh"),
};

const ALL_BASE_REGIONS = Array.from(
  new Map(Object.values(BASE_REGIONS_BY_TIER).flat().map(region => [region.baseCode, region])).values()
);

const BASE_REGIONS = BASE_REGIONS_BY_TIER.tc;

type RealmBasePlan = { baseCode: string; label: string; customPrefix?: boolean };

function normalizeRealmPrefixList(value: any): RealmBasePlan[] {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[,;\s]+/).filter(Boolean);
  const out: RealmBasePlan[] = [];
  for (const item of raw) {
    const code = String(item || "").trim();
    if (!code) continue;
    // Hỗ trợ cả dạng prefix: sect_10_tc và dạng template: sect_10_tc_c{channel}
    // Không ép validate theo bf_* vì bí cảnh thực tế của user đang dùng code sect_10_tc_c05/c06.
    if (!out.some(row => row.baseCode === code)) {
      out.push({ baseCode: code, label: code, customPrefix: true });
    }
  }
  return out;
}

const FARM_RUNTIME = new Map<string, FarmRuntimeState>();

// Tránh race condition khi cùng 1 account vừa join/snapshot nhiều kênh gần như đồng thời.
// Lỗi thực tế gặp: rpc_get_secret_realm_snapshot HTTP 409 / PostgreSQL 23505
// vì server cố insert trạng thái map trùng character_id.
const FARM_CHARACTER_STATE_LOCKS = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function clearFarmRuntimeState(characterId?: string) {
  if (characterId) {
    FARM_RUNTIME.delete(characterId);
    for (const key of Array.from(FARM_CHARACTER_STATE_LOCKS.keys())) {
      if (key.includes(characterId)) FARM_CHARACTER_STATE_LOCKS.delete(key);
    }
    return;
  }
  FARM_RUNTIME.clear();
  FARM_CHARACTER_STATE_LOCKS.clear();
}

export function clearFarmRuntimeLocks(characterId?: string) {
  clearFarmRuntimeState(characterId);
}

async function withCharacterStateLock<T>(characterId: string, fn: () => Promise<T>): Promise<T> {
  const key = `realm-state:${characterId}`;
  const previous = FARM_CHARACTER_STATE_LOCKS.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => current);
  FARM_CHARACTER_STATE_LOCKS.set(key, chain);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (FARM_CHARACTER_STATE_LOCKS.get(key) === chain) {
      FARM_CHARACTER_STATE_LOCKS.delete(key);
    }
  }
}

function isSnapshotConflictError(error: any): boolean {
  const raw = errorText(error);
  return Number(error?.status) === 409
    || String(error?.data?.code || "") === "23505"
    || raw.includes("23505")
    || raw.includes("duplicate_key")
    || raw.includes("duplicate key")
    || raw.includes("already_exists")
    || raw.includes("already exists")
    || raw.includes("key_character_id")
    || raw.includes("character_id");
}

async function retryRealmStateRpc<T>(args: {
  characterId: string;
  label: string;
  maxAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  const { characterId, label, fn } = args;
  const maxAttempts = Math.max(1, Math.min(5, Number(args.maxAttempts || 3)));
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withCharacterStateLock(characterId, fn);
    } catch (error: any) {
      lastError = error;
      if (!isSnapshotConflictError(error) || attempt >= maxAttempts) throw error;

      const runtime = FARM_RUNTIME.get(characterId);
      if (runtime) {
        runtime.lastSnapshotConflictAt = Date.now();
        runtime.lastSnapshotConflictCount = Number(runtime.lastSnapshotConflictCount || 0) + 1;
      }

      // Conflict này thường do request song song hoặc tab khác. Chờ ngắn rồi thử lại.
      const waitMs = 450 + attempt * 350 + Math.floor(Math.random() * 250);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error(`[${label}] unknown realm state retry failure`);
}

const cancellableSleep = async (ms: number, shouldStop?: () => boolean) => {
  const endAt = Date.now() + Math.max(0, ms);
  while (Date.now() < endAt) {
    if (shouldStop?.()) return false;
    await sleep(Math.min(300, Math.max(0, endAt - Date.now())));
  }
  return !shouldStop?.();
};

function firstDefined(...values: any[]) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function normalizeKey(value: any) {
  return String(value || "")
    .replace(/[Đđ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRealmTier(value: any): FarmRealmTier | undefined {
  const key = normalizeKey(value);
  if (!key) return undefined;
  if (key === "lk" || key.startsWith("luyen_khi") || key === "luyenkhi") return "lk";
  if (key === "tc" || key.startsWith("truc_co") || key === "trucco") return "tc";
  if (key === "kd" || key.startsWith("kim_dan") || key === "kimdan" || key.startsWith("kim_an")) return "kd";
  if (key === "na" || key.startsWith("nguyen_anh") || key === "nguyenanh") return "na";
  if (key === "ht" || key.startsWith("hoa_than") || key === "hoathan") return "ht";
  if (key === "lh" || key.startsWith("luyen_hu") || key === "luyenhu") return "lh";
  return undefined;
}

function tierFromLevel(value: any): FarmRealmTier | undefined {
  const n = toNumber(value);
  if (n === null || n <= 0) return undefined;
  if (n <= 10) return "lk";
  if (n <= 20) return "tc";
  if (n <= 30) return "kd";
  if (n <= 40) return "na";
  if (n <= 50) return "ht";
  return "lh";
}

function getFarmRealmTier(settings: Record<string, any> = {}): FarmRealmTier {
  return normalizeRealmTier(
    firstDefined(
      settings.farm_realm_tier_override,
      settings.manual_realm_tier,
      settings.current_realm_tier,
      settings.realm_tier,
      settings.farm_realm_tier,
      settings.realm_code,
      settings.account_realm_code,
      settings.current_realm_code,
      settings.realm_label,
      settings.account_realm_label,
    )
  ) || tierFromLevel(firstDefined(settings.realm_level, settings.account_realm_level, settings.level, settings.character_level)) || "tc";
}

function regionsForTier(tier: FarmRealmTier): { baseCode: string; label: string }[] {
  return BASE_REGIONS_BY_TIER[tier] || makeTierRegions(tier);
}

function toNumber(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.inventory)) return value.inventory;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function normalizeBaseCodeList(value: any, regions: { baseCode: string }[] = ALL_BASE_REGIONS): string[] {
  const valid = new Set(regions.map(region => region.baseCode));
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[,;\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const item of raw) {
    const code = String(item || "").trim();
    if (valid.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

function normalizeMode(value: any): FarmMode {
  const raw = String(value ?? "smart");
  const mode = normalizeKey(raw);
  if (["all", "any", "tat_ca"].includes(mode)) return "all";
  if (["normal", "thuong", "quai_thuong", "only_normal", "normal_only", "chi_quai_thuong"].includes(mode)) return "normal";
  if (["elite", "tinh_anh", "only_elite", "elite_only", "chi_tinh_anh"].includes(mode)) return "elite";
  if ([
    "boss",
    "only_boss",
    "boss_only",
    "chi_boss",
    "farm_boss",
    "boss_farm",
    "boss_strict",
    "strict_boss",
    "boss_multi",
    "multi_boss",
    "boss_multichannel",
    "boss_multi_channel",
    "chi_boss_da_kenh",
  ].includes(mode)) return "boss";

  // Trường hợp dữ liệu cũ/setting cũ lưu mode bằng label tiếng Việt hoặc tên biến khác.
  // Chỉ nhận là Boss STRICT khi chuỗi có boss/thủ lĩnh và có dấu hiệu "only/strict/đa kênh".
  if ((mode.includes("boss") || mode.includes("thu_linh") || mode.includes("thulinh"))
    && (mode.includes("only") || mode.includes("strict") || mode.includes("chi") || mode.includes("multi") || mode.includes("da_kenh") || mode.includes("dakenh"))) {
    return "boss";
  }
  return "smart";
}

function normalizePriority(value: any): FarmMobType[] {
  const raw = String(value || "boss_elite_normal").toLowerCase();
  const tokens = raw.split(/[^a-z]+/).filter(Boolean);
  const order: FarmMobType[] = [];
  for (const token of tokens) {
    if (["boss", "elite", "normal"].includes(token) && !order.includes(token as FarmMobType)) {
      order.push(token as FarmMobType);
    }
  }
  for (const fallback of ["boss", "elite", "normal"] as FarmMobType[]) {
    if (!order.includes(fallback)) order.push(fallback);
  }
  return order;
}


function isBossPrioritySettings(settings: Record<string, any>, mode: FarmMode): boolean {
  if (mode === "boss") return true;
  const flags = [
    settings.boss_priority_mode,
    settings.farm_boss_priority,
    settings.is_boss_mode,
  ];
  if (flags.some(value => value === true || value === "true" || value === 1 || value === "1")) return true;

  const raw = normalizeKey(firstDefined(
    settings.mode,
    settings.farm_mode,
    settings.target_mode,
    settings.mob_mode,
    settings.mode_label,
    settings.farm_mode_label,
  ));
  return raw.includes("boss") || raw.includes("thu_linh") || raw.includes("thulinh");
}

function isStrictBossSettings(settings: Record<string, any>, mode: FarmMode): boolean {
  // Chỉ bật STRICT tuyệt đối nếu sau này người dùng cố tình bật cờ mới này.
  // Các cờ cũ strict_boss_mode/farm_boss_only không còn được dùng để tránh kẹt chỉ boss.
  const flags = [
    settings.absolute_boss_only,
    settings.hard_boss_only,
    settings.strict_boss_absolute,
  ];
  if (flags.some(value => value === true || value === "true" || value === 1 || value === "1")) return true;

  const raw = normalizeKey(firstDefined(
    settings.mode,
    settings.farm_mode,
    settings.target_mode,
    settings.mob_mode,
    settings.mode_label,
    settings.farm_mode_label,
  ));
  return raw.includes("absolute_boss") || raw.includes("hard_boss_only");
}

function channelRange(settings: Record<string, any>): number[] {
  const from = Math.max(1, Math.floor(Number(settings.from_channel || settings.channel || 1)) || 1);
  const to = Math.max(from, Math.floor(Number(settings.to_channel || from)) || from);
  const channels: number[] = [];
  for (let n = from; n <= to; n += 1) channels.push(n);
  return channels;
}

function realmCodeFor(baseCode: string, channelNo: number) {
  const channel = String(channelNo).padStart(2, "0");
  if (baseCode.includes("{channel}")) return baseCode.replace(/\{channel\}/g, channel);
  if (baseCode.includes("{c}")) return baseCode.replace(/\{c\}/g, channel);
  if (/[_-]c\d{2}$/i.test(baseCode)) return baseCode.replace(/([_-]c)\d{2}$/i, `$1${channel}`);
  return `${baseCode}_c${channel}`;
}

function getRuntime(characterId: string, settings: Record<string, any>): FarmRuntimeState {
  const tier = getFarmRealmTier(settings);
  const tierRegions = regionsForTier(tier);
  let rt = FARM_RUNTIME.get(characterId);
  if (!rt) {
    rt = {
      realmTier: tier,
      availableBaseCodes: new Set<string>(),
      skippedBaseCodes: new Set<string>(),
      scanCursor: 0,
      currentRealm: null,
      mobQueue: [],
      mobQueueAt: 0,
      currentMob: null,
      currentMobHits: 0,
      noMobCount: 0,
      lastQuestAt: 0,
      questCache: null,
      channelCache: {},
      lastSnapshot: undefined,
      lastSnapshotSummary: undefined,
      deadMobUntil: {},
      mobDeadStreak: 0,
      channelErrorStreak: 0,
    };
    FARM_RUNTIME.set(characterId, rt);
  }

  // migrate runtime cũ (thiếu field mới)
  if (!rt.deadMobUntil) rt.deadMobUntil = {};
  if (rt.mobDeadStreak == null) rt.mobDeadStreak = 0;
  if (rt.channelErrorStreak == null) rt.channelErrorStreak = 0;

  if (rt.realmTier !== tier) {
    rt.realmTier = tier;
    rt.availableBaseCodes.clear();
    rt.skippedBaseCodes.clear();
    rt.scanCursor = 0;
    rt.currentRealm = null;
    rt.mobQueue = [];
    rt.mobQueueAt = 0;
    rt.currentMob = null;
    rt.currentMobHits = 0;
    rt.noMobCount = 0;
    rt.lastSnapshot = undefined;
    rt.lastSnapshotSummary = undefined;
    rt.lastSnapshotConflictAt = undefined;
    rt.lastSnapshotConflictCount = 0;
    rt.deadMobUntil = {};
    rt.mobDeadStreak = 0;
    rt.channelErrorStreak = 0;
  }

  for (const code of normalizeBaseCodeList(settings.available_base_codes || settings.farm_available_base_codes, tierRegions)) rt.availableBaseCodes.add(code);
  for (const code of normalizeBaseCodeList(settings.unavailable_base_codes || settings.farm_unavailable_base_codes, tierRegions)) rt.skippedBaseCodes.add(code);
  return rt;
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

function errorText(error: any) {
  return normalizeKey([
    error?.message,
    error?.data?.message,
    error?.data?.error,
    error?.data?.reason,
    error?.data?.code,
    error?.data?.details,
    error?.data?.hint,
    JSON.stringify(error?.data || {}),
  ].filter(Boolean).join(" "));
}

function isCooldownError(error: any) {
  const raw = errorText(error);
  return raw.includes("cooldown") || raw.includes("too_soon") || raw.includes("interval");
}

function isMobDeadError(error: any) {
  const raw = errorText(error);
  return raw.includes("mob_dead")
    || raw.includes("target_dead")
    || raw.includes("already_dead")
    || raw.includes("dead_mob")
    || raw.includes("not_alive")
    || raw.includes("notalive")
    || raw.includes("killed")
    || raw.includes("defeated")
    || raw.includes("respawn")
    || raw.includes("khong_con_song")
    || raw.includes("khongconsong")
    || raw.includes("da_chet")
    || raw.includes("dachet")
    || raw.includes("bi_ha_guc")
    || raw.includes("bihaguc");
}

function isNotJoinedError(error: any) {
  const raw = errorText(error);
  return raw.includes("not_joined") || raw.includes("notjoined") || raw.includes("not_join");
}

/** Lệch kênh / realm / không còn trong secret realm */
function isChannelRealmError(error: any) {
  const raw = errorText(error);
  return (
    isNotJoinedError(error) ||
    raw.includes("wrong_channel") ||
    raw.includes("not_same_channel") ||
    raw.includes("channel_mismatch") ||
    raw.includes("invalid_realm") ||
    raw.includes("not_in_realm") ||
    raw.includes("realm_mismatch") ||
    raw.includes("wrong_realm") ||
    raw.includes("not_in_secret") ||
    raw.includes("not_in_secret_realm") ||
    raw.includes("leave_first") ||
    raw.includes("already_in_other") ||
    raw.includes("different_channel") ||
    raw.includes("khong_cung_kenh") ||
    raw.includes("khongcungkenh") ||
    raw.includes("sai_kenh") ||
    raw.includes("saikenh") ||
    raw.includes("mob_not_found") ||
    raw.includes("mobnotfound") ||
    raw.includes("invalid_mob") ||
    raw.includes("unknown_mob")
  );
}

function purgeDeadMobBlacklist(runtime: FarmRuntimeState) {
  const now = Date.now();
  for (const [id, exp] of Object.entries(runtime.deadMobUntil || {})) {
    if (!exp || exp <= now) delete runtime.deadMobUntil[id];
  }
}

function blacklistDeadMob(runtime: FarmRuntimeState, mobId: string, ttlMs = 12_000) {
  if (!mobId) return;
  if (!runtime.deadMobUntil) runtime.deadMobUntil = {};
  runtime.deadMobUntil[mobId] = Date.now() + Math.max(3000, ttlMs);
}

function isMobBlacklisted(runtime: FarmRuntimeState, mobId: string) {
  purgeDeadMobBlacklist(runtime);
  const exp = runtime.deadMobUntil?.[mobId];
  return Boolean(exp && exp > Date.now());
}

function clearTargetQueue(runtime: FarmRuntimeState) {
  runtime.currentMob = null;
  runtime.currentMobHits = 0;
  runtime.mobQueue = [];
  runtime.mobQueueAt = 0;
}

function isLimitError(error: any) {
  const raw = errorText(error);
  return raw.includes("daily_limit") || raw.includes("online_limit") || raw.includes("time_limit") || raw.includes("limit_reached") || raw.includes("out_of_time") || raw.includes("expired");
}

/** Lỗi cứng (auth/account) — phải dừng hẳn, không tự phục hồi. */
function isFatalError(error: any): boolean {
  const s = Number(error?.status);
  if (s === 401 || s === 403) return true;
  const raw = errorText(error).toLowerCase();
  return (
    raw.includes("unauthorized") ||
    raw.includes("forbidden") ||
    raw.includes("invalid_token") ||
    raw.includes("token_expired") ||
    raw.includes("not_authenticated") ||
    raw.includes("login_required") ||
    raw.includes("session") ||
    raw.includes("banned") ||
    raw.includes("blocked") ||
    raw.includes("character_not_found")
  );
}

/** Lỗi chưa phân loại nhưng KHÔNG cứng → bọc lại để top-level trả WAITING + softRescan (tự phục hồi). */
class FarmRecoverableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FarmRecoverableError";
  }
}

function isNotEnoughMpError(error: any): boolean {
  const raw = errorText(error);
  if (!raw) return false;

  // Response thực tế của farm có thể chỉ trả đúng reason `no_mana`, ví dụ:
  // [rpc_attack_realm_mob_v3] no_mana. Bản cũ bắt buộc phải có thêm
  // `not_enough/insufficient/...` nên không nhận diện được và bị log ERROR.
  if (
    raw.includes("no_mana") ||
    raw.includes("nomana") ||
    raw.includes("out_of_mana") ||
    raw.includes("outofmana") ||
    raw.includes("no_mp") ||
    raw.includes("nomp") ||
    raw.includes("out_of_mp") ||
    raw.includes("outofmp") ||
    raw.includes("mana_empty") ||
    raw.includes("mp_empty")
  ) return true;

  const hasMpWord = raw.includes("mp")
    || raw.includes("mana")
    || raw.includes("linh_luc")
    || raw.includes("linhluc")
    || raw.includes("noi_luc")
    || raw.includes("noiluc");

  const hasLackWord = raw.includes("not_enough")
    || raw.includes("insufficient")
    || raw.includes("khong_du")
    || raw.includes("khongdu")
    || raw.includes("thieu")
    || raw.includes("low")
    || raw.includes("empty")
    || raw.includes("lack");

  return hasMpWord && hasLackWord;
}

function getInventoryItemCode(item: any): string {
  return String(firstDefined(item?.item_code, item?.code, item?.itemCode, item?.item?.code, item?.template_code, item?.source_code, ""));
}

function getInventoryItemId(item: any): string {
  return String(firstDefined(item?.id, item?.item_id, item?.inventory_id, item?.itemId, item?.item?.id, ""));
}

function findInventoryItemByCode(inventoryData: any, itemCode: string) {
  const target = normalizeKey(itemCode);
  return asArray(inventoryData).find(item => {
    const code = normalizeKey(getInventoryItemCode(item));
    const qty = toNumber(firstDefined(item?.qty, item?.quantity, item?.count, item?.amount, item?.stack, item?.stack_count));
    return code === target && (qty === null || qty > 0);
  });
}

async function useMpPotion(characterId: string, accessToken: string, itemCode: string, onLog?: FarmAutoOptions["onLog"]) {
  // Ưu tiên dùng trực tiếp bằng item_code trước. Khi đã no_mana thì tốc độ quan trọng hơn việc scan túi đồ.
  // Payload này khớp với bản auto cũ và ít bị Supabase RPC reject vì truyền thừa field.
  try {
    const result = await rpc("rpc_use_item", { p_character_id: characterId, p_item_code: itemCode }, accessToken);
    onLog?.("SUCCESS", `Farm tự dùng bình MP ${itemCode} thành công.`, { payload: { p_item_code: itemCode } });
    return { ok: true, itemCode, payload: { p_character_id: characterId, p_item_code: itemCode }, result };
  } catch (directError: any) {
    let inventoryItem: any = null;
    try {
      const inv = await rpc("rpc_list_inventory", { p_character_id: characterId, p_locale: "vi" }, accessToken);
      inventoryItem = findInventoryItemByCode(inv, itemCode);
    } catch (inventoryError: any) {
      onLog?.("DEBUG", "Không đọc được túi đồ sau khi dùng bình MP trực tiếp thất bại.", inventoryError?.data || { message: inventoryError?.message });
    }

    const itemId = inventoryItem ? getInventoryItemId(inventoryItem) : "";
    const payloads: Record<string, any>[] = [];
    if (itemId) payloads.push({ p_character_id: characterId, p_item_id: itemId });
    if (itemId) payloads.push({ p_character_id: characterId, p_inventory_item_id: itemId });
    payloads.push({ p_character_id: characterId, p_item_code: itemCode, p_quantity: 1 });
    payloads.push({ p_character_id: characterId, p_item_code: itemCode, p_qty: 1 });
    payloads.push({ p_character_id: characterId, p_code: itemCode });

    let lastError: any = directError;
    for (const payload of payloads) {
      try {
        const result = await rpc("rpc_use_item", payload, accessToken);
        onLog?.("SUCCESS", `Farm tự dùng bình MP ${itemCode} thành công.`, { payload });
        return { ok: true, itemCode, payload, result };
      } catch (error: any) {
        lastError = error;
      }
    }

    const err: any = new Error(`Không dùng được bình MP ${itemCode}`);
    err.data = lastError?.data || { message: lastError?.message, itemCode };
    throw err;
  }
}

function isNoPotionError(error: any): boolean {
  const raw = errorText(error);
  if (!raw) return false;
  return raw.includes("item_not_found")
    || raw.includes("not_found")
    || raw.includes("no_item")
    || raw.includes("not_enough_item")
    || raw.includes("not_enough_qty")
    || raw.includes("insufficient_item")
    || raw.includes("insufficient_qty")
    || raw.includes("quantity")
    || raw.includes("qty")
    || raw.includes("inventory");
}

/** Shop alchemy chỉ mua gói 1 hoặc 10 — mặc định 10 cho farm lâu */
function resolveMpBuyQty(raw: any): 1 | 10 {
  const n = Math.floor(Number(raw));
  return n === 1 ? 1 : 10;
}

async function buyMpPotion(args: {
  characterId: string;
  accessToken: string;
  itemCode: string;
  qty: number;
  shopCode?: string;
  onLog?: FarmAutoOptions["onLog"];
}) {
  const { characterId, accessToken, itemCode, shopCode = "alchemy", onLog } = args;
  const qty = resolveMpBuyQty(args.qty);
  // rpc_nh_shop_buy — cùng mã bình farm đang dùng (vd pill_lk_mp)
  const payload = {
    p_character_id: characterId,
    p_shop_code: shopCode,
    p_item_code: itemCode,
    p_qty: qty,
  };
  const result = await rpc("rpc_nh_shop_buy", payload, accessToken);
  const bought = Number(result?.qty ?? qty) || qty;
  const spent = Number(result?.spent ?? result?.cost ?? result?.diamond_spent ?? 0) || 0;
  onLog?.(
    "SUCCESS",
    `Farm mua ${bought}× ${itemCode} (shop ${shopCode})${spent ? ` · ${spent} bạc/kc` : ""}.`,
    { payload, result }
  );
  return { ok: true, itemCode, qty: bought, spent, payload, result };
}

/**
 * Uống MP: thử pill_lk_mp → tc → … → lh.
 * Hết sạch → mua CHỈ pill_lk_mp rồi uống lại.
 */
async function ensureMpPotionAndUse(args: {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  autoBuy: boolean;
  buyQty: number;
  shopCode?: string;
  onLog?: FarmAutoOptions["onLog"];
}) {
  const { characterId, accessToken, settings = {}, autoBuy, buyQty, shopCode, onLog } = args;
  let boughtCount = 0;
  let buySpent = 0;
  let buyResult: any = undefined;
  const codes = orderedMpPillCodes(settings);
  const buyCode = mpBuyItemCode(settings);

  onLog?.("INFO", `Farm hết MP → thử đan thấp→cao (${codes.slice(0, 3).join(" → ")}…)`);

  for (const itemCode of codes) {
    try {
      const used = await useMpPotion(characterId, accessToken, itemCode, onLog);
      return { used, boughtCount, buySpent, buyResult, itemCode };
    } catch {
      /* thử cấp cao hơn */
    }
  }

  if (!autoBuy) {
    const err: any = new Error(`Hết bình MP (đã thử ${codes.join(",")}) · auto_buy tắt`);
    err.data = { reason: "no_mp_pill", tried: codes };
    throw err;
  }

  // Mua chỉ LK
  const preferQty = resolveMpBuyQty(buyQty);
  onLog?.("INFO", `Farm hết mọi pill MP → mua shop ${buyCode} ×${preferQty} (chỉ ưu tiên LK)`);

  try {
    buyResult = await buyMpPotion({
      characterId,
      accessToken,
      itemCode: buyCode,
      qty: preferQty,
      shopCode,
      onLog,
    });
  } catch (buyError: any) {
    if (preferQty !== 1) {
      onLog?.("WARN", `Farm mua ${buyCode} ×${preferQty} fail → thử ×1`, buyError?.data || { message: buyError?.message });
      buyResult = await buyMpPotion({
        characterId,
        accessToken,
        itemCode: buyCode,
        qty: 1,
        shopCode,
        onLog,
      });
    } else {
      throw buyError;
    }
  }

  boughtCount += Number(buyResult?.qty || 0);
  buySpent += Number(buyResult?.spent || 0);
  await cancellableSleep(350);
  const used = await useMpPotion(characterId, accessToken, buyCode, onLog);
  return { used, boughtCount, buySpent, buyResult, itemCode: buyCode };
}

function collectMobs(snapshot: any): any[] {
  if (Array.isArray(snapshot?.mobs)) return snapshot.mobs;
  if (Array.isArray(snapshot?.data?.mobs)) return snapshot.data.mobs;
  if (Array.isArray(snapshot?.realm?.mobs)) return snapshot.realm.mobs;
  if (Array.isArray(snapshot?.secret_realm?.mobs)) return snapshot.secret_realm.mobs;
  return [];
}

function getMobId(mob: any): string {
  return String(firstDefined(mob?.id, mob?.mob_id, mob?.mobId, mob?.realm_mob_id, mob?.monster_id, mob?.target_id, ""));
}

function getMobName(mob: any): string | undefined {
  return firstDefined(mob?.name, mob?.mob_name, mob?.monster_name, mob?.title, mob?.label);
}

function getMobHp(mob: any): number | null {
  return toNumber(firstDefined(mob?.hp, mob?.current_hp, mob?.hp_current, mob?.currentHp, mob?.health, mob?.current_health));
}

function isMobAlive(mob: any) {
  if (!mob) return false;
  if (mob.alive === false || mob.is_alive === false || mob.dead === true || mob.is_dead === true) return false;
  const status = normalizeKey(mob.status || mob.state || mob.life_state);
  if (["dead", "killed", "defeated", "not_alive", "expired"].includes(status)) return false;
  const hp = getMobHp(mob);
  if (hp !== null && hp <= 0) return false;
  return Boolean(getMobId(mob));
}

function getMobType(mob: any): FarmMobKind {
  const raw = normalizeKey([
    mob?.mob_kind,
    mob?.visual_kind,
    mob?.type,
    mob?.mob_type,
    mob?.category,
    mob?.kind,
    mob?.name,
    mob?.mob_name,
    mob?.code,
    mob?.mob_code,
  ].filter(value => value !== undefined && value !== null && value !== "").join(" "));

  if (raw.includes("boss") || raw.includes("thu_linh") || raw.includes("thulinh")) return "boss";
  if (raw.includes("elite") || raw.includes("tinh_anh") || raw.includes("tinhanh")) return "elite";
  if (raw.includes("normal") || raw.includes("quai_vat") || raw.includes("quaivat") || raw.includes("thuong")) return "normal";
  return "unknown";
}

function summarizeMobs(snapshot: any, realm?: FarmRuntimeState["currentRealm"]): FarmSnapshotSummary {
  const mobs = collectMobs(snapshot);
  const alive = mobs.filter(mob => isMobAlive(mob));
  const bosses = alive.filter(mob => getMobType(mob) === "boss");
  const elites = alive.filter(mob => getMobType(mob) === "elite");
  const normals = alive.filter(mob => getMobType(mob) === "normal");
  return {
    realmCode: realm?.realmCode || snapshot?.realm?.code,
    realmId: realm?.realmId || snapshot?.realm?.id,
    channelNo: realm?.channelNo,
    boss: bosses.length,
    elite: elites.length,
    normal: normals.length,
    alive: alive.length,
    firstBoss: bosses[0] ? { id: getMobId(bosses[0]), hp: getMobHp(bosses[0]), status: bosses[0]?.status, kind: getMobType(bosses[0]), name: getMobName(bosses[0]), slot: bosses[0]?.slot } : undefined,
  };
}

function snapshotCountsForSummary(summary?: FarmSnapshotSummary): Record<FarmMobType | "alive", number> | undefined {
  if (!summary) return undefined;
  return { boss: summary.boss || 0, elite: summary.elite || 0, normal: summary.normal || 0, alive: summary.alive || 0 };
}

function getMobById(snapshot: any, mobId: string) {
  return collectMobs(snapshot).find(mob => getMobId(mob) === mobId);
}

function snapshotCountDelta(before?: FarmSnapshotSummary, after?: FarmSnapshotSummary): Record<FarmMobType | "alive" | "totalTyped", number> | undefined {
  if (!before || !after) return undefined;
  const boss = Math.max(0, (before.boss || 0) - (after.boss || 0));
  const elite = Math.max(0, (before.elite || 0) - (after.elite || 0));
  const normal = Math.max(0, (before.normal || 0) - (after.normal || 0));
  const alive = Math.max(0, (before.alive || 0) - (after.alive || 0));
  return { boss, elite, normal, alive, totalTyped: boss + elite + normal };
}

function inferObservedKill(args: {
  target: FarmQueueMob;
  beforeSnapshot?: any;
  beforeSummary?: FarmSnapshotSummary;
  afterSnapshot?: any;
  afterSummary?: FarmSnapshotSummary;
  responseHpAfter: number | null;
}) {
  const { target, beforeSnapshot, beforeSummary, afterSnapshot, afterSummary, responseHpAfter } = args;
  const beforeMob = beforeSnapshot ? getMobById(beforeSnapshot, target.id) : target.raw;
  const afterMob = afterSnapshot ? getMobById(afterSnapshot, target.id) : undefined;
  const beforeAlive = beforeMob ? isMobAlive(beforeMob) : true;
  const afterAlive = afterMob ? isMobAlive(afterMob) : false;
  const afterHpSnapshot = afterMob ? getMobHp(afterMob) : null;
  const delta = snapshotCountDelta(beforeSummary, afterSummary);

  let observedKind: FarmMobType | null = null;
  let confidence = "none";
  let reason = "no_observed_kill";

  if (beforeAlive && !afterAlive) {
    observedKind = target.kind;
    confidence = "target_id_dead_after_snapshot";
    reason = "target_killed";
  } else if (delta && delta.totalTyped === 1) {
    observedKind = delta.boss ? "boss" : delta.elite ? "elite" : "normal";
    confidence = "single_type_count_delta";
    reason = "one_typed_count_decreased";
  } else if (delta && delta.totalTyped > 1) {
    confidence = "mixed_count_delta";
    reason = "multiple_types_decreased";
  } else if (responseHpAfter !== null && responseHpAfter <= 0) {
    observedKind = target.kind;
    confidence = "response_only";
    reason = "response_hp_after_zero_no_count_delta";
  }

  return {
    observedKind,
    confidence,
    reason,
    beforeAlive,
    afterAlive,
    responseHpAfter,
    afterHpSnapshot,
    delta,
  };
}

function hasAnyAliveMob(snapshot: any) {
  return collectMobs(snapshot).some(mob => isMobAlive(mob));
}

function learnFarmableRegion(args: {
  runtime: FarmRuntimeState;
  settings: Record<string, any>;
  baseCode?: string;
  label?: string;
  source: string;
  meta?: Record<string, any>;
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
}) {
  const { runtime, settings, baseCode, label, source, meta, onRegionAvailability } = args;
  if (!baseCode) return;
  if (runtime.availableBaseCodes.has(baseCode)) return;

  const tier = runtime.realmTier || getFarmRealmTier(settings);
  const tierRegions = regionsForTier(tier);
  const valid = new Set(tierRegions.map(region => region.baseCode));
  if (!valid.has(baseCode)) return;

  const maxAvailable = Math.max(1, Math.min(tierRegions.length, Number(settings.max_available_base_codes || 2)));
  if (runtime.availableBaseCodes.size >= maxAvailable) return;

  runtime.availableBaseCodes.add(baseCode);
  runtime.skippedBaseCodes.delete(baseCode);
  onRegionAvailability?.(baseCode, true, {
    label,
    baseCode,
    source,
    learnedAt: new Date().toISOString(),
    ...meta,
  });

  // Khi đã học đủ 2 vùng hợp lệ của account, khóa cache lại:
  // các vùng còn lại sẽ không được scan/farm nữa cho tới khi đổi tier hoặc reset cache.
  if (runtime.availableBaseCodes.size >= maxAvailable) {
    for (const region of tierRegions) {
      if (!runtime.availableBaseCodes.has(region.baseCode)) {
        runtime.skippedBaseCodes.add(region.baseCode);
        onRegionAvailability?.(region.baseCode, false, {
          label: region.label,
          baseCode: region.baseCode,
          reason: "account_two_farmable_regions_learned",
          source,
        });
      }
    }
  }
}

function extractMobs(
  snapshot: any,
  wantedTypes: FarmMobType[],
  claimMobLock?: FarmAutoOptions["claimMobLock"],
  realm?: FarmRuntimeState["currentRealm"],
  lockTtlMs = 7000,
  runtime?: FarmRuntimeState,
  /** Chỉ lấy mob sống + không bị đánh (full HP / không combat flag) */
  freeOnly = true
) {
  const mobs = collectMobs(snapshot);
  const free: FarmQueueMob[] = [];
  const contested: FarmQueueMob[] = [];
  let skippedLocked = 0;
  let skippedContested = 0;

  for (const raw of mobs) {
    if (!isMobAlive(raw)) continue;
    const id = getMobId(raw);
    if (!id) continue;
    if (runtime && isMobBlacklisted(runtime, id)) continue;
    const kind = getMobType(raw);
    if (kind === "unknown" || !wantedTypes.includes(kind)) continue;
    if (realm?.realmId) {
      const lockKey = `${realm.realmId}:${id}`;
      if (claimMobLock && !claimMobLock(lockKey, { realmCode: realm.realmCode, channelNo: realm.channelNo, baseCode: realm.baseCode, mobId: id, mobType: kind, mobName: getMobName(raw) }, lockTtlMs)) {
        skippedLocked += 1;
        continue;
      }
    }
    const row: FarmQueueMob = { id, kind, name: getMobName(raw), raw };
    if (isMobContested(raw)) {
      skippedContested += 1;
      if (!freeOnly) contested.push(row);
      continue;
    }
    free.push(row);
  }

  const pool = freeOnly ? free : [...free, ...contested];
  const ordered: FarmQueueMob[] = [];
  for (const type of wantedTypes) ordered.push(...pool.filter((mob) => mob.kind === type));
  return { queue: ordered, skippedLocked, skippedContested, freeCount: free.length };
}

function extractQuestNeededTypes(progress: any): { needed: FarmMobType[]; done: boolean; raw?: any } {
  const counters: Record<FarmMobType, { current: number | null; target: number | null }> = {
    normal: { current: null, target: null },
    elite: { current: null, target: null },
    boss: { current: null, target: null },
  };

  const quest = progress?.quest || progress?.data?.quest || progress || {};
  const candidates: Array<[FarmMobType, string[], string[]]> = [
    ["normal", ["mobs_killed", "normal", "normal_killed", "normalKill"], ["mobs_killed", "normal", "normal_target", "normalTarget"]],
    ["elite", ["elites_killed", "elite", "elite_killed", "eliteKill"], ["elites_killed", "elite", "elite_target", "eliteTarget"]],
    ["boss", ["bosses_killed", "boss", "boss_killed", "bossKill"], ["bosses_killed", "boss", "boss_target", "bossTarget"]],
  ];

  const progressObj = quest.progress || quest.current || quest;
  const targetsObj = quest.targets || quest.required || quest.target || quest;

  for (const [type, curKeys, targetKeys] of candidates) {
    for (const key of curKeys) {
      const n = toNumber(progressObj?.[key] ?? progressObj?.[normalizeKey(key)]);
      if (n !== null) counters[type].current = Math.max(counters[type].current ?? 0, n);
    }
    for (const key of targetKeys) {
      const n = toNumber(targetsObj?.[key] ?? targetsObj?.[`${key}_target`] ?? targetsObj?.[`${key}_required`] ?? targetsObj?.[normalizeKey(key)]);
      if (n !== null) counters[type].target = Math.max(counters[type].target ?? 0, n);
    }
  }

  const needed = (["boss", "elite", "normal"] as FarmMobType[]).filter(type => {
    const current = counters[type].current;
    const target = counters[type].target;
    if (target === null || target <= 0) return false;
    if (current === null) return true;
    return current < target;
  });

  const hasAnyTarget = (["boss", "elite", "normal"] as FarmMobType[]).some(type => (counters[type].target ?? 0) > 0);
  return { needed, done: hasAnyTarget && needed.length === 0, raw: { counters, hasAnyTarget } };
}

async function loadQuestProgress(characterId: string, accessToken: string, runtime: FarmRuntimeState, onLog?: FarmAutoOptions["onLog"]) {
  const cacheMs = 30_000;
  if (runtime.questCache && Date.now() - runtime.lastQuestAt < cacheMs) return runtime.questCache;
  try {
    const data = await rpc("rpc_get_rebirth_quest_progress", { p_character_id: characterId }, accessToken);
    const extracted = extractQuestNeededTypes(data);
    runtime.questCache = { data, extracted };
    runtime.lastQuestAt = Date.now();
    return runtime.questCache;
  } catch (error: any) {
    onLog?.("DEBUG", "Không đọc được nhiệm vụ trùng sinh, Farm thông minh fallback theo ưu tiên.", error?.data || { message: error?.message });
    return null;
  }
}

function orderedTypesForMode(mode: FarmMode, priority: FarmMobType[], quest: { needed: FarmMobType[]; done: boolean } | null) {
  if (mode === "normal") return ["normal"] as FarmMobType[];
  if (mode === "elite") return ["elite"] as FarmMobType[];
  // Boss mode mặc định mới là Boss Priority nhanh: Boss -> Elite -> đổi kênh, bỏ Normal.
  // Normal chỉ xuất hiện khi Farm thông minh Trùng Sinh thật sự cần.
  if (mode === "boss") return ["boss", "elite"] as FarmMobType[];
  if (mode === "smart") {
    if (quest?.needed?.length) return priority.filter(type => quest.needed.includes(type));
    return priority;
  }
  return priority;
}

function regionPlan(runtime: FarmRuntimeState, settings: Record<string, any>): RealmBasePlan[] {
  // Mặc định tự ghép base_code theo cảnh giới hiện tại của account.
  // LK: bf_tay_bac; TC: bf_tay_bac_tc; KD: bf_tay_bac_kd; NA/HT/LH tương tự.
  // Luồng học vùng: scan 4 vùng ứng viên của tier hiện tại -> lưu tối đa 2 vùng account vào được
  // -> những vòng sau chỉ farm trong 2 vùng đã học; nếu đổi tier thì cache bị reset và học lại.
  const customPrefixes = normalizeRealmPrefixList(
    settings.realm_code_prefixes
    || settings.realm_code_prefix
    || settings.realm_prefixes
    || settings.realm_prefix
    || settings.realm_code_template
  );
  if (customPrefixes.length) return customPrefixes;

  const tier = getFarmRealmTier(settings);
  runtime.realmTier = tier;
  const tierRegions = regionsForTier(tier);

  const cachedAvailable = normalizeBaseCodeList(settings.available_base_codes || settings.farm_available_base_codes, tierRegions);
  const cachedSkipped = normalizeBaseCodeList(settings.unavailable_base_codes || settings.farm_unavailable_base_codes, tierRegions);
  for (const code of cachedAvailable) runtime.availableBaseCodes.add(code);
  for (const code of cachedSkipped) runtime.skippedBaseCodes.add(code);

  const maxAvailable = Math.max(1, Math.min(tierRegions.length, Number(settings.max_available_base_codes || 2)));
  if (runtime.availableBaseCodes.size >= maxAvailable) {
    return tierRegions.filter(region => runtime.availableBaseCodes.has(region.baseCode));
  }

  const plan = tierRegions.filter(region => !runtime.skippedBaseCodes.has(region.baseCode));
  return plan.length ? plan : tierRegions;
}


async function joinRealm(characterId: string, accessToken: string, realmCode: string) {
  return retryRealmStateRpc({
    characterId,
    label: "rpc_join_secret_realm",
    maxAttempts: 3,
    fn: () => rpc("rpc_join_secret_realm", { p_character_id: characterId, p_realm_code: realmCode }, accessToken),
  });
}

async function leaveRealm(characterId: string, accessToken: string, realmId: string) {
  try {
    return await retryRealmStateRpc({
      characterId,
      label: "rpc_leave_secret_realm",
      maxAttempts: 2,
      fn: () => rpc("rpc_leave_secret_realm", { p_character_id: characterId, p_realm_id: realmId }, accessToken),
    });
  } catch {
    return null;
  }
}

/** leave → clear queue → join lại realm_code → cập nhật realmId */
async function hardRejoinRealm(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  onLog?: FarmAutoOptions["onLog"];
}): Promise<boolean> {
  const { characterId, accessToken, runtime, onLog } = args;
  const cur = runtime.currentRealm;
  if (!cur?.realmCode) return false;
  clearTargetQueue(runtime);
  if (cur.realmId) {
    await leaveRealm(characterId, accessToken, cur.realmId);
  }
  try {
    const joined = await joinRealm(characterId, accessToken, cur.realmCode);
    const realmId = String(firstDefined(joined?.realm_id, joined?.realmId, joined?.id, cur.realmId, ""));
    if (!realmId) {
      onLog?.("WARN", `Farm rejoin ${cur.realmCode}: không lấy được realm_id`);
      runtime.currentRealm = null;
      return false;
    }
    runtime.currentRealm = { ...cur, realmId };
    onLog?.("INFO", `Farm rejoin kênh ${cur.channelNo} · ${cur.realmCode}`);
    return true;
  } catch (e: any) {
    onLog?.("WARN", `Farm rejoin fail ${cur.realmCode}: ${(e?.message || e).toString().slice(0, 120)}`);
    runtime.currentRealm = null;
    return false;
  }
}

async function snapshotRealm(characterId: string, accessToken: string, realmId: string, limitPlayers: number) {
  return retryRealmStateRpc({
    characterId,
    label: "rpc_get_secret_realm_snapshot",
    maxAttempts: 4,
    fn: () => rpc("rpc_get_secret_realm_snapshot", { p_character_id: characterId, p_realm_id: realmId, p_limit_players: limitPlayers }, accessToken),
  });
}

async function listRealmChannels(characterId: string, accessToken: string, baseCode: string) {
  return rpc("rpc_list_realm_channels", { p_character_id: characterId, p_base_code: baseCode }, accessToken);
}

function extractChannelRows(data: any, region: RealmBasePlan): RealmChannelInfo[] {
  const rows = Array.isArray(data?.channels) ? data.channels : asArray(data);
  return rows
    .map((row: any) => {
      const channelNo = Number(firstDefined(row?.channel_no, row?.channelNo, row?.channel, row?.no));
      const realmCode = String(firstDefined(row?.realm_code, row?.realmCode, row?.code, realmCodeFor(region.baseCode, channelNo)));
      const realmId = String(firstDefined(row?.realm_id, row?.realmId, row?.id, ""));
      if (!Number.isFinite(channelNo) || channelNo <= 0 || !realmCode) return null;
      return {
        baseCode: region.baseCode,
        label: region.label,
        realmId: realmId || undefined,
        realmCode,
        channelNo,
        activeCount: toNumber(row?.active_count ?? row?.activeCount) ?? undefined,
        hostileCount: toNumber(row?.hostile_count ?? row?.hostileCount) ?? undefined,
        raw: row,
      } as RealmChannelInfo;
    })
    .filter(Boolean) as RealmChannelInfo[];
}

async function getRegionChannels(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  region: RealmBasePlan;
  channels: number[];
  settings: Record<string, any>;
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
}) {
  const { characterId, accessToken, runtime, region, channels, settings, onRegionAvailability } = args;
  const wanted = new Set(channels);

  if (region.customPrefix) {
    return channels.map(channelNo => ({
      baseCode: region.baseCode,
      label: region.label,
      realmCode: realmCodeFor(region.baseCode, channelNo),
      channelNo,
    } as RealmChannelInfo));
  }

  const ttlMs = Math.max(60_000, Number(settings.realm_channel_cache_ttl_ms || 24 * 60 * 60 * 1000));
  const cached = runtime.channelCache[region.baseCode];
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.channels.filter(row => wanted.has(row.channelNo));
  }

  const listed = await listRealmChannels(characterId, accessToken, region.baseCode);
  const parsed = extractChannelRows(listed, region);
  runtime.channelCache[region.baseCode] = { at: Date.now(), channels: parsed };
  // Lưu ý: rpc_list_realm_channels OK chỉ chứng minh base_code có channel,
  // chưa chứng minh account farm được vùng đó. Không đánh dấu available ở đây.
  // Vùng chỉ được học/lưu sau khi join + snapshot thấy mob sống hoặc attack thành công.
  return parsed.filter(row => wanted.has(row.channelNo));
}

/** Bình MP: ưu tiên dùng từ thấp → cao (lk → … → lh) */
const MP_PILL_TIERS = ["lk", "tc", "kd", "na", "ht", "lh"] as const;
const MP_BUY_CODE_DEFAULT = "pill_lk_mp";

function orderedMpPillCodes(settings: Record<string, any> = {}): string[] {
  const codes: string[] = [];
  const push = (c: string) => {
    const x = String(c || "").trim();
    if (x && !codes.includes(x)) codes.push(x);
  };
  // preferred từ lần trước dùng OK
  push(String(settings.last_mp_pill || ""));
  for (const t of MP_PILL_TIERS) push(`pill_${t}_mp`);
  // custom user (nếu có) thử sau cascade thấp→cao? User: ưu tiên thấp→cao; custom để cuối
  const custom = String(settings.mp_potion_item_code || "").trim();
  if (custom && !/^pill_(lk|tc|kd|na|ht|lh)_mp$/i.test(custom)) push(custom);
  return codes;
}

/** Mua shop: chỉ pill_lk_mp (hoặc override buy code) */
function mpBuyItemCode(settings: Record<string, any> = {}): string {
  const buy = String(settings.mp_potion_buy_item_code || settings.mp_buy_item_code || "").trim();
  if (buy) return buy;
  return MP_BUY_CODE_DEFAULT;
}

/** Mob đang bị đánh / combat (né nếu detect được từ snapshot) */
function isMobContested(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (
    raw.in_combat === true ||
    raw.is_in_combat === true ||
    raw.combat === true ||
    raw.being_attacked === true ||
    raw.is_being_attacked === true ||
    raw.engaged === true ||
    raw.is_engaged === true ||
    raw.under_attack === true ||
    raw.locked === true ||
    raw.is_locked === true
  ) {
    return true;
  }
  const status = normalizeKey(raw.combat_status || raw.battle_status || raw.fight_status || "");
  if (status && /combat|fight|engaged|busy|attack|locked/.test(status)) return true;
  if (raw.attacker_id || raw.attacker_character_id || raw.target_character_id || raw.locked_by) return true;
  if (Array.isArray(raw.attackers) && raw.attackers.length > 0) return true;
  if (Array.isArray(raw.engagers) && raw.engagers.length > 0) return true;
  // HP < max ~98% → coi như đang bị chip (người khác đánh)
  const hp = getMobHp(raw);
  const maxHp = toNumber(
    firstDefined(raw.hp_max, raw.max_hp, raw.maxHp, raw.health_max, raw.max_health, raw.hpMax)
  );
  if (hp !== null && maxHp !== null && maxHp > 0 && hp < maxHp * 0.98) return true;
  return false;
}

function getMobMaxHp(raw: any): number | null {
  return toNumber(firstDefined(raw?.hp_max, raw?.max_hp, raw?.maxHp, raw?.health_max, raw?.max_health, raw?.hpMax));
}

/**
 * p_apply_counter: luôn gửi true|false (không omit).
 * Học tự động theo kênh — không setting tay:
 * - mặc định false
 * - đã học kênh này → dùng
 * - đổi kênh → mang giá trị kênh trước (last), nếu farm không kill → đảo & lưu kênh mới
 */
function getApplyCounterByChannel(settings: Record<string, any>): Record<string, boolean> {
  const raw = settings.learned_apply_counter_by_channel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === true || v === false) out[String(k)] = v;
  }
  return out;
}

function channelCounterKey(channelNo: number | undefined | null): string {
  const n = Math.floor(Number(channelNo));
  if (Number.isFinite(n) && n > 0) return `c${n}`;
  return "c_default";
}

function resolveApplyCounterForChannel(
  settings: Record<string, any>,
  channelNo?: number | null
): { apply: boolean; reason: string; key: string; fromCarry: boolean } {
  const key = channelCounterKey(channelNo);
  const map = getApplyCounterByChannel(settings);

  // Kênh này đã học
  if (Object.prototype.hasOwnProperty.call(map, key) && (map[key] === true || map[key] === false)) {
    return { apply: map[key], reason: `learned_${key}=${map[key]}`, key, fromCarry: false };
  }

  // Đổi kênh: mang giá trị last (vd c7=true → c6 thử true trước)
  if (settings.learned_apply_counter === true || settings.learned_apply_counter === false) {
    return {
      apply: settings.learned_apply_counter === true,
      reason: `carry_last=${settings.learned_apply_counter}`,
      key,
      fromCarry: true,
    };
  }

  // Acc mới: mặc định false
  return { apply: false, reason: "default_false", key, fromCarry: false };
}

function questProgressFingerprint(questData: any): string {
  if (!questData) return "";
  const extracted = extractQuestNeededTypes(questData);
  const c = (extracted as any)?.raw?.counters;
  if (!c) {
    // fallback deep-ish
    return JSON.stringify({
      n: questData?.quest?.mobs_killed ?? questData?.mobs_killed,
      e: questData?.quest?.elites_killed ?? questData?.elites_killed,
      b: questData?.quest?.bosses_killed ?? questData?.bosses_killed,
    });
  }
  return JSON.stringify({
    n: c.normal?.current,
    e: c.elite?.current,
    b: c.boss?.current,
  });
}

/** Attack — luôn gửi p_apply_counter true|false */
async function attackMob(
  characterId: string,
  accessToken: string,
  realmId: string,
  mobId: string,
  skillSlot: number,
  applyCounter: boolean
) {
  return rpc(
    "rpc_attack_realm_mob_v3",
    {
      p_character_id: characterId,
      p_realm_id: realmId,
      p_mob_id: mobId,
      p_skill_slot: skillSlot,
      p_apply_counter: applyCounter === true,
    },
    accessToken
  );
}


async function attackWithMpRecovery(args: {
  characterId: string;
  accessToken: string;
  realmId: string;
  mobId: string;
  skillSlot: number;
  applyCounter: boolean;
  autoUseMpPotion: boolean;
  settings?: Record<string, any>;
  autoBuyMpPotion?: boolean;
  mpPotionBuyQty?: number;
  mpPotionShopCode?: string;
  onLog?: FarmAutoOptions["onLog"];
  shouldStop?: () => boolean;
  maxPotionAttempts?: number;
}) {
  const {
    characterId,
    accessToken,
    realmId,
    mobId,
    skillSlot,
    applyCounter,
    autoUseMpPotion,
    settings = {},
    autoBuyMpPotion = true,
    mpPotionBuyQty = 10,
    mpPotionShopCode = "alchemy",
    onLog,
    shouldStop,
    maxPotionAttempts = 2,
  } = args;

  let mpPotionUsedCount = 0;
  let mpPotionFailedCount = 0;
  let mpPotionBoughtCount = 0;
  let mpPotionBuySpent = 0;
  let lastMpPotionResult: any = undefined;
  let lastNoManaError: any = null;

  for (let attempt = 0; attempt <= Math.max(0, maxPotionAttempts); attempt += 1) {
    try {
      const attackResult = await attackMob(characterId, accessToken, realmId, mobId, skillSlot, applyCounter);
      return { attackResult, mpPotionUsedCount, mpPotionFailedCount, mpPotionBoughtCount, mpPotionBuySpent, lastMpPotionResult };
    } catch (error: any) {
      if (!isNotEnoughMpError(error) || !autoUseMpPotion) throw error;
      lastNoManaError = error;

      if (attempt >= maxPotionAttempts || shouldStop?.()) {
        const err: any = new Error(`[rpc_attack_realm_mob_v3] no_mana_after_mp_potion_retry`);
        err.data = {
          reason: "no_mana_after_mp_potion_retry",
          lastAttackError: error?.data || { message: error?.message },
          lastMpPotionResult,
          mpPotionUsedCount,
          mpPotionFailedCount,
          mpPotionBoughtCount,
          mpPotionBuySpent,
        };
        throw err;
      }

      try {
        const recovery = await ensureMpPotionAndUse({
          characterId,
          accessToken,
          settings,
          autoBuy: Boolean(autoBuyMpPotion),
          buyQty: mpPotionBuyQty,
          shopCode: mpPotionShopCode,
          onLog,
        });
        lastMpPotionResult = { used: recovery.used, buyResult: recovery.buyResult, itemCode: recovery.itemCode };
        mpPotionUsedCount += 1;
        mpPotionBoughtCount += recovery.boughtCount;
        mpPotionBuySpent += recovery.buySpent;
        if (recovery.itemCode) settings.last_mp_pill = recovery.itemCode;
        // Bơm/mua xong đánh lại ngay trong cùng vòng
        await cancellableSleep(700, shouldStop);
        continue;
      } catch (potionError: any) {
        mpPotionFailedCount += 1;
        const err: any = new Error(`Không dùng được bình MP sau lỗi ${error?.message || "no_mana"}`);
        err.data = {
          reason: "mp_potion_failed",
          attackError: lastNoManaError?.data || { message: lastNoManaError?.message },
          potionError: potionError?.data || { message: potionError?.message },
          autoBuyMpPotion,
          mpPotionBuyQty,
        };
        throw err;
      }
    }
  }

  const err: any = new Error(`[rpc_attack_realm_mob_v3] no_mana`);
  err.data = lastNoManaError?.data || { reason: "no_mana" };
  throw err;
}

function attackMobHpAfter(result: any) {
  if (!result) return null;
  return toNumber(result.mob_hp_after ?? result.mob?.hp ?? result.mob?.hp_after ?? result.target_hp_after);
}

/** Trích máu tự thân từ 1 object (kết quả attack / entry player trong snapshot). Thử nhiều tên trường. */
function getSelfHp(obj: any): { hp?: number; max?: number } {
  if (!obj || typeof obj !== "object") return {};
  const hpRaw = toNumber(
    firstDefined(
      obj.self_hp, obj.player_hp, obj.char_hp, obj.character_hp, obj.hp, obj.current_hp,
      obj.hp_current, obj.self?.hp, obj.player?.hp, obj.character?.hp
    )
  );
  const maxRaw = toNumber(
    firstDefined(
      obj.self_hp_max, obj.player_hp_max, obj.char_hp_max, obj.character_hp_max, obj.hp_max, obj.max_hp,
      obj.hp_max_current, obj.self?.hp_max, obj.player?.hp_max, obj.character?.hp_max
    )
  );
  const hp = hpRaw != null && Number.isFinite(hpRaw) ? hpRaw : undefined;
  const max = maxRaw != null && Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined;
  return { hp, max };
}

/** Tìm máu tự thân từ snapshot (danh sách players khớp characterId, hoặc top-level self). */
function extractSelfHp(snap: any, characterId: string): { hp?: number; max?: number } {
  if (!snap) return {};
  const players = Array.isArray(snap.players) ? snap.players : [];
  const me = players.find(
    (p: any) => p && String(p.character_id ?? p.id ?? p.char_id) === String(characterId)
  );
  if (me) return getSelfHp(me);
  if (snap.self || snap.character_id != null) return getSelfHp(snap.self || snap);
  return {};
}

/** Chọn skill_slot trước mỗi lượt attack: máu < threshold → skill hồi máu, ngược lại đánh thường (0). */
function pickFarmSkillSlot(runtime: any, settings: Record<string, any>): { skillSlot: number; reason: string } {
  if (settings.auto_heal_on_low_hp === false) return { skillSlot: 0, reason: "heal tắt" };
  const healSlot = Math.max(0, Math.floor(Number(settings.farm_heal_skill_slot ?? 3)));
  const threshold = Math.max(1, Math.min(99, Number(settings.farm_heal_hp_threshold ?? 50))) / 100;
  const hp = runtime?.lastSelfHp;
  const max = runtime?.lastSelfHpMax;
  if (hp == null || max == null || max <= 0) {
    return { skillSlot: 0, reason: "chưa biết máu" };
  }
  if (hp / max < threshold) {
    return { skillSlot: healSlot, reason: `máu ${Math.round((hp / max) * 100)}% < ${Math.round(threshold * 100)}% → skill ${healSlot}` };
  }
  return { skillSlot: 0, reason: `máu ${Math.round((hp / max) * 100)}% ok` };
}

function attackSpeedSec(result: any) {
  if (!result) return null;
  return toNumber(result.atk_speed_sec ?? result.attack_speed_sec ?? result.cooldown_sec ?? result.next_attack_sec);
}

function attackDelayMsFromResult(result: any, fallbackMs: number) {
  const sec = attackSpeedSec(result);
  // Server thực tế có trả atk_speed_sec. Dùng giá trị server + đệm nhỏ để farm nhanh hơn
  // nhưng vẫn tránh spam sát cooldown.
  if (sec !== null && sec > 0) return Math.max(1000, Math.round(sec * 1000 + 350));
  return fallbackMs;
}

function attackDropItemCode(result: any) {
  const raw = firstDefined(result?.drop_item_code, result?.dropItemCode, result?.drop?.item_code, result?.reward?.item_code);
  return raw === undefined || raw === null || raw === "" ? undefined : String(raw);
}

function isMobKilledByAttack(result: any) {
  if (!result) return false;
  if (result.killed || result.mob_killed || result.defeated || result.is_dead) return true;
  const mobHpAfter = attackMobHpAfter(result);
  return mobHpAfter !== null && mobHpAfter <= 0;
}

function currentRealmStillMatches(runtime: FarmRuntimeState, channels: number[], regions: { baseCode: string }[]) {
  if (!runtime.currentRealm) return false;
  if (!channels.includes(runtime.currentRealm.channelNo)) return false;
  if (!regions.some(region => region.baseCode === runtime.currentRealm?.baseCode)) return false;
  return true;
}

async function refreshMobQueue(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  wantedTypes: FarmMobType[];
  settings: Record<string, any>;
  claimMobLock?: FarmAutoOptions["claimMobLock"];
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
  onLog?: FarmAutoOptions["onLog"];
}) {
  const { characterId, accessToken, runtime, wantedTypes, settings, claimMobLock, onRegionAvailability } = args;
  if (!runtime.currentRealm?.realmId) return { queue: [], skippedLocked: 0, scanned: 0 };

  // forceRefresh: sau kill luôn snapshot lại; cache rất ngắn khi không force
  const forceRefresh = settings._force_mob_refresh === true;
  const mobCacheMaxAgeMs = Math.max(500, Number(settings.mob_cache_max_age_ms || 2000));
  if (
    !forceRefresh &&
    runtime.mobQueue.length &&
    Date.now() - runtime.mobQueueAt < mobCacheMaxAgeMs
  ) {
    runtime.mobQueue = runtime.mobQueue.filter(
      (m) => !isMobBlacklisted(runtime, m.id) && !isMobContested(m.raw)
    );
    if (runtime.mobQueue.length) return { queue: runtime.mobQueue, skippedLocked: 0, skippedContested: 0, scanned: 0 };
  }

  const freeOnly = settings.prefer_free_mobs !== false;
  const limitPlayers = Math.max(20, Math.min(300, Number(settings.snapshot_limit_players || 200)));
  const snap = await snapshotRealm(characterId, accessToken, runtime.currentRealm.realmId, limitPlayers);
  runtime.lastSnapshot = snap;
  runtime.lastSnapshotSummary = summarizeMobs(snap, runtime.currentRealm);
  const mobCount = collectMobs(snap).length;
  const aliveCount = collectMobs(snap).filter((mob) => isMobAlive(mob)).length;
  const extracted = extractMobs(
    snap,
    wantedTypes,
    claimMobLock,
    runtime.currentRealm,
    Math.max(3000, Number(settings.mob_reservation_ttl_ms || 7000)),
    runtime,
    freeOnly
  );
  if (extracted.queue.length) {
    learnFarmableRegion({
      runtime,
      settings,
      baseCode: runtime.currentRealm.baseCode,
      label: runtime.currentRealm.label,
      source: wantedTypes.length === 1 && wantedTypes[0] === "boss" ? "snapshot_has_alive_boss" : "snapshot_has_target_mob",
      meta: {
        realmCode: runtime.currentRealm.realmCode,
        channelNo: runtime.currentRealm.channelNo,
        mobCount,
        aliveCount,
        freeCount: extracted.freeCount,
        targetCount: extracted.queue.length,
        wantedTypes,
      },
      onRegionAvailability,
    });
  }
  runtime.mobQueue = extracted.queue;
  runtime.mobQueueAt = Date.now();
  return {
    queue: runtime.mobQueue,
    skippedLocked: extracted.skippedLocked,
    skippedContested: extracted.skippedContested,
    scanned: 1,
  };
}

async function buildRealmCandidates(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  channels: number[];
  settings: Record<string, any>;
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
  shouldStop?: () => boolean;
}) {
  const { characterId, accessToken, runtime, channels, settings, onRegionAvailability, shouldStop } = args;
  const regions = regionPlan(runtime, settings);
  const tierRegions = regionsForTier(getFarmRealmTier(settings));
  const maxAvailable = Math.max(1, Math.min(tierRegions.length, Number(settings.max_available_base_codes || 2)));
  const candidates: RealmChannelInfo[] = [];

  for (const region of regions) {
    if (shouldStop?.()) break;
    if (!region.customPrefix && runtime.availableBaseCodes.size >= maxAvailable && !runtime.availableBaseCodes.has(region.baseCode)) {
      runtime.skippedBaseCodes.add(region.baseCode);
      onRegionAvailability?.(region.baseCode, false, { label: region.label, reason: "max_available_region_learned" });
      continue;
    }

    try {
      const rows = await getRegionChannels({ characterId, accessToken, runtime, region, channels, settings, onRegionAvailability });
      candidates.push(...rows);
    } catch (error: any) {
      if (isLimitError(error)) throw error;
      if (!region.customPrefix && !runtime.availableBaseCodes.has(region.baseCode)) {
        runtime.skippedBaseCodes.add(region.baseCode);
        onRegionAvailability?.(region.baseCode, false, {
          label: region.label,
          reason: errorText(error) || "list_realm_channels_failed",
          source: "rpc_list_realm_channels",
        });
      }
    }
  }

  // Trong giai đoạn chưa học đủ 2 vùng, ưu tiên thử vùng CHƯA học trước.
  // Điều này giúp bot không bị kẹt farm mãi vùng đầu tiên mà không học vùng thứ 2.
  const hasCustomRegion = regions.some(region => region.customPrefix);
  if (!hasCustomRegion && runtime.availableBaseCodes.size > 0 && runtime.availableBaseCodes.size < maxAvailable) {
    candidates.sort((a, b) => Number(runtime.availableBaseCodes.has(a.baseCode)) - Number(runtime.availableBaseCodes.has(b.baseCode)));
  }

  // Nếu đã học đủ 2 vùng hợp lệ, chỉ giữ candidate thuộc 2 vùng đó.
  // Tránh vòng hiện tại tiếp tục lang thang sang 2 vùng còn lại.
  if (!hasCustomRegion && runtime.availableBaseCodes.size >= maxAvailable) {
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (!runtime.availableBaseCodes.has(candidates[i].baseCode)) candidates.splice(i, 1);
    }
  }

  if (!hasCustomRegion && runtime.availableBaseCodes.size >= maxAvailable) {
    for (const region of tierRegions) {
      if (!runtime.availableBaseCodes.has(region.baseCode)) {
        runtime.skippedBaseCodes.add(region.baseCode);
        onRegionAvailability?.(region.baseCode, false, { label: region.label, reason: "account_has_other_two_regions" });
      }
    }
  }

  if (!candidates.length && runtime.availableBaseCodes.size) {
    // Fallback an toàn: nếu cache setting có vùng hợp lệ nhưng channel cache vừa lỗi, tự dựng realm_code từ base_code.
    const availableRegions = tierRegions.filter(region => runtime.availableBaseCodes.has(region.baseCode));
    for (const region of availableRegions) {
      for (const channelNo of channels) {
        candidates.push({ baseCode: region.baseCode, label: region.label, realmCode: realmCodeFor(region.baseCode, channelNo), channelNo });
      }
    }
  }

  return candidates;
}

async function joinRealmCandidate(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  candidate: RealmChannelInfo;
}) {
  const { characterId, accessToken, runtime, candidate } = args;
  const joined = await joinRealm(characterId, accessToken, candidate.realmCode);
  const realmId = String(firstDefined(joined?.realm_id, joined?.realmId, joined?.id, candidate.realmId || ""));
  if (!realmId) return null;
  runtime.currentRealm = {
    baseCode: candidate.baseCode,
    label: candidate.label,
    realmCode: candidate.realmCode,
    realmId,
    channelNo: candidate.channelNo,
  };
  runtime.mobQueue = [];
  runtime.currentMob = null;
  runtime.currentMobHits = 0;
  runtime.noMobCount = 0;
  return runtime.currentRealm;
}

async function findAndJoinRealm(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  channels: number[];
  settings: Record<string, any>;
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
  onLog?: FarmAutoOptions["onLog"];
  shouldStop?: () => boolean;
}) {
  const { characterId, accessToken, runtime, channels, settings, onRegionAvailability, onLog, shouldStop } = args;
  const candidates = await buildRealmCandidates({ characterId, accessToken, runtime, channels, settings, onRegionAvailability, shouldStop });
  if (!candidates.length) return null;

  const attempts = candidates.length;
  for (let i = 0; i < attempts; i += 1) {
    if (shouldStop?.()) return null;
    const idx = (runtime.scanCursor + i) % attempts;
    const candidate = candidates[idx];
    try {
      const joined = await joinRealmCandidate({ characterId, accessToken, runtime, candidate });
      if (!joined?.realmId) continue;
      runtime.scanCursor = (idx + 1) % attempts;
      return joined;
    } catch (error: any) {
      if (isLimitError(error)) throw error;
      continue;
    }
  }
  return null;
}

async function findBossAcrossRealms(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  channels: number[];
  settings: Record<string, any>;
  claimMobLock?: FarmAutoOptions["claimMobLock"];
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
  onLog?: FarmAutoOptions["onLog"];
  shouldStop?: () => boolean;
}) {
  const { characterId, accessToken, runtime, channels, settings, claimMobLock, onRegionAvailability, onLog, shouldStop } = args;
  const candidates = await buildRealmCandidates({ characterId, accessToken, runtime, channels, settings, onRegionAvailability, shouldStop });
  if (!candidates.length) return { found: false, scanned: 0, skippedLocked: 0 };

  const limitPlayers = Math.max(20, Math.min(300, Number(settings.snapshot_limit_players || 200)));
  const ttlMs = Math.max(3000, Number(settings.mob_reservation_ttl_ms || 7000));
  let scanned = 0;
  let skippedLocked = 0;
  const attempts = candidates.length;

  for (let i = 0; i < attempts; i += 1) {
    if (shouldStop?.()) return { found: false, scanned, skippedLocked };
    const idx = (runtime.scanCursor + i) % attempts;
    const candidate = candidates[idx];

    try {
      const joined = await joinRealmCandidate({ characterId, accessToken, runtime, candidate });
      if (!joined?.realmId) continue;
      const snap = await snapshotRealm(characterId, accessToken, joined.realmId, limitPlayers);
      runtime.lastSnapshot = snap;
      runtime.lastSnapshotSummary = summarizeMobs(snap, joined);
      scanned += 1;
      const mobCount = collectMobs(snap).length;
      const aliveCount = collectMobs(snap).filter(mob => isMobAlive(mob)).length;
      const extracted = extractMobs(snap, ["boss"], claimMobLock, joined, ttlMs, runtime);
      skippedLocked += extracted.skippedLocked;
      if (extracted.queue.length) {
        learnFarmableRegion({
          runtime,
          settings,
          baseCode: joined.baseCode,
          label: joined.label,
          source: "boss_sweep_snapshot_has_alive_boss",
          meta: { realmCode: joined.realmCode, channelNo: joined.channelNo, mobCount, aliveCount, bossCount: extracted.queue.length },
          onRegionAvailability,
        });
        runtime.mobQueue = extracted.queue;
        runtime.mobQueueAt = Date.now();
        runtime.currentMob = null;
        runtime.currentMobHits = 0;
        runtime.noMobCount = 0;
        runtime.scanCursor = (idx + 1) % attempts;
        onLog?.("DEBUG", "Đã tìm thấy boss sống trong realm.", { realmCode: joined.realmCode, channelNo: joined.channelNo, baseCode: joined.baseCode, bossCount: extracted.queue.length });
        return { found: true, scanned, skippedLocked };
      }
      await leaveRealm(characterId, accessToken, joined.realmId);
      runtime.currentRealm = null;
      runtime.mobQueue = [];
      runtime.currentMob = null;
      runtime.currentMobHits = 0;
    } catch (error: any) {
      if (isLimitError(error)) throw error;
      onLog?.("DEBUG", "Scan boss realm lỗi nhẹ, bỏ qua realm này.", { realmCode: candidate.realmCode, reason: errorText(error) || error?.message });
    }
  }

  return { found: false, scanned, skippedLocked };
}

async function getNextMobTarget(args: {
  characterId: string;
  accessToken: string;
  runtime: FarmRuntimeState;
  wantedTypes: FarmMobType[];
  settings: Record<string, any>;
  claimMobLock?: FarmAutoOptions["claimMobLock"];
  onRegionAvailability?: FarmAutoOptions["onRegionAvailability"];
}) {
  const { characterId, accessToken, runtime, wantedTypes, settings, claimMobLock, onRegionAvailability } = args;
  if (
    runtime.currentMob &&
    wantedTypes.includes(runtime.currentMob.kind) &&
    !isMobBlacklisted(runtime, runtime.currentMob.id) &&
    !isMobContested(runtime.currentMob.raw)
  ) {
    return { target: runtime.currentMob, skippedLocked: 0, scanned: 0 };
  }
  if (
    runtime.currentMob &&
    (isMobBlacklisted(runtime, runtime.currentMob.id) || isMobContested(runtime.currentMob.raw))
  ) {
    runtime.currentMob = null;
    runtime.currentMobHits = 0;
  }

  let skippedLocked = 0;
  let scanned = 0;
  let queueInfo = await refreshMobQueue({ characterId, accessToken, runtime, wantedTypes, settings, claimMobLock, onRegionAvailability });
  skippedLocked += queueInfo.skippedLocked;
  scanned += queueInfo.scanned;

  if (!runtime.mobQueue.length) {
    runtime.mobQueueAt = 0;
    queueInfo = await refreshMobQueue({ characterId, accessToken, runtime, wantedTypes, settings, claimMobLock, onRegionAvailability });
    skippedLocked += queueInfo.skippedLocked;
    scanned += queueInfo.scanned;
  }

  while (runtime.mobQueue.length) {
    const candidate = runtime.mobQueue.shift()!;
    if (isMobBlacklisted(runtime, candidate.id)) continue;
    if (isMobContested(candidate.raw)) continue;
    runtime.currentMob = candidate;
    runtime.currentMobHits = 0;
    return { target: candidate, skippedLocked, scanned };
  }

  runtime.currentMob = null;
  return { target: null, skippedLocked, scanned };
}

export async function runFarmAuto(options: FarmAutoOptions): Promise<FarmRunSummary> {
  const { characterId, accessToken, settings = {}, onLog, claimMobLock, onRegionAvailability, shouldStop } = options;
  const startedAt = new Date().toISOString();
  const realmTier = getFarmRealmTier(settings);
  const mode = normalizeMode(firstDefined(settings.mode, settings.farm_mode, settings.target_mode, settings.mob_mode));
  const bossPriorityMode = isBossPrioritySettings(settings, mode);
  const strictBossMode = isStrictBossSettings(settings, mode);
  // Boss Priority nhanh: chỉ dọn Boss -> Elite trong kênh hiện tại rồi chuyển kênh, không dọn Normal.
  // Normal chỉ được thêm vào khi nhiệm vụ Trùng Sinh đang yêu cầu.
  const bossPriorityFast = bossPriorityMode && settings.boss_priority_fast !== false;
  const smartRebirthEnabled = settings.smart_rebirth_farm !== false;
  const priority = bossPriorityMode
    ? ((bossPriorityFast ? ["boss", "elite"] : ["boss", "elite", "normal"]) as FarmMobType[])
    : normalizePriority(settings.priority);
  const channels = channelRange(settings);
  const runtime = getRuntime(characterId, settings);

  // Đòn đánh thường cố định: skill_slot = 0, cooldown server/game = 5 giây.
  // Không lấy từ UI để tránh cấu hình sai làm farm chậm/tốn MP.
  const attackEveryMs = 5000;
  const emptyScanDelayMs = Math.max(1000, Number(settings.empty_scan_delay_ms || 1000));
  const noMobBeforeRotate = bossPriorityMode ? 1 : Math.max(1, Number(settings.no_mob_before_rotate || 1));
  const maxHitsSameMobBeforeRefresh = Math.max(1, Number(settings.max_hits_same_mob_before_refresh || 60));
  // Chọn skill mỗi lượt: mặc định đánh thường (slot 0); nếu máu tự thân < threshold → skill hồi máu (mặc định slot 3).
  // HP lấy từ kết quả attack / snapshot lần trước (lưu runtime.lastSelfHp).
  const skillPick = pickFarmSkillSlot(runtime, settings);
  const skillSlot = skillPick.skillSlot;
  if (skillSlot !== 0) onLog?.("INFO", `Farm chọn skill hồi máu: ${skillPick.reason}`);
  const autoUseMpPotion = settings.auto_use_mp_potion !== false;
  // Uống MP: cascade lk→lh; mua shop chỉ pill_lk_mp
  const autoBuyMpPotion = settings.auto_buy_mp_potion !== false;
  const mpPotionBuyQty = resolveMpBuyQty(settings.mp_potion_buy_qty ?? 10);
  const mpPotionShopCode = String(settings.mp_potion_shop_code || "alchemy").trim() || "alchemy";
  const verifyFarmKillWithSnapshot = settings.verify_farm_kill_with_snapshot !== false;
  /** Số hit không kill → đảo p_apply_counter (mặc định 3) */
  const noKillFlipAfter = Math.max(2, Math.min(10, Number(settings.apply_counter_no_kill_flip_after || 3) || 3));

  const errors: string[] = [];
  const regionSource = regionPlan(runtime, settings);
  const usingCustomRealmPrefix = regionSource.some(region => region.customPrefix);
  const regions: FarmRegionSummary[] = regionSource.map(region => ({ ...region, scannedChannels: [], attackCount: 0, targetCount: 0 }));
  let attackCount = 0;
  let killedCount = 0;
  let killedBossCount = 0;
  let killedEliteCount = 0;
  let killedNormalCount = 0;
  let observedKilledCount = 0;
  let observedKilledBossCount = 0;
  let observedKilledEliteCount = 0;
  let observedKilledNormalCount = 0;
  let intendedObservedMismatchCount = 0;
  let nextAttackDelayMs = attackEveryMs;
  let mpPotionUsedCount = 0;
  let mpPotionFailedCount = 0;
  let mpPotionBoughtCount = 0;
  let mpPotionBuySpent = 0;
  let lastMpPotionResult: any = undefined;
  let skippedLockedCount = 0;
  let scannedRealmCount = 0;
  let lastTarget: FarmAttackSummary | undefined;
  let questProgress: any = undefined;

  // p_apply_counter: học theo kênh, mặc định false, mang last khi đổi kênh
  const learnedByChannel = getApplyCounterByChannel(settings);
  let applyCounterResolved = resolveApplyCounterForChannel(
    settings,
    Number(settings.channel || settings.from_channel) || undefined
  );
  let applyCounter = applyCounterResolved.apply;
  let applyCounterKey = applyCounterResolved.key;
  let noKillStreak = 0;
  let persistFarm: Record<string, any> = {
    learned_apply_counter_by_channel: { ...learnedByChannel },
    learned_apply_counter:
      settings.learned_apply_counter === true || settings.learned_apply_counter === false
        ? settings.learned_apply_counter
        : applyCounter,
  };

  const saveApplyCounter = (value: boolean, key: string, why: string) => {
    learnedByChannel[key] = value;
    applyCounter = value;
    applyCounterKey = key;
    noKillStreak = 0;
    persistFarm = {
      learned_apply_counter_by_channel: { ...learnedByChannel },
      learned_apply_counter: value,
      apply_counter_last_channel: key,
      apply_counter_last_value: value,
    };
    onLog?.(
      "SUCCESS",
      `Farm học p_apply_counter=${value} · ${key} · ${why} · đã lưu (đổi kênh mang theo, fail mới check lại)`
    );
  };

  let quest: any = null;
  let questFpBefore = "";
  if (mode === "smart" || smartRebirthEnabled) {
    quest = await loadQuestProgress(characterId, accessToken, runtime, onLog);
    questProgress = quest?.data;
    questFpBefore = questProgressFingerprint(quest?.data);
  }
  const stopSmartWhenQuestDone = mode === "smart" && settings.smart_stop_when_quest_done === true;
  const smartQuestDone = mode === "smart" && quest?.extracted?.done === true;
  const questNeededTypes = quest?.extracted?.needed || [];
  const neededTypes = orderedTypesForMode(mode, priority, quest?.extracted ? { needed: quest.extracted.needed, done: quest.extracted.done } : null);
  onLog?.(
    "INFO",
    `Farm · p_apply_counter=${applyCounter} (${applyCounterResolved.reason}) · MP lk→lh · mua ${mpBuyItemCode(settings)} · free_mobs · snap sau kill`
  );
  const effectiveMode: FarmRunSummary["effectiveMode"] = smartQuestDone
    ? (stopSmartWhenQuestDone ? "smart_done_stopped" : "all_after_smart_done")
    : mode;

  // Chọn target cho vòng hiện tại:
  // 1) Nếu bật Trùng Sinh thông minh và quest còn yêu cầu mob cụ thể -> farm đúng loại đó.
  // 2) Nếu không có quest mob -> Boss Priority nhanh: Boss -> Elite, bỏ Normal.
  // 3) Chỉ Boss tuyệt đối vẫn chỉ đánh Boss.
  const questTargetTypes: FarmMobType[] = smartRebirthEnabled && questNeededTypes.length
    ? (["boss", "elite", "normal"] as FarmMobType[]).filter(type => questNeededTypes.includes(type))
    : [];
  const bossFastTypes: FarmMobType[] = bossPriorityFast ? ["boss", "elite"] : ["boss", "elite", "normal"];
  const wantedTypesForThisRun: FarmMobType[] = strictBossMode
    ? ["boss"]
    : (questTargetTypes.length
      ? questTargetTypes
      : (bossPriorityMode
        ? bossFastTypes
        : (mode === "smart" && smartQuestDone && !stopSmartWhenQuestDone
          ? priority
          : (neededTypes.length ? neededTypes : priority))));

  if (bossPriorityMode && settings.farm_log_mode === "verbose") {
    onLog?.("DEBUG", strictBossMode
      ? "Farm Boss STRICT: chỉ quét và đánh boss."
      : "Farm Boss ưu tiên động: Boss -> Elite -> Normal; đang farm Elite/Normal vẫn quét boss hồi lại.", {
      channels,
      wantedTypes: wantedTypesForThisRun,
      realmTier,
      realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
      realmPrefixes: regionSource.map(region => region.baseCode),
      realmCodeExamples: regionSource.flatMap(region => channels.slice(0, 3).map(channel => realmCodeFor(region.baseCode, channel))),
      usingCustomRealmPrefix,
    });
  }

  if (smartQuestDone && stopSmartWhenQuestDone) {
    runtime.mobQueue = [];
    runtime.currentMob = null;
    runtime.currentMobHits = 0;
    runtime.noMobCount = 0;
    onLog?.("SUCCESS", "Farm thông minh đã đủ yêu cầu nhiệm vụ trùng sinh, dừng Farm quái.", quest?.extracted?.raw || {});
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "DONE",
      mode,
      effectiveMode,
      priority,
      neededTypes,
      bossPriorityFast,
      smartRebirthEnabled,
      channels,
      regions,
      realmTier,
      realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
      availableBaseCodes: Array.from(runtime.availableBaseCodes),
      skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
      attackCount: 0,
      mpPotionUsedCount: 0,
      mpPotionFailedCount: 0,
      mpPotionBoughtCount: 0,
      mpPotionBuySpent: 0,
      skippedLockedCount: 0,
      scannedRealmCount: 0,
      nextDelayMs: 0,
      errors: [],
      questProgress: undefined,
    };
  }

  if (smartQuestDone && !stopSmartWhenQuestDone) {
    onLog?.("DEBUG", "Farm thông minh đã đủ nhiệm vụ; checkbox dừng không bật nên tiếp tục farm theo priority.", {
      effectiveMode,
      priority: wantedTypesForThisRun,
      quest: quest?.extracted?.raw,
    });
  }

  if (shouldStop?.()) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "WAITING",
      mode,
      effectiveMode,
      priority,
      neededTypes,
      bossPriorityFast,
      smartRebirthEnabled,
      channels,
      regions,
      realmTier,
      realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
      availableBaseCodes: Array.from(runtime.availableBaseCodes),
      skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
      attackCount: 0,
      mpPotionUsedCount: 0,
      mpPotionFailedCount: 0,
      mpPotionBoughtCount: 0,
      mpPotionBuySpent: 0,
      skippedLockedCount: 0,
      scannedRealmCount: 0,
      nextDelayMs: emptyScanDelayMs,
      errors: [],
      questProgress: undefined,
    };
  }

  let recoverable = false;
  try {
    const tierRegionsForLearning = regionsForTier(realmTier);
    const maxLearnedRegions = Math.max(1, Math.min(tierRegionsForLearning.length, Number(settings.max_available_base_codes || 2)));
    const hasCustomRegionSource = regionSource.some(region => region.customPrefix);

    // Nếu mới học được 1/2 vùng, không giữ mãi vùng đã học.
    // Reset realm để vòng kế tiếp ưu tiên scan vùng chưa học, sau khi đủ 2 vùng mới farm ổn định đa kênh.
    if (!hasCustomRegionSource
      && runtime.availableBaseCodes.size > 0
      && runtime.availableBaseCodes.size < maxLearnedRegions
      && runtime.currentRealm?.baseCode
      && runtime.availableBaseCodes.has(runtime.currentRealm.baseCode)) {
      runtime.currentRealm = null;
      runtime.mobQueue = [];
      runtime.currentMob = null;
      runtime.currentMobHits = 0;
    }

    if (!currentRealmStillMatches(runtime, channels, regionSource)) {
      runtime.currentRealm = null;
      runtime.mobQueue = [];
      runtime.currentMob = null;
      runtime.currentMobHits = 0;
    }

    // Boss Priority nhanh không quét lan man toàn bộ vùng/kênh mỗi vòng.
    // Khi đang đánh Elite, chỉ refresh snapshot kênh hiện tại để xem Boss trong chính kênh đó đã hồi chưa.
    // Boss Priority đầy đủ/legacy mới quét toàn bộ vùng/kênh trước khi fallback.
    if (bossPriorityMode && bossPriorityFast && runtime.currentMob?.kind !== "boss") {
      runtime.currentMob = null;
      runtime.currentMobHits = 0;
      runtime.mobQueueAt = 0;
    }

    if (bossPriorityMode && !bossPriorityFast && runtime.currentMob?.kind !== "boss") {
      const fallbackStateBeforeBossSweep = {
        currentRealm: runtime.currentRealm ? { ...runtime.currentRealm } : null,
        currentMob: runtime.currentMob ? { ...runtime.currentMob } : null,
        currentMobHits: runtime.currentMobHits,
        mobQueue: [...runtime.mobQueue],
        mobQueueAt: runtime.mobQueueAt,
      };
      const bossSweep = await findBossAcrossRealms({
        characterId,
        accessToken,
        runtime,
        channels,
        settings,
        claimMobLock,
        onRegionAvailability,
        onLog,
        shouldStop,
      });
      skippedLockedCount += bossSweep.skippedLocked;
      scannedRealmCount += bossSweep.scanned;
      if (!bossSweep.found && strictBossMode) {
        runtime.currentRealm = null;
        runtime.mobQueue = [];
        runtime.currentMob = null;
        runtime.currentMobHits = 0;
        onLog?.("DEBUG", "Không tìm thấy boss sống. Boss STRICT sẽ chờ/quét lại, không fallback.", {
          channels,
          availableBaseCodes: Array.from(runtime.availableBaseCodes),
        });
        return {
          startedAt,
          finishedAt: new Date().toISOString(),
          status: "WAITING",
          mode,
          effectiveMode,
          priority,
          neededTypes,
          bossPriorityFast,
          smartRebirthEnabled,
          channels,
          regions,
          realmTier,
          realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
          availableBaseCodes: Array.from(runtime.availableBaseCodes),
          skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
          attackCount: 0,
          mpPotionUsedCount,
          mpPotionFailedCount,
          mpPotionBoughtCount,
          mpPotionBuySpent,
          lastMpPotionResult,
          skippedLockedCount,
          scannedRealmCount,
          nextDelayMs: emptyScanDelayMs,
          errors,
          questProgress: undefined,
        };
      }
      if (!bossSweep.found && bossPriorityMode) {
        // Không có boss: trả lại target/realm fallback cũ nếu đang đánh Elite/Normal để không bị chậm.
        // Nếu server đã leave realm khi quét boss, nhánh attack sẽ tự rejoin lại khi gặp not_joined.
        runtime.currentRealm = fallbackStateBeforeBossSweep.currentRealm;
        runtime.currentMob = fallbackStateBeforeBossSweep.currentMob;
        runtime.currentMobHits = fallbackStateBeforeBossSweep.currentMobHits;
        runtime.mobQueue = fallbackStateBeforeBossSweep.mobQueue.filter(mob => mob.kind !== "boss");
        runtime.mobQueueAt = fallbackStateBeforeBossSweep.mobQueueAt;
        onLog?.("DEBUG", "Boss chưa hồi, fallback tạm sang Elite/Normal và sẽ quét lại boss ở vòng kế tiếp.", {
          channels,
          availableBaseCodes: Array.from(runtime.availableBaseCodes),
          restoredFallbackTarget: runtime.currentMob ? { id: runtime.currentMob.id, kind: runtime.currentMob.kind, name: runtime.currentMob.name } : null,
        });
      }
    }

    if (!runtime.currentRealm?.realmId) {
      await findAndJoinRealm({ characterId, accessToken, runtime, channels, settings, onRegionAvailability, onLog, shouldStop });
    }

    if (!runtime.currentRealm?.realmId) {
      runtime.noMobCount += 1;
      onLog?.("DEBUG", "Farm chưa tìm được realm hợp lệ, sẽ thử lại vòng sau.", { channels, availableBaseCodes: Array.from(runtime.availableBaseCodes), skippedBaseCodes: Array.from(runtime.skippedBaseCodes) });
    } else {
      const regionSummary = regions.find(region => region.baseCode === runtime.currentRealm?.baseCode);
      if (regionSummary && !regionSummary.scannedChannels.includes(runtime.currentRealm.channelNo)) regionSummary.scannedChannels.push(runtime.currentRealm.channelNo);

      const next = await getNextMobTarget({ characterId, accessToken, runtime, wantedTypes: wantedTypesForThisRun, settings, claimMobLock, onRegionAvailability });
      skippedLockedCount += next.skippedLocked;
      scannedRealmCount += next.scanned;

      if (!next.target) {
        if (strictBossMode) {
          runtime.currentRealm = null;
          runtime.mobQueue = [];
          runtime.currentMob = null;
          runtime.currentMobHits = 0;
          return {
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "WAITING",
            mode,
            effectiveMode,
            priority,
            neededTypes,
            bossPriorityFast,
            smartRebirthEnabled,
            channels,
            regions,
            realmTier,
            realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
            availableBaseCodes: Array.from(runtime.availableBaseCodes),
            skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
            attackCount: 0,
            mpPotionUsedCount,
            mpPotionFailedCount,
            mpPotionBoughtCount,
            mpPotionBuySpent,
            lastMpPotionResult,
            skippedLockedCount,
            scannedRealmCount,
            nextDelayMs: emptyScanDelayMs,
            errors,
            questProgress: undefined,
          };
        }
        runtime.noMobCount += 1;
        if (runtime.noMobCount >= noMobBeforeRotate) {
          const oldRealm = runtime.currentRealm ? { ...runtime.currentRealm } : null;
          if (runtime.currentRealm?.realmId) await leaveRealm(characterId, accessToken, runtime.currentRealm.realmId);
          runtime.currentRealm = null;
          clearTargetQueue(runtime);
          runtime.noMobCount = 0;
          runtime.mobDeadStreak = 0;
          onLog?.("DEBUG", "Farm không còn mob phù hợp, leave + xoay realm/kênh.", oldRealm || undefined);
        }
      } else {
        if (strictBossMode && next.target.kind !== "boss") {
          runtime.currentMob = null;
          runtime.currentMobHits = 0;
          runtime.mobQueue = [];
          runtime.mobQueueAt = 0;
          onLog?.("ERROR", "Boss mode hard-lock chặn mục tiêu không phải boss, không attack.", { target: next.target });
          return {
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "WAITING",
            mode,
            effectiveMode,
            priority,
            neededTypes,
            bossPriorityFast,
            smartRebirthEnabled,
            channels,
            regions,
            realmTier,
            realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
            availableBaseCodes: Array.from(runtime.availableBaseCodes),
            skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
            attackCount: 0,
            mpPotionUsedCount,
            mpPotionFailedCount,
            mpPotionBoughtCount,
            mpPotionBuySpent,
            lastMpPotionResult,
            skippedLockedCount,
            scannedRealmCount,
            nextDelayMs: emptyScanDelayMs,
            errors: ["Boss mode blocked non-boss target"],
            questProgress: undefined,
          };
        }
        runtime.noMobCount = 0;
        // Luôn lấy currentRealm mới nhất (sau rejoin có thể đổi realmId)
        let realm = runtime.currentRealm;
        if (!realm?.realmId) {
          clearTargetQueue(runtime);
          return {
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "WAITING",
            mode,
            effectiveMode,
            priority,
            neededTypes,
            bossPriorityFast,
            smartRebirthEnabled,
            channels,
            regions,
            realmTier,
            realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
            availableBaseCodes: Array.from(runtime.availableBaseCodes),
            skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
            attackCount: 0,
            mpPotionUsedCount,
            mpPotionFailedCount,
            mpPotionBoughtCount,
            mpPotionBuySpent,
            lastMpPotionResult,
            skippedLockedCount,
            scannedRealmCount,
            nextDelayMs: 1000,
            softRescan: true,
            rescanReason: "no_realm",
            errors,
            questProgress: undefined,
          };
        }
        const beforeAttackSnapshot = runtime.lastSnapshot;
        const beforeAttackSummary = runtime.lastSnapshotSummary;
        let attackResult: any;
        try {
          // Đồng bộ counter theo kênh hiện tại (đổi kênh → carry last hoặc learned)
          {
            const r = resolveApplyCounterForChannel(
              { ...settings, learned_apply_counter_by_channel: learnedByChannel, learned_apply_counter: persistFarm.learned_apply_counter },
              realm.channelNo
            );
            applyCounter = r.apply;
            applyCounterKey = r.key;
          }
          const attack = await attackWithMpRecovery({
            characterId,
            accessToken,
            realmId: realm.realmId,
            mobId: next.target.id,
            skillSlot,
            applyCounter,
            autoUseMpPotion,
            settings,
            autoBuyMpPotion,
            mpPotionBuyQty,
            mpPotionShopCode,
            onLog,
            shouldStop,
            maxPotionAttempts: Math.max(1, Math.min(3, Number(settings.mp_potion_max_retry || 2))),
          });
          attackResult = attack.attackResult;
          {
            const s = getSelfHp(attackResult);
            if (s.hp != null) runtime.lastSelfHp = s.hp;
            if (s.max != null) runtime.lastSelfHpMax = s.max;
          }
          mpPotionUsedCount += attack.mpPotionUsedCount;
          mpPotionFailedCount += attack.mpPotionFailedCount;
          mpPotionBoughtCount += attack.mpPotionBoughtCount || 0;
          mpPotionBuySpent += attack.mpPotionBuySpent || 0;
          lastMpPotionResult = attack.lastMpPotionResult || lastMpPotionResult;
        } catch (error: any) {
          if (isChannelRealmError(error)) {
            // Lệch kênh / not_joined / mob_not_found → hard rejoin, clear queue, rescan
            runtime.channelErrorStreak = (runtime.channelErrorStreak || 0) + 1;
            const deadId = next.target?.id;
            if (deadId && (isMobDeadError(error) || /mob_not_found|invalid_mob|unknown_mob/i.test(errorText(error)))) {
              blacklistDeadMob(runtime, deadId, 12_000);
            }
            onLog?.(
              "WARN",
              `Farm lệch kênh/realm: ${(error?.message || "channel_realm").toString().slice(0, 100)} · rejoin #${runtime.channelErrorStreak}`,
              error?.data || { message: error?.message }
            );

            const ok = await hardRejoinRealm({ characterId, accessToken, runtime, onLog });
            if (ok && runtime.currentRealm?.realmId && !isMobBlacklisted(runtime, next.target.id)) {
              try {
                const r2 = resolveApplyCounterForChannel(
                  { ...settings, learned_apply_counter_by_channel: learnedByChannel, learned_apply_counter: persistFarm.learned_apply_counter },
                  runtime.currentRealm.channelNo
                );
                applyCounter = r2.apply;
                applyCounterKey = r2.key;
                const attack = await attackWithMpRecovery({
                  characterId,
                  accessToken,
                  realmId: runtime.currentRealm.realmId,
                  mobId: next.target.id,
                  skillSlot,
                  applyCounter,
                  autoUseMpPotion,
                  settings,
                  autoBuyMpPotion,
                  mpPotionBuyQty,
                  mpPotionShopCode,
                  onLog,
                  shouldStop,
                  maxPotionAttempts: Math.max(1, Math.min(3, Number(settings.mp_potion_max_retry || 2))),
                });
                attackResult = attack.attackResult;
                {
                  const s = getSelfHp(attackResult);
                  if (s.hp != null) runtime.lastSelfHp = s.hp;
                  if (s.max != null) runtime.lastSelfHpMax = s.max;
                }
                mpPotionUsedCount += attack.mpPotionUsedCount;
                mpPotionFailedCount += attack.mpPotionFailedCount;
                mpPotionBoughtCount += attack.mpPotionBoughtCount || 0;
                mpPotionBuySpent += attack.mpPotionBuySpent || 0;
                lastMpPotionResult = attack.lastMpPotionResult || lastMpPotionResult;
                runtime.channelErrorStreak = 0;
              } catch (retryErr: any) {
                clearTargetQueue(runtime);
                if (isMobDeadError(retryErr)) {
                  blacklistDeadMob(runtime, next.target.id, 12_000);
                  runtime.mobDeadStreak = (runtime.mobDeadStreak || 0) + 1;
                  return {
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    status: "WAITING",
                    mode,
                    effectiveMode,
                    priority,
                    neededTypes,
                    bossPriorityFast,
                    smartRebirthEnabled,
                    channels,
                    regions,
                    realmTier,
                    realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
                    availableBaseCodes: Array.from(runtime.availableBaseCodes),
                    skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
                    attackCount: 0,
                    mpPotionUsedCount,
                    mpPotionFailedCount,
                    mpPotionBoughtCount,
                    mpPotionBuySpent,
                    lastMpPotionResult,
                    skippedLockedCount,
                    scannedRealmCount,
                    nextDelayMs: 700,
                    softRescan: true,
                    rescanReason: "mob_dead_after_rejoin",
                    errors,
                    questProgress: undefined,
                  };
                }
                // 2+ lần lệch kênh liên tiếp → đổi kênh
                if (runtime.channelErrorStreak >= 2) {
                  if (runtime.currentRealm?.realmId) {
                    await leaveRealm(characterId, accessToken, runtime.currentRealm.realmId);
                  }
                  runtime.currentRealm = null;
                  runtime.channelErrorStreak = 0;
                  runtime.noMobCount = noMobBeforeRotate;
                  onLog?.("WARN", "Farm rejoin vẫn lỗi → xoay kênh/realm");
                }
                return {
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  status: "WAITING",
                  mode,
                  effectiveMode,
                  priority,
                  neededTypes,
                  bossPriorityFast,
                  smartRebirthEnabled,
                  channels,
                  regions,
                  realmTier,
                  realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
                  availableBaseCodes: Array.from(runtime.availableBaseCodes),
                  skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
                  attackCount: 0,
                  mpPotionUsedCount,
                  mpPotionFailedCount,
                  mpPotionBoughtCount,
                  mpPotionBuySpent,
                  lastMpPotionResult,
                  skippedLockedCount,
                  scannedRealmCount,
                  nextDelayMs: 1200,
                  softRescan: true,
                  rescanReason: "channel_rejoin_retry_fail",
                  errors,
                  questProgress: undefined,
                };
              }
            } else {
              // rejoin fail hoặc mob blacklisted → xoay nếu streak cao
              if (runtime.channelErrorStreak >= 2) {
                if (runtime.currentRealm?.realmId) {
                  await leaveRealm(characterId, accessToken, runtime.currentRealm.realmId);
                }
                runtime.currentRealm = null;
                runtime.channelErrorStreak = 0;
                onLog?.("WARN", "Farm không rejoin được → xoay kênh");
              }
              clearTargetQueue(runtime);
              return {
                startedAt,
                finishedAt: new Date().toISOString(),
                status: "WAITING",
                mode,
                effectiveMode,
                priority,
                neededTypes,
                bossPriorityFast,
                smartRebirthEnabled,
                channels,
                regions,
                realmTier,
                realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
                availableBaseCodes: Array.from(runtime.availableBaseCodes),
                skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
                attackCount: 0,
                mpPotionUsedCount,
                mpPotionFailedCount,
                mpPotionBoughtCount,
                mpPotionBuySpent,
                lastMpPotionResult,
                skippedLockedCount,
                scannedRealmCount,
                nextDelayMs: 1000,
                softRescan: true,
                rescanReason: "channel_realm_error",
                errors,
                questProgress: undefined,
              };
            }
          } else if (isNotEnoughMpError(error) && autoUseMpPotion) {
            // Đã thử bơm và retry trong attackWithMpRecovery nhưng vẫn không đủ MP.
            // Không log ERROR liên tục; giữ mob hiện tại và thử lại vòng sau.
            mpPotionFailedCount += 1;
            lastMpPotionResult = error?.data || { message: error?.message };
            onLog?.("WARN", `Farm vẫn thiếu MP sau cascade pill_lk→lh (+ mua LK), sẽ thử lại vòng sau.`, lastMpPotionResult);
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "WAITING",
              mode,
              effectiveMode,
              priority,
              neededTypes,
              bossPriorityFast,
              smartRebirthEnabled,
              channels,
              regions,
              availableBaseCodes: Array.from(runtime.availableBaseCodes),
              skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
              attackCount: 0,
              mpPotionUsedCount,
              mpPotionFailedCount,
              mpPotionBoughtCount,
              mpPotionBuySpent,
              lastMpPotionResult,
              skippedLockedCount,
              scannedRealmCount,
              nextDelayMs: attackEveryMs,
              errors,
              questProgress: undefined,
            };
          } else if (isMobDeadError(error)) {
            // Mob đã chết: blacklist id, force snapshot, rescan nhanh; chuỗi dead → rotate kênh
            const deadId = next.target?.id || "";
            blacklistDeadMob(runtime, deadId, Number(settings.mob_dead_blacklist_ms || 12_000));
            clearTargetQueue(runtime);
            runtime.mobDeadStreak = (runtime.mobDeadStreak || 0) + 1;
            const streak = runtime.mobDeadStreak;
            const rotateAfter = Math.max(2, Math.min(8, Number(settings.mob_dead_rotate_after || 3)));

            if (streak >= rotateAfter && runtime.currentRealm) {
              onLog?.(
                "WARN",
                `Farm mob_dead ×${streak} @ c${runtime.currentRealm.channelNo} → leave + xoay kênh`
              );
              await leaveRealm(characterId, accessToken, runtime.currentRealm.realmId);
              runtime.currentRealm = null;
              runtime.mobDeadStreak = 0;
              runtime.noMobCount = 0;
              return {
                startedAt,
                finishedAt: new Date().toISOString(),
                status: "WAITING",
                mode,
                effectiveMode,
                priority,
                neededTypes,
                bossPriorityFast,
                smartRebirthEnabled,
                channels,
                regions,
                realmTier,
                realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
                availableBaseCodes: Array.from(runtime.availableBaseCodes),
                skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
                attackCount: 0,
                mpPotionUsedCount,
                mpPotionFailedCount,
                mpPotionBoughtCount,
                mpPotionBuySpent,
                lastMpPotionResult,
                skippedLockedCount,
                scannedRealmCount,
                nextDelayMs: 800,
                softRescan: true,
                rescanReason: "mob_dead_rotate_channel",
                errors,
                questProgress: undefined,
              };
            }

            onLog?.(
              "DEBUG",
              `Mob dead #${deadId || "?"} (streak ${streak}/${rotateAfter}) → blacklist + quét lại`,
              error?.data || { message: error?.message }
            );
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "WAITING",
              mode,
              effectiveMode,
              priority,
              neededTypes,
              bossPriorityFast,
              smartRebirthEnabled,
              channels,
              regions,
              realmTier,
              realmTierLabel: REALM_TIER_LABELS[realmTier] || realmTier,
              availableBaseCodes: Array.from(runtime.availableBaseCodes),
              skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
              attackCount: 0,
              mpPotionUsedCount,
              mpPotionFailedCount,
              mpPotionBoughtCount,
              mpPotionBuySpent,
              lastMpPotionResult,
              skippedLockedCount,
              scannedRealmCount,
              nextDelayMs: 700,
              softRescan: true,
              rescanReason: "mob_dead",
              errors,
              questProgress: undefined,
            };
          } else if (isCooldownError(error)) {
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "WAITING",
              mode,
              effectiveMode,
              priority,
              neededTypes,
              bossPriorityFast,
              smartRebirthEnabled,
              channels,
              regions,
              availableBaseCodes: Array.from(runtime.availableBaseCodes),
              skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
              attackCount: 0,
              mpPotionUsedCount,
              mpPotionFailedCount,
              mpPotionBoughtCount,
              mpPotionBuySpent,
              lastMpPotionResult,
              skippedLockedCount,
              scannedRealmCount,
              nextDelayMs: attackEveryMs,
              errors,
              questProgress: undefined,
            };
          } else if (isLimitError(error)) {
            errors.push(error?.message || "Farm limit");
            throw error;
          } else {
            runtime.currentMob = null;
            runtime.currentMobHits = 0;
            // Lỗi chưa phân loại: nếu là lỗi cứng (auth/account) thì ném để dừng;
            // ngược lại bọc thành FarmRecoverableError để top-level trả WAITING + softRescan
            // (tự phục hồi/rescan thay vì spin PARTIAL_ERROR mỗi tick — chống "FARM HĂNG").
            if (isFatalError(error)) throw error;
            onLog?.(
              "WARN",
              `Farm lỗi chưa phân loại (${(error?.message || "").toString().slice(0, 140)}) · tự phục hồi/rescan`,
              error?.data || { message: error?.message }
            );
            throw new FarmRecoverableError(error?.message || "unknown farm error");
          }
        }

        attackCount += 1;
        runtime.mobDeadStreak = 0;
        runtime.channelErrorStreak = 0;
        realm = runtime.currentRealm || realm;
        nextAttackDelayMs = attackDelayMsFromResult(attackResult, attackEveryMs);
        const targetKilled = isMobKilledByAttack(attackResult);
        const targetHpAfter = attackMobHpAfter(attackResult);
        const targetDropItemCode = attackDropItemCode(attackResult);
        const targetAttackSpeedSec = attackSpeedSec(attackResult);

        let afterAttackSnapshot: any = undefined;
        let afterAttackSummary: FarmSnapshotSummary | undefined = undefined;
        let observed = {
          observedKind: targetKilled ? next.target.kind : null,
          confidence: targetKilled ? "response_only" : "none",
          reason: targetKilled ? "response_hp_after_zero_no_post_snapshot" : "no_observed_kill",
          beforeAlive: true,
          afterAlive: false,
          responseHpAfter: targetHpAfter,
          afterHpSnapshot: null as number | null,
          delta: undefined as ReturnType<typeof snapshotCountDelta>,
        };

        if (verifyFarmKillWithSnapshot && realm?.realmId) {
          try {
            afterAttackSnapshot = await snapshotRealm(characterId, accessToken, realm.realmId, Math.max(20, Math.min(300, Number(settings.snapshot_limit_players || 200))));
            afterAttackSummary = summarizeMobs(afterAttackSnapshot, realm);
            runtime.lastSnapshot = afterAttackSnapshot;
            runtime.lastSnapshotSummary = afterAttackSummary;
            {
              const s = extractSelfHp(afterAttackSnapshot, characterId);
              if (s.hp != null) runtime.lastSelfHp = s.hp;
              if (s.max != null) runtime.lastSelfHpMax = s.max;
            }
            observed = inferObservedKill({
              target: next.target,
              beforeSnapshot: beforeAttackSnapshot,
              beforeSummary: beforeAttackSummary,
              afterSnapshot: afterAttackSnapshot,
              afterSummary: afterAttackSummary,
              responseHpAfter: targetHpAfter,
            });
          } catch (verifyError: any) {
            onLog?.("DEBUG", "Không snapshot được sau attack để đối chiếu kill thực tế, fallback theo response.", verifyError?.data || { message: verifyError?.message });
          }
        }

        if (targetKilled) {
          killedCount += 1;
          if (next.target.kind === "boss") killedBossCount += 1;
          else if (next.target.kind === "elite") killedEliteCount += 1;
          else if (next.target.kind === "normal") killedNormalCount += 1;
          // Kill OK → khóa giá trị counter cho kênh này
          noKillStreak = 0;
          const ck = channelCounterKey(realm.channelNo);
          if (learnedByChannel[ck] !== applyCounter) {
            saveApplyCounter(applyCounter, ck, "kill_ok");
          } else {
            // vẫn cập nhật last global
            persistFarm = {
              ...persistFarm,
              learned_apply_counter: applyCounter,
              learned_apply_counter_by_channel: { ...learnedByChannel, [ck]: applyCounter },
            };
            learnedByChannel[ck] = applyCounter;
          }
        } else {
          // Không kill → đếm streak; đủ N hit → đảo true/false & lưu kênh
          noKillStreak += 1;
          if (noKillStreak >= noKillFlipAfter) {
            const ck = channelCounterKey(realm.channelNo);
            const flipped = !applyCounter;
            saveApplyCounter(flipped, ck, `no_kill_x${noKillStreak}`);
          }
        }

        if (observed.observedKind) {
          observedKilledCount += 1;
          if (observed.observedKind === "boss") observedKilledBossCount += 1;
          else if (observed.observedKind === "elite") observedKilledEliteCount += 1;
          else if (observed.observedKind === "normal") observedKilledNormalCount += 1;
          if (observed.observedKind !== next.target.kind) {
            intendedObservedMismatchCount += 1;
            onLog?.("WARN", `Farm mismatch: định đánh ${next.target.kind} nhưng snapshot sau attack ghi giảm ${observed.observedKind}.`, {
              realmCode: realm.realmCode,
              channelNo: realm.channelNo,
              target: { id: next.target.id, kind: next.target.kind, name: next.target.name },
              observed,
              beforeCounts: snapshotCountsForSummary(beforeAttackSummary),
              afterCounts: snapshotCountsForSummary(afterAttackSummary),
            });
          }
        }
        learnFarmableRegion({
          runtime,
          settings,
          baseCode: realm.baseCode,
          label: realm.label,
          source: "attack_success",
          meta: { realmCode: realm.realmCode, channelNo: realm.channelNo, mobId: next.target.id, mobType: next.target.kind },
          onRegionAvailability,
        });
        runtime.currentMobHits += 1;
        if (regionSummary) {
          regionSummary.attackCount += 1;
          regionSummary.targetCount += 1;
        }

        lastTarget = {
          baseCode: realm.baseCode,
          realmCode: realm.realmCode,
          realmId: realm.realmId,
          channelNo: realm.channelNo,
          mobId: next.target.id,
          mobName: next.target.name,
          mobType: next.target.kind,
          killed: targetKilled,
          mobHpAfter: targetHpAfter,
          dropItemCode: targetDropItemCode,
          attackSpeedSec: targetAttackSpeedSec,
          attackResult,
          responseKilled: targetKilled,
          observedKilled: Boolean(observed.observedKind),
          observedKind: observed.observedKind,
          observedConfidence: observed.confidence,
          observedReason: observed.reason,
          beforeCounts: snapshotCountsForSummary(beforeAttackSummary),
          afterCounts: snapshotCountsForSummary(afterAttackSummary),
          countDelta: observed.delta,
        };

        // Giết xong / đánh quá lâu → bỏ target; kill → snapshot lại mob sống + free
        if (targetKilled || runtime.currentMobHits >= maxHitsSameMobBeforeRefresh) {
          const killedId = next.target.id;
          if (targetKilled && killedId) {
            blacklistDeadMob(runtime, killedId, 8_000);
          }
          clearTargetQueue(runtime);
          if (targetKilled && realm?.realmId) {
            try {
              const rescan = await refreshMobQueue({
                characterId,
                accessToken,
                runtime,
                wantedTypes: wantedTypesForThisRun,
                settings: { ...settings, _force_mob_refresh: true, prefer_free_mobs: true },
                claimMobLock,
                onRegionAvailability,
              });
              skippedLockedCount += rescan.skippedLocked || 0;
              scannedRealmCount += rescan.scanned || 0;
              const freeN = runtime.mobQueue.length;
              const skipC = (rescan as any).skippedContested ?? 0;
              onLog?.(
                "INFO",
                `Farm kill → snapshot lại · free ${freeN} · bỏ contested ~${skipC} · sẵn sàng mob kế`
              );
              // Prefill next target từ snapshot mới (vòng sau attack sau CD)
              if (runtime.mobQueue.length) {
                const nxt = runtime.mobQueue.shift()!;
                if (!isMobBlacklisted(runtime, nxt.id) && !isMobContested(nxt.raw)) {
                  runtime.currentMob = nxt;
                  runtime.currentMobHits = 0;
                }
              }
            } catch (snapErr: any) {
              onLog?.(
                "DEBUG",
                `Farm snapshot sau kill fail: ${(snapErr?.message || snapErr).toString().slice(0, 100)}`
              );
            }
          }
        }
      }
    }
  } catch (error: any) {
    if (error instanceof FarmRecoverableError) {
      recoverable = true;
      onLog?.("WARN", `Farm tự phục hồi sau lỗi chưa phân loại: ${error.message}`);
    } else {
      errors.push(error?.message || "Farm quái lỗi không xác định");
      onLog?.("ERROR", error?.message || "Farm quái lỗi không xác định.", error?.data || { message: error?.message });
    }
  }

  // smart_rebirth: đã attack nhưng không kill / quest không tăng → đảo counter
  if (
    smartRebirthEnabled &&
    attackCount > 0 &&
    killedCount === 0 &&
    !shouldStop?.()
  ) {
    try {
      runtime.lastQuestAt = 0;
      const q2 = await loadQuestProgress(characterId, accessToken, runtime, onLog);
      const fp2 = questProgressFingerprint(q2?.data);
      if (questFpBefore && fp2 && fp2 === questFpBefore) {
        const ch =
          runtime.currentRealm?.channelNo ??
          (Number(settings.channel || settings.from_channel) || 0);
        const ck = channelCounterKey(ch);
        if (learnedByChannel[ck] === undefined || noKillStreak >= 1) {
          saveApplyCounter(!applyCounter, ck, "quest_progress_stuck");
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Lỗi chưa phân loại (không cứng) → tự phục hồi: WAITING + softRescan, retry nhanh thay vì spin PARTIAL_ERROR.
  const status: FarmRunSummary["status"] = shouldStop?.()
    ? "WAITING"
    : recoverable
      ? "WAITING"
      : attackCount > 0
        ? (errors.length ? "PARTIAL_ERROR" : "RUNNING")
        : (errors.length ? "PARTIAL_ERROR" : "WAITING");

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    mode,
    effectiveMode,
    priority,
    neededTypes,
    bossPriorityFast,
    smartRebirthEnabled,
    channels,
    regions,
    availableBaseCodes: Array.from(runtime.availableBaseCodes),
    skippedBaseCodes: Array.from(runtime.skippedBaseCodes),
    attackCount,
    killedCount,
    killedBossCount,
    killedEliteCount,
    killedNormalCount,
    observedKilledCount,
    observedKilledBossCount,
    observedKilledEliteCount,
    observedKilledNormalCount,
    intendedObservedMismatchCount,
    mpPotionUsedCount,
    mpPotionFailedCount,
    mpPotionBoughtCount,
    mpPotionBuySpent,
    lastMpPotionResult,
    skippedLockedCount,
    scannedRealmCount,
    lastTarget,
    nextDelayMs: recoverable ? 1500 : attackCount > 0 ? nextAttackDelayMs : emptyScanDelayMs,
    softRescan: recoverable,
    persist: persistFarm,
    errors,
    questProgress: undefined,
  };
}
