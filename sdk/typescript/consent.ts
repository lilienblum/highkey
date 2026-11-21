import {
  browserNamespace,
  browserPrivacyBlocked,
  persistentSource,
  startBrowserTracker,
  type BrowserOptions,
} from "./browser.js";
import { mountConsentPrompt, type ConsentAppearance } from "./consent-ui.js";
export type { ConsentAppearance } from "./consent-ui.js";

type Options = Omit<BrowserOptions, "identity" | "defer"> & { appearance?: ConsentAppearance };
type Choice = "allow" | "decline" | null;

/** Install once in the browser. There is no tracker, including no pre-consent queue, until Allow. */
export function registerAnalyticsConsent(options: Options) {
  if (!options.key.trim() || options.key.startsWith("sk_"))
    throw new Error("Use a public browser key");
  const namespace = browserNamespace(options),
    key = `${namespace}:consent:v1`;
  const abort = new AbortController();
  let tracker: ReturnType<typeof startBrowserTracker> | undefined;
  let panel: HTMLElement | undefined,
    opener: HTMLElement | null = null;
  let choice: Choice = null,
    eligible = false,
    disposed = false;
  const blocked = () => disposed || browserPrivacyBlocked(options);
  function read(): Choice {
    try {
      const stored = localStorage.getItem(key);
      return stored === "allow" || stored === "decline" ? stored : null;
    } catch {
      return choice;
    }
  }
  function close() {
    panel?.remove();
    panel = undefined;
    opener?.focus({ preventScroll: true });
    opener = null;
  }
  function show(manual = false) {
    if (!eligible || blocked() || !document.body) return;
    if (!panel) panel = mountConsentPrompt(document.body, options.appearance ?? {}, decide, choice);
    if (manual) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panel
        .querySelector<HTMLButtonElement>(
          choice === "allow" ? ".hk-consent-allow" : ".hk-consent-decline",
        )
        ?.focus();
    }
  }
  function apply(next: Choice) {
    close();
    choice = next;
    if (next !== "allow" || blocked()) {
      tracker?.optOut();
      tracker = undefined;
    } else {
      tracker ??= startBrowserTracker({ ...options, identity: "persistent" });
    }
    if (!next) show();
  }
  function decide(allow: boolean) {
    if (!eligible || blocked()) {
      apply(null);
      return;
    }
    const next = allow ? "allow" : "decline";
    try {
      localStorage.setItem(key, next);
    } catch {
      /* The choice lasts for this page. */
    }
    apply(next);
  }
  function sync(event: StorageEvent) {
    if (event.key === key || event.key === null) reconcile();
  }
  function reconcile() {
    if (blocked()) {
      apply(null);
      return;
    }
    const stored = read();
    if (stored !== choice) apply(stored);
  }
  function preferencesClick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest("[data-highkey-privacy]")) {
      event.preventDefault();
      show(true);
    }
  }
  function escape(event: KeyboardEvent) {
    if (event.key === "Escape" && panel && (opener || panel.contains(document.activeElement)))
      close();
  }
  function detach() {
    disposed = true;
    abort.abort();
    close();
    window.removeEventListener("storage", sync);
    window.removeEventListener("pageshow", reconcile);
    document.removeEventListener("click", preferencesClick);
    document.removeEventListener("keydown", escape);
    document.removeEventListener("DOMContentLoaded", initialPrompt);
    options.signal?.removeEventListener("abort", onAbort);
  }
  function onAbort() {
    tracker?.optOut();
    tracker = undefined;
    detach();
  }
  function initialPrompt() {
    if (!choice) show();
  }
  const ready = (async () => {
    if (blocked()) return;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // A stale Returning-visitors snippet must not prompt or access storage on an Off source.
    try {
      if (!(await persistentSource(options, abort.signal)) || blocked()) return;
    } catch {
      return;
    }
    eligible = true;
    window.addEventListener("storage", sync);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("click", preferencesClick);
    document.addEventListener("keydown", escape);
    apply(read());
    if (!document.body)
      document.addEventListener("DOMContentLoaded", initialPrompt, { once: true });
  })();
  return {
    ready,
    get tracker() {
      return tracker;
    },
    openPreferences() {
      void ready.then(() => show(true));
    },
    async destroy() {
      detach();
      const active = tracker;
      tracker = undefined;
      await active?.shutdown();
    },
  };
}
