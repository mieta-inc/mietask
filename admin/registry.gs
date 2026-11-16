/**
 * ミエタスク 管理台帳の窓口（Google Apps Script）
 *
 * 管理台帳のスプレッドシートに付けて、ウェブアプリとして公開する。役目は2つ。
 *
 * 1. 各メンバーの mietask の窓口
 *    メンバーは一人ずつ別の鍵を持つ。窓口は鍵を確かめてから、その人の代わりに Slack へ投稿する。
 *    Botトークンはこのスクリプトの中（スクリプト プロパティ）にだけ置き、メンバーには配らない。
 *    メンバーが投稿できるのは、本人の投稿先だけ。チームのまとめチャンネルには各自の一覧を出さない
 *    （タスクの題名には DM・非公開チャンネル・メールの内容が入るため）。各自からは毎朝、
 *    案件ごとの要約（案件名・状態・次の期限）を受け取り、チームのまとめに出す。同じものが本人のチャンネルにも出る。
 *    あわせて件数（超過・今日・今週）も受け取り「日々の状態」シートに残す。件数は動作の点検用で、
 *    見られるのはシステム管理者だけ（チームの管理者の状態把握には使わない。案件ごとに重さが違うため）。
 *    台帳で「停止」にした人、鍵を無効にした人は、その時点から何もできなくなる。
 *
 * 2. 管理者のメニュー（スプレッドシートの「ミエタスク」メニュー）
 *    鍵の発行（Bot から本人に DM で届ける）、鍵の無効化、まとめチャンネルの作成、管理者の招待、
 *    退職者の投稿先の片付け。スプレッドシートを編集できる人が管理者になる。
 *
 * 3. チームのまとめ（平日の朝、まとめチャンネルへ。祝日は出さない）
 *    MTD（Notion）のプログラムの案件と、各自のミエタスクが送る案件ごとの要約（社内の案件・リードしている仕事など、
 *    MTD に出てこないもの）を合わせて、メンバーごとに出す。ミエタスクのタスクの題名・件数は使わない。
 *    Notion の鍵はスクリプト プロパティ（NOTION_TOKEN）にだけ置く。
 *    出す前に、まとめチャンネルが非公開で、参加者が管理者・システム管理者・Bot だけかを確かめる。
 *
 * ■ 最初の1回
 *   1. スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの中身を貼る
 *   2. 関数 setupSheets を実行する（シートと見出しを作る）
 *   3. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *      出てきた URL を「設定」シートの relay_url に入れる
 *   4. スプレッドシートを開き直し、「ミエタスク → Botトークンを設定する」でトークンを入れる
 *   5. メンバーの行を選んで「ミエタスク → 選んだ人の鍵を発行する」
 *   6. （チームのまとめを出すとき）Notion でインテグレーションを作り、MTD のプロジェクトDB・タスクDBに接続する。
 *      「ミエタスク → Notionの鍵を設定する」で鍵を入れ、チームの行を選んで「まとめを試しに作る」で中身を確かめてから
 *      「毎朝のまとめを始める」
 *
 * ■ シート（見出しの名前で列を探すので、列の並べ替えや列の追加をしても壊れない）
 *   メンバー: 名前 / Slack ID / メール / チーム / 状態 / Notion ユーザー / 投稿先 / 鍵 / 最後に動いた / バージョン / メモ
 *             チームはチームIDをカンマ区切り（例: pm,pm1）。状態は「有効」か「停止」
 *             Notion ユーザーは user://… （管理者の画面が MTD の担当を引くのに使う。空ならメールで探す）
 *             投稿先・鍵・最後に動いた・バージョンは、このスクリプトが書く
 *   チーム:   チームID / 表示名 / 親チーム / まとめチャンネル / 管理者 / メモ
 *             親チームに pm と書けば、PM の管理者の画面に PM1 も入る。管理者は Slack ID をカンマ区切り
 *   日々の状態: 日付 / Slack ID / 名前 / 超過 / 今日 / 今週 / 届いた時刻
 *             各自のミエタスクが毎朝送る件数。このスクリプトが書く。件数のほかは受け取らない
 *   案件の要約: 日付 / Slack ID / 名前 / 要約 / 届いた時刻
 *             各自のミエタスクが毎朝送る、案件ごとの状態（案件名・状態・次の期限）。このスクリプトが書く。
 *             タスクの題名・メールや DM の文面は受け取らない。チームのまとめと管理者の画面に出る
 *   設定:     項目 / 値
 *             relay_url（この窓口の URL）・workspace（Slack のワークスペース名）・bot_username・bot_icon_url・
 *             notion_projects・notion_tasks（MTD の場所）・
 *             system_admins（システム管理者の Slack ID。カンマ区切り。全チームの管理者向けの情報と、
 *             点検用の件数を見られる。不具合のときに確かめるため）
 */

