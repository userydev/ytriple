import path from "node:path";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import type { Artifact, Source } from "../shared/types.js";
import {
  DELIVERY_STATUS,
  FEEDBACK_DECISION,
  deliveryCommandSchema,
  type DeliveryCommand,
  type DeliveryRecord,
  type DeliverySnapshot,
} from "../shared/delivery.js";
import type { Store } from "./store.js";
import { now, uid } from "./store.js";
import {
  hash,
  readOwnedArtifactSync,
  textSource,
  within,
  writeArtifact,
} from "./files.js";
import type { FeatureHost } from "./feature-host.js";
import { listProjects } from "./system.js";

const KEY = "delivery.ledger.v1";
interface Ledger {
  records: DeliveryRecord[];
  receipts: Record<string, { fingerprint: string; deliveryId: string }>;
}
const queues = new WeakMap<Store, Promise<void>>();
const ledger = (store: Store): Ledger =>
  structuredClone(
    store.config<Ledger>(KEY, () => ({ records: [], receipts: {} })),
  );

export function deliverySnapshot(store: Store): DeliverySnapshot {
  return {
    records: ledger(store)
      .records.map((record) => {
        const task = store.hasTask(record.taskId)
          ? store.task(record.taskId)
          : undefined;
        const artifact = task?.artifacts.find(
          (item) => item.id === record.artifactId,
        );
        return {
          ...record,
          sourceChanged: artifact
            ? artifact.hash !== record.artifactHash
            : false,
          sourceMissing: !artifact,
          works: record.works.map((work) => {
            const current = store.hasTask(work.taskId)
              ? store.task(work.taskId)
              : undefined;
            return {
              ...work,
              status: current?.status ?? "missing",
              error: current?.error ?? work.error,
            };
          }),
        };
      })
      .sort(
        (a, b) =>
          (a.plannedDate ?? "9999").localeCompare(b.plannedDate ?? "9999") ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
  };
}

/** A readable package freezes the registered version, even after the source changes. */
export function deliveryMarkdown(record: DeliveryRecord): string {
  const sources = record.sources
    .map(
      (source) =>
        `- ${source.title}\n  - 位置：${source.location}\n  - 范围：${source.coverage}\n  - SHA-256：${source.hash}`,
    )
    .join("\n");
  return `# ${record.artifactTitle} · 交接材料\n\n给谁使用：${record.recipient}\n\n目标：${record.goal}\n\n完成标准：${record.criteria}\n\n尚缺条件：${record.missing || "未登记缺失条件；仍需检查依据。"}\n\n计划日期：${record.plannedDate ?? "未设置"}（不是实际发布时间）\n\n当前登记：${DELIVERY_STATUS[record.status]}\n\n来源任务：${record.taskId}\n成果：${record.artifactId} · v${record.artifactVersion}\n目标版本：${record.goalVersion}\nSHA-256：${record.artifactHash}\n交付记录：${record.id} · 修订 ${record.revision}\n\n## 准确版本正文\n\n${record.content}\n\n## 来源与阅读范围\n\n${sources || "没有登记来源；正文主张不能据此视为已核查。"}\n\n## 使用与验证记录\n\n${record.history
    .map(
      (entry) =>
        `${entry.recordedAt} · ${DELIVERY_STATUS[entry.status]}\n${Object.entries(
          entry.evidence,
        )
          .map(
            ([key, value]) =>
              `${({ receipt: "接收证据", usage: "实际用途", conditions: "使用条件", observations: "观察与证据" } as Record<string, string>)[key]}：${value}`,
          )
          .join("\n")}\n${entry.note ?? ""}`,
    )
    .join(
      "\n\n",
    )}\n\n## 反馈原文与判断\n\n${record.feedback.map((feedback) => `### ${feedback.observedAt} · ${FEEDBACK_DECISION[feedback.decision]}\n\n${feedback.quote}\n\n来源：${feedback.location ?? "用户手动登记"}\n覆盖：${feedback.coverage}\n处理说明：${feedback.decisionNote ?? "尚未判断"}`).join("\n\n") || "尚未登记真实反馈。"}\n\n检查任务只检查交接材料；模型输出不等于接收、执行成功或用户价值已验证。\n`;
}

export function handleDeliveryCommand(
  host: FeatureHost,
  input: DeliveryCommand,
): Promise<void> {
  const command = deliveryCommandSchema.parse(input);
  const previous = queues.get(host.store) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => applyCommand(host, command));
  queues.set(host.store, pending);
  return pending.finally(() => {
    if (queues.get(host.store) === pending) queues.delete(host.store);
  });
}

