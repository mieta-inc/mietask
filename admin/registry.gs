/**
 * ミエタスク 管理台帳の窓口（Google Apps Script）
 *
 * 管理台帳のスプレッドシートに付けて、ウェブアプリとして公開する。役目は2つ。
 *
 * 1. 各メンバーの mietask の窓口
 *    メンバーは一人ずつ別の鍵を持つ。窓口は鍵を確かめてから、その人の代わりに Slack へ投稿する。
 *    Botトークンはこのスクリプトの中（スクリプト プロパティ）にだけ置き、メンバーには配らない。
 *    メンバーが投稿できるのは、本人の投稿先だけ（タスクの題名には DM・非公開チャンネル・メールの内容が入るため）。
 *    各自からは毎朝、案件ごとの要約（案件名・状態・次の期限）を受け取る。同じものが本人のチャンネルにも出る。
 *    あわせて件数（超過・今日・今週）も受け取り「日々の状態」シートに残す。件数は動作の点検用で、
 *    見られるのはシステム管理者だけ（チームの管理者の状態把握には使わない。案件ごとに重さが違うため）。
 *    台帳で「停止」にした人、鍵を無効にした人は、その時点から何もできなくなる。
 *
 * 2. 管理者のメニュー（スプレッドシートの「ミエタスク」メニュー）
 *    鍵の発行（Bot から本人に DM で届ける）、鍵の無効化、退職者の投稿先の片付け、ダッシュボードの合言葉。
 *    スプレッドシートを編集できる人が管理者になる。
 *
 * 3. ダッシュボード（admin/dashboard の別の Apps Script が表示する、管理者・メンバー向けのページ）
 *    ページは社内の Google アカウントでだけ開け、見ている人のメールを合言葉付きでここに問い合わせる。
 *    メンバーごとに、MTD（Notion）のプログラムの案件と、各自のミエタスクが送る案件ごとの要約を1つの並びにして返す。
 *    見える範囲は「メンバー」シートのロールで、ここで決める（ページの側では決めない）:
 *      - 本人の分は誰でも見える
 *      - 管理者は、自分の「チーム」のチームとその下のチームの人が見える（リーダー・部門長）
 *      - 役員は全員が見える
 *      - システム管理者は、別のページで全員の動作状況（最後に動いた時刻・版・要約と件数が届いた日）だけが見える
 *    ミエタスクのタスクの題名は使わない。Notion の鍵はスクリプト プロパティ（NOTION_TOKEN）にだけ置く。
 *
 * ■ 最初の1回
 *   1. スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの中身を貼る
 *   2. 関数 setupSheets を実行する（シートと見出しを作る）
 *   3. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *      出てきた URL を「設定」シートの relay_url に入れる
 *   4. スプレッドシートを開き直し、「ミエタスク → Botトークンを設定する」でトークンを入れる
 *   5. メンバーの行を選んで「ミエタスク → 選んだ人の鍵を発行する」
 *   6. （ダッシュボードを使うとき）Notion でインテグレーションを作り、MTD のプロジェクトDB・タスクDBに接続して
 *      「ミエタスク → Notionの鍵を設定する」。「ダッシュボードの合言葉を作る」で出た2つの値を、
 *      ダッシュボードの Apps Script のスクリプト プロパティに入れる（admin/dashboard/dashboard.gs の説明を参照）
 *
 * ■ シート（見出しの名前で列を探すので、列の並べ替えや列の追加をしても壊れない）
 *   メンバー: 名前 / Slack ID / メール / チーム / ロール / 状態 / Notion ユーザー / 投稿先 / 鍵 / 最後に動いた / バージョン / メモ
 *             チームはチームIDをカンマ区切り（例: pm,pm1）。状態は「有効」か「停止」
 *             ロールは メンバー / 役員 / システム管理者 をカンマ区切り（空ならメンバー）。
 *             管理者はロールではなく「チーム」の管理者欄に書く（以前のロールの管理者は「シートを整える」で移す）
 *             メールは社内の Google アカウント（ダッシュボードはこのメールで見ている人を見分ける）
 *             Notion ユーザーは user://… （管理者の画面が MTD の担当を引くのに使う。空ならメールで探す）
 *             投稿先・鍵・最後に動いた・バージョンは、このスクリプトが書く
 *   チーム:   チームID / 表示名 / 親チーム / 管理者 / メモ
 *             親チームに pm と書けば、PM の管理者に PM1 の人も見える（部門 → チームの木にする）
 *             管理者は Slack ID をカンマ区切り。そのチームと、その下のチームの人が見える（部門長・PM長・リーダー）
 *   日々の状態: 日付 / Slack ID / 名前 / 超過 / 今日 / 今週 / 届いた時刻
 *             各自のミエタスクが毎朝送る件数。このスクリプトが書く。件数のほかは受け取らない
 *   案件の要約: 日付 / Slack ID / 名前 / 要約 / 届いた時刻
 *             各自のミエタスクが毎朝送る、案件ごとの状態（案件名・状態・次の期限）。このスクリプトが書く。
 *             タスクの題名・メールや DM の文面は受け取らない。ダッシュボードと管理者の画面に出る
 *   変更の記録: 日時 / 変えた人 / 対象 / 項目 / 前 / 後
 *             システム管理者がダッシュボードのページから変えたもの。このスクリプトが書く（シートを直に直した分は残らない）
 *   設定:     項目 / 値
 *             relay_url（この窓口の URL）・workspace（Slack のワークスペース名）・bot_username・bot_icon_url・
 *             notion_projects・notion_tasks（MTD の場所）
 */

var SHEETS = {
  members: {
    name: 'メンバー',
    headers: ['名前', 'Slack ID', 'メール', 'チーム', 'ロール', '状態', 'Notion ユーザー', '投稿先', '鍵', '最後に動いた', 'バージョン', 'メモ'],
  },
  teams: { name: 'チーム', headers: ['チームID', '表示名', '親チーム', '管理者', 'メモ'] },
  daily: { name: '日々の状態', headers: ['日付', 'Slack ID', '名前', '超過', '今日', '今週', '届いた時刻'] },
  shares: { name: '案件の要約', headers: ['日付', 'Slack ID', '名前', '要約', '届いた時刻'] },
  settings: { name: '設定', headers: ['項目', '値'] },
  changes: { name: '変更の記録', headers: ['日時', '変えた人', '対象', '項目', '前', '後'] },
  // 同じ案件が人によって別の名前で届いたとき、ダッシュボードで1つに束ねる（別名 → 案件名）
  aliases: { name: '案件の別名', headers: ['別名', '案件名', 'メモ'] },
};

var KEY_PREFIX = 'mietask2.';
var MAX_TEXT = 3900; // Slack は長すぎる本文を黙って切るので、投稿の前に止める
var STOPPED = '停止';
// 「メンバー」シートの「ロール」に書くもの（カンマ区切りで重ねられる。空ならメンバー）
var ROLE_MANAGER = '管理者'; // 以前のロール。いまは「チーム」の管理者欄に書く（移す前の台帳のためだけに読む）
var ROLE_EXEC = '役員'; // 全員が見える
var ROLE_SYSADMIN = 'システム管理者'; // 全員の動作状況が見える（案件の中身は見えない）
var ROLE_NAMES = ['メンバー', ROLE_MANAGER, ROLE_EXEC, ROLE_SYSADMIN];

// 管理者を「チーム」の管理者欄に移したか（メニュー「シートを整える」で移す）。
// 移す前は管理者欄を読まない（以前の管理者列の古い値が残っていても、見える範囲に効かないように）
function managersOnTeams_() { return PropertiesService.getScriptProperties().getProperty('MANAGERS_ON_TEAMS') === '1'; }

// 書けるロール。移したあとは、ロールに管理者は書かない
function roleNames_() { return managersOnTeams_() ? ['メンバー', ROLE_EXEC, ROLE_SYSADMIN] : ROLE_NAMES; }

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
    // 鍵をまだ持っていない人の申し込み（確認コード）。ここだけは鍵なしで受ける
    if (body.action === 'enroll_start' || body.action === 'enroll_claim') {
      var res = body.action === 'enroll_start' ? enrollStart_(body) : enrollClaim_(body);
      res.ok = true;
      return json_(res);
    }
    if (body.action === 'dashboard') {
      var dss = SpreadsheetApp.getActiveSpreadsheet();
      var demail = dashboardAuth_(body);
      var view = body.view === 'health' ? healthPage_(dss, demail, todayJst_(), body.change) : dashboardView_(dss, demail, todayJst_());
      view.ok = true;
      return json_(view);
    }
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

  // setup で選ぶチームの一覧（台帳の「チーム」シートの順。上のチームからの道すじを付ける）。台帳でチームを足せば、ここに出る
  teams: function (ctx) {
    var teams = allTeams_(ctx.ss);
    return { teams: teams.map(function (t) { return { id: t.id, name: t.name || t.id, path: teamPath_(teams, t) }; }), mine: ctx.member.teams };
  },

  // setup で本人がチームを選ぶ。まだどのチームにも入っていない人だけ（入っている人の付け替えはシステム管理者が行う）。
  // チームに入って変わるのは「その人の案件が、そのチームの管理者に見える」ことだけなので、承認は取らず、管理者に知らせる
  join_team: function (ctx, body) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var m = findMember_(ctx.ss, ctx.member.slack_id);
      if (m.teams.length) throw relayError_('already', 'すでに ' + m.teams.join(', ') + ' に入っています。チームを変えるときは、システム管理者に頼んでください');
      var teams = allTeams_(ctx.ss);
      var t = teamById_(teams, String(body.team || '').trim());
      if (!t) throw relayError_('bad_request', 'チーム「' + String(body.team || '') + '」は台帳にありません');
      setCell_(ctx.ss, SHEETS.members, m.row, 'チーム', t.id);
      logChanges_(ctx.ss, m.name + '（本人・setup）', [[m.name + '（' + m.slack_id + '）', 'チーム', '', t.id]]);
      var told = notifyJoin_(ctx.ss, teams, t, m);
      return { team: t.id, name: t.name || t.id, notified: told };
    } finally {
      lock.releaseLock();
    }
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
      throw relayError_('forbidden_channel', 'この投稿先には投稿できません（本人の投稿先だけ）');
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

  // 案件ごとの要約を受け取る（ダッシュボードに出す）。案件名・状態・一言・次の期限・残りの件数・超過の件数だけを残し、ほかは捨てる。

  // 本人の手元で、タスクの題名やメール・DM の文面を入れずに作ったもの。同じものが本人のチャンネルにも出ている
  share: function (ctx, body) {
    var items = cleanShare_(body.items);
    var now = nowJst_();
    upsertDaily_(ctx, SHEETS.shares, now.slice(0, 10), { '要約': JSON.stringify(items) }, now);
    touch_(ctx, body);
    return { items: items.length };
  },

  // 案件の名前の手がかり。各自の Claude が要約を作るとき、同じ案件を同じ名前に寄せるために使う。
  // 本人が関わる MTD の案件名と、同じチームの人が最近の要約で使った案件名（名前だけ。状態・担当者は返さない）
  hints: function (ctx) {
    var today = todayJst_();
    var resolve = aliasResolver_(ctx.ss);
    var out = { mtd: [], team: [], mtd_error: '' };
    var m = ctx.member;
    if (nid_(m.notion_user)) {
      try {
        var r = notionReader_(ctx.ss);
        out.mtd = mtdNames_(memberState_(r.projects(m.notion_user), r.tasks(m.notion_user), today, r.title)).map(function (n) { return resolve(n).name; });
      } catch (err) {
        out.mtd_error = String(err && err.message ? err.message : err);
      }
    }
    var mine = m.teams.map(function (t) { return t.toLowerCase(); });
    var mates = {};
    activeMembers_(ctx.ss).forEach(function (x) {
      if (x.slack_id === m.slack_id || x.teams.some(function (t) { return mine.indexOf(t.toLowerCase()) >= 0; })) mates[x.slack_id] = true;
    });
    var since = addDays_(today, -14);
    var names = [];
    rows_(ctx.ss, SHEETS.shares).forEach(function (row) {
      if (!mates[row['Slack ID']] || row['日付'] < since) return;
      var items;
      try { items = JSON.parse(row['要約'] || '[]'); } catch (err) { return; }
      items.forEach(function (it) { names.push(resolve(it.name).name); });
    });
    // 全角・半角や空白だけが違う名前は1つにする（先に出たほうを残す）
    var seenKey = {};
    var once = function (n) { var k = normName_(n); if (!k || seenKey[k]) return false; seenKey[k] = true; return true; };
    out.mtd = out.mtd.filter(once);
    out.team = names.filter(once).slice(0, HINT_MAX);
    return out;

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

// ---------------------------------------------------------------- 確認コードで使い始める（鍵を持っていない人）
// 本人の PC（ミエタスク）が申し込むと、その Slack ID の DM に6桁の確認コードを送る。
// PC は手元に合札（乱数）を持ち、その sha256 だけを先に送る。鍵はコードと合札がそろったときにだけ、その場で作って渡す。
// コードは本人の DM にしか届かないので、他人の Slack ID を名乗って申し込んでも先へ進めない（本人は何もしなくてよい）。
// 申し込みは Slack ID ごとに1件まで、10分で無効。打ち間違いは5回まで。窓口全体でも1時間あたりの件数を絞る。

var ENROLL_TTL_MS = 10 * 60 * 1000;
var ENROLL_TRIES = 5;
var ENROLL_PER_HOUR = 30;

function jsonProp_(props, key) {
  var raw = props.getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

// 申し込みに書かれた名前などは、数式や改行にならない形にして長さを切る（台帳とメッセージにそのまま入るため）
function enrollText_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]/g, ' ').replace(/^[=+\-@\s]+/, '').trim().slice(0, max);
}

