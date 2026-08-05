# pi-telegram

`pi-telegram` is a host neutral Telegram messaging extension for Pi compatible
agents. One package works in Senpi and Oh My Pi. Both hosts load the same built
entry point, `./dist/index.js`, from the package manifest.

The extension adds four chat commands and one tool:

```text
/telegram-login
/telegram-status
/telegram-test
/telegram-logout
telegram_send
```

It sends messages through the Telegram Bot API. It doesn't read Telegram
messages, handle files, choose recipients for the model, or manage more than one
Telegram target.

## Requirements

You need Bun, a Telegram bot token from BotFather, a numeric target chat or
group/channel ID, and Senpi or Oh My Pi with extension support. The interactive
login may accept `@channelname`, but it resolves and saves Telegram's immutable
numeric ID.

The login flow is TUI only. `/telegram-login` opens masked terminal input for
the bot token. It doesn't accept the token as a command argument, and it doesn't
support non interactive login prompts.

## Installation

Install the package with the command for your host.

For Senpi:

```bash
senpi install git:github.com/OWNER/pi-telegram
```

For Oh My Pi:

```bash
omp plugin install github:OWNER/pi-telegram
```

Replace `OWNER` with the account or organization that publishes this package.

After installation, start the host and run:

```text
/telegram-login
```

## How the package is loaded

The package manifest declares the same extension file for both hosts:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"]
  },
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

Senpi loads `pi.extensions`. Oh My Pi loads `omp.extensions` and can also read
the legacy `pi.extensions` entry. In both cases, the installed package uses
`dist/index.js` after the project has been built.

The implementation is split across `src/index.ts`, `src/config.ts`,
`src/telegram-client.ts`, `src/secret-input.ts`, and `src/types.ts`.

## Configuration

You can configure Telegram credentials with environment variables or a local
config file. Environment variables win over the file.

Precedence:

1. `PI_TELEGRAM_BOT_TOKEN` and `PI_TELEGRAM_CHAT_ID`
2. The config file

Optional config path override:

```bash
PI_TELEGRAM_CONFIG=/custom/path/config.json
```

Default config paths:

```text
macOS and Linux: ${XDG_CONFIG_HOME:-~/.config}/pi-telegram/config.json
Windows: %APPDATA%\pi-telegram\config.json
Custom: $PI_TELEGRAM_CONFIG
```

Config file format:

```json
{
  "version": 1,
  "botToken": "123456:REPLACE_WITH_BOT_TOKEN",
  "chatId": "123456789",
  "botUsername": "example_bot",
  "updatedAt": "2026-07-30T12:00:00.000Z"
}
```

`chatId` is stored as a numeric string so negative group/channel IDs are
preserved without numeric precision loss. Environment variables and manually
edited config files must use this immutable numeric form.

On macOS and Linux, the extension stores the config directory with `0700`
permissions and the config file with `0600` permissions. It writes a temporary
file first, then renames it into place. Windows uses the ACL inherited from the
user profile; restrict that ACL or use environment variables on shared systems.
Only `config.example.json` belongs in the Git repository.

## Commands

### `/telegram-login`

Starts the TUI login flow.

The token prompt is masked. Typed and pasted token characters are shown as mask
characters, not plaintext. The token is kept out of command arguments, model
messages, and session entries. After submission, the input buffer is cleared.

Flow:

1. Enter the bot token in masked input.
2. The extension calls Telegram `getMe` to validate the token.
3. The bot username is shown.
4. Enter the target chat ID, group ID, or channel username.
5. The extension calls `getChat` to validate the target.
6. Confirm the bot and target.
7. Choose whether to send a test message.
8. The immutable numeric ID returned by `getChat` is saved, even if you entered
   a mutable `@username`.

Don't pass secrets as command arguments:

```text
/telegram-login
```

Not this:

```text
/telegram-login 123456:SECRET 123456789
```

When no interactive TUI is available, login stops and tells you to set
`PI_TELEGRAM_BOT_TOKEN` and `PI_TELEGRAM_CHAT_ID` instead.

### `/telegram-status`

Calls `getMe` and `getChat` to check the configured bot and target connection,
then shows the connected bot, target, Chat ID, and config source. It never
prints the bot token.

### `/telegram-test`

Sends a fixed test message to the configured target. Use it after login or after
changing environment variables.

### `/telegram-logout`

Deletes the saved Telegram config file. It can't remove environment variables
from your shell, so if credentials still come from `PI_TELEGRAM_BOT_TOKEN` and
`PI_TELEGRAM_CHAT_ID`, unset them there too.

## Tool behavior

The tool name is `telegram_send`.

Input schema:

```json
{
  "text": "Task completed."
}
```

