# Спека: CLI-агенты и прямые ключи

Решения из опроса 2026-10-12.

## Прямые ключи

- Новые провайдеры: **Anthropic**, **OpenAI**, **Google Gemini**, **xAI**. Каждый говорит на своём протоколе
  через родной пакет AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`):
  инструменты, рассуждения и картинки работают так, как задумано производителем.
- Список моделей — из API производителя. Цены производители через API не дают; Artel берёт их из открытого
  каталога OpenRouter (та же цена, что у производителя) и помечает как оценку.

## CLI-агенты

- Новые провайдеры: **Claude Code**, **Codex**, **Gemini CLI** — работа по подписке пользователя, без ключа.
  Artel сам ищет программу в PATH (`claude`, `codex`, `gemini`) и запускает то, что оборачивает `.cmd` от npm,
  напрямую, без оболочки; если программы нет — говорит, как поставить. Задание идёт в stdin.
  Модели: «по умолчанию» (что выбрано в самом CLI; после первого запуска Artel показывает, какая это модель)
  и свежие модели производителя по именам из открытого каталога OpenRouter: для Claude Code `claude-opus-5-5`
  из `anthropic/claude-opus-5.5`, для Codex и Gemini CLI — имя как есть. Без каталога — алиасы самого CLI.
  Ответы «обнови программу» и «лимит подписки исчерпан» показываются отдельными ошибками.
  Расход по подписке показывается как «по подписке», токены считаются.
- **В задаче CLI — исполнитель шагов Artel.** Опрос, спека, план, ответ на вопрос: Artel просит у CLI ответ
  строго в JSON `{"tool", "input"}` со схемами в задании (у Claude ещё и `--json-schema` на внешнюю форму,
  у Codex и Gemini — по инструкции), проверяет `input` схемой инструмента и выполняет его так же, как вызовы
  `ask_questions` / `propose_spec` / `answer`. Тесты и код CLI пишет сам в копии
  проекта; его итог — последнее сообщение, строка `COMMIT:` даёт сообщение коммита. Дальше всё как обычно:
  проверки Artel, визуальная проверка, попытки, эскалация, ревью. Повторные ходы продолжают ту же сессию CLI.
- В команде CLI может быть исполнителем подзадач.
- **В чате** CLI отвечает как обычная модель, в своей папке на каждый чат, только чтение и веб.
- **Права:** правки файлов в копии и безопасные команды без вопросов; опасное запрещено:
  - Claude Code: `--permission-mode acceptEdits`, Bash разрешён, `git push`, глобальные установки, `curl`/`wget`,
    удаление вне копии — в `--disallowedTools`; работа ограничена папкой копии.
  - Codex: `--sandbox workspace-write` (запись только в копии, без сети).
  - Gemini CLI: `--approval-mode auto_edit` и разрешённые безопасные команды (npm, npx, node, git status/diff…).
  - На шагах опроса и спеки — только чтение: у Claude `dontAsk` с разрешёнными Read/Glob/Grep/LS,
    у Codex `--sandbox read-only`, у Gemini `--approval-mode default` (без подтверждения доступно только чтение).
  - Сессия хранится вместе с CLI и моделью; смена модели начинает новую сессию с пересказом разговора.
- Ход CLI виден в ленте: его чтение файлов, правки и команды переводятся в те же строки, что у агентов Artel.
- CLI-агентам не передаются MCP-серверы, скиллы и картинки Artel: у них свои (Claude Code сам читает
  `.claude/skills`). Визуальные проверки для них не выполняются: Artel не может отдать CLI свои скриншоты.
- Деньги не считаются (подписка), токены — считаются.
- Если у провайдера включено «Через прокси», CLI получает адрес прокси в `HTTPS_PROXY`/`HTTP_PROXY`.

## Готово, когда

- Прямые ключи: список моделей и цены из каталога, ответ в чате по протоколу каждого производителя (тесты
  на поддельных серверах), агент с инструментами.
- CLI: поддельные CLI в тестах (те же форматы событий) — опрос, спека, код, проверки, продолжение сессии,
  чат, права в аргументах запуска; поиск программы на Windows через `.cmd`-обёртки npm.
- Живая проверка: Claude Code по подписке (чат и задача). Codex и Gemini — если поставлены.

## Antigravity CLI and subscription limits
- Google stopped serving Gemini CLI to personal accounts on 2026-06-18; its successor `agy` (Antigravity CLI) is a
  fourth CLI. Headless: `--output-format stream-json --input-format stream-json`, the prompt as one
  `{"event":"user",...}` line on stdin, `--conversation <id>` to continue, `--model <slug>` from `agy models`.
  Chats and read steps run without `--dangerously-skip-permissions` (agy then refuses what needs approval); writing
  steps get it together with `--sandbox`, inside Artel's copy of the project.
- What is left of the subscription is shown as the CLI reports it while it runs: Claude Code's `rate_limit_event`
  (share used, window, reset time), Codex's `rate_limits` (percent, window in minutes). Artel keeps the latest per CLI
  in memory, shows it on the provider and next to a chat, and knows nothing before the first run.
