import { config } from "./config";
import { store } from "./store";

const pickFirst = (...values: any[]) => values.find((v) => v !== undefined && v !== null && v !== "");

const isPlainObject = (value: any): value is Record<string, any> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

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

function getHomeFinalStats(snapshot: any): Record<string, any> {
  const candidates = [
    snapshot?.stats?.final,
    snapshot?.final,
    snapshot?.final_stats,
    snapshot?.finalStats,
    snapshot?.stats?.final_stats,
    snapshot?.stats?.finalStats,
  ];
  return (candidates.find(isPlainObject) || {}) as Record<string, any>;
}

function pickCombatStat(source: any, stat: "atk" | "def"): any {
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
      source?.attributes?.attack
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
    source?.attributes?.defense
  );
}

function extractCombatStats(snapshot: any, character: any = {}, fallback: { atk?: any; def?: any } = {}) {
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
    fallback.atk
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
    fallback.def
  );
  return { atk, def };
}

/** Sức mạnh / combat power — quét nhiều field giống game */
function extractPower(snapshot: any, character: any = {}, fallback?: any): any {
  const finalStats = getHomeFinalStats(snapshot);
  const base = snapshot?.stats?.base || {};
  return pickFirst(
    snapshot?.power_rating,
    snapshot?.powerRating,
    snapshot?.combat_power,
    snapshot?.combatPower,
    snapshot?.battle_power,
    snapshot?.battlePower,
    snapshot?.total_power,
    snapshot?.totalPower,
    snapshot?.force,
    snapshot?.cp,
    finalStats?.power,
    finalStats?.power_rating,
    finalStats?.combat_power,
    finalStats?.battle_power,
    base?.power,
    base?.power_rating,
    base?.combat_power,
    character?.power_rating,
    character?.powerRating,
    character?.combat_power,
    character?.battle_power,
    character?.power,
    snapshot?.character?.power_rating,
    snapshot?.character?.combat_power,
    snapshot?.profile?.power_rating,
    fallback
  );
}

function extractVip(snapshot: any, character: any = {}, fallback?: any): any {
  return pickFirst(
    snapshot?.vip_level,
    snapshot?.vip,
    snapshot?.vipLevel,
    character?.vip_level,
    character?.vip,
    character?.vipLevel,
    snapshot?.account?.vip_level,
    snapshot?.account?.vip,
    snapshot?.profile?.vip_level,
    snapshot?.profile?.vip,
    snapshot?.stats?.vip_level,
    snapshot?.stats?.vip,
    snapshot?.user?.vip_level,
    fallback
  );
}

function parseJwtPayload(token?: string): any | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function isAccessTokenExpired(token?: string) {
  const payload = parseJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  if (!exp) return true;
  return Date.now() / 1000 > exp - 90;
}

async function gameFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

