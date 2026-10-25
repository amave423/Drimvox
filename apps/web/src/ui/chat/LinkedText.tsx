import { Fragment } from "react";
import { splitLinks } from "../../lib/links";
import { siteIcon } from "../../lib/siteIcons";

/** A link in plain text, as in answers: it stands out, and a popular site's carries its mark. */
export function TextLink({ url }: { url: string }) {
  const icon = siteIcon(url);
  return (
    <a className="text-link" href={url} target="_blank" rel="noreferrer" title={url}>
      {icon && (
        <svg className="text-link-icon" viewBox="0 0 24 24" aria-hidden>
          <path d={icon.path} />
        </svg>
      )}
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
