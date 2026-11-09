import {
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { buildAddModal, buildSearchModal, buildSearchPicker, PANEL_ID, SEARCH_RESULTS } from '../lib/panel';
import { UserFacingError } from '../lib/errors';
import { safeTitle } from '../lib/format';
import { isVideoId, videoUrl } from '../lib/youtube';
import { searchVideos } from '../services/ytdlp';
import type { LoopMode } from '../lib/embeds';
import { findPlayer, type GuildPlayer } from '../services/player';
import { leaveChannel } from '../services/voiceConnection';
import { checkSameVoiceChannel, replyEphemeral } from '../services/commandGuards';
import { buildQueueView } from '../services/queueView';
import { handlePlayRequest } from '../services/playRequest';

const NEXT_LOOP: Record<LoopMode, LoopMode> = { off: 'one', one: 'all', all: 'off' };

export function isMusicPanelButton(customId: string): boolean {
  return customId.startsWith('mp:');
}

/**
 * 누른 메시지가 지금 패널이면 그 자리에서 갱신, 오래된 패널이면 본인에게만 결과 안내
 */
async function respond(interaction: ButtonInteraction<'cached'>, player: GuildPlayer, text: string): Promise<void> {
  if (player.isNowPlayingMessage(interaction.message.id) && player.hasCurrent) {
    await interaction.update({ ...player.panelPayload(), allowedMentions: { parse: [] } });
    return;
  }
  await replyEphemeral(interaction, text);
}

export async function handleMusicButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const { customId } = interaction;

  // 대기열 보기·페이지 이동: 누구나
  if (customId === PANEL_ID.queue || customId.startsWith(PANEL_ID.queuePagePrefix)) {
    const isPage = customId.startsWith(PANEL_ID.queuePagePrefix);
    const page = isPage ? Number(customId.slice(PANEL_ID.queuePagePrefix.length)) || 1 : 1;
    const view = buildQueueView(findPlayer(interaction.guildId), page);
    if (!view) {
      if (isPage) await interaction.update({ content: '대기열이 비어 있어요.', embeds: [], components: [] });
      else await replyEphemeral(interaction, '대기열이 비어 있어요.');
      return;
    }
    if (isPage) await interaction.update({ ...view, allowedMentions: { parse: [] } });
    else await interaction.reply({ ...view, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  // 곡 추가·검색: 입력 창 (음성 채널 확인은 제출할 때)
  if (customId === PANEL_ID.add) {
    await interaction.showModal(buildAddModal());
    return;
  }
  if (customId === PANEL_ID.search) {
    await interaction.showModal(buildSearchModal());
    return;
  }

  // 나머지 제어 버튼: 봇과 같은 음성 채널만
  const problem = checkSameVoiceChannel(interaction);
  if (problem) {
    await replyEphemeral(interaction, problem);
    return;
  }
  const player = findPlayer(interaction.guildId);

  switch (customId) {
    case PANEL_ID.toggle: {
      if (!player?.hasCurrent) {
        await replyEphemeral(interaction, '재생 중인 곡이 없어요.');
        return;
      }
      if (player.isPaused) player.resume();
      else player.pause();
      await respond(interaction, player, player.isPaused ? '⏸️ 일시정지했어요.' : '▶️ 다시 재생해요.');
      return;
    }
    case PANEL_ID.loop: {
      if (!player) {
        await replyEphemeral(interaction, '재생 중인 곡이 없어요.');
        return;
      }
      const next = NEXT_LOOP[player.loopMode];
      player.setLoop(next);
      await respond(interaction, player, `🔁 반복 모드를 바꿨어요.`);
      return;
    }
    case PANEL_ID.skip: {
      if (!player?.hasCurrent) {
        await replyEphemeral(interaction, '재생 중인 곡이 없어요.');
        return;
      }
      // 다음 곡 패널이 새로 올라오거나(이 패널은 삭제) 대기열이 끝나면 종료 패널로 바뀜
      await interaction.deferUpdate();
      player.skip();
      return;
    }
    case PANEL_ID.stop: {
      await interaction.deferUpdate();
      leaveChannel(interaction.guildId); // 연결 종료 → 플레이어 정리 + 패널이 종료 상태로 바뀜
      return;
    }
    default:
      await replyEphemeral(interaction, '알 수 없는 버튼이에요.');
  }
}

export function isMusicPanelModal(customId: string): boolean {
  return customId === PANEL_ID.addModal || customId === PANEL_ID.searchModal;
}

export async function handleMusicModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  if (interaction.customId === PANEL_ID.addModal) {
    await handlePlayRequest(interaction, interaction.fields.getTextInputValue(PANEL_ID.addModalUrl));
    return;
  }

  // 🔍 검색: 상위 결과를 본인에게만 보여주고 고르게 함
  const query = interaction.fields.getTextInputValue(PANEL_ID.searchModalQuery).trim();
  if (!interaction.member.voice.channelId) {
    await replyEphemeral(interaction, '먼저 음성 채널에 들어가 주세요.');
    return;
  }
  if (!query) {
    await replyEphemeral(interaction, '검색어를 입력해 주세요.');
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const results = await searchVideos(query, SEARCH_RESULTS);
    if (results.length === 0) {
      await interaction.editReply(`"${safeTitle(query, 50)}" 검색 결과가 없어요.`);
      return;
    }
    await interaction.editReply({
      content: `🔍 **${safeTitle(query, 50)}** 검색 결과`,
      components: [buildSearchPicker(results)],
    });
  } catch (error) {
    if (error instanceof UserFacingError) {
      await interaction.editReply(`⚠️ ${error.userMessage}`);
      return;
    }
    throw error;
  }
}

export function isMusicPanelSelect(customId: string): boolean {
  return customId === PANEL_ID.pick;
}

/** 검색 결과에서 고른 곡 재생 (값은 영상 ID만, 형식 확인 후 표준 주소로) */
export async function handleMusicSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const [videoId] = interaction.values;
  if (!videoId || !isVideoId(videoId)) {
    await interaction.update({ content: '⚠️ 잘못된 선택이에요.', components: [] });
    return;
  }
  await handlePlayRequest(interaction, videoUrl(videoId));
}
