import { z } from "zod";
import {
  teamSchema,
  workflowSchema,
} from "../../desktop/src/core/configuration.ts";
import {
  briefInputSchema,
  standardInputSchema,
} from "../../desktop/src/core/project-contract.ts";
import { Store } from "../../desktop/src/core/store.ts";
import { Projects } from "../../desktop/src/core/projects.ts";
import { ServiceError } from "./errors.ts";
import { validText } from "./text.ts";
const id = z.string().min(1).max(300);
export const serviceCommand = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create-project"),
      name: z.string().trim().min(1).max(200),
      goal: z.string().trim().max(8000),
      kind: z.enum(["software", "media"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("create-delivery"),
      projectId: id,
      title: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({ type: z.literal("project-brief"), brief: briefInputSchema })
    .strict(),
  z
    .object({
      type: z.literal("project-standard"),
      standard: standardInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("add-text-material"),
      title: z.string().trim().min(1).max(500),
      body: z.string().min(1).max(200000),
    })
    .strict(),
  z.object({ type: z.literal("save-team"), team: teamSchema }).strict(),
  z
    .object({ type: z.literal("save-workflow"), workflow: workflowSchema })
    .strict(),
  z
    .object({
      type: z.literal("select-configuration"),
      workId: id.nullable(),
      teamKey: id,
      workflowKey: id,
    })
    .strict(),
]);
export const commandRequest = z
  .object({
    key: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    command: serviceCommand,
  })
  .strict()
  .refine(validText, "Text contains unsupported characters");
export type CommandRequest = z.infer<typeof commandRequest>;

// Deliberate capability boundary: never dispatch desktop IPC commands here.
// File reads/writes, arbitrary paths, credentials and client-supplied state have no remote entry point.
export function execute(store: Store, command: z.infer<typeof serviceCommand>) {
  try {
    switch (command.type) {
      case "create-project":
        return store.createProject(command.name, command.goal, command.kind);
      case "create-delivery":
        return store.createDelivery(command.projectId, command.title);
      case "project-brief":
        return new Projects(store).saveBrief(command.brief);
      case "project-standard":
        return new Projects(store).saveStandard(command.standard);
      case "add-text-material":
        return store.addMaterial(command.title, command.body, "uploaded_text");
      case "save-team":
        return store.saveTeam(command.team);
      case "save-workflow":
        return store.saveWorkflow(command.workflow);
      case "select-configuration":
        store.selectConfiguration(
          command.workId,
          command.teamKey,
          command.workflowKey,
        );
        return store.configuration(command.workId ?? undefined);
    }
  } catch {
    throw new ServiceError(
      "COMMAND_REJECTED",
      "操作与当前资料、版本或归属不一致，请重新检查",
      409,
    );
  }
}
