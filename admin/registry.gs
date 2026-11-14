/**
 * ミエタスク 管理台帳の窓口（Google Apps Script）
 *
 * 管理台帳のスプレッドシートに付けて、ウェブアプリとして公開する。役目は2つ。
 *
 * 1. 各メンバーの mietask の窓口
 *    メンバーは一人ずつ別の鍵を持つ。窓口は鍵を確かめてから、その人の代わりに Slack へ投稿する。
 *    Botトークンはこのスクリプトの中（スクリプト プロパティ）にだけ置き、メンバーには配らない。
 *    投稿できるのは、本人の投稿先と、所属チームのまとめチャンネルだけ。
 *    台帳で「停止」にした人、鍵を無効にした人は、その時点から何もできなくなる。
 *
 * 2. 管理者のメニュー（スプレッドシートの「ミエタスク」メニュー）
 *    鍵の発行（Bot から本人に DM で届ける）、鍵の無効化、まとめチャンネルの作成、管理者の招待、
 *    退職者の投稿先の片付け。スプレッドシートを編集できる人が管理者になる。
 *
 * ■ 最初の1回
 *   1. スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの中身を貼る
 *   2. 関数 setupSheets を実行する（シートと見出しを作る）
 *   3. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *      出てきた URL を「設定」シートの relay_url に入れる
 *   4. スプレッドシートを開き直し、「ミエタスク → Botトークンを設定する」でトークンを入れる
 *   5. メンバーの行を選んで「ミエタスク → 選んだ人の鍵を発行する」
 *
 * ■ シート（見出しの名前で列を探すので、列の並べ替えや列の追加をしても壊れない）
 *   メンバー: 名前 / Slack ID / メール / チーム / 状態 / Notion ユーザー / 投稿先 / 鍵 / 最後に動いた / バージョン / メモ
 *             チームはチームIDをカンマ区切り（例: pm,pm1）。状態は「有効」か「停止」
 *             Notion ユーザーは user://… （管理者の画面が MTD の担当を引くのに使う。空ならメールで探す）
 *             投稿先・鍵・最後に動いた・バージョンは、このスクリプトが書く
 *   チーム:   チームID / 表示名 / 親チーム / まとめチャンネル / 管理者 / メモ
 *             親チームに pm と書けば、PM の管理者の画面に PM1 も入る。管理者は Slack ID をカンマ区切り
 *   設定:     項目 / 値
 *             relay_url（この窓口の URL）・workspace（Slack のワークスペース名）・bot_username・bot_icon_url・
 *             notion_projects・notion_tasks（MTD の場所）
 */

var SHEETS = {
  members: {
    name: 'メンバー',
    headers: ['名前', 'Slack ID', 'メール', 'チーム', '状態', 'Notion ユーザー', '投稿先', '鍵', '最後に動いた', 'バージョン', 'メモ'],
  },
  teams: { name: 'チーム', headers: ['チームID', '表示名', '親チーム', 'まとめチャンネル', '管理者', 'メモ'] },
  settings: { name: '設定', headers: ['項目', '値'] },
};

var KEY_PREFIX = 'mietask2.';
var MAX_TEXT = 3900; // Slack は長すぎる本文を黙って切るので、投稿の前に止める
var STOPPED = '停止';

// ================================================================ ウェブアプリ（メンバーの mietask から）

function doGet() {
  // 中身は返さない。生きているかの確認だけ
  return json_({ ok: true, service: 'mietask', version: 2 });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'JSONが読めません' });
  }
  try {
    var ctx = auth_(body);
    var fn = ACTIONS[body.action];
    if (!fn) return json_({ ok: false, error: 'unknown_action', message: '不明な操作です: ' + body.action });
    var out = fn(ctx, body) || {};
    out.ok = true;
    return json_(out);
  } catch (err) {
    if (err && err.relay) return json_({ ok: false, error: err.code, message: err.message });
    // 想定外の失敗。中身（トークン等）を出さないよう、種類だけ返す
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'internal', message: '窓口で想定外のエラーが起きました。管理者に連絡してください' });
  }
}

