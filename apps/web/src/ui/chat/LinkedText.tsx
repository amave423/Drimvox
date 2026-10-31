import { Fragment } from "react";
import { splitLinks } from "../../lib/links";
import { siteIcon } from "../../lib/siteIcons";
import { useApp } from "../../context";
import { useAuthorizedUrl } from "../../lib/media";

/** The site's own address, one per site: every link to it shares one icon request. */
function siteOf(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}/` : null;
  } catch {
    return null;
  }
}

/**
 * A link's mark (asked for: every site's, not only the few drawn into the app): a popular site's drawn in the app's
 * colour, any other's own icon, which Drimvox asks of the site itself and keeps; none while it is not there.
 */
export function SiteMark({ url, className }: { url: string | undefined; className: string }) {
  const { token } = useApp();
  const icon = siteIcon(url);
  const site = icon ? null : siteOf(url);
  const src = useAuthorizedUrl(site ? `/api/favicon?url=${encodeURIComponent(site)}` : null, token);
  if (icon) {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden>
        <path d={icon.path} />
      </svg>
    );
  }
  return src ? <img className={`${className} is-favicon`} src={src} alt="" aria-hidden /> : null;
}

/** A link in plain text, as in answers: it stands out and carries its site's mark. */
export function TextLink({ url }: { url: string }) {
  return (
    <a className="text-link" href={url} target="_blank" rel="noreferrer" title={url}>
      <SiteMark url={url} className="text-link-icon" />
      {url}
    </a>
  );
}

/** The user's own message with its web addresses as links (asked for: like in other chats). */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, n) => (p.url ? <TextLink key={n} url={p.url} /> : <Fragment key={n}>{p.text}</Fragment>))}
    </>
  );
}
