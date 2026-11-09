import { Collection } from 'discord.js';
import type { Command } from '../types/command';
import { ping } from './ping';
import { join } from './join';
import { leave } from './leave';
import { play } from './play';
import { playerPanel } from './playerPanel';
import { skip } from './skip';
import { stop } from './stop';
import { pause } from './pause';
import { resume } from './resume';
import { queue } from './queue';
import { nowplaying } from './nowplaying';
import { loop } from './loop';
import { remove } from './remove';

export const commandList: Command[] = [
  ping, join, leave, play, playerPanel, skip, stop, pause, resume, queue, nowplaying, loop, remove,
];

export const commands = new Collection<string, Command>(
  commandList.map((command) => [command.data.name, command]),
);
