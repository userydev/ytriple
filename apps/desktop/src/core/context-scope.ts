import type { ContextScope } from "./types";
import { outputLabels } from "./output";

export function formatContextScope(scope: ContextScope): string {
  const parts = [outputLabels[scope.outputMode]];
  if (scope.processScoped) parts.push("限定过程/材料范围");
  if (scope.includesCurrentResult)
    parts.push(
      scope.currentResultTruncated
        ? "含主成果节选（非全文）"
        : "含当前主成果全文",
    );
  if (scope.includesResultBase) parts.push("含修订基准成果");
  if (scope.includesExplicitMaterials)
    parts.push(scope.inheritedMaterials ? "含继承/显式材料" : "含显式材料引用");
  if (scope.exchangeTurns)
    parts.push(
      `接续 ${scope.exchangeTurns} 轮交流${scope.exchangeOmitted ? `（省略 ${scope.exchangeOmitted} 轮）` : ""}`,
    );
  else if (!scope.processScoped && scope.outputMode === "explanation")
    parts.push("无先前交流");
  if (scope.backgroundOmitted)
    parts.push(`背景省略 ${scope.backgroundOmitted} 次`);
  if (scope.exchangeFailedTurns)
    parts.push(`${scope.exchangeFailedTurns} 轮未成功`);
  if (scope.exchangeTruncated || scope.backgroundTruncated)
    parts.push("已按预算截断");
  if (scope.exchangeHistoryBytes)
    parts.push(`交流约 ${scope.exchangeHistoryBytes} 字节`);
  return parts.join(" · ");
}
