export interface VoiceMemberLike {
  id: string;
  displayName: string;
  user: {
    bot?: boolean;
    username: string;
    avatarURL?: () => string | null;
  };
  voice?: {
    mute?: boolean;
    deaf?: boolean;
  };
  permissions: {
    has: (permission: string) => boolean;
  };
  roles: {
    cache: {
      some: (predicate: (role: RoleLike) => boolean) => boolean;
      find: (predicate: (role: RoleLike) => boolean) => RoleLike | undefined;
    };
  };
}

export interface VoiceChannelLike {
  id: string;
  name: string;
  type: string;
  parentId?: string | null;
  parent?: {
    name?: string;
  };
  viewable?: boolean;
  userLimit?: number;
  permissionsFor?: (id: string) => { has: (permission: string) => boolean } | undefined;
  members?: {
    size: number;
    map: (callback: (member: VoiceMemberLike) => VoiceMemberSummaryLike) => VoiceMemberSummaryLike[];
  };
}

export interface VoiceMemberSummaryLike {
  id: string;
  username: string;
  displayName: string;
  isMuted: boolean;
  isDeaf: boolean;
  isStaff: boolean;
  staffReason: string;
}

export interface RoleLike {
  name: string;
}

export interface GuildMemberLike {
  id: string;
  displayName: string;
  user: {
    bot?: boolean;
    username: string;
    avatarURL?: () => string | null;
  };
  permissions: {
    has: (permission: string) => boolean;
  };
  roles: {
    cache: {
      some: (predicate: (role: RoleLike) => boolean) => boolean;
      find: (predicate: (role: RoleLike) => boolean) => RoleLike | undefined;
    };
  };
  voice?: {
    mute?: boolean;
    deaf?: boolean;
  };
}

export interface VoiceStateLike {
  id: string;
  guild: GuildLike;
  channel: VoiceChannelLike | null;
  channelId: string | null;
  member?: GuildMemberLike;
}

export interface GuildLike {
  id: string;
  name?: string;
  channels: {
    cache: {
      get: (id: string) => VoiceChannelLike | undefined;
    };
  };
  members: {
    me?: {
      id?: string;
      voice: {
        channelId?: string | null;
        channel?: VoiceChannelLike | null;
        disconnect?: () => Promise<void>;
      };
      roles: {
        cache: {
          has: (roleId: string) => boolean;
        };
      };
      permissions: {
        has: (permission: string) => boolean;
      };
    } | null;
    edit?: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  me?: {
    id?: string;
    voice: {
      channelId?: string | null;
      channel?: VoiceChannelLike | null;
      disconnect?: (reason?: string) => Promise<unknown>;
    };
    roles: {
      cache: {
        has: (roleId: string) => boolean;
      };
    };
  } | null;
}

export interface VoiceConnectionLike {
  setMute: (mute: boolean) => Promise<void>;
  setDeaf: (deaf: boolean) => Promise<void>;
  disconnect?: () => Promise<void>;
}

export interface DiscordClientLike {
  destroy?: () => Promise<void> | void;
  login: (token: string) => Promise<void>;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners?: (event?: string) => void;
  readyTimestamp?: number;
  ws?: {
    connected?: boolean;
  };
  user?: {
    id?: string;
    tag?: string;
    username?: string;
    displayName?: string;
    avatarURL?: () => string | null;
    createdTimestamp?: number;
    setPresence?: (options: { status: string }) => Promise<void>;
  };
  channels: {
    cache: {
      get: (id: string) => any | undefined;
    };
    fetch?: (id: string, options?: { allowUnknownGuild?: boolean; cache?: boolean; force?: boolean }) => Promise<any>;
  };
  voice: {
    joinChannel: (channel: VoiceChannelLike, options: Record<string, unknown>) => Promise<void>;
    connection?: VoiceConnectionLike | null;
  };
  guilds: {
    cache: {
      get: (id: string) => GuildLike | undefined;
    };
  };
}
