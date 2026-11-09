import { env } from '../lib/env';
import { seoulDateString, seoulHour } from '../lib/time';
import { isAnyPlayerActive, usedTempFiles } from './player';
import { cleanupOrphans } from './tempFiles';
import { logYtdlpVersion, updateYtdlp } from './ytdlp';

/**
 * 하루 1번 관리 작업: yt-dlp 업데이트 + 남은 임시 파일 정리.
 * 새벽 5시(KST) 이후 처음으로 아무도 재생하지 않을 때 실행 (재생 중이면 다음 확인 때로 미룸)
 */
const CHECK_INTERVAL_MS = 10 * 60_000;
const DAILY_HOUR = 5;

let timer: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;
let running = false;

async function runMaintenance(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    console.log(`[maintenance] 시작 (${reason})`);
    if (env.ytdlpAutoUpdate) {
      await updateYtdlp();
      logYtdlpVersion();
    }
    await cleanupOrphans(usedTempFiles());
  } catch (error) {
    console.error('[maintenance] 오류', error);
  } finally {
    running = false;
  }
}

function tick(): void {
  const today = seoulDateString();
  if (lastRunDate === today || seoulHour() < DAILY_HOUR || isAnyPlayerActive()) return;
  lastRunDate = today;
  void runMaintenance('매일 점검');
}

/** 봇 시작 시 1번 (재생 전이라 안전) + 매일 점검 예약 */
export function startMaintenance(): void {
  if (timer) return;
  lastRunDate = seoulDateString();
  void runMaintenance('봇 시작');
  timer = setInterval(tick, CHECK_INTERVAL_MS);
}

export function stopMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
