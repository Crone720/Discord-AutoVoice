import { ConfigManager } from '../managers/ConfigManager';
import { StateManager } from '../managers/StateManager';
import { PresenceStatus } from '../types/config';
import { DiscordClientLike, VoiceConnectionLike, VoiceStateLike } from '../types/discord';
import { GistServerConfig } from './GistService';
import { NotificationService } from './NotificationService';

interface DiscordLifecycleOptions {
  clearToken?: boolean;
  leaveVoice?: boolean;
  resetRuntime?: boolean;
}

export class DiscordService {
  private readonly config: ConfigManager;
  private readonly state: StateManager;
  private readonly notifications: NotificationService;
  private readonly stateChangeListeners = new Set<() => void>();
  private client!: DiscordClientLike;
  private initialized = false;
  private activeToken: string | null = null;
  private eventRegistrationCallback?: () => void;
  private registeredReadyListener?: (...args: any[]) => void;
  private registeredVoiceStateListener?: (...args: any[]) => void;

  constructor(config: ConfigManager, state: StateManager, notifications: NotificationService) {
    this.config = config;
    this.state = state;
    this.notifications = notifications;
    this.createClient();
  }

  private createClient(): void {
    const DiscordClientCtor = require('discord.js-selfbot-v13').Client as new (options: { checkUpdate: boolean }) => DiscordClientLike;
    this.client = new DiscordClientCtor({ checkUpdate: false });
    this.attachInternalEvents();
  }

  private createClientInstance(): DiscordClientLike {
    const DiscordClientCtor = require('discord.js-selfbot-v13').Client as new (options: { checkUpdate: boolean }) => DiscordClientLike;
    return new DiscordClientCtor({ checkUpdate: false });
  }

  private attachInternalEvents(): void {
    this.client.on('ready', () => {
      this.initialized = true;
      this.emitStateChange();
    });
    this.client.on('disconnect', () => {
      this.initialized = false;
      this.emitStateChange();
    });
    this.client.on('reconnecting', () => {
      this.emitStateChange();
    });
    this.client.on('voiceStateUpdate', () => {
      this.emitStateChange();
    });
    this.client.on('presenceUpdate', () => {
      this.emitStateChange();
    });
    this.client.on('guildMemberUpdate', () => {
      this.emitStateChange();
    });
    this.client.on('guildMemberAdd', () => {
      this.emitStateChange();
    });
    this.client.on('guildMemberRemove', () => {
      this.emitStateChange();
    });
    this.client.on('error', () => {
      this.emitStateChange();
    });
  }

  private async destroyClient(): Promise<void> {
    try {
      if (this.client?.destroy) {
        await this.client.destroy();
      }
    } catch {
    }
    this.client?.removeAllListeners?.();
    this.initialized = false;
    this.emitStateChange();
  }

  public setClientEventRegistrationCallback(callback: () => void): void {
    this.eventRegistrationCallback = callback;
  }

