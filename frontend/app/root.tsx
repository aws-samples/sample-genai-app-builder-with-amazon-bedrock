import type { LinksFunction } from '@remix-run/node';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import { stripIndents } from './utils/stripIndent';
import { createHead } from 'remix-island';
import { ThemeProvider } from './components/ui/ThemeProvider';
import AppConfigured from './components/auth/AppConfigured';

import reactToastifyStyles from 'react-toastify/dist/ReactToastify.css?url';
import globalStyles from './styles/index.scss?url';
import xtermStyles from '@xterm/xterm/css/xterm.css?url';

import 'virtual:uno.css';

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: '/favicon.ico',
    type: 'image/x-icon',
  },
  { rel: 'stylesheet', href: reactToastifyStyles },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  { rel: 'stylesheet', href: xtermStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

const inlineThemeCode = stripIndents`
  document.querySelector('html')?.setAttribute('data-theme', 'light');
`;

export const Head = createHead(() => (
  <>
    <meta charSet="utf-8" />
    <meta httpEquiv="Content-Type" content="text/html;charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bedrock Vibe</title>
    <Meta />
    <Links />
    <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
    <script
      dangerouslySetInnerHTML={{
        __html: `window.ENV = ${JSON.stringify({
          CHAT_API_URL: process.env.LAMBDA_FUNCTION_URL || '/api/chat',
          API_BASE_URL: '',
          LAMBDA_FUNCTION_URL: process.env.LAMBDA_FUNCTION_URL || '',
          // Cognito Configuration
          COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID || '',
          COGNITO_USER_POOL_CLIENT_ID: process.env.COGNITO_USER_POOL_CLIENT_ID || '',
          COGNITO_IDENTITY_POOL_ID: process.env.COGNITO_IDENTITY_POOL_ID || '',
          AWS_REGION: process.env.AWS_REGION,
          STACK_PREFIX: process.env.STACK_PREFIX || process.env.STACK_NAME || '',
        })}`
      }}
    />
  </>
));

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AppConfigured>
        {children}
      </AppConfigured>
      <ScrollRestoration />
      <Scripts />
    </ThemeProvider>
  );
}

export default function App() {
  return <Outlet />;
}
