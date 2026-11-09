import {
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { EMBED_COLOR, queuedEmbed } from '../lib/embeds';
import { UserFacingError } from '../lib/errors';
import { safeTitle } from '../lib/format';
import { parseInput } from '../lib/youtube';
import { checkJoinable, getConnectedChannelId, joinChannel } from './voiceConnection';
import { getPlayer, isPlayerActive, MAX_QUEUE } from './player';
import { fetchPlaylist, searchVideos } from './ytdlp';

/** 재생목록에서 한 번에 가져올 최대 곡 수 */
export const PLAYLIST_LIMIT = 50;

type PlayInteraction =
  | ChatInputCommandInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>;

type ResultPayload = BaseMessageOptions & { flags?: MessageFlags.IsComponentsV2 };

/**
 * 응답 방식 차이 흡수
 * - 커맨드·입력 창: 본인에게만 에러 / 공개 응답으로 결과
 * - 검색 결과 고르기(본인에게만 보이는 메시지): 그 메시지를 "준비 중"으로 바꾸고 결과는 공개 메시지로 따로
 */
interface Responder {
  reject(text: string): Promise<void>;
  start(): Promise<void>;
  result(payload: ResultPayload): Promise<Message>;
  error(text: string): Promise<void>;
}

function makeResponder(interaction: PlayInteraction): Responder {
  if (interaction.isStringSelectMenu()) {
    return {
      reject: async (text) => {
        await interaction.update({ content: `⚠️ ${text}`, components: [] });
      },
      start: async () => {
        await interaction.update({ content: '⏳ 준비하고 있어요…', components: [] });
      },
      result: async (payload) => {
        await interaction.editReply({ content: '✅ 추가했어요.', components: [] });
        return interaction.followUp({ ...payload, allowedMentions: { parse: [] } });
      },
      error: async (text) => {
        await interaction.editReply({ content: `⚠️ ${text}`, components: [] });
      },
    };
  }
  return {
    reject: async (text) => {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    },
    start: async () => {
      await interaction.deferReply();
    },
    result: (payload) => interaction.editReply({ ...payload, allowedMentions: { parse: [] } }),
    error: async (text) => {
      await interaction.editReply(`⚠️ ${text}`);
    },
  };
}

function playlistEmbed(title: string | null, added: number, skippedForLimit: number, userId: string): EmbedBuilder {
  const name = title ? `**${safeTitle(title, 80)}**에서 ` : '';
  const limitNote = skippedForLimit > 0 ? `\n-# 대기열 한도(${MAX_QUEUE}곡) 때문에 ${skippedForLimit}곡은 빠졌어요.` : '';
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: '📥 재생목록 추가' })
    .setDescription(`${name}${added}곡을 대기열에 넣었어요 · 요청 <@${userId}>${limitNote}`);
}

/**
 * /재생, ➕ 곡 추가 창, 검색 결과 고르기에서 같이 쓰는 재생 요청 처리.
 * input: 영상 링크 / 재생목록 링크 / 검색어(첫 번째 결과)
 */
export async function handlePlayRequest(interaction: PlayInteraction, input: string): Promise<void> {
  const respond = makeResponder(interaction);

  const channel = interaction.member.voice.channel;
  if (!channel) {
    await respond.reject('먼저 음성 채널에 들어가 주세요.');
    return;
  }

  const parsed = parseInput(input);
  if (parsed.kind === 'invalid') {
    await respond.reject(parsed.reason);
    return;
  }

  // 다른 채널에서 재생 중이면 끌고 오지 않음
  const botChannelId = getConnectedChannelId(interaction.guildId);
  if (botChannelId && botChannelId !== channel.id && isPlayerActive(interaction.guildId)) {
    await respond.reject(`봇이 <#${botChannelId}>에서 재생 중이에요. 그 채널에서 사용해 주세요.`);
    return;
  }

  const problem = checkJoinable(channel);
  if (problem) {
    await respond.reject(problem);
    return;
  }

  await respond.start();

  try {
    // 검색어 → 첫 번째 결과의 링크로 (목록만 조회해서 빠름)
    let url: string | null = parsed.kind === 'video' ? parsed.url : null;
    if (parsed.kind === 'search') {
      const [first] = await searchVideos(parsed.query, 1);
      if (!first) {
        await respond.error(`"${safeTitle(parsed.query, 50)}" 검색 결과가 없어요.`);
        return;
      }
      url = first.url;
    }

    // 재생목록은 목록을 먼저 받아둠 (연결 전에 실패하면 괜히 입장하지 않도록)
    const playlist = parsed.kind === 'playlist' ? await fetchPlaylist(parsed.url, PLAYLIST_LIMIT) : null;
    if (playlist && playlist.entries.length === 0) {
      await respond.error('재생목록에서 재생할 수 있는 곡을 찾지 못했어요. (비공개 재생목록이면 볼 수 없어요)');
      return;
    }

    const joined = await joinChannel(channel);
    if (!joined.ok) {
      await respond.error(joined.reason);
      return;
    }
    const player = getPlayer(interaction.guildId);

    if (playlist) {
      const result = await player.enqueueMany(joined.connection, playlist.entries, interaction.user.id, interaction.channel);
      if (result.started) {
        const message = await respond.result(player.panelPayload());
        player.setNowPlayingMessage(message);
        // 패널과 별개로 몇 곡 들어갔는지 알림 (1곡짜리면 생략)
        if (result.added <= 1) return;
        await interaction.followUp({
          embeds: [playlistEmbed(playlist.title, result.added - 1, result.skippedForLimit, interaction.user.id)],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await respond.result({
        embeds: [playlistEmbed(playlist.title, result.added, result.skippedForLimit, interaction.user.id)],
      });
      return;
    }

    if (!url) return;
    const result = await player.enqueue(joined.connection, url, interaction.user.id, interaction.channel);
    if (result.kind === 'queued') {
      await respond.result({ embeds: [queuedEmbed(result.info, interaction.user.id, result.position)] });
      return;
    }
    // 바로 재생: 이 응답이 플레이어 카드 (다음 곡이 시작되면 새 카드로 바뀜)
    const message = await respond.result(player.panelPayload());
    player.setNowPlayingMessage(message);
  } catch (error) {
    if (error instanceof UserFacingError) {
      await respond.error(error.userMessage);
      return;
    }
    throw error;
  }
}