function enrollSlackId_(body) {
  var sid = String(body.slack_id || '').trim().toUpperCase();
  if (!/^[UW][A-Z0-9]+$/.test(sid)) throw relayError_('bad_request', 'Slack ID が読めません'); // 鍵の確かめ（auth_）と同じ形
  return sid;
}

// 6桁の確認コード（Utilities.getUuid の乱数から作る）
function enrollCode_() {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return ('000000' + (parseInt(hex, 16) % 1000000)).slice(-6);
}

function enrollStart_(body) {
  var sid = enrollSlackId_(body);
  var verifier = String(body.verifier || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(verifier)) throw relayError_('bad_request', '申し込みの形が違います。ミエタスクを最新にしてから、もう一度試してください');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = findMember_(ss, sid);
  if (m && m.status === STOPPED) throw relayError_('stopped', 'ミエタスクの利用は管理台帳で停止されています。管理者に確認してください');
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = Date.now();
    var cur = jsonProp_(props, 'ENROLL_' + sid);
    if (cur && cur.exp > now) {
      throw relayError_('pending', '確認コードはもう Slack の DM に送っています。届いた6桁を入れてください（送り直せるのは ' + Math.ceil((cur.exp - now) / 60000) + ' 分後です）');
    }
    var hour = Math.floor(now / 3600000);
    var rate = jsonProp_(props, 'ENROLL_RATE') || {};
    if (rate.hour !== hour) rate = { hour: hour, n: 0 };
    if (rate.n >= ENROLL_PER_HOUR) throw relayError_('busy', '申し込みが混み合っています。しばらくしてから、もう一度試してください');
    rate.n++;
    props.setProperty('ENROLL_RATE', JSON.stringify(rate));
    var id = Utilities.getUuid();
    var code = enrollCode_();
    var pc = enrollText_(body.pc, 60);
    var text = ':key: *ミエタスクの確認コード：' + code + '*\n' +
      (pc ? pc + ' で' : '') + 'ミエタスクのセットアップが始まりました。この番号を Claude に入力してください（10分のあいだ有効です）。\n' +
      '心当たりがなければ、このメッセージは無視してください。番号を入れないかぎり、何も起きません。';
    var r = slack_('chat.postMessage', { channel: sid, text: text });
    if (!r.ok) throw relayError_('dm_failed', '確認コードを Slack の DM で送れませんでした（' + r.error + '）。Slack ID が正しいか確かめてください');
    props.setProperty('ENROLL_' + sid, JSON.stringify({
      id: id, code: sha256_(id + ':' + code), verifier: verifier, exp: now + ENROLL_TTL_MS, tries: 0,
      name: enrollText_(body.name, 60), email: enrollText_(body.email, 200).toLowerCase(), pc: pc,
      msg: { channel: r.channel || '', ts: r.ts || '' },
    }));
    return { enroll_id: id, expires_in: ENROLL_TTL_MS / 1000 };
  } finally {
    lock.releaseLock();
  }
}

function enrollClaim_(body) {
  var sid = enrollSlackId_(body);
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cur = jsonProp_(props, 'ENROLL_' + sid);
    if (!cur || cur.exp <= Date.now() || cur.id !== String(body.enroll_id || '')) {
      throw relayError_('expired', '確認コードの期限が切れたか、申し込みが見つかりません。もう一度 /mietask:setup を打ってください');
    }
    if (sha256_(String(body.secret || '')) !== cur.verifier) {
      throw relayError_('bad_request', 'この申し込みは別の PC で始められたものです。この PC で /mietask:setup を打ち直してください');
    }
    var code = String(body.code || '').replace(/\D/g, '');
    if (sha256_(cur.id + ':' + code) !== cur.code) {
      cur.tries = (cur.tries || 0) + 1;
      if (cur.tries >= ENROLL_TRIES) {
        props.deleteProperty('ENROLL_' + sid);
        throw relayError_('too_many', '確認コードを ' + ENROLL_TRIES + ' 回まちがえたので、この申し込みは無効にしました。もう一度 /mietask:setup を打ってください');
      }
      props.setProperty('ENROLL_' + sid, JSON.stringify(cur));
      throw relayError_('bad_code', '確認コードが違います（あと ' + (ENROLL_TRIES - cur.tries) + ' 回）');
    }
    props.deleteProperty('ENROLL_' + sid); // 1回きり
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var m = findMember_(ss, sid);
    if (m && m.status === STOPPED) throw relayError_('stopped', 'ミエタスクの利用は管理台帳で停止されています。管理者に確認してください');
    var log = [], fresh = !m;
    var email = enrollEmail_(ss, sid, cur.email);
    if (fresh) {
      var name = cur.name || sid;
      var sh = sheet_(ss, SHEETS.members);
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var row = { '名前': name, 'Slack ID': sid, 'メール': email, '状態': '有効' };
      sh.appendRow(head.map(function (h) { return row[String(h).trim()] || ''; }));
      log.push([name + '（' + sid + '）', '登録', '', '確認コードで登録' + (email ? '・メール: ' + email : '')]);
      m = findMember_(ss, sid);
    } else if (!m.email && email) {
      setCell_(ss, SHEETS.members, m.row, 'メール', email);
      log.push([m.name + '（' + sid + '）', 'メール', '', email]);
    }
    var key = newKey_(ss, m);
    log.push([m.name + '（' + sid + '）', '鍵', m.key || '', '確認コードで発行' + (cur.pc ? '（' + cur.pc + '）' : '')]);
    logChanges_(ss, m.name + '（本人・確認コード）', log);
    // 確認コードの DM は役目を終えたので消す（消せなくても続ける）
    if (cur.msg && cur.msg.ts) slack_('chat.delete', { channel: cur.msg.channel, ts: cur.msg.ts });
    return { key: key, name: m.name, registered: fresh };
  } finally {
    lock.releaseLock();
  }
}

// 申し込みのメール（本人の Slack のプロフィールから）。形が正しく、「設定」の email_domain に合い、ほかの人が使っていないときだけ使う
function enrollEmail_(ss, sid, email) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  var domain = String(settings_(ss).email_domain || '').trim().toLowerCase().replace(/^@/, '');
  if (domain && email.split('@')[1] !== domain) return '';
  var taken = rows_(ss, SHEETS.members).some(function (r) { return r['Slack ID'] !== sid && String(r['メール']).trim().toLowerCase() === email; });
  return taken ? '' : email;
}

// 「変更の記録」に残す（ページからの変更と同じ形）
function logChanges_(ss, who, log) {
  var at = nowJst_();
  var sh = sheet_(ss, SHEETS.changes);
  log.forEach(function (l) { sh.appendRow([at, who, l[0], l[1], l[2], l[3]]); });
}

// チームの道すじ（PD › PM › PM1）。輪になっていても止まる
function teamPath_(teams, t) {
  var names = [], seen = {}, cur = t;
  while (cur && !seen[cur.id.toLowerCase()]) {
    seen[cur.id.toLowerCase()] = true;
    names.unshift(cur.name || cur.id);
    cur = cur.parent ? teamById_(teams, cur.parent) : null;
  }
  return names.join(' › ');
}

// 本人がチームに入ったことを、そのチームの管理者に知らせる。いなければ上のチームの管理者、それもいなければシステム管理者
function notifyJoin_(ss, teams, t, m) {
  var members = rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (x) { return x.slack_id && x.status !== STOPPED; });
  var byId = {};
  members.forEach(function (x) { byId[x.slack_id] = x; });
  var sys = members.filter(isSystemAdmin_);
  var to = [], seen = {}, cur = t, viaSys = false;
  while (cur && !seen[cur.id.toLowerCase()] && !to.length) {
    seen[cur.id.toLowerCase()] = true;
    to = (cur.managers || []).filter(function (u) { return byId[u] && u !== m.slack_id; });
    cur = cur.parent ? teamById_(teams, cur.parent) : null;
  }
  if (!to.length) { to = sys.map(function (x) { return x.slack_id; }).filter(function (u) { return u !== m.slack_id; }); viaSys = true; }
  var sysNames = sys.map(function (x) { return x.name; }).join('・') || 'システム管理者';
  var text = ':wave: *' + m.name + ' さんがミエタスクで「' + (t.name || t.id) + '」に入りました*\n' +
    'この人の持ち案件が、このチームの管理者のページに出るようになります。\n' +
    (viaSys ? '違っていたら、ページの「管理 → メンバー」でチームを直してください。' : '違っていたら、システム管理者（' + sysNames + '）に伝えてください。');
  var told = [];
  uniq_(to).forEach(function (u) {
    var r = slack_('chat.postMessage', { channel: u, text: text });
    if (r.ok) told.push(byId[u].name);
  });
  return told;
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
    row: rowNo, name: r['名前'], slack_id: r['Slack ID'], email: r['メール'], teams: list_(r['チーム']), roles: list_(r['ロール']),
    status: r['状態'] || '有効', notion_user: r['Notion ユーザー'], channel: r['投稿先'],
    last_run: r['最後に動いた'], version: r['バージョン'], key: r['鍵'] || '',
  };
}

