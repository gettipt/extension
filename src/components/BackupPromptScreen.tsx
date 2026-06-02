interface BackupPromptScreenProps {
  backupDownloaded: boolean;
  onDownload: () => void;
  onContinue: () => void;
}

export function BackupPromptScreen({ backupDownloaded, onDownload, onContinue }: BackupPromptScreenProps) {
  return (
    <div className="space-y-4 p-4">
      <div className="text-center">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">Back Up Your Wallet</h2>
        <p className="text-xs text-neutral-500 mt-1">
          Download your backup file and store it somewhere safe. It will help you recover your wallet if you lose access.
        </p>
      </div>
      <button
        onClick={onDownload}
        className="w-full py-3 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 active:bg-neutral-950 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100 dark:active:bg-neutral-300"
      >
        Backup Wallet
      </button>
      <button
        onClick={onContinue}
        disabled={!backupDownloaded}
        className="w-full py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800"
      >
        Continue to Wallet
      </button>
    </div>
  );
}
