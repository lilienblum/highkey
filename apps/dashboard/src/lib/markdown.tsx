import type { ReactNode } from "react";

/**
 * A deliberately small Markdown renderer: headings, paragraphs, emphasis, code, lists and https
 * links. Text always goes through React's escaping and HTML is never interpreted, so links with
 * any other scheme (javascript:, data:, http:) stay literal text.
 */
const inline = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(text: string, key = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(inline)) {
    const [whole, code, strong, em, label, url] = match;
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const k = `${key}-${n++}`;
    if (code !== undefined) nodes.push(<code key={k}>{code}</code>);
    else if (strong !== undefined) nodes.push(<strong key={k}>{renderInline(strong, k)}</strong>);
    else if (em !== undefined) nodes.push(<em key={k}>{renderInline(em, k)}</em>);
    else if (/^https:\/\/[^\s]+$/i.test(url))
      nodes.push(
        <a key={k} href={url} rel="noreferrer" target="_blank">
          {label}
        </a>,
      );
    else nodes.push(whole);
    last = start + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: { id: string; text: string }[] };

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
    } else if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const text = (bullet ?? numbered)?.[1] ?? "";
      const previous = blocks.at(-1);
      if (previous?.kind === "list" && previous.ordered === ordered)
        previous.items.push({ id: `l${blocks.length}-${previous.items.length}`, text });
      else blocks.push({ kind: "list", ordered, items: [{ id: `l${blocks.length}-0`, text }] });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {parse(source).map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "heading") {
          const Tag = `h${block.level}` as "h1" | "h2" | "h3";
          return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
        }
        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={key}>
              {block.items.map((item) => (
                <li key={item.id}>{renderInline(item.text, item.id)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </>
  );
}
