import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  type AudioPlayer,
  type AudioResource,
  type PlayerSubscription,
  type VoiceConnection,
} from '@discordjs/voice';
import { PermissionFlagsBits, type GuildTextBasedChannel, type Message } from 'discord.js';
import { UserFacingError } from '../lib/errors';
import type { LoopMode } from '../lib/embeds';
import { buildIdlePanel, buildPlayerPanel, canAttachBanner, type PanelPayload } from '../lib/panel';
import { safeTitle } from '../lib/format';
import { TailReadStream } from './tailReadStream';
import { ensureDiskSpace, newTempFilePath, removeFile } from './tempFiles';
import { fetchInfo, startDownload, YtdlpError, type DownloadJob, type TrackInfo } from './ytdlp';
import { onConnectionDestroyed } from './voiceConnection';

/** 재생 시작 전에 쌓아둘 양 (webm/opus 약 130kbps 기준 5초 남짓) */
const START_BUFFER_BYTES = 96 * 1024;
const START_BUFFER_TIMEOUT_MS = 30_000;
/**
 * @discordjs/voice는 기본적으로 프레임이 5개(100ms)만 비어도 곡을 종료함.
 * 재생이 다운로드를 따라잡았을 때 끊기지 않도록, 최대 60초까지는 무음을 보내며 기다림
 */
const MAX_BUFFERING_FRAMES = (60 * 1000) / 20;
export const MAX_QUEUE = 100;
/** 연속으로 이만큼 실패하면 재생을 멈춤 (전체 반복 + 전부 실패 같은 무한 루프 방지) */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 새 요청·스킵·퇴장으로 준비 중이던 재생이 취소됨 */
export class PlaybackCancelledError extends UserFacingError {
  constructor() {
    super('다른 요청으로 재생이 취소됐어요.');
    this.name = 'PlaybackCancelledError';
  }
}

interface Prepared {
  job: DownloadJob;
  filePath: string;
}

export interface QueueItem {
  readonly id: number;
  readonly url: string;
  readonly requestedBy: string;
  info: TrackInfo | null;
  prepared: Prepared | null;
  preparing: Promise<void> | null;
  /** 대기열에서 빠짐 → 준비 중이던 다운로드도 버림 */
  discarded: boolean;
}

interface Playback {
  item: QueueItem;
  reader: TailReadStream | null;
  resource: AudioResource | null;
  finished: boolean;
  errored: boolean;
}

/** 곡이 끝난 이유 → 다음 곡 결정에 사용 */
type AdvanceCause = 'ended' | 'replay' | 'skipped' | 'failed';
/** reply: /재생 응답이 곧 "지금 재생 중" 메시지 / channel: 채널에 새로 알림 / replay: 반복 재생(알림 없음) */
type StartMode = 'reply' | 'channel' | 'replay';

export type EnqueueResult =
  | { kind: 'started'; info: TrackInfo }
  | { kind: 'queued'; info: TrackInfo; position: number };

export interface NowPlaying {
  info: TrackInfo | null;
  url: string;
  requestedBy: string;
  elapsedMs: number;
  paused: boolean;
}

let itemSeq = 0;

function newItem(url: string, requestedBy: string, info: TrackInfo | null): QueueItem {
  return { id: ++itemSeq, url, requestedBy, info, prepared: null, preparing: null, discarded: false };
}

function itemTitle(item: QueueItem): string {
  return item.info ? item.info.title : item.url;
}

class GuildPlayer {
  private readonly audioPlayer: AudioPlayer;
  private subscription: PlayerSubscription | null = null;
  private current: Playback | null = null;
  private readonly queue: QueueItem[] = [];
  private loop: LoopMode = 'off';
  private textChannel: GuildTextBasedChannel | null = null;
  private nowPlayingMessage: Message | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;
  /** 패널 갱신 묶어 보내기 (대기열 추가 연타 시 수정 API 호출 줄이기) */
  private panelRefreshTimer: NodeJS.Timeout | null = null;
  /** 마지막으로 보낸 패널 상태 — 같으면 다시 수정하지 않음 */
  private lastPanelKey = '';

