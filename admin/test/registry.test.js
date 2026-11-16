// 窓口（admin/registry.gs）の自動テスト。Google の各サービスと Slack を偽物にして、本物と同じコードを動かす。
//
//   node --test admin/test/
//
// 窓口は Google の中でしか動かないので、デプロイ前にここで振る舞いを確かめる。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 偽のスプレッドシート

class Sheet {
  constructor(name) { this.name = name; this.cells = []; }
  getName() { return this.name; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  ensure(r, c) {
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1];
    while (row.length < c) row.push('');
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) row.push(((sh.cells[r - 1 + i] || [])[c - 1 + j]) ?? '');
          out.push(row);
        }
        return out;
      },
      setValues(vals) {
        vals.forEach((row, i) => row.forEach((v, j) => { sh.ensure(r + i, c + j); sh.cells[r - 1 + i][c - 1 + j] = v; }));
        return this;
      },
      setValue(v) { sh.ensure(r, c); sh.cells[r - 1][c - 1] = v; return this; },
      setFontWeight() { return this; },
      setDataValidation() { return this; },
      setNumberFormat() { return this; },
      getDisplayValues() { return this.getValues().map(row => row.map(v => String(v ?? ''))); },
      getRow() { return r; },
    };
  }
  getDataRange() {
    const sh = this;
    const w = sh.getLastColumn();
    const grid = () => sh.cells.map(row => { const out = row.slice(); while (out.length < w) out.push(''); return out; });
    return { getValues: grid, getDisplayValues: () => grid().map(r => r.map(v => String(v ?? ''))) };
  }
  appendRow(row) { this.cells.push(row.slice()); }
  deleteRow(r) { this.cells.splice(r - 1, 1); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor() { this.sheets = {}; this.active = null; this.activeRow = 2; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet(n)); }
}

// ---------------------------------------------------------------- 偽の Slack

class FakeSlack {
  constructor() {
    this.channels = {}; // id → {name, members:Set, archived, messages:[]}
    this.dms = {};
    this.strayDms = {};
    this.seq = 0;
    this.token = 'xoxb-good';
    this.rateLimitOnce = false;
    this.calls = [];
    this.dmFails = false;
  }
  ts() { this.seq++; return `1700000000.${String(this.seq).padStart(6, '0')}`; }
  handle(method, p, token) {
    this.calls.push(method);
    if (token !== this.token) return { ok: false, error: 'invalid_auth' };
    switch (method) {
      case 'auth.test': return { ok: true, team: 'MIETA', user: 'mietask', user_id: 'BOT' };
      case 'conversations.create': {
        if (!/^[a-zぁ-んァ-ヶー一-龠0-9_-]+$/.test(p.name)) return { ok: false, error: 'invalid_name' };
        if (Object.values(this.channels).some(c => c.name === p.name)) return { ok: false, error: 'name_taken' };
        const id = 'C' + (100 + Object.keys(this.channels).length);
        this.channels[id] = { name: p.name, members: new Set(['BOT']), archived: false, private: p.is_private === 'true', messages: [] };
        return { ok: true, channel: { id, name: p.name } };
      }
      case 'conversations.invite': {
        const c = this.channels[p.channel];
        if (!c) return { ok: false, error: 'channel_not_found' };
        if (c.members.has(p.users)) return { ok: false, error: 'already_in_channel' };
        c.members.add(p.users);
        return { ok: true };
      }
      case 'conversations.members': {
        const c = this.channels[p.channel];
        return c ? { ok: true, members: [...c.members] } : { ok: false, error: 'channel_not_found' };
      }
      case 'conversations.list':
        return { ok: true, channels: Object.entries(this.channels).filter(([, c]) => c.members.has('BOT') && !c.archived).map(([id, c]) => ({ id, name: c.name })) };
      case 'conversations.info': {
        const c = this.channels[p.channel];
        return c ? { ok: true, channel: { name: c.name, is_archived: c.archived, is_private: !!c.private } } : { ok: false, error: 'channel_not_found' };
      }
      case 'conversations.archive': {
        const c = this.channels[p.channel];
        if (!c) return { ok: false, error: 'channel_not_found' };
        c.archived = true;
        return { ok: true };
      }
      case 'chat.postMessage': {
        if (/^DU/.test(p.channel)) { // DM のスレッドへの返信
          const u = p.channel.slice(1);
          const ts = this.ts();
          (this.dms[u] = this.dms[u] || []).push({ ts, text: p.text, thread_ts: p.thread_ts });
          return { ok: true, channel: p.channel, ts };
        }
        if (/^U/.test(p.channel)) {
          if (this.dmFails) return { ok: false, error: 'missing_scope' };
          const ts = this.ts();
          // 本物の Slack と同じく、表示名を指定すると Bot の入っていない別の場所に置かれ、Bot からは消せない
          if (p.username) {
            (this.strayDms[p.channel] = this.strayDms[p.channel] || []).push({ ts, text: p.text });
            return { ok: true, channel: 'X' + p.channel, ts };
          }
          (this.dms[p.channel] = this.dms[p.channel] || []).push({ ts, text: p.text });
          return { ok: true, channel: 'D' + p.channel, ts };
        }
        const c = this.channels[p.channel];
        if (!c) return { ok: false, error: 'channel_not_found' };
        if (c.archived) return { ok: false, error: 'is_archived' };
        const ts = this.ts();
        c.messages.push({ ts, text: p.text, thread_ts: p.thread_ts, username: p.username });
        return { ok: true, ts };
      }
      case 'chat.delete': {
        if (String(p.channel).startsWith('X')) return { ok: false, error: 'channel_not_found' };
        if (String(p.channel).startsWith('D')) {
          const u = p.channel.slice(1);
          this.dms[u] = (this.dms[u] || []).filter(m => m.ts !== p.ts);
          return { ok: true };
        }
        const c = this.channels[p.channel];
        if (!c) return { ok: false, error: 'channel_not_found' };
        const before = c.messages.length;
        c.messages = c.messages.filter(m => m.ts !== p.ts);
        return before === c.messages.length ? { ok: false, error: 'message_not_found' } : { ok: true };
      }
    }
    return { ok: false, error: 'unknown_method' };
  }
}

// ---------------------------------------------------------------- 偽の Notion

const hex = s => String(s || '').replace(/-/g, '').toLowerCase();

class FakeNotion {
  constructor() {
    this.token = 'ntn_good';
    this.sources = {}; // id → pages[]
    this.denied = new Set(); // インテグレーションが接続されていないデータベース
    this.calls = [];
  }
  match(page, f) {
    if (!f) return true;
    if (f.and) return f.and.every(x => this.match(page, x));
    if (f.or) return f.or.some(x => this.match(page, x));
    const p = page.properties[f.property];
    if (!p) throw new Error('validation_error: ' + f.property);
    if (f.people) return (p.people || []).some(u => hex(u.id) === hex(f.people.contains));
    if (f.status) return p.status && p.status.name === f.status.equals;
    throw new Error('未対応の条件: ' + JSON.stringify(f));
  }
  handle(method, path, body, headers) {
    this.calls.push({ method, path, body, version: headers['Notion-Version'] });
    if (headers.Authorization !== 'Bearer ' + this.token) return [401, { object: 'error', code: 'unauthorized', message: 'API token is invalid.' }];
    if (path === 'users/me') return [200, { object: 'user', type: 'bot', name: 'ミエタスク' }];
    let m = path.match(/^data_sources\/([^/]+)\/query$/);
    if (m && method === 'post') {
      if (!this.sources[m[1]] || this.denied.has(m[1])) return [404, { object: 'error', code: 'object_not_found', message: 'Could not find data_source' }];
      const all = this.sources[m[1]].filter(pg => this.match(pg, body.filter));
      const from = Number(body.start_cursor || 0);
      const size = body.page_size || 100;
      const results = all.slice(from, from + size);
      const more = from + size < all.length;
      return [200, { results, has_more: more, next_cursor: more ? String(from + size) : null }];
    }
    m = path.match(/^pages\/([^/]+)$/);
    if (m && method === 'get') {
      for (const pages of Object.values(this.sources)) {
        const pg = pages.find(x => hex(x.id) === hex(m[1]));
        if (pg) return [200, pg];
      }
      return [404, { object: 'error', code: 'object_not_found', message: 'Could not find page' }];
    }
    return [400, { object: 'error', code: 'invalid_request_url', message: path }];
  }
}

const people = ids => ({ type: 'people', people: ids.map(id => ({ object: 'user', id })) });
const date = (start, end) => ({ type: 'date', date: start || end ? { start: start || null, end: end || null } : null });

function project(id, name, o) {
  return { object: 'page', id, properties: {
    '': { type: 'title', title: [{ plain_text: name }] },
    'CC担当': people(o.cc || []), 'PM担当': people(o.pm || []), 'SP担当': people(o.sp || []),
    'プロジェクトリード': people(o.lead || []), '連携メンバー': people(o.collab || []),
    'ステータス': { type: 'status', status: { name: o.status || '進行中' } },
    'プログラム種別': { type: 'select', select: o.kind ? { name: o.kind } : null },
    '期間': date(o.start, o.end), '授業初日': date(o.first),
  } };
}

function task(id, name, o) {
  return { object: 'page', id, properties: {
    'タスク名': { type: 'title', title: [{ plain_text: name }] },
    '担当者': people(o.who || []),
    'ステータス': { type: 'status', status: { name: o.status } },
    'プログラム': { type: 'relation', relation: (o.projects || []).map(x => ({ id: x })), has_more: false },
  } };
}

// ---------------------------------------------------------------- Apps Script の実行環境