  public subscribe(listener: () => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  private emitStateChange(): void {
    this.stateChangeListeners.forEach((listener) => listener());
  }

  public getClient(): DiscordClientLike {
    return this.client;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public isConnected(): boolean {
    return this.initialized && Boolean(this.client?.ws?.connected);
  }

  public async connect(token?: string, force = false): Promise<boolean> {
    const targetToken = token ?? this.config.get().discord_token;
    if (!targetToken) {
      console.log('⚠️ Discord токен не установлен');
      return false;
    }

    if (this.initialized && !force && this.activeToken === targetToken) {
      return true;
    }

    await this.disconnect({ leaveVoice: false, resetRuntime: false, clearToken: false });
    this.createClient();
    this.activeToken = null;

    try {
      await this.client.login(targetToken);
      this.activeToken = targetToken;
      this.initialized = true;
      console.log('✅ Discord клиент подготовлен');
      this.config.update('discord_token', targetToken);
      this.state.setInitialized(true);
      this.state.setStopped(false);
      this.state.setBotJoining(false);
      await this.applyPresence(this.config.get().presence_status);

      const currentTag = this.getCurrentUserTag();
      if (currentTag) {
        this.config.update('account_display_name', currentTag);
      }

      this.eventRegistrationCallback?.();
      this.emitStateChange();
      return true;
    } catch (error) {
      console.error('❌ Ошибка при логине в Discord:', error instanceof Error ? error.message : error);
      await this.destroyClient();
      this.activeToken = null;
      return false;
    }
  }

  public async initialize(force = false, token?: string): Promise<boolean> {
    return this.connect(token ?? this.config.get().discord_token, force);
  }

  public async validateToken(token: string): Promise<boolean> {
    if (!token) {
      return false;
    }

    const tempClient = this.createClientInstance();
    try {
      await tempClient.login(token);
      return true;
    } catch (error) {
      console.warn('⚠️ Discord token validation failed:', error instanceof Error ? error.message : error);
      return false;
    } finally {
      tempClient.removeAllListeners?.();
      await tempClient.destroy?.();
    }
  }

  public async changeToken(token: string): Promise<boolean> {
    if (!token) {
      return false;
    }

    await this.disconnect({ leaveVoice: true, resetRuntime: false, clearToken: false });
    return this.connect(token, true);
  }

  public async removeToken(): Promise<boolean> {
    await this.disconnect({ leaveVoice: true, resetRuntime: false, clearToken: true });
    return true;
  }

  public async restart(): Promise<boolean> {
    const token = this.config.get().discord_token;
    if (!token) {
      return false;
    }

    await this.disconnect({ leaveVoice: false, resetRuntime: false, clearToken: false });
    return this.connect(token, true);
  }

  public async disconnect(options: DiscordLifecycleOptions = {}): Promise<void> {
    const cfg = this.config.get();
    this.state.setInitialized(false);
    this.state.setStopped(true);
    this.state.setBotJoining(false);
    this.state.clearReconnectTimer();

    if (options.leaveVoice !== false) {
      await this.leaveVoiceChannel(cfg.guild_id);
    }

    await this.destroyClient();
    this.activeToken = null;

    if (options.clearToken) {
      this.config.update('discord_token', '');
    }

    this.emitStateChange();
  }

  public getCurrentUserTag(): string | null {
    return this.client?.user?.tag ?? null;
  }

  public async applyPresence(status: PresenceStatus): Promise<void> {
    try {
      if (!this.initialized || !this.client?.user?.setPresence) {
        return;
      }
      await this.client.user.setPresence({ status });
      console.log(`✅ Статус Discord установлен: ${status}`);
    } catch (error) {
      console.warn('⚠️ Не удалось установить статус Discord:', error instanceof Error ? error.message : error);
    }
  }

  public async joinVoiceChannel(guildId: string, channelId: string): Promise<boolean> {
    if (this.state.get().isBotJoining) {
      return false;
    }

    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        console.error('❌ Гильдия не найдена', { guildId, channelId });
        return false;
      }

      const channel = guild.channels.cache.get(channelId);
      let fetchedChannel: any = channel;

      if (!fetchedChannel && (guild.channels as any)?.fetch) {
        try {
          fetchedChannel = await (guild.channels as any).fetch(channelId, { force: true });
          console.log('ℹ️ joinVoiceChannel: fetched channel from guild cache', { channelId });
        } catch (err) {
          console.warn('⚠️ joinVoiceChannel: guild channel fetch failed', { channelId, error: err instanceof Error ? err.message : err });
        }
      }

      if (!fetchedChannel && (this.client.channels as any)?.fetch) {
        try {
          fetchedChannel = await (this.client.channels as any).fetch(channelId, { force: true });
          console.log('ℹ️ joinVoiceChannel: fetched channel from client channels', { channelId });
        } catch (err) {
          console.warn('⚠️ joinVoiceChannel: client channel fetch failed', { channelId, error: err instanceof Error ? err.message : err });
        }
      }

      const isVoice = fetchedChannel && (fetchedChannel.type === 'GUILD_VOICE' || fetchedChannel.type === 'GUILD_STAGE' || fetchedChannel.type === 'voice');
      if (!fetchedChannel || !isVoice) {
        console.error('❌ Канал не найден или это не войс', {
          channelId,
          channelType: fetchedChannel?.type,
          channelExists: !!fetchedChannel,
          cachedChannel: !!channel
        });
        return false;
      }

      this.state.setBotJoining(true);
      await this.client.voice.joinChannel(fetchedChannel, {
        selfMute: false,
        selfDeaf: false,
        selfVideo: false,
        checkConfirm: true
      });

      console.log(`✅ Успешное подключение к ${fetchedChannel.name}`);
      this.state.setBotJoining(false);
      this.state.setNextJoinTimestamp(null);
      this.emitStateChange();
      return true;
    } catch (error) {
      this.state.setBotJoining(false);
      const message = error instanceof Error
        ? error.message
        : error && typeof error === 'object'
          ? (Object.getOwnPropertyNames(error).length > 0 ? JSON.stringify(error, Object.getOwnPropertyNames(error), 2) : JSON.stringify(error))
          : String(error);
      if (!message || message === '{}' || message === '[object Object]') {
        console.error('❌ joinVoiceChannel caught raw error object', error);
      }
      if (message.includes('Connection not established within 15 seconds') || message.includes('15 seconds')) {
        console.log('⚠️ Предупреждение: Таймаут соединения, проверка статуса...');
        await this.sleep(2000);
        const checkGuild = this.client.guilds.cache.get(guildId);
        if (checkGuild?.members?.me?.voice?.channelId === channelId) {
          console.log('✅ Бот всё же зашел в канал (таймаут был ложным)');
          return true;
        }

        console.log('✅ Ошибка соединения была проигнорирована, считаем подключение успешным.');
        return true;
      }
      console.error('❌ Ошибка присоединения:', message);
      return false;
    }
  }

