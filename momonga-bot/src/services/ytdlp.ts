import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { env } from '../lib/env';
import { UserFacingError } from '../lib/errors';
import { formatBytes } from '../lib/format';
import { resolveThumbnail } from '../lib/thumbnail';
import { isVideoId, videoUrl } from '../lib/youtube';

/** 재인코딩 없이 그대로 보낼 수 있는 webm/opus 오디오만 사용 */
const AUDIO_FORMAT = 'bestaudio[acodec=opus][ext=webm]';
const INFO_TIMEOUT_MS = 30_000;
const MAX_DURATION_SEC = 12 * 60 * 60;
const STDERR_KEEP = 4_000;
const INFO_TEMPLATE = '%(.{id,title,duration,thumbnail,webpage_url,uploader,is_live})j';

export interface TrackInfo {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  url: string;
  uploader: string | null;
}

/** yt-dlp 관련 에러 (사용자 안내 문구 포함) */
export class YtdlpError extends UserFacingError {
  constructor(userMessage: string, detail?: string) {
    super(userMessage, detail);
    this.name = 'YtdlpError';
  }
}

/** 쿠키 파일이 설정돼 있으면 모든 요청에 사용 */
function cookieArgs(): string[] {
  return env.ytdlpCookies ? ['--cookies', env.ytdlpCookies] : [];
}

function commonArgs(): string[] {
  return [
    ...cookieArgs(),
    '--no-playlist',
    // 유튜브 JS 챌린지 풀이용 런타임: 봇을 실행 중인 Node를 그대로 사용 (Deno 설치 불필요)
    '--js-runtimes', `node:${process.execPath}`,
    '--socket-timeout', '20',
    '-f', AUDIO_FORMAT,
  ];
}

function classifyError(stderr: string): YtdlpError {
  const text = stderr.toLowerCase();
  const detail = stderr.trim().slice(-500);
  if (text.includes('private video')) return new YtdlpError('비공개 영상이라 재생할 수 없어요.', detail);
  if (text.includes('confirm your age') || text.includes('age-restricted') || text.includes('inappropriate for some users'))
    return new YtdlpError('연령 제한 영상이라 재생할 수 없어요.', detail);
  if (text.includes('not a bot') || text.includes('sign in to confirm'))
    return new YtdlpError('유튜브가 봇 확인을 요구하고 있어요. 잠시 후 다시 시도해 주세요.', detail);
  if (text.includes('members-only') || text.includes('join this channel'))
    return new YtdlpError('채널 멤버십 전용 영상이라 재생할 수 없어요.', detail);
  if (text.includes('premieres in') || text.includes('live event will begin'))
    return new YtdlpError('아직 공개되지 않은 영상이에요.', detail);
  if (text.includes('requested format is not available'))
    return new YtdlpError('재생할 수 있는 오디오 형식을 찾지 못했어요. (yt-dlp 업데이트 필요할 수 있음)', detail);
  if (text.includes('video unavailable') || text.includes('not available'))
    return new YtdlpError('볼 수 없는 영상이에요. (삭제·지역 제한 등)', detail);
  if (text.includes('unsupported url') || text.includes('is not a valid url'))
    return new YtdlpError('올바른 유튜브 링크가 아니에요.', detail);
  return new YtdlpError('오디오를 받는 중 오류가 발생했어요.', detail);
}

/** -O 로 출력한 JSON 한 줄 → TrackInfo (라이브·너무 긴 영상은 에러) */
function parseInfoLine(line: string, fallbackUrl: string): TrackInfo {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new YtdlpError('영상 정보를 읽지 못했어요.', line.slice(0, 200));
  }
  if (raw.is_live === true) throw new YtdlpError('라이브 방송은 재생할 수 없어요.');
  const duration = typeof raw.duration === 'number' ? raw.duration : null;
  if (duration !== null && duration > MAX_DURATION_SEC) {
    throw new YtdlpError(`${MAX_DURATION_SEC / 3600}시간이 넘는 영상은 재생할 수 없어요.`);
  }
  return {
    id: String(raw.id ?? ''),
    title: typeof raw.title === 'string' ? raw.title : '제목 없음',
    duration,
    // yt-dlp 썸네일 주소는 404인 경우가 많아 쓰지 않음 → withThumbnail()에서 확인한 주소로 채움
    thumbnail: null,
    url: typeof raw.webpage_url === 'string' ? raw.webpage_url : fallbackUrl,
    uploader: typeof raw.uploader === 'string' ? raw.uploader : null,
  };
}

async function withThumbnail(info: TrackInfo): Promise<TrackInfo> {
  if (!isVideoId(info.id)) return info;
  return { ...info, thumbnail: await resolveThumbnail(info.id) };
}

/** Windows의 yt-dlp.exe는 자식 프로세스를 띄우므로 트리째 종료 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}

function spawnYtdlp(args: string[]): { child: ChildProcess; stderr: () => string } {
  const child = spawn(env.ytdlpPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  return { child, stderr: () => stderr };
}

/**
 * 메타데이터만 조회 (대기열에 넣을 때). 다운로드하지 않음.
 * 형식(-f)도 같이 확인하므로 재생할 수 없는 영상은 여기서 걸러짐
 */
