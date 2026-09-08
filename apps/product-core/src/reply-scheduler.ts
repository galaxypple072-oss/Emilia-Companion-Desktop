export interface ReplySchedulerOptions {
  quietMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

export interface ReplyExecutionContext {
  revision: number;
  signal: AbortSignal;
  isCurrent(): boolean;
}

export class ReplyScheduler<T> {
  private readonly capture: () => T;
  private readonly execute: (payload: T, context: ReplyExecutionContext) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private firstAt = 0;
  private lastAt = 0;
  private revision = 0;
  private activeQuietMs: number;
  private activeController: AbortController | null = null;
  private execution: Promise<void> = Promise.resolve();

  constructor(
    capture: () => T,
    execute: (payload: T, context: ReplyExecutionContext) => Promise<void>,
    onError: (error: unknown) => void,
    options: ReplySchedulerOptions = {},
  ) {
    this.capture = capture;
    this.execute = execute;
    this.onError = onError;
    this.quietMs = options.quietMs ?? 2500;
    this.maxWaitMs = options.maxWaitMs ?? 10_000;
    this.activeQuietMs = this.quietMs;
    this.now = options.now ?? Date.now;
    if (this.quietMs < 1 || this.maxWaitMs < this.quietMs) {
      throw new Error("Reply scheduler requires 0 < quietMs <= maxWaitMs");
    }
  }

  notify(quietMs = this.quietMs): number {
    const now = this.now();
    this.revision += 1;
    this.activeController?.abort();
    if (!this.pending) {
      this.pending = true;
      this.firstAt = now;
    }
    this.lastAt = now;
    this.activeQuietMs = Math.max(this.quietMs, Math.min(this.maxWaitMs, quietMs));
    this.arm(now);
    return this.revision;
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  async waitForIdle(): Promise<void> {
    await this.execution;
  }

  private arm(now: number): void {
    if (this.timer) clearTimeout(this.timer);
    const quietRemaining = this.lastAt + this.activeQuietMs - now;
    const maximumRemaining = this.firstAt + this.maxWaitMs - now;
    const delay = Math.max(0, Math.min(quietRemaining, maximumRemaining));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    if (!this.pending) return;
    this.pending = false;
    const revision = this.revision;
    this.execution = this.execution
      .then(async () => {
        if (revision !== this.revision) return;
        const payload = this.capture();
        const controller = new AbortController();
        this.activeController = controller;
        const context: ReplyExecutionContext = {
          revision,
          signal: controller.signal,
          isCurrent: () => revision === this.revision,
        };
        try {
          await this.execute(payload, context);
        } catch (error) {
          if (context.isCurrent()) this.onError(error);
        } finally {
          if (this.activeController === controller) this.activeController = null;
        }
      });
  }
}
