"use client";

import { useState, useEffect, useRef } from "react";
import { Settings, Play, Square as SquareOutline, Plus, Trash2, Gem, Coins, Loader2, X, Crown } from "lucide-react";
import { runMazeAuto, MazeRunSummary } from "../lib/mazeEngine";
import { runDailyAuto, DailyRunSummary, runClaimExpAuto, runWorldCupCheckinAuto, runOnboardingClaimAuto, runBodyCultAuto, runAchievementClaimAuto } from "../lib/dailyEngine";
import { runWorldBossAuto, WorldBossRunSummary } from "../lib/worldBossEngine";
import { runFarmAuto, FarmRunSummary, clearFarmRuntimeLocks } from "../lib/farmEngine";
import { runMailClaimAll, MailRunSummary } from "../lib/mailEngine";
import { runGiftcodeAuto, GiftcodeRunSummary } from "../lib/giftcodeEngine";
import { runAutoBuffCheck, BuffRunSummary } from "../lib/buffEngine";
import { runAutoEquipCheck, AutoEquipRunSummary } from "../lib/autoEquipEngine";
import { runCraftAuto, listCraftRecipes, filterCraftRecipes, CraftRunSummary, getCraftTierLabel } from "../lib/craftEngine";
import { runBreakthroughAuto, BreakthroughRunSummary } from "../lib/breakthroughEngine";
import {
  AppLog,
  LogLevel,
  createLogEntry,
  normalizeLogList,
  prependLog,
  filterLogs,
  countLogsByLevel,
  exportLogsText,
  formatLogLine,
} from "../lib/logEngine";

type AccountState = "IDLE" | "LOGGING_IN" | "FETCHING_CHAR" | "FETCHING_INFO" | "ONLINE_PREP" | "ONLINE_MANUAL_FARM" | "MP_RECOVERY" | "OFFLINE_AFK" | "CRAFT_ONLY" | "DAILY_RUNNING" | "MAZE_RUNNING" | "WORLD_BOSS_RUNNING" | "TASK_RUNNING" | "WAITING_TIMER" | "PAUSED" | "ERROR" | "READY";

const stateLabels: Record<AccountState, { text: string; color: string; icon?: boolean }> = {
  IDLE: { text: "OFFLINE", color: "text-gray-500" },
  LOGGING_IN: { text: "Đang đăng nhập...", color: "text-yellow-400", icon: true },
  FETCHING_CHAR: { text: "Lấy nhân vật...", color: "text-yellow-400", icon: true },
  FETCHING_INFO: { text: "Lấy thông tin...", color: "text-yellow-400", icon: true },
  READY: { text: "Đang chờ lệnh", color: "text-green-400" },
  ONLINE_PREP: { text: "Đang chuẩn bị...", color: "text-yellow-400" },
  ONLINE_MANUAL_FARM: { text: "Đang Farm Quái", color: "text-green-400", icon: true },
  MP_RECOVERY: { text: "Hồi phục MP", color: "text-blue-400" },
  OFFLINE_AFK: { text: "Treo Offline", color: "text-purple-400" },
  CRAFT_ONLY: { text: "Đang Chế tạo", color: "text-orange-400", icon: true },
  DAILY_RUNNING: { text: "NV Hằng ngày", color: "text-teal-400", icon: true },
  MAZE_RUNNING: { text: "Chạy Mê Cung", color: "text-indigo-400", icon: true },
  WORLD_BOSS_RUNNING: { text: "Đánh World Boss", color: "text-red-500", icon: true },
  TASK_RUNNING: { text: "Đang chạy", color: "text-cyan-400", icon: true },
  WAITING_TIMER: { text: "Đang chờ timer", color: "text-purple-300" },
  PAUSED: { text: "Đang tạm dừng", color: "text-gray-400" },
  ERROR: { text: "Lỗi kết nối", color: "text-red-400" }
};

type FeatureStatus = "NOT_SELECTED" | "PENDING" | "WAITING" | "IN_PROGRESS" | "DONE";

interface FeatureConfig {
  enabled: boolean;
  status: FeatureStatus;
  settings: Record<string, any>;
}

interface WalletTokens {
  copper?: number | string;
  silver?: number | string;
  gold?: number | string;
  diamond?: number | string;
  chaos?: number | string;
  platinum?: number | string;
}

interface Account {
  id: string;
  email: string;
  password?: string;
  characterId?: string;
  characterName?: string;
  accessToken?: string;
  state: AccountState;
  level: number | string;
  rankLabel?: number | string;
  totalScore?: number | string;
  rebirthRank: number | string;
  realmCode?: string;
  realmLabel?: string;
  realmTier?: string;
  vipLevel?: number | string;
  gold: number;
  spiritStones: number;
  tokens?: WalletTokens;
  requiredToken?: string;
  sectName?: string;
  daoCoTotal?: number | string;
  dominantElement?: string;
  dominantElementScore?: number | string;
  atk?: number | string;
  def?: number | string;
  mazeLastRun?: MazeRunSummary;
  dailyLastRun?: DailyRunSummary;
  mailLastRun?: MailRunSummary;
  giftcodeLastRun?: GiftcodeRunSummary;
  worldBossLastRun?: WorldBossRunSummary;
  farmLastRun?: FarmRunSummary;
  farmSessionStats?: any;
  buffLastRun?: BuffRunSummary;
  autoEquipLastRun?: AutoEquipRunSummary;
  craftLastRun?: CraftRunSummary;
  breakthroughLastRun?: BreakthroughRunSummary;
  hp?: number | string;
  maxHp?: number | string;
  mp?: number | string;
  maxMp?: number | string;
  expCurrent?: number | string;
  expMax?: number | string;
  features: Record<string, FeatureConfig>;
  errorMessage?: string;
  activeTask?: string;
  logs?: AppLog[];
}

const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";
const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";

const realmLabelMap: Record<string, string> = {
  luyen_khi: "Luyện Khí",
  truc_co: "Trúc Cơ",
  kim_dan: "Kim Đan",
  nguyen_anh: "Nguyên Anh",
  hoa_than: "Hoá Thần",
  luyen_hu: "Luyện Hư",
  hop_the: "Hợp Thể",
  dai_thua: "Đại Thừa",
};

const pickFirst = (...values: any[]) => values.find(v => v !== undefined && v !== null && v !== "");

const formatRealmLabel = (code?: any) => {
  if (!code) return "?";
  const key = String(code);
  return realmLabelMap[key] || key;
};

const realmTierLabelMap: Record<string, string> = {
  lk: "Luyện Khí",
  tc: "Trúc Cơ",
  kd: "Kim Đan",
  na: "Nguyên Anh",
  ht: "Hoá Thần",
  lh: "Luyện Hư",
};

const normalizeRealmTierKey = (value: any): string | undefined => {
  const key = String(value || "")
    .replace(/[Đđ]/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) return undefined;
  if (key === "lk" || key.startsWith("luyen_khi") || key === "luyenkhi") return "lk";
  if (key === "tc" || key.startsWith("truc_co") || key === "trucco") return "tc";
  if (key === "kd" || key.startsWith("kim_dan") || key === "kimdan" || key.startsWith("kim_an")) return "kd";
  if (key === "na" || key.startsWith("nguyen_anh") || key === "nguyenanh") return "na";
  if (key === "ht" || key.startsWith("hoa_than") || key === "hoathan") return "ht";
  if (key === "lh" || key.startsWith("luyen_hu") || key === "luyenhu") return "lh";
  return undefined;
};

const realmTierFromLevel = (value: any): string | undefined => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n <= 10) return "lk";
  if (n <= 20) return "tc";
  if (n <= 30) return "kd";
  if (n <= 40) return "na";
  if (n <= 50) return "ht";
  return "lh";
};

const inferAccountRealmTier = (accLike: Partial<Account> & Record<string, any> = {}) => {
  return normalizeRealmTierKey(
    pickFirst(
      accLike.farm_realm_tier_override,
      accLike.manual_realm_tier,
      accLike.realmTier,
      accLike.realmCode,
      accLike.realmLabel,
      accLike.realm_name,
      accLike.realmName,
    )
  ) || realmTierFromLevel(pickFirst(accLike.realm_level, accLike.realmLevel, accLike.level)) || "tc";
};

const formatNumber = (value: any) => {
  if (value === undefined || value === null || value === "") return "?";
  if (typeof value === "number") return value.toLocaleString();
  const n = Number(value);
  return Number.isFinite(n) && String(value).trim() !== "" ? n.toLocaleString() : String(value);
};

const isPlainObject = (value: any): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

const getHomeFinalStats = (snapshot: any): Record<string, any> => {
  const candidates = [
    snapshot?.stats?.final,
    snapshot?.final,
    snapshot?.final_stats,
    snapshot?.finalStats,
    snapshot?.stats?.final_stats,
    snapshot?.stats?.finalStats,
  ];
  return (candidates.find(isPlainObject) || {}) as Record<string, any>;
};

const getHomeTalentStats = (snapshot: any): Record<string, any> => {
  const candidates = [
    snapshot?.stats?.linh_can_buff,
    snapshot?.qi_breakdown?.talent,
    snapshot?.talent,
    snapshot?.stats?.talent,
  ];
  return (candidates.find(isPlainObject) || {}) as Record<string, any>;
};

const elementNameMap: Record<string, string> = {
  wood: "Mộc",
  fire: "Hỏa",
  earth: "Thổ",
  metal: "Kim",
  water: "Thủy",
};

const elementAliases: Record<string, string[]> = {
  wood: ["wood", "moc", "mộc", "mu", "木"],
  fire: ["fire", "hoa", "hỏa", "hoả", "火"],
  earth: ["earth", "tho", "thổ", "土"],
  metal: ["metal", "kim", "金"],
  water: ["water", "thuy", "thủy", "thuỷ", "水"],
};

const normalizeLooseKey = (value: any) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9_]+/g, "_")
  .replace(/^_+|_+$/g, "");

const normalizeElementKey = (value: any): string | undefined => {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const key = normalizeLooseKey(raw);
  for (const [canonical, aliases] of Object.entries(elementAliases)) {
    if (canonical === key || aliases.some(alias => normalizeLooseKey(alias) === key)) return canonical;
  }
  return undefined;
};

const getTalentValue = (talent: any, elementKey?: string): number | null => {
  if (!talent || !elementKey) return null;
  const aliases = elementAliases[elementKey] || [elementKey];
  const candidates = [
    talent?.[elementKey],
    talent?.[`${elementKey}_value`],
    talent?.[`${elementKey}_score`],
    talent?.[`${elementKey}_talent`],
    talent?.elements?.[elementKey],
    talent?.scores?.[elementKey],
    talent?.values?.[elementKey],
  ];

  for (const alias of aliases) {
    const loose = normalizeLooseKey(alias);
    candidates.push(
      talent?.[alias],
      talent?.[loose],
      talent?.[`${loose}_value`],
      talent?.[`${loose}_score`],
      talent?.[`${loose}_talent`],
      talent?.elements?.[alias],
      talent?.elements?.[loose],
      talent?.scores?.[alias],
      talent?.scores?.[loose],
      talent?.values?.[alias],
      talent?.values?.[loose],
    );
  }

  for (const value of candidates) {
    const n = parseFiniteNumber(value);
    if (n !== null) return n;
  }

  return null;
};

const extractDominantTalent = (talent: any, fallbackElement?: any): { key?: string; label?: string; value?: number } => {
  if (!talent || typeof talent !== "object") {
    const key = normalizeElementKey(fallbackElement);
    return key ? { key, label: elementNameMap[key] || key } : {};
  }

  let key = normalizeElementKey(
    pickFirst(
      talent?.dominant_element,
      talent?.dominantElement,
      talent?.main_element,
      talent?.mainElement,
      talent?.element,
      fallbackElement,
    )
  );

  if (!key) {
    let bestKey: string | undefined;
    let bestValue: number | null = null;
    for (const candidate of Object.keys(elementNameMap)) {
      const value = getTalentValue(talent, candidate);
      if (value !== null && (bestValue === null || value > bestValue)) {
        bestKey = candidate;
        bestValue = value;
      }
    }
    key = bestKey;
  }

  const dominantFallbackValue = parseFiniteNumber(pickFirst(
    talent?.dominant_value,
    talent?.dominantValue,
    talent?.base,
    talent?.value,
    talent?.score,
  ));
  const value = getTalentValue(talent, key) ?? dominantFallbackValue;
  return key ? { key, label: elementNameMap[key] || key, value: value ?? undefined } : {};
};

const formatDominantElement = (acc: Pick<Account, "dominantElement" | "dominantElementScore">) => {
  const key = normalizeElementKey(acc.dominantElement) || String(acc.dominantElement || "");
  if (!key) return "?";
  const label = elementNameMap[key] || String(acc.dominantElement || key);
  const score = acc.dominantElementScore;
  return score !== undefined && score !== null && score !== "" ? `${label} ${formatNumber(score)}` : label;
};

const pickCombatStat = (source: any, stat: "atk" | "def"): any => {
  if (!source || typeof source !== "object") return undefined;
  if (stat === "atk") {
    return pickFirst(
      source?.atk,
      source?.attack,
      source?.attack_power,
      source?.attackPower,
      source?.total_atk,
      source?.totalAtk,
      source?.final_atk,
      source?.finalAtk,
      source?.battle_atk,
      source?.battleAtk,
      source?.stats?.atk,
      source?.stats?.attack,
      source?.stats?.attack_power,
      source?.combat?.atk,
      source?.combat?.attack,
      source?.combat_stats?.atk,
      source?.combatStats?.atk,
      source?.attributes?.atk,
      source?.attributes?.attack,
    );
  }
  return pickFirst(
    source?.def,
    source?.defense,
    source?.defence,
    source?.defense_power,
    source?.defensePower,
    source?.total_def,
    source?.totalDef,
    source?.final_def,
    source?.finalDef,
    source?.battle_def,
    source?.battleDef,
    source?.stats?.def,
    source?.stats?.defense,
    source?.stats?.defence,
    source?.combat?.def,
    source?.combat?.defense,
    source?.combat_stats?.def,
    source?.combatStats?.def,
    source?.attributes?.def,
    source?.attributes?.defense,
  );
};

const extractCombatStats = (snapshot: any, character: any = {}, fallback: { atk?: any; def?: any } = {}) => {
  const finalStats = getHomeFinalStats(snapshot);
  const atk = pickFirst(
    finalStats?.atk,
    finalStats?.attack,
    finalStats?.attack_power,
    pickCombatStat(finalStats, "atk"),
    pickCombatStat(character, "atk"),
    pickCombatStat(snapshot?.character, "atk"),
    pickCombatStat(snapshot?.character_info, "atk"),
    pickCombatStat(snapshot?.profile, "atk"),
    fallback.atk,
  );
  const def = pickFirst(
    finalStats?.def,
    finalStats?.defense,
    finalStats?.defence,
    finalStats?.defense_power,
    pickCombatStat(finalStats, "def"),
    pickCombatStat(character, "def"),
    pickCombatStat(snapshot?.character, "def"),
    pickCombatStat(snapshot?.character_info, "def"),
    pickCombatStat(snapshot?.profile, "def"),
    fallback.def,
  );
  return { atk, def };
};

const findNumberDeep = (obj: any, includes: string[], excludes: string[] = []): number | null => {
  const seen = new Set<any>();

  const walk = (value: any): number | null => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);

    for (const [key, raw] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      const matched = includes.some(part => lowerKey.includes(part));
      const blocked = excludes.some(part => lowerKey.includes(part));
      if (matched && !blocked) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }

      if (raw && typeof raw === "object") {
        const nested = walk(raw);
        if (nested !== null) return nested;
      }
    }

    return null;
  };

  return walk(obj);
};

const normalizeExpKey = (value: any) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const parseFiniteNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;

  const raw = String(value).trim();
  if (!raw) return null;

  let direct = Number(raw);
  if (Number.isFinite(direct)) return direct;

  // EXP thường là số nguyên, nhưng API/UI có thể trả "1,234", "1.234" hoặc "1 234".
  const compact = raw.replace(/\s+/g, "");
  const commaClean = compact.replace(/,/g, "");
  direct = Number(commaClean);
  if (Number.isFinite(direct)) return direct;

  const dotClean = compact.replace(/\./g, "").replace(/,/g, ".");
  direct = Number(dotClean);
  if (Number.isFinite(direct)) return direct;

  const digitsOnly = compact.replace(/[^0-9.-]/g, "");
  if (!digitsOnly || digitsOnly === "-" || digitsOnly === ".") return null;
  direct = Number(digitsOnly);
  return Number.isFinite(direct) ? direct : null;
};

const toFiniteNumber = parseFiniteNumber;

const parseProgressPair = (value: any): { current: number; max: number } | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/([0-9][0-9,\.\s]*)\s*\/\s*([0-9][0-9,\.\s]*)/);
  if (!match) return null;
  const current = parseFiniteNumber(match[1]);
  const max = parseFiniteNumber(match[2]);
  if (current === null || max === null || max <= 0) return null;
  return { current, max };
};

type ExpCandidate = {
  key: string;
  path: string;
  parentPath: string;
  value: number;
  currentScore: number;
  maxScore: number;
};

const keyHasAny = (key: string, words: string[]) => words.some(word => key === word || key.includes(word));

const collectExpCandidates = (snapshot: any, limit = 80): ExpCandidate[] => {
  const seen = new Set<any>();
  const candidates: ExpCandidate[] = [];

  const explicitCurrentKeys = [
    "current_exp", "exp_current", "exp_now", "now_exp", "cur_exp", "exp_cur", "currentexp", "expcurrent",
    "cultivation_exp", "tu_vi_exp", "tuvi_exp", "xp_current", "current_xp", "experience_current",
  ];
  const explicitMaxKeys = [
    "max_exp", "exp_max", "maxexp", "expmax", "required_exp", "exp_required", "need_exp", "exp_need",
    "next_exp", "exp_next", "next_level_exp", "levelup_exp", "cap_exp", "exp_cap", "target_exp", "exp_target",
    "required_xp", "xp_required", "next_xp", "xp_next", "experience_required", "experience_max",
  ];
  const expContextWords = ["exp", "xp", "experience", "cultivation", "tu_vi", "tuvi", "tu_luyen", "level_progress", "progress"];
  const currentWords = ["current", "now", "cur", "value", "amount", "progress", "used", "have", "owned"];
  const maxWords = ["max", "required", "require", "need", "next", "cap", "target", "limit", "total"];
  const blockCurrentWords = ["max", "required", "require", "need", "next", "cap", "target", "limit"];
  const blockMaxWords = ["current", "now", "cur", "used", "have", "owned"];

  const scoreCandidate = (key: string, pathParts: string[], type: "current" | "max") => {
    const path = pathParts.join("_");
    const full = `${path}_${key}`;
    const hasContext = expContextWords.some(word => key.includes(word) || path.includes(word) || full.includes(word));
    let score = hasContext ? 2 : 0;

    if (type === "current") {
      if (explicitCurrentKeys.some(k => key === k || full.includes(k))) score += 10;
      if ((key === "exp" || key === "xp" || key === "experience") && !blockCurrentWords.some(w => full.includes(w))) score += 8;
      if (hasContext && currentWords.some(w => key === w || key.includes(w))) score += 6;
      if (blockCurrentWords.some(w => key.includes(w))) score -= 8;
    } else {
      if (explicitMaxKeys.some(k => key === k || full.includes(k))) score += 10;
      if (hasContext && maxWords.some(w => key === w || key.includes(w))) score += 7;
      if (blockMaxWords.some(w => key.includes(w))) score -= 8;
    }

    return Math.max(0, score);
  };

  const walk = (value: any, pathParts: string[] = []) => {
    if (value === undefined || value === null || seen.has(value) || candidates.length >= limit) return;

    if (typeof value !== "object") return;
    seen.add(value);

    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = normalizeExpKey(rawKey);
      const nextPath = [...pathParts, key];
      const path = nextPath.join(".");
      const parentPath = pathParts.join(".");

      const pair = parseProgressPair(rawValue);
      const pathContext = nextPath.join("_");
      if (pair && keyHasAny(pathContext, ["exp", "xp", "experience", "cultivation", "tu_vi", "tuvi", "progress"])) {
        candidates.push({ key: `${key}_current_from_pair`, path, parentPath, value: pair.current, currentScore: 25, maxScore: 0 });
        candidates.push({ key: `${key}_max_from_pair`, path, parentPath, value: pair.max, currentScore: 0, maxScore: 25 });
      }

      const numeric = parseFiniteNumber(rawValue);
      if (numeric !== null) {
        const currentScore = scoreCandidate(key, pathParts, "current");
        const maxScore = scoreCandidate(key, pathParts, "max");
        if (currentScore > 0 || maxScore > 0) {
          candidates.push({ key, path, parentPath, value: numeric, currentScore, maxScore });
        }
      }

      if (rawValue && typeof rawValue === "object") walk(rawValue, nextPath);
    }
  };

  walk(snapshot);
  return candidates.sort((a, b) => Math.max(b.currentScore, b.maxScore) - Math.max(a.currentScore, a.maxScore));
};

const getExpDebugCandidates = (snapshot: any) => collectExpCandidates(snapshot, 30).map(item => ({
  path: item.path,
  value: item.value,
  currentScore: item.currentScore,
  maxScore: item.maxScore,
}));

const extractExpPair = (snapshot: any): { current: number | null; max: number | null; percent?: number | null } => {
  if (!snapshot) return { current: null, max: null, percent: null };

  const directPair = parseProgressPair(snapshot);
  if (directPair) return { ...directPair, percent: Math.round((directPair.current / directPair.max) * 100) };

  const candidates = collectExpCandidates(snapshot, 120);
  const currentCandidates = candidates.filter(item => item.currentScore > 0);
  const maxCandidates = candidates.filter(item => item.maxScore > 0 && item.value > 0);

  let best: { current: number; max: number; score: number } | null = null;

  for (const current of currentCandidates) {
    for (const max of maxCandidates) {
      if (current.path === max.path && !current.key.includes("from_pair")) continue;
      if (max.value <= 0) continue;
      if (current.value < 0) continue;

      const currentParent = current.parentPath;
      const maxParent = max.parentPath;
      const sameParent = currentParent && currentParent === maxParent;
      const samePathPair = current.path === max.path && current.key.includes("from_pair") && max.key.includes("from_pair");
      const prefixBonus = currentParent && maxParent && (currentParent.startsWith(maxParent) || maxParent.startsWith(currentParent)) ? 3 : 0;
      const rangeBonus = current.value <= max.value ? 5 : -7;
      const score = current.currentScore + max.maxScore + (sameParent ? 8 : 0) + (samePathPair ? 12 : 0) + prefixBonus + rangeBonus;

      if (!best || score > best.score) best = { current: current.value, max: max.value, score };
    }
  }

  if (best && best.max > 0) {
    return {
      current: best.current,
      max: best.max,
      percent: Math.min(100, Math.max(0, Math.round((best.current / best.max) * 100))),
    };
  }

  const percentCandidate = candidates.find(item => item.key.includes("percent") || item.key.includes("pct"));
  return {
    current: null,
    max: null,
    percent: percentCandidate ? Math.min(100, Math.max(0, percentCandidate.value)) : null,
  };
};

