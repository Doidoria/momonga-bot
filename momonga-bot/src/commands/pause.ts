import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { findPlayer } from '../services/player';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const pause: Command = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setNameLocalizations({ ko: '일시정지' })
    .setDescription('Pause playback')
    .setDescriptionLocalizations({ ko: '재생을 잠시 멈춰요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    const ok = findPlayer(interaction.guildId)?.pause() ?? false;
    await replyEphemeral(interaction, ok ? '⏸️ 일시정지했어요. `/재개`로 이어서 들을 수 있어요.' : '재생 중인 곡이 없어요.');
  },
};
