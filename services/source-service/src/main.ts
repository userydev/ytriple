import { createSourceApi, type SourceApi } from "./api.js";
import {
  loadConfig,
  loadRuntimeConfig,
  requireApiConfig,
  type SourceRuntimeConfig,
  type SourceServiceConfig,
} from "./config.js";
import { safeServiceMessage } from "./security.js";
import { SourceDatabase } from "./store/database.js";
import { SourceWorker } from "./worker.js";
import { EditorialWorker } from "./editorial-worker.js";
import {
  EditorialPresentationWorker,
  geminiEditorialPresenter,
} from "./editorial-presentation.js";
import { geminiEditorialModel } from "./editorial-model.js";
import { coverReader } from "./editorial-cover.js";
import {
  EditorialEditionWorker,
  geminiEditionEditor,
} from "./editorial-edition.js";

export type ServiceRole = "api" | "worker" | "all" | "migrate";

async function listen(
  api: SourceApi,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    api.server.once("error", reject);
    api.server.listen(port, host, () => {
      api.server.off("error", reject);
      resolve();
    });
  });
}

export async function runSourceService(
  role: ServiceRole,
  config: SourceRuntimeConfig | SourceServiceConfig,
): Promise<() => Promise<void>> {
  const database = new SourceDatabase(config.databaseURL);
  await database.migrate();
  if (role === "migrate") {
    await database.close();
    return async () => {};
  }

  let api: SourceApi | undefined;
  let worker: SourceWorker | undefined;
  let reading: EditorialWorker | undefined;
  let presentation: EditorialPresentationWorker | undefined;
  let edition: EditorialEditionWorker | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      await api?.close();
      await worker?.stop();
      await reading?.stop();
      await presentation?.stop();
      await edition?.stop();
      await database.close();
    })();
    return closing;
  };
  if (role === "api" || role === "all") {
    api = await createSourceApi(database, requireApiConfig(config));
    await listen(api, config.host, config.port);
  }
  if (role === "worker" || role === "all") {
    worker = new SourceWorker(database, {
      pollMs: config.workerPollMs,
      localDevEgressMode: config.localDevEgressMode,
    });
    const readingKey = process.env.SOURCE_READING_API_KEY;
    const readingModel = process.env.SOURCE_READING_MODEL;
    if (readingKey && readingModel) {
      reading = new EditorialWorker(
        database,
        geminiEditorialModel(readingKey, readingModel),
        readingModel,
      );
      presentation = new EditorialPresentationWorker(
        database,
        geminiEditorialPresenter(readingKey, readingModel),
        readingModel,
      );
      void presentation.start();
      edition = new EditorialEditionWorker(
        database,
        geminiEditionEditor(readingKey, readingModel),
        readingModel,
        coverReader({ localDevEgressMode: config.localDevEgressMode }),
      );
      void edition.start();
      void reading
        .start()
        .catch(() =>
          process.stderr.write("服务器栏目制作暂停；来源采集继续。\n"),
        );
    }
    void worker.start().catch((error) => {
      process.stderr.write(`${safeServiceMessage(error)}\n`);
      process.exitCode = 1;
      void close().catch((closeError) =>
        process.stderr.write(`${safeServiceMessage(closeError)}\n`),
      );
    });
  }
  return close;
}

function parseRole(value: string | undefined): ServiceRole {
  if (
    value === "api" ||
    value === "worker" ||
    value === "all" ||
    value === "migrate"
  )
    return value;
  throw new Error("启动角色必须是 api、worker、all 或 migrate。");
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const role = parseRole(process.argv[2] || "all");
  try {
    const config =
      role === "api" || role === "all" ? loadConfig() : loadRuntimeConfig();
    const close = await runSourceService(role, config);
    if (role !== "migrate") {
      process.stdout.write(
        role === "worker"
          ? "source-service worker ready\n"
          : `source-service ${role} listening on ${config.host}:${config.port}\n`,
      );
      const shutdown = () => {
        void close()
          .catch((error) =>
            process.stderr.write(`${safeServiceMessage(error)}\n`),
          )
          .finally(() => process.exit());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
  } catch (error) {
    process.stderr.write(`${safeServiceMessage(error)}\n`);
    process.exitCode = 1;
  }
}
