import {
  entersState,
  getVoiceConnection,
  getVoiceConnections,
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import { PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';

const READY_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;
const MAX_REJOIN_ATTEMPTS = 5;

export type JoinResult =
  | { ok: true; connection: VoiceConnection; moved: boolean; alreadyHere: boolean }
  | { ok: false; reason: string };

/** 같은 커넥션에 리스너를 중복으로 달지 않기 위한 표시 */
const managed = new WeakSet<VoiceConnection>();

/** 연결이 완전히 끝났을 때 실행할 정리 작업 (플레이어 등에서 등록) */
type DestroyedHandler = (guildId: string) => void;
const destroyedHandlers: DestroyedHandler[] = [];
export function onConnectionDestroyed(handler: DestroyedHandler): void {
  destroyedHandlers.push(handler);
}

function tag(guildId: string): string {
  return `[voice:${guildId}]`;
}

function isAlive(connection: VoiceConnection | undefined): connection is VoiceConnection {
  return connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed;
}

/** 봇이 채널에 들어갈 수 있는지 확인. 문제가 있으면 안내 문구를 반환 */
export function checkJoinable(channel: VoiceBasedChannel): string | null {
  const me = channel.guild.members.me;
  if (!me) return '봇 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';

  const perms = channel.permissionsFor(me);
  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('채널 보기');
  if (!perms.has(PermissionFlagsBits.Connect)) missing.push('연결');
  if (!perms.has(PermissionFlagsBits.Speak)) missing.push('말하기');
  if (missing.length > 0) {
    return `<#${channel.id}> 채널에서 봇 권한이 부족해요: ${missing.join(', ')}`;
  }
  // 이미 그 채널에 있으면 인원 제한과 무관
  if (getConnectedChannelId(channel.guild.id) === channel.id) return null;
  // 인원 제한이 꽉 찬 경우 (멤버 이동 권한이 있으면 들어갈 수 있음)
  if (!channel.joinable) {
    return `<#${channel.id}> 채널 인원이 가득 차서 들어갈 수 없어요.`;
  }
  return null;
}

function attachLifecycle(connection: VoiceConnection, guildId: string): void {
  if (managed.has(connection)) return;
  managed.add(connection);

  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status !== newState.status) {
      console.log(`${tag(guildId)} ${oldState.status} -> ${newState.status}`);
    }
  });

  // 연결 끊김 처리
  // 1) 5초 안에 스스로 다시 연결 단계로 들어가면 복구 중 (채널 이동·순간 끊김)
  // 2) 강제 퇴장(close code 4014)이면 정리
  // 3) 그 외(네트워크 문제 등)는 5초·10초·…간격으로 최대 5번 다시 입장 시도, 그래도 안 되면 정리
  connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
      ]);
      console.log(`${tag(guildId)} 재연결 중`);
      return;
    } catch {
      // 스스로 복구되지 않음
    }
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;

    const kicked =
      newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014;
    if (!kicked && connection.rejoinAttempts < MAX_REJOIN_ATTEMPTS) {
      const delay = (connection.rejoinAttempts + 1) * RECONNECT_TIMEOUT_MS;
      console.warn(`${tag(guildId)} 연결 끊김 → ${delay / 1000}초 뒤 다시 입장 (${connection.rejoinAttempts + 1}/${MAX_REJOIN_ATTEMPTS})`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
      return;
    }
    console.warn(`${tag(guildId)} ${kicked ? '강제 퇴장됨' : '재연결 실패'} → 연결 정리`);
    if (isAlive(connection)) connection.destroy();
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log(`${tag(guildId)} 연결 종료`);
    for (const handler of destroyedHandlers) {
      try {
        handler(guildId);
      } catch (error) {
        console.error(`${tag(guildId)} 종료 처리 오류`, error);
      }
    }
  });

  connection.on('error', (error) => {
    console.error(`${tag(guildId)} 연결 오류`, error);
  });
}

/** 채널에 입장 (이미 있으면 그대로, 같은 서버 다른 채널이면 이동) */
export async function joinChannel(channel: VoiceBasedChannel): Promise<JoinResult> {
  const guildId = channel.guild.id;
  const existing = getVoiceConnection(guildId);

  if (isAlive(existing) && existing.joinConfig.channelId === channel.id) {
    if (existing.state.status === VoiceConnectionStatus.Ready) {
      return { ok: true, connection: existing, moved: false, alreadyHere: true };
    }
    // 같은 채널로 연결 중이면 기다림
    try {
      await entersState(existing, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      return { ok: true, connection: existing, moved: false, alreadyHere: true };
    } catch {
      // 아래에서 다시 연결 시도
    }
  }

  const moved = isAlive(existing) && existing.joinConfig.channelId !== channel.id;

  // 같은 길드에 커넥션이 있으면 joinVoiceChannel이 기존 커넥션을 재사용해 채널만 옮김
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true, // 듣기 기능은 쓰지 않음
    selfMute: false,
  });
  attachLifecycle(connection, guildId);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    return { ok: true, connection, moved, alreadyHere: false };
  } catch (error) {
    console.error(`${tag(guildId)} ${READY_TIMEOUT_MS / 1000}초 안에 연결되지 않음`, error);
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    return { ok: false, reason: '음성 채널 연결에 실패했어요. 잠시 후 다시 시도해 주세요.' };
  }
}

/** 퇴장. 연결이 없었으면 false */
export function leaveChannel(guildId: string): boolean {
  const connection = getVoiceConnection(guildId);
  if (!isAlive(connection)) return false;
  connection.destroy();
  return true;
}

export function getConnectedChannelId(guildId: string): string | null {
  const connection = getVoiceConnection(guildId);
  return isAlive(connection) ? connection.joinConfig.channelId : null;
}

/** 종료 시 모든 음성 연결 정리 */
export function destroyAllConnections(): void {
  for (const connection of getVoiceConnections().values()) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  }
}
