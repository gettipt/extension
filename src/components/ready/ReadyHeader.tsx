import { useEffect, useRef, useState } from 'react';
import {
  FaGear,
  FaCloudArrowDown,
  FaShieldHalved,
  FaCopy,
  FaCheck,
  FaTriangleExclamation,
  FaTrashCan,
  FaSpinner,
} from 'react-icons/fa6';
import { MSG } from '../../lib/messages';
import { sendWalletMessage } from '../../lib/wallet-client';

interface ReadyHeaderProps {
  onBackup: () => void;
  onDelete: () => void;
  onTrustedSites: () => void;
}

interface SparkAddressResponse {
  ok: boolean;
  address?: string;
  error?: string;
}

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

export function ReadyHeader({ onBackup, onDelete, onTrustedSites }: ReadyHeaderProps) {
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  // Track the last "copied" timer so menu re-opens / unmounts don't leak it
  // and we never call setState after the component unmounted.
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!showSettingsMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSettingsMenu(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showSettingsMenu]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Reset the copy indicator the moment the user re-opens the menu so a
  // second click starts from a clean "Copy Spark Address" label rather
  // than the stale "Copied!" from the previous open.
  useEffect(() => {
    if (showSettingsMenu) {
      setCopyState('idle');
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    }
  }, [showSettingsMenu]);

  const handleCopySparkAddress = async () => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    try {
      const response = await sendWalletMessage<SparkAddressResponse>({
        type: MSG.GET_SPARK_ADDRESS,
      });
      if (!response?.ok || !response.address) {
        throw new Error(response?.error ?? 'Could not load Spark address.');
      }
      await navigator.clipboard.writeText(response.address);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopyState('idle');
        copyTimerRef.current = null;
      }, 1500);
    }
  };

  const copyIcon =
    copyState === 'copying' ? <FaSpinner className="w-3.5 h-3.5 animate-spin" />
    : copyState === 'copied' ? <FaCheck className="w-3.5 h-3.5" />
    : copyState === 'error' ? <FaTriangleExclamation className="w-3.5 h-3.5" />
    : <FaCopy className="w-3.5 h-3.5" />;

  const copyLabel =
    copyState === 'copying' ? 'Copying…'
    : copyState === 'copied' ? 'Copied!'
    : copyState === 'error' ? 'Copy failed'
    : 'Copy Spark Address';

  const copyRowClass =
    copyState === 'copied'
      ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30'
      : copyState === 'error'
        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
        : 'text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800';

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-7 h-7" />
        <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-200">WALLET</h1>
      </div>
      <div className="relative" ref={settingsMenuRef}>
        <button
          onClick={() => setShowSettingsMenu((v) => !v)}
          title="Settings"
          aria-haspopup="menu"
          aria-expanded={showSettingsMenu}
          className={`p-1.5 rounded-lg transition-colors ${
            showSettingsMenu
              ? 'text-neutral-900 bg-neutral-200 dark:text-neutral-100 dark:bg-neutral-800'
              : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          <FaGear className="w-4 h-4" />
        </button>
        {showSettingsMenu && (
          <div
            role="menu"
            aria-label="Wallet settings"
            className="tipt-menu-pop absolute right-0 top-10 z-20 w-52 p-1.5 rounded-xl bg-white/95 backdrop-blur shadow-lg ring-1 ring-black/5 dark:bg-neutral-900/95 dark:ring-white/10"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onBackup();
                setShowSettingsMenu(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors"
            >
              <FaCloudArrowDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
              <span>Backup Wallet</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onTrustedSites();
                setShowSettingsMenu(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors"
            >
              <FaShieldHalved className="w-3.5 h-3.5 shrink-0 opacity-70" />
              <span>Trusted Sites</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { void handleCopySparkAddress(); }}
              disabled={copyState === 'copying'}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left transition-colors disabled:cursor-default ${copyRowClass}`}
            >
              <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center opacity-80">
                {copyIcon}
              </span>
              <span>{copyLabel}</span>
            </button>
            <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onDelete();
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300 transition-colors"
            >
              <FaTrashCan className="w-3.5 h-3.5 shrink-0 opacity-80" />
              <span>Delete Wallet</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
