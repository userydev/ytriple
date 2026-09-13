import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import {
  encodeSSEEvent,
  SSEWakeSignal,
  SSEWriteError,
  writeSSE,
} from "../src/sse.js";

class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly frames: string[] = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    return false;
  }
}

test("SSE event framing keeps cursor and JSON data on one bounded frame", () => {
  assert.equal(
    encodeSSEEvent("change", "signed.cursor", { text: "line\none" }),
    'id: signed.cursor\nevent: change\ndata: {"text":"line\\none"}\n\n',
  );
  assert.throws(
    () => encodeSSEEvent("change\nevil", "signed.cursor", {}),
    SSEWriteError,
  );
  assert.throws(
    () => encodeSSEEvent("change", "signed.cursor\nevil", {}),
    SSEWriteError,
  );
});

test("SSE wake-ups coalesce and abort without leaving a pending waiter", async () => {
  const wake = new SSEWakeSignal();
  wake.notify();
  wake.notify();
  assert.equal(
    await wake.wait(1_000, new AbortController().signal),
    "notified",
  );

  const controller = new AbortController();
  const waiting = wake.wait(1_000, controller.signal);
  controller.abort();
  assert.equal(await waiting, "aborted");

  wake.notify();
  assert.equal(
    await wake.wait(1_000, new AbortController().signal),
    "notified",
  );
});

test("SSE writes honor drain and remove backpressure listeners", async () => {
  const response = new BackpressuredResponse();
  const writing = writeSSE(
    response as unknown as ServerResponse,
    ": heartbeat\n\n",
    new AbortController().signal,
    1_000,
  );
  assert.equal(response.listenerCount("drain"), 1);
  assert.equal(response.listenerCount("close"), 1);
  response.emit("drain");
  await writing;
  assert.deepEqual(response.frames, [": heartbeat\n\n"]);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("aborting a backpressured SSE write rejects and cleans up", async () => {
  const response = new BackpressuredResponse();
  const controller = new AbortController();
  const writing = writeSSE(
    response as unknown as ServerResponse,
    ": heartbeat\n\n",
    controller.signal,
    1_000,
  );
  controller.abort();
  await assert.rejects(writing, SSEWriteError);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});
