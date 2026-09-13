import {
  WorkbenchService,
  safeError,
  type InternalCommand,
} from "../core/service.js";
import type { ModelProfile } from "../shared/types.js";
import { HttpSourceGateway } from "../core/source-gateway.js";
import {
  WorkGateway,
  WorkConnectionSchema,
  loginWorkService,
  keyForWorkProfile,
  type WorkConnection,
} from "../core/work-gateway.js";
import {
  pairSourceService,
  SourceConnectionSchema,
  type SourceConnection,
} from "../core/source-connection.js";
const port = (
  process as NodeJS.Process & {
    parentPort: {
      on(name: string, fn: (event: { data: unknown }) => void): void;
      postMessage(message: unknown): void;
    };
  }
).parentPort;
let service: WorkbenchService | undefined;
let keys: Record<string, string> = {};
let workConnection: WorkConnection | undefined;
const readKey = (profile: ModelProfile) =>
  keyForWorkProfile(workConnection, profile) ||
  keys[profile.id] ||
  (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);
port.on("message", async ({ data }) => {
  const request = data as {
    id: number;
    type: string;
    dataPath?: string;
    keys?: Record<string, string>;
    profileId?: string;
    apiKey?: string;
    command?: InternalCommand;
    sourceConnection?: SourceConnection;
    workConnection?: WorkConnection;
    login?: {
      baseURL: string;
      username: string;
      password: string;
      deviceName: string;
    };
    pairing?: { baseURL: string; bootstrapToken?: string; pairingId: string };
  };
  try {
    let value: unknown;
    if (request.type === "initialize") {
      keys = request.keys || {};
      const savedSource = keys["__source_service__"]
        ? SourceConnectionSchema.parse(JSON.parse(keys["__source_service__"]))
        : undefined;
      delete keys["__source_service__"];
      workConnection = keys["__work_service__"]
        ? WorkConnectionSchema.parse(JSON.parse(keys["__work_service__"]))
        : undefined;
      delete keys["__work_service__"];
      const sourceURL = savedSource?.baseURL ?? process.env.YTRIPLE_SOURCE_URL;
      const sourceToken =
        savedSource?.token ?? process.env.YTRIPLE_SOURCE_TOKEN;
      const sourceTenantId =
        savedSource?.tenantId ?? process.env.YTRIPLE_SOURCE_TENANT_ID;
      if (
        [sourceURL, sourceToken, sourceTenantId].some(Boolean) &&
        ![sourceURL, sourceToken, sourceTenantId].every(Boolean)
      )
        throw new Error("信息源服务需要同时配置 URL、设备令牌和租户 ID。");
      service = new WorkbenchService(
        request.dataPath!,
        readKey,
        (snapshot) => port.postMessage({ type: "snapshot", snapshot }),
        {
          ...(sourceURL && sourceToken && sourceTenantId
            ? {
                autoDigestRadar: false,
                sourceServiceURL: sourceURL,
                sourceGateway: new HttpSourceGateway({
                  baseURL: sourceURL,
                  token: sourceToken,
                  tenantId: sourceTenantId,
                  timeoutMs: Number(
                    process.env.YTRIPLE_SOURCE_TIMEOUT_MS || 300_000,
                  ),
                }),
              }
            : { autoDigestRadar: false }),
          workGateway: workConnection
            ? new WorkGateway(workConnection)
            : undefined,
        },
      );
      value = await service.initialize();
    } else if (request.type === "work.login") {
      const { baseURL, ...input } = request.login!;
      value = await loginWorkService(baseURL, input);
    } else if (request.type === "work.connect" && service) {
      await service.runtime.stopAll();
      workConnection = WorkConnectionSchema.parse(request.workConnection);
      value = await service.connectWorkService(new WorkGateway(workConnection));
    } else if (request.type === "work.logout" && service) {
      let revokeUnconfirmed = false;
      await service.runtime.stopAll();
      if (workConnection) {
        const gateway = new WorkGateway(workConnection);
        try {
          await gateway.request("/v1/auth/logout", "POST", {});
        } catch {
          revokeUnconfirmed = true;
        } finally {
          gateway.close();
        }
      }
      workConnection = undefined;
      value = await service.disconnectWorkService(
        revokeUnconfirmed
          ? "本机已退出，远端撤销未确认；可在服务恢复后通过其他已登录设备撤销此设备。"
          : undefined,
      );
    } else if (request.type === "source.pair") {
      value = await pairSourceService(request.pairing!);
    } else if (request.type === "source.connect" && service) {
      const connection = SourceConnectionSchema.parse(request.sourceConnection);
      value = await service.connectSourceService(
        new HttpSourceGateway(connection),
        connection.baseURL,
      );
    } else if (request.type === "key") {
      if (request.apiKey) keys[request.profileId!] = request.apiKey;
      else delete keys[request.profileId!];
    } else if (request.type === "close") {
      await service?.close();
      service = undefined;
    } else if (request.type === "command" && service)
      value = await service.execute(request.command!);
    else throw new Error("工作引擎还未准备好。");
    port.postMessage({ id: request.id, value });
  } catch (error) {
    let message = safeError(error);
    for (const key of [
      workConnection?.token ?? "",
      request.login?.password ?? "",
      ...Object.values(keys),
      ...Object.entries(process.env)
        .filter(([name]) => /API_KEY|TOKEN|SECRET/.test(name))
        .map(([, v]) => v || ""),
    ])
      if (key.length > 5) message = message.split(key).join("[已隐藏密钥]");
    port.postMessage({ id: request.id, error: message });
  }
});
