import { Events } from 'discord.js';
import { defineEvent } from '../types/event';

export const error = defineEvent({
  name: Events.Error,
  execute(err) {
    console.error('[client] 오류', err);
  },
});
