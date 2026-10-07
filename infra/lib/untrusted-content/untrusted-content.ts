import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Untrusted content: live previews of generated apps and published shared sites.
 *
 * Both are LLM-written code. Served from the authenticated app's origin they could
 * read the tokens the app keeps in localStorage/sessionStorage (the sign-in tokens)
 * and call the API as the signed-in user. So they live on their own CloudFront
 * distribution and hostnames, and the app's distribution only redirects there.
 *
 * Hostnames, in order of preference:
 *   - `previewDomain` set: `*.<previewDomain>` — a separate registrable domain,
 *     so the app and the untrusted content are not even same-site (no cookie
 *     tossing onto the app domain). Needs a hosted zone for it in this account.
 *   - only `customDomain` set: `*.preview.<customDomain>` — a distinct origin per
 *     session, but same-site with the app.
 *   - neither: the distribution's own `*.cloudfront.net` host, which is cross-site
 *     from the app's (cloudfront.net is on the Public Suffix List), though every
 *     session shares that one origin.
 *
 * Resources are created in the caller's scope with their historical IDs so an
 * existing `PreviewDistribution` updates in place rather than being replaced
 * (a replacement would collide on the wildcard alias).
 */

export interface UntrustedContentProps {
  stackPrefix: string;
  /** Sandbox ALB origin, already carrying the origin-verify header. */
  albOrigin: cloudfront.IOrigin;
  /** Viewer-request function that sets x-sandbox-session from the path. */
  previewRequestFunction: cloudfront.IFunction;
  sharedSitesBucket: s3.IBucket;
  sharedSitesRewriteFunction: cloudfront.IFunction;
  originAccessControl: cloudfront.IOriginAccessControl;
  /** Bucket for CloudFront standard access logs. */
  logBucket?: s3.IBucket;
  /** The authenticated app's origin, e.g. https://vibe.example.dev. Undefined without a custom domain. */
  appOrigin?: string;
  /** Wildcard parent for untrusted hosts (`*.<parentDomain>`) and the zone it lives in. */
  domain?: { parentDomain: string; hostedZone: route53.IHostedZone };
}

export interface UntrustedContent {
  distribution: cloudfront.Distribution;
  /** Host for a session's preview; `{sessionId}` is substituted when per-session hosts exist. */
  previewHostTemplate: string;
  /** Full preview URL template, for the session manager. */
  previewUrlTemplate: string;
  /** Host shared sites are served from. */
  sharedSitesHost: string;
  /** https origin share links are minted on. */
  sharedSitesOrigin: string;
  /** CSP source the app may frame. */
  frameSource: string;
}

/** Placeholder replaced with a session id in host/URL templates. */
export const SESSION_PLACEHOLDER = '{sessionId}';

/** Host share links use under a wildcard parent domain. */
export const SHARED_SITES_LABEL = 'shared';

const HSTS = {
  accessControlMaxAge: cdk.Duration.seconds(47304000),
  includeSubdomains: true,
  preload: true,
  override: true,
};

// Generated code can be served by anything the LLM wrote (a Vite plugin, an
// Express dev server); none of it may grant credentialed cross-origin reads.
const STRIP_CREDENTIALED_CORS = ['Access-Control-Allow-Credentials'];

