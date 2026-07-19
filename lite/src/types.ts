import type { FeatureId } from "./config";

export type AccountState =
  | "IDLE"
  | "LOGGING_IN"
  | "READY"
  | "RUNNING"
  | "WAITING"
  | "ERROR"
  | "STOPPED";

export type LogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface AppLog {
  id: string;
  time: string;
  module: string;
  level: LogLevel;
  message: string;
}

export interface FeatureConfig {
  enabled: boolean;
  status: "OFF" | "PENDING" | "RUNNING" | "WAITING" | "DONE" | "ERROR";
  settings: Record<string, any>;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface Account {
  id: string;
  email: string;
  password: string;
  characterId?: string;
  characterName?: string;
  accessToken?: string;
  state: AccountState;
  level?: number | string;
  rankLabel?: number | string;
  totalScore?: number | string;
  realmCode?: string;
  realmLabel?: string;
  realmTier?: string;
  vipLevel?: number | string;
  gold?: number;
  spiritStones?: number;
  /** Sức mạnh / combat power */
  power?: number | string;
  daoCoTotal?: number | string;
  hp?: number | string;
  maxHp?: number | string;
  mp?: number | string;
  maxMp?: number | string;
  expCurrent?: number | string;
  expMax?: number | string;
  atk?: number | string;
  def?: number | string;
  features: Partial<Record<FeatureId, FeatureConfig>>;
  errorMessage?: string;
  activeTask?: string;
  logs: AppLog[];
  running: boolean;
  /** true nếu user đã Start — dùng auto-resume sau restart/wake Render */
  wantRunning?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoreData {
  version: 1;
  accounts: Account[];
  updatedAt: string;
}

export interface PublicAccount {
  id: string;
  email: string;
  characterId?: string;
  characterName?: string;
  state: AccountState;
  level?: number | string;
  rankLabel?: number | string;
  totalScore?: number | string;
  realmCode?: string;
  realmLabel?: string;
  vipLevel?: number | string;
  gold?: number;
  spiritStones?: number;
  power?: number | string;
  daoCoTotal?: number | string;
  expCurrent?: number | string;
  expMax?: number | string;
  atk?: number | string;
  def?: number | string;
  features: Partial<Record<FeatureId, FeatureConfig>>;
  errorMessage?: string;
  activeTask?: string;
  logs: AppLog[];
  running: boolean;
  updatedAt: string;
}