var SHEETS = {
  members: {
    name: 'メンバー',
    headers: ['名前', 'Slack ID', 'メール', 'チーム', '状態', 'Notion ユーザー', '投稿先', '鍵', '最後に動いた', 'バージョン', 'メモ'],
  },
  teams: { name: 'チーム', headers: ['チームID', '表示名', '親チーム', 'まとめチャンネル', '管理者', 'メモ'] },
  daily: { name: '日々の状態', headers: ['日付', 'Slack ID', '名前', '超過', '今日', '今週', '届いた時刻'] },
  shares: { name: '案件の要約', headers: ['日付', 'Slack ID', '名前', '要約', '届いた時刻'] },
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

  // 親＋子スレッドを、本人の投稿先に投稿する（稼働も記録する）
  post: function (ctx, body) {
    var channel = String(body.channel || '');
    if (!channel) throw relayError_('bad_request', '投稿先がありません');
    if (!allowedChannel_(ctx, channel)) {
      throw relayError_('forbidden_channel', 'この投稿先には投稿できません（本人の投稿先だけ。チームのまとめには件数だけが届きます）');
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

  // 案件ごとの要約を受け取る（チームのまとめに出す）。案件名・状態・次の期限だけを残し、ほかは捨てる。
  // 本人の手元で、タスクの題名やメール・DM の文面を入れずに作ったもの。同じものが本人のチャンネルにも出ている
  share: function (ctx, body) {
    var items = cleanShare_(body.items);
    var now = nowJst_();
    upsertDaily_(ctx, SHEETS.shares, now.slice(0, 10), { '要約': JSON.stringify(items) }, now);
    touch_(ctx, body);
    return { items: items.length };
  },

  // その日の件数（超過・今日・今週）を受け取る。システム管理者が動作を点検するのに使う
  // （急に0件になった人がいれば、巡回が壊れているかもしれない）。チームの管理者には見せない。
  // 件数のほか（題名・メモ・出どころ）は、送られてきても受け取らない。
  status: function (ctx, body) {
    var c = body.counts || {};
    var now = nowJst_();
    recordDaily_(ctx, now.slice(0, 10), { '超過': count_(c.overdue), '今日': count_(c.today), '今週': count_(c.week) }, now);
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
function isSystemAdmin_(ss, slackId) {
  return list_(settings_(ss).system_admins).indexOf(slackId) >= 0;
}

// 管理者に返す中身。チームの管理者には、管理しているチームとその下のチームの人を返す。
// システム管理者には、全チームの人と、点検用の件数（直近8日）も返す。
function managedView_(ctx) {
  var teams = allTeams_(ctx.ss);
  var admin = isSystemAdmin_(ctx.ss, ctx.member.slack_id);
  var mine = admin ? teams : teams.filter(function (t) { return t.managers.indexOf(ctx.member.slack_id) >= 0; });
  if (!mine.length && !admin) return null;
  var ids = {};
  mine.forEach(function (t) { subtree_(teams, t.id).forEach(function (id) { ids[id.toLowerCase()] = true; }); });
  var members = rows_(ctx.ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (m) { return m.slack_id && m.teams.some(function (t) { return ids[t.toLowerCase()]; }); })
    .map(function (m) { delete m.row; return m; });
  var settings = settings_(ctx.ss);
  var out = {
    teams: teams.filter(function (t) { return ids[t.id.toLowerCase()]; }),
    members: members,
    settings: { notion_projects: settings.notion_projects || '', notion_tasks: settings.notion_tasks || '' },
    system_admin: admin,
  };
  // 案件ごとの要約（ミエタスクから）。担当チームの人の分だけ、直近8日以内のもの
  var shares = latestShares_(ctx.ss);
  var since8 = addDays_(nowJst_().slice(0, 10), -7);
  out.shared = members.filter(function (m) { return shares[m.slack_id] && shares[m.slack_id].date >= since8; })
    .map(function (m) {
      var sh = shares[m.slack_id];
      return { slack_id: m.slack_id, name: m.name, date: sh.date, at: sh.at, items: sh.items };
    });
  if (admin) {
    // 点検用の件数はシステム管理者にだけ返す
    var since = addDays_(nowJst_().slice(0, 10), -7);
    out.daily = rows_(ctx.ss, SHEETS.daily)
      .filter(function (r) { return r['日付'] >= since; })
      .map(function (r) {
        return { date: r['日付'], slack_id: r['Slack ID'], name: r['名前'],
          overdue: count_(r['超過']), today: count_(r['今日']), week: count_(r['今週']), at: r['届いた時刻'] };
      });
  }
  return out;
}

function allowedChannel_(ctx, channel) {
  // メンバーが投稿できるのは本人の投稿先だけ。チームのまとめに各自の一覧を出さない
  return !!channel && channel === ctx.member.channel;
}

// ---------------------------------------------------------------- 日々の状態（件数だけ）

function count_(v) {
  var n = Math.floor(Number(v));
  return isFinite(n) && n >= 0 ? Math.min(n, 9999) : 0;
}

function recordDaily_(ctx, date, counts, at) {
  upsertDaily_(ctx, SHEETS.daily, date, counts, at);
}

// 1人1日1行。同じ日に2回届いたら（手で回し直したときなど）上書きする
function upsertDaily_(ctx, def, date, fields, at) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(ctx.ss, def);
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var col = indexOf_(head);
    var row = -1;
    if (sh.getLastRow() >= 2) {
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getDisplayValues();
      for (var i = 0; i < vals.length; i++) {
        if (vals[i][col['日付']] === date && vals[i][col['Slack ID']] === ctx.member.slack_id) { row = i + 2; break; }
      }
    }
    var rec = { '日付': date, 'Slack ID': ctx.member.slack_id, '名前': ctx.member.name, '届いた時刻': at };
    Object.keys(fields).forEach(function (k) { rec[k] = fields[k]; });
    var line = head.map(function (h) { return h in rec ? rec[h] : ''; });
    if (row < 0) row = sh.getLastRow() + 1;
    // 日付を文字列のまま置く（スプレッドシートが日付に変えると、見た目が変わって同じ日を探せなくなる）
    sh.getRange(row, col['日付'] + 1).setNumberFormat('@');
    sh.getRange(row, 1, 1, line.length).setValues([line]);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- 案件の要約（ミエタスクから）

var SHARE_STATES = ['動いている', '相手待ち', '期限が過ぎたものあり'];
var SHARE_MAX = 12;

// 決まった形のものだけを受け取る。リンク・メールアドレス・メンションは入れさせない（中身が漏れる入口になるため）
function cleanShare_(raw) {
  if (!Array.isArray(raw)) throw relayError_('bad_share', '要約（items）がありません');
  if (raw.length > SHARE_MAX) throw relayError_('bad_share', '要約は' + SHARE_MAX + '件までです');
  return raw.map(function (it, i) {
    var where = 'items[' + i + ']';
    var name = String((it && it.name) || '').trim();
    if (!name) throw relayError_('bad_share', where + ' の案件名が空です');
    if (name.length > 40) throw relayError_('bad_share', where + ' の案件名が長すぎます（40文字まで）');
    if (/[\r\n<>@]|https?:/i.test(name)) throw relayError_('bad_share', where + ' の案件名に改行・リンク・メンション・メールアドレスは入れられません');
    var state = String(it.state || '');
    if (SHARE_STATES.indexOf(state) < 0) throw relayError_('bad_share', where + ' の状態は ' + SHARE_STATES.join('・') + ' のどれかです');
    var due = String(it.due || '');
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw relayError_('bad_share', where + ' の期限は yyyy-MM-dd です');
    return { name: name, state: state, due: due };
  });
}

// メンバーごとの最新の要約（Slack ID → {date, at, items}）
function latestShares_(ss) {
  var out = {};
  rows_(ss, SHEETS.shares).forEach(function (r) {
    var id = r['Slack ID'];
    if (!id || (out[id] && out[id].date >= r['日付'])) return;
    out[id] = { date: r['日付'], at: r['届いた時刻'], items: JSON.parse(r['要約'] || '[]') };
  });
  return out;
}

// 'yyyy-MM-dd' に日数を足す（暦の上の計算。時刻帯に左右されない）
function addDays_(ymd, n) {
  var p = String(ymd).split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
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
    .addItem('選んだチームのまとめを試しに作る（システム管理者にDM）', 'menuTrialRollup')
    .addItem('毎朝のまとめを始める（平日9時台）', 'menuStartRollup')
    .addItem('毎朝のまとめを止める', 'menuStopRollup')
    .addSeparator()
    .addItem('Botトークンを設定する', 'menuSetBotToken')
    .addItem('Notionの鍵を設定する', 'menuSetNotionToken')
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
  var defaults = { relay_url: '', workspace: '', bot_username: 'ミエタスク', bot_icon_url: '', notion_projects: '', notion_tasks: '', system_admins: '' };
  Object.keys(defaults).forEach(function (k) {
    if (!(k in have)) settings.appendRow([k, defaults[k]]);
  });
}

// ================================================================ チームのまとめ（MTD の案件と状態）
//
// 平日の朝、チームごとに「誰がどの案件を持っていて、それぞれ今何を作っているか」をまとめチャンネルに出す。
// 出どころは MTD（Notion のプロジェクトDBとタスクDB）だけ。各自のミエタスクの中身も件数も使わない
// （題名に DM・非公開チャンネル・メールの内容が入るため。件数は案件ごとに重さが違い、状態を表さないため）。
// MTD の外の仕事は見えないので、毎回そう書き添える。見立て（空く・余裕がある）は書かない。
//
// 投稿の前に、まとめチャンネルが非公開で、参加者が「そのチームの管理者・システム管理者・Bot」だけかを確かめる。
// ほかの人が入っていたら投稿せず、システム管理者に DM で知らせる。

var NOTION_VERSION = '2025-09-03';
var ROLLUP_HOUR = 9; // 平日（祝日を除く）のこの時台に出す（時間主導のトリガーは時台の中のどこかで動く）
var MOVING = ['進行中', '継続', '確認待ち']; // 今動いているタスク
var STUCK = ['確認待ち', '保留']; // 詰まっていそうなタスク
var ROLES = [['CC担当', 'CC'], ['PM担当', 'PM'], ['SP担当', 'SP'], ['プロジェクトリード', 'リード'], ['連携メンバー', '連携']];
var COUNTED = ['CC', 'PM', 'SP']; // 並行の数に入れる役割（リード・連携は社内案件・手伝いが多いので、別に出す）
var UNREADABLE = '（読めない案件）'; // インテグレーションが接続されていないページ
var PARENT_MAX = 4; // 一覧の1行に名前を出す案件の数（残りは「ほかN件」）
var ROLLUP_FOOTER = '一人ずつの案件はスレッドに。出どころはMTD（Notion）と、各自のミエタスクが送る案件ごとの状態です（タスクの題名・メールやDMの中身は入っていません）。';

// ---------------------------------------------------------------- Notion

function notionToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!t) throw relayError_('no_notion_token', 'Notion の鍵が設定されていません（ミエタスク → Notionの鍵を設定する）');
  return t;
}

function notion_(method, path, body) {
  var opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + notionToken_(), 'Notion-Version': NOTION_VERSION },
    muteHttpExceptions: true,
  };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  for (var attempt = 0; attempt < 4; attempt++) {
    var res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, opts);
    var code = res.getResponseCode();
    if ((code === 429 || code >= 500) && attempt < 3) {
      var wait = Number((res.getHeaders() || {})['Retry-After'] || 2);
      Utilities.sleep(Math.min(Math.max(wait, 1), 30) * 1000);
      continue;
    }
    var out = {};
    try { out = JSON.parse(res.getContentText() || '{}'); } catch (err) { out = {}; }
    if (code >= 400) {
      var e = relayError_('notion_' + (out.code || code), 'Notion が断りました（' + code + (out.code ? ' ' + out.code : '') + '）' + (out.message ? '：' + out.message : ''));
      e.status = code;
      throw e;
    }
    return out;
  }
  throw relayError_('notion_unavailable', 'Notion が混んでいて読めませんでした');
}