export function createUntrustedContent(scope: Construct, props: UntrustedContentProps): UntrustedContent {
  const { stackPrefix, domain } = props;

  // No app origin without a custom domain: the app's *.cloudfront.net host can't be
  // referenced here without a dependency cycle (the app's CSP references this
  // distribution), so fall back to any CloudFront host.
  const frameAncestors = props.appOrigin ?? 'https://*.cloudfront.net';

  const previewHeaders = new cloudfront.ResponseHeadersPolicy(scope, 'PreviewHeadersPolicy', {
    responseHeadersPolicyName: `${stackPrefix}-preview-headers`,
    comment: 'Live previews of generated apps: framed only by the app',
    securityHeadersBehavior: {
      // Only framing is constrained — the generated app may legitimately load
      // anything else, and it already runs on an origin that holds no secrets.
      contentSecurityPolicy: { contentSecurityPolicy: `frame-ancestors ${frameAncestors};`, override: true },
      contentTypeOptions: { override: true },
      strictTransportSecurity: HSTS,
      // The path carries the session id; don't leak it to third parties.
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
    },
    removeHeaders: STRIP_CREDENTIALED_CORS,
  });

  const sharedSitesHeaders = new cloudfront.ResponseHeadersPolicy(scope, 'SharedSitesHeadersPolicy', {
    responseHeadersPolicyName: `${stackPrefix}-shared-sites-headers`,
    comment: 'Published shared sites: standalone, never framed',
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: "frame-ancestors 'none'; object-src 'none'; base-uri 'self';",
        override: true,
      },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      contentTypeOptions: { override: true },
      strictTransportSecurity: HSTS,
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
    },
    removeHeaders: STRIP_CREDENTIALED_CORS,
  });

  const sharedSitesOrigin = origins.S3BucketOrigin.withOriginAccessControl(props.sharedSitesBucket, {
    originAccessControl: props.originAccessControl,
  });

  const sharedSitesBehavior: cloudfront.BehaviorOptions = {
    origin: sharedSitesOrigin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    responseHeadersPolicy: sharedSitesHeaders,
    functionAssociations: [{
      function: props.sharedSitesRewriteFunction,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    }],
  };

  const certificate = domain
    ? new acm.DnsValidatedCertificate(scope, 'PreviewCertificate', {
        domainName: `*.${domain.parentDomain}`,
        hostedZone: domain.hostedZone,
        region: 'us-east-1', // CloudFront certificates must be in us-east-1
      })
    : undefined;

  const distribution = new cloudfront.Distribution(scope, 'PreviewDistribution', {
    comment: `Untrusted content (previews, shared sites) for ${stackPrefix}`,
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    ...(props.logBucket
      ? { enableLogging: true, logBucket: props.logBucket, logFilePrefix: 'cloudfront/preview/', logIncludesCookies: false }
      : {}),
    ...(domain && certificate ? { domainNames: [`*.${domain.parentDomain}`], certificate } : {}),
    // Anything that is neither a preview nor a shared site lands on the bucket,
    // which only holds shared sites — never on the sandbox ALB.
    defaultBehavior: sharedSitesBehavior,
    additionalBehaviors: {
      '/shared/*': sharedSitesBehavior,
      '/sandbox-preview*': {
        origin: props.albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // ALL_VIEWER carries the ALB stickiness cookies and the HMR upgrade
        // headers. Safe here: this host never sees the app's cookies or tokens.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        responseHeadersPolicy: previewHeaders,
        functionAssociations: [{
          function: props.previewRequestFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
    },
    // WebSocket (Vite HMR) works over HTTP/1.1 upgrade; HTTP/2+3 for page loads.
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  });

  if (domain) {
    const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
    new route53.ARecord(scope, 'PreviewARecord', {
      zone: domain.hostedZone,
      recordName: `*.${domain.parentDomain}`,
      target,
    });
    new route53.AaaaRecord(scope, 'PreviewAaaaRecord', {
      zone: domain.hostedZone,
      recordName: `*.${domain.parentDomain}`,
      target,
    });
  }

  const previewHostTemplate = domain
    ? `${SESSION_PLACEHOLDER}.${domain.parentDomain}`
    : distribution.distributionDomainName;
  const sharedSitesHost = domain
    ? `${SHARED_SITES_LABEL}.${domain.parentDomain}`
    : distribution.distributionDomainName;

  new cdk.CfnOutput(scope, 'PreviewDomain', {
    value: domain ? `*.${domain.parentDomain}` : distribution.distributionDomainName,
    description: 'Untrusted content host(s): live previews and shared sites',
  });

  return {
    distribution,
    previewHostTemplate,
    previewUrlTemplate: `https://${previewHostTemplate}/sandbox-preview/${SESSION_PLACEHOLDER}/`,
    sharedSitesHost,
    sharedSitesOrigin: `https://${sharedSitesHost}`,
    frameSource: domain ? `https://*.${domain.parentDomain}` : `https://${distribution.distributionDomainName}`,
  };
}

/**
 * Viewer-request function for the app distribution's legacy untrusted paths.
 *
 * `/sandbox-preview/{id}/...` and `/shared/{id}/...` used to be served from the
 * app's own origin. They now only 302 to the untrusted host, so old links keep
 * working without generated code ever executing on the app origin. The function
 * answers itself; the request never reaches an origin.
 *
 * Written for the cloudfront-js-1.0 (ES5.1) runtime.
 */
export function legacyRedirectFunctionCode(opts: {
  previewHostTemplate: string;
  sharedSitesHost: string;
}): string {
  return `
var PREVIEW_HOST = ${JSON.stringify(opts.previewHostTemplate)};
var SHARED_HOST = ${JSON.stringify(opts.sharedSitesHost)};
function qs(q) {
  var parts = [];
  for (var k in q) {
    var v = q[k];
    if (v.multiValue) {
      for (var i = 0; i < v.multiValue.length; i++) { parts.push(k + '=' + v.multiValue[i].value); }
    } else {
      parts.push(k + '=' + v.value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = null;
  var m = uri.match(/^\\/sandbox-preview\\/([A-Za-z0-9-]{1,63})(\\/|$)/);
  if (m) {
    host = PREVIEW_HOST.split('${SESSION_PLACEHOLDER}').join(m[1]);
  } else if (uri.indexOf('/shared/') === 0) {
    host = SHARED_HOST;
  }
  if (!host) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: { value: 'https://' + host + uri + qs(request.querystring || {}) },
      'cache-control': { value: 'no-store' }
    }
  };
}
`;
}
