import { AuthClient } from "@supabase/auth-js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CredentialVault } from "./model-connections";
import type { AccountSummary } from "./types";
import {
  ACCOUNT_CONTRACT,
  accountSummarySchema,
} from "./account-summary-contract";
import { YCore, ServiceError } from "./ycore";

function endpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("服务地址需使用 HTTPS，本机服务可使用 HTTP");
  return url.href.replace(/\/+$/, "");
}
const providerSchema = z
  .object({
    provider: z.literal("supabase"),
    auth_url: z.string().url().max(2048).transform(endpoint),
    publishable_key: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{10,200}$/),
  })
  .strict();
const sessionSchema = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384),
  expires_at: z.number().int().positive(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().max(320).optional(),
    is_anonymous: z.literal(false).optional(),
  }),
});
const recordSchema = z
  .object({
    baseUrl: z.string().url().max(2048).transform(endpoint),
    provider: providerSchema,
    session: sessionSchema,
  })
  .strict();
type AccountRecord = z.infer<typeof recordSchema>;
export type AccountInfo = {
  state: "signed_out" | "signed_in" | "relogin";
  email: string | null;
  error: string | null;
};
const envelope = z
  .object({
    version: z.literal(1),
    mode: z.enum(["account", "legacy"]),
    baseUrl: z.string().url().max(2048).transform(endpoint),
    encrypted: z.string().max(100000).nullable(),
    interrupted: z.boolean().optional(),
  })
  .strict();

/** Credentials stay in the main process. There is no background refresh or SDK
 * disk storage: each rotation is serialized and durably saved before token use. */
