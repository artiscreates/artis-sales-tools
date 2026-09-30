// node --test "red yellow green/lib.test.js"
// lib.js is a browser script; load it the way Chrome does, into a global.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('./lib.js', import.meta.url), 'utf8'));
const { normalizeDomain, normalizeHandle, unwrapLink, evaluateRecord, extractEmails, worst } = globalThis.ArtisCRM;

const DAY = 86400000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ev = (props, opts = {}) => evaluateRecord(props, { now: NOW, ...opts });

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://www.Studio-X.com/about?x=1#y'), 'studio-x.com');
  assert.equal(normalizeDomain('www.lavish.inc'), 'lavish.inc');
  assert.equal(normalizeDomain('shop.studio.com:8080'), 'studio.com');
  assert.equal(normalizeDomain('name@Studio.com'), 'studio.com');
  assert.equal(normalizeDomain('https://www.studio.co.uk/'), 'studio.co.uk');
  assert.equal(normalizeDomain('studio.com.'), 'studio.com');
  assert.equal(normalizeDomain('192.168.0.1'), '');
  assert.equal(normalizeDomain('localhost'), '');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
});

test('normalizeHandle', () => {
  assert.equal(normalizeHandle('@Studio.X'), 'studio.x');
  assert.equal(normalizeHandle('https://www.instagram.com/studio_x/?hl=en'), 'studio_x');
  assert.equal(normalizeHandle('instagram.com/studio_x/reels/'), 'studio_x');
  assert.equal(normalizeHandle('https://www.instagram.com/p/Cxyz/'), '');
  assert.equal(normalizeHandle('explore'), '');
  assert.equal(normalizeHandle('bad handle'), '');
  assert.equal(normalizeHandle('a'.repeat(31)), '');
  assert.equal(normalizeHandle(''), '');
});

test('unwrapLink', () => {
  assert.equal(unwrapLink('https://l.instagram.com/?u=https%3A%2F%2Fstudiox.com%2F&e=abc'), 'https://studiox.com/');
  assert.equal(unwrapLink('https://studiox.com/a'), 'https://studiox.com/a');
  assert.equal(unwrapLink('https://www.instagram.com/studiox/'), 'https://www.instagram.com/studiox/');
  assert.equal(unwrapLink('not a url'), 'not a url');
});

test('extractEmails skips image filenames and trailing dots', () => {
  assert.deepEqual(extractEmails('Mail Jo@Studio.com. or logo@2x.png'), ['jo@studio.com']);
});

test('evaluateRecord: green is the caller, yellow is any quiet match', () => {
  assert.equal(ev({}).status, 'yellow');
  assert.match(ev({}).reason, /no emails or calls logged/);
  assert.equal(ev({ lifecyclestage: 'opportunity', hs_num_open_deals: '0', notes_last_contacted: ago(60) }).status, 'yellow');
});

test('evaluateRecord: 45/46-day boundary', () => {
  assert.equal(ev({ notes_last_contacted: ago(45) }).status, 'red');
  assert.equal(ev({ notes_last_contacted: ago(45.9) }).status, 'red');
  assert.equal(ev({ notes_last_contacted: ago(46) }).status, 'yellow');
  assert.equal(ev({ notes_last_contacted: ago(0) }).reason, 'Contacted today');
  assert.equal(ev({ notes_last_contacted: new Date(NOW + DAY).toISOString() }).status, 'red'); // clock skew
  assert.equal(ev({ notes_last_contacted: String(NOW - 10 * DAY) }).status, 'red'); // epoch-ms string
  assert.equal(ev({ notes_last_contacted: ago(20) }, { windowDays: 14 }).status, 'yellow');
});

test('evaluateRecord: red rules', () => {
  assert.equal(ev({ lifecyclestage: 'customer', notes_last_contacted: ago(400) }).reason, 'Customer');
  assert.equal(ev({ lifecyclestage: 'customer', customer_status: 'Inactive' }).reason, 'Former customer');
  assert.equal(ev({ lifecyclestage: 'evangelist' }).status, 'red');
  assert.equal(ev({ hs_num_open_deals: '2', notes_last_contacted: ago(100) }).reason, 'Open deal');
  assert.equal(ev({ hs_email_optout: 'true' }).reason, 'Opted out of email');
  assert.equal(ev({ hs_email_optout: 'false' }).status, 'yellow');
});

test('evaluateRecord: owner changes the label, never the color', () => {
  assert.deepEqual(ev({ hubspot_owner_id: '1', notes_last_contacted: ago(60) }, { ownerName: 'Zach Rubin' }),
    { status: 'yellow', reason: 'In HubSpot · last contacted 60d ago · Zach Rubin' });
  assert.equal(ev({ hubspot_owner_id: '9' }).reason, 'In HubSpot · no emails or calls logged · former rep');
  assert.equal(ev({ lifecyclestage: 'customer', hubspot_owner_id: '1' }, { ownerName: 'Zach Rubin' }).reason, 'Customer · Zach Rubin');
});

test('worst: the strictest color wins', () => {
  const g = { status: 'green' }, y = { status: 'yellow' }, r = { status: 'red' };
  assert.equal([y, r, g].reduce(worst), r);
  assert.equal([g, y].reduce(worst), y);
  assert.equal(worst(null, y), y);
});
