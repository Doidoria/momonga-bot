import { Client, GatewayIntentBits } from 'discord.js';

// Guilds: 슬래시 커맨드·길드/채널 캐시
// GuildVoiceStates: 음성 연결(voiceAdapterCreator)과 유저가 있는 음성 채널 확인에 필수
export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
