interface ErrorScreenProps {
  error: string | null;
  onReset: () => void;
}

export function ErrorScreen({ error, onReset }: ErrorScreenProps) {
  return (
    <div className="space-y-3 text-center">
      <div className="p-4 rounded-xl bg-neutral-100 border border-neutral-300 text-neutral-700 dark:bg-neutral-800/50 dark:border-neutral-600/30 dark:text-neutral-300">
        <p className="font-semibold text-sm mb-1">Something went wrong</p>
        <p className="text-xs font-mono break-all">{error}</p>
      </div>
      <button onClick={onReset} className="px-5 py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100">
        Try Again
      </button>
    </div>
  );
}
