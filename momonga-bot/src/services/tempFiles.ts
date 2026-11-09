import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/env';
import { UserFacingError } from '../lib/errors';
import { formatBytes } from '../lib/format';

const AUDIO_EXT = '.webm';

export function newTempFilePath(guildId: string): string {
  return path.join(env.tempDir, `${guildId}-${randomUUID()}${AUDIO_EXT}`);
}

/** 봇 시작 시: 폴더 생성 + 이전 실행에서 남은 오디오 파일 삭제 (.webm만) */
export async function prepareTempDir(): Promise<void> {
  await mkdir(env.tempDir, { recursive: true });
  const names = await readdir(env.tempDir);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(AUDIO_EXT)) continue;
    if (await removeFile(path.join(env.tempDir, name))) removed++;
  }
  console.log(`[temp] ${env.tempDir} 준비 완료 (남은 파일 ${removed}개 삭제)`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 파일 삭제. Windows는 프로세스 종료 직후 파일이 잠겨 있을 수 있어 몇 번 재시도.
 * 없으면 성공으로 취급. 끝내 실패하면 false (다음 시작 때 정리됨)
 */
export async function removeFile(filePath: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rm(filePath, { force: true });
      return true;
    } catch (error) {
      if (attempt === 5) {
        console.warn(`[temp] 삭제 실패: ${filePath}`, error);
        return false;
      }
      await sleep(300 * attempt);
    }
  }
  return false;
}

/** 새 곡을 받기 전 남아 있어야 할 디스크 공간 (8시간 영상 약 0.5GB + 미리 받기 여유) */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** 디스크 여유 공간 확인. 부족하면 사용자 안내 에러 (확인 자체가 실패하면 통과) */
export async function ensureDiskSpace(): Promise<void> {
  let free: number;
  try {
    const fsStat = await statfs(env.tempDir);
    free = fsStat.bavail * fsStat.bsize;
  } catch {
    return;
  }
  if (free < MIN_FREE_BYTES) {
    console.warn(`[temp] 디스크 여유 공간 부족: ${formatBytes(free)}`);
    throw new UserFacingError('봇 PC의 저장 공간이 부족해서 곡을 받을 수 없어요.');
  }
}

/**
 * 사용 중이 아닌데 남아 있는 오디오 파일 삭제 (삭제 실패·비정상 종료로 남은 것).
 * 방금 만들어진 파일은 건드리지 않도록 10분 이상 된 것만
 */
export async function cleanupOrphans(inUse: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(env.tempDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 10 * 60_000;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(AUDIO_EXT)) continue;
    const filePath = path.join(env.tempDir, name);
    if (inUse.has(filePath)) continue;
    try {
      if ((await stat(filePath)).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    if (await removeFile(filePath)) removed++;
  }
  if (removed > 0) console.log(`[temp] 남아 있던 파일 ${removed}개 정리`);
}
