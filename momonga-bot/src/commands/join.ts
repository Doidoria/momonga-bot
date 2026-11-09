import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';
import { checkJoinable, joinChannel } from '../services/voiceConnection';

export const join: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setNameLocalizations({ ko: '입장' })
    .setDescription('Join your voice channel')
    .setDescriptionLocalizations({ ko: '내가 있는 음성 채널에 들어와요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: '서버에서만 쓸 수 있어요.', flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.reply({
        content: '먼저 음성 채널에 들어가 주세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const problem = checkJoinable(channel);
    if (problem) {
      await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });
      return;
    }

    // 연결에 최대 20초 걸릴 수 있으므로 defer (본인에게만 보이게)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await joinChannel(channel);

    if (!result.ok) {
      await interaction.editReply(`⚠️ ${result.reason}`);
      return;
    }
    // 성공 시 안내 메시지 없이 응답 삭제
    await interaction.deleteReply();
  },
};