async function applyCommand(
  host: FeatureHost,
  command: DeliveryCommand,
): Promise<void> {
  const { store } = host;
  const state = ledger(store);
  const fingerprint = hash(JSON.stringify(command));
  const receipt = state.receipts[command.requestId];
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new Error("这个请求编号已用于不同操作，请刷新后重试。");
    return;
  }
  let record: DeliveryRecord;
  let workToRun: string | undefined;
  if (command.type === "delivery.register") {
    const task = store.task(command.taskId);
    const artifact = task.artifacts.find(
      (item) => item.id === command.artifactId,
    );
    if (!artifact || !["md", "html"].includes(artifact.format))
      throw new Error("请选择一份可读取的 Markdown 或 HTML 文字成果。");
    const body = readOwnedArtifactSync(artifact, task.workspace);
    if (
      artifact.hash !== command.expectedHash ||
      hash(body) !== command.expectedHash
    )
      throw new Error("成果正文已改变，请刷新并登记实际版本。");
    if (body.byteLength > 1_500_000)
      throw new Error("此说明书过大，请拆分后登记交付。");
    if (
      state.records.some(
        (item) =>
          item.taskId === task.id &&
          item.artifactId === artifact.id &&
          item.artifactHash === artifact.hash,
      )
    )
      throw new Error("这个成果版本已经登记，请打开已有交付记录。");
    record = {
      ...command.spec,
      id: uid(),
      revision: 1,
      taskId: task.id,
      projectId: task.projectId,
      artifactId: artifact.id,
      artifactTitle: artifact.title,
      artifactVersion: artifact.version,
      artifactHash: artifact.hash,
      goalVersion: artifact.goalVersion,
      content: body.toString("utf8"),
      format: artifact.format as "md" | "html",
      sources: task.sources.map((source) => ({
        id: source.id,
        title: source.title,
        location: source.location,
        coverage: source.coverage,
        hash: hash(source.text),
      })),
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
      history: [{ status: "draft", recordedAt: now(), evidence: {} }],
      works: [],
      feedback: [],
      exports: [],
      writebacks: [],
    };
    state.records.push(record);
  } else {
    const found = state.records.find((item) => item.id === command.deliveryId);
    if (!found) throw new Error("交付记录不存在，请刷新。");
    record = found;
    if (record.revision !== command.expectedRevision)
      throw new Error("交付记录已更新，请核对最新内容后重试；旧输入尚未写入。");
    switch (command.type) {
      case "delivery.update":
        Object.assign(record, command.spec);
        if (!command.spec.plannedDate) delete record.plannedDate;
        if (record.status === "ready") {
          record.status = "revision_needed";
          record.history.push({
            status: record.status,
            recordedAt: now(),
            evidence: {},
            note: "目标、接收条件或计划已修改，请重新检查交接是否就绪。",
          });
        }
        break;
      case "delivery.status": {
        const evidence = command.evidence;
        if (command.status === "handed_off" && !evidence.receipt?.trim())
          throw new Error(
            "已交接需要接收方回执或实际接收证据；打开文件不表示已接收。",
          );
        if (
          ["used", "verified"].includes(command.status) &&
          (!evidence.usage?.trim() ||
            !evidence.conditions?.trim() ||
            !evidence.observations?.trim())
        )
          throw new Error(
            "请记录实际用途、使用条件和观察证据，再登记已使用或已验证。",
          );
        if (command.status === "ready" && record.missing.trim())
          throw new Error(
            "仍有登记的缺失条件，请先处理或明确修订条件，再确认可交接。",
          );
        record.status = command.status;
        record.history.push({
          status: command.status,
          recordedAt: now(),
          evidence,
          note: command.note,
        });
        break;
      }
      case "delivery.check":
      case "delivery.reviewFeedback": {
        const isCheck = command.type === "delivery.check";
        const task = store.hasTask(record.taskId)
          ? store.task(record.taskId)
          : undefined;
        const selectedSources: Source[] = [];
        let feedbackIds: string[] = [];
        if (isCheck) {
          for (const id of new Set(command.sourceIds)) {
            const source = task?.sources.find((item) => item.id === id);
            if (!source) throw new Error("选定资料已不存在，请重新选择。");
            if (source.library?.supersededAt)
              throw new Error("选定资产已过期，请选择有效版本。");
            selectedSources.push(structuredClone(source));
          }
        } else {
          feedbackIds = [...new Set(command.feedbackIds)];
          for (const id of feedbackIds) {
            const feedback = record.feedback.find((item) => item.id === id);
            if (!feedback) throw new Error("反馈选择已改变，请刷新。");
            selectedSources.push(
              textSource(
                `反馈原话 · ${feedback.observedAt}`,
                `${feedback.quote}\n\n来源：${feedback.location ?? "用户登记"}\n范围：${feedback.coverage}\n处理状态：${FEEDBACK_DECISION[feedback.decision]}\n${feedback.decisionNote ?? ""}`,
              ),
            );
          }
        }
        const frozen = textSource(
          `${record.artifactTitle} · v${record.artifactVersion} · 交接快照`,
          `接收方：${record.recipient}\n目标：${record.goal}\n完成标准：${record.criteria}\n尚缺条件：${record.missing || "未登记"}\n成果版本：${record.artifactVersion}\n目标版本：${record.goalVersion}\nSHA-256：${record.artifactHash}\n\n${record.content}`,
          "text",
          `delivery:${record.id}:${record.artifactHash}`,
        );
        const work = await host.createWork({
          requestId: command.requestId,
          isolatedContext: true,
          title: `${isCheck ? "检查交接" : "整理反馈"} · ${record.artifactTitle} v${record.artifactVersion}`,
          member: "researcher",
          kind: "research",
          skillPolicy: {
            mode: "explicit",
            skillIds: [isCheck ? "handoff-review" : "material-digest"],
          },
          sources: [frozen, ...selectedSources],
          goal: isCheck
            ? "你是未参与原讨论的独立检查者。仅依据本工作明确提供的成果版本与选定资料，复述接收方要完成的目标、条件与标准，定位歧义、矛盾、证据缺口和接收者可能误解之处。输出具体检查说明与未解决问题并保存 Markdown。不要修改原成果；不要把阅读检查表示为代码、发布或使用效果通过。资料不足则明确无法判断，不调用其他任务或全库补充隐含背景。"
            : "仅依据所提供交付版本与真实反馈，整理问题与机会。合并相似意见但保留原话、时间、来源和覆盖；区分缺陷、需求、误解、赞同、情绪与少数意见，指出低样本及未证明的解释。关联当前交付物的具体内容，给出待用户采纳的建议并保存 Markdown；不自动修改目标、代码或全局方法，不将模型归纳冒充现实因果。",
        });
        record.works.push({
          id: command.requestId,
          taskId: work.id,
          kind: isCheck ? "readiness" : "feedback",
          createdAt: now(),
          artifactHash: record.artifactHash,
          deliveryRevision: record.revision,
          sourceIds: isCheck ? [...new Set(command.sourceIds)] : [],
          feedbackIds,
        });
        workToRun = work.id;
        break;
      }
      case "delivery.export": {
        const task = store.task(record.taskId);
        const saved = await writeArtifact(store, task.id, {
          title: `${record.artifactTitle} · v${record.artifactVersion} 交接包`,
          content: deliveryMarkdown(record),
          format: "md",
          goalVersion: task.goalVersion,
          operationId: `delivery-export:${command.requestId}`,
        });
        record.exports.push({
          artifactId: saved.id,
          path: saved.path,
          hash: saved.hash,
          createdAt: now(),
        });
        break;
      }
      case "delivery.addFeedback": {
        if (command.kind === "url" && !command.location)
          throw new Error("请填写反馈原文所在的公开网址。");
        let quote = command.quote;
        let location = command.location;
        let coverage = command.coverage;
        if (command.kind === "report") {
          const source = store
            .task(record.taskId)
            .sources.find((item) => item.id === command.reportSourceId);
          if (!source) throw new Error("请选择已导入本工作的实际报告资料。");
          quote += `\n\n报告正文快照：\n${source.text}`;
          location = source.location;
          coverage += `；导入范围：${source.coverage}；SHA-256：${hash(source.text)}`;
        }
        if (command.kind === "url")
          coverage += "；网址由用户提供，本操作未抓取网页";
        record.feedback.push({
          id: uid(),
          kind: command.kind,
          quote,
          location,
          observedAt: command.observedAt,
          coverage,
          addedAt: now(),
          decision: "pending",
        });
        break;
      }
      case "delivery.decideFeedback": {
        const feedback = record.feedback.find(
          (item) => item.id === command.feedbackId,
        );
        if (!feedback) throw new Error("找不到这条反馈。");
        feedback.decision = command.decision;
        feedback.decisionNote = command.note;
        feedback.decidedAt = now();
        break;
      }
      case "delivery.writeFeedback": {
        const feedback = record.feedback.find(
          (item) => item.id === command.feedbackId,
        );
        if (!feedback || feedback.decision !== "accepted")
          throw new Error("请先明确采纳这条反馈，再写入项目反馈位置。");
        if (!record.projectId) throw new Error("此交付未关联软件项目。");
        if (record.writebacks.some((item) => item.feedbackId === feedback.id))
          break;
        const projects = await listProjects(store.settings().aiRoot);
        const project = projects.find((item) => item.id === record.projectId);
        const target = project?.documents.external_ai_writeback;
        if (
          !project ||
          !target ||
          path.extname(target).toLowerCase() !== ".md" ||
          !within(store.settings().codeRoot, project.devPath) ||
          !within(project.devPath, target) ||
          Object.entries(project.documents).some(
            ([key, value]) =>
              key !== "external_ai_writeback" &&
              value &&
              path.resolve(value) === path.resolve(target),
          )
        )
          throw new Error(
            "项目没有明确且独立的 Markdown 反馈入口，请由项目负责人配置登记；不能写代码或正式方案。",
          );
        const before = readOwnedArtifactSync(
          { path: target } as Artifact,
          path.dirname(target),
        );
        const marker = `<!-- ytriple-delivery:${command.requestId} -->`;
        if (!before.toString("utf8").includes(marker)) {
          const fd = openSync(
            target,
            constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
          );
          try {
            const opened = fstatSync(fd),
              current = lstatSync(target);
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              current.isSymbolicLink() ||
              opened.ino !== current.ino ||
              opened.dev !== current.dev ||
              hash(
                readOwnedArtifactSync(
                  { path: target } as Artifact,
                  path.dirname(target),
                ),
              ) !== hash(before)
            )
              throw new Error("反馈文件在准备期间已改变，请刷新后重试。");
            appendFileSync(
              fd,
              `\n\n${marker}\n## ${record.artifactTitle} · v${record.artifactVersion} 的已采纳反馈\n\n来源交付：${record.id}\n成果 SHA-256：${record.artifactHash}\n观察时间：${feedback.observedAt}\n来源：${feedback.location ?? "用户登记"}\n范围：${feedback.coverage}\n\n${feedback.quote}\n\n采纳说明：${feedback.decisionNote}\n\n此项为用户采纳的反馈，未表示 Codex 已执行或修改正式方案。\n`,
              "utf8",
            );
          } finally {
            closeSync(fd);
          }
        }
        record.writebacks.push({
          feedbackId: feedback.id,
          path: target,
          writtenAt: now(),
        });
        break;
      }
    }
    record.revision++;
    record.updatedAt = now();
  }
  state.receipts[command.requestId] = { fingerprint, deliveryId: record.id };
  store.setConfig(KEY, state);
  if (workToRun) {
    const taskId = workToRun;
    void host.runWork(taskId).catch((error: unknown) => {
      const current = ledger(store);
      const work = current.records
        .find((item) => item.id === record.id)
        ?.works.find((item) => item.taskId === taskId);
      if (work) {
        work.error =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "工作未完成，请打开工作查看状态。";
        store.setConfig(KEY, current);
      }
    });
  }
}
