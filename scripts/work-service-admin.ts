import path from "node:path";
import { z } from "zod";
import { WorkStore } from "../services/work-service/store.js";

const entitlementSchema = z
  .object({
    plan: z.string().min(1),
    active: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    modelIds: z.array(z.string().min(1)).min(1),
    tokenLimit: z.number().int().min(0).max(1000000000),
    maxConcurrent: z.number().int().min(1).max(20),
  })
  .strict();
const username = process.argv[2],
  password = process.env.WORK_ADMIN_PASSWORD;
if (!username || !password)
  throw new Error(
    "用法：WORK_ADMIN_PASSWORD=... WORK_ENTITLEMENT_JSON=... npx tsx scripts/work-service-admin.ts 用户名；密码至少 12 位，仅从环境变量读取。",
  );
const entitlement = entitlementSchema.parse(
  JSON.parse(process.env.WORK_ENTITLEMENT_JSON ?? "{}"),
);
const store = new WorkStore(
  path.resolve(process.env.WORK_DATA_DIR ?? ".local/work-service"),
);
try {
  const id = store.provision(username, password, entitlement);
  process.stdout.write(
    `Account ${username} (${id}) provisioned; previous device tokens revoked.\n`,
  );
} finally {
  store.close();
}
