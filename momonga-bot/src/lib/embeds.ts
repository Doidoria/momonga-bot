import { EmbedBuilder } from 'discord.js';
import { formatDuration, progressBar, safeTitle } from './format';
import type { TrackInfo } from '../services/ytdlp';

export const EMBED_COLOR = 0xf2c4ce;

export type LoopMode = 'off' | 'one' | 'all';

export const LOOP_LABEL: Record<LoopMode, string> = {
  off: '끔',
  one: '한 곡',
  all: '전체',
};

export function nowPlayingEmbed(
  info: TrackInfo,
  requestedBy: string,
  opts: { queueLength: number; loop: LoopMode; elapsedMs?: number; paused?: boolean },
): EmbedBuilder {
  const lines = [`길이 \`${formatDuration(info.duration)}\` · 요청 <@${requestedBy}>`];
  if (opts.elapsedMs !== undefined) {
    const elapsed = opts.elapsedMs / 1000;
    const bar = progressBar(elapsed, info.duration);
    lines.unshift(`${opts.paused ? '⏸️' : '▶️'} ${bar} \`${formatDuration(elapsed)} / ${formatDuration(info.duration)}\``);
  }
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: '🎵 지금 재생 중' })
    .setTitle(info.title.slice(0, 256))
    .setURL(info.url)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `대기열 ${opts.queueLength}곡 · 반복: ${LOOP_LABEL[opts.loop]}` });
  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed;
}

export function queuedEmbed(info: TrackInfo, requestedBy: string, position: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: `📥 대기열 ${position}번에 추가` })
    .setDescription(`[${safeTitle(info.title, 80)}](${info.url}) \`${formatDuration(info.duration)}\` · 요청 <@${requestedBy}>`);
}