export async function loginAccount(accountId: string, force = false) {
  const acc = store.get(accountId);
  if (!acc) throw new Error("Account not found");
  if (!acc.password) throw new Error("Thiếu password");

  if (!force && acc.accessToken && !isAccessTokenExpired(acc.accessToken) && acc.characterId) {
    return { accessToken: acc.accessToken, characterId: acc.characterId };
  }

  store.update(accountId, { state: "LOGGING_IN", activeTask: "Đăng nhập", errorMessage: undefined });

  const { res, data } = await gameFetch(`${config.gameBaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: config.gameApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: acc.email, password: acc.password }),
  });

  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.error || "Lỗi đăng nhập";
    store.update(accountId, { state: "ERROR", activeTask: undefined, errorMessage: msg });
    store.addLog(accountId, "AUTH", "ERROR", String(msg));
    throw new Error(String(msg));
  }

  const token = data.access_token as string;
  store.update(accountId, { accessToken: token });

  // character
  store.update(accountId, { activeTask: "Lấy nhân vật" });
  const char = await gameFetch(`${config.gameBaseUrl}/rest/v1/characters?select=*`, {
    method: "GET",
    headers: {
      apikey: config.gameApiKey,
      authorization: `Bearer ${token}`,
    },
  });

  if (!char.res.ok || !Array.isArray(char.data) || char.data.length === 0) {
    const msg = "Không tìm thấy nhân vật";
    store.update(accountId, { state: "ERROR", activeTask: undefined, errorMessage: msg });
    store.addLog(accountId, "CHAR", "ERROR", msg);
    throw new Error(msg);
  }

  const character = char.data[0];
  const characterId = character.id as string;
  const characterName = pickFirst(character.name, character.display_name, character.nickname, character.character_name);
  const level = pickFirst(character.level_reach, character.level, character.rank, 1);

  store.update(accountId, {
    characterId,
    characterName,
    level,
    accessToken: token,
  });

  await refreshAccountInfo(accountId);
  return { accessToken: token, characterId };
}

export async function ensureRuntime(accountId: string) {
  const acc = store.get(accountId);
  if (!acc) return null;

  let token = acc.accessToken;
  let charId = acc.characterId;

  if (!token || isAccessTokenExpired(token) || !charId) {
    try {
      const r = await loginAccount(accountId, true);
      token = r.accessToken;
      charId = r.characterId;
    } catch {
      return null;
    }
  }

  if (!token || !charId) return null;
  return { accessToken: token, characterId: charId };
}

export async function refreshAccountInfo(accountId: string) {
  const runtime = await ensureRuntime(accountId);
  if (!runtime) return false;
  const acc = store.get(accountId);
  if (!acc) return false;

  try {
    const snap = await gameFetch(`${config.gameBaseUrl}/rest/v1/rpc/rpc_get_home_snapshot`, {
      method: "POST",
      headers: {
        apikey: config.gameApiKey,
        authorization: `Bearer ${runtime.accessToken}`,
        "content-profile": "public",
        "content-type": "application/json",
        "x-client-info": "auto-lite/1.0",
      },
      body: JSON.stringify({ p_character_id: runtime.characterId }),
    });

    const patch: any = { state: acc.running ? acc.state : "READY", activeTask: acc.running ? acc.activeTask : undefined };

    if (snap.res.ok && snap.data) {
      const snapData = snap.data;
      const snapChar = snapData?.character || snapData?.character_info || snapData?.profile || {};
      const wallet = snapData?.wallet || snapData?.resources || {};

      patch.spiritStones = pickFirst(
        snapData?.spirit_stones,
        wallet?.spirit_stones,
        snapData?.resources?.spirit_stones,
        acc.spiritStones,
        0
      );
      patch.gold = pickFirst(
        snapData?.sect_contribution?.points,
        wallet?.sect_contribution,
        wallet?.gold,
        wallet?.bac,
        snapData?.bac,
        acc.gold,
        0
      );
      patch.level = pickFirst(
        snapChar?.level_reach,
        snapChar?.level,
        snapChar?.rank,
        snapData?.level,
        snapData?.level_reach,
        acc.level
      );
      // VIP — nhiều path như bản local
      patch.vipLevel = extractVip(snapData, snapChar, acc.vipLevel);
      patch.hp = pickFirst(snapChar?.hp, snapData?.hp, snapData?.current_hp, acc.hp);
      patch.maxHp = pickFirst(snapChar?.max_hp, snapData?.max_hp, acc.maxHp);
      patch.mp = pickFirst(snapChar?.mp, snapData?.mp, snapData?.current_mp, acc.mp);
      patch.maxMp = pickFirst(snapChar?.max_mp, snapData?.max_mp, acc.maxMp);

      // ATK / DEF / Power (sức mạnh)
      const combat = extractCombatStats(snapData, snapChar, { atk: acc.atk, def: acc.def });
      patch.atk = combat.atk;
      patch.def = combat.def;
      patch.power = extractPower(snapData, snapChar, acc.power);

      const realmName = pickFirst(snapChar?.realm_name, snapData?.stats?.base?.realm_name, snapData?.realm_name);
      const realmCode = pickFirst(snapChar?.realm_code, snapData?.realm_code, acc.realmCode);
      patch.realmCode = realmCode;
      patch.realmLabel = realmName || (realmCode ? realmLabelMap[String(realmCode)] || realmCode : acc.realmLabel);
    }

    // rank + dao cơ + score
    try {
      const rank = await gameFetch(`${config.gameBaseUrl}/rest/v1/rpc/rpc_get_rebirth_quest_progress`, {
        method: "POST",
        headers: {
          apikey: config.gameApiKey,
          authorization: `Bearer ${runtime.accessToken}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": "auto-lite/1.0",
        },
        body: JSON.stringify({ p_character_id: runtime.characterId }),
      });
      if (rank.res.ok && rank.data) {
        const q = rank.data?.quest || rank.data;
        patch.rankLabel = pickFirst(q?.rank_label, rank.data?.rank_label, acc.rankLabel);
        patch.totalScore = pickFirst(q?.total_score, rank.data?.total_score, acc.totalScore);
        patch.realmCode = pickFirst(rank.data?.realm_code, patch.realmCode, acc.realmCode);
        patch.daoCoTotal = pickFirst(rank.data?.dao_co?.total, rank.data?.dao_co_total, acc.daoCoTotal);
        // VIP fallback từ rank response nếu snapshot thiếu
        patch.vipLevel = pickFirst(patch.vipLevel, rank.data?.vip_level, rank.data?.vip, acc.vipLevel);
        patch.power = pickFirst(
          patch.power,
          rank.data?.power_rating,
          rank.data?.combat_power,
          rank.data?.power,
          acc.power
        );
        patch.expCurrent = pickFirst(
          rank.data?.exp_current,
          rank.data?.current_exp,
          q?.exp_current,
          acc.expCurrent
        );
        patch.expMax = pickFirst(rank.data?.exp_max, rank.data?.max_exp, q?.exp_max, acc.expMax);
      }
    } catch {
      /* optional */
    }

    if (!acc.running) patch.state = "READY";
    store.update(accountId, patch);

    const fmt = (x: any) => {
      if (x === undefined || x === null || x === "") return "?";
      const n = Number(x);
      return Number.isFinite(n) ? n.toLocaleString("en-US") : String(x);
    };
    store.addLog(
      accountId,
      "INFO",
      "SUCCESS",
      `OK · ${characterNameOr(accountId, patch)} · VIP ${patch.vipLevel ?? "?"} · Power ${fmt(patch.power)} · ATK ${fmt(patch.atk)} · DEF ${fmt(patch.def)} · Rank ${patch.rankLabel ?? "?"} · LS ${fmt(patch.spiritStones)}`
    );
    return true;
  } catch (e: any) {
    store.addLog(accountId, "INFO", "WARN", e?.message || "Refresh info lỗi");
    return false;
  }
}

function characterNameOr(accountId: string, patch: any) {
  const acc = store.get(accountId);
  return patch.characterName || acc?.characterName || acc?.email || accountId.slice(0, 6);
}
