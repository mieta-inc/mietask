/**
 * ミエタスク ダッシュボード（Google Apps Script・ウェブアプリ）
 *
 * 「人がいま何をしていて、どこで詰まっているか」を見るページ。1つの URL を全員に配り、見る人によって出るタブと中身が変わる。
 * 見える範囲は管理台帳の「チーム」シートの管理者欄と「メンバー」シートのロールで、窓口（admin/registry.gs）が決める。
 * このスクリプトは見ている人のメールを確かめて窓口に問い合わせ、返ってきたものを並べるだけ。
 *
 *   - メンバー: 「自分」（管理者に見えている内容）と、自分の関わる「案件」
 *   - 管理者（「チーム」の管理者欄にいる人）: 「メンバー」（そのチームと、その下のチームの人）・「案件」・「自分」
 *   - 役員: 全員
 *   - システム管理者: 「管理」のタブで、全員の動作状況と台帳の操作（人を足す・鍵を送る・チームと管理者・ロール・案件の別名）。
 *     案件の中身は見えない。変えたものは窓口がもう一度ロールを確かめてから台帳に書き、「変更の記録」シートに残す
 *
 * 案件は判断の材料として添えるもの。並びの主役は人で、案件のタブは「同じ案件に誰が関わっているか」を確かめる補助。
 *
 * 窓口への問い合わせには合言葉を付ける。人が入力するものではなく、このスクリプトと窓口のあいだだけで使う鍵
 * （窓口はメンバーの mietask から呼べるように誰でも呼べる状態なので、合言葉が無いと、誰かを名乗るだけで
 * その人の見える範囲を取れてしまう）。
 *
 * 窓口とは別のスクリプトにしているのは、公開の設定が違うため。窓口はメンバーの mietask が鍵で呼ぶので
 * 「全員」に公開している。こちらは社内の Google アカウントでしか開けないようにして、見ている人のメールを確かめる。
 *
 * ■ 最初の1回
 *   1. 新しい Apps Script のプロジェクト（スタンドアロン）に、このファイルと appsscript.json を入れる
 *   2. 管理台帳のメニュー「ミエタスク → ダッシュボードの合言葉を作る」で出た RELAY_URL と DASHBOARD_SECRET を、
 *      「プロジェクトの設定 → スクリプト プロパティ」に入れる
 *   3. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 組織内の全員（appsscript.json のとおり）
 *   4. 出てきた URL（https://script.google.com/a/macros/<ドメイン>/s/…/exec の形）を社内に案内する。
 *      ドメインの入った形だと、ブラウザに複数の Google アカウントでログインしていても社内のアカウントで開く
 */

// ミエタスクのアイコン（assets/icon.svg から白い下地を除いたもの。ロゴを差し替えたら、ここも差し替える）
var LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="34" height="34" aria-hidden="true"><g transform="translate(2 1) scale(0.86)"><path d="M5.17 127.75A5.11 5.11 0 0 1 0.12 121.84L18.71 4.86A7.05 7.05 0 0 1 32.17 3.21L61.29 71.86A2.94 2.94 0 0 0 66.71 71.86L95.83 3.21A7.05 7.05 0 0 1 109.29 4.86L127.88 121.84A5.11 5.11 0 0 1 122.83 127.75L92.45 127.75A8.04 8.04 0 0 1 84.59 121.4L81.87 108.78A2.41 2.41 0 0 0 79.52 106.88L78.54 106.88A2.25 2.25 0 0 0 76.82 107.67L66.3 120.13A3.01 3.01 0 0 1 61.7 120.13L51.18 107.67A2.25 2.25 0 0 0 49.46 106.88L48.48 106.88A2.41 2.41 0 0 0 46.13 108.78L43.41 121.4A8.04 8.04 0 0 1 35.55 127.75Z" fill="#E9BB00"/><ellipse cx="35.01" cy="80.1" rx="14.87" ry="20.71" fill="#fff"/><ellipse cx="43.14" cy="73.82" rx="10.8" ry="14.09" transform="rotate(17.64 43.14 73.82)" fill="#E9BB00"/><ellipse cx="92.85" cy="80.1" rx="14.87" ry="20.71" fill="#fff"/><ellipse cx="100.98" cy="73.82" rx="10.8" ry="14.09" transform="rotate(17.64 100.98 73.82)" fill="#E9BB00"/><rect x="14.51" y="54.1" width="41" height="50" rx="12" fill="none" stroke="#1A1A1A" stroke-width="6"/><path d="M21.71 54.1H48.31" stroke="#1A1A1A" stroke-width="7.800000000000001" stroke-linecap="round"/><rect x="72.35" y="54.1" width="41" height="50" rx="12" fill="none" stroke="#1A1A1A" stroke-width="6"/><path d="M79.55 54.1H106.15" stroke="#1A1A1A" stroke-width="7.800000000000001" stroke-linecap="round"/><path d="M55.51 64.1Q63.93 59.1 72.35 64.1" stroke="#1A1A1A" stroke-width="6" fill="none"/><path d="M14.51 64.1L12.8 61.1" stroke="#1A1A1A" stroke-width="6" stroke-linecap="round" fill="none"/><path d="M113.35 64.1L115.2 61.1" stroke="#1A1A1A" stroke-width="6" stroke-linecap="round" fill="none"/></g><g transform="translate(119 66) rotate(135)"><path d="M0 -8.0H61L70 0L61 8.0H0Z" fill="#fff" stroke="#fff" stroke-width="7" stroke-linejoin="round"/></g><g transform="translate(119 66) rotate(135)"><rect x="0" y="-8.0" width="7" height="16" rx="2" fill="#F2A7B8" stroke="#1A1A1A" stroke-width="2"/><rect x="6" y="-8.0" width="4" height="16" fill="#BFC3C7" stroke="#1A1A1A" stroke-width="2"/><rect x="10" y="-8.0" width="51" height="16" fill="#1A1A1A" stroke="#1A1A1A" stroke-width="2"/><path d="M10 -2.67H61" stroke="#3A3A3A" stroke-width="1.6"/><path d="M61 -8.0L70 0L61 8.0Z" fill="#F3D9A4" stroke="#1A1A1A" stroke-width="2" stroke-linejoin="round"/><path d="M66.58 -3.04L70 0L66.58 3.04Z" fill="#1A1A1A"/></g></svg>';
var FAVICON_URL = 'https://raw.githubusercontent.com/mieta-inc/mietask/main/assets/icon-64.png';

