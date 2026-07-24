import path from "path";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  /** Pass web thường — mọi người dùng (vd 0000) */
  apiKey: String(process.env.LITE_API_KEY || "").trim(),
  /**
   * Pass 2 (admin) — chỉ Export/Import backup.
   * Env: LITE_BACKUP_KEY. Không set = tắt backup API.
   */
  backupKey: String(process.env.LITE_BACKUP_KEY || process.env.LITE_ADMIN_KEY || "").trim(),
  selfPingMinutes: Math.max(0, num(process.env.SELF_PING_MINUTES, 10)),
  publicUrl: String(process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  /** Giữ log ngắn trên RAM/UI — mặc định 40 */
  maxLogs: Math.max(30, num(process.env.MAX_LOGS_PER_ACCOUNT, 60)),
  /** Delay tối thiểu giữa 2 vòng farm (ms) — mặc định 5s */
  minFarmDelayMs: Math.max(1000, num(process.env.MIN_FARM_DELAY_MS, 5000)),
  /** Render free disk mất khi redeploy — có thể trỏ volume path nếu sau này gắn disk */
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "data"),
  accountsFile: process.env.DATA_DIR
    ? path.join(path.resolve(process.env.DATA_DIR), "accounts.json")
    : path.join(process.cwd(), "data", "accounts.json"),
  gameBaseUrl: "https://jeassefmlprfnlszgvbs.supabase.co",
  gameApiKey: "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB",
};

export type FeatureId =
  | "farm"
  | "buff"
  | "claim_exp"
  | "world_boss"
  | "breakthrough"
  | "achievement"
  | "mail"
  | "maze"
  | "pvp"
  | "rank_challenge"
  | "nhap_mong"
  | "khoi_loi"
  | "ki_ngo"
  | "vip_daily"
  | "auto_equip"
  | "craft"
  | "body_cult"
  | "hoang_co"
  | "ngu_hanh_thap";

export const FEATURE_LABELS: Record<FeatureId, string> = {
  farm: "Farm quái",
  buff: "Buff",
  claim_exp: "Claim EXP",
  world_boss: "World Boss",
  breakthrough: "Đột phá",
  achievement: "Thành tựu",
  mail: "Nhận mail",
  maze: "Mê cung",
  pvp: "Auto PVP",
  rank_challenge: "Buff PVP",
  nhap_mong: "Nhập Mộng",
  khoi_loi: "Khôi Lỗi",
  ki_ngo: "Kì ngộ",
  vip_daily: "VIP daily",
  auto_equip: "Auto trang bị",
  craft: "Chế tạo",
  body_cult: "Luyện thể",
  hoang_co: "Hoàng Cổ",
  ngu_hanh_thap: "Ngũ Hành Tháp",
};

