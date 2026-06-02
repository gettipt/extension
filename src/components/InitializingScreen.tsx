import { Spinner } from './Spinner';

export function InitializingScreen() {
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10" />
      <Spinner className="w-6 h-6 text-neutral-400" />
    </div>
  );
}
