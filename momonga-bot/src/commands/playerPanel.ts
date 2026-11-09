import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { buildIdlePanel, canAttachBanner } from '../lib/panel';
import { findPlayer } from '../services/player';
import { ensureGuild } from '../services/commandGuards';

export const playerPanel: Command = {
  data: new SlashCommandBuilder()
    .setName('player')
    .setNameLocalizations({ ko: '플레이어' })
    .setDescription('Show the music player panel here')
    .setDescriptionLocalizations({ ko: '버튼으로 조작하는 플레이어를 이 채널에 띄워요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const player = findPlayer(interaction.guildId);
    if (!player?.hasCurrent) {
      // 재생 중이 아니면 곡 추가 버튼만 있는 패널
      await interaction.reply({
        ...buildIdlePanel(undefined, canAttachBanner(interaction.channel)),
        allowedMentions: { parse: [] },
      });
      return;
    }

    // 채팅에 묻힌 패널을 아래로 다시 불러옴 (이전 패널은 삭제, 다음 곡 알림도 이 채널로)
    const response = await interaction.reply({ ...player.panelPayload(), allowedMentions: { parse: [] }, withResponse: true });
    const message = response.resource?.message;
    if (message) player.setNowPlayingMessage(message, interaction.channel);
  },
};
