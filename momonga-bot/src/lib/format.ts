import { escapeMarkdown } from 'discord.js';

/** 초 → 1:02:03 / 4:05 형식 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '알 수 없음';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 임베드 링크 안에 넣어도 깨지지 않게: 마크다운·대괄호 처리 + 길이 제한 */
export function safeTitle(title: string, max = 60): string {
  const cut = title.length > max ? `${title.slice(0, max - 1)}…` : title;
  return escapeMarkdown(cut.replace(/\[/g, '(').replace(/\]/g, ')'));
}

/** ▬▬▬🔘▬▬▬ 형태 진행 막대 */
export function progressBar(elapsedSec: number, totalSec: number | null, width = 14): string {
  if (!totalSec || totalSec <= 0) return '';
  const ratio = Math.min(1, Math.max(0, elapsedSec / totalSec));
  const pos = Math.min(width - 1, Math.floor(ratio * width));
  return `${'▬'.repeat(pos)}🔘${'▬'.repeat(width - 1 - pos)}`;
}
