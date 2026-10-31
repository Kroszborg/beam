/**
 * React binding for SenderSession. Owns the session's lifecycle and surfaces
 * its events as React state. All transfer logic lives in the session/lib layers
 * — this hook is a thin adapter.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SenderSession,
  type ReceiverStatus,
  type SenderPhase,
  type SenderRoomInfo,
  type SenderCode,
} from '@/lib/session/senderSession';
import { SIGNALING_URL } from '@/config/env';

export interface UseSender {
  phase: SenderPhase;
  room: SenderRoomInfo | null;
  receivers: ReceiverStatus[];
  error: string | null;
  code: SenderCode | null;
  start: (files: File[]) => void;
  /** Make (or replace) a short code; resolves when it's shown. */
  createCode: () => Promise<void>;
}

export function useSenderSession(): UseSender {
  const sessionRef = useRef<SenderSession | null>(null);
  const [phase, setPhase] = useState<SenderPhase>('idle');
  const [room, setRoom] = useState<SenderRoomInfo | null>(null);
  const [receivers, setReceivers] = useState<ReceiverStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<SenderCode | null>(null);

  useEffect(() => {
    return () => sessionRef.current?.close();
  }, []);

  const start = useCallback((files: File[]) => {
    if (sessionRef.current || files.length === 0) return;
    // `?relay=1` forces the server relay, to test or work around a bad network.
    const forceRelay = new URLSearchParams(window.location.search).get('relay') === '1';
    const session = new SenderSession(SIGNALING_URL, window.location.origin, { forceRelay });
    sessionRef.current = session;
    session.on('phase', setPhase);
    session.on('room', setRoom);
    session.on('receivers', setReceivers);
    session.on('code', setCode);
    session.on('error', (msg) => {
      setError(msg);
      setPhase('error');
    });
    void session.start(files).catch((e: Error) => {
      setError(e.message || "Couldn't reach the Beam server.");
      setPhase('error');
    });
  }, []);

  const createCode = useCallback(async () => {
    await sessionRef.current?.createCode();
  }, []);

  return { phase, room, receivers, error, code, start, createCode };
}
