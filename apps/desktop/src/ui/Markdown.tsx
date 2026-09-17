import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps } from "react";
const plugins = [remarkGfm];
export default function Markdown(props: ComponentProps<typeof ReactMarkdown>) {
  return (
    <div className="markdown">
      <ReactMarkdown
        {...props}
        remarkPlugins={
          props.remarkPlugins ? [...plugins, ...props.remarkPlugins] : plugins
        }
      />
    </div>
  );
}