var TAB_LABEL = { members: 'メンバー', projects: '案件', self: '自分', admin: '管理' };
var STATE_LABEL = ['期限超過あり', '相手待ち・確認待ち', '動いている', '手伝い', 'しばらく動きなし', 'これから'];

function doGet(e) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var want = e && e.parameter && e.parameter.view === 'health' ? 'admin' : ''; // 以前の動作状況のページの URL は、管理のタブで開く
  var html;
  if (!email) {
    html = messagePage_('社内の Google アカウントで開いてください', 'このページは、社内の Google アカウントでログインしているときだけ見られます。');
  } else {
    try {
      var view = fetchView_(email, '');
      if (!view.viewer) {
        html = messagePage_('このページを見る権限がありません',
          '管理台帳に、このアカウント（' + email + '）の人が登録されていません。登録されているはずなら、システム管理者に連絡してください。');
      } else {
        html = renderPage_(view, want);
      }
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      html = messagePage_('読み込めませんでした', (err && err.message ? err.message : String(err)) + '（しばらくしても直らなければ、システム管理者に連絡してください）');
    }
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle('ミエタスク')
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 窓口に、見ている人に見せてよいものを問い合わせる
function fetchView_(email, view, change) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('RELAY_URL');
  var secret = props.getProperty('DASHBOARD_SECRET');
  if (!url || !secret) throw new Error('ダッシュボードの設定（RELAY_URL・DASHBOARD_SECRET）が入っていません');
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ action: 'dashboard', secret: secret, email: email, view: view || '', change: change || null, page_url: baseUrl_() }),
  });
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('窓口の返事が読めませんでした（HTTP ' + res.getResponseCode() + '）');
  }
  if (!body.ok) throw new Error('窓口が断りました: ' + (body.message || body.error));
  return body;
}

// 管理のタブから呼ばれる（google.script.run）。台帳を変えて、作り直した管理のタブの HTML と知らせを返す。
// 見ている人はここでも Google のログインから確かめ直し、システム管理者かどうかは窓口が確かめる
function saveChange(change) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('社内の Google アカウントで開いてください');
  var view = fetchView_(email, 'health', change);
  if (!view.viewer || view.forbidden) throw new Error('台帳を変えられるのはシステム管理者だけです');
  return { html: adminBody_(view), message: view.message || '' };
}

// このページの URL（鍵や案内の DM に書くため、窓口に知らせる）
function baseUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; }
}

// ---------------------------------------------------------------- 部品

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function md_(ymd) {
  var p = String(ymd || '').slice(0, 10).split('-');
  return p.length === 3 ? Number(p[1]) + '/' + Number(p[2]) : '';
}

function hm_(iso) {
  var m = String(iso || '').match(/T(\d\d):(\d\d)/);
  return m ? Number(m[1]) + ':' + m[2] : '';
}

function rank_(r) { return Math.max(0, Math.min(5, Number(r) || 0)); }

// 案件1つぶんのカード。1行目 案件名と関わり方／2行目 いまの状態の一言／3行目 状態と期限・期間・最後に動いた日。
// 詳細があればカードの中で開く。並び替えに使う値を data- に持たせる
var STAGES = ['準備', '進行中', '仕上げ', '運用中'];

// 段階のバー（4つのうち、いまの段階までを塗る）
function stageHtml_(stage, r) {
  var at = STAGES.indexOf(stage);
  if (at < 0) return '';
  return '<div class="stage"><div class="steps" title="' + esc_(STAGES.join(' → ')) + '">' + STAGES.map(function (s, i) {
    return '<i' + (i <= at ? ' class="on"' : '') + '></i>';
  }).join('') + '</div><div class="sl"><b>' + esc_(stage) + '</b><span>' + STATE_LABEL[r] + '</span></div></div>';
}

// 次の節目（「次：11/25 項目を固める打合せ」）。日付を過ぎていれば赤
function nextHtml_(o) {
  if (!o.next) return '';
  var late = o.next_date && o.today && o.next_date < o.today;
  var when = o.next_date ? (o.next_date === o.today ? '今日' : md_(o.next_date)) : '日付未定';
  return '<div class="next">次：<span class="nd' + (late ? ' late' : '') + '">' + esc_(when) + '</span>' + esc_(o.next) + '</div>';
}

function cardHtml_(o) {
  var r = rank_(o.rank);
  var stage = stageHtml_(o.stage, r);
  return '<div class="card s' + r + '" data-rank="' + r + '" data-name="' + esc_(o.name) + '" data-role="' + esc_(o.role || '') + '"' +
    ' data-last="' + esc_(o.last || '') + '" data-due="' + esc_(o.due || '') + '" data-count="' + Number(o.count || 0) + '"' +
    ' data-stage="' + (STAGES.indexOf(o.stage) < 0 ? 9 : STAGES.indexOf(o.stage)) + '" data-next="' + esc_(o.next ? o.next_date || '9998' : '9999') + '">' +
    '<div class="ct"><span class="pn">' + esc_(o.name) + '</span>' + (o.role ? '<span class="role">' + esc_(o.role) + '</span>' : '') + '</div>' +
    stage + nextHtml_(o) +
    (o.note ? '<div class="note">' + esc_(o.note) + '</div>' : '') +
    (o.extra || '') +
    '<div class="meta">' + esc_([stage ? '' : STATE_LABEL[r], o.meta].filter(String).join('・')) + '</div>' +
    (o.detail ? '<details><summary>詳細</summary><p class="detail">' + esc_(o.detail) + '</p></details>' : '') + '</div>';
}

