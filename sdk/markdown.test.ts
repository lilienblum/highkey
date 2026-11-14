import { expect, test } from "bun:test";
// React resolves from the dashboard workspace; the root has only its types.
// @ts-expect-error untyped deep import
import { createElement } from "../apps/dashboard/node_modules/react";
// @ts-expect-error untyped deep import
import { renderToStaticMarkup } from "../apps/dashboard/node_modules/react-dom/server";
import { Markdown } from "../apps/dashboard/src/lib/markdown";

const render = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

test("renders allowed constructs", () => {
  const html = render(
    "# Title\n## Sub\n### Third\n\nHello *there* **bold** `code`\n\n- one\n- two\n\n1. first\n2. second\n\n[docs](https://example.com/a)",
  );
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<h2>Sub</h2>");
  expect(html).toContain("<h3>Third</h3>");
  expect(html).toContain("<p>Hello <em>there</em> <strong>bold</strong> <code>code</code></p>");
  expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  expect(html).toContain(
    '<a href="https://example.com/a" rel="noreferrer" target="_blank">docs</a>',
  );
});

test("does not interpret html", () => {
  const html = render('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("drops javascript: and data: links to text", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "http://insecure.test"]) {
    const html = render(`[click](${url})`);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
    expect(html).toContain("click");
  }
});
