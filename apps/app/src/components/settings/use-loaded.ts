import { useCallback, useEffect, useState } from "react";

/** Loads data for a settings page, with a reload for after each change. */
export function useLoaded<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  // `load` is the page's own loader; `generation` asks for a reload.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => {
        setData(value);
        setError(undefined);
      },
      (failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message || "Couldn’t load this.");
      },
    );
    return () => controller.abort();
  }, [generation]);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  return { data, error, reload, loading: data === undefined && error === undefined };
}
