import type { HttpPort, HttpRequestInit, SecretPort } from "@ytriple/shared";

export interface FakeHttpCall {
  init: HttpRequestInit;
  body: Record<string, unknown>;
}

export interface FakeHttpPort extends HttpPort {
  readonly calls: FakeHttpCall[];
  readonly lastBody: Record<string, unknown>;
}

/** HttpPort double: no adapter test may ever reach the network. */
export function createFakeHttpPort(
  responder: (init: HttpRequestInit, call: number) => { status?: number; body: unknown },
): FakeHttpPort {
  const calls: FakeHttpCall[] = [];

  return {
    calls,
    get lastBody() {
      const last = calls[calls.length - 1];
      if (!last) throw new Error("No HTTP call recorded");
      return last.body;
    },
    async request(init: HttpRequestInit) {
      const index = calls.length;
      calls.push({
        init,
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      const result = responder(init, index);
      return {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
        body: typeof result.body === "string" ? result.body : JSON.stringify(result.body),
      };
    },
  };
}

export function createFakeSecretPort(values: Record<string, string>): SecretPort {
  return {
    async resolve(credentialRef) {
      const value = values[credentialRef];
      if (value === undefined) {
        throw new Error(`secret "${credentialRef}" is not set`);
      }
      return value;
    },
  };
}
