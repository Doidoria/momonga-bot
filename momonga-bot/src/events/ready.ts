import { Events } from 'discord.js';
import { defineEvent } from '../types/event';
import { startAutoLeave } from '../services/autoLeave';

export const ready = defineEvent({
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`[ready] ${client.user.tag} 로그인 (서버 ${client.guilds.cache.size}개)`);
    startAutoLeave(client);
  },
});
