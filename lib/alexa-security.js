import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import fetch from 'node-fetch';

const systemRoots = rootCertificates.map(pem => new X509Certificate(pem));
function validAt(cert, now) { return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now; }

export function validateCertificateChain(pem, { roots = systemRoots, now = Date.now() } = {}) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 8) throw new Error('Invalid certificate chain');
  const chain = blocks.map(block => new X509Certificate(block));
  const leaf = chain[0];
  // SAN is mandatory. No CN fallback or wildcard match is accepted for Alexa's signing certificate.
  if (!leaf.subjectAltName?.split(', ').includes('DNS:echo-api.amazon.com') || leaf.ca || !validAt(leaf, now)) throw new Error('Invalid signing identity');
  function trusted(child, seen = new Set()) {
    if (seen.size >= 8 || !validAt(child, now)) return false;
    const visited = new Set(seen).add(child.fingerprint256);
    for (const root of roots) {
      if (root.ca && validAt(root, now) && child.checkIssued(root) && child.verify(root.publicKey)) return true;
    }
    return chain.slice(1).some(parent => parent.ca && !visited.has(parent.fingerprint256)
      && child.checkIssued(parent) && child.verify(parent.publicKey) && trusted(parent, visited));
  }
  if (!trusted(leaf)) throw new Error('Untrusted signing chain');
  return leaf;
}

// Amazon's URL and signing rules, using native X509/RSA verification. Certificates are fetched only
// from its exact HTTPS S3 path; redirects, oversized responses and arbitrary certificate hosts fail closed.
export function createAlexaVerifier({ skillId, fetchImpl = fetch, roots = systemRoots, clock = () => Date.now() }) {
  const cache = new Map();
  return async (rawBody, headers, envelope) => {
    if (!skillId) throw new Error('Alexa skill ID not configured');
    const applicationId = envelope.context?.System?.application?.applicationId || envelope.session?.application?.applicationId;
    if (applicationId !== skillId) throw new Error('Wrong skill');
    const timestamp = Date.parse(envelope.request?.timestamp);
    const tolerance = String(envelope.request?.type).startsWith('AlexaSkillEvent.') ? 3600000 : 150000;
    if (!Number.isFinite(timestamp) || Math.abs(clock() - timestamp) > tolerance) throw new Error('Invalid timestamp');
    if (typeof envelope.request?.requestId !== 'string' || envelope.request.requestId.length > 200) throw new Error('Invalid request identifier');
    const certUrl = headers.signaturecertchainurl;
    const signature = headers['signature-256'];
    if (typeof certUrl !== 'string' || certUrl.length > 2048 || typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 2048) throw new Error('Missing signature');
    const url = new URL(certUrl);
    if (url.protocol !== 'https:' || url.hostname !== 's3.amazonaws.com' || !url.pathname.startsWith('/echo.api/')
      || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash) throw new Error('Invalid certificate URL');
    let cached = cache.get(url.toString());
    if (!cached || cached.until <= clock()) {
      const response = await fetchImpl(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(3000), size: 65536 });
      if (!response.ok) throw new Error('Certificate unavailable');
      const pem = await response.text();
      if (Buffer.byteLength(pem) > 65536) throw new Error('Certificate too large');
      const cert = validateCertificateChain(pem, { roots, now: clock() });
      cached = { cert, until: Math.min(Date.parse(cert.validTo), clock() + 1800000) };
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(url.toString(), cached);
    }
    if (!verifySignature('RSA-SHA256', rawBody, cached.cert.publicKey, Buffer.from(signature, 'base64'))) throw new Error('Invalid signature');
  };
}
