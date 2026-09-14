import { Fragment, type JSX } from "react";
import { parseInline, parseMarkdown } from "./markdown.js";

function Inline({ text }: { text: string }): JSX.Element {
  return (
    <>
      {parseInline(text).map((span, index) => {
        if (span.kind === "strong") return <strong key={index}>{span.text}</strong>;
        if (span.kind === "link") {
          return (
            <a key={index} href={span.href} target="_blank" rel="noreferrer">
              {span.text}
            </a>
          );
        }
        return <Fragment key={index}>{span.text}</Fragment>;
      })}
    </>
  );
}

export function Markdown({ source }: { source: string }): JSX.Element {
  return (
    <div className="markdown">
      {parseMarkdown(source).map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = (["h1", "h2", "h3"] as const)[block.level - 1]!;
            return (
              <Tag key={index}>
                <Inline text={block.text} />
              </Tag>
            );
          }
          case "bullets":
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Inline text={item} />
                  </li>
                ))}
              </ul>
            );
          case "numbered":
            return (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Inline text={item} />
                  </li>
                ))}
              </ol>
            );
          case "paragraph":
            return (
              <p key={index}>
                <Inline text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
