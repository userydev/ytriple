import { createHmac, timingSafeEqual } from "node:crypto";

type CursorPayload = {
  v: 1;
  server: string;
  tenant: string;
  sequence: string;
};

export class CursorError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() {
    super("同步游标无效或不属于当前服务与租户。");
  }
}

export class CursorCodec {
  constructor(
    private readonly secret: string,
    private readonly serverInstanceId: string,
  ) {}

  encode(tenantId: string, sequence: bigint): string {
    const payload: CursorPayload = {
      v: 1,
      server: this.serverInstanceId,
      tenant: tenantId,
      sequence: sequence.toString(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  decode(cursor: string | undefined, tenantId: string): bigint {
    if (!cursor) return 0n;
    const [encoded, signature, extra] = cursor.split(".");
    if (!encoded || !signature || extra) throw new CursorError();
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new CursorError();
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as CursorPayload;
      if (
        payload.v !== 1 ||
        payload.server !== this.serverInstanceId ||
        payload.tenant !== tenantId ||
        !/^\d+$/.test(payload.sequence)
      )
        throw new CursorError();
      return BigInt(payload.sequence);
    } catch (error) {
      if (error instanceof CursorError) throw error;
      throw new CursorError();
    }
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}
