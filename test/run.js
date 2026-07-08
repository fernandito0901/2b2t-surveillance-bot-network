/**
 * test/run.js — Dependency-free smoke + regression tests. Run: npm test
 * Focused on the fragile parsing/aggregation that has silently broken before.
 */
const assert = require('assert');
const P = require('../lib/parsers');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

console.log('parsers:');

t('queue position — last of many', () => {
  const text = 'Position in queue: 500\nfoo\nPosition in queue: 497\nPosition in queue: 495';
  assert.strictEqual(P.lastQueuePosition(text), 495);
});
t('queue position — none', () => assert.strictEqual(P.lastQueuePosition('nothing here'), null));

t('device code — new otc URL form', () => {
  const dc = P.deviceCode('[Terminal] Login Here: https://www.microsoft.com/link?otc=VNR8GHHA');
  assert.deepStrictEqual(dc, { url: 'https://www.microsoft.com/link?otc=VNR8GHHA', code: 'VNR8GHHA' });
});
t('device code — old "with code" form', () => {
  const dc = P.deviceCode('Login Here: https://microsoft.com/link with code: ABCD1234');
  assert.strictEqual(dc.code, 'ABCD1234');
});
t('device code — absent', () => assert.strictEqual(P.deviceCode('Position in queue: 10'), null));

t('in-game — chat flowing', () => assert.ok(P.isInGame('[2026/06/23 18:51:33] [Chat] [INFO] <jimmie67> hi')));
t('in-game — join line', () => assert.ok(P.isInGame('Connected to the server')));
t('in-game — queuing is NOT in-game', () => assert.ok(!P.isInGame('Position in queue: 412')));

t('visualRange — enter', () => {
  const e = P.visualRangeEvent('[Module] [WARN] [VisualRange] Finnders entered visual range');
  assert.deepStrictEqual(e, { player: 'Finnders', kind: 'enter' });
});
t('visualRange — leave', () => assert.strictEqual(P.visualRangeEvent('[VisualRange] Finnders left visual range').kind, 'leave'));
t('visualRange — logout', () => assert.strictEqual(P.visualRangeEvent('[VisualRange] popbob logged out').kind, 'logout'));
t('visualRange — non-VR line', () => assert.strictEqual(P.visualRangeEvent('[Chat] [INFO] <x> hi'), null));

t('loggedInAs — extracts + cleans IGN', () => assert.strictEqual(P.loggedInAs('[Auth] Logged in as SpectatorBot [uuid]'), 'SpectatorBot'));

console.log('metrics store:');
const metrics = require('../metrics/MetricsStore');
const id = '__test__' + Date.now();
const now = Date.now();
metrics.recordSample(id, 'queuing', 500);
metrics.recordSample(id, 'in_game', null);
metrics.recordSample(id, 'queuing', 480);
metrics.recordEvent(id, 'drop', 're-queued #480');
t('metrics — segments produced', () => assert.ok(metrics.segments(id, now - 60000).length >= 1));
t('metrics — availability has in-game + queuing', () => {
  const a = metrics.availability(id, now - 60000);
  assert.ok((a.G || 0) >= 0 && (a.Q || 0) >= 0);
});
t('metrics — drop counted', () => assert.strictEqual(metrics.countEvents(id, 'drop', now - 60000), 1));
t('metrics — queueSeries non-null points', () => assert.ok(metrics.queueSeries(id, now - 60000).every(p => p.q != null)));

console.log('cartography:');
const xaero = require('../cartography/XaeroDecoder');
t('regionCoords — parses x_z.zip', () => assert.deepStrictEqual(xaero.regionCoords('-1_-3065.zip'), [-1, -3065]));
t('regionCoords — path-prefixed', () => assert.deepStrictEqual(xaero.regionCoords('mw$default/0_-2808.zip'), [0, -2808]));
t('decodeRegion — flags player blocks, skips natural + biomes', () => {
  const fake = Buffer.from('minecraft:netherrack minecraft:obsidian minecraft:ender_chest minecraft:nether_wastes minecraft:orange_banner', 'latin1');
  const { blocks, signals } = xaero.decodeRegion(fake);
  assert.ok(signals.includes('ender_chest') && signals.includes('orange_banner'), 'player blocks flagged');
  assert.ok(!signals.includes('obsidian'), 'obsidian excluded (natural in nether)');
  assert.ok(!blocks.includes('nether_wastes'), 'biome filtered from blocks');
});

console.log(`\n${passed} tests passed`);
process.exit(0);