  constructor(private readonly guildId: string) {
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
        maxMissedFrames: MAX_BUFFERING_FRAMES,
      },
    });

    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (oldState.status === newState.status) return;
      // 재생 중이던 곡이 스스로 끝남 (끝까지 재생 또는 에러). 스킵·정지는 finish()에서 직접 처리
      if (newState.status === AudioPlayerStatus.Idle && 'resource' in oldState) {
        const pb = this.current;
        if (pb && pb.resource === oldState.resource) this.onTrackEnd(pb);
      }
    });

    this.audioPlayer.on('error', (error) => {
      const pb = this.current;
      if (pb && error.resource === pb.resource) pb.errored = true;
      console.error(`${this.tag()} 재생 오류`, error.message);
    });
  }

  private tag(): string {
    return `[player:${this.guildId}]`;
  }

  // ---------- 조회 ----------

  get isActive(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  get loopMode(): LoopMode {
    return this.loop;
  }

  get upcoming(): readonly QueueItem[] {
    return this.queue;
  }

  get hasCurrent(): boolean {
    return this.current !== null;
  }

  get isPaused(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  isNowPlayingMessage(messageId: string): boolean {
    return this.nowPlayingMessage?.id === messageId;
  }

  /** 현재 상태의 플레이어 패널 (재생 중이 아니면 곡 추가 버튼만) */
  panelPayload(): PanelPayload {
    const pb = this.current;
    if (!pb || !pb.item.info) {
      this.lastPanelKey = 'idle';
      return buildIdlePanel(undefined, canAttachBanner(this.textChannel));
    }
    const replays = this.loop === 'one' || (this.loop === 'all' && this.queue.length === 0);
    const next = replays ? pb.item : this.queue[0];
    const state = {
      info: pb.item.info,
      requestedBy: pb.item.requestedBy,
      queueLength: this.queue.length,
      nextTitle: next ? itemTitle(next) : null,
      loop: this.loop,
      paused: this.isPaused,
    };
    this.lastPanelKey = `${pb.item.id}|${state.queueLength}|${state.nextTitle}|${state.loop}|${state.paused}`;
    return buildPlayerPanel(state);
  }

  getNowPlaying(): NowPlaying | null {
    const pb = this.current;
    if (!pb) return null;
    return {
      info: pb.item.info,
      url: pb.item.url,
      requestedBy: pb.item.requestedBy,
      elapsedMs: pb.resource?.playbackDuration ?? 0,
      paused: this.audioPlayer.state.status === AudioPlayerStatus.Paused,
    };
  }

  // ---------- 명령 ----------

  /** /재생: 비어 있으면 바로 재생, 재생 중이면 대기열 끝에 추가 */
  async enqueue(
    connection: VoiceConnection,
    url: string,
    requestedBy: string,
    channel: GuildTextBasedChannel | null,
  ): Promise<EnqueueResult> {
    this.subscribe(connection);
    if (channel) this.textChannel = channel;

    if (!this.isActive) {
      const info = await this.startItem(newItem(url, requestedBy, null), 'reply');
      return { kind: 'started', info };
    }

    if (this.queue.length >= MAX_QUEUE) throw new UserFacingError(`대기열이 가득 찼어요. (최대 ${MAX_QUEUE}곡)`);
    const info = await fetchInfo(url);
    if (this.destroyed) throw new PlaybackCancelledError();

    // 정보를 받는 사이 재생이 끝났으면 바로 재생
    if (!this.isActive) {
      const started = await this.startItem(newItem(url, requestedBy, info), 'reply');
      return { kind: 'started', info: started };
    }
    if (this.queue.length >= MAX_QUEUE) throw new UserFacingError(`대기열이 가득 찼어요. (최대 ${MAX_QUEUE}곡)`);

    this.queue.push(newItem(url, requestedBy, info));
    this.schedulePrefetch();
    this.schedulePanelRefresh();
    return { kind: 'queued', info, position: this.queue.length };
  }

  /**
   * 재생목록: 여러 곡을 한 번에 대기열에. 비어 있었으면 첫 곡을 바로 재생.
   * 곡별 상세 조회는 하지 않음 (재생할 수 없는 곡은 차례가 오면 건너뜀)
   */
  async enqueueMany(
    connection: VoiceConnection,
    entries: TrackInfo[],
    requestedBy: string,
    channel: GuildTextBasedChannel | null,
  ): Promise<{ started: TrackInfo | null; added: number; skippedForLimit: number }> {
    this.subscribe(connection);
    if (channel) this.textChannel = channel;

    const startNow = !this.isActive;
    const room = MAX_QUEUE - this.queue.length + (startNow ? 1 : 0);
    if (room <= 0) throw new UserFacingError(`대기열이 가득 찼어요. (최대 ${MAX_QUEUE}곡)`);
    const accepted = entries.slice(0, room);
    const items = accepted.map((info) => newItem(info.url, requestedBy, info));
    const skippedForLimit = entries.length - accepted.length;

    if (!startNow) {
      this.queue.push(...items);
      this.schedulePrefetch();
      this.schedulePanelRefresh();
      return { started: null, added: items.length, skippedForLimit };
    }

    const [first, ...rest] = items;
    if (!first) throw new UserFacingError('재생할 수 있는 곡이 없어요.');
    // 나머지를 먼저 넣어둬야 첫 곡이 실패해도 다음 곡으로 이어짐
    this.queue.push(...rest);
    try {
      const started = await this.startItem(first, 'reply');
      return { started, added: items.length, skippedForLimit };
    } catch (error) {
      if (error instanceof PlaybackCancelledError || !this.hasCurrent) throw error;
      // 첫 곡만 실패 → 이미 다음 곡이 시작됨 (채널에 패널이 올라감)
      return { started: null, added: rest.length, skippedForLimit };
    }
  }

  /** 스킵한 곡을 반환 (재생 중인 곡이 없으면 null) */
  skip(): QueueItem | null {
    const pb = this.current;
    if (!pb) return null;
    this.consecutiveFailures = 0;
    const cleanup = this.finish(pb, false, '스킵');
    this.advance(pb.item, 'skipped');
    void cleanup;
    return pb.item;
  }

  pause(): boolean {
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Playing) return false;
    const ok = this.audioPlayer.pause();
    this.schedulePanelRefresh();
    return ok;
  }

  resume(): boolean {
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Paused) return false;
    const ok = this.audioPlayer.unpause();
    this.schedulePanelRefresh();
    return ok;
  }

  setLoop(mode: LoopMode): void {
    this.loop = mode;
    this.schedulePrefetch();
    this.schedulePanelRefresh();
  }

  /** 대기열 번호(1부터)로 삭제 */
  remove(position: number): QueueItem | null {
    if (position < 1 || position > this.queue.length) return null;
    const [item] = this.queue.splice(position - 1, 1);
    if (!item) return null;
    void this.discard(item);
    this.schedulePrefetch();
    this.schedulePanelRefresh();
    return item;
  }

  /** 플레이어 패널로 쓸 메시지 등록 (/재생 응답, /플레이어). channel을 주면 다음 곡 알림도 그 채널로 */
  setNowPlayingMessage(message: Message, channel?: GuildTextBasedChannel | null): void {
    if (channel) this.textChannel = channel;
    this.replaceNowPlayingMessage(message);
  }

  /** 지금 쓰고 있는 임시 파일 (남은 파일 정리에서 제외) */
  usedFiles(): string[] {
    const items = this.current ? [this.current.item, ...this.queue] : [...this.queue];
    return items.flatMap((item) => (item.prepared ? [item.prepared.filePath] : []));
  }

  /** 정지·퇴장: 대기열 비우고 모든 다운로드·임시 파일 정리 */
  async destroy(endMessage = '⏹️ 재생을 마쳤어요.'): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.panelRefreshTimer) clearTimeout(this.panelRefreshTimer);
    this.showIdlePanel(endMessage);
    const items = this.queue.splice(0);
    const tasks = items.map((item) => this.discard(item));
    if (this.current) tasks.push(this.finish(this.current, false, '플레이어 종료'));
    this.audioPlayer.stop(true);
    this.subscription?.unsubscribe();
    this.subscription = null;
    await Promise.all(tasks);
  }

  // ---------- 재생 흐름 ----------

  private subscribe(connection: VoiceConnection): void {
    if (this.subscription?.connection === connection) return;
    this.subscription = connection.subscribe(this.audioPlayer) ?? null;
  }

  /**
   * 곡 1개 재생 시작. current는 호출 즉시(동기) 설정됨 → 동시에 들어온 명령이 상태를 올바르게 봄.
   * 실패하면 스스로 정리하고 다음 곡으로 넘긴 뒤 에러를 던짐
   */
  private async startItem(item: QueueItem, mode: StartMode): Promise<TrackInfo> {
    const pb: Playback = { item, reader: null, resource: null, finished: false, errored: false };
    this.current = pb;
    try {
      return await this.runPlayback(pb, mode);
    } catch (error) {
      if (error instanceof PlaybackCancelledError || pb.finished) throw error;
      this.consecutiveFailures++;
      console.warn(`${this.tag()} #${item.id} 재생 실패: ${error instanceof Error ? error.message : String(error)}`);
      if (mode !== 'reply') this.announceFailure(item, error);
      const cleanup = this.finish(pb, false, '재생 준비 실패');
      this.advance(item, 'failed');
      await cleanup;
      throw error;
    }
  }

  private async runPlayback(pb: Playback, mode: StartMode): Promise<TrackInfo> {
    const { item } = pb;
    const prev = item.prepared;
    if (prev && (prev.job.status === 'failed' || prev.job.status === 'cancelled')) {
      item.prepared = null;
      await removeFile(prev.filePath);
    }

    await this.prepare(item);
    if (pb.finished) throw new PlaybackCancelledError();
    const prepared = item.prepared;
    if (!prepared || !item.info) throw new YtdlpError('오디오를 준비하지 못했어요. 다시 시도해 주세요.');

    await prepared.job.waitForBytes(START_BUFFER_BYTES, START_BUFFER_TIMEOUT_MS);
    if (pb.finished) throw new PlaybackCancelledError();

    const label = `${this.guildId} #${item.id}`;
    const reader = new TailReadStream(prepared.job, label);
    reader.on('error', (error) => {
      // 스킵·정지로 인한 종료는 정상 흐름
      if (!pb.finished) console.error(`${this.tag()} #${item.id} 읽기 오류`, error.message);
    });
    const resource = createAudioResource(reader, { inputType: StreamType.WebmOpus });
    pb.reader = reader;
    pb.resource = resource;
    this.audioPlayer.play(resource);
    console.log(`${this.tag()} #${item.id} 재생 시작${mode === 'replay' ? ' (반복)' : ''}: ${item.info.title}`);

    if (mode === 'channel') void this.announceNowPlaying(item);
    // 현재 곡 다운로드가 끝나면 다음 곡 미리 받기 (동시에 받아 대역폭 나눠 쓰지 않음)
    void prepared.job.exited.then(() => this.schedulePrefetch());
    this.schedulePrefetch();
    return item.info;
  }

  /** 곡이 스스로 끝남 (끝까지 재생 또는 재생 중 에러) */
  private onTrackEnd(pb: Playback): void {
    if (pb.errored) {
      this.consecutiveFailures++;
      this.announceFailure(pb.item, null);
      const cleanup = this.finish(pb, false, '재생 중 오류');
      this.advance(pb.item, 'failed');
      void cleanup;
      return;
    }
    this.consecutiveFailures = 0;
    // 한 곡 반복, 또는 전체 반복인데 대기열이 비어 있으면 받아둔 파일로 다시 재생
    const replay = this.loop === 'one' || (this.loop === 'all' && this.queue.length === 0);
    const cleanup = this.finish(pb, replay, replay ? '반복' : '재생 종료');
    this.advance(pb.item, replay ? 'replay' : 'ended');
    void cleanup;
  }

  /**
   * 다음 곡 결정 후 시작 (동기). 반드시 현재 곡을 finish()한 쪽에서 1번만 호출
   */
  private advance(last: QueueItem, cause: AdvanceCause): void {
    if (this.destroyed) return;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.consecutiveFailures = 0;
      const items = this.queue.splice(0);
      for (const item of items) void this.discard(item);
      console.warn(`${this.tag()} 연속 ${MAX_CONSECUTIVE_FAILURES}회 실패 → 재생 중지`);
      void this.sendText(`⚠️ 연속으로 ${MAX_CONSECUTIVE_FAILURES}곡 재생에 실패해서 대기열을 비웠어요.`);
      return;
    }

    if (cause === 'replay') {
      void this.startItem(last, 'replay').catch(() => undefined);
      return;
    }

    // 전체 반복: 끝났거나 스킵한 곡을 새 항목으로 대기열 끝에 (파일은 다시 받음)
    if (this.loop === 'all' && (cause === 'ended' || cause === 'skipped') && this.queue.length < MAX_QUEUE) {
      this.queue.push(newItem(last.url, last.requestedBy, last.info));
    }

    const next = this.queue.shift();
    if (!next) {
      console.log(`${this.tag()} 대기열 끝`);
      this.showIdlePanel('대기열의 곡을 모두 재생했어요.');
      return;
    }
    void this.startItem(next, 'channel').catch(() => undefined);
  }

  /**
   * 재생 1건 끝내기. 동기 부분: 상태 정리·재생 중지 / 반환 Promise: 다운로드 중단·파일 삭제.
   * keepFile=true면 반복 재생을 위해 받아둔 파일 유지
   */
  private finish(pb: Playback, keepFile: boolean, reason: string): Promise<void> {
    if (pb.finished) return Promise.resolve();
    pb.finished = true;
    if (this.current === pb) this.current = null;

    const state = this.audioPlayer.state;
    if (pb.resource && 'resource' in state && state.resource === pb.resource) {
      this.audioPlayer.stop(true);
    }
    pb.reader?.destroy();
    console.log(`${this.tag()} #${pb.item.id} 정리 (${reason})`);
    return keepFile ? Promise.resolve() : this.discard(pb.item);
  }

  // ---------- 다운로드 준비 ----------

  /** 다운로드 시작 + 메타데이터 확보 (이미 준비됐거나 준비 중이면 그걸 기다림) */
  private prepare(item: QueueItem): Promise<void> {
    if (item.prepared) return Promise.resolve();
    if (item.preparing) return item.preparing;
    if (item.discarded) return Promise.reject(new PlaybackCancelledError());

    const filePath = newTempFilePath(this.guildId);
    const task = (async () => {
      try {
        await ensureDiskSpace();
        const { info, job } = await startDownload(item.url, filePath, `#${item.id}`);
        if (item.discarded) {
          await job.cancel();
          await removeFile(filePath);
          throw new PlaybackCancelledError();
        }
        item.info = info;
        item.prepared = { job, filePath };
      } catch (error) {
        await removeFile(filePath);
        throw error;
      } finally {
        item.preparing = null;
      }
    })();
    item.preparing = task;
    return task;
  }

  /** 다음에 재생될 곡을 미리 받기. 현재 곡 다운로드가 끝난 뒤에만, 한 번에 1곡 */
  private schedulePrefetch(): void {
    if (this.destroyed) return;
    const cur = this.current;
    if (cur) {
      if (this.loop === 'one') return; // 다음 곡 = 현재 곡
      const status = cur.item.prepared?.job.status;
      if (status !== 'done') return; // 현재 곡 준비·다운로드 중
    }
    const next = this.queue[0];
    if (!next || next.prepared || next.preparing) return;
    console.log(`${this.tag()} #${next.id} 미리 받기 시작`);
    this.prepare(next).catch((error: unknown) => {
      // 실패해도 차례가 오면 한 번 더 시도
      if (!(error instanceof PlaybackCancelledError)) {
        console.warn(`${this.tag()} #${next.id} 미리 받기 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** 항목 버리기: 준비 중이면 끝날 때까지 기다린 뒤 다운로드 중단 + 파일 삭제 */
  private async discard(item: QueueItem): Promise<void> {
    item.discarded = true;
    const preparing = item.preparing;
    if (preparing) await preparing.catch(() => undefined);
    const prepared = item.prepared;
    item.prepared = null;
    if (prepared) {
      await prepared.job.cancel();
      await removeFile(prepared.filePath);
    }
  }

  // ---------- 알림 ----------

  private canSend(channel: GuildTextBasedChannel): boolean {
    const me = channel.guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    return perms.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks]);
  }

  private async announceNowPlaying(item: QueueItem): Promise<void> {
    const channel = this.textChannel;
    if (!channel || !item.info) return;
    if (!this.canSend(channel)) {
      console.warn(`${this.tag()} #${channel.id} 채널에 메시지 권한 없음 (메시지 보내기·링크 첨부)`);
      return;
    }
    try {
      const message = await channel.send({ ...this.panelPayload(), allowedMentions: { parse: [] } });
      this.replaceNowPlayingMessage(message);
    } catch (error) {
      console.warn(`${this.tag()} 지금 재생 중 메시지 전송 실패`, error instanceof Error ? error.message : error);
    }
  }

  private announceFailure(item: QueueItem, error: unknown): void {
    const reason = error instanceof UserFacingError ? error.userMessage : '재생 중 오류가 발생했어요.';
    void this.sendText(`⚠️ **${safeTitle(itemTitle(item))}** 재생 실패: ${reason} 다음 곡으로 넘어가요.`);
  }

  private async sendText(content: string): Promise<void> {
    const channel = this.textChannel;
    if (!channel || !this.canSend(channel)) return;
    try {
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      console.warn(`${this.tag()} 메시지 전송 실패`, error instanceof Error ? error.message : error);
    }
  }

  /** 패널 메시지를 현재 상태로 수정 (1.5초 안의 변경은 한 번에, 내용이 같으면 생략) */
  private schedulePanelRefresh(): void {
    if (!this.nowPlayingMessage || this.destroyed) return;
    if (this.panelRefreshTimer) clearTimeout(this.panelRefreshTimer);
    this.panelRefreshTimer = setTimeout(() => {
      this.panelRefreshTimer = null;
      const message = this.nowPlayingMessage;
      if (!message || this.destroyed) return;
      const before = this.lastPanelKey;
      const payload = this.panelPayload();
      if (this.lastPanelKey === before) return;
      message.edit({ ...payload, allowedMentions: { parse: [] } }).catch((error: unknown) => {
        console.warn(`${this.tag()} 패널 수정 실패`, error instanceof Error ? error.message : error);
      });
    }, 1_500);
  }

  /** 재생이 끝나면 패널을 "곡 추가" 버튼만 남긴 상태로 */
  private showIdlePanel(text: string): void {
    const message = this.nowPlayingMessage;
    if (!message) return;
    this.lastPanelKey = 'idle';
    const channel = message.channel.isTextBased() && 'guild' in message.channel ? message.channel : null;
    message
      .edit({ ...buildIdlePanel(text, canAttachBanner(channel)), allowedMentions: { parse: [] } })
      .catch((error: unknown) => {
        console.warn(`${this.tag()} 대기 카드로 수정 실패`, error instanceof Error ? error.message : error);
      });
  }

  /** 이전 "지금 재생 중" 메시지는 지워서 채팅이 쌓이지 않게 */
  private replaceNowPlayingMessage(message: Message): void {
    const old = this.nowPlayingMessage;
    this.nowPlayingMessage = message;
    if (old && old.id !== message.id) {
      old.delete().catch(() => undefined);
    }
  }
}

const players = new Map<string, GuildPlayer>();

export type { GuildPlayer };

export function getPlayer(guildId: string): GuildPlayer {
  let player = players.get(guildId);
  if (!player) {
    player = new GuildPlayer(guildId);
    players.set(guildId, player);
  }
  return player;
}

/** 플레이어가 없으면 만들지 않고 undefined */
export function findPlayer(guildId: string): GuildPlayer | undefined {
  return players.get(guildId);
}

export function isAnyPlayerActive(): boolean {
  for (const player of players.values()) if (player.isActive) return true;
  return false;
}

export function usedTempFiles(): Set<string> {
  return new Set([...players.values()].flatMap((player) => player.usedFiles()));
}

export function isPlayerActive(guildId: string): boolean {
  return players.get(guildId)?.isActive ?? false;
}

export async function destroyPlayer(guildId: string, endMessage?: string): Promise<void> {
  const player = players.get(guildId);
  if (!player) return;
  players.delete(guildId);
  await player.destroy(endMessage);
}

export async function destroyAllPlayers(): Promise<void> {
  await Promise.all([...players.keys()].map((guildId) => destroyPlayer(guildId)));
}

// 퇴장·정지·강제 퇴장 등으로 음성 연결이 끝나면 그 서버의 재생·대기열·임시 파일 정리
onConnectionDestroyed((guildId) => {
  void destroyPlayer(guildId).catch((error: unknown) => {
    console.error(`[player:${guildId}] 정리 오류`, error);
  });
});