function load() {
  const ss = new Spreadsheet();
  const slack = new FakeSlack();
  const notion = new FakeNotion();
  const clock = { today: '2026-11-16', dow: '1' }; // 月曜
  const triggers = [];
  const props = {};
  const cache = {};
  const ui = { alerts: [], dialogs: [], promptText: '', promptOk: true };
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getActiveSheet: () => ss.active,
      newDataValidation: () => { const b = { requireValueInList: () => b, build: () => ({}) }; return b; },
      getUi: () => ({
        alert: m => ui.alerts.push(m),
        prompt: () => ({ getSelectedButton: () => (ui.promptOk ? 'OK' : 'CANCEL'), getResponseText: () => ui.promptText }),
        ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' },
        showModalDialog: (h, title) => ui.dialogs.push({ html: h.html, title }),
        createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => m }; return m; },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; },
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (url.startsWith('https://api.notion.com/v1/')) {
          const body = opts.payload ? JSON.parse(opts.payload) : {};
          const [code, out] = notion.handle(opts.method, url.replace('https://api.notion.com/v1/', ''), body, opts.headers);
          return { getResponseCode: () => code, getHeaders: () => ({}), getContentText: () => JSON.stringify(out) };
        }
        const method = url.replace('https://slack.com/api/', '');
        if (slack.rateLimitOnce) {
          slack.rateLimitOnce = false;
          return { getResponseCode: () => 429, getHeaders: () => ({ 'Retry-After': '1' }), getContentText: () => '' };
        }
        const token = opts.headers.Authorization.replace('Bearer ', '');
        // 本物の Slack と同じく、読み取り系は JSON の本文を受け付けない
        const isJSON = typeof opts.payload === 'string' || /json/.test(opts.contentType || '');
        if (isJSON && /^conversations\.(info|members|list)$/.test(method)) {
          return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify({ ok: false, error: 'invalid_arguments' }) };
        }
        const raw = typeof opts.payload === 'string' ? JSON.parse(opts.payload) : opts.payload;
        // フォーム形式では値はすべて文字列で届く
        const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
        const out = slack.handle(method, params, token);
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(out) };
      },
    },
    Utilities: {
      sleep: () => {},
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM-dd' ? clock.today : fmt === 'u' ? clock.dow : '2026-11-16T07:00:00+09:00'),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    HtmlService: { createHtmlOutput: h => ({ html: h, setWidth() { return this; }, setHeight() { return this; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: fn => {
        const spec = { fn };
        const b = {
          timeBased: () => b, everyDays: n => { spec.everyDays = n; return b; }, atHour: h => { spec.hour = h; return b; },
          inTimezone: tz => { spec.tz = tz; return b; },
          create: () => { const t = { spec, getHandlerFunction: () => fn }; triggers.push(t); return t; },
        };
        return b;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.REGISTRY_GS || path.join(__dirname, '..', 'registry.gs'), 'utf8'), ctx);
  return { ctx, ss, slack, notion, clock, triggers, props, ui, cache };
}

function seed(env) {
  const { ctx, ss } = env;
  ctx.setupSheets();
  const put = (name, rows) => {
    const sh = ss.getSheetByName(name);
    const head = sh.cells[0];
    rows.forEach(r => sh.appendRow(head.map(h => r[h] ?? '')));
  };
  put('メンバー', [
    { '名前': '山田 太郎', 'Slack ID': 'U1', 'チーム': 'pm1', '状態': '有効' },
    { '名前': '管理 花子', 'Slack ID': 'UM', 'チーム': 'pm', 'ロール': '管理者', '状態': '有効' },
    { '名前': '別チーム', 'Slack ID': 'U2', 'チーム': 'pd', '状態': '有効' },
    { '名前': '退職 次郎', 'Slack ID': 'U9', 'チーム': 'pm2', '状態': '有効' },
  ]);
  put('チーム', [
    { 'チームID': 'pm', '表示名': 'PM' },
    { 'チームID': 'pm1', '表示名': 'PM1', '親チーム': 'pm' },
    { 'チームID': 'pm2', '表示名': 'PM2', '親チーム': 'PM' },
    { 'チームID': 'pd', '表示名': 'PD' },
  ]);
  const settings = ss.getSheetByName('設定');
  settings.cells.forEach(r => { if (r[0] === 'relay_url') r[1] = 'https://script.google.com/macros/s/X/exec'; });
  env.props.SLACK_BOT_TOKEN = 'xoxb-good';
}

function select(env, sheetName, row) {
  env.ss.active = env.ss.getSheetByName(sheetName);
  const orig = env.ss.active.getRange.bind(env.ss.active);
  env.ss.active.getActiveRange = () => ({ getRow: () => row });
  return orig;
}

function call(env, body) {
  return JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
}

function issue(env, row) {
  select(env, 'メンバー', row);
  env.ui.alerts.length = 0;
  env.ctx.menuIssueKey();
  const sid = env.ss.getSheetByName('メンバー').cells[row - 1][1];
  assert.ok(!(env.slack.strayDms[sid] || []).length, '鍵の DM が Bot から消せない場所に送られた（表示名を指定している）');
  const dm = (env.slack.dms[sid] || []).slice(-1)[0];
  assert.ok(dm, '鍵の DM が届いていない: ' + env.ui.alerts.join(' / '));
  const key = dm.text.match(/```(mietask2\.[A-Za-z0-9_-]+)```/)[1];
  return JSON.parse(Buffer.from(key.slice('mietask2.'.length), 'base64url').toString('utf8'));
}

function setCell(env, sheet, row, header, value) {
  const sh = env.ss.getSheetByName(sheet);
  sh.cells[row - 1][sh.cells[0].indexOf(header)] = value;
}

function cell(env, sheet, row, header) {
  const sh = env.ss.getSheetByName(sheet);
  return sh.cells[row - 1][sh.cells[0].indexOf(header)];
}

// ---------------------------------------------------------------- テスト

test('鍵の発行から、投稿先の用意・投稿まで', () => {
  const env = load();
  seed(env);
  const k = issue(env, 2);
  assert.strictEqual(k.u, 'https://script.google.com/macros/s/X/exec');
  assert.strictEqual(k.i, 'U1');
  assert.ok(cell(env, 'メンバー', 2, '鍵').startsWith('発行'));

  const me = call(env, { id: k.i, k: k.k, action: 'me' });
  assert.ok(me.ok, JSON.stringify(me));
  assert.strictEqual(me.me.name, '山田 太郎');
  assert.strictEqual(me.managed, null);

  const s = call(env, { id: k.i, k: k.k, action: 'setup', candidates: ['ミエタスク-yamada'], version: '0.5.0', os: 'darwin/arm64' });
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(s.message, '招待しました');
  assert.strictEqual(cell(env, 'メンバー', 2, '投稿先'), s.channel);
  assert.strictEqual(env.slack.dms.U1.length, 0, '鍵の DM がセットアップ後に消えていない');

  const chk = call(env, { id: k.i, k: k.k, action: 'check' });
  assert.strictEqual(chk.channel.name, 'ミエタスク-yamada', '診断で投稿先を確かめられない: ' + JSON.stringify(chk.channel));
  const p = call(env, { id: k.i, k: k.k, action: 'post', channel: s.channel, parent: '親', replies: ['子1', '子2'], version: '0.5.0' });
  assert.ok(p.ok, JSON.stringify(p));
  const msgs = env.slack.channels[s.channel].messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[1].thread_ts, p.ts);
  assert.strictEqual(msgs[0].username, 'ミエタスク');
  assert.strictEqual(cell(env, 'メンバー', 2, '最後に動いた'), '2026-11-16T07:00:00+09:00');
});

test('投稿できるのは本人の投稿先だけ。Bot が入っているほかのチャンネルにも出せない', () => {
  const env = load();
  seed(env);
  const room = (id, name) => { env.slack.channels[id] = { name, members: new Set(['BOT', 'U1']), archived: false, private: true, messages: [] }; return id; };
  const pm1 = room('C801', 'pm1-team');
  const pd = room('C802', 'pd-team');
  const k = issue(env, 2); // U1 は pm1
  // 本人が入っているチャンネルでも出せない（各自の一覧には DM や非公開チャンネルの内容が入るため）
  const own = call(env, { id: k.i, k: k.k, action: 'post', channel: pm1, parent: 'まとめ' });
  assert.strictEqual(own.error, 'forbidden_channel');
  assert.strictEqual(env.slack.channels[pm1].messages.length, 0);
  const ng = call(env, { id: k.i, k: k.k, action: 'post', channel: pd, parent: '他チーム' });
  assert.strictEqual(ng.error, 'forbidden_channel');
  const ng2 = call(env, { id: k.i, k: k.k, action: 'post', channel: 'C999', parent: 'x' });
  assert.strictEqual(ng2.error, 'forbidden_channel');
});

test('鍵の確認：違う鍵・未登録・停止・無効化・作り直し', () => {
  const env = load();
  seed(env);
  const k = issue(env, 2);
  assert.strictEqual(call(env, { id: k.i, k: 'wrong', action: 'me' }).error, 'bad_key');
  assert.strictEqual(call(env, { id: 'UNOBODY', k: k.k, action: 'me' }).error, 'not_registered');
  assert.strictEqual(call(env, { id: 'U1', action: 'me' }).error, 'bad_key');

  // 作り直すと前の鍵は効かない
  const k2 = issue(env, 2);
  assert.strictEqual(call(env, { id: k.i, k: k.k, action: 'me' }).error, 'bad_key');
  assert.ok(call(env, { id: k2.i, k: k2.k, action: 'me' }).ok);

  // 停止にした瞬間から使えない
  setCell(env, 'メンバー', 2, '状態', '停止');
  assert.strictEqual(call(env, { id: k2.i, k: k2.k, action: 'me' }).error, 'stopped');
  setCell(env, 'メンバー', 2, '状態', '有効');

  // 無効にした鍵は使えない
  select(env, 'メンバー', 2);
  env.ctx.menuRevokeKey();
  assert.strictEqual(call(env, { id: k2.i, k: k2.k, action: 'me' }).error, 'bad_key');
  assert.ok(cell(env, 'メンバー', 2, '鍵').startsWith('無効'));
});

test('停止の人には鍵を発行しない', () => {
  const env = load();
  seed(env);
  setCell(env, 'メンバー', 5, '状態', '停止');
  select(env, 'メンバー', 5);
  env.ctx.menuIssueKey();
  assert.match(env.ui.alerts.pop(), /停止/);
  assert.ok(!('KEY_U9' in env.props));
});

