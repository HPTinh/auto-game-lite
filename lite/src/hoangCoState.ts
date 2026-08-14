/**
 * Hoàng Cổ — BỂ CHUNG (shared scan store)
 * Chỉ 1 tài khoản (hc_scanner_account_id) quét map_state → ghi vào đây.
 * Các tài khoản khác đọc từ đây thay vì tự scan liên tục (bản lite, tránh nặng).
 *
 * Lưu ý: module này KHÔNG gọi RPC — nó chỉ giữ state.
 * Việc quét thực hiện ở orchestrator (scanner account gọi scanHoangCoState từ engine).
 */

import type { HoangCoRunSummary } from "../../lib/hoangCoEngine";

export interface HoangCoClanCount {
  clan_id: string;
  clan_name: string;
  flag_count: number;
}

export interface HoangCoSharedState {
  scannerId: string | null;
  lastScanAt: number; // epoch ms
  /** Tăng mỗi lần scanner publish scan mới → acc phụ so sánh để "thức" sớm khi có data tươi */
  scanVersion: number;
  map: any | null; // map_state đã parse (raw)
  myClanId: string;
  clanCounts: HoangCoClanCount[];
  centralPlan: any | null;
  wipePlan: any | null;
  /** log tóm tắt lần quét gần nhất */
  lastSummary?: string;
}

let state: HoangCoSharedState = {
  scannerId: null,
  lastScanAt: 0,
  scanVersion: 0,
  map: null,
  myClanId: "",
  clanCounts: [],
  centralPlan: null,
  wipePlan: null,
};

export function getHoangCoSharedState(): HoangCoSharedState {
  return state;
}

export function setHoangCoSharedState(partial: Partial<HoangCoSharedState>): void {
  state = { ...state, ...partial };
}

/** Bể chung còn tươi (chưa quá staleMs) không */
export function isHoangCoScanFresh(staleMs: number): boolean {
  return state.lastScanAt > 0 && Date.now() - state.lastScanAt < staleMs;
}

export function resetHoangCoSharedState(): void {
  state = {
    scannerId: null,
    lastScanAt: 0,
    scanVersion: 0,
    map: null,
    myClanId: "",
    clanCounts: [],
    centralPlan: null,
    wipePlan: null,
  };
}

/** Ghi nhận kết quả 1 lần quét từ scanner */
export function publishHoangCoScan(input: {
  scannerId: string;
  map: any;
  myClanId: string;
  clanCounts: HoangCoClanCount[];
  centralPlan?: any;
  wipePlan?: any;
  summary?: string;
}): void {
  state = {
    ...state,
    scannerId: input.scannerId,
    lastScanAt: Date.now(),
    scanVersion: state.scanVersion + 1,
    map: input.map,
    myClanId: input.myClanId,
    clanCounts: input.clanCounts,
    centralPlan: input.centralPlan ?? state.centralPlan,
    wipePlan: input.wipePlan ?? state.wipePlan,
    lastSummary: input.summary ?? state.lastSummary,
  };
}

export type { HoangCoRunSummary };
