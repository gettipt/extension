import { useEffect, useRef, useState } from 'react';
import { FaGear } from 'react-icons/fa6';

interface ReadyHeaderProps {
  onBackup: () => void;
  onDelete: () => void;
  onTrustedSites: () => void;
}

export function ReadyHeader({ onBackup, onDelete, onTrustedSites }: ReadyHeaderProps) {
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSettingsMenu) return;
    const handler = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettingsMenu]);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-7 h-7" />
        <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-200">WALLET</h1>
        {/* <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-400">| WALLET</h1> */}
      </div>
      <div className="relative" ref={settingsMenuRef}>
        <>
          <button
            onClick={() => setShowSettingsMenu((v) => !v)}
            title="Settings"
            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
          >
            <FaGear className="w-4 h-4" />
          </button>
          {showSettingsMenu && (
            <div className="absolute right-0 top-9 z-10 min-w-30 p-2 rounded-lg bg-white border border-neutral-200 shadow-sm dark:bg-neutral-900 dark:border-neutral-800">
              <div className="flex flex-col items-start gap-1">
                <button
                  onClick={() => {
                    onBackup();
                    setShowSettingsMenu(false);
                  }}
                  className="text-xs text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                >
                  Backup Wallet
                </button>
                <button
                  onClick={() => {
                    onTrustedSites();
                    setShowSettingsMenu(false);
                  }}
                  className="text-xs text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                >
                  Trusted Sites
                </button>
                <button
                  onClick={() => {
                    onDelete();
                  }}
                  className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                >
                  Delete Wallet
                </button>
              </div>
            </div>
          )}
        </>
      </div>
    </div>
  );
}
