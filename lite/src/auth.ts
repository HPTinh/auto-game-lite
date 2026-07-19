import { config } from "./config";
import { store } from "./store";

const pickFirst = (...values: any[]) => values.find((v) => v !== undefined && v !== null && v !== "");

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
  store.addLog(accountId, "AUTH", "INFO", force ? "Đăng nhập lại..." : "Đang đăng nhập...");

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
  store.addLog(accountId, "AUTH", "SUCCESS", "Đăng nhập OK");

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
  store.addLog(accountId, "CHAR", "SUCCESS", `NV: ${characterName || characterId}`);

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
      patch.level = pickFirst(snapChar?.level_reach, snapChar?.level, snapData?.level, acc.level);
      patch.vipLevel = pickFirst(snapData?.vip_level, snapData?.vip, snapChar?.vip_level, snapChar?.vip, acc.vipLevel);
      patch.hp = pickFirst(snapChar?.hp, snapData?.hp, acc.hp);
      patch.maxHp = pickFirst(snapChar?.max_hp, snapData?.max_hp, acc.maxHp);
      patch.mp = pickFirst(snapChar?.mp, snapData?.mp, acc.mp);
      patch.maxMp = pickFirst(snapChar?.max_mp, snapData?.max_mp, acc.maxMp);

      const finalStats = snapData?.stats?.final || snapData?.final || {};
      patch.atk = pickFirst(finalStats?.atk, finalStats?.attack, snapChar?.atk, acc.atk);
      patch.def = pickFirst(finalStats?.def, finalStats?.defense, snapChar?.def, acc.def);

      const realmName = pickFirst(snapChar?.realm_name, snapData?.stats?.base?.realm_name, snapData?.realm_name);
      const realmCode = pickFirst(snapChar?.realm_code, snapData?.realm_code, acc.realmCode);
      patch.realmCode = realmCode;
      patch.realmLabel = realmName || (realmCode ? realmLabelMap[String(realmCode)] || realmCode : acc.realmLabel);
    }

    // rank
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
        if (rank.data?.tokens != null) {
          /* ignore tokens detail to save RAM */
        }
        // EXP
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
    store.addLog(accountId, "INFO", "SUCCESS", `Lv ${patch.level ?? "?"} | Rank ${patch.rankLabel ?? "?"} | LS ${patch.spiritStones ?? "?"}`);
    return true;
  } catch (e: any) {
    store.addLog(accountId, "INFO", "WARN", e?.message || "Refresh info lỗi");
    return false;
  }
}
