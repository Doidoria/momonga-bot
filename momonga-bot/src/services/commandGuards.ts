import { MessageFlags, type GuildMember, type RepliableInteraction } from 'discord.js';
import { getConnectedChannelId } from './voiceConnection';

/** 재생 제어: 봇과 같은 음성 채널에 있는 사람만. 문제가 있으면 안내 문구 */
export function checkSameVoiceChannel(ctx: { guildId: string; member: GuildMember }): string | null {
  const botChannelId = getConnectedChannelId(ctx.guildId);
  if (!botChannelId) return '봇이 음성 채널에 없어요.';
  if (ctx.member.voice.channelId !== botChannelId) {
    return `봇이 있는 <#${botChannelId}> 채널에 들어가서 사용해 주세요.`;
  }
  return null;
}

/** 서버 밖에서 실행됐으면 안내하고 false */
export async function ensureGuild(interaction: RepliableInteraction): Promise<boolean> {
  if (interaction.inCachedGuild()) return true;
  await interaction.reply({ content: '서버에서만 쓸 수 있어요.', flags: MessageFlags.Ephemeral });
  return false;
}

export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}
