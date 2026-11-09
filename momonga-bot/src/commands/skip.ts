import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { safeTitle } from '../lib/format';
import { findPlayer } from '../services/player';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setNameLocalizations({ ko: '스킵' })
    .setDescription('Skip the current song')
    .setDescriptionLocalizations({ ko: '지금 곡을 건너뛰어요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    const player = findPlayer(interaction.guildId);
    const skipped = player?.skip() ?? null;
    if (!skipped) {
      await replyEphemeral(interaction, '재생 중인 곡이 없어요.');
      return;
    }
    const title = skipped.info ? safeTitle(skipped.info.title) : '준비 중이던 곡';
    const next = player?.upcoming.length === 0 && player.loopMode === 'off' ? ' (대기열 끝)' : '';
    await replyEphemeral(interaction, `⏭️ **${title}** 건너뜀${next}`);
  },
};
