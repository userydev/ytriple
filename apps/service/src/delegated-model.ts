import { z } from "zod";
import {
  YCore,
  managedServiceScope,
  type Model,
} from "../../desktop/src/core/ycore.ts";
import type { Identity } from "./auth.ts";
const delegatedIdentity = z.object({
  id: z.string().min(1).max(200),
  user_id: z.string().uuid(),
  product_id: z.literal("ytriple"),
  authentication: z.literal("delegation"),
  scopes: z.array(z.literal("ai:invoke")).min(1),
  delegation: z.object({
    id: z.string().uuid(),
    execution_id: z.string().uuid(),
  }),
});

// Grants stay in server credential storage. Never return this token in a Snapshot,
// command receipt, task input, backup or public configuration response.
export async function delegatedModel(
  baseUrl: string,
  owner: Identity,
  grant: { id: string; executionId: string; token: string },
  fetcher: typeof fetch = fetch,
): Promise<Model> {
  z.object({
    id: z.string().uuid(),
    executionId: z.string().uuid(),
    token: z.string().regex(/^ycg1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i),
  })
    .strict()
    .parse(grant);
  const client = new YCore(baseUrl, grant.token, async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-YCore-Product", "ytriple");
    const request = { ...init, headers };
    if (
      request.method === "POST" &&
      String(url) === baseUrl.replace(/\/$/, "") + "/v1/ai/runs"
    ) {
      if (typeof request.body !== "string")
        throw Error("Invalid model request");
      request.body = JSON.stringify({
        ...JSON.parse(request.body),
        execution_id: grant.executionId,
      });
    }
    return fetcher(url, request);
  });
  const identity = delegatedIdentity.parse(
    await (await client.request("/v1/identity")).json(),
  );
  if (
    identity.id !== owner.id ||
    identity.user_id !== owner.user_id ||
    identity.delegation.id !== grant.id ||
    identity.delegation.execution_id !== grant.executionId
  )
    throw Error(
      "Background authorization does not belong to this account and execution",
    );
  return {
    scope: managedServiceScope(baseUrl, identity.id),
    recovery: "remote",
    identity: client.identity,
    stream: client.stream.bind(client),
    lookup: client.lookup.bind(client),
    lookupByKey: client.lookupByKey.bind(client),
  };
}
