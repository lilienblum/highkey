import { expect, test } from "bun:test";
import type { Event } from "./client";
import { trackAnthropic, trackOpenAI, trackVercelAI, vercelAIHooks } from "./ai";

function collector() {
  const events: Event[] = [];
  return {
    events,
    send: async (event: Event) => {
      events.push(event);
      return { accepted: 1, duplicates: 0 };
    },
  };
}
const options = { source: "server", model: "test-model" };

test("generation wrappers preserve results and failures without collecting prompts or error messages", async () => {
  const client = collector();
  const result = { usage: { prompt_tokens: 10, completion_tokens: 2 }, output: "private" };
  expect(
    await trackOpenAI(
      client,
      {
        ...options,
        prompt: "private",
        trace_id: "trace-1",
        cost: 0.002,
        visit: { actor_id: "visitor", session_id: "visit" },
      },
      () => result,
    ),
  ).toBe(result);
  expect(client.events[0].ai_prompt).toBeUndefined();
  expect(client.events[0]).toMatchObject({
    actor_id: "visitor",
    session_id: "visit",
    identity_kind: "visitor",
  });
  expect(client.events[0].properties).toMatchObject({
    provider: "openai",
    input_tokens: 10,
    output_tokens: 2,
    trace_id: "trace-1",
    cost: 0.002,
    error: false,
  });
  const error = new Error("secret provider request");
  await expect(
    trackAnthropic(client, options, () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(client.events[1].properties?.error).toBe(true);
  expect(client.events[1].session_id).toBeUndefined();
  expect(JSON.stringify(client.events)).not.toContain("private");
  expect(JSON.stringify(client.events)).not.toContain("secret provider request");
  expect(
    await trackVercelAI(
      {
        send: async () => {
          throw new Error("offline");
        },
      },
      options,
      () => result,
    ),
  ).toBe(result);
});

test("stream instrumentation is lazy, preserves chunks and uses cumulative Anthropic usage", async () => {
  const client = collector();
  let advanced = 0;
  const chunks = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 4 } },
    },
    { type: "message_delta", usage: { input_tokens: null, output_tokens: 8 } },
    { type: "message_delta", usage: { output_tokens: 12 } },
  ];
  async function* stream() {
    for (const chunk of chunks) {
      advanced++;
      yield chunk;
    }
  }
  const tracked = await trackAnthropic(client, options, stream);
  expect(advanced).toBe(0);
  const got = [];
  for await (const chunk of tracked) got.push(chunk);
  expect(got).toEqual(chunks);
  expect(client.events).toHaveLength(1);
  expect(client.events[0].properties).toMatchObject({
    input_tokens: 20,
    output_tokens: 12,
    cached_input_tokens: 4,
    cancelled: false,
  });
});

test("stream cancellation closes the source and reports once without inventing usage", async () => {
  const client = collector();
  let closed = false;
  async function* stream() {
    try {
      yield { delta: "hello" };
      yield { delta: "world" };
    } finally {
      closed = true;
    }
  }
  for await (const _chunk of await trackOpenAI(client, options, stream)) break;
  expect(closed).toBe(true);
  expect(client.events).toHaveLength(1);
  expect(client.events[0].properties?.cancelled).toBe(true);
  expect(client.events[0].properties?.input_tokens).toBeUndefined();
});

test("stream failures preserve the provider error and reported error events are labelled", async () => {
  const client = collector();
  const failure = new Error("provider failure");
  async function* stream() {
    yield {
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 3 } },
    };
    throw failure;
  }
  const tracked = await trackOpenAI(client, options, stream);
  const consume = async () => {
    for await (const _chunk of tracked) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toBe(failure);
  expect(client.events[0].properties).toMatchObject({
    error: true,
    input_tokens: 12,
    output_tokens: 3,
  });
  async function* failed() {
    yield { type: "response.failed", response: { error: { message: "private" } } };
  }
  for await (const _chunk of await trackOpenAI(client, options, failed)) {
    /* consume */
  }
  expect(client.events[1].properties?.error).toBe(true);
  expect(JSON.stringify(client.events)).not.toContain("private");
});

test("Vercel callbacks finish once, use total usage and bound opted-in Unicode prompts", async () => {
  const client = collector();
  const hooks = vercelAIHooks(client, {
    ...options,
    capturePrompt: true,
    prompt: "🟢".repeat(10000),
    cost: (usage) => (usage.input_tokens ?? 0) / 1e6,
  });
  const result = { usage: { inputTokens: 1 }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  await hooks.onEnd(result);
  await hooks.onFinish(result);
  expect(client.events).toHaveLength(1);
  expect(client.events[0].properties).toMatchObject({
    input_tokens: 100,
    output_tokens: 20,
    cost: 0.0001,
  });
  expect(new TextEncoder().encode(client.events[0].ai_prompt).length).toBe(32768);
  expect(client.events[0].ai_prompt).not.toContain("�");
});
