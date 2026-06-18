import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BrowserSupportGate } from '@/components/BrowserSupportGate';

const HomePage = lazy(() => import('@/pages/Home').then((m) => ({ default: m.HomePage })));
const SendPage = lazy(() => import('@/pages/Send').then((m) => ({ default: m.SendPage })));
const ReceivePage = lazy(() => import('@/pages/Receive').then((m) => ({ default: m.ReceivePage })));
const PrivacyPage = lazy(() => import('@/pages/Privacy').then((m) => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('@/pages/Terms').then((m) => ({ default: m.TermsPage })));

/**
 * App routes:
 *   /            landing
 *   /send        sender flow (drop → encrypt → share → transfer)
 *   /r/:roomId   receiver flow (auto-joins; key is in the URL fragment)
 */
export function App() {
  return (
    <BrowserSupportGate>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/r/:roomId" element={<ReceivePage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </BrowserSupportGate>
  );
}
