import { useEffect, useRef } from 'react';
import { PIN_LENGTH } from '../constants';

export function PinInput({
  value, onChange, onSubmit, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  disabled?: boolean;
}) {
  // Single ref array — earlier code allocated N separate `useRef` calls in
  // a literal array, which (a) breaks hook rules if PIN_LENGTH ever changes,
  // and (b) allocates more objects than needed.
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const setInputRef = (i: number) => (el: HTMLInputElement | null) => {
    inputsRef.current[i] = el;
  };
  const focusAt = (i: number) => inputsRef.current[i]?.focus();

  // Explicit post-mount focus. React's `autoFocus` prop calls focus() during
  // the commit phase, which Chrome's extension popup can silently drop when
  // the mount is triggered by a click on the previous screen's button
  // (focus often stays on the originating button). Calling focus() from an
  // effect runs after the commit settles, so the cursor reliably lands in
  // the first input on every mount of this component — including remounts
  // (e.g. when PinSetupScreen swaps the `key` between 'enter' and 'confirm').
  useEffect(() => {
    const focusFirst = () => {
      if (disabled) return;
      inputsRef.current[0]?.focus();
    };

    // File-picker flows (recover from backup file) can restore focus to the
    // extension window after this effect runs. Retry on the next frame, a
    // short timeout, and focus/visibility regain so the first PIN box still
    // receives focus when control returns from native dialogs.
    const rafId = requestAnimationFrame(focusFirst);
    const timerId = window.setTimeout(focusFirst, 120);
    const onWindowFocus = () => focusFirst();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') focusFirst();
    };

    focusFirst();
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [disabled]);

  const digits = value.split('').concat(Array(PIN_LENGTH).fill('')).slice(0, PIN_LENGTH);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = value.slice(0, i > 0 && digits[i] === '' ? i - 1 : i);
      onChange(next);
      focusAt(Math.max(0, digits[i] === '' ? i - 1 : i));
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
    if (i < PIN_LENGTH - 1) focusAt(i + 1);
    else if (next.length === PIN_LENGTH) onSubmit?.(next);
  };

  return (
    <div className="flex gap-2 justify-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={setInputRef(i)}
          type="password"
          inputMode="numeric"
          maxLength={1}
          value={d}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          disabled={disabled}
          className="w-10 h-12 text-center text-lg font-mono rounded-lg border border-transparent bg-neutral-100 text-neutral-900 focus:outline-none focus:border-neutral-500 disabled:opacity-50 caret-transparent dark:bg-neutral-800 dark:text-white dark:focus:border-neutral-400"
        />
      ))}
    </div>
  );
}

