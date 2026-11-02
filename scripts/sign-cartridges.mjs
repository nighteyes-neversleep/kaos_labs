import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privatePath = resolve(root, '.omi-dev/cartridge-signing-key.pem');
await mkdir(dirname(privatePath), { recursive: true });
let privateKey;
try {
  privateKey = await readFile(privatePath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
}
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
await mkdir(resolve(root, 'src/generated'), { recursive: true });
await writeFile(resolve(root, 'src/generated/cartridge-trust.json'), JSON.stringify({ publicKey, label: 'Local development signer' }, null, 2) + '\n');
const source = await readFile(resolve(root, 'omi-client/cartridges/eagles-nest/index.html'), 'utf8');
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';";
if (!source.includes('<head>')) throw new Error('Cartridge must have an explicit head element');
const html = source.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
const payload = Buffer.from(JSON.stringify({ appId: 'eagles-nest', version: '0.1.0', html }), 'utf8');
const bundle = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
const out = resolve(root, 'public/cartridges');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'eagles-nest.bundle.json'), JSON.stringify(bundle));
console.log('Signed Eagle’s Nest for local development. This is not a production trust attestation.');
