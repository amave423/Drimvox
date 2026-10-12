import type { ReactNode } from "react";

/** An on/off switch with its label; a real checkbox underneath, announced as a switch. */
export function Toggle({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`toggle${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{children}</span>
    </label>
  );
}
