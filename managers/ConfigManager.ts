import { existsSync, readFileSync, writeFileSync } from 'fs-extra';
import * as path from 'path';
import { Telegraf } from 'telegraf';

import { IConfig } from '../types/config';

export class ConfigManager {
  private readonly configPath: string;
  private config: IConfig;

  constructor(configDir: string = process.cwd()) {
    this.configPath = path.join(configDir, 'settings.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): IConfig {
    if (!existsSync(this.configPath)) {
      console.log('⚠️ Файл settings.json не найден. Создаю новый со стандартными настройками...');
      const defaultConfig = this.getDefaultConfig();
      writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 4), 'utf-8');
      return defaultConfig;
    }

    try {
      const data = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(data) as Partial<IConfig> & Record<string, unknown>;
      const defaultConfig = this.getDefaultConfig();
      const normalized: IConfig = {
        ...defaultConfig,
        ...parsed,
        notifications: {
          ...defaultConfig.notifications,
          ...(parsed.notifications ?? {})
        }
      };

      if (!parsed.presence_status || parsed.legalizer_enabled === undefined) {
        writeFileSync(this.configPath, JSON.stringify(normalized, null, 4), 'utf-8');
      }

      return normalized;
    } catch (error) {
      console.error('❌ Ошибка при чтении конфига (неверный формат):', error);
      return this.getDefaultConfig();
    }
  }

  private getDefaultConfig(): IConfig {
    return {
      owner_id: null,
      discord_token: '',
      tg_bot_token: 'вот_тут_укажите_токен',
      guild_id: '',
      target_vc_id: '',
      role_id: '',
      account_display_name: null,
      account_token: null,
      presence_status: 'online',
      auto_reconnect_enabled: true,
      auto_reconnect_delay: 180,
      legalizer_enabled: false,
      legalizer_min_delay: 120,
      legalizer_max_delay: 180,
      mute_microphone: false,
      mute_headphones: false,
      notifications: {
        enabled: true,
        on_join_leave: true,
        on_role_changes: true,
        on_channel_changes: true,
        on_move: true
      }
    };
  }

  public async initializeTgBot(bot: Telegraf): Promise<boolean> {
    try {
      const botInfo = await bot.telegram.getMe();
      console.log(`✅ Токен Telegram бота валидный: @${botInfo.username}`);
      return true;
    } catch (error) {
      console.error('❌ Токен Telegram бота невалидный:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  public save(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 4), 'utf-8');
      console.log('✅ Конфиг сохранен');
    } catch (error) {
      console.error('❌ Ошибка при сохранении конфига:', error);
    }
  }

  public get(): IConfig {
    return this.config;
  }

  public update<K extends keyof IConfig>(key: K, value: IConfig[K]): void {
    this.config[key] = value;
    this.save();
  }

  public updateNested(pathValue: string, value: unknown): void {
    const keys = pathValue.split('.');
    let current: Record<string, unknown> = this.config as unknown as Record<string, unknown>;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index];
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
    this.save();
  }

  public getNested(pathValue: string): unknown {
    const keys = pathValue.split('.');
    let current: unknown = this.config;

    for (const key of keys) {
      if (typeof current === 'object' && current !== null && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  public isReady(): boolean {
    return Boolean(
      this.config.owner_id &&
      this.config.discord_token &&
      this.config.tg_bot_token &&
      this.config.guild_id &&
      this.config.target_vc_id
    );
  }
}
