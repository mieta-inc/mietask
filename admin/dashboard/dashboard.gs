/**
 * ミエタスク ダッシュボード（Google Apps Script・ウェブアプリ）
 *
 * 「人がいま何をしていて、どこで詰まっているか」を見るページ。1つの URL を全員に配り、見る人によって出るタブと中身が変わる。
 * 見える範囲は管理台帳の「メンバー」シートのロールで、窓口（admin/registry.gs）が決める。
 * このスクリプトは見ている人のメールを確かめて窓口に問い合わせ、返ってきたものを並べるだけ。
 *
 *   - メンバー: 「自分」（管理者に見えている内容）と、自分の関わる「案件」
 *   - 管理者: 「メンバー」（自分の「チーム」のチームと、その下のチームの人）・「案件」・「自分」
 *   - 役員: 全員
 *   - システム管理者: 「管理」のタブで、全員の動作状況と台帳の操作（人を足す・鍵を送る・チーム・ロール・案件の別名）。
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

var TAB_LABEL = { members: 'メンバー', projects: '案件', self: '自分', admin: '管理' };
var STATE_LABEL = ['期限超過あり', '相手待ち・確認待ち', '進行中', '手伝い', 'これから'];

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

function rank_(r) { return Math.max(0, Math.min(4, Number(r) || 0)); }

// 1人ぶん。名前・いまの数・気にすべきもの、その下に案件ごとの1行（何をしているかの一言と、件数・期限・期間）
function personHtml_(c, teamsOf) {
  var flags = (c.overdue.length ? '<span class="flag f0">期限超過 ' + c.overdue.length + '</span>' : '') +
    (c.waiting.length ? '<span class="flag f1">相手待ち ' + c.waiting.length + '</span>' : '');
  var sub = [(c.team_names || c.teams).join('・'), '今 ' + c.now + '件', c.later ? 'これから ' + c.later + '件' : ''].filter(String).join('・');
  var items = c.items.map(function (it) {
    var r = rank_(it.rank);
    return '<div class="pn"><span class="dot d' + r + '" title="' + STATE_LABEL[r] + '"></span>' + esc_(it.name) +
      (it.role ? ' <span class="role">' + esc_(it.role) + '</span>' : '') + '</div>' +
      '<div class="pd">' + esc_(it.note) + (it.meta ? '<span class="meta">' + (it.note ? '・' : '') + esc_(it.meta) + '</span>' : '') +
      (it.note || it.meta ? '' : '<span class="meta">' + STATE_LABEL[r] + '</span>') + '</div>';
  }).join('');
  return '<article class="person" data-teams=" ' + esc_((teamsOf || []).join(' ')) + ' ">' +
    '<header><h3>' + esc_(c.name) + '</h3><span class="sub">' + esc_(sub) + '</span>' + flags + '</header>' +
    (c.notes ? '<p class="notes">' + esc_(c.notes) + '</p>' : '') +
    (items ? '<div class="items">' + items + '</div>' : '<p class="notes">見える案件はありません</p>') +
    (c.share_at ? '<p class="foot">ミエタスク ' + md_(c.share_at) + ' ' + hm_(c.share_at) + '時点</p>' : '') + '</article>';
}

function membersPanel_(v) {
  // その人が入っているチーム（下のチームの人は、上のチームの絞り込みにも出す）
  var teamsOf = {};
  (v.teams || []).forEach(function (t) { t.members.forEach(function (id) { (teamsOf[id] = teamsOf[id] || []).push(t.id); }); });
  var filter = (v.teams || []).length > 1 ? '<label class="filter">チーム <select data-team><option value="">すべて</option>' +
    v.teams.map(function (t) { return '<option value="' + esc_(t.id) + '">' + esc_(t.name) + '</option>'; }).join('') + '</select></label>' : '';
  var people = v.people || [];
  return '<div class="bar"><span class="lead">気にすべきものがある人から並べています。一言は各自の Claude が書いたもの（タスクの題名・人の名前は入りません）</span>' + filter + '</div>' +
    (people.length ? '<div class="people">' + people.map(function (c) { return personHtml_(c, teamsOf[c.slack_id]); }).join('') + '</div>' +
      '<p class="empty" hidden>このチームにはメンバーがいません</p>' : '<p class="empty">見える範囲にメンバーがいません</p>');
}

function projectsPanel_(v) {
  var list = v.projects || [];
  var rows = list.map(function (p) {
    var r = rank_(p.rank);
    var who = p.members.map(function (m) { return esc_(m.name) + (m.role ? '<span class="role">' + esc_(m.role) + '</span>' : ''); }).join('、') +
      (p.others ? '<span class="meta">・ほかに' + Number(p.others) + '人</span>' : '');
    var meta = [p.due_label ? '次の期限 ' + p.due_label : '', p.counts || '', p.progress ? p.progress.label : ''].filter(String).join('・');
    return '<div class="prow"><div><span class="dot d' + r + '"></span>' + esc_(p.name) + '<div class="meta state">' + STATE_LABEL[r] + '</div></div>' +
      '<div><div>' + who + '</div>' + (meta ? '<div class="meta">' + esc_(meta) + '</div>' : '') + '</div></div>';
  }).join('');
  return '<p class="lead">同じ案件に誰が関わっているかを確かめる補助の一覧です。案件の名前は、各自の Claude が Slack・メール・議事録・MTD から束ねてつけたもの' +
    '（同じ案件が別の名前で出ていたら、システム管理者が1つにまとめられます）。</p>' +
    (rows ? '<div class="projects">' + rows + '</div>' : '<p class="empty">見える案件はまだありません（各自のミエタスクが朝に送ると出ます）</p>');
}

function selfPanel_(v) {
  return '<p class="lead">管理者・役員には、この内容が見えています（自分のチャンネルの「管理者に届く内容」と同じ）。</p>' +
    '<div class="people">' + personHtml_(v.self, []) + '</div>';
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
  return page_('<header class="top"><h1>ミエタスク</h1><span>' + esc_(v.viewer.name) + '　' + md_(v.today) + '時点</span></header>' +
    problems + nav + panels +
    '<footer>出どころは MTD（Notion）と、各自のミエタスクが毎朝送る案件ごとの状態と一言です。タスクの題名・メールや DM の中身は入っていません。</footer>' +
    (v.admin ? '<dialog id="edit"><h2></h2><div class="body"></div><p class="err" role="alert"></p>' +
      '<div class="actions"><span class="extra"></span><button type="button" data-cancel>やめる</button><button type="button" data-save class="primary">保存</button></div></dialog>' : '') +
    '<script>' + CLIENT_JS + (v.admin ? ADMIN_JS : '') + '</script>');
}

// 管理のタブの中身。動作状況と台帳の設定だけ（案件の中身は出さない）
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
  var teams = (a.teams || []).map(function (t) {
    return '<tr><td>' + esc_(t.id) + '</td><td>' + esc_(t.name) + '</td><td>' + esc_(t.parent) + '</td><td>' + (count[t.id.toLowerCase()] || 0) + '人</td>' +
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
    teams: a.teams || [], roles: a.roles || [],
  };
  var table = function (head, body, empty) {
    return body ? '<div class="scroll"><table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
      : '<p class="empty">' + empty + '</p>';
  };
  return '<div class="subnav" role="tablist">' +
    '<button type="button" data-sub="a-members" aria-selected="true">メンバー</button><button type="button" data-sub="a-teams" aria-selected="false">チーム</button>' +
    '<button type="button" data-sub="a-aliases" aria-selected="false">案件の別名</button><button type="button" data-sub="a-log" aria-selected="false">変更の記録</button></div>' +
    '<div data-subpanel="a-members">' + fix +
    '<div class="bar"><span class="lead">動いているかどうかの点検と、台帳の操作です。案件の中身は出ません。鍵は Bot が本人に DM で送り、この画面には出しません。</span>' +
    '<button type="button" data-add-member>メンバーを足す</button></div>' +
    table(['名前', 'チーム', 'ロール', '動き', '版', '要約が届いた日', ''], members, 'まだ誰もいません') + '</div>' +
    '<div data-subpanel="a-teams" hidden><div class="bar"><span class="lead">親チームの管理者には、その下のチームの人も見えます。</span><button type="button" data-add-team>チームを足す</button></div>' +
    table(['チームID', '表示名', '親チーム', '人数', ''], teams, 'チームがありません') + '</div>' +
    '<div data-subpanel="a-aliases" hidden><div class="bar"><span class="lead">同じ案件が人によって別の名前で届いたものを、1つに束ねます。名前は画面に出ているとおりに書きます。</span>' +
    '<button type="button" data-merge>案件をまとめる</button></div>' +
    table(['束ねる名前', 'まとめ先', ''], aliases, 'まだ束ねた案件はありません') + '</div>' +
    '<div data-subpanel="a-log" hidden>' + table(['日時', '変えた人', '対象', '項目', '前', '後'], log, 'まだ変更はありません') + '</div>' +
    // 編集の画面が使う今の値。< を逃がして、中身で script が閉じないようにする
    '<script type="application/json" id="admin-data">' + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>';
}

function messagePage_(title, body) {
  return page_('<header class="top"><h1>ミエタスク</h1></header><div class="message"><h2>' + esc_(title) + '</h2><p>' + esc_(body) + '</p></div>');
}

function page_(body) {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ミエタスク</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}

// タブとチームの絞り込み。データは持たない（サーバーで作った HTML を出し分けるだけ）
var CLIENT_JS = `
(function () {
  document.querySelectorAll('nav [data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav [data-tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      document.querySelectorAll('section[role=tabpanel]').forEach(function (p) { p.hidden = p.id !== b.getAttribute('data-tab'); });
    });
  });
  var panel = document.getElementById('members');
  var pick = panel && panel.querySelector('[data-team]');
  if (!pick) return;
  pick.addEventListener('change', function () {
    var shown = 0;
    panel.querySelectorAll('.person').forEach(function (p) {
      p.hidden = !!pick.value && p.getAttribute('data-teams').indexOf(' ' + pick.value + ' ') < 0;
      if (!p.hidden) shown++;
    });
    var empty = panel.querySelector('.empty');
    if (empty) empty.hidden = shown > 0;
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
      field('ロール', f.roles, 'どれも付けなければ、自分の分だけが見えるメンバーです。管理者・役員を付けると、ページの案内が DM で届きます'),
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
  function editTeam(id) {
    var t = data().teams.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var name = text(t.name);
    var parent = parents(t.id, t.parent);
    show('チーム ' + t.id, [field('表示名', name), field('親チーム', parent, '親チームの管理者には、このチームの人も見えます')], function () {
      return { kind: 'team', id: t.id, set: { name: name.value, parent: parent.value }, base: { name: t.name, parent: t.parent } };
    });
  }
  function addTeam() {
    var id = text('', 'pm3');
    var name = text('', 'PM3');
    var parent = parents('', '');
    show('チームを足す', [field('チームID', id, '英数字・- ・_ 。あとから変えられません'), field('表示名', name), field('親チーム', parent)], function () {
      return { kind: 'add_team', id: id.value, name: name.value, parent: parent.value };
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
  ':root{--bg:#fafaf8;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--faint:#9a9993;--line:#e7e6e1;--soft:#f2f1ed;',
  '--red:#b3261e;--red-bg:#fbeceb;--amber:#8a5a00;--amber-bg:#fbf1dc;--blue:#2457a6;--accent:#2457a6}',
  '@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1d1d1b;--ink:#ecebe6;--muted:#a3a29b;--faint:#7c7b75;--line:#2f2e2b;--soft:#262624;',
  '--red:#ef8a7f;--red-bg:#3a2321;--amber:#e8c06a;--amber-bg:#3a3020;--blue:#8db4ef;--accent:#8db4ef}}',
  '*{box-sizing:border-box}body{margin:0 auto;max-width:1080px;padding:20px 16px 40px;background:var(--bg);color:var(--ink);',
  'font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}',
  '.top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.top h1{font-size:18px;font-weight:600;margin:0}.top span{color:var(--muted);font-size:13px}',
  'nav{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:14px 0 18px}',
  'nav button{font:inherit;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 14px;color:var(--muted);cursor:pointer}',
  'nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}',
  '.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 8px}',
  '.lead{color:var(--muted);font-size:12px;margin:0 0 8px}.bar .lead{margin:0}.filter{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center}',
  'select,input[type=text]{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 8px}',
  '.people{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 16px}',
  '.person{padding:14px 0;border-top:1px solid var(--line)}.person:first-child{border-top:0}',
  '.person header{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.person h3{margin:0;font-size:15px;font-weight:600}.sub{color:var(--faint);font-size:12px}',
  '.flag{font-size:12px;padding:1px 8px;border-radius:999px}.f0{background:var(--red-bg);color:var(--red)}.f1{background:var(--amber-bg);color:var(--amber)}',
  '.items{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:4px 16px;margin-top:8px;font-size:13px}',
  '.pn{overflow-wrap:anywhere}.pd{color:var(--muted);overflow-wrap:anywhere}.role{color:var(--faint);font-size:12px;margin-left:4px}.meta{color:var(--faint);font-size:12px}',
  '.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--line)}',
  '.d0{background:var(--red)}.d1{background:var(--amber)}.d2{background:var(--faint)}.d3{background:var(--line)}.d4{background:var(--blue)}',
  '.notes{margin:4px 0 0;color:var(--faint);font-size:12px}.foot{margin:6px 0 0;color:var(--faint);font-size:11px}',
  '.projects{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 16px}',
  '.prow{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:16px;padding:12px 0;border-top:1px solid var(--line);font-size:13px}.prow:first-child{border-top:0}',
  '.state{margin-left:14px}.empty{color:var(--muted)}',
  '.problems{background:var(--amber-bg);color:var(--amber);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:13px}.problems p{margin:2px 0}',
  '.subnav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
  '.subnav button{font:inherit;font-size:13px;background:none;border:1px solid var(--line);border-radius:999px;padding:3px 12px;color:var(--muted);cursor:pointer}',
  '.subnav button[aria-selected=true]{color:var(--ink);border-color:var(--ink)}',
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
  '@media (max-width:640px){.items,.prow{grid-template-columns:1fr;gap:2px}.pn{margin-top:6px}}',
].join('');
