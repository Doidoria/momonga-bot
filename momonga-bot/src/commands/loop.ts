import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { LOOP_LABEL, type LoopMode } from '../lib/embeds';
import { getConnectedChannelId } from '../services/voiceConnection';
import { getPlayer } from '../services/player';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

const MODES: readonly LoopMode[] = ['off', 'one', 'all'];

function isLoopMode(value: string): value is LoopMode {
  return (MODES as readonly string[]).includes(value);
}

export const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setNameLocalizations({ ko: '반복' })
    .setDescription('Set repeat mode')
    .setDescriptionLocalizations({ ko: '반복 모드를 정해요' })
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('mode')
        .setNameLocalizations({ ko: '모드' })
        .setDescription('Repeat mode')
        .setDescriptionLocalizations({ ko: '반복 모드' })
        .setRequired(true)
        .addChoices(
          { name: 'Off', name_localizations: { ko: '끄기' }, value: 'off' },
          { name: 'One song', name_localizations: { ko: '한 곡' }, value: 'one' },
          { name: 'Whole queue', name_localizations: { ko: '전체' }, value: 'all' },
        ),
    ),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    const value = interaction.options.getString('mode', true);
    if (!isLoopMode(value) || !getConnectedChannelId(interaction.guildId)) {
      await replyEphemeral(interaction, '반복 모드를 바꿀 수 없어요.');
      return;
    }
    getPlayer(interaction.guildId).setLoop(value);
    await replyEphemeral(interaction, `🔁 반복: **${LOOP_LABEL[value]}**`);
  },
};
