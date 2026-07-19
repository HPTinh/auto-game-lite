import fs from "fs";
import path from "path";
import { config, defaultFeatureSettings, type FeatureId } from "./config";
import type { Account, AppLog, FeatureConfig, LogLevel, PublicAccount, StoreData } from "./types";

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function defaultFeatures(enabled: FeatureId[] = ["farm", "buff", "claim_exp", "breakthrough", "world_boss", "achievement", "mail"]): Account["features"] {
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
          // không lưu log quá dài vào disk
          logs: (a.logs || []).slice(0, 30),
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
    this.addLog(acc.id, "SYS", "INFO", "Đã thêm tài khoản.");
    this.persist();
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
    this.addLog(id, "AUTH", "INFO", "Đã cập nhật password trên server.");
    this.notify();
    return acc;
  }

  addLog(id: string, module: string, level: LogLevel, message: string) {
    const acc = this.accounts.get(id);
    if (!acc) return;
    const log: AppLog = {
      id: uid(),
      time: new Date().toISOString(),
      module,
      level,
      message: String(message || "").slice(0, 500),
    };
    acc.logs = [log, ...(acc.logs || [])].slice(0, config.maxLogs);
    acc.updatedAt = new Date().toISOString();
    this.persist();
    // log spam: không notify mỗi dòng — UI poll
  }
}

export const store = new Store();