// これからの節目（期限を過ぎたものと、今日から2週間のもの）を日付順に並べた帯
function milestonesHtml_(items, today) {
  var end = addDaysYmd_(today, 14);
  var list = items.filter(function (it) { return it.next && it.next_date && it.next_date <= end; })
    .sort(function (a, b) { return a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0; });
  if (!list.length) return '';
  return '<div class="strip-wrap"><div class="lbl">これからの節目（2週間）</div><div class="strip">' + list.map(function (it) {
    var cls = it.next_date < today ? ' late' : it.next_date === today ? ' today' : '';
    var when = it.next_date === today ? '今日' : md_(it.next_date) + (it.next_date < today ? ' 過ぎている' : '');
    return '<div class="ms"><div class="d' + cls + '">' + esc_(when) + '</div><div class="x"><b>' + esc_(it.name) + '</b>：' + esc_(it.next) + '</div></div>';
  }).join('') + '</div></div>';
}

function addDaysYmd_(ymd, n) {
  var p = String(ymd).split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

var SORTS = {
  person: [['rank', '状態'], ['stage', '段階'], ['next', '次の節目'], ['last', '最近動いた'], ['role', '関わり方'], ['name', '名前']],
  project: [['rank', '状態'], ['due', '次の期限'], ['count', '人数'], ['name', '名前']],
};

function sortBar_(kind) {
  return '<div class="sortbar"><span class="lbl">並び</span><div class="seg">' + SORTS[kind].map(function (s, i) {
    return '<button type="button" data-sort="' + s[0] + '" aria-pressed="' + (i === 0) + '">' + s[1] + '</button>';
  }).join('') + '</div></div>';
}

// 1人ぶん。名前・持っている案件の数・気にすべきもの、並び替え、案件のカード
function personPanel_(c, hidden, today) {
  var flags = (c.overdue.length ? '<span class="flag f0">期限超過 ' + c.overdue.length + '</span>' : '') +
    (c.waiting.length ? '<span class="flag f1">相手待ち ' + c.waiting.length + '</span>' : '');
  var sub = [(c.team_names || c.teams).join('・'), '持っている案件 ' + c.now + '件' + (c.idle ? '（うちしばらく動きなし ' + c.idle + '件）' : ''),
    c.later ? 'これから ' + c.later + '件' : ''].filter(String).join('・');
  var cards = c.items.map(function (it) {
    return cardHtml_({ rank: it.rank, name: it.name, role: it.role, note: it.note, meta: it.meta, detail: it.detail, last: it.last,
      stage: it.stage, next: it.next, next_date: it.next_date, today: today });
  }).join('');
  return '<div class="person" data-person="' + esc_(c.slack_id) + '"' + (hidden ? ' hidden' : '') + '>' +
    '<div class="phead"><h3>' + esc_(c.name) + '</h3><span class="sub">' + esc_(sub) + '</span>' + flags + '</div>' +
    (c.notes ? '<p class="notes">' + esc_(c.notes) + '</p>' : '') +
    milestonesHtml_(c.items, today) +
    (cards ? sortBar_('person') + '<div class="cards">' + cards + '</div>' : '<p class="notes">見える案件はありません</p>') +
    (c.share_at ? '<p class="foot">ミエタスク ' + md_(c.share_at) + ' ' + hm_(c.share_at) + '時点</p>' : '') + '</div>';
}

// メンバーのタブ。人は丸いボタンで1人ずつ選ぶ（気にすべきものがある人から並ぶ）。チームが複数見えるなら、ボタンをチームで絞れる
function membersPanel_(v) {
  var teamsOf = {};
  (v.teams || []).forEach(function (t) { t.members.forEach(function (id) { (teamsOf[id] = teamsOf[id] || []).push(t.id); }); });
  var people = v.people || [];
  if (!people.length) return '<p class="empty">見える範囲にメンバーがいません</p>';
  var filter = (v.teams || []).length > 1 ? '<label class="filter">チーム <select data-team><option value="">すべて</option>' +
    v.teams.map(function (t) { return '<option value="' + esc_(t.id) + '">' + esc_(t.name) + '</option>'; }).join('') + '</select></label>' : '';
  var pills = people.map(function (c, i) {
    var n = c.overdue.length;
    return '<button type="button" class="pill" data-pick="' + esc_(c.slack_id) + '" data-teams=" ' + esc_((teamsOf[c.slack_id] || []).join(' ')) + ' "' +
      ' aria-pressed="' + (i === 0) + '">' + esc_(c.name) + (n ? '<span class="n" title="期限超過">' + n + '</span>' : '') + '</button>';
  }).join('');
  return '<div class="pickbar">' + filter + '<div class="pills">' + pills + '</div></div>' +
    people.map(function (c, i) { return personPanel_(c, i > 0, v.today); }).join('') +
    '<p class="lead">気にすべきものがある人から並べています。一言と詳細は各自の Claude が書いたもの（タスクの題名・人の名前は入りません）。</p>';
}

function projectsPanel_(v) {
  var list = v.projects || [];
  var cards = list.map(function (p) {
    var who = p.members.map(function (m) { return esc_(m.name) + (m.role ? '<span class="role">' + esc_(m.role) + '</span>' : ''); }).join('、') +
      (p.others ? '<span class="meta">・ほかに' + Number(p.others) + '人</span>' : '');
    var meta = [p.due_label ? '次の期限 ' + p.due_label : '', p.counts || '', p.progress ? p.progress.label : ''].filter(String).join('・');
    return cardHtml_({ rank: p.rank, name: p.name, meta: meta, due: p.due || (p.progress ? '' : ''), count: p.members.length + Number(p.others || 0),
      extra: '<div class="who">' + who + '</div>' });
  }).join('');
  return '<p class="lead">同じ案件に誰が関わっているかを確かめる補助の一覧です。案件の名前は、各自の Claude が Slack・メール・議事録・MTD から束ねてつけたもの' +
    '（同じ案件が別の名前で出ていたら、システム管理者が1つにまとめられます）。</p>' +
    (cards ? sortBar_('project') + '<div class="cards">' + cards + '</div>' : '<p class="empty">見える案件はまだありません（各自のミエタスクが朝に送ると出ます）</p>');
}

function selfPanel_(v) {
  return '<p class="lead">管理者・役員には、この内容が見えています。</p>' + personPanel_(v.self, false, v.today);
}

function renderPage_(v, want) {
  var tabs = (v.tabs || ['self']).filter(function (t) { return TAB_LABEL[t] && (t !== 'admin' || v.admin); });
  var first = tabs.indexOf(want) >= 0 ? want : tabs[0];
  var make = { members: membersPanel_, projects: projectsPanel_, self: selfPanel_,
    admin: function () { return '<p class="flash" role="status"></p><div id="admin">' + adminBody_(v.admin) + '</div>'; } };
  var nav = '<nav role="tablist">' + tabs.map(function (t) {
    return '<button role="tab" data-tab="' + t + '" aria-selected="' + (t === first) + '">' + TAB_LABEL[t] + '</button>';
  }).join('') + '</nav>';
  var panels = tabs.map(function (t) {
    return '<section role="tabpanel" id="' + t + '"' + (t === first ? '' : ' hidden') + '>' + make[t](v) + '</section>';
  }).join('');
  var problems = (v.problems || []).length ? '<div class="problems">' + v.problems.map(function (p) { return '<p>' + esc_(p) + '</p>'; }).join('') + '</div>' : '';
  return page_('<header class="top">' + brand_() + '<span>' + esc_(v.viewer.name) + '　' + md_(v.today) + '時点</span></header>' +
    problems + nav + panels +
    '<footer>出どころは MTD（Notion）と、各自のミエタスクが毎朝送る案件ごとの状態と一言です。タスクの題名・メールや DM の中身は入っていません。</footer>' +
    (v.admin ? '<dialog id="edit"><h2></h2><div class="body"></div><p class="err" role="alert"></p>' +
      '<div class="actions"><span class="extra"></span><button type="button" data-cancel>やめる</button><button type="button" data-save class="primary">保存</button></div></dialog>' : '') +
    '<script>' + CLIENT_JS + (v.admin ? ADMIN_JS : '') + '</script>');
}

// 管理のタブの中身。動作状況と台帳の設定だけ（案件の中身は出さない）
// 管理台帳（スプレッドシート）を別のタブで開くリンク。窓口が返した Google スプレッドシートの URL だけを使う
function ledgerLink_(url) {
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(String(url || ''))) return '';
  return '<a class="ledger" href="' + esc_(url) + '" target="_blank" rel="noopener">管理台帳を開く ↗</a>';
}