var ACTIONS = {
  // 自分の情報・所属チーム。管理者なら、管理しているチームのメンバーも返す
  me: function (ctx) {
    return { me: publicMember_(ctx.member), teams: myTeams_(ctx), managed: managedView_(ctx), settings: publicSettings_(ctx.ss) };
  },

  // 投稿先を用意する（無ければ作り、本人を招待する）。鍵を届けた DM はここで消す
  setup: function (ctx, body) {
    var m = ctx.member;
    var result;
    if (m.channel) {
      var inv = invite_(m.channel, m.slack_id);
      result = { channel: m.channel, name: channelName_(m.channel), message: inv };
    } else {
      result = createOwnChannel_(ctx, body.candidates || []);
    }
    touch_(ctx, body);
    deleteKeyMessage_(m.slack_id);
    return result;
  },

  // 親＋子スレッドを投稿する。own=true なら本人の投稿先（稼働も記録する）、そうでなければまとめチャンネル
  post: function (ctx, body) {
    var channel = String(body.channel || '');
    if (!channel) throw relayError_('bad_request', '投稿先がありません');
    if (!allowedChannel_(ctx, channel)) {
      throw relayError_('forbidden_channel', 'この投稿先には投稿できません（本人の投稿先と、所属チームのまとめチャンネルだけ）');
    }
    var parent = String(body.parent || '');
    var replies = body.replies || [];
    if (!parent.trim()) throw relayError_('bad_request', 'parent が空です');
    [parent].concat(replies).forEach(function (t, i) {
      if (String(t).length > MAX_TEXT) throw relayError_('too_long', (i ? 'replies[' + (i - 1) + ']' : 'parent') + ' が長すぎます');
    });
    var ts = postMessage_(ctx.ss, channel, parent, null);
    for (var i = 0; i < replies.length; i++) {
      Utilities.sleep(1100); // chat.postMessage は1チャンネル毎秒1通が目安
      postMessage_(ctx.ss, channel, String(replies[i]), ts);
    }
    if (channel === ctx.member.channel) touch_(ctx, body);
    return { ts: ts };
  },

  // 本人の投稿先にある Bot の投稿を消す
  delete: function (ctx, body) {
    var channel = ctx.member.channel;
    if (!channel) throw relayError_('no_channel', '投稿先がまだありません');
    var done = [], failed = [];
    (body.ts || []).forEach(function (ts, i) {
      if (i) Utilities.sleep(1100);
      var r = slack_('chat.delete', { channel: channel, ts: String(ts) });
      if (r.ok) done.push(ts); else failed.push(ts + ': ' + r.error);
    });
    return { deleted: done, failed: failed };
  },

  // 診断。Bot と投稿先が使えるかを返す
  check: function (ctx) {
    var bot = slack_('auth.test', {});
    var out = { bot: bot.ok ? 'ok' : bot.error, me: publicMember_(ctx.member), teams: myTeams_(ctx) };
    if (ctx.member.channel) {
      var info = slack_('conversations.info', { channel: ctx.member.channel });
      out.channel = info.ok ? { id: ctx.member.channel, name: info.channel.name, archived: !!info.channel.is_archived } : { id: ctx.member.channel, error: info.error };
    }
    return out;
  },

  heartbeat: function (ctx, body) {
    touch_(ctx, body);
    return {};
  },
};

// ---------------------------------------------------------------- 認証

