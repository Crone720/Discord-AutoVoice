import { Markup } from 'telegraf';

import { ConfigManager } from '../managers/ConfigManager';
import { StateManager } from '../managers/StateManager';
import { DiscordService } from '../services/DiscordService';
import { GistService } from '../services/GistService';
import { NotificationService } from '../services/NotificationService';
import { VoiceStateLike } from '../types/discord';

export class DiscordEventHandler {
  private readonly discord: DiscordService;
  private readonly notifications: NotificationService;
  private readonly config: ConfigManager;
  private readonly state: StateManager;
  private readonly gist: GistService;

  constructor(discord: DiscordService, notifications: NotificationService, config: ConfigManager, state: StateManager, gist: GistService) {
    this.discord = discord;
    this.notifications = notifications;
    this.config = config;
    this.state = state;
    this.gist = gist;
  }

  public registerHandlers(): void {
    this.discord.registerEventHandlers({
      onReady: () => this.handleReady(),
      onVoiceStateUpdate: (oldState, newState) => this.handleVoiceStateUpdate(oldState, newState)
    });
  }

  private handleReady(): void {
    console.log('✅ Discord клиент готов');
    this.startPeriodicCheck();
    this.checkAndJoin();
  }

  private startPeriodicCheck(): void {
    this.state.clearPeriodicCheckTimer();
    this.state.setPeriodicCheckTimer(setInterval(() => {
      const cfg = this.config.get();
      if (cfg.auto_reconnect_enabled && !this.state.get().isBotJoining) {
        this.checkAndJoin();
      }
    }, 30000));
  }

  private async handleVoiceStateUpdate(oldState: VoiceStateLike, newState: VoiceStateLike): Promise<void> {
    const cfg = this.config.get();
    const st = this.state.get();
    if (st.isStopped || newState.guild.id !== cfg.guild_id) {
      return;
    }

    const myId = this.discord.getClient().user?.id;
    const isMyStateChange = newState.id === myId;
    if (isMyStateChange) {
      await this.handleMyVoiceStateChange(oldState, newState);
    } else {
      await this.handleOtherVoiceStateChange(oldState, newState);
    }
  }

