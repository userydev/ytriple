import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Accounts } from "../src/core/accounts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-accounts-"));
  const key = randomBytes(32),
    baseUrl = "https://core.example.test";
  let now = Date.now(),
    revision = 0,
    refreshes = 0,
    privateReads = 0,
    logouts = 0;
  let userId = randomUUID(),
    entitled = true,
    badRefresh = false,
    logoutFailure = false,
    writable = true,
    available = true;
  const authUrl = "https://auth.example.test/auth/v1";
  const vault = {
    available: () => available,
    encrypt(text: string) {
      if (!writable) throw Error("fixture disk/encryption failure");
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt(bytes: Buffer) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString();
    },
  };
  const session = () => ({
    access_token: "access-sensitive-" + revision,
    refresh_token: "refresh-sensitive-" + revision,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(now / 1000) + 3600,
    user: {
      id: userId,
      email: "fixture@example.com",
      aud: "authenticated",
      role: "authenticated",
      created_at: new Date(now).toISOString(),
    },
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-YCore-Contract": "0.1.0",
      },
    });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    if (url.href === baseUrl + "/v1/auth/config")
      return json({
        authentication: {
          provider: "supabase",
          auth_url: authUrl,
          publishable_key: "sb_publishable_fixture-only-key",
        },
      });
    if (url.href === authUrl + "/token?grant_type=password") {
      assert.equal(JSON.parse(String(init?.body)).password, "fixture-password");
      revision++;
      return json(session());
    }
    if (url.href === authUrl + "/token?grant_type=refresh_token") {
      refreshes++;
      assert.equal(
        JSON.parse(String(init?.body)).refresh_token,
        "refresh-sensitive-" + revision,
      );
      if (badRefresh)
        return json(
          {
            msg: "expired refresh token",
            error_code: "refresh_token_not_found",
          },
          400,
        );
      revision++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json(session());
    }
    if (url.href === authUrl + "/logout?scope=local") {
      logouts++;
      if (logoutFailure) return json({ msg: "expired JWT" }, 401);
      return new Response(null, { status: 204 });
    }
    if (url.href === baseUrl + "/v1/identity") {
      if (!entitled)
        return json(
          { error: { code: "ENTITLEMENT_REQUIRED", message: "grant missing" } },
          403,
        );
      return json({
        id: "user:" + userId + ":ytriple",
        user_id: userId,
        product_id: "ytriple",
        authentication: "supabase",
      });
    }
    if (url.href === baseUrl + "/v1/capabilities") {
      privateReads++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer access-sensitive-" + revision,
      );
      return json({ ai: true });
    }
    throw Error("Unexpected fixture URL: " + url);
  };
  const make = () =>
    new Accounts(
      dir,
      vault,
      () => {},
      fetcher,
      () => now,
    );
  const login = (
    account: Accounts,
    guard: (scope: string) => void = () => {},
  ) =>
    account.signIn(baseUrl, "fixture@example.com", "fixture-password", guard);
  return {
    dir,
    make,
    login,
    vault,
    baseUrl,
    fetcher,
    get refreshes() {
      return refreshes;
    },
    get privateReads() {
      return privateReads;
    },
    get logouts() {
      return logouts;
    },
    expire() {
      now += 3600_000;
    },
    set entitled(value: boolean) {
      entitled = value;
    },
    set badRefresh(value: boolean) {
      badRefresh = value;
    },
    set writable(value: boolean) {
      writable = value;
    },
    set logoutFailure(value: boolean) {
      logoutFailure = value;
    },
    set available(value: boolean) {
      available = value;
    },
    changeUser() {
      userId = randomUUID();
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("managed sign-in saves only encrypted credentials, restores and rotates once for concurrent requests", async () => {
  const f = fixture();
  try {
    const a = f.make(),
      first = (await f.login(a))!;
    await first.capabilities();
    const saved = readFileSync(join(f.dir, "account.json"), "utf8");
    for (const secret of [
      "access-sensitive",
      "refresh-sensitive",
      "fixture-password",
      "fixture@example.com",
    ])
      assert.equal(saved.includes(secret), false);
    assert.equal(statSync(join(f.dir, "account.json")).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(a.info()).includes("token"), false);
    const restored = f.make(),
      client = await restored.connect();
    assert.equal(client.scope, first.scope);
    f.expire();
    await Promise.all(Array.from({ length: 8 }, () => client.capabilities()));
    assert.equal(f.refreshes, 1);
    assert.equal(client.scope, first.scope);
    const again = f.make();
    await (await again.connect()).capabilities();
    assert.equal(f.refreshes, 1);
    await restored.signOut(() => {});
    assert.equal(f.logouts, 1);
    await assert.rejects(client.capabilities(), /账号已退出/);
    const loggedOut = f.make();
    assert.equal(loggedOut.enabled, true);
    assert.equal(loggedOut.info().state, "signed_out");
    await assert.rejects(loggedOut.connect(), /请先登录/);
  } finally {
    f.close();
  }
});
test("no entitlement retains login for retry; guarded account adoption does not overwrite an existing connection", async () => {
  const f = fixture();
  try {
    f.entitled = false;
    const a = f.make();
    assert.equal(await f.login(a), undefined);
    assert.equal(a.info().state, "signed_in");
    assert.match(a.info().error!, /尚无/);
    await assert.rejects(f.login(a), /先退出/);
    f.entitled = true;
    await (await a.connect()).capabilities();
    assert.equal(a.info().error, null);
    await assert.rejects(
      a.signOut(() => {
        throw Error("old run active");
      }),
      /old run/,
    );
    assert.equal(a.info().state, "signed_in");
    await a.signOut(() => {});
    const before = readFileSync(join(f.dir, "account.json"), "utf8");
    await assert.rejects(
      f.login(a, () => {
        throw Error("old run active");
      }),
      /old run/,
    );
    assert.equal(readFileSync(join(f.dir, "account.json"), "utf8"), before);
    assert.equal(a.info().state, "signed_out");
    assert.equal(f.logouts, 2);
  } finally {
    f.close();
  }
});
test("failed or different-user refresh blocks private requests and restarts require login", async () => {
  for (const mode of ["expired", "different-user", "persistence"] as const) {
    const f = fixture();
    try {
      const a = f.make(),
        client = (await f.login(a))!;
      f.expire();
      if (mode === "expired") f.badRefresh = true;
      if (mode === "different-user") f.changeUser();
      if (mode === "persistence") f.writable = false;
      await assert.rejects(client.capabilities(), /重新登录/);
      assert.equal(f.privateReads, 0);
      assert.equal(a.info().state, "relogin");
      assert.equal(f.make().info().state, "relogin");
      assert.equal(f.make().enabled, true);
    } finally {
      f.close();
    }
  }
});
test("corrupt/locked account files fail closed, cancellation does not issue private request, manual legacy choice is explicit", async () => {
  const f = fixture();
  try {
    const a = f.make(),
      client = (await f.login(a))!;
    f.available = false;
    assert.equal(f.make().info().state, "relogin");
    assert.equal(f.make().enabled, true);
    f.available = true;
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(
      client.request("/v1/capabilities", { signal: stop.signal }),
    );
    assert.equal(f.privateReads, 0);
    assert.throws(() => a.useLegacy(f.baseUrl), /先退出/);
    await a.signOut(() => {});
    a.useLegacy(f.baseUrl);
    assert.equal(f.make().enabled, false);
    writeFileSync(join(f.dir, "account.json"), "corrupt");
    assert.equal(f.make().enabled, true);
    assert.equal(f.make().info().state, "relogin");
  } finally {
    f.close();
  }
});

test("unconfirmed remote logout still removes the local session durably and reports its limit", async () => {
  const f = fixture();
  try {
    const a = f.make(),
      client = (await f.login(a))!;
    f.logoutFailure = true;
    await a.signOut(() => {});
    assert.equal(a.info().state, "signed_out");
    assert.match(a.info().error!, /撤销未确认/);
    await assert.rejects(client.capabilities(), /账号已退出/);
    assert.equal(f.privateReads, 0);
    assert.equal(f.make().enabled, true);
    assert.equal(f.make().info().state, "signed_out");
  } finally {
    f.close();
  }
});
