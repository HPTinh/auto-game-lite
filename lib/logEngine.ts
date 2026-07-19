export type LogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR" | "DEBUG";

export interface AppLog {
  id: string;
  ts: number;
  time: string;
  accountId?: string;
  accountLabel?: string;
  module: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, any>;
}

export interface LogFilterOptions {
  level?: "ALL" | LogLevel;
  module?: "ALL" | string;
  search?: string;
}

const makeId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export const createLogEntry = ({
  accountId,
  accountLabel,
  module,
  level,
  message,
  meta,
}: {
  accountId?: string;
  accountLabel?: string;
  module: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, any>;
}): AppLog => {
  const now = new Date();
  return {
    id: makeId(),
    ts: now.getTime(),
    time: now.toLocaleTimeString(),
    accountId,
    accountLabel,
    module: module.toUpperCase(),
    level,
    message,
    meta,
  };
};

export const formatLogLine = (log: AppLog) => {
  const account = log.accountLabel || log.accountId || "-";
  return `[${log.time}] [${account}] [${log.module}] [${log.level}] ${log.message}`;
};

export const normalizeLogEntry = (raw: unknown): AppLog => {
  if (typeof raw === "object" && raw !== null) {
    const value = raw as Partial<AppLog>;
    return {
      id: value.id || makeId(),
      ts: typeof value.ts === "number" ? value.ts : Date.now(),
      time: value.time || new Date(value.ts || Date.now()).toLocaleTimeString(),
      accountId: value.accountId,
      accountLabel: value.accountLabel,
      module: (value.module || "SYSTEM").toUpperCase(),
      level: (value.level || "INFO") as LogLevel,
      message: value.message || "",
      meta: value.meta,
    };
  }

  const text = String(raw || "");
  const levelMatch = text.match(/\[(INFO|SUCCESS|WARN|ERROR|DEBUG)\]/);
  const moduleMatch = text.match(/\] \[([^\]]+)\] \[(INFO|SUCCESS|WARN|ERROR|DEBUG)\]/);

  return {
    id: makeId(),
    ts: Date.now(),
    time: text.match(/^\[([^\]]+)\]/)?.[1] || new Date().toLocaleTimeString(),
    module: (moduleMatch?.[1] || "LEGACY").toUpperCase(),
    level: (levelMatch?.[1] || "INFO") as LogLevel,
    message: text,
  };
};

export const normalizeLogList = (logs: unknown): AppLog[] => {
  if (!Array.isArray(logs)) return [];
  return logs.map(normalizeLogEntry).sort((a, b) => b.ts - a.ts);
};

export const prependLog = (logs: unknown, log: AppLog, max = 300): AppLog[] => {
  return [log, ...normalizeLogList(logs)].slice(0, max);
};

export const filterLogs = (logs: AppLog[], options: LogFilterOptions = {}) => {
  const search = (options.search || "").trim().toLowerCase();

  return normalizeLogList(logs).filter(log => {
    if (options.level && options.level !== "ALL" && log.level !== options.level) return false;
    if (options.module && options.module !== "ALL" && log.module !== options.module) return false;

    if (search) {
      const haystack = [
        log.time,
        log.accountLabel,
        log.accountId,
        log.module,
        log.level,
        log.message,
        log.meta ? JSON.stringify(log.meta) : "",
      ].filter(Boolean).join(" ").toLowerCase();

      if (!haystack.includes(search)) return false;
    }

    return true;
  });
};

export const countLogsByLevel = (logs: AppLog[]) => {
  const counts: Record<LogLevel | "TOTAL", number> = {
    TOTAL: 0,
    INFO: 0,
    SUCCESS: 0,
    WARN: 0,
    ERROR: 0,
    DEBUG: 0,
  };

  for (const log of normalizeLogList(logs)) {
    counts.TOTAL += 1;
    counts[log.level] += 1;
  }

  return counts;
};

export const exportLogsText = (logs: AppLog[]) => {
  return normalizeLogList(logs).map(formatLogLine).join("\n");
};