function adminBody_(a) {
  var rows = a.health || [];
  var issues = rows.filter(function (h) { return h.issues && h.issues.length; });
  var warn = { '止まっているかも': 1, 'セットアップ待ち': 1, '鍵なし': 1 };
  var members = rows.map(function (h) {
    return '<tr' + (h.status === '停止' ? ' class="stopped"' : '') + '><td>' + esc_(h.name) + '</td><td>' + esc_(h.teams.join(', ')) + '</td>' +
      '<td>' + esc_(h.roles.join(', ')) + '</td><td class="' + (warn[h.state] ? 'warn' : '') + '">' + esc_(h.state) +
      (h.last_run ? '<span class="meta">・' + esc_(md_(h.last_run) + ' ' + hm_(h.last_run)) + '</span>' : '') + '</td>' +
      '<td>' + esc_(String(h.version).split(' ')[0]) + '</td><td>' + esc_(md_(h.share_date)) + '</td>' +
      '<td class="acts"><button type="button" class="small" data-member="' + esc_(h.slack_id) + '">変える</button>' +
      (h.status === '停止' ? '' : '<button type="button" class="small" data-key="' + esc_(h.slack_id) + '">鍵を送る</button>') + '</td></tr>';
  }).join('');
  var count = {};
  rows.forEach(function (h) { h.teams.forEach(function (t) { count[t.toLowerCase()] = (count[t.toLowerCase()] || 0) + 1; }); });
  var nameOf = {};
  rows.forEach(function (h) { nameOf[h.slack_id] = h.name; });
  var teams = (a.teams || []).map(function (t) {
    var mgr = (t.managers || []).map(function (u) { return nameOf[u] || u + '（台帳にいない）'; }).join('、');
    return '<tr><td>' + esc_(t.id) + '</td><td>' + esc_(t.name) + '</td><td>' + esc_(t.parent) + '</td><td>' + esc_(mgr) + '</td><td>' + (count[t.id.toLowerCase()] || 0) + '人</td>' +
      '<td class="acts"><button type="button" class="small" data-team="' + esc_(t.id) + '">変える</button></td></tr>';
  }).join('');
  var aliases = (a.aliases || []).map(function (x) {
    return '<tr><td>' + esc_(x.alias) + '</td><td>' + esc_(x.name) + '</td>' +
      '<td class="acts"><button type="button" class="small" data-unmerge="' + esc_(x.alias) + '">外す</button></td></tr>';
  }).join('');
  var log = (a.log || []).map(function (l) {
    return '<tr><td>' + esc_(String(l['日時']).replace('T', ' ').slice(0, 16)) + '</td><td>' + esc_(l['変えた人']) + '</td><td>' + esc_(l['対象']) + '</td>' +
      '<td>' + esc_(l['項目']) + '</td><td>' + esc_(l['前']) + '</td><td>' + esc_(l['後']) + '</td></tr>';
  }).join('');
  var fix = issues.length ? '<div class="problems"><p>台帳の直すところ</p>' + issues.map(function (h) {
    return '<p>・' + esc_(h.name) + '：' + esc_(h.issues.join(' / ')) + '</p>';
  }).join('') + '</div>' : '';
  var data = {
    members: rows.map(function (h) {
      return { slack_id: h.slack_id, name: h.name, email: h.email, teams: h.teams, roles: h.roles, status: h.status, notion_user: h.notion_user || '', key: h.key || '' };
    }),
    teams: a.teams || [], roles: a.roles || [], managers_on_teams: !!a.managers_on_teams,
  };
  var table = function (head, body, empty) {
    return body ? '<div class="scroll"><table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
      : '<p class="empty">' + empty + '</p>';
  };
  return '<div class="subnav" role="tablist">' +
    '<button type="button" data-sub="a-members" aria-selected="true">メンバー</button><button type="button" data-sub="a-teams" aria-selected="false">チーム</button>' +
    '<button type="button" data-sub="a-aliases" aria-selected="false">案件の別名</button><button type="button" data-sub="a-log" aria-selected="false">変更の記録</button>' +
    ledgerLink_(a.ledger_url) + '</div>' +
    '<div data-subpanel="a-members">' + fix +
    '<div class="bar"><span class="lead">動いているかどうかの点検と、台帳の操作です。案件の中身は出ません。鍵は Bot が本人に DM で送り、この画面には出しません。</span>' +
    '<button type="button" data-add-member>メンバーを足す</button></div>' +
    table(['名前', 'チーム', 'ロール', '動き', '版', '要約が届いた日', ''], members, 'まだ誰もいません') + '</div>' +
    '<div data-subpanel="a-teams" hidden><div class="bar"><span class="lead">' +
    (a.managers_on_teams ? 'チームの管理者には、そのチームと、その下のチームの人が見えます。'
      : '管理者をここで選ぶには、先に台帳のメニュー「シートを整える」を1回押してください（いまの管理者のロールを、チームに移します）。') + '</span><button type="button" data-add-team>チームを足す</button></div>' +
    table(['チームID', '表示名', '親チーム', '管理者', '人数', ''], teams, 'チームがありません') + '</div>' +
    '<div data-subpanel="a-aliases" hidden><div class="bar"><span class="lead">同じ案件が人によって別の名前で届いたものを、1つに束ねます。名前は画面に出ているとおりに書きます。</span>' +
    '<button type="button" data-merge>案件をまとめる</button></div>' +
    table(['束ねる名前', 'まとめ先', ''], aliases, 'まだ束ねた案件はありません') + '</div>' +
    '<div data-subpanel="a-log" hidden>' + table(['日時', '変えた人', '対象', '項目', '前', '後'], log, 'まだ変更はありません') + '</div>' +
    // 編集の画面が使う今の値。< を逃がして、中身で script が閉じないようにする
    '<script type="application/json" id="admin-data">' + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>';
}

