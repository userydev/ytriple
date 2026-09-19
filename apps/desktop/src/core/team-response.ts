import { z } from "zod";
import {
  filterPublicFeedback,
  type InputManifest,
} from "./input-manifest";
import type { OutputMode, Run } from "./types";

export const TEAM_RESPONSE_PROTOCOL = "team-response-v1";

const artifactSchema = z
  .object({
    body: z.string().min(1).max(160000),
    baseVersionId: z.string().uuid().nullable(),
  })
  .strict();

const publicFeedbackSchema = z
  .object({
    sourceId: z.string().min(1).max(320),
    stance: z.enum(["used", "not_used", "clarify", "unchecked"]),
    note: z.string().max(1000).optional(),
  })
  .strict();

const publicProcessSchema = z
  .object({
    version: z.literal(1).optional(),
    basis: z.string().max(2000).optional(),
    uncertainties: z.array(z.string().max(500)).max(8).optional(),
    feedback: z.array(publicFeedbackSchema).max(12).optional(),
  })
  .strict();

const responseSchema = z
  .object({
    answer: z.string().min(1).max(160000),
    artifact: z.union([artifactSchema, z.null()]),
    public: publicProcessSchema.optional(),
  })
  .strict();

export type PublicProcessMeta = {
  version?: 1;
  basis?: string;
  uncertainties?: string[];
  feedback?: {
    sourceId: string;
    stance: "used" | "not_used" | "clarify" | "unchecked";
    note?: string;
  }[];
};

export type TeamResponsePayload = {
  answer: string;
  artifact: z.infer<typeof artifactSchema> | null;
  public?: PublicProcessMeta;
  publicWarnings?: string[];
};

export function usesTeamResponseProtocol(mode: OutputMode | undefined) {
  return (
    mode === undefined ||
    mode === "result" ||
    mode === "explanation"
  );
}

export function appliesTeamResponseProtocol(run: Run) {
  return (
    run.responseProtocol === TEAM_RESPONSE_PROTOCOL &&
    usesTeamResponseProtocol(run.outputMode)
  );
}

export function teamResponseOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ytriple_response: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string", minLength: 1 },
          artifact: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  body: { type: "string", minLength: 1 },
                  baseVersionId: {
                    anyOf: [
                      { type: "null" },
                      { type: "string", format: "uuid" },
                    ],
                  },
                },
                required: ["body", "baseVersionId"],
              },
            ],
          },
          public: {
            type: "object",
            additionalProperties: false,
            properties: {
              version: { type: "integer", enum: [1] },
              basis: { type: "string" },
              uncertainties: { type: "array", items: { type: "string" } },
              feedback: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sourceId: { type: "string" },
                    stance: {
                      type: "string",
                      enum: ["used", "not_used", "clarify", "unchecked"],
                    },
                    note: { type: "string" },
                  },
                  required: ["sourceId", "stance"],
                },
              },
            },
          },
        },
        required: ["answer", "artifact"],
      },
    },
    required: ["ytriple_response"],
  };
}

export function teamResponseInstruction(
  run: Run,
  options: { finalStage: boolean; allowsArtifact: boolean },
) {
  if (!appliesTeamResponseProtocol(run) || !options.finalStage) return "";
  const bound = JSON.stringify(run.baseVersionId ?? null);
  const artifactNull = "null";
  const artifactExample =
    options.allowsArtifact && run.outputMode !== "explanation"
      ? `{"body":"完整候选正文","baseVersionId":${bound}}`
      : artifactNull;
  return (
    "本轮负责人向用户交付的最后输出必须是且仅是一个 JSON 对象：" +
    `{"ytriple_response":{"answer":"对用户可见的完整回答","artifact":${artifactNull},"public":{"version":1,"basis":"可选简短依据","uncertainties":["可选不确定性"],"feedback":[{"sourceId":"输入清单中的准确ID","stance":"used|not_used|clarify|unchecked","note":"可选说明"}]}}}。` +
    "这是公开说明摘要，不能声称提供内部思维链。answer只写对用户的结论与待决定事项；依据和不确定性放入public。public 整段可省略；feedback.sourceId 必须来自本轮实际输入清单，非法引用会被丢弃且不会扩大权限。" +
    "解释、讨论、追问、不修改主成果时 artifact 必须为 JSON null（不是字符串 \"null\"）。" +
    (options.allowsArtifact && run.outputMode !== "explanation"
      ? `仅当明确产出或修订主成果时，artifact 为 ${artifactExample}，其中 baseVersionId 必须等于本轮绑定的 ${bound}；`
      : "本轮不允许提交 artifact；") +
    (run.workflowCandidateSource ? '这是用户主动准备的流程候选提炼轮。answer 内先给简短说明，再给一个 JSON 对象：{"ytriple_workflow_candidate":{"name":"流程名称","targetWorkflowId":"新的英文数字连字符标识","executionStrategy":"fixed-stages","stages":[{"role":"现有成员标识","objective":"步骤目标","result":true}],"applicability":"适用与不适用范围","unverified":["待验证项"],"sourceNotes":"来源记录与限制"}}。仅最后一步 result 为 true；不得添加工具或成员。若用 adaptive-delegation，另附 delegation:{maxTasks:1至8,maxDepth:1至3}；固定步骤不得附 delegation。候选体现复盘发现，不能用复制旧配置冒充改进。artifact 必须 null。' : "") +
    `YTRIPLE_BOUND_BASE=${bound}\n` +
    "answer 必须是可读正文，不要把控制 JSON 混入 answer。中间步骤仍输出普通公开文本，不使用此对象。"
  );
}

