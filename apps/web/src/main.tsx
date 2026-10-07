import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './app/router.js';
import { createTheme, cssVariables } from './app/theme.js';
import './styles.css';

const style = document.createElement('style');
style.textContent = cssVariables();
document.head.appendChild(style);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FluentProvider theme={createTheme()}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </FluentProvider>
  </StrictMode>,
);
