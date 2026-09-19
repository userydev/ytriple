/** Service prices use each currency's ISO minor unit, never display it as a major unit. */
export function subscriptionPriceLabel(price: {
  priced: boolean;
  amountMinor: number | null;
  currency: string | null;
  billingPeriod: string | null;
} | null | undefined): string {
  if (!price?.priced || price.amountMinor == null || !price.currency) return "未定价";
  try {
    const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency: price.currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    const amount = format.format(price.amountMinor / 10 ** digits);
    const period = ({ month: "月", year: "年", one_time: "次" } as Record<string, string>)[price.billingPeriod ?? ""];
    return period ? `${amount}/${period}` : amount;
  } catch { return "价格信息不可用"; }
}
