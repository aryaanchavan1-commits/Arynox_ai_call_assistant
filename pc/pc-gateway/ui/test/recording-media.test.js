import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRecordingMediaService } from '../electron/recording-media.js';

test('recording media URLs authorize only the selected local file and expire', async () => {
  let handler;
  let clock = 10_000;
  const directory = await mkdtemp(join(tmpdir(), 'agentcall-media-'));
  const mediaPath = join(directory, 'conversation.wav');
  await writeFile(mediaPath, Buffer.from('0123456789abcdef'));
  const protocol = {
    handle: (scheme, callback) => {
      assert.equal(scheme, 'agentcall-media');
      handler = callback;
    },
  };
  try {
    const service = createRecordingMediaService({ protocol, now: () => clock });
    const mediaUrl = service.createMediaUrl(mediaPath);

    const allowed = await handler({ url: mediaUrl, method: 'GET', headers: new Headers() });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('content-type'), 'audio/wav');
    assert.equal(await allowed.text(), '0123456789abcdef');

    const partial = await handler({
      url: mediaUrl,
      method: 'GET',
      headers: new Headers({ range: 'bytes=4-7' }),
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 4-7/16');
    assert.equal(await partial.text(), '4567');

    clock += 60 * 60 * 1000 + 1;
    const expired = await handler({ url: mediaUrl, method: 'GET', headers: new Headers() });
    assert.equal(expired.status, 404);

    const forged = await handler({
      url: 'agentcall-media://recording/not-authorized',
      method: 'GET',
      headers: new Headers(),
    });
    assert.equal(forged.status, 404);
  } finally {
    await rm(directory, { recursive: true });
  }
});
