/**
 * Auto Nhập Mộng
 * - rpc_nhap_mong_status  → free_left / paid_left / active_run (cur_idx, length, choices, wait_left_sec)
 * - rpc_nhap_mong_start   → p_pay: "free" | "paid"
 * - rpc_nhap_mong_choose  → p_choice_idx
 *
 * cur_idx = chỉ số câu hỏi hiện tại (0..length-1)
 * length  = tổng số câu trong run
 */

export type NhapMongLogLevel = "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface NhapMongRunSummary {
  startedAt: string;
  finishedAt: string;
  status: "DONE" | "WAITING" | "NO_RUNS" | "ERROR" | "PARTIAL";
  freeLeft?: number;
  paidLeft?: number;
  runsStarted: number;
  runsFinished: number;
  answers: number;
  lastCurIdx?: number;
  lastLength?: number;
  lastScore?: number;
  nextDelayMs: number;
  reason?: string;
}

export interface NhapMongAutoOptions {
  characterId: string;
  accessToken: string;
  settings?: Record<string, any>;
  onLog?: (level: NhapMongLogLevel, message: string, meta?: any) => void;
  shouldStop?: () => boolean;
}

const BASE_URL = "https://jeassefmlprfnlszgvbs.supabase.co";
const GAME_API_KEY = "sb_publishable_vNnNBJooTMczVrWP7qCnhA_479q9nKB";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function rpc(name: string, payload: Record<string, any>, accessToken: string) {
  const res = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: GAME_API_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-profile": "public",
      "content-type": "application/json",
      "x-client-info": "auto-lite/1.0",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(`[${name}] HTTP ${res.status}: ${text || res.statusText}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  if (data && data.ok === false) {
    const reason = data.error || data.reason || data.message || data.code || "ok_false";
    const err: any = new Error(`[${name}] ${reason}`);
    err.data = data;
    throw err;
  }
  return data;
}

function getRun(statusOrStart: any): any | null {
  return statusOrStart?.active_run || statusOrStart?.run || null;
}

function isRunActive(run: any): boolean {
  if (!run) return false;
  if (run.settled === true) return false;
  if (run.ending_code) return false;
  return true;
}

function isRunFinished(chooseRes: any, run: any): boolean {
  if (chooseRes?.finished === true) return true;
  if (run?.settled === true) return true;
  if (run?.ending_code) return true;
  const cur = Number(run?.cur_idx);
  const len = Number(run?.length);
  // cur_idx đạt length → hết câu
  if (Number.isFinite(cur) && Number.isFinite(len) && len > 0 && cur >= len) return true;
  // không còn current/choices
  if (run && !run.current && Number.isFinite(cur) && Number.isFinite(len) && cur >= len - 1) {
    /* ambiguous */
  }
  return false;
}

/** Chọn đáp án: ưu tiên safe / gamble / first */
function pickChoiceIdx(choices: any[], prefer: string): number {
  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) return 0;

  const pref = String(prefer || "safe").toLowerCase();
  if (pref === "first") {
    return Number(list[0]?.idx ?? 0);
  }
  if (pref === "gamble") {
    const g = list.find((c) => String(c?.kind || "").toLowerCase() === "gamble");
    if (g) return Number(g.idx ?? 0);
  }
  // safe (default) — kind safe, fallback first non-gamble, rồi idx 0
  const safe = list.find((c) => String(c?.kind || "").toLowerCase() === "safe");
  if (safe) return Number(safe.idx ?? 0);
  const nonGamble = list.find((c) => String(c?.kind || "").toLowerCase() !== "gamble");
  if (nonGamble) return Number(nonGamble.idx ?? 0);
  return Number(list[0]?.idx ?? 0);
}

function choiceLabel(choices: any[], idx: number): string {
  const c = (choices || []).find((x) => Number(x?.idx) === idx) || (choices || [])[idx];
  return String(c?.label_vi || c?.label || c?.kind || idx);
}

export async function runNhapMongAuto(options: NhapMongAutoOptions): Promise<NhapMongRunSummary> {
  const settings = options.settings || {};
  const onLog = options.onLog;
  const prefer = String(settings.prefer_choice || settings.prefer || "safe").toLowerCase();
  const useFree = settings.use_free !== false;
  const usePaid = settings.use_paid === true;
  const maxRuns = Math.max(1, Math.min(30, Math.floor(Number(settings.max_runs_per_cycle || 3)) || 3));
  const maxAnswers = Math.max(1, Math.min(200, Math.floor(Number(settings.max_answers_per_cycle || 40)) || 40));
  const maxWaitSec = Math.max(0, Math.min(600, Math.floor(Number(settings.max_inline_wait_sec || 30)) || 30));
  const intervalMin = Math.max(5, Math.min(24 * 60, Number(settings.interval_minutes || 30) || 30));

  const summary: NhapMongRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "DONE",
    runsStarted: 0,
    runsFinished: 0,
    answers: 0,
    nextDelayMs: intervalMin * 60_000,
  };

  try {
    let status = await rpc("rpc_nhap_mong_status", { p_character_id: options.characterId }, options.accessToken);
    summary.freeLeft = Number(status?.free_left ?? 0);
    summary.paidLeft = Number(status?.paid_left ?? 0);

    onLog?.(
      "INFO",
      `Nhập Mộng: free ${summary.freeLeft}/${status?.free_per_day ?? "?"} · paid ${summary.paidLeft}/${status?.paid_per_day ?? "?"} · prefer=${prefer}`
    );

    if (status?.allowed === false) {
      summary.status = "NO_RUNS";
      summary.reason = "not_allowed";
      onLog?.("WARN", "Nhập Mộng: account không được phép chơi");
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    let answersLeft = maxAnswers;
    let runsLeft = maxRuns;

    const processActiveRun = async (runIn: any): Promise<"finished" | "waiting" | "error" | "stopped"> => {
      let run = runIn;
      while (isRunActive(run) && answersLeft > 0) {
        if (options.shouldStop?.()) return "stopped";

        const waitSec = Math.max(0, Number(run?.wait_left_sec || 0));
        if (waitSec > 0) {
          if (waitSec <= maxWaitSec) {
            onLog?.("INFO", `Nhập Mộng: chờ ${waitSec}s trước câu tiếp...`);
            await sleep(waitSec * 1000 + 200);
          } else {
            summary.status = "WAITING";
            summary.nextDelayMs = Math.max(5_000, waitSec * 1000 + 500);
            summary.reason = `wait ${waitSec}s`;
            summary.lastCurIdx = Number(run?.cur_idx);
            summary.lastLength = Number(run?.length);
            onLog?.("INFO", `Nhập Mộng: chờ ${waitSec}s (cur ${run?.cur_idx}/${run?.length}) · hẹn lại`);
            return "waiting";
          }
        }

        const current = run?.current;
        const choices = current?.choices || [];
        if (!choices.length) {
          // có thể đã hết câu — refresh status
          status = await rpc("rpc_nhap_mong_status", { p_character_id: options.characterId }, options.accessToken);
          run = getRun(status);
          if (!isRunActive(run)) return "finished";
          if (!(run?.current?.choices || []).length) {
            onLog?.("WARN", "Nhập Mộng: không có choices — dừng run");
            return "error";
          }
          continue;
        }

        const idx = pickChoiceIdx(choices, prefer);
        const label = choiceLabel(choices, idx);
        const curIdx = Number(run?.cur_idx ?? 0);
        const length = Number(run?.length ?? 0);

        try {
          const chooseRes = await rpc(
            "rpc_nhap_mong_choose",
            { p_character_id: options.characterId, p_choice_idx: idx },
            options.accessToken
          );
          answersLeft -= 1;
          summary.answers += 1;

          run = getRun(chooseRes) || chooseRes?.run || run;
          summary.lastCurIdx = Number(run?.cur_idx ?? curIdx);
          summary.lastLength = Number(run?.length ?? length);
          summary.lastScore = Number(run?.score ?? summary.lastScore);

          const qName = current?.name_vi || current?.code || "?";
          onLog?.(
            "SUCCESS",
            `NM câu ${curIdx + 1}/${length || "?"} · chọn [${idx}] ${label} · ${qName} · score ${run?.score ?? "?"}`
          );

          if (isRunFinished(chooseRes, run)) {
            summary.runsFinished += 1;
            onLog?.("SUCCESS", `Nhập Mộng: xong 1 run · score ${run?.score ?? "?"} · answers ${summary.answers}`);
            return "finished";
          }
        } catch (e: any) {
          const msg = e?.message || String(e);
          // cooldown
          if (/wait|cooldown|chờ|too.?fast|rush/i.test(msg)) {
            summary.status = "WAITING";
            summary.nextDelayMs = Math.max(15_000, Number(run?.wait_left_sec || 30) * 1000);
            onLog?.("WARN", `Nhập Mộng: chờ — ${msg.slice(0, 100)}`);
            return "waiting";
          }
          onLog?.("ERROR", `Nhập Mộng choose lỗi: ${msg.slice(0, 120)}`);
          return "error";
        }

        await sleep(400);
      }

      if (!isRunActive(run)) return "finished";
      return answersLeft <= 0 ? "waiting" : "finished";
    };

    // Vòng xử lý: run đang dở trước, rồi start free/paid
    while (runsLeft > 0 && answersLeft > 0) {
      if (options.shouldStop?.()) break;

      status = await rpc("rpc_nhap_mong_status", { p_character_id: options.characterId }, options.accessToken);
      summary.freeLeft = Number(status?.free_left ?? summary.freeLeft ?? 0);
      summary.paidLeft = Number(status?.paid_left ?? summary.paidLeft ?? 0);

      let run = getRun(status);

      if (isRunActive(run)) {
        onLog?.(
          "INFO",
          `Nhập Mộng: tiếp tục run · cur_idx ${run.cur_idx}/${run.length} · score ${run.score ?? "?"}`
        );
        const r = await processActiveRun(run);
        if (r === "waiting") {
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
        if (r === "error") {
          summary.status = "PARTIAL";
          summary.nextDelayMs = 5 * 60_000;
          break;
        }
        // finished — có thể start run mới
        runsLeft -= 1;
        continue;
      }

      // Không có run active — start mới
      let pay: "free" | "paid" | null = null;
      if (useFree && Number(status?.free_left || 0) > 0) pay = "free";
      else if (usePaid && Number(status?.paid_left || 0) > 0) pay = "paid";

      if (!pay) {
        summary.status = summary.runsFinished > 0 || summary.answers > 0 ? "DONE" : "NO_RUNS";
        summary.reason = "hết free/paid trong ngày";
        summary.nextDelayMs = intervalMin * 60_000;
        onLog?.("WARN", `Nhập Mộng: hết lượt · free ${status?.free_left ?? 0} · paid ${status?.paid_left ?? 0} · hẹn ${intervalMin}p`);
        break;
      }

      try {
        onLog?.("INFO", `Nhập Mộng: start run (${pay})...`);
        const startRes = await rpc(
          "rpc_nhap_mong_start",
          { p_character_id: options.characterId, p_pay: pay },
          options.accessToken
        );
        summary.runsStarted += 1;
        run = getRun(startRes);
        if (!isRunActive(run)) {
          // start xong nhưng resumed finished?
          onLog?.("WARN", "Nhập Mộng: start OK nhưng không có active_run");
          runsLeft -= 1;
          continue;
        }
        const r = await processActiveRun(run);
        if (r === "waiting") {
          summary.finishedAt = new Date().toISOString();
          return summary;
        }
        if (r === "error") {
          summary.status = "PARTIAL";
          summary.nextDelayMs = 5 * 60_000;
          break;
        }
        runsLeft -= 1;
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (/limit|hết|no.?run|not.?allowed|already/i.test(msg)) {
          summary.status = "NO_RUNS";
          summary.reason = msg.slice(0, 120);
          onLog?.("WARN", `Nhập Mộng: ${summary.reason}`);
          break;
        }
        summary.status = "ERROR";
        summary.reason = msg.slice(0, 160);
        onLog?.("ERROR", `Nhập Mộng start lỗi: ${summary.reason}`);
        summary.nextDelayMs = 5 * 60_000;
        break;
      }
    }

    if (summary.status === "DONE" && summary.answers === 0 && summary.runsFinished === 0) {
      summary.status = "NO_RUNS";
    }

    // Còn free/run dở → check sớm hơn
    if (summary.status === "DONE" || summary.status === "PARTIAL") {
      const fl = Number(summary.freeLeft || 0);
      if (fl > 0 || usePaid) {
        summary.nextDelayMs = Math.min(summary.nextDelayMs, 10 * 60_000);
      }
    }

    onLog?.(
      "INFO",
      `Nhập Mộng xong · runs ${summary.runsFinished}/${summary.runsStarted} · answers ${summary.answers} · next ${Math.round(summary.nextDelayMs / 1000)}s`
    );
  } catch (e: any) {
    summary.status = "ERROR";
    summary.reason = e?.message || String(e);
    summary.nextDelayMs = 5 * 60_000;
    onLog?.("ERROR", `Nhập Mộng fail: ${summary.reason}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