export function fetchInfo(url: string): Promise<TrackInfo> {
  const { child, stderr } = spawnYtdlp([...commonArgs(), '-O', INFO_TEMPLATE, '--', url]);
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(() => reject(new YtdlpError('영상 정보를 불러오는 데 너무 오래 걸려요.')));
    }, INFO_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (out += chunk));
    child.once('error', (error) => {
      console.error(`[ytdlp] 실행 실패 (${env.ytdlpPath})`, error);
      done(() => reject(new YtdlpError('yt-dlp를 실행할 수 없어요. (봇 설정 확인 필요)', error.message)));
    });
    child.once('close', (code) => {
      done(() => {
        const line = out.split('\n').find((l) => l.trim().startsWith('{'));
        if (code !== 0 || !line) {
          const error = classifyError(stderr());
          console.error(`[ytdlp] 정보 조회 실패 (code ${code})\n${error.message}`);
          reject(error);
          return;
        }
        try {
          void withThumbnail(parseInfoLine(line, url)).then(resolve);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

export type DownloadStatus = 'downloading' | 'done' | 'failed' | 'cancelled';

export class DownloadJob {
  status: DownloadStatus = 'downloading';
  error: YtdlpError | null = null;
  readonly exited: Promise<void>;
  private readonly startedAt = Date.now();

  constructor(
    private readonly child: ChildProcess,
    readonly filePath: string,
    private readonly label: string,
  ) {
    this.exited = new Promise((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
  }

  /** startDownload 내부에서 프로세스 종료 결과 반영 */
  settle(code: number | null, stderr: string): void {
    if (this.status !== 'downloading') return;
    if (code === 0) {
      this.status = 'done';
      void this.size().then((bytes) => {
        const sec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        console.log(`[ytdlp] ${this.label} 다운로드 완료 (${formatBytes(bytes)}, ${sec}초)`);
      });
    } else {
      this.status = 'failed';
      this.error = classifyError(stderr);
      console.error(`[ytdlp] ${this.label} 다운로드 실패 (code ${code})\n${this.error.message}`);
    }
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }

  /** 파일이 minBytes 이상 쌓이거나 다운로드가 끝날 때까지 대기 */
  async waitForBytes(minBytes: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.status === 'failed') throw this.error ?? new YtdlpError('오디오를 받지 못했어요.');
      if (this.status === 'cancelled') throw new YtdlpError('재생이 취소됐어요.');
      const bytes = await this.size();
      if (bytes >= minBytes || (this.status === 'done' && bytes > 0)) return;
      if (this.status === 'done') throw new YtdlpError('받은 오디오가 비어 있어요.');
      if (Date.now() > deadline) throw new YtdlpError('오디오를 받는 데 너무 오래 걸려요. 다시 시도해 주세요.');
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }

  /** 다운로드 중단 (끝났으면 아무 일 없음). 프로세스가 완전히 종료될 때까지 기다림 */
  async cancel(): Promise<void> {
    if (this.status === 'downloading') {
      this.status = 'cancelled';
      killTree(this.child);
    }
    await this.exited;
  }
}

/**
 * yt-dlp 프로세스 1개로 메타데이터 출력 + 다운로드를 함께 처리.
 * 메타데이터가 나오면 resolve (다운로드는 계속 진행), 그 전에 실패하면 reject
 */
export function startDownload(url: string, filePath: string, label: string): Promise<{ info: TrackInfo; job: DownloadJob }> {
  const { child, stderr } = spawnYtdlp([
    ...commonArgs(),
    '--no-simulate',
    '--no-part', // 최종 파일에 바로 기록 → 받는 중에 뒤따라 읽기 가능
    '--no-mtime',
    '--no-progress',
    '--retries', '10',
    '-O', INFO_TEMPLATE,
    '-o', filePath,
    '--',
    url,
  ]);
  const job = new DownloadJob(child, filePath, label);

  return new Promise((resolve, reject) => {
    let gotInfo = false;
    const fail = (error: unknown) => {
      if (gotInfo) return;
      gotInfo = true;
      clearTimeout(timer);
      void job.cancel().then(() => reject(error));
    };

    const timer = setTimeout(() => fail(new YtdlpError('영상 정보를 불러오는 데 너무 오래 걸려요.')), INFO_TIMEOUT_MS);

    child.once('error', (error) => {
      console.error(`[ytdlp] 실행 실패 (${env.ytdlpPath})`, error);
      fail(new YtdlpError('yt-dlp를 실행할 수 없어요. (봇 설정 확인 필요)', error.message));
    });

    child.once('close', (code) => {
      job.settle(code, stderr());
      if (!gotInfo) {
        gotInfo = true;
        clearTimeout(timer);
        reject(job.error ?? classifyError(stderr()));
      }
    });

    if (!child.stdout) return;
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      if (gotInfo) return;
      let info: TrackInfo;
      try {
        info = parseInfoLine(line, url);
      } catch (error) {
        fail(error);
        return;
      }
      gotInfo = true;
      clearTimeout(timer);
      // 썸네일 확인(최대 3초)은 다운로드와 동시에 진행됨
      void withThumbnail(info).then((resolved) => resolve({ info: resolved, job }));
    });
  });
}

// ---------- 검색 · 재생목록 (--flat-playlist: 영상별 상세 조회 없이 목록만 빠르게) ----------

const FLAT_TEMPLATE = '%(.{id,title,duration,channel,uploader})j';
const UNAVAILABLE_TITLES = new Set(['[Private video]', '[Deleted video]']);

/** --flat-playlist 결과 한 줄 → TrackInfo (비공개·삭제 영상은 null) */
function parseFlatEntry(line: string): TrackInfo | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  if (!isVideoId(id) || !title || UNAVAILABLE_TITLES.has(title)) return null;
  const duration = typeof raw.duration === 'number' ? raw.duration : null;
  if (duration !== null && duration > MAX_DURATION_SEC) return null;
  const channel = typeof raw.channel === 'string' ? raw.channel : typeof raw.uploader === 'string' ? raw.uploader : null;
  return { id, title, duration, thumbnail: null, url: videoUrl(id), uploader: channel };
}

/** yt-dlp를 실행해 stdout 줄 목록을 받음 (실패 시 YtdlpError) */
function runLines(args: string[], timeoutMs: number): Promise<string[]> {
  const { child, stderr } = spawnYtdlp(args);
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(() => reject(new YtdlpError('유튜브 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.')));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (out += chunk));
    child.once('error', (error) => {
      done(() => reject(new YtdlpError('yt-dlp를 실행할 수 없어요. (봇 설정 확인 필요)', error.message)));
    });
    child.once('close', (code) => {
      done(() => {
        const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (code !== 0 && lines.length === 0) {
          const error = classifyError(stderr());
          console.error(`[ytdlp] 목록 조회 실패 (code ${code})\n${error.message}`);
          reject(error);
          return;
        }
        resolve(lines);
      });
    });
  });
}