  private async handleMyVoiceStateChange(oldState: VoiceStateLike, newState: VoiceStateLike): Promise<void> {
    const cfg = this.config.get();
    const oldChan = oldState.channel;
    const newChan = newState.channel;

    if (oldChan && !newChan) {
      await this.notifications.notifyJoinLeave(`门 *Вышел из голосового канала* ${oldChan.name}`);
      if (cfg.auto_reconnect_enabled) {
        let delay = cfg.auto_reconnect_delay;
        if (cfg.legalizer_enabled) {
          const minDelay = Math.max(0, cfg.legalizer_min_delay);
          const maxDelay = Math.max(minDelay, cfg.legalizer_max_delay);
          delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
        }
        this.state.clearReconnectTimer();
        if (delay === 0) {
          setTimeout(() => this.checkAndJoin(), 100);
        } else {
          this.state.setNextJoinTimestamp(Date.now() + delay * 1000);
          this.state.setReconnectTimer(setTimeout(() => this.checkAndJoin(), delay * 1000));
        }
      }
    } else if (oldChan && newChan && oldChan.id !== newChan.id) {
      const enabled = Boolean(this.config.getNested(`gist_auto_lock.${cfg.guild_id}`));
      const server = enabled ? await this.gist.getServerByGuildId(cfg.guild_id) : undefined;
      const shouldLockOnMove = Boolean(server && newChan.id === server.voice_channel_id);

      if (oldChan.parentId === newChan.parentId) {
        console.log(`📡 Перемещение внутри категории ${oldChan.parentId || 'без категории'} игнорировано.`);
        this.state.clearReconnectTimer();
        if (shouldLockOnMove) {
          await this.waitForVoiceJoin(cfg.guild_id, newChan.id, 15000, 500);
          await this.sleep(2500);
          const pressResult = await this.discord.pressLockRoom(server!);
          if (!pressResult.ok) {
            console.warn('⚠️ Автозамок после перемещения внутри категории не удался:', pressResult.message);
          }
        }
        return;
      }

      await this.notifications.notifyMove(`🔔 *Вас перекинули в другую категорию!*\n` +
        `Новый канал: ${newChan.name}\n` +
        `Категория: ${newChan.parent?.name || 'Нет'}`, Markup.inlineKeyboard([[Markup.button.callback('🏃 ЭКСТРЕННЫЙ ВЫХОД', 'force_exit')]]));

      if (!newChan.viewable) {
        await this.sleep(12000);
        if (newState.guild.members.me?.voice.channelId === newChan.id) {
          await this.discord.leaveVoiceChannel(cfg.guild_id);
        }
      }
    } else if (!oldChan && newChan) {
      try {
        const cfg = this.config.get();
        const enabled = Boolean(this.config.getNested(`gist_auto_lock.${cfg.guild_id}`));
        if (enabled) {
          const server = await this.gist.getServerByGuildId(cfg.guild_id);
          if (server) {
            if (newChan.id !== server.voice_channel_id) {
              console.log(`ℹ️ Присоединение к каналу ${newChan.id}, автозамок пропущен (ожидается ${server.voice_channel_id}).`);
              return;
            }
            await this.waitForVoiceJoin(cfg.guild_id, newChan.id, 15000, 500);
            await this.sleep(5000);

            let pressResult = await this.discord.pressLockRoom(server);
            if (!pressResult.ok) {
              console.warn('⚠️ Первое нажатие кнопки блокировки не удалось:', pressResult.message);
              await this.sleep(3000);
              pressResult = await this.discord.pressLockRoom(server);
              if (!pressResult.ok) {
                console.warn('⚠️ Второе нажатие кнопки блокировки также не удалось:', pressResult.message);
              }
            }
          }
        }
      } catch (error) {
        console.warn('⚠️ Ошибка при попытке автоблокировки после входа:', error instanceof Error ? error.message : error);
      }
    }
  }

  private getUserStatus(member: { permissions: { has: (permission: string) => boolean }; roles: { cache: { some: (predicate: (role: { name: string }) => boolean) => boolean; find: (predicate: (role: { name: string }) => boolean) => { name: string } | undefined } }; } | undefined): string {
    if (!member) {
      return 'Пользователь';
    }

    const priorityRoles = ['Owner', 'Админ', 'Administrator', 'Admin', 'Мастер', 'Master', 'Куратор', 'Curator'];

    if (member.permissions.has('ADMINISTRATOR')) {
      return '👑 Администратор (права)';
    }

    const hasStaffRole = member.roles.cache.some((role) => role.name.toLowerCase().includes('staff'));
    if (hasStaffRole) {
      const subRole = member.roles.cache.find((role) => priorityRoles.some((priorityRole) => role.name.toLowerCase().includes(priorityRole.toLowerCase())));
      return subRole ? `🛡️ Staff (${subRole.name})` : '🛡️ Staff';
    }

    const foundRole = member.roles.cache.find((role) => priorityRoles.some((priorityRole) => role.name.toLowerCase().includes(priorityRole.toLowerCase())));
    return foundRole ? `⭐ ${foundRole.name}` : '👤 Пользователь';
  }

