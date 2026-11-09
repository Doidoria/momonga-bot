import type { Client, ClientEvents } from 'discord.js';
import type { BotEvent } from '../types/event';
import { ready } from './ready';
import { interactionCreate } from './interactionCreate';
import { error } from './error';

const events: BotEvent<keyof ClientEvents>[] = [
  ready as BotEvent<keyof ClientEvents>,
  interactionCreate as BotEvent<keyof ClientEvents>,
  error as BotEvent<keyof ClientEvents>,
];

export function registerEvents(client: Client): void {
  for (const event of events) {
    const handler = (...args: ClientEvents[keyof ClientEvents]) => {
      Promise.resolve(event.execute(...args)).catch((err: unknown) => {
        console.error(`[event:${event.name}] 처리 오류`, err);
      });
    };
    if (event.once) client.once(event.name, handler);
    else client.on(event.name, handler);
  }
}
