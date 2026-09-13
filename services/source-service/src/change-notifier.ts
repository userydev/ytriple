import { Client, type Notification } from "pg";

export const CHANGE_NOTIFICATION_CHANNEL = "ytriple_source_changes_v1";

type ChangeListener = () => void;

/**
 * One PostgreSQL LISTEN connection per API process, fanned out in memory by
 * tenant. Notifications are only wake-ups: subscribers still read committed
 * rows from delivery_change using their signed cursor.
 */
export class ChangeNotifier {
  private readonly listeners = new Map<string, Set<ChangeListener>>();
  private client?: Client;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly databaseURL: string) {}

  async subscribe(
    tenantId: string,
    listener: ChangeListener,
  ): Promise<() => void> {
    if (this.closed) throw new Error("信息源变更通知器已经关闭。");
    const tenantListeners = this.listeners.get(tenantId) ?? new Set();
    tenantListeners.add(listener);
    this.listeners.set(tenantId, tenantListeners);
    try {
      await this.ensureConnected();
    } catch (error) {
      this.remove(tenantId, listener);
      throw error;
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.remove(tenantId, listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.listeners.clear();
    if (client) {
      client.removeAllListeners();
      client.on("error", () => {});
      await client.end().catch(() => undefined);
    }
  }

  private remove(tenantId: string, listener: ChangeListener): void {
    const tenantListeners = this.listeners.get(tenantId);
    tenantListeners?.delete(listener);
    if (!tenantListeners?.size) this.listeners.delete(tenantId);
  }

  private listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  private ensureConnected(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("信息源变更通知器已经关闭。"));
    if (this.client) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect()
      .catch((error) => {
        this.scheduleReconnect();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({
      connectionString: this.databaseURL,
      application_name: "ytriple-source-change-listener",
    });
    let disconnectedBeforeReady = false;
    const disconnected = () => {
      if (this.client === client) this.disconnected(client);
      else disconnectedBeforeReady = true;
    };
    client.on("error", disconnected);
    client.on("end", disconnected);
    client.on("notification", (notification) => this.notified(notification));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANGE_NOTIFICATION_CHANNEL}`);
      if (disconnectedBeforeReady)
        throw new Error("PostgreSQL 变更通知连接在准备期间关闭。");
    } catch (error) {
      client.removeAllListeners();
      // Keep a terminal error listener while pg tears the failed socket down.
      client.on("error", () => {});
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      client.removeAllListeners();
      client.on("error", () => {});
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
  }

  private notified(notification: Notification): void {
    if (
      notification.channel !== CHANGE_NOTIFICATION_CHANNEL ||
      !notification.payload
    )
      return;
    for (const listener of this.listeners.get(notification.payload) ?? []) {
      try {
        listener();
      } catch {
        // A subscriber cannot break notification delivery for other streams.
      }
    }
  }

  private disconnected(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    client.removeAllListeners();
    // A broken pg socket can emit more than one error while it closes. Never
    // leave those later events without a listener.
    client.on("error", () => {});
    void client.end().catch(() => undefined);
    for (const listeners of this.listeners.values())
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Subscribers will fall back to their authoritative cursor query.
        }
      }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !this.listenerCount()) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.listenerCount()) return;
      void this.ensureConnected().catch(() => undefined);
    }, 1_000);
    this.reconnectTimer.unref?.();
  }
}
