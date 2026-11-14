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
      case 'auth.test': return { ok: true, team: 'MIETA', user: 'mietask' };
      case 'conversations.create': {
        if (!/^[a-zぁ-んァ-ヶー一-龠0-9_-]+$/.test(p.name)) return { ok: false, error: 'invalid_name' };
        if (Object.values(this.channels).some(c => c.name === p.name)) return { ok: false, error: 'name_taken' };
        const id = 'C' + (100 + Object.keys(this.channels).length);
        this.channels[id] = { name: p.name, members: new Set(['BOT']), archived: false, messages: [] };
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
        return c ? { ok: true, channel: { name: c.name, is_archived: c.archived } } : { ok: false, error: 'channel_not_found' };
      }
      case 'conversations.archive': {
        const c = this.channels[p.channel];
        if (!c) return { ok: false, error: 'channel_not_found' };
        c.archived = true;
        return { ok: true };
      }
      case 'chat.postMessage': {
        if (/^U/.test(p.channel)) {
          if (this.dmFails) return { ok: false, error: 'missing_scope' };
          const ts = this.ts();
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

// ---------------------------------------------------------------- Apps Script の実行環境

function load() {
  const ss = new Spreadsheet();
  const slack = new FakeSlack();
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
        const method = url.replace('https://slack.com/api/', '');
        if (slack.rateLimitOnce) {
          slack.rateLimitOnce = false;
          return { getResponseCode: () => 429, getHeaders: () => ({ 'Retry-After': '1' }), getContentText: () => '' };
        }
        const token = opts.headers.Authorization.replace('Bearer ', '');
        const out = slack.handle(method, JSON.parse(opts.payload), token);
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(out) };
      },
    },
    Utilities: {
      sleep: () => {},
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: () => '2026-11-16T07:00:00+09:00',
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    HtmlService: { createHtmlOutput: h => ({ html: h, setWidth() { return this; }, setHeight() { return this; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.REGISTRY_GS || path.join(__dirname, '..', 'registry.gs'), 'utf8'), ctx);
  return { ctx, ss, slack, props, ui };
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

  const p = call(env, { id: k.i, k: k.k, action: 'post', channel: s.channel, parent: '親', replies: ['子1', '子2'], version: '0.5.0' });
  assert.ok(p.ok, JSON.stringify(p));
  const msgs = env.slack.channels[s.channel].messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[1].thread_ts, p.ts);
  assert.strictEqual(msgs[0].username, 'ミエタスク');
  assert.strictEqual(cell(env, 'メンバー', 2, '最後に動いた'), '2026-11-16T07:00:00+09:00');
});

test('投稿できるのは本人の投稿先と所属チームのまとめチャンネルだけ', () => {
  const env = load();
  seed(env);
  select(env, 'チーム', 3); // pm1
  env.ctx.menuCreateTeamChannel();
  const pm1 = cell(env, 'チーム', 3, 'まとめチャンネル');
  select(env, 'チーム', 5); // pd
  env.ctx.menuCreateTeamChannel();
  const pd = cell(env, 'チーム', 5, 'まとめチャンネル');
  const k = issue(env, 2); // U1 は pm1
  assert.ok(call(env, { id: k.i, k: k.k, action: 'post', channel: pm1, parent: 'まとめ' }).ok);
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
