import {
  matchRulesSchema,
  type MatchRules,
  type RadarTopic,
  type TopicInput,
} from "./radar-contract";
import type { Material } from "./types";

const latinKeyword = /^[a-z0-9]+(?:[ '\-][a-z0-9]+)*$/i;

export function textMatchesKeyword(text: string, keyword: string) {
  const needle = keyword.trim();
  if (!needle) return false;
  const haystack = text.toLocaleLowerCase();
  const lowered = needle.toLocaleLowerCase();
  if (latinKeyword.test(needle)) {
    const escaped = lowered
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[ '\-]+/g, "[ '\\-]+");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(
      haystack,
    );
  }
  return haystack.includes(lowered);
}

export function textMatchesAnyKeyword(
  text: string,
  keywords: readonly string[],
) {
  return keywords.some((keyword) => textMatchesKeyword(text, keyword));
}

export function normalizeMatchTerm(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeMatchRules(rules: MatchRules): MatchRules {
  const dedupe = (terms: string[]) => {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const term of terms) {
      const normalized = normalizeMatchTerm(term);
      const key = normalized.toLocaleLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      next.push(normalized);
    }
    return next;
  };
  return {
    version: 1,
    groups: rules.groups.map((group) => ({ terms: dedupe(group.terms) })),
    ...(rules.exclude?.length
      ? { exclude: dedupe(rules.exclude) }
      : {}),
  };
}

export function parseMatchRules(raw: unknown):
  | { ok: true; rules: MatchRules }
  | { ok: false; error: string } {
  const parsed = matchRulesSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "匹配规则无效，未改用宽松关键词" };
  const rules = normalizeMatchRules(parsed.data);
  if (rules.groups.some((group) => !group.terms.length))
    return { ok: false, error: "匹配规则含空组，未改用宽松关键词" };
  return { ok: true, rules };
}

export function matchRulesEqual(a?: MatchRules, b?: MatchRules) {
  return JSON.stringify(a ? normalizeMatchRules(a) : null) ===
    JSON.stringify(b ? normalizeMatchRules(b) : null);
}

export type TopicMatchMode =
  | { mode: "rules"; rules: MatchRules }
  | { mode: "keywords"; keywords: string[] }
  | { mode: "invalid"; error: string }
  | { mode: "none" };

export function topicMatchMode(
  topic: Pick<RadarTopic, "keywords" | "matchRules">,
): TopicMatchMode {
  if (topic.matchRules !== undefined) {
    const parsed = parseMatchRules(topic.matchRules);
    if (!parsed.ok) return { mode: "invalid", error: parsed.error };
    return { mode: "rules", rules: parsed.rules };
  }
  const keywords = (topic.keywords ?? []).map(normalizeMatchTerm).filter(Boolean);
  if (keywords.length) return { mode: "keywords", keywords };
  return { mode: "none" };
}

export function splitMatchUnits(title: string, body: string) {
  const units = [title.trim()].filter(Boolean);
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return units;
  const chunks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split("\n");
  for (const chunk of chunks) {
    const value = chunk.trim();
    if (value) units.push(value);
  }
  return units;
}

function unitMatchesGroups(unit: string, groups: MatchRules["groups"]) {
  return groups.every((group) =>
    group.terms.some((term) => textMatchesKeyword(unit, term)),
  );
}

export function rulesMatchText(title: string, body: string, rules: MatchRules) {
  const article = `${title}\n${body}`;
  if (rules.exclude?.some((term) => textMatchesKeyword(article, term)))
    return false;
  return splitMatchUnits(title, body).some((unit) =>
    unitMatchesGroups(unit, rules.groups),
  );
}

export function rulesHitSentence(
  title: string,
  body: string,
  rules: MatchRules,
) {
  for (const unit of splitMatchUnits(title, body)) {
    if (unitMatchesGroups(unit, rules.groups)) return unit.slice(0, 240);
  }
  return "";
}

export function materialMatchesTopic(
  material: Pick<Material, "title" | "body">,
  topic: Pick<RadarTopic, "keywords" | "matchRules">,
) {
  const mode = topicMatchMode(topic);
  if (mode.mode === "invalid" || mode.mode === "none") return false;
  if (mode.mode === "rules")
    return rulesMatchText(material.title, material.body, mode.rules);
  return textMatchesAnyKeyword(
    `${material.title}\n${material.body}`,
    mode.keywords,
  );
}

export function topicExecutionScope(
  topic: Pick<
    TopicInput,
    | "focus"
    | "feedIds"
    | "feedLimit"
    | "sourceIds"
    | "keywords"
    | "matchRules"
    | "sources"
  >,
) {
  const mode = topicMatchMode(topic);
  return JSON.stringify({
    focus: topic.focus,
    feedIds: topic.feedIds ?? [],
    feedLimit: topic.feedLimit ?? 8,
    sourceIds: topic.sourceIds ?? [],
    match:
      mode.mode === "rules"
        ? { rules: normalizeMatchRules(mode.rules) }
        : mode.mode === "keywords"
          ? { keywords: mode.keywords }
          : mode.mode === "invalid"
            ? { invalid: true }
            : { none: true },
    sources: topic.sources,
  });
}

export function previewTopicMatches(
  materials: readonly Pick<Material, "id" | "title" | "body">[],
  topic: Pick<RadarTopic, "keywords" | "matchRules">,
  limit = 8,
) {
  const mode = topicMatchMode(topic);
  if (mode.mode === "invalid")
    return { error: mode.error, count: 0, samples: [] as { title: string; hit: string }[] };
  const samples: { title: string; hit: string }[] = [];
  let count = 0;
  for (const material of materials) {
    if (!materialMatchesTopic(material, topic)) continue;
    count += 1;
    if (samples.length < limit) {
      samples.push({
        title: material.title,
        hit:
          mode.mode === "rules"
            ? rulesHitSentence(material.title, material.body, mode.rules)
            : material.title,
      });
    }
  }
  return { error: null as string | null, count, samples };
}