export default function AutoGameDashboard() {
  const [activeTab, setActiveTab] = useState("DIEU_KHIEN");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [tempSettings, setTempSettings] = useState<Record<string, any>>({});
  const [viewingAccountId, setViewingAccountId] = useState<string | null>(null);
  const [checkedAccountIds, setCheckedAccountIds] = useState<Set<string>>(new Set());
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addInput, setAddInput] = useState("");

  const [logScope, setLogScope] = useState<"selected" | "all">("selected");
  const [logFilterLevel, setLogFilterLevel] = useState<"ALL" | LogLevel>("ALL");
  const [logFilterModule, setLogFilterModule] = useState("ALL");
  const [logSearch, setLogSearch] = useState("");

  const tabs = [
    { id: "DIEU_KHIEN", label: "ĐIỀU KHIỂN" },
    { id: "TIEN_ICH", label: "TIỆN ÍCH" },
    { id: "THONG_TIN", label: "THÔNG TIN" },
  ];

  const featuresDef: Record<string, { id: string; label: string }[]> = {
    DIEU_KHIEN: [
      { id: "pho_ban", label: "Đi phó bản" },
      { id: "farm", label: "Farm quái" },
      { id: "claim_exp", label: "Claim EXP" },
      { id: "world_cup_checkin", label: "World Cup Checkin" },
      { id: "onboarding_claim", label: "Quà tân thủ" },
      { id: "body_cult", label: "Thể tu" },
      { id: "achievement", label: "Thành tựu" },
      { id: "world_boss", label: "Boss Thế Giới" },
      { id: "ki_ngo", label: "Kì ngộ" },
      { id: "me_cung", label: "Chạy Mê Cung" },
      { id: "arena", label: "Đấu trường (PvP)" },
      { id: "pet", label: "Linh thú" },
    ],
    TIEN_ICH: [
      { id: "buff", label: "Tự động Buff" },
      { id: "auto_equip", label: "Tự động mặc đồ" },
      { id: "craft", label: "Chế tạo đồ" },
      { id: "shop", label: "Mua đồ tự động" },
      { id: "origin", label: "Tẩy tuỷ" },
      { id: "breakthrough", label: "Đột phá / Trùng sinh" },
      { id: "mail_giftcode", label: "Mail / Giftcode" },
      { id: "offline_afk", label: "Treo máy Offline (AFK)" },
    ],
    THONG_TIN: [
      { id: "log", label: "Log hoạt động" },
      { id: "stats", label: "Thống kê tài nguyên" },
    ],
  };

  const defaultFeaturesState: Record<string, FeatureConfig> = {
    farm: { enabled: false, status: "NOT_SELECTED", settings: { mode: "boss", farm_realm_tier_override: "auto", realm_code_prefix: "", from_channel: 3, to_channel: 6, priority: "boss_elite", boss_priority_mode: true, boss_priority_fast: true, smart_rebirth_farm: true, strict_boss_mode: false, farm_boss_only: false, attack_delay_ms: 5000, empty_scan_delay_ms: 1000, skill_slot: 0, snapshot_limit_players: 200, farm_log_mode: "summary", summary_log_interval_seconds: 3600, max_available_base_codes: 2, available_base_codes: [], unavailable_base_codes: [], available_base_codes_by_tier: {}, unavailable_base_codes_by_tier: {}, farm_cache_tier: "", auto_use_mp_potion: true, mp_potion_item_code: "pill_lk_mp", auto_buy_mp_potion: false, mp_potion_shop_code: "alchemy", mp_potion_buy_qty: 10, smart_stop_when_quest_done: false, mob_cache_max_age_ms: 3000, mob_reservation_ttl_ms: 7000, no_mob_before_rotate: 1, max_hits_same_mob_before_refresh: 60 } },
    daily: { enabled: false, status: "NOT_SELECTED", settings: {} },
    claim_exp: { enabled: false, status: "NOT_SELECTED", settings: { interval_minutes: 15 } },
    world_cup_checkin: { enabled: false, status: "NOT_SELECTED", settings: { reset_at_vn_midnight: true } },
    onboarding_claim: { enabled: false, status: "NOT_SELECTED", settings: {} },
    body_cult: { enabled: false, status: "NOT_SELECTED", settings: { auto_start: true, body_cult_element: "metal", body_cult_session_type: "long", next_harvest_at: null, remaining_seconds: null } },
    achievement: { enabled: false, status: "NOT_SELECTED", settings: { interval_minutes: 60 } },
    world_boss: { enabled: false, status: "NOT_SELECTED", settings: { tiers: "lk,tc,kd", check_interval_minutes: 10, max_attacks_per_check: 30, attack_delay_ms: 1500, auto_claim: true } },
    ki_ngo: { enabled: false, status: "NOT_SELECTED", settings: {} },
    me_cung: { enabled: false, status: "NOT_SELECTED", settings: { tier: 1, run_count: 3, auto_boss: true, auto_claim_final: true, skip_monster: true, skip_trap: true, skip_fire: true, skip_merchant: true, boss_hp_reserve: 5, max_passes: 5 } },
    buff: { enabled: false, status: "NOT_SELECTED", settings: { interval_seconds: 300, enable_formation_buff: true, formation_item_code: "formation_lk_dragon", enable_talisman_buff: true, talisman_item_code: "talisman_lk_crit" } },
    auto_equip: { enabled: false, status: "NOT_SELECTED", settings: { interval_seconds: 300, weight_preset: "highest_stats", min_score_gain: 0, dry_run: false, auto_equip: true, allow_zero_score: true, slot_filter: "", inventory_rpc: "rpc_get_equipment\nrpc_list_inventory", equipment_rpc: "rpc_get_equipment", equip_rpc: "" } },
    craft: { enabled: false, status: "NOT_SELECTED", settings: { mode: "manual", category: "alchemy", tier: "lk", recipe_code: "", times_per_run: 1, interval_seconds: 20, pause_on_fail_minutes: 30, auto_open_containers: true, auto_use_recovery_items: true, stamina_item_code: "", spirit_item_code: "", max_recovery_uses: 8, recipe_search: "", recipe_cache: [], recipe_cache_at: null } },
    shop: { enabled: false, status: "NOT_SELECTED", settings: {} },
    origin: { enabled: false, status: "NOT_SELECTED", settings: { target: "auto" } },
    breakthrough: { enabled: false, status: "NOT_SELECTED", settings: { interval_seconds: 60, full_exp_threshold_percent: 99.99, pill_item_codes: "pill_lk_minor\npill_lk_major", auto_buy_pill: true, shop_code: "alchemy", buy_qty: 1, pause_on_fail_minutes: 30, retry_delay_ms: 700 } },
    mail_giftcode: { enabled: false, status: "NOT_SELECTED", settings: { claim_mail: true, giftcode_enabled: false, mode: "until_success_count", success_target: 1, giftcodes: "" } },
    offline_afk: { enabled: false, status: "NOT_SELECTED", settings: {} },
  };

  const [isClient, setIsClient] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const protectedResourceFields = new Set([
    "gold",
    "spiritStones",
    "tokens",
    "totalScore",
    "rebirthRank",
    "rankLabel",
    "realmCode",
    "realmLabel",
    "requiredToken",
    "sectName",
    "daoCoTotal",
    "dominantElement",
    "dominantElementScore",
    "atk",
    "def",
  ]);

  const stripProtectedResourceUpdates = (updates: Record<string, any>) => {
    const { __resourceAuthoritative, __accountStateAuthoritative, ...rest } = updates;
    if (__resourceAuthoritative === true) return rest;

    const clean: Record<string, any> = { ...rest };
    for (const key of protectedResourceFields) {
      if (key in clean) delete clean[key];
    }
    return clean;
  };

  const isNoisyFeatureStateUpdate = (updates: Record<string, any>) => {
    const noisyStates = new Set<AccountState>([
      "ONLINE_PREP",
      "ONLINE_MANUAL_FARM",
      "MP_RECOVERY",
      "OFFLINE_AFK",
      "CRAFT_ONLY",
      "DAILY_RUNNING",
      "MAZE_RUNNING",
      "WORLD_BOSS_RUNNING",
      "TASK_RUNNING",
      "WAITING_TIMER",
    ]);
    return Boolean(updates.state && noisyStates.has(updates.state));
  };

  const updateAccount = (id: string, updates: Partial<Account> & Record<string, any>) => {
    setAccounts(prev => prev.map(a => {
      if (a.id !== id) return a;
      const runtime = runtimeState.current[id];
      const rawUpdates = updates as Record<string, any>;
      const protectedSafeUpdates = stripProtectedResourceUpdates(rawUpdates);

      // Khi đang chạy nhiều feature song song, state tổng của account được tính từ feature.status,
      // không để từng module ghi đè activeTask qua lại làm UI nhảy liên tục.
      if (runtime?.featureRunnerMode && rawUpdates.__accountStateAuthoritative !== true && isNoisyFeatureStateUpdate(protectedSafeUpdates)) {
        delete (protectedSafeUpdates as any).state;
        delete (protectedSafeUpdates as any).activeTask;
      }

      // Nếu user đã bấm Dừng, chặn các promise/timer cũ ghi ngược state đang chạy lên UI.
      if (runtime?.stopped && protectedSafeUpdates.state && !["IDLE", "PAUSED", "READY"].includes(protectedSafeUpdates.state)) {
        const { state, activeTask, errorMessage, ...safeUpdates } = protectedSafeUpdates as any;
        return { ...a, ...safeUpdates };
      }
      return { ...a, ...protectedSafeUpdates };
    }));
  };

  const addAccountLog = (id: string, module: string, level: LogLevel, message: string, meta?: Record<string, any>) => {
    setAccounts(prev => prev.map(acc => {
      if (acc.id !== id) return acc;
      const accountLabel = acc.characterName || acc.email.split("@")[0];
      const log = createLogEntry({
        accountId: id,
        accountLabel,
        module,
        level,
        message,
        meta,
      });
      return { ...acc, logs: prependLog(acc.logs, log, 300) };
    }));
  };

  useEffect(() => {
    setIsClient(true);
    const saved = localStorage.getItem("samsara_accounts_v2");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setAccounts(Array.isArray(parsed) ? parsed.map((acc: Account) => ({
          ...acc,
          logs: normalizeLogList(acc.logs),
        })) : []);
      } catch (e) {
        console.error("Lỗi đọc dữ liệu tài khoản:", e);
      }
    } else {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    if (isClient) {
      localStorage.setItem("samsara_accounts_v2", JSON.stringify(accounts));
    }
  }, [accounts, isClient]);

  const accountsRef = useRef(accounts);
  const runtimeState = useRef<Record<string, any>>({});
  const farmMobLocksRef = useRef<Record<string, { accountId: string; expiresAt: number; mobInfo?: Record<string, any> }>>({});
  const RESOURCE_REFRESH_DEBOUNCE_MS = 1200;
  const featureLabelMap: Record<string, string> = {
    farm: "Farm",
    claim_exp: "Claim EXP",
    world_cup_checkin: "World Cup",
    onboarding_claim: "Tân thủ",
    body_cult: "Thể tu",
    achievement: "Thành tựu",
    world_boss: "Boss",
    ki_ngo: "Kì ngộ",
    me_cung: "Mê cung",
    buff: "Buff",
    auto_equip: "Mặc đồ",
    mail_giftcode: "Mail/Giftcode",
    craft: "Craft",
    shop: "Shop",
    origin: "Tẩy tuỷ",
    breakthrough: "Đột phá",
    offline_afk: "Offline AFK",
  };
  const farmRegionRoots = [
    { root: "bf_tay_bac", label: "Tây Bắc" },
    { root: "bf_dong_bac", label: "Đông Bắc" },
    { root: "bf_tay_nam", label: "Tây Nam" },
    { root: "bf_dong_nam", label: "Đông Nam" },
  ];
  const farmTierSuffix: Record<string, string> = { lk: "", tc: "_tc", kd: "_kd", na: "_na", ht: "_ht", lh: "_lh" };
  const makeFarmBaseRegions = (tier: string) => {
    const suffix = farmTierSuffix[tier] ?? `_${tier}`;
    const tierLabel = realmTierLabelMap[tier] || tier.toUpperCase();
    return farmRegionRoots.map(region => ({ baseCode: `${region.root}${suffix}`, label: `${region.label} ${tierLabel}` }));
  };
  const farmBaseRegionsByTier: Record<string, { baseCode: string; label: string }[]> = {
    lk: makeFarmBaseRegions("lk"),
    tc: makeFarmBaseRegions("tc"),
    kd: makeFarmBaseRegions("kd"),
    na: makeFarmBaseRegions("na"),
    ht: makeFarmBaseRegions("ht"),
    lh: makeFarmBaseRegions("lh"),
  };
  const farmBaseRegions = farmBaseRegionsByTier.tc;
  const getFarmBaseRegionsForTier = (tier?: any) => farmBaseRegionsByTier[normalizeRealmTierKey(tier) || "tc"] || farmBaseRegionsByTier.tc;
  const normalizeFarmBaseCodes = (value: any, tier?: any) => {
    const valid = new Set(getFarmBaseRegionsForTier(tier).map(region => region.baseCode));
    const raw = Array.isArray(value) ? value : String(value || "").split(/[,;\s]+/).filter(Boolean);
    const out: string[] = [];
    for (const item of raw) {
      const code = String(item || "").trim();
      if (valid.has(code) && !out.includes(code)) out.push(code);
    }
    return out;
  };
  const getTieredFarmCodes = (settings: Record<string, any>, key: "available_base_codes" | "unavailable_base_codes", tier: string) => {
    const byTierKey = key === "available_base_codes" ? "available_base_codes_by_tier" : "unavailable_base_codes_by_tier";
    const byTier = settings?.[byTierKey] || {};
    const direct = Array.isArray(byTier?.[tier]) ? byTier[tier] : [];
    if (direct.length) return normalizeFarmBaseCodes(direct, tier);
    // Chỉ dùng cache phẳng nếu cache đó được ghi rõ cùng tier. Nếu không, reset để tránh LK dùng nhầm vùng TC.
    if (settings?.farm_cache_tier && normalizeRealmTierKey(settings.farm_cache_tier) === tier) {
      return normalizeFarmBaseCodes(settings?.[key] || settings?.[`farm_${key}`], tier);
    }
    return [];
  };

  const isFarmBossPriorityMode = (settings: Record<string, any> = {}) => {
    const raw = String(pickFirst(
      settings.mode,
      settings.farm_mode,
      settings.target_mode,
      settings.mob_mode,
      settings.mode_label,
      settings.farm_mode_label,
    ) || "");
    const key = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (["boss", "boss_only", "only_boss", "chi_boss", "farm_boss", "boss_farm", "boss_strict", "strict_boss", "boss_multi", "boss_multichannel", "boss_multi_channel", "chi_boss_da_kenh"].includes(key)) return true;
    // Chấp nhận cả setting cũ strict_boss_mode/farm_boss_only để tự chuyển sang Boss Priority mới,
    // nhưng khi gửi xuống engine sẽ ép strict=false để không bị kẹt chỉ boss.
    if (settings.strict_boss_mode === true || settings.farm_boss_only === true || settings.boss_only === true || settings.only_boss === true || settings.boss_priority_mode === true) return true;
    return key.includes("boss") || key.includes("thu_linh") || key.includes("thulinh");
  };
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);

  const ensureRuntimeState = (accountId: string) => {
    if (!runtimeState.current[accountId]) runtimeState.current[accountId] = {};
    if (!runtimeState.current[accountId].timers) runtimeState.current[accountId].timers = {};
    if (!runtimeState.current[accountId].cancelledFeatures) runtimeState.current[accountId].cancelledFeatures = {};
    return runtimeState.current[accountId];
  };

  const beginAccountRunToken = (accountId: string) => {
    const runtime = ensureRuntimeState(accountId);
    runtime.stopped = false;
    runtime.featureRunnerMode = true;
    runtime.runToken = Number(runtime.runToken || 0) + 1;
    runtime.cancelledFeatures = {};
    return runtime.runToken as number;
  };

  const stopAccountRuntime = (accountId: string) => {
    const runtime = ensureRuntimeState(accountId);
    runtime.stopped = true;
    runtime.featureRunnerMode = false;
    runtime.runToken = Number(runtime.runToken || 0) + 1;
    runtime.cancelledFeatures = Object.fromEntries(Object.keys(defaultFeaturesState).map(key => [key, true]));
    if (runtime.resourceRefreshQueue?.timer) clearTimeout(runtime.resourceRefreshQueue.timer);
    if (runtime.resourceRefreshQueue?.resolvers) runtime.resourceRefreshQueue.resolvers.forEach((resolve: any) => resolve(false));
    runtime.resourceRefreshQueue = undefined;
    clearAccountTimers(accountId);
    releaseFarmLocksForAccount(accountId);
    clearFarmRuntimeLocks(accountId);
  };

  const cancelFeatureRuntime = (accountId: string, featureId: string) => {
    const runtime = ensureRuntimeState(accountId);
    runtime.cancelledFeatures[featureId] = true;
    clearFeatureTimer(accountId, featureId);
    if (featureId === "farm") {
      releaseFarmLocksForAccount(accountId);
      clearFarmRuntimeLocks(accountId);
    }
  };

  const isFeatureStillAllowed = (accountId: string, featureId: string, runToken?: number) => {
    const runtime = runtimeState.current[accountId];
    if (runtime?.stopped) return false;
    if (runToken !== undefined && Number(runtime?.runToken || 0) !== Number(runToken)) return false;
    if (runtime?.cancelledFeatures?.[featureId]) return false;
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return false;
    if (acc.features?.[featureId]?.settings?.disabled_override === true) return false;
    return Boolean(acc.features?.[featureId]?.enabled || globalFeatureToggles?.[featureId]);
  };

  const releaseFarmLocksForAccount = (accountId: string) => {
    const locks = farmMobLocksRef.current;
    for (const [key, lock] of Object.entries(locks) as [string, { accountId: string; expiresAt: number; mobInfo?: Record<string, any> }][]) {
      if (lock?.accountId === accountId) delete locks[key];
    }
  };

  const claimFarmMobLock = (accountId: string, lockKey: string, mobInfo: Record<string, any>, ttlMs = 20_000) => {
    const now = Date.now();
    const locks = farmMobLocksRef.current;

    for (const [key, lock] of Object.entries(locks) as [string, { accountId: string; expiresAt: number; mobInfo?: Record<string, any> }][]) {
      if (!lock || lock.expiresAt <= now) delete locks[key];
    }

    const current = locks[lockKey];
    if (current && current.accountId !== accountId && current.expiresAt > now) return false;

    locks[lockKey] = {
      accountId,
      expiresAt: now + Math.max(5_000, ttlMs),
      mobInfo: { ...mobInfo, lockedAt: new Date(now).toISOString() },
    };
    return true;
  };

  const updateFarmRegionCache = (accountId: string, baseCode: string, isAvailable: boolean, meta?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    const tier = inferAccountRealmTier(acc || {});
    const tierRegions = getFarmBaseRegionsForTier(tier);
    if (!tierRegions.some(region => region.baseCode === baseCode)) return;

    const runtime = ensureRuntimeState(accountId);
    if (!acc || acc.features?.farm?.settings?.disabled_override === true || runtime.cancelledFeatures?.farm || runtime.stopped) return;
    const currentSettings = acc?.features?.farm?.settings || {};

    if (!runtime.farmAvailableBaseCodesByTier) runtime.farmAvailableBaseCodesByTier = {};
    if (!runtime.farmUnavailableBaseCodesByTier) runtime.farmUnavailableBaseCodesByTier = {};

    const available = new Set<string>([
      ...getTieredFarmCodes(currentSettings, "available_base_codes", tier),
      ...normalizeFarmBaseCodes(runtime.farmAvailableBaseCodesByTier?.[tier], tier),
      ...normalizeFarmBaseCodes(runtime.farmAvailableBaseCodes, tier),
    ]);
    const unavailable = new Set<string>([
      ...getTieredFarmCodes(currentSettings, "unavailable_base_codes", tier),
      ...normalizeFarmBaseCodes(runtime.farmUnavailableBaseCodesByTier?.[tier], tier),
      ...normalizeFarmBaseCodes(runtime.farmUnavailableBaseCodes, tier),
    ]);

    const beforeAvailable = Array.from(available).sort().join(",");
    const beforeUnavailable = Array.from(unavailable).sort().join(",");

    if (isAvailable) {
      available.add(baseCode);
      unavailable.delete(baseCode);
      // Mỗi account thường chỉ có 2 vùng cố định trong cùng một cảnh giới.
      // Cache theo tier để LK không dùng nhầm vùng TC sau khi account đổi cảnh giới.
      if (available.size >= 2) {
        for (const region of tierRegions) {
          if (!available.has(region.baseCode)) unavailable.add(region.baseCode);
        }
      }
    } else if (!available.has(baseCode)) {
      unavailable.add(baseCode);
    }

    runtime.farmAvailableBaseCodesByTier[tier] = Array.from(available);
    runtime.farmUnavailableBaseCodesByTier[tier] = Array.from(unavailable);
    runtime.farmAvailableBaseCodes = Array.from(available);
    runtime.farmUnavailableBaseCodes = Array.from(unavailable);
    runtime.farmCacheTier = tier;

    const afterAvailable = Array.from(available).sort().join(",");
    const afterUnavailable = Array.from(unavailable).sort().join(",");
    if (beforeAvailable === afterAvailable && beforeUnavailable === afterUnavailable) return;

    setAccounts(prev => prev.map(item => {
      if (item.id !== accountId) return item;
      const farmFeature = item.features?.farm || defaultFeaturesState.farm;
      const oldSettings = farmFeature.settings || {};
      const availableByTier = { ...(oldSettings.available_base_codes_by_tier || {}), [tier]: Array.from(available) };
      const unavailableByTier = { ...(oldSettings.unavailable_base_codes_by_tier || {}), [tier]: Array.from(unavailable) };
      return {
        ...item,
        features: {
          ...item.features,
          farm: {
            ...farmFeature,
            settings: {
              ...oldSettings,
              available_base_codes: Array.from(available),
              unavailable_base_codes: Array.from(unavailable),
              available_base_codes_by_tier: availableByTier,
              unavailable_base_codes_by_tier: unavailableByTier,
              farm_cache_tier: tier,
              max_available_base_codes: 2,
              skill_slot: 0,
              attack_delay_ms: 5000,
            },
          },
        },
      };
    }));

    const label = tierRegions.find(region => region.baseCode === baseCode)?.label || baseCode;
    const tierLabel = realmTierLabelMap[tier] || tier.toUpperCase();
    if (isAvailable) {
      addAccountLog(accountId, "FARM", "INFO", `Đã lưu vùng farm hợp lệ (${tierLabel}): ${label}.`, { tier, available: Array.from(available), unavailable: Array.from(unavailable), ...meta });
    } else {
      addAccountLog(accountId, "FARM", "INFO", `Đã skip vùng không thuộc account (${tierLabel}): ${label}.`, { tier, available: Array.from(available), unavailable: Array.from(unavailable), ...meta });
    }
  };

  const clearFeatureTimer = (accountId: string, featureId: string) => {
    const runtime = runtimeState.current[accountId];
    const timer = runtime?.timers?.[featureId];
    if (timer) clearTimeout(timer);
    if (runtime?.timers) delete runtime.timers[featureId];
  };

  const clearAccountTimers = (accountId: string) => {
    const runtime = runtimeState.current[accountId];
    if (!runtime?.timers) return;
    Object.values(runtime.timers).forEach((timer: any) => clearTimeout(timer));
    runtime.timers = {};
  };

  const setFeatureTimer = (accountId: string, featureId: string, ms: number, callback: () => void) => {
    const runtime = ensureRuntimeState(accountId);
    if (runtime.stopped || runtime.cancelledFeatures?.[featureId]) return;
    const scheduledRunToken = Number(runtime.runToken || 0);
    clearFeatureTimer(accountId, featureId);
    runtime.timers[featureId] = setTimeout(() => {
      if (!isFeatureStillAllowed(accountId, featureId, scheduledRunToken)) {
        clearFeatureTimer(accountId, featureId);
        return;
      }
      callback();
    }, ms);
  };

  const msUntilNextVietnamHour = (hour = 0) => {
    const now = new Date();
    const vnOffset = 7 * 60 * 60 * 1000;
    const vnNow = new Date(now.getTime() + vnOffset);
    let nextUtcMs = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), hour, 0, 0) - vnOffset;
    if (nextUtcMs <= now.getTime()) {
      nextUtcMs = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate() + 1, hour, 0, 0) - vnOffset;
    }
    return Math.max(60_000, nextUtcMs - now.getTime());
  };

  const msUntilNextVietnamMidnight = () => msUntilNextVietnamHour(0);
  const msUntilNextVietnamNoon = () => msUntilNextVietnamHour(12);

  const formatWaitMinutes = (ms: number) => {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    if (minutes < 60) return `${minutes} phút`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
  };

  const [globalFeatureToggles, setGlobalFeatureToggles] = useState<Record<string, boolean>>({});

  const toggleAccountCheck = (id: string) => {
    const newSet = new Set(checkedAccountIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setCheckedAccountIds(newSet);
  };

  const toggleAllAccounts = () => {
    if (checkedAccountIds.size === accounts.length) {
      setCheckedAccountIds(new Set());
    } else {
      setCheckedAccountIds(new Set(accounts.map(a => a.id)));
    }
  };

  const getCharacterName = (accOrEmail: Account | string) => {
    if (typeof accOrEmail === "string") return accOrEmail.split('@')[0];
    return accOrEmail.characterName || accOrEmail.email.split('@')[0];
  };

  const viewingAccount = accounts.find(a => a.id === viewingAccountId);
  const checkedAccountKey = Array.from(checkedAccountIds).sort().join("|");

  const getBatchTargetIds = () => {
    if (checkedAccountIds.size > 0) return Array.from(checkedAccountIds);
    if (viewingAccountId) return [viewingAccountId];
    return [];
  };

  const getBatchTargetAccounts = () => {
    const ids = new Set(getBatchTargetIds());
    return accounts.filter(acc => ids.has(acc.id));
  };

  const sanitizeSettingsForFeatureSave = (featureId: string, incoming: Record<string, any>, current: Record<string, any> = {}) => {
    const next = { ...(incoming || {}) };

    // Các field dưới đây là cache/trạng thái riêng từng account, không được copy hàng loạt
    // vì sẽ làm account A nhận cache vùng/timer/progress của account B.
    const accountScopedKeysByFeature: Record<string, string[]> = {
      farm: [
        "available_base_codes",
        "unavailable_base_codes",
        "farm_available_base_codes",
        "farm_unavailable_base_codes",
        "available_base_codes_by_tier",
        "unavailable_base_codes_by_tier",
        "farm_cache_tier",
        "learned_base_codes_at",
        "last_region_scan_at",
      ],
      body_cult: [
        "next_harvest_at",
        "remaining_seconds",
        "last_mode",
        "training_session_id",
      ],
      ki_ngo: [
        "daily_count",
        "daily_limit",
        "success_count",
        "fail_count",
        "completed_today",
        "next_reset_at",
        "next_run_at",
        "last_run_at",
      ],
      claim_exp: ["last_claim_at", "next_claim_at"],
    };

    for (const key of accountScopedKeysByFeature[featureId] || []) {
      if (current && Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
      else delete next[key];
    }

    // disabled_override là trạng thái tick/tắt thủ công, không phải setting form.
    if (current && Object.prototype.hasOwnProperty.call(current, "disabled_override")) next.disabled_override = current.disabled_override;
    else delete next.disabled_override;

    return next;
  };

  const getLogAccountLabel = (acc: Account) => acc.characterName || acc.email.split("@")[0];

  const allLogs = accounts
    .flatMap(acc => normalizeLogList(acc.logs).map(log => ({
      ...log,
      accountId: log.accountId || acc.id,
      accountLabel: log.accountLabel || getLogAccountLabel(acc),
    })))
    .sort((a, b) => b.ts - a.ts);

  const scopedLogs = logScope === "all"
    ? allLogs
    : viewingAccount
      ? normalizeLogList(viewingAccount.logs).map(log => ({
          ...log,
          accountId: log.accountId || viewingAccount.id,
          accountLabel: log.accountLabel || getLogAccountLabel(viewingAccount),
        }))
      : [];

  const availableLogModules = Array.from(new Set(scopedLogs.map(log => log.module))).sort();
  const filteredLogs = filterLogs(scopedLogs, {
    level: logFilterLevel,
    module: logFilterModule,
    search: logSearch,
  });
  const logCounts = countLogsByLevel(scopedLogs);

  const getLogLevelClass = (level: LogLevel) => {
    switch (level) {
      case "SUCCESS": return "text-green-400 border-green-900/50 bg-green-950/10";
      case "WARN": return "text-yellow-400 border-yellow-900/50 bg-yellow-950/10";
      case "ERROR": return "text-red-400 border-red-900/50 bg-red-950/10";
      case "DEBUG": return "text-gray-500 border-gray-800 bg-gray-950/20";
      case "INFO":
      default: return "text-blue-300 border-blue-900/40 bg-blue-950/10";
    }
  };

  const clearLogs = () => {
    if (logScope === "all") {
      setAccounts(prev => prev.map(acc => ({ ...acc, logs: [] })));
      return;
    }
    if (viewingAccount) updateAccount(viewingAccount.id, { logs: [] });
  };

  const copyVisibleLogs = async () => {
    const text = exportLogsText(filteredLogs);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      console.log(text);
    }
  };

  const downloadVisibleLogs = () => {
    const text = exportLogsText(filteredLogs);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `samsara-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!selectedFeatureId) {
      setTempSettings({});
      return;
    }

    // Nếu đang tick nhiều account thì setting panel lấy mẫu từ account tick đầu tiên.
    // Khi bấm Lưu, setting sẽ áp dụng cho toàn bộ account đang tick.
    const sourceId = checkedAccountIds.size > 0 ? Array.from(checkedAccountIds)[0] : viewingAccountId;
    const sourceAcc = accountsRef.current.find(a => a.id === sourceId);
    setTempSettings(sourceAcc?.features?.[selectedFeatureId]?.settings || {});
  }, [selectedFeatureId, viewingAccountId, checkedAccountKey]); // Không đưa accounts vào dependency để tránh reset khi đang gõ

  const handleSaveSettings = () => {
    if (!selectedFeatureId) return;

    const targetIds = getBatchTargetIds();
    if (targetIds.length === 0) {
      alert("Hãy tick tài khoản hoặc mở một tài khoản trước khi lưu setting.");
      return;
    }

    const targetSet = new Set(targetIds);
    setAccounts(prev => prev.map(acc => {
      if (!targetSet.has(acc.id)) return acc;
      const current = acc.features[selectedFeatureId] || { enabled: false, status: "NOT_SELECTED", settings: {} };
      return {
        ...acc,
        features: {
          ...acc.features,
          [selectedFeatureId]: {
            ...current,
            settings: sanitizeSettingsForFeatureSave(selectedFeatureId, tempSettings, current.settings || {}),
          },
        },
      };
    }));

    targetIds.forEach(id => addAccountLog(id, "SETTINGS", "SUCCESS", `Đã lưu cấu hình ${selectedFeatureId} cho nhóm ${targetIds.length} tài khoản.`));
    alert(`Đã lưu cấu hình cho ${targetIds.length} tài khoản!`);
  };

  const updateTempSetting = (key: string, value: any) => {
    setTempSettings(prev => ({ ...prev, [key]: value }));
  };

  const getStatusBadge = (status: FeatureStatus) => {
    switch (status) {
      case "NOT_SELECTED": return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 font-semibold uppercase">Chưa làm</span>;
      case "PENDING": return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 font-semibold uppercase">Đang chờ</span>;
      case "WAITING": return <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300 font-semibold uppercase">Đang chờ</span>;
      case "IN_PROGRESS": return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 font-semibold uppercase">Đang làm</span>;
      case "DONE": return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400 font-semibold uppercase">Làm xong</span>;
    }
  };

  const isFeatureEnabled = (fId: string) => {
    const targets = getBatchTargetAccounts();
    if (targets.length > 0) return targets.every(acc => acc.features[fId]?.enabled === true);
    return globalFeatureToggles[fId] || false;
  };

  const isFeaturePartiallyEnabled = (fId: string) => {
    const targets = getBatchTargetAccounts();
    if (targets.length <= 1) return false;
    const enabledCount = targets.filter(acc => acc.features[fId]?.enabled === true).length;
    return enabledCount > 0 && enabledCount < targets.length;
  };

  const toggleFeature = (fId: string) => {
    const targetIds = getBatchTargetIds();

    if (targetIds.length > 0) {
      const targetSet = new Set(targetIds);
      const targets = accounts.filter(acc => targetSet.has(acc.id));
      const allEnabled = targets.length > 0 && targets.every(acc => acc.features[fId]?.enabled === true);
      const nextEnabled = !allEnabled;

      setAccounts(prev => prev.map(acc => {
        if (!targetSet.has(acc.id)) return acc;

        if (!nextEnabled) cancelFeatureRuntime(acc.id, fId);
        else {
          const runtime = ensureRuntimeState(acc.id);
          runtime.cancelledFeatures[fId] = false;
          if (runtime.stopped) runtime.stopped = false;
        }

        const current = acc.features[fId] || { enabled: false, status: "NOT_SELECTED", settings: {} };
        const log = createLogEntry({
          accountId: acc.id,
          accountLabel: acc.characterName || acc.email.split("@")[0],
          module: "FEATURE",
          level: nextEnabled ? "INFO" : "WARN",
          message: `${nextEnabled ? "Bật" : "Tắt"} tính năng ${fId} theo thao tác hàng loạt (${targetIds.length} tài khoản).`,
        });

        return {
          ...acc,
          logs: prependLog(acc.logs, log, 300),
          features: {
            ...acc.features,
            [fId]: {
              ...current,
              enabled: nextEnabled,
              status: nextEnabled ? "PENDING" : "NOT_SELECTED",
              settings: {
                ...(current.settings || {}),
                disabled_override: nextEnabled ? false : true,
              },
            },
          },
        };
      }));
      return;
    }

    setGlobalFeatureToggles(prev => ({...prev, [fId]: !prev[fId]}));
  };


  const summarizeAccountFromFeatures = (features: Record<string, FeatureConfig>) => {
    const enabledEntries = Object.entries(features || {}).filter(([, cfg]) => Boolean(cfg?.enabled));
    const byStatus = (target: FeatureStatus) => enabledEntries
      .filter(([, cfg]) => cfg?.status === target)
      .map(([id]) => featureLabelMap[id] || id);

    const running = byStatus("IN_PROGRESS");
    if (running.length > 0) {
      return { state: "TASK_RUNNING" as AccountState, activeTask: `Đang chạy: ${running.slice(0, 4).join(", ")}${running.length > 4 ? ` +${running.length - 4}` : ""}` };
    }

    const waiting = byStatus("WAITING");
    if (waiting.length > 0) {
      return { state: "WAITING_TIMER" as AccountState, activeTask: `Đang chờ: ${waiting.slice(0, 4).join(", ")}${waiting.length > 4 ? ` +${waiting.length - 4}` : ""}` };
    }

    const done = byStatus("DONE");
    if (done.length > 0) {
      return { state: "READY" as AccountState, activeTask: `Đã xong: ${done.slice(0, 4).join(", ")}${done.length > 4 ? ` +${done.length - 4}` : ""}` };
    }

    return { state: "READY" as AccountState, activeTask: undefined };
  };

  const setAccountFeatureStatus = (accountId: string, featureId: string, status: FeatureStatus, enabled?: boolean) => {
    setAccounts(prev => prev.map(acc => {
      if (acc.id !== accountId) return acc;
      const runtime = runtimeState.current[accountId];
      const current = acc.features[featureId] || { enabled: false, status: "NOT_SELECTED", settings: {} };
      // Sau khi user bấm Dừng, không cho promise/timer cũ đẩy trạng thái quay lại Đang làm/Đang chờ.
      if (runtime?.stopped && status !== "NOT_SELECTED") return acc;
      // Không tự bật lại tính năng từ các callback cũ. Chỉ cho phép tắt cưỡng bức bằng enabled=false.
      const nextEnabled = enabled === false ? false : current.enabled;
      const nextFeatures = {
        ...acc.features,
        [featureId]: {
          ...current,
          enabled: nextEnabled,
          status: nextEnabled ? status : "NOT_SELECTED",
        }
      };
      const display = runtime?.featureRunnerMode && acc.state !== "ERROR" ? summarizeAccountFromFeatures(nextFeatures as Record<string, FeatureConfig>) : {};
      return {
        ...acc,
        ...display,
        features: nextFeatures,
      };
    }));
  };


  const parseJwtPayload = (token?: string) => {
    if (!token) return null;
    try {
      const part = token.split(".")[1];
      if (!part) return null;
      const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(
        atob(base64)
          .split("")
          .map(c => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`)
          .join("")
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

  const isAccessTokenExpired = (token?: string) => {
    const payload = parseJwtPayload(token);
    const exp = Number(payload?.exp || 0);
    if (!exp) return true;
    // Làm mới sớm 60 giây để tránh đang chạy giữa chừng bị JWT expired.
    return Date.now() / 1000 > exp - 60;
  };

  const ensureRuntimeAccount = async (accountId: string, moduleName: string) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    let token = acc.accessToken;
    let charId = acc.characterId;
    let characterName = acc.characterName;

    if (!token || isAccessTokenExpired(token)) {
      if (!acc.password) {
        addAccountLog(acc.id, moduleName, "ERROR", "JWT đã hết hạn nhưng tài khoản không có password để đăng nhập lại.");
        updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: "JWT expired, thiếu password để login lại" });
        return null;
      }

      addAccountLog(acc.id, "AUTH", "WARN", "JWT hết hạn hoặc thiếu token, đang đăng nhập lại trước khi chạy.");
      updateAccount(acc.id, { state: "LOGGING_IN", activeTask: "Đăng nhập lại", errorMessage: undefined });

      const authRes = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: GAME_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: acc.email, password: acc.password }),
        credentials: "omit",
      });

      const authData = await authRes.json();
      if (!authRes.ok) {
        const msg = authData.error_description || authData.msg || "Lỗi đăng nhập lại";
        addAccountLog(acc.id, "AUTH", "ERROR", msg, authData);
        updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: msg });
        return null;
      }

      token = authData.access_token;
      updateAccount(acc.id, { accessToken: token });
      addAccountLog(acc.id, "AUTH", "SUCCESS", "Đăng nhập lại thành công.");
    }

    if (!charId) {
      addAccountLog(acc.id, "CHAR", "INFO", "Thiếu characterId, đang lấy lại nhân vật.");
      updateAccount(acc.id, { state: "FETCHING_CHAR", activeTask: "Lấy nhân vật" });

      const charRes = await fetch(`${BASE_URL}/rest/v1/characters?select=*`, {
        method: "GET",
        headers: {
          apikey: GAME_API_KEY,
          authorization: `Bearer ${token}`,
        },
        credentials: "omit",
      });

      const charData = await charRes.json();
      if (!charRes.ok || !Array.isArray(charData) || charData.length === 0) {
        addAccountLog(acc.id, "CHAR", "ERROR", "Không tìm thấy nhân vật khi chuẩn bị chạy.", charData);
        updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: "Không tìm thấy nhân vật" });
        return null;
      }

      const character = charData[0];
      charId = character.id;
      characterName = pickFirst(character.name, character.display_name, character.nickname, character.character_name, characterName);
      updateAccount(acc.id, { characterId: charId, characterName });
      addAccountLog(acc.id, "CHAR", "SUCCESS", `Đã lấy nhân vật: ${characterName || charId}.`);
    }

    return { account: acc, accessToken: token as string, characterId: charId as string };
  };

  const refreshAccountResourcesNow = async (accountId: string, moduleName = "RESOURCE") => {
    const runtime = await ensureRuntimeAccount(accountId, moduleName);
    if (!runtime) return false;

    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return false;

    try {
      let finalStones: any = acc.spiritStones;
      let finalGold: any = acc.gold;
      let finalLevel: any = acc.level;
      let finalVip: any = acc.vipLevel ?? "?";
      let finalHp: any = acc.hp;
      let finalMaxHp: any = acc.maxHp;
      let finalMp: any = acc.mp;
      let finalMaxMp: any = acc.maxMp;
      let finalExpCurrent: any = acc.expCurrent;
      let finalExpMax: any = acc.expMax;
      let finalAtk: any = acc.atk;
      let finalDef: any = acc.def;
      let dominantElement = acc.dominantElement;
      let dominantElementScore: number | string | undefined = acc.dominantElementScore;
      let snapshotRealmLevel: any = undefined;
      let snapshotRealmName: any = undefined;

      const snapRes = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_get_home_snapshot`, {
        method: "POST",
        headers: {
          apikey: GAME_API_KEY,
          authorization: `Bearer ${runtime.accessToken}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": "supabase-flutter/2.12.0",
        },
        body: JSON.stringify({ p_character_id: runtime.characterId }),
        credentials: "omit",
      });

      if (snapRes.ok) {
        const snapData = await snapRes.json();
        const snapChar = snapData?.character || snapData?.character_info || snapData?.profile || {};
        snapshotRealmLevel = pickFirst(snapChar?.realm_level, snapChar?.level_reach, snapData?.character?.realm_level, snapData?.realm_level);
        snapshotRealmName = pickFirst(snapChar?.realm_name, snapData?.stats?.base?.realm_name, snapData?.realm_name);
        const wallet = snapData?.wallet || snapData?.resources || {};

        finalStones = pickFirst(
          snapData?.spirit_stones,
          wallet?.spirit_stones,
          snapData?.resources?.spirit_stones,
          snapData?.wallet?.spirit_stones,
          finalStones
        );

        finalGold = pickFirst(
          snapData?.sect_contribution?.points,
          wallet?.sect_contribution,
          wallet?.gold,
          wallet?.bac,
          snapData?.resources?.bac,
          snapData?.bac,
          finalGold
        );

        finalLevel = pickFirst(
          snapChar?.level_reach,
          snapChar?.level,
          snapChar?.rank,
          snapChar?.realm,
          snapChar?.cultivation_rank,
          snapData?.level,
          snapData?.level_reach,
          finalLevel
        );

        finalVip = pickFirst(
          snapData?.vip_level,
          snapData?.vip,
          snapChar?.vip_level,
          snapChar?.vip,
          snapData?.account?.vip_level,
          snapData?.account?.vip,
          snapData?.profile?.vip_level,
          snapData?.profile?.vip,
          finalVip
        );

        finalHp = pickFirst(snapChar?.hp, snapData?.hp, snapData?.current_hp, finalHp);
        finalMaxHp = pickFirst(snapChar?.max_hp, snapData?.max_hp, finalMaxHp);
        finalMp = pickFirst(snapChar?.mp, snapData?.mp, snapData?.current_mp, finalMp);
        finalMaxMp = pickFirst(snapChar?.max_mp, snapData?.max_mp, finalMaxMp);
        const combatStats = extractCombatStats(snapData, snapChar, { atk: finalAtk, def: finalDef });
        finalAtk = pickFirst(combatStats.atk, finalAtk);
        finalDef = pickFirst(combatStats.def, finalDef);
        const finalPathStats = getHomeFinalStats(snapData);
        if (finalPathStats?.atk !== undefined || finalPathStats?.def !== undefined) {
          addAccountLog(acc.id, "STATS", "DEBUG", `Đọc ATK/DEF từ home snapshot stats.final: ATK ${formatNumber(finalPathStats?.atk)}, DEF ${formatNumber(finalPathStats?.def)}.`);
        }
        const snapshotTalent = extractDominantTalent(getHomeTalentStats(snapData), dominantElement);
        dominantElement = pickFirst(snapshotTalent.key, dominantElement);
        dominantElementScore = pickFirst(snapshotTalent.value, dominantElementScore);

        const expPair = extractExpPair(snapData);
        finalExpCurrent = pickFirst(expPair.current, finalExpCurrent);
        finalExpMax = pickFirst(expPair.max, finalExpMax);
        if (expPair.current !== null && expPair.max !== null) {
          addAccountLog(accountId, "EXP", "DEBUG", `Đọc EXP từ home snapshot: ${formatNumber(expPair.current)}/${formatNumber(expPair.max)}.`);
        } else {
          addAccountLog(accountId, "EXP", "DEBUG", "Chưa map được EXP từ home snapshot, sẽ thử rebirth progress.", { expCandidates: getExpDebugCandidates(snapData) });
        }
      } else {
        addAccountLog(accountId, moduleName, "WARN", "Không cập nhật được home snapshot sau khi claim quà.");
      }

      let rbRank = acc.rebirthRank;
      let rankLabel: any = acc.rankLabel ?? "?";
      let totalScore: any = acc.totalScore ?? "?";
      let realmCode = acc.realmCode;
      let realmLabel = acc.realmLabel;
      let realmTier = acc.realmTier;
      let requiredToken = acc.requiredToken;
      let sectName = acc.sectName;
      let daoCoTotal = acc.daoCoTotal;
      let tokens: WalletTokens = acc.tokens || {};

      const rankRes = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_get_rebirth_quest_progress`, {
        method: "POST",
        headers: {
          apikey: GAME_API_KEY,
          authorization: `Bearer ${runtime.accessToken}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": "supabase-flutter/2.12.0",
        },
        body: JSON.stringify({ p_character_id: runtime.characterId }),
        credentials: "omit",
      });

      if (rankRes.ok) {
        const tsData = await rankRes.json();
        rankLabel = pickFirst(tsData?.quest?.rank_label, rankLabel, "?");
        totalScore = pickFirst(tsData?.quest?.total_score, totalScore, "?");
        rbRank = `${rankLabel} (${totalScore})`;
        realmCode = pickFirst(tsData?.realm_code, realmCode);
        realmLabel = formatRealmLabel(realmCode);
        realmTier = inferAccountRealmTier({ realmTier, realmCode, realmLabel, realm_level: snapshotRealmLevel, realm_name: snapshotRealmName, level: finalLevel });
        requiredToken = pickFirst(tsData?.required_token, requiredToken);
        sectName = pickFirst(tsData?.sect_name, sectName);
        daoCoTotal = pickFirst(tsData?.dao_co?.total, daoCoTotal);
        const dominantTalent = extractDominantTalent(tsData?.talent, dominantElement);
        dominantElement = pickFirst(dominantTalent.key, tsData?.talent?.dominant_element, dominantElement);
        dominantElementScore = pickFirst(dominantTalent.value, dominantElementScore);
        tokens = {
          copper: pickFirst(tsData?.tokens?.copper, tokens?.copper, 0),
          silver: pickFirst(tsData?.tokens?.silver, tokens?.silver, 0),
          gold: pickFirst(tsData?.tokens?.gold, tokens?.gold, 0),
          diamond: pickFirst(tsData?.tokens?.diamond, tokens?.diamond, 0),
          chaos: pickFirst(tsData?.tokens?.chaos, tokens?.chaos, 0),
          platinum: pickFirst(tsData?.tokens?.platinum, tokens?.platinum, 0),
        };

        const rbExpPair = extractExpPair(tsData);
        finalExpCurrent = pickFirst(rbExpPair.current, finalExpCurrent);
        finalExpMax = pickFirst(rbExpPair.max, finalExpMax);
        if (rbExpPair.current !== null && rbExpPair.max !== null) {
          addAccountLog(accountId, "EXP", "DEBUG", `Đọc EXP từ rebirth progress: ${formatNumber(rbExpPair.current)}/${formatNumber(rbExpPair.max)}.`);
        }
      }

      realmTier = inferAccountRealmTier({ realmTier, realmCode, realmLabel, realm_level: snapshotRealmLevel, realm_name: snapshotRealmName, level: finalLevel });

      updateAccount(accountId, {
        __resourceAuthoritative: true,
        spiritStones: Number(finalStones) || 0,
        gold: Number(finalGold) || 0,
        level: finalLevel,
        vipLevel: finalVip,
        hp: finalHp,
        maxHp: finalMaxHp,
        mp: finalMp,
        maxMp: finalMaxMp,
        expCurrent: finalExpCurrent,
        expMax: finalExpMax,
        rebirthRank: rbRank,
        rankLabel,
        totalScore,
        realmCode,
        realmLabel,
        realmTier,
        tokens,
        requiredToken,
        sectName,
        daoCoTotal,
        dominantElement,
        dominantElementScore,
        atk: finalAtk,
        def: finalDef,
      });

      addAccountLog(accountId, moduleName, "SUCCESS", `Đã cập nhật lại tài nguyên sau khi claim: linh thạch ${formatNumber(finalStones)}, cống hiến/bạc ${formatNumber(finalGold)}.`);
      return true;
    } catch (error: any) {
      addAccountLog(accountId, moduleName, "WARN", `Cập nhật tài nguyên sau claim lỗi: ${error.message || "unknown"}`, error?.data);
      return false;
    }
  };

  const requestAccountResourceRefresh = (accountId: string, moduleName = "RESOURCE", debounceMs = RESOURCE_REFRESH_DEBOUNCE_MS) => {
    const runtime = ensureRuntimeState(accountId);
    if (runtime.stopped) return Promise.resolve(false);

    if (!runtime.resourceRefreshQueue) {
      runtime.resourceRefreshQueue = { modules: new Set<string>(), resolvers: [] as Array<(ok: boolean) => void>, timer: null as any };
    }

    const queue = runtime.resourceRefreshQueue;
    queue.modules.add(moduleName);

    const promise = new Promise<boolean>(resolve => {
      queue.resolvers.push(resolve);
    });

    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(async () => {
      const activeQueue = runtime.resourceRefreshQueue;
      runtime.resourceRefreshQueue = undefined;

      if (!activeQueue || runtime.stopped) {
        activeQueue?.resolvers?.forEach((resolve: any) => resolve(false));
        return;
      }

      const modules = Array.from(activeQueue.modules || []);
      const mergedReason = modules.length > 1 ? `SYNC:${modules.join("+")}` : (modules[0] || moduleName);
      if (modules.length > 1) {
        addAccountLog(accountId, "RESOURCE", "INFO", `Gộp ${modules.length} yêu cầu refresh tài nguyên thành 1 snapshot thật.`, { modules });
      }

      const ok = await refreshAccountResourcesNow(accountId, mergedReason);
      activeQueue.resolvers.forEach((resolve: any) => resolve(ok));
    }, Math.max(0, Number(debounceMs || 0)));

    return promise;
  };

  const refreshAccountResources = (accountId: string, moduleName = "RESOURCE") => requestAccountResourceRefresh(accountId, moduleName);

  const getMazeSettings = (acc: Account, override?: Record<string, any>) => {
    const settings = { ...(acc.features.me_cung?.settings || {}), ...(override || {}) };
    return {
      tier: Number(settings.tier || 1),
      autoBoss: settings.auto_boss !== false,
      autoClaimFinal: settings.auto_claim_final !== false,
      bossHpReserve: Number(settings.boss_hp_reserve || 5),
      maxPasses: Number(settings.max_passes || 5),
      runCount: Math.min(10, Math.max(1, Number(settings.run_count || 3))),
    };
  };

  const runMazeForAccount = async (accountId: string, settingsOverride?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return;

    const runtime = await ensureRuntimeAccount(acc.id, "MAZE");
    if (!runtime) return;

    const settings = getMazeSettings(acc, settingsOverride);
    const tier = Math.min(6, Math.max(1, Number(settings.tier || 1)));

    const runCount = Math.min(10, Math.max(1, Number(settings.runCount || 3)));

    addAccountLog(acc.id, "MAZE", "INFO", `Bắt đầu chạy Mê Cung tier ${tier}, số lượt ${runCount}, maxPasses=${settings.maxPasses}.`);
    setAccountFeatureStatus(acc.id, "me_cung", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "MAZE_RUNNING", activeTask: "Mê Cung", errorMessage: undefined });

    let lastResult: MazeRunSummary | undefined;
    let successCount = 0;
    let failCount = 0;
    let totalCoTe = 0;
    let totalMinted = 0;

    try {
      for (let runIndex = 1; runIndex <= runCount; runIndex++) {
        addAccountLog(acc.id, "MAZE", "INFO", `Lượt ${runIndex}/${runCount}: bắt đầu Mê Cung tier ${tier}.`);

        try {
          const result = await runMazeAuto({
            characterId: runtime.characterId,
            accessToken: runtime.accessToken,
            tier,
            autoBoss: settings.autoBoss,
            autoClaimFinal: settings.autoClaimFinal,
            bossHpReserve: settings.bossHpReserve,
            maxPasses: settings.maxPasses,
            onLog: (level, message, meta) => addAccountLog(acc.id, "MAZE", level, `[${runIndex}/${runCount}] ${message}`, meta),
          });

          lastResult = result;
          successCount += 1;
          totalCoTe += Number(result.coTe || 0);
          totalMinted += Number(result.minted || 0);

          updateAccount(acc.id, {
            mazeLastRun: result,
            errorMessage: undefined,
          });

          addAccountLog(acc.id, "MAZE", "SUCCESS", `Lượt ${runIndex}/${runCount} hoàn tất: claim=${result.claimed ? "OK" : "chưa claim"}, co_te=${result.coTe ?? "?"}, minted=${result.minted ?? "?"}.`, {
            runId: result.runId,
            coTe: result.coTe,
            minted: result.minted,
            status: result.status,
          });
        } catch (runError: any) {
          failCount += 1;
          addAccountLog(acc.id, "MAZE", "ERROR", `Lượt ${runIndex}/${runCount} lỗi: ${runError.message || "Lỗi Mê Cung không xác định."}`, runError?.data);

          // Nếu hết lượt/free daily hoặc lỗi start run thì dừng các lượt sau để tránh spam RPC.
          const msg = String(runError.message || "").toLowerCase();
          const raw = JSON.stringify(runError?.data || {}).toLowerCase();
          if (msg.includes("free") || msg.includes("daily") || msg.includes("limit") || raw.includes("free") || raw.includes("daily") || raw.includes("limit")) {
            addAccountLog(acc.id, "MAZE", "WARN", "Dừng các lượt Mê Cung còn lại vì có vẻ đã hết lượt/ngày hoặc bị giới hạn lượt.");
            break;
          }
        }
      }

      if (successCount > 0) {
        await refreshAccountResources(acc.id, "MAZE");
      }

      const ms = msUntilNextVietnamMidnight();
      setFeatureTimer(accountId, "me_cung", ms, () => runMazeForAccount(accountId, undefined));
      updateAccount(acc.id, {
        state: "WAITING_TIMER",
        activeTask: "Đợi reset Mê Cung 0h Việt Nam",
        mazeLastRun: lastResult,
        errorMessage: failCount > 0 && successCount === 0 ? "Có thể đã hết lượt Mê Cung miễn phí hôm nay" : undefined,
      });
      setAccountFeatureStatus(acc.id, "me_cung", "WAITING", true);
      addAccountLog(acc.id, successCount > 0 ? "MAZE" : "MAZE", successCount > 0 ? "SUCCESS" : "WARN", `Kết thúc Mê Cung: thành công ${successCount}/${runCount}, lỗi ${failCount}, tổng co_te=${totalCoTe}, tổng minted=${totalMinted}. Sẽ tự chạy lại sau reset 0h Việt Nam.`, {
        successCount,
        failCount,
        runCount,
        totalCoTe,
        totalMinted,
      });
    } catch (error: any) {
      const ms = msUntilNextVietnamMidnight();
      setFeatureTimer(accountId, "me_cung", ms, () => runMazeForAccount(accountId, undefined));
      updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: "Đợi reset Mê Cung 0h Việt Nam", errorMessage: error.message || "Có thể đã hết lượt Mê Cung hôm nay" });
      setAccountFeatureStatus(acc.id, "me_cung", "WAITING", true);
      addAccountLog(acc.id, "MAZE", "WARN", `${error.message || "Mê Cung chưa chạy được"}. Sẽ tự check lại sau reset 0h Việt Nam.`, error?.data);
    }
  };

  const runMazeForTargets = () => {
    const targetIds = viewingAccountId ? [viewingAccountId] : Array.from(checkedAccountIds);
    if (targetIds.length === 0) return;
    const settingsOverride = selectedFeatureId === "me_cung" ? tempSettings : undefined;

    // Lưu nhanh setting đang hiển thị trước khi chạy để lần sau mở lại vẫn còn.
    if (settingsOverride) {
      setAccounts(prev => prev.map(acc => {
        if (!targetIds.includes(acc.id)) return acc;
        const current = acc.features.me_cung || { enabled: false, status: "NOT_SELECTED", settings: {} };
        return {
          ...acc,
          features: {
            ...acc.features,
            me_cung: {
              ...current,
              enabled: true,
              settings: { ...current.settings, ...settingsOverride },
            }
          }
        };
      }));
    }

    targetIds.forEach(id => runMazeForAccount(id, settingsOverride));
  };


  const getDailySettings = (acc: Account, override?: Record<string, any>) => {
    const settings = { ...(acc.features.attendance?.settings || {}), ...(override || {}) };
    return {
      auto_cultivation: settings.auto_cultivation !== false,
      world_cup_checkin: settings.world_cup_checkin !== false,
      onboarding_claim: settings.onboarding_claim !== false,
      body_cult_claim: settings.body_cult_claim !== false,
      world_boss: settings.world_boss === true,
      world_boss_tier: String(settings.world_boss_tier || "lk"),
      achievement_claim: settings.achievement_claim === true,
    };
  };

  const runDailyForAccount = async (accountId: string, settingsOverride?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return;

    const runtime = await ensureRuntimeAccount(acc.id, "DAILY");
    if (!runtime) return;

    const settings = getDailySettings(acc, settingsOverride);
    addAccountLog(acc.id, "DAILY", "INFO", "Bắt đầu Daily Engine.");
    setAccountFeatureStatus(acc.id, "attendance", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "DAILY_RUNNING", activeTask: "Daily Engine", errorMessage: undefined });

    try {
      const result = await runDailyAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: (level, message, meta) => addAccountLog(acc.id, "DAILY", level, message, meta),
      });

      const nextState: AccountState = result.status === "ERROR" ? "ERROR" : "READY";
      updateAccount(acc.id, {
        state: nextState,
        activeTask: undefined,
        dailyLastRun: result,
        errorMessage: result.status === "ERROR" ? "Daily Engine lỗi nghiêm trọng" : undefined,
      });

      setAccountFeatureStatus(acc.id, "attendance", result.status === "ERROR" ? "PENDING" : "DONE", true);
      addAccountLog(acc.id, "DAILY", result.status === "DONE" ? "SUCCESS" : result.status === "PARTIAL_ERROR" ? "WARN" : "ERROR", `Kết thúc Daily: ${result.status}, success=${result.successCount}, warn=${result.warnCount}, error=${result.errorCount}, skipped=${result.skippedCount}.`, {
        status: result.status,
        successCount: result.successCount,
        warnCount: result.warnCount,
        errorCount: result.errorCount,
        skippedCount: result.skippedCount,
        taskCount: result.tasks.length,
      });
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Daily Engine" });
      setAccountFeatureStatus(acc.id, "attendance", "PENDING", true);
      addAccountLog(acc.id, "DAILY", "ERROR", error.message || "Lỗi Daily Engine không xác định.", error?.data);
    }
  };

  const runDailyForTargets = () => {
    const targetIds = viewingAccountId ? [viewingAccountId] : Array.from(checkedAccountIds);
    if (targetIds.length === 0) return;
    const settingsOverride = selectedFeatureId === "attendance" ? tempSettings : undefined;

    if (settingsOverride) {
      setAccounts(prev => prev.map(acc => {
        if (!targetIds.includes(acc.id)) return acc;
        const current = acc.features.attendance || { enabled: false, status: "NOT_SELECTED", settings: {} };
        return {
          ...acc,
          features: {
            ...acc.features,
            attendance: { ...current, enabled: true, settings: { ...current.settings, ...settingsOverride } }
          }
        };
      }));
    }

    targetIds.forEach(id => runDailyForAccount(id, settingsOverride));
  };


  const runMailForAccount = async (accountId: string) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "MAIL");
    if (!runtime) return null;

    addAccountLog(acc.id, "MAIL", "INFO", "Bắt đầu claim tất cả mail.");
    setAccountFeatureStatus(acc.id, "mail_giftcode", "IN_PROGRESS", true);

    try {
      const result = await runMailClaimAll({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        onLog: (level, message, meta) => addAccountLog(acc.id, "MAIL", level, message, meta),
      });

      updateAccount(acc.id, {
        state: result.status === "ERROR" ? "ERROR" : "READY",
        mailLastRun: result,
        errorMessage: result.status === "ERROR" ? "Claim mail lỗi nghiêm trọng" : undefined,
      });

      setAccountFeatureStatus(acc.id, "mail_giftcode", result.status === "ERROR" ? "PENDING" : "DONE", true);
      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", errorMessage: error.message || "Lỗi claim mail" });
      setAccountFeatureStatus(acc.id, "mail_giftcode", "PENDING", true);
      addAccountLog(acc.id, "MAIL", "ERROR", error.message || "Lỗi claim mail không xác định.", error?.data);
      return null;
    }
  };

  const runMailForTargets = () => {
    const targetIds = viewingAccountId ? [viewingAccountId] : Array.from(checkedAccountIds);
    if (targetIds.length === 0) return;
    targetIds.forEach(id => runMailForAccount(id));
  };

  const getGiftcodeSettings = (acc: Account, override?: Record<string, any>) => {
    const settings = { ...(acc.features.giftcode?.settings || {}), ...(override || {}) };
    return {
      mode: String(settings.mode || "until_success_count"),
      success_target: Math.max(1, Number(settings.success_target || 1) || 1),
      giftcodes: String(settings.giftcodes || ""),
    };
  };

  const runGiftcodeForAccount = async (accountId: string, settingsOverride?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    if (!acc.accessToken) {
      addAccountLog(acc.id, "GIFTCODE", "ERROR", "Thiếu accessToken. Hãy bấm Kiểm tra tài khoản trước khi nhập giftcode.");
      updateAccount(acc.id, { state: "ERROR", errorMessage: "Thiếu token cho Giftcode" });
      return null;
    }

    const settings = getGiftcodeSettings(acc, settingsOverride);

    addAccountLog(acc.id, "GIFTCODE", "INFO", `Bắt đầu nhập giftcode mode=${settings.mode}.`);
    setAccountFeatureStatus(acc.id, "giftcode", "IN_PROGRESS", true);

    try {
      const result = await runGiftcodeAuto({
        accessToken: acc.accessToken,
        settings,
        onLog: (level, message, meta) => addAccountLog(acc.id, "GIFTCODE", level, message, meta),
      });

      updateAccount(acc.id, {
        state: "READY",
        giftcodeLastRun: result,
        errorMessage: undefined,
      });

      setAccountFeatureStatus(acc.id, "giftcode", "DONE", true);
      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", errorMessage: error.message || "Lỗi Giftcode Engine" });
      setAccountFeatureStatus(acc.id, "giftcode", "PENDING", true);
      addAccountLog(acc.id, "GIFTCODE", "ERROR", error.message || "Lỗi Giftcode Engine không xác định.", error?.data);
      return null;
    }
  };

  const updateGiftcodeListForTargets = (targetIds: string[], giftcodes: string) => {
    setAccounts(prev => prev.map(acc => {
      if (!targetIds.includes(acc.id)) return acc;
      const current = acc.features.giftcode || { enabled: false, status: "NOT_SELECTED", settings: {} };
      return {
        ...acc,
        features: {
          ...acc.features,
          giftcode: {
            ...current,
            enabled: true,
            settings: {
              ...current.settings,
              giftcodes,
            },
          },
        },
      };
    }));

    if (selectedFeatureId === "giftcode") {
      setTempSettings(prev => ({ ...prev, giftcodes }));
    }
  };

  const runGiftcodeForTargets = async () => {
    const targetIds = viewingAccountId ? [viewingAccountId] : Array.from(checkedAccountIds);
    if (targetIds.length === 0) return;

    const baseSettings = selectedFeatureId === "giftcode" ? { ...tempSettings } : undefined;
    const mode = String(baseSettings?.mode || "until_success_count");

    if (baseSettings) {
      setAccounts(prev => prev.map(acc => {
        if (!targetIds.includes(acc.id)) return acc;
        const current = acc.features.giftcode || { enabled: false, status: "NOT_SELECTED", settings: {} };
        return {
          ...acc,
          features: {
            ...acc.features,
            giftcode: {
              ...current,
              enabled: true,
              settings: { ...current.settings, ...baseSettings },
            },
          },
        };
      }));
    }

    let sharedGiftcodes = String(baseSettings?.giftcodes || "");

    for (const id of targetIds) {
      const settingsForThisAccount = {
        ...(baseSettings || {}),
        giftcodes: mode === "shared_pool_remove_attempted" ? sharedGiftcodes : String(baseSettings?.giftcodes || ""),
      };

      const result = await runGiftcodeForAccount(id, settingsForThisAccount);

      if (mode === "shared_pool_remove_attempted" && result) {
        sharedGiftcodes = result.remainingCodes.join("\n");
        updateGiftcodeListForTargets(targetIds, sharedGiftcodes);
        addAccountLog(id, "GIFTCODE", "INFO", `Pool còn lại ${result.remainingCodes.length} code sau account này.`);
      }

      if (mode === "shared_pool_remove_attempted" && !sharedGiftcodes.trim()) {
        addAccountLog(id, "GIFTCODE", "WARN", "Pool giftcode đã hết, dừng các account còn lại.");
        break;
      }
    }
  };


  const getMailGiftcodeSettings = (acc: Account, override?: Record<string, any>) => {
    const settings = { ...(acc.features.mail_giftcode?.settings || {}), ...(override || {}) };
    return {
      claim_mail: settings.claim_mail !== false,
      giftcode_enabled: settings.giftcode_enabled === true || String(settings.giftcodes || "").trim() !== "",
      mode: String(settings.mode || "until_success_count"),
      success_target: Math.max(1, Number(settings.success_target || 1) || 1),
      giftcodes: String(settings.giftcodes || ""),
    };
  };

  const updateSharedGiftcodePoolForTargets = (targetIds: string[], giftcodes: string) => {
    setAccounts(prev => prev.map(acc => {
      if (!targetIds.includes(acc.id)) return acc;
      const current = acc.features.mail_giftcode || { enabled: false, status: "NOT_SELECTED", settings: {} };
      return {
        ...acc,
        features: {
          ...acc.features,
          mail_giftcode: {
            ...current,
            enabled: true,
            settings: {
              ...current.settings,
              giftcodes,
            },
          },
        },
      };
    }));

    if (selectedFeatureId === "mail_giftcode") {
      setTempSettings(prev => ({ ...prev, giftcodes }));
    }
  };

  const runMailGiftcodeForAccount = async (accountId: string, settingsOverride?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "MAIL_GIFTCODE");
    if (!runtime) return null;

    const settings = getMailGiftcodeSettings(acc, settingsOverride);
    setAccountFeatureStatus(acc.id, "mail_giftcode", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: "Mail / Giftcode", errorMessage: undefined });

    let mailResult: MailRunSummary | null = null;
    let giftcodeResult: GiftcodeRunSummary | null = null;

    try {
      // Logic mới: nếu có tick nhập giftcode thì nhập giftcode trước, hoàn tất xong mới claim mail.
      if (settings.giftcode_enabled) {
        updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: "Nhập Giftcode" });
        addAccountLog(acc.id, "GIFTCODE", "INFO", `Bắt đầu nhập giftcode mode=${settings.mode}. Sau khi xong mới claim mail.`);
        giftcodeResult = await runGiftcodeAuto({
          accessToken: runtime.accessToken,
          settings,
          onLog: (level, message, meta) => addAccountLog(acc.id, "GIFTCODE", level, message, meta),
        });
        updateAccount(acc.id, { giftcodeLastRun: giftcodeResult });
      } else {
        addAccountLog(acc.id, "GIFTCODE", "DEBUG", "Giftcode đang tắt hoặc list trống, bỏ qua bước nhập code.");
      }

      if (settings.claim_mail) {
        updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: "Claim Mail" });
        addAccountLog(acc.id, "MAIL", "INFO", settings.giftcode_enabled ? "Giftcode đã hoàn tất, bắt đầu claim tất cả mail." : "Bắt đầu claim tất cả mail.");
        mailResult = await runMailClaimAll({
          characterId: runtime.characterId,
          accessToken: runtime.accessToken,
          onLog: (level, message, meta) => addAccountLog(acc.id, "MAIL", level, message, meta),
        });
        updateAccount(acc.id, { mailLastRun: mailResult });
      } else {
        addAccountLog(acc.id, "MAIL", "DEBUG", "Claim Mail đang tắt trong setting.");
      }

      if ((giftcodeResult?.successCount || 0) > 0 || (mailResult?.claimedCount || 0) > 0) {
        await refreshAccountResources(acc.id, "MAIL_GIFTCODE");
      }

      updateAccount(acc.id, { state: "READY", activeTask: undefined, errorMessage: undefined });
      setAccountFeatureStatus(acc.id, "mail_giftcode", "DONE", true);

      return { mailResult, giftcodeResult };
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Mail / Giftcode" });
      setAccountFeatureStatus(acc.id, "mail_giftcode", "PENDING", true);
      addAccountLog(acc.id, "MAIL_GIFTCODE", "ERROR", error.message || "Lỗi Mail / Giftcode không xác định.", error?.data);
      return { mailResult, giftcodeResult };
    }
  };

  const startAccountWorkflow = async (acc: Account, forceFreshLogin = false) => {
    try {
      let token = acc.accessToken;
      let charId = acc.characterId;
      let currentLevel = acc.level;
      let currentGold = acc.gold;
      let currentName = acc.characterName;
      let currentAtk: number | string | undefined = acc.atk;
      let currentDef: number | string | undefined = acc.def;

      addAccountLog(acc.id, "LOGIN", "INFO", "Bắt đầu kiểm tra tài khoản và lấy thông tin nhân vật.");

      // 1. Đăng nhập và lấy characterId nếu chưa có.
      // Khi bấm Kiểm tra, forceFreshLogin=true sẽ đăng nhập lại để lấy token/snapshot mới giống như mới vào game.
      if (forceFreshLogin && !acc.password && token) {
        addAccountLog(acc.id, "LOGIN", "WARN", "Không có password để đăng nhập lại, dùng token hiện tại để refresh thông tin.");
      }

      if (!charId || !token || (forceFreshLogin && Boolean(acc.password))) {
        updateAccount(acc.id, { state: "LOGGING_IN", activeTask: forceFreshLogin ? "Đăng nhập lại" : "Kiểm tra / đăng nhập", errorMessage: undefined });
        const authRes = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: {
            "apikey": GAME_API_KEY,
            "content-type": "application/json"
          },
          body: JSON.stringify({ email: acc.email, password: acc.password }),
          credentials: "omit"
        });
        const authData = await authRes.json();
        if (!authRes.ok) throw new Error(authData.error_description || authData.msg || "Lỗi đăng nhập");
        token = authData.access_token;
        updateAccount(acc.id, { accessToken: token });
        addAccountLog(acc.id, "LOGIN", "SUCCESS", "Đăng nhập thành công.");
        
        updateAccount(acc.id, { state: "FETCHING_CHAR", activeTask: "Lấy nhân vật" });
        const charRes = await fetch(`${BASE_URL}/rest/v1/characters?select=*`, {
          method: "GET",
          headers: {
            "apikey": GAME_API_KEY,
            "authorization": `Bearer ${token}`
          },
          credentials: "omit"
        });
        const charData = await charRes.json();
        if (!charRes.ok || !Array.isArray(charData) || charData.length === 0) throw new Error("Không tìm thấy nhân vật");
        
        const character = charData[0];
        charId = character.id;
        currentName = pickFirst(character.name, character.display_name, character.nickname, character.character_name, currentName);
        currentLevel = pickFirst(character.level_reach, character.level, character.rank, character.cultivation_rank, currentLevel, 1);
        currentGold = pickFirst(character.bac, character.coins, character.gold, currentGold, 0);
        const charCombat = extractCombatStats(character, character, { atk: currentAtk, def: currentDef });
        currentAtk = pickFirst(charCombat.atk, currentAtk);
        currentDef = pickFirst(charCombat.def, currentDef);
        updateAccount(acc.id, { characterId: charId, characterName: currentName, level: currentLevel, gold: Number(currentGold) || 0, atk: currentAtk, def: currentDef });
        addAccountLog(acc.id, "CHAR", "SUCCESS", `Đã lấy nhân vật: ${currentName || charId}.`);
      }

      if (!charId || !token) throw new Error("Thiếu characterId hoặc accessToken sau bước đăng nhập.");

      // 2. Lấy thông tin tổng quan: cấp độ, ví, VIP, HP/MP
      updateAccount(acc.id, { state: "FETCHING_INFO", activeTask: "Lấy thông tin" });
      addAccountLog(acc.id, "INFO", "INFO", "Đang lấy home snapshot.");
      
      const snapRes = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_get_home_snapshot`, {
        method: "POST",
        headers: {
          "apikey": GAME_API_KEY,
          "authorization": `Bearer ${token}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": "supabase-flutter/2.12.0"
        },
        body: JSON.stringify({ p_character_id: charId }),
        credentials: "omit"
      });
      
      let finalStones = acc.spiritStones;
      let finalGold = currentGold;
      let finalLevel = currentLevel;
      let finalVip: number | string = acc.vipLevel ?? "?";
      let finalHp: number | string | undefined = acc.hp;
      let finalMaxHp: number | string | undefined = acc.maxHp;
      let finalMp: number | string | undefined = acc.mp;
      let finalMaxMp: number | string | undefined = acc.maxMp;
      let finalExpCurrent: number | string | undefined = acc.expCurrent;
      let finalExpMax: number | string | undefined = acc.expMax;
      let finalAtk: number | string | undefined = currentAtk ?? acc.atk;
      let finalDef: number | string | undefined = currentDef ?? acc.def;
      let dominantElement = acc.dominantElement;
      let dominantElementScore: number | string | undefined = acc.dominantElementScore;
      let snapshotRealmLevel: any = undefined;
      let snapshotRealmName: any = undefined;

      if (snapRes.ok) {
        const snapData = await snapRes.json();
        const snapChar = snapData?.character || snapData?.character_info || snapData?.profile || {};
        snapshotRealmLevel = pickFirst(snapChar?.realm_level, snapChar?.level_reach, snapData?.character?.realm_level, snapData?.realm_level);
        snapshotRealmName = pickFirst(snapChar?.realm_name, snapData?.stats?.base?.realm_name, snapData?.realm_name);
        const wallet = snapData?.wallet || snapData?.resources || {};
        
        finalStones = pickFirst(
          snapData?.spirit_stones,
          wallet?.spirit_stones,
          snapData?.resources?.spirit_stones,
          snapData?.wallet?.spirit_stones,
          finalStones
        );
          
        finalLevel = pickFirst(
          snapChar?.level_reach,
          snapChar?.level,
          snapChar?.rank,
          snapChar?.realm,
          snapChar?.cultivation_rank,
          snapData?.level,
          snapData?.level_reach,
          finalLevel
        );

        finalGold = pickFirst(
          snapData?.sect_contribution?.points,
          wallet?.sect_contribution,
          wallet?.gold,
          wallet?.bac,
          snapData?.resources?.bac,
          snapData?.bac,
          finalGold
        );

        finalVip = pickFirst(
          snapData?.vip_level,
          snapData?.vip,
          snapChar?.vip_level,
          snapChar?.vip,
          snapData?.account?.vip_level,
          snapData?.account?.vip,
          snapData?.profile?.vip_level,
          snapData?.profile?.vip,
          finalVip
        );

        finalHp = pickFirst(snapChar?.hp, snapData?.hp, snapData?.current_hp, finalHp);
        finalMaxHp = pickFirst(snapChar?.max_hp, snapData?.max_hp, finalMaxHp);
        finalMp = pickFirst(snapChar?.mp, snapData?.mp, snapData?.current_mp, finalMp);
        finalMaxMp = pickFirst(snapChar?.max_mp, snapData?.max_mp, finalMaxMp);
        const combatStats = extractCombatStats(snapData, snapChar, { atk: finalAtk, def: finalDef });
        finalAtk = pickFirst(combatStats.atk, finalAtk);
        finalDef = pickFirst(combatStats.def, finalDef);
        const finalPathStats = getHomeFinalStats(snapData);
        if (finalPathStats?.atk !== undefined || finalPathStats?.def !== undefined) {
          addAccountLog(acc.id, "STATS", "DEBUG", `Đọc ATK/DEF từ home snapshot stats.final: ATK ${formatNumber(finalPathStats?.atk)}, DEF ${formatNumber(finalPathStats?.def)}.`);
        }
        const snapshotTalent = extractDominantTalent(getHomeTalentStats(snapData), dominantElement);
        dominantElement = pickFirst(snapshotTalent.key, dominantElement);
        dominantElementScore = pickFirst(snapshotTalent.value, dominantElementScore);

        const expPair = extractExpPair(snapData);
        finalExpCurrent = pickFirst(expPair.current, finalExpCurrent);
        finalExpMax = pickFirst(expPair.max, finalExpMax);
        if (expPair.current !== null && expPair.max !== null) {
          addAccountLog(acc.id, "EXP", "DEBUG", `Đọc EXP từ home snapshot: ${formatNumber(expPair.current)}/${formatNumber(expPair.max)}.`);
        } else {
          addAccountLog(acc.id, "EXP", "DEBUG", "Chưa map được EXP từ home snapshot, sẽ thử rebirth progress.", { expCandidates: getExpDebugCandidates(snapData) });
        }

        addAccountLog(acc.id, "INFO", "SUCCESS", `Snapshot OK: cấp ${finalLevel}, VIP ${finalVip}, linh thạch ${formatNumber(finalStones)}.`);
      } else {
        addAccountLog(acc.id, "INFO", "WARN", "Không lấy được home snapshot, tiếp tục lấy rank.");
      }

      // 3. Lấy rank/cấp bậc đúng từ rebirth quest progress
      addAccountLog(acc.id, "RANK", "INFO", "Đang lấy rank_label từ rebirth quest progress.");
      const tsRes = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_get_rebirth_quest_progress`, {
        method: "POST",
        headers: {
          "apikey": GAME_API_KEY,
          "authorization": `Bearer ${token}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": "supabase-flutter/2.12.0"
        },
        body: JSON.stringify({ p_character_id: charId }),
        credentials: "omit"
      });
      
      let rbRank = acc.rebirthRank;
      let rankLabel: number | string = acc.rankLabel ?? "?";
      let totalScore: number | string = acc.totalScore ?? "?";
      let realmCode = acc.realmCode;
      let realmLabel = acc.realmLabel;
      let realmTier = acc.realmTier;
      let requiredToken = acc.requiredToken;
      let sectName = acc.sectName;
      let daoCoTotal = acc.daoCoTotal;
      let tokens: WalletTokens = acc.tokens || {};

      if (tsRes.ok) {
        const tsData = await tsRes.json();
        rankLabel = pickFirst(tsData?.quest?.rank_label, rankLabel, "?");
        totalScore = pickFirst(tsData?.quest?.total_score, totalScore, "?");
        rbRank = `${rankLabel} (${totalScore})`;
        realmCode = pickFirst(tsData?.realm_code, realmCode);
        realmLabel = formatRealmLabel(realmCode);
        realmTier = inferAccountRealmTier({ realmTier, realmCode, realmLabel, realm_level: snapshotRealmLevel, realm_name: snapshotRealmName, level: finalLevel });
        requiredToken = pickFirst(tsData?.required_token, requiredToken);
        sectName = pickFirst(tsData?.sect_name, sectName);
        daoCoTotal = pickFirst(tsData?.dao_co?.total, daoCoTotal);
        const dominantTalent = extractDominantTalent(tsData?.talent, dominantElement);
        dominantElement = pickFirst(dominantTalent.key, tsData?.talent?.dominant_element, dominantElement);
        dominantElementScore = pickFirst(dominantTalent.value, dominantElementScore);
        tokens = {
          copper: pickFirst(tsData?.tokens?.copper, tokens?.copper, 0),
          silver: pickFirst(tsData?.tokens?.silver, tokens?.silver, 0),
          gold: pickFirst(tsData?.tokens?.gold, tokens?.gold, 0),
          diamond: pickFirst(tsData?.tokens?.diamond, tokens?.diamond, 0),
          chaos: pickFirst(tsData?.tokens?.chaos, tokens?.chaos, 0),
          platinum: pickFirst(tsData?.tokens?.platinum, tokens?.platinum, 0),
        };

        const rbExpPair = extractExpPair(tsData);
        finalExpCurrent = pickFirst(rbExpPair.current, finalExpCurrent);
        finalExpMax = pickFirst(rbExpPair.max, finalExpMax);
        if (rbExpPair.current !== null && rbExpPair.max !== null) {
          addAccountLog(acc.id, "EXP", "DEBUG", `Đọc EXP từ rebirth progress: ${formatNumber(rbExpPair.current)}/${formatNumber(rbExpPair.max)}.`);
        }
        addAccountLog(acc.id, "RANK", "SUCCESS", `Rank ${rankLabel}, score ${totalScore}, cảnh giới ${realmLabel}.`);
      } else {
        addAccountLog(acc.id, "RANK", "WARN", "Không lấy được rebirth quest progress.");
      }
      
      // 4. Cập nhật trạng thái cuối của Giai đoạn 1
      realmTier = inferAccountRealmTier({ realmTier, realmCode, realmLabel, realm_level: snapshotRealmLevel, realm_name: snapshotRealmName, level: finalLevel });

      updateAccount(acc.id, { 
        __resourceAuthoritative: true,
        state: "READY",
        activeTask: undefined, 
        spiritStones: Number(finalStones) || 0,
        gold: Number(finalGold) || 0,
        level: finalLevel,
        rebirthRank: rbRank,
        rankLabel,
        totalScore,
        realmCode,
        realmLabel,
        realmTier,
        vipLevel: finalVip,
        tokens,
        requiredToken,
        sectName,
        daoCoTotal,
        dominantElement,
        dominantElementScore,
        atk: finalAtk,
        def: finalDef,
        hp: finalHp,
        maxHp: finalMaxHp,
        mp: finalMp,
        maxMp: finalMaxMp,
        expCurrent: finalExpCurrent,
        expMax: finalExpMax,
        characterName: currentName,
        errorMessage: undefined,
      });
      addAccountLog(acc.id, "PHASE1", "SUCCESS", forceFreshLogin ? "Hoàn tất kiểm tra lại: đã lấy thông tin mới nhất." : "Hoàn tất lấy thông tin tài khoản giai đoạn 1.");
      return true;
      
    } catch (error: any) {
      console.error("API Error:", error);
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message });
      addAccountLog(acc.id, "PHASE1", "ERROR", error.message || "Lỗi không xác định.");
      return false;
    }
  };

  const handleAddAccounts = () => {
    const lines = addInput.split('\n').map(l => l.trim()).filter(l => l);
    const newAccs: Account[] = [];
    lines.forEach(line => {
      const [email, password] = line.split('|');
      if (email) {
        const newId = Date.now().toString() + Math.random().toString(36).substring(7);
        newAccs.push({
          id: newId,
          email,
          password: password || "",
          state: "IDLE",
          level: "?",
          rankLabel: "?",
          totalScore: "?",
          rebirthRank: "?",
          realmCode: "?",
          realmLabel: "?",
          vipLevel: "?",
          gold: 0,
          spiritStones: 0,
          expCurrent: "?",
          expMax: "?",
          tokens: { copper: 0, silver: 0, gold: 0, diamond: 0, chaos: 0, platinum: 0 },
          features: JSON.parse(JSON.stringify(defaultFeaturesState)),
          logs: [createLogEntry({
            accountId: newId,
            accountLabel: email.split("@")[0],
            module: "ACCOUNT",
            level: "INFO",
            message: "Đã thêm tài khoản vào dashboard.",
          })]
        });
      }
    });
    
    if (newAccs.length > 0) {
      setAccounts(prev => [...prev, ...newAccs]);
    }
    setIsAddModalOpen(false);
    setAddInput("");
  };


  const getSelectedFeatureTitle = (featureId?: string | null) => {
    const allFeatures = Object.values(featuresDef).flat();
    return allFeatures.find(item => item.id === featureId)?.label || featureId || "Chức năng";
  };

  const getFeatureModules = (featureId?: string | null) => {
    const map: Record<string, string[]> = {
      claim_exp: ["CLAIM_EXP"],
      world_cup_checkin: ["WORLD_CUP"],
      onboarding_claim: ["ONBOARDING"],
      body_cult: ["BODY_CULT"],
      achievement: ["ACHIEVEMENT"],
      world_boss: ["WORLD_BOSS"],
      mail_giftcode: ["MAIL_GIFTCODE", "MAIL", "GIFTCODE"],
      me_cung: ["MAZE"],
      ki_ngo: ["KI_NGO", "KÌ_NGỘ", "KY_NGO"],
      farm: ["FARM"],
      buff: ["BUFF"],
      auto_equip: ["AUTO_EQUIP", "EQUIP"],
      craft: ["CRAFT"],
      origin: ["ORIGIN"],
      breakthrough: ["BREAKTHROUGH"],
    };

    return map[featureId || ""] || [String(featureId || "").toUpperCase()];
  };

  const getSummaryAccounts = () => {
    if (viewingAccount) return [viewingAccount];
    if (checkedAccountIds.size > 0) return accounts.filter(acc => checkedAccountIds.has(acc.id));
    return [];
  };

  const getFeatureLogs = (featureId?: string | null) => {
    const modules = getFeatureModules(featureId);
    return getSummaryAccounts()
      .flatMap(acc => acc.logs || [])
      .filter(log => modules.includes(log.module))
      .slice(0, 80);
  };

  const deepFindNumber = (obj: any, includes: string[], excludes: string[] = []): number | null => {
    const seen = new Set<any>();

    const walk = (value: any): number | null => {
      if (!value || typeof value !== "object" || seen.has(value)) return null;
      seen.add(value);

      for (const [key, raw] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        const matched = includes.some(part => lowerKey.includes(part));
        const blocked = excludes.some(part => lowerKey.includes(part));
        if (matched && !blocked) {
          const n = Number(raw);
          if (Number.isFinite(n)) return n;
        }

        if (raw && typeof raw === "object") {
          const nested = walk(raw);
          if (nested !== null) return nested;
        }
      }

      return null;
    };

    return walk(obj);
  };

  const getClaimExpProgress = () => {
    const accountCurrent = parseFiniteNumber(viewingAccount?.expCurrent);
    const accountMax = parseFiniteNumber(viewingAccount?.expMax);

    if (accountCurrent !== null && accountMax !== null && accountMax > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((accountCurrent / accountMax) * 100)));
      return { current: accountCurrent, max: accountMax, percent, text: `${formatNumber(accountCurrent)}/${formatNumber(accountMax)} (${percent}%)` };
    }

    const task = viewingAccount?.dailyLastRun?.tasks?.find(item => item.key === "claim_exp");
    const data = task?.data || {};
    const sources = [
      data?.snapshot,
      data?.homeSnapshot,
      data?.afterSnapshot,
      data?.claim,
      data?.result,
      data,
      viewingAccount?.dailyLastRun,
      viewingAccount,
    ];

    for (const source of sources) {
      const expPair = extractExpPair(source);
      const current = expPair.current;
      const max = expPair.max;

      if (current !== null && max !== null && max > 0) {
        const percent = Math.min(100, Math.max(0, Math.round((current / max) * 100)));
        return { current, max, percent, text: `${formatNumber(current)}/${formatNumber(max)} (${percent}%)` };
      }

      if (expPair.percent !== undefined && expPair.percent !== null) {
        const percent = Math.min(100, Math.max(0, Math.round(expPair.percent)));
        return { current: null, max: null, percent, text: `${percent}%` };
      }
    }

    return { current: null, max: null, percent: 0, text: "Chưa đọc được EXP - xem log EXP DEBUG để map đúng field" };
  };

  const getKiNgoProgress = () => {
    const cached = viewingAccount?.features?.ki_ngo?.settings || {};
    const cachedUsed = toKiNgoProgressNumber(cached.daily_count ?? cached.used_count ?? cached.current_count);
    const cachedLimit = toKiNgoProgressNumber(cached.daily_limit ?? cached.max_count ?? cached.limit_count);

    if (cachedUsed !== undefined || cachedLimit !== undefined) {
      const safeUsed = cachedUsed ?? 0;
      const safeLimit = cachedLimit ?? 0;
      const percent = safeLimit > 0 ? Math.min(100, Math.max(0, Math.round((safeUsed / safeLimit) * 100))) : 0;
      return {
        used: safeUsed,
        limit: safeLimit,
        percent,
        text: safeLimit > 0 ? `${formatNumber(safeUsed)}/${formatNumber(safeLimit)} (${percent}%)` : `${formatNumber(safeUsed)}/?`,
        source: "cache",
      };
    }

    const logs = getFeatureLogs("ki_ngo");

    const findNumber = (source: any, keys: string[]) => {
      if (!source) return null;
      for (const key of keys) {
        const n = deepFindNumber(source, [key], []);
        if (n !== null) return n;
      }
      return null;
    };

    for (const log of logs) {
      const meta = log.meta || {};
      const used = findNumber(meta, ["daily_count", "current", "used", "count", "today_count", "trigger_count"]);
      const limit = findNumber(meta, ["daily_limit", "max", "limit", "cap", "today_limit"]);

      if (used !== null || limit !== null) {
        const safeUsed = used ?? 0;
        const safeLimit = limit ?? 0;
        const percent = safeLimit > 0 ? Math.min(100, Math.max(0, Math.round((safeUsed / safeLimit) * 100))) : 0;
        return {
          used: safeUsed,
          limit: safeLimit,
          percent,
          text: safeLimit > 0 ? `${formatNumber(safeUsed)}/${formatNumber(safeLimit)} (${percent}%)` : `${formatNumber(safeUsed)}/?`,
          source: "meta",
        };
      }
    }

    const text = logs.map(log => log.message).join("\n");
    const matched = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (matched) {
      const used = Number(matched[1]);
      const limit = Number(matched[2]);
      const percent = limit > 0 ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : 0;
      return {
        used,
        limit,
        percent,
        text: `${formatNumber(used)}/${formatNumber(limit)} (${percent}%)`,
        source: "message",
      };
    }

    return {
      used: null,
      limit: null,
      percent: 0,
      text: "Chưa có dữ liệu lượt Kì ngộ",
      source: "none",
    };
  };

  const getFeatureMiniStats = (featureId?: string | null) => {
    const relatedLogs = getFeatureLogs(featureId);
    const accountsInScope = getSummaryAccounts();
    const successCount = relatedLogs.filter(log => log.level === "SUCCESS").length;
    const failCount = relatedLogs.filter(log => log.level === "ERROR").length;
    const warnCount = relatedLogs.filter(log => log.level === "WARN").length;
    const runningCount = accountsInScope.filter(acc => acc.features?.[featureId || ""]?.status === "IN_PROGRESS").length;
    const waitingCount = accountsInScope.filter(acc => acc.features?.[featureId || ""]?.status === "WAITING").length;
    const doneCount = accountsInScope.filter(acc => acc.features?.[featureId || ""]?.status === "DONE").length;
    const pendingCount = accountsInScope.filter(acc => acc.features?.[featureId || ""]?.status === "PENDING").length;
    const recent = relatedLogs.slice(0, 6);

    let primary = "Đang chờ";
    let primaryClass = "text-gray-300";

    if (runningCount > 0) {
      primary = `Đang chạy (${runningCount})`;
      primaryClass = "text-cyan-300";
    } else if (waitingCount > 0) {
      primary = `Đang chờ (${waitingCount})`;
      primaryClass = "text-purple-300";
    } else if (doneCount > 0) {
      primary = `Đã chạy (${doneCount})`;
      primaryClass = "text-green-300";
    } else if (pendingCount > 0) {
      primary = `Đang chờ (${pendingCount})`;
      primaryClass = "text-yellow-300";
    }

    return { relatedLogs, successCount, failCount, warnCount, runningCount, waitingCount, doneCount, pendingCount, recent, primary, primaryClass };
  };

  const renderProgressBar = (percent: number, className = "bg-green-500") => (
    <div className="h-2 w-full overflow-hidden rounded bg-gray-900 border border-gray-700">
      <div className={`h-full ${className}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );

  const renderFeatureSummaryPanel = () => {
    const accountsInScope = getSummaryAccounts();
    const featureTitle = getSelectedFeatureTitle(selectedFeatureId);
    const stats = getFeatureMiniStats(selectedFeatureId);
    const expProgress = getClaimExpProgress();

    const emptyScope = accountsInScope.length === 0;

    return (
      <div className="rounded border border-gray-700 bg-gray-800/50 p-4 space-y-3 h-fit">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Tổng quan chạy</h3>
            <p className="text-[11px] text-gray-500">
              {viewingAccount ? getCharacterName(viewingAccount) : checkedAccountIds.size > 0 ? `${checkedAccountIds.size} tài khoản đã chọn` : "Chưa chọn tài khoản"}
            </p>
          </div>
          <span className={`text-xs px-2 py-1 rounded bg-gray-900 border border-gray-700 ${stats.primaryClass}`}>
            {stats.primary}
          </span>
        </div>

        <div className="rounded bg-gray-900/60 border border-gray-700 p-3">
          <div className="text-xs text-gray-500 mb-2">{featureTitle}</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded bg-gray-950/70 border border-gray-800 p-2">
              <div className="text-green-300 text-lg font-semibold">{stats.successCount}</div>
              <div className="text-[10px] text-gray-500">Thành công</div>
            </div>
            <div className="rounded bg-gray-950/70 border border-gray-800 p-2">
              <div className="text-yellow-300 text-lg font-semibold">{stats.warnCount}</div>
              <div className="text-[10px] text-gray-500">Cảnh báo</div>
            </div>
            <div className="rounded bg-gray-950/70 border border-gray-800 p-2">
              <div className="text-red-300 text-lg font-semibold">{stats.failCount}</div>
              <div className="text-[10px] text-gray-500">Thất bại</div>
            </div>
          </div>
        </div>

        {selectedFeatureId === "claim_exp" && (
          <div className="rounded bg-green-950/10 border border-green-900/50 p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-green-200 font-medium">Tiến độ EXP</span>
              <span className="text-gray-300">{expProgress.text}</span>
            </div>
            {renderProgressBar(expProgress.percent, "bg-green-500")}
          </div>
        )}

        {selectedFeatureId === "ki_ngo" && (
          <div className="rounded bg-fuchsia-950/10 border border-fuchsia-900/50 p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-fuchsia-200 font-medium">Tiến độ Kì ngộ hôm nay</span>
              <span className="text-gray-300">{getKiNgoProgress().text}</span>
            </div>
            {renderProgressBar(getKiNgoProgress().percent, "bg-fuchsia-500")}
            <p className="text-[11px] text-gray-500">
              Lấy từ log/meta của lần chạy Kì ngộ gần nhất. Ví dụ: đã chạy / giới hạn tối đa trong ngày.
            </p>
          </div>
        )}

        {selectedFeatureId === "body_cult" && viewingAccount && (
          <div className="rounded bg-orange-950/10 border border-orange-900/50 p-3 space-y-1">
            <div className="text-xs text-orange-200 font-medium">Cache Thể tu</div>
            <div className="text-sm text-gray-200">
              Còn lại: {formatNumber(viewingAccount.features?.body_cult?.settings?.remaining_seconds ?? viewingAccount.dailyLastRun?.tasks?.find(item => item.key === "body_cult")?.data?.remainingSeconds ?? "?")} giây
            </div>
            <div className="text-[11px] text-gray-500">
              Thu hoạch lúc: {viewingAccount.features?.body_cult?.settings?.next_harvest_at || viewingAccount.dailyLastRun?.tasks?.find(item => item.key === "body_cult")?.data?.nextHarvestAt || "chưa có"}
            </div>
          </div>
        )}


        {selectedFeatureId === "farm" && viewingAccount?.farmSessionStats && (
          <div className="rounded border border-emerald-700/60 bg-emerald-950/20 p-3 text-xs text-gray-300 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-emerald-200 font-medium">Tổng phiên Farm hiện tại</div>
              <div className="text-[10px] text-gray-500">chỉ tính mob đã THỰC SỰ đánh/kill</div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded bg-gray-950/70 border border-gray-800 p-2"><div className="text-cyan-300 text-lg font-semibold">{viewingAccount.farmSessionStats.attacks || 0}</div><div className="text-[10px] text-gray-500">Lượt đánh thật</div></div>
              <div className="rounded bg-gray-950/70 border border-gray-800 p-2"><div className="text-green-300 text-lg font-semibold">{viewingAccount.farmSessionStats.kills || 0}</div><div className="text-[10px] text-gray-500">Kill thật</div></div>
              <div className="rounded bg-gray-950/70 border border-gray-800 p-2"><div className="text-red-300 text-lg font-semibold">{viewingAccount.farmSessionStats.bossKills || 0}</div><div className="text-[10px] text-gray-500">Boss kill</div></div>
              <div className="rounded bg-gray-950/70 border border-gray-800 p-2"><div className="text-purple-300 text-lg font-semibold">{viewingAccount.farmSessionStats.eliteKills || 0}</div><div className="text-[10px] text-gray-500">Elite kill</div></div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded bg-gray-950/60 border border-gray-800 p-2"><div className="text-green-300 text-base font-semibold">{viewingAccount.farmSessionStats.observedKills || 0}</div><div className="text-[10px] text-gray-500">Observed kill</div></div>
              <div className="rounded bg-gray-950/60 border border-gray-800 p-2"><div className="text-red-300 text-base font-semibold">{viewingAccount.farmSessionStats.observedBossKills || 0}</div><div className="text-[10px] text-gray-500">Obs Boss</div></div>
              <div className="rounded bg-gray-950/60 border border-gray-800 p-2"><div className="text-purple-300 text-base font-semibold">{viewingAccount.farmSessionStats.observedEliteKills || 0}</div><div className="text-[10px] text-gray-500">Obs Elite</div></div>
              <div className="rounded bg-gray-950/60 border border-gray-800 p-2"><div className="text-gray-300 text-base font-semibold">{viewingAccount.farmSessionStats.observedNormalKills || 0}</div><div className="text-[10px] text-gray-500">Obs Normal</div></div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div>Normal kill: <span className="text-gray-200">{viewingAccount.farmSessionStats.normalKills || 0}</span></div>
              <div>Scan realm: <span className="text-gray-200">{viewingAccount.farmSessionStats.scans || 0}</span></div>
              <div>Bình MP dùng: <span className="text-blue-300">{viewingAccount.farmSessionStats.mpPotions || 0}</span></div>
            </div>
            <div className="rounded bg-gray-950/50 border border-gray-800 p-2 text-[11px] text-gray-400">
              Lưu ý: dòng <span className="text-gray-200">Observed</span> là số đối chiếu bằng snapshot sau attack. Nếu game thực tế cộng nhầm elite/normal, nó sẽ hiện ở Obs Elite/Obs Normal và mismatch.
            </div>
            {viewingAccount.farmSessionStats.lastTarget && <div className="text-[11px] text-gray-400">Đánh gần nhất: <span className="text-gray-200">{viewingAccount.farmSessionStats.lastTarget.mobName || viewingAccount.farmSessionStats.lastTarget.mobId}</span> <span className="text-gray-500">({viewingAccount.farmSessionStats.lastTarget.realmCode})</span> <span className="text-gray-500">[{viewingAccount.farmSessionStats.lastTarget.mobType}{viewingAccount.farmSessionStats.lastTarget.killed ? ", killed" : ", hit"}{viewingAccount.farmSessionStats.lastTarget.observedKind ? `, observed=${viewingAccount.farmSessionStats.lastTarget.observedKind}` : ""}{viewingAccount.farmSessionStats.lastTarget.mobHpAfter !== undefined && viewingAccount.farmSessionStats.lastTarget.mobHpAfter !== null ? `, hp=${viewingAccount.farmSessionStats.lastTarget.mobHpAfter}` : ""}{viewingAccount.farmSessionStats.lastTarget.dropItemCode ? `, drop=${viewingAccount.farmSessionStats.lastTarget.dropItemCode}` : ""}]</span></div>}
          </div>
        )}

        {selectedFeatureId === "farm" && viewingAccount?.farmLastRun && (
          <div className="rounded border border-green-900/50 bg-green-950/10 p-3 text-xs text-gray-300 space-y-1">
            <div className="text-xs text-green-200 font-medium">Vòng Farm gần nhất</div>
            <div>Mode: <span className="text-gray-200">{viewingAccount.farmLastRun.effectiveMode}</span></div>
            <div>Kênh: <span className="text-gray-200">{viewingAccount.farmLastRun.channels?.join(", ") || "?"}</span></div>
            <div>Ưu tiên: <span className="text-gray-200">{viewingAccount.farmLastRun.priority?.join(" > ") || "?"}</span></div>
            <div>Attack vòng này: <span className="text-gray-200">{viewingAccount.farmLastRun.attackCount || 0}</span></div>
            <div>Kill vòng này: <span className="text-green-300">{viewingAccount.farmLastRun.killedCount || 0}</span> <span className="text-gray-500">(boss {viewingAccount.farmLastRun.killedBossCount || 0}, elite {viewingAccount.farmLastRun.killedEliteCount || 0}, normal {viewingAccount.farmLastRun.killedNormalCount || 0})</span></div>
            <div>Observed vòng này: <span className="text-green-300">{viewingAccount.farmLastRun.observedKilledCount || 0}</span> <span className="text-gray-500">(boss {viewingAccount.farmLastRun.observedKilledBossCount || 0}, elite {viewingAccount.farmLastRun.observedKilledEliteCount || 0}, normal {viewingAccount.farmLastRun.observedKilledNormalCount || 0}, mismatch {viewingAccount.farmLastRun.intendedObservedMismatchCount || 0})</span></div>
            <div>Dùng bình MP: <span className="text-blue-300">{viewingAccount.farmLastRun.mpPotionUsedCount || 0}</span></div>
            <div>Mua bình MP: <span className="text-purple-300">{viewingAccount.farmLastRun.mpPotionBoughtCount || 0}</span>{viewingAccount.farmLastRun.mpPotionBuySpent ? <span className="text-gray-500"> (-{viewingAccount.farmLastRun.mpPotionBuySpent} KC)</span> : null}</div>
            <div>Scan realm: <span className="text-gray-200">{viewingAccount.farmLastRun.scannedRealmCount || 0}</span></div>
            <div>Mob bị account khác giữ: <span className="text-yellow-300">{viewingAccount.farmLastRun.skippedLockedCount || 0}</span></div>
            {viewingAccount.farmLastRun.lastTarget && <div>Target cuối: <span className="text-gray-200">{viewingAccount.farmLastRun.lastTarget.mobName || viewingAccount.farmLastRun.lastTarget.mobId}</span> <span className="text-gray-500">({viewingAccount.farmLastRun.lastTarget.realmCode})</span> <span className="text-gray-500">[{viewingAccount.farmLastRun.lastTarget.mobType}{viewingAccount.farmLastRun.lastTarget.killed ? ", killed" : ""}{viewingAccount.farmLastRun.lastTarget.mobHpAfter !== undefined && viewingAccount.farmLastRun.lastTarget.mobHpAfter !== null ? `, hp=${viewingAccount.farmLastRun.lastTarget.mobHpAfter}` : ""}]</span></div>}
          </div>
        )}

        {selectedFeatureId === "world_boss" && viewingAccount?.worldBossLastRun && (
          <div className="rounded bg-red-950/10 border border-red-900/50 p-3 grid grid-cols-2 gap-2 text-xs">
            <div>Tier: <span className="text-gray-200">{viewingAccount.worldBossLastRun.tiers?.join(", ") || "?"}</span></div>
            <div>Attack: <span className="text-gray-200">{viewingAccount.worldBossLastRun.attackCount || 0}</span></div>
            <div>Quà: <span className={viewingAccount.worldBossLastRun.claimed ? "text-green-300" : "text-yellow-300"}>{viewingAccount.worldBossLastRun.claimCount || 0}</span></div>
            <div>Linh thạch: <span className="text-green-300 font-semibold">{formatNumber((viewingAccount.worldBossLastRun as any).claimStones || 0)}</span></div>
            <div className="col-span-2">Status: <span className="text-gray-200">{viewingAccount.worldBossLastRun.status}</span></div>
          </div>
        )}

        {selectedFeatureId === "mail_giftcode" && (
          <div className="rounded bg-purple-950/10 border border-purple-900/50 p-3 grid grid-cols-2 gap-2 text-xs">
            <div>Mail claim: <span className="text-green-300">{viewingAccount?.mailLastRun?.claimedCount ?? 0}</span></div>
            <div>Mail lỗi: <span className="text-red-300">{viewingAccount?.mailLastRun?.errorCount ?? 0}</span></div>
            <div>Code OK: <span className="text-green-300">{viewingAccount?.giftcodeLastRun?.successCount ?? 0}</span></div>
            <div>Code lỗi: <span className="text-yellow-300">{viewingAccount?.giftcodeLastRun?.failCount ?? 0}</span></div>
          </div>
        )}

        {selectedFeatureId === "auto_equip" && viewingAccount?.autoEquipLastRun && (
          <div className="rounded bg-emerald-950/10 border border-emerald-900/50 p-3 grid grid-cols-2 gap-2 text-xs">
            <div>Scan item: <span className="text-gray-200">{viewingAccount.autoEquipLastRun.scannedCount}</span></div>
            <div>Trang bị: <span className="text-gray-200">{viewingAccount.autoEquipLastRun.equipmentCount}</span></div>
            <div>Đã mặc: <span className="text-green-300">{viewingAccount.autoEquipLastRun.equippedCount}</span></div>
            <div>Bỏ qua: <span className="text-yellow-300">{viewingAccount.autoEquipLastRun.skippedCount}</span></div>
            <div>Tăng điểm: <span className="text-green-300 font-semibold">{formatNumber(viewingAccount.autoEquipLastRun.totalGain)}</span></div>
            <div>Lỗi: <span className="text-red-300">{viewingAccount.autoEquipLastRun.errors?.length || 0}</span></div>
            <div className="col-span-2">Status: <span className="text-gray-200">{viewingAccount.autoEquipLastRun.status}</span></div>
          </div>
        )}

        {selectedFeatureId === "craft" && viewingAccount?.craftLastRun && (
          <div className="rounded bg-orange-950/10 border border-orange-900/50 p-3 grid grid-cols-2 gap-2 text-xs">
            <div>Recipe: <span className="font-mono text-orange-200">{viewingAccount.craftLastRun.recipeCode || "?"}</span></div>
            <div>Tier: <span className="text-gray-200">{viewingAccount.craftLastRun.tierCode || "?"}</span></div>
            <div>Success: <span className="text-green-300">{viewingAccount.craftLastRun.successCount || 0}</span></div>
            <div>Fail: <span className="text-yellow-300">{viewingAccount.craftLastRun.failCount || 0}</span></div>
            <div>Rate: <span className="text-gray-200">{viewingAccount.craftLastRun.rate ?? "?"}</span></div>
            <div>Status: <span className="text-gray-200">{viewingAccount.craftLastRun.status}</span></div>
            <div className="col-span-2">Reward: <span className="font-mono text-green-300">{viewingAccount.craftLastRun.rewards?.map(item => `${item.code || "?"} x${item.qty || 1}`).join(", ") || "?"}</span></div>
          </div>
        )}


        {selectedFeatureId === "breakthrough" && viewingAccount?.breakthroughLastRun && (
          <div className="rounded bg-yellow-950/10 border border-yellow-900/50 p-3 grid grid-cols-2 gap-2 text-xs">
            <div>Status: <span className="text-gray-200">{viewingAccount.breakthroughLastRun.status}</span></div>
            <div>Level: <span className="text-gray-200">{formatNumber(viewingAccount.breakthroughLastRun.level)}</span></div>
            <div>EXP: <span className="text-gray-200">{formatNumber(viewingAccount.breakthroughLastRun.expCurrent)}/{formatNumber(viewingAccount.breakthroughLastRun.expMax)}</span></div>
            <div>%: <span className="text-gray-200">{viewingAccount.breakthroughLastRun.expPercent !== undefined ? viewingAccount.breakthroughLastRun.expPercent.toFixed(2) : "?"}</span></div>
            <div>Đan: <span className="font-mono text-yellow-200">{viewingAccount.breakthroughLastRun.pillItemCode || "?"}</span></div>
            <div>Mua: <span className={viewingAccount.breakthroughLastRun.boughtPill ? "text-green-300" : "text-gray-400"}>{viewingAccount.breakthroughLastRun.boughtPill ? "có" : "không"}</span></div>
            <div className="col-span-2">Lần sau: <span className="text-gray-200">{Math.ceil((viewingAccount.breakthroughLastRun.nextDelayMs || 0) / 1000)} giây</span></div>
          </div>
        )}

        <div className="rounded bg-gray-950/60 border border-gray-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-300">Log mini</span>
            <span className="text-[10px] text-gray-500">6 dòng mới nhất</span>
          </div>
          <div className="space-y-1 max-h-44 overflow-auto">
            {emptyScope ? (
              <div className="text-xs text-gray-500">Chọn một tài khoản hoặc tick nhiều tài khoản để xem tổng quan.</div>
            ) : stats.recent.length === 0 ? (
              <div className="text-xs text-gray-500">Chưa có log cho chức năng này.</div>
            ) : (
              stats.recent.map(log => (
                <div key={log.id} className="text-[11px] rounded bg-gray-900/70 border border-gray-800 px-2 py-1">
                  <div className="flex justify-between gap-2">
                    <span className={log.level === "SUCCESS" ? "text-green-300" : log.level === "ERROR" ? "text-red-300" : log.level === "WARN" ? "text-yellow-300" : "text-gray-400"}>{log.level}</span>
                    <span className="text-gray-600">{log.time}</span>
                  </div>
                  <div className="text-gray-300 line-clamp-2">{log.message}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-400">
          <div className="rounded bg-gray-900/60 border border-gray-800 p-2">Linh thạch: <span className="text-gray-200">{viewingAccount ? formatNumber(viewingAccount.spiritStones) : "-"}</span></div>
          <div className="rounded bg-gray-900/60 border border-gray-800 p-2">Bạc/điểm: <span className="text-gray-200">{viewingAccount ? formatNumber(viewingAccount.gold) : "-"}</span></div>
        </div>
      </div>
    );
  };


  const renderResources = (acc: Account) => {
    const tokenParts = [
      acc.tokens?.copper !== undefined ? `Cu ${formatNumber(acc.tokens.copper)}` : null,
      acc.tokens?.silver !== undefined ? `Ag ${formatNumber(acc.tokens.silver)}` : null,
      acc.tokens?.diamond !== undefined ? `Dia ${formatNumber(acc.tokens.diamond)}` : null,
    ].filter(Boolean);

    return (
      <div className="flex flex-col gap-1 text-gray-300 text-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1" title="Cống Hiến / Bạc / Điểm tông môn">
            <Coins size={14} className="text-yellow-500" />
            <span>{formatNumber(acc.gold)}</span>
          </div>
          <div className="flex items-center gap-1" title="Linh Thạch / Spirit Stones">
            <Gem size={14} className="text-blue-400" />
            <span>{formatNumber(acc.spiritStones)}</span>
          </div>
        </div>
        {tokenParts.length > 0 && (
          <div className="text-[10px] text-gray-500" title="Token trùng sinh">
            {tokenParts.join(" · ")}
          </div>
        )}
      </div>
    );
  };

  const deleteSelectedAccounts = () => {
    if (checkedAccountIds.size === 0) return;
    // Removed window.confirm to ensure it works within the iframe preview
    setAccounts(prev => prev.filter(acc => !checkedAccountIds.has(acc.id)));
    checkedAccountIds.forEach(id => {
      clearAccountTimers(id);
      delete runtimeState.current[id];
    });
    setCheckedAccountIds(new Set());
    if (viewingAccountId && checkedAccountIds.has(viewingAccountId)) {
      setViewingAccountId(null);
    }
  };

  const startSelectedAccounts = async () => {
    if (checkedAccountIds.size === 0) return;

    const targetAccounts = accounts.filter(acc => checkedAccountIds.has(acc.id));
    targetAccounts.forEach(acc => {
      addAccountLog(acc.id, "CHECK", "INFO", "Bấm Kiểm tra: đăng nhập/lấy thông tin mới đồng loạt.");
      updateAccount(acc.id, { state: "LOGGING_IN", activeTask: "Kiểm tra lại", errorMessage: undefined });
    });

    await Promise.allSettled(
      targetAccounts.map(acc => startAccountWorkflow(acc, true))
    );
  };



  const getFeatureSettings = (acc: Account, featureId: string, override?: Record<string, any>) => {
    // Luôn merge default trước để account cũ chưa có setting mới vẫn dùng được.
    // Farm mới dùng 4 base_code thật qua rpc_list_realm_channels.
    // Merge default để account cũ tự nhận setting mới và cache vùng farm đúng.
    return { ...(defaultFeaturesState[featureId]?.settings || {}), ...(acc.features[featureId]?.settings || {}), ...(override || {}) };
  };

  const craftTierOptions = [
    { value: "all", label: "Tất cả tier" },
    { value: "lk", label: "Tier 1 - Luyện Khí (lk)" },
    { value: "tc", label: "Tier 2 - Trúc Cơ (tc)" },
    { value: "kd", label: "Tier 3 - Kim Đan (kd)" },
    { value: "na", label: "Tier 4 - Nguyên Anh (na)" },
    { value: "ht", label: "Tier 5 - Hoá Thần (ht)" },
    { value: "lh", label: "Tier 6 - Luyện Hư (lh)" },
  ];

  const getCraftRecipeCache = (settings: Record<string, any>) => {
    const rows = Array.isArray(settings.recipe_cache) ? settings.recipe_cache : [];
    return rows;
  };

  const getFilteredCraftRecipes = (settings: Record<string, any>) => {
    return filterCraftRecipes(
      getCraftRecipeCache(settings),
      String(settings.tier || "all"),
      String(settings.recipe_search || "")
    );
  };

  const loadCraftRecipesForAccount = async (accountId: string, settingsOverride?: Record<string, any>) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return [];
    const runtime = await ensureRuntimeAccount(acc.id, "CRAFT");
    if (!runtime) return [];

    const settings = getFeatureSettings(acc, "craft", settingsOverride);
    const category = String(settings.category || "alchemy");
    addAccountLog(acc.id, "CRAFT", "INFO", `Đang tải danh sách recipe ${category}...`);

    try {
      const recipes = await listCraftRecipes({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        category,
      });
      const cacheAt = new Date().toISOString();
      const nextSettings = { ...settings, recipe_cache: recipes, recipe_cache_at: cacheAt };

      setAccounts(prev => prev.map(item => {
        if (item.id !== accountId) return item;
        const current = item.features.craft || { enabled: false, status: "NOT_SELECTED", settings: {} };
        return {
          ...item,
          features: {
            ...item.features,
            craft: {
              ...current,
              settings: {
                ...(current.settings || {}),
                recipe_cache: recipes,
                recipe_cache_at: cacheAt,
              },
            },
          },
        };
      }));

      if (selectedFeatureId === "craft" && (viewingAccountId === accountId || checkedAccountIds.has(accountId))) {
        setTempSettings(prev => ({ ...prev, recipe_cache: recipes, recipe_cache_at: cacheAt }));
      }

      const counts = recipes.reduce((accum: Record<string, number>, recipe: any) => {
        const key = recipe.tierCode || "unknown";
        accum[key] = (accum[key] || 0) + 1;
        return accum;
      }, {});
      addAccountLog(acc.id, "CRAFT", "SUCCESS", `Đã tải ${recipes.length} recipe ${category}.`, { category, counts });
      return recipes;
    } catch (error: any) {
      addAccountLog(acc.id, "CRAFT", "ERROR", `Tải danh sách recipe lỗi: ${error.message || "unknown"}`, error?.data);
      return [];
    }
  };

  const runDailySingleFeatureForAccount = async (accountId: string, featureId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, featureId.toUpperCase());
    if (!runtime) return null;

    const settings = getFeatureSettings(acc, featureId, settingsOverride);
    setAccountFeatureStatus(acc.id, featureId, "IN_PROGRESS", true);

    const featureLabels: Record<string, string> = {
      claim_exp: "Claim EXP",
      world_cup_checkin: "World Cup Checkin",
      onboarding_claim: "Quà tân thủ",
      body_cult: "Thể tu",
      achievement: "Thành tựu",
    };

    const label = featureLabels[featureId] || featureId;
    updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: label, errorMessage: undefined });

    try {
      let result: DailyRunSummary;
      if (featureId === "claim_exp") {
        result = await runClaimExpAuto({ characterId: runtime.characterId, accessToken: runtime.accessToken, settings, onLog: (level, message, meta) => addAccountLog(acc.id, "CLAIM_EXP", level, message, meta) });
      } else if (featureId === "world_cup_checkin") {
        result = await runWorldCupCheckinAuto({ characterId: runtime.characterId, accessToken: runtime.accessToken, settings, onLog: (level, message, meta) => addAccountLog(acc.id, "WORLD_CUP", level, message, meta) });
      } else if (featureId === "onboarding_claim") {
        result = await runOnboardingClaimAuto({ characterId: runtime.characterId, accessToken: runtime.accessToken, settings, onLog: (level, message, meta) => addAccountLog(acc.id, "ONBOARDING", level, message, meta) });
      } else if (featureId === "body_cult") {
        result = await runBodyCultAuto({ characterId: runtime.characterId, accessToken: runtime.accessToken, settings, onLog: (level, message, meta) => addAccountLog(acc.id, "BODY_CULT", level, message, meta) });
      } else if (featureId === "achievement") {
        result = await runAchievementClaimAuto({ characterId: runtime.characterId, accessToken: runtime.accessToken, settings, onLog: (level, message, meta) => addAccountLog(acc.id, "ACHIEVEMENT", level, message, meta) });
      } else {
        addAccountLog(acc.id, "DAILY", "WARN", `Không nhận diện daily feature: ${featureId}`);
        return null;
      }

      updateAccount(acc.id, { dailyLastRun: result, errorMessage: undefined });

      if (result.successCount > 0 || result.warnCount > 0) {
        await refreshAccountResources(acc.id, featureId.toUpperCase());
      }

      const scheduledFeature = ["claim_exp", "world_cup_checkin", "body_cult", "achievement"].includes(featureId);
      setAccountFeatureStatus(acc.id, featureId, result.status === "ERROR" ? "PENDING" : scheduledFeature ? "WAITING" : "DONE", true);

      if (featureId === "claim_exp") {
        const minutes = Math.max(1, Number(settings.interval_minutes || 15));
        setFeatureTimer(accountId, featureId, minutes * 60_000, () => runDailySingleFeatureForAccount(accountId, featureId, undefined, true));
        addAccountLog(acc.id, "CLAIM_EXP", "INFO", `Claim EXP đang chạy nền, lặp lại sau ${minutes} phút.`);
      } else if (featureId === "world_cup_checkin") {
        const ms = msUntilNextVietnamMidnight();
        setFeatureTimer(accountId, featureId, ms, () => runDailySingleFeatureForAccount(accountId, featureId, undefined, true));
        addAccountLog(acc.id, "WORLD_CUP", "INFO", "World Cup Checkin đang chạy nền, sẽ check lại sau mốc 0h Việt Nam.");
      } else if (featureId === "body_cult") {
        const taskData = result.tasks?.[0]?.data || {};
        const delayMs = Math.max(60_000, Number(taskData.nextDelayMs || 0) || 10 * 60_000);
        const minutes = Math.max(1, Math.ceil(delayMs / 60_000));
        const nextHarvestAt = taskData.nextHarvestAt || new Date(Date.now() + delayMs).toISOString();

        setAccounts(prev => prev.map(item => {
          if (item.id !== acc.id) return item;
          const current = item.features.body_cult || { enabled: true, status: "WAITING", settings: {} };
          return {
            ...item,
            features: {
              ...item.features,
              body_cult: {
                ...current,
                settings: {
                  ...current.settings,
                  next_harvest_at: nextHarvestAt,
                  remaining_seconds: taskData.remainingSeconds ?? null,
                  last_mode: taskData.mode || "unknown",
                },
              },
            },
          };
        }));

        setFeatureTimer(accountId, featureId, delayMs, () => runDailySingleFeatureForAccount(accountId, featureId, undefined, true));
        addAccountLog(acc.id, "BODY_CULT", "INFO", `Đã lưu cache Thể tu. Hẹn thu hoạch/check lại sau khoảng ${minutes} phút.`, {
          nextHarvestAt,
          remainingSeconds: taskData.remainingSeconds,
          mode: taskData.mode,
        });
      } else if (featureId === "achievement") {
        const minutes = Math.max(1, Number(settings.interval_minutes || 60));
        setFeatureTimer(accountId, featureId, minutes * 60_000, () => runDailySingleFeatureForAccount(accountId, featureId, undefined, true));
        addAccountLog(acc.id, "ACHIEVEMENT", "INFO", `Thành tựu đang chạy nền, check lại sau ${minutes} phút.`);
      }

      if (scheduledFeature) {
        updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Đang chờ lần chạy tiếp theo: ${label}` });
      } else if (!fromTimer) {
        updateAccount(acc.id, { state: "READY", activeTask: undefined });
      }
      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || `Lỗi ${label}` });
      setAccountFeatureStatus(acc.id, featureId, "PENDING", true);
      addAccountLog(acc.id, "DAILY", "ERROR", error.message || `Lỗi ${label} không xác định.`, error?.data);
      return null;
    }
  };

  const runWorldBossForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "WORLD_BOSS");
    if (!runtime) return null;

    const settings = getFeatureSettings(acc, "world_boss", settingsOverride);
    setAccountFeatureStatus(acc.id, "world_boss", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "WORLD_BOSS_RUNNING", activeTask: "Boss Thế Giới", errorMessage: undefined });

    try {
      const result = await runWorldBossAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        tiers: settings.tiers || "lk,tc,kd",
        maxAttacksPerCheck: Number(settings.max_attacks_per_check || 30),
        attackDelayMs: Number(settings.attack_delay_ms || 1500),
        autoClaim: settings.auto_claim !== false,
        onLog: (level, message, meta) => {
          // Boss Thế Giới đã chạy ổn: mặc định chỉ giữ lỗi/cảnh báo quan trọng, không spam từng attack/check.
          if (level === "ERROR" || level === "WARN") {
            addAccountLog(acc.id, "WORLD_BOSS", level, message, meta);
          }
        },
      });

      if (result.claimed || result.attackCount > 0) {
        await refreshAccountResources(acc.id, "WORLD_BOSS");
      }

      const isWaitingRespawn = result.status === "WAITING_RESPAWN";
      const isError = result.status === "ERROR" || result.status === "PARTIAL_ERROR";

      updateAccount(acc.id, {
        worldBossLastRun: result,
        errorMessage: isError ? "Boss Thế Giới lỗi một phần" : undefined,
      });

      const defaultMs = Math.max(1, Number(settings.check_interval_minutes || 10)) * 60_000;
      const waitMs = isWaitingRespawn ? Math.max(60_000, Number(result.nextCheckMs || 0) || defaultMs) : defaultMs;
      const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
      const claimedStones = Number((result as any).claimStones || 0);

      addAccountLog(acc.id, "WORLD_BOSS", claimedStones > 0 ? "SUCCESS" : "INFO", `Boss Thế Giới: đã claim tổng ${formatNumber(claimedStones)} linh thạch từ boss.`, {
        claimStones: claimedStones,
        claimCount: result.claimCount || 0,
        attackCount: result.attackCount || 0,
        status: result.status,
      });

      setAccountFeatureStatus(acc.id, "world_boss", isError ? "PENDING" : "WAITING", true);
      setFeatureTimer(accountId, "world_boss", waitMs, () => runWorldBossForAccount(accountId, undefined, true));

      if (isWaitingRespawn) {
        updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Đang chờ Boss sống lại (${minutes}p)` });
      } else {
        updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Đang chờ lần check Boss tiếp theo (${minutes}p)` });
      }

      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Boss Thế Giới" });
      setAccountFeatureStatus(acc.id, "world_boss", "PENDING", true);
      addAccountLog(acc.id, "WORLD_BOSS", "ERROR", error.message || "Lỗi Boss Thế Giới không xác định.", error?.data);
      return null;
    }
  };


  const toKiNgoProgressNumber = (value: any): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };

  const extractKiNgoProgress = (data: any, fallbackUsed?: number, fallbackLimit?: number) => {
    const used = pickFirst(
      data?.daily_count,
      data?.today_count,
      data?.used_count,
      data?.current_count,
      data?.trigger_count,
      data?.count,
      data?.ki_ngo_count,
      findNumberDeep(data, ["daily_count", "today_count", "used_count", "current_count", "trigger_count", "ki_ngo_count"], []),
      fallbackUsed
    );

    const limit = pickFirst(
      data?.daily_limit,
      data?.today_limit,
      data?.max_count,
      data?.limit_count,
      data?.limit,
      data?.cap,
      data?.ki_ngo_limit,
      findNumberDeep(data, ["daily_limit", "today_limit", "max_count", "limit_count", "ki_ngo_limit"], []),
      fallbackLimit
    );

    return {
      used: toKiNgoProgressNumber(used),
      limit: toKiNgoProgressNumber(limit),
    };
  };

  const isKiNgoStopLike = (errorOrData: any) => {
    const text = `${String(errorOrData?.message || "").toLowerCase()} ${JSON.stringify(errorOrData?.data || errorOrData || {}).toLowerCase()}`;
    return ["limit", "daily", "max", "cooldown", "already", "hết", "het", "no encounter", "not_available"].some(key => text.includes(key));
  };

  const isKiNgoDailyLimitReached = (usedValue: any, limitValue: any, _data?: any, _message?: string) => {
    const usedNumber = Number(usedValue);
    const limitNumber = Number(limitValue);

    // Chỉ xem là hoàn thành ngày khi có số daily_count/daily_limit rõ ràng và count đã chạm limit.
    // Không được đánh dấu DONE chỉ vì API trả cooldown/no encounter/can_continue=false.
    if (Number.isFinite(usedNumber) && Number.isFinite(limitNumber) && limitNumber > 0 && usedNumber >= limitNumber) {
      return true;
    }

    // Nếu message nói đã đạt giới hạn nhưng không có số count/limit thì cũng chưa đủ tin cậy để hiện 100%.
    // Trường hợp này sẽ WAITING để lần sau check lại thay vì hiện Làm xong sai.
    return false;
  };

  const getKiNgoSettings = (acc: Account) => getFeatureSettings(acc, "ki_ngo", undefined);

  const runKiNgoForAccount = async (accountId: string, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "KI_NGO");
    if (!runtime) return null;

    const settings = getKiNgoSettings(acc);
    const maxLoops = Math.max(1, Number(settings.max_runs_per_check || 30));
    const continueDelayMs = Math.max(30_000, Number(settings.continue_delay_seconds || 60) * 1000);

    setAccountFeatureStatus(acc.id, "ki_ngo", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: fromTimer ? "Kì ngộ chạy lại sau reset 12h" : "Kì ngộ", errorMessage: undefined });
    addAccountLog(acc.id, "KI_NGO", "INFO", fromTimer ? "Mốc 12h Việt Nam đã tới, bắt đầu chạy lại Kì ngộ." : "Bắt đầu chạy Kì ngộ.");

    let successCount = 0;
    let failCount = 0;
    let lastData: any = null;
    let used: number | undefined = undefined;
    let limit: number | undefined = undefined;
    let stoppedByStopLike = false;
    let stoppedByApiContinueFalse = false;

    const cached = acc.features?.ki_ngo?.settings || {};
    const cachedUsed = toKiNgoProgressNumber(cached.daily_count ?? cached.used_count ?? cached.current_count);
    const cachedLimit = toKiNgoProgressNumber(cached.daily_limit ?? cached.max_count ?? cached.limit_count);
    if (cachedUsed !== undefined) used = cachedUsed;
    if (cachedLimit !== undefined) limit = cachedLimit;

    for (let i = 1; i <= maxLoops; i++) {
      try {
        const res = await fetch(`${BASE_URL}/rest/v1/rpc/rpc_trigger_ki_ngo`, {
          method: "POST",
          headers: {
            apikey: GAME_API_KEY,
            authorization: `Bearer ${runtime.accessToken}`,
            "content-profile": "public",
            "content-type": "application/json",
            "x-client-info": "supabase-flutter/2.12.0",
          },
          body: JSON.stringify({ p_character_id: runtime.characterId }),
          credentials: "omit",
        });

        const text = await res.text();
        let data: any = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }

        if (!res.ok || data?.ok === false) {
          const message = data?.error || data?.reason || data?.message || text || `HTTP ${res.status}`;
          const progress = extractKiNgoProgress(data, used, limit);
          if (Number.isFinite(progress.used)) used = progress.used;
          if (Number.isFinite(progress.limit)) limit = progress.limit;

          if (isKiNgoStopLike({ message, data })) {
            stoppedByStopLike = true;
            addAccountLog(acc.id, "KI_NGO", "WARN", `Kì ngộ tạm dừng: ${message}`, {
              ...(data || {}),
              daily_count: used,
              daily_limit: limit,
              completed_today: isKiNgoDailyLimitReached(used, limit, data, message),
            });
            break;
          }

          failCount += 1;
          addAccountLog(acc.id, "KI_NGO", "ERROR", `Kì ngộ lỗi: ${message}`, data);
          break;
        }

        successCount += 1;
        lastData = data;

        const progress = extractKiNgoProgress(data, used, limit);
        if (Number.isFinite(progress.used)) used = progress.used;
        else used = (used || 0) + 1;
        if (Number.isFinite(progress.limit)) limit = progress.limit;

        addAccountLog(acc.id, "KI_NGO", "SUCCESS", `Kì ngộ thành công ${Number.isFinite(used) && Number.isFinite(limit) ? `${used}/${limit}` : `lần ${successCount}`}.`, data);

        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && used >= limit) {
          addAccountLog(acc.id, "KI_NGO", "SUCCESS", `Đã hoàn thành toàn bộ Kì ngộ hôm nay: ${used}/${limit}.`);
          break;
        }

        const canContinue = data?.can_continue ?? data?.canContinue ?? data?.continue;
        if (canContinue === false) {
          stoppedByApiContinueFalse = true;
          addAccountLog(acc.id, "KI_NGO", "INFO", "API báo không còn Kì ngộ để chạy tiếp.", data);
          break;
        }
      } catch (error: any) {
        if (isKiNgoStopLike(error)) {
          stoppedByStopLike = true;
          addAccountLog(acc.id, "KI_NGO", "WARN", error.message || "Kì ngộ tạm dừng do hết lượt tạm thời/cooldown.", error?.data);
        } else {
          failCount += 1;
          addAccountLog(acc.id, "KI_NGO", "ERROR", error.message || "Kì ngộ lỗi không xác định.", error?.data);
        }
        break;
      }
    }

    const safeUsed = Number.isFinite(used) ? Number(used) : successCount;
    const safeLimit = Number.isFinite(limit) ? Number(limit) : undefined;
    const reachedDailyLimit = isKiNgoDailyLimitReached(safeUsed, safeLimit, lastData);
    const completedToday = reachedDailyLimit;
    const stoppedBeforeLimit = (stoppedByStopLike || stoppedByApiContinueFalse) && !completedToday;

    const nextResetMs = msUntilNextVietnamNoon();
    const nextResetAt = new Date(Date.now() + nextResetMs).toISOString();
    const retryMs = completedToday ? nextResetMs : continueDelayMs;
    const nextRunAt = new Date(Date.now() + retryMs).toISOString();
    const status: FeatureStatus = failCount > 0 && successCount === 0 && !completedToday && !stoppedBeforeLimit ? "PENDING" : completedToday ? "DONE" : "WAITING";

    setAccounts(prev => prev.map(item => {
      if (item.id !== acc.id) return item;
      const current = item.features.ki_ngo || { enabled: true, status: "WAITING", settings: {} };
      return {
        ...item,
        features: {
          ...item.features,
          ki_ngo: {
            ...current,
            enabled: true,
            status,
            settings: {
              ...current.settings,
              daily_count: safeUsed,
              daily_limit: safeLimit ?? current.settings?.daily_limit,
              success_count: successCount,
              fail_count: failCount,
              completed_today: completedToday,
              next_reset_at: nextResetAt,
              next_run_at: nextRunAt,
              last_result: lastData,
              last_run_at: new Date().toISOString(),
            },
          },
        },
      };
    }));

    if (completedToday) {
      setFeatureTimer(accountId, "ki_ngo", nextResetMs, () => runKiNgoForAccount(accountId, true));
      updateAccount(acc.id, {
        state: "WAITING_TIMER",
        activeTask: `Kì ngộ đã làm xong, chờ reset 12h Việt Nam (${formatWaitMinutes(nextResetMs)})`,
        errorMessage: undefined,
      });
      addAccountLog(acc.id, "KI_NGO", "SUCCESS", `Kì ngộ đã đạt 100%, dừng chạy. Sẽ tự chạy lại sau mốc 12h Việt Nam, khoảng ${formatWaitMinutes(nextResetMs)} nữa.`, {
        daily_count: safeUsed,
        daily_limit: safeLimit,
        next_reset_at: nextResetAt,
      });
    } else if (status === "WAITING") {
      setFeatureTimer(accountId, "ki_ngo", retryMs, () => runKiNgoForAccount(accountId, true));
      updateAccount(acc.id, {
        state: "WAITING_TIMER",
        activeTask: `Kì ngộ chưa đủ 100%, chờ chạy tiếp (${formatWaitMinutes(retryMs)})`,
        errorMessage: undefined,
      });
      addAccountLog(acc.id, "KI_NGO", "INFO", `Kì ngộ chưa đạt giới hạn ngày. Hẹn chạy tiếp sau ${formatWaitMinutes(retryMs)}.`, {
        daily_count: safeUsed,
        daily_limit: safeLimit,
        next_run_at: nextRunAt,
      });
    } else {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: "Kì ngộ lỗi, cần kiểm tra log." });
    }

    addAccountLog(acc.id, "KI_NGO", successCount > 0 || completedToday ? "SUCCESS" : "WARN", `Kết thúc Kì ngộ: success=${successCount}, fail=${failCount}, tiến độ=${formatNumber(safeUsed)}/${Number.isFinite(safeLimit) ? formatNumber(safeLimit) : "?"}, trạng thái=${status}.`, {
      successCount,
      failCount,
      used: safeUsed,
      limit: safeLimit,
      completedToday,
      stoppedBeforeLimit,
      nextRunAt,
      nextResetAt,
    });

    return { successCount, failCount, used: safeUsed, limit: safeLimit, completedToday, nextRunAt, nextResetAt };
  };


  const sanitizeFarmRunForUi = (result: FarmRunSummary | null): FarmRunSummary | null => {
    if (!result) return result;
    return {
      ...result,
      // Farm không phải nguồn tài nguyên. Không lưu response attack / quest progress
      // vào account state để tránh các số hp/mp/drop/token trong response bị hiểu nhầm
      // là ví/tài nguyên thật của tài khoản.
      questProgress: undefined,
      lastMpPotionResult: undefined,
      lastTarget: result.lastTarget ? {
        baseCode: result.lastTarget.baseCode,
        realmCode: result.lastTarget.realmCode,
        realmId: result.lastTarget.realmId,
        channelNo: result.lastTarget.channelNo,
        mobId: result.lastTarget.mobId,
        mobName: result.lastTarget.mobName,
        mobType: result.lastTarget.mobType,
        killed: result.lastTarget.killed,
        mobHpAfter: result.lastTarget.mobHpAfter,
        dropItemCode: result.lastTarget.dropItemCode,
        attackSpeedSec: result.lastTarget.attackSpeedSec,
        responseKilled: result.lastTarget.responseKilled,
        observedKilled: result.lastTarget.observedKilled,
        observedKind: result.lastTarget.observedKind,
        observedConfidence: result.lastTarget.observedConfidence,
        observedReason: result.lastTarget.observedReason,
        beforeCounts: result.lastTarget.beforeCounts,
        afterCounts: result.lastTarget.afterCounts,
        countDelta: result.lastTarget.countDelta,
      } : undefined,
    };
  };

  const runFarmForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runToken = Number(runtimeState.current[accountId]?.runToken || 0);
    if (!isFeatureStillAllowed(accountId, "farm", runToken)) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "FARM");
    if (!runtime || !isFeatureStillAllowed(accountId, "farm", runToken)) return null;

    const baseSettings = getFeatureSettings(acc, "farm", settingsOverride);
    const rtForFarm = ensureRuntimeState(acc.id);
    const manualRealmTier = normalizeRealmTierKey(baseSettings.farm_realm_tier_override);
    const currentRealmTier = manualRealmTier || inferAccountRealmTier(acc);
    const runtimeAvailableByTier = rtForFarm.farmAvailableBaseCodesByTier?.[currentRealmTier];
    const runtimeUnavailableByTier = rtForFarm.farmUnavailableBaseCodesByTier?.[currentRealmTier];
    const runtimeAvailable = normalizeFarmBaseCodes(runtimeAvailableByTier, currentRealmTier).length
      ? normalizeFarmBaseCodes(runtimeAvailableByTier, currentRealmTier)
      : normalizeFarmBaseCodes(rtForFarm.farmAvailableBaseCodes, currentRealmTier);
    const runtimeUnavailable = normalizeFarmBaseCodes(runtimeUnavailableByTier, currentRealmTier).length
      ? normalizeFarmBaseCodes(runtimeUnavailableByTier, currentRealmTier)
      : normalizeFarmBaseCodes(rtForFarm.farmUnavailableBaseCodes, currentRealmTier);
    const cachedAvailable = getTieredFarmCodes(baseSettings, "available_base_codes", currentRealmTier);
    const cachedUnavailable = getTieredFarmCodes(baseSettings, "unavailable_base_codes", currentRealmTier);
    const forceBossPriority = isFarmBossPriorityMode(baseSettings);
    const settings: Record<string, any> = {
      ...baseSettings,
      mode: forceBossPriority ? "boss" : baseSettings.mode,
      priority: forceBossPriority ? "boss_elite" : baseSettings.priority,
      boss_priority_mode: forceBossPriority,
      // Boss Priority nhanh: Boss -> Elite -> đổi kênh, bỏ Normal.
      // Nếu Farm thông minh Trùng Sinh phát hiện quest cần Normal thì mới thêm Normal.
      boss_priority_fast: forceBossPriority ? baseSettings.boss_priority_fast !== false : baseSettings.boss_priority_fast,
      smart_rebirth_farm: baseSettings.smart_rebirth_farm !== false,
      strict_boss_mode: false,
      farm_boss_only: false,
      current_realm_tier: currentRealmTier,
      farm_realm_tier: currentRealmTier,
      manual_realm_tier: manualRealmTier || "",
      account_realm_code: acc.realmCode,
      account_realm_label: acc.realmLabel,
      account_realm_level: acc.level,
      available_base_codes: runtimeAvailable.length ? runtimeAvailable : cachedAvailable,
      unavailable_base_codes: runtimeUnavailable.length ? runtimeUnavailable : cachedUnavailable,
      farm_cache_tier: currentRealmTier,
      max_available_base_codes: 2,
      summary_log_interval_seconds: Math.max(60, Number(baseSettings.summary_log_interval_seconds || 3600)),
      mob_cache_max_age_ms: Math.max(1000, Number(baseSettings.mob_cache_max_age_ms || 3000)),
    };
    setAccountFeatureStatus(acc.id, "farm", "IN_PROGRESS");
    updateAccount(acc.id, { state: "ONLINE_MANUAL_FARM", activeTask: fromTimer ? "Farm quái chạy vòng tiếp theo" : "Farm quái", errorMessage: undefined });

    try {
      const farmLogMode = String(settings.farm_log_mode || "summary");
      const verboseFarmLog = farmLogMode === "verbose" || settings.verbose_farm_logs === true;

      const result = await runFarmAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        claimMobLock: (lockKey, mobInfo, ttlMs) => claimFarmMobLock(acc.id, lockKey, mobInfo, ttlMs),
        onRegionAvailability: (baseCode, isAvailable, meta) => updateFarmRegionCache(acc.id, baseCode, isAvailable, meta),
        shouldStop: () => !isFeatureStillAllowed(accountId, "farm", runToken),
        onLog: (level, message, meta) => {
          // Farm chạy liên tục nên mặc định chỉ ghi lỗi thật. Các lỗi mềm theo kênh/vùng
          // như join/snapshot không được, không thuộc vùng, không lấy realm_id... sẽ gộp vào summary,
          // tránh spam log kiểu "Farm bf_xxx_c02 lỗi nhẹ" mỗi vòng.
          const text = String(message || "");
          const isSoftFarmMessage =
            text.includes("lỗi nhẹ") ||
            text.includes("Không list được channel") ||
            text.includes("Không lấy được realm_id") ||
            text.includes("bỏ qua kênh") ||
            text.includes("bỏ qua kênh/vùng");

          if (verboseFarmLog) {
            addAccountLog(acc.id, "FARM", level, message, meta);
            return;
          }

          if (level === "ERROR") {
            addAccountLog(acc.id, "FARM", level, message, meta);
            return;
          }

          if (level === "WARN" && !isSoftFarmMessage) {
            addAccountLog(acc.id, "FARM", level, message, meta);
          }
        },
      });

      // Không release lock mob ngay sau vòng farm. Lock có TTL ngắn để tránh nhiều account cùng đánh trùng mob.

      if (!isFeatureStillAllowed(accountId, "farm", runToken)) {
        return result;
      }

      updateAccount(acc.id, { farmLastRun: sanitizeFarmRunForUi(result) as any, errorMessage: result.status === "ERROR" ? "Farm quái lỗi" : undefined });

      // Farm quái KHÔNG cập nhật tài nguyên/tổng chỉ số account.
      // Không refresh linh thạch, bạc/cống hiến, score; cũng không ghi đè HP/MP ở bảng tổng.
      // Các số tài nguyên chỉ được cập nhật bởi chức năng có claim thật như Boss Thế Giới, Mail/Giftcode, Mê Cung, Thành tựu...
      if (!isFeatureStillAllowed(accountId, "farm", runToken)) {
        return result;
      }

      const farmDoneBySmartStop =
        result.status === "DONE" &&
        result.mode === "smart" &&
        result.effectiveMode === "smart_done_stopped" &&
        settings.smart_stop_when_quest_done === true;

      // Chỉ dừng Farm khi đúng là người dùng đã tick "Farm thông minh đủ nhiệm vụ thì dừng".
      // Nếu nhiệm vụ đủ nhưng checkbox không bật, engine sẽ trả effectiveMode=all_after_smart_done
      // và Farm phải tiếp tục chạy theo priority, không được set DONE chỉ vì quest đã full.
      if (farmDoneBySmartStop) {
        clearFeatureTimer(accountId, "farm");
        setAccountFeatureStatus(acc.id, "farm", "DONE");
        updateAccount(acc.id, {
          state: "READY",
          activeTask: "Farm thông minh đã đủ nhiệm vụ trùng sinh",
          errorMessage: undefined,
        });
        const rt = ensureRuntimeState(acc.id);
        rt.farmSummaryStats = undefined;
        addAccountLog(acc.id, "FARM", "SUCCESS", "Farm thông minh đã đủ yêu cầu nhiệm vụ trùng sinh, dừng Farm quái.", {
          mode: result.mode,
          effectiveMode: result.effectiveMode,
          neededTypes: result.neededTypes,
        });
        return result;
      }

      const waitMs = Math.max(500, Number(result.nextDelayMs || settings.empty_scan_delay_ms || 5000));
      setFeatureTimer(accountId, "farm", waitMs, () => runFarmForAccount(accountId, undefined, true));
      setAccountFeatureStatus(acc.id, "farm", result.status === "ERROR" ? "PENDING" : "WAITING");
      updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Farm quái chờ vòng scan tiếp theo (${Math.max(1, Math.ceil(waitMs / 1000))}s)` });

      const rt = ensureRuntimeState(acc.id);
      const now = Date.now();
      const intervalMs = Math.max(15, Number(settings.summary_log_interval_seconds || 60)) * 1000;
      const stats = rt.farmSummaryStats || {
        startedAt: now,
        lastLoggedAt: 0,
        cycles: 0,
        attacks: 0,
        scans: 0,
        lockSkips: 0,
        mpPotions: 0,
        mpPotionBought: 0,
        mpPotionSpent: 0,
        kills: 0,
        bossKills: 0,
        eliteKills: 0,
        normalKills: 0,
        observedKills: 0,
        observedBossKills: 0,
        observedEliteKills: 0,
        observedNormalKills: 0,
        observedMismatch: 0,
      };
      const totalStats = rt.farmSessionTotalStats || {
        startedAt: now,
        lastUpdatedAt: now,
        cycles: 0,
        attacks: 0,
        scans: 0,
        lockSkips: 0,
        mpPotions: 0,
        mpPotionBought: 0,
        mpPotionSpent: 0,
        kills: 0,
        bossKills: 0,
        eliteKills: 0,
        normalKills: 0,
        observedKills: 0,
        observedBossKills: 0,
        observedEliteKills: 0,
        observedNormalKills: 0,
        observedMismatch: 0,
        lastTarget: undefined,
        lastMode: undefined,
        lastStatus: undefined,
      };
      stats.cycles += 1;
      stats.attacks += result.attackCount || 0;
      stats.kills = (stats.kills || 0) + (result.killedCount || 0);
      stats.bossKills = (stats.bossKills || 0) + (result.killedBossCount || 0);
      stats.eliteKills = (stats.eliteKills || 0) + (result.killedEliteCount || 0);
      stats.normalKills = (stats.normalKills || 0) + (result.killedNormalCount || 0);
      stats.observedKills = (stats.observedKills || 0) + (result.observedKilledCount || 0);
      stats.observedBossKills = (stats.observedBossKills || 0) + (result.observedKilledBossCount || 0);
      stats.observedEliteKills = (stats.observedEliteKills || 0) + (result.observedKilledEliteCount || 0);
      stats.observedNormalKills = (stats.observedNormalKills || 0) + (result.observedKilledNormalCount || 0);
      stats.observedMismatch = (stats.observedMismatch || 0) + (result.intendedObservedMismatchCount || 0);
      stats.scans += result.scannedRealmCount || 0;
      stats.lockSkips += result.skippedLockedCount || 0;
      stats.mpPotions = (stats.mpPotions || 0) + (result.mpPotionUsedCount || 0);
      stats.mpPotionBought = (stats.mpPotionBought || 0) + (result.mpPotionBoughtCount || 0);
      stats.mpPotionSpent = (stats.mpPotionSpent || 0) + (result.mpPotionBuySpent || 0);
      totalStats.lastUpdatedAt = now;
      totalStats.cycles += 1;
      totalStats.attacks += result.attackCount || 0;
      totalStats.kills = (totalStats.kills || 0) + (result.killedCount || 0);
      totalStats.bossKills = (totalStats.bossKills || 0) + (result.killedBossCount || 0);
      totalStats.eliteKills = (totalStats.eliteKills || 0) + (result.killedEliteCount || 0);
      totalStats.normalKills = (totalStats.normalKills || 0) + (result.killedNormalCount || 0);
      totalStats.observedKills = (totalStats.observedKills || 0) + (result.observedKilledCount || 0);
      totalStats.observedBossKills = (totalStats.observedBossKills || 0) + (result.observedKilledBossCount || 0);
      totalStats.observedEliteKills = (totalStats.observedEliteKills || 0) + (result.observedKilledEliteCount || 0);
      totalStats.observedNormalKills = (totalStats.observedNormalKills || 0) + (result.observedKilledNormalCount || 0);
      totalStats.observedMismatch = (totalStats.observedMismatch || 0) + (result.intendedObservedMismatchCount || 0);
      totalStats.scans += result.scannedRealmCount || 0;
      totalStats.lockSkips += result.skippedLockedCount || 0;
      totalStats.mpPotions = (totalStats.mpPotions || 0) + (result.mpPotionUsedCount || 0);
      totalStats.mpPotionBought = (totalStats.mpPotionBought || 0) + (result.mpPotionBoughtCount || 0);
      totalStats.mpPotionSpent = (totalStats.mpPotionSpent || 0) + (result.mpPotionBuySpent || 0);
      totalStats.lastTarget = result.lastTarget ? {
        baseCode: result.lastTarget.baseCode,
        realmCode: result.lastTarget.realmCode,
        channelNo: result.lastTarget.channelNo,
        mobId: result.lastTarget.mobId,
        mobName: result.lastTarget.mobName,
        mobType: result.lastTarget.mobType,
        killed: result.lastTarget.killed,
        mobHpAfter: result.lastTarget.mobHpAfter,
        dropItemCode: result.lastTarget.dropItemCode,
        attackSpeedSec: result.lastTarget.attackSpeedSec,
        observedKilled: result.lastTarget.observedKilled,
        observedKind: result.lastTarget.observedKind,
        observedConfidence: result.lastTarget.observedConfidence,
        observedReason: result.lastTarget.observedReason,
        countDelta: result.lastTarget.countDelta,
      } : totalStats.lastTarget;
      totalStats.lastMode = result.effectiveMode;
      totalStats.lastStatus = result.status;
      rt.farmSummaryStats = stats;
      rt.farmSessionTotalStats = totalStats;
      updateAccount(acc.id, {
        farmSessionStats: {
          ...totalStats,
          startedAtIso: new Date(totalStats.startedAt).toISOString(),
          lastUpdatedAtIso: new Date(totalStats.lastUpdatedAt).toISOString(),
        } as any,
      } as any);

      const shouldLogSummary = verboseFarmLog || stats.lastLoggedAt === 0 || now - stats.lastLoggedAt >= intervalMs || result.status === "ERROR";
      if (shouldLogSummary) {
        addAccountLog(acc.id, "FARM", totalStats.attacks > 0 ? "SUCCESS" : "INFO", `Farm tổng phiên: ${Math.round((now - totalStats.startedAt) / 60000)} phút | Kill=${totalStats.observedKills || totalStats.kills || 0} | Boss=${totalStats.observedBossKills || totalStats.bossKills || 0} | Elite=${totalStats.observedEliteKills || totalStats.eliteKills || 0} | Normal=${totalStats.observedNormalKills || totalStats.normalKills || 0} | Attack=${totalStats.attacks} | MP=${totalStats.mpPotions || 0} | Scan=${totalStats.scans}. Gần đây: ${stats.cycles} vòng, attack=${stats.attacks}, kill=${stats.observedKills || stats.kills || 0}. Next=${Math.max(1, Math.ceil(waitMs / 1000))}s.`, {
          mode: result.mode,
          effectiveMode: result.effectiveMode,
          priority: result.priority,
          channels: result.channels,
          neededTypes: result.neededTypes,
          total: totalStats,
          recent: stats,
          lastTarget: totalStats.lastTarget,
          availableBaseCodes: result.availableBaseCodes,
          skippedBaseCodes: result.skippedBaseCodes,
        });
        rt.farmSummaryStats = {
          startedAt: now,
          lastLoggedAt: now,
          cycles: 0,
          attacks: 0,
          scans: 0,
          lockSkips: 0,
          mpPotions: 0,
          mpPotionBought: 0,
          mpPotionSpent: 0,
          kills: 0,
          bossKills: 0,
          eliteKills: 0,
          normalKills: 0,
        };
      }

      return result;
    } catch (error: any) {
      releaseFarmLocksForAccount(acc.id);
      if (!isFeatureStillAllowed(accountId, "farm", runToken)) return null;
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Farm quái" });
      setAccountFeatureStatus(acc.id, "farm", "PENDING");
      addAccountLog(acc.id, "FARM", "ERROR", error.message || "Farm quái lỗi không xác định.", error?.data);
      return null;
    }
  };

  const runBuffForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "BUFF");
    if (!runtime) return null;

    const settings = getFeatureSettings(acc, "buff", settingsOverride);
    setAccountFeatureStatus(acc.id, "buff", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: "Tự động Buff", errorMessage: undefined });

    try {
      const result = await runAutoBuffCheck({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: (level, message, meta) => addAccountLog(acc.id, "BUFF", level, message, meta),
      });

      updateAccount(acc.id, { buffLastRun: result, errorMessage: undefined });
      if (result.usedCount > 0) await refreshAccountResources(acc.id, "BUFF");

      const seconds = Math.max(10, Number(settings.interval_seconds || 60));
      setFeatureTimer(accountId, "buff", seconds * 1000, () => runBuffForAccount(accountId, undefined, true));
      setAccountFeatureStatus(acc.id, "buff", result.status === "ERROR" ? "PENDING" : "WAITING", true);
      updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Đang chờ Buff (${seconds}s)` });
      addAccountLog(acc.id, "BUFF", "INFO", `Auto Buff hẹn check lại sau ${seconds} giây.`);

      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Auto Buff" });
      setAccountFeatureStatus(acc.id, "buff", "PENDING", true);
      addAccountLog(acc.id, "BUFF", "ERROR", error.message || "Auto Buff lỗi không xác định.", error?.data);
      return null;
    }
  };


  const runAutoEquipForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "AUTO_EQUIP");
    if (!runtime) return null;

    const runToken = Number(runtimeState.current[accountId]?.runToken || 0);
    if (!isFeatureStillAllowed(accountId, "auto_equip", runToken)) return null;

    const settings = getFeatureSettings(acc, "auto_equip", settingsOverride);
    setAccountFeatureStatus(acc.id, "auto_equip", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "TASK_RUNNING", activeTask: "Tự động mặc đồ", errorMessage: undefined });

    try {
      const result = await runAutoEquipCheck({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        onLog: (level, message, meta) => addAccountLog(acc.id, "AUTO_EQUIP", level, message, meta),
      });

      if (!isFeatureStillAllowed(accountId, "auto_equip", runToken)) return result;

      updateAccount(acc.id, { autoEquipLastRun: result, errorMessage: undefined });
      if (result.equippedCount > 0) await refreshAccountResources(acc.id, "AUTO_EQUIP");

      const seconds = Math.max(30, Number(settings.interval_seconds || 300));
      setFeatureTimer(accountId, "auto_equip", seconds * 1000, () => runAutoEquipForAccount(accountId, undefined, true));
      setAccountFeatureStatus(acc.id, "auto_equip", result.status === "ERROR" ? "PENDING" : "WAITING", true);
      updateAccount(acc.id, { state: "WAITING_TIMER", activeTask: `Đang chờ Auto mặc đồ (${seconds}s)` });

      const changedText = result.equippedCount > 0
        ? `Auto mặc đồ: đã mặc ${result.equippedCount} món, tăng ${formatNumber(result.totalGain)} điểm.`
        : `Auto mặc đồ: chưa có món nào tốt hơn. Đã scan ${result.scannedCount} item.`;
      addAccountLog(acc.id, "AUTO_EQUIP", result.equippedCount > 0 ? "SUCCESS" : "INFO", changedText, result as any);

      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Auto mặc đồ" });
      setAccountFeatureStatus(acc.id, "auto_equip", "PENDING", true);
      addAccountLog(acc.id, "AUTO_EQUIP", "ERROR", error.message || "Auto mặc đồ lỗi không xác định.", error?.data);
      return null;
    }
  };

  const runCraftForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "CRAFT");
    if (!runtime) return null;

    const runToken = Number(runtimeState.current[accountId]?.runToken || 0);
    if (!isFeatureStillAllowed(accountId, "craft", runToken)) return null;

    let settings = getFeatureSettings(acc, "craft", settingsOverride);
    setAccountFeatureStatus(acc.id, "craft", "IN_PROGRESS", true);
    updateAccount(acc.id, { state: "CRAFT_ONLY", activeTask: fromTimer ? "Craft vòng tiếp theo" : "Auto Craft", errorMessage: undefined });

    try {
      if (settings.auto_load_recipes !== false && (!Array.isArray(settings.recipe_cache) || settings.recipe_cache.length === 0)) {
        const recipes = await loadCraftRecipesForAccount(accountId, settings);
        settings = { ...settings, recipe_cache: recipes };
      }

      const result = await runCraftAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        shouldStop: () => !isFeatureStillAllowed(accountId, "craft", runToken),
        onLog: (level, message, meta) => addAccountLog(acc.id, "CRAFT", level, message, meta),
      });

      if (!isFeatureStillAllowed(accountId, "craft", runToken)) return result;

      updateAccount(acc.id, {
        craftLastRun: result,
        errorMessage: result.status === "ERROR" ? "Auto Craft lỗi" : undefined,
      });

      if (result.successCount > 0) {
        await refreshAccountResources(acc.id, "CRAFT");
      }

      const waitMs = Math.max(5_000, Number(result.nextDelayMs || Number(settings.interval_seconds || 20) * 1000));
      setFeatureTimer(accountId, "craft", waitMs, () => runCraftForAccount(accountId, undefined, true));
      setAccountFeatureStatus(acc.id, "craft", result.status === "ERROR" ? "PENDING" : "WAITING", true);
      updateAccount(acc.id, {
        state: "WAITING_TIMER",
        activeTask: result.status === "SUCCESS"
          ? `Craft OK, chờ vòng tiếp theo (${Math.max(1, Math.ceil(waitMs / 1000))}s)`
          : result.status === "RATE_FAILED"
            ? `Craft trượt do tỉ lệ, chờ vòng tiếp theo (${Math.max(1, Math.ceil(waitMs / 1000))}s)`
            : `Craft tạm chờ do ${result.reason || result.status} (${Math.max(1, Math.ceil(waitMs / 60000))}p)`,
      });

      addAccountLog(acc.id, "CRAFT", result.successCount > 0 ? "SUCCESS" : result.status === "SKIPPED" || result.status === "PAUSED" ? "WARN" : "INFO", `Auto Craft: ${result.recipeCode || "chưa chọn recipe"}, success=${result.successCount}, fail=${result.failCount}, status=${result.status}.`, result as any);
      return result;
    } catch (error: any) {
      updateAccount(acc.id, { state: "ERROR", activeTask: undefined, errorMessage: error.message || "Lỗi Auto Craft" });
      setAccountFeatureStatus(acc.id, "craft", "PENDING", true);
      addAccountLog(acc.id, "CRAFT", "ERROR", error.message || "Auto Craft lỗi không xác định.", error?.data);
      return null;
    }
  };


  const getBreakthroughSettings = (acc: Account, override?: Record<string, any>) => {
    const settings = { ...(acc.features.breakthrough?.settings || {}), ...(override || {}) };
    return {
      interval_seconds: Number(settings.interval_seconds ?? 60) || 60,
      full_exp_threshold_percent: Number(settings.full_exp_threshold_percent ?? 99.99) || 99.99,
      pill_item_codes: String(settings.pill_item_codes || settings.pill_item_code || "pill_lk_minor\npill_lk_major"),
      auto_buy_pill: settings.auto_buy_pill !== false,
      shop_code: String(settings.shop_code || "alchemy"),
      buy_qty: Math.max(1, Number(settings.buy_qty || 1) || 1),
      pause_on_fail_minutes: Number(settings.pause_on_fail_minutes ?? 30) || 30,
      retry_delay_ms: Number(settings.retry_delay_ms ?? 700) || 700,
    };
  };

  const runBreakthroughForAccount = async (accountId: string, settingsOverride?: Record<string, any>, fromTimer = false) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc || runtimeState.current[accountId]?.stopped) return null;

    const runtime = await ensureRuntimeAccount(acc.id, "BREAKTHROUGH");
    if (!runtime || runtimeState.current[accountId]?.stopped) return null;

    const settings = getBreakthroughSettings(acc, settingsOverride);
    addAccountLog(acc.id, "BREAKTHROUGH", fromTimer ? "DEBUG" : "INFO", "Kiểm tra điều kiện đột phá level.", settings);
    setAccountFeatureStatus(acc.id, "breakthrough", "IN_PROGRESS", true);

    try {
      const result = await runBreakthroughAuto({
        characterId: runtime.characterId,
        accessToken: runtime.accessToken,
        settings,
        account: accountsRef.current.find(item => item.id === accountId) || acc,
        onLog: (level, message, meta) => addAccountLog(acc.id, "BREAKTHROUGH", level, message, meta),
        shouldStop: () => Boolean(runtimeState.current[accountId]?.stopped || runtimeState.current[accountId]?.cancelledFeatures?.breakthrough),
      });

      updateAccount(acc.id, {
        breakthroughLastRun: result,
        errorMessage: result.status === "ERROR" ? (result.reason || "Đột phá lỗi") : undefined,
      });

      if (result.status === "SUCCESS") {
        await requestAccountResourceRefresh(acc.id, "BREAKTHROUGH", 500);
      }

      const shouldStopFeature = result.status === "ERROR";
      setAccountFeatureStatus(acc.id, "breakthrough", shouldStopFeature ? "PENDING" : "WAITING", true);
      const waitMs = Math.max(10_000, Number(result.nextDelayMs || settings.interval_seconds * 1000));
      if (!shouldStopFeature && isFeatureStillAllowed(acc.id, "breakthrough")) {
        setFeatureTimer(acc.id, "breakthrough", waitMs, () => runBreakthroughForAccount(acc.id, undefined, true));
      }
      return result;
    } catch (error: any) {
      updateAccount(acc.id, { errorMessage: error.message || "Lỗi Auto Đột phá" });
      setAccountFeatureStatus(acc.id, "breakthrough", "PENDING", true);
      addAccountLog(acc.id, "BREAKTHROUGH", "ERROR", error.message || "Lỗi Auto Đột phá không xác định.", error?.data);
      return null;
    }
  };

  const runEnabledFeaturesForAccount = async (
    accountId: string,
    sharedPools: Record<string, string>,
    sharedPoolLocks: Record<string, Promise<any>>
  ) => {
    const acc = accountsRef.current.find(item => item.id === accountId);
    if (!acc || runtimeState.current[accountId]?.stopped) return;

    const accountEnabledFeatures = (Object.entries(acc.features || {}) as [string, FeatureConfig][])
      .filter(([, cfg]) => Boolean(cfg?.enabled))
      .map(([id]) => id);

    const globalEnabledFeatures = (Object.entries(globalFeatureToggles || {}) as [string, boolean][])
      .filter(([id, enabled]) => Boolean(enabled) && acc.features?.[id]?.settings?.disabled_override !== true)
      .map(([id]) => id);

    const enabledFeatures = Array.from(new Set([...accountEnabledFeatures, ...globalEnabledFeatures]))
      .filter(id => !["daily", "attendance", "gift", "quest", "mail", "giftcode"].includes(id));

    if (enabledFeatures.length === 0) {
      addAccountLog(acc.id, "RUN", "WARN", "Tài khoản chưa tick chức năng nào để chạy.");
      return;
    }

    addAccountLog(acc.id, "RUN", "INFO", `Khởi động song song ${enabledFeatures.length} chức năng: ${enabledFeatures.join(", ")}.`);
    updateAccount(acc.id, { __accountStateAuthoritative: true, state: "TASK_RUNNING", activeTask: `Chạy song song ${enabledFeatures.length} chức năng`, errorMessage: undefined });

    const runOneFeature = async (featureId: string) => {
      const latest = accountsRef.current.find(item => item.id === accountId);
      if (!latest || runtimeState.current[accountId]?.stopped) return;
      if (latest.features?.[featureId]?.settings?.disabled_override === true) return;
      if (latest.features?.[featureId]?.enabled === false && !globalFeatureToggles?.[featureId]) return;

      try {
        if (featureId === "farm") {
          await runFarmForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (["claim_exp", "world_cup_checkin", "onboarding_claim", "body_cult", "achievement"].includes(featureId)) {
          await runDailySingleFeatureForAccount(accountId, featureId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "world_boss") {
          await runWorldBossForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "buff") {
          await runBuffForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "auto_equip") {
          await runAutoEquipForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "craft") {
          await runCraftForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "breakthrough") {
          await runBreakthroughForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "me_cung") {
          await runMazeForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
        } else if (featureId === "ki_ngo") {
          await runKiNgoForAccount(accountId);
        } else if (featureId === "mail_giftcode") {
          const settings = getMailGiftcodeSettings(latest, featureId === selectedFeatureId ? tempSettings : undefined);
          const poolKey = "mail_giftcode_shared_pool";

          if (settings.mode === "shared_pool_remove_attempted") {
            // Pool chung bắt buộc có khoá tuần tự để tránh 2 account nhập trùng cùng 1 code.
            const previousLock = sharedPoolLocks[poolKey] || Promise.resolve();

            const currentLock = previousLock.then(async () => {
              if (sharedPools[poolKey] === undefined) sharedPools[poolKey] = settings.giftcodes;

              addAccountLog(accountId, "GIFTCODE", "INFO", "Đợi lượt dùng pool giftcode chung để tránh nhập trùng mã.");
              const result = await runMailGiftcodeForAccount(accountId, {
                ...settings,
                giftcodes: sharedPools[poolKey],
              });

              const remaining = result?.giftcodeResult?.remainingCodes;
              if (remaining) {
                sharedPools[poolKey] = remaining.join("\n");
                updateSharedGiftcodePoolForTargets(Array.from(checkedAccountIds), sharedPools[poolKey]);
                addAccountLog(accountId, "GIFTCODE", "INFO", `Pool giftcode còn lại ${remaining.length} code sau account này.`);
              }

              return result;
            });

            sharedPoolLocks[poolKey] = currentLock.catch(() => undefined);
            await currentLock;
          } else {
            await runMailGiftcodeForAccount(accountId, featureId === selectedFeatureId ? tempSettings : undefined);
          }
        } else {
          addAccountLog(acc.id, "RUN", "WARN", `Chức năng ${featureId} đã bật nhưng chưa có engine chạy thật ở giai đoạn này.`);
          setAccountFeatureStatus(acc.id, featureId, "PENDING", true);
        }
      } catch (error: any) {
        addAccountLog(acc.id, "RUN", "ERROR", `Lỗi khi chạy ${featureId}: ${error.message || "unknown"}`, error?.data);
        setAccountFeatureStatus(acc.id, featureId, "PENDING", true);
      }
    };

    const results = await Promise.allSettled(enabledFeatures.map(featureId => runOneFeature(featureId)));
    const rejectedCount = results.filter(item => item.status === "rejected").length;

    const after = accountsRef.current.find(item => item.id === accountId);
    if (after && after.state !== "ERROR" && !runtimeState.current[accountId]?.stopped) {
      const scheduledFeatures = enabledFeatures.filter(id => {
        if (!["farm", "claim_exp", "world_cup_checkin", "body_cult", "achievement", "world_boss", "me_cung", "ki_ngo", "buff", "auto_equip", "craft", "breakthrough"].includes(id)) return false;
        // Kì ngộ đạt 100% phải hiển thị Làm xong, không bị ghi đè thành Đang chờ trong tổng runner.
        if (id === "ki_ngo" && after.features?.ki_ngo?.status === "DONE") return false;
        return true;
      });
      const doneTimerFeatures = enabledFeatures.filter(id => id === "ki_ngo" && after.features?.ki_ngo?.status === "DONE");

      if (scheduledFeatures.length > 0) {
        updateAccount(accountId, { __accountStateAuthoritative: true, state: "WAITING_TIMER", activeTask: `Đang chờ lịch: ${scheduledFeatures.join(", ")}` });
        addAccountLog(accountId, rejectedCount ? "RUN" : "RUN", rejectedCount ? "WARN" : "SUCCESS", `Đã khởi động song song ${enabledFeatures.length} chức năng. ${scheduledFeatures.length} chức năng có timer riêng đang chờ lần chạy tiếp theo.`, {
          total: enabledFeatures.length,
          rejected: rejectedCount,
          scheduledFeatures,
          doneTimerFeatures,
        });
      } else if (doneTimerFeatures.length > 0) {
        addAccountLog(accountId, rejectedCount ? "RUN" : "RUN", rejectedCount ? "WARN" : "SUCCESS", `Đã chạy xong ${doneTimerFeatures.join(", ")}. Tính năng đã ở trạng thái Làm xong và có timer chờ reset.`, {
          total: enabledFeatures.length,
          rejected: rejectedCount,
          doneTimerFeatures,
        });
      } else {
        updateAccount(accountId, { __accountStateAuthoritative: true, state: "READY", activeTask: undefined });
        addAccountLog(accountId, rejectedCount ? "RUN" : "RUN", rejectedCount ? "WARN" : "SUCCESS", `Đã chạy song song xong ${enabledFeatures.length} chức năng đã bật.`, {
          total: enabledFeatures.length,
          rejected: rejectedCount,
        });
      }
    }
  };

  const runSelectedAccounts = async () => {
    if (checkedAccountIds.size === 0) return;

    // Nếu người dùng đang mở setting của một chức năng và bấm Chạy luôn,
    // tự lưu nhanh setting đó cho các tài khoản đã chọn trước khi chạy.
    if (selectedFeatureId) {
      setAccounts(prev => prev.map(acc => {
        if (!checkedAccountIds.has(acc.id)) return acc;
        const current = acc.features[selectedFeatureId] || { enabled: false, status: "NOT_SELECTED", settings: {} };
        return {
          ...acc,
          features: {
            ...acc.features,
            [selectedFeatureId]: {
              ...current,
              // Lưu setting không được tự bật lại checkbox. Người dùng tắt Farm thì giữ nguyên tắt.
              enabled: current.enabled,
              settings: sanitizeSettingsForFeatureSave(selectedFeatureId, { ...current.settings, ...tempSettings }, current.settings || {}),
            },
          },
        };
      }));
    }

    const targetIds: string[] = Array.from(checkedAccountIds);
    const sharedPools: Record<string, string> = {};
    const sharedPoolLocks: Record<string, Promise<any>> = {};

    targetIds.forEach(id => {
      beginAccountRunToken(id);
      addAccountLog(id, "RUN", "INFO", "Bấm Chạy: khởi động account song song với các account khác.");
    });

    await Promise.allSettled(
      targetIds.map(id => runEnabledFeaturesForAccount(id, sharedPools, sharedPoolLocks))
    );
  };

  const stopSelectedAccounts = () => {
    if (checkedAccountIds.size === 0) return;
    const targetIds = Array.from(checkedAccountIds);
    targetIds.forEach(id => stopAccountRuntime(id));
    setAccounts(prev => prev.map(acc => {
      if (checkedAccountIds.has(acc.id)) {
        const log = createLogEntry({
          accountId: acc.id,
          accountLabel: acc.characterName || acc.email.split("@")[0],
          module: "CONTROL",
          level: "WARN",
          message: "Người dùng bấm Dừng: đã hủy timer/loop đang chờ và đưa tài khoản về IDLE.",
        });
        const stoppedFeatures = Object.fromEntries(Object.entries(acc.features || {}).map(([key, cfg]: [string, any]) => [
          key,
          { ...cfg, status: cfg?.enabled ? "PENDING" : "NOT_SELECTED" }
        ]));
        return { ...acc, state: "IDLE", activeTask: undefined, errorMessage: undefined, features: stoppedFeatures as Record<string, FeatureConfig>, logs: prependLog(acc.logs, log, 300) };
      }
      return acc;
    }));
  };

    if (!isClient) {
      return (
        <div className="flex flex-col h-screen bg-gray-900 text-gray-100 items-center justify-center">
          <Loader2 className="animate-spin text-blue-500 mb-4" size={32} />
          <p className="text-gray-400">Đang tải dữ liệu tài khoản...</p>
        </div>
      );
    }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-900 text-gray-100 font-sans">
      {/* Phân vùng 1: Danh sách tài khoản */}
      <div className="flex-none h-[430px] min-h-[430px] max-h-[430px] border-b border-gray-700 flex flex-col overflow-hidden bg-gray-800">
        <div className="p-2 border-b border-gray-700 bg-gray-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Danh sách tài khoản</h2>
            <div className="text-[10px] text-gray-500">Hiển thị tối đa khoảng 6 tài khoản, còn lại kéo trong bảng</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={() => setIsAddModalOpen(true)} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded flex items-center gap-1">
              <Plus size={14} /> Thêm
            </button>
            <button 
              onClick={startSelectedAccounts}
              disabled={checkedAccountIds.size === 0}
              className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Play size={14} /> Kiểm tra lại
            </button>
            <button 
              onClick={runSelectedAccounts}
              disabled={checkedAccountIds.size === 0}
              className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white text-xs rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Play size={14} /> Chạy
            </button>
            <button 
              onClick={stopSelectedAccounts}
              disabled={checkedAccountIds.size === 0}
              className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-xs rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <SquareOutline size={14} /> Dừng
            </button>
            <button 
              onClick={deleteSelectedAccounts}
              disabled={checkedAccountIds.size === 0}
              className="px-3 py-1 bg-red-900/80 hover:bg-red-700 text-white text-xs rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={14} /> Xóa
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-gray-900">
          <table className="w-full min-w-[1180px] text-sm text-left">
            <thead className="text-xs text-gray-400 uppercase bg-gray-800 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 w-10">
                  <input 
                    type="checkbox" 
                    checked={accounts.length > 0 && checkedAccountIds.size === accounts.length} 
                    onChange={toggleAllAccounts}
                    className="rounded bg-gray-700 border-gray-600 cursor-pointer" 
                  />
                </th>
                <th className="px-3 py-2">Nhân vật</th>
                <th className="px-3 py-2">Trạng thái</th>
                <th className="px-3 py-2">Cấp / Cảnh giới</th>
                <th className="px-3 py-2">Nguyên tố</th>
                <th className="px-3 py-2">ATK / DEF</th>
                <th className="px-3 py-2">Rank</th>
                <th className="px-3 py-2">VIP</th>
                <th className="px-3 py-2">Ví / Token</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr 
                  key={acc.id}
                  title="Bấm vào dòng tài khoản để mở setting riêng"
                  className={`h-[58px] border-b border-gray-800 transition-colors cursor-pointer
                    ${checkedAccountIds.has(acc.id) ? 'bg-gray-800/80' : 'hover:bg-gray-800/50'}
                    ${viewingAccountId === acc.id ? 'bg-blue-900/20' : ''}
                  `}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    setViewingAccountId(acc.id);
                  }}
                >
                  <td className="px-3 py-1.5">
                    <input 
                      type="checkbox" 
                      checked={checkedAccountIds.has(acc.id)} 
                      onChange={() => toggleAccountCheck(acc.id)}
                      className="rounded bg-gray-700 border-gray-600 cursor-pointer" 
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <div>
                        <div className="font-medium text-gray-100">{getCharacterName(acc)}</div>
                        <div className="text-[10px] text-gray-500 max-w-[190px] truncate" title={acc.email}>{acc.email}</div>
                        {acc.characterId && <div className="text-[10px] text-gray-600 max-w-[190px] truncate" title={acc.characterId}>ID: {acc.characterId}</div>}
                      </div>
                      {viewingAccountId === acc.id && (
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-blue-900/70 text-blue-200 border border-blue-700/60">
                          Đang xem
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`font-semibold flex items-center gap-1 ${stateLabels[acc.state].color}`} title={acc.errorMessage}>
                      {stateLabels[acc.state].icon && <Loader2 size={12} className="animate-spin" />}
                      {stateLabels[acc.state].text}
                    </span>
                    {acc.activeTask && <div className="text-[10px] text-cyan-300 max-w-[150px] truncate" title={acc.activeTask}>{acc.activeTask}</div>}
                    {acc.errorMessage && <div className="text-[10px] text-red-500 max-w-[150px] truncate" title={acc.errorMessage}>{acc.errorMessage}</div>}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="font-mono text-gray-100">Lv {acc.level ?? "?"}</div>
                    <div className="text-[10px] text-purple-300" title={acc.realmCode}>{acc.realmLabel || formatRealmLabel(acc.realmCode)}</div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="font-semibold text-emerald-300 whitespace-nowrap" title={`Nguyên tố mạnh nhất: ${formatDominantElement(acc)}`}>{formatDominantElement(acc)}</div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    <div className="text-red-300 whitespace-nowrap">ATK {formatNumber(acc.atk)}</div>
                    <div className="text-blue-300 whitespace-nowrap">DEF {formatNumber(acc.def)}</div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-blue-300">
                    <div>{acc.rankLabel || acc.rebirthRank}</div>
                    <div className="text-[10px] text-gray-500">Score: {acc.totalScore ?? "?"}</div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-900/30 text-yellow-300 text-xs font-semibold">
                      <Crown size={13} /> VIP {acc.vipLevel ?? "?"}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    {renderResources(acc)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Nửa dưới */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Phân vùng 2: Khung chọn tính năng */}
        <div className="w-[35%] min-w-[320px] border-r border-gray-700 flex flex-col bg-gray-800">
          <div className={`p-2 text-xs font-semibold uppercase tracking-wider text-center flex items-center justify-between ${viewingAccount ? 'bg-blue-900/60 text-blue-200' : 'bg-gray-700 text-gray-300'}`}>
            <span>{checkedAccountIds.size > 0 ? `Cấu hình hàng loạt: ${checkedAccountIds.size} tài khoản` : (viewingAccount ? `Đang xem: ${getCharacterName(viewingAccount)}` : "Cấu hình chung (Hàng loạt)")}</span>
            {viewingAccount && (
              <button onClick={() => setViewingAccountId(null)} className="text-[10px] text-blue-300 hover:text-white">ĐÓNG [x]</button>
            )}
          </div>
          <div className="flex border-b border-gray-700 bg-gray-800">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors
                  ${activeTab === tab.id ? 'bg-gray-700 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400 hover:bg-gray-700/50'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto bg-gray-900">
            {featuresDef[activeTab]?.map(feature => {
              const enabled = isFeatureEnabled(feature.id);
              const partialEnabled = isFeaturePartiallyEnabled(feature.id);
              const status = viewingAccount && checkedAccountIds.size === 0 ? viewingAccount.features[feature.id]?.status : null;
              const isSelected = selectedFeatureId === feature.id;

              return (
                <div 
                  key={feature.id} 
                  className={`flex items-center gap-2 p-2 border-b border-gray-800 transition-colors
                    ${isSelected ? 'bg-blue-900/30 border-l-2 border-l-blue-500' : 'hover:bg-gray-800'}`}
                >
                  <input 
                    type="checkbox" 
                    checked={enabled}
                    onChange={() => toggleFeature(feature.id)}
                    className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500 cursor-pointer" 
                  />
                  <span className="flex-1 text-sm font-medium text-gray-200 cursor-pointer" onClick={() => setSelectedFeatureId(feature.id)}>
                    {feature.label}
                    {partialEnabled && <span className="ml-2 text-[10px] text-yellow-300">một phần</span>}
                  </span>
                  
                  {viewingAccount && status && (
                    <div className="flex-shrink-0">
                      {getStatusBadge(status)}
                    </div>
                  )}

                  <button 
                    onClick={() => setSelectedFeatureId(feature.id)}
                    className={`p-1.5 rounded transition-colors
                      ${isSelected ? 'text-blue-400 bg-blue-900/50' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                  >
                    <Settings size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Phân vùng 3: Khung cấu hình chi tiết */}
        <div className="flex-1 flex flex-col bg-gray-900">
          <div className="p-2 border-b border-gray-800 bg-gray-900 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              {selectedFeatureId 
                ? `CẤU HÌNH CHI TIẾT / ${featuresDef[activeTab]?.find(f => f.id === selectedFeatureId)?.label || featuresDef['DIEU_KHIEN'].find(f => f.id === selectedFeatureId)?.label || featuresDef['TIEN_ICH'].find(f => f.id === selectedFeatureId)?.label}` 
                : "CẤU HÌNH CHI TIẾT"}
            </h2>
          </div>
          
          <div className="flex-1 overflow-auto p-4">
            {viewingAccount && (
              <div className="mb-4 rounded border border-blue-900/50 bg-blue-950/20 p-3">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <div className="text-sm font-semibold text-blue-100">{getCharacterName(viewingAccount)}</div>
                    <div className="text-[11px] text-gray-500">{viewingAccount.email}</div>
                  </div>
                  <div className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-900/30 text-yellow-300 text-xs font-semibold">
                    <Crown size={13} /> VIP {viewingAccount.vipLevel ?? "?"}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Cấp</div>
                    <div className="font-mono text-gray-100">Lv {viewingAccount.level ?? "?"}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Cảnh giới</div>
                    <div className="font-mono text-purple-300">{viewingAccount.realmLabel || formatRealmLabel(viewingAccount.realmCode)}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Rank</div>
                    <div className="font-mono text-blue-300">{viewingAccount.rankLabel || viewingAccount.rebirthRank}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Score</div>
                    <div className="font-mono text-gray-100">{viewingAccount.totalScore ?? "?"}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Linh thạch</div>
                    <div className="font-mono text-blue-300">{formatNumber(viewingAccount.spiritStones)}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Cống hiến</div>
                    <div className="font-mono text-yellow-300">{formatNumber(viewingAccount.gold)}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Token</div>
                    <div className="font-mono text-gray-100">Cu {formatNumber(viewingAccount.tokens?.copper)} · Ag {formatNumber(viewingAccount.tokens?.silver)}</div>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <div className="text-gray-500">Yêu cầu</div>
                    <div className="font-mono text-gray-100">{viewingAccount.requiredToken || "?"}</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-gray-500 grid grid-cols-1 md:grid-cols-2 gap-1">
                  <div>Tông môn: <span className="text-gray-300">{viewingAccount.sectName || "?"}</span></div>
                  <div>Ngũ hành chủ đạo: <span className="text-gray-300">{viewingAccount.dominantElement || "?"}</span></div>
                  <div>HP/MP: <span className="text-gray-300">{viewingAccount.hp ?? "?"}/{viewingAccount.maxHp ?? "?"} · {viewingAccount.mp ?? "?"}/{viewingAccount.maxMp ?? "?"}</span></div>
                  <div>Đạo cơ: <span className="text-gray-300">{viewingAccount.daoCoTotal ?? "?"}</span></div>
                </div>
                {viewingAccount.mazeLastRun && (
                  <div className="mt-3 rounded border border-indigo-900/50 bg-indigo-950/20 p-2 text-xs">
                    <div className="mb-1 font-semibold text-indigo-200">Mê Cung gần nhất</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <div>Tier: <span className="text-gray-200">{viewingAccount.mazeLastRun.tier}</span></div>
                      <div>Status: <span className="text-gray-200">{viewingAccount.mazeLastRun.status || "?"}</span></div>
                      <div>Boss: <span className={viewingAccount.mazeLastRun.bossKilled ? "text-green-400" : "text-yellow-400"}>{viewingAccount.mazeLastRun.bossKilled ? "Đã hạ" : "Chưa hạ"}</span></div>
                      <div>Claim: <span className={viewingAccount.mazeLastRun.claimed ? "text-green-400" : "text-yellow-400"}>{viewingAccount.mazeLastRun.claimed ? "OK" : "Chưa"}</span></div>
                      <div>Coins: <span className="text-yellow-300">{formatNumber(viewingAccount.mazeLastRun.coins)}</span></div>
                      <div>Co_te: <span className="text-yellow-300">{formatNumber(viewingAccount.mazeLastRun.coTe)}</span></div>
                      <div>Minted: <span className="text-yellow-300">{formatNumber(viewingAccount.mazeLastRun.minted)}</span></div>
                      <div>Run: <span className="text-gray-400" title={viewingAccount.mazeLastRun.runId}>{viewingAccount.mazeLastRun.runId ? `${viewingAccount.mazeLastRun.runId.slice(0, 8)}...` : "?"}</span></div>
                    </div>
                  </div>
                )}
                {viewingAccount.dailyLastRun && (
                  <div className="mt-3 rounded border border-teal-900/50 bg-teal-950/20 p-2 text-xs">
                    <div className="mb-1 font-semibold text-teal-200">Daily gần nhất</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <div>Status: <span className={viewingAccount.dailyLastRun.status === "DONE" ? "text-green-400" : viewingAccount.dailyLastRun.status === "PARTIAL_ERROR" ? "text-yellow-400" : "text-red-400"}>{viewingAccount.dailyLastRun.status}</span></div>
                      <div>Success: <span className="text-green-300">{viewingAccount.dailyLastRun.successCount}</span></div>
                      <div>Warn: <span className="text-yellow-300">{viewingAccount.dailyLastRun.warnCount}</span></div>
                      <div>Error: <span className="text-red-300">{viewingAccount.dailyLastRun.errorCount}</span></div>
                      <div>Skipped: <span className="text-gray-400">{viewingAccount.dailyLastRun.skippedCount}</span></div>
                      <div>Tasks: <span className="text-gray-300">{viewingAccount.dailyLastRun.tasks.length}</span></div>
                    </div>
                  </div>
                )}
                {viewingAccount.mailLastRun && (
                  <div className="mt-3 rounded border border-blue-900/50 bg-blue-950/20 p-2 text-xs">
                    <div className="mb-1 font-semibold text-blue-200">Mail gần nhất</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <div>Status: <span className="text-gray-200">{viewingAccount.mailLastRun.status}</span></div>
                      <div>Total: <span className="text-gray-300">{viewingAccount.mailLastRun.totalMail}</span></div>
                      <div>Có quà: <span className="text-yellow-300">{viewingAccount.mailLastRun.claimableCount}</span></div>
                      <div>Claimed: <span className="text-green-300">{viewingAccount.mailLastRun.claimedCount}</span></div>
                    </div>
                  </div>
                )}
                {viewingAccount.giftcodeLastRun && (
                  <div className="mt-3 rounded border border-purple-900/50 bg-purple-950/20 p-2 text-xs">
                    <div className="mb-1 font-semibold text-purple-200">Giftcode gần nhất</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <div>Status: <span className="text-gray-200">{viewingAccount.giftcodeLastRun.status}</span></div>
                      <div>Mode: <span className="text-gray-300">{viewingAccount.giftcodeLastRun.mode}</span></div>
                      <div>Thử: <span className="text-blue-300">{viewingAccount.giftcodeLastRun.attemptedCount}</span></div>
                      <div>Thành công: <span className="text-green-300">{viewingAccount.giftcodeLastRun.successCount}</span></div>
                      <div>Thất bại: <span className="text-yellow-300">{viewingAccount.giftcodeLastRun.failCount}</span></div>
                      <div>Còn lại: <span className="text-gray-300">{viewingAccount.giftcodeLastRun.remainingCodes.length}</span></div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!selectedFeatureId ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-500 gap-3">
                <Settings size={40} className="opacity-30" />
                <p>Chọn Icon Bánh răng của một tính năng ở menu trái để cấu hình.</p>
              </div>
            ) : selectedFeatureId === 'log' ? (
              <div className="w-full h-full flex flex-col space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-gray-300 font-semibold text-sm">Log Engine</h3>
                    <p className="text-[11px] text-gray-500">{logScope === "all" ? "Đang xem tất cả account" : viewingAccount ? `Đang xem ${getCharacterName(viewingAccount)}` : "Chọn 1 tài khoản hoặc đổi sang Tất cả"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={copyVisibleLogs} disabled={filteredLogs.length === 0} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 disabled:opacity-40">Copy</button>
                    <button onClick={downloadVisibleLogs} disabled={filteredLogs.length === 0} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 disabled:opacity-40">Export TXT</button>
                    <button onClick={clearLogs} disabled={scopedLogs.length === 0} className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 text-xs text-red-200 disabled:opacity-40">Xoá Log</button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  <div className="rounded border border-gray-800 bg-gray-950/40 p-2"><div className="text-gray-500">Tổng</div><div className="font-mono text-gray-100">{scopedLogs.length}</div></div>
                  <div className="rounded border border-green-900/40 bg-green-950/10 p-2"><div className="text-gray-500">Success</div><div className="font-mono text-green-400">{logCounts.SUCCESS}</div></div>
                  <div className="rounded border border-yellow-900/40 bg-yellow-950/10 p-2"><div className="text-gray-500">Warn</div><div className="font-mono text-yellow-400">{logCounts.WARN}</div></div>
                  <div className="rounded border border-red-900/40 bg-red-950/10 p-2"><div className="text-gray-500">Error</div><div className="font-mono text-red-400">{logCounts.ERROR}</div></div>
                  <div className="rounded border border-blue-900/40 bg-blue-950/10 p-2"><div className="text-gray-500">Đang lọc</div><div className="font-mono text-blue-300">{filteredLogs.length}</div></div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <select value={logScope} onChange={(e) => setLogScope(e.target.value as "selected" | "all")} className="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-200 outline-none focus:border-blue-500">
                    <option value="selected">Account đang xem</option>
                    <option value="all">Tất cả account</option>
                  </select>
                  <select value={logFilterLevel} onChange={(e) => setLogFilterLevel(e.target.value as "ALL" | LogLevel)} className="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-200 outline-none focus:border-blue-500">
                    <option value="ALL">Tất cả level</option>
                    <option value="INFO">INFO</option>
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="WARN">WARN</option>
                    <option value="ERROR">ERROR</option>
                    <option value="DEBUG">DEBUG</option>
                  </select>
                  <select value={logFilterModule} onChange={(e) => setLogFilterModule(e.target.value)} className="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-200 outline-none focus:border-blue-500">
                    <option value="ALL">Tất cả module</option>
                    {availableLogModules.map(module => <option key={module} value={module}>{module}</option>)}
                  </select>
                  <input value={logSearch} onChange={(e) => setLogSearch(e.target.value)} placeholder="Tìm trong log..." className="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-200 outline-none focus:border-blue-500" />
                </div>

                <div className="flex-1 bg-black border border-gray-700 rounded p-3 font-mono text-xs overflow-y-auto space-y-1 h-[400px]">
                  {logScope === "selected" && !viewingAccount ? (
                    <div className="text-gray-500 text-center py-10">Chọn 1 tài khoản hoặc chuyển phạm vi sang “Tất cả account”.</div>
                  ) : filteredLogs.length === 0 ? (
                    <div className="text-gray-500 text-center py-10">Không có log phù hợp với bộ lọc hiện tại.</div>
                  ) : (
                    filteredLogs.map(log => (
                      <div key={log.id} className={`rounded border px-2 py-1 ${getLogLevelClass(log.level)}`}>
                        <div className="flex flex-wrap gap-x-2 gap-y-1">
                          <span className="text-gray-500">[{log.time}]</span>
                          <span className="text-gray-400">[{log.accountLabel || log.accountId || "-"}]</span>
                          <span className="text-purple-300">[{log.module}]</span>
                          <span>[{log.level}]</span>
                          <span className="text-gray-200">{log.message}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : selectedFeatureId === 'stats' ? (
              <div className="w-full h-full flex flex-col space-y-2">
                <h3 className="text-gray-300 font-semibold text-sm">Thống Kê Tài Nguyên</h3>
                <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded p-4 text-center text-gray-500">
                  Tính năng đang phát triển...
                </div>
              </div>
            ) : (
              <div className="w-full max-w-6xl mx-auto grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-4">
                <div className="p-4 rounded border border-gray-700 bg-gray-800/50 space-y-4">
                  <div className="flex items-center justify-between gap-3 pb-2 border-b border-gray-700">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-200">Setting chức năng</h3>
                      <p className="text-[11px] text-gray-500">{getSelectedFeatureTitle(selectedFeatureId)}</p>
                    </div>
                    {checkedAccountIds.size > 0 ? (
                      <span className="text-[11px] text-yellow-200 bg-yellow-950/30 border border-yellow-800/60 rounded px-2 py-1">Áp dụng cho {checkedAccountIds.size} tài khoản đã tick</span>
                    ) : viewingAccount && (
                      <span className="text-[11px] text-blue-300 bg-blue-950/40 border border-blue-900/60 rounded px-2 py-1">{getCharacterName(viewingAccount)}</span>
                    )}
                  </div>
                  {/* Farm Settings */}
                  {selectedFeatureId === 'farm' && (
                    <div className="space-y-4">
                      <div className="rounded border border-green-900/50 bg-green-950/10 p-3 text-xs text-gray-400 space-y-1">
                        <div className="text-green-200 font-medium">Farm Boss Priority nhanh + Trùng Sinh thông minh</div>
                        <p>Bot học 2 vùng phù hợp theo cảnh giới, farm tuần tự kênh bạn chọn. Boss Priority nhanh sẽ đánh Boss → Elite rồi chuyển kênh, bỏ Normal; Normal chỉ farm khi nhiệm vụ Trùng Sinh yêu cầu.</p>
                        <p>Farm không cập nhật ví/token/tài nguyên tổng. Các số tài nguyên chỉ đổi sau claim thật và refresh snapshot thật.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chế độ Farm</label>
                          <select
                            value={tempSettings.mode || 'smart'}
                            onChange={(e) => {
                              const nextMode = e.target.value;
                              updateTempSetting('mode', nextMode);
                              updateTempSetting('boss_priority_mode', nextMode === 'boss');
                              updateTempSetting('boss_priority_fast', nextMode === 'boss');
                              updateTempSetting('smart_rebirth_farm', true);
                              updateTempSetting('strict_boss_mode', false);
                              updateTempSetting('farm_boss_only', false);
                              if (nextMode === 'boss') updateTempSetting('priority', 'boss_elite');
                              updateTempSetting('available_base_codes', []);
                              updateTempSetting('unavailable_base_codes', []);
                              updateTempSetting('available_base_codes_by_tier', {});
                              updateTempSetting('unavailable_base_codes_by_tier', {});
                              updateTempSetting('farm_cache_tier', '');
                            }}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          >
                            <option value="boss">Boss Priority nhanh + Trùng Sinh</option>
                            <option value="smart">Chỉ Farm theo Trùng Sinh</option>
                            <option value="all">Farm tất cả</option>
                            <option value="elite">Chỉ tinh anh</option>
                            <option value="normal">Chỉ quái thường</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Ưu tiên phụ</label>
                          <select
                            value={tempSettings.priority || 'boss_elite_normal'}
                            onChange={(e) => updateTempSetting('priority', e.target.value)}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          >
                            <option value="boss_elite">Boss &gt; Elite, bỏ Normal</option>
                            <option value="boss">Chỉ Boss tuyệt đối</option>
                            <option value="boss_elite_normal">Boss &gt; Elite &gt; Normal</option>
                            <option value="elite_boss_normal">Elite &gt; Boss &gt; Normal</option>
                            <option value="normal_elite_boss">Normal &gt; Elite &gt; Boss</option>
                          </select>
                          <p className="text-[11px] text-gray-500">Mặc định nên để Boss &gt; Elite, bỏ Normal. Normal sẽ tự bật khi nhiệm vụ Trùng Sinh cần.</p>
                        </div>
                      </div>

                      <div className="rounded border border-gray-700 bg-gray-800/50 p-3 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <label className="block text-xs uppercase tracking-wider text-gray-400">Trình độ farm</label>
                            <select
                              value={tempSettings.farm_realm_tier_override || 'auto'}
                              onChange={(e) => {
                                updateTempSetting('farm_realm_tier_override', e.target.value);
                                updateTempSetting('available_base_codes', []);
                                updateTempSetting('unavailable_base_codes', []);
                                updateTempSetting('available_base_codes_by_tier', {});
                                updateTempSetting('unavailable_base_codes_by_tier', {});
                                updateTempSetting('farm_cache_tier', '');
                              }}
                              className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-green-500 outline-none"
                            >
                              <option value="auto">Tự nhận theo account</option>
                              <option value="lk">Luyện Khí (LK)</option>
                              <option value="tc">Trúc Cơ (TC)</option>
                              <option value="kd">Kim Đan (KD)</option>
                              <option value="na">Nguyên Anh (NA)</option>
                              <option value="ht">Hoá Thần (HT)</option>
                              <option value="lh">Luyện Hư (LH)</option>
                            </select>
                            <p className="text-[11px] text-gray-500">Nếu auto nhận sai cảnh giới, chọn thủ công tại đây. Đổi trình độ sẽ tự reset cache vùng đã học.</p>
                          </div>
                          <div className="rounded border border-green-900/40 bg-green-950/10 p-3 text-xs text-gray-300">
                            <div className="text-gray-400 uppercase tracking-wider mb-1">Vùng sẽ dùng</div>
                            <div className="font-mono text-green-200 break-words">
                              {(tempSettings.farm_realm_tier_override && tempSettings.farm_realm_tier_override !== 'auto')
                                ? getFarmBaseRegionsForTier(tempSettings.farm_realm_tier_override).map(r => r.baseCode).join(', ')
                                : 'Auto theo realm/tier account'}
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Mẫu mã bí cảnh / realm prefix</label>
                          <input
                            type="text"
                            value={tempSettings.realm_code_prefix || ''}
                            onChange={(e) => updateTempSetting('realm_code_prefix', e.target.value.trim())}
                            placeholder="Để trống để dùng 4 vùng mặc định"
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none font-mono"
                          />
                          <p className="text-[11px] text-gray-500">Để trống để tự chọn vùng theo cảnh giới account. Bot sẽ scan tối đa 4 vùng ứng viên của tier hiện tại, học đúng 2 vùng account vào được, rồi những vòng sau chỉ farm trong 2 vùng đã lưu. LK không hậu tố; TC/KD/NA/HT/LH tự thêm <span className="font-mono text-gray-300">_tc/_kd/_na/_ht/_lh</span>.</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <label className="block text-xs uppercase tracking-wider text-gray-400">Từ kênh</label>
                            <input
                              type="number"
                              min="1"
                              value={tempSettings.from_channel || 1}
                              onChange={(e) => updateTempSetting('from_channel', Math.max(1, Number(e.target.value) || 1))}
                              className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="block text-xs uppercase tracking-wider text-gray-400">Đến kênh</label>
                            <input
                              type="number"
                              min="1"
                              value={tempSettings.to_channel || 10}
                              onChange={(e) => updateTempSetting('to_channel', Math.max(1, Number(e.target.value) || 1))}
                              className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-gray-500">Bạn chọn khoảng kênh; bot sẽ đọc cảnh giới, sinh 4 vùng ứng viên, join + snapshot để học đúng 2 vùng có mob sống/attack được. Sau khi học xong, bot chỉ farm đa kênh trong 2 vùng đã lưu.</p>
                        <button
                          type="button"
                          onClick={() => {
                            updateTempSetting('available_base_codes', []);
                            updateTempSetting('unavailable_base_codes', []);
                            updateTempSetting('available_base_codes_by_tier', {});
                            updateTempSetting('unavailable_base_codes_by_tier', {});
                            updateTempSetting('farm_cache_tier', '');
                          }}
                          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 border border-gray-600"
                        >
                          Reset cache realm farm
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <label className="flex items-center gap-2 rounded border border-blue-900/40 bg-blue-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_use_mp_potion !== false}
                            onChange={(e) => updateTempSetting('auto_use_mp_potion', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-blue-500"
                          />
                          Tự dùng bình MP <span className="font-mono text-blue-200">pill_lk_mp</span>
                        </label>
                        <label className="flex items-center gap-2 rounded border border-purple-900/40 bg-purple-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_buy_mp_potion === true}
                            onChange={(e) => updateTempSetting('auto_buy_mp_potion', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-purple-500"
                          />
                          Hết bình thì mua bằng kim cương
                        </label>
                        <label className="flex items-center gap-2 rounded border border-emerald-900/40 bg-emerald-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.smart_rebirth_farm !== false}
                            onChange={(e) => updateTempSetting('smart_rebirth_farm', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-emerald-500"
                          />
                          Farm thông minh Trùng Sinh
                        </label>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Mua mỗi lần</label>
                          <select
                            value={String(tempSettings.mp_potion_buy_qty || 10)}
                            onChange={(e) => updateTempSetting('mp_potion_buy_qty', Number(e.target.value) || 10)}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-purple-500 outline-none"
                          >
                            <option value="10">10 bình / lần</option>
                            <option value="1">1 bình / lần</option>
                          </select>
                          <p className="text-[11px] text-gray-500">Shop: alchemy, item: pill_lk_mp.</p>
                        </div>
                        <div className="rounded border border-green-900/40 bg-green-950/10 p-3 text-sm text-gray-300">
                          <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Đòn đánh</div>
                          <div className="font-mono text-green-200">skill_slot = 0</div>
                          <p className="text-[11px] text-gray-500 mt-1">Cố định đánh thường, cooldown 5 giây, không cần chỉnh.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Log Farm</label>
                          <select
                            value={tempSettings.farm_log_mode || 'summary'}
                            onChange={(e) => updateTempSetting('farm_log_mode', e.target.value)}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-green-500 outline-none"
                          >
                            <option value="summary">Chỉ log tổng</option>
                            <option value="verbose">Chi tiết debug</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ log tổng</label>
                          <select
                            value={String(tempSettings.summary_log_interval_seconds || 3600)}
                            onChange={(e) => updateTempSetting('summary_log_interval_seconds', Number(e.target.value) || 3600)}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-green-500 outline-none"
                          >
                            <option value="300">5 phút</option>
                            <option value="900">15 phút</option>
                            <option value="1800">30 phút</option>
                            <option value="3600">60 phút</option>
                          </select>
                        </div>
                      </div>

                      <div className="rounded border border-gray-700 bg-gray-900/40 p-3 text-[11px] text-gray-500 space-y-1">
                        <p>Logic mới: học 2 vùng theo cảnh giới → farm tuần tự vùng 1 kênh từ-đến → vùng 2 kênh từ-đến. Trong mỗi kênh, Boss Priority nhanh đánh Boss rồi Elite; hết Elite thì qua kênh mới, không dọn Normal.</p>
                        <p>Farm thông minh Trùng Sinh sẽ đọc nhiệm vụ; nếu quest cần Normal thì mới farm Normal, nếu không thì quay về Boss Priority nhanh.</p>
                        <p>Không còn các ô “Số lượt attack / vòng”, “Attack tối đa / realm”, “Delay attack”, “Limit players snapshot” để tránh setting rối và giảm lỗi vận hành.</p>
                      </div>

                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Farm quái' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {/* Daily Engine Settings */}
                  {selectedFeatureId === 'claim_exp' && (
                    <div className="space-y-4">
                      <div className="rounded border border-green-900/50 bg-green-950/10 p-3"><div className="text-sm font-semibold text-green-200 mb-1">Claim EXP</div><p className="text-[11px] text-gray-500">Tự claim EXP định kỳ. Mặc định 15 phút/lần.</p></div>
                      <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ claim EXP, phút</label><input type="number" min={1} value={tempSettings.interval_minutes ?? 15} onChange={(e) => updateTempSetting('interval_minutes', Number(e.target.value) || 15)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-green-500 outline-none" /></div>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Claim EXP' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'world_cup_checkin' && (
                    <div className="space-y-4">
                      <div className="rounded border border-sky-900/50 bg-sky-950/10 p-3"><div className="text-sm font-semibold text-sky-200 mb-1">World Cup Checkin</div><p className="text-[11px] text-gray-500">Chạy checkin hằng ngày, lịch tiếp theo là sau 0h Việt Nam.</p></div>
                      <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={tempSettings.reset_at_vn_midnight !== false} onChange={(e) => updateTempSetting('reset_at_vn_midnight', e.target.checked)} className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-sky-500" />Reset theo 0h Việt Nam</label>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting World Cup' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'onboarding_claim' && (
                    <div className="space-y-4">
                      <div className="rounded border border-amber-900/50 bg-amber-950/10 p-3"><div className="text-sm font-semibold text-amber-200 mb-1">Quà tân thủ / Onboarding</div><p className="text-[11px] text-gray-500">Claim quà onboarding nếu account còn phần thưởng chưa nhận.</p></div>
                      <div className="text-xs text-gray-400">Chức năng này chạy một lần khi bấm Chạy, không cần vòng lặp định kỳ.</div>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Onboarding' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'body_cult' && (
                    <div className="space-y-4">
                      <div className="rounded border border-orange-900/50 bg-orange-950/10 p-3">
                        <div className="text-sm font-semibold text-orange-200 mb-1">Thể tu</div>
                        <p className="text-[11px] text-gray-500">
                          Không cần cài thời gian claim. Mỗi lần chạy bot sẽ check trạng thái, nếu đang active sẽ đọc remaining_seconds rồi lưu cache thời điểm thu hoạch = thời gian còn lại + 5 giây.
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input type="checkbox" checked={tempSettings.auto_start !== false} onChange={(e) => updateTempSetting('auto_start', e.target.checked)} className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-orange-500" />
                        Tự thử start nếu chưa có phiên active
                      </label>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Nguyên tố start training</label>
                          <select value={tempSettings.body_cult_element || 'metal'} onChange={(e) => updateTempSetting('body_cult_element', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none">
                            <option value="metal">metal</option>
                            <option value="wood">wood</option>
                            <option value="earth">earth</option>
                            <option value="water">water</option>
                            <option value="fire">fire</option>
                          </select>
                          <p className="text-[11px] text-gray-500">Theo Network bạn gửi, payload đúng đang dùng p_element = metal.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Loại phiên</label>
                          <select value={tempSettings.body_cult_session_type || 'long'} onChange={(e) => updateTempSetting('body_cult_session_type', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none">
                            <option value="long">long</option>
                            <option value="short">short</option>
                          </select>
                          <p className="text-[11px] text-gray-500">Theo Network bạn gửi, payload đúng đang dùng p_session_type = long.</p>
                        </div>
                      </div>
                      <div className="rounded border border-gray-700 bg-gray-950/40 p-3 text-xs text-gray-400 space-y-1">
                        <div>Cache thu hoạch: <span className="text-orange-200">{viewingAccount?.features?.body_cult?.settings?.next_harvest_at || "chưa có"}</span></div>
                        <div>Còn lại: <span className="text-orange-200">{viewingAccount?.features?.body_cult?.settings?.remaining_seconds ?? "?"}</span> giây</div>
                        <div>Mode cuối: <span className="text-orange-200">{viewingAccount?.features?.body_cult?.settings?.last_mode || "chưa chạy"}</span></div>
                      </div>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Thể tu' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'achievement' && (
                    <div className="space-y-4">
                      <div className="rounded border border-yellow-900/50 bg-yellow-950/10 p-3"><div className="text-sm font-semibold text-yellow-200 mb-1">Claim Thành tựu</div><p className="text-[11px] text-gray-500">Tự kiểm tra và claim thành tựu định kỳ. Mặc định 60 phút/lần.</p></div>
                      <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ claim, phút</label><input type="number" min={1} value={tempSettings.interval_minutes ?? 60} onChange={(e) => updateTempSetting('interval_minutes', Number(e.target.value) || 60)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none" /></div>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Thành tựu' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'world_boss' && (
                    <div className="space-y-4">
                      <div className="rounded border border-red-900/50 bg-red-950/10 p-3"><div className="text-sm font-semibold text-red-200 mb-1">Boss Thế Giới</div><p className="text-[11px] text-gray-500">Đánh tất cả tier boss đã khai báo. Đây là timer độc lập, có thể chạy song song với Farm/Craft/Mê Cung. Nếu rơi vào thời gian chờ boss sống lại, bot chuyển sang trạng thái Đang chờ và skip đúng thời gian chờ trước khi check lại.</p></div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Danh sách tier boss</label><input type="text" value={tempSettings.tiers || 'lk,tc,kd'} onChange={(e) => updateTempSetting('tiers', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-red-500 outline-none" /><p className="text-[11px] text-gray-500">Nhập cách nhau bằng dấu phẩy. Mặc định: lk,tc,kd.</p></div>
                        <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Check/reload, phút</label><input type="number" min={1} value={tempSettings.check_interval_minutes ?? 10} onChange={(e) => updateTempSetting('check_interval_minutes', Number(e.target.value) || 10)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-red-500 outline-none" /><p className="text-[11px] text-gray-500">Mặc định 10 phút/lần. Sau khi boss chết và claim quà, bot sẽ đợi đến lần check tiếp theo.</p></div>
                        <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Số lần đánh tối đa mỗi lượt check</label><input type="number" min={1} value={tempSettings.max_attacks_per_check ?? 30} onChange={(e) => updateTempSetting('max_attacks_per_check', Number(e.target.value) || 30)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-red-500 outline-none" /></div>
                        <div className="space-y-1"><label className="block text-xs uppercase tracking-wider text-gray-400">Delay giữa 2 lần đánh, ms</label><input type="number" min={500} value={tempSettings.attack_delay_ms ?? 1500} onChange={(e) => updateTempSetting('attack_delay_ms', Number(e.target.value) || 1500)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-red-500 outline-none" /></div>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={tempSettings.auto_claim !== false} onChange={(e) => updateTempSetting('auto_claim', e.target.checked)} className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-red-500" />Tự claim quà sau khi boss chết</label>
                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Boss Thế Giới' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                  )}

                  {selectedFeatureId === 'ki_ngo' && (
                    <div className="space-y-4">
                      <div className="rounded border border-fuchsia-900/50 bg-fuchsia-950/10 p-3">
                        <div className="text-sm font-semibold text-fuchsia-200 mb-1">Kì ngộ</div>
                        <p className="text-[11px] text-gray-500">
                          Kì ngộ không cần setting riêng. Chỉ cần bật/tắt ở danh sách chức năng, sau đó bấm nút Chạy chung.
                        </p>
                      </div>
                      <div className="rounded border border-gray-700 bg-gray-950/40 p-3 text-xs text-gray-400">
                        Bảng bên phải sẽ hiển thị log mini, số lượt đã chạy và giới hạn tối đa nếu API/log trả về daily_count/daily_limit.
                      </div>
                    </div>
                  )}

                  {selectedFeatureId === 'craft' && (() => {
                    const recipes = getFilteredCraftRecipes(tempSettings);
                    const cacheCount = Array.isArray(tempSettings.recipe_cache) ? tempSettings.recipe_cache.length : 0;
                    const selectedRecipe = recipes.find((item: any) => item.recipe_code === tempSettings.recipe_code)
                      || (Array.isArray(tempSettings.recipe_cache) ? tempSettings.recipe_cache.find((item: any) => item.recipe_code === tempSettings.recipe_code) : null);
                    const targetAccountId = viewingAccountId || Array.from(checkedAccountIds)[0] || null;
                    const tierCounts = (Array.isArray(tempSettings.recipe_cache) ? tempSettings.recipe_cache : []).reduce((accum: Record<string, number>, item: any) => {
                      const tier = item.tierCode || item.meta?.realm_code || item.meta?.tier || 'unknown';
                      accum[tier] = (accum[tier] || 0) + 1;
                      return accum;
                    }, {});

                    return (
                    <div className="space-y-4">
                      <div className="rounded border border-orange-900/50 bg-orange-950/10 p-3">
                        <div className="text-sm font-semibold text-orange-200 mb-1">Auto Craft - Chế tạo đồ</div>
                        <p className="text-[11px] text-gray-500">Bản mới đọc recipe thật bằng rpc_list_recipes, phân loại theo tier/realm_code: lk, tc, kd, na, ht, lh. Bạn chọn tier nào thì danh sách chỉ hiện sản phẩm của tier đó để pick recipe.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Mục craft</label>
                          <select
                            value={tempSettings.category || 'alchemy'}
                            onChange={(e) => {
                              updateTempSetting('category', e.target.value);
                              updateTempSetting('recipe_code', '');
                              updateTempSetting('recipe_cache', []);
                            }}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          >
                            <option value="alchemy">Luyện đan - hệ Mộc</option>
                          </select>
                          <p className="text-[11px] text-gray-500">Network hiện tại bạn gửi là p_category = alchemy.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Lọc theo tier</label>
                          <select
                            value={tempSettings.tier || 'lk'}
                            onChange={(e) => {
                              updateTempSetting('tier', e.target.value);
                              updateTempSetting('recipe_code', '');
                            }}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          >
                            {craftTierOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                          <p className="text-[11px] text-gray-500">Tier hiện có: {Object.entries(tierCounts).map(([key, value]) => `${key}:${value}`).join(' · ') || 'chưa tải'}.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Tìm nhanh</label>
                          <input
                            type="text"
                            value={tempSettings.recipe_search || ''}
                            onChange={(e) => updateTempSetting('recipe_search', e.target.value)}
                            placeholder="mp, sta, linh_thu, tu_vi..."
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none font-mono"
                          />
                        </div>
                      </div>

                      <div className="rounded border border-gray-700 bg-gray-800/50 p-3 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs text-gray-400">
                            Đã tải <span className="text-orange-200 font-semibold">{cacheCount}</span> recipe. Đang hiển thị <span className="text-orange-200 font-semibold">{recipes.length}</span> recipe theo bộ lọc.
                            {tempSettings.recipe_cache_at && <span className="ml-2 text-gray-500">Lần tải: {tempSettings.recipe_cache_at}</span>}
                          </div>
                          <button
                            type="button"
                            onClick={() => targetAccountId && loadCraftRecipesForAccount(targetAccountId, tempSettings)}
                            disabled={!targetAccountId}
                            className="px-3 py-1.5 rounded bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-xs text-white border border-orange-600"
                          >
                            Tải / refresh danh sách recipe
                          </button>
                        </div>

                        <div className="max-h-72 overflow-auto rounded border border-gray-700 divide-y divide-gray-800 bg-gray-950/40">
                          {recipes.length === 0 ? (
                            <div className="p-3 text-xs text-gray-500">Chưa có recipe để hiển thị. Hãy bấm “Tải / refresh danh sách recipe”, hoặc đổi tier/từ khoá tìm kiếm.</div>
                          ) : recipes.slice(0, 120).map((recipe: any) => {
                            const active = tempSettings.recipe_code === recipe.recipe_code;
                            return (
                              <button
                                key={recipe.recipe_code}
                                type="button"
                                onClick={() => {
                                  updateTempSetting('recipe_code', recipe.recipe_code);
                                  updateTempSetting('selected_output_code', recipe.output_code);
                                  updateTempSetting('selected_recipe_tier', recipe.tierCode);
                                }}
                                className={`w-full text-left p-3 text-xs hover:bg-gray-800/80 ${active ? 'bg-orange-950/30 border-l-2 border-orange-400' : ''}`}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-orange-200">{recipe.recipe_code}</span>
                                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{recipe.tierCode}</span>
                                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{recipe.kindLabel}</span>
                                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">rate {recipe.success_rate ?? '?'}%</span>
                                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{recipe.output_rarity || '?'}</span>
                                </div>
                                <div className="mt-1 text-gray-300">Sản phẩm: <span className="font-mono text-green-300">{recipe.output_code}</span> x{recipe.output_qty || 1}</div>
                                <div className="mt-1 text-gray-500 truncate">Nguyên liệu: {recipe.requirementText}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="space-y-1 md:col-span-2">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Recipe đã chọn</label>
                          <input
                            type="text"
                            value={tempSettings.recipe_code || ''}
                            onChange={(e) => updateTempSetting('recipe_code', e.target.value.trim())}
                            placeholder="Ví dụ: r_pill_lk_sta"
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none font-mono"
                          />
                          <p className="text-[11px] text-gray-500">Có thể pick từ danh sách hoặc nhập tay recipe_code.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Số lần craft / vòng</label>
                          <input
                            type="number"
                            min="1"
                            max="50"
                            value={tempSettings.times_per_run || 1}
                            onChange={(e) => updateTempSetting('times_per_run', Math.max(1, Number(e.target.value) || 1))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ craft, giây</label>
                          <input
                            type="number"
                            min="5"
                            value={tempSettings.interval_seconds || 20}
                            onChange={(e) => updateTempSetting('interval_seconds', Math.max(5, Number(e.target.value) || 20))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Lỗi thật thì nghỉ, phút</label>
                          <input
                            type="number"
                            min="1"
                            value={tempSettings.pause_on_fail_minutes || 30}
                            onChange={(e) => updateTempSetting('pause_on_fail_minutes', Math.max(1, Number(e.target.value) || 30))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          />
                          <p className="text-[11px] text-gray-500">Fail do tỉ lệ không tính là lỗi, không pause.</p>
                        </div>
                        <label className="flex items-center gap-2 rounded border border-orange-900/40 bg-orange-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_load_recipes !== false}
                            onChange={(e) => updateTempSetting('auto_load_recipes', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-orange-500"
                          />
                          Tự tải recipe nếu cache rỗng
                        </label>
                        <div className="rounded border border-gray-700 bg-gray-950/40 p-3 text-xs text-gray-400">
                          {selectedRecipe ? (
                            <div className="space-y-1">
                              <div>Đã chọn: <span className="font-mono text-orange-200">{selectedRecipe.recipe_code}</span></div>
                              <div>Tier: <span className="text-gray-200">{getCraftTierLabel(selectedRecipe.tierCode || tempSettings.tier)}</span></div>
                              <div>Sản phẩm: <span className="font-mono text-green-300">{selectedRecipe.output_code}</span></div>
                            </div>
                          ) : <div>Chưa chọn recipe.</div>}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <label className="flex items-center gap-2 rounded border border-amber-900/40 bg-amber-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_open_containers !== false}
                            onChange={(e) => updateTempSetting('auto_open_containers', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-orange-500"
                          />
                          Thiếu nguyên liệu thì mở rương
                        </label>
                        <label className="flex items-center gap-2 rounded border border-amber-900/40 bg-amber-950/10 p-3 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_use_recovery_items !== false}
                            onChange={(e) => updateTempSetting('auto_use_recovery_items', e.target.checked)}
                            className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-orange-500"
                          />
                          Hết STA / thần hồn → đan thấp→cao (lk→lh)
                        </label>
                        <div className="space-y-1 md:col-span-2">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Tối đa viên / lần thiếu</label>
                          <input
                            type="number"
                            min={1}
                            max={30}
                            value={tempSettings.max_recovery_uses ?? 8}
                            onChange={(e) => updateTempSetting('max_recovery_uses', Math.max(1, Number(e.target.value) || 8))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-orange-500 outline-none"
                          />
                        </div>
                      </div>

                      <div className="rounded border border-gray-700 bg-gray-900/40 p-3 text-[11px] text-gray-500 space-y-1">
                        <p>Hết STA/thần hồn → tự thử <code className="text-gray-300">pill_lk_sta/spirit</code> → tc → kd → na → ht → lh. Hết cấp thấp mới dùng cấp cao. Có thể uống nhiều viên nếu 1 viên chưa đủ.</p>
                        <p>Craft OK khi success &gt; 0. Fail tỉ lệ → không pause. Thiếu NL → mở rương.</p>
                      </div>

                      <div className="pt-3 border-t border-gray-700"><button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">{viewingAccount ? 'Lưu Setting Auto Craft' : 'Lưu Setting Cho TK Đã Chọn'}</button></div>
                    </div>
                    );
                  })()}

                  {/* Mail / Giftcode Settings */}
                  {selectedFeatureId === 'mail_giftcode' && (
                    <div className="space-y-4">
                      <div className="rounded border border-purple-900/50 bg-purple-950/10 p-3">
                        <div className="text-sm font-semibold text-purple-200 mb-1">Mail / Giftcode</div>
                        <p className="text-[11px] text-gray-500">
                          Một ô chung cho nhập giftcode và claim mail. Nếu bật nhập giftcode, bot sẽ nhập giftcode xong trước rồi mới claim mail.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                          <input type="checkbox" checked={tempSettings.claim_mail !== false} onChange={(e) => updateTempSetting('claim_mail', e.target.checked)} className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-purple-500" />
                          Claim tất cả mail sau giftcode
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                          <input type="checkbox" checked={tempSettings.giftcode_enabled === true || String(tempSettings.giftcodes || '').trim() !== ''} onChange={(e) => updateTempSetting('giftcode_enabled', e.target.checked)} className="w-4 h-4 bg-gray-900 border-gray-600 rounded text-purple-500" />
                          Nhập giftcode
                        </label>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-xs uppercase tracking-wider text-gray-400">Chế độ nhập giftcode</label>
                        <select value={tempSettings.mode || 'until_success_count'} onChange={(e) => updateTempSetting('mode', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-purple-500 outline-none">
                          <option value="until_success_count">Nhập đến khi đủ số code thành công rồi dừng</option>
                          <option value="try_all_for_each_account">Nhập toàn bộ danh sách cho mỗi account</option>
                          <option value="shared_pool_remove_attempted">Pool chung: code đã thử sẽ xoá khỏi list</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-xs uppercase tracking-wider text-gray-400">Số code thành công cần đạt</label>
                        <input type="number" min={1} value={tempSettings.success_target ?? 1} onChange={(e) => updateTempSetting('success_target', Number(e.target.value) || 1)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-purple-500 outline-none" />
                        <p className="text-[11px] text-gray-500">Ví dụ đặt 1: thành công 1 code thì dừng account đó.</p>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-xs uppercase tracking-wider text-gray-400">Danh sách giftcode</label>
                        <textarea value={tempSettings.giftcodes || ''} onChange={(e) => updateTempSetting('giftcodes', e.target.value)} placeholder="Mỗi dòng 1 code" className="w-full h-36 bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-purple-500 outline-none font-mono" />
                        <p className="text-[11px] text-gray-500">Mode pool chung sẽ tự xoá code đã thử, dù thành công hoặc thất bại; các account dùng khoá tuần tự riêng để tránh nhập trùng mã.</p>
                      </div>

                      <div className="pt-3 border-t border-gray-700 flex flex-wrap gap-2">
                        <button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">
                          {viewingAccount ? 'Lưu Setting Mail/Giftcode' : 'Lưu Setting Cho TK Đã Chọn'}
                        </button>
                      </div>
                    </div>
                  )}

                  {selectedFeatureId === 'me_cung' && (
                    <div className="space-y-4">
                      <div className="rounded border border-indigo-900/50 bg-indigo-950/20 p-3 text-xs text-indigo-100">
                        <div className="font-semibold mb-1">Giai đoạn 3: Mê Cung thật</div>
                        <div className="text-gray-400">Flow mỗi lượt: start → reward → key → door → reward again → boss → claim final. Mặc định chạy 3 lượt, maxPasses=5, không quét ô trống, không đụng trap/fire/merchant/monster.</div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Map / Tier</label>
                          <select
                            value={tempSettings.tier || 1}
                            onChange={(e) => updateTempSetting('tier', Number(e.target.value))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          >
                            {[1, 2, 3, 4, 5, 6].map(tier => (
                              <option key={tier} value={tier}>Tier {tier}</option>
                            ))}
                          </select>
                          <p className="text-[11px] text-gray-500">Hiện hỗ trợ tổng cộng 6 tier.</p>
                        </div>

                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">HP reserve trước boss</label>
                          <input
                            type="number"
                            min="0"
                            value={tempSettings.boss_hp_reserve ?? 5}
                            onChange={(e) => updateTempSetting('boss_hp_reserve', Number(e.target.value))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          />
                          <p className="text-[11px] text-gray-500">Không đánh boss nếu HP thấp hơn boss_cost + reserve.</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <label className="flex items-center gap-2 rounded bg-gray-900/60 border border-gray-700 p-2">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_boss !== false}
                            onChange={(e) => updateTempSetting('auto_boss', e.target.checked)}
                            className="rounded bg-gray-700 border-gray-600 text-indigo-500"
                          />
                          <span>Auto đánh boss cuối</span>
                        </label>
                        <label className="flex items-center gap-2 rounded bg-gray-900/60 border border-gray-700 p-2">
                          <input
                            type="checkbox"
                            checked={tempSettings.auto_claim_final !== false}
                            onChange={(e) => updateTempSetting('auto_claim_final', e.target.checked)}
                            className="rounded bg-gray-700 border-gray-600 text-indigo-500"
                          />
                          <span>Auto claim cuối</span>
                        </label>
                        <label className="flex items-center gap-2 rounded bg-gray-900/60 border border-gray-700 p-2 text-gray-400">
                          <input type="checkbox" checked readOnly className="rounded bg-gray-700 border-gray-600 text-indigo-500" />
                          <span>Skip monster</span>
                        </label>
                        <label className="flex items-center gap-2 rounded bg-gray-900/60 border border-gray-700 p-2 text-gray-400">
                          <input type="checkbox" checked readOnly className="rounded bg-gray-700 border-gray-600 text-indigo-500" />
                          <span>Skip trap/fire/merchant</span>
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Số lượt đi Mê Cung</label>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={tempSettings.run_count ?? 3}
                            onChange={(e) => updateTempSetting('run_count', Number(e.target.value))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          />
                          <p className="text-[11px] text-gray-500">Mặc định 3 lượt/ngày theo số lượt miễn phí.</p>
                        </div>

                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Số vòng xử lý tối đa</label>
                          <input
                            type="number"
                            min="1"
                            max="30"
                            value={tempSettings.max_passes ?? 5}
                            onChange={(e) => updateTempSetting('max_passes', Number(e.target.value))}
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                          />
                          <p className="text-[11px] text-gray-500">Mặc định 5 vòng xử lý trong mỗi lượt Mê Cung.</p>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-gray-700 flex flex-wrap gap-2">
                        <button
                          onClick={handleSaveSettings}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
                        >
                          {viewingAccount ? 'Lưu Setting Mê Cung' : 'Lưu Setting Cho TK Đã Chọn'}
                        </button>
                        <p className="w-full text-[11px] text-gray-500">Mê Cung sẽ chạy bằng nút Chạy chung nếu tài khoản đã tick chức năng này. Sau khi chạy xong sẽ tự chờ reset 0h Việt Nam để chạy lại.</p>
                      </div>
                    </div>
                  )}

                  {/* Craft Settings */}
                  {selectedFeatureId === 'craft' && (
                    <div className="space-y-1">
                      <label className="block text-xs uppercase tracking-wider text-gray-400">Chế độ Chế tạo (20s/lần)</label>
                      <select className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none">
                        <option value="auto">Tự động ưu tiên (Auto)</option>
                        <option value="r_pill_lk_mp">Chỉ craft MP (r_pill_lk_mp)</option>
                        <option value="r_pill_lk_sta">Chỉ craft Thể lực (r_pill_lk_sta)</option>
                        <option value="off">Tắt</option>
                      </select>
                    </div>
                  )}

                  {/* Origin Settings */}
                  {selectedFeatureId === 'origin' && (
                    <div className="space-y-1">
                      <label className="block text-xs uppercase tracking-wider text-gray-400">Mục tiêu Tẩy tuỷ</label>
                      <select className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none">
                        <option value="auto">Tự động phân tích</option>
                        <option value="moc">Hệ Mộc (Wood)</option>
                        <option value="hoa">Hệ Hoả (Fire)</option>
                        <option value="tho">Hệ Thổ (Earth)</option>
                        <option value="kim">Hệ Kim (Metal)</option>
                        <option value="thuy">Hệ Thuỷ (Water)</option>
                      </select>
                    </div>
                  )}

                  {/* Auto Equip Settings */}
                  {selectedFeatureId === 'auto_equip' && (
                    <div className="space-y-4">
                      <div className="rounded border border-emerald-900/50 bg-emerald-950/10 p-3">
                        <div className="text-sm font-semibold text-emerald-200 mb-1">Tự động mặc đồ</div>
                        <p className="text-[11px] text-gray-500">Tự đọc rpc_get_equipment/túi đồ, tính điểm theo rolled_stats thực tế rồi mặc món có chỉ số cao nhất theo từng slot. Nếu slot đang trống thì tự mặc món tốt nhất vào.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Kiểu ưu tiên chỉ số</label>
                          <select value={tempSettings.weight_preset || 'highest_stats'} onChange={(e) => updateTempSetting('weight_preset', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none">
                            <option value="highest_stats">Chỉ số cao nhất</option>
                            <option value="balanced">Cân bằng tổng lực</option>
                            <option value="attack">Ưu tiên ATK</option>
                            <option value="defense">Ưu tiên DEF</option>
                            <option value="hp">Ưu tiên HP</option>
                            <option value="custom">Tự chỉnh trọng số</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Điểm chênh tối thiểu mới mặc (0 = slot trống thì mặc ngay)</label>
                          <input type="number" min={0} value={tempSettings.min_score_gain ?? 0} onChange={(e) => updateTempSetting('min_score_gain', Number(e.target.value) || 0)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ check, giây</label>
                          <input type="number" min={30} value={tempSettings.interval_seconds ?? 300} onChange={(e) => updateTempSetting('interval_seconds', Number(e.target.value) || 300)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none" />
                        </div>
                      </div>

                      {tempSettings.weight_preset === 'custom' && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 rounded border border-gray-700 bg-gray-900/60 p-3">
                          <div className="space-y-1"><label className="block text-xs text-gray-400">ATK</label><input type="number" step="0.1" value={tempSettings.weight_atk ?? 1.5} onChange={(e) => updateTempSetting('weight_atk', Number(e.target.value) || 1.5)} className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-sm text-gray-200" /></div>
                          <div className="space-y-1"><label className="block text-xs text-gray-400">DEF</label><input type="number" step="0.1" value={tempSettings.weight_def ?? 1.2} onChange={(e) => updateTempSetting('weight_def', Number(e.target.value) || 1.2)} className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-sm text-gray-200" /></div>
                          <div className="space-y-1"><label className="block text-xs text-gray-400">HP</label><input type="number" step="0.01" value={tempSettings.weight_hp ?? 0.1} onChange={(e) => updateTempSetting('weight_hp', Number(e.target.value) || 0.1)} className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-sm text-gray-200" /></div>
                          <div className="space-y-1"><label className="block text-xs text-gray-400">MP</label><input type="number" step="0.01" value={tempSettings.weight_mp ?? 0.05} onChange={(e) => updateTempSetting('weight_mp', Number(e.target.value) || 0.05)} className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-sm text-gray-200" /></div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chỉ check slot này, bỏ trống là tất cả</label>
                          <input value={tempSettings.slot_filter || ''} onChange={(e) => updateTempSetting('slot_filter', e.target.value)} placeholder="weapon, armor, helmet, boots, ring..." className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none font-mono" />
                          <p className="text-[11px] text-gray-500">Mỗi slot cách nhau bằng dấu phẩy. Bỏ trống để bot tự xét tất cả slot nhận diện được.</p>
                        </div>
                        <div className="space-y-2 rounded border border-gray-700 bg-gray-900/50 p-3">
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" checked={tempSettings.dry_run === true} onChange={(e) => updateTempSetting('dry_run', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-emerald-500" />
                            Chỉ quét thử, không mặc thật
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" checked={tempSettings.allow_unknown_equipment === true} onChange={(e) => updateTempSetting('allow_unknown_equipment', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-emerald-500" />
                            Cho phép thử item chưa rõ loại trang bị
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" checked={tempSettings.allow_zero_score !== false} onChange={(e) => updateTempSetting('allow_zero_score', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-emerald-500" />
                            Nếu slot trống vẫn mặc item 0 điểm
                          </label>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">RPC đọc túi đồ</label>
                          <textarea rows={2} value={tempSettings.inventory_rpc || 'rpc_get_equipment\nrpc_list_inventory'} onChange={(e) => updateTempSetting('inventory_rpc', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none font-mono" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">RPC đọc đồ đang mặc</label>
                          <input value={tempSettings.equipment_rpc || 'rpc_get_equipment'} onChange={(e) => updateTempSetting('equipment_rpc', e.target.value)} placeholder="để trống để tự thử" className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none font-mono" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">RPC mặc đồ</label>
                          <input value={tempSettings.equip_rpc || ''} onChange={(e) => updateTempSetting('equip_rpc', e.target.value)} placeholder="để trống để tự thử" className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-emerald-500 outline-none font-mono" />
                        </div>
                      </div>
                    </div>
                  )}


                  {selectedFeatureId === 'breakthrough' && (
                    <div className="space-y-4">
                      <div className="rounded border border-yellow-900/50 bg-yellow-950/10 p-3">
                        <div className="text-sm font-semibold text-yellow-200 mb-1">Tự động đột phá level</div>
                        <p className="text-[11px] text-gray-500">Khi EXP đạt 100%, bot tìm instance đan trong túi rồi gọi rpc_breakthrough_v1. Nếu không có đan, bot mua theo item code bạn cấu hình rồi đọc lại túi để lấy p_pill_instance_id.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Danh sách mã đan ưu tiên</label>
                          <textarea value={tempSettings.pill_item_codes || 'pill_lk_minor\npill_lk_major'} onChange={(e) => updateTempSetting('pill_item_codes', e.target.value)} rows={4} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none font-mono" />
                          <p className="text-[11px] text-gray-500">Mỗi dòng 1 mã. Bot thử theo thứ tự từ trên xuống. Ví dụ: pill_lk_minor, pill_lk_major.</p>
                        </div>

                        <div className="space-y-3">
                          <label className="flex items-center gap-2 text-sm text-gray-200">
                            <input type="checkbox" checked={tempSettings.auto_buy_pill !== false} onChange={(e) => updateTempSetting('auto_buy_pill', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-yellow-500" />
                            Không có đan thì tự mua
                          </label>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="block text-xs uppercase tracking-wider text-gray-400">Shop code</label>
                              <input value={tempSettings.shop_code || 'alchemy'} onChange={(e) => updateTempSetting('shop_code', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none font-mono" />
                            </div>
                            <div className="space-y-1">
                              <label className="block text-xs uppercase tracking-wider text-gray-400">Số lượng mua</label>
                              <input type="number" min={1} value={tempSettings.buy_qty ?? 1} onChange={(e) => updateTempSetting('buy_qty', Number(e.target.value) || 1)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none" />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Ngưỡng EXP, %</label>
                          <input type="number" min={1} max={100} step="0.01" value={tempSettings.full_exp_threshold_percent ?? 99.99} onChange={(e) => updateTempSetting('full_exp_threshold_percent', Number(e.target.value) || 99.99)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ kiểm tra, giây</label>
                          <input type="number" min={10} value={tempSettings.interval_seconds ?? 60} onChange={(e) => updateTempSetting('interval_seconds', Number(e.target.value) || 60)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Lỗi thì nghỉ, phút</label>
                          <input type="number" min={1} value={tempSettings.pause_on_fail_minutes ?? 30} onChange={(e) => updateTempSetting('pause_on_fail_minutes', Number(e.target.value) || 30)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-yellow-500 outline-none" />
                        </div>
                      </div>
                    </div>
                  )}

                  {selectedFeatureId === 'buff' && (
                    <div className="space-y-4">
                      <div className="rounded border border-pink-900/50 bg-pink-950/10 p-3">
                        <div className="text-sm font-semibold text-pink-200 mb-1">Tự động Buff vật phẩm</div>
                        <p className="text-[11px] text-gray-500">Tick vật phẩm muốn buff. Bot sẽ gọi RPC guarded tương ứng; nếu vật phẩm còn hiệu lực hoặc server chặn dùng lại, bot ghi log và chờ vòng sau.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="rounded border border-gray-700 bg-gray-900/40 p-3 space-y-2">
                          <label className="flex items-center gap-2 text-sm text-gray-200">
                            <input type="checkbox" checked={tempSettings.enable_formation_buff !== false} onChange={(e) => updateTempSetting('enable_formation_buff', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-pink-500" />
                            Buff trận pháp / Formation
                          </label>
                          <div className="space-y-1">
                            <label className="block text-xs uppercase tracking-wider text-gray-400">Item code</label>
                            <input value={tempSettings.formation_item_code || 'formation_lk_dragon'} onChange={(e) => updateTempSetting('formation_item_code', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-pink-500 outline-none font-mono" />
                          </div>
                          <p className="text-[11px] text-gray-500">RPC: rpc_activate_formation_guarded</p>
                        </div>

                        <div className="rounded border border-gray-700 bg-gray-900/40 p-3 space-y-2">
                          <label className="flex items-center gap-2 text-sm text-gray-200">
                            <input type="checkbox" checked={tempSettings.enable_talisman_buff !== false} onChange={(e) => updateTempSetting('enable_talisman_buff', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-pink-500" />
                            Buff phù / Talisman
                          </label>
                          <div className="space-y-1">
                            <label className="block text-xs uppercase tracking-wider text-gray-400">Item code</label>
                            <input value={tempSettings.talisman_item_code || 'talisman_lk_crit'} onChange={(e) => updateTempSetting('talisman_item_code', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-pink-500 outline-none font-mono" />
                          </div>
                          <p className="text-[11px] text-gray-500">RPC: rpc_activate_talisman_guarded</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chu kỳ buff lại, giây</label>
                          <input type="number" min={30} value={tempSettings.interval_seconds ?? 300} onChange={(e) => updateTempSetting('interval_seconds', Number(e.target.value) || 300)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-pink-500 outline-none" />
                          <p className="text-[11px] text-gray-500">Mặc định 300 giây. Formation trong preview có duration 86400s, Talisman 21600s.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chế độ lỗi</label>
                          <select value={tempSettings.stop_on_all_failed === true ? 'stop' : 'wait'} onChange={(e) => updateTempSetting('stop_on_all_failed', e.target.value === 'stop')} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-pink-500 outline-none">
                            <option value="wait">Lỗi thì chờ vòng sau</option>
                            <option value="stop">Tất cả lỗi thì báo lỗi</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  {selectedFeatureId === 'hoang_co' && (
                    <div className="space-y-4">
                      <div className="rounded border border-amber-900/50 bg-amber-950/10 p-3">
                        <div className="text-sm font-semibold text-amber-200 mb-1">Auto Hoàng Cổ — Phá cờ / Chiếm central / Chiếm resource / Chiếm vệ tinh</div>
                        <p className="text-[11px] text-gray-500">6 chế độ: any (phá cờ gần nhất), central (phá sạch box rồi chiếm central — tự động chiếm vệ tinh trước nếu thiếu), clan_wipe (phá hết cờ 1 bang), resource (chiếm mỏ ưu tiên gần→xa), resource_all (chiếm hết mọi mỏ), satellites (chiếm hết vệ tinh). Central & resource đều cần cờ đồng minh cheby≤1 với mục tiêu.</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Chế độ phá</label>
                          <select value={tempSettings.break_mode || 'any'} onChange={(e) => updateTempSetting('break_mode', e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none">
                            <option value="any">Phá any (gần nhất)</option>
                            <option value="central">Chiếm central</option>
                            <option value="clan_wipe">Tất cả cờ 1 bang</option>
                            <option value="resource">Chiếm resource (mỏ, ưu tiên gần→xa)</option>
                            <option value="resource_all">Chiếm hết resource (mọi mỏ)</option>
                            <option value="satellites">Chiếm vệ tinh (satellites)</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Tên bang cần phá (clan_wipe, trống = mọi địch)</label>
                          <input value={tempSettings.target_clan_name || ''} onChange={(e) => updateTempSetting('target_clan_name', e.target.value)} placeholder="Tên bang hội" className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none font-mono" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Bán kính central (box)</label>
                          <input type="number" min={4} value={tempSettings.central_radius ?? 12} onChange={(e) => updateTempSetting('central_radius', Number(e.target.value) || 12)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Acc quét scan tập trung (trống = tự quét)</label>
                          <input value={tempSettings.hc_scanner_account_id || ''} onChange={(e) => updateTempSetting('hc_scanner_account_id', e.target.value)} placeholder="character id" className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none font-mono" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Scan hết hạn sau (ms)</label>
                          <input type="number" min={1000} value={tempSettings.scan_stale_ms ?? 8000} onChange={(e) => updateTempSetting('scan_stale_ms', Number(e.target.value) || 8000)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Bán kính chip resource</label>
                          <input type="number" min={1} value={tempSettings.resource_attack_radius ?? 3} onChange={(e) => updateTempSetting('resource_attack_radius', Number(e.target.value) || 3)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs uppercase tracking-wider text-gray-400">Bán kính né địch (flee)</label>
                          <input type="number" min={1} max={3} value={tempSettings.flee_radius ?? 2} onChange={(e) => updateTempSetting('flee_radius', Number(e.target.value) || 2)} className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-amber-500 outline-none" />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 rounded border border-gray-700 bg-gray-900/50 p-3">
                        <label className="flex items-center gap-2 text-sm text-gray-200">
                          <input type="checkbox" checked={tempSettings.auto_break_flag === true} onChange={(e) => updateTempSetting('auto_break_flag', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-amber-500" />
                          Bật mission Phá cờ (cắm→xây→phá)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-200">
                          <input type="checkbox" checked={tempSettings.auto_capture_resource !== false} onChange={(e) => updateTempSetting('auto_capture_resource', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-amber-500" />
                          Chủ động đi chiếm resource (mỏ)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-200">
                          <input type="checkbox" checked={tempSettings.attack_near_resource !== false} onChange={(e) => updateTempSetting('attack_near_resource', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-amber-500" />
                          Chip resource gần khi rảnh
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-200">
                          <input type="checkbox" checked={tempSettings.flee_on_enemy_near !== false} onChange={(e) => updateTempSetting('flee_on_enemy_near', e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-amber-500" />
                          Địch gần → tạm né
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Generic Setting Placeholder for others */}
                  {!['farm', 'craft', 'origin', 'buff', 'auto_equip', 'breakthrough', 'me_cung', 'ki_ngo', 'claim_exp', 'world_cup_checkin', 'onboarding_claim', 'body_cult', 'achievement', 'world_boss', 'mail_giftcode', 'log', 'stats', 'hoang_co'].includes(selectedFeatureId) && (
                    <div className="space-y-1">
                      <label className="block text-xs uppercase tracking-wider text-gray-400">Tuỳ chọn mặc định</label>
                      <select className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none">
                        <option>Mặc định hệ thống</option>
                        <option>Ưu tiên tốc độ</option>
                        <option>Tiết kiệm tài nguyên</option>
                      </select>
                    </div>
                  )}
{selectedFeatureId !== 'me_cung' && selectedFeatureId !== 'mail_giftcode' && selectedFeatureId !== 'ki_ngo' && !['claim_exp','world_cup_checkin','onboarding_claim','body_cult','achievement','world_boss'].includes(selectedFeatureId) && (
                    <div className="pt-4 border-t border-gray-700 flex justify-end">
                      <button onClick={handleSaveSettings} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">
                        {viewingAccount ? 'Lưu Cho Tài Khoản Này' : 'Lưu Cho Các TK Đã Chọn'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  {renderFeatureSummaryPanel()}

                  {!viewingAccount && checkedAccountIds.size > 0 && (
                    <p className="text-xs text-yellow-500 bg-yellow-900/20 p-2 rounded border border-yellow-800/50">
                      Cấu hình này sẽ được áp dụng cho {checkedAccountIds.size} tài khoản đang được tích chọn trên danh sách.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Thêm Tài Khoản */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
          <div className="bg-gray-800 border border-gray-700 p-4 rounded w-96 shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-200">Thêm Tài Khoản Mới</h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-gray-500 hover:text-white"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs text-gray-400">Định dạng: email|password (mỗi dòng 1 tk)</label>
              <textarea 
                value={addInput}
                onChange={(e) => setAddInput(e.target.value)}
                className="w-full h-32 bg-gray-900 border border-gray-600 rounded p-2 text-sm text-gray-200 focus:border-blue-500 outline-none font-mono"
                placeholder="testgame1@gmail.com|123456&#10;testgame2@gmail.com|123456"
              />
              <button 
                onClick={handleAddAccounts}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-semibold transition-colors"
              >
                Xác Nhận Thêm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
