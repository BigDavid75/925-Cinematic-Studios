import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, extractScriptText } from '../lib/script.js';

test('screenplay: one shot per scene heading, in order, dialogue kept out of the prompt', () => {
  const shots = parseScript('FADE IN:\n\nINT. LIGHTHOUSE - NIGHT\n\nA keeper climbs the stairs.\n\nMARA\n(whispering)\nNot tonight.\n\nEXT. CLIFF - DAWN\n\nWaves crash below. (3s)\n');
  assert.deepEqual(shots.map((s) => s.heading), ['INT. LIGHTHOUSE - NIGHT', 'EXT. CLIFF - DAWN']);
  assert.match(shots[0].prompt, /keeper climbs/);
  assert.doesNotMatch(shots[0].prompt, /Not tonight|MARA/);
  assert.match(shots[0].text, /Not tonight/);
  assert.equal(shots[1].duration_seconds, 3);
  assert.doesNotMatch(shots[1].prompt, /3s/);
});

test('explicit shot markers keep their order and numbers', () => {
  const shots = parseScript('Shot 1: A red kite over a field [5 sec]\nShot 2 - A child runs after it\n\n## Shot 3\nThe kite snags in a tree');
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((s) => s.heading), ['Shot 1', 'Shot 2', 'Shot 3']);
  assert.equal(shots[0].duration_seconds, 5);
  assert.match(shots[2].prompt, /snags in a tree/);
});

test('numbered lists and prose paragraphs', () => {
  assert.equal(parseScript('1. Sunrise over dunes\n2. A caravan appears\n3. Close on a compass').length, 3);
  assert.equal(parseScript('A city wakes.\n\nTrams start to move.').length, 2);
  const one = parseScript('A city wakes. Trams start to move. A baker opens her door.');
  assert.equal(one.length, 3);
  assert.ok(one.every((s) => s.duration_seconds >= 2 && s.duration_seconds <= 5));
});

test('empty script gives no shots', () => assert.equal(parseScript('  \n ').length, 0));

test('subtitle files lose their timestamps', async () => {
  const t = await extractScriptText('a.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nBye'));
  assert.equal(t, 'Hello there\n\nBye');
});

test('local shots get a sound line from their description', () => {
  const [shot] = parseScript('EXT. CLIFF - DAWN\n\nWaves crash below as gulls wheel overhead.');
  assert.match(shot.sound, /Waves crash/);
  assert.doesNotMatch(shot.sound, /EXT\./);
});
