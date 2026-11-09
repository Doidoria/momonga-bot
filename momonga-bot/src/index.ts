import os from 'node:os';
import { env } from './lib/env';
import { client } from './lib/client';
import { registerEvents } from './events';
import { destroyAllConnections } from './services/voiceConnection';
import { destroyAllPlayers } from './services/player';
import { prepareTempDir } from './services/tempFiles';
import { stopAutoLeave } from './services/autoLeave';
import { startMaintenance, stopMaintenance } from './services/maintenance';

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException', err);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} 수신, 정리 중`);
  // 정리가 멈춰도 10초 뒤에는 종료 (pm2 kill_timeout 15초보다 짧게)
  setTimeout(() => process.exit(0), 10_000).unref();
  try {
    stopAutoLeave();
    stopMaintenance();
    await destroyAllPlayers(); // yt-dlp 종료 + 임시 파일 삭제
    destroyAllConnections();
    await client.destroy();
  } catch (err) {
    console.error('[shutdown] 정리 중 오류', err);
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows의 pm2는 시그널 대신 'shutdown' 메시지로 종료를 알림 (ecosystem: shutdown_with_message)
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown('pm2 shutdown');
});

/** 다른 프로그램이 바쁠 때도 20ms마다 보내는 오디오 패킷이 밀리지 않게 우선순위를 약간 올림 */
function raisePriority(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL);
    console.log('[boot] 프로세스 우선순위: 보통 이상');
  } catch (err) {
    console.warn('[boot] 우선순위 변경 실패 (무시)', err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  console.log(`[boot] ${env.envFile} 사용`);
  raisePriority();
  await prepareTempDir();
  startMaintenance(); // yt-dlp 업데이트 확인 + 매일 점검 예약 (백그라운드)
  registerEvents(client);
  await client.login(env.discordToken);
}

main().catch((err: unknown) => {
  console.error('[boot] 시작 실패', err);
  process.exit(1);
});