test('管理者の画面：管理しているチームとその下のチームの人だけ見える', () => {
  const env = load();
  seed(env);
  const km = issue(env, 3); // UM は pm の管理者
  const me = call(env, { id: km.i, k: km.k, action: 'me' });
  assert.deepStrictEqual(me.managed.teams.map(t => t.id).sort(), ['pm', 'pm1', 'pm2']);
  assert.deepStrictEqual(me.managed.members.map(m => m.slack_id).sort(), ['U1', 'U9', 'UM']);
  // 一般メンバーには見えない
  const k1 = issue(env, 2);
  assert.strictEqual(call(env, { id: k1.i, k: k1.k, action: 'me' }).managed, null);
});

test('日々の状態：件数だけを受け取り、同じ日に2回届いたら上書きする', () => {
  const env = load();
  seed(env);
  const k = issue(env, 2); // U1
  const r = call(env, { id: k.i, k: k.k, action: 'status', version: '0.7.0',
    counts: { overdue: 5, today: '5', week: 23 },
    // 件数のほかは受け取らない
    title: '秘密の案件', memo: 'DMで聞いた話', parent: '一覧の全部' });
  assert.ok(r.ok, JSON.stringify(r));
  const sh = env.ss.getSheetByName('日々の状態');
  assert.strictEqual(sh.cells.length, 2, '1人1日1行になっていない');
  assert.strictEqual(cell(env, '日々の状態', 2, '日付'), '2026-11-16');
  assert.strictEqual(cell(env, '日々の状態', 2, '名前'), '山田 太郎');
  assert.deepStrictEqual(['超過', '今日', '今週'].map(h => cell(env, '日々の状態', 2, h)), [5, 5, 23]);
  const all = JSON.stringify(env.ss.sheets);
  for (const leak of ['秘密の案件', 'DMで聞いた話', '一覧の全部']) {
    assert.ok(!all.includes(leak), '件数のほかが台帳に残っている: ' + leak);
  }
  assert.strictEqual(cell(env, 'メンバー', 2, '最後に動いた'), '2026-11-16T07:00:00+09:00');
  assert.strictEqual(cell(env, 'メンバー', 2, 'バージョン'), '0.7.0');

  // 同じ日にもう一度：行は増えず上書き。壊れた値は0
  call(env, { id: k.i, k: k.k, action: 'status', counts: { overdue: 2, today: -1, week: 'たくさん' } });
  assert.strictEqual(sh.cells.length, 2);
  assert.deepStrictEqual(['超過', '今日', '今週'].map(h => cell(env, '日々の状態', 2, h)), [2, 0, 0]);
});

test('点検用の件数：チームの管理者には返さず、システム管理者にだけ全員分を返す', () => {
  const env = load();
  seed(env);
  const k1 = issue(env, 2); // U1（pm1）
  const k2 = issue(env, 4); // U2（pd）
  call(env, { id: k1.i, k: k1.k, action: 'status', counts: { overdue: 1, today: 2, week: 3 } });
  call(env, { id: k2.i, k: k2.k, action: 'status', counts: { overdue: 9, today: 9, week: 9 } });
  // 8日より前の行は返さない
  const sh = env.ss.getSheetByName('日々の状態');
  sh.appendRow(sh.cells[0].map(h => ({ '日付': '2026-11-08', 'Slack ID': 'U1', '名前': '山田 太郎', '超過': 7 })[h] ?? ''));

  // チームの管理者：担当チームの人は見えるが、件数は返らない（案件ごとに重さが違い、状態把握に使えないため）
  const km = issue(env, 3); // UM は pm の管理者
  const mgr = call(env, { id: km.i, k: km.k, action: 'me' }).managed;
  assert.deepStrictEqual(mgr.members.map(m => m.slack_id).sort(), ['U1', 'U9', 'UM']);
  assert.strictEqual(mgr.system_admin, false);
  assert.strictEqual(mgr.daily, undefined, 'チームの管理者に件数が返っている');

  // システム管理者：どのチームの管理者でもなくても、全チーム・全員と、直近8日の件数が見える。案件の要約は見えない
  call(env, { id: k1.i, k: k1.k, action: 'share', items: [{ name: '社内DX', state: '動いている' }] });
  const st = env.ss.getSheetByName('設定');
  setCell(env, 'メンバー', 4, 'ロール', 'システム管理者'); // U2
  const adm = call(env, { id: k2.i, k: k2.k, action: 'me' }).managed;
  assert.strictEqual(adm.system_admin, true);
  assert.deepStrictEqual(adm.teams.map(t => t.id).sort(), ['pd', 'pm', 'pm1', 'pm2']);
  assert.deepStrictEqual(adm.members.map(m => m.slack_id).sort(), ['U1', 'U2', 'U9', 'UM']);
  assert.deepStrictEqual(adm.daily.map(d => [d.slack_id, d.date, d.overdue]).sort(), [['U1', '2026-11-16', 1], ['U2', '2026-11-16', 9]]);
  assert.deepStrictEqual(adm.shared, [], 'システム管理者に案件の要約が返っている');
  assert.deepStrictEqual(call(env, { id: km.i, k: km.k, action: 'me' }).managed.shared.map(x => x.slack_id), ['U1']);

  // どちらでもない人には何も返らない
  assert.strictEqual(call(env, { id: k1.i, k: k1.k, action: 'me' }).managed, null);
});

test('投稿先：同じ名前が他人のものなら別の名前、本人のものなら使い回す', () => {
  const env = load();
  seed(env);
  const k1 = issue(env, 2);
  const s1 = call(env, { id: k1.i, k: k1.k, action: 'setup', candidates: ['ミエタスク-yamada', 'ミエタスク-taro-yamada'] });
  const k2 = issue(env, 4); // 別の人が同じ名字
  const s2 = call(env, { id: k2.i, k: k2.k, action: 'setup', candidates: ['ミエタスク-yamada', 'ミエタスク-jiro-yamada'] });
  assert.strictEqual(s2.name, 'ミエタスク-jiro-yamada');
  assert.notStrictEqual(s1.channel, s2.channel);
  // 投稿先の記録が消えた（途中で止まった等）あとでも、本人のチャンネルを使い回す
  setCell(env, 'メンバー', 2, '投稿先', '');
  const s3 = call(env, { id: k1.i, k: k1.k, action: 'setup', candidates: ['ミエタスク-yamada'] });
  assert.strictEqual(s3.channel, s1.channel);
  // 日本語が使えないワークスペースでは英字の候補に進む
  setCell(env, 'メンバー', 4, '投稿先', '');
  const s4 = call(env, { id: k2.i, k: k2.k, action: 'setup', candidates: ['ミエタスク 空白', 'mietask-jiro'] });
  assert.strictEqual(s4.name, 'mietask-jiro');
});

test('退職者の片付け：停止の人だけアーカイブでき、鍵も無効になる', () => {
  const env = load();
  seed(env);
  const k = issue(env, 5);
  const s = call(env, { id: k.i, k: k.k, action: 'setup', candidates: ['ミエタスク-taishoku'] });
  select(env, 'メンバー', 5);
  env.ctx.menuArchiveMember();
  assert.match(env.ui.alerts.pop(), /停止/);
  assert.strictEqual(env.slack.channels[s.channel].archived, false);
  setCell(env, 'メンバー', 5, '状態', '停止');
  env.ctx.menuArchiveMember();
  assert.strictEqual(env.slack.channels[s.channel].archived, true);
  assert.ok(!('KEY_U9' in env.props));
});

test('Botトークン：間違ったものは保存しない。メンバーには返さない', () => {
  const env = load();
  seed(env);
  env.ui.promptText = 'xoxp-user';
  env.ctx.menuSetBotToken();
  assert.match(env.ui.alerts.pop(), /xoxb-/);
  env.ui.promptText = 'xoxb-bad';
  env.ctx.menuSetBotToken();
  assert.match(env.ui.alerts.pop(), /拒否/);
  assert.strictEqual(env.props.SLACK_BOT_TOKEN, 'xoxb-good', '失敗したのに前のトークンが消えた');
  const k = issue(env, 2);
  const res = env.ctx.doPost({ postData: { contents: JSON.stringify({ id: k.i, k: k.k, action: 'check' }) } }).text;
  assert.ok(!res.includes('xoxb-'), '応答に Botトークンが含まれている');
});

test('Botトークンが無いときは分かるエラーを返す。DM を送れないときは管理者に鍵を見せる', () => {
  const env = load();
  seed(env);
  env.slack.dmFails = true;
  select(env, 'メンバー', 2);
  env.ctx.menuIssueKey();
  assert.strictEqual(env.ui.dialogs.length, 1);
  assert.match(env.ui.dialogs[0].html, /mietask2\./);
  const key = env.ui.dialogs[0].html.match(/(mietask2\.[A-Za-z0-9_-]+)/)[1];
  const k = JSON.parse(Buffer.from(key.slice(9), 'base64url').toString('utf8'));
  delete env.props.SLACK_BOT_TOKEN;
  assert.strictEqual(call(env, { id: k.i, k: k.k, action: 'check' }).error, 'no_bot_token');
});

test('レート制限のときは待ってやり直す。長すぎる本文は投稿しない', () => {
  const env = load();
  seed(env);
  const k = issue(env, 2);
  const s = call(env, { id: k.i, k: k.k, action: 'setup', candidates: ['ミエタスク-yamada'] });
  env.slack.rateLimitOnce = true;
  assert.ok(call(env, { id: k.i, k: k.k, action: 'post', channel: s.channel, parent: 'x' }).ok);
  const long = call(env, { id: k.i, k: k.k, action: 'post', channel: s.channel, parent: 'x'.repeat(4000) });
  assert.strictEqual(long.error, 'too_long');
});

test('中身は doGet では返さない。壊れた要求には分かるエラー', () => {
  const env = load();
  seed(env);
  assert.deepStrictEqual(JSON.parse(env.ctx.doGet().text), { ok: true, service: 'mietask', version: 2 });
  assert.strictEqual(JSON.parse(env.ctx.doPost({ postData: { contents: '{' } }).text).error, 'bad_request');
  const k = issue(env, 2);
  assert.strictEqual(call(env, { id: k.i, k: k.k, action: 'nope' }).error, 'unknown_action');
});

// ---------------------------------------------------------------- ダッシュボード（MTD の案件と、案件ごとの要約）

