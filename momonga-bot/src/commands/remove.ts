import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { safeTitle } from '../lib/format';
import { findPlayer, MAX_QUEUE } from '../services/player';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setNameLocalizations({ ko: '삭제' })
    .setDescription('Remove a song from the queue')
    .setDescriptionLocalizations({ ko: '대기열에서 곡을 빼요' })
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('number')
        .setNameLocalizations({ ko: '번호' })
        .setDescription('Queue number (see /queue)')
        .setDescriptionLocalizations({ ko: '대기열 번호 (/대기열 에서 확인)' })
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_QUEUE),
    ),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    const position = interaction.options.getInteger('number', true);
    const player = findPlayer(interaction.guildId);
    const total = player?.upcoming.length ?? 0;
    const removed = player?.remove(position) ?? null;
    if (!removed) {
      await replyEphemeral(
        interaction,
        total === 0 ? '대기열이 비어 있어요.' : `1~${total} 사이 번호를 입력해 주세요.`,
      );
      return;
    }
    const title = removed.info ? safeTitle(removed.info.title) : removed.url;
    await replyEphemeral(interaction, `🗑️ ${position}번 **${title}** 을(를) 대기열에서 뺐어요.`);
  },
};