function auth_(body) {
  var id = String(body.id || '');
  var key = String(body.k || '');
  if (!/^[UW][A-Z0-9]+$/.test(id) || !key) throw relayError_('bad_key', '鍵が読めません。管理者に鍵を発行し直してもらってください');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = findMember_(ss, id);
  if (!m) throw relayError_('not_registered', '管理台帳に登録されていません。管理者に確認してください');
  if (m.status === STOPPED) throw relayError_('stopped', 'ミエタスクの利用は管理台帳で停止されています。管理者に確認してください');
  var want = PropertiesService.getScriptProperties().getProperty('KEY_' + id);
  if (!want || want !== sha256_(key)) throw relayError_('bad_key', '鍵が無効です（作り直されたか、無効にされています）。管理者に確認してください');
  return { ss: ss, member: m };
}

// ---------------------------------------------------------------- メンバー・チーム

function findMember_(ss, slackId) {
  var rows = rows_(ss, SHEETS.members);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]['Slack ID'] === slackId) return memberFromRow_(rows[i], i + 2);
  }
  return null;
}

function memberFromRow_(r, rowNo) {
  return {
    row: rowNo, name: r['名前'], slack_id: r['Slack ID'], email: r['メール'], teams: list_(r['チーム']),
    status: r['状態'] || '有効', notion_user: r['Notion ユーザー'], channel: r['投稿先'],
    last_run: r['最後に動いた'], version: r['バージョン'],
  };
}

function publicMember_(m) {
  return { name: m.name, slack_id: m.slack_id, teams: m.teams, status: m.status, channel: m.channel };
}

function allTeams_(ss) {
  return rows_(ss, SHEETS.teams).map(function (r) {
    return { id: r['チームID'], name: r['表示名'], parent: r['親チーム'], channel: r['まとめチャンネル'], managers: list_(r['管理者']) };
  }).filter(function (t) { return t.id; });
}

function teamById_(teams, id) {
  for (var i = 0; i < teams.length; i++) if (teams[i].id.toLowerCase() === String(id).toLowerCase()) return teams[i];
  return null;
}

function myTeams_(ctx) {
  var teams = allTeams_(ctx.ss);
  return ctx.member.teams.map(function (id) {
    var t = teamById_(teams, id);
    return t ? { id: t.id, name: t.name, channel: t.channel } : { id: id, missing: true };
  });
}

// subtree は指定チームと、その下のチーム（親チームをたどって）。循環していても止まる
function subtree_(teams, id) {
  var out = [], seen = {};
  (function walk(cur) {
    var key = String(cur).toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(cur);
    teams.forEach(function (t) { if (String(t.parent).toLowerCase() === key) walk(t.id); });
  })(id);
  return out;
}

// 管理者の画面用。自分が管理者のチーム（と、その下のチーム）のメンバーだけを返す
function managedView_(ctx) {
  var teams = allTeams_(ctx.ss);
  var mine = teams.filter(function (t) { return t.managers.indexOf(ctx.member.slack_id) >= 0; });
  if (!mine.length) return null;
  var ids = {};
  mine.forEach(function (t) { subtree_(teams, t.id).forEach(function (id) { ids[id.toLowerCase()] = true; }); });
  var members = rows_(ctx.ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (m) { return m.slack_id && m.teams.some(function (t) { return ids[t.toLowerCase()]; }); })
    .map(function (m) { delete m.row; return m; });
  var settings = settings_(ctx.ss);
  return {
    teams: teams.filter(function (t) { return ids[t.id.toLowerCase()]; }),
    members: members,
    settings: { notion_projects: settings.notion_projects || '', notion_tasks: settings.notion_tasks || '' },
  };
}

function allowedChannel_(ctx, channel) {
  if (channel === ctx.member.channel) return true;
  var teams = allTeams_(ctx.ss);
  return ctx.member.teams.some(function (id) {
    var t = teamById_(teams, id);
    return t && t.channel === channel;
  });
}

function touch_(ctx, body) {
  setCell_(ctx.ss, SHEETS.members, ctx.member.row, '最後に動いた', nowJst_());
  if (body.version) setCell_(ctx.ss, SHEETS.members, ctx.member.row, 'バージョン', String(body.version).slice(0, 30) + (body.os ? ' / ' + String(body.os).slice(0, 30) : ''));
}

