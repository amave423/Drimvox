import {
  siAnthropic,
  siApple,
  siClaude,
  siDeepseek,
  siDocker,
  siDuckduckgo,
  siFigma,
  siGithub,
  siGitlab,
  siGoogle,
  siHabr,
  siHuggingface,
  siMdnwebdocs,
  siMedium,
  siNodedotjs,
  siNotion,
  siNpm,
  siOpenrouter,
  siPypi,
  siPython,
  siReact,
  siReddit,
  siStackoverflow,
  siTelegram,
  siTypescript,
  siVite,
  siVk,
  siWikipedia,
  siX,
  siYoutube,
  type SimpleIcon,
} from "simple-icons";

/**
 * The marks of popular sites, drawn from Simple Icons (CC0) inside the app: no request goes to the site or to a favicon
 * service, so a link tells nobody what the chat is about.
 */
const SITES: [string, SimpleIcon][] = [
  ["github.com", siGithub],
  ["githubusercontent.com", siGithub],
  ["gitlab.com", siGitlab],
  ["youtube.com", siYoutube],
  ["youtu.be", siYoutube],
  ["wikipedia.org", siWikipedia],
  ["stackoverflow.com", siStackoverflow],
  ["reddit.com", siReddit],
  ["x.com", siX],
  ["twitter.com", siX],
  ["t.me", siTelegram],
  ["telegram.org", siTelegram],
  ["vk.com", siVk],
  ["habr.com", siHabr],
  ["npmjs.com", siNpm],
  ["pypi.org", siPypi],
  ["python.org", siPython],
  ["developer.mozilla.org", siMdnwebdocs],
  ["google.com", siGoogle],
  ["anthropic.com", siAnthropic],
  ["claude.ai", siClaude],
  ["claude.com", siClaude],
  ["apple.com", siApple],
  ["docker.com", siDocker],
  ["figma.com", siFigma],
  ["notion.so", siNotion],
  ["medium.com", siMedium],
  ["huggingface.co", siHuggingface],
  ["openrouter.ai", siOpenrouter],
  ["deepseek.com", siDeepseek],
  ["duckduckgo.com", siDuckduckgo],
  ["typescriptlang.org", siTypescript],
  ["react.dev", siReact],
  ["vite.dev", siVite],
  ["vitejs.dev", siVite],
  ["nodejs.org", siNodedotjs],
];

/** A popular site's mark for a link, by its host or a parent domain of it; null for any other address. */
export function siteIcon(href: string | undefined): SimpleIcon | null {
  if (!href) return null;
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  return SITES.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? null;
}