function brand_() { return '<span class="logo">' + LOGO_SVG + '</span><h1>ミエタスク</h1>'; }

function messagePage_(title, body) {
  return page_('<header class="top">' + brand_() + '</header><div class="message"><h2>' + esc_(title) + '</h2><p>' + esc_(body) + '</p></div>');
}

function page_(body) {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ミエタスク</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}

// タブ・人の選択・チームの絞り込み・並び替え。データは持たない（サーバーで作った HTML を出し分け・並べ替えるだけ）
var CLIENT_JS = `
(function () {
  document.querySelectorAll('nav [data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav [data-tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      document.querySelectorAll('section[role=tabpanel]').forEach(function (p) { p.hidden = p.id !== b.getAttribute('data-tab'); });
    });
  });
  var panel = document.getElementById('members');
  function pickPerson(id) {
    panel.querySelectorAll('[data-pick]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-pick') === id)); });
    panel.querySelectorAll('.person').forEach(function (p) { p.hidden = p.getAttribute('data-person') !== id; });
  }
  if (panel) {
    panel.querySelectorAll('[data-pick]').forEach(function (b) {
      b.addEventListener('click', function () { pickPerson(b.getAttribute('data-pick')); });
    });
    var team = panel.querySelector('[data-team]');
    if (team) team.addEventListener('change', function () {
      var first = null, keep = false;
      panel.querySelectorAll('[data-pick]').forEach(function (b) {
        b.hidden = !!team.value && b.getAttribute('data-teams').indexOf(' ' + team.value + ' ') < 0;
        if (!b.hidden && !first) first = b;
        if (!b.hidden && b.getAttribute('aria-pressed') === 'true') keep = true;
      });
      if (!keep && first) pickPerson(first.getAttribute('data-pick'));
    });
  }
  // 並び替え：同じかたまりの .cards の中のカードを並べ直す
  var num = function (c, k) { return Number(c.getAttribute('data-' + k)) || 0; };
  var str = function (c, k) { return c.getAttribute('data-' + k) || ''; };
  var byName = function (a, b) { return str(a, 'name').localeCompare(str(b, 'name'), 'ja'); };
  var cmp = {
    rank: function (a, b) { return num(a, 'rank') - num(b, 'rank') || byName(a, b); },
    name: byName,
    role: function (a, b) { return (str(a, 'role') || '\\uffff').localeCompare(str(b, 'role') || '\\uffff', 'ja') || num(a, 'rank') - num(b, 'rank'); },
    last: function (a, b) { return str(b, 'last').localeCompare(str(a, 'last')) || num(a, 'rank') - num(b, 'rank'); },
    due: function (a, b) { return (str(a, 'due') || '9999').localeCompare(str(b, 'due') || '9999') || num(a, 'rank') - num(b, 'rank'); },
    stage: function (a, b) { return num(a, 'stage') - num(b, 'stage') || num(a, 'rank') - num(b, 'rank'); },
    next: function (a, b) { return str(a, 'next').localeCompare(str(b, 'next')) || num(a, 'rank') - num(b, 'rank'); },
    count: function (a, b) { return num(b, 'count') - num(a, 'count') || num(a, 'rank') - num(b, 'rank'); },
  };
  document.querySelectorAll('.sortbar').forEach(function (bar) {
    var grid = bar.nextElementSibling;
    var first = Array.prototype.slice.call(grid.children);
    bar.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        bar.querySelectorAll('[data-sort]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        var k = b.getAttribute('data-sort');
        // 状態順は、窓口が並べた元の順（状態・期限の近い順）に戻す
        var list = k === 'rank' ? first.slice() : Array.prototype.slice.call(grid.children).sort(cmp[k]);
        list.forEach(function (c) { grid.appendChild(c); });
      });
    });
  });
})();
`;