// ---------------------------------------------------------------- 投稿先チャンネル

function createOwnChannel_(ctx, candidates) {
  var m = ctx.member;
  var tried = [];
  for (var i = 0; i < candidates.length; i++) {
    var name = String(candidates[i]).replace(/^#/, '').trim();
    if (!name) continue;
    var r = slack_('conversations.create', { name: name, is_private: true });
    if (r.ok) {
      var msg = invite_(r.channel.id, m.slack_id);
      setCell_(ctx.ss, SHEETS.members, m.row, '投稿先', r.channel.id);
      return { channel: r.channel.id, name: r.channel.name, message: msg, created: true };
    }
    tried.push(name + '（' + r.error + '）');
    if (r.error === 'name_taken') {
      // 本人がすでに入っているなら、前回作った本人のチャンネル
      var id = findPrivateChannel_(name);
      if (id && isMember_(id, m.slack_id)) {
        setCell_(ctx.ss, SHEETS.members, m.row, '投稿先', id);
        return { channel: id, name: name, message: 'すでに本人のものなので、それを使います' };
      }
      continue;
    }
    if (r.error === 'invalid_name') continue;
    throw relayError_('slack_' + r.error, 'チャンネルを作れませんでした（' + r.error + '）');
  }
  throw relayError_('no_channel', '投稿先を作れませんでした: ' + tried.join(', '));
}

function invite_(channel, user) {
  var r = slack_('conversations.invite', { channel: channel, users: user });
  if (r.ok) return '招待しました';
  if (r.error === 'already_in_channel') return 'すでに参加しています';
  throw relayError_('slack_' + r.error, 'チャンネルに招待できませんでした（' + r.error + '）');
}

function channelName_(channel) {
  var r = slack_('conversations.info', { channel: channel });
  return r.ok ? r.channel.name : '';
}

function isMember_(channel, user) {
  var cursor = '';
  for (var i = 0; i < 10; i++) {
    var p = { channel: channel, limit: 200 };
    if (cursor) p.cursor = cursor;
    var r = slack_('conversations.members', p);
    if (!r.ok) return false;
    if ((r.members || []).indexOf(user) >= 0) return true;
    cursor = (r.response_metadata || {}).next_cursor || '';
    if (!cursor) return false;
  }
  return false;
}

function findPrivateChannel_(name) {
  var cursor = '';
  for (var i = 0; i < 20; i++) {
    var p = { types: 'private_channel', exclude_archived: true, limit: 200 };
    if (cursor) p.cursor = cursor;
    var r = slack_('conversations.list', p);
    if (!r.ok) return '';
    for (var j = 0; j < (r.channels || []).length; j++) if (r.channels[j].name === name) return r.channels[j].id;
    cursor = (r.response_metadata || {}).next_cursor || '';
    if (!cursor) return '';
  }
  return '';
}

// ---------------------------------------------------------------- Slack

function botToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!t) throw relayError_('no_bot_token', '窓口に Botトークンが設定されていません。管理者に連絡してください');
  return t;
}

function slack_(method, params) {
  var token = botToken_();
  // フォーム形式で送る。conversations.info / members / list などの読み取り系は JSON の本文を受け付けない
  var form = {};
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) form[k] = String(params[k]);
  });
  for (var attempt = 0; attempt < 4; attempt++) {
    var res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      payload: form,
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 429 && attempt < 3) {
      var wait = Number((res.getHeaders() || {})['Retry-After'] || 5);
      Utilities.sleep(Math.min(Math.max(wait, 1), 30) * 1000);
      continue;
    }
    if (code >= 400) return { ok: false, error: 'http_' + code };
    return JSON.parse(res.getContentText());
  }
  return { ok: false, error: 'ratelimited' };
}