function flatArgs(): string[] {
  return [...cookieArgs(), '--flat-playlist', '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '20'];
}

/** 유튜브 검색 상위 N개 (재생할 수 없는 항목 제외) */
export async function searchVideos(query: string, limit: number): Promise<TrackInfo[]> {
  const safe = query.replace(/[\r\n]/g, ' ').slice(0, 100);
  const lines = await runLines([...flatArgs(), '-O', FLAT_TEMPLATE, '--', `ytsearch${limit}:${safe}`], INFO_TIMEOUT_MS);
  return lines.map(parseFlatEntry).filter((info): info is TrackInfo => info !== null);
}

/** 재생목록 앞에서부터 최대 limit곡 + 재생목록 제목 */
export async function fetchPlaylist(url: string, limit: number): Promise<{ title: string | null; entries: TrackInfo[] }> {
  const lines = await runLines(
    [...flatArgs(), '--playlist-end', String(limit), '-O', 'playlist:%(title)j', '-O', FLAT_TEMPLATE, '--', url],
    60_000,
  );
  let title: string | null = null;
  const entries: TrackInfo[] = [];
  for (const line of lines) {
    if (line.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'string' && parsed !== 'NA') title = parsed;
      } catch {
        // 무시
      }
      continue;
    }
    const entry = parseFlatEntry(line);
    if (entry) entries.push(entry);
  }
  return { title, entries };
}

/**
 * yt-dlp 자체 업데이트 (yt-dlp -U). 공식 exe로 설치한 경우만 동작.
 * 실패해도 봇은 계속 동작 (로그만)
 */
export function updateYtdlp(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(env.ytdlpPath, ['-U'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (out += chunk));
    child.stderr?.on('data', (chunk: string) => (out += chunk));
    const timer = setTimeout(() => {
      killTree(child);
      console.warn('[ytdlp] 업데이트 2분 초과 → 중단');
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      console.warn(`[ytdlp] 업데이트 실행 실패: ${error.message}`);
      resolve();
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const summary =
        lines.find((l) => /updated yt-dlp to|is up to date/i.test(l)) ?? lines[lines.length - 1] ?? '(출력 없음)';
      if (code === 0) console.log(`[ytdlp] 업데이트 확인: ${summary}`);
      else console.warn(`[ytdlp] 업데이트 실패 (code ${code}): ${summary}`);
      resolve();
    });
  });
}

/** 시작 시 yt-dlp 동작 확인용 (실패해도 봇은 계속) */
export function logYtdlpVersion(): void {
  const child = spawn(env.ytdlpPath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (out += chunk));
  child.once('error', (error) => console.error(`[ytdlp] 실행 불가 (${env.ytdlpPath}): ${error.message}`));
  child.once('close', (code) => {
    if (code === 0) console.log(`[ytdlp] 버전 ${out.trim()}`);
  });
}
