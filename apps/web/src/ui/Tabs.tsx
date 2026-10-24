/** A row of tabs over a sheet: the project workspace's parts, the settings' sections. */
export function Tabs<T extends string>({ value, options, label, onChange }: { value: T; options: { value: T; label: string }[]; label: string; onChange(value: T): void }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? "tab is-active" : "tab"} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
