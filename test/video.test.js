import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMockClip, makeMockAudio, muxAudio, renderFilm, probe, ffmpegAvailable } from '../lib/video.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-video-'));
const f = (n) => path.join(dir, n);
const skip = !(await ffmpegAvailable()) && 'ffmpeg is not installed';

test('stitch keeps sound across silent and sound clips, in order', { skip }, async () => {
  await makeMockClip(f('a.mp4'), { width: 320, height: 192, duration: 2, label: 'A' });
  await makeMockClip(f('b_silent.mp4'), { width: 320, height: 192, duration: 3, label: 'B' });
  await makeMockAudio(f('a.flac'), { duration: 2 });
  await muxAudio(f('a.mp4'), f('a.flac'), f('a_av.mp4'));
  assert.equal((await probe(f('a_av.mp4'))).audio, true);
  assert.equal((await probe(f('b_silent.mp4'))).audio, false);

  const cut = await renderFilm([{ file: f('a_av.mp4') }, { file: f('b_silent.mp4') }], f('cut.mp4'), { format: 'mp4' });
  assert.equal(cut.audio, true);
  assert.deepEqual(cut.segments.map((s) => s.start), [0, 2]);
  const pc = await probe(f('cut.mp4'));
  assert.ok(pc.audio && Math.abs(pc.duration - 5) < 0.15, `duration ${pc.duration}`);

  const fade = await renderFilm([{ file: f('a_av.mp4') }, { file: f('b_silent.mp4') }], f('fade.webm'), { format: 'webm', transition: 'crossfade' });
  assert.ok(fade.audio && fade.duration < 5);

  const silent = await renderFilm([{ file: f('a_av.mp4') }], f('off.mp4'), { format: 'mp4', audio: false });
  assert.equal((await probe(f('off.mp4'))).audio, false);
  assert.equal(silent.audio, false);

  const gif = await renderFilm([{ file: f('a_av.mp4') }], f('x.gif'), { format: 'gif' });
  assert.equal(gif.audio, false);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
