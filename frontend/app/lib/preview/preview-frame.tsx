import { forwardRef } from 'react';

/**
 * The live preview runs generated (LLM-written) code, so it is only ever loaded
 * from the untrusted-content origin the session manager hands out — never from
 * the app's own origin, where it could read the auth tokens the app keeps in
 * localStorage/sessionStorage.
 *
 * Sandbox flags, and why:
 *   - allow-scripts, allow-forms, allow-popups, allow-modals: what a generated web
 *     app needs to run, submit forms, open links and use alert/confirm.
 *   - allow-same-origin: only when the preview is on a different origin from the
 *     app. It keeps the preview's own origin so Vite's module scripts, its HMR
 *     WebSocket, the app's own localStorage and the ALB stickiness cookies work.
 *     Combined with allow-scripts on the *app's* origin it would let the frame
 *     remove its own sandbox, so it is dropped whenever the src is (or cannot be
 *     shown not to be) the app origin.
 * Deliberately absent: allow-top-navigation*, allow-popups-to-escape-sandbox.
 */
export const PREVIEW_SANDBOX_BASE = 'allow-scripts allow-forms allow-popups allow-modals';

function originOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    // no base: a relative src would resolve to the app origin, so it is treated as one
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Sandbox attribute for a preview iframe at `src`, embedded by `appOrigin`. */
export function previewSandbox(src: string | undefined, appOrigin: string): string {
  const origin = originOf(src);

  if (!origin || origin === 'null' || origin === appOrigin) {
    return PREVIEW_SANDBOX_BASE;
  }

  return `${PREVIEW_SANDBOX_BASE} allow-same-origin`;
}

/**
 * The URL to load a session's preview from, or null if there is no untrusted
 * origin to load it from. Never the app's own origin.
 */
export function resolvePreviewUrl(opts: {
  previewUrl?: string;
  previewDomain?: string;
  sessionId?: string;
  appOrigin: string;
}): string | null {
  let candidate = opts.previewUrl;

  // older session managers only returned the per-session preview host
  if (!candidate && opts.previewDomain && opts.sessionId) {
    candidate = `https://${opts.previewDomain}/sandbox-preview/${opts.sessionId}/`;
  }

  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'https:' || url.origin === opts.appOrigin) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

interface PreviewFrameProps {
  src?: string;
  appOrigin: string;
  className?: string;
}

/** The preview iframe, with the sandbox and referrer policy applied. */
export const PreviewFrame = forwardRef<HTMLIFrameElement, PreviewFrameProps>(({ src, appOrigin, className }, ref) => (
  <iframe
    ref={ref}
    className={className}
    src={src}
    sandbox={previewSandbox(src, appOrigin)}
    referrerPolicy="no-referrer"
    title="Preview"
  />
));

PreviewFrame.displayName = 'PreviewFrame';
