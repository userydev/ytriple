import { parseHTML } from "linkedom";

/** Render readable text only; feed HTML never gets an active renderer. */
export function readableText(markup: string): string {
  const { document } = parseHTML(`<html><body>${markup}</body></html>`);
  document
    .querySelectorAll("script,style,iframe,object,embed,form")
    .forEach((node) => node.remove());
  document
    .querySelectorAll("p,div,section,article,li,h1,h2,h3,h4,br,pre,blockquote")
    .forEach((node) => {
      node.before(document.createTextNode("\n\n"));
      node.after(document.createTextNode("\n\n"));
    });
  return (
    document.body.textContent
      ?.replace(/[\t ]+/g, " ")
      .replace(/\n\s*\n(?:\s*\n)+/g, "\n\n")
      .trim() ?? ""
  );
}
