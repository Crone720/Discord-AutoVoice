import { Telegraf } from 'telegraf';

import { ConfigManager } from './managers/ConfigManager';
import { StateManager } from './managers/StateManager';
import { DiscordService } from './services/DiscordService';
import { GistService } from './services/GistService';
import { NotificationService } from './services/NotificationService';
import { TelegramService } from './services/TelegramService';
import { DiscordEventHandler } from './handlers/DiscordEventHandler';

class Application {
  private readonly configManager: ConfigManager;
  private readonly stateManager: StateManager;
  private readonly telegramBot: Telegraf;
  private readonly discordService: DiscordService;
  private readonly notificationService: NotificationService;
  private readonly gistService: GistService;
  private readonly telegramService: TelegramService;
  private readonly eventHandler: DiscordEventHandler;

  constructor() {
    this.configManager = new ConfigManager();
    this.stateManager = new StateManager();
    this.telegramBot = new Telegraf(this.configManager.get().tg_bot_token || '');
    this.discordService = new DiscordService(
      this.configManager,
      this.stateManager,
      new NotificationService(this.telegramBot, this.configManager)
    );
    this.notificationService = new NotificationService(this.telegramBot, this.configManager);
    this.gistService = new GistService(this.discordService);
    this.telegramService = new TelegramService(
      this.telegramBot,
      this.configManager,
      this.stateManager,
      this.discordService,
      this.gistService
    );
    this.eventHandler = new DiscordEventHandler(
      this.discordService,
      this.notificationService,
      this.configManager,
      this.stateManager,
      this.gistService
    );

    this.discordService.setClientEventRegistrationCallback(() => {
      console.log('🔁 Re-registering Discord event handlers after client reconnect');
      this.eventHandler.registerHandlers();
    });
  }

  public async initialize(): Promise<void> {
    console.log('🚀 Инициализация приложения...\n');

    const cfg = this.configManager.get();
    if (!cfg.tg_bot_token) {
      console.error('❌ Токен Telegram бота не установлен в конфиге');
      console.log('⚠️ Обновите tg_bot_token в settings.json и перезапустите приложение \n\nЧтобы создать бота зайдите в телеграмм, перейдите в бота @botfather\nи делайте по инструкции');
      process.exit(1);
    }

    console.log('🔍 Проверка токена Telegram бота...');
    const tgValid = await this.configManager.initializeTgBot(this.telegramBot);
    if (!tgValid) {
      console.error('❌ Токен Telegram бота невалидный');
      console.log('⚠️ Обновите tg_bot_token в settings.json и перезапустите приложение \n\nЧтобы создать бота зайдите в телеграмм, перейдите в бота @botfather\nи делайте по инструкции');
      process.exit(1);
    }

    await this.gistService.refresh().catch((error) => {
      console.warn('⚠️ Не удалось обновить Gist-конфиг:', error instanceof Error ? error.message : error);
    });

    console.log('\n🤖 Запуск Telegram бота...');
    await this.telegramService.initialize();

    if (cfg.discord_token) {
      console.log('\n📱 Инициализация Discord клиента...');
      await this.discordService.initialize();

      if (this.discordService.isInitialized()) {
        console.log('📡 Регистрация обработчиков Discord событий...');
        this.eventHandler.registerHandlers();
        this.stateManager.setInitialized(true);
        console.log('\n✅ Приложение полностью инициализировано\n');
      }
    } else {
      console.log('\n⚠️ Discord токен не установлен. Используйте команду /start для настройки');
      console.log('\n✅ Telegram бот активен и готов к конфигурации\n');
    }
  }

  public start(): void {
    this.initialize().catch((error) => {
      console.error('❌ Критическая ошибка при инициализации:', error);
      process.exit(1);
    });
  }
}

const app = new Application();
app.start();

process.on('SIGINT', () => {
  console.log('\n🛑 Завершение работы приложения...');
  process.exit(0);
});
