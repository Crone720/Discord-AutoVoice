import { Telegraf } from 'telegraf';

import { ConfigManager } from '../managers/ConfigManager';

export class NotificationService {
  private readonly bot: Telegraf;
  private readonly config: ConfigManager;

  constructor(bot: Telegraf, config: ConfigManager) {
    this.bot = bot;
    this.config = config;
  }

  public async send(text: string, extra: object = {}): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.notifications.enabled || !cfg.owner_id) {
      return;
    }

    try {
      const messageOptions: { parse_mode: 'Markdown'; disable_web_page_preview: boolean } & Record<string, unknown> = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(extra as Record<string, unknown>)
      };

      await this.bot.telegram.sendMessage(cfg.owner_id, text, messageOptions);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("can't parse entities") || errorMessage.includes('Can\'t find end of the entity')) {
        console.warn('⚠️ Ошибка форматирования уведомления, повторная отправка без parse_mode.');
        const fallbackOptions: Record<string, unknown> = {
          disable_web_page_preview: true,
          ...(extra as Record<string, unknown>)
        };
        delete (fallbackOptions as Record<string, unknown>).parse_mode;
        try {
          await this.bot.telegram.sendMessage(cfg.owner_id, text, fallbackOptions);
          return;
        } catch (retryError) {
          console.error('❌ Повторная отправка уведомления не удалась:', retryError instanceof Error ? retryError.message : retryError);
          return;
        }
      }

      console.error('❌ Ошибка отправки уведомления:', errorMessage);
    }
  }

  public async notifyJoinLeave(text: string, extra?: object): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.notifications.on_join_leave) {
      return;
    }
    await this.send(text, extra ?? {});
  }

  public async notifyRoleChanges(text: string, extra?: object): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.notifications.on_role_changes) {
      return;
    }
    await this.send(text, extra ?? {});
  }

  public async notifyChannelChanges(text: string, extra?: object): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.notifications.on_channel_changes) {
      return;
    }
    await this.send(text, extra ?? {});
  }

  public async notifyMove(text: string, extra?: object): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.notifications.on_move) {
      return;
    }
    await this.send(text, extra ?? {});
  }
}
