import {
  WorkbenchService,
  safeError,
  type InternalCommand,
} from "../core/service.js";
import type { ModelProfile } from "../shared/types.js";
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
  };
  try {
    let value: unknown;
    if (request.type === "initialize") {
      keys = request.keys || {};
      service = new WorkbenchService(request.dataPath!, readKey, (snapshot) =>
        port.postMessage({ type: "snapshot", snapshot }),
      );
      value = await service.initialize();
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