function publicMember_(m) {
  return { name: m.name, slack_id: m.slack_id, teams: m.teams, status: m.status, channel: m.channel };
}

function allTeams_(ss) {
  var on = managersOnTeams_();
  return rows_(ss, SHEETS.teams).map(function (r) {
    return { id: r['チームID'], name: r['表示名'], parent: r['親チーム'], managers: on ? list_(r['管理者']) : [] };
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
    return t ? { id: t.id, name: t.name } : { id: id, missing: true };
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
function hasRole_(m, role) { return !!m && (m.roles || []).indexOf(role) >= 0; }

function isSystemAdmin_(m) { return hasRole_(m, ROLE_SYSADMIN); }

// 案件の中身が見えるチームの起点。役員は一番上のチーム全部、管理者は管理者欄に自分がいるチーム（どちらも下のチームを含む）。
// 管理者欄に移す前の台帳では、以前どおり「管理者のロール ＋ 自分の『チーム』」で決める
function scopeRoots_(teams, m) {
  if (!m) return [];
  if (hasRole_(m, ROLE_EXEC)) return teams.filter(function (t) { return !t.parent || !teamById_(teams, t.parent); });
  if (managersOnTeams_()) return teams.filter(function (t) { return t.managers.indexOf(m.slack_id) >= 0; });
  if (hasRole_(m, ROLE_MANAGER)) return m.teams.map(function (id) { return teamById_(teams, id) || { id: id, name: id, parent: '' }; });
  return [];
}

// 起点のチームと、その下のチーム（木の順。重なりは1つに）
function scopeTeams_(teams, roots) {
  var out = [], seen = {};
  roots.forEach(function (t) {
    subtree_(teams, t.id).forEach(function (id) {
      var key = id.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(teamById_(teams, id) || { id: id, name: id, parent: '' });
    });
  });
  return out;
}

function idSet_(teams) {
  var set = {};
  teams.forEach(function (t) { set[t.id.toLowerCase()] = true; });
  return set;
}

function inTeams_(m, set) { return m.teams.some(function (t) { return set[t.toLowerCase()]; }); }

// 管理者に返す中身（team-sheet が使う）。管理者・役員には、見える範囲のチームの人と、その人たちの案件の要約を返す。
// システム管理者には、全員と、点検用の件数（直近8日）も返す（案件の要約は、自分が見える範囲の人の分だけ）。
function managedView_(ctx) {
  var teams = allTeams_(ctx.ss);
  var admin = isSystemAdmin_(ctx.member);
  var mine = scopeTeams_(teams, scopeRoots_(teams, ctx.member));
  if (!mine.length && !admin) return null;
  var managed = idSet_(mine);
  // システム管理者には全員を返す（動作の点検用）。案件の要約は、自分が見える範囲の人の分だけ
  var ids = admin ? idSet_(teams) : managed;
  var all = rows_(ctx.ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); });
  var members = all.filter(function (m) { return m.slack_id && (admin || inTeams_(m, ids)); })
    .map(function (m) { delete m.row; return m; });
  var settings = settings_(ctx.ss);
  var out = {
    teams: admin ? teams : mine,
    members: members,
    settings: { notion_projects: settings.notion_projects || '', notion_tasks: settings.notion_tasks || '' },
    system_admin: admin,
  };
  // 案件ごとの要約（ミエタスクから）。担当チームの人の分だけ、直近8日以内のもの
  var shares = latestShares_(ctx.ss);
  var since8 = addDays_(nowJst_().slice(0, 10), -7);
  out.shared = members.filter(function (m) { return inTeams_(m, managed) && shares[m.slack_id] && shares[m.slack_id].date >= since8; })
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
  // メンバーが投稿できるのは本人の投稿先だけ。ほかの人が見る場所に各自の一覧を出さない
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

var SHARE_STATES = ['動いている', '相手待ち', '期限が過ぎたものあり', 'しばらく動きなし'];
var SHARE_MAX = 40; // 持ち案件の一覧（横断の仕事の多い人は数が多い）
var SHARE_FRESH_DAYS = 7; // 持ち案件の一覧は、この日数のあいだは最新として出す（朝の実行が1日抜けても消さない）
var HINT_MAX = 80;
var NOTE_MAX = 40; // 案件ごとの「いま何をしているか」の一言
var DETAIL_MAX = 300; // 案件ごとの詳細（ページではトグルで開く）
var STAGES = ['準備', '進行中', '仕上げ', '運用中']; // 案件の段階（どこまで進んでいるか）
var NEXT_MAX = 30; // 次の節目

// 件数（残り・超過）。書かれていなければ null（古い版のミエタスクは件数を送らない）
function shareCount_(v, label) {
  if (v === undefined || v === null || v === '') return null;
  var n = Number(v);
  if (!(n >= 0 && n <= 999 && Math.floor(n) === n)) throw relayError_('bad_share', label + ' は0〜999の整数です');
  return n;
}

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
    var out = { name: name, state: state, due: due };
    var role = String(it.role || '').trim();
    if (role.length > 12 || /[\r\n<>@]|https?:/i.test(role)) throw relayError_('bad_share', where + ' の関わり方は12文字までで、改行・リンク・メンションは入れられません');
    if (role) out.role = role;
    var last = String(it.last_seen || '');
    if (last && !/^\d{4}-\d{2}-\d{2}$/.test(last)) throw relayError_('bad_share', where + ' の最後に動いた日は yyyy-MM-dd です');
    if (last) out.last_seen = last;
    var note = String(it.note || '').trim();
    if (note.length > NOTE_MAX) throw relayError_('bad_share', where + ' の一言が長すぎます（' + NOTE_MAX + '文字まで）');
    if (/[\r\n<>@]|https?:/i.test(note)) throw relayError_('bad_share', where + ' の一言に改行・リンク・メンション・メールアドレスは入れられません');
    if (note) out.note = note;
    var detail = String(it.detail || '').trim();
    if (detail.length > DETAIL_MAX) throw relayError_('bad_share', where + ' の詳細が長すぎます（' + DETAIL_MAX + '文字まで）');
    if (/[\r\n<>@]|https?:/i.test(detail)) throw relayError_('bad_share', where + ' の詳細に改行・リンク・メンション・メールアドレスは入れられません');
    if (detail) out.detail = detail;
    var stage = String(it.stage || '');
    if (stage && STAGES.indexOf(stage) < 0) throw relayError_('bad_share', where + ' の段階は ' + STAGES.join('・') + ' のどれかです');
    if (stage) out.stage = stage;
    var next = String(it.next || '').trim();
    if (next.length > NEXT_MAX) throw relayError_('bad_share', where + ' の次の節目が長すぎます（' + NEXT_MAX + '文字まで）');
    if (/[\r\n<>@]|https?:/i.test(next)) throw relayError_('bad_share', where + ' の次の節目に改行・リンク・メンション・メールアドレスは入れられません');
    var nextDate = String(it.next_date || '');
    if (nextDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw relayError_('bad_share', where + ' の次の節目の日付は yyyy-MM-dd です');
    if (next) { out.next = next; if (nextDate) out.next_date = nextDate; }
    var open = shareCount_(it.open, where + ' の残りの件数（open）');
    var overdue = shareCount_(it.overdue, where + ' の超過の件数（overdue）');
    if (open !== null) out.open = open;
    if (overdue !== null) out.overdue = overdue;
    if (open !== null && overdue !== null && overdue > open) throw relayError_('bad_share', where + ' の超過の件数が残りの件数より多くなっています');
    return out;
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
    .addItem('選んだ人の投稿先をアーカイブする（停止の人だけ）', 'menuArchiveMember')
    .addSeparator()
    .addItem('Botトークンを設定する', 'menuSetBotToken')
    .addItem('Notionの鍵を設定する', 'menuSetNotionToken')
    .addItem('ダッシュボードの合言葉を作る', 'menuMakeDashboardSecret')
    .addItem('シートを整える', 'menuSetupSheets')
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
  var key = newKey_(ss, m);
  var r = dmKey_(m, key);
  if (r.ok) return m.name + ' さんに鍵を DM で送りました。前の鍵があれば、それはもう使えません。';
  // DM を送れない（Slack アプリの権限が足りない等）。管理者に見せて、手で渡してもらう
  var html = HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif;font-size:13px">DM を送れませんでした（' + r.error + '）。<br>' +
    '下の鍵をコピーして、' + m.name + ' さんに Slack の DM などで渡してください。</p>' +
    '<textarea readonly style="width:100%;height:110px;font-family:monospace">' + key + '</textarea>')
    .setWidth(520).setHeight(240);
  ui.showModalDialog(html, 'ミエタスクの鍵（' + m.name + ' さん）');
  return null;
}

// 鍵を作り直す（前の鍵はここで効かなくなる）
function newKey_(ss, m) {
  if (!/^[UW][A-Z0-9]+$/.test(m.slack_id)) throw changeError_('Slack ID が入っていません');
  if (m.status === STOPPED) throw changeError_(m.name + ' さんは「停止」です。鍵は発行できません');
  var url = settings_(ss).relay_url;
  if (!url) throw changeError_('「設定」シートに relay_url（この窓口のURL）がありません');
  var secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('KEY_' + m.slack_id, sha256_(secret));
  setCell_(ss, SHEETS.members, m.row, '鍵', '発行 ' + nowJst_().slice(0, 10));
  return KEY_PREFIX + base64url_(JSON.stringify({ u: url, i: m.slack_id, k: secret }));
}

// 鍵と入れ方を本人に DM で送る。送れたら、あとで消せるように場所を覚える
function dmKey_(m, key) {
  deleteKeyMessage_(m.slack_id);
  var page = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL');
  var text = ':key: *ミエタスクの鍵*（' + m.name + ' さん専用）\n' +
    '1. Claude のアプリの設定（カスタマイズ）からマーケットプレイスを追加し、GitHub リポジトリに `mieta-inc/mietask` を指定する\n' +
    '2. 追加したマーケットプレイスの `mietask` を、このコンピュータに追加する\n' +
    '3. 入力欄の下のモードを「Auto」にして `/mietask:setup` と打ち、入力欄が出たら下の鍵をそのまま貼る\n' +
    '```' + key + '```\n' +
    'この鍵はほかの人に渡さないでください。セットアップが終わると、このメッセージは自動で消えます。' +
    (page ? '\n管理者に何が見えているかは、ミエタスクのページの「自分」で確かめられます（社内の Google アカウントで開く）: ' + page : '');
  // 表示名（username）は指定しない。指定すると Slack は Bot の入っていない別の DM に置き、あとで消せなくなる
  var r = slack_('chat.postMessage', { channel: m.slack_id, text: text });
  if (r.ok) PropertiesService.getScriptProperties().setProperty('KEYMSG_' + m.slack_id, JSON.stringify({ channel: r.channel, ts: r.ts }));
  return r;
}

function revokeKey_(sel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = memberFromRow_(sel.r, sel.row);
  PropertiesService.getScriptProperties().deleteProperty('KEY_' + m.slack_id);
  deleteKeyMessage_(m.slack_id);
  setCell_(ss, SHEETS.members, m.row, '鍵', '無効 ' + nowJst_().slice(0, 10));
  return m.name + ' さんの鍵を無効にしました。この時点から窓口は使えません。';
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

function menuSetupSheets() { menu_(function () { return setupSheets(); }); }

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
  var defaults = { relay_url: '', workspace: '', bot_username: 'ミエタスク', bot_icon_url: '', notion_projects: '', notion_tasks: '', email_domain: '' };
  Object.keys(defaults).forEach(function (k) {
    if (!(k in have)) settings.appendRow([k, defaults[k]]);
  });
  var notes = migrateRoles_(ss);
  var moved = migrateManagers_(ss);
  return 'シートを整えました。' + (notes.length ? '\n\nロールを移しました（以前の「設定」の system_admins から）:\n' + notes.join('\n') : '') +
    (moved.length ? '\n\n管理者を「チーム」の管理者欄に移しました:\n' + moved.join('\n') : '');
}

// 以前は「設定」の system_admins で決めていた。ロールが空の人にだけ、そこから移す。
// 古い項目は消さない（見比べられるように。もう読まないので、確かめたら消してよい）
function migrateRoles_(ss) {
  var sys = list_(settings_(ss).system_admins);
  var notes = [], found = {};
  rows_(ss, SHEETS.members).forEach(function (r, i) {
    var id = r['Slack ID'];
    if (!id) return;
    found[id] = true;
    if (r['ロール'] || sys.indexOf(id) < 0) return;
    setCell_(ss, SHEETS.members, i + 2, 'ロール', ROLE_SYSADMIN);
    notes.push('・' + r['名前'] + '：' + ROLE_SYSADMIN);
  });
  sys.forEach(function (u) {
    if (!found[u]) { found[u] = true; notes.push('・' + u + '：「メンバー」に行がありません。ページを見せるなら、メール付きで行を足してロールを入れてください'); }
  });
  return notes;
}

// 管理者を、ロールから「チーム」の管理者欄に移す（1回だけ）。管理者のロールの人を、その人の「チーム」の管理者にして、
// ロールから管理者を外す。管理者欄に以前の値が残っていても使わず、ここで書き直す
function migrateManagers_(ss) {
  if (managersOnTeams_()) return [];
  var members = rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); }).filter(function (m) { return m.slack_id; });
  var teamRows = rows_(ss, SHEETS.teams);
  var known = {};
  teamRows.forEach(function (r) { if (r['チームID']) known[String(r['チームID']).toLowerCase()] = true; });
  var notes = [], byTeam = {};
  members.forEach(function (m) {
    if (!hasRole_(m, ROLE_MANAGER)) return;
    if (!m.teams.length) notes.push('・' + m.name + '：管理者のロールでしたが「チーム」が空なので、どのチームの管理者にもしていません');
    m.teams.forEach(function (t) {
      var k = String(t).toLowerCase();
      if (!known[k]) { notes.push('・' + m.name + '：チーム「' + t + '」が「チーム」シートに無いので、管理者にしていません'); return; }
      (byTeam[k] = byTeam[k] || []).push(m);
    });
  });
  teamRows.forEach(function (r, i) {
    if (!r['チームID']) return;
    var ms = byTeam[String(r['チームID']).toLowerCase()] || [];
    var value = ms.map(function (m) { return m.slack_id; }).join(', ');
    var old = String(r['管理者'] || '').trim();
    if (value === old) return;
    setCell_(ss, SHEETS.teams, i + 2, '管理者', value);
    notes.push('・チーム ' + r['チームID'] + '：' + (ms.length ? ms.map(function (m) { return m.name; }).join('、') + ' を管理者に' : '管理者を空に') +
      (old ? '（前の値「' + old + '」は使いません）' : ''));
  });
  members.forEach(function (m) {
    if (!hasRole_(m, ROLE_MANAGER)) return;
    setCell_(ss, SHEETS.members, m.row, 'ロール', m.roles.filter(function (r) { return r !== ROLE_MANAGER; }).join(', '));
  });
  PropertiesService.getScriptProperties().setProperty('MANAGERS_ON_TEAMS', '1');
  return notes;
}

