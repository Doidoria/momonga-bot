import path from 'node:path';
import dotenv from 'dotenv';

const isProd = process.argv.includes('--env=prod');
const envFile = isProd ? '.env.prod' : '.env';

dotenv.config({ path: path.resolve(process.cwd(), envFile), quiet: true });

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`[env] ${envFile}에 ${key} 값이 없습니다.`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value ? value : fallback;
}

export interface Env {
  isProd: boolean;
  envFile: string;
  discordToken: string;
  discordClientId: string;
  deployGuildIds: string[];
  /** yt-dlp 실행 파일 경로 (PATH에 있으면 yt-dlp) */
  ytdlpPath: string;
  /** 임시 오디오 파일 폴더 (절대 경로) */
  tempDir: string;
  /** 유튜브 쿠키 파일 (봇 확인 에러가 계속될 때만, 절대 경로) */
  ytdlpCookies: string | null;
  /** yt-dlp 자동 업데이트 (기본 켜짐) */
  ytdlpAutoUpdate: boolean;
}

export const env: Env = {
  isProd,
  envFile,
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  deployGuildIds: (process.env.DEPLOY_GUILD_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  ytdlpPath: optional('YTDLP_PATH', 'yt-dlp'),
  tempDir: path.resolve(process.cwd(), optional('TEMP_DIR', 'tmp')),
  ytdlpCookies: process.env.YTDLP_COOKIES?.trim() ? path.resolve(process.cwd(), process.env.YTDLP_COOKIES.trim()) : null,
  ytdlpAutoUpdate: optional('YTDLP_AUTO_UPDATE', 'true').toLowerCase() !== 'false',
};
