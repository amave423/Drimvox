import { z } from "zod";

/** An HTTP proxy for providers: http://host:port or http://login:password@host:port. */
export const proxyUrlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\/[^/?#]+/.test(u), "http or https only");

export const proxySetSchema = z.object({ url: proxyUrlSchema }).strict();
/** The sites that open through the proxy, one host each (instagram.com); the rest open directly. */
export const proxySitesSchema = z.object({ hosts: z.array(z.string().trim().min(1).max(253)).max(500) }).strict();

/** The proxy as the interface sees it: the password never leaves the core. */
export interface ProxyView {
  /** The address with the password replaced by dots; null when no proxy is set. */
  url: string | null;
}

export interface ProxyCheck {
  ok: boolean;
  /** How long the test request took through the proxy. */
  ms?: number;
  error?: { code: string; detail?: string };
}