/** Setting mặc định tối ưu treo Render free */
export const defaultFeatureSettings = (): Record<FeatureId, Record<string, any>> => ({
  farm: {
    // Đơn kênh mặc định — tick multi_channel để farm dải kênh
    multi_channel: false,
    channel: 3,
    from_channel: 3,
    to_channel: 6,
    // boss_elite | boss_elite_normal | boss | elite | normal | elite_normal
    target_order: "boss_elite",
    farm_realm_tier_override: "auto",
    smart_rebirth_farm: true,
    /** chu kỳ farm (ms) — orchestrator hẹn vòng sau; engine game CD ~5s */
    attack_delay_ms: 4000,
    empty_scan_delay_ms: 4000,
    farm_log_mode: "summary",
    summary_log_interval_seconds: 1800,
    max_available_base_codes: 2,
    auto_use_mp_potion: true,
    /** Mã bình MP đang bơm — hết thì mua đúng mã này ở shop alchemy */
    mp_potion_item_code: "pill_lk_mp",
    /** Hết bình → tự mua (rpc_nh_shop_buy) */
    auto_buy_mp_potion: true,
    /** Số lượng mỗi lần mua shop: 10 (mặc định) hoặc 1 */
    mp_potion_buy_qty: 10,
    mp_potion_shop_code: "alchemy",
    smart_stop_when_quest_done: false,
    mob_cache_max_age_ms: 3000,
    no_mob_before_rotate: 1,
    /** Phản đòn quái — chỉnh tay: on | off (mặc định off) */
    apply_counter: "off",
    /** Chỉ farm mob sống + không bị đánh (HP full / không combat flag) */
    prefer_free_mobs: true,
  },
  pvp: {
    /** Số trận tối đa / ngày (user nhập) — free và PK đều nằm trong trần này */
    free_per_day: 30,
    /** Hết free game → dùng thẻ PK (vẫn ≤ free_per_day) */
    use_pk: false,
    /** Thắng → lưu ID bem dí; thua → bỏ list, tìm người khác */
    hunt_on_win: true,
    delay_ms: 1500,
    max_attacks: 10,
    max_hunt: 15,
    hunt_list: [],
    daily_date: "",
    daily_completed: 0,
    daily_locked: false,
    daily_target: 30,
  },
  rank_challenge: {
    /** board: auto | lk | tc | kd | na | ht | lh */
    board_code: "auto",
    /** Số lần WIN muốn đạt hôm nay */
    daily_target: 20,
    /** Dừng nếu N trận liên tiếp không win */
    max_no_win_streak: 10,
    /** Giữ tối đa N slot đã WIN để farm vòng */
    max_hunt: 3,
    /** Thử slot từ (1) → đến (9): thua thì nhảy slot sau */
    slot_min: 1,
    slot_max: 9,
    delay_ms: 1500,
    max_fights_per_tick: 10,
    min_level: 1,
    max_level: 99,
    board_limit: 20,
    // tự lưu
    daily_completed: 0,
    lose_streak: 0,
    daily_date: "",
    daily_locked: false,
    hunt_list: [],
    /** slot đã thua hôm nay — không đánh lại */
    skip_slots: [],
    farm_rotate: 0,
    last_board_code: "",
  },
  nhap_mong: {
    /** safe | gamble | first */
    prefer_choice: "safe",
    use_free: true,
    use_paid: false,
    /** số run mộng / lần check */
    max_runs_per_cycle: 3,
    /** số câu trả lời tối đa / lần check */
    max_answers_per_cycle: 40,
    /** chờ inline tối đa (giây) nếu wait_left_sec nhỏ */
    max_inline_wait_sec: 30,
    /** khi hết lượt free/paid */
    interval_minutes: 30,
  },
  khoi_loi: {
    /** chu kỳ claim — giờ, tối thiểu 2, mặc định 2 */
    interval_hours: 2,
    /** chỉ claim puppet có pending > 0 */
    only_with_pending: true,
    claim_delay_ms: 500,
  },
  ki_ngo: {
    /** số lần trigger / vòng check */
    max_runs_per_check: 30,
    /** khi chưa đủ daily: hẹn lại sau (giây), min 30 */
    continue_delay_seconds: 60,
    /** delay giữa 2 lần trigger trong vòng (ms) */
    loop_delay_ms: 400,
    // tiến độ ngày — tự lưu (reset 12:00 VN)
    daily_count: 0,
    daily_limit: 0,
    completed_today: false,
    last_run_at: "",
  },
  vip_daily: {
    /** tự claim rpc_vip_auto_claim_artifacts sau daily (nếu có) */
    auto_claim_artifacts: true,
    // tiến độ ngày — tool tự lưu (reset 00:00 VN)
    claimed_today: false,
    daily_date: "",
    last_claim_at: "",
    vip_level: 0,
  },
  buff: {
    interval_seconds: 300,
    enable_formation_buff: true,
    formation_item_code: "formation_lk_dragon",
    enable_talisman_buff: true,
    talisman_item_code: "talisman_lk_crit",
  },
  claim_exp: { interval_minutes: 15 },
  world_boss: {
    /**
     * Không cần user setting.
     * Bật feature → tự: boss sống = attack mỗi ~3s; boss chết = chờ hồi (giờ chẵn VN) rồi đánh tiếp.
     * Tier theo my_tier/available từ rpc_wb_channels; claim quà tự động.
     */
    auto_claim: true,
  },
  breakthrough: {
    interval_seconds: 90,
    full_exp_threshold_percent: 99.99,
    pill_item_codes: "pill_lk_minor\npill_lk_major",
    auto_buy_pill: true,
    shop_code: "alchemy",
    buy_qty: 1,
    pause_on_fail_minutes: 30,
  },
  achievement: { interval_minutes: 60 },
  mail: { claim_mail: true },
  maze: {
    tier: 1,
    /** Số lần mê cung cần chạy mỗi ngày (reset 00:00 giờ VN) */
    run_count: 3,
    max_passes: 5,
    auto_boss: true,
    auto_claim_final: true,
    boss_hp_reserve: 5,
    // trạng thái ngày — tự cập nhật, không cần user sửa
    daily_date: "",
    daily_completed: 0,
    daily_locked: false,
    skip_monster: true,
    skip_trap: true,
    skip_fire: true,
    skip_merchant: true,
  },
  auto_equip: {
    interval_seconds: 600,
    weight_preset: "highest_stats",
    auto_equip: true,
    allow_zero_score: true,
  },
  craft: {
    /**
     * category API (rpc_list_recipes p_category):
     * - alchemy = Luyện đan
     * - forging = Luyện khí
     * - talisman = Phù lục
     * - formation = Trận pháp
     */
    mode: "manual",
    category: "alchemy",
    tier: "lk",
    recipe_code: "",
    selected_output_code: "",
    selected_recipe_tier: "",
    recipe_search: "",
    times_per_run: 1,
    /** chu kỳ craft manual (giây) */
    interval_seconds: 20,
    /**
     * Craft nhanh (rpc_craft_auto) — chỉ VIP >= 5.
     * Delay mặc định 3000ms (3s/lần theo craft.txt).
     */
    use_quick_craft: false,
    quick_craft_delay_ms: 3000,
    pause_on_fail_minutes: 30,
    /** tự tải rpc_list_recipes(category) nếu recipe_cache rỗng */
    auto_load_recipes: true,
    auto_open_containers: true,
    /** Hết STA/thần hồn → thử pill_lk → tc → … → lh (thấp→cao) */
    auto_use_recovery_items: true,
    /** Override mã item (để trống = cascade auto) */
    stamina_item_code: "",
    spirit_item_code: "",
    /** Tối đa số viên uống / loại mỗi lần craft thiếu */
    max_recovery_uses: 8,
    /** cache danh sách recipe theo category — server/UI tự điền */
    recipe_cache: [],
    recipe_cache_at: "",
  },
  body_cult: { auto_start: true, body_cult_element: "metal", body_cult_session_type: "long" },
  /** Hoàng Cổ: central Thủ(còn lock) → Công(hết lock) → Thủ lại */
  hoang_co: {
    /**
     * Phá cờ (cắm → xây → phá cờ địch gần nhất).
     * Bật cái này → chỉ chạy mission phá; tắt mới dùng mở rộng/thủ/central bên dưới.
     */
    auto_break_flag: false,
    auto_place: true,
    auto_build: true,
    auto_defend: true,
    /** 1 chu ky central: thu (con lock) <-> cong (het lock / dich giu) */
    auto_central: true,
    auto_attack: false,
    focus_flag_id: null,
    focus_attack_flag_id: null,
    self_placed_flag_ids: [],
  },
  /**
   * Ngũ Hành Tháp — zero-config (chỉ bật)
   * status → leo win → thua → free sweep → chờ 00:00 VN → lặp
   */
  ngu_hanh_thap: {
    auto_use_recovery_items: true,
    /** Hiển thị / tự cập nhật từ rpc_tower_get_status */
    highest_cleared: 0,
    highest_floor: 0,
    next_floor: 1,
    sweep_charges: 0,
    display_highest: 0,
    display_next: 1,
    display_sweep_charges: 0,
    lost_today: false,
    swept_today: false,
    daily_date: "",
  },
});
