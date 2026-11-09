import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/command';

export const ping: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setNameLocalizations({ ko: '핑' })
    .setDescription('Check bot latency and memory')
    .setDescriptionLocalizations({ ko: '봇 응답 속도와 메모리 사용량을 확인해요' })
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    const { rss, heapUsed } = process.memoryUsage();
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
    await interaction.reply({
      content: `🐿️ 퐁! \`${interaction.client.ws.ping}ms\` · 메모리 \`${mb(rss)}MB\` (힙 ${mb(heapUsed)}MB)`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
