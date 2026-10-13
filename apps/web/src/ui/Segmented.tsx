interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  labelledBy: string;
  onChange(value: T): void;
}

export function Segmented<T extends string>({ value, options, labelledBy, onChange }: Props<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        <button
          key={o.value}
          // Not a submit button: segmented choices sit inside forms, such as the new task form.
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "is-on" : undefined}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
