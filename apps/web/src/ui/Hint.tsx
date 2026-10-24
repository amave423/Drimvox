import { useRef, useState } from "react";
import { createPortal } from "react-dom";

const WIDTH = 280;

/**
 * A "?" in a circle whose text shows on hover or focus (seen: explanations under every switch and menu item made them
 * long and noisy). Drawn over everything, so menus with scrolling never cut it. Inside a menu item, which is a button
 * itself, it is not a button of its own.
 */
export function Hint({ text, inButton = false }: { text: string; inButton?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 8));
    const below = r.top < 120;
    setAt({ left, top: below ? r.bottom + 6 : r.top - 6, below });
  };
  const hide = () => setAt(null);
  const tip =
    at &&
    createPortal(
      <span role="tooltip" className={`hint-tip${at.below ? " is-below" : ""}`} style={{ left: at.left, top: at.top, width: WIDTH }}>
        {text}
      </span>,
      document.body,
    );
  const common = { className: "hint", "aria-label": text, onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
  return inButton ? (
    <span ref={(el) => void (ref.current = el)} {...common} role="img">
      ?{tip}
    </span>
  ) : (
    <button ref={(el) => void (ref.current = el)} type="button" {...common} onClick={(e) => (e.preventDefault(), at ? hide() : show())}>
      ?{tip}
    </button>
  );
}
