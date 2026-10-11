# Artel

Десктопное приложение, в котором команда ИИ-агентов пишет код под присмотром человека —
на любых нейросетях, по твоим ключам. Рабочее название.

Статус: **M1** — чат с любой моделью через OpenRouter, DeepSeek, NVIDIA NIM, Ollama, LM Studio
или любой OpenAI-совместимый сервис; учёт токенов и денег. План — в [docs/CONTEXT.md](docs/CONTEXT.md).

## Запуск

Нужен Node.js 22.13 или новее.

```bash
npm install
npm start
```

Разработка с горячей перезагрузкой:

```bash
npm run dev
```

Проверка всего (типы, тесты, сборка, e2e):

```bash
npm run verify
```

Данные хранятся в `%APPDATA%\Artel` (в режиме разработки — `%APPDATA%\Artel Dev`).
