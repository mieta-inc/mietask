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
  return { ctx, ss, slack, notion, clock, triggers, props, ui };
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
    { '名前': '管理 花子', 'Slack ID': 'UM', 'チーム': 'pm', '状態': '有効' },
    { '名前': '別チーム', 'Slack ID': 'U2', 'チーム': 'pd', '状態': '有効' },
    { '名前': '退職 次郎', 'Slack ID': 'U9', 'チーム': 'pm2', '状態': '有効' },
  ]);
  put('チーム', [
    { 'チームID': 'pm', '表示名': 'PM', '管理者': 'UM', 'まとめチャンネル': '' },
    { 'チームID': 'pm1', '表示名': 'PM1', '親チーム': 'pm', 'まとめチャンネル': '' },
    { 'チームID': 'pm2', '表示名': 'PM2', '親チーム': 'PM', 'まとめチャンネル': '' },
    { 'チームID': 'pd', '表示名': 'PD', 'まとめチャンネル': '' },
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

test('投稿できるのは本人の投稿先だけ。所属チームのまとめチャンネルにも出せない', () => {
  const env = load();
  seed(env);
  select(env, 'チーム', 3); // pm1
  env.ctx.menuCreateTeamChannel();
  const pm1 = cell(env, 'チーム', 3, 'まとめチャンネル');
  select(env, 'チーム', 5); // pd
  env.ctx.menuCreateTeamChannel();
  const pd = cell(env, 'チーム', 5, 'まとめチャンネル');
  const k = issue(env, 2); // U1 は pm1
  // 自分のチームのまとめにも出せない（各自の一覧には DM や非公開チャンネルの内容が入るため）
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
  env.ss.getSheetByName('メンバー').cells[1][4] = '停止';
  assert.strictEqual(call(env, { id: k2.i, k: k2.k, action: 'me' }).error, 'stopped');
  env.ss.getSheetByName('メンバー').cells[1][4] = '有効';

  // 無効にした鍵は使えない
  select(env, 'メンバー', 2);
  env.ctx.menuRevokeKey();
  assert.strictEqual(call(env, { id: k2.i, k: k2.k, action: 'me' }).error, 'bad_key');
  assert.ok(cell(env, 'メンバー', 2, '鍵').startsWith('無効'));
});

test('停止の人には鍵を発行しない', () => {
  const env = load();
  seed(env);
  env.ss.getSheetByName('メンバー').cells[4][4] = '停止';
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

  // システム管理者：どのチームの管理者でもなくても、全チーム・全員と、直近8日の件数が見える
  const st = env.ss.getSheetByName('設定');
  st.cells.forEach(r => { if (r[0] === 'system_admins') r[1] = 'U2'; });
  const adm = call(env, { id: k2.i, k: k2.k, action: 'me' }).managed;
  assert.strictEqual(adm.system_admin, true);
  assert.deepStrictEqual(adm.teams.map(t => t.id).sort(), ['pd', 'pm', 'pm1', 'pm2']);
  assert.deepStrictEqual(adm.members.map(m => m.slack_id).sort(), ['U1', 'U2', 'U9', 'UM']);
  assert.deepStrictEqual(adm.daily.map(d => [d.slack_id, d.date, d.overdue]).sort(), [['U1', '2026-11-16', 1], ['U2', '2026-11-16', 9]]);

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
  env.ss.getSheetByName('メンバー').cells[1][6] = '';
  const s3 = call(env, { id: k1.i, k: k1.k, action: 'setup', candidates: ['ミエタスク-yamada'] });
  assert.strictEqual(s3.channel, s1.channel);
  // 日本語が使えないワークスペースでは英字の候補に進む
  env.ss.getSheetByName('メンバー').cells[3][6] = '';
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
  env.ss.getSheetByName('メンバー').cells[4][4] = '停止';
  env.ctx.menuArchiveMember();
  assert.strictEqual(env.slack.channels[s.channel].archived, true);
  assert.ok(!('KEY_U9' in env.props));
});

test('チーム：まとめチャンネルを作ると管理者を招待し、IDを台帳に書く', () => {
  const env = load();
  seed(env);
  select(env, 'チーム', 2); // pm（管理者 UM）
  env.ctx.menuCreateTeamChannel();
  const id = cell(env, 'チーム', 2, 'まとめチャンネル');
  assert.ok(id);
  assert.ok(env.slack.channels[id].members.has('UM'));
  env.ctx.menuCreateTeamChannel();
  assert.match(env.ui.alerts.pop(), /すでに/);
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

// ---------------------------------------------------------------- チームのまとめ（MTD の案件と状態）

const NU = n => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`; // Notion のユーザーID
const ME = NU(2), OTHER = NU(99);

// pd チーム（管理者 UD）にまとめチャンネルを作り、MTD に U2 の案件とタスクを入れる
function seedRollup(env) {
  seed(env);
  const members = env.ss.getSheetByName('メンバー');
  const head = members.cells[0];
  const put = r => members.appendRow(head.map(h => r[h] ?? ''));
  members.cells[3][head.indexOf('Notion ユーザー')] = 'user://' + ME; // U2（pd）
  put({ '名前': 'ひも付けなし', 'Slack ID': 'U3', 'チーム': 'pd', '状態': '有効' });
  put({ '名前': 'MTDに無い人', 'Slack ID': 'U4', 'チーム': 'pd', '状態': '有効', 'Notion ユーザー': 'user://' + NU(4) });
  put({ '名前': '停止の人', 'Slack ID': 'U5', 'チーム': 'pd', '状態': '停止', 'Notion ユーザー': 'user://' + NU(5) });
  const teams = env.ss.getSheetByName('チーム');
  teams.cells[4][teams.cells[0].indexOf('管理者')] = 'UD';
  const st = env.ss.getSheetByName('設定');
  st.cells.forEach(r => {
    if (r[0] === 'system_admins') r[1] = 'UA';
    if (r[0] === 'notion_projects') r[1] = 'collection://proj';
    if (r[0] === 'notion_tasks') r[1] = 'collection://tasks';
  });
  select(env, 'チーム', 5);
  env.ctx.menuCreateTeamChannel();
  const channel = cell(env, 'チーム', 5, 'まとめチャンネル');
  env.props.NOTION_TOKEN = 'ntn_good';
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
  return channel;
}

test('チームのまとめ：1人1行に案件名を並べ、スレッドに案件の数と1件ずつの状態を出す', () => {
  const env = load();
  const channel = seedRollup(env);
  env.slack.channels[channel].members.add('UA'); // システム管理者は入っていてもよい
  // 各自のミエタスクの件数が届いていても、まとめには使わない
  const k = issue(env, 4);
  call(env, { id: k.i, k: k.k, action: 'status', counts: { overdue: 7, today: 8, week: 9 } });

  env.ctx.dailyRollup();
  const msgs = env.slack.channels[channel].messages;
  assert.strictEqual(msgs.length, 2, '親1本＋案件が見える人（1人）のスレッド1本のはず: ' + msgs.map(m => m.text).join('\n---\n'));
  const [parent, detail] = msgs;
  assert.strictEqual(detail.thread_ts, parent.ts);
  assert.match(parent.text, /\*PDの状況\*　11\/16時点/);
  // 気にすべきもの → 終わりが近い順。名前は4件まで、残りは数だけ
  assert.ok(parent.text.includes('• *別チーム*　26順天高1ゼミ（CC・〜3/31・確認待ちあり）、26広島学院 高1 FW（CC・〜11/20）、'
    + '大阪国際WS（PM・〜12/4）、リードだけの案件（リード・〜3/31） ほか3件　※ミエタスク未着'), parent.text);
  assert.ok(parent.text.includes('• *ひも付けなし*　見える案件なし　※MTD未連携（システム管理者が対応）・ミエタスク未着'), parent.text);
  assert.ok(parent.text.includes('• *MTDに無い人*　見える案件なし　※ミエタスク未着'), parent.text);
  assert.ok(!parent.text.includes('停止の人'));
  assert.ok(parent.text.includes('タスクの題名・メールやDMの中身は入っていません'));

  assert.strictEqual(detail.text, [
    '■ *別チーム* — 今の案件 6件、これから始まる 1件　※ミエタスク未着',
    '・26順天高1ゼミ — CC・確認待ちあり（〜3/31）',
    '・26広島学院 高1 FW — CC（〜11/20）',
    '・大阪国際WS — PM（〜12/4）',
    '・リードだけの案件 — リード（〜3/31）',
    '・都立大崎 — SP（10/1〜）',
    '・他人の案件 — 担当外・タスク1件',
    '・1月開始WS — CC・これから（1/10〜）',
  ].join('\n'));
  // 中止・終わった・期間が過ぎた案件と、タスクの題名は出さない。「MTD」の件数の書き方もしない
  for (const t of [parent.text, detail.text]) {
    assert.ok(!/中止した案件|昔の案件|26洗足FW|ワークシート|動画修正|講師コンテンツ|スライド|MTD \d/.test(t), t);
  }
  // Notion にはバージョンを付けて問い合わせ、担当は CC・PM・SP だけで引く
  assert.ok(env.notion.calls.length > 0 && env.notion.calls.every(c => c.version === '2025-09-03'));
  const q = env.notion.calls.find(c => c.path === 'data_sources/proj/query');
  assert.deepStrictEqual(q.body.filter.or.map(f => f.property), ['CC担当', 'PM担当', 'SP担当', 'プロジェクトリード', '連携メンバー']);
  assert.strictEqual(JSON.parse(env.props.ROLLUP_LAST).problems.length, 0);
});

test('チームのまとめ：管理者・システム管理者以外が入っている／公開チャンネルなら出さず、システム管理者に知らせる', () => {
  const env = load();
  const channel = seedRollup(env);
  env.slack.channels[channel].members.add('U2'); // メンバー本人が入ってしまっている
  assert.throws(() => env.ctx.dailyRollup(), /管理者・システム管理者以外/);
  assert.strictEqual(env.slack.channels[channel].messages.length, 0, '投稿してしまった');
  assert.match(env.slack.dms.UA.slice(-1)[0].text, /<@U2>.*投稿していません/s);

  env.slack.channels[channel].members.delete('U2');
  env.slack.channels[channel].private = false;
  assert.throws(() => env.ctx.dailyRollup(), /公開チャンネル/);
  assert.strictEqual(env.slack.channels[channel].messages.length, 0);
});

test('チームのまとめ：土日・祝日は出さない。Notion の鍵が無ければシステム管理者に知らせる', () => {
  const env = load();
  const channel = seedRollup(env);
  env.clock.dow = '6';
  env.ctx.dailyRollup();
  env.clock.dow = '1';
  env.clock.today = '2026-11-23'; // 勤労感謝の日（月曜）
  env.ctx.dailyRollup();
  assert.strictEqual(env.notion.calls.length, 0);
  assert.strictEqual(env.slack.channels[channel].messages.length, 0);
  env.clock.today = '2026-11-24';

  env.clock.dow = '2';
  delete env.props.NOTION_TOKEN;
  assert.throws(() => env.ctx.dailyRollup(), /Notion の鍵/);
  assert.match(env.slack.dms.UA.slice(-1)[0].text, /PD：Notion の鍵が設定されていません/);
  assert.strictEqual(env.slack.channels[channel].messages.length, 0);
});

test('チームのまとめ：ページが分かれていても全部読む', () => {
  const env = load();
  seedRollup(env);
  for (let i = 0; i < 130; i++) {
    env.notion.sources.proj.push(project(`b2000000-0000-0000-0000-${String(i).padStart(12, '0')}`, 'ゼミ' + i, { cc: [ME], kind: 'ゼミ', start: '2026-04-01', end: '2027-03-31' }));
  }
  env.ctx.dailyRollup();
  const ch = cell(env, 'チーム', 5, 'まとめチャンネル');
  assert.match(env.slack.channels[ch].messages[1].text, /今の案件 136件、これから始まる 1件/);
  assert.ok(env.notion.calls.some(c => c.path === 'data_sources/proj/query' && c.body.start_cursor === '100'), '2ページ目を読んでいない');
});

test('チームのまとめ：試しの実行はシステム管理者の DM にだけ届き、まとめチャンネルには出さない', () => {
  const env = load();
  const channel = seedRollup(env);
  select(env, 'チーム', 5);
  env.ui.alerts.length = 0;
  env.ctx.menuTrialRollup();
  assert.match(env.ui.alerts.pop(), /DM で送りました[\s\S]*出せる状態/);
  assert.strictEqual(env.slack.channels[channel].messages.length, 0);
  const dm = env.slack.dms.UA;
  assert.match(dm[0].text, /^（試し・まとめチャンネルには出していません）\n:busts_in_silhouette: \*PDの状況\*/);
  assert.strictEqual(dm.length, 2);
  assert.strictEqual(dm[1].thread_ts, dm[0].ts);
  assert.ok(!(env.slack.strayDms.UA || []).length, '表示名を付けて送り、Bot から消せない場所に置いた');
});

test('Notionの鍵：MTD を読めない鍵は保存しない', () => {
  const env = load();
  seedRollup(env);
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

test('毎朝の仕組み：始めると平日9時の1本だけになり、止めると消える', () => {
  const env = load();
  seedRollup(env);
  delete env.props.NOTION_TOKEN;
  env.ctx.menuStartRollup();
  assert.match(env.ui.alerts.pop(), /Notion の鍵/);
  assert.strictEqual(env.triggers.length, 0);

  env.props.NOTION_TOKEN = 'ntn_good';
  env.ctx.menuStartRollup();
  env.ctx.menuStartRollup();
  assert.match(env.ui.alerts.pop(), /始めました[\s\S]*PD：出せる状態/);
  assert.strictEqual(env.triggers.length, 1);
  assert.deepStrictEqual(env.triggers[0].spec, { fn: 'dailyRollup', everyDays: 1, hour: 9, tz: 'Asia/Tokyo' });
  env.ctx.menuStopRollup();
  assert.match(env.ui.alerts.pop(), /止めました/);
  assert.strictEqual(env.triggers.length, 0);
});

test('祝日：振替休日・国民の休日・移動する祝日も含めて、内閣府の一覧と同じになる', () => {
  const env = load();
  const list = y => Object.keys(env.ctx.jpHolidays_(y)).sort();
  assert.deepStrictEqual(list(2026), ['2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29',
    '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22',
    '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23']);
  assert.deepStrictEqual(list(2027), ['2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22',
    '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23',
    '2027-10-11', '2027-11-03', '2027-11-23']);
  assert.strictEqual(env.ctx.isJpHoliday_('2026-11-16'), false);
});

test('チームのまとめ：担当案件が無くても、担当外の案件で動いていればその案件を出す', () => {
  const env = load();
  seedRollup(env);
  env.notion.sources.proj = env.notion.sources.proj.filter(p => ['CC担当', 'PM担当', 'SP担当', 'プロジェクトリード']
    .every(k => p.properties[k].people.every(u => u.id !== ME)));
  env.ctx.dailyRollup();
  const ch = cell(env, 'チーム', 5, 'まとめチャンネル');
  assert.ok(env.slack.channels[ch].messages[0].text.includes('• *別チーム*　他人の案件（担当外）、名前を読めない案件（担当外・2件）　※ミエタスク未着'),
    env.slack.channels[ch].messages[0].text);
});

test('案件の要約：決まった形だけを受け取り、まとめでMTDの案件と1つの並びにする。本人の題名やリンクは受け取らない', () => {
  const env = load();
  const channel = seedRollup(env);
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
    Array.from({ length: 13 }, (_, i) => ({ name: '案件' + i, state: '動いている' })),
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

  env.ctx.dailyRollup();
  const msgs = env.slack.channels[channel].messages;
  const parent = msgs[0].text;
  // 出どころを分けず、気にすべきもの（期限超過 → 相手待ち・確認待ち）から並べる
  assert.ok(parent.includes('• *別チーム*　TiB講義スライド（期限超過あり）、26順天高1ゼミ（CC・〜3/31・確認待ちあり）、社内DX（相手待ち）、'
    + 'ミエマス（ポータル・MTD）（期限11/20） ほか7件\n'), parent);
  assert.ok(parent.includes('• *MTDに無い人*　見える案件なし　※ミエタスクは11/13から未着'), parent);
  assert.strictEqual(msgs.length, 2, '案件が見える人だけにスレッドを付ける');
  assert.strictEqual(msgs[1].text, [
    '■ *別チーム* — 今の案件 10件、これから始まる 1件',
    '・TiB講義スライド — 期限が過ぎたものあり',
    '・26順天高1ゼミ — CC・確認待ちあり（〜3/31）',
    '・社内DX — 相手待ち',
    '・ミエマス（ポータル・MTD） — 動いている（次の期限 11/20）',
    '・26広島学院 高1 FW — CC（〜11/20）',
    '・大阪国際WS — PM（〜12/4）',
    '・リードだけの案件 — リード（〜3/31）',
    '・採用 — 動いている',
    '・都立大崎 — SP（10/1〜）',
    '・他人の案件 — 担当外・タスク1件',
    '・1月開始WS — CC・これから（1/10〜）',
  ].join('\n'));

  // 管理者の画面にも、担当チームの人の要約が返る
  const st = env.ss.getSheetByName('設定');
  st.cells.forEach(r => { if (r[0] === 'system_admins') r[1] = ''; });
  const teams = env.ss.getSheetByName('チーム');
  teams.cells[4][teams.cells[0].indexOf('管理者')] = 'U2';
  const mgr = call(env, { id: k2.i, k: k2.k, action: 'me' }).managed;
  assert.deepStrictEqual(mgr.shared.map(x => [x.slack_id, x.date, x.items.length]).sort(), [['U2', '2026-11-16', 4], ['U4', '2026-11-13', 0]]);
});
