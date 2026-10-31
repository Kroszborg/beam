/**
 * React binding for ReceiverSession. Starts as soon as it has a target — a
 * link (room id + key fragment) or a typed short code — so scanning a QR or
 * opening the link begins the handshake immediately.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest } from '@beam/shared';
import { ReceiverSession, type ReceiveTarget } from '@/lib/session/receiverSession';
import { prepareSinks } from '@/lib/transfer';
import type {
  CompletedFile,
  ReceiverState,
  SinkKind,
  TransferProgress,
} from '@/lib/transfer';
import type { Route } from '@/lib/webrtc';
import { SIGNALING_URL } from '@/config/env';

export interface UseReceiver {
  state: ReceiverState;
  manifest: Manifest | null;
  progress: TransferProgress | null;
  route: Route | null;
  /** Files still to be saved by hand, or null when they went straight to disk. */
  files: CompletedFile[] | null;
  waiting: boolean;
  error: string | null;
  accept: (fileIndices: number[], sink: SinkKind) => Promise<void>;
  cancel: () => void;
}

export function useReceiverSession(target: ReceiveTarget | null): UseReceiver {
  const sessionRef = useRef<ReceiverSession | null>(null);
  const [state, setState] = useState<ReceiverState>('idle');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [files, setFiles] = useState<CompletedFile[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable identity for the effect: one session per distinct target.
  const targetKey = target ? JSON.stringify(target) : '';

  useEffect(() => {
    if (!target) return;
    if ('keyFragment' in target && !target.keyFragment) {
      setError('This link is missing its decryption key.');
      setState('error');
      return;
    }
    if (sessionRef.current) return;

    prepareSinks();
    const session = new ReceiverSession(SIGNALING_URL);
    sessionRef.current = session;
    session.on('state', setState);
    session.on('manifest', setManifest);
    session.on('progress', setProgress);
    session.on('route', setRoute);
    session.on('complete', setFiles);
    session.on('waiting', setWaiting);
    session.on('error', setError);
    void session.start(target).catch((e: Error) => {
      setError(e.message);
      setState('error');
    });

    return () => {
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by targetKey
  }, [targetKey]);

  const accept = useCallback(async (fileIndices: number[], sink: SinkKind) => {
    await sessionRef.current?.accept(fileIndices, sink);
  }, []);

  const cancel = useCallback(() => {
    void sessionRef.current?.cancel();
  }, []);

  return { state, manifest, progress, route, files, waiting, error, accept, cancel };
}
