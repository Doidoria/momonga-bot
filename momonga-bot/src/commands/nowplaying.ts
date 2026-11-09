import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { nowPlayingEmbed } from '../lib/embeds';
import { findPlayer } from '../services/player';
import { ensureGuild, replyEphemeral } from '../services/commandGuards';

export const nowplaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setNameLocalizations({ ko: '지금곡' })
    .setDescription('Show the current song')
    .setDescriptionLocalizations({ ko: '지금 재생 중인 곡을 보여줘요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const player = findPlayer(interaction.guildId);
    const now = player?.getNowPlaying() ?? null;
    if (!player || !now) {
      await replyEphemeral(interaction, '재생 중인 곡이 없어요.');
      return;
    }
    if (!now.info) {
      await replyEphemeral(interaction, '곡을 준비하고 있어요. 잠시 후 다시 확인해 주세요.');
      return;
    }

    await interaction.reply({
      embeds: [
        nowPlayingEmbed(now.info, now.requestedBy, {
          queueLength: player.upcoming.length,
          loop: player.loopMode,
          elapsedMs: now.elapsedMs,
          paused: now.paused,
        }),
      ],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
