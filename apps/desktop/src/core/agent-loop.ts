import { delegationKey, parseDelegation } from "./agent-controls";
import { parseDecision } from "./decisions";
import {
  availableSkills,
  parseSkillRequest,
  skillKey,
  type SkillUse,
} from "./skill-contract";
import { memberTools, parseToolRequest, toolRecordText } from "./tool-contract";
import { memberCanReadMaterials } from "./agent-prompt";
import { teamResponseInstruction } from "./team-response";
import type { AgentHost } from "./agent-host";
import type { Contribution, Member, Reference } from "./types";
import type { Prompt } from "./ycore";

export class AwaitingDecision extends Error {}

export async function runMemberTask(
  host: AgentHost,
  input: {
    key: string;
    member: Member;
    objective: string;
    context: string;
    refs: Reference[];
    depth: number;
    stage: number;
    parentId?: string;
    finalStage?: boolean;
    allowsArtifact?: boolean;
  },
): Promise<Contribution> {
  let returns = "";
  let toolReturns = "";
  let toolFormatCorrectionUsed = false;
  let returnedFrom: string | undefined;
  const policy = host.delegationPolicy();
  const methods = availableSkills(host.run, input.member);
  const uses: SkillUse[] = (host.run.requestedSkillKeys ?? []).map((key) => ({
    key,
    purpose: `用户指定，用于本任务：${input.objective}`,
    source: "requested",
  }));
  const allowsDelegation = host.kernel.allowsDelegation(
    host.strategyId,
    host.run,
  );
  const maxTurns =
    policy.maxTasks +
    (methods.length ? 4 : 0) +
    (host.run.tools?.maxCalls ?? 0) +
    2;
  for (let turn = 0; turn <= maxTurns; turn++) {
    if (host.signal.aborted) throw new DOMException("已停止", "AbortError");
    const callKey = `${input.key}:t${turn}`;
    const answers = host.answeredDecisions();
    const attempt = answers.filter((d) => d.taskKey === callKey).length;
    if (attempt > 8) throw new Error("此子任务已多次等待答复，请调整目标后再继续");
    const id = `${callKey}:a${attempt}`;
    let c = host.loadContribution(id);
    if (!c) {
      c = {
        id,
        remoteKey: delegationKey(id),
        workId: host.run.workId,
        runId: host.run.id,
        memberId: input.member.id,
        memberName: input.member.name,
        objective: input.objective,
        body: "",
        status: "running",
        remoteId: null,
        error: null,
        createdAt: new Date().toISOString(),
        task: {
          key: input.key,
          stage: input.stage,
          depth: input.depth,
          parentId: input.parentId,
          returnedFrom,
          refs: input.refs,
        },
      };
      host.saveContribution(c);
      const system = host.kernel.buildSystemPrompt({
        run: host.run,
        member: input.member,
        depth: input.depth,
        uses,
        strategyId: host.strategyId,
      });
      const prompt: Prompt = {
        taskId: id,
        refs: [],
        messages: [
          {
            role: "system",
            content: [
              system,
              teamResponseInstruction(host.run, {
                finalStage:
                  input.finalStage ?? (input.depth === 0 &&
                  (!!host.run.recipient ||
                    input.stage === host.run.workflow.stages.length - 1)),
                allowsArtifact:
                  input.allowsArtifact ?? (!host.run.recipient &&
                  !!host.run.workflow.stages[input.stage]?.result),
              }),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          {
            role: "user",
            content: host.kernel.buildUserPrompt({
              objective: input.objective,
              context: input.context,
              materials: host.formatMaterials(
                input.refs,
                memberCanReadMaterials(host.run, input.member),
              ),
              toolReturns,
              delegationReturns: returns,
              decisionLines: host
                .answeredDecisions(input.key + ":t")
                .map((d) => `问题：${d.question}\n答复：${d.answer}`)
                .join("\n\n"),
            }),
          },
        ],
      };
      c = { ...c, skills: structuredClone(uses) };
      host.saveContribution(c);
      const protocol = host.run.tools?.keys.length
        ? "team-tools-v1"
        : "team-methods-v1";
      const streamed = await host.streamModel(c, prompt, c.remoteKey!, protocol);
      c = streamed.contribution;
    }
    if (c.status === "failed" && input.depth > 0) return c;
    if (c.status !== "succeeded")
      throw new Error("子任务仍未确认完成；请核对原运行，不重复调用");
    if (c.toolFormatError) {
      if (
        host.kernel.loopPolicy.afterToolFormatError(toolFormatCorrectionUsed) ===
        "terminate"
      )
        throw new Error(c.toolFormatError.message);
      toolFormatCorrectionUsed = true;
      toolReturns += `\n记录 ${c.id}\n${c.toolFormatError.message}\n`;
      continue;
    }
    // Only a whole top-level control response can request an action. JSON in
    // a user-visible answer is data, even when it looks like a tool request.
    const body = c.body;
    let toolRequest: ReturnType<typeof parseToolRequest>;
    try {
      toolRequest = c.tool?.request ?? parseToolRequest(body);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "工具请求格式不正确";
      if (
        !message.startsWith("工具请求字段不符合要求") ||
        toolFormatCorrectionUsed ||
        host.kernel.loopPolicy.afterToolFormatError(
          toolFormatCorrectionUsed,
        ) === "terminate"
      )
        throw error;
      toolFormatCorrectionUsed = true;
      c = {
        ...c,
        toolFormatError: { message, createdAt: new Date().toISOString() },
      };
      host.saveContribution(c);
      toolReturns += `\n记录 ${c.id}\n${message}\n`;
      continue;
    }
    if (toolRequest) {
      const receipt = host.executeTool(
        c.id,
        input.member,
        input.refs,
        toolRequest,
      );
      if (
        receipt.status === "failed" &&
        host.kernel.loopPolicy.afterToolFailure() === "terminate"
      )
        throw new Error(receipt.output || "工具执行失败，内核策略终止本轮");
      c = { ...c, tool: receipt, body: toolRecordText(receipt) };
      host.saveContribution(c);
      toolReturns += `\n记录 ${c.id}\n${c.body}\n`;
      continue;
    }
    const question = parseDecision(body);
    if (question) {
      host.pauseForDecision(c, input.stage, attempt, question, callKey);
      throw new AwaitingDecision();
    }
    const methodRequest = c.skillRequest ?? parseSkillRequest(body);
    if (methodRequest) {
      const method = methods.find((s) => skillKey(s) === methodRequest.key);
      if (!method) throw new Error("方法不在此成员本轮获准范围内");
      if (uses.some((u) => u.key === methodRequest.key))
        throw new Error("成员重复请求已加载方法");
      if (uses.length >= 4) throw new Error("已达到本任务方法加载上限");
      if (!c.skillRequest) {
        c = {
          ...c,
          skillRequest: methodRequest,
          body: `选择方法 ${method.name}（${methodRequest.key}）\n用途：${methodRequest.purpose}`,
        };
        host.saveContribution(c);
      }
      uses.push({ ...methodRequest, source: "automatic" });
      continue;
    }
    const request = c.delegation?.request ?? parseDelegation(body);
    if (!request) return c;
    if (!allowsDelegation)
      throw new Error("此流程未启用委派，未执行委派请求");
    const member = host.run.team.members.find((m) => m.id === request.memberId);
    if (!member || member.id === input.member.id)
      throw new Error("委派对象必须是当前搭配中的其他成员");
    if (input.depth >= policy.maxDepth)
      throw new Error("委派超过当前流程层级限制");
    if (request.references.some((i) => i < 1 || i > input.refs.length))
      throw new Error("委派引用超出本任务可用材料范围");
    if (!c.delegation) {
      if (host.delegationCount() >= policy.maxTasks)
        throw new Error("已达到本轮委派上限");
      c = {
        ...c,
        delegation: { request, childKey: `${id}:d` },
        body: `委派给${member.name}：${request.objective}`,
      };
      host.saveContribution(c);
    }
    const child = await runMemberTask(host, {
      key: c.delegation!.childKey,
      member,
      objective: request.objective,
      context: request.context,
      refs: [...new Set(request.references)].map((i) => input.refs[i - 1]),
      depth: input.depth + 1,
      stage: input.stage,
      parentId: c.id,
      finalStage: false,
      allowsArtifact: false,
    });
    c = { ...c, delegation: { ...c.delegation!, responseId: child.id } };
    host.saveContribution(c);
    returnedFrom = child.id;
    returns += `\n委派记录：${c.id}\n${member.name}的返回（${child.id}；状态：${child.status}）：\n${child.body}\n${child.error ? `失败原因：${child.error}；该子任务未完成。` : ""}\n`;
  }
  throw new Error("成员任务轮次超过上限，已有结果保留");
}