export class Accounts {
  private record?: AccountRecord;
  private sdk?: InstanceType<typeof AuthClient>;
  private refresh?: Promise<string>;
  private state: AccountInfo = {
    state: "signed_out",
    email: null,
    error: null,
  };
  private managed = false;
  private serviceUrl = "https://core.ydev.work";
  constructor(
    private directory: string,
    private vault: CredentialVault,
    private notify: () => void = () => {},
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {
    if (!existsSync(this.path)) return;
    // A damaged/unreadable account file must never revive an older shared token.
    this.managed = true;
    try {
      const saved = envelope.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.serviceUrl = saved.baseUrl;
      this.managed = saved.mode === "account";
      if (!this.managed) return;
      if (saved.interrupted) throw Error("Interrupted session rotation");
      if (saved.encrypted) {
        if (!vault.available()) throw Error("Unavailable vault");
        this.record = recordSchema.parse(
          JSON.parse(vault.decrypt(Buffer.from(saved.encrypted, "base64"))),
        );
        if (this.record.baseUrl !== saved.baseUrl)
          throw Error("Account endpoint mismatch");
        this.sdk = this.provider(this.record.provider);
        this.state = {
          state: "signed_in",
          email: this.record.session.user.email ?? null,
          error: null,
        };
      }
    } catch {
      this.record = undefined;
      this.state = {
        state: "relogin",
        email: null,
        error: "账号会话无法恢复，请重新登录",
      };
    }
  }
  private get path() {
    return join(this.directory, "account.json");
  }
  get enabled() {
    return this.managed;
  }
  get baseUrl() {
    return this.serviceUrl;
  }
  info(): AccountInfo {
    return { ...this.state };
  }
  private save(
    baseUrl: string,
    record?: AccountRecord,
    interrupted = false,
    mode: "account" | "legacy" = "account",
  ) {
    if (record && !this.vault.available())
      throw Error("系统安全存储不可用，不能保存账号");
    const saved = {
      version: 1,
      mode,
      baseUrl,
      interrupted,
      encrypted: record
        ? this.vault.encrypt(JSON.stringify(record)).toString("base64")
        : null,
    };
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(saved), {
        mode: 0o600,
        flag: "wx",
      });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* already renamed */
      }
    }
  }
  private provider(config: z.infer<typeof providerSchema>) {
    return new AuthClient({
      url: config.auth_url,
      headers: { apikey: config.publishable_key },
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "ytriple-" + randomUUID(),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (
          !["/token", "/user", "/logout"].some(
            (path) => url.origin + url.pathname === config.auth_url + path,
          )
        )
          throw Error("身份服务请求地址不匹配");
        try {
          const result = await this.fetcher(input, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          const body = await boundedText(result);
          return new Response(body || null, {
            status: result.status,
            headers: result.headers,
          });
        } catch {
          throw Error("身份服务暂时不可用");
        }
      },
    });
  }
  async signIn(
    baseUrl: string,
    email: string,
    password: string,
    beforeChange: (scope: string) => void,
  ) {
    if (this.record) throw Error("请先退出当前账号");
    if (!this.vault.available()) throw Error("系统安全存储不可用，不能登录");
    baseUrl = endpoint(baseUrl);
    const response = await this.fetcher(baseUrl + "/v1/auth/config", {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || response.headers.get("x-ycore-contract") !== "0.1.0")
      throw Error("当前服务不支持账号登录，请检查服务地址");
    const discovered = z
      .object({ authentication: providerSchema.nullable() })
      .parse(JSON.parse(await boundedText(response)));
    if (!discovered.authentication) throw Error("当前服务尚未启用账号登录");
    const sdk = this.provider(discovered.authentication);
    const { data, error } = await sdk.signInWithPassword({ email, password });
    if (error || !data.session)
      throw Error(
        error?.code === "email_not_confirmed"
          ? "请先验证账号邮箱，再登录"
          : error?.status === 400 || error?.status === 422
            ? "邮箱或密码不正确"
            : "登录失败，请检查网络或稍后重试",
      );
    const record = recordSchema.parse({
      baseUrl,
      provider: discovered.authentication,
      session: data.session,
    });
    let activated = false;
    let candidate: YCore | undefined,
      accessError: string | null = null;
    try {
      candidate = await YCore.forUser(
        baseUrl,
        "ytriple",
        (signal) =>
          activated
            ? this.token(record, signal)
            : Promise.resolve(record.session.access_token),
        this.fetcher,
        record.session.user.id,
      );
    } catch (e) {
      accessError = accessMessage(e);
    }
    try {
      beforeChange(candidate?.scope ?? "account-without-service");
      this.save(baseUrl, record);
    } catch (e) {
      // Login created a provider session, but it was never adopted by this workspace.
      await sdk.admin
        .signOut(record.session.access_token, "local")
        .catch(() => {});
      throw e;
    }
    this.record = record;
    this.sdk = sdk;
    this.managed = true;
    this.serviceUrl = baseUrl;
    this.state = {
      state: "signed_in",
      email: record.session.user.email ?? null,
      error: accessError,
    };
    activated = true;
    this.notify();
    return candidate;
  }
  async connect(): Promise<YCore> {
    const record = this.record;
    if (!record) throw Error("请先登录账号");
    try {
      const client = await YCore.forUser(
        record.baseUrl,
        "ytriple",
        (signal) => this.token(record, signal),
        this.fetcher,
        record.session.user.id,
      );
      this.state.error = null;
      return client;
    } catch (e) {
      if (this.state.state !== "relogin") this.state.error = accessMessage(e);
      throw Error(this.state.error ?? "账号会话不可用，请重新登录");
    } finally {
      this.notify();
    }
  }
  private async token(
    record: AccountRecord,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (this.record !== record || !this.sdk)
      throw Error("账号已退出或变化，请重新连接");
    if (record.session.expires_at * 1000 - this.now() > 60000)
      return record.session.access_token;
    if (!this.refresh) {
      this.refresh = this.rotate(record).finally(() => {
        this.refresh = undefined;
      });
    }
    // Cancelling a caller must not abort an in-flight token rotation shared by other requests.
    const token = await this.refresh;
    signal?.throwIfAborted();
    if (this.record !== record) throw Error("账号已退出或变化，请重新连接");
    return token;
  }
  private async rotate(record: AccountRecord) {
    try {
      // A crash after the provider consumes a refresh token must not replay it on restart.
      this.save(record.baseUrl, undefined, true);
      const { data, error } = await this.sdk!.refreshSession({
        refresh_token: record.session.refresh_token,
      });
      if (error || !data.session) throw Error("刷新失败");
      const session = sessionSchema.parse(data.session);
      if (session.user.id !== record.session.user.id || this.record !== record)
        throw Error("账号变化");
      const next = { ...record, session };
      this.save(record.baseUrl, next);
      record.session = session;
      this.notify();
      return session.access_token;
    } catch {
      this.record = undefined;
      this.sdk = undefined;
      this.state = {
        state: "relogin",
        email: this.state.email,
        error: "账号会话已中断，请重新登录后继续",
      };
      this.notify();
      throw Error(this.state.error!);
    }
  }
  async fetchAccountSummary(): Promise<AccountSummary | null> {
    const record = this.record;
    if (!record || this.state.state !== "signed_in") return null;
    const expectedUserId = record.session.user.id;
    const token = await this.token(record);
    const response = await this.fetcher(record.baseUrl + "/v1/account", {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: "Bearer " + token,
        "X-YCore-Product": "ytriple",
        Accept: "application/json",
      },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      if (this.record !== record || this.state.state !== "signed_in")
        throw Error("账号已变化，忽略过期的账号信息");
      return null;
    }
    const contract = response.headers.get("x-ycore-contract");
    if (contract !== ACCOUNT_CONTRACT)
      throw Error("服务契约版本不匹配，请升级客户端");
    const text = await boundedText(response);
    if (this.record !== record || this.state.state !== "signed_in")
      throw Error("账号已变化，忽略过期的账号信息");
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "账号会话不可用，请重新登录"
          : `账号信息读取失败（${response.status}）`,
      );
    const parsed = accountSummarySchema.parse(JSON.parse(text));
    if (parsed.user_id !== expectedUserId)
      throw Error("服务返回的账号与当前登录不一致");
    return {
      productId: parsed.product_id,
      userId: parsed.user_id,
      accessState: parsed.access_state,
      catalogNote: parsed.catalog_note,
      subscription: parsed.subscription
        ? {
            planId: parsed.subscription.plan_id,
            planName: parsed.subscription.plan_name,
            planVersion: parsed.subscription.plan_version,
            priceId: parsed.subscription.price_id,
            price: parsed.subscription.price
              ? {
                  amountMinor: parsed.subscription.price.amount_minor,
                  currency: parsed.subscription.price.currency,
                  billingPeriod: parsed.subscription.price.billing_period,
                  priced: parsed.subscription.price.priced,
                }
              : null,
            validFrom: parsed.subscription.valid_from,
            validUntil: parsed.subscription.valid_until,
            revision: parsed.subscription.revision,
            revokedAt: parsed.subscription.revoked_at,
          }
        : null,
      entitlement: parsed.entitlement
        ? {
            ownership: parsed.entitlement.ownership,
            dailyRequests: parsed.entitlement.daily_requests,
            dailyBudgetUnits: parsed.entitlement.daily_token_units,
            validUntil: parsed.entitlement.valid_until,
            remainingRequests: parsed.entitlement.remaining_requests,
            remainingBudgetUnits: parsed.entitlement.remaining_budget_units,
          }
        : null,
      usageToday: {
        requests: parsed.usage_today.requests,
        budgetUnits: parsed.usage_today.budget_units,
        note: parsed.usage_today.note,
      },
      catalog: parsed.catalog.map((row) => ({
        planId: String(row.plan_id),
        displayName: String(row.display_name),
        version: Number(row.version),
        prices: Array.isArray(row.prices)
          ? row.prices.map((pr: any) => ({
              priceId: String(pr.price_id),
              amountMinor: pr.amount_minor ?? null,
              currency: pr.currency ?? null,
              billingPeriod: pr.billing_period ?? null,
              priced: Boolean(pr.priced),
            }))
          : [],
      })),
    };
  }
  async signOut(beforeChange: (scope: string) => void) {
    if (this.refresh) await this.refresh.catch(() => {});
    beforeChange("account-signed-out");
    const token = this.record?.session.access_token,
      sdk = this.sdk;
    this.save(this.serviceUrl);
    this.record = undefined;
    this.sdk = undefined;
    this.managed = true;
    this.state = { state: "signed_out", email: null, error: null };
    this.notify();
    if (token && sdk) {
      try {
        const { error } = await sdk.admin.signOut(token, "local");
        if (error) throw error;
      } catch {
        this.state.error =
          "本机已退出；服务端会话撤销未确认，请在账号服务中检查会话";
        this.notify();
      }
    }
  }
  useLegacy(baseUrl: string) {
    if (this.record) throw Error("请先退出账号，再使用访问令牌");
    this.save(endpoint(baseUrl), undefined, false, "legacy");
    this.managed = false;
    this.serviceUrl = endpoint(baseUrl);
    this.state = { state: "signed_out", email: null, error: null };
  }
}
function accessMessage(error: unknown) {
  return error instanceof ServiceError &&
    ["FORBIDDEN", "ENTITLEMENT_REQUIRED"].includes(error.code)
    ? "已登录，当前账号尚无 ytriple 服务权限"
    : error instanceof ServiceError && error.code === "UNAUTHORIZED"
      ? "账号会话不可用，请退出后重新登录"
      : "暂时无法验证服务权限，可稍后检查连接";
}
async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) throw Error("身份服务响应过大");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
