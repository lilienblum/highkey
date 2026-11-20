import { Highkey, type Event, type Options, type Properties } from "./client.js";
const campaignParams = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export type CampaignParam = (typeof campaignParams)[number];
export type BrowserOptions = Options & {
  enabled?: boolean;
  defer?: boolean;
  properties?: Properties;
  filter?: (event: Event) => boolean;
  identity?: "none" | "persistent";
  identityScope?: string;
  campaigns?: readonly CampaignParam[];
  collectReferrer?: boolean;
  collectTitle?: boolean;
  trackHashChanges?: boolean;
  trackOutboundLinks?: boolean;
  trackAttributes?: boolean;
  sanitizePath?: (path: string) => string | null;
  beforeSend?: (event: Event) => Event | null;
  capacity?: number;
};
/** No identity or campaign values by default. The host application owns consent. */
export function startBrowserTracker(options: BrowserOptions) {
  const namespace = `highkey:${new URL(options.endpoint, location.href).origin}:${options.identityScope ?? options.key}`;
  const capacity = options.capacity ?? 100;
  const campaignKeys = campaignParams.filter((key) => options.campaigns?.includes(key));
  const queue: Event[] = [];
  const delivery = new AbortController();
  let running: Promise<void> | undefined;
  let stopped = false;
  let optedOut = false;
  let deferred = options.defer === true;
  let globalProperties = { ...options.properties };
  let actor: string | undefined;
  let profile: string | undefined;
  let groups: Record<string, string> = {};
  let cleanup = () => {};
  const privacyBlocked = () =>
    options.enabled === false ||
    options.signal?.aborted === true ||
    navigator.doNotTrack === "1" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  function stop() {
    stopped = true;
    cleanup();
  }
  function optOut() {
    optedOut = true;
    stop();
    queue.length = 0;
    delivery.abort();
    actor = undefined;
    profile = undefined;
    groups = {};
    try {
      localStorage.removeItem(`${namespace}:visitor`);
      localStorage.removeItem(`${namespace}:session`);
    } catch {
      /* Storage may be unavailable; collection is still stopped. */
    }
  }
  function canTrack() {
    if (stopped) return false;
    if (!privacyBlocked()) return true;
    optOut();
    return false;
  }
  function identity(): Pick<Event, "actor_id" | "identity_kind" | "session_id"> {
    if (!actor) return {};
    try {
      const raw = localStorage.getItem(`${namespace}:session`);
      const previous = raw ? (JSON.parse(raw) as { id: string; seen: number }) : undefined;
      const session = {
        id:
          previous && Date.now() - previous.seen < 30 * 60 * 1000
            ? previous.id
            : crypto.randomUUID(),
        seen: Date.now(),
      };
      localStorage.setItem(`${namespace}:session`, JSON.stringify(session));
      return { actor_id: actor, identity_kind: "visitor", session_id: session.id };
    } catch {
      actor = undefined;
      return {};
    }
  }
  function enqueue(name: string, properties: Properties = {}, record: Partial<Event> = {}) {
    if (!canTrack() || queue.length >= capacity) return false;
    const event: Event = {
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      name,
      source: "browser",
      properties: { ...globalProperties, ...properties },
      ...identity(),
      ...(profile ? { profile_id: profile } : {}),
      ...(Object.keys(groups).length ? { groups: { ...groups } } : {}),
      ...record,
    };
    try {
      if (options.filter && !options.filter(event)) return false;
      const accepted = options.beforeSend ? options.beforeSend(event) : event;
      if (!accepted || !canTrack()) return false;
      queue.push({
        ...accepted,
        properties: { ...accepted.properties },
        ...(accepted.traits ? { traits: { ...accepted.traits } } : {}),
        ...(accepted.increments ? { increments: { ...accepted.increments } } : {}),
        ...(accepted.groups ? { groups: { ...accepted.groups } } : {}),
      });
    } catch {
      return false;
    }
    if (queue.length >= 20) void flush();
    return true;
  }
  function track(name: string, properties: Properties = {}) {
    return enqueue(name, properties);
  }
  const validId = (id: string) =>
    typeof id === "string" && id.length > 0 && new TextEncoder().encode(id).length <= 128;
  function pageView() {
    if (!canTrack()) return false;
    const url = new URL(location.href);
    const properties: Properties = {};
    try {
      const route = url.pathname + (options.trackHashChanges ? url.hash : "");
      const path = options.sanitizePath ? options.sanitizePath(route) : route;
      if (path !== null) properties.path = path;
    } catch {
      return false;
    }
    if (options.collectTitle) properties.title = document.title.slice(0, 512);
    if (options.collectReferrer !== false) {
      try {
        properties.referrer = document.referrer ? new URL(document.referrer).hostname : "Direct";
      } catch {
        properties.referrer = "Direct";
      }
    }
    for (const key of campaignKeys) {
      const value = url.searchParams.get(key);
      if (value) properties[key] = value.slice(0, 2048);
    }
    return track("page_view", properties);
  }
  function flush(): Promise<void> {
    if (optedOut) return Promise.resolve();
    if (privacyBlocked()) {
      optOut();
      return Promise.resolve();
    }
    if (deferred) return Promise.resolve();
    if (running) return running;
    const batch = queue.splice(0, 20);
    if (!batch.length) return Promise.resolve();
    running = (async () => {
      // Leave framing headroom under keepalive's limit; a large single event uses ordinary fetch.
      while (
        batch.length > 1 &&
        new TextEncoder().encode(JSON.stringify({ events: batch })).byteLength > 60_000
      ) {
        queue.unshift(...batch.splice(-1));
      }
      await client.sendBatch(batch);
    })()
      .then(
        () => {},
        () => {}, // Best effort: retries are bounded; drop failed batches.
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  }
  const tracker = {
    track,
    pageView,
    flush,
    optOut,
    identify(id: string, traits: Properties = {}, increments: Record<string, number> = {}) {
      if (!canTrack() || deferred || !validId(id)) return false;
      const accepted = enqueue(
        "profile_identify",
        {},
        { record_type: "identify", profile_id: id, traits, increments },
      );
      if (accepted) profile = id;
      return accepted;
    },
    group(
      type: string,
      id: string,
      traits: Properties = {},
      name?: string,
      increments: Record<string, number> = {},
    ) {
      if (
        !canTrack() ||
        deferred ||
        !/^[a-zA-Z0-9_./-]{1,64}$/.test(type) ||
        !validId(id) ||
        (!Object.hasOwn(groups, type) && Object.keys(groups).length >= 8)
      )
        return false;
      const accepted = enqueue(
        "group_update",
        {},
        {
          record_type: "group",
          group_type: type,
          group_id: id,
          group_name: name,
          traits,
          increments,
        },
      );
      if (accepted) groups = { ...groups, [type]: id };
      return accepted;
    },
    reset() {
      profile = undefined;
      groups = {};
    },
    setProperties(properties: Properties) {
      if (!canTrack()) return false;
      globalProperties = { ...properties };
      return true;
    },
    ready() {
      if (!canTrack()) return false;
      if (!deferred) return true;
      deferred = false;
      initializeIdentity();
      void flush();
      return true;
    },
    async shutdown() {
      stop();
      if (deferred) queue.length = 0;
      if (optedOut || (!queue.length && !running)) return;
      // Drain accepted events without letting multiple batches extend shutdown's deadline.
      const timer = setTimeout(() => {
        queue.length = 0;
        delivery.abort();
      }, options.timeoutMs ?? 800);
      try {
        do {
          await flush();
        } while ((queue.length || running) && !delivery.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  if (privacyBlocked()) {
    stopped = true;
    optedOut = true;
    return tracker;
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error("capacity must be a positive finite integer");
  const client = new Highkey({
    ...options,
    keepalive: true,
    signal: options.signal ? AbortSignal.any([options.signal, delivery.signal]) : delivery.signal,
  });
  function initializeIdentity() {
    if (options.identity !== "persistent") return;
    try {
      const stored = localStorage.getItem(`${namespace}:visitor`) ?? crypto.randomUUID();
      localStorage.setItem(`${namespace}:visitor`, stored);
      actor = stored;
    } catch {
      /* Storage denied: anonymous events, no fingerprint fallback. */
    }
  }
  if (!deferred) initializeIdentity();
  const navigationKey = () =>
    location.pathname + location.search + (options.trackHashChanges ? location.hash : "");
  let previous = navigationKey();
  const navigation = () => {
    const next = navigationKey();
    if (next !== previous) {
      previous = next;
      pageView();
    }
  };
  const push = history.pushState;
  const replace = history.replaceState;
  const wrappedPush: History["pushState"] = function (this: History, ...args) {
    push.apply(this, args);
    navigation();
  };
  const wrappedReplace: History["replaceState"] = function (this: History, ...args) {
    replace.apply(this, args);
    navigation();
  };
  const pageHide = () => {
    void flush();
  };
  const click = (event: MouseEvent) => {
    if (!canTrack() || event.button > 1) return;
    const elements = event
      .composedPath()
      .filter((node): node is HTMLElement => node instanceof HTMLElement);
    if (options.trackAttributes) {
      const element = elements.find((node) => node.hasAttribute("data-track"));
      const name = element?.dataset.track;
      if (element && name && /^[a-zA-Z0-9_./-]{1,64}$/.test(name)) {
        const properties = Object.fromEntries(
          Object.entries(element.dataset)
            .filter(([key]) => key !== "track" && /^[a-zA-Z0-9_./-]{1,64}$/.test(key))
            .slice(0, 32)
            .map(([key, value]) => [key, (value ?? "").slice(0, 512)]),
        );
        track(name, properties);
      }
    }
    if (options.trackOutboundLinks) {
      const anchor = elements.find(
        (node): node is HTMLAnchorElement =>
          node instanceof HTMLAnchorElement && node.hasAttribute("href"),
      );
      if (!anchor) return;
      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) return;
      track("link_out", {
        url: `${url.origin}${url.pathname}`.slice(0, 512),
        text: (anchor.textContent ?? "").trim().slice(0, 512),
      });
    }
  };
  const timer = setInterval(() => void flush(), 2000);
  cleanup = () => {
    clearInterval(timer);
    removeEventListener("popstate", navigation);
    if (options.trackHashChanges) removeEventListener("hashchange", navigation);
    removeEventListener("pagehide", pageHide);
    if (options.trackOutboundLinks || options.trackAttributes) {
      removeEventListener("click", click, true);
      removeEventListener("auxclick", click, true);
    }
    options.signal?.removeEventListener("abort", optOut);
    if (history.pushState === wrappedPush) history.pushState = push;
    if (history.replaceState === wrappedReplace) history.replaceState = replace;
  };
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  addEventListener("popstate", navigation);
  if (options.trackHashChanges) addEventListener("hashchange", navigation);
  addEventListener("pagehide", pageHide);
  if (options.trackOutboundLinks || options.trackAttributes) {
    addEventListener("click", click, true);
    addEventListener("auxclick", click, true);
  }
  options.signal?.addEventListener("abort", optOut, { once: true });
  pageView();
  return tracker;
}