function postMessage_(ss, channel, text, threadTs) {
  var s = settings_(ss);
  var p = { channel: channel, text: text, reply_broadcast: false, unfurl_links: false, unfurl_media: false };
  if (threadTs) p.thread_ts = threadTs;
  // 表示名とアイコンは投稿ごとに渡す（App の設定だけでは反映されないことがあるため）
  p.username = s.bot_username || 'ミエタスク';
  if (s.bot_icon_url) p.icon_url = s.bot_icon_url;
  var r = slack_('chat.postMessage', p);
  if (!r.ok && (r.error === 'missing_scope' || r.error === 'not_allowed_token_type')) {
    delete p.username; delete p.icon_url; // 表示名の指定だけが原因なら、名前を諦めて投稿は通す
    r = slack_('chat.postMessage', p);
  }
  if (!r.ok) throw relayError_('slack_' + r.error, 'Slack が投稿を拒否しました（' + r.error + '）');
  return r.ts;
}

// ================================================================ 管理者のメニュー（スプレッドシートから）

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ミエタスク')
    .addItem('選んだ人の鍵を発行する（DMで送る）', 'menuIssueKey')
    .addItem('選んだ人の鍵を無効にする', 'menuRevokeKey')
    .addSeparator()
    .addItem('選んだチームのまとめチャンネルを作る', 'menuCreateTeamChannel')
    .addItem('選んだチームの管理者をまとめチャンネルに招待する', 'menuInviteManagers')
    .addSeparator()
    .addItem('選んだ人の投稿先をアーカイブする（停止の人だけ）', 'menuArchiveMember')
    .addSeparator()
    .addItem('Botトークンを設定する', 'menuSetBotToken')
    .addItem('シートを整える', 'setupSheets')
    .addToUi();
}

function selectedRow_(def) {
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== def.name) throw new Error('「' + def.name + '」シートで、対象の行を選んでから実行してください');
  var row = sh.getActiveRange().getRow();
  if (row < 2) throw new Error('見出しではなく、対象の行を選んでください');
  var rows = rows_(SpreadsheetApp.getActiveSpreadsheet(), def);
  var r = rows[row - 2];
  if (!r) throw new Error('選んだ行が空です');
  return { row: row, r: r };
}

function menu_(fn) {
  var ui = SpreadsheetApp.getUi();
  try {
    var msg = fn(ui);
    if (msg) ui.alert(msg);
  } catch (err) {
    ui.alert('できませんでした: ' + (err && err.message ? err.message : err));
  }
}

function menuIssueKey() { menu_(function (ui) { return issueKey_(ui, selectedRow_(SHEETS.members)); }); }
function menuRevokeKey() { menu_(function () { return revokeKey_(selectedRow_(SHEETS.members)); }); }
function menuCreateTeamChannel() { menu_(function () { return createTeamChannel_(selectedRow_(SHEETS.teams)); }); }
function menuInviteManagers() { menu_(function () { return inviteManagers_(selectedRow_(SHEETS.teams)); }); }
function menuArchiveMember() { menu_(function () { return archiveMember_(selectedRow_(SHEETS.members)); }); }

