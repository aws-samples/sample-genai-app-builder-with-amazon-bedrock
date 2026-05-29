import type { AppLoadContext, EntryContext } from '@remix-run/node';
import { RemixServer } from '@remix-run/react';
import { renderToString } from 'react-dom/server';
import { renderHeadToString } from 'remix-island';
import { Head } from './root';
import { DEFAULT_THEME } from '~/lib/stores/theme';

export default async function handleRequest(
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    remixContext: EntryContext,
    _loadContext: AppLoadContext,
) {
    const head = renderHeadToString({ request, remixContext, Head });

    const markup = renderToString(
        <RemixServer context={remixContext} url={request.url} />
    );

    const html = `<!DOCTYPE html><html lang="en" data-theme="${DEFAULT_THEME}"><head>${head}</head><body><div id="root" class="w-full h-full">${markup}</div></body></html>`;

    responseHeaders.set('Content-Type', 'text/html');

    return new Response(html, {
        headers: responseHeaders,
        status: responseStatusCode,
    });
} 