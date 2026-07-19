import fs from "fs";
import path from "path";
import { config, defaultFeatureSettings, type FeatureId } from "./config";
import type { Account, AppLog, FeatureConfig, LogLevel, PublicAccount, StoreData } from "./types";

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function defaultFeatures(enabled: FeatureId[] = ["farm", "buff", "claim_exp", "breakthrough", "world_boss", "achievement", "mail", "pvp"]): Account["features"] {
  const defaults = defaultFeatureSettings();
  const features: Account["features"] = {};
  (Object.keys(defaults) as FeatureId[]).forEach((id) => {
    features[id] = {
      enabled: enabled.includes(id),
      status: enabled.includes(id) ? "PENDING" : "OFF",
      settings: { ...defaults[id] },
    };
  });
  return features;
}

class Store {
  private accounts = new Map<string, Account>();
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();

  load() {
    ensureDir(config.dataDir);
    if (!fs.existsSync(config.accountsFile)) {
      this.persist(true);
      return;
    }
    try {
      const raw = fs.readFileSync(config.accountsFile, "utf8");
      const data = JSON.parse(raw) as StoreData;
      this.accounts.clear();
      for (const acc of data.accounts || []) {
        // Process restart: reset runtime flags; wantRunning giữ lại để auto-resume
        if (acc.wantRunning === undefined) acc.wantRunning = Boolean(acc.running);
        acc.running = false;
        acc.state = acc.state === "ERROR" ? "ERROR" : acc.wantRunning ? "IDLE" : "IDLE";
        acc.activeTask = undefined;
        if (!acc.features) acc.features = defaultFeatures();
        else {
          // merge feature mới (pvp, setting farm mới) mà không ghi đè enabled user đã chọn
          const defaults = defaultFeatures([]);
          for (const [fid, def] of Object.entries(defaults)) {
            if (!acc.features[fid as FeatureId]) {
              acc.features[fid as FeatureId] = def;
            } else {
              acc.features[fid as FeatureId]!.settings = {
                ...def.settings,
                ...(acc.features[fid as FeatureId]!.settings || {}),
              };
            }
          }
        }
        if (!Array.isArray(acc.logs)) acc.logs = [];
        this.accounts.set(acc.id, acc);
      }
    } catch (e) {
      console.error("[store] load failed", e);
    }
  }