function menuSetBotToken() {
  menu_(function (ui) {
    var res = ui.prompt('Botトークンを設定する',
      'Slack アプリの「OAuth & Permissions」にある Bot User OAuth Token（xoxb- で始まる）を貼り付けてください。\n' +
      'スクリプトの中にだけ保存され、メンバーには配られません。', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return null;
    return setBotToken_(res.getResponseText());
  });
}

function setBotToken_(raw) {
  var token = String(raw || '').trim();
  if (token.indexOf('xoxb-') !== 0) throw new Error('xoxb- で始まる Bot User OAuth Token ではありません');
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperty('SLACK_BOT_TOKEN');
  props.setProperty('SLACK_BOT_TOKEN', token);
  var r = slack_('auth.test', {});
  if (!r.ok) {
    if (old) props.setProperty('SLACK_BOT_TOKEN', old); else props.deleteProperty('SLACK_BOT_TOKEN');
    throw new Error('Slack に拒否されました（' + r.error + '）。保存していません');
  }
  return 'Botトークンを保存しました（' + r.team + ' / ' + r.user + '）';
}

function issueKey_(ui, sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = memberFromRow_(sel.r, sel.row);
  if (!/^[UW][A-Z0-9]+$/.test(m.slack_id)) throw new Error('Slack ID が入っていません');
  if (m.status === STOPPED) throw new Error(m.name + ' さんは「停止」です。鍵は発行できません');
  var url = settings_(ss).relay_url;
  if (!url) throw new Error('「設定」シートに relay_url（この窓口のURL）がありません');

  var secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('KEY_' + m.slack_id, sha256_(secret)); // 前の鍵はここで効かなくなる
  var key = KEY_PREFIX + base64url_(JSON.stringify({ u: url, i: m.slack_id, k: secret }));
  setCell_(ss, SHEETS.members, m.row, '鍵', '発行 ' + nowJst_().slice(0, 10));

  deleteKeyMessage_(m.slack_id);
  var text = ':key: *ミエタスクの鍵*（' + m.name + ' さん専用）\n' +
    'Claude Code で `/mietask:setup` と打ち、入力欄が出たら、下の鍵をそのまま貼ってください。\n' +
    '```' + key + '```\n' +
    'この鍵はほかの人に渡さないでください。セットアップが終わると、このメッセージは自動で消えます。';
  // 表示名（username）は指定しない。指定すると Slack は Bot の入っていない別の DM に置き、あとで消せなくなる
  var r = slack_('chat.postMessage', { channel: m.slack_id, text: text });
  if (r.ok) {
    props.setProperty('KEYMSG_' + m.slack_id, JSON.stringify({ channel: r.channel, ts: r.ts }));
    return m.name + ' さんに鍵を DM で送りました。前の鍵があれば、それはもう使えません。';
  }
  // DM を送れない（Slack アプリの権限が足りない等）。管理者に見せて、手で渡してもらう
  var html = HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif;font-size:13px">DM を送れませんでした（' + r.error + '）。<br>' +
    '下の鍵をコピーして、' + m.name + ' さんに Slack の DM などで渡してください。</p>' +
    '<textarea readonly style="width:100%;height:110px;font-family:monospace">' + key + '</textarea>')
    .setWidth(520).setHeight(240);
  ui.showModalDialog(html, 'ミエタスクの鍵（' + m.name + ' さん）');
  return null;
}

function revokeKey_(sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = memberFromRow_(sel.r, sel.row);
  PropertiesService.getScriptProperties().deleteProperty('KEY_' + m.slack_id);
  deleteKeyMessage_(m.slack_id);
  setCell_(ss, SHEETS.members, m.row, '鍵', '無効 ' + nowJst_().slice(0, 10));
  return m.name + ' さんの鍵を無効にしました。この時点から窓口は使えません。';
}

function createTeamChannel_(sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = sel.r['チームID'];
  if (!id) throw new Error('チームIDが入っていません');
  if (sel.r['まとめチャンネル']) throw new Error('すでにまとめチャンネルがあります（' + sel.r['まとめチャンネル'] + '）');
  var name = 'ミエタスク-' + id.toLowerCase();
  var r = slack_('conversations.create', { name: name, is_private: true });
  if (!r.ok) throw new Error('チャンネルを作れませんでした（' + r.error + '）');
  setCell_(ss, SHEETS.teams, sel.row, 'まとめチャンネル', r.channel.id);
  var notes = list_(sel.r['管理者']).map(function (u) {
    try { return u + ': ' + invite_(r.channel.id, u); } catch (err) { return u + ': ' + err.message; }
  });
  return '#' + r.channel.name + ' を作りました。\n' + (notes.join('\n') || '管理者が入っていないので、招待はしていません');
}

