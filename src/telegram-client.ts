import ky from "ky";
import { z } from "zod";

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SleepFunction = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type RequestSignals = {
  readonly combined: AbortSignal;
  readonly caller?: AbortSignal;
  readonly timeout: AbortSignal;
};

export interface TelegramClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly sleep?: SleepFunction;
  readonly fetch?: FetchFunction;
  readonly createTimeoutSignal?: (milliseconds: number) => AbortSignal;
}

export class TelegramClientError extends Error {
  override readonly name = "TelegramClientError";
}

const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

const telegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: telegramChatSchema,
  text: z.string().optional(),
});

const telegramErrorSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string(),
  parameters: z
    .object({
      retry_after: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function sanitizeDescription(description: string, token: string): string {
  return description
    .replaceAll(token, "[redacted]")
    .replaceAll(/https?:\/\/\S+/gu, "[redacted-url]");
}

function parseEnvelope<T>(value: unknown, resultSchema: z.ZodType<T>) {
  return z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), result: resultSchema }),
      telegramErrorSchema,
    ])
    .safeParse(value);
}

export class TelegramClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #sleep: SleepFunction;
  readonly #fetch: FetchFunction | undefined;
  readonly #createTimeoutSignal: (milliseconds: number) => AbortSignal;

  constructor(options: TelegramClientOptions) {
    const token = options.token.trim();
    if (token.length === 0) throw new TelegramClientError("Telegram token is required");
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/u, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#fetch = options.fetch;
    this.#createTimeoutSignal = options.createTimeoutSignal ?? AbortSignal.timeout;
  }

  async getMe(signal?: AbortSignal) {
    return this.#request("getMe", {}, telegramUserSchema, signal);
  }

  async getChat(chatId: string, signal?: AbortSignal) {
    return this.#request("getChat", { chat_id: chatId }, telegramChatSchema, signal);
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal) {
    const length = [...text].length;
    if (length < 1 || length > 4096) {
      throw new TelegramClientError("Telegram message must contain 1 to 4096 characters");
    }
    return this.#request("sendMessage", { chat_id: chatId, text }, telegramMessageSchema, signal);
  }

  async #request<T>(
    method: "getMe" | "getChat" | "sendMessage",
    body: Readonly<Record<string, string>>,
    resultSchema: z.ZodType<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = this.#createTimeoutSignal(this.#timeoutMs);
    const signal =
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    const signals: RequestSignals = {
      combined: signal,
      timeout: timeoutSignal,
      ...(callerSignal === undefined ? {} : { caller: callerSignal }),
    };
    const url = `${this.#baseUrl}/bot${encodeURIComponent(this.#token)}/${method}`;
    let rateLimitRetries = 0;
    let serverRetries = 0;

    while (true) {
      if (signal.aborted) throw this.#signalError(signals);
      let response: Response;
      try {
        response = await ky.post(url, {
          json: body,
          retry: 0,
          timeout: false,
          throwHttpErrors: false,
          signal,
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        });
      } catch {
        throw signal.aborted
          ? this.#signalError(signals)
          : new TelegramClientError("Telegram request failed");
      }

      if (response.status >= 500 && response.status <= 599 && serverRetries < 2) {
        const delay = 100 * 2 ** serverRetries;
        serverRetries += 1;
        await this.#pause(delay, signals);
        continue;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new TelegramClientError("Telegram returned an invalid response");
      }
      const parsed = parseEnvelope(payload, resultSchema);
      if (!parsed.success) throw new TelegramClientError("Telegram returned an invalid response");
      if (response.ok && parsed.data.ok) return parsed.data.result;
      if (!parsed.data.ok && (response.status === 401 || response.status === 404)) {
        throw new TelegramClientError(
          "Telegram bot token was rejected. Paste the token exactly as BotFather provided it, without a 'bot' prefix, quotes, or spaces.",
        );
      }

      if (
        response.status === 429 &&
        !parsed.data.ok &&
        rateLimitRetries === 0 &&
        parsed.data.parameters?.retry_after !== undefined
      ) {
        rateLimitRetries += 1;
        await this.#pause(parsed.data.parameters.retry_after * 1000, signals);
        continue;
      }

      const description = parsed.data.ok ? "Unexpected HTTP status" : parsed.data.description;
      throw new TelegramClientError(
        `Telegram request failed: ${sanitizeDescription(description, this.#token)}`,
      );
    }
  }

  #signalError(signals: RequestSignals): TelegramClientError {
    if (signals.caller?.aborted === true) {
      return new TelegramClientError("Telegram request cancelled");
    }
    if (signals.timeout.aborted) return new TelegramClientError("Telegram request timed out");
    return new TelegramClientError("Telegram request cancelled");
  }

  async #pause(milliseconds: number, signals: RequestSignals): Promise<void> {
    try {
      await this.#sleep(milliseconds, signals.combined);
    } catch {
      if (signals.combined.aborted) throw this.#signalError(signals);
      throw new TelegramClientError("Telegram retry delay failed");
    }
  }
}