  public async leaveVoiceChannel(guildId: string): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        return;
      }

      const me = guild.members.me;
      if (!me?.voice.channelId) {
        console.log('✅ Бот и так не в голосовом канале');
        return;
      }
      try {
        const connection = this.client.voice.connection;
        
        if (connection?.disconnect) {
          await connection.disconnect();
        } 
        else if (me.voice.disconnect) {
          await me.voice.disconnect();
        } 
        else if (me.id && guild.members.edit) {
          await guild.members.edit(me.id, { channel: null });
        } 
        else {
          console.warn('⚠️ Нет доступного метода для выхода из голосового канала.');
          return;
        }
      } catch (innerError) {
        const innerMessage = innerError instanceof Error ? innerError.message : String(innerError);
        if (innerMessage.includes('Missing Permissions')) {
          console.warn('⚠️ Не удалось выйти из канала из-за недостатка прав, состояние синхронизировано.');
          return;
        }
        throw innerError;
      }

      console.log('✅ Голосовое соединение разорвано');
      this.emitStateChange();
    } catch (error) {
      this.state.setBotJoining(false);
      console.error('❌ Ошибка выхода из канала:', error instanceof Error ? error.message : error);
    }
  }

  public getCurrentVoiceChannel(guildId: string): string | null {
    const guild = this.client.guilds.cache.get(guildId);
    return guild?.members?.me?.voice?.channelId ?? null;
  }

  public hasRole(guildId: string, roleId: string): boolean {
    const guild = this.client.guilds.cache.get(guildId);
    return guild?.members?.me?.roles.cache.has(roleId) ?? false;
  }

  public isGuildMember(guildId: string): boolean {
    const guild = this.client.guilds.cache.get(guildId);
    return Boolean(guild?.members?.me);
  }

  public validateVoiceChannelAccess(guildId: string, channelId: string): { ok: boolean; message: string } {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      return { ok: false, message: '❌ Сервер не найден.' };
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return { ok: false, message: '❌ Канал не найден.' };
    }

    const canView = channel.viewable !== false;
    const canConnect = Boolean(guild.members.me?.permissions.has('CONNECT'));

    if (!canView) {
      return { ok: false, message: '❌ У вас нет доступа к просмотру этого канала.' };
    }

    if (!canConnect) {
      return { ok: false, message: '❌ У вас нет прав на подключение к этому каналу.' };
    }

    return { ok: true, message: '✅ Доступ к голосовому каналу подтвержден.' };
  }

  public async pressLockRoom(serverConfig: GistServerConfig): Promise<{ ok: boolean; message: string }> {
    if (!this.initialized) {
      return { ok: false, message: '❌ Discord клиент не подключен.' };
    }

    try {
      let channel: any = undefined;
      try {
        channel = (this.client.channels as any)?.cache?.get?.(serverConfig.channel_id);
      } catch {
        channel = undefined;
      }

      if (!channel && (this.client.channels as any)?.fetch) {
        try {
          channel = await (this.client.channels as any).fetch(serverConfig.channel_id, { force: true });
        } catch (err) {
        }
      }

      if (!channel || !channel.messages || !channel.messages.fetch) {
        return { ok: false, message: '❌ Не удалось получить сообщение сервера для блокировки.' };
      }

      let message: any;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          message = await channel.messages.fetch(serverConfig.message_id as any, { force: true });
          break;
        } catch (err) {
          if (attempt === 3) {
            return { ok: false, message: '❌ Не удалось получить сообщение (fetch failed).' };
          }
          await this.sleep(1000);
        }
      }

      const components: any[] = (message as any).components ?? [];
      const foundIds: string[] = [];
      let targetCustomId: string | undefined;

      for (const row of components) {
        const rowComps = row?.components ?? [];
        for (const comp of rowComps) {
          const cid = comp?.custom_id ?? comp?.customId ?? comp?.data?.custom_id ?? comp?.data?.customId;
          if (typeof cid === 'string') {
            foundIds.push(cid);
            if (!targetCustomId && (cid === serverConfig.button_lock_channel || cid.includes(String(serverConfig.button_lock_channel)))) {
              targetCustomId = cid;
            }
          }
        }
      }

      if (!targetCustomId && foundIds.length > 0) {
        targetCustomId = foundIds[0];
      }

      if (!targetCustomId) {
        return { ok: false, message: `❌ Кнопка не найдена. Доступные custom_id: ${foundIds.join(', ') || 'нет'}` };
      }

      const sessionId = (this.client as any).sessionId ?? (this.client as any).ws?.sessionId ?? null;
      if (!sessionId) {
        console.warn('⚠️ Предупреждение: client.sessionId отсутствует — попытка нажать кнопку может не сработать.');
      }

      const attempts = 3;
      for (let i = 0; i < attempts; i++) {
        try {
          if (typeof (message as any).clickButton === 'function') {
            await (message as any).clickButton(targetCustomId);
            return { ok: true, message: '✅ Команда блокировки комнаты отправлена.' };
          }
          break;
        } catch (err) {
          const em = err instanceof Error ? err.message : String(err);
          console.warn(`⚠️ Попытка ${i + 1} нажатия кнопки не удалась: ${em}`);
          await this.sleep(500);
        }
      }

      return { ok: false, message: '❌ Кнопка обнаружена, но не удалось выполнить нажатие (см логи).' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('❌ Ошибка при нажатии кнопки блокировки комнаты:', msg);
      return { ok: false, message: `❌ Ошибка при блокировке комнаты: ${msg}` };
    }
  }

  public async kickFromVoice(guildId: string, memberId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return { ok: false, message: '❌ Гильдия не найдена' };

      if (guild.members.edit) {
        await guild.members.edit(memberId, { channel: null });
        return { ok: true, message: '✅ Пользователь удалён из голосового канала' };
      }

      const anyMembers = (guild as any).members;
      const member = anyMembers?.cache?.get ? anyMembers.cache.get(memberId) : undefined;
      if (member && member.voice && typeof member.voice.disconnect === 'function') {
        await member.voice.disconnect();
        return { ok: true, message: '✅ Пользователь отключён от голосового канала' };
      }

      return { ok: false, message: '⚠️ Нет подходящего метода для удаления из канала' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('❌ Ошибка при удалении пользователя из канала:', msg);
      return { ok: false, message: `❌ Ошибка: ${msg}` };
    }
  }

  private unregisterEventHandlers(): void {
    if (this.registeredReadyListener) {
      if (typeof this.client.off === 'function') {
        this.client.off('ready', this.registeredReadyListener);
      } else if (typeof this.client.removeListener === 'function') {
        this.client.removeListener('ready', this.registeredReadyListener);
      }
      this.registeredReadyListener = undefined;
    }
    if (this.registeredVoiceStateListener) {
      if (typeof this.client.off === 'function') {
        this.client.off('voiceStateUpdate', this.registeredVoiceStateListener);
      } else if (typeof this.client.removeListener === 'function') {
        this.client.removeListener('voiceStateUpdate', this.registeredVoiceStateListener);
      }
      this.registeredVoiceStateListener = undefined;
    }
  }

  public registerEventHandlers(callbacks: {
    onReady?: () => void;
    onVoiceStateUpdate?: (oldState: VoiceStateLike, newState: VoiceStateLike) => void;
  }): void {
    this.unregisterEventHandlers();

    if (callbacks.onReady) {
      this.registeredReadyListener = () => callbacks.onReady?.();
      this.client.once('ready', this.registeredReadyListener);
    }
    if (callbacks.onVoiceStateUpdate) {
      this.registeredVoiceStateListener = (oldState: any, newState: any) => {
        callbacks.onVoiceStateUpdate?.(oldState as VoiceStateLike, newState as VoiceStateLike);
      };
      this.client.on('voiceStateUpdate', this.registeredVoiceStateListener);
    }
  }

  public async setMute(mute: boolean): Promise<void> {
    try {
      if (!this.initialized || !this.client?.voice?.connection) {
        return;
      }
      const connection = this.client.voice.connection;
      if (connection) {
        await connection.setMute(mute);
        console.log(`✅ Микрофон ${mute ? 'выключен' : 'включен'}`);
        this.emitStateChange();
      }
    } catch (error) {
      console.warn('⚠️ Не удалось изменить состояние микрофона:', error instanceof Error ? error.message : error);
    }
  }

  public async setDeaf(deaf: boolean): Promise<void> {
    try {
      if (!this.initialized || !this.client?.voice?.connection) {
        return;
      }
      const connection = this.client.voice.connection;
      if (connection) {
        await connection.setDeaf(deaf);
        console.log(`✅ Наушники ${deaf ? 'выключены' : 'включены'}`);
        this.emitStateChange();
      }
    } catch (error) {
      console.warn('⚠️ Не удалось изменить состояние наушников:', error instanceof Error ? error.message : error);
    }
  }


  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
