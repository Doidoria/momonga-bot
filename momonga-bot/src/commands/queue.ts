import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { findPlayer } from '../services/player';
import { buildQueueView } from '../services/queueView';
import { ensureGuild, replyEphemeral } from '../services/commandGuards';

export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setNameLocalizations({ ko: '대기열' })
    .setDescription('Show the queue')
    .setDescriptionLocalizations({ ko: '대기열을 보여줘요' })
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setNameLocalizations({ ko: '페이지' })
        .setDescription('Page number')
        .setDescriptionLocalizations({ ko: '페이지 번호' })
        .setMinValue(1),
    ),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const view = buildQueueView(findPlayer(interaction.guildId), interaction.options.getInteger('page') ?? 1);
    if (!view) {
      await replyEphemeral(interaction, '대기열이 비어 있어요.');
      return;
    }
    await interaction.reply({ ...view, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
