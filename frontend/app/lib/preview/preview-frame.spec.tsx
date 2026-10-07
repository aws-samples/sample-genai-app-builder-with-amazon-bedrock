import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreviewFrame, previewSandbox, resolvePreviewUrl, PREVIEW_SANDBOX_BASE } from './preview-frame';

const APP = 'https://vibe.example.dev';

describe('previewSandbox', () => {
  it('grants only the minimum flags a generated app needs', () => {
    expect(PREVIEW_SANDBOX_BASE.split(' ').sort()).toEqual(
      ['allow-forms', 'allow-modals', 'allow-popups', 'allow-scripts'].sort(),
    );
  });

  it('keeps the preview its own origin when it is on a different origin from the app', () => {
    expect(previewSandbox('https://abc.preview.vibe.example.dev/sandbox-preview/abc/', APP).split(' ')).toContain(
      'allow-same-origin',
    );
  });

  it('never combines allow-scripts with allow-same-origin on the app origin', () => {
    const flags = previewSandbox(`${APP}/sandbox-preview/abc/`, APP).split(' ');
    expect(flags).toContain('allow-scripts');
    expect(flags).not.toContain('allow-same-origin');
  });

  it('treats an unparseable or relative src as same-origin', () => {
    expect(previewSandbox('/sandbox-preview/abc/', APP)).not.toContain('allow-same-origin');
    expect(previewSandbox('not a url', APP)).not.toContain('allow-same-origin');
    expect(previewSandbox(undefined, APP)).not.toContain('allow-same-origin');
  });

  it('never grants a sandbox escape or top navigation', () => {
    const flags = previewSandbox('https://abc.preview.vibe.example.dev/', APP);
    expect(flags).not.toContain('allow-top-navigation');
    expect(flags).not.toContain('allow-popups-to-escape-sandbox');
  });
});

describe('resolvePreviewUrl', () => {
  it('uses the URL the session manager handed out', () => {
    expect(
      resolvePreviewUrl({
        previewUrl: 'https://abc.preview.vibe.example.dev/sandbox-preview/abc/',
        appOrigin: APP,
      }),
    ).toBe('https://abc.preview.vibe.example.dev/sandbox-preview/abc/');
  });

  it('falls back to the preview domain from an older session manager', () => {
    expect(resolvePreviewUrl({ previewDomain: 'abc.preview.vibe.example.dev', sessionId: 'abc', appOrigin: APP })).toBe(
      'https://abc.preview.vibe.example.dev/sandbox-preview/abc/',
    );
  });

  it('refuses a preview on the app origin', () => {
    expect(resolvePreviewUrl({ previewUrl: `${APP}/sandbox-preview/abc/`, appOrigin: APP })).toBeNull();
  });

  it('refuses a non-https preview URL', () => {
    expect(resolvePreviewUrl({ previewUrl: 'http://abc.preview.vibe.example.dev/', appOrigin: APP })).toBeNull();
    expect(resolvePreviewUrl({ previewUrl: 'javascript:alert(1)', appOrigin: APP })).toBeNull();
  });

  it('has nothing to offer without an untrusted origin', () => {
    expect(resolvePreviewUrl({ sessionId: 'abc', appOrigin: APP })).toBeNull();
  });
});

describe('PreviewFrame', () => {
  it('renders a sandboxed iframe on the untrusted origin', () => {
    const html = renderToStaticMarkup(
      <PreviewFrame src="https://abc.preview.vibe.example.dev/sandbox-preview/abc/" appOrigin={APP} />,
    );

    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    expect(html).toContain('src="https://abc.preview.vibe.example.dev/sandbox-preview/abc/"');
  });

  it('drops allow-same-origin if the src would be the app origin', () => {
    const html = renderToStaticMarkup(<PreviewFrame src={`${APP}/x`} appOrigin={APP} />);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-modals"');
  });
});
