# Pi Telegram Extension 설계서

- **가칭:** `pi-telegram`
- **대상:** Oh My Pi, Senpi
- **방식:** 에이전트 호출형 도구
- **상태:** Draft v0.1

## 1. 목표

하나의 Extension 패키지를 OMP와 Senpi에서 공유하며 다음 기능을 제공한다.

1. `/telegram-login`으로 Telegram Bot Token과 Chat ID 설정
2. `telegram_send` 도구로 메시지 전송
3. 토큰을 모델 컨텍스트나 도구 인자에 노출하지 않음
4. 사용자별 로컬 설정 지원
5. 연결 확인, 테스트, 로그아웃 명령 제공

두 에이전트 모두 TypeScript Extension에서 도구, 명령, UI를 등록할 수 있다. <citation refs="Nr8JsU9VcpxP4aNQWe8-q VFXqWo6Auygd2R-BlTlOm">OMP와 Senpi는 공통적으로 Extension factory, registerTool, registerCommand 및 사용자 입력 UI를 제공한다.</citation>

## 2. 비목표

초기 버전에서는 다음 기능을 제공하지 않는다.

- 여러 Telegram 계정 및 수신자 프로필
- Telegram 메시지 수신
- 그룹별 권한 관리
- 파일, 사진, 음성 전송
- OS Keychain 연동
- 작업 완료 이벤트 자동 전송
- 모델이 Chat ID를 임의로 선택하는 기능

## 3. 사용자 인터페이스

### 3.1 명령어

| 명령어 | 기능 |
|---|---|
| `/telegram-login` | Bot Token과 Chat ID 설정 또는 변경 |
| `/telegram-status` | 설정 및 연결 상태 확인 |
| `/telegram-test` | 고정된 테스트 메시지 전송 |
| `/telegram-logout` | 저장된 Telegram 설정 삭제 |

토큰과 Chat ID는 명령어 인자로 받지 않는다.

```text
# 금지
/telegram-login 123456:SECRET 123456789

# 사용
/telegram-login
```

명령어 인자로 전달하면 세션 기록이나 명령 기록에 비밀값이 남을 수 있기 때문이다.

### 3.2 로그인 흐름

```text
사용자: /telegram-login

1. 마스킹 입력창으로 Bot Token 입력
2. Telegram getMe 호출로 토큰 검증
3. Bot 사용자명 표시
4. Chat ID 입력
5. getChat 호출로 대상 검증
6. Bot과 대상 정보 확인
7. 테스트 메시지 전송 여부 확인
8. 로컬 설정 파일에 저장
```

예시:

```text
Telegram Bot Token
> ••••••••••••••••••••••••

Connected bot: @my_notification_bot

Telegram Chat ID
> 123456789

Target: 김관우
Send a test message? [Yes / No]

Telegram configuration saved.
```

### 3.3 비대화형 모드

RPC, print 또는 UI가 없는 모드에서는 로그인 입력을 시도하지 않는다.

```text
Interactive UI is required for /telegram-login.
Configure PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_CHAT_ID instead.
```

## 4. 도구 설계

### 4.1 도구 이름

```text
telegram_send
```

### 4.2 입력 스키마

```json
{
  "text": "작업이 완료됐습니다."
}
```

```ts
{
  text: string; // 1~4096자
}
```

Bot Token과 Chat ID는 입력 스키마에 포함하지 않는다.

### 4.3 호출 정책

도구 설명에는 다음 정책을 포함한다.

> Send a Telegram message only when the user explicitly requests it or when project instructions require a completion notification.

따라서 에이전트가 임의로 메시지를 보내지 않으며, 다음과 같이 요청하거나 프로젝트 규칙에 명시한다.

```text
작업이 완료되면 telegram_send로 알려줘.
```

### 4.4 반환값

성공:

```json
{
  "sent": true,
  "messageId": 123
}
```

실패:

```json
{
  "sent": false,
  "error": "Telegram rejected the configured chat"
}
```

오류 메시지에는 Token, API URL 또는 Telegram 응답 원문을 그대로 포함하지 않는다.

## 5. 설정 저장

### 5.1 설정 우선순위

1. 환경변수
2. 사용자 설정 파일

```bash
PI_TELEGRAM_BOT_TOKEN=123456:ABC...
PI_TELEGRAM_CHAT_ID=123456789
PI_TELEGRAM_CONFIG=/custom/path/config.json
```

환경변수가 설정 파일보다 우선한다.

### 5.2 기본 설정 경로

| 운영체제 | 경로 |
|---|---|
| macOS/Linux | `${XDG_CONFIG_HOME:-~/.config}/pi-telegram/config.json` |
| Windows | `%APPDATA%\\pi-telegram\\config.json` |
| 사용자 지정 | `$PI_TELEGRAM_CONFIG` |

OMP나 Senpi의 전용 설정 폴더를 사용하지 않아 동일한 설정을 공유할 수 있게 한다.

### 5.3 설정 형식

```json
{
  "version": 1,
  "botToken": "123456:ABC...",
  "chatId": "123456789",
  "botUsername": "my_notification_bot",
  "updatedAt": "2026-07-30T12:00:00.000Z"
}
```

