import type { Event, Highkey, Properties } from "./client.js";

export interface GenerationOptions {
  source: string;
  model: string;
  profile_id?: string;
  /** Explicit attribution to a visitor's existing session, if available. */
  visit?: { actor_id: string; session_id: string };
  groups?: Record<string, string>;
  trace_id?: string;
  properties?: Properties;
  /** USD for this call, or a calculator using the provider's reported token counts. */
  cost?: number | ((usage: TokenUsage) => number | undefined);
  /** Prompts are never read from provider requests. Supply text and opt in explicitly. */
  capturePrompt?: boolean;
  prompt?: string;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
}

type Provider = "openai" | "anthropic" | "vercel";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function usageOf(value: unknown, provider: Provider): TokenUsage {
  const outer = object(value);
  const result = object(outer.response ?? outer.message ?? value);
  const usage = object(result.totalUsage ?? result.usage);
  const tokens: TokenUsage = {};
  const set = (key: keyof TokenUsage, value: unknown) => {
    const n = count(value);
    if (n !== undefined) tokens[key] = n;
  };
  set("input_tokens", usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
  set("output_tokens", usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
  if (provider === "anthropic") {
    set("cached_input_tokens", usage.cache_read_input_tokens);
    set("cache_write_tokens", usage.cache_creation_input_tokens);
  } else {
    set(
      "cached_input_tokens",
      object(usage.input_tokens_details ?? usage.prompt_tokens_details).cached_tokens ??
        object(usage.inputTokenDetails).cacheReadTokens,
    );
  }
  return tokens;
}

function boundedPrompt(text: string): string {
  let bytes = 0;
  let end = 0;
  const encoder = new TextEncoder();
  for (const char of text) {
    bytes += encoder.encode(char).byteLength;
    if (bytes > 32768) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function generation(client: Pick<Highkey, "send">, provider: Provider, options: GenerationOptions) {
  const started = performance.now();
  const event: Event = {
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    name: "ai_generation",
    source: options.source,
    profile_id: options.profile_id,
    ...(options.visit
      ? {
          actor_id: options.visit.actor_id,
          session_id: options.visit.session_id,
          identity_kind: "visitor",
        }
      : {}),
    groups: options.groups ? { ...options.groups } : undefined,
    properties: {
      ...options.properties,
      provider,
      model: options.model,
      ...(options.trace_id ? { trace_id: options.trace_id } : {}),
    },
    ...(options.capturePrompt && options.prompt !== undefined
      ? { ai_prompt: boundedPrompt(options.prompt) }
      : {}),
  };
  let sent = false;
  let usage: TokenUsage = {};
  let providerError = false;
  let interrupted = false;
  return {
    observe(value: unknown) {
      usage = { ...usage, ...usageOf(value, provider) };
      const result = object(value);
      providerError ||=
        result.type === "error" ||
        result.type === "response.failed" ||
        result.finishReason === "error" ||
        result.status === "failed";
      interrupted ||=
        result.finishReason === "interrupted" ||
        result.type === "response.incomplete" ||
        result.status === "incomplete";
    },
    async finish(error = false, cancelled = false) {
      if (sent) return;
      sent = true;
      try {
        let cost: number | undefined;
        try {
          cost = typeof options.cost === "function" ? options.cost(usage) : options.cost;
        } catch {
          /* Cost is optional. */
        }
        await client.send({
          ...event,
          properties: {
            ...event.properties,
            ...usage,
            latency_ms: Math.max(0, performance.now() - started),
            error: error || providerError,
            cancelled: cancelled || interrupted,
            ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
              ? { cost, currency: "USD" }
              : {}),
          },
        });
      } catch {
        /* Telemetry must never replace the provider's result or error. */
      }
    },
  };
}

async function track<T>(
  client: Pick<Highkey, "send">,
  provider: Provider,
  options: GenerationOptions,
  call: () => T | PromiseLike<T>,
): Promise<T> {
  const observer = generation(client, provider, options);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    await observer.finish(true);
    throw error;
  }
  if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
    const stream = result as T & AsyncIterable<unknown>;
    return new Proxy(stream, {
      get(target, property) {
        if (property === Symbol.asyncIterator)
          return async function* () {
            let completed = false;
            let failed = false;
            try {
              for await (const chunk of target) {
                observer.observe(chunk);
                yield chunk;
              }
              completed = true;
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              await observer.finish(failed, !completed && !failed);
            }
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  observer.observe(result);
  await observer.finish();
  return result;
}

/** Wrap responses.create or chat.completions.create; async-iterator streams remain lazy. */
export const trackOpenAI = <T>(
  client: Pick<Highkey, "send">,
  options: GenerationOptions,
  call: () => T | PromiseLike<T>,
) => track(client, "openai", options, call);

/** Wrap messages.create, including stream:true. Cumulative token deltas replace earlier counts. */
export const trackAnthropic = <T>(
  client: Pick<Highkey, "send">,
  options: GenerationOptions,
  call: () => T | PromiseLike<T>,
) => track(client, "anthropic", options, call);

/** Wrap generateText. For streamText use vercelAIHooks without reading or draining the stream. */
export const trackVercelAI = <T>(
  client: Pick<Highkey, "send">,
  options: GenerationOptions,
  call: () => T | PromiseLike<T>,
) => track(client, "vercel", options, call);

/** Spread into streamText options. Both completion names support AI SDK 6 and newer versions. */
export function vercelAIHooks(client: Pick<Highkey, "send">, options: GenerationOptions) {
  const observer = generation(client, "vercel", options);
  const complete = async (result: unknown) => {
    observer.observe(result);
    const reason = object(result).finishReason;
    await observer.finish(reason === "error", reason === "interrupted");
  };
  return {
    onFinish: complete,
    onEnd: complete,
    onError: async () => observer.finish(true),
    onAbort: async () => observer.finish(false, true),
  };
}
