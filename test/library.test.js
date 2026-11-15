import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-lib-'));
const { kindOf, ingest, extractText } = await import('../lib/assets.js');
const { parseCharacterList, autoAssign, createCharacter } = await import('../lib/characters.js');

test('file types: images, documents and audio are recognised; others are not', () => {
  for (const f of ['a.png', 'a.HEIC', 'a.tiff', 'a.svg', 'a.avif', 'a.bmp']) assert.equal(kindOf(f), 'image', f);
  for (const f of ['a.pdf', 'a.doc', 'a.docx', 'a.odt', 'a.rtf', 'a.txt', 'a.fdx', 'a.fountain']) assert.equal(kindOf(f), 'document', f);
  for (const f of ['a.mp3', 'a.wav', 'a.m4a', 'a.flac', 'a.aiff', 'a.ogg', 'a.wma']) assert.equal(kindOf(f), 'audio', f);
  assert.equal(kindOf('a.exe'), null);
  assert.equal(kindOf('blob', 'image/jpeg'), 'image');
});

test('character lists: bibles, cast lists and screenplays', () => {
  assert.deepEqual(parseCharacterList('SHOW - SERIES BIBLE\n\nCHARACTERS\nRILEY (10) – a loud kid, red hoodie.\nGRANDDAD: retired, strict but kind.').map((c) => c.name), ['Riley', 'Granddad']);
  assert.deepEqual(parseCharacterList('Cast:\n- Ana Ruiz: a detective with a scar\n- Theo – her partner, always eating').map((c) => c.name), ['Ana Ruiz', 'Theo']);
  assert.deepEqual(parseCharacterList('INT. KITCHEN\n\nMAYA\nHi.\n\nJONAS\nHey.\n\nMAYA\nBye.\n\nJONAS (V.O.)\nLater.').map((c) => c.name), ['Maya', 'Jonas']);
});

test('rtf text without the font table', async () => {
  const { text } = await extractText('n.rtf', Buffer.from('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0 Granddad\\par Green chair.\\par}'));
  assert.equal(text.trim(), 'Granddad\n Green chair.');
});

test('uploads are filed under characters by document, file name and message', async () => {
  const bible = await ingest(Buffer.from('CHARACTERS\nZARA: a pilot with a silver jacket.\nOMAR: her mechanic, always covered in grease.'), { name: 'cast.txt' });
  const r1 = await autoAssign([bible]);
  assert.deepEqual(r1.created.map((c) => c.name).sort(), ['Omar', 'Zara']);
  const voice = await ingest(Buffer.from('ID3fake-audio-bytes'), { name: 'take3.mp3' });
  const note = await ingest(Buffer.from('Zara checks the engine.'), { name: 'notes.md' });
  const r2 = await autoAssign([voice, note], "this voice is Omar's");
  const by = Object.fromEntries(r2.summary.map((s) => [s.name, s.characters]));
  assert.deepEqual(by['take3.mp3'], ['Omar']);
  assert.ok(by['notes.md'].includes('Zara'));
  createCharacter({ name: 'Zara' });
  assert.equal((await autoAssign([])).summary.length, 0);
});
