/**
 * Uống đan STA / spirit: ưu tiên từ thấp → cao (lk → tc → kd → na → ht → lh).
 * Ví dụ hết pill_lk_sta thì thử pill_tc_sta...
 */

export const PILL_TIERS = ["lk", "tc", "kd", "na", "ht", "lh"] as const;
export type PillTier = (typeof PILL_TIERS)[number];
export type PillKind = "stamina" | "spirit";

export function isUseItemOk(used: any): boolean {
  if (!used || typeof used !== "object") return false;
  if (used.ok === false) return false;
  const reason = String(used.reason || used.error || used.message || used.code || "").toLowerCase();
  if (
    reason &&
    /not_found|missing|no_item|item_not|insufficient|not_enough|không|het|hết|fail|error|invalid|out_of|empty/.test(
      reason
    )
  ) {
    return false;
  }
  if (used.used || used.item_code || used.itemCode) return true;
  if (used.heal_stamina != null || used.heal_spirit != null) return true;
  if (used.stamina_after != null || used.spirit_after != null) return true;
  return used.ok === true;
}

/**
 * Danh sách mã đan theo thứ tự thử.
 * - custom item_code (nếu có) thử trước
 * - sau đó pill_lk_* → … → pill_lh_*
 * - preferredCode (đã dùng OK lần trước trong session) đẩy lên đầu sau custom
 */
export function orderedPillCodes(
  kind: PillKind,
  settings: Record<string, any> = {},
  preferredCode?: string
): string[] {
  const suffix = kind === "stamina" ? "sta" : "spirit";
  const custom =
    kind === "stamina"
      ? String(settings.stamina_item_code || settings.recover_stamina_item_code || "").trim()
      : String(settings.spirit_item_code || settings.soul_item_code || settings.recover_spirit_item_code || "").trim();

  const codes: string[] = [];
  const push = (c: string) => {
    const x = String(c || "").trim();
    if (x && !codes.includes(x)) codes.push(x);
  };

  if (custom) push(custom);
  if (preferredCode) push(preferredCode);

  // Thấp → cao: lk → tc → kd → na → ht → lh
  for (const t of PILL_TIERS) {
    push(`pill_${t}_${suffix}`);
  }

  return codes;
}

export type UsePillRpc = (itemCode: string) => Promise<any>;

export interface TryPillsResult {
  ok: boolean;
  itemCode?: string;
  used?: any;
  tried: Array<{ itemCode: string; ok: boolean; raw?: any }>;
}

/**
 * Thử uống đan từ thấp → cao cho đến khi 1 mã OK.
 * preferredCode: nhớ mã đã thành công để lần sau thử trước (vẫn fallback full list).
 */
export async function tryUsePillsLowToHigh(args: {
  kind: PillKind;
  settings?: Record<string, any>;
  preferredCode?: string;
  rpcUse: UsePillRpc;
  onLog?: (level: "INFO" | "SUCCESS" | "WARN" | "DEBUG", message: string, meta?: any) => void;
  sleepMs?: number;
}): Promise<TryPillsResult> {
  const { kind, settings = {}, preferredCode, rpcUse, onLog } = args;
  const sleepMs = Math.max(0, Number(args.sleepMs ?? 500) || 500);
  const codes = orderedPillCodes(kind, settings, preferredCode);
  const tried: TryPillsResult["tried"] = [];
  const label = kind === "stamina" ? "STA" : "thần hồn";

  onLog?.("INFO", `Hồi ${label}: thử đan thấp→cao (${codes.slice(0, 3).join(" → ")}…)`);

  for (const itemCode of codes) {
    let used: any;
    try {
      used = await rpcUse(itemCode);
    } catch (err: any) {
      used = err?.data || { ok: false, reason: err?.message || "use_item_error" };
    }
    const ok = isUseItemOk(used);
    tried.push({ itemCode, ok, raw: used });
    if (ok) {
      const extra =
        kind === "stamina" && used?.heal_stamina != null
          ? ` · +${used.heal_stamina} STA → ${used.stamina_after ?? "?"}/${used.stamina_max ?? "?"}`
          : kind === "spirit" && used?.heal_spirit != null
            ? ` · +${used.heal_spirit} spirit → ${used.spirit_after ?? "?"}/${used.spirit_max ?? "?"}`
            : "";
      onLog?.("SUCCESS", `Đã dùng ${itemCode}${extra}`);
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
      return { ok: true, itemCode, used, tried };
    }
    onLog?.(
      "DEBUG",
      `${itemCode} không dùng được (${String(used?.message || used?.reason || used?.error || "fail")}) → thử cấp cao hơn`
    );
    if (sleepMs) await new Promise((r) => setTimeout(r, Math.min(300, sleepMs)));
  }

  onLog?.("WARN", `Hết đan ${label}: đã thử ${tried.map((t) => t.itemCode).join(", ")}`);
  return { ok: false, tried };
}
