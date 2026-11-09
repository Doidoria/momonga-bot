import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { ensureGuild } from '../services/commandGuards';
import { handlePlayRequest } from '../services/playRequest';

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setNameLocalizations({ ko: '재생' })
    .setDescription('Play a YouTube link, playlist, or search term (adds to queue if playing)')
    .setDescriptionLocalizations({ ko: '유튜브 링크·재생목록·검색어로 재생해요 (재생 중이면 대기열에 추가)' })
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('query')
        .setNameLocalizations({ ko: '노래' })
        .setDescription('YouTube link, playlist link, or search term')
        .setDescriptionLocalizations({ ko: '유튜브 영상·재생목록 링크 또는 검색어 (첫 번째 결과 재생)' })
        .setRequired(true)
        .setMaxLength(200),
    ),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;
    await handlePlayRequest(interaction, interaction.options.getString('query', true));
  },
};
