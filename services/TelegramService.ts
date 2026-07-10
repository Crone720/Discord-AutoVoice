import { Context, Markup, Telegraf } from 'telegraf';
import { ParseMode } from 'telegraf/typings/core/types/typegram';

import { ConfigManager } from '../managers/ConfigManager';
import { StateManager } from '../managers/StateManager';
import { VoiceChannelLike, VoiceMemberLike } from '../types/discord';
import { DiscordService } from './DiscordService';
import { GistServerConfig, GistService } from './GistService';

interface WaitingInput {
  type: 'discord_token' | 'legalizer_range' | 'reconnect_h' | 'reconnect_m' | 'reconnect_s' | 'channel_input';
  accountAction?: 'connect' | 'change';
}

interface AccountMessageRef {
  chatId: number;
  messageId: number;
}

interface VoiceMemberEntry {
  id: string;
  username: string;
  displayName: string;
  isMuted: boolean;
  isDeaf: boolean;
  isStaff: boolean;
  staffReason: string;
  line: string;
}

interface GistNavigationState {
  page: number;
  selectedServer?: string;
}

export class TelegramService {
  private readonly bot: Telegraf;
  private readonly config: ConfigManager;
  private readonly state: StateManager;
  private readonly discord: DiscordService;
  private readonly waitingForInput: Map<number, WaitingInput>;
  private readonly trackedAccountMessages: Map<number, AccountMessageRef>;
  private readonly gistNavigation: Map<number, GistNavigationState>;
  private readonly gist: GistService;
  private onDiscordReadyCallback?: () => void;
  private readonly discordSubscription: () => void;

  constructor(bot: Telegraf, config: ConfigManager, state: StateManager, discord: DiscordService, gist: GistService) {
    this.bot = bot;
    this.config = config;
    this.state = state;
    this.discord = discord;
    this.gist = gist;
    this.waitingForInput = new Map();
    this.trackedAccountMessages = new Map();
    this.gistNavigation = new Map();
    this.discordSubscription = this.discord.subscribe(() => {
      void this.refreshTrackedAccountMessages();
    });
  }

  public setDiscordReadyCallback(callback: () => void): void {
    this.onDiscordReadyCallback = callback;
  }

  public async initialize(): Promise<void> {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) {
        return;
      }

      const cfg = this.config.get();
      if (!cfg.owner_id) {
        cfg.owner_id = ctx.from.id;
        this.config.update('owner_id', ctx.from.id);
        await ctx.reply(`👑 *Вы установлены как владелец бота*\n` +
          `ID: ${ctx.from.id}\n\n` +
          'Используйте /start для открытия панели управления');
      }

      if (ctx.from.id !== cfg.owner_id) {
        return;
      }

