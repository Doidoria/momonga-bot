import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  LabelBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
import { EMBED_COLOR, LOOP_LABEL, type LoopMode } from './embeds';
import { formatDuration, safeTitle } from './format';
import { fallbackThumbnail } from './thumbnail';
import type { TrackInfo } from '../services/ytdlp';

/** 버튼·모달 customId (상태는 넣지 않고 동작 이름만) */
export const PANEL_ID = {
  toggle: 'mp:toggle',
  skip: 'mp:skip',
  stop: 'mp:stop',
  loop: 'mp:loop',
  add: 'mp:add',
  queue: 'mp:queue',
  queuePagePrefix: 'mp:qpage:',
  addModal: 'mp:addModal',
  addModalUrl: 'url',
  search: 'mp:search',
  searchModal: 'mp:searchModal',
  searchModalQuery: 'query',
  pick: 'mp:pick',
} as const;

export const SEARCH_RESULTS = 5;

export interface PanelState {
  info: TrackInfo;
  requestedBy: string;
  queueLength: number;
  nextTitle: string | null;
  loop: LoopMode;
  paused: boolean;
}

/** Components V2 카드 메시지 (embeds·content와 같이 쓸 수 없음) */
export interface PanelPayload {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  files: AttachmentBuilder[];
}

// ---------- 대기 화면 배너 (선택) ----------
// assets/panel-banner.(gif|png|jpg|webp) 파일이 있으면 대기 화면 카드에 크게 표시
const BANNER_EXTS = ['gif', 'png', 'jpg', 'webp'] as const;
const bannerPath = BANNER_EXTS.map((ext) => path.resolve(process.cwd(), 'assets', `panel-banner.${ext}`)).find((p) =>
  existsSync(p),
);
const bannerName = bannerPath ? path.basename(bannerPath) : null;

/** 이 채널에서 배너를 붙일 수 있는지 (배너 파일이 있고 봇에 파일 첨부 권한) */
export function canAttachBanner(channel: GuildTextBasedChannel | null): boolean {
  if (!bannerPath || !channel) return false;
  const me = channel.guild.members.me;
  return me ? channel.permissionsFor(me).has(PermissionFlagsBits.AttachFiles) : false;
}

// ---------- 버튼 ----------

function button(id: string, label: string, emoji: string, style: ButtonStyle): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

const addButton = () => button(PANEL_ID.add, '곡 추가', '➕', ButtonStyle.Primary);
const queueButton = () => button(PANEL_ID.queue, '대기열', '📜', ButtonStyle.Secondary);
const searchButton = () => button(PANEL_ID.search, '검색', '🔍', ButtonStyle.Secondary);

function controlRows(state: PanelState): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      state.paused
        ? button(PANEL_ID.toggle, '재개', '▶️', ButtonStyle.Success)
        : button(PANEL_ID.toggle, '일시정지', '⏸️', ButtonStyle.Secondary),
      button(PANEL_ID.skip, '스킵', '⏭️', ButtonStyle.Secondary),
      button(PANEL_ID.stop, '정지', '⏹️', ButtonStyle.Danger),
      button(
        PANEL_ID.loop,
        `반복: ${LOOP_LABEL[state.loop]}`,
        state.loop === 'one' ? '🔂' : '🔁',
        state.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success,
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(addButton(), searchButton(), queueButton()),
  ];
}

const text = (content: string) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

function thumbnailUrl(info: TrackInfo): string {
  // 확인된 주소가 없으면 항상 존재하는 기본 썸네일
  return info.thumbnail ?? fallbackThumbnail(info.id);
}

// ---------- 패널 ----------

/** 재생 중 카드: 제목 · 큰 썸네일 · 곡 정보 · 버튼 */
export function buildPlayerPanel(state: PanelState): PanelPayload {
  const { info } = state;
  const footer = [
    state.nextTitle ? `다음 곡: ${safeTitle(state.nextTitle, 40)}` : '다음 곡 없음',
    `대기열 ${state.queueLength}곡`,
    `반복 ${LOOP_LABEL[state.loop]}`,
  ].join(' · ');

  const container = new ContainerBuilder()
    .setAccentColor(state.paused ? 0x9aa0a6 : EMBED_COLOR)
    .addTextDisplayComponents(text(state.paused ? '### ⏸️ 일시정지됨' : '### 🎵 지금 재생 중'))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems((item) => item.setURL(thumbnailUrl(info))))
    .addTextDisplayComponents(
      text(`**[${safeTitle(info.title, 90)}](${info.url})**\n⏱️ \`${formatDuration(info.duration)}\` · 🙋 <@${state.requestedBy}>`),
      text(`-# ${footer}`),
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(...controlRows(state));

  return { components: [container], flags: MessageFlags.IsComponentsV2, files: [] };
}

/** 대기 카드: 안내 문구 · (배너) · 곡 추가 버튼. 파일 첨부 권한이 없으면 withBanner=false */
export function buildIdlePanel(message = '재생 중인 곡이 없어요.', withBanner = true): PanelPayload {
  const container = new ContainerBuilder()
    .setAccentColor(EMBED_COLOR)
    .addTextDisplayComponents(
      text(`### 🐿️ 모몽가 플레이어\n${message}\n-# ➕ 곡 추가에 링크·재생목록·검색어를 넣거나, 🔍 검색으로 골라서 재생해요.`),
    );

  const files: AttachmentBuilder[] = [];
  if (withBanner && bannerPath && bannerName) {
    files.push(new AttachmentBuilder(bannerPath, { name: bannerName }));
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems((item) => item.setURL(`attachment://${bannerName}`)),
    );
  }

  container
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(addButton(), searchButton(), queueButton()),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2, files };
}

/** ➕ 곡 추가 → 링크 입력 창 */
export function buildAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(PANEL_ID.addModal)
    .setTitle('곡 추가')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('링크 또는 검색어')
        .setDescription('영상·재생목록 링크, 또는 검색어(첫 번째 결과). 재생 중이면 대기열에 추가')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(PANEL_ID.addModalUrl)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://youtu.be/... 또는 노래 제목')
            .setRequired(true)
            .setMaxLength(200),
        ),
    );
}

/** 🔍 검색 → 검색어 입력 창 */
export function buildSearchModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(PANEL_ID.searchModal)
    .setTitle('유튜브 검색')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('검색어')
        .setDescription(`상위 ${SEARCH_RESULTS}개 중에서 고를 수 있어요`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(PANEL_ID.searchModalQuery)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('노래 제목, 가수 이름')
            .setRequired(true)
            .setMaxLength(100),
        ),
    );
}

/** 검색 결과 고르기 메뉴 (값 = 영상 ID) */
export function buildSearchPicker(results: TrackInfo[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(PANEL_ID.pick)
    .setPlaceholder('재생할 곡을 고르세요')
    .addOptions(
      results.map((info, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${index + 1}. ${info.title}`.slice(0, 100))
          .setDescription(`${formatDuration(info.duration)}${info.uploader ? ` · ${info.uploader}` : ''}`.slice(0, 100))
          .setValue(info.id),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
