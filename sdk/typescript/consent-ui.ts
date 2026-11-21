/** Ordinary light DOM and low-specificity CSS so the host can style every part. */
export type ConsentAppearance = {
  layout?: "bar" | "corner";
  theme?: "auto" | "light" | "dark";
  unstyled?: boolean;
  nonce?: string;
};

const css = `
:where(.hk-consent) {
  color-scheme: light dark;
  --hk-bg: var(--card, light-dark(#fff, #202022));
  --hk-fg: var(--card-foreground, light-dark(#202022, #fafafa));
  --hk-muted: var(--muted-foreground, light-dark(#52525b, #c4c4ca));
  --hk-border: var(--border, light-dark(#d4d4d8, #55555c));
  --hk-hover: var(--accent, light-dark(#f4f4f5, #303035));
  --hk-ring: var(--ring, currentColor);
  position: fixed; z-index: var(--hk-consent-z-index, 1000);
  inset: auto 1rem max(1rem, env(safe-area-inset-bottom));
  box-sizing: border-box; max-width: 54rem; margin-inline: auto;
  max-height: 70vh; overflow: auto;
  display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.5rem;
  padding: 1rem 1.25rem;
  background: var(--hk-consent-bg, var(--hk-bg)); color: var(--hk-consent-fg, var(--hk-fg));
  border: 1px solid var(--hk-consent-border, var(--hk-border));
  border-radius: var(--hk-consent-radius, var(--radius, .75rem));
  box-shadow: 0 .5rem 2rem #0002; font: inherit; text-align: start;
}
:where(.dark .hk-consent, [data-theme="dark"] .hk-consent) { color-scheme: dark; }
:where(.light .hk-consent, [data-theme="light"] .hk-consent) { color-scheme: light; }
:where(.hk-consent[data-theme="dark"], .hk-consent[data-theme="light"]) {
  --hk-bg: light-dark(#fff, #202022); --hk-fg: light-dark(#202022, #fafafa);
  --hk-muted: light-dark(#52525b, #c4c4ca); --hk-border: light-dark(#d4d4d8, #55555c);
  --hk-hover: light-dark(#f4f4f5, #303035);
}
:where(.hk-consent[data-theme="dark"]) { color-scheme: dark; }
:where(.hk-consent[data-theme="light"]) { color-scheme: light; }
:where(.hk-consent[data-layout="corner"]) { max-width: 23rem; margin-inline-end: 0; }
:where(.hk-consent[data-preview]) { position: static; z-index: auto; margin: 0; box-shadow: none; }
:where(.hk-consent-copy) { flex: 1 1 18rem; min-width: 0; }
:where(.hk-consent-title) { margin: 0; font: inherit; font-weight: 600; }
:where(.hk-consent-description) { margin: .25rem 0 0; font: inherit; font-size: .875em; line-height: 1.5; color: var(--hk-consent-muted, var(--hk-muted)); }
:where(.hk-consent-actions) { display: flex; flex-wrap: wrap; gap: .5rem; }
:where(.hk-consent-button) {
  appearance: none; box-sizing: border-box; cursor: pointer; min-height: 2.5rem; min-width: 5rem;
  padding: .375rem .875rem; font: inherit; font-size: .875em; font-weight: 500;
  border-radius: var(--hk-consent-radius, var(--radius, .5rem));
  color: inherit; background: transparent; border: 1px solid var(--hk-consent-border, var(--hk-border));
}
:where(.hk-consent-button:hover) { background: var(--hk-consent-hover, var(--hk-hover)); }
:where(.hk-consent-button:focus-visible) { outline: 2px solid var(--hk-consent-ring, var(--hk-ring)); outline-offset: 2px; }
`;

let sequence = 0;
export function mountConsentPrompt(
  parent: HTMLElement,
  appearance: ConsentAppearance,
  choose: (allow: boolean) => void,
  choice: "allow" | "decline" | null,
  preview = false,
) {
  const panel = document.createElement("section");
  panel.className = "hk-consent";
  panel.dataset.layout = appearance.layout ?? "bar";
  panel.dataset.theme = appearance.theme ?? "auto";
  panel.setAttribute("role", "dialog");
  if (preview) {
    panel.dataset.preview = "";
    panel.inert = true;
  }
  const title = document.createElement("p"),
    description = document.createElement("p");
  title.className = "hk-consent-title";
  title.id = `hk-consent-title-${++sequence}`;
  title.textContent = "Allow visitor analytics?";
  description.className = "hk-consent-description";
  description.id = `${title.id}-description`;
  description.textContent =
    "This site would like to remember this browser to count return visits. You can change your choice later.";
  panel.setAttribute("aria-labelledby", title.id);
  panel.setAttribute("aria-describedby", description.id);
  const copy = document.createElement("div"),
    actions = document.createElement("div");
  copy.className = "hk-consent-copy";
  copy.append(title, description);
  actions.className = "hk-consent-actions";
  for (const option of ["decline", "allow"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hk-consent-button hk-consent-${option}`;
    button.textContent = option === "allow" ? "Allow" : "Decline";
    if (choice) button.setAttribute("aria-pressed", String(choice === option));
    button.onclick = () => choose(option === "allow");
    actions.append(button);
  }
  if (!appearance.unstyled) {
    const style = document.createElement("style");
    if (appearance.nonce) style.nonce = appearance.nonce;
    style.textContent = css;
    panel.append(style);
  }
  panel.append(copy, actions);
  parent.append(panel);
  return panel;
}
