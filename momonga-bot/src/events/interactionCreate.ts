import { Events, MessageFlags, type RepliableInteraction } from 'discord.js';
import { defineEvent } from '../types/event';
import { commands } from '../commands';
import {
  handleMusicButton,
  handleMusicModal,
  handleMusicSelect,
  isMusicPanelButton,
  isMusicPanelModal,
  isMusicPanelSelect,
} from '../buttons/musicPanel';

async function replyError(interaction: RepliableInteraction, label: string, error: unknown): Promise<void> {
  console.error(`[${label}] 실행 오류`, error);
  const content = '⚠️ 처리하는 중 오류가 발생했어요.';
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyError) {
    console.error(`[${label}] 에러 응답 실패`, replyError);
  }
}

export const interactionCreate = defineEvent({
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction);
      } catch (error) {
        await replyError(interaction, `command:${interaction.commandName}`, error);
      }
      return;
    }

    if (interaction.isButton() && isMusicPanelButton(interaction.customId)) {
      try {
        await handleMusicButton(interaction);
      } catch (error) {
        await replyError(interaction, `button:${interaction.customId}`, error);
      }
      return;
    }

    if (interaction.isModalSubmit() && isMusicPanelModal(interaction.customId)) {
      try {
        await handleMusicModal(interaction);
      } catch (error) {
        await replyError(interaction, `modal:${interaction.customId}`, error);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && isMusicPanelSelect(interaction.customId)) {
      try {
        await handleMusicSelect(interaction);
      } catch (error) {
        await replyError(interaction, `select:${interaction.customId}`, error);
      }
    }
  },
});
