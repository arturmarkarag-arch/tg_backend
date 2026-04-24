import React, { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { ConfirmProvider } from './components/ConfirmModal.jsx';
import MiniAppPage from './routes/MiniAppPage.jsx';
import OrderSummaryPage from './routes/OrderSummaryPage.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const [isTelegramWebApp, setIsTelegramWebApp] = useState(false);
  const [checkedWebApp, setCheckedWebApp] = useState(false);

  useEffect(() => {
    const hasWebApp = typeof window !== 'undefined' && Boolean(window.Telegram?.WebApp);
    setIsTelegramWebApp(hasWebApp);
    setCheckedWebApp(true);
  }, []);

  if (!checkedWebApp) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AppRoutes isTelegramWebApp={isTelegramWebApp}>
            <div className="min-h-screen bg-slate-950 text-slate-100">
              <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
                <main className="space-y-6">
                  <Routes>
                    <Route path="/mini-app" element={<MiniAppPage />} />
                    <Route path="/orders/:id" element={<OrderSummaryPage />} />
                    <Route path="*" element={<Navigate to="/mini-app" replace />} />
                  </Routes>
                </main>
              </div>
            </div>
          </AppRoutes>
        </BrowserRouter>

        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: '#0f172a',
              color: '#f8fafc',
            },
          }}
        />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

function AppRoutes({ isTelegramWebApp, children }) {
  const location = useLocation();
  const isPublicOrderPage = location.pathname.startsWith('/orders/');

  if (!isTelegramWebApp && !isPublicOrderPage) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-4 py-10 text-center">
          <div className="rounded-3xl border border-slate-700 bg-slate-900/90 p-10 shadow-xl shadow-slate-950/40">
            <h1 className="text-3xl font-semibold text-white">Доступно тільки через Telegram</h1>
            <p className="mt-4 text-sm leading-6 text-slate-400">
              Відкрийте цю апку через Telegram Web App, щоб потрапити до мініапу. Прямий доступ з браузера вимкнено.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default App;
