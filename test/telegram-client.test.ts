import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TelegramClient, TelegramClientError } from "../src/telegram-client";

const requestBodySchema = z.record(z.string(), z.string());

type FetchCall = {
  readonly url: string;
  readonly body: Readonly<Record<string, string>>;
};

type ChatResult = {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly first_name?: string;
};

type MessageResult = {
  readonly message_id: number;
  readonly date: number;
  readonly chat: ChatResult;
  readonly text?: string;
};

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function createFetch(responses: readonly (Response | Error)[], calls: FetchCall[]): FetchFunction {
  let index = 0;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const parsedBody = requestBodySchema.parse(await request.clone().json());
    calls.push({ url: request.url, body: parsedBody });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("Unexpected request");
    if (response instanceof Error) throw response;
    return response;
  };
}

const user = {
  id: 7,
  is_bot: true,
  first_name: "Notifier",
  username: "notify_bot",
};
const chat: ChatResult = {
  id: 42,
  type: "private",
  first_name: "Kim",
};
const message: MessageResult = {
  message_id: 9,
  date: 1_700_000_000,
  chat,
  text: "done",
};

describe("TelegramClient", () => {
  test("posts getMe, getChat, and sendMessage with exact bodies", async () => {
    const calls: FetchCall[] = [];
    const client = new TelegramClient({
      token: "synthetic-secret-token",
      baseUrl: "https://telegram.test",
      fetch: createFetch(
        [
          jsonResponse({ ok: true, result: user }),
          jsonResponse({ ok: true, result: chat }),
          jsonResponse({ ok: true, result: message }),
        ],
        calls,
      ),
    });

    expect(await client.getMe()).toEqual(user);
    expect(await client.getChat("-100001")).toEqual(chat);
    expect(await client.sendMessage("-100001", "done")).toEqual(message);
    expect(calls.map(({ body }) => body)).toEqual([
      {},
      { chat_id: "-100001" },
      { chat_id: "-100001", text: "done" },
    ]);
    expect(calls.every(({ url }) => url.startsWith("https://telegram.test/bot"))).toBe(true);
  });

  test("accepts 1 and 4096 Unicode code points", async () => {
    const calls: FetchCall[] = [];
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch(
        [jsonResponse({ ok: true, result: message }), jsonResponse({ ok: true, result: message })],
        calls,
      ),
    });

    await client.sendMessage("1", "🙂");
    await client.sendMessage("1", "🙂".repeat(4096));
    expect(calls).toHaveLength(2);
  });

  test.each(["", "x".repeat(4097)])("rejects invalid text boundary", async (text) => {
    const calls: FetchCall[] = [];
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch([], calls),
    });

    await expect(client.sendMessage("1", text)).rejects.toBeInstanceOf(TelegramClientError);
    expect(calls).toHaveLength(0);
  });

  test("retries 429 once using retry_after", async () => {
    const calls: FetchCall[] = [];
    const delays: number[] = [];
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch(
        [
          jsonResponse(
            {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 2 },
            },
            429,
          ),
          jsonResponse({ ok: true, result: message }),
        ],
        calls,
      ),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(await client.sendMessage("1", "done")).toEqual(message);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  test("retries 5xx twice with exponential delays", async () => {
    const calls: FetchCall[] = [];
    const delays: number[] = [];
    const unavailable = { ok: false, error_code: 500, description: "Unavailable" };
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch(
        [
          jsonResponse(unavailable, 500),
          jsonResponse(unavailable, 503),
          jsonResponse({ ok: true, result: user }),
        ],
        calls,
      ),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(await client.getMe()).toEqual(user);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  test("retries malformed 5xx responses before parsing", async () => {
    const calls: FetchCall[] = [];
    const delays: number[] = [];
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch(
        [
          new Response("<html>bad gateway</html>", { status: 502 }),
          new Response("upstream failure", { status: 503 }),
          jsonResponse({ ok: true, result: user }),
        ],
        calls,
      ),
      sleep: async (milliseconds: number) => {
        delays.push(milliseconds);
      },
    });

    expect(await client.getMe()).toEqual(user);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  test("does not retry ordinary 4xx or malformed responses", async () => {
    const forbiddenCalls: FetchCall[] = [];
    const malformedCalls: FetchCall[] = [];
    const forbidden = new TelegramClient({
      token: "secret",
      fetch: createFetch(
        [jsonResponse({ ok: false, error_code: 403, description: "Forbidden" }, 403)],
        forbiddenCalls,
      ),
    });
    const malformed = new TelegramClient({
      token: "secret",
      fetch: createFetch([jsonResponse({ unexpected: true })], malformedCalls),
    });

    await expect(forbidden.getMe()).rejects.toBeInstanceOf(TelegramClientError);
    await expect(malformed.getMe()).rejects.toBeInstanceOf(TelegramClientError);
    expect(forbiddenCalls).toHaveLength(1);
    expect(malformedCalls).toHaveLength(1);
  });

  test("normalizes token whitespace and explains Telegram 404 rejection", async () => {
    const normalizedCalls: FetchCall[] = [];
    const normalized = new TelegramClient({
      token: " 123456:secret \n",
      baseUrl: "https://telegram.test",
      fetch: createFetch([jsonResponse({ ok: true, result: user })], normalizedCalls),
    });
    const rejected = new TelegramClient({
      token: "bot123456:secret",
      fetch: createFetch(
        [jsonResponse({ ok: false, error_code: 404, description: "Not Found" }, 404)],
        [],
      ),
    });

    expect(await normalized.getMe()).toEqual(user);
    expect(normalizedCalls[0]?.url).toBe("https://telegram.test/bot123456%3Asecret/getMe");
    await expect(rejected.getMe()).rejects.toThrow("BotFather");
  });

  test("propagates caller cancellation without retrying", async () => {
    const calls: FetchCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch([jsonResponse({ ok: true, result: user })], calls),
    });

    await expect(client.getMe(controller.signal)).rejects.toThrow("cancelled");
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  test("supports deterministic timeout injection", async () => {
    const calls: FetchCall[] = [];
    const timeout = new AbortController();
    timeout.abort();
    const client = new TelegramClient({
      token: "secret",
      fetch: createFetch([jsonResponse({ ok: true, result: user })], calls),
      createTimeoutSignal: () => timeout.signal,
    });

    await expect(client.getMe()).rejects.toThrow("timed out");
  });

  test("sanitizes transport errors", async () => {
    const token = "synthetic-secret-token";
    const client = new TelegramClient({
      token,
      fetch: createFetch([new Error(`failed https://api.telegram.org/bot${token}/getMe`)], []),
    });

    let caught: unknown;
    try {
      await client.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramClientError);
    const messageText = caught instanceof Error ? caught.message : String(caught);
    expect(messageText).not.toContain(token);
    expect(messageText).not.toContain("https://");
  });
});
