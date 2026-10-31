/**
 * While a transfer is running: keep the screen awake (phones otherwise sleep
 * and suspend the tab mid-transfer) and ask before the tab is closed.
 */
import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export function useKeepAlive(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let lock: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
        const l = await wl?.request('screen');
        if (cancelled) void l?.release();
        else lock = l ?? null;
      } catch {
        // Not supported or denied (e.g. battery saver) — the transfer still works.
      }
    };
    // The lock is dropped whenever the tab is hidden; take it again on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      cancelled = true;
      void lock?.release().catch(() => {});
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [active]);
}