`text` must be 1 to 4096 Unicode code points after Telegram entity parsing.
This extension sends no entities, so the client and TypeBox schema enforce the
same plain-text limit. The bot token and chat ID are never tool arguments.

Success result:

```json
{
  "sent": true,
  "messageId": 123
}
```

Failures return `sent: false` with a sanitized `error` and host-visible text.
The result doesn't include the token, a token-bearing API URL, or raw Telegram
response bodies.

## Explicit send policy

The tool is for explicit sends only. The agent should call `telegram_send` only
when you ask for a Telegram message or when project instructions require a
completion notification.

Good examples:

```text
Send me a Telegram message when the task is done.
```

```text
Use telegram_send with a short completion note after deployment.
```

The extension doesn't send automatic task completion messages by itself.

## Network policy

The extension uses these Telegram Bot API methods:

```text
getMe
getChat
sendMessage
```

Request policy:

* Timeout is 15 seconds.
* HTTP `429` follows Telegram `retry_after` and retries at most once.
* HTTP `5xx` uses short exponential backoff and retries at most twice.
* Other `4xx` responses aren't retried.
* Host cancellation is passed through with the extension `AbortSignal`.
* Logs must not contain token bearing Telegram API URLs.

## Security properties

`pi-telegram` is built around keeping secrets out of the model path.

What it does:

* Token input is TUI only and masked.
* Commands don't accept token or chat ID arguments.
* The tool schema doesn't contain token or chat ID fields.
* `/telegram-status` doesn't print the token.
* Token bearing URLs are redacted from logs and user facing errors.
* Config files are written with private file permissions.

What it doesn't do:

* It doesn't use the OS keychain.
* It doesn't encrypt the local config file.
* It doesn't manage multiple Telegram accounts or recipient profiles.
* It doesn't receive Telegram messages.
* It doesn't send files, photos, or voice messages.
* It doesn't let the model choose arbitrary chat IDs.

If you need stronger local secret storage, set credentials through your host
process environment and manage that environment with your own secret manager.

## Build, test, and package

Install dependencies:

```bash
bun install
```

Build the extension entry point:

```bash
bun run build
```

The build command writes `dist/index.js`, the file loaded by both
`pi.extensions` and `omp.extensions`.

Run tests:

```bash
bun test
```

Run type checking:

```bash
bun run typecheck
```

Run lint and format checks:

```bash
bun run lint
```

Inspect the npm package contents before publishing:

```bash
npm pack --dry-run
```

The package manifest includes `src`, `dist`, `README.md`, `LICENSE`, and
`config.example.json` in the published package.

## Troubleshooting

### `/telegram-login` says an interactive UI is required

You're running without a TUI. Set credentials in the host process environment
instead:

```bash
export PI_TELEGRAM_BOT_TOKEN='your bot token'
export PI_TELEGRAM_CHAT_ID='your chat id'
```

Don't paste a real bot token into a model chat, issue tracker, terminal
transcript, or support request. If you need help, replace the token with
`[redacted]` and share only the exact command, sanitized error text, host name,
and operating system.

### `/telegram-status` says Telegram isn't configured

Check whether the environment variables are set in the same shell or service
that starts Senpi or Oh My Pi. If you expect file config, check the default
config path or `PI_TELEGRAM_CONFIG`.

### Telegram rejects the bot token or previously returned `Not Found`

Copy the current token again from BotFather and paste only the token itself.
Do not include a leading `bot`, surrounding quotes, spaces, or a complete Bot
API URL. If BotFather says the token was revoked, generate a replacement and
run `/telegram-login` again.

### An explicit `-e` extension does not load in Oh My Pi

Installed Oh My Pi 17.2.0 suppresses explicit `-e` paths when
`--no-extensions` is also present, despite its help text saying otherwise.
Remove `--no-extensions` when testing or loading this package explicitly.

### `/telegram-test` fails after login

Confirm the bot is still valid with BotFather, then check that the bot can
access the target chat. For groups, add the bot to the group. For channels, add
the bot with the needed posting rights.

### `telegram_send` rejects the message length

Telegram messages are limited to 4096 Unicode code points after entity parsing.
This extension sends plain text without entities. Send a shorter summary.

### Logout didn't stop sends

`/telegram-logout` removes only the saved config file. If
`PI_TELEGRAM_BOT_TOKEN` and `PI_TELEGRAM_CHAT_ID` are still set, they take
precedence and remain active until you unset them and restart the host process
if needed.

### Logs show a Telegram URL

Sanitize it before sharing. A Telegram Bot API URL can contain the bot token in
the path. Replace any token shaped value with `[redacted]`.

### Network errors or rate limits

The extension times out requests after 15 seconds. It retries `429` once using
Telegram's `retry_after`, and retries `5xx` responses at most twice. Other `4xx`
responses usually mean the token, chat ID, or bot permissions need to be fixed.
