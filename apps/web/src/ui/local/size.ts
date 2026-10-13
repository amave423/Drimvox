import { useApp } from "../../context";

/** Sizes in gigabytes (megabytes when small), with the decimal sign of the interface language. */
export function useSize(): (bytes: number) => string {
  const { t, settings } = useApp();
  const tag = settings.locale === "ru" ? "ru-RU" : "en-US";
  return (bytes) => {
    const gb = bytes / 2 ** 30;
    if (gb >= 1) return t("local.gb", { n: gb.toLocaleString(tag, { maximumFractionDigits: 1 }) });
    return t("local.mb", { n: Math.max(1, Math.round(bytes / 2 ** 20)).toLocaleString(tag) });
  };
}