`chatId`는 음수 그룹 ID와 `@channelusername`을 지원하기 위해 문자열로 저장한다.

### 5.4 파일 보안

- 설정 디렉터리 권한: `0700`
- 설정 파일 권한: `0600`
- 임시 파일 작성 후 원자적으로 rename
- Git 저장소에는 `config.example.json`만 포함
- `/telegram-status`에서 Token을 출력하지 않음
- `/telegram-logout`은 설정 파일만 삭제
- 환경변수는 `/telegram-logout`으로 제거할 수 없음을 안내

## 6. 비밀 입력 UI

양쪽의 기본 `ctx.ui.input()`에는 공통 password 옵션이 없으므로 별도의 `SecretInput`을 구현한다.

### 요구사항

- 입력 문자를 `•`로 표시
- 붙여넣기 지원
- Backspace 지원
- Enter 제출
- Escape 취소
- 실제 Token은 메모리에만 보관
- 제출 후 입력 버퍼 초기화
- 모델 메시지 및 세션 엔트리에 추가하지 않음

### 호환 전략

```text
promptSecret()
├── Interactive TUI: 마스킹 SecretInput 사용
└── UI 없음: 입력 중단 후 환경변수 설정 안내
```

OMP와 Senpi 모두 custom extension UI를 제공하지만 TUI 구현 차이가 있으므로 작은 호환 어댑터로 격리하고 양쪽에서 통합 테스트한다.

## 7. Telegram API 사용

Telegram Bot API는 HTTP 기반으로 제공된다. <citation refs="jTulYPjk8MO8Txqu4aAgO">Telegram 공식 Bot API는 HTTP 인터페이스와 sendMessage 등의 메서드를 제공한다.</citation>

| API | 용도 |
|---|---|
| `getMe` | Bot Token 검증 및 Bot 정보 조회 |
| `getChat` | Chat ID 검증 |
| `sendMessage` | 실제 메시지 및 테스트 메시지 전송 |

### 네트워크 정책

- 요청 제한시간: 15초
- `429`: `retry_after`를 따라 최대 1회 재시도
- `5xx`: 짧은 지수 백오프로 최대 2회 재시도
- 기타 `4xx`: 재시도하지 않음
- 호출 취소 시 Extension의 `AbortSignal` 전달
- 로그에 Token이 포함된 요청 URL을 기록하지 않음

## 8. 패키지 구조

```text
pi-telegram/
├── package.json
├── README.md
├── LICENSE
├── config.example.json
├── src/
│   ├── index.ts
│   ├── commands.ts
│   ├── tool.ts
│   ├── config.ts
│   ├── telegram-client.ts
│   ├── secret-input.ts
│   ├── redaction.ts
│   └── types.ts
├── tests/
│   ├── config.test.ts
│   ├── telegram-client.test.ts
│   ├── redaction.test.ts
│   └── tool.test.ts
└── dist/
    └── index.js
```

## 9. 패키지 매니페스트

```json
{
  "name": "pi-telegram",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package", "telegram"],
  "pi": {
    "extensions": ["./dist/index.js"]
  },
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

Senpi는 `pi.extensions`를 사용하고, OMP는 `omp.extensions`와 기존 `pi.extensions`를 모두 읽을 수 있다. <citation refs="XSJTdBPGCcVa-IpEed9CZ EUknCJRkGzSeU8buhIzW5">Senpi의 Pi Package 형식은 pi.extensions를 사용하며, OMP는 omp.extensions와 legacy pi.extensions를 함께 지원한다.</citation>

## 10. 설치 예시

### Senpi

```bash
senpi install git:github.com/OWNER/pi-telegram
```

### Oh My Pi

```bash
omp plugin install github:OWNER/pi-telegram
```

설치 후:

```text
/telegram-login
```

## 11. 테스트 계획

### 단위 테스트

- 환경변수와 설정 파일 우선순위
- Chat ID 문자열 보존
- 설정 파일 권한
- 원자적 파일 저장
- Token 마스킹 및 로그 제거
- Telegram API 성공 및 오류 처리
- `429` 및 `5xx` 재시도
- 4096자 제한
- 설정 없이 도구 호출 시 오류

### 통합 테스트

각 에이전트에서 다음 항목을 확인한다.

1. Extension 로드 성공
2. 네 개 명령어 등록
3. `telegram_send` 도구 등록
4. 마스킹 입력 정상 작동
5. 로그인 정보 저장
6. 프로세스 재시작 후 설정 유지
7. 테스트 메시지 수신
8. 로그아웃 후 도구 호출 차단
9. Token이 세션과 로그에 남지 않음

## 12. 완료 조건

- [ ] 동일 패키지가 OMP와 Senpi에서 설치된다.
- [ ] `/telegram-login`으로 정보를 입력할 수 있다.
- [ ] Token이 입력 중 마스킹된다.
- [ ] Token이 모델 컨텍스트와 도구 인자에 포함되지 않는다.
- [ ] `telegram_send`는 설정된 수신자에게만 전송한다.
- [ ] `/telegram-status`, `/telegram-test`, `/telegram-logout`이 동작한다.
- [ ] 설정 파일이 안전한 권한으로 저장된다.
- [ ] 양쪽 에이전트의 통합 테스트가 통과한다.