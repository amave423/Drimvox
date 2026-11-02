# Drimvox на macOS

## Зачем

Попросили: приложение и на Mac. Подпись Apple пока не делаем (нужен платный аккаунт разработчика) — сборка без неё.

## Как устроено

- **Сборка** (`apps/desktop/electron-builder.yml`, раздел `mac`): `.dmg` для установки и `.zip`, для Apple Silicon
  (arm64). Подпись — ad-hoc (`identity: "-"`): без неё Apple Silicon вообще не запускает приложение; подписи Apple
  нет, поэтому первый запуск — через «Всё равно открыть» или `xattr -cr` (написано в README). Собирает машина macOS в
  GitHub Actions вместе с Windows и Linux при выпуске версии; отдельная проверка всего на Mac —
  `.github/workflows/macos-check.yml` (запуск вручную: типы, юнит-тесты, dmg, тесты на настоящем окне).
- **Окно**: строка заголовка своя, как на Windows, но кнопки окна macOS рисует сам слева (`trafficLightPosition`);
  страница отступает под них (`html.is-mac-window .topbar`). Нажатие на значок в Доке возвращает окно из трея.
- **Обновления**: macOS ставит обновление только подписанному приложению, поэтому, как у `.deb`, Drimvox находит новую
  версию и показывает ссылку на неё (`updates.ts`, состояние `manual`).
- **Движки на компьютере**: Piper — свои сборки под Mac (Apple Silicon и Intel); картинки (stable-diffusion.cpp) —
  сборка под Apple Silicon; Ollama — из `/Applications/Ollama.app` или Homebrew. Готовой сборки whisper.cpp под Mac
  нет: распознавание речи — облачной моделью.
- **Только на Windows**: окна других программ (UI Automation) и распознавание текста средствами Windows — на Mac
  текст с картинок читает модель со зрением.

## Тесты

- `engines-macos.test.ts`: какие движки скачиваются на Mac.
- Вся проверка на Mac — `macos-check.yml` в GitHub Actions.
