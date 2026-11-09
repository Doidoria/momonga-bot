import type { ClientEvents } from 'discord.js';

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute: (...args: ClientEvents[K]) => Promise<void> | void;
}

export function defineEvent<K extends keyof ClientEvents>(event: BotEvent<K>): BotEvent<K> {
  return event;
}