// 管理のタブの操作。保存は google.script.run で saveChange を呼び、返ってきた HTML で管理のタブを差し替える
var ADMIN_JS = `
(function () {
  var root = document.getElementById('admin');
  var dlg = document.getElementById('edit');
  var flash = document.querySelector('.flash');
  var sub = 'a-members';
  function data() { return JSON.parse(document.getElementById('admin-data').textContent); }
  function showSub() {
    root.querySelectorAll('[data-sub]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-sub') === sub)); });
    root.querySelectorAll('[data-subpanel]').forEach(function (p) { p.hidden = p.getAttribute('data-subpanel') !== sub; });
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function field(label, input, note) {
    return el('div', { class: 'field' }, [el('span', { class: 'label', text: label }), input].concat(note ? [el('span', { class: 'note', text: note })] : []));
  }
  function checks(options, selected) {
    var box = el('div', { class: 'checks' });
    var lower = selected.map(function (x) { return String(x).toLowerCase(); });
    options.forEach(function (o) {
      var c = el('input', { type: 'checkbox', value: o.value });
      c.checked = lower.indexOf(String(o.value).toLowerCase()) >= 0;
      box.appendChild(el('label', {}, [c, el('span', { text: o.label })]));
    });
    return box;
  }
  function picked(box) { return Array.prototype.slice.call(box.querySelectorAll('input:checked')).map(function (c) { return c.value; }); }
  function choose(options, value) {
    var s = el('select');
    options.forEach(function (o) { var op = el('option', { value: o.value, text: o.label }); if (o.value === value) op.selected = true; s.appendChild(op); });
    return s;
  }
  function text(value, placeholder) { var i = el('input', { type: 'text', placeholder: placeholder || '' }); i.value = value || ''; return i; }
  function teamLabel(t) { return t.name && t.name !== t.id ? t.name + '（' + t.id + '）' : t.id; }
  function send(change, done, fail) {
    google.script.run
      .withSuccessHandler(function (r) { root.innerHTML = r.html; showSub(); flash.textContent = r.message || '保存しました（変更の記録に残しました）'; if (done) done(); })
      .withFailureHandler(function (e) { var m = (e && e.message) || String(e); if (fail) fail(m); else flash.textContent = m; })
      .saveChange(change);
  }
  function show(title, body, make, extra) {
    dlg.querySelector('h2').textContent = title;
    var b = dlg.querySelector('.body');
    b.textContent = '';
    body.forEach(function (x) { b.appendChild(x); });
    var ex = dlg.querySelector('.extra');
    ex.textContent = '';
    if (extra) ex.appendChild(extra);
    var err = dlg.querySelector('.err');
    err.textContent = '';
    var save = dlg.querySelector('[data-save]');
    save.disabled = false;
    save.onclick = function () {
      save.disabled = true;
      err.textContent = '保存しています…';
      send(make(), function () { dlg.close(); }, function (m) { save.disabled = false; err.textContent = m; });
    };
    dlg.showModal();
  }
  function act(label, message, change) {
    var b = el('button', { type: 'button', class: 'link', text: label });
    b.onclick = function () { if (confirm(message)) { dlg.close(); flash.textContent = '送っています…'; send(change); } };
    return b;
  }
  function memberFields(m) {
    var d = data();
    var known = d.teams.map(function (t) { return t.id.toLowerCase(); });
    var lost = m.teams.filter(function (t) { return known.indexOf(t.toLowerCase()) < 0; });
    var f = {
      name: text(m.name, '山田 太郎'),
      teams: checks(d.teams.map(function (t) { return { value: t.id, label: teamLabel(t) }; }), m.teams),
      roles: checks(d.roles.map(function (r) { return { value: r, label: r }; }), m.roles),
      email: text(m.email, 'name@example.com'),
      notion: text(m.notion_user, 'Notion のユーザーID（32桁）'),
    };
    f.list = [
      field('名前', f.name),
      field('チーム', f.teams, lost.length ? '「チーム」シートに無い ' + lost.join('、') + ' は外れます' : ''),
      field('ロール', f.roles, d.managers_on_teams ? 'どれも付けなければ、自分の分だけが見えるメンバーです。役員を付けると、ページの案内が DM で届きます。チームの管理者は「チーム」で選びます'
        : 'どれも付けなければ、自分の分だけが見えるメンバーです。管理者・役員を付けると、ページの案内が DM で届きます'),
      field('メール', f.email, '社内の Google アカウント。ページはこのメールで本人を見分けます'),
      field('Notion ユーザー', f.notion, 'MTD の案件と結びつけるのに使います。空なら MTD は出ません'),
    ];
    return f;
  }
  function editMember(id) {
    var m = data().members.filter(function (x) { return x.slack_id === id; })[0];
    if (!m) return;
    var f = memberFields(m);
    var status = choose([{ value: '有効', label: '有効' }, { value: '停止', label: '停止（ミエタスクも止まる）' }], m.status);
    var extra = m.key && !/^無効/.test(m.key) ? act('鍵を無効にする', m.name + ' さんの鍵を無効にしますか？ この時点からミエタスクが止まります。', { kind: 'revoke_key', slack_id: m.slack_id }) : null;
    show(m.name + ' さん', f.list.concat([field('状態', status)]), function () {
      return { kind: 'member', slack_id: m.slack_id,
        set: { name: f.name.value, teams: picked(f.teams), roles: picked(f.roles), status: status.value, email: f.email.value, notion_user: f.notion.value },
        base: { name: m.name, teams: m.teams, roles: m.roles, status: m.status, email: m.email, notion_user: m.notion_user } };
    }, extra);
  }
  function addMember() {
    var f = memberFields({ name: '', teams: [], roles: [], email: '', notion_user: '' });
    var sid = text('', 'U0123ABCD');
    show('メンバーを足す', [f.list[0], field('Slack ID', sid, 'Slack のプロフィールの「︙」→「メンバーIDをコピー」')].concat(f.list.slice(1)), function () {
      return { kind: 'add_member', name: f.name.value, slack_id: sid.value, teams: picked(f.teams), roles: picked(f.roles), email: f.email.value, notion_user: f.notion.value };
    });
  }
  function sendKey(id) {
    var m = data().members.filter(function (x) { return x.slack_id === id; })[0];
    if (!m) return;
    var again = m.key && !/^無効/.test(m.key);
    if (!confirm(m.name + ' さんに鍵を DM で送りますか？' + (again ? ' 前の鍵は使えなくなります（入れ直しが要ります）。' : ''))) return;
    flash.textContent = '送っています…';
    send({ kind: 'send_key', slack_id: id });
  }
  function parents(except, value) {
    var opts = [{ value: '', label: '（なし・一番上）' }];
    data().teams.forEach(function (t) { if (t.id !== except) opts.push({ value: t.id, label: teamLabel(t) }); });
    return choose(opts, value);
  }
  // 管理者に選べるのは、台帳にいて停止していない人（いまの管理者は停止していても外せるように出す）
  function managers(selected) {
    var opts = data().members.filter(function (m) { return m.status !== '停止' || selected.indexOf(m.slack_id) >= 0; })
      .map(function (m) { return { value: m.slack_id, label: m.name }; });
    return checks(opts, selected);
  }
  var MANAGER_NOTE = 'このチームと、その下のチームの人が見えます。新しく選んだ人には、ページの案内が DM で届きます';
  function editTeam(id) {
    var d = data();
    var t = d.teams.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var name = text(t.name);
    var parent = parents(t.id, t.parent);
    var mgr = d.managers_on_teams ? managers(t.managers || []) : null;
    var list = [field('表示名', name), field('親チーム', parent, '親チームの管理者には、このチームの人も見えます')];
    if (mgr) list.push(field('管理者', mgr, MANAGER_NOTE));
    show('チーム ' + t.id, list, function () {
      var set = { name: name.value, parent: parent.value }, base = { name: t.name, parent: t.parent };
      if (mgr) { set.managers = picked(mgr); base.managers = t.managers || []; }
      return { kind: 'team', id: t.id, set: set, base: base };
    });
  }
  function addTeam() {
    var id = text('', 'pm3');
    var name = text('', 'PM3');
    var parent = parents('', '');
    var mgr = data().managers_on_teams ? managers([]) : null;
    var list = [field('チームID', id, '英数字・- ・_ 。あとから変えられません'), field('表示名', name), field('親チーム', parent)];
    if (mgr) list.push(field('管理者', mgr, MANAGER_NOTE));
    show('チームを足す', list, function () {
      return { kind: 'add_team', id: id.value, name: name.value, parent: parent.value, managers: mgr ? picked(mgr) : [] };
    });
  }
  function merge() {
    var from = text('', '渋谷区WS');
    var to = text('', '渋谷区');
    show('案件をまとめる', [field('束ねる名前', from, '画面に出ている名前'), field('まとめ先', to, 'この名前で1つに出ます')], function () {
      return { kind: 'merge', from: from.value, to: to.value };
    });
  }
  function unmerge(alias) {
    if (!confirm('「' + alias + '」のまとめを外しますか？ 別々に出るようになります。')) return;
    flash.textContent = '保存しています…';
    send({ kind: 'unmerge', alias: alias });
  }
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    flash.textContent = '';
    if (b.hasAttribute('data-sub')) { sub = b.getAttribute('data-sub'); showSub(); }
    else if (b.hasAttribute('data-member')) editMember(b.getAttribute('data-member'));
    else if (b.hasAttribute('data-key')) sendKey(b.getAttribute('data-key'));
    else if (b.hasAttribute('data-add-member')) addMember();
    else if (b.hasAttribute('data-team')) editTeam(b.getAttribute('data-team'));
    else if (b.hasAttribute('data-add-team')) addTeam();
    else if (b.hasAttribute('data-merge')) merge();
    else if (b.hasAttribute('data-unmerge')) unmerge(b.getAttribute('data-unmerge'));
  });
  dlg.querySelector('[data-cancel]').addEventListener('click', function () { dlg.close(); });
})();
`;

