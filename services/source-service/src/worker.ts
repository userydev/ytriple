import { setTimeout as delay } from "node:timers/promises";
import {
  SourceApiErrorCodeSchema,
  type SourceApiErrorCode,
} from "@ytriple/source-contract";
import { fetchSourceItems } from "./connectors/feed.js";
import { fetchAndNormalizePublicURL } from "./connectors/public-url.js";
import {
  JobLeaseLostError,
  SourceDatabase,
  type NormalizedPublicItem,
  type StoredJob,
} from "./store/database.js";
import { safeServiceMessage } from "./security.js";

export type PublicURLFetcher = (url: string) => Promise<NormalizedPublicItem>;

export type WorkerOptions = {
  fetcher?: PublicURLFetcher;
  localDevEgressMode?: "orbstack-loopback";
  pollMs?: number;
  leaseSeconds?: number;
  leaseHeartbeatMs?: number;
};

const connectorCodes = new Set<SourceApiErrorCode>([
  "INVALID_SOURCE_URL",
  "SOURCE_URL_BLOCKED",
  "SOURCE_TOO_LARGE",
  "SOURCE_TIMEOUT",
  "SOURCE_REDIRECT_LIMIT",
  "SOURCE_HTTP_ERROR",
  "SOURCE_UNSUPPORTED_CONTENT",
  "SOURCE_CONTENT_UNREADABLE",
]);

function normalizedFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "SOURCE_FETCH_FAILED";
  const parsedCode = SourceApiErrorCodeSchema.safeParse(rawCode);
  const code =
    parsedCode.success && connectorCodes.has(parsedCode.data)
      ? parsedCode.data
      : "SOURCE_FETCH_FAILED";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  const retryable =
    code === "SOURCE_TIMEOUT" ||
    (code === "SOURCE_HTTP_ERROR" &&
      (status === undefined ||
        status === 408 ||
        status === 429 ||
        status >= 500));
  return {
    code,
    message:
      code === "SOURCE_FETCH_FAILED"
        ? "信息源刷新失败。"
        : safeServiceMessage(error),
    retryable,
  };
}

export class SourceWorker {
  private stopping = false;
  private running?: Promise<void>;
  private readonly fetcher: PublicURLFetcher;
  private readonly sourceFetcher: (
    url: string,
  ) => Promise<NormalizedPublicItem[]>;
  private readonly pollMs: number;
  private readonly leaseSeconds: number;
  private readonly leaseHeartbeatMs: number;

  constructor(
    private readonly database: SourceDatabase,
    options: WorkerOptions = {},
  ) {
    this.fetcher =
      options.fetcher ||
      ((url) =>
        fetchAndNormalizePublicURL(url, {
          localDevEgressMode: options.localDevEgressMode,
        }));
    this.sourceFetcher = options.fetcher
      ? async (url) => [await options.fetcher!(url)]
      : (url) =>
          fetchSourceItems(url, {
            localDevEgressMode: options.localDevEgressMode,
          });
    this.pollMs = options.pollMs || 250;
    this.leaseSeconds = options.leaseSeconds || 45;
    this.leaseHeartbeatMs =
      options.leaseHeartbeatMs ||
      Math.max(1_000, Math.floor((this.leaseSeconds * 1_000) / 3));
  }

  async processOne(): Promise<boolean> {
    await this.database.scheduleDueFollows();
    const job = await this.database.claimJob(this.leaseSeconds);
    if (!job) return false;
    await this.process(job);
    return true;
  }

  start(): Promise<void> {
    if (this.running) return this.running;
    this.stopping = false;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const processed = await this.processOne();
      if (!processed) await delay(this.pollMs, undefined, { ref: true });
    }
  }

  private async process(job: StoredJob): Promise<void> {
    const heartbeatController = new AbortController();
    let leaseOwned = true;
    const heartbeat = this.maintainLease(job, heartbeatController.signal).then(
      (owned) => {
        leaseOwned = owned;
      },
      () => {
        leaseOwned = false;
      },
    );
    try {
      if (!job.sourceURL) throw new Error("刷新作业缺少来源地址。");
      let items: NormalizedPublicItem[];
      try {
        items = job.followId
          ? await this.sourceFetcher(job.sourceURL)
          : [await this.fetcher(job.sourceURL)];
      } catch (error) {
        if (leaseOwned)
          await this.database.failJob(job, normalizedFailure(error));
        return;
      }
      if (leaseOwned)
        try {
          await this.database.completeItems(job, items);
        } catch (error) {
          if (!(error instanceof JobLeaseLostError)) throw error;
        }
    } finally {
      heartbeatController.abort();
      await heartbeat;
    }
  }

  private async maintainLease(
    job: StoredJob,
    signal: AbortSignal,
  ): Promise<boolean> {
    while (!signal.aborted) {
      try {
        await delay(this.leaseHeartbeatMs, undefined, { signal, ref: true });
      } catch (error) {
        if (signal.aborted) return true;
        throw error;
      }
      if (!(await this.database.renewJobLease(job, this.leaseSeconds)))
        return false;
    }
    return true;
  }
}
