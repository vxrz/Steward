import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { BRAND } from '../../shared/src/brand';
import { App } from './App';
import { initPwa } from './pwa';
import { initErrorReporting } from './errorReporting';
import { ErrorBoundary } from './components/ErrorBoundary';

document.title = BRAND.name;
initPwa();
void initErrorReporting();

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // Icon-only close buttons need an accessible name (screen readers, axe "button-name").
  components: {
    Modal: { defaultProps: { closeButtonProps: { 'aria-label': 'Close' } } },
    Drawer: { defaultProps: { closeButtonProps: { 'aria-label': 'Close' } } },
    // the command palette's result list scrolls; make it reachable by keyboard (axe "scrollable-region-focusable")
    SpotlightActionsList: { defaultProps: { viewportProps: { tabIndex: 0 } } },
    TableScrollContainer: { defaultProps: { scrollAreaProps: { viewportProps: { tabIndex: 0 } } } },
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
