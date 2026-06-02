interface IdleScreenProps {
  showRecover: boolean;
  recoverInput: string;
  onRecoverInputChange: (v: string) => void;
  onCreateWallet: () => void;
  onShowRecover: () => void;
  onRecoverWithText: (mnemonic: string) => void;
  onRecoverWithFile: (mnemonic: string) => void;
  onCancelRecover: () => void;
}

export function IdleScreen({
  showRecover,
  recoverInput,
  onRecoverInputChange,
  onCreateWallet,
  onShowRecover,
  onRecoverWithText,
  onRecoverWithFile,
  onCancelRecover,
}: IdleScreenProps) {
  return (
    <div className="space-y-4 p-4">
      <div className="text-center">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{showRecover ? 'Recover Wallet' : 'Get Started'}</h2>
        <p className="text-xs text-neutral-500 mt-1">{showRecover ? 'Enter your seed phrase or upload your backup file to restore your wallet.' : 'Create a new wallet or recover an existing one.'}</p>
      </div>
      {!showRecover ? (
        <>
          <button onClick={onCreateWallet} className="w-full py-3 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 active:bg-neutral-950 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100 dark:active:bg-neutral-300">
            Create Wallet
          </button>
          <button onClick={onShowRecover} className="w-full py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:bg-neutral-100 transition-colors dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800">
            Recover Wallet
          </button>
          <a href="#" onClick={(e) => e.preventDefault()} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
            Setup Instructions
          </a>
        </>
      ) : (
        <div className="space-y-3">
          <textarea
            autoFocus
            value={recoverInput}
            onChange={(e) => onRecoverInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const t = recoverInput.trim();
                if (!t) return;
                onRecoverWithText(t);
              }
            }}
            placeholder="Enter your seed phrase..."
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 placeholder-neutral-400 font-mono resize-none focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-400 dark:placeholder-neutral-600 dark:focus:border-neutral-400/50"
          />
          <button
            onClick={() => {
              const t = recoverInput.trim();
              if (!t) return;
              onRecoverWithText(t);
            }}
            disabled={!recoverInput.trim()}
            className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
          >
            Recover
          </button>
          <label className="flex items-center justify-center gap-1.5 w-full py-2.5 text-sm font-medium rounded-xl border border-dashed border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 cursor-pointer transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12" /></svg>
            Upload Backup File
            <input
              type="file"
              accept=".txt,.text,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const text = (reader.result as string).trim();
                  if (!text) return;
                  onRecoverWithFile(text);
                };
                reader.readAsText(file);
                e.target.value = '';
              }}
            />
          </label>
          <button onClick={onCancelRecover} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
