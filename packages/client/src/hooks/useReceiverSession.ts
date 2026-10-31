/**
 * React binding for ReceiverSession. Auto-starts from the room id (route param)
 * and the key in the URL fragment, so scanning a QR / opening the link begins
 * the handshake immediately.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest } from '@beam/shared';
import { ReceiverSession } from '@/lib/session/receiverSession';
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

export function useReceiverSession(roomId: string | undefined, keyFragment: string): UseReceiver {
  const sessionRef = useRef<ReceiverSession | null>(null);
  const [state, setState] = useState<ReceiverState>('idle');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [files, setFiles] = useState<CompletedFile[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) {
      setError('Missing room code.');
      setState('error');
      return;
    }
    if (!keyFragment) {
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
    void session.start(roomId, keyFragment).catch((e: Error) => {
      setError(e.message);
      setState('error');
    });

    return () => {
      session.close();
      sessionRef.current = null;
    };
  }, [roomId, keyFragment]);

  const accept = useCallback(async (fileIndices: number[], sink: SinkKind) => {
    await sessionRef.current?.accept(fileIndices, sink);
  }, []);

  const cancel = useCallback(() => {
    void sessionRef.current?.cancel();
  }, []);

  return { state, manifest, progress, route, files, waiting, error, accept, cancel };
}