function inviteManagers_(sel) {
  var ch = sel.r['まとめチャンネル'];
  if (!ch) throw new Error('まとめチャンネルがまだありません');
  var notes = list_(sel.r['管理者']).map(function (u) {
    try { return u + ': ' + invite_(ch, u); } catch (err) { return u + ': ' + err.message; }
  });
  return (notes.join('\n') || '管理者が入っていません') + '\n\n前の管理者をチャンネルから外すのは、Slack の画面から行ってください（Bot は人を外せません）。';
}

function archiveMember_(sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = memberFromRow_(sel.r, sel.row);
  if (m.status !== STOPPED) throw new Error(m.name + ' さんは「停止」になっていません。先に状態を「停止」にしてください');
  if (!m.channel) throw new Error(m.name + ' さんの投稿先が記録されていません');
  var r = slack_('conversations.archive', { channel: m.channel });
  if (!r.ok && r.error !== 'already_archived') throw new Error('アーカイブできませんでした（' + r.error + '）');
  PropertiesService.getScriptProperties().deleteProperty('KEY_' + m.slack_id);
  setCell_(ss, SHEETS.members, m.row, '鍵', '無効 ' + nowJst_().slice(0, 10));
  return m.name + ' さんの投稿先をアーカイブし、鍵も無効にしました（Slack の画面から元に戻せます）。';
}

function deleteKeyMessage_(slackId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('KEYMSG_' + slackId);
  if (!raw) return;
  try {
    var m = JSON.parse(raw);
    slack_('chat.delete', { channel: m.channel, ts: m.ts });
  } catch (err) { /* 消せなくても続ける */ }
  props.deleteProperty('KEYMSG_' + slackId);
}

/** シートと見出しを作る。既にあるものは消さない。足りない見出しは右端に足す */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (k) { sheet_(ss, SHEETS[k]); });
  var members = sheet_(ss, SHEETS.members);
  var col = indexOf_(members.getRange(1, 1, 1, members.getLastColumn()).getValues()[0]);
  members.getRange(2, col['状態'] + 1, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['有効', STOPPED], true).build());
  var settings = sheet_(ss, SHEETS.settings);
  var have = settings_(ss);
  var defaults = { relay_url: '', workspace: '', bot_username: 'ミエタスク', bot_icon_url: '', notion_projects: '', notion_tasks: '' };
  Object.keys(defaults).forEach(function (k) {
    if (!(k in have)) settings.appendRow([k, defaults[k]]);
  });
}

// ================================================================ 共通

function relayError_(code, message) {
  var e = new Error(message);
  e.relay = true;
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function settings_(ss) {
  return rows_(ss, SHEETS.settings).reduce(function (acc, r) {
    if (r['項目']) acc[r['項目']] = r['値'];
    return acc;
  }, {});
}

function publicSettings_(ss) {
  var s = settings_(ss);
  return { workspace: s.workspace || '' };
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function base64url_(s) {
  return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function nowJst_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function sheet_(ss, def) {
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  def.headers.forEach(function (h) {
    if (head.indexOf(h) < 0) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      head.push(h);
    }
  });
  return sh;
}

function indexOf_(headerRow) {
  var col = {};
  headerRow.forEach(function (h, i) { col[String(h).trim()] = i; });
  return col;
}

function setCell_(ss, def, row, header, value) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(ss, def);
    var col = indexOf_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
    if (col[header] === undefined) return;
    sh.getRange(row, col[header] + 1).setValue(value);
  } finally {
    lock.releaseLock();
  }
}

function rows_(ss, def) {
  var sh = ss.getSheetByName(def.name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getDisplayValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).map(function (v) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[h] = String(v[i] === undefined ? '' : v[i]).trim(); });
    return o;
  });
}

function list_(s) {
  return String(s || '').split(/[,、，\s]+/).map(function (x) { return x.trim(); }).filter(String);
}
