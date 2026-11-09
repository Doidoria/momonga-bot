import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { EMBED_COLOR, LOOP_LABEL } from '../lib/embeds';
import { formatDuration, safeTitle } from '../lib/format';
import { PANEL_ID } from '../lib/panel';
import type { GuildPlayer, QueueItem } from './player';

const PAGE_SIZE = 10;

function itemLine(item: QueueItem): string {
  if (!item.info) return `${item.url} · <@${item.requestedBy}>`;
  return `[${safeTitle(item.info.title)}](${item.info.url}) \`${formatDuration(item.info.duration)}\` · <@${item.requestedBy}>`;
}

export interface QueueView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** 대기열 화면 (본인에게만 보이는 메시지). 2페이지 이상이면 이전/다음 버튼 */
export function buildQueueView(player: GuildPlayer | undefined, requestedPage: number): QueueView | null {
  const now = player?.getNowPlaying() ?? null;
  const items = player?.upcoming ?? [];
  if (!player || (!now && items.length === 0)) return null;

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * PAGE_SIZE;

  const lines: string[] = [];
  if (now) {
    const title = now.info ? `[${safeTitle(now.info.title)}](${now.info.url})` : '준비 중…';
    const time = now.info ? ` \`${formatDuration(now.elapsedMs / 1000)} / ${formatDuration(now.info.duration)}\`` : '';
    lines.push(`**${now.paused ? '⏸️' : '🎵'} 지금 재생 중**`, `${title}${time} · <@${now.requestedBy}>`, '');
  }
  if (items.length === 0) {
    lines.push('대기 중인 곡이 없어요.');
  } else {
    const totalSec = items.reduce((sum, item) => sum + (item.info?.duration ?? 0), 0);
    lines.push(`**대기열 ${items.length}곡 · 총 ${formatDuration(totalSec)}**`);
    items.slice(start, start + PAGE_SIZE).forEach((item, index) => {
      lines.push(`\`${start + index + 1}.\` ${itemLine(item)}`);
    });
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: `페이지 ${page}/${totalPages} · 반복: ${LOOP_LABEL[player.loopMode]} · 삭제는 /삭제 번호` });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PANEL_ID.queuePagePrefix}${page - 1}`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`${PANEL_ID.queuePagePrefix}${page + 1}`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages),
      ),
    );
  }
  return { embeds: [embed], components };
}