  private async handleOtherVoiceStateChange(oldState: VoiceStateLike, newState: VoiceStateLike): Promise<void> {
    const cfg = this.config.get();
    const myChannelId = newState.guild.members.me?.voice.channelId;

    if (myChannelId && newState.channelId === myChannelId && oldState.channelId !== newState.channelId) {
      const member = newState.member;
      if (member && !member.user.bot) {
        const status = this.getUserStatus(member);
        const text = `👤 *В войс зашел:*
• Статус: *${status}*
• Имя: ${member.displayName}
• Юзер: @${member.user.username}
• ID: \`${member.id}\``;
        await this.notifications.notifyChannelChanges(text, Markup.inlineKeyboard([[Markup.button.callback('🚪 ВЫЙТИ', 'force_exit')]]));

        try {
          const parentName = (newState.channel?.parent?.name || '').toLowerCase();
          if (!parentName.includes('приватные')) {
            const kickResult = await this.discord.kickFromVoice(newState.guild.id, member.id);
            await this.notifications.notifyChannelChanges(`⚠️ Пользователь ${member.displayName} был удалён из канала (категория: ${parentName || '—'})\n${kickResult.message}`);
          }
        } catch (err) {
          console.warn('⚠️ Ошибка проверки категории/выдворения пользователя:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (myChannelId && oldState.channelId === myChannelId && newState.channelId !== oldState.channelId) {
      const memberLeft = oldState.member;
      if (memberLeft && !memberLeft.user.bot) {
        await this.notifications.notifyChannelChanges(`门 *Из войса вышел:*
` +
          `• Имя: ${memberLeft.displayName}
` +
          `• Юзер: @${memberLeft.user.username}
` +
          `• ID: \`${memberLeft.id}\`
` +
          `• Время: ${new Date().toLocaleTimeString('ru-RU')}`);
      }
    }
    const st = this.state.get();
    if (st.isStopped || st.isBotJoining) {
      return;
    }

    const client = this.discord.getClient();
    const guild = client.guilds.cache.get(cfg.guild_id);
    const me = guild?.members.me ?? guild?.me;
    const targetChannel = guild?.channels.cache.get(cfg.target_vc_id);
    if (!guild || me?.voice.channelId) {
      return;
    }

    const isVoice = targetChannel && (targetChannel.type === 'GUILD_VOICE' || targetChannel.type === 'GUILD_STAGE');
    if (!targetChannel || !isVoice || !targetChannel.viewable) {
      if (cfg.role_id && !me?.roles.cache.has(cfg.role_id)) {
        await this.notifications.notifyJoinLeave(`💔 *Ошибка подключения*\n\n` +
          `Нет прав доступа к каналу. Требуется роль: \`${cfg.role_id}\``);
        this.state.setStopped(true);
        return;
      }

      this.state.setReconnectTimer(setTimeout(() => this.checkAndJoin(), 300000));
      return;
    }

    const success = await this.discord.joinVoiceChannel(cfg.guild_id, cfg.target_vc_id);
    if (success) {
      await this.notifications.notifyJoinLeave(`🎙️ *Подключился к каналу:* ${targetChannel.name}`);
    }
  }

  private async waitForVoiceJoin(guildId: string, channelId: string, timeoutMs = 10000, intervalMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.discord.getCurrentVoiceChannel(guildId) === channelId) {
        return true;
      }
      await this.sleep(intervalMs);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async checkAndJoin(): Promise<void> {
    const cfg = this.config.get();
    const st = this.state.get();
    if (st.isStopped || st.isBotJoining) {
      return;
    }

    if (st.nextJoinTimestamp !== null && Date.now() < st.nextJoinTimestamp) {
      return;
    }

    const client = this.discord.getClient();
    const guild = client.guilds.cache.get(cfg.guild_id);
    const me = guild?.members.me ?? guild?.me;
    const targetChannel = guild?.channels.cache.get(cfg.target_vc_id);
    if (!guild || me?.voice.channelId) {
      return;
    }

    const isVoice = targetChannel && (targetChannel.type === 'GUILD_VOICE' || targetChannel.type === 'GUILD_STAGE');
    if (!targetChannel || !isVoice || !targetChannel.viewable) {
      if (cfg.role_id && !me?.roles.cache.has(cfg.role_id)) {
        await this.notifications.notifyJoinLeave(`💔 *Ошибка подключения*\n\n` +
          `Нет прав доступа к каналу. Требуется роль: \`${cfg.role_id}\``);
        this.state.setStopped(true);
        return;
      }

      this.state.setReconnectTimer(setTimeout(() => this.checkAndJoin(), 300000));
      return;
    }

    const success = await this.discord.joinVoiceChannel(cfg.guild_id, cfg.target_vc_id);
    if (success) {
      await this.notifications.notifyJoinLeave(`🎙️ *Подключился к каналу:* ${targetChannel.name}`);
    }
  }
}
