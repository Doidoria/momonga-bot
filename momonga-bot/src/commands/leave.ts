import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { leaveChannel } from '../services/voiceConnection';
import { checkSameVoiceChannel, ensureGuild, replyEphemeral } from '../services/commandGuards';

export const leave: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setNameLocalizations({ ko: '퇴장' })
    .setDescription('Leave the voice channel')
    .setDescriptionLocalizations({ ko: '음성 채널에서 나가요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!(await ensureGuild(interaction)) || !interaction.inCachedGuild()) return;

    // 다른 채널에서 듣는 사람을 방해하지 않도록 같은 채널에 있는 사람만
    const problem = checkSameVoiceChannel(interaction);
    if (problem) {
      await replyEphemeral(interaction, problem);
      return;
    }

    // 응답은 필수라 본인에게만 보이게 defer 후 바로 삭제 (안내 메시지 없음)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    leaveChannel(interaction.guildId); // 대기열·다운로드·임시 파일은 연결 종료 시 자동 정리
    await interaction.deleteReply();
  },
};
