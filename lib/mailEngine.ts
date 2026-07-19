"use client";

export type MailLogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface MailClaimResult {
  messageId: string;
  ok: boolean;
  error?: string;
  data?: any;
}

export interface MailRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "PARTIAL_ERROR" | "ERROR";
  totalMail: number;
  claimableCount: number;
  claimedCount: number;
  errorCount: number;
  results: MailClaimResult[];
}

export interface MailAutoOptions {
  characterId: string;
  accessToken: string;
  onLog?: (level: MailLogLevel, message: string, meta?: Record<string, any>) => void;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

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

function firstArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.mails)) return value.mails;
  if (Array.isArray(value?.messages)) return value.messages;
  return [];
}

function isClaimableMail(mail: any) {
  if (!mail || typeof mail !== "object") return false;
  if (mail.claimed === true || mail.is_claimed === true || mail.claimed_at) return false;
  if (mail.has_gift === true || mail.hasGift === true) return true;
  if (Array.isArray(mail.gifts) && mail.gifts.length > 0) return true;
  if (Array.isArray(mail.attachments) && mail.attachments.length > 0) return true;
  if (mail.reward || mail.rewards || mail.gift || mail.attachment) return true;
  return false;
}

function getMailMessageId(mail: any) {
  return mail?.message_id || mail?.id || mail?.mail_id || mail?.messageId || mail?.mailId;
}

export async function runMailClaimAll(options: MailAutoOptions): Promise<MailRunSummary> {
  const summary: MailRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    totalMail: 0,
    claimableCount: 0,
    claimedCount: 0,
    errorCount: 0,
    results: [],
  };

  const { characterId, accessToken, onLog } = options;
  onLog?.("INFO", "Bắt đầu claim tất cả mail.");

  const allMails: any[] = [];
  const limit = 50;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const listData = await rpc("rpc_list_mailbox", {
      p_character_id: characterId,
      p_limit: limit,
      p_offset: offset,
    }, accessToken);

    const mails = firstArray(listData);
    allMails.push(...mails);

    if (mails.length < limit) break;
  }

  summary.totalMail = allMails.length;
  const claimable = allMails.filter(isClaimableMail);
  summary.claimableCount = claimable.length;

  onLog?.("INFO", `Tìm thấy ${summary.totalMail} mail, ${summary.claimableCount} mail có quà.`);

  for (const mail of claimable) {
    const messageId = getMailMessageId(mail);
    if (!messageId) {
      summary.errorCount += 1;
      summary.results.push({ messageId: "unknown", ok: false, error: "Không tìm thấy message_id." });
      onLog?.("WARN", "Bỏ qua mail vì không tìm thấy message_id.", mail);
      continue;
    }

    try {
      const data = await rpc("rpc_claim_mail_gift_v2", {
        p_character_id: characterId,
        p_message_id: messageId,
      }, accessToken);

      summary.claimedCount += 1;
      summary.results.push({ messageId, ok: true, data });
      onLog?.("SUCCESS", `Claim mail OK: ${messageId}`, data);
    } catch (error: any) {
      summary.errorCount += 1;
      summary.results.push({ messageId, ok: false, error: error?.message, data: error?.data });
      onLog?.("WARN", `Claim mail lỗi: ${messageId} — ${error?.message || "unknown"}`, error?.data);
    }
  }

  summary.finishedAt = new Date().toISOString();

  if (summary.errorCount > 0 && summary.claimedCount === 0 && summary.claimableCount > 0) {
    summary.status = "ERROR";
  } else if (summary.errorCount > 0) {
    summary.status = "PARTIAL_ERROR";
  } else {
    summary.status = "DONE";
  }

  onLog?.(summary.status === "DONE" ? "SUCCESS" : summary.status === "PARTIAL_ERROR" ? "WARN" : "ERROR", "Kết thúc claim mail.", {
    status: summary.status,
    totalMail: summary.totalMail,
    claimable: summary.claimableCount,
    claimed: summary.claimedCount,
    errors: summary.errorCount,
  });

  return summary;
}
