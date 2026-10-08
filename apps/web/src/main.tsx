import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
// The shared stylesheet loads before the router pulls in every page's CSS, so a page rule wins
// over a shared rule of the same specificity without doubling its classes.
import './styles.css';
import { router } from './app/router.js';
import { createTheme, cssVariables } from './app/theme.js';

const style = document.createElement('style');
style.textContent = cssVariables();
document.head.appendChild(style);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

async function bootstrap(): Promise<void> {
  const root = document.getElementById('root')!;
  // Preview builds (VITE_PB_PREVIEW=true) run against recorded synthetic API responses; see src/preview/shim.ts.
  if (import.meta.env.VITE_PB_PREVIEW === 'true') {
    try {
      const { installPreviewShim } = await import('./preview/shim.js');
      await installPreviewShim('./preview/fixtures.json');
    } catch (error) {
      // Without the recordings nothing can render; say so rather than leave the page blank.
      const reason = error instanceof Error ? error.message : 'unknown error';
      root.textContent = `This preview could not load its recorded data (preview/fixtures.json): ${reason}.`;
      return;
    }
  }
  createRoot(root).render(
    <StrictMode>
      <FluentProvider theme={createTheme()}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </FluentProvider>
    </StrictMode>,
  );
}

void bootstrap();
