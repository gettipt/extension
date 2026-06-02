import { Spinner } from './Spinner';

interface LoadingScreenProps {
  mode: 'creating' | 'recovering';
}

export function LoadingScreen({ mode }: LoadingScreenProps) {
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10" />
      <Spinner className="w-6 h-6 text-neutral-400" />
      <span className="text-neutral-400 text-sm">{mode === 'recovering' ? 'Recovering wallet...' : 'Creating wallet...'}</span>
    </div>
  );
}
