import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionPriceLabel as label } from "../src/ui/subscription-price";
test("subscription prices format currency minor units and distinguish unpriced from zero", () => {
  assert.equal(label({ priced: true, amountMinor: 9900, currency: "CNY", billingPeriod: "month" }), "¥99.00/月");
  assert.equal(label({ priced: true, amountMinor: 9900, currency: "JPY", billingPeriod: "year" }), "JP¥9,900/年");
  assert.equal(label({ priced: true, amountMinor: 0, currency: "USD", billingPeriod: "month" }), "US$0.00/月");
  assert.equal(label({ priced: false, amountMinor: null, currency: null, billingPeriod: null }), "未定价");
});
