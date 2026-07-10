import { AppState } from '../types/config';

export class StateManager {
  private state: AppState;

  constructor() {
    this.state = {
      isBotJoining: false,
      nextJoinTimestamp: null,
      reconnectTimer: null,
      periodicCheckTimer: null,
      isStopped: false,
      isInitialized: false
    };
  }

  public get(): AppState {
    return this.state;
  }

  public setBotJoining(value: boolean): void {
    this.state.isBotJoining = value;
  }

  public setNextJoinTimestamp(value: number | null): void {
    this.state.nextJoinTimestamp = value;
  }

  public setReconnectTimer(timer: NodeJS.Timeout | null): void {
    if (this.state.reconnectTimer) {
      clearTimeout(this.state.reconnectTimer);
    }
    this.state.reconnectTimer = timer;
  }

  public setStopped(value: boolean): void {
    this.state.isStopped = value;
  }

  public setInitialized(value: boolean): void {
    this.state.isInitialized = value;
  }

  public setPeriodicCheckTimer(timer: NodeJS.Timeout | null): void {
    if (this.state.periodicCheckTimer) {
      clearInterval(this.state.periodicCheckTimer);
    }
    this.state.periodicCheckTimer = timer;
  }

  public clearPeriodicCheckTimer(): void {
    if (this.state.periodicCheckTimer) {
      clearInterval(this.state.periodicCheckTimer);
    }
    this.state.periodicCheckTimer = null;
  }

  public clearReconnectTimer(): void {
    if (this.state.reconnectTimer) {
      clearTimeout(this.state.reconnectTimer);
    }
    this.state.reconnectTimer = null;
    this.state.nextJoinTimestamp = null;
  }

}