// ================================================================ ダッシュボード（MTD の案件と、各自の案件ごとの要約）
//
// 案件ごとに「誰が関わっていて、どこまで進んでいるか」と、メンバーごとに「どの案件を持っていて、それぞれどういう状態か」を返す。
// 出どころは MTD（Notion のプロジェクトDBとタスクDB）と、各自のミエタスクが送る案件ごとの要約（Slack・メール・議事録・
// MTD から本人の Claude が拾ったタスクを、案件ごとに束ねたもの）。ミエタスクのタスクの題名は使わない
// （題名に DM・非公開チャンネル・メールの内容が入るため）。届くのは案件ごとの状態・次の期限・残りと超過の件数だけ。
// 案件の名前は各自の Claude がつけるので、ゆれは「案件の別名」シートで束ねる。見立て（空く・余裕がある）は書かない。

var NOTION_VERSION = '2025-09-03';
var MOVING = ['進行中', '継続', '確認待ち']; // 今動いているタスク
var STUCK = ['確認待ち', '保留']; // 詰まっていそうなタスク
var ROLES = [['CC担当', 'CC'], ['PM担当', 'PM'], ['SP担当', 'SP'], ['プロジェクトリード', 'リード'], ['連携メンバー', '連携']];
var COUNTED = ['CC', 'PM', 'SP']; // 並行の数に入れる役割（リード・連携は社内案件・手伝いが多いので、別に出す）
var UNREADABLE = '（読めない案件）'; // インテグレーションが接続されていないページ
var DASH_CACHE_SEC = 600; // メンバー1人ぶんの案件を覚えておく秒数（開くたびに Notion へ問い合わせないため）

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
    // 役割の欄に入っている人（ほかに誰が関わっているかを数えるのに使う）
    people: uniq_([].concat.apply([], ROLES.map(function (r) { return prop_(page, r[0]) || []; }))),

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

// ---------------------------------------------------------------- ダッシュボードの中身（ここは読むだけ。純粋な計算）

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

// 1人ぶんの案件の並び（personItems_）。rank の小さい順（気にすべきもの → 動いているもの → 担当外 → これから始まるもの）、
// 同じ rank は期限・終了日の近い順。
var RANK = { overdue: 0, waiting: 1, running: 2, helping: 3, idle: 4, starting: 5 };
var SHARE_WORD = ['期限が過ぎたものあり', '相手待ち', '動いている', '', 'しばらく動きなし'];
var SHARE_RANK = { '期限が過ぎたものあり': RANK.overdue, '相手待ち': RANK.waiting, '動いている': RANK.running, 'しばらく動きなし': RANK.idle };

// 持ち案件の一覧として使えるか（届いてから SHARE_FRESH_DAYS 日まで）
function freshShare_(sh, today) { return !!sh && sh.date >= addDays_(today, -SHARE_FRESH_DAYS); }

function periodLabel_(p, today) {
  return p.end ? '〜' + dateLabel_(p.end, today) : p.start ? dateLabel_(p.start, today) + '〜' : '';
}

// 「残り5件（うち超過2件）」。件数が届いていなければ空
function countLabel_(open, overdue) {
  if (open === undefined || open === null) return '';
  return '残り' + open + '件' + (overdue ? '（うち超過' + overdue + '件）' : '');
}

// 見えていない理由（空いているとは書かない）
function memberNotes_(sh, today, linked) {
  var notes = [];
  if (!linked) notes.push('MTD未連携（システム管理者が対応）');
  if (!sh) notes.push('ミエタスク未着');
  else if (sh.date !== today) notes.push('ミエタスクは' + md_(sh.date) + 'から未着');
  return notes.join('・');
}

function todayJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

// ---------------------------------------------------------------- 案件ごとに束ねる（純粋な計算）
//
// 同じ案件かどうかは名前で決める。全角・半角、大文字・小文字、空白と記号のゆれは同じとみなす。
// それでも別の名前で届くもの（「渋谷区」と「渋谷区ワークショップ」など）は「案件の別名」シートで束ねる。

function normName_(s) {
  var t = String(s || '');
  if (t.normalize) t = t.normalize('NFKC');
  return t.toLowerCase().replace(/[\s・･\-‐−–—_／\/.,、。()（）「」『』\[\]【】]/g, '');
}

// 別名 → 案件名 を引く関数を返す。別名の別名もたどる（輪になっていたら途中で止める）
function aliasResolverFrom_(rows) {
  var map = {};
  rows.forEach(function (r) {
    var from = normName_(r['別名']), to = String(r['案件名'] || '').trim();
    if (from && to && normName_(to) !== from) map[from] = to;
  });
  return function (name) {
    var shown = String(name || '').trim(), key = normName_(shown), seen = {};
    while (map[key] && !seen[key]) {
      seen[key] = true;
      shown = map[key];
      key = normName_(shown);
    }
    return { key: key, name: shown, aliased: !!seen[normName_(name)] };
  };
}

function aliasResolver_(ss) { return aliasResolverFrom_(rows_(ss, SHEETS.aliases)); }

// 本人が関わっている MTD の案件名（今のもの・これからのもの・担当外でタスクを持っているもの）
function mtdNames_(st) {
  if (!st) return [];
  var names = st.running.concat(st.leading, st.starting).map(function (p) { return p.name; });
  Object.keys(st.elsewhere).forEach(function (k) { if (st.elsewhere[k].name !== UNREADABLE) names.push(st.elsewhere[k].name); });
  return uniq_(names);
}

