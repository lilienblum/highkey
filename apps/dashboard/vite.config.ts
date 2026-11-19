import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { tako } from "tako.sh/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

/** Markdown imports are their text, as Bun's `[loader]` in bunfig.toml makes them. */
function markdownText(): Plugin {
  return {
    name: "highkey-markdown-text",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), markdownText(), tanstackStart(), react(), tako()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  // Tako reads channel metadata through this internal development hostname.
  server: { port: 3000, allowedHosts: ["highkey.tako"] },
});
