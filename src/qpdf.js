// qpdf (compiled to WebAssembly) for the two jobs pdf-lib cannot do itself:
// removing encryption, and rewriting damaged files into a clean structure.
// Loaded only when needed (~1.3 MB).
const wasmUrl = () => new URL('vendor/qpdf/qpdf.wasm', document.baseURI).href;

async function run(args, input) {
  const { default: createQpdf } = await import('@neslinesli93/qpdf-wasm');
  // A fresh instance per call keeps no document data in memory afterwards.
  // This build binds console.log/error when it is created and ignores the
  // print options, so silence the console while creating it (qpdf's messages,
  // e.g. "invalid password", are not useful to users).
  const { log, error } = console;
  console.log = console.error = () => {};
  let qpdf;
  try {
    qpdf = await createQpdf({ locateFile: wasmUrl });
  } finally {
    console.log = log;
    console.error = error;
  }
  qpdf.FS.writeFile('/in.pdf', input);
  let code;
  try {
    code = qpdf.callMain([...args, '/in.pdf', '/out.pdf']);
  } catch (err) {
    code = typeof err?.status === 'number' ? err.status : 2;
  }
  // qpdf exit codes: 0 ok, 3 ok with warnings, 2 error.
  if (code !== 0 && code !== 3) return null;
  return qpdf.FS.readFile('/out.pdf');
}

/** Cheap check for an /Encrypt entry in the trailer. */
export function looksEncrypted(bytes) {
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  const text = new TextDecoder('latin1').decode(tail);
  if (/\/Encrypt\s/.test(text)) return true;
  // Cross-reference streams may sit earlier in the file.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
}

/**
 * Returns the decrypted file, or null when the password is wrong.
 * An empty password works for files that only restrict editing/printing.
 */
export function decrypt(bytes, password = '') {
  return run([`--password=${password}`, '--decrypt'], bytes);
}

/** Rewrites a damaged PDF; null if qpdf cannot read it either. */
export function repair(bytes) {
  return run(['--decrypt'], bytes);
}