// 1人ぶんの、案件ごとの関わり。出どころ（MTD・ミエタスク）ごとに1つずつ。
// 人ごとに束ねるのは personItems_、案件ごとに束ねるのは projectsView_
function memberEntries_(st, sh, today) {
  var out = [];
  if (st) {
    st.running.concat(st.leading).forEach(function (p) {
      var stuck = st.stuckIn[p.id];
      out.push({ name: p.name, src: 'mtd', rank: stuck ? RANK.waiting : RANK.running, due: '', roles: p.roles,
        start: p.start, end: p.end, people: p.people || [], note: stuck ? stuck + 'のタスクあり' : '' });
    });
    st.starting.forEach(function (p) {
      out.push({ name: p.name, src: 'mtd', rank: RANK.starting, due: '', roles: p.roles, start: p.start, end: p.end,
        people: p.people || [], note: dateLabel_(p.start, today) + '開始' });
    });
    var unreadable = 0;
    Object.keys(st.elsewhere).forEach(function (k) {
      var o = st.elsewhere[k];
      if (o.name === UNREADABLE) { unreadable++; return; }
      out.push({ name: o.name, src: 'mtd', rank: RANK.helping, due: '', roles: ['担当外'], start: '', end: '', people: [],
        note: 'タスク' + o.tasks.length + '件' });
    });
    // 名前を読めない案件は1つにまとめる（並べても何の案件か分からないため）。案件ごとの並びには出さない
    if (unreadable) {
      out.push({ name: '名前を読めない案件', src: 'mtd', rank: RANK.helping, due: '', roles: ['担当外'], start: '', end: '', people: [],
        note: unreadable + '件（Notion のインテグレーションが接続されていない）', unreadable: true });
    }
  }
  if (freshShare_(sh, today)) {
    sh.items.forEach(function (it) {
      var rank = it.state in SHARE_RANK ? SHARE_RANK[it.state] : RANK.running;
      out.push({ name: it.name, src: 'share', rank: rank, due: it.due || '', roles: it.role ? [it.role] : [], start: '', end: '',
        open: it.open === undefined ? null : it.open, overdue: it.overdue === undefined ? null : it.overdue, people: [], note: it.note || '',
        detail: it.detail || '', last_seen: it.last_seen || '', stage: it.stage || '', next: it.next || '', next_date: it.next_date || '' });
    });
  }
  return out;
}

// 1人ぶんの関わりを案件ごとに1行にする。MTD とミエタスクの同じ案件は1行（役割と期間は MTD、一言と件数はミエタスクから）
function personItems_(entries, resolve, today) {
  var groups = {}, order = [];
  entries.forEach(function (e) {
    var r = e.unreadable ? { key: '\u0000unreadable', name: e.name, aliased: false } : resolve(e.name);
    var g = groups[r.key];
    if (!g) { g = groups[r.key] = { name: r.name, fixed: r.aliased, mtd: false, share: false, list: [] }; order.push(r.key); }
    if (e.src === 'mtd') { if (!g.fixed && !g.mtd) g.name = e.name; g.mtd = true; } else g.share = true;
    g.list.push(e);
  });
  var items = order.map(function (k) {
    var g = groups[k], list = g.list;
    var rank = Math.min.apply(null, list.map(function (e) { return e.rank; }));
    var mtd = list.filter(function (e) { return e.src === 'mtd'; }), sh = list.filter(function (e) { return e.src === 'share'; });
    // 役割は MTD のもの。MTD に無い案件は、本人の持ち案件の一覧に書いた関わり方
    var roles = uniq_([].concat.apply([], (mtd.length ? mtd : sh).map(function (e) { return e.roles; })));
    var last = sh.map(function (e) { return e.last_seen; }).filter(String).sort().reverse()[0] || '';
    var note = sh.map(function (e) { return e.note; }).filter(String)[0] || mtd.map(function (e) { return e.note; }).filter(String)[0] || '';
    if (!note && sh.length) note = SHARE_WORD[Math.min.apply(null, sh.map(function (e) { return e.rank; }))] || '';
    var detail = sh.map(function (e) { return e.detail; }).filter(String)[0] || '';
    var stage = sh.map(function (e) { return e.stage; }).filter(String)[0] || '';
    var nx = sh.filter(function (e) { return e.next; })[0] || null;
    var dues = list.map(function (e) { return e.due; }).filter(String).sort();
    var start = mtd.map(function (e) { return e.start; }).filter(String).sort()[0] || '';
    var end = mtd.map(function (e) { return e.end; }).filter(String).sort().reverse()[0] || '';
    var counted = sh.filter(function (e) { return e.open !== null && e.open !== undefined; });
    var count = counted.length ? countLabel_(counted.reduce(function (n, e) { return n + e.open; }, 0),
      counted.reduce(function (n, e) { return n + (e.overdue || 0); }, 0)) : '';
    var meta = [count, dues[0] ? '次の期限' + dateLabel_(dues[0], today) : '', rank !== RANK.starting ? periodLabel_({ start: start, end: end }, today) : '',
      last && last < today ? '最後に動いた ' + dateLabel_(last, today) : ''].filter(String).join('・');
    return { name: g.name, rank: rank, role: roles.join('・'), src: g.mtd && g.share ? 'both' : g.mtd ? 'mtd' : 'share',
      note: note, detail: detail, meta: meta, start: start, last: last, stage: stage, next: nx ? nx.next : '', next_date: nx ? nx.next_date || '' : '', _sort: dues[0] || end || (rank === RANK.starting ? start : '') || '9999' };
  });
  return sortByRank_(items);
}

function sortByRank_(items) {
  items.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a._sort !== b._sort) return a._sort < b._sort ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  items.forEach(function (p) { delete p._sort; });
  return items;
}

// 1人ぶんのカード。並びのほかに、気にすべきもの（期限超過・相手待ち）の案件名
function personCard_(base, entries, resolve, today) {
  var items = personItems_(entries || [], resolve, today);
  var pick = function (f) { return items.filter(f).map(function (it) { return it.name; }); };
  return {
    slack_id: base.slack_id, name: base.name, teams: base.teams, notes: base.notes, share_at: base.share_at,
    items: items.map(function (it) {
      var o = { name: it.name, rank: it.rank, role: it.role, src: it.src, note: it.note, meta: it.meta, last: it.last || '' };
      if (it.detail) o.detail = it.detail;
      if (it.stage) o.stage = it.stage;
      if (it.next) { o.next = it.next; o.next_date = it.next_date || ''; }

      return o;
    }),

    now: items.filter(function (it) { return it.rank !== RANK.starting; }).length,
    later: items.filter(function (it) { return it.rank === RANK.starting; }).length,
    idle: items.filter(function (it) { return it.rank === RANK.idle; }).length,

    overdue: pick(function (it) { return it.rank === RANK.overdue; }),
    waiting: pick(function (it) { return it.rank === RANK.waiting; }),
  };
}

