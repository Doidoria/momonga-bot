import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { leaveChannel } from '../services/voiceConnection';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setNameLocalizations({ ko: '정지' })
    .setDescription('Clear the queue and leave')
    .setDescriptionLocalizations({ ko: '대기열을 비우고 음성 채널에서 나가요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    // 퇴장과 같음: 연결 종료 → 플레이어가 대기열·다운로드·임시 파일 모두 정리 (안내 메시지 없음)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    leaveChannel(interaction.guildId);
    await interaction.deleteReply();
  },
};
