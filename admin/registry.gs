/**
 * ミエタスク 管理台帳の窓口（Google Apps Script）
 *
 * 管理台帳のスプレッドシートに付けて、ウェブアプリとして公開する。
 * 各メンバーの mietask は毎朝ここを読んで、自分の所属チームと状態（有効／停止）を確かめる。
 * 投稿のあとには「動いた」ことをここに記録する（管理者が導入状況を見るため）。
 *
 * 読めるのは、ミエタスクの鍵に入っている合言葉を知っている人だけ。
 * スプレッドシート自体の共有範囲は変えなくてよい（スクリプトは公開した人の権限で動く）。
 *
 * ■ 最初の1回
 *   1. スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの中身を貼る
 *   2. 関数 setupSheets を実行する（シートと見出しを作り、合言葉を作る）
 *   3. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *   4. 出てきた URL と、関数 showKey で出る合言葉を mietask admin make-key に渡す
 *
 * ■ シート（見出しの名前で列を探すので、列の並べ替えや列の追加をしても壊れない）
 *   メンバー: 名前 / Slack ID / メール / チーム / 状態 / メモ
 *             チームはチームIDをカンマ区切り（例: pm,pm1）。状態は「有効」か「停止」
 *   チーム:   チームID / 表示名 / 親チーム / まとめチャンネル / 管理者 / メモ
 *             親チームに pm と書けば、PM の管理者の画面に PM1 も入る。管理者は Slack ID をカンマ区切り
 *   設定:     項目 / 値（MTD の Notion の場所など、管理者の画面が使う値）
 *   稼働:     mietask が書く。手で書かない
 */

var SHEETS = {
  members: { name: 'メンバー', headers: ['名前', 'Slack ID', 'メール', 'チーム', '状態', 'メモ'] },
  teams: { name: 'チーム', headers: ['チームID', '表示名', '親チーム', 'まとめチャンネル', '管理者', 'メモ'] },
  settings: { name: '設定', headers: ['項目', '値'] },
  activity: { name: '稼働', headers: ['Slack ID', '名前', '投稿先', 'バージョン', 'OS', '最後に動いた'] },
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!checkKey_(p.key)) return json_({ ok: false, error: '合言葉が違います' });
  if (p.action !== 'get') return json_({ ok: false, error: '不明な操作です: ' + p.action });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return json_({
    ok: true,
    teams: rows_(ss, SHEETS.teams).map(function (r) {
      return {
        id: r['チームID'], name: r['表示名'], parent: r['親チーム'],
        channel: r['まとめチャンネル'], managers: list_(r['管理者']), note: r['メモ'],
      };
    }).filter(function (t) { return t.id; }),
    members: rows_(ss, SHEETS.members).map(function (r) {
      return {
        name: r['名前'], slack_id: r['Slack ID'], email: r['メール'],
        teams: list_(r['チーム']), status: r['状態'] || '有効', note: r['メモ'],
      };
    }).filter(function (m) { return m.slack_id; }),
    settings: rows_(ss, SHEETS.settings).reduce(function (acc, r) {
      if (r['項目']) acc[r['項目']] = r['値'];
      return acc;
    }, {}),
    activity: rows_(ss, SHEETS.activity).map(function (r) {
      return {
        slack_id: r['Slack ID'], name: r['名前'], channel: r['投稿先'],
        version: r['バージョン'], os: r['OS'], at: r['最後に動いた'],
      };
    }),
  });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'JSONが読めません' });
  }
  if (!checkKey_(body.key)) return json_({ ok: false, error: '合言葉が違います' });
  if (body.action !== 'heartbeat') return json_({ ok: false, error: '不明な操作です: ' + body.action });
  if (!/^[UW][A-Z0-9]+$/.test(String(body.slack_id || ''))) return json_({ ok: false, error: 'Slack ID が不正です' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEETS.activity);
    var values = sh.getDataRange().getValues();
    var col = indexOf_(values[0]);
    var at = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
    var row = [];
    row[col['Slack ID']] = body.slack_id;
    row[col['名前']] = String(body.name || '').slice(0, 100);
    row[col['投稿先']] = String(body.channel || '').slice(0, 30);
    row[col['バージョン']] = String(body.version || '').slice(0, 30);
    row[col['OS']] = String(body.os || '').slice(0, 30);
    row[col['最後に動いた']] = at;
    for (var i = 0; i < values[0].length; i++) if (row[i] === undefined) row[i] = '';
    for (var r = 1; r < values.length; r++) {
      if (values[r][col['Slack ID']] === body.slack_id) {
        sh.getRange(r + 1, 1, 1, row.length).setValues([row]);
        return json_({ ok: true });
      }
    }
    sh.appendRow(row);
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/** 最初の1回だけ実行する。シートと見出しを作り、合言葉を作る。既にあるものは消さない。 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (k) { sheet_(ss, SHEETS[k]); });
  var members = sheet_(ss, SHEETS.members);
  var statusCol = indexOf_(members.getRange(1, 1, 1, members.getLastColumn()).getValues()[0])['状態'] + 1;
  members.getRange(2, statusCol, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['有効', '停止'], true).build());
  var activity = sheet_(ss, SHEETS.activity);
  activity.protect().setDescription('mietask が書くシート。手で書かない').setWarningOnly(true);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('MIETASK_KEY')) {
    props.setProperty('MIETASK_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('準備できました。合言葉は showKey で確認できます');
}

/** 合言葉を表示する。鍵を作るときにだけ使う。 */
function showKey() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('MIETASK_KEY'));
}

/** 合言葉を作り直す。鍵が漏れたときに使う。作り直したら鍵も作り直して全員に貼り直してもらう。 */
function rotateKey() {
  PropertiesService.getScriptProperties().setProperty('MIETASK_KEY', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('作り直しました。showKey で新しい合言葉を確認し、鍵を作り直してください');
}

// ---------------------------------------------------------------- 内部

function checkKey_(key) {
  var want = PropertiesService.getScriptProperties().getProperty('MIETASK_KEY');
  return !!want && key === want;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(ss, def) {
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  // 見出しが足りなければ右端に足す（既存の列は動かさない）
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
