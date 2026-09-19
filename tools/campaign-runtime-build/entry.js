import URL from 'core-js-pure/actual/url/index.js';
import {_SHA256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import runtime from '../../n8n/growth/campaign-runtime.js';
import service from '../../n8n/growth/campaign-service.js';

// JSON.stringify escapes lone surrogates. Encode the resulting JSON as UTF-8
// without relying on Buffer or TextEncoder in the restricted n8n runner.
export function hashValue(value) {
  const json=JSON.stringify(service.stable(value));
  const octets=unescape(encodeURIComponent(json));
  const bytes=Uint8Array.from(octets,c=>c.charCodeAt(0));
  // Use the pinned library's stateful SHA-256 API: the callable wrapper checks
  // realm-specific Object.prototype identity during initialization, which the
  // n8n sandbox does not preserve. No option validation or crypto is bypassed.
  return bytesToHex(new _SHA256().update(bytes).digest());
}
export function createRuntime(options={}) {
  return runtime.createRuntime({...options,hashValue});
}
export {URL};