function daysBetween_(a, b) {
  var p = String(a).split('-').map(Number), q = String(b).split('-').map(Number);
  return Math.round((Date.UTC(q[0], q[1] - 1, q[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 86400000);
}

// MTD の期間から見た進み具合（「期間の6割・残り3週」）。期間が分からなければ null
function progress_(start, end, today) {
  if (start && start > today) return { label: dateLabel_(start, today) + '開始', pct: 0 };
  if (end && end < today) return { label: '期間終了（' + dateLabel_(end, today) + '）', pct: 100 };
  if (start && end) {
    var all = Math.max(1, daysBetween_(start, end)), gone = daysBetween_(start, today), left = daysBetween_(today, end);
    var pct = Math.max(0, Math.min(100, Math.round(gone / all * 100)));
    var rest = left >= 14 ? '残り' + Math.round(left / 7) + '週' : left > 0 ? '残り' + left + '日' : '今日まで';
    return { label: '期間の' + Math.min(10, Math.floor(pct / 10)) + '割・' + rest + '（' + dateLabel_(start, today) + '〜' + dateLabel_(end, today) + '）', pct: pct };
  }
  if (end) return { label: '〜' + dateLabel_(end, today), pct: null };
  if (start) return { label: dateLabel_(start, today) + '〜', pct: null };
  return null;
}

var ROLE_ORDER = ['PM', 'CC', 'SP', 'リード', '連携', '担当外', 'ミエタスク'];
// 本人が書いた関わり方（「担当」「手伝い」など）は、MTD の役割のあと・担当外の前に並べる
function roleRank_(r) { var i = ROLE_ORDER.indexOf(r); return i < 0 ? ROLE_ORDER.indexOf('連携') + 0.5 : i; }

// 見える人の関わりを案件ごとに束ねる。others は、見えない人のうちその案件に関わっている人の数（名前は出さない）。
//   seen: [{member, entries}]（見える人） / hidden: [{member, entries}]（見えない人。MTD の役割の欄と今日の要約から分かる分）
//   byNotion: Notion のユーザーID → Slack ID
function projectsView_(seen, hidden, resolve, byNotion, today) {
  var groups = {}, order = [];
  var group = function (name) {
    var r = resolve(name);
    if (!groups[r.key]) { groups[r.key] = { key: r.key, name: r.name, fixed: r.aliased, mtd: false, entries: [], who: {}, people: {} }; order.push(r.key); }
    return groups[r.key];
  };
  seen.forEach(function (s) {
    s.entries.forEach(function (e) {
      if (e.unreadable) return;
      var g = group(e.name);
      // 表示する名前は、別名で束ねたものなら案件名、そうでなければ MTD の名前を優先する
      if (!g.fixed && e.src === 'mtd' && !g.mtd) { g.name = e.name; g.mtd = true; }
      g.entries.push(e);
      var w = g.who[s.member.slack_id] = g.who[s.member.slack_id] || { name: s.member.name, roles: [] };
      w.roles = uniq_(w.roles.concat(e.src === 'share' ? (e.roles.length ? e.roles : ['ミエタスク']) : e.roles));
      (e.people || []).forEach(function (p) { g.people[p] = true; });
    });
  });
  var out = order.map(function (k) {
    var g = groups[k];
    var rank = Math.min.apply(null, g.entries.map(function (e) { return e.rank; }));
    var dues = g.entries.map(function (e) { return e.due; }).filter(String).sort();
    var mtd = g.entries.filter(function (e) { return e.src === 'mtd' && (e.start || e.end); });
    var start = mtd.map(function (e) { return e.start; }).filter(String).sort()[0] || '';
    var end = mtd.map(function (e) { return e.end; }).filter(String).sort().reverse()[0] || '';
    var counted = g.entries.filter(function (e) { return e.open !== null && e.open !== undefined; });
    var open = counted.reduce(function (n, e) { return n + e.open; }, 0);
    var overdue = counted.reduce(function (n, e) { return n + (e.overdue || 0); }, 0);
    // 見えない人：MTD の役割の欄に入っている人と、今日の要約で同じ案件を出している人
    var others = {};
    hidden.forEach(function (h) {
      var inMtd = nid_(h.member.notion_user) && g.people[nid_(h.member.notion_user)];
      var inShare = h.entries.some(function (e) { return resolve(e.name).key === k; });
      if (inMtd || inShare) others[h.member.slack_id] = true;
    });
    Object.keys(g.people).forEach(function (p) { if (!byNotion[p]) others['n:' + p] = true; }); // 台帳にいない人（ミエタスクを使っていない人）も数える
    Object.keys(g.who).forEach(function (id) { delete others[id]; });
    var members = Object.keys(g.who).map(function (id) {
      var w = g.who[id];
      var roles = w.roles.length > 1 ? w.roles.filter(function (r) { return r !== 'ミエタスク'; }) : w.roles;
      roles.sort(function (a, b) { return roleRank_(a) - roleRank_(b); });
      return { name: w.name, role: roles.join('・'), top: roleRank_(roles[0]) };
    }).sort(function (a, b) { return a.top - b.top; }).map(function (m) { return { name: m.name, role: m.role }; });
    return {
      name: g.name, rank: rank, due: dues[0] || '', due_label: dues[0] ? dateLabel_(dues[0], today) : '',
      progress: progress_(start, end, today), mtd: g.mtd || mtd.length > 0,
      counts: counted.length ? countLabel_(open, overdue) : '', members: members, others: Object.keys(others).length,
      _sort: dues[0] || end || (rank === RANK.starting ? start : '') || '9999',
    };
  });
  return sortByRank_(out);
}


// ---------------------------------------------------------------- 誰が見ているか

// ダッシュボードの Apps Script からの問い合わせを確かめ、見ている人のメールを返す。
// そちらは社内の Google アカウントでしか開けないので、メールはそちらで確かめたものを信じる。合言葉はその代わりの鍵
function dashboardAuth_(body) {
  var want = PropertiesService.getScriptProperties().getProperty('DASHBOARD_SECRET');
  if (!want) throw relayError_('no_dashboard', 'ダッシュボードの合言葉がまだ作られていません（台帳のメニュー「ダッシュボードの合言葉を作る」）');
  if (sha256_(String(body.secret || '')) !== sha256_(want)) throw relayError_('bad_secret', 'ダッシュボードの合言葉が違います');
  var email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw relayError_('bad_request', '見ている人のメールがありません');
  // ページの URL を覚える（鍵や案内の DM に書くため）。合言葉を確かめたあとなので、ページから来たものだけ
  var page = String(body.page_url || '');
  var props = PropertiesService.getScriptProperties();
  if (/^https:\/\/script\.google\.com\/[\w\/.\-]+\/exec$/.test(page) && props.getProperty('DASHBOARD_URL') !== page) props.setProperty('DASHBOARD_URL', page);
  return email;
}

function activeMembers_(ss) {
  return rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (m) { return m.slack_id && m.status !== STOPPED; });
}

// ---------------------------------------------------------------- 見える範囲と中身

// 見る人に見せてよいものだけを返す。
//   メンバー: 自分の分と、自分の関わる案件 / 管理者: 自分のチームとその下のチームの人 / 役員: 全員 /
//   システム管理者: そのほかに管理のタブ（動作状況と台帳の操作。案件の中身は入れない）
function dashboardView_(ss, email, today) {
  var members = activeMembers_(ss);
  var viewer = viewerByEmail_(ss, email);
  if (!viewer) return { viewer: null, today: today };

  var teams = allTeams_(ss);
  // 見える範囲の下にあるチームも、それぞれ絞り込みに出す（部門長なら部門と、その下の各チーム）
  var visible = scopeTeams_(teams, scopeRoots_(teams, viewer));
  var ctx = { ss: ss, today: today, shares: latestShares_(ss), reader: null, failed: {}, cards: {}, entries: {} };
  var resolve = aliasResolver_(ss);
  var out = { viewer: { name: viewer.name, email: email }, today: today };
  card_(ctx, viewer);
  out.teams = visible.map(function (t) {
    var ids = idSet_(scopeTeams_(teams, [t]));
    var inTeam = members.filter(function (m) { return inTeams_(m, ids); });
    return { id: t.id, name: t.name || t.id, parent: t.parent || '', members: inTeam.map(function (m) { return card_(ctx, m).slack_id; }) };
  });
  var teamName = function (id) { var t = teamById_(teams, id); return t ? t.name || t.id : id; };
  var person = function (id) {
    var c = personCard_(ctx.cards[id], ctx.entries[id], resolve, today);
    c.team_names = c.teams.map(teamName);
    return c;
  };
  var ids = uniq_([].concat.apply([], out.teams.map(function (t) { return t.members; })));
  var worst = function (c) { return c.items.length ? Math.min.apply(null, c.items.map(function (it) { return it.rank; })) : 9; };
  out.people = ids.map(person).map(function (c, i) { c._i = i; return c; }).sort(function (a, b) {
    return worst(a) - worst(b) || a._i - b._i; // 気にすべきものがある人から
  }).map(function (c) { delete c._i; return c; });
  out.self = person(viewer.slack_id);

  // 案件ごとの並び。見える人の関わりを束ね、見えない人は数だけ（MTD の役割の欄と、今日の要約から分かる分）
  var byNotion = {};
  members.forEach(function (m) { if (nid_(m.notion_user)) byNotion[nid_(m.notion_user)] = m.slack_id; });
  var seen = [], hidden = [];
  members.forEach(function (m) {
    if (ctx.cards[m.slack_id]) seen.push({ member: m, entries: ctx.entries[m.slack_id] || [] });
    else hidden.push({ member: m, entries: memberEntries_(null, ctx.shares[m.slack_id] || null, today) });
  });
  out.projects = projectsView_(seen, hidden, resolve, byNotion, today);

  var sys = isSystemAdmin_(viewer);
  out.tabs = visible.length ? ['members', 'projects', 'self'] : sys ? ['self'] : ['self', 'projects'];
  if (sys) out.tabs.push('admin');
  out.admin = sys ? adminData_(ss, today) : null;
  // 同じ理由で読めなかった人は1行にまとめる（Notion の鍵が無いときに全員分が並ばないように）
  out.problems = Object.keys(ctx.failed).map(function (why) { return 'MTD を読めませんでした（' + why + '）：' + ctx.failed[why].join('、'); });
  return out;
}

// 1人ぶんの土台（名前・見えていない理由）と、案件ごとの関わり（ctx.entries）。
// MTD を読めなかったときは、その人のカードに書かずにページの上に出す（黙って空にしない）。
// 束ね方（案件の別名）は開くたびに台帳から読むので、ここでは束ねずに覚える
function card_(ctx, m) {
  if (ctx.cards[m.slack_id]) return ctx.cards[m.slack_id];
  var cache = CacheService.getScriptCache();
  var key = 'dash3:' + m.slack_id + ':' + ctx.today;
  var hit = cache.get(key);
  if (hit) {
    var saved = JSON.parse(hit);
    ctx.entries[m.slack_id] = saved.entries;
    return (ctx.cards[m.slack_id] = saved.card);
  }
  var linked = !!nid_(m.notion_user);
  var st = null, mtdOk = true;
  if (linked) {
    try {
      if (!ctx.reader) ctx.reader = notionReader_(ctx.ss);
      st = memberState_(ctx.reader.projects(m.notion_user), ctx.reader.tasks(m.notion_user), ctx.today, ctx.reader.title);
    } catch (err) {
      mtdOk = false;
      var why = String(err && err.message ? err.message : err);
      (ctx.failed[why] = ctx.failed[why] || []).push(m.name);
    }
  }
  var sh = ctx.shares[m.slack_id] || null;
  var c = { slack_id: m.slack_id, name: m.name, teams: m.teams, notes: memberNotes_(sh, ctx.today, linked),
    share_at: freshShare_(sh, ctx.today) ? sh.at : '' };
  var entries = memberEntries_(st, sh, ctx.today);
  if (mtdOk) cache.put(key, JSON.stringify({ card: c, entries: entries }), DASH_CACHE_SEC);
  ctx.entries[m.slack_id] = entries;
  return (ctx.cards[m.slack_id] = c);
}

// 管理のタブの中身。システム管理者にだけ返す（動作状況と台帳の設定。案件の中身は入れない）
function adminData_(ss, today) {
  return {
    health: healthView_(ss, latestShares_(ss), today),
    teams: allTeams_(ss).map(function (t) { return { id: t.id, name: t.name || '', parent: t.parent || '', managers: t.managers }; }),
    roles: roleNames_().slice(1),
    managers_on_teams: managersOnTeams_(), // 移す前は、管理者をロールで付ける（チームの画面では選べない）
    aliases: rows_(ss, SHEETS.aliases).filter(function (r) { return r['別名'] && r['案件名']; })
      .map(function (r) { return { alias: r['別名'], name: r['案件名'] }; }),
    log: rows_(ss, SHEETS.changes).slice(-30).reverse(), // 直近の変更（新しい順）
    ledger_url: ss.getUrl(), // 管理台帳のスプレッドシート（システム管理者にだけ返す。開けるかはシートの共有で決まる）
  };
}

// 管理のタブからの変更。システム管理者だけが変えられる。変えたあとの管理のタブの中身を返す
function healthPage_(ss, email, today, change) {
  var viewer = viewerByEmail_(ss, email);
  if (!viewer) return { viewer: null, today: today };
  var out = { viewer: { name: viewer.name, email: email }, today: today };
  if (!isSystemAdmin_(viewer)) {
    if (change) throw relayError_('forbidden', '台帳を変えられるのはシステム管理者だけです');
    out.forbidden = true;
    return out;
  }
  if (change) {
    var r = applyChange_(ss, viewer, change);
    out.changed = r.count;
    out.message = r.notes.join('\n');
  }
  var a = adminData_(ss, today);
  Object.keys(a).forEach(function (k) { out[k] = a[k]; });
  return out;
}

// ---------------------------------------------------------------- 台帳の変更（システム管理者がページから）
//
// 台帳はスプレッドシートのままが正。ページから変えられるのは、見える範囲を決める項目だけ
// （メンバーのチーム・ロール・状態・メール、チームの追加・表示名・親チーム・管理者）。
// ページを開いたあとにシートが直に直されていたら、上書きせずに断る（base と今の値を比べる）。
// 変えたものは「変更の記録」に残す。

var MEMBER_FIELDS = { name: '名前', teams: 'チーム', roles: 'ロール', status: '状態', email: 'メール', notion_user: 'Notion ユーザー' };
var TEAM_FIELDS = { name: '表示名', parent: '親チーム', managers: '管理者' };

function changeError_(message) { return relayError_('bad_change', message); }

// シートに数式として入らないように（先頭が = + - @ のものは受け取らない）
function plainText_(v, label) {
  var t = String(v === undefined || v === null ? '' : v).trim();
  if (/^[=+\-@]/.test(t)) throw changeError_(label + 'の先頭に = + - @ は使えません');
  if (/[\r\n]/.test(t)) throw changeError_(label + 'に改行は使えません');
  if (t.length > 100) throw changeError_(label + 'が長すぎます');
  return t;
}

function applyChange_(ss, viewer, change) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var kind = String(change && change.kind || '');
    var notes = []; // 画面に返す知らせ（DM を送った・送れなかった など）
    var log;
    if (kind === 'member') log = changeMember_(ss, change, notes);
    else if (kind === 'add_member') log = addMember_(ss, change, notes);
    else if (kind === 'send_key') log = sendKeyFromPage_(ss, change, notes);
    else if (kind === 'revoke_key') log = revokeKeyFromPage_(ss, change, notes);
    else if (kind === 'team') log = changeTeam_(ss, change, notes);
    else if (kind === 'add_team') log = addTeam_(ss, change, notes);
    else if (kind === 'merge') log = mergeProject_(ss, change);
    else if (kind === 'unmerge') log = unmergeProject_(ss, change);
    else throw changeError_('不明な変更です: ' + kind);
    var at = nowJst_();
    var sh = sheet_(ss, SHEETS.changes);
    log.forEach(function (l) { sh.appendRow([at, viewer.name + '（' + viewer.email + '）', l[0], l[1], l[2], l[3]]); });
    return { count: log.length, notes: notes };
  } finally {
    lock.releaseLock();
  }
}

