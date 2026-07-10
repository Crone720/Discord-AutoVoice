export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface IConfig {
  owner_id: number | null;
  discord_token: string;
  tg_bot_token: string;
  guild_id: string;
  target_vc_id: string;
  role_id: string;
  account_display_name: string | null;
  account_token: string | null;
  presence_status: PresenceStatus;
  auto_reconnect_enabled: boolean;
  auto_reconnect_delay: number;
  legalizer_enabled: boolean;
  legalizer_min_delay: number;
  legalizer_max_delay: number;
  mute_microphone: boolean;
  mute_headphones: boolean;
  notifications: {
    enabled: boolean;
    on_join_leave: boolean;
    on_role_changes: boolean;
    on_channel_changes: boolean;
    on_move: boolean;
  };
}

export interface AppState {
  isBotJoining: boolean;
  nextJoinTimestamp: number | null;
  reconnectTimer: NodeJS.Timeout | null;
  periodicCheckTimer: NodeJS.Timeout | null;
  isStopped: boolean;
  isInitialized: boolean;
}
