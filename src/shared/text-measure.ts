/** A transparent length estimate; it cannot measure an actual voice performance. */
export function measureText(text: string, unitsPerMinute: number) {
  if (
    !Number.isFinite(unitsPerMinute) ||
    unitsPerMinute < 30 ||
    unitsPerMinute > 1000
  )
    throw new Error("请使用每分钟 30–1000 单位的明示语速。");
  const hanCharacters = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const otherWords = (
    text
      .replace(/\p{Script=Han}/gu, " ")
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []
  ).length;
  const units = hanCharacters + otherWords;
  return {
    unicodeCharacters: [...text].length,
    hanCharacters,
    otherWords,
    spokenUnits: units,
    unitsPerMinute,
    estimatedSeconds: Math.ceil((units / unitsPerMinute) * 60),
    scope:
      "仅计量提供的台词文字；汉字按字，其他语言与数字按词组，标点空白不计。时长按声明语速估算，不含停顿、情绪、画面、实读或成片验证。",
  };
}