var CSS = [
  // ロゴの黄（#E9BB00）と黒を基調にする。状態の色（期限超過の赤・相手待ちの橙・これからの青）は黄と混ざらない色にする
  ':root{--bg:#fbfaf6;--panel:#fff;--ink:#1a1a1a;--muted:#5d5b55;--faint:#99968c;--line:#e9e5d9;--soft:#f6f2e6;',
  '--brand:#e9bb00;--brand-soft:#fff4c2;--red:#c0392b;--red-bg:#fbeceb;--amber:#c2650f;--amber-bg:#fdecd9;--blue:#2457a6;--accent:#1a1a1a}',
  '@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#f1eee6;--muted:#b3b0a7;--faint:#85827a;--line:#302e29;--soft:#26241f;',
  '--brand:#e9bb00;--brand-soft:#3b3214;--red:#ef8a7f;--red-bg:#3a2321;--amber:#f0a35e;--amber-bg:#3b2a1a;--blue:#8db4ef;--accent:#f1eee6}}',
  '*{box-sizing:border-box}body{margin:0 auto;max-width:1080px;padding:20px 16px 40px;background:var(--bg);color:var(--ink);',
  'font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}',
  'html{border-top:4px solid var(--brand)}.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.logo{display:inline-flex;width:34px;height:34px}',
  '.top h1{font-size:20px;font-weight:800;letter-spacing:.02em;margin:0}.top span{color:var(--muted);font-size:13px;margin-left:4px}',
  // 暗い画面ではロゴの黒い線が沈むので、白い下地に載せる
  '@media (prefers-color-scheme:dark){.logo{background:#fff;border-radius:8px;padding:2px}}',
  'nav{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:14px 0 18px}',
  'nav button{font:inherit;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 14px;color:var(--muted);cursor:pointer}',
  'nav button[aria-selected=true]{color:var(--ink);border-bottom:3px solid var(--brand);font-weight:700}nav button:hover{color:var(--ink)}',
  '.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 8px}',
  '.lead{color:var(--muted);font-size:12px;margin:0 0 8px}.bar .lead{margin:0}.filter{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center}',
  'select,input[type=text]{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 8px}',
  '.pickbar{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin:0 0 14px}.pills{display:flex;gap:6px;flex-wrap:wrap;flex:1}',
  '.pill{border-radius:999px;padding:4px 14px;font-size:13px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}',
  '.pill[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--bg)}.pill:hover{border-color:var(--ink)}',
  '.pill .n{display:inline-block;margin-left:6px;min-width:18px;padding:0 6px;border-radius:999px;font-size:11px;background:var(--red);color:#fff;text-align:center}',
  '.phead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 2px}.phead h3{margin:0;font-size:17px;font-weight:600}.sub{color:var(--faint);font-size:12px}',
  '.flag{font-size:12px;padding:1px 8px;border-radius:999px}.f0{background:var(--red-bg);color:var(--red)}.f1{background:var(--amber-bg);color:var(--amber)}',
  '.sortbar{display:flex;align-items:center;gap:8px;margin:10px 0 10px}.sortbar .lbl{font-size:12px;color:var(--muted)}',
  '.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--panel)}',
  '.seg button{border:0;border-radius:0;font-size:12px;padding:3px 12px;background:none;color:var(--muted)}.seg button[aria-pressed=true]{background:var(--brand-soft);color:var(--ink);font-weight:700}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;align-items:start}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;font-size:13px;min-width:0}',
  '.card.s0{box-shadow:inset 3px 0 0 var(--red)}.card.s1{box-shadow:inset 3px 0 0 var(--amber)}.card.s5{box-shadow:inset 3px 0 0 var(--blue)}.card.s4{opacity:.6}',
  '.ct{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.pn{font-weight:600;overflow-wrap:anywhere}.role{color:var(--faint);font-size:12px;white-space:nowrap}',
  '.note{color:var(--muted);overflow-wrap:anywhere}.meta{color:var(--faint);font-size:12px}.who{font-size:12px;overflow-wrap:anywhere}.who .role{margin-left:2px}',
  '.card details{margin-top:2px}.card summary{cursor:pointer;font-size:12px;color:var(--ink);list-style:none;text-decoration:underline;text-decoration-color:var(--brand);text-decoration-thickness:2px;text-underline-offset:3px;align-self:flex-start}.card summary::-webkit-details-marker{display:none}',
  '.card summary::after{content:" ▾"}.card details[open] summary::after{content:" ▴"}',
  '.detail{margin:4px 0 0;padding:6px 9px;background:var(--soft);border-radius:6px;color:var(--ink);font-size:12.5px;line-height:1.6}',
  '.stage{display:flex;flex-direction:column;gap:3px;margin:2px 0}.steps{display:flex;gap:3px}.steps i{flex:1;height:5px;border-radius:3px;background:var(--line)}',
  '.steps i.on{background:var(--brand)}.sl{display:flex;justify-content:space-between;font-size:11px;color:var(--faint)}.sl b{color:var(--ink);font-weight:700}',
  '.next{font-size:12px;background:var(--soft);border-radius:6px;padding:3px 8px}.nd{font-weight:700;margin-right:6px}.nd.late{color:var(--red)}',
  '.strip-wrap{margin:10px 0 2px}.strip-wrap .lbl{font-size:12px;color:var(--muted);margin-bottom:6px}',
  '.strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}.ms{flex:0 0 auto;max-width:240px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px}',
  '.ms .d{font-weight:700;font-size:12px}.ms .d.late{color:var(--red)}.ms .d.today{color:var(--ink);background:var(--brand-soft);display:inline-block;padding:0 6px;border-radius:4px}',
  '.ms .x{font-size:12px;color:var(--muted)}.ms .x b{color:var(--ink);font-weight:600}',

  '.notes{margin:4px 0 0;color:var(--faint);font-size:12px}.foot{margin:10px 0 0;color:var(--faint);font-size:11px}',
  '.empty{color:var(--muted)}',
  '.problems{background:var(--amber-bg);color:var(--amber);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:13px}.problems p{margin:2px 0}',
  '.subnav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
  '.subnav button{font:inherit;font-size:13px;background:none;border:1px solid var(--line);border-radius:999px;padding:3px 12px;color:var(--muted);cursor:pointer}',
  '.subnav button[aria-selected=true]{color:var(--ink);border-color:var(--ink);background:var(--brand-soft)}',
  '.subnav .ledger{margin-left:auto;align-self:center;font-size:13px;color:var(--ink)}',
  '.scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13px}',
  'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}tr:last-child td{border-bottom:0}th{color:var(--muted);font-weight:500}',
  'tr.stopped td{color:var(--faint)}td.warn{color:var(--amber)}td.acts{text-align:right}',
  'button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 12px;cursor:pointer}',
  'button.small{font-size:12px;padding:2px 10px;margin-left:4px}button.link{border:0;background:none;color:var(--red);padding:0}',
  'button.primary{background:var(--ink);border-color:var(--ink);color:var(--bg)}button:disabled{opacity:.5;cursor:default}',
  '.flash{color:var(--accent);font-size:13px;min-height:1em;margin:0 0 8px}',
  'footer{margin-top:28px;color:var(--faint);font-size:12px}.message{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:14px}',
  '.message h2{font-size:16px;margin:0 0 6px}.message p{margin:0;color:var(--muted)}[hidden]{display:none!important}',
  'dialog{border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);padding:18px 20px;width:min(540px,calc(100vw - 32px))}',
  'dialog::backdrop{background:rgba(0,0,0,.35)}dialog h2{font-size:16px;margin:0 0 12px}',
  '.field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.label{font-size:13px;color:var(--muted)}.note{font-size:12px;color:var(--faint)}',
  '.checks{display:flex;flex-wrap:wrap;gap:6px 14px}.checks label{display:flex;gap:4px;align-items:center}',
  '.err{color:var(--red);font-size:13px;min-height:1em}.actions{display:flex;align-items:center;gap:8px}.extra{margin-right:auto}',

].join('');
