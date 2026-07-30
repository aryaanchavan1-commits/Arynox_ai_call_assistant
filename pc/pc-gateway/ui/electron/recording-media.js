import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

const MEDIA_SCHEME = 'agentcall-media';
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export function registerRecordingMediaScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  }]);
}

function contentType(mediaPath) {
  return extname(mediaPath).toLowerCase() === '.wav' ? 'audio/wav' : 'video/x-matroska';
}

function requestedRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start || end >= size) return null;
  return { start, end, partial: true };
}

export function createRecordingMediaService({ protocol, now = Date.now } = {}) {
  if (!protocol?.handle) throw new TypeError('recording media protocol is unavailable');
  const tokens = new Map();
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'recording' ? url.pathname.slice(1) : '';
    const entry = tokens.get(token);
    if (!entry || entry.expiresAt < now()) {
      tokens.delete(token);
      return new Response('Recording playback authorization expired', { status: 404 });
    }
    const metadata = await stat(entry.path);
    if (!metadata.isFile() || metadata.size < 1) {
      return new Response('Recording unavailable', { status: 404 });
    }
    const range = requestedRange(request.headers.get('range'), metadata.size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` },
      });
    }
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Type': contentType(entry.path),
    });
    if (range.partial) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: range.partial ? 206 : 200, headers });
    }
    const stream = createReadStream(entry.path, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream), {
      status: range.partial ? 206 : 200,
      headers,
    });
  });
  return {
    createMediaUrl(mediaPath) {
      const token = randomUUID();
      for (const [key, entry] of tokens) {
        if (entry.expiresAt < now()) tokens.delete(key);
      }
      tokens.set(token, { path: mediaPath, expiresAt: now() + TOKEN_LIFETIME_MS });
      return `${MEDIA_SCHEME}://recording/${token}`;
    },
    clear() {
      tokens.clear();
    },
  };
}

export { MEDIA_SCHEME };
