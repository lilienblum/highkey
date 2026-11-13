import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from "react";
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual";
import type { LogRow } from "@/lib/logs";
import { displayTimestamp } from "@/lib/display-time";

export function LogStream({
  logs,
  timeZone,
  viewportRef,
  selectedId,
  onInspect,
  onBrowse,
  onLoadOlder,
  canLoadOlder,
}: {
  logs: LogRow[];
  timeZone: string;
  viewportRef: RefObject<HTMLElement | null>;
  selectedId?: string;
  onInspect: (log: LogRow, opener: HTMLButtonElement) => void;
  onBrowse: () => void;
  onLoadOlder: () => void;
  canLoadOlder: boolean;
}) {
  const [activeId, setActiveId] = useState(logs[0]?.log_id);
  const focusRequested = useRef(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 600px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const activeIndex = Math.max(
    0,
    logs.findIndex((log) => log.log_id === activeId),
  );
  const selectedIndex = logs.findIndex((log) => log.log_id === selectedId);
  // The page is the only scroll container; rows are positioned from the list's place on the page.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const top = (viewportRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    if (Math.abs(top - scrollMargin) > 0.5) setScrollMargin(top);
  });
  const virtualizer = useWindowVirtualizer<HTMLLIElement>({
    count: logs.length,
    getItemKey: useCallback((index: number) => logs[index].log_id, [logs]),
    estimateSize: () => (mobile ? 60 : 35),
    overscan: 8,
    scrollMargin,
    // Keeps keyboard-focused rows clear of the sticky column header.
    scrollPaddingStart: 40,
    rangeExtractor: useCallback(
      (range: Range) =>
        [
          ...new Set([
            ...defaultRangeExtractor(range),
            activeIndex,
            ...(selectedIndex >= 0 ? [selectedIndex] : []),
          ]),
        ].sort((a, b) => a - b),
      [activeIndex, selectedIndex],
    ),
  });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        virtualizer.measure();
      }
    });
    observer.observe(element);
    virtualizer.measure();
    return () => observer.disconnect();
  }, [virtualizer, viewportRef]);
  const items = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    const row = rows.current.get(logs[activeIndex]?.log_id);
    if (row) {
      row.focus({ preventScroll: true });
      focusRequested.current = false;
    }
  });
  const checkEnd = useCallback(() => {
    const element = viewportRef.current;
    if (
      element &&
      window.scrollY > 0 &&
      canLoadOlder &&
      element.getBoundingClientRect().bottom - window.innerHeight < 300
    )
      onLoadOlder();
  }, [viewportRef, canLoadOlder, onLoadOlder]);
  useEffect(checkEnd, [checkEnd]);
  useEffect(() => {
    const scroll = () => {
      // Reading past the newest rows pauses Follow, as scrolling the list did.
      if ((viewportRef.current?.getBoundingClientRect().top ?? 0) < 0) onBrowse();
      checkEnd();
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, [viewportRef, onBrowse, checkEnd]);
  function move(event: KeyboardEvent, index: number) {
    let target: number;
    switch (event.key) {
      case "ArrowDown":
        target = index + 1;
        break;
      case "ArrowUp":
        target = index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = logs.length - 1;
        break;
      case "PageDown":
        target = index + Math.max(1, Math.floor(window.innerHeight / (mobile ? 60 : 35)));
        break;
      case "PageUp":
        target = index - Math.max(1, Math.floor(window.innerHeight / (mobile ? 60 : 35)));
        break;
      default:
        return;
    }
    event.preventDefault();
    target = Math.max(0, Math.min(logs.length - 1, target));
    focusRequested.current = true;
    setActiveId(logs[target].log_id);
    virtualizer.scrollToIndex(target, { align: "auto" });
  }
  const shortTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  return (
    <>
      <p id="log-stream-keyboard-help" className="sr-only">
        Use Up and Down to move between logs, Home and End to reach loaded records, and Enter to
        inspect.
      </p>
      <section
        className="logs-viewport"
        ref={viewportRef}
        aria-label="Log records"
        aria-describedby="log-stream-keyboard-help"
        tabIndex={-1}
      >
        <ul
          className="logs-virtual-body"
          aria-label="Loaded log records"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const log = logs[item.index];
            return (
              <li
                className="log-virtual-row"
                aria-posinset={item.index + 1}
                aria-setsize={logs.length}
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
              >
                <button
                  type="button"
                  className="log-row"
                  data-log-id={log.log_id}
                  data-level={log.level}
                  tabIndex={item.index === activeIndex ? 0 : -1}
                  ref={(element) => {
                    if (element) rows.current.set(log.log_id, element);
                    else rows.current.delete(log.log_id);
                  }}
                  onFocus={() => setActiveId(log.log_id)}
                  onKeyDown={(event) => move(event, item.index)}
                  onClick={(event) => onInspect(log, event.currentTarget)}
                  aria-label={`Inspect ${log.level} log at ${displayTimestamp(log.timestamp, timeZone)}: ${log.message.slice(0, 160)}`}
                >
                  <time
                    dateTime={new Date(log.timestamp).toISOString()}
                    title={displayTimestamp(log.timestamp, timeZone)}
                  >
                    <span className="log-full-time">
                      {displayTimestamp(log.timestamp, timeZone)}
                    </span>
                    <span className="log-short-time" aria-hidden="true">
                      {shortTime.format(log.timestamp)}
                    </span>
                  </time>
                  <span className="log-level" data-level={log.level}>
                    {log.level}
                  </span>
                  <span className="log-service" title={log.service}>
                    {log.service}
                  </span>
                  <span className="log-message">{log.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