const NU = n => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`; // Notion のユーザーID
const ME = NU(2), OTHER = NU(99);

// 全社の下に pm・pd を置き、UD を pd の管理者、UE を役員、UA をシステム管理者にする。MTD に U2 の案件とタスクを入れる
function seedDash(env) {
  seed(env);
  const members = env.ss.getSheetByName('メンバー');
  const head = members.cells[0];
  const put = r => members.appendRow(head.map(h => r[h] ?? ''));
  members.cells[3][head.indexOf('Notion ユーザー')] = 'user://' + ME; // U2（pd）
  put({ '名前': 'ひも付けなし', 'Slack ID': 'U3', 'チーム': 'pd', '状態': '有効' });
  put({ '名前': 'MTDに無い人', 'Slack ID': 'U4', 'チーム': 'pd', '状態': '有効', 'Notion ユーザー': 'user://' + NU(4) });
  put({ '名前': '停止の人', 'Slack ID': 'U5', 'チーム': 'pd', '状態': '停止', 'Notion ユーザー': 'user://' + NU(5) });
  put({ '名前': '段 部長', 'Slack ID': 'UD', 'チーム': 'pd', 'ロール': '管理者', '状態': '有効', 'メール': 'dan@example.com' });
  put({ '名前': '役員 一郎', 'Slack ID': 'UE', 'チーム': 'all', 'ロール': '役員', '状態': '有効', 'メール': 'exec@example.com' });
  put({ '名前': 'システム 管理', 'Slack ID': 'UA', 'チーム': 'all', 'ロール': 'メンバー, システム管理者', '状態': '有効', 'メール': 'sys@example.com' });
  const emails = { U1: 'yamada@example.com', UM: 'kanri@example.com', U2: 'betsu@example.com', U4: 'nomtd@example.com', U5: 'stopped@example.com' };
  members.cells.forEach(r => { if (emails[r[1]]) r[head.indexOf('メール')] = emails[r[1]]; });
  const teams = env.ss.getSheetByName('チーム');
  const th = teams.cells[0];
  teams.appendRow(th.map(h => ({ 'チームID': 'all', '表示名': '全社' })[h] ?? ''));
  [1, 4].forEach(r => { teams.cells[r][th.indexOf('親チーム')] = 'all'; }); // pm・pd の親を全社に
  const st = env.ss.getSheetByName('設定');
  st.cells.forEach(r => {
    if (r[0] === 'notion_projects') r[1] = 'collection://proj';
    if (r[0] === 'notion_tasks') r[1] = 'collection://tasks';
  });
  env.props.NOTION_TOKEN = 'ntn_good';
  env.props.DASHBOARD_SECRET = 'dash-secret';
  env.notion.sources.proj = [
    project('b1000000-0000-0000-0000-000000000001', '26順天高1ゼミ', { cc: [ME], kind: 'ゼミ', start: '2026-04-01', end: '2027-03-31' }),
    project('b1000000-0000-0000-0000-000000000002', '26広島学院 高1 FW', { cc: [ME], kind: 'FW', start: '2026-09-01', end: '2026-11-20' }),
    project('b1000000-0000-0000-0000-000000000003', '大阪国際WS', { pm: [ME], kind: 'WS', start: '2026-10-01', end: '2026-12-04' }),
    project('b1000000-0000-0000-0000-000000000004', '都立大崎', { sp: [ME], kind: 'WS', first: '2026-10-01' }),
    project('b1000000-0000-0000-0000-000000000005', '1月開始WS', { cc: [ME], kind: 'WS', start: '2027-01-10', end: '2027-02-28' }),
    project('b1000000-0000-0000-0000-000000000006', '中止した案件', { cc: [ME], kind: 'WS', status: '中止', start: '2026-10-01', end: '2027-01-01' }),
    project('b1000000-0000-0000-0000-000000000007', '昔の案件', { cc: [ME], kind: 'WS', status: '完了', start: '2025-01-01', end: '2025-03-01' }),
    project('b1000000-0000-0000-0000-000000000008', 'リードだけの案件', { lead: [ME], kind: 'WS', start: '2026-04-01', end: '2027-03-31' }),
    project('b1000000-0000-0000-0000-000000000009', '他人の案件', { cc: [OTHER], kind: 'WS', start: '2026-04-01', end: '2027-03-31' }),
    project('b1000000-0000-0000-0000-00000000000a', '26洗足FW', { cc: [ME], kind: 'FW', start: '2026-04-01', end: '2026-05-29' }),
  ];
  const P = n => `b1000000-0000-0000-0000-00000000000${n}`;
  env.notion.sources.tasks = [
    task('t1', '2学期ワークシート最終化', { who: [ME], status: '進行中', projects: [P(1)] }),
    task('t2', '中間プレゼン②スライド', { who: [ME], status: '確認待ち', projects: [P(1)] }),
    task('t3', '講師コンテンツ', { who: [ME], status: '継続', projects: [P(1)] }),
    task('t4', '動画修正', { who: [ME], status: '進行中' }),
    task('t5', 'ワークシート作成', { who: [ME], status: '進行中', projects: [P(9)] }),
    task('t6', '終わったタスク', { who: [ME], status: '完了', projects: [P(1)] }),
    task('t7', 'まだのタスク', { who: [ME], status: '未着手', projects: [P(2)] }),
    task('t8', '他人のタスク', { who: [OTHER], status: '進行中', projects: [P(1)] }),
    task('t9', '当日ワークシート作成', { who: [ME], status: '進行中', projects: [P('a')] }), // 期間が過ぎても閉じられていない
    task('t10', '動画修正', { who: [ME], status: '進行中' }), // 同じ名前は1つにまとめる
  ];
}


function dash(env, email, secret = 'dash-secret') {
  return call(env, { action: 'dashboard', secret, email });
}

const cardOf = (v, id) => v.cards[id];

test('ダッシュボード：メンバーは自分の分だけ。案件を出どころで分けず、気にすべきものから並べる', () => {
  const env = load();
  seedDash(env);
  const v = dash(env, 'Betsu@Example.com '); // 大文字・空白があっても同じ人
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepStrictEqual(v.viewer, { name: '別チーム', email: 'betsu@example.com' });
  assert.strictEqual(v.self, 'U2');
  assert.deepStrictEqual(v.teams, []);
  assert.strictEqual(v.admin, false);
  assert.ok(!('health' in v));
  assert.deepStrictEqual(Object.keys(v.cards), ['U2'], 'ほかの人の分が入っている');
  const c = cardOf(v, 'U2');
  assert.strictEqual(c.count, '今の案件 6件、これから始まる 1件');
  assert.strictEqual(c.notes, 'ミエタスク未着');
  assert.deepStrictEqual(c.items.map(i => [i.name, i.rank, i.long]), [
    ['26順天高1ゼミ', 1, 'CC・確認待ちあり（〜3/31）'],
    ['26広島学院 高1 FW', 2, 'CC（〜11/20）'],
    ['大阪国際WS', 2, 'PM（〜12/4）'],
    ['リードだけの案件', 2, 'リード（〜3/31）'],
    ['都立大崎', 2, 'SP（10/1〜）'],
    ['他人の案件', 3, '担当外・タスク1件'],
    ['1月開始WS', 4, 'CC・これから（1/10〜）'],
  ]);
  // 中止・終わった・期間が過ぎた案件と、タスクの題名は返さない
  const text = JSON.stringify(v);
  assert.ok(!/中止した案件|昔の案件|26洗足FW|ワークシート|動画修正|講師コンテンツ|スライド/.test(text), text);
  // Notion にはバージョンを付けて問い合わせ、担当は CC・PM・SP・リード・連携で引く
  assert.ok(env.notion.calls.length > 0 && env.notion.calls.every(c => c.version === '2025-09-03'));
  const q = env.notion.calls.find(c => c.path === 'data_sources/proj/query');
  assert.deepStrictEqual(q.body.filter.or.map(f => f.property), ['CC担当', 'PM担当', 'SP担当', 'プロジェクトリード', '連携メンバー']);
});

test('ダッシュボード：ロールで見える範囲が決まる。管理者は自分のチームとその下、役員は全員。横のチームは見えない', () => {
  const env = load();
  seedDash(env);
  const d = dash(env, 'dan@example.com'); // pd の管理者
  assert.deepStrictEqual(d.teams.map(t => [t.id, t.members]), [['pd', ['U2', 'U3', 'U4', 'UD']]]);
  assert.deepStrictEqual(Object.keys(d.cards).sort(), ['U2', 'U3', 'U4', 'UD'], '停止の人・pm の人が入っている');
  assert.strictEqual(d.admin, false);

  const m = dash(env, 'kanri@example.com'); // pm の管理者（下に pm1・pm2）
  assert.deepStrictEqual(m.teams.map(t => [t.id, t.members.sort()]), [['pm', ['U1', 'U9', 'UM']], ['pm1', ['U1']], ['pm2', ['U9']]]);
  assert.ok(!('U2' in m.cards));

  const e = dash(env, 'exec@example.com'); // 役員（一番上のチームから全部）
  assert.deepStrictEqual(e.teams.map(t => t.id), ['all', 'pm', 'pm1', 'pm2', 'pd']);
  assert.deepStrictEqual(e.teams[0].members.sort(), ['U1', 'U2', 'U3', 'U4', 'U9', 'UA', 'UD', 'UE', 'UM']);
  assert.strictEqual(e.cards.U3.notes, 'MTD未連携（システム管理者が対応）・ミエタスク未着');

  // ロールが無ければ（チームに属していても）自分の分だけ。ロールを外せば、その時点から見えなくなる
  setCell(env, 'メンバー', 9, 'ロール', '');
  const gone = dash(env, 'dan@example.com');
  assert.deepStrictEqual([gone.teams, Object.keys(gone.cards)], [[], ['UD']]);
  // 部門長：部門（親チーム）の管理者にすると、下のチームもタブになる
  setCell(env, 'メンバー', 9, 'ロール', '管理者');
  setCell(env, 'メンバー', 9, 'チーム', 'all');
  assert.deepStrictEqual(dash(env, 'dan@example.com').teams.map(t => t.id), ['all', 'pm', 'pm1', 'pm2', 'pd']);
});

test('ダッシュボード：システム管理者は別のページで全員の動作状況だけ。案件の中身は見えない', () => {
  const env = load();
  seedDash(env);
  const k = issue(env, 4); // U2
  call(env, { id: k.i, k: k.k, action: 'status', counts: { overdue: 1, today: 2, week: 3 }, version: '0.9.0' });
  call(env, { id: k.i, k: k.k, action: 'share', items: [{ name: '社内DX', state: '相手待ち' }] });
  const v = dash(env, 'sys@example.com');
  assert.deepStrictEqual([v.teams, Object.keys(v.cards), v.admin], [[], ['UA'], true], 'システム管理者に他人の案件が見えている');
  const h = call(env, { action: 'dashboard', secret: 'dash-secret', email: 'sys@example.com', view: 'health' });
  assert.ok(h.ok && !h.forbidden, JSON.stringify(h));
  const u2 = h.health.find(x => x.name === '別チーム');
  assert.deepStrictEqual(u2.counts, { date: '2026-11-16', overdue: 1, today: 2, week: 3 });
  assert.deepStrictEqual([u2.share_date, u2.version, u2.roles], ['2026-11-16', '0.9.0', ['メンバー']]);
  assert.ok(h.health.some(x => x.status === '停止'), '停止の人も動作状況には出す');
  assert.ok(!JSON.stringify(h).includes('社内DX'), '案件の中身が動作状況に入っている');
  // 台帳の書き方の誤りを出す
  setCell(env, 'メンバー', 2, 'ロール', 'リーダー');
  setCell(env, 'メンバー', 2, 'チーム', 'pm9');
  const y = call(env, { action: 'dashboard', secret: 'dash-secret', email: 'sys@example.com', view: 'health' }).health.find(x => x.name === '山田 太郎');
  assert.deepStrictEqual(y.issues, ['ロール「リーダー」は使えません', 'チーム「pm9」が「チーム」シートにありません']);
  // システム管理者でない人には動作状況を返さない（役員でも）
  for (const email of ['betsu@example.com', 'exec@example.com']) {
    const ng = call(env, { action: 'dashboard', secret: 'dash-secret', email, view: 'health' });
    assert.ok(ng.forbidden && !('health' in ng), email);
  }
});

test('ロールへの移しかえ：以前の管理者列と system_admins から、ロールが空の人にだけ入れる', () => {
  const env = load();
  seed(env);
  const teams = env.ss.getSheetByName('チーム');
  teams.cells[0].push('管理者');
  teams.cells.slice(1).forEach(r => r.push(''));
  teams.cells[4][teams.cells[0].indexOf('管理者')] = 'U2, UX'; // pd（U2 は pd の人。UX は台帳にいない）
  teams.cells[2][teams.cells[0].indexOf('管理者')] = 'U1'; // pm1（U1 は pm1）
  teams.cells[1][teams.cells[0].indexOf('管理者')] = 'U1'; // pm（U1 は pm に入っていない）
  env.ss.getSheetByName('設定').appendRow(['system_admins', 'U9']);
  setCell(env, 'メンバー', 3, 'ロール', '管理者'); // UM は入っているのでそのまま
  env.ui.alerts.length = 0;
  env.ctx.menuSetupSheets();
  const msg = env.ui.alerts.pop();
  assert.deepStrictEqual([2, 3, 4, 5].map(r => cell(env, 'メンバー', r, 'ロール')), ['管理者', '管理者', '管理者', 'システム管理者']);
  assert.match(msg, /山田 太郎：管理していた pm が「チーム」に入っていません/);
  assert.match(msg, /UX：「メンバー」に行がありません/);
  // もう一度押しても変わらない
  env.ctx.menuSetupSheets();
  assert.ok(!/山田 太郎/.test(env.ui.alerts.pop()));
});

test('ダッシュボード：合言葉が違えば断る。台帳に無い人・停止の人には何も返さない', () => {
  const env = load();
  seedDash(env);
  assert.strictEqual(dash(env, 'betsu@example.com', 'wrong').error, 'bad_secret');
  assert.strictEqual(dash(env, '', 'dash-secret').error, 'bad_request');
  assert.deepStrictEqual(dash(env, 'nobody@example.com'), { ok: true, viewer: null, today: '2026-11-16' });
  assert.strictEqual(dash(env, 'stopped@example.com').viewer, null);
  delete env.props.DASHBOARD_SECRET;
  assert.strictEqual(dash(env, 'betsu@example.com', '').error, 'no_dashboard');
  // メンバーの鍵では呼べない（合言葉の代わりにはならない）
  const k = issue(env, 4);
  assert.strictEqual(call(env, { id: k.i, k: k.k, action: 'dashboard', email: 'exec@example.com' }).error, 'no_dashboard');
});

test('ダッシュボード：MTD を読めなければ、同じ理由の人を1行にまとめてページに出す。読めた分は覚えておく', () => {
  const env = load();
  seedDash(env);
  delete env.props.NOTION_TOKEN;
  const e = dash(env, 'exec@example.com');
  assert.strictEqual(e.problems.length, 1, JSON.stringify(e.problems));
  assert.match(e.problems[0], /^MTD を読めませんでした（Notion の鍵が設定されていません.*）：/);
  assert.match(e.problems[0], /別チーム/);
  assert.strictEqual(Object.keys(env.cache).filter(k => /U2/.test(k)).length, 0, '読めなかった分を覚えている');
  env.props.NOTION_TOKEN = 'ntn_good';
  const before = env.notion.calls.length;
  assert.deepStrictEqual(dash(env, 'betsu@example.com').problems, []);
  const after = env.notion.calls.length;
  assert.ok(after > before);
  dash(env, 'dan@example.com');
  assert.strictEqual(env.notion.calls.filter((c, i) => i >= after && /U2|00002/.test(JSON.stringify(c.body))).length, 0, '同じ日に同じ人を読み直した');
});

test('ダッシュボード：ページが分かれていても全部読む', () => {
  const env = load();
  seedDash(env);
  for (let i = 0; i < 130; i++) {
    env.notion.sources.proj.push(project(`b2000000-0000-0000-0000-${String(i).padStart(12, '0')}`, 'ゼミ' + i, { cc: [ME], kind: 'ゼミ', start: '2026-04-01', end: '2027-03-31' }));
  }
  assert.strictEqual(dash(env, 'betsu@example.com').cards.U2.count, '今の案件 136件、これから始まる 1件');
  assert.ok(env.notion.calls.some(c => c.path === 'data_sources/proj/query' && c.body.start_cursor === '100'), '2ページ目を読んでいない');
});

test('ダッシュボード：担当案件が無くても、担当外の案件で動いていればその案件を出す。名前を読めない案件は1つにまとめる', () => {
  const env = load();
  seedDash(env);
  env.notion.sources.proj = env.notion.sources.proj.filter(p => ['CC担当', 'PM担当', 'SP担当', 'プロジェクトリード']
    .every(k => p.properties[k].people.every(u => u.id !== ME)));
  assert.deepStrictEqual(dash(env, 'betsu@example.com').cards.U2.items.map(i => [i.name, i.short]),
    [['他人の案件', '担当外'], ['名前を読めない案件', '担当外・2件']]);
});

test('案件の要約：決まった形だけを受け取り、ダッシュボードで MTD の案件と1つの並びにする。本人の題名やリンクは受け取らない', () => {
  const env = load();
  seedDash(env);
  const k2 = issue(env, 4); // U2（MTDに案件あり）
  const k4 = issue(env, 7); // U4（MTDに何もない）
  // 決まった形でないものは断る
  const bad = [
    [{ name: 'https://example.com の件', state: '動いている' }],
    [{ name: '山田さん <@U123> から', state: '動いている' }],
    [{ name: 'a@example.com への返信', state: '動いている' }],
    [{ name: '改行\nあり', state: '動いている' }],
    [{ name: 'ミエマス', state: '忙しい' }],
    [{ name: 'ミエマス', state: '動いている', due: '11/20' }],
    Array.from({ length: 21 }, (_, i) => ({ name: '案件' + i, state: '動いている' })),
    [{ name: 'ミエマス', state: '動いている', open: -1 }],
    [{ name: 'ミエマス', state: '動いている', open: 1.5 }],
    [{ name: 'ミエマス', state: '動いている', open: 1000 }],
    [{ name: 'ミエマス', state: '動いている', open: 'たくさん' }],
    [{ name: 'ミエマス', state: '期限が過ぎたものあり', open: 1, overdue: 2 }],
  ];
  for (const items of bad) assert.strictEqual(call(env, { id: k4.i, k: k4.k, action: 'share', items }).error, 'bad_share', JSON.stringify(items));
  // 決まった項目のほか（題名・メモ・出どころ）は送られてきても残さない
  const r = call(env, { id: k2.i, k: k2.k, action: 'share', items: [
    { name: 'ミエマス（ポータル・MTD）', state: '動いている', due: '2026-11-20', title: '秘密の題名', source: 'DM' },
    { name: '社内DX', state: '相手待ち' },
    { name: 'TiB講義スライド', state: '期限が過ぎたものあり' },
    { name: '採用', state: '動いている' },
  ] });
  assert.ok(r.ok, JSON.stringify(r));
  const sheet = env.ss.getSheetByName('案件の要約');
  assert.ok(!JSON.stringify(sheet.cells).includes('秘密の題名'));
  // 前の日の要約しか無い人は「届いていない」と書く（空いているとは書かない）
  sheet.appendRow(sheet.cells[0].map(h => ({ '日付': '2026-11-13', 'Slack ID': 'U4', '名前': 'MTDに無い人', '要約': '[]', '届いた時刻': '2026-11-13T07:00:00+09:00' })[h] ?? ''));

  const v = dash(env, 'dan@example.com');
  const c2 = v.cards.U2;
  assert.strictEqual(c2.count, '今の案件 10件、これから始まる 1件');
  assert.strictEqual(c2.notes, '');
  assert.strictEqual(c2.share_at, '2026-11-16T07:00:00+09:00');
  assert.deepStrictEqual(c2.items.map(i => i.name + ' — ' + i.long), [
    'TiB講義スライド — 期限が過ぎたものあり',
    '26順天高1ゼミ — CC・確認待ちあり（〜3/31）',
    '社内DX — 相手待ち',
    'ミエマス（ポータル・MTD） — 動いている（次の期限 11/20）',
    '26広島学院 高1 FW — CC（〜11/20）',
    '大阪国際WS — PM（〜12/4）',
    'リードだけの案件 — リード（〜3/31）',
    '採用 — 動いている',
    '都立大崎 — SP（10/1〜）',
    '他人の案件 — 担当外・タスク1件',
    '1月開始WS — CC・これから（1/10〜）',
  ]);
  assert.strictEqual(c2.items[3].short, '期限11/20');
  assert.deepStrictEqual(v.cards.U4, { slack_id: 'U4', name: 'MTDに無い人', teams: ['pd'], count: '見える案件なし', items: [], notes: 'ミエタスクは11/13から未着', share_at: '' });

  // 管理者の画面（team-sheet）にも、担当チームの人の要約が返る
  const k = issue(env, 9); // UD（pd の管理者）
  const mgr = call(env, { id: k.i, k: k.k, action: 'me' }).managed;
  assert.deepStrictEqual(mgr.shared.map(x => [x.slack_id, x.date, x.items.length]).sort(), [['U2', '2026-11-16', 4], ['U4', '2026-11-13', 0]]);
});

test('以前の毎朝のまとめのトリガーが残っていたら、動いたときに自分を消す。Slack には何も出さない', () => {
  const env = load();
  seedDash(env);
  env.ctx.ScriptApp.newTrigger('dailyRollup').timeBased().everyDays(1).atHour(9).inTimezone('Asia/Tokyo').create();
  const before = Object.values(env.slack.channels).reduce((n, c) => n + c.messages.length, 0);
  env.ctx.dailyRollup();
  assert.strictEqual(env.triggers.length, 0);
  assert.strictEqual(Object.values(env.slack.channels).reduce((n, c) => n + c.messages.length, 0), before);
  assert.deepStrictEqual(env.slack.dms, {});
});

test('ダッシュボードの合言葉：relay_url が無ければ作らない。作り直しは確かめてから', () => {
  const env = load();
  seedDash(env);
  delete env.props.DASHBOARD_SECRET;
  env.ss.getSheetByName('設定').cells.forEach(r => { if (r[0] === 'relay_url') r[1] = ''; });
  env.ctx.menuMakeDashboardSecret();
  assert.match(env.ui.alerts.pop(), /relay_url が空/);
  assert.ok(!('DASHBOARD_SECRET' in env.props));
  env.ss.getSheetByName('設定').cells.forEach(r => { if (r[0] === 'relay_url') r[1] = 'https://script.google.com/macros/s/X/exec'; });
  env.ctx.menuMakeDashboardSecret();
  const msg = env.ui.alerts.pop();
  const first = env.props.DASHBOARD_SECRET;
  assert.ok(/^[0-9a-f]{64}$/.test(first));
  assert.ok(msg.includes('RELAY_URL: https://script.google.com/macros/s/X/exec') && msg.includes('DASHBOARD_SECRET: ' + first));
  env.ui.promptText = 'はい';
  env.ctx.menuMakeDashboardSecret();
  assert.strictEqual(env.props.DASHBOARD_SECRET, first, '確かめずに作り直した');
  env.ui.promptText = '作り直す';
  env.ctx.menuMakeDashboardSecret();
  assert.notStrictEqual(env.props.DASHBOARD_SECRET, first);
});

test('Notionの鍵：MTD を読めない鍵は保存しない', () => {
  const env = load();
  seedDash(env);
  delete env.props.NOTION_TOKEN;
  env.ui.promptText = 'xoxb-wrong';
  env.ctx.menuSetNotionToken();
  assert.match(env.ui.alerts.pop(), /ntn_/);
  env.ui.promptText = 'ntn_bad';
  env.ctx.menuSetNotionToken();
  assert.match(env.ui.alerts.pop(), /401[\s\S]*保存していません/);
  assert.ok(!('NOTION_TOKEN' in env.props));

  env.notion.denied.add('tasks'); // タスクDBにインテグレーションを接続し忘れた
  env.ui.promptText = 'ntn_good';
  env.ctx.menuSetNotionToken();
  assert.match(env.ui.alerts.pop(), /タスクDBを読めません.*接続.*保存していません/);
  assert.ok(!('NOTION_TOKEN' in env.props));

  env.notion.denied.clear();
  env.ctx.menuSetNotionToken();
  assert.match(env.ui.alerts.pop(), /保存しました/);
  assert.strictEqual(env.props.NOTION_TOKEN, 'ntn_good');
});

// ---------------------------------------------------------------- ダッシュボードのページ（admin/dashboard）

// ページの Apps Script を読み込み、窓口への問い合わせはこのテストの窓口（env）に渡す
function loadDashboard(env, { email = '', props = { RELAY_URL: 'https://relay.example/exec', DASHBOARD_SECRET: 'dash-secret' } } = {}) {
  const sent = [];
  const ctx = {
    console,
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://dash.example/exec' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        sent.push({ url, body: JSON.parse(opts.payload) });
        const out = env.ctx.doPost({ postData: { contents: opts.payload } }).text;
        return { getResponseCode: () => 200, getContentText: () => out };
      },
    },
    HtmlService: {
      createHtmlOutput: html => {
        const o = { html, title: '', setTitle(t) { o.title = t; return o; }, addMetaTag() { return o; } };
        return o;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'dashboard.gs'), 'utf8'), ctx);
  return { page: (parameter = {}) => ctx.doGet({ parameter }).html, sent, ctx };
}

const tabsOf = html => [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map(m => m[1]);

test('ダッシュボードのページ：メンバーは自分の分だけ。役員はチームのタブ。動作状況はシステム管理者だけの別ページ', () => {
  const env = load();
  seedDash(env);
  // MTD の案件名は自由に書けるので、そのまま HTML に入れない
  env.notion.sources.proj.push(project('b1000000-0000-0000-0000-0000000000ff', '<img src=x onerror=alert(1)>案件', { cc: [ME], start: '2026-04-01', end: '2027-03-31' }));

  const mem = loadDashboard(env, { email: 'betsu@example.com' });
  const h = mem.page();
  assert.deepStrictEqual(mem.sent.map(s => [s.url, s.body]), [['https://relay.example/exec', { action: 'dashboard', secret: 'dash-secret', email: 'betsu@example.com', view: '', change: null }]]);
  assert.deepStrictEqual(tabsOf(h), ['案件', '自分']);
  assert.ok(h.includes('<h3>別チーム</h3>') && h.includes('26順天高1ゼミ') && h.includes('今の案件 7件、これから始まる 1件'), h);
  assert.ok(!h.includes('<img src=x') && h.includes('&lt;img src=x onerror=alert(1)&gt;案件'), '案件名を escape していない');
  assert.ok(!/段 部長|山田 太郎|動作状況/.test(h));

  const ex = loadDashboard(env, { email: 'exec@example.com' }).page();
  assert.deepStrictEqual(tabsOf(ex), ['案件', '全社', 'PM', 'PM1', 'PM2', 'PD', '自分']);
  assert.ok(ex.includes('9人・気にすべきものがある人 1人'), ex.match(/<div class="bar">.*?<\/div>/)[0]);
  assert.ok(!ex.includes('件数（点検用）'));

  assert.ok(!ex.includes('?view=health'), '役員に動作状況の入口が出ている');

  const sys = loadDashboard(env, { email: 'sys@example.com' });
  const top = sys.page();
  assert.deepStrictEqual(tabsOf(top), ['案件', '自分']);

  assert.ok(top.includes('href="https://dash.example/exec?view=health" target="_top"'), '動作状況への入口が無い');
  const hp = sys.page({ view: 'health' });
  assert.ok(hp.includes('ミエタスク 動作状況') && hp.includes('件数（点検用）') && hp.includes('メンバー, システム管理者'), hp);
  assert.ok(!hp.includes('26順天高1ゼミ'), '動作状況に案件の中身が出ている');
  assert.deepStrictEqual(sys.sent.map(x => x.body.view), ['', 'health']);
  // システム管理者でなければ、URL を直に開いても見えない
  const no = loadDashboard(env, { email: 'exec@example.com' }).page({ view: 'health' });
  assert.match(no, /システム管理者だけが見られます/);
  assert.ok(!no.includes('件数（点検用）'));

  // ページの中の JavaScript が壊れていない
  const js = ex.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(js));
});

test('ダッシュボードのページ：開けないときは、理由を書いたページを出す', () => {
  const env = load();
  seedDash(env);
  assert.match(loadDashboard(env, { email: '' }).page(), /社内の Google アカウントで開いてください/);
  assert.match(loadDashboard(env, { email: 'nobody@example.com' }).page(), /見る権限がありません[\s\S]*nobody@example.com/);
  assert.match(loadDashboard(env, { email: 'betsu@example.com', props: {} }).page(), /読み込めませんでした[\s\S]*RELAY_URL/);
  const bad = loadDashboard(env, { email: 'betsu@example.com', props: { RELAY_URL: 'https://relay.example/exec', DASHBOARD_SECRET: 'x' } }).page();
  assert.match(bad, /窓口が断りました: ダッシュボードの合言葉が違います/);
  assert.ok(!bad.includes('26順天高1ゼミ'));
});

// ---------------------------------------------------------------- 台帳の変更（システム管理者がページから）

function change(env, email, c) {
  return call(env, { action: 'dashboard', secret: 'dash-secret', email, view: 'health', change: c });
}

const memberRow = (env, sid) => env.ss.getSheetByName('メンバー').cells.findIndex(r => r[1] === sid) + 1;

test('台帳の変更：システム管理者はメンバーのチーム・ロール・状態・メールを変えられ、変更の記録に残る', () => {
  const env = load();
  seedDash(env);
  const r1 = memberRow(env, 'U1');
  const res = change(env, 'sys@example.com', { kind: 'member', slack_id: 'U1',
    set: { teams: ['PM1', 'pd'], roles: ['メンバー', '管理者'], status: '有効', email: 'Yamada2@Example.com' },
    base: { teams: ['pm1'], roles: ['メンバー'], status: '有効', email: 'yamada@example.com' } });
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.changed, 3);
  assert.deepStrictEqual(['チーム', 'ロール', 'メール'].map(h => cell(env, 'メンバー', r1, h)), ['pm1, pd', '管理者', 'yamada2@example.com']);
  assert.deepStrictEqual(res.log.map(l => [l['変えた人'], l['対象'], l['項目'], l['前'], l['後']]), [
    ['システム 管理（sys@example.com）', '山田 太郎（U1）', 'チーム', 'pm1', 'pm1, pd'],
    ['システム 管理（sys@example.com）', '山田 太郎（U1）', 'ロール', '', '管理者'],
    ['システム 管理（sys@example.com）', '山田 太郎（U1）', 'メール', 'yamada@example.com', 'yamada2@example.com'],
  ].reverse());
  // 変えた時点から、見える範囲が変わる
  assert.deepStrictEqual(dash(env, 'yamada2@example.com').teams.map(t => t.id), ['pm1', 'pd']);
  assert.strictEqual(dash(env, 'yamada@example.com').viewer, null);
});

test('台帳の変更：ページを開いたあとにシートが直されていたら上書きしない。決まった形でないものは書かない', () => {
  const env = load();
  seedDash(env);
  const r1 = memberRow(env, 'U1');
  const before = JSON.stringify(env.ss.getSheetByName('メンバー').cells);
  const base = { teams: ['pm1'], roles: [], status: '有効', email: 'yamada@example.com' };
  setCell(env, 'メンバー', r1, 'チーム', 'pm2'); // 誰かがシートを直した
  const stale = change(env, 'sys@example.com', { kind: 'member', slack_id: 'U1', set: { teams: ['pd'] }, base });
  assert.strictEqual(stale.error, 'conflict');
  assert.strictEqual(cell(env, 'メンバー', r1, 'チーム'), 'pm2');
  setCell(env, 'メンバー', r1, 'チーム', 'pm1');
  const bad = [
    [{ teams: ['pm9'] }, /pm9.*ありません/],
    [{ roles: ['リーダー'] }, /リーダー.*使えません/],
    [{ status: '休職' }, /有効.*停止/],
    [{ email: '=HYPERLINK("x")@a.b' }, /先頭/],
    [{ email: 'not-mail' }, /メールの形/],
    [{ email: 'betsu@example.com' }, /別チーム さんが使っています/],
    [{ name: '山田' }, /変えられない項目/],
  ];
  for (const [set, why] of bad) {
    const r = change(env, 'sys@example.com', { kind: 'member', slack_id: 'U1', set, base });
    assert.strictEqual(r.error, 'bad_change', JSON.stringify(set));
    assert.match(r.message, why);
  }
  assert.strictEqual(change(env, 'sys@example.com', { kind: 'member', slack_id: 'UX', set: {}, base: {} }).error, 'bad_change');
  assert.strictEqual(JSON.stringify(env.ss.getSheetByName('メンバー').cells), before);
  assert.ok(!env.ss.getSheetByName('変更の記録') || env.ss.getSheetByName('変更の記録').cells.length === 1);
});

test('台帳の変更：システム管理者が1人もいなくなる変更は断る。システム管理者でなければ何も変えられない', () => {
  const env = load();
  seedDash(env);
  const rA = memberRow(env, 'UA');
  const base = { roles: ['メンバー', 'システム管理者'], status: '有効' };
  assert.match(change(env, 'sys@example.com', { kind: 'member', slack_id: 'UA', set: { roles: ['メンバー'] }, base }).message, /1人もいなくなる/);
  assert.match(change(env, 'sys@example.com', { kind: 'member', slack_id: 'UA', set: { status: '停止' }, base }).message, /1人もいなくなる/);
  // 役員でも、システム管理者でなければ変えられない（自分をシステム管理者にすることもできない）
  const ng = change(env, 'exec@example.com', { kind: 'member', slack_id: 'UE', set: { roles: ['役員', 'システム管理者'] }, base: { roles: ['役員'] } });
  assert.strictEqual(ng.error, 'forbidden');
  assert.strictEqual(cell(env, 'メンバー', memberRow(env, 'UE'), 'ロール'), '役員');
  // ほかの人をシステム管理者にしてからなら、自分を外せる
  assert.ok(change(env, 'sys@example.com', { kind: 'member', slack_id: 'UE', set: { roles: ['役員', 'システム管理者'] }, base: { roles: ['役員'] } }).ok);
  assert.ok(change(env, 'sys@example.com', { kind: 'member', slack_id: 'UA', set: { roles: [] }, base }).ok);
  assert.strictEqual(cell(env, 'メンバー', rA, 'ロール'), '');
});

test('台帳の変更：チームを足し、表示名と親チームを変えられる。輪になる親・無いチームは断る', () => {
  const env = load();
  seedDash(env);
  assert.ok(change(env, 'sys@example.com', { kind: 'add_team', id: 'pm3', name: 'PM3', parent: 'PM' }).ok);
  assert.deepStrictEqual(env.ss.getSheetByName('チーム').cells.slice(-1)[0].slice(0, 3), ['pm3', 'PM3', 'pm']);
  for (const [c, why] of [
    [{ kind: 'add_team', id: 'PM3' }, /もうあります/],
    [{ kind: 'add_team', id: 'pm 4' }, /英数字/],
    [{ kind: 'add_team', id: 'pm4', name: '+cmd' }, /先頭/],
    [{ kind: 'add_team', id: 'pm4', parent: 'zz' }, /zz.*ありません/],
    [{ kind: 'team', id: 'pm', set: { parent: 'pm1' }, base: { parent: 'all' } }, /自分か自分の下/],
    [{ kind: 'team', id: 'pm', set: { parent: 'pm' }, base: { parent: 'all' } }, /自分か自分の下/],
    [{ kind: 'team', id: 'nope', set: { name: 'x' }, base: { name: '' } }, /ありません/],
  ]) {
    const r = change(env, 'sys@example.com', c);
    assert.strictEqual(r.error, 'bad_change', JSON.stringify(c));
    assert.match(r.message, why);
  }
  const r = change(env, 'sys@example.com', { kind: 'team', id: 'pd', set: { name: '企画開発', parent: '' }, base: { name: 'PD', parent: 'all' } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.teams.find(t => t.id === 'pd'), { id: 'pd', name: '企画開発', parent: '' });
  // pd は全社の下から外れたので、役員には一番上のチームとして出る（並びは「チーム」シートの順）
  assert.deepStrictEqual(dash(env, 'exec@example.com').teams.map(t => t.id), ['pd', 'all', 'pm', 'pm1', 'pm2', 'pm3']);
  assert.strictEqual(change(env, 'sys@example.com', { kind: 'team', id: 'pd', set: { name: 'x' }, base: { name: 'PD' } }).error, 'conflict');
});

test('台帳の変更：ページの保存から窓口まで通る。表を作り直した HTML を返し、データの中で script を閉じさせない', () => {
  const env = load();
  seedDash(env);
  const sys = loadDashboard(env, { email: 'sys@example.com' });
  const html = sys.ctx.saveChange({ kind: 'add_team', id: 'x1', name: '</script><script>alert(1)</script>' });
  assert.ok(html.includes('<td>x1</td>') && html.includes('id="admin-data"'), html);
  const data = html.match(/<script type="application\/json" id="admin-data">([\s\S]*?)<\/script>/)[1];
  assert.ok(!data.includes('<'), 'データの中に < がそのまま入っている');
  assert.strictEqual(JSON.parse(data).teams.find(t => t.id === 'x1').name, '</script><script>alert(1)</script>');
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  // 編集画面の JavaScript が壊れていない
  const page = sys.page({ view: 'health' });
  assert.ok(page.includes('<dialog id="edit">'));
  for (const m of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]));
  // システム管理者でなければ、保存は断られる
  const ex = loadDashboard(env, { email: 'exec@example.com' });
  assert.throws(() => ex.ctx.saveChange({ kind: 'add_team', id: 'x2' }), /システム管理者だけ/);
  assert.throws(() => loadDashboard(env, { email: '' }).ctx.saveChange({ kind: 'add_team', id: 'x3' }), /Google アカウント/);
  assert.ok(!env.ss.getSheetByName('チーム').cells.some(r => r[0] === 'x2' || r[0] === 'x3'));
});

// ---------------------------------------------------------------- 案件ごとの並び

const NU4 = NU(4);

// 案件ごとの並びの試し：MTD の案件「渋谷区WS」（U2 が PM・U4 が CC・台帳にいない人が連携）と、各自の要約
function seedProjects(env) {
  seedDash(env);
  env.notion.sources.proj.push(project('b1000000-0000-0000-0000-0000000000b1', '渋谷区WS', { pm: [ME], cc: [NU4], collab: [OTHER], kind: 'WS', start: '2026-10-01', end: '2026-12-31' }));
  const share = (row, items) => {
    const k = issue(env, row);
    const r = call(env, { id: k.i, k: k.k, action: 'share', items });
    assert.ok(r.ok, JSON.stringify(r));
    return k;
  };
  return {
    U2: share(4, [
      { name: '渋谷区ＷＳ', state: '相手待ち', due: '2026-11-20', open: 3, overdue: 0 }, // 全角でも同じ案件
      { name: '社内DX', state: '期限が過ぎたものあり', open: 5, overdue: 2 },
    ]),
    U4: share(7, [{ name: '社内 DX', state: '動いている', open: 2 }]),
    U1: share(2, [{ name: '社内DX', state: '動いている' }, { name: 'PM1だけの案件', state: '動いている' }]),
    U3: share(6, [{ name: '渋谷区ワークショップ', state: '動いている' }]),
  };
}

function addAlias(env, from, to) {
  const sh = env.ss.getSheetByName('案件の別名');
  sh.appendRow(sh.cells[0].map(h => ({ '別名': from, '案件名': to })[h] ?? ''));
}

test('案件のタブ：MTD とミエタスクを案件ごとに束ね、関わっている人・進み具合・残りの件数を出す。見えない人は数だけ', () => {
  const env = load();
  seedProjects(env);
  addAlias(env, '渋谷区ワークショップ', '渋谷区WS');

  const v = dash(env, 'dan@example.com'); // pd の管理者
  const names = v.projects.map(p => p.name);
  assert.deepStrictEqual(names.slice(0, 2), ['社内DX', '渋谷区WS'], '気にすべきもの（期限超過 → 相手待ち・期限の近い順）から並んでいない');
  assert.ok(!names.includes('PM1だけの案件'), '見えない人だけの案件が出ている');
  assert.ok(!names.includes('社内 DX') && !names.includes('渋谷区ＷＳ') && !names.includes('渋谷区ワークショップ'), '束ねられていない');
  const dx = v.projects[0];
  assert.deepStrictEqual(dx, { name: '社内DX', rank: 0, due: '', due_label: '', progress: null, mtd: false, counts: '残り7件（うち超過2件）',
    members: [{ name: '別チーム', role: 'ミエタスク' }, { name: 'MTDに無い人', role: 'ミエタスク' }], others: 1 }); // 山田さん（pm1）は数だけ
  const ws = v.projects[1];
  assert.deepStrictEqual(ws, { name: '渋谷区WS', rank: 1, due: '2026-11-20', due_label: '11/20',
    progress: { label: '期間の5割・残り6週（10/1〜12/31）', pct: 51 }, mtd: true, counts: '残り3件',
    members: [{ name: '別チーム', role: 'PM' }, { name: 'MTDに無い人', role: 'CC' }, { name: 'ひも付けなし', role: 'ミエタスク' }],
    others: 1 }); // 台帳にいない連携メンバー
  const later = v.projects.find(p => p.name === '1月開始WS');
  assert.deepStrictEqual([later.rank, later.progress.label], [4, '1/10開始']);
  assert.strictEqual(v.projects.find(p => p.name === '他人の案件').members[0].role, '担当外');
  assert.ok(!names.includes('名前を読めない案件'));

  // メンバーは自分の関わる案件だけ。ほかの人は名前を出さず数だけ
  const me = dash(env, 'betsu@example.com').projects;
  assert.deepStrictEqual(me.find(p => p.name === '社内DX').members, [{ name: '別チーム', role: 'ミエタスク' }]);
  assert.strictEqual(me.find(p => p.name === '社内DX').others, 2);
  assert.strictEqual(me.find(p => p.name === '渋谷区WS').others, 3);
  assert.ok(!JSON.stringify(me).includes('MTDに無い人') && !JSON.stringify(me).includes('山田'));

  // 役員は全員が見えるので、数だけの人はいない
  const ex = dash(env, 'exec@example.com').projects;
  assert.deepStrictEqual(ex.find(p => p.name === '社内DX').members.map(m => m.name), ['山田 太郎', '別チーム', 'MTDに無い人']);
  assert.strictEqual(ex.find(p => p.name === '社内DX').others, 0);
  assert.ok(ex.some(p => p.name === 'PM1だけの案件'));

  // まとめを外すと別々に出る（覚えている分があっても、束ね方は開くたびに台帳から読む）
  env.ss.getSheetByName('案件の別名').cells.splice(1);
  const after = dash(env, 'dan@example.com').projects.map(p => p.name);
  assert.ok(after.includes('渋谷区ワークショップ'));
});

test('案件の手がかり：本人の MTD の案件名と、同じチームの人が最近使った案件名だけを返す。別名はまとめ先の名前にする', () => {
  const env = load();
  const k = seedProjects(env);
  addAlias(env, '渋谷区ワークショップ', '渋谷区WS');
  // 15日前の要約は使わない
  const sheet = env.ss.getSheetByName('案件の要約');
  sheet.appendRow(sheet.cells[0].map(h => ({ '日付': '2026-11-01', 'Slack ID': 'U4', '名前': 'MTDに無い人', '要約': JSON.stringify([{ name: '古い案件', state: '動いている' }]) })[h] ?? ''));

  const r = call(env, { id: k.U2.i, k: k.U2.k, action: 'hints' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.mtd_error, '');
  assert.ok(['26順天高1ゼミ', '渋谷区WS', '1月開始WS', '他人の案件'].every(n => r.mtd.includes(n)), JSON.stringify(r.mtd));
  assert.ok(!r.mtd.includes('昔の案件') && !r.mtd.includes('中止した案件') && !r.mtd.includes('（読めない案件）'));
  assert.deepStrictEqual(r.team, ['社内DX'], '同じチーム（pd）の人の分だけ・MTD と同じものや表記ゆれは1つ');
  assert.deepStrictEqual(Object.keys(r).sort(), ['mtd', 'mtd_error', 'ok', 'team'], '名前のほかを返している');

  // MTD を読めなくても、チームの分は返す
  env.props.NOTION_TOKEN = '';
  const r2 = call(env, { id: k.U4.i, k: k.U4.k, action: 'hints' });
  assert.ok(r2.ok && r2.mtd_error && r2.mtd.length === 0, JSON.stringify(r2));
  assert.deepStrictEqual(r2.team, ['渋谷区ＷＳ', '社内DX'], '全角・半角や別名のゆれは、先に出た名前1つにする');
});

test('案件の要約：残りと超過の件数を受け取り、メンバーの一覧に出す。件数の無い古い版も受け取る', () => {
  const env = load();
  const k = seedProjects(env);
  const c = dash(env, 'betsu@example.com').cards.U2;
  assert.strictEqual(c.items.find(i => i.name === '社内DX').long, '期限が過ぎたものあり・残り5件（うち超過2件）');
  assert.strictEqual(c.items.find(i => i.name === '渋谷区ＷＳ').long, '相手待ち・残り3件（次の期限 11/20）');
  assert.ok(call(env, { id: k.U2.i, k: k.U2.k, action: 'share', items: [{ name: '社内DX', state: '動いている' }] }).ok);
  const row = env.ss.getSheetByName('案件の要約').cells.find(r => r[1] === 'U2');
  assert.deepStrictEqual(JSON.parse(row[3]), [{ name: '社内DX', state: '動いている', due: '' }]);
});

test('案件の別名：システム管理者が動作状況のページから束ね・外せる。変更の記録に残り、輪や同じ名前は断る', () => {
  const env = load();
  seedProjects(env);
  const r = change(env, 'sys@example.com', { kind: 'merge', from: '渋谷区ワークショップ', to: '渋谷区WS' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.changed, 1);
  assert.deepStrictEqual(r.aliases, [{ alias: '渋谷区ワークショップ', name: '渋谷区WS' }]);
  assert.ok(!dash(env, 'dan@example.com').projects.some(p => p.name === '渋谷区ワークショップ'));
  // 同じ別名をもう一度束ねると、まとめ先を書き換える（行は増やさない）
  assert.strictEqual(change(env, 'sys@example.com', { kind: 'merge', from: '渋谷区ワークショップ', to: '渋谷区WS' }).changed, 0);
  const moved = change(env, 'sys@example.com', { kind: 'merge', from: '渋谷区 ワークショップ', to: '渋谷区' });
  assert.deepStrictEqual(moved.aliases, [{ alias: '渋谷区ワークショップ', name: '渋谷区' }]);
  for (const [c, why] of [
    [{ kind: 'merge', from: '渋谷区', to: '渋谷区ワークショップ' }, /輪/],
    [{ kind: 'merge', from: '社内 DX', to: '社内ＤＸ' }, /同じ名前/],
    [{ kind: 'merge', from: '=HYPERLINK("x")', to: '社内DX' }, /先頭/],
    [{ kind: 'merge', from: 'a@example.com', to: '社内DX' }, /メールアドレス/],
    [{ kind: 'merge', from: '', to: '社内DX' }, /空/],
    [{ kind: 'unmerge', alias: 'ない名前' }, /ありません/],
  ]) {
    const res = change(env, 'sys@example.com', c);
    assert.strictEqual(res.error, 'bad_change', JSON.stringify(c));
    assert.match(res.message, why);
  }
  const un = change(env, 'sys@example.com', { kind: 'unmerge', alias: '渋谷区ワークショップ' });
  assert.ok(un.ok && un.aliases.length === 0, JSON.stringify(un));
  assert.deepStrictEqual(un.log.slice(0, 3).map(l => [l['対象'], l['前'], l['後']]), [
    ['案件 渋谷区ワークショップ', '渋谷区', '（外した）'],
    ['案件 渋谷区 ワークショップ', '渋谷区WS', '渋谷区'],
    ['案件 渋谷区ワークショップ', '', '渋谷区WS'],
  ]);
  // システム管理者でなければ束ねられない
  assert.strictEqual(change(env, 'exec@example.com', { kind: 'merge', from: 'a', to: 'b' }).error, 'forbidden');
});

test('案件のページ：案件のタブを最初に出し、関わっている人と進み具合を並べる。動作状況のページから案件を束ねられる', () => {
  const env = load();
  seedProjects(env);
  env.notion.sources.proj.push(project('b1000000-0000-0000-0000-0000000000b2', '<b>太字</b>の案件', { pm: [ME], start: '2026-04-01', end: '2027-03-31' }));
  const h = loadDashboard(env, { email: 'dan@example.com' }).page();
  const first = h.match(/<section role="tabpanel" id="projects">([\s\S]*?)<\/section>/)[1];
  assert.ok(first.includes('<h3>渋谷区WS</h3>') && first.includes('期間の5割・残り6週') && first.includes('<li>別チーム<span>PM</span></li>') &&
    first.includes('ほかに1人') && first.includes('残り7件（うち超過2件）') && first.includes('次の期限 11/20'), first);
  assert.ok(first.includes('&lt;b&gt;太字&lt;/b&gt;の案件') && !first.includes('<b>太字'), '案件名を escape していない');
  assert.ok(!h.includes('PM1だけの案件'));
  const hp = loadDashboard(env, { email: 'sys@example.com' });
  const html = hp.ctx.saveChange({ kind: 'merge', from: '渋谷区ワークショップ', to: '渋谷区&港区"WS' });
  assert.ok(html.includes('<td>渋谷区ワークショップ</td><td>渋谷区&amp;港区&quot;WS</td>') && html.includes('data-unmerge="渋谷区ワークショップ"'), html);
  const page = hp.page({ view: 'health' });
  assert.ok(page.includes('data-merge') && page.includes('案件の別名'));
  for (const m of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]));
});
