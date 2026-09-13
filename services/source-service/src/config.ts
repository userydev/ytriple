import { z } from "zod";
import { HttpUrlSchema, StableIdSchema } from "@ytriple/source-contract";

const RecommendedSourceConfigSchema = z.object({
  id: StableIdSchema,
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  url: HttpUrlSchema,
  refreshIntervalMinutes: z.number().int().min(5).max(10_080),
  enabledByDefault: z.boolean().default(true),
});

export type RecommendedSourceConfig = z.infer<
  typeof RecommendedSourceConfigSchema
>;

const DEFAULT_RECOMMENDED_SOURCES: RecommendedSourceConfig[] = [
  {
    id: "openai-agents-js-changelog",
    name: "OpenAI Agents JS 更新",
    category: "开发工具",
    description: "OpenAI Agents JS 官方仓库发布的 SDK 变更记录。",
    url: "https://raw.githubusercontent.com/openai/openai-agents-js/main/packages/agents/CHANGELOG.md",
    refreshIntervalMinutes: 360,
    enabledByDefault: true,
  },
  {
    id: "huggingface-blog-feed",
    name: "Hugging Face Blog",
    category: "AI 与模型",
    description:
      "Hugging Face 发布的模型、开源工具和实践文章；保留作者原文入口。",
    url: "https://huggingface.co/blog/feed.xml",
    refreshIntervalMinutes: 60,
    enabledByDefault: true,
  },
  {
    id: "github-changelog-feed",
    name: "GitHub Changelog",
    category: "开发工具",
    description: "GitHub 官方发布的开发工具与平台更新。",
    url: "https://github.blog/changelog/feed/",
    refreshIntervalMinutes: 60,
    enabledByDefault: true,
  },
  {
    id: "sspai-feed",
    name: "少数派",
    category: "数字生活与方法",
    description: "少数派公开订阅中的应用、工作方法和数字生活文章。",
    url: "https://sspai.com/feed",
    refreshIntervalMinutes: 60,
    enabledByDefault: true,
  },
  {
    id: "solidot-feed",
    name: "Solidot",
    category: "科技与新知",
    description: "Solidot 公开科技、科学与开源资讯。",
    url: "https://www.solidot.org/index.rss",
    refreshIntervalMinutes: 60,
    enabledByDefault: true,
  },
  {
    id: "federal-reserve-monetary",
    name: "美联储货币政策",
    category: "金融与宏观",
    description: "美联储官方货币政策声明与会议纪要；解释公开信息及条件。",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    refreshIntervalMinutes: 180,
    enabledByDefault: true,
  },
  {
    id: "nvidia-newsroom",
    name: "NVIDIA 官方动态",
    category: "科技与公司业绩",
    description: "NVIDIA 原始产品与公司公告；厂商陈述与独立验证分别标明。",
    url: "https://nvidianews.nvidia.com/releases.xml",
    refreshIntervalMinutes: 120,
    enabledByDefault: true,
  },
];

const LocalDevEgressModeSchema = z.literal("orbstack-loopback");

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function requireLoopbackDevelopment(
  config: { host: string; localDevEgressMode?: "orbstack-loopback" },
  context: z.RefinementCtx,
): void {
  if (config.localDevEgressMode && !isLoopbackHost(config.host))
    context.addIssue({
      code: "custom",
      path: ["localDevEgressMode"],
      message: "OrbStack development egress requires an explicit loopback host",
    });
}

const RuntimeConfigFields = {
  databaseURL: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  workerPollMs: z.number().int().min(25).max(60_000),
  localDevEgressMode: LocalDevEgressModeSchema.optional(),
};

const RuntimeConfigSchema = z
  .object(RuntimeConfigFields)
  .superRefine(requireLoopbackDevelopment);

const ConfigSchema = z
  .object({
    ...RuntimeConfigFields,
    bootstrapToken: z.string().min(12),
    tokenSecret: z.string().min(32),
    cursorSecret: z.string().min(32),
    pairingEnabled: z.boolean(),
    recommendedDefaultsEnabled: z.boolean().optional(),
    recommendedSources: z
      .array(RecommendedSourceConfigSchema)
      .max(100)
      .optional(),
  })
  .superRefine(requireLoopbackDevelopment);

export type SourceRuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type SourceServiceConfig = z.infer<typeof ConfigSchema>;

function values(env: NodeJS.ProcessEnv) {
  const pairingEnabled =
    env.SOURCE_PAIRING_ENABLED === undefined
      ? true
      : env.SOURCE_PAIRING_ENABLED === "true"
        ? true
        : env.SOURCE_PAIRING_ENABLED === "false"
          ? false
          : env.SOURCE_PAIRING_ENABLED;
  const recommendedDefaultsEnabled =
    env.SOURCE_RECOMMENDED_DEFAULTS_ENABLED === undefined
      ? true
      : env.SOURCE_RECOMMENDED_DEFAULTS_ENABLED === "true"
        ? true
        : env.SOURCE_RECOMMENDED_DEFAULTS_ENABLED === "false"
          ? false
          : env.SOURCE_RECOMMENDED_DEFAULTS_ENABLED;
  let recommendedSources: unknown = DEFAULT_RECOMMENDED_SOURCES;
  if (env.SOURCE_RECOMMENDED_SOURCES_JSON !== undefined)
    try {
      recommendedSources = JSON.parse(env.SOURCE_RECOMMENDED_SOURCES_JSON);
    } catch {
      recommendedSources = env.SOURCE_RECOMMENDED_SOURCES_JSON;
    }
  return {
    databaseURL: env.SOURCE_DATABASE_URL,
    host: env.SOURCE_HOST || "127.0.0.1",
    port: Number(env.SOURCE_PORT || 47321),
    bootstrapToken: env.SOURCE_BOOTSTRAP_TOKEN,
    tokenSecret: env.SOURCE_TOKEN_SECRET,
    cursorSecret: env.SOURCE_CURSOR_SECRET,
    pairingEnabled,
    recommendedDefaultsEnabled,
    recommendedSources,
    workerPollMs: Number(env.SOURCE_WORKER_POLL_MS || 250),
    localDevEgressMode: env.SOURCE_LOCAL_DEV_EGRESS_MODE,
  };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `信息源服务配置不完整：${[...new Set(fields)].join("、")}。`,
    );
  }
  return result.data;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): SourceServiceConfig {
  return parse(ConfigSchema, values(env));
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SourceRuntimeConfig {
  return parse(RuntimeConfigSchema, values(env));
}

export function requireApiConfig(
  config: SourceRuntimeConfig | SourceServiceConfig,
): SourceServiceConfig {
  return parse(ConfigSchema, config);
}
