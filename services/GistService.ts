import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs-extra';
import * as path from 'path';

import { DiscordService } from './DiscordService';

export interface GistServerConfig {
  server_id: string;
  channel_id: string;
  message_id: string;
  voice_channel_id: string;
  button_lock_channel: string;
}

export interface GistConfigData {
  servers: Record<string, GistServerConfig>;
}

export class GistService {
  private static readonly DEFAULT_REMOTE_URL = 'https://gist.githubusercontent.com/Crone720/096076cb5219de5a17a3bf9f596cfb9d/raw/0c6cbf3bd35ca08fafa67bec9d8b4a5cfb781668/gist.json';

  private readonly discord: DiscordService;
  private readonly cachePath: string;
  private readonly remoteUrl: string | null;
  private cachedData: GistConfigData | null = null;

  constructor(discord: DiscordService, cacheDir: string = process.cwd()) {
    this.discord = discord;
    this.cachePath = path.join(cacheDir, 'gist-cache.json');
    this.remoteUrl = process.env.GIST_URL ?? GistService.DEFAULT_REMOTE_URL;
  }

  public async getServers(): Promise<Record<string, GistServerConfig>> {
    const data = await this.load();
    return data.servers;
  }

  public async getServer(name: string): Promise<GistServerConfig | undefined> {
    const servers = await this.getServers();
    return servers[name];
  }

  public async getServerByGuildId(guildId: string): Promise<GistServerConfig | undefined> {
    const servers = await this.getServers();
    return Object.values(servers).find((server) => server.server_id === guildId);
  }

  public async refresh(): Promise<GistConfigData> {
    const data = await this.loadRemoteConfig();
    this.cachedData = data;
    this.persistCache(data);
    return data;
  }

  public async validateServer(name: string, server: GistServerConfig): Promise<{ ok: boolean; message: string }> {
    if (!this.discord.isGuildMember(server.server_id)) {
      return { ok: false, message: `❌ Вы не являетесь участником сервера ${name}.` };
    }

    return this.discord.validateVoiceChannelAccess(server.server_id, server.voice_channel_id);
  }

  private async load(): Promise<GistConfigData> {
    if (this.cachedData) {
      return this.cachedData;
    }

    const cached = this.loadCache();
    if (cached) {
      this.cachedData = cached;
      return cached;
    }

    return this.refresh();
  }

  private async loadRemoteConfig(): Promise<GistConfigData> {
    if (this.remoteUrl) {
      try {
        const response = await fetch(this.remoteUrl);
        if (!response.ok) {
          throw new Error(`Unable to download gist config: ${response.status}`);
        }

        const data = (await response.json()) as Partial<GistConfigData>;
        return this.normalizeConfig(data);
      } catch (error) {
        console.warn('⚠️ Не удалось загрузить удалённый gist, пробую кэш/локальный файл:', error instanceof Error ? error.message : error);
      }
    }

    const cached = this.loadCache();
    if (cached) {
      return cached;
    }

    return this.loadLocalConfig();
  }

  private loadLocalConfig(): GistConfigData {
    const localPath = path.join(process.cwd(), 'gist.json');
    if (!existsSync(localPath)) {
      return { servers: {} };
    }

    const raw = readFileSync(localPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GistConfigData>;
    return this.normalizeConfig(parsed);
  }

  private loadCache(): GistConfigData | null {
    if (!existsSync(this.cachePath)) {
      return null;
    }

    const raw = readFileSync(this.cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GistConfigData>;
    return this.normalizeConfig(parsed);
  }

  private persistCache(data: GistConfigData): void {
    mkdirSync(path.dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private normalizeConfig(data: Partial<GistConfigData>): GistConfigData {
    const servers = data.servers && typeof data.servers === 'object' ? data.servers : {};

    const normalizedServers: Record<string, GistServerConfig> = {};
    for (const [name, value] of Object.entries(servers)) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const server = value as Partial<GistServerConfig>;
      if (
        typeof server.server_id === 'string' &&
        typeof server.channel_id === 'string' &&
        typeof server.message_id === 'string' &&
        typeof server.voice_channel_id === 'string' &&
        typeof server.button_lock_channel === 'string'
      ) {
        normalizedServers[name] = {
          server_id: server.server_id,
          channel_id: server.channel_id,
          message_id: server.message_id,
          voice_channel_id: server.voice_channel_id,
          button_lock_channel: server.button_lock_channel
        };
      }
    }

    return { servers: normalizedServers };
  }
}