// 見出しで列を探して書く（ロックは呼ぶ側で取る）
function writeCells_(ss, def, row, fields) {
  var sh = sheet_(ss, def);
  var col = indexOf_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  Object.keys(fields).forEach(function (h) {
    if (col[h] === undefined) throw changeError_('「' + def.name + '」シートに「' + h + '」の列がありません（メニューの「シートを整える」）');
    sh.getRange(row, col[h] + 1).setValue(fields[h]);
  });
}

function sameList_(a, b) {
  var norm = function (x) { return (Array.isArray(x) ? x : list_(x)).map(function (v) { return String(v).trim().toLowerCase(); }).join(','); };
  return norm(a) === norm(b);
}

function changeMember_(ss, change, notes) {
  var rows = rows_(ss, SHEETS.members);
  var idx = -1;
  for (var i = 0; i < rows.length; i++) if (rows[i]['Slack ID'] && rows[i]['Slack ID'] === change.slack_id) { idx = i; break; }
  if (idx < 0) throw changeError_('その人は台帳にいません');
  var cur = memberFromRow_(rows[idx], idx + 2);
  var teams = allTeams_(ss);
  var set = change.set || {}, base = change.base || {};
  var now = { name: cur.name || '', teams: cur.teams, roles: cur.roles, status: cur.status, email: cur.email || '', notion_user: cur.notion_user || '' };
  var next = {};
  Object.keys(set).forEach(function (k) {
    if (!MEMBER_FIELDS[k]) throw changeError_('変えられない項目です: ' + k);
    var noMember = function (x) { return (Array.isArray(x) ? x : list_(x)).filter(function (r) { return r !== 'メンバー'; }); };
    var same = k === 'teams' ? sameList_(now.teams, base.teams)
      : k === 'roles' ? sameList_(noMember(now.roles), noMember(base.roles))
        : String(now[k]) === String(base[k] === undefined ? '' : base[k]);
    if (!same) throw relayError_('conflict', cur.name + ' さんの' + MEMBER_FIELDS[k] + 'は、ページを開いたあとに変わっています。ページを開き直してください');
  });
  if ('name' in set) next.name = checkName_(set.name);
  if ('teams' in set) next.teams = checkTeams_(teams, set.teams);
  if ('roles' in set) next.roles = checkRoles_(set.roles);
  if ('status' in set) {
    next.status = String(set.status);
    if (['有効', STOPPED].indexOf(next.status) < 0) throw changeError_('状態は「有効」か「停止」です');
  }
  if ('email' in set) next.email = checkEmail_(rows, idx, set.email);
  if ('notion_user' in set) next.notion_user = checkNotion_(set.notion_user);
  // システム管理者が1人もいなくならないように
  var after = rows.map(function (r, i) {
    var m = memberFromRow_(r, i + 2);
    if (i === idx) { if (next.roles) m.roles = next.roles; if (next.status) m.status = next.status; }
    return m;
  });
  if (!after.some(function (m) { return m.slack_id && m.status !== STOPPED && isSystemAdmin_(m); })) {
    throw changeError_('システム管理者が1人もいなくなるので変えられません。先にほかの人をシステム管理者にしてください');
  }
  var fields = {}, log = [];
  Object.keys(next).forEach(function (k) {
    var before = Array.isArray(now[k]) ? now[k].join(', ') : now[k];
    var value = Array.isArray(next[k]) ? next[k].join(', ') : next[k];
    if (before === value) return;
    fields[MEMBER_FIELDS[k]] = value;
    log.push([cur.name + '（' + cur.slack_id + '）', MEMBER_FIELDS[k], before, value]);
  });
  if (log.length) writeCells_(ss, SHEETS.members, idx + 2, fields);
  // 管理者・役員になった人には、ページの場所を DM で知らせる
  if (next.roles && (next.status || cur.status) !== STOPPED) {
    var gained = viewerRoles_(next.roles).filter(function (r) { return viewerRoles_(cur.roles).indexOf(r) < 0; });
    if (gained.length) notifyViewer_({ name: next.name || cur.name, slack_id: cur.slack_id }, gained, notes);
  }
  return log;
}

// 台帳に人を足す。鍵は送らない（「鍵を送る」は別。ミエタスクを使わず、ページを見るだけの人もいるため）
function addMember_(ss, change, notes) {
  var rows = rows_(ss, SHEETS.members);
  var name = checkName_(change.name);
  var sid = String(change.slack_id || '').trim().toUpperCase();
  if (!/^[UW][A-Z0-9]{6,}$/.test(sid)) throw changeError_('Slack ID は U から始まる英数字です（Slack のプロフィールの「︙」→「メンバーIDをコピー」）');
  rows.forEach(function (r) { if (String(r['Slack ID']).toUpperCase() === sid) throw changeError_('その Slack ID は ' + r['名前'] + ' さんとして台帳にあります'); });
  var m = {
    '名前': name, 'Slack ID': sid, 'メール': checkEmail_(rows, -1, change.email),
    'チーム': checkTeams_(allTeams_(ss), change.teams || []).join(', '), 'ロール': checkRoles_(change.roles || []).join(', '),
    '状態': '有効', 'Notion ユーザー': checkNotion_(change.notion_user),
  };
  var sh = sheet_(ss, SHEETS.members);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(function (h) { return m[String(h).trim()] || ''; }));
  var gained = viewerRoles_(list_(m['ロール']));
  if (gained.length) notifyViewer_({ name: name, slack_id: sid }, gained, notes);
  return [[name + '（' + sid + '）', '追加', '', ['チーム: ' + (m['チーム'] || 'なし'), 'ロール: ' + (m['ロール'] || 'メンバー'), m['メール'] ? 'メール: ' + m['メール'] : ''].filter(String).join('・')]];
}

function memberBySlackId_(ss, sid) {
  var rows = rows_(ss, SHEETS.members);
  for (var i = 0; i < rows.length; i++) if (rows[i]['Slack ID'] && rows[i]['Slack ID'] === sid) return memberFromRow_(rows[i], i + 2);
  throw changeError_('その人は台帳にいません');
}

// 鍵を作り直して本人に DM で送る。鍵はページに返さない（DM が送れなければ、台帳のメニューから発行してもらう）
function sendKeyFromPage_(ss, change, notes) {
  var m = memberBySlackId_(ss, String(change.slack_id || ''));
  var key = newKey_(ss, m);
  var r = dmKey_(m, key);
  if (!r.ok) {
    PropertiesService.getScriptProperties().deleteProperty('KEY_' + m.slack_id);
    setCell_(ss, SHEETS.members, m.row, '鍵', '無効 ' + nowJst_().slice(0, 10));
    throw changeError_(m.name + ' さんに DM を送れませんでした（' + r.error + '）。前の鍵も使えなくなっています。台帳のメニュー「選んだ人の鍵を発行する」から発行すると、鍵をその場で表示して手で渡せます');
  }
  notes.push(m.name + ' さんに鍵を DM で送りました。前の鍵があれば、それはもう使えません。');
  return [[m.name + '（' + m.slack_id + '）', '鍵', m.key || '', 'DM で送った']];
}

function revokeKeyFromPage_(ss, change, notes) {
  var m = memberBySlackId_(ss, String(change.slack_id || ''));
  PropertiesService.getScriptProperties().deleteProperty('KEY_' + m.slack_id);
  deleteKeyMessage_(m.slack_id);
  setCell_(ss, SHEETS.members, m.row, '鍵', '無効 ' + nowJst_().slice(0, 10));
  notes.push(m.name + ' さんの鍵を無効にしました。この時点からミエタスクは窓口を使えません。');
  return [[m.name + '（' + m.slack_id + '）', '鍵', m.key || '', '無効にした']];
}

function checkName_(v) {
  var t = plainText_(v, '名前');
  if (!t) throw changeError_('名前が空です');
  return t;
}

function checkTeams_(teams, v) {
  return uniq_((Array.isArray(v) ? v : []).map(function (id) {
    var t = teamById_(teams, String(id).trim());
    if (!t) throw changeError_('チーム「' + id + '」は「チーム」シートにありません');
    return t.id;
  }));
}

function checkRoles_(v) {
  var roles = (Array.isArray(v) ? v : []).map(function (r) { return String(r).trim(); }).filter(function (r) { return r && r !== 'メンバー'; });
  roles.forEach(function (r) {
    if (r === ROLE_MANAGER && managersOnTeams_()) throw changeError_('管理者はロールではなく、「チーム」の管理者で決めます');
    if (roleNames_().indexOf(r) < 0) throw changeError_('ロール「' + r + '」は使えません');
  });
  return uniq_(roles);
}

// メールの形と、ほかの人と重なっていないか（idx はその人の行。足すときは -1）
function checkEmail_(rows, idx, v) {
  var email = plainText_(v, 'メール').toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw changeError_('メールの形ではありません');
  rows.forEach(function (r, i) {
    if (i !== idx && email && String(r['メール']).trim().toLowerCase() === email) throw changeError_('そのメールは ' + r['名前'] + ' さんが使っています');
  });
  return email;
}

// Notion のユーザーID（user://… でも、URL の末尾の32桁でもよい）。空なら MTD とひも付けない
function checkNotion_(v) {
  var t = plainText_(v, 'Notion ユーザー');
  if (!t) return '';
  var id = uuid_(t.replace(/^.*[\/:]/, ''));
  if (!id) throw changeError_('Notion のユーザーIDは32桁の英数字です（ハイフンはあってもなくてもよい）');
  return 'user://' + id;
}

function viewerRoles_(roles) { return (roles || []).filter(function (r) { return r === ROLE_MANAGER || r === ROLE_EXEC; }); }

// 管理者・役員になった人に、ページの場所と見方を DM で知らせる（送れなくても台帳の変更は済ませる）
function notifyViewer_(m, roles, notes) {
  var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL');
  if (!url) { notes.push('ページの URL がまだ分からないので、' + m.name + ' さんに案内の DM は送っていません'); return; }
  var text = ':bar_chart: *ミエタスクのページが見られるようになりました*（' + roles.join('・') + '）\n' + url + '\n' +
    '• 最初のタブで、見える範囲の人が、いまどの案件で何をしているか・どこで詰まっているかが分かります\n' +
    '• 社内の Google アカウントで開いてください。タスクの題名やメール・DM の中身は出ません';
  var r = slack_('chat.postMessage', { channel: m.slack_id, text: text });
  notes.push(r.ok ? m.name + ' さんにページの案内を DM で送りました' : m.name + ' さんに案内の DM を送れませんでした（' + r.error + '）');
}

