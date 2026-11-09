import { getVoiceConnections } from '@discordjs/voice';
import type { Client } from 'discord.js';
import { destroyPlayer, isPlayerActive } from './player';
import { leaveChannel } from './voiceConnection';

/** 음성 채널에 사람이 없으면 2분 뒤, 재생할 곡이 없으면 5분 뒤 자동 퇴장 */
const CHECK_INTERVAL_MS = 15_000;
const ALONE_LEAVE_MS = 2 * 60_000;
const IDLE_LEAVE_MS = 5 * 60_000;

const aloneSince = new Map<string, number>();
const idleSince = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

/** condition이 계속 참인 시간(ms). 거짓이 되면 기록 초기화 */
function trackDuration(map: Map<string, number>, guildId: string, condition: boolean, now: number): number {
  if (!condition) {
    map.delete(guildId);
    return 0;
  }
  const since = map.get(guildId) ?? now;
  map.set(guildId, since);
  return now - since;
}

async function leave(guildId: string, message: string, reason: string): Promise<void> {
  aloneSince.delete(guildId);
  idleSince.delete(guildId);
  console.log(`[autoLeave:${guildId}] ${reason} → 자동 퇴장`);
  await destroyPlayer(guildId, message); // 패널에 퇴장 이유 표시
  leaveChannel(guildId);
}

function check(client: Client): void {
  const now = Date.now();
  const connected = new Set<string>();

  for (const [guildId, connection] of getVoiceConnections()) {
    const channelId = connection.joinConfig.channelId;
    if (!channelId) continue;
    connected.add(guildId);

    // 음성 상태 캐시(GuildVoiceStates)로 채널의 사람 수 확인 — API 호출 없음
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    const listeners = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;

    const alone = trackDuration(aloneSince, guildId, listeners === 0, now);
    const idle = trackDuration(idleSince, guildId, !isPlayerActive(guildId), now);

    if (alone >= ALONE_LEAVE_MS) {
      void leave(guildId, '👋 음성 채널에 아무도 없어서 나왔어요.', '혼자 남음');
    } else if (idle >= IDLE_LEAVE_MS) {
      void leave(guildId, '💤 한동안 재생할 곡이 없어서 나왔어요.', '대기열 빔');
    }
  }

  // 이미 나간 서버 기록 정리
  for (const map of [aloneSince, idleSince]) {
    for (const guildId of map.keys()) if (!connected.has(guildId)) map.delete(guildId);
  }
}

export function startAutoLeave(client: Client): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      check(client);
    } catch (error) {
      console.error('[autoLeave] 확인 중 오류', error);
    }
  }, CHECK_INTERVAL_MS);
}

export function stopAutoLeave(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
