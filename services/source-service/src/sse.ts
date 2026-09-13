import type { ServerResponse } from "node:http";

export class SSEWriteError extends Error {}

export type SSEWakeResult = "notified" | "timeout" | "aborted";

export class SSEWakeSignal {
  private pending = false;
  private wake?: () => void;

  notify(): void {
    this.pending = true;
    this.wake?.();
  }

  wait(timeoutMs: number, signal: AbortSignal): Promise<SSEWakeResult> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("notified");
    }
    if (signal.aborted) return Promise.resolve("aborted");
    if (this.wake) throw new Error("SSE 唤醒器不能并发等待。");
    return new Promise<SSEWakeResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: SSEWakeResult) => {
        if (settled) return;
        settled = true;
        if (result === "notified") this.pending = false;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.wake = undefined;
        resolve(result);
      };
      const aborted = () => finish("aborted");
      this.wake = () => finish("notified");
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
      signal.addEventListener("abort", aborted, { once: true });
      if (this.pending) this.wake();
      else if (signal.aborted) aborted();
    });
  }
}

export function encodeSSEEvent(
  event: string,
  id: string,
  data: unknown,
): string {
  if (/\r|\n/.test(event) || /\r|\n/.test(id))
    throw new SSEWriteError("SSE 事件名称或 ID 无效。");
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Write one bounded SSE frame and wait for drain without leaking listeners. */
export async function writeSSE(
  response: ServerResponse,
  frame: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded)
    throw new SSEWriteError("SSE 连接已经关闭。");
  if (response.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off("drain", drained);
      response.off("close", closed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const drained = () => finish();
    const closed = () => finish(new SSEWriteError("SSE 连接已经关闭。"));
    const aborted = () => finish(new SSEWriteError("SSE 写入已经停止。"));
    timer = setTimeout(
      () => finish(new SSEWriteError("SSE 客户端读取超时。")),
      timeoutMs,
    );
    timer.unref?.();
    response.once("drain", drained);
    response.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
