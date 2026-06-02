import { useRef } from 'react';
import { PIN_LENGTH } from '../constants';

export function PinInput({
  value, onChange, onSubmit, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  disabled?: boolean;
}) {
  const refs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];
  const digits = value.split('').concat(Array(PIN_LENGTH).fill('')).slice(0, PIN_LENGTH);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = value.slice(0, i > 0 && digits[i] === '' ? i - 1 : i);
      onChange(next);
      refs[Math.max(0, digits[i] === '' ? i - 1 : i)]?.current?.focus();
    } else if (e.key === 'Enter' && value.length === PIN_LENGTH) {
      onSubmit?.(value);
    }
  };

  const handleChange = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value.replace(/\D/g, '').slice(-1);
    if (!d) return;
    const arr = digits.slice();
    arr[i] = d;
    const next = arr.join('').slice(0, PIN_LENGTH);
    onChange(next);
    if (i < PIN_LENGTH - 1) refs[i + 1]?.current?.focus();
    else if (next.length === PIN_LENGTH) onSubmit?.(next);
  };

  return (
    <div className="flex gap-2 justify-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={refs[i]}
          type="password"
          inputMode="numeric"
          maxLength={1}
          value={d}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          disabled={disabled}
          autoFocus={i === 0}
          className="w-10 h-12 text-center text-lg font-mono rounded-lg border border-transparent bg-neutral-100 text-neutral-900 focus:outline-none focus:border-neutral-500 disabled:opacity-50 caret-transparent dark:bg-neutral-800 dark:text-white dark:focus:border-neutral-400"
        />
      ))}
    </div>
  );
}