function sourceId_(source) {
  var id = String(source || '').replace(/^collection:\/\//, '').trim();
  if (!id) throw relayError_('no_notion_source', '「設定」シートに MTD の場所（notion_projects・notion_tasks）がありません');
  return id;
}

// 条件に合うページを全部読む（1人ぶんの案件・タスクなので、2000件で打ち切っても届かない）
function notionQuery_(source, filter) {
  var id = sourceId_(source);
  var pages = [], cursor = null;
  for (var i = 0; i < 20; i++) {
    var body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    var r = notion_('post', 'data_sources/' + id + '/query', body);
    pages = pages.concat(r.results || []);
    if (!r.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return pages;
}

// Notion の ID は「-」の有無が混ざるので、比べるときは 32桁の小文字にそろえる
function nid_(s) { return String(s || '').replace(/^user:\/\//, '').replace(/-/g, '').toLowerCase(); }

function uuid_(s) {
  var h = nid_(s);
  if (!/^[0-9a-f]{32}$/.test(h)) return '';
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}

function richText_(arr) {
  return (arr || []).map(function (t) { return t.plain_text || ''; }).join('').replace(/\s+/g, ' ').trim();
}

// 題名の列は名前が空のことがある（MTD のプロジェクトDB）ので、種類で探す
function pageTitle_(page) {
  var props = page.properties || {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) if (props[keys[i]] && props[keys[i]].type === 'title') return richText_(props[keys[i]].title);
  return '';
}

function prop_(page, name) {
  var p = (page.properties || {})[name];
  if (!p) return null;
  switch (p.type) {
    case 'people': return (p.people || []).map(function (u) { return nid_(u.id); });
    case 'relation': return (p.relation || []).map(function (r) { return nid_(r.id); });
    case 'status': return p.status ? p.status.name : '';
    case 'select': return p.select ? p.select.name : '';
    case 'date': return { start: String((p.date && p.date.start) || '').slice(0, 10), end: String((p.date && p.date.end) || '').slice(0, 10) };
    case 'title': return richText_(p.title);
    case 'rich_text': return richText_(p.rich_text);
  }
  return null;
}

function projectFromPage_(page, uid) {
  var me = nid_(uid);
  var period = prop_(page, '期間') || {}, first = prop_(page, '授業初日') || {};
  return {
    id: nid_(page.id),
    name: pageTitle_(page) || '（名前なし）',
    kind: prop_(page, 'プログラム種別') || '',
    status: prop_(page, 'ステータス') || '',
    roles: ROLES.filter(function (r) { return (prop_(page, r[0]) || []).indexOf(me) >= 0; }).map(function (r) { return r[1]; }),
    start: period.start || first.start || '',
    end: period.end || '',
    first: first.start || '',
  };
}

function taskFromPage_(page) {
  return { name: pageTitle_(page) || '（名前なし）', status: prop_(page, 'ステータス') || '', projects: prop_(page, 'プログラム') || [] };
}

// MTD を読む道具。同じ人を何度も読まないよう、1回の実行の中で覚えておく
function notionReader_(ss) {
  var s = settings_(ss);
  var cache = { projects: {}, tasks: {}, titles: {} };
  var statuses = MOVING.concat(STUCK).filter(function (x, i, a) { return a.indexOf(x) === i; });
  return {
    projects: function (uid) {
      var key = nid_(uid);
      if (!cache.projects[key]) {
        var id = uuid_(uid);
        cache.projects[key] = notionQuery_(s.notion_projects, {
          or: ROLES.map(function (r) { return { property: r[0], people: { contains: id } }; }),
        }).map(function (pg) { return projectFromPage_(pg, uid); });
      }
      return cache.projects[key];
    },
    tasks: function (uid) {
      var key = nid_(uid);
      if (!cache.tasks[key]) {
        cache.tasks[key] = notionQuery_(s.notion_tasks, {
          and: [
            { property: '担当者', people: { contains: uuid_(uid) } },
            { or: statuses.map(function (st) { return { property: 'ステータス', status: { equals: st } }; }) },
          ],
        }).map(taskFromPage_);
      }
      return cache.tasks[key];
    },
    // 担当ではない案件の名前（そこでタスクを持っているとき）
    title: function (pid) {
      if (!(pid in cache.titles)) {
        try { cache.titles[pid] = pageTitle_(notion_('get', 'pages/' + uuid_(pid))) || '（名前なし）'; }
        catch (err) { cache.titles[pid] = UNREADABLE; }
      }
      return cache.titles[pid];
    },
  };
}

// ---------------------------------------------------------------- まとめの中身（ここは読むだけ。純粋な計算）

function md_(ymd) {
  var p = String(ymd || '').split('-');
  return p.length === 3 ? Number(p[1]) + '/' + Number(p[2]) : '';
}

// 2か月より前・半年より先の日付は年も書く（「〜5/29」が去年か来年か分からなくなるため）
function dateLabel_(ymd, today) {
  if (!ymd) return '';
  if (ymd < addDays_(today, -60) || ymd > addDays_(today, 180)) return Number(ymd.slice(0, 4)) + '/' + md_(ymd);
  return md_(ymd);
}

function uniq_(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }

function byEnd_(a, b) { return (a.end || '9999') < (b.end || '9999') ? -1 : (a.end || '9999') > (b.end || '9999') ? 1 : 0; }
function byStart_(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }

// 1人ぶんの状態。期間で分ける（ステータスは期間が過ぎても「進行中」のままのことが多いため）
function memberState_(projects, tasks, today, titleOf) {
  var live = projects.filter(function (p) { return p.status !== '中止'; });
  var mine = {};
  live.forEach(function (p) { mine[p.id] = p; });
  var isRun = function (p) {
    return !!p.start && p.start <= today && (p.end ? p.end >= today : !!p.first && p.first >= addDays_(today, -120));
  };
  var counted = live.filter(function (p) { return p.roles.some(function (r) { return COUNTED.indexOf(r) >= 0; }); });
  var running = counted.filter(isRun).sort(byEnd_);
  var leading = live.filter(function (p) { return counted.indexOf(p) < 0 && isRun(p); }).sort(byEnd_);
  var starting = counted.filter(function (p) { return p.start > today && p.start <= addDays_(today, 60); }).sort(byStart_);
  var ending = running.filter(function (p) { return p.end && p.end <= addDays_(today, 30); });
  // 期間が過ぎた案件（タスクが閉じられずに残っていることが多い。今の仕事としては数えない）
  var past = {};
  live.forEach(function (p) { if (!isRun(p) && p.start && p.start <= today) past[p.id] = true; });

  var moving = {}, elsewhere = {}, outside = [], stuck = [], stuckIn = {};
  tasks.forEach(function (t) {
    var pids = t.projects.length ? t.projects : [''];
    pids.forEach(function (pid) {
      var where = !pid ? '' : mine[pid] ? mine[pid].name : titleOf(pid);
      if (STUCK.indexOf(t.status) >= 0) {
        stuck.push({ where: where, task: t.name, status: t.status });
        if (mine[pid] && stuckIn[pid] !== '確認待ち') stuckIn[pid] = t.status;
      }
      if (MOVING.indexOf(t.status) < 0) return;
      if (!pid) outside.push(t.name);
      else if (mine[pid]) (moving[pid] = moving[pid] || []).push(t.name);
      else (elsewhere[pid] = elsewhere[pid] || { name: where, tasks: [] }).tasks.push(t.name);
    });
  });

  var history = {};
  counted.forEach(function (p) { if (p.kind) history[p.kind] = (history[p.kind] || 0) + 1; });
  var others = outside.length + Object.keys(elsewhere).reduce(function (n, k) { return n + elsewhere[k].tasks.length; }, 0);
  return { today: today, projects: live, running: running, leading: leading, starting: starting, ending: ending, past: past,
    moving: moving, elsewhere: elsewhere, outside: uniq_(outside), others: others, stuck: stuck, stuckIn: stuckIn, history: history,
    hasTasks: tasks.length > 0 };
}

// 1人ぶんの案件を、出どころ（MTD・ミエタスク）を分けずに1つの並びにする。
// rank の小さい順（気にすべきもの → 動いているもの → 担当外 → これから始まるもの）、同じ rank は期限・終了日の近い順。
// short は一覧の1行に添える短い説明、long はスレッドの1行に出す説明。
var RANK = { overdue: 0, waiting: 1, running: 2, helping: 3, starting: 4 };

function periodLabel_(p, today) {
  return p.end ? '〜' + dateLabel_(p.end, today) : p.start ? dateLabel_(p.start, today) + '〜' : '';
}

function mtdItems_(st) {
  if (!st) return [];
  var items = [];
  var current = st.running.concat(st.leading);
  current.forEach(function (p) {
    var role = p.roles.join('・');
    var period = periodLabel_(p, st.today);
    var stuck = st.stuckIn[p.id] ? st.stuckIn[p.id] + 'あり' : '';
    var state = stuck || (st.moving[p.id] ? '動いている' : '');
    items.push({
      name: p.name, rank: stuck ? RANK.waiting : RANK.running, due: p.end || '',
      short: [role, period, stuck].filter(String).join('・'),
      long: [role, state].filter(String).join('・') + (period ? '（' + period + '）' : ''),
    });
  });
  var unreadable = 0;
  Object.keys(st.elsewhere).forEach(function (k) {
    var o = st.elsewhere[k];
    if (o.name === UNREADABLE) { unreadable++; return; }
    items.push({ name: o.name, rank: RANK.helping, due: '', short: '担当外', long: '担当外・タスク' + o.tasks.length + '件' });
  });
  // 名前を読めない案件は1つにまとめる（並べても何の案件か分からないため）
  if (unreadable) {
    items.push({ name: '名前を読めない案件', rank: RANK.helping, due: '', short: '担当外・' + unreadable + '件',
      long: '担当外・' + unreadable + '件（Notion のインテグレーションが接続されていない）' });
  }
  st.starting.forEach(function (p) {
    var role = p.roles.join('・');
    var from = dateLabel_(p.start, st.today) + '〜';
    items.push({ name: p.name, rank: RANK.starting, due: p.start,
      short: [role, from].filter(String).join('・'), long: [role, 'これから'].filter(String).join('・') + '（' + from + '）' });
  });
  return items;
}

function shareItems_(sh, today) {
  if (!sh || sh.date !== today) return [];
  return sh.items.map(function (it) {
    var due = it.due ? dateLabel_(it.due, today) : '';
    var rank = it.state === '期限が過ぎたものあり' ? RANK.overdue : it.state === '相手待ち' ? RANK.waiting : RANK.running;
    var word = it.state === '期限が過ぎたものあり' ? '期限超過あり' : it.state === '相手待ち' ? '相手待ち' : '';
    return { name: it.name, rank: rank, due: it.due || '',
      short: [word, due ? '期限' + due : ''].filter(String).join('・'), long: it.state + (due ? '（次の期限 ' + due + '）' : '') };
  });
}

function memberItems_(st, sh, today) {
  var items = shareItems_(sh, today).concat(mtdItems_(st));
  return items.map(function (it, i) { it.i = i; return it; }).sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    var da = a.due || '9999', db = b.due || '9999';
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });
}

// 見えていない理由（空いているとは書かない）
function memberNotes_(st, sh, today, linked) {
  var notes = [];
  if (!linked) notes.push('MTD未連携（システム管理者が対応）');
  if (!sh) notes.push('ミエタスク未着');
  else if (sh.date !== today) notes.push('ミエタスクは' + md_(sh.date) + 'から未着');
  return notes.length ? '※' + notes.join('・') : '';
}

function memberLine_(m, items, notes) {
  var shown = items.slice(0, PARENT_MAX).map(function (it) { return it.name + (it.short ? '（' + it.short + '）' : ''); });
  var body = items.length ? shown.join('、') + (items.length > PARENT_MAX ? ' ほか' + (items.length - PARENT_MAX) + '件' : '') : '見える案件なし';
  return '• *' + m.name + '*　' + body + (notes ? '　' + notes : '');
}

// スレッドの見出しに、いま抱えている案件の数を出す（どれくらいやっているかの目安）
function memberCount_(items) {
  var now = items.filter(function (it) { return it.rank !== RANK.starting; }).length;
  var later = items.length - now;
  if (!items.length) return '見える案件なし';
  return '今の案件 ' + now + '件' + (later ? '、これから始まる ' + later + '件' : '');
}

function memberDetail_(m, items, notes) {
  var lines = ['■ *' + m.name + '* — ' + memberCount_(items) + (notes ? '　' + notes : '')];
  items.forEach(function (it) { lines.push('・' + it.name + (it.long ? ' — ' + it.long : '')); });
  return fit_(lines);
}

// Slack の上限を超えないように、末尾の行から削る
function fit_(lines) {
  var out = lines.slice();
  var cut = 0;
  while (out.join('\n').length > MAX_TEXT - 40 && out.length > 1) { out.pop(); cut++; }
  if (cut) out.push('…（長いので' + cut + '行を省きました）');
  return out.join('\n');
}

function teamMembers_(ss, team) {
  var ids = {};
  subtree_(allTeams_(ss), team.id).forEach(function (id) { ids[id.toLowerCase()] = true; });
  return rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (m) { return m.slack_id && m.status !== STOPPED && m.teams.some(function (t) { return ids[t.toLowerCase()]; }); });
}

// チーム1つぶんの投稿（親1本＋1人1スレッド）を作る
function buildRollup_(ss, team, today, reader) {
  var members = teamMembers_(ss, team);
  var shares = latestShares_(ss);
  var lines = [], replies = [];
  members.forEach(function (m) {
    var linked = !!nid_(m.notion_user);
    var st = linked ? memberState_(reader.projects(m.notion_user), reader.tasks(m.notion_user), today, reader.title) : null;
    var sh = shares[m.slack_id] || null;
    var items = memberItems_(st, sh, today);
    var notes = memberNotes_(st, sh, today, linked);
    lines.push(memberLine_(m, items, notes));
    if (items.length) replies.push(memberDetail_(m, items, notes));
  });
  var head = ':busts_in_silhouette: *' + (team.name || team.id) + 'の状況*　' + md_(today) + '時点';
  var parent = fit_([head, ''].concat(lines.length ? lines : ['対象のメンバーがいません'], ['', ROLLUP_FOOTER]));
  return { parent: parent, replies: replies, members: members.length };
}

// ---------------------------------------------------------------- 出す場所の確かめと投稿

// まとめチャンネルに出してよいか。問題があれば理由を返す（無ければ空文字）
function audienceProblem_(ss, team) {
  var info = slack_('conversations.info', { channel: team.channel });
  if (!info.ok) return 'まとめチャンネルを確かめられません（' + info.error + '）';
  if (info.channel.is_archived) return 'まとめチャンネルがアーカイブされています';
  if (!info.channel.is_private) return 'まとめチャンネルが公開チャンネルです（非公開にしか出しません）';
  var bot = slack_('auth.test', {});
  var allowed = team.managers.concat(list_(settings_(ss).system_admins), [bot.user_id || '']);
  var outsiders = [], cursor = '';
  for (var i = 0; i < 10; i++) {
    var p = { channel: team.channel, limit: 200 };
    if (cursor) p.cursor = cursor;
    var r = slack_('conversations.members', p);
    if (!r.ok) return 'まとめチャンネルの参加者を確かめられません（' + r.error + '）';
    (r.members || []).forEach(function (u) { if (allowed.indexOf(u) < 0) outsiders.push(u); });
    cursor = (r.response_metadata || {}).next_cursor || '';
    if (!cursor) break;
  }
  if (outsiders.length) {
    return 'まとめチャンネルに管理者・システム管理者以外の人がいます（' + outsiders.map(function (u) { return '<@' + u + '>'; }).join(' ') + '）';
  }
  return '';
}

function postRollup_(ss, channel, r) {
  var ts = postMessage_(ss, channel, r.parent, null);
  r.replies.forEach(function (t) {
    Utilities.sleep(1100);
    postMessage_(ss, channel, t, ts);
  });
  return ts;
}

// システム管理者に DM で送る（試しの実行と、失敗の知らせ）。表示名は指定しない（鍵の DM と同じ理由）
function dmAdmins_(ss, parent, replies) {
  var admins = list_(settings_(ss).system_admins);
  if (!admins.length) throw new Error('「設定」シートの system_admins にシステム管理者の Slack ID がありません');
  admins.forEach(function (u) {
    var r = slack_('chat.postMessage', { channel: u, text: parent, unfurl_links: false });
    if (!r.ok) throw new Error('システム管理者（' + u + '）に DM を送れませんでした（' + r.error + '）');
    (replies || []).forEach(function (t) {
      Utilities.sleep(1100);
      var c = slack_('chat.postMessage', { channel: r.channel, text: t, thread_ts: r.ts, unfurl_links: false });
      if (!c.ok) throw new Error('システム管理者（' + u + '）への DM の続きを送れませんでした（' + c.error + '）');
    });
  });
  return admins;
}

function todayJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

// ---------------------------------------------------------------- 祝日（国民の祝日に関する法律のとおりに計算する）
//
// カレンダーの権限を増やさず、ネットにも頼らないよう、計算で出す。春分・秋分は 2099年まで使える近似式。
// 法律が変わったとき（特例の移動など）はここを直す。会社の休み（年末年始など）は入っていない。

function ymd_(y, m, d) {
  var t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() + '-' + ('0' + (t.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + t.getUTCDate()).slice(-2);
}

function weekday_(ymd) {
  var p = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0=日 … 6=土
}

// m月の第n月曜
function nthMonday_(y, m, n) {
  var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return ymd_(y, m, 1 + ((8 - first) % 7) + (n - 1) * 7);
}

function jpHolidays_(y) {
  var k = Math.floor((y - 1980) / 4);
  var base = [
    ymd_(y, 1, 1), nthMonday_(y, 1, 2), ymd_(y, 2, 11), ymd_(y, 2, 23),
    ymd_(y, 3, Math.floor(20.8431 + 0.242194 * (y - 1980)) - k), // 春分の日
    ymd_(y, 4, 29), ymd_(y, 5, 3), ymd_(y, 5, 4), ymd_(y, 5, 5),
    nthMonday_(y, 7, 3), ymd_(y, 8, 11), nthMonday_(y, 9, 3),
    ymd_(y, 9, Math.floor(23.2488 + 0.242194 * (y - 1980)) - k), // 秋分の日
    nthMonday_(y, 10, 2), ymd_(y, 11, 3), ymd_(y, 11, 23),
  ];
  var set = {};
  base.forEach(function (d) { set[d] = true; });
  // 国民の休日：前日と翌日が祝日の日
  base.forEach(function (d) {
    var mid = addDays_(d, 1);
    if (!set[mid] && set[addDays_(d, 2)]) set[mid] = true;
  });
  // 振替休日：祝日が日曜なら、そのあとの最初の祝日でない日
  base.forEach(function (d) {
    if (weekday_(d) !== 0) return;
    var next = addDays_(d, 1);
    while (set[next]) next = addDays_(next, 1);
    set[next] = true;
  });
  return set;
}

function isJpHoliday_(ymd) {
  return !!jpHolidays_(Number(String(ymd).slice(0, 4)))[ymd];
}

/** 時間主導のトリガーから呼ばれる。土日・祝日は出さない */
function dailyRollup() {
  var dow = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'u'); // 1=月 … 7=日
  if (dow === '6' || dow === '7') return;
  var today = todayJst_();
  if (isJpHoliday_(today)) return;
  var problems = runRollups_(SpreadsheetApp.getActiveSpreadsheet(), today);
  // 失敗はシステム管理者に DM で知らせたうえで、実行ログにも失敗として残す（トリガーの失敗通知メールが届く）
  if (problems.length) throw new Error('チームのまとめで問題がありました: ' + problems.join(' / '));
}

function runRollups_(ss, today) {
  var reader = notionReader_(ss);
  var teams = allTeams_(ss).filter(function (t) { return t.channel; });
  var problems = [], done = [];
  teams.forEach(function (team) {
    try {
      var why = audienceProblem_(ss, team);
      if (why) { problems.push((team.name || team.id) + '：' + why + '。投稿していません'); return; }
      var r = buildRollup_(ss, team, today, reader);
      if (!r.members) return;
      postRollup_(ss, team.channel, r);
      done.push(team.id);
    } catch (err) {
      problems.push((team.name || team.id) + '：' + (err && err.message ? err.message : err));
    }
  });
  PropertiesService.getScriptProperties().setProperty('ROLLUP_LAST', JSON.stringify({ at: nowJst_(), posted: done, problems: problems }));
  if (problems.length) {
    try {
      dmAdmins_(ss, ':warning: *ミエタスク：チームのまとめ*（' + md_(today) + '）\n' + problems.map(function (p) { return '• ' + p; }).join('\n'));
    } catch (err) {
      problems.push('システム管理者に知らせられませんでした：' + err.message);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- メニュー（チームのまとめ）

function menuSetNotionToken() {
  menu_(function (ui) {
    var res = ui.prompt('Notionの鍵を設定する',
      'Notion のインテグレーションの「内部インテグレーションシークレット」（ntn_ で始まる）を貼り付けてください。\n' +
      'スクリプトの中にだけ保存され、メンバーには配られません。MTD の2つのデータベースを読めるかを確かめてから保存します。',
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return null;
    return setNotionToken_(res.getResponseText());
  });
}

function setNotionToken_(raw) {
  var token = String(raw || '').trim();
  if (!/^(ntn_|secret_)/.test(token)) throw new Error('ntn_ で始まる内部インテグレーションシークレットではありません');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = settings_(ss);
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperty('NOTION_TOKEN');
  props.setProperty('NOTION_TOKEN', token);
  try {
    var me = notion_('get', 'users/me');
    [['プロジェクトDB', s.notion_projects], ['タスクDB', s.notion_tasks]].forEach(function (db) {
      try {
        notion_('post', 'data_sources/' + sourceId_(db[1]) + '/query', { page_size: 1 });
      } catch (err) {
        if (err.status === 404) throw new Error('MTD の' + db[0] + 'を読めません。そのデータベースの「…」→「接続」で、このインテグレーションを追加してください');
        throw err;
      }
    });
    return 'Notionの鍵を保存しました（' + (me.name || 'インテグレーション') + '）。MTD のプロジェクトDB・タスクDBを読めることを確かめました。';
  } catch (err) {
    if (old) props.setProperty('NOTION_TOKEN', old); else props.deleteProperty('NOTION_TOKEN');
    throw new Error(err.message + '（保存していません）');
  }
}

function menuTrialRollup() { menu_(function () { return trialRollup_(selectedRow_(SHEETS.teams)); }); }

// 選んだチームのまとめを、まとめチャンネルではなくシステム管理者の DM に出す。中身と出し先の両方を確かめる
function trialRollup_(sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var team = teamById_(allTeams_(ss), sel.r['チームID']);
  if (!team) throw new Error('チームIDが入っていません');
  var r = buildRollup_(ss, team, todayJst_(), notionReader_(ss));
  var to = dmAdmins_(ss, '（試し・まとめチャンネルには出していません）\n' + r.parent, r.replies);
  var where = team.channel ? audienceProblem_(ss, team) || 'まとめチャンネルの参加者は管理者・システム管理者だけで、出せる状態です' : 'まとめチャンネルがまだありません';
  return (team.name || team.id) + 'のまとめ（' + r.members + '人）をシステム管理者（' + to.join(', ') + '）に DM で送りました。\n' + where;
}

function rollupTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'dailyRollup'; });
}

function menuStartRollup() { menu_(function () { return startRollup_(); }); }

function startRollup_() {
  notionToken_(); // 鍵が無いまま始めない
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!list_(settings_(ss).system_admins).length) throw new Error('「設定」シートの system_admins が空です。失敗を知らせる先が無いので始めません');
  rollupTriggers_().forEach(function (t) { ScriptApp.deleteTrigger(t); }); // 何度押しても1本だけにする
  ScriptApp.newTrigger('dailyRollup').timeBased().everyDays(1).atHour(ROLLUP_HOUR).inTimezone('Asia/Tokyo').create();
  var teams = allTeams_(ss).filter(function (t) { return t.channel; });
  var notes = teams.map(function (t) { return '・' + (t.name || t.id) + '：' + (audienceProblem_(ss, t) || '出せる状態です'); });
  return '毎朝のまとめを始めました（平日 ' + ROLLUP_HOUR + '時台。土日・祝日は出しません）。\n' + (notes.join('\n') || 'まとめチャンネルのあるチームがまだありません');
}

function menuStopRollup() {
  menu_(function () {
    var ts = rollupTriggers_();
    ts.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    return ts.length ? '毎朝のまとめを止めました。' : '毎朝のまとめは動いていませんでした。';
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
