import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { delegatedModel } from "../src/delegated-model.ts";
import { managedServiceScope } from "../../desktop/src/core/ycore.ts";
import type { Identity } from "../src/auth.ts";
const owner: Identity = {
  id: "user:fixture:owner:ytriple",
  user_id: randomUUID(),
  product_id: "ytriple",
  authentication: "supabase",
  scopes: ["product:access"],
};
const grant = { id: randomUUID(), executionId: randomUUID(), token: "" };
grant.token = `ycg1.${grant.id}.${randomBytes(32).toString("base64url")}`;
const identity = {
  ...owner,
  authentication: "delegation",
  scopes: ["ai:invoke"],
  delegation: { id: grant.id, execution_id: grant.executionId },
};
const response = (value: unknown) =>
  Response.json(value, { headers: { "X-YCore-Contract": "0.1.0" } });

test("delegated model verifies account and execution, uses stable managed scope, injects only its authorized execution into AI requests", async () => {
  const seen: { url: string; body: any }[] = [];
  const runId = randomUUID();
  const fetcher = (async (url: any, init: any) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), "Bearer " + grant.token);
    assert.equal(headers.get("X-YCore-Product"), "ytriple");
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/v1/identity")) return response(identity);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url: String(url), body });
    if (init.method === "POST")
      return new Response(
        `event: run.started\ndata: {"run_id":"${runId}"}\n\nevent: text.delta\ndata: {"run_id":"${runId}","text":"fixture"}\n\nevent: run.completed\ndata: {"run_id":"${runId}"}\n\n`,
        {
          headers: {
            "X-YCore-Contract": "0.1.0",
            "Content-Type": "text/event-stream",
          },
        },
      );
    return response({
      id: runId,
      status: "succeeded",
      result: { text: "fixture" },
      error: null,
    });
  }) as typeof fetch;
  const model = await delegatedModel(
    "https://example.com",
    owner,
    grant,
    fetcher,
  );
  assert.equal(
    model.scope,
    managedServiceScope("https://example.com", owner.id),
  );
  for await (const _ of model.stream(
    {
      taskId: "fixture",
      refs: [],
      messages: [{ role: "user", content: "test" }],
    },
    randomUUID(),
    new AbortController().signal,
  )) {
  }
  assert.equal(seen[0].body.execution_id, grant.executionId);
  assert.ok(!JSON.stringify(seen[0].body).includes(grant.token));
  await model.lookupByKey!("original-key");
  await model.lookup!(runId);
  assert.equal(seen[1].body, null);
});

test("wrong identity, product, grant or execution is rejected before invoking a model; a managed token cannot substitute for a grant", async () => {
  for (const patch of [
    { id: "another-owner" },
    { user_id: randomUUID() },
    { product_id: "ytrader" },
    { authentication: "supabase" },
    { scopes: ["product:access"] },
    { delegation: { id: randomUUID(), execution_id: grant.executionId } },
    { delegation: { id: grant.id, execution_id: randomUUID() } },
  ]) {
    let requests = 0;
    await assert.rejects(
      delegatedModel("https://example.com", owner, grant, (async () => {
        requests++;
        return response({ ...identity, ...patch });
      }) as typeof fetch),
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    delegatedModel("https://example.com", owner, {
      ...grant,
      token: "ordinary-access-token",
    }),
  );
});
