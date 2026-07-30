import { createInterface } from 'node:readline';
import { decodeTranscript, encodeTranscript, syntheticTranscript } from '../../src/bootstrap-protocol-v2.js';

const mode = process.argv[2];
if (!['produce', 'roundtrip'].includes(mode) || process.argv.length !== 3) throw new Error('invalid interop mode');
let bytes;
if (mode === 'produce') {
  bytes = encodeTranscript(syntheticTranscript());
} else {
  const [line = '', ...extra] = await new Promise((resolve) => {
    const lines = [];
    const input = createInterface({ input: process.stdin });
    input.on('line', (value) => lines.push(value));
    input.on('close', () => resolve(lines));
  });
  if (extra.length || !/^(?:[0-9a-f]{2})+$/.test(line) || line.length > 8192) throw new Error('invalid interop input');
  bytes = encodeTranscript(decodeTranscript(Buffer.from(line, 'hex')));
}
process.stdout.write(`${bytes.toString('hex')}\n`);