  private persist(immediate = false) {
    const write = () => {
      ensureDir(config.dataDir);
      const data: StoreData = {
        version: 1,
        accounts: Array.from(this.accounts.values()).map((a) => ({
          ...a,
          // log chỉ trên RAM — disk chỉ giữ vài dòng gần nhất (tránh phình file)
          logs: (a.logs || []).slice(0, 8),
        })),
        updatedAt: new Date().toISOString(),
      };
      const tmp = config.accountsFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, config.accountsFile);
    };

    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      write();
      return;
    }

    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        write();
      } catch (e) {
        console.error("[store] save failed", e);
      }
    }, 1500);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  list(): Account[] {
    return Array.from(this.accounts.values());
  }

  get(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  toPublic(acc: Account): PublicAccount {
    return {
      id: acc.id,
      email: acc.email,
      characterId: acc.characterId,
      characterName: acc.characterName,
      state: acc.state,
      level: acc.level,
      rankLabel: acc.rankLabel,
      totalScore: acc.totalScore,
      realmCode: acc.realmCode,
      realmLabel: acc.realmLabel,
      vipLevel: acc.vipLevel,
      gold: acc.gold,
      spiritStones: acc.spiritStones,
      expCurrent: acc.expCurrent,
      expMax: acc.expMax,
      atk: acc.atk,
      def: acc.def,
      features: acc.features,
      errorMessage: acc.errorMessage,
      activeTask: acc.activeTask,
      logs: acc.logs || [],
      running: acc.running,
      updatedAt: acc.updatedAt,
    };
  }

  listPublic(): PublicAccount[] {
    return this.list().map((a) => this.toPublic(a));
  }

  addAccount(email: string, password: string, enabledFeatures?: FeatureId[]): Account {
    const now = new Date().toISOString();
    const acc: Account = {
      id: uid(),
      email: email.trim().toLowerCase(),
      password,
      state: "IDLE",
      features: defaultFeatures(enabledFeatures),
      logs: [],
      running: false,
      gold: 0,
      spiritStones: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(acc.id, acc);
    this.persist(true);
    this.notify();
    return acc;
  }

  removeAccount(id: string) {
    this.accounts.delete(id);
    this.persist(true);
    this.notify();
  }

  update(id: string, patch: Partial<Account>, opts?: { silent?: boolean }) {
    const acc = this.accounts.get(id);
    if (!acc) return null;
    Object.assign(acc, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    if (!opts?.silent) this.notify();
    return acc;
  }

  setFeature(id: string, featureId: FeatureId, patch: Partial<FeatureConfig>) {
    const acc = this.accounts.get(id);
    if (!acc) return null;
    const defaults = defaultFeatureSettings();
    const current = acc.features[featureId] || {
      enabled: false,
      status: "OFF" as const,
      settings: { ...defaults[featureId] },
    };
    const nextEnabled = patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled;
    let nextStatus = patch.status !== undefined ? patch.status : current.status;
    if (patch.enabled === false) nextStatus = "OFF";
    else if (patch.enabled === true && (current.status === "OFF" || !current.status)) nextStatus = "PENDING";

    acc.features[featureId] = {
      ...current,
      ...patch,
      enabled: nextEnabled,
      status: nextStatus,
      settings: { ...defaults[featureId], ...current.settings, ...(patch.settings || {}) },
    };
    acc.updatedAt = new Date().toISOString();
    // Feature toggle/settings: ghi disk ngay để không bị mất khi refresh UI
    this.persist(true);
    this.notify();
    return acc;
  }

  setPassword(id: string, password: string) {
    const acc = this.accounts.get(id);
    if (!acc) return null;
    acc.password = password;
    acc.updatedAt = new Date().toISOString();
    this.persist(true);
    this.notify();
    return acc;
  }

  /** Backup đầy đủ (có password + features/settings) — dùng restore sau redeploy */
  exportBackup(): StoreData {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts: this.list().map((a) => ({
        ...a,
        accessToken: undefined, // token hết hạn nhanh — không cần backup
        running: false,
        activeTask: undefined,
        errorMessage: undefined,
        logs: [],
        state: "IDLE" as const,
      })),
    };
  }

  /**
   * Restore/merge backup theo email.
   * - Trùng email: giữ id hiện tại, cập nhật password + features/settings (không mất setting).
   * - Email mới: thêm account.
   */
  importBackup(raw: any, opts?: { replace?: boolean }): { imported: number; updated: number; added: number } {
    const list: any[] = Array.isArray(raw?.accounts) ? raw.accounts : Array.isArray(raw) ? raw : [];
    let updated = 0;
    let added = 0;

    if (opts?.replace) {
      this.accounts.clear();
    }

    for (const row of list) {
      const email = String(row?.email || "")
        .trim()
        .toLowerCase();
      const password = String(row?.password || "");
      if (!email || !password) continue;

      const existing = this.list().find((a) => a.email === email);
      const defaults = defaultFeatures([]);
      const incomingFeatures = row.features && typeof row.features === "object" ? row.features : {};

      // merge features: defaults ← existing ← backup
      const mergedFeatures: Account["features"] = { ...defaults };
      for (const fid of Object.keys(defaults) as FeatureId[]) {
        const fromBackup = incomingFeatures[fid];
        const fromExist = existing?.features?.[fid];
        mergedFeatures[fid] = {
          enabled: Boolean(fromBackup?.enabled ?? fromExist?.enabled ?? false),
          status: "OFF",
          settings: {
            ...defaults[fid]!.settings,
            ...(fromExist?.settings || {}),
            ...(fromBackup?.settings || {}),
          },
          lastRunAt: fromBackup?.lastRunAt || fromExist?.lastRunAt,
        };
      }

      if (existing) {
        existing.password = password;
        existing.features = mergedFeatures;
        existing.characterId = row.characterId || existing.characterId;
        existing.characterName = row.characterName || existing.characterName;
        existing.level = row.level ?? existing.level;
        existing.wantRunning = Boolean(row.wantRunning ?? existing.wantRunning);
        existing.running = false;
        existing.state = "IDLE";
        existing.updatedAt = new Date().toISOString();
        // clear expired token so next check re-login
        if (row.forceRelogin !== false) existing.accessToken = undefined;
        updated += 1;
      } else {
        const now = new Date().toISOString();
        const id = String(row.id || uid());
        const acc: Account = {
          id: this.accounts.has(id) ? uid() : id,
          email,
          password,
          characterId: row.characterId,
          characterName: row.characterName,
          level: row.level,
          features: mergedFeatures,
          logs: [],
          running: false,
          wantRunning: Boolean(row.wantRunning),
          state: "IDLE",
          gold: Number(row.gold) || 0,
          spiritStones: Number(row.spiritStones) || 0,
          createdAt: row.createdAt || now,
          updatedAt: now,
        };
        this.accounts.set(acc.id, acc);
        added += 1;
      }
    }

    this.persist(true);
    this.notify();
    return { imported: updated + added, updated, added };
  }

  /**
   * Ghi log in-memory. Không ghi disk mỗi dòng (tránh spam I/O Render).
   * Dedupe dòng trùng liên tiếp: gộp thành message (×N).
   */
  addLog(id: string, module: string, level: LogLevel, message: string, opts?: { force?: boolean }) {
    const acc = this.accounts.get(id);
    if (!acc) return;

    const msg = String(message || "").slice(0, 280);
    if (!msg) return;

    const logs = acc.logs || [];
    const head = logs[0];
    // Gộp trùng liên tiếp cùng module+level+message
    if (
      !opts?.force &&
      head &&
      head.module === module &&
      head.level === level &&
      normalizeSame(head.message) === normalizeSame(msg)
    ) {
      const base = head.message.replace(/\s*\(×\d+\)\s*$/, "");
      const m = head.message.match(/\(×(\d+)\)\s*$/);
      const n = m ? Number(m[1]) + 1 : 2;
      head.message = `${base} (×${n})`;
      head.time = new Date().toISOString();
      acc.updatedAt = head.time;
      return;
    }

    const log: AppLog = {
      id: uid(),
      time: new Date().toISOString(),
      module,
      level,
      message: msg,
    };
    acc.logs = [log, ...logs].slice(0, config.maxLogs);
    acc.updatedAt = log.time;
    // Không persist disk — log chỉ trên RAM; account/settings vẫn persist chỗ khác
  }
}

function normalizeSame(message: string) {
  return String(message || "")
    .replace(/\s*\(×\d+\)\s*$/, "")
    .trim();
}

export const store = new Store();
