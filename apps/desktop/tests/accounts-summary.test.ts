import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountSummarySchema } from "../src/core/account-summary-contract";

test("account summary schema validates the priced subscription DTO", () => {
  const body = accountSummarySchema.parse({
    product_id: "ytriple",
    user_id: randomUUID(),
    access_state: "subscription_active",
    catalog: [
      {
        plan_id: "pro",
        display_name: "Pro",
        version: 1,
        prices: [
          {
            price_id: "pro-month",
            amount_minor: 900,
            currency: "USD",
            billing_period: "month",
            priced: true,
          },
        ],
      },
    ],
    subscription: {
      revision: 1,
      plan_id: "pro",
      plan_name: "Pro",
      plan_version: 1,
      price_id: "pro-month",
      price: {
        price_id: "pro-month",
        amount_minor: 900,
        currency: "USD",
        billing_period: "month",
        priced: true,
      },
      valid_from: new Date().toISOString(),
      valid_until: new Date(Date.now() + 86400000).toISOString(),
      revoked_at: null,
    },
    entitlement: {
      enabled: true,
      ownership: "subscription",
      scopes: ["product:access", "ai:invoke"],
      valid_from: new Date().toISOString(),
      daily_requests: 10,
      daily_token_units: 1000,
      valid_until: null,
      remaining_requests: 8,
      remaining_budget_units: 900,
    },
    usage_today: {
      requests: 2,
      budget_units: 100,
      note: "fixture",
    },
    catalog_note: null,
  });
  assert.equal(body.product_id, "ytriple");
});
