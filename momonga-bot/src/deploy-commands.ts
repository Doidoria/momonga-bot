import { REST, Routes } from 'discord.js';
import { env } from './lib/env';
import { commandList } from './commands';

async function main(): Promise<void> {
  if (env.deployGuildIds.length === 0) {
    throw new Error(`${env.envFile}에 DEPLOY_GUILD_IDS가 없습니다.`);
  }

  const rest = new REST().setToken(env.discordToken);
  const body = commandList.map((command) => command.data.toJSON());

  for (const guildId of env.deployGuildIds) {
    await rest.put(Routes.applicationGuildCommands(env.discordClientId, guildId), { body });
    console.log(`[deploy] ${guildId}: 커맨드 ${body.length}개 등록`);
  }
}

main().catch((err: unknown) => {
  console.error('[deploy] 실패', err);
  process.exit(1);
});