function changeTeam_(ss, change, notes) {
  var rows = rows_(ss, SHEETS.teams);
  var teams = allTeams_(ss);
  var idx = -1;
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['チームID']).toLowerCase() === String(change.id || '').toLowerCase() && rows[i]['チームID']) { idx = i; break; }
  if (idx < 0) throw changeError_('そのチームは「チーム」シートにありません');
  var id = rows[idx]['チームID'];
  var now = { name: rows[idx]['表示名'] || '', parent: rows[idx]['親チーム'] || '', managers: managersOnTeams_() ? list_(rows[idx]['管理者']) : [] };
  var set = change.set || {}, base = change.base || {};
  var next = {};
  Object.keys(set).forEach(function (k) {
    if (!TEAM_FIELDS[k]) throw changeError_('変えられない項目です: ' + k);
    var same = k === 'managers' ? sameList_(now.managers, base.managers || [])
      : String(now[k]) === String(base[k] === undefined ? '' : base[k]);
    if (!same) throw relayError_('conflict', 'チーム ' + id + ' の' + TEAM_FIELDS[k] + 'は、ページを開いたあとに変わっています。ページを開き直してください');
  });
  if ('name' in set) next.name = plainText_(set.name, '表示名');
  if ('parent' in set) next.parent = checkParent_(teams, id, set.parent);
  if ('managers' in set) next.managers = checkManagers_(ss, set.managers);
  var who = managerNames_(ss);
  var fields = {}, log = [];
  Object.keys(next).forEach(function (k) {
    var before = k === 'managers' ? who(now.managers) : now[k];
    var after = k === 'managers' ? who(next.managers) : next[k];
    if (k === 'managers' ? sameList_(now.managers, next.managers) : now[k] === next[k]) return;
    fields[TEAM_FIELDS[k]] = k === 'managers' ? next.managers.join(', ') : next[k];
    log.push(['チーム ' + id, TEAM_FIELDS[k], before, after]);
  });
  if (log.length) writeCells_(ss, SHEETS.teams, idx + 2, fields);
  if (next.managers) notifyManagers_(ss, next.managers.filter(function (u) { return now.managers.indexOf(u) < 0; }), rows[idx]['表示名'] || id, notes);
  return log;
}

// 管理者に選べるのは、台帳にいて停止していない人だけ。管理者欄に移す前は選べない
function checkManagers_(ss, v) {
  if (!managersOnTeams_()) throw changeError_('管理者を選ぶ前に、台帳のメニュー「シートを整える」を1回押してください（管理者を「チーム」に移します）');
  var ids = uniq_((Array.isArray(v) ? v : list_(v)).map(function (x) { return String(x).trim(); }).filter(String));
  var members = rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); });
  ids.forEach(function (u) {
    var m = members.filter(function (x) { return x.slack_id === u; })[0];
    if (!m) throw changeError_('管理者「' + u + '」は台帳にいません');
    if (m.status === STOPPED) throw changeError_(m.name + ' さんは停止しているので、管理者にできません');
  });
  return ids;
}

// Slack ID の並びを、記録に残す名前の並びにする（台帳にいない ID はそのまま）
function managerNames_(ss) {
  var name = {};
  rows_(ss, SHEETS.members).forEach(function (r) { if (r['Slack ID']) name[r['Slack ID']] = r['名前']; });
  return function (ids) { return ids.map(function (u) { return name[u] || u; }).join(', '); };
}

// 新しく管理者になった人に、ページの場所を DM で知らせる
function notifyManagers_(ss, ids, teamName, notes) {
  var members = rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); });
  ids.forEach(function (u) {
    var m = members.filter(function (x) { return x.slack_id === u; })[0];
    if (m) notifyViewer_({ name: m.name, slack_id: m.slack_id }, [teamName + ' の管理者'], notes);
  });
}

// 親チームはあるチームだけ。自分や自分の下のチームを親にして輪にしない
function checkParent_(teams, id, raw) {
  var p = String(raw || '').trim();
  if (!p) return '';
  var t = teamById_(teams, p);
  if (!t) throw changeError_('親チーム「' + p + '」は「チーム」シートにありません');
  if (id && subtree_(teams, id).some(function (x) { return x.toLowerCase() === t.id.toLowerCase(); })) {
    throw changeError_('チーム ' + id + ' の親に、自分か自分の下のチーム（' + t.id + '）は選べません');
  }
  return t.id;
}

function addTeam_(ss, change, notes) {
  var teams = allTeams_(ss);
  var id = String(change.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id) || /^[-]/.test(id)) throw changeError_('チームIDは英数字・- ・_ で30文字まで（先頭に - は使えません）');
  if (teamById_(teams, id)) throw changeError_('チーム ' + id + ' はもうあります');
  var name = plainText_(change.name, '表示名') || id;
  var parent = checkParent_(teams, '', change.parent);
  var managers = (change.managers || []).length ? checkManagers_(ss, change.managers) : [];
  var sh = sheet_(ss, SHEETS.teams);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = { 'チームID': id, '表示名': name, '親チーム': parent, '管理者': managers.join(', ') };
  sh.appendRow(head.map(function (h) { return row[String(h).trim()] || ''; }));
  if (managers.length) notifyManagers_(ss, managers, name, notes || []);
  return [['チーム ' + id, '追加', '', '表示名: ' + name + (parent ? '・親チーム: ' + parent : '') +
    (managers.length ? '・管理者: ' + managerNames_(ss)(managers) : '')]];
}

// 案件の名前は要約と同じ決まりで受け取る（ダッシュボードにそのまま出るため）
function projectName_(v, label) {
  var t = plainText_(v, label);
  if (!t) throw changeError_(label + 'が空です');
  if (t.length > 40) throw changeError_(label + 'は40文字までです');
  if (/[<>@]|https?:/i.test(t)) throw changeError_(label + 'にリンク・メンション・メールアドレスは入れられません');
  return t;
}

// 「from は to と同じ案件」を「案件の別名」シートに書く。from がもう別名なら行を書き換える
function mergeProject_(ss, change) {
  var from = projectName_(change.from, '束ねる名前');
  var to = projectName_(change.to, 'まとめ先の案件名');
  var rows = rows_(ss, SHEETS.aliases);
  var key = normName_(from);
  if (key === normName_(to)) throw changeError_('同じ名前です（全角・半角や空白の違いは、もともと同じ案件として束ねています）');
  // まとめ先をたどって from に戻るなら輪になる
  var others = rows.filter(function (r) { return normName_(r['別名']) !== key; });
  if (aliasResolverFrom_(others)(to).key === key) throw changeError_('「' + to + '」はもう「' + from + '」に束ねられています（輪になります）');
  for (var i = 0; i < rows.length; i++) {
    if (normName_(rows[i]['別名']) !== key) continue;
    var before = rows[i]['案件名'];
    if (before === to) return [];
    writeCells_(ss, SHEETS.aliases, i + 2, { '案件名': to });
    return [['案件 ' + from, 'まとめ先', before, to]];
  }
  var sh = sheet_(ss, SHEETS.aliases);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = { '別名': from, '案件名': to };
  sh.appendRow(head.map(function (h) { return row[String(h).trim()] || ''; }));
  return [['案件 ' + from, 'まとめ先', '', to]];
}

function unmergeProject_(ss, change) {
  var key = normName_(change.alias);
  var sh = sheet_(ss, SHEETS.aliases);
  var rows = rows_(ss, SHEETS.aliases);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (!rows[i]['別名'] || normName_(rows[i]['別名']) !== key) continue;
    sh.deleteRow(i + 2);
    return [['案件 ' + rows[i]['別名'], 'まとめ先', rows[i]['案件名'], '（外した）']];
  }
  throw changeError_('その別名は「案件の別名」シートにありません。ページを開き直してください');
}

function viewerByEmail_(ss, email) {

  var members = activeMembers_(ss);
  for (var i = 0; i < members.length; i++) if (String(members[i].email).toLowerCase() === email) return members[i];
  return null;
}

// システム管理者向け。動いているかどうかと、台帳の書き方の誤りだけで、案件の中身は入れない
function healthView_(ss, shares, today) {
  var counts = {};
  rows_(ss, SHEETS.daily).forEach(function (r) {
    var c = counts[r['Slack ID']];
    if (!c || r['日付'] >= c.date) {
      counts[r['Slack ID']] = { date: r['日付'], overdue: count_(r['超過']), today: count_(r['今日']), week: count_(r['今週']) };
    }
  });
  var teams = allTeams_(ss);
  return rows_(ss, SHEETS.members).map(function (r, i) { return memberFromRow_(r, i + 2); })
    .filter(function (m) { return m.slack_id; })
    .map(function (m) {
      var issues = [];
      m.roles.forEach(function (x) {
        if (x === ROLE_MANAGER && managersOnTeams_()) issues.push('ロールの「管理者」は使っていません（管理者は「チーム」の管理者で決めます）');
        else if (roleNames_().indexOf(x) < 0) issues.push('ロール「' + x + '」は使えません');
      });
      m.teams.forEach(function (t) { if (!teamById_(teams, t)) issues.push('チーム「' + t + '」が「チーム」シートにありません'); });
      if (!m.email) issues.push('メールが空です（ダッシュボードを開けません）');
      if (!managersOnTeams_() && hasRole_(m, ROLE_MANAGER) && !m.teams.length) issues.push('管理者ですがチームが空です');
      // 一目で分かる動き具合（3日より前から動いていなければ、毎朝の実行が止まっているかもしれない）
      var state = m.status === STOPPED ? '停止' : /^無効/.test(m.key) ? '鍵を無効にした' : !m.key ? '鍵なし'
        : !m.last_run ? 'セットアップ待ち' : today && String(m.last_run).slice(0, 10) < addDays_(today, -3) ? '止まっているかも' : '動いている';
      return {
        slack_id: m.slack_id, email: m.email || '', name: m.name, teams: m.teams, roles: m.roles.length ? m.roles : ['メンバー'], status: m.status,
        last_run: m.last_run || '', version: m.version || '', notion_user: m.notion_user || '', key: m.key || '', state: state,
        share_date: shares[m.slack_id] ? shares[m.slack_id].date : '', counts: counts[m.slack_id] || null, issues: issues,
      };
    });
}

/** 以前の「毎朝のまとめ」（Slack に出していた）のトリガーが残っていたときに呼ばれる。自分のトリガーを消して終わる */
function dailyRollup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRollup') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------- メニュー（Notion の鍵・ダッシュボードの合言葉）

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

function menuMakeDashboardSecret() {
  menu_(function (ui) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('DASHBOARD_SECRET')) {
      var res = ui.prompt('ダッシュボードの合言葉を作り直す',
        'すでに合言葉があります。作り直すと、ダッシュボードの側にも新しい合言葉を入れ直すまで、ページが開けなくなります。\n' +
        '作り直すときは「作り直す」と入力してください。', ui.ButtonSet.OK_CANCEL);
      if (res.getSelectedButton() !== ui.Button.OK || res.getResponseText().trim() !== '作り直す') return null;
    }
    return makeDashboardSecret_(ss);
  });
}

// 合言葉を作り、ダッシュボードの Apps Script に入れる2つの値を、メニューを押した人にだけ見せる
function makeDashboardSecret_(ss) {
  var url = settings_(ss).relay_url;
  if (!url) throw new Error('「設定」シートの relay_url が空です。先にこの窓口の URL を入れてください');
  var secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('DASHBOARD_SECRET', secret);
  return 'ダッシュボードの合言葉を作りました。ダッシュボードの Apps Script の「プロジェクトの設定 → スクリプト プロパティ」に、次の2つを入れてください。\n\n' +
    'RELAY_URL: ' + url + '\nDASHBOARD_SECRET: ' + secret + '\n\nこの画面を閉じると、合言葉はもう表示されません（作り直すことはできます）。';
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
