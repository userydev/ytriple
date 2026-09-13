import {
  WorkbenchService,
  safeError,
  type InternalCommand,
} from "../core/service.js";
import type { ModelProfile } from "../shared/types.js";
import { HttpSourceGateway } from "../core/source-gateway.js";
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
const readKey = (profile: ModelProfile) =>
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
        sourceURL && sourceToken && sourceTenantId
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
          : { autoDigestRadar: false },
      );
      value = await service.initialize();
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
      ...Object.values(keys),
      ...Object.entries(process.env)
        .filter(([name]) => /API_KEY|TOKEN|SECRET/.test(name))
        .map(([, v]) => v || ""),
    ])
      if (key.length > 5) message = message.split(key).join("[已隐藏密钥]");
    port.postMessage({ id: request.id, error: message });
  }
});
