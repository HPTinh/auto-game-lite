import type { LogLevel } from "./types";

/** Chuẩn hoá message để so trùng (bỏ số động, ms, kênh thay đổi liên tục…) */
export function normalizeLogKey(module: string, level: string, message: string): string {
  const msg = String(message || "")
    .toLowerCase()
    .replace(/\d{2}:\d{2}:\d{2}/g, ":time:")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|giây|phút|m|h)\b/gi, "#n$2")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${module}|${level}|${msg}`;
}

interface GateEntry {
  lastAt: number;
  count: number;
  lastMessage: string;
}

/** rate-limit + gộp log trùng theo account */
export class LogGate {
  private map = new Map<string, GateEntry>();

  /**
   * @returns null nếu bỏ qua; string message (có thể kèm xN) nếu cho qua
   */
  allow(
    accountId: string,
    module: string,
    level: LogLevel | string,
    message: string,
    opts?: { minIntervalMs?: number; maxBurst?: number }
  ): string | null {
    const lv = String(level || "INFO").toUpperCase();
    // ERROR luôn qua (nhưng vẫn gộp nếu spam cùng 1 lỗi)
    const minInterval =
      opts?.minIntervalMs ??
      (lv === "ERROR" ? 8_000 : lv === "WARN" ? 15_000 : lv === "SUCCESS" ? 12_000 : 25_000);

    const key = `${accountId}|${normalizeLogKey(module, lv, message)}`;
    const now = Date.now();
    const prev = this.map.get(key);

    if (!prev) {
      this.map.set(key, { lastAt: now, count: 1, lastMessage: message });
      return message;
    }

    prev.count += 1;
    const elapsed = now - prev.lastAt;

    if (elapsed < minInterval) {
      // trong cửa sổ: chặn, chỉ nhớ số lần
      return null;
    }

    const suppressed = prev.count - 1;
    prev.lastAt = now;
    prev.count = 1;
    prev.lastMessage = message;

    if (suppressed > 0) {
      return `${message} (×${suppressed + 1})`;
    }
    return message;
  }

  /** dọn map định kỳ tránh phình RAM */
  cleanup(maxAgeMs = 10 * 60_000) {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.lastAt > maxAgeMs) this.map.delete(k);
    }
  }
}

export const logGate = new LogGate();

/** Lọc log từ engine trước khi vào gate */
export function shouldAcceptEngineLog(module: string, level: string, message: string): boolean {
  const lv = String(level || "INFO").toUpperCase();
  const text = String(message || "");

  if (lv === "DEBUG") return false;

  // Soft / spam patterns chung
  const soft =
    /lỗi nhẹ|bỏ qua kênh|không list được channel|không lấy được realm|snapshot conflict|đang chờ|waiting|retry|cooldown|đã nhận|already|no_reward|not available|not_available/i.test(
      text
    );
  if (soft && lv !== "ERROR") return false;

  if (module === "FARM") {
    // Farm chỉ: ERROR, WARN quan trọng, SUCCESS, hoặc dòng tóm tắt
    if (lv === "ERROR") return true;
    if (lv === "SUCCESS") return true;
    if (lv === "WARN" && !soft) return true;
    if (lv === "INFO") {
      return /tóm tắt|summary|đủ nhiệm vụ|smart_done|dừng farm|hết mp|mua mp fail/i.test(text);
    }
    return false;
  }

  if (module === "WORLD_BOSS") {
    if (lv === "ERROR" || lv === "SUCCESS" || lv === "WARN") return true;
    // INFO: chỉ bắt đầu / claim / xong
    return /bắt đầu|claim|nhận quà|xong|done|waiting_respawn|không có boss/i.test(text);
  }

  if (module === "BUFF" || module === "CLAIM_EXP" || module === "ACHIEVEMENT" || module === "MAIL") {
    return lv === "ERROR" || lv === "SUCCESS" || lv === "WARN";
  }

  if (module === "BREAKTHROUGH") {
    if (lv === "ERROR" || lv === "SUCCESS") return true;
    // bỏ "chưa đủ EXP" lặp mỗi phút — chỉ WARN/SUCCESS/ERROR
    if (lv === "INFO" && /chưa đủ exp/i.test(text)) return false;
    return lv === "WARN";
  }

  if (module === "MAZE" || module === "CRAFT" || module === "AUTO_EQUIP") {
    return lv !== "INFO" || /bắt đầu|xong|hoàn tất|thành công|fail|lỗi/i.test(text);
  }

  // module khác: bỏ INFO thuần, giữ WARN+
  if (lv === "INFO") return false;
  return true;
}

// dọn gate mỗi 5 phút
setInterval(() => logGate.cleanup(), 5 * 60_000).unref?.();
