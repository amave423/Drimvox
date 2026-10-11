import type { Locale } from "@artel/shared";

const ru = {
  "top.noProject": "Проект не выбран",
  "top.settings": "Настройки",
  "top.home": "Главная",

  "side.projects": "Проекты",
  "side.projectsEmpty": "Проектов пока нет. Подключение папки с проектом появится на этапе M2.",
  "side.system": "Система",
  "side.core": "Ядро запущено",
  "side.database": "База данных, схема {version}",
  "side.keys": "Ключи и модели",
  "side.keysSoon": "этап M1",

  "home.title": "Добро пожаловать в Artel",
  "home.lede":
    "Здесь команда ИИ-агентов будет писать код под твоим присмотром. Сейчас собран каркас: окно, ядро, база данных, темы и языки.",
  "home.next": "Что дальше",
  "home.m1": "Подключить нейросети и поговорить с любой моделью",
  "home.m2": "Solo-агент в отдельной копии проекта и ревью правок",
  "home.m3": "Опрос, спека и тесты до кода",
  "home.m4": "Оркестратор и команда агентов",
  "home.noteCore": "Ядро отвечает: версия {version}, Node {node}.",
  "home.noteData": "Данные хранятся здесь:",

  "settings.title": "Настройки",
  "settings.lede": "Изменения сохраняются сразу.",
  "settings.theme": "Оформление",
  "settings.theme.system": "Как в системе",
  "settings.theme.light": "Светлое",
  "settings.theme.dark": "Тёмное",
  "settings.locale": "Язык",
  "settings.saved": "Сохранено",
  "settings.saveFailed": "Не удалось сохранить: ядро не отвечает. Перезапусти приложение.",

  "boot.failedTitle": "Ядро не отвечает",
  "boot.failedBody": "Интерфейс не смог связаться с ядром Artel. Перезапусти приложение. Если не поможет, пришли текст ошибки ниже.",
  "boot.noToken": "Открой Artel через приложение: в браузере вход по паролю появится вместе с серверным режимом.",
  "bottom.version": "Artel {version}",
} as const;

export type MessageKey = keyof typeof ru;

const en: Record<MessageKey, string> = {
  "top.noProject": "No project selected",
  "top.settings": "Settings",
  "top.home": "Home",

  "side.projects": "Projects",
  "side.projectsEmpty": "No projects yet. Connecting a project folder arrives in milestone M2.",
  "side.system": "System",
  "side.core": "Core is running",
  "side.database": "Database, schema {version}",
  "side.keys": "Keys and models",
  "side.keysSoon": "milestone M1",

  "home.title": "Welcome to Artel",
  "home.lede":
    "A team of AI agents will write code here while you supervise. The skeleton is in place: window, core, database, themes and languages.",
  "home.next": "What comes next",
  "home.m1": "Connect AI providers and chat with any model",
  "home.m2": "A Solo agent in its own copy of the project, with change review",
  "home.m3": "Interview, spec and tests before code",
  "home.m4": "Orchestrator and a team of agents",
  "home.noteCore": "Core responds: version {version}, Node {node}.",
  "home.noteData": "Your data lives here:",

  "settings.title": "Settings",
  "settings.lede": "Changes are saved right away.",
  "settings.theme": "Appearance",
  "settings.theme.system": "Match system",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.locale": "Language",
  "settings.saved": "Saved",
  "settings.saveFailed": "Could not save: the core is not responding. Restart the app.",

  "boot.failedTitle": "The core is not responding",
  "boot.failedBody": "The interface could not reach the Artel core. Restart the app. If that does not help, send the error text below.",
  "boot.noToken": "Open Artel from the desktop app. Password sign-in for browsers arrives with server mode.",
  "bottom.version": "Artel {version}",
};

export const dictionaries: Record<Locale, Record<MessageKey, string>> = { ru, en };

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictionaries[locale][key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Best guess before settings load: Russian unless the system clearly prefers something else. */
export function guessLocale(languages: readonly string[]): Locale {
  const first = languages[0]?.toLowerCase() ?? "ru";
  return first.startsWith("ru") ? "ru" : first.startsWith("en") ? "en" : "ru";
}
