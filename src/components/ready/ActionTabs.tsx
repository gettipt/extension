type ActivePanel = 'send' | 'receive' | null;

interface ActionTabsProps {
  activePanel: ActivePanel;
  onSendClick: () => void;
  onReceiveClick: () => void;
}

export function ActionTabs({ activePanel, onSendClick, onReceiveClick }: ActionTabsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onSendClick}
        className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'send' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:text-neutral-200'}`}
      >
        <span className="text-md font-semibold">Send</span>
      </button>
      <button
        onClick={onReceiveClick}
        className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'receive' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:text-neutral-200'}`}
      >
        <span className="text-md font-semibold">Receive</span>
      </button>
    </div>
  );
}
