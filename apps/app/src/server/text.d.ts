// Markdown imports are their text: bunfig.toml's [loader] for Bun, a plugin for Vite.
declare module "*.md" {
  const text: string;
  export default text;
}