      return next();
    });

    this.setupCommands();
    this.setupActionHandlers();
    this.setupTextHandler();

    this.bot.launch();
    console.log('✅ Telegram бот запущен');
  }

  private setupCommands(): void {
    this.bot.command(['start', 'panel'], async (ctx) => {
      await this.sendMainPanel(ctx);
    });
  }

  private setupActionHandlers(): void {
    this.bot.action('refresh_panel', async (ctx) => {
      await this.sendMainPanel(ctx);
    });

    this.bot.action('account', async (ctx) => {
      await this.sendAccountPanel(ctx);
    });

    this.bot.action('account_change', async (ctx) => {
      await this.promptForToken(ctx, 'change');
    });

    this.bot.action('account_connect', async (ctx) => {
      await this.promptForToken(ctx, 'connect');
    });

    this.bot.action('account_remove', async (ctx) => {
      await this.sendAccountRemoveConfirmation(ctx);
    });

    this.bot.action('account_remove_confirm', async (ctx) => {
      const removed = await this.discord.removeToken();
      if (removed) {
        await ctx.answerCbQuery('🗑️ Токен удален');
      } else {
        await ctx.answerCbQuery('⚠️ Не удалось удалить токен');
      }
      await this.sendAccountPanel(ctx);
    });

    this.bot.action('account_remove_cancel', async (ctx) => {
      await ctx.answerCbQuery('❌ Отменено');
      await this.sendAccountPanel(ctx);
    });

    this.bot.action('notifications', async (ctx) => {
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('notify_toggle', async (ctx) => {
      const cfg = this.config.get();
      cfg.notifications.enabled = !cfg.notifications.enabled;
      this.config.update('notifications', cfg.notifications);
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('notify_join_leave', async (ctx) => {
      const cfg = this.config.get();
      cfg.notifications.on_join_leave = !cfg.notifications.on_join_leave;
      this.config.update('notifications', cfg.notifications);
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('notify_role_changes', async (ctx) => {
      const cfg = this.config.get();
      cfg.notifications.on_role_changes = !cfg.notifications.on_role_changes;
      this.config.update('notifications', cfg.notifications);
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('notify_channel_changes', async (ctx) => {
      const cfg = this.config.get();
      cfg.notifications.on_channel_changes = !cfg.notifications.on_channel_changes;
      this.config.update('notifications', cfg.notifications);
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('notify_move', async (ctx) => {
      const cfg = this.config.get();
      cfg.notifications.on_move = !cfg.notifications.on_move;
      this.config.update('notifications', cfg.notifications);
      await this.sendNotificationsPanel(ctx);
    });

    this.bot.action('settings', async (ctx) => {
      await this.sendSettingsPanel(ctx);
    });

    this.bot.action('status_online', async (ctx) => {
      await this.handleStatusChange(ctx, 'online');
    });

    this.bot.action('status_idle', async (ctx) => {
      await this.handleStatusChange(ctx, 'idle');
    });

    this.bot.action('status_dnd', async (ctx) => {
      await this.handleStatusChange(ctx, 'dnd');
    });

    this.bot.action('status_invisible', async (ctx) => {
      await this.handleStatusChange(ctx, 'invisible');
    });

    this.bot.action('status_menu', async (ctx) => {
      await this.sendStatusMenu(ctx);
    });

    this.bot.action('toggle_microphone', async (ctx) => {
      const cfg = this.config.get();
      cfg.mute_microphone = !cfg.mute_microphone;
      this.config.update('mute_microphone', cfg.mute_microphone);
      if (this.discord.isInitialized()) {
        await this.discord.setMute(cfg.mute_microphone);
      }
      await ctx.answerCbQuery(`Микрофон ${cfg.mute_microphone ? 'выключен' : 'включен'}`);
      await this.sendSettingsPanel(ctx);
    });

    this.bot.action('toggle_headphones', async (ctx) => {
      const cfg = this.config.get();
      cfg.mute_headphones = !cfg.mute_headphones;
      this.config.update('mute_headphones', cfg.mute_headphones);
      if (this.discord.isInitialized()) {
        await this.discord.setDeaf(cfg.mute_headphones);
      }
      await ctx.answerCbQuery(`Наушники ${cfg.mute_headphones ? 'выключены' : 'включены'}`);
      await this.sendSettingsPanel(ctx);
    });

    this.bot.action('lock_room', async (ctx) => {
      const cfg = this.config.get();
      const server = await this.gist.getServerByGuildId(cfg.guild_id);
      if (!server) {
        await this.safeAnswerCbQuery(ctx, '❌ Gist-конфиг для этого сервера не найден');
        await this.sendSettingsPanel(ctx);
        return;
      }

      await this.sendLockRoomPanel(ctx, server);
    });

    this.bot.action('manage', async (ctx) => {
      await this.sendManagementPanel(ctx);
    });

    this.bot.action('restart_client', async (ctx) => {
      await ctx.answerCbQuery('♻️ Перезапуск клиента...');
      const result = await this.discord.restart();
      if (result) {
        await ctx.reply('✅ Клиент Discord перезапущен');
      } else {
        await ctx.reply('❌ Не удалось перезапустить клиент. Проверьте токен и состояние.');
      }
      await this.sendManagementPanel(ctx);
    });

    this.bot.action('refresh_gist', async (ctx) => {
      await ctx.answerCbQuery('🔄 Обновляю Gist...');
      try {
        await this.gist.refresh();
        await ctx.reply('✅ Gist обновлён');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`❌ Ошибка при обновлении Gist: ${message}`);
      }
      await this.sendManagementPanel(ctx);
    });

    this.bot.action('lock_room_toggle', async (ctx) => {
      const cfg = this.config.get();
      const server = await this.gist.getServerByGuildId(cfg.guild_id);
      if (!server) {
        await this.safeAnswerCbQuery(ctx, '❌ Gist-конфиг для этого сервера не найден');
        await this.sendSettingsPanel(ctx);
        return;
      }

      const key = `gist_auto_lock.${server.server_id}`;
      const current = Boolean(this.config.getNested(key));
      const next = !current;
      this.config.updateNested(key, next);

      if (next) {
        await this.safeAnswerCbQuery(ctx, '🔒 Автоматическая блокировка включена');
        const currentVoice = this.discord.getCurrentVoiceChannel(server.server_id);
        if (currentVoice && currentVoice === server.voice_channel_id) {
          const result = await this.discord.pressLockRoom(server);
          await ctx.reply(result.message);
        } else {
          await ctx.reply('ℹ️ Бот пока не в голосовом канале. Блокировка будет выполнена при его следующем подключении.');
        }
      } else {
        await this.safeAnswerCbQuery(ctx, '🔓 Автоматическая блокировка отключена');
      }

      await this.sendLockRoomPanel(ctx, server);
    });

    this.bot.action('lock_room_back', async (ctx) => {
      await this.sendSettingsPanel(ctx);
    });

    this.bot.action('manage_back', async (ctx) => {
      await this.sendSettingsPanel(ctx);
    });

    this.bot.action('legalizer_toggle', async (ctx) => {
      const cfg = this.config.get();
      cfg.legalizer_enabled = !cfg.legalizer_enabled;
      this.config.update('legalizer_enabled', cfg.legalizer_enabled);
      await this.sendReconnectMenu(ctx);
    });

    this.bot.action('legalizer_range', async (ctx) => {
      await ctx.editMessageText('*Настройка Легалайзера*\n\n' +
        'Введите диапазон в формате: `mm:ss-mm:ss`\n' +
        'Например: `02:00-03:30`', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
      this.waitingForInput.set(ctx.from.id, { type: 'legalizer_range' });
    });

    this.bot.action('reconnect_menu', async (ctx) => {
      await this.sendReconnectMenu(ctx);
    });

    this.bot.action('reconnect_h', async (ctx) => {
      await ctx.editMessageText('*Авто-переподключение (часы)*\n\n' +
        'Введите количество часов (от 1 до 24):', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
      this.waitingForInput.set(ctx.from.id, { type: 'reconnect_h' });
    });

    this.bot.action('reconnect_m', async (ctx) => {
      await ctx.editMessageText('*Авто-переподключение (минуты)*\n\n' +
        'Введите количество минут (от 1 до 59):', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
      this.waitingForInput.set(ctx.from.id, { type: 'reconnect_m' });
    });

    this.bot.action('reconnect_s', async (ctx) => {
      await ctx.editMessageText('*Авто-переподключение (секунды)*\n\n' +
        'Введите количество секунд (от 1 до 59):', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
      this.waitingForInput.set(ctx.from.id, { type: 'reconnect_s' });
    });

    this.bot.action('reconnect_now', async (ctx) => {
      const cfg = this.config.get();
      cfg.auto_reconnect_enabled = true;
      cfg.auto_reconnect_delay = 0;
      this.config.update('auto_reconnect_enabled', true);
      this.config.update('auto_reconnect_delay', 0);
      await ctx.answerCbQuery('⚡ Переподключение будет моментальным');
      await this.sendReconnectMenu(ctx);
    });

    this.bot.action('reconnect_clear', async (ctx) => {
      const cfg = this.config.get();
      cfg.auto_reconnect_enabled = false;
      this.config.update('auto_reconnect_enabled', false);
      this.state.clearReconnectTimer();
      await ctx.answerCbQuery('🗑️ Авто-переподключение отключено');
      await this.sendReconnectMenu(ctx);
    });

    this.bot.action('reconnect_fixed', async (ctx) => {
      await ctx.editMessageText('*Фиксированное время*\n\n' +
        'Выберите единицу измерения:', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Часы', 'reconnect_h'), Markup.button.callback('Минуты', 'reconnect_m'), Markup.button.callback('Секунды', 'reconnect_s')],
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
    });

    this.bot.action('reconnect_legalizer', async (ctx) => {
      await ctx.editMessageText('*Настройка Легалайзера*\n\n' +
        'Введите диапазон в формате: `mm:ss-mm:ss`\n' +
        'Например: `02:00-03:30`', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'reconnect_menu')]
          ])
        });
      this.waitingForInput.set(ctx.from.id, { type: 'legalizer_range' });
    });

    this.bot.action('force_exit', async (ctx) => {
      const cfg = this.config.get();
      this.state.setStopped(true);
      this.state.clearReconnectTimer();
      await this.discord.leaveVoiceChannel(cfg.guild_id);
      await ctx.answerCbQuery('🚀 Выход выполнен, авто-вход отключен');
      await ctx.reply('🛑 Вы вышли из канала. Режим "Стоп" активирован.');
      await this.sendMainPanel(ctx);
    });

    this.bot.action('server_list', async (ctx) => {
      await this.sendServerList(ctx);
    });

    this.bot.action('gist_list_prev', async (ctx) => {
      const userId = ctx.from?.id ?? 0;
      const current = this.gistNavigation.get(userId) ?? { page: 0 };
      const nextPage = Math.max(0, current.page - 1);
      this.gistNavigation.set(userId, { ...current, page: nextPage });
      await this.sendServerList(ctx);
    });

    this.bot.action('gist_list_next', async (ctx) => {
      const userId = ctx.from?.id ?? 0;
      const current = this.gistNavigation.get(userId) ?? { page: 0 };
      this.gistNavigation.set(userId, { ...current, page: current.page + 1 });
      await this.sendServerList(ctx);
    });

    this.bot.action(/^gist_server_(.+)$/, async (ctx) => {
      const match = ctx.match;
      const serverName = typeof match === 'string' ? match : match?.[1] ?? '';
      if (!serverName) {
        await ctx.answerCbQuery('❌ Сервер не найден');
        return;
      }
      await this.sendServerConfirmation(ctx, serverName);
    });

    this.bot.action('gist_confirm_add', async (ctx) => {
      const userId = ctx.from?.id ?? 0;
      const selectedServer = this.gistNavigation.get(userId)?.selectedServer;
      if (!selectedServer) {
        await ctx.answerCbQuery('❌ Сначала выберите сервер');
        return;
      }
      await this.handleServerValidation(ctx, selectedServer);
    });

    this.bot.action('gist_confirm_back', async (ctx) => {
      await this.sendServerList(ctx);
    });

    this.bot.action('gist_main_menu', async (ctx) => {
      await this.sendMainPanel(ctx);
    });

    this.bot.action('setup_channel', async (ctx) => {
      await this.sendChannelSetupPrompt(ctx);
    });

    this.bot.action('join_now', async (ctx) => {
      const cfg = this.config.get();
      this.state.clearReconnectTimer();
      this.state.setNextJoinTimestamp(null);
      await this.safeAnswerCbQuery(ctx, '⚡ Попытка моментального входа...');
      try {
        const success = await this.discord.joinVoiceChannel(cfg.guild_id, cfg.target_vc_id);
        if (success) {
          await ctx.reply('✅ Команда на вход отправлена успешно');

          const autoLockEnabled = Boolean(this.config.getNested(`gist_auto_lock.${cfg.guild_id}`));
          if (autoLockEnabled) {
            const server = await this.gist.getServerByGuildId(cfg.guild_id);
            if (server && server.voice_channel_id === cfg.target_vc_id) {
              await new Promise((resolve) => setTimeout(resolve, 2500));
              const lockResult = await this.discord.pressLockRoom(server);
              await ctx.reply(lockResult.message);
            }
          }
        } else {
          await ctx.reply('❌ Не удалось зайти. Проверьте логи или настройки канала.');
          console.warn('⚠️ join_now: joinVoiceChannel returned false', { guildId: cfg.guild_id, targetVcId: cfg.target_vc_id });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('❌ join_now caught exception:', msg, error);
        await ctx.reply(`❌ Ошибка входа: ${msg}`);
      }
      await this.sendMainPanel(ctx);
    });
  }

  private async safeAnswerCbQuery(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.answerCbQuery(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('query is too old') || message.includes('query ID is invalid') || message.includes('response timeout expired')) {
        console.warn('⚠️ Callback query expired or invalid, продолжение без ответа.');
        return;
      }
      throw error;
    }
  }

  private setupTextHandler(): void {
    this.bot.on('text', async (ctx) => {
      const userId = ctx.from.id;
      const input = ctx.message.text;
      const waiting = this.waitingForInput.get(userId);
      if (!waiting) {
        return;
      }

      try {
        switch (waiting.type) {
          case 'discord_token':
            const keepWaiting = await this.handleDiscordTokenInput(ctx, input, waiting.accountAction ?? 'connect');
            if (keepWaiting) {
              this.waitingForInput.delete(userId);
            }
            return;
          case 'reconnect_h':
            await this.handleReconnectInput(ctx, input, 'h');
            break;
          case 'reconnect_m':
            await this.handleReconnectInput(ctx, input, 'm');
            break;
          case 'reconnect_s':
            await this.handleReconnectInput(ctx, input, 's');
            break;
          case 'legalizer_range':
            await this.handleLegalizerRangeInput(ctx, input);
            break;
          case 'channel_input':
            await this.handleChannelInput(ctx, input);
            break;
        }
      } catch (error) {
        await ctx.reply(`❌ Ошибка: ${error instanceof Error ? error.message : error}`);
      }
      this.waitingForInput.delete(userId);
    });
  }

  private async handleDiscordTokenInput(ctx: Context, token: string, mode: 'connect' | 'change'): Promise<boolean> {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      await ctx.reply('❌ Введите токен Discord');
      return false;
    }

    await ctx.reply('🔄 Проверяю Discord токен...');
    const valid = await this.discord.validateToken(trimmedToken);
    if (!valid) {
      await ctx.reply('❌ Токен Discord не прошел проверку. Попробуйте еще раз.');
      return false;
    }

    let success = false;
    if (mode === 'change') {
      success = await this.discord.changeToken(trimmedToken);
    } else {
      success = await this.discord.connect(trimmedToken, true);
    }

    if (success) {
      const accountName = this.discord.getCurrentUserTag() || 'Неизвестный аккаунт';
      this.config.update('account_display_name', accountName);
      await ctx.reply(`✅ Токен аккаунта сохранен. Вошел как: ${accountName}`);
      if (this.onDiscordReadyCallback) {
        this.onDiscordReadyCallback();
      }
      await this.sendAccountPanel(ctx);
      return true;
    }

    this.config.update('account_display_name', null);
    await ctx.reply('❌ Не удалось подключить Discord. Попробуйте еще раз.');
    return false;
  }

  private async handleStatusChange(ctx: Context, status: 'online' | 'idle' | 'dnd' | 'invisible'): Promise<void> {
    const cfg = this.config.get();
    cfg.presence_status = status;
    this.config.update('presence_status', status);
    if (this.discord.isInitialized()) {
      await this.discord.applyPresence(status);
    }
    await ctx.answerCbQuery(`Статус установлен: ${status}`);
    await this.sendStatusMenu(ctx);
  }

  private async handleLegalizerRangeInput(ctx: Context, input: string): Promise<void> {
    const text = input.trim();
    const regex = /^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/;
    const match = text.match(regex);
    if (!match) {
      await ctx.reply('❌ Неверный формат. Используйте mm:ss-mm:ss');
      return;
    }

    const minMinutes = Number(match[1]);
    const minSeconds = Number(match[2]);
    const maxMinutes = Number(match[3]);
    const maxSeconds = Number(match[4]);
    const minTotal = minMinutes * 60 + minSeconds;
    const maxTotal = maxMinutes * 60 + maxSeconds;

    if (minTotal <= 0 || maxTotal <= 0 || minTotal >= maxTotal) {
      await ctx.reply('❌ Неверный диапазон. Минимум должен быть меньше максимума и больше 0.');
      return;
    }

    this.config.update('legalizer_enabled', true);
    this.config.update('legalizer_min_delay', minTotal);
    this.config.update('legalizer_max_delay', maxTotal);

    const now = new Date();
    const timeString = now.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    await ctx.reply(`${ctx.from?.username || 'User'}, [${timeString}]\n✅ Легалайзер включен: от ${minMinutes}:${minSeconds.toString().padStart(2, '0')} до ${maxMinutes}:${maxSeconds.toString().padStart(2, '0')}`);
    await this.sendReconnectMenu(ctx);
  }

  private async handleReconnectInput(ctx: Context, input: string, unit: 'h' | 'm' | 's'): Promise<void> {
    const value = Number.parseInt(input, 10);
    const cfg = this.config.get();

    if (Number.isNaN(value)) {
      await ctx.reply('❌ Введите корректное число');
      return;
    }

    if (value === 0) {
      cfg.auto_reconnect_enabled = false;
      this.config.update('auto_reconnect_enabled', false);
      this.state.clearReconnectTimer();
      await ctx.reply('🗑️ Авто-переподключение отключено');
      await this.sendReconnectMenu(ctx);
      return;
    }

    let delaySeconds = 0;
    if (unit === 'h') {
      if (value < 1 || value > 24) {
        await ctx.reply('❌ Часы должны быть от 1 до 24');
        return;
      }
      delaySeconds = value * 3600;
    } else if (unit === 'm') {
      if (value < 1 || value > 59) {
        await ctx.reply('❌ Минуты должны быть от 1 до 59');
        return;
      }
      delaySeconds = value * 60;
    } else if (unit === 's') {
      if (value < 1 || value > 59) {
        await ctx.reply('❌ Секунды должны быть от 1 до 59');
        return;
      }
      delaySeconds = value;
    }

    cfg.auto_reconnect_enabled = true;
    cfg.auto_reconnect_delay = delaySeconds;
    cfg.legalizer_enabled = false;
    this.config.update('auto_reconnect_enabled', true);
    this.config.update('auto_reconnect_delay', delaySeconds);
    this.config.update('legalizer_enabled', false);

    const minutes = Math.floor(delaySeconds / 60);
    const seconds = delaySeconds % 60;
    const displayText = minutes > 0 ? `${minutes} мин${seconds > 0 ? ` ${seconds} сек` : ''}` : `${seconds} сек`;
    const now = new Date();
    const timeString = now.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    await ctx.reply(`${ctx.from?.username || 'User'}, [${timeString}]\n✅ Авто-переподключение установлено на: ${displayText}`);
    await this.sendReconnectMenu(ctx);
  }

  private async sendMainPanel(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const guild = this.discord.getClient().guilds.cache.get(cfg.guild_id);
    const me = guild?.members.me;
    const targetChan = guild?.channels.cache.get(cfg.target_vc_id);

    let voiceStatus = '🔴 Не в войсе';
    if (me?.voice.channel) {
      const chan = me.voice.channel;
      voiceStatus = `🟢 [${chan.name}](https://discord.com/channels/${cfg.guild_id}/${chan.id})`;
    }

    const state = this.state.get();
    const nextTimestamp = state.nextJoinTimestamp;
    const delaySeconds = nextTimestamp !== null ? Math.max(0, Math.round((nextTimestamp - Date.now()) / 1000)) : cfg.auto_reconnect_delay;
    const isScheduled = nextTimestamp !== null;

    let autoRecText = '❌ Выключен';
    if (cfg.auto_reconnect_enabled) {
      if (isScheduled) {
        if (delaySeconds === 0) {
          autoRecText = '⚡ Моментально';
        } else {
          const minutes = Math.floor(delaySeconds / 60);
          const seconds = delaySeconds % 60;
          autoRecText = `✅ Через ${minutes > 0 ? `${minutes} мин ` : ''}${seconds} сек`;
        }
      } else {
        if (cfg.auto_reconnect_delay === 0) {
          autoRecText = '⚡ Моментально';
        } else {
          const minutes = Math.floor(cfg.auto_reconnect_delay / 60);
          const seconds = cfg.auto_reconnect_delay % 60;
          autoRecText = `✅ ${minutes > 0 ? `${minutes} мин ` : ''}${seconds} сек`;
        }
      }
    }

    const accountName = this.escapeHtml(this.discord.getCurrentUserTag() || cfg.account_display_name || 'Не установлен');
    const presenceStatus = cfg.presence_status || 'online';
    const statusIcon = presenceStatus === 'online' ? '🟢' : presenceStatus === 'idle' ? '🌙' : presenceStatus === 'dnd' ? '🔴' : '⚫';

    const text = '<b>📱 Discord-Voice</b>\n\n' +
      '<b>Статус:</b>\n' +
      `• Войс: ${voiceStatus}\n` +
      `• Авто-переподключение: ${autoRecText}\n` +
      `• Канал подключения: ${targetChan ? `📍 ${this.escapeHtml(targetChan.name)}` : '❌ Не указан'}\n` +
      `• Уведомления: ${cfg.notifications.enabled ? '✅ Включены' : '❌ Выключены'}\n` +
      `• Статус аккаунта: ${statusIcon} ${presenceStatus}\n\n` +
      `<b>Аккаунт:</b> ${accountName}`;

    const keyboardRows = [
      [
        Markup.button.callback('👤 Аккаунт', 'account'),
        Markup.button.callback('⚙️ Настройки', 'settings')
      ],
      [
        Markup.button.callback('Установить канал', 'setup_channel'),
        Markup.button.callback('⚡ Зайти сейчас', 'join_now')
      ],
      [
        Markup.button.callback('⏱️ Авто-реконнект', 'reconnect_menu'),
        Markup.button.callback('🔄 Обновить', 'refresh_panel')
      ]
    ];

    if (me?.voice.channel) {
      keyboardRows.push([Markup.button.callback('🚪 ВЫЙТИ', 'force_exit')]);
    }

    await this.editOrReply(ctx, text, Markup.inlineKeyboard(keyboardRows), 'HTML');
  }

  private async sendChannelSetupPrompt(ctx: Context): Promise<void> {
    const fromId = ctx.from?.id;
    await ctx.editMessageText('*Установка целевого канала*\n\n' +
      'Пришлите ID канала или ссылку на него в формате:\n' +
      '`https://discord.com/channels/SERVER_ID/CHANNEL_ID`', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📚 Добавленные сервера', 'server_list')],
          [Markup.button.callback('❌ Отмена', 'refresh_panel')]
        ])
      });
    if (typeof fromId === 'number') {
      this.waitingForInput.set(fromId, { type: 'channel_input' });
    }
  }

  private async sendServerList(ctx: Context): Promise<void> {
    const userId = ctx.from?.id ?? 0;
    const current = this.gistNavigation.get(userId) ?? { page: 0 };
    const servers = await this.gist.getServers();
    const serverEntries = Object.entries(servers);
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(serverEntries.length / pageSize));
    const safePage = Math.min(current.page, totalPages - 1);
    const pageItems = serverEntries.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const lines = pageItems.map(([name]) => `• ${name}`);
    const text = '<b>📚 Добавленные сервера</b>\n\n' + (lines.length > 0 ? lines.join('\n') : '• Нет доступных серверов.');

    const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (pageItems.length > 0) {
      keyboardRows.push(...pageItems.map(([name]) => [Markup.button.callback(name, `gist_server_${name}`)]));
    }
    keyboardRows.push([
      Markup.button.callback('🔙 Назад', 'setup_channel'),
      Markup.button.callback('🏠 Главное меню', 'refresh_panel')
    ]);
    if (totalPages > 1) {
      keyboardRows.splice(1, 0, [
        Markup.button.callback('⬅️ Назад', 'gist_list_prev'),
        Markup.button.callback('➡️ Далее', 'gist_list_next')
      ]);
    }

    this.gistNavigation.set(userId, { ...current, page: safePage });
    await this.editOrReply(ctx, text, Markup.inlineKeyboard(keyboardRows), 'HTML');
  }

  private async sendServerConfirmation(ctx: Context, serverName: string): Promise<void> {
    const serverConfig = await this.gist.getServer(serverName);
    if (!serverConfig) {
      await ctx.answerCbQuery('❌ Сервер не найден');
      return;
    }

    const userId = ctx.from?.id ?? 0;
    this.gistNavigation.set(userId, { page: this.gistNavigation.get(userId)?.page ?? 0, selectedServer: serverName });

    const text = '<b>✅ Подтверждение сервера</b>\n\n' +
      `• Сервер: ${this.escapeHtml(serverName)}\n` +
      `• server_id: ${this.escapeHtml(serverConfig.server_id)}\n` +
      `• voice_channel_id: ${this.escapeHtml(serverConfig.voice_channel_id)}`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Добавить', 'gist_confirm_add')],
      [Markup.button.callback('🔙 Назад', 'gist_confirm_back')],
      [Markup.button.callback('🏠 Главное меню', 'gist_main_menu')]
    ]);

    await this.editOrReply(ctx, text, keyboard, 'HTML');
  }

  private async handleServerValidation(ctx: Context, serverName: string): Promise<void> {
    const serverConfig = await this.gist.getServer(serverName);
    if (!serverConfig) {
      await ctx.answerCbQuery('❌ Сервер не найден');
      return;
    }

    const validation = await this.gist.validateServer(serverName, serverConfig);
    if (!validation.ok) {
      await ctx.answerCbQuery(validation.message);
      await this.sendServerConfirmation(ctx, serverName);
      return;
    }

    this.config.update('guild_id', serverConfig.server_id);
    this.config.update('target_vc_id', serverConfig.voice_channel_id);

    const userId = ctx.from?.id ?? 0;
    this.gistNavigation.delete(userId);

    await ctx.answerCbQuery(validation.message);
    await ctx.reply('✅ Конфиг обновлен: сервер и голосовой канал установлены.');
    await this.sendMainPanel(ctx);
  }

  private async sendNotificationsPanel(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const enableIcon = cfg.notifications.enabled ? '✅' : '❌';
    const joinIcon = cfg.notifications.on_join_leave ? '✅' : '❌';
    const roleIcon = cfg.notifications.on_role_changes ? '✅' : '❌';
    const channelIcon = cfg.notifications.on_channel_changes ? '✅' : '❌';
    const moveIcon = cfg.notifications.on_move ? '✅' : '❌';
    const text = '*🔔 Настройки уведомлений*\n\n' +
      `${joinIcon} Уведомлять о заходе / выходе\n` +
      `${roleIcon} Уведомлять о изменениях ролей\n` +
      `${channelIcon} Уведомлять о изменениях канала\n` +
      `${moveIcon} Уведомлять о перемещении`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${enableIcon} ${cfg.notifications.enabled ? 'Выключить' : 'Включить'}`, 'notify_toggle')],
      [
        Markup.button.callback(`${joinIcon} Заход/Выход`, 'notify_join_leave'),
        Markup.button.callback(`${roleIcon} Роли`, 'notify_role_changes')
      ],
      [
        Markup.button.callback(`${channelIcon} Канал`, 'notify_channel_changes'),
        Markup.button.callback(`${moveIcon} Перемещение`, 'notify_move')
      ],
      [Markup.button.callback('◀️ Назад', 'refresh_panel')]
    ]);

    await this.editOrReply(ctx, text, keyboard);
  }

  private async sendSettingsPanel(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const text = '*⚙️ Настройки*\n\n' +
      `• Микрофон: ${cfg.mute_microphone ? '🔇 Выключен' : '🎤 Включен'}\n` +
      `• Наушники: ${cfg.mute_headphones ? '🔇 Выключены' : '🎧 Включены'}`;

    const server = await this.gist.getServerByGuildId(cfg.guild_id);
    const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = [];
    keyboardRows.push([Markup.button.callback('🎤 Микрофон', 'toggle_microphone'), Markup.button.callback('🎧 Наушники', 'toggle_headphones')]);
    keyboardRows.push([Markup.button.callback('Поставить Статус', 'status_menu')]);
    keyboardRows.push([Markup.button.callback('🛠️ Управление', 'manage')]);
    if (server) {
      keyboardRows.push([Markup.button.callback('🔒 Блокировка комнаты', 'lock_room')]);
    }
    keyboardRows.push([Markup.button.callback('◀️ Назад', 'refresh_panel')]);

    await this.editOrReply(ctx, text, Markup.inlineKeyboard(keyboardRows));
  }

  private async sendManagementPanel(ctx: Context): Promise<void> {
    const text = '*🛠️ Панель управления*\n\n' +
      'Здесь можно перезапустить клиент Discord и обновить конфигурацию Gist.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('♻️ Перезапустить клиент', 'restart_client')],
      [Markup.button.callback('🔄 Обновить Gist', 'refresh_gist')],
      [Markup.button.callback('◀️ Назад', 'manage_back')]
    ]);

    await this.editOrReply(ctx, text, keyboard);
  }

  private async sendStatusMenu(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const currentStatus = cfg.presence_status || 'online';
    const text = `*Статус аккаунта*\n\nТекущий: ${currentStatus}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Онлайн', 'status_online'), Markup.button.callback('Не в сети', 'status_invisible')],
      [Markup.button.callback('Отошел', 'status_idle'), Markup.button.callback('Не беспокоить', 'status_dnd')],
      [Markup.button.callback('◀️ Назад', 'settings')]
    ]);
    await this.editOrReply(ctx, text, keyboard);
  }

  private async editOrReply(ctx: Context, text: string, keyboard: object = {}, parseMode: ParseMode = 'Markdown'): Promise<{ chatId: number; messageId: number } | undefined> {
    const options: { parse_mode: ParseMode } & Record<string, unknown> = {
      parse_mode: parseMode,
      ...(keyboard as Record<string, unknown>)
    };

    try {
      const edited = await ctx.editMessageText(text, options);
      const message = edited as { chat?: { id?: number }; message_id?: number };
      if (message?.chat?.id && typeof message.message_id === 'number') {
        return { chatId: message.chat.id, messageId: message.message_id };
      }
      return undefined;
    } catch {
      try {
        await ctx.deleteMessage();
        const replied = await ctx.reply(text, options);
        const message = replied as { chat?: { id?: number }; message_id?: number };
        if (message?.chat?.id && typeof message.message_id === 'number') {
          return { chatId: message.chat.id, messageId: message.message_id };
        }
        return undefined;
      } catch {
        const replied = await ctx.reply(text, options);
        const message = replied as { chat?: { id?: number }; message_id?: number };
        if (message?.chat?.id && typeof message.message_id === 'number') {
          return { chatId: message.chat.id, messageId: message.message_id };
        }
        return undefined;
      }
    }
  }

  private async handleChannelInput(ctx: Context, input: string): Promise<void> {
    let channelId = input.trim();
    let guildId = this.config.get().guild_id;

    if (input.includes('discord.com/channels/')) {
      const parts = input.split('/');
      channelId = parts[parts.length - 1];
      guildId = parts[parts.length - 2];
    }

    if (!/^\d+$/.test(channelId)) {
      await ctx.reply('❌ Неверный формат ID канала');
      return;
    }

    this.config.update('guild_id', guildId);
    this.config.update('target_vc_id', channelId);
    await ctx.reply(`✅ Настройки обновлены!\nСервер: \`${guildId}\`\nКанал: \`${channelId}\``);
    await this.sendMainPanel(ctx);
  }

  private async sendReconnectMenu(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const isEnabled = cfg.auto_reconnect_enabled;
    const delay = cfg.auto_reconnect_delay;
    let delayText = '❌ Отключено';
    if (isEnabled) {
      if (cfg.legalizer_enabled) {
        delayText = `Легалайзер: от ${Math.floor(cfg.legalizer_min_delay / 60)}:${(cfg.legalizer_min_delay % 60).toString().padStart(2, '0')} до ${Math.floor(cfg.legalizer_max_delay / 60)}:${(cfg.legalizer_max_delay % 60).toString().padStart(2, '0')}`;
      } else if (delay === 0) {
        delayText = '⚡ Моментально';
      } else {
        const minutes = Math.floor(delay / 60);
        const seconds = delay % 60;
        delayText = minutes > 0 ? `⏱️ ${minutes} мин${seconds > 0 ? ` ${seconds} сек` : ''}` : `⏱️ ${seconds} сек`;
      }
    }

    const text = '*⏱️ Авто-переподключение*\n\n' +
      `Текущая настройка: ${delayText}\n\n` +
      'Рекомендуется: 2-3 минуты';
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⏱️ Фиксированное время', 'reconnect_fixed'),
        Markup.button.callback('🎲 Легалайзер', 'reconnect_legalizer')
      ],
      [
        Markup.button.callback('🗑️ Очистить', 'reconnect_clear'),
        Markup.button.callback('◀️ Назад', 'refresh_panel')
      ]
    ]);

    await this.editOrReply(ctx, text, keyboard);
  }

  private async sendAccountPanel(ctx: Context): Promise<void> {
    const cfg = this.config.get();
    const text = this.buildAccountText(cfg);
    const keyboard = this.buildAccountKeyboard(cfg);

    const result = await this.editOrReply(ctx, text, keyboard, 'HTML');
    if (result && ctx.chat?.id) {
      this.trackedAccountMessages.set(ctx.chat.id, result);
    }
  }

  private async sendAccountRemoveConfirmation(ctx: Context): Promise<void> {
    const text = '*🗑 Удаление токена*\n\n' +
      'Вы уверены, что хотите удалить токен Discord?';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'account_remove_confirm'), Markup.button.callback('❌ Cancel', 'account_remove_cancel')]
    ]);
    await this.editOrReply(ctx, text, keyboard);
  }

  private async promptForToken(ctx: Context, mode: 'connect' | 'change'): Promise<void> {
    const actionText = mode === 'change' ? 'Изменить токен Discord' : 'Подключить Discord';
    await ctx.editMessageText(`*🔐 ${actionText}*\n\nВведите токен аккаунта Discord:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'account')]])
    });
    this.waitingForInput.set(ctx.from?.id ?? 0, { type: 'discord_token', accountAction: mode });
  }

  private async refreshTrackedAccountMessages(): Promise<void> {
    for (const [chatId, messageRef] of this.trackedAccountMessages.entries()) {
      try {
        const cfg = this.config.get();
        const text = this.buildAccountText(cfg);
        const keyboard = this.buildAccountKeyboard(cfg);
        await this.bot.telegram.editMessageText(chatId, messageRef.messageId, undefined, text, {
          parse_mode: 'HTML' as ParseMode,
          reply_markup: keyboard.reply_markup
        });
      } catch {
        this.trackedAccountMessages.delete(chatId);
      }
    }
  }

  private buildAccountText(cfg: ReturnType<ConfigManager['get']>): string {
    const client = this.discord.getClient();
    const user = client.user;
    const guild = client.guilds.cache.get(cfg.guild_id);
    const voiceChannel = guild?.members?.me?.voice?.channel;
    const connected = this.discord.isConnected();
    const hasToken = Boolean(cfg.discord_token);
    const statusLabel = connected ? '✅ Подключен' : '❌ Отключен';

    const avatarText = user?.avatarURL ? `<a href="${user.avatarURL()}">🖼️ Аватар</a>` : '🖼️ Placeholder avatar';
    const usernameText = this.escapeHtml(user?.username || cfg.account_display_name || 'Неизвестно');
    const displayNameText = this.escapeHtml(user?.displayName || user?.tag || '—');
    const userIdText = user?.id || '—';
    const createdAt = user?.createdTimestamp ? new Date(user.createdTimestamp).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }) : '—';
    const presenceText = connected ? (cfg.presence_status || 'online') : 'Не подключен';

    let voiceText = '• Голос: Не подключен к голосовому каналу.';
    let voiceMembersText = '• Участники: Нет данных.';
    if (voiceChannel) {
      const memberCount = voiceChannel.members?.size ?? 0;
      const limitText = voiceChannel.userLimit && voiceChannel.userLimit > 0 ? `${memberCount} / ${voiceChannel.userLimit}` : 'Unlimited';
      voiceText = `• Голос: ${this.escapeHtml(guild?.name || 'Сервер')}\n` +
        `• Канал: ${this.escapeHtml(voiceChannel.name)}\n` +
        `• ID канала: ${voiceChannel.id}\n` +
        `• Участники: ${limitText}`;

      const voiceMembers = this.getVoiceMemberList(voiceChannel);
      voiceMembersText = voiceMembers.length > 0
        ? `• Участники в канале:\n${voiceMembers.map((member) => `  - ${this.escapeHtml(member.line)}`).join('\n')}`
        : '• Участники в канале: Нет.';
    }

    const tokenManagement = hasToken
      ? '• Токен: сохранен\n' +
        '• Управление: 🔄 Change Token / 🗑 Remove Token'
      : '• Токен: отсутствует\n' +
        '• Состояние: No Discord account connected.';

    return '<b>👤 Аккаунт Discord</b>\n\n' +
      `• Аватар: ${avatarText}\n` +
      `• Username: ${usernameText}\n` +
      `• Display Name: ${displayNameText}\n` +
      `• User ID: ${userIdText}\n` +
      `• Дата регистрации: ${createdAt}\n` +
      `• Статус: ${presenceText}\n` +
      `• Клиент Discord: ${statusLabel}\n\n` +
      '<b>🎙️ Голосовая информация</b>\n' +
      `${voiceText}\n\n` +
      '<b>👥 Участники в голосе</b>\n' +
      `${voiceMembersText}\n\n` +
      '<b>🔐 Токен</b>\n' +
      `${tokenManagement}`;
  }

  private buildAccountKeyboard(cfg: ReturnType<ConfigManager['get']>): ReturnType<typeof Markup.inlineKeyboard> {
    const hasToken = Boolean(cfg.discord_token);
    return Markup.inlineKeyboard([
      hasToken
        ? [Markup.button.callback('🔄 Change Token', 'account_change'), Markup.button.callback('🗑 Remove Token', 'account_remove')]
        : [Markup.button.callback('➕ Connect Discord Account', 'account_connect')],
      [Markup.button.callback('🔔 Уведомления', 'notifications'), Markup.button.callback('◀️ Назад', 'refresh_panel')]
    ]);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private getVoiceMemberList(voiceChannel: VoiceChannelLike | undefined): VoiceMemberEntry[] {
    const members = voiceChannel?.members?.map?.((member) => {
      const staffInfo = this.getStaffInfo(member);
      return {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        isMuted: member.voice?.mute ?? false,
        isDeaf: member.voice?.deaf ?? false,
        isStaff: staffInfo.isStaff,
        staffReason: staffInfo.reason
      };
    }) ?? [];

    return members.map((member) => {
      const micIndicator = member.isMuted ? '🔇' : '🎤';
      const headphoneIndicator = member.isDeaf ? '🚫' : '🎧';
      const line = `${member.displayName || member.username} ${micIndicator}${headphoneIndicator}${member.isStaff ? ` 👑 (${member.staffReason})` : ''}`;
      return {
        ...member,
        line
      };
    }).filter((member) => !member.username.startsWith('!'));
  }

  private getStaffInfo(member: VoiceMemberLike): { isStaff: boolean; reason: string } {
    const role = member.roles.cache.find((role) => role.name.toLowerCase().includes('staff'));
    if (role) {
      return { isStaff: true, reason: 'Staff role' };
    }
    if (member.permissions.has('ADMINISTRATOR')) {
      return { isStaff: true, reason: 'Administrator' };
    }
    if (member.permissions.has('MODERATE_MEMBERS')) {
      return { isStaff: true, reason: 'Moderate Members' };
    }
    if (member.permissions.has('MANAGE_GUILD')) {
      return { isStaff: true, reason: 'Manage Guild' };
    }
    return { isStaff: false, reason: '' };
  }

  public notifyPersonJoined(name: string, username: string): unknown {
    const cfg = this.config.get();
    return Markup.inlineKeyboard([[Markup.button.callback('🚪 ВЫЙТИ', 'force_exit')]]);
  }

  private async sendLockRoomPanel(ctx: Context, serverConfig: GistServerConfig): Promise<void> {
    const key = `gist_auto_lock.${serverConfig.server_id}`;
    const enabled = Boolean(this.config.getNested(key));

    const text = '*🔒 Блокировка комнаты*\n\n' +
      'Бот будет автоматически блокировать комнату, чтобы предотвратить вход посторонних пользователей.\n' +
      'Эта функция работает только для каналов из раздела "Добавленные сервера".';

    const toggleLabel = enabled ? 'Выключить' : 'Включить';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${enabled ? '🔓' : '🔒'} ${toggleLabel}`, 'lock_room_toggle')],
      [Markup.button.callback('◀️ Назад', 'lock_room_back')]
    ]);

    await this.editOrReply(ctx, text, keyboard, 'Markdown');
  }
}
