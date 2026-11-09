import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { findPlayer } from '../services/player';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const resume: Command = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setNameLocalizations({ ko: '재개' })
    .setDescription('Resume playback')
    .setDescriptionLocalizations({ ko: '멈춘 곡을 이어서 재생해요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    const ok = findPlayer(interaction.guildId)?.resume() ?? false;
    await replyEphemeral(interaction, ok ? '▶️ 다시 재생해요.' : '일시정지된 곡이 없어요.');
  },
};
