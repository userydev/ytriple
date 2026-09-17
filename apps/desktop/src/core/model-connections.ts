import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  directProfile,
  normalizeEndpoint,
  type DirectProfile,
  type ModelInfo,
} from "./model-contract";
import { DirectModel } from "./direct-model";
import type { Store } from "./store";
import type { Model } from "./ycore";
export type CredentialVault = {
  available: () => boolean;
  encrypt: (text: string) => Buffer;
  decrypt: (buffer: Buffer) => string;
};
const savedSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["service", "direct"]),
    profile: directProfile.nullable(),
    encrypted: z.string().max(32000).nullable(),
  })
  .strict();
export class ModelConnections {
  private mode: "service" | "direct" = "service";
  private direct: DirectModel | undefined;
  private token = "";
  private testedAt: string | null = null;
  private error: string | null = null;
  constructor(
    private store: Store,
    private directory: string,
    private vault: CredentialVault,
    private service: () => Model | undefined,
    environment?: { profile: DirectProfile; token: string },
  ) {
    const path = join(directory, "model.json");
    if (existsSync(path)) {
      try {
        const saved = savedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        this.mode = saved.mode;
        if (saved.profile) {
          if (saved.encrypted && !vault.available())
            throw Error("系统安全存储不可用");
          this.token = saved.encrypted
            ? vault.decrypt(Buffer.from(saved.encrypted, "base64"))
            : "";
          this.direct = new DirectModel(store, saved.profile, this.token);
        }
      } catch {
        this.mode = "direct";
        this.error = "模型配置无法读取，请重新配置；未自动切换其他服务";
      }
    } else if (environment) {
      this.mode = "direct";
      try {
        this.direct = new DirectModel(
          store,
          environment.profile,
          environment.token,
        );
        this.token = environment.token;
      } catch {
        this.error = "本机启动提供的模型配置无效，请在设置中核对";
      }
    }
  }
  info(): ModelInfo {
    return {
      mode: this.mode,
      configured: this.mode === "direct" ? !!this.direct : !!this.service(),
      label:
        this.mode === "direct"
          ? (this.direct?.profile.model ?? "自带 API 未配置")
          : "ycore 共享模型",
      direct: this.direct?.profile ?? null,
      testedAt: this.testedAt,
      error: this.error,
    };
  }
  model(): Model {
    const model = this.mode === "direct" ? this.direct : this.service();
    if (!model)
      throw Error(
        this.mode === "direct"
          ? "请先在设置中配置自带 API"
          : "请先连接 ycore，或选择自带 API",
      );
    return model;
  }
  private persist(
    mode: "service" | "direct",
    direct = this.direct,
    token = this.token,
  ) {
    if (token && !this.vault.available())
      throw Error("系统安全存储不可用，不能保存 API Key");
    const value = {
      version: 1,
      mode,
      profile: direct?.profile ?? null,
      encrypted: token ? this.vault.encrypt(token).toString("base64") : null,
    };
    const temp = join(this.directory, `.model-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temp, join(this.directory, "model.json"));
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  save(
    profile: DirectProfile,
    token: string,
    noKey: boolean,
    assertChange: (scope: string) => void,
  ) {
    const normalized = {
      ...directProfile.parse(profile),
      baseUrl: normalizeEndpoint(profile.baseUrl),
    };
    const secret = noKey
      ? ""
      : token ||
        (this.direct?.profile.baseUrl === normalized.baseUrl ? this.token : "");
    if (!secret && !noKey)
      throw Error("请输入 API Key；更换接口地址时需要重新填写");
    const candidate = new DirectModel(this.store, normalized, secret);
    assertChange(candidate.scope);
    this.persist("direct", candidate, secret);
    this.direct = candidate;
    this.token = secret;
    this.mode = "direct";
    this.testedAt = null;
    this.error = null;
    return this.info();
  }
  select(mode: "service" | "direct", assertChange: (scope: string) => void) {
    const candidate = mode === "direct" ? this.direct : this.service();
    if (!candidate?.scope) throw Error("先配置要使用的模型连接");
    assertChange(candidate.scope);
    this.persist(mode);
    this.mode = mode;
    this.testedAt = null;
    this.error = null;
    return this.info();
  }
  async test() {
    const model = this.model();
    const key = `connection-test-${randomUUID()}`;
    try {
      let completed = false;
      for await (const event of model.stream(
        {
          taskId: key,
          messages: [{ role: "user", content: "Reply with only OK." }],
          refs: [],
        },
        key,
        AbortSignal.timeout(30000),
      )) {
        if (event.type === "run.completed") completed = true;
        if (event.type === "run.failed") throw Error("模型测试调用失败");
      }
      if (!completed) throw Error("未收到模型完成状态");
      this.testedAt = new Date().toISOString();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "模型测试失败";
      throw e;
    }
    return this.info();
  }
}
