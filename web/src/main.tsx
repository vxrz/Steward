import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { BRAND } from '../../shared/src/brand';
import './i18n';
import { App } from './App';
import { initPwa } from './pwa';
import { initErrorReporting } from './errorReporting';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemedMantineProvider } from './theme';
import { BASE_PATH } from './basePath';

document.title = BRAND.name;
initPwa();
void initErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* the administrator's theme (Settings → Appearance), also on the sign-in page */}
      <ThemedMantineProvider>
        <Notifications position="top-right" />
        {/* confirmation dialogs (components/confirm.tsx) */}
        <ModalsProvider>
          {/* with a trailing slash: the app's home is /steward/ (the server redirects /steward there) */}
          <BrowserRouter basename={BASE_PATH ? BASE_PATH + '/' : undefined}>
            <ErrorBoundary>
              {/* Suspends while the language files of a non-English UI load. */}
              <Suspense
                fallback={
                  <Center h="100vh">
                    <Loader />
                  </Center>
                }
              >
                <App />
              </Suspense>
            </ErrorBoundary>
          </BrowserRouter>
        </ModalsProvider>
      </ThemedMantineProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
