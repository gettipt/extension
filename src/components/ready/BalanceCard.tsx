import { FaRightLeft } from 'react-icons/fa6';

interface BalanceCardProps {
  satsDisplay: string;
  usdDisplay: string;
  usdPrimary: boolean;
  balanceFlash: boolean;
  onToggleUsdPrimary: () => void;
}

export function BalanceCard({
  satsDisplay,
  usdDisplay,
  usdPrimary,
  balanceFlash,
  onToggleUsdPrimary,
}: BalanceCardProps) {
  return (
    <div className="px-4 py-3 rounded-xl bg-neutral-100 dark:bg-neutral-900">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">BALANCE</p>
      </div>
      <div>
        {usdPrimary ? (
              <>
                <p className={`mb-2 text-5xl leading-none font-bold transition-colors duration-300 ${balanceFlash ? 'text-green-500' : 'text-neutral-900 dark:text-neutral-200'}`}>
                  <span className="text-neutral-500">$</span>{usdDisplay}
                </p>
                <div className="flex items-center gap-0.5">
                  <p className="text-xs leading-none text-neutral-600 dark:text-neutral-400">
                    &#8383;{satsDisplay}
                  </p>
                  <button
                    onClick={onToggleUsdPrimary}
                    title="Switch primary balance"
                    className="p-0.5 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <FaRightLeft className="w-3 h-3 rotate-90" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={`mb-2 text-5xl leading-none font-bold transition-colors duration-300 ${balanceFlash ? 'text-green-500' : 'text-neutral-900 dark:text-neutral-200'}`}>
                  <span className="text-neutral-500">&#8383;</span>{satsDisplay}
                </div>
                <div className="flex items-center gap-0.5">
                  <p className="text-xs leading-none text-neutral-600 dark:text-neutral-400">
                    ${usdDisplay} USD
                  </p>
                  <button
                    onClick={onToggleUsdPrimary}
                    title="Switch primary balance"
                    className="p-0.5 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <FaRightLeft className="w-3 h-3 rotate-90" />
                  </button>
                </div>
              </>
            )}
      </div>
    </div>
  );
}
