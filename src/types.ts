import type { TObject, TString } from "typebox";

export type MaybePromise<T> = T | Promise<T>;

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolResult<Details = unknown> {
  readonly content: TextContent[];
  readonly details: Details;
}

export interface ToolUpdate<Details = unknown> {
  readonly content?: TextContent[];
  readonly details?: Details;
}

export interface ToolContext {
  readonly cwd: string;
  readonly mode?: "tui" | "rpc" | "app-server" | "json" | "print";
  readonly hasUI?: boolean;
  readonly ui?: UserInterface;
}

export type TelegramToolSchema = TObject<{ text: TString }>;

export interface ToolDefinition<Input, Details = unknown> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TelegramToolSchema;
  readonly execute: (
    toolCallId: string,
    input: Input,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ) => Promise<ToolResult<Details>>;
}

export interface CommandContext {
  readonly cwd: string;
  readonly mode?: "tui" | "rpc" | "app-server" | "json" | "print";
  readonly hasUI?: boolean;
  readonly ui?: UserInterface;
}

export interface CommandDefinition {
  readonly description: string;
  readonly handler: (arguments_: string, context: CommandContext) => Promise<void>;
}

export interface TuiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface CustomTuiComponent extends TuiComponent {
  handleInput(data: string): void;
}

export interface TuiController {
  requestRender(): void;
}

export interface TuiTheme {
  readonly fg: (color: "text" | "muted" | "accent", text: string) => string;
}

export interface CustomComponentOptions {
  readonly overlay?: boolean;
}

export interface UserInterface {
  readonly input: (title: string, placeholder?: string) => Promise<string | undefined>;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly notify: (message: string, level?: "info" | "warning" | "error") => void;
  readonly custom: <T>(
    factory: (
      tui: TuiController,
      theme: TuiTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => TuiComponent | Promise<TuiComponent>,
    options?: CustomComponentOptions,
  ) => Promise<T>;
}

export interface ExtensionAPI {
  registerCommand(name: string, definition: CommandDefinition): void;
  registerTool<Input, Details = unknown>(definition: ToolDefinition<Input, Details>): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => MaybePromise<void>;

export interface TelegramConfig {
  readonly version: 1;
  readonly botToken: string;
  readonly chatId: string;
  readonly botUsername: string;
  readonly updatedAt: string;
}

export interface ResolvedConfiguration {
  readonly botToken: string;
  readonly chatId: string;
  readonly source: "environment" | "file";
  readonly botUsername?: string;
}

export interface TelegramSendResult {
  readonly sent: boolean;
  readonly messageId?: number;
  readonly error?: string;
}