function parseCoreResponse(value: unknown, run: Run, required: boolean) {
  if (!value || typeof value !== "object" || !("ytriple_response" in value))
    throw Error("响应协议缺少 ytriple_response，不会自动发布成果");
  if (Object.keys(value).some(k => k !== "ytriple_response"))
    throw Error("响应协议含未知控制字段");
  const raw = (value as { ytriple_response: unknown }).ytriple_response;
  const core = z
    .object({
      answer: z.string().min(1).max(160000),
      artifact: z.union([artifactSchema, z.null()]),
      public: z.unknown().optional(),
    })
    .strict()
    .safeParse(raw);
  if (!core.success)
    throw Error("响应协议字段不符合要求，已保留输出，不会自动发布成果");
  const payload = core.data;
  if (run.outputMode === "explanation" && payload.artifact !== null)
    throw Error("解释轮次不能提交主成果候选");
  if (payload.artifact) {
    const bound = run.baseVersionId ?? null;
    if (payload.artifact.baseVersionId !== bound)
      throw Error("主成果候选绑定的版本不是本轮基准，已拒绝");
  }
  if (!payload.answer.trim() && required) return null;
  return payload;
}

export function parseTeamResponse(
  body: string,
  run: Run,
  required: boolean,
  manifest?: InputManifest,
): TeamResponsePayload | null {
  const trimmed = body.trim();
  if (!trimmed) return required ? null : { answer: "", artifact: null };
  if (!appliesTeamResponseProtocol(run)) {
    if (required) return null;
    return { answer: trimmed, artifact: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw Error("响应协议格式不完整，已保留输出，不会自动发布成果");
  }
  const payload = parseCoreResponse(value, run, required);
  if (!payload) return required ? null : { answer: "", artifact: null };
  const warnings: string[] = [];
  let publicMeta: PublicProcessMeta | undefined;
  const raw = (value as { ytriple_response: Record<string, unknown> })
    .ytriple_response;
  if (raw.public !== undefined) {
    const parsed = publicProcessSchema.safeParse(raw.public);
    if (!parsed.success) warnings.push("公开说明附属字段无效，已忽略");
    else {
      const filtered = filterPublicFeedback(manifest, parsed.data.feedback);
      if (filtered.rejected.length)
        warnings.push(
          `以下反馈引用不在本轮输入清单：${filtered.rejected.join("、")}`,
        );
      publicMeta = {
        basis: parsed.data.basis,
        uncertainties: parsed.data.uncertainties,
        feedback: filtered.accepted.length ? filtered.accepted : undefined,
      };
    }
  }
  return {
    answer: payload.answer,
    artifact: payload.artifact,
    public: publicMeta,
    publicWarnings: warnings.length ? warnings : undefined,
  };
}

export function teamResponse(
  answer: string,
  artifact: null | { body: string; baseVersionId: string | null } = null,
  publicMeta?: PublicProcessMeta,
) {
  return JSON.stringify({
    ytriple_response: {
      answer,
      artifact,
      ...(publicMeta ? { public: publicMeta } : {}),
    },
  });
}

export function publicAnswer(body: string, run: Run): string {
  if (!appliesTeamResponseProtocol(run)) return body;
  try {
    return parseTeamResponse(body, run, true)!.answer;
  } catch {
    const t = body.trimStart();
    if (t.startsWith("{") || t.includes('"ytriple_response"'))
      return "本轮回答未能解析为可读内容，请查看运行详情。";
    return body;
  }
}

export function displayContributionBody(body: string, run: Run): string {
  if (run.workflowCandidateSource) {
    const answer = publicAnswer(body, run);
    return answer.split("{")[0].trim() || "可执行流程数据请在来源复盘的候选预览中查看。";
  }
  if (/^\s*\{/.test(body) && !body.includes('"ytriple_response"')) return "协作控制记录；实际执行状态见宿主记录。";
  if (!appliesTeamResponseProtocol(run)) return body;
  return publicAnswer(body, run);
}

export function attachPublicProcessToContribution(
  store: import("./store").Store,
  run: Run,
  contributionId: string,
) {
  const c = store.get<import("./types").Contribution>(
    "contribution",
    contributionId,
  );
  if (!c?.body.trim()) return;
  const manifest = c.inputManifestId
    ? store.get<InputManifest>("input-manifest", c.inputManifestId)
    : undefined;
  try {
    const parsed = parseTeamResponse(c.body, run, true, manifest ?? undefined);
    if (!parsed) return;
    store.put("contribution", contributionId, {
      ...c,
      publicProcess: parsed.public,
      publicProcessWarnings: parsed.publicWarnings,
    });
  } catch {
    /* 保留原始正文，由 finish 处理协议错误 */
  }
}
