import { z } from "zod";

export const ACCOUNT_CONTRACT = "0.1.0";

const price = z
  .object({
    price_id: z.string().min(1).max(128),
    amount_minor: z.number().int().nonnegative().safe().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    billing_period: z.enum(["month", "year"]).nullable(),
    priced: z.boolean(),
  })
  .strict();

export const accountSummarySchema = z
  .object({
    product_id: z.literal("ytriple"),
    user_id: z.string().uuid(),
    access_state: z.enum([
      "none",
      "manual",
      "manual_expired",
      "subscription_active",
      "subscription_expired",
      "revoked",
    ]),
    catalog: z.array(
      z
        .object({
          plan_id: z.string().min(1).max(128),
          display_name: z.string().min(1).max(200),
          version: z.number().int().positive(),
          scopes: z.array(z.enum(["information:read", "ai:invoke", "product:access"])).optional(),
          daily_requests: z.number().int().nonnegative().optional(),
          daily_token_units: z.number().int().nonnegative().optional(),
          prices: z.array(price).max(400).default([]),
        })
        .strict(),
    ).max(40),
    subscription: z
      .object({
        revision: z.number().int().positive(),
        plan_id: z.string().min(1).max(128),
        plan_name: z.string().min(1).max(200),
        plan_version: z.number().int().positive(),
        price_id: z.string().min(1).max(128).nullable(),
        price: price.nullable(),
        valid_from: z.string().datetime({ offset: true }),
        valid_until: z.string().datetime({ offset: true }).nullable(),
        revoked_at: z.string().datetime({ offset: true }).nullable(),
      })
      .strict()
      .nullable(),
    entitlement: z
      .object({
        enabled: z.boolean(),
        ownership: z.enum(["manual", "subscription"]),
        scopes: z.array(z.enum(["information:read", "ai:invoke", "product:access"])),
        valid_from: z.string().datetime({ offset: true }),
        daily_requests: z.number().int().nonnegative(),
        daily_token_units: z.number().int().nonnegative(),
        valid_until: z.string().datetime({ offset: true }).nullable(),
        remaining_requests: z.number().int().nonnegative(),
        remaining_budget_units: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    usage_today: z.object({
      requests: z.number().int().nonnegative(),
      budget_units: z.number().int().nonnegative(),
      note: z.string(),
    }),
    catalog_note: z.string().nullable(),
  })
  .strict();

export type AccountSummaryDto = z.infer<typeof accountSummarySchema>;
