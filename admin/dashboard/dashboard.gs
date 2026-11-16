/**
 * ミエタスク ダッシュボード（Google Apps Script・ウェブアプリ）
 *
 * 最初のタブは案件ごと（どこまで進んでいて、誰がどの役割で関わっているか）。続くタブはチームごとのメンバーの一覧
 * （どの案件を持っていて、それぞれどういう状態か）。1つの URL を全員に配り、見る人によって中身が変わる。
 * 見える範囲は管理台帳の「メンバー」シートのロールで、窓口（admin/registry.gs）が決める。
 * このスクリプトは見ている人のメールを確かめて窓口に問い合わせ、返ってきたものを並べるだけ。
 *
 *   - メンバー: 自分の分だけ（自分のチャンネルの「管理者に届く内容」と同じもの）
 *   - 管理者: 自分の「チーム」のチームと、その下のチームの人（リーダー・部門長）
 *   - 役員: 全員
 *   - システム管理者: 別のページ（URL の末尾に ?view=health）で、全員の動作状況と台帳の書き方の誤り。案件の中身は見えない。
 *     そのページから、メンバーのチーム・ロール・状態・メールと、チームの追加・表示名・親チーム、案件の別名（束ね方）を変えられる

 *     （窓口がもう一度ロールを確かめてから台帳に書き、「変更の記録」シートに残す）
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
 *   4. 出てきた URL を社内に案内する
 */

function doGet(e) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var health = !!(e && e.parameter && e.parameter.view === 'health');
  var html;
  if (!email) {
    html = messagePage_('社内の Google アカウントで開いてください', 'このページは、社内の Google アカウントでログインしているときだけ見られます。');
  } else {
    try {
      var view = fetchView_(email, health ? 'health' : '');
      if (!view.viewer) {
        html = messagePage_('このページを見る権限がありません',
          '管理台帳に、このアカウント（' + email + '）の人が登録されていません。登録されているはずなら、システム管理者に連絡してください。');
      } else if (view.forbidden) {
        html = messagePage_('このページはシステム管理者だけが見られます', '案件の状況は、ページの最初の画面で見られます。', baseUrl_());
      } else {
        html = health ? renderHealth_(view) : renderPage_(view);
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
    payload: JSON.stringify({ action: 'dashboard', secret: secret, email: email, view: view || '', change: change || null }),
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

// 動作状況のページから呼ばれる（google.script.run）。台帳を変えて、表を作り直した HTML を返す。
// 見ている人はここでも Google のログインから確かめ直し、システム管理者かどうかは窓口が確かめる
function saveChange(change) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('社内の Google アカウントで開いてください');
  var view = fetchView_(email, 'health', change);
  if (!view.viewer || view.forbidden) throw new Error('台帳を変えられるのはシステム管理者だけです');
  return healthBody_(view);
}

// このページの URL（ページの切り替えに使う）
function baseUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; }
}

// ---------------------------------------------------------------- ページ

var RANK_LABEL = ['期限超過', '要確認', '進行中', '担当外', 'これから'];
var PROJECT_LABEL = ['期限超過あり', '要確認', '進行中', '手伝い', 'これから'];

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

function attention_(c) {
  return c.items.some(function (it) { return it.rank <= 1; });
}

function cardHtml_(c) {
  var items = c.items.map(function (it) {
    var r = Math.max(0, Math.min(4, Number(it.rank) || 0));
    return '<li class="item r' + r + '"' + (r > 1 ? ' data-calm' : '') + '><span class="badge">' + RANK_LABEL[r] + '</span>' +
      '<span class="name">' + esc_(it.name) + '</span><span class="state">' + esc_(it.long) + '</span></li>';
  }).join('');
  var foot = c.share_at ? '<div class="foot">ミエタスク ' + md_(c.share_at) + ' ' + hm_(c.share_at) + '時点</div>' : '';
  return '<article class="card"' + (attention_(c) ? ' data-attention' : '') + '>' +
    '<header><h3>' + esc_(c.name) + '</h3><span class="count">' + esc_(c.count) + '</span></header>' +
    (c.notes ? '<p class="notes">※' + esc_(c.notes) + '</p>' : '') +
    (items ? '<ul>' + items + '</ul>' : '') + foot + '</article>';
}

// 案件1つぶん。状態・次の期限・残りの件数・期間の進み具合・誰がどの役割で関わっているか
function projectHtml_(p) {
  var r = Math.max(0, Math.min(4, Number(p.rank) || 0));
  var meta = [p.due_label ? '次の期限 ' + p.due_label : '', p.counts || ''].filter(String).join('　');
  var prog = p.progress ? '<div class="progress">' +
    (p.progress.pct === null || p.progress.pct === undefined ? '' : '<span class="track"><i style="width:' + Math.max(0, Math.min(100, Number(p.progress.pct) || 0)) + '%"></i></span>') +
    '<span>' + esc_(p.progress.label) + '</span></div>' : '';
  var people = p.members.map(function (m) {
    return '<li>' + esc_(m.name) + (m.role ? '<span>' + esc_(m.role) + '</span>' : '') + '</li>';
  }).join('') + (p.others ? '<li class="more">ほかに' + Number(p.others) + '人</li>' : '');
  return '<article class="card project r' + r + '"' + (r <= 1 ? ' data-attention' : '') + '>' +
    '<header><h3>' + esc_(p.name) + '</h3><span class="badge">' + PROJECT_LABEL[r] + '</span></header>' +
    (meta ? '<p class="meta">' + esc_(meta) + '</p>' : '') + prog + '<ul class="people">' + people + '</ul></article>';
}

function projectPanel_(projects) {
  var n = projects.filter(function (p) { return p.rank <= 1; }).length;
  return '<p class="lead">案件の名前は、各自の Claude が Slack・メール・議事録・MTD から拾ったタスクを束ねてつけたものです。' +
    '同じ案件が別の名前で出ていたら、システム管理者に伝えてください（1つにまとめられます）。</p>' +
    '<div class="bar"><span>' + projects.length + '件' + (n ? '・気にすべきもの ' + n + '件' : '') + '</span>' +
    '<label><input type="checkbox" data-filter> 気にすべきものだけ</label></div>' +
    (projects.length ? '<div class="grid">' + projects.map(projectHtml_).join('') + '</div><p class="empty" hidden>気にすべきものはありません</p>'
      : '<p class="empty">見える案件はまだありません（各自のミエタスクが朝に送ると出ます）</p>');
}

function teamPanel_(t, cards) {
  var list = t.members.map(function (id) { return cards[id]; }).filter(Boolean);
  var n = list.filter(attention_).length;
  return '<div class="bar"><span>' + list.length + '人' + (n ? '・気にすべきものがある人 ' + n + '人' : '') + '</span>' +
    '<label><input type="checkbox" data-filter> 気にすべきものだけ</label></div>' +
    (list.length ? '<div class="grid">' + list.map(cardHtml_).join('') + '</div><p class="empty" hidden>気にすべきものはありません</p>'
      : '<p class="empty">このチームにはメンバーがいません</p>');
}

// システム管理者だけのページ。動いているかどうかと、台帳の書き方の誤り（案件の中身は出さない）。台帳の一部をここから変えられる
function renderHealth_(v) {
  var back = baseUrl_();
  return page_('<header class="top"><h1>ミエタスク 動作状況</h1><span>' + esc_(v.viewer.name) + '　' + md_(v.today) + '時点</span>' +
    (back ? '<a href="' + esc_(back) + '" target="_top">案件の状況へ</a>' : '') + '</header>' +
    '<p class="lead">システム管理者だけが見られるページです。動いているかどうかの点検用で、案件の中身は出しません。' +
    'チーム・ロール・状態・メールはここから変えられます（台帳のスプレッドシートを直に直してもかまいません）。</p>' +
    '<p class="flash" role="status"></p><main id="health">' + healthBody_(v) + '</main>' +
    '<dialog id="edit"><h2></h2><div class="body"></div><p class="err" role="alert"></p>' +
    '<div class="actions"><button type="button" data-cancel>やめる</button><button type="button" data-save class="primary">保存</button></div></dialog>' +
    '<script>' + ADMIN_JS + '</script>');
}

function healthBody_(v) {
  var rows = v.health || [];
  var issues = rows.filter(function (h) { return h.issues && h.issues.length; });
  var members = rows.map(function (h) {
    var c = h.counts;
    return '<tr' + (h.status === '停止' ? ' class="stopped"' : '') + '><td>' + esc_(h.name) + '</td><td>' + esc_(h.teams.join(', ')) + '</td>' +
      '<td>' + esc_(h.roles.join(', ')) + '</td><td>' + esc_(h.status) + '</td><td>' + esc_(h.last_run) + '</td><td>' + esc_(h.version) + '</td>' +
      '<td>' + esc_(md_(h.share_date)) + '</td>' +
      '<td>' + (c ? esc_(md_(c.date) + '　超過' + c.overdue + '・今日' + c.today + '・今週' + c.week) : '') + '</td>' +
      '<td><button type="button" class="link" data-member="' + esc_(h.slack_id) + '">変える</button></td></tr>';
  }).join('');
  var count = {};
  rows.forEach(function (h) { h.teams.forEach(function (t) { count[t.toLowerCase()] = (count[t.toLowerCase()] || 0) + 1; }); });
  var teams = (v.teams || []).map(function (t) {
    return '<tr><td>' + esc_(t.id) + '</td><td>' + esc_(t.name) + '</td><td>' + esc_(t.parent) + '</td><td>' + (count[t.id.toLowerCase()] || 0) + '人</td>' +
      '<td><button type="button" class="link" data-team="' + esc_(t.id) + '">変える</button></td></tr>';
  }).join('');
  var aliases = (v.aliases || []).map(function (a) {
    return '<tr><td>' + esc_(a.alias) + '</td><td>' + esc_(a.name) + '</td>' +
      '<td><button type="button" class="link" data-unmerge="' + esc_(a.alias) + '">外す</button></td></tr>';
  }).join('');
  var fix = issues.length ? '<div class="problems"><p>台帳の直すところ</p>' + issues.map(function (h) {
    return '<p>・' + esc_(h.name) + '：' + esc_(h.issues.join(' / ')) + '</p>';
  }).join('') + '</div>' : '';
  var log = (v.log || []).length ? '<h2>最近の変更</h2><div class="scroll"><table><thead><tr><th>日時</th><th>変えた人</th><th>対象</th><th>項目</th><th>前</th><th>後</th></tr></thead><tbody>' +
    v.log.map(function (l) {
      return '<tr><td>' + esc_(String(l['日時']).replace('T', ' ').slice(0, 16)) + '</td><td>' + esc_(l['変えた人']) + '</td><td>' + esc_(l['対象']) + '</td>' +
        '<td>' + esc_(l['項目']) + '</td><td>' + esc_(l['前']) + '</td><td>' + esc_(l['後']) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '';
  var data = {
    members: rows.map(function (h) { return { slack_id: h.slack_id, name: h.name, email: h.email, teams: h.teams, roles: h.roles, status: h.status }; }),
    teams: v.teams || [], roles: v.roles || [],
  };
  return fix +
    '<h2>メンバー</h2><div class="scroll"><table><thead><tr><th>名前</th><th>チーム</th><th>ロール</th><th>状態</th><th>最後に動いた</th><th>版</th>' +
    '<th>要約が届いた日</th><th>件数（点検用）</th><th></th></tr></thead><tbody>' + members + '</tbody></table></div>' +
    '<h2>チーム</h2><div class="scroll"><table><thead><tr><th>チームID</th><th>表示名</th><th>親チーム</th><th>人数</th><th></th></tr></thead><tbody>' +
    teams + '</tbody></table></div><p><button type="button" data-add-team>チームを足す</button></p>' +
    '<h2>案件の別名</h2><p class="lead">同じ案件が人によって別の名前で届いたものを、案件のタブで1つに束ねます。名前は案件のタブに出ているとおりに書きます。</p>' +
    (aliases ? '<div class="scroll"><table><thead><tr><th>束ねる名前</th><th>まとめ先</th><th></th></tr></thead><tbody>' + aliases + '</tbody></table></div>' : '') +
    '<p><button type="button" data-merge>案件をまとめる</button></p>' + log +
    // 編集の画面が使う今の値。< を逃がして、中身で script が閉じないようにする
    '<script type="application/json" id="admin-data">' + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>';
}

// 動作状況のページの編集画面。保存は google.script.run で saveChange を呼び、返ってきた HTML で表を差し替える
var ADMIN_JS = `
(function () {
  var root = document.getElementById('health');
  var dlg = document.getElementById('edit');
  var flash = document.querySelector('.flash');
  function data() { return JSON.parse(document.getElementById('admin-data').textContent); }
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
  function show(title, body, make) {
    dlg.querySelector('h2').textContent = title;
    var b = dlg.querySelector('.body');
    b.textContent = '';
    body.forEach(function (x) { b.appendChild(x); });
    var err = dlg.querySelector('.err');
    err.textContent = '';
    var save = dlg.querySelector('[data-save]');
    save.disabled = false;
    save.onclick = function () {
      var change = make();
      save.disabled = true;
      err.textContent = '保存しています…';
      google.script.run
        .withSuccessHandler(function (html) { dlg.close(); root.innerHTML = html; flash.textContent = '保存しました（変更の記録に残しました）'; })
        .withFailureHandler(function (e) { save.disabled = false; err.textContent = (e && e.message) || String(e); })
        .saveChange(change);
    };
    dlg.showModal();
  }
  function editMember(id) {
    var d = data();
    var m = d.members.filter(function (x) { return x.slack_id === id; })[0];
    if (!m) return;
    var known = d.teams.map(function (t) { return t.id.toLowerCase(); });
    var lost = m.teams.filter(function (t) { return known.indexOf(t.toLowerCase()) < 0; });
    var teams = checks(d.teams.map(function (t) { return { value: t.id, label: teamLabel(t) }; }), m.teams);
    var roles = checks(d.roles.map(function (r) { return { value: r, label: r }; }), m.roles);
    var status = choose([{ value: '有効', label: '有効' }, { value: '停止', label: '停止（ミエタスクも止まる）' }], m.status);
    var email = text(m.email, 'name@example.com');
    show(m.name + ' さん', [
      field('チーム', teams, lost.length ? '「チーム」シートに無い ' + lost.join('、') + ' は外れます' : ''),
      field('ロール', roles, 'どれも付けなければ、自分の分だけが見えるメンバーです'),
      field('状態', status),
      field('メール', email, '社内の Google アカウント。ページはこのメールで本人を見分けます'),
    ], function () {
      return { kind: 'member', slack_id: m.slack_id,
        set: { teams: picked(teams), roles: picked(roles), status: status.value, email: email.value },
        base: { teams: m.teams, roles: m.roles, status: m.status, email: m.email } };
    });
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
  function merge() {
    var from = text('', '例: 渋谷区WS');
    var to = text('', '例: 渋谷区');
    show('案件をまとめる', [field('束ねる名前', from, '案件のタブに出ている名前'), field('まとめ先', to, 'この名前で1つに出ます')], function () {
      return { kind: 'merge', from: from.value, to: to.value };
    });
  }
  function unmerge(alias) {
    if (!confirm('「' + alias + '」のまとめを外しますか？ 案件のタブで別々に出るようになります。')) return;
    flash.textContent = '保存しています…';
    google.script.run
      .withSuccessHandler(function (html) { root.innerHTML = html; flash.textContent = '外しました（変更の記録に残しました）'; })
      .withFailureHandler(function (e) { flash.textContent = (e && e.message) || String(e); })
      .saveChange({ kind: 'unmerge', alias: alias });
  }
  function addTeam() {
    var id = text('', '例: pm3');
    var name = text('', '例: PM3');
    var parent = parents('', '');
    show('チームを足す', [field('チームID', id, '英数字・- ・_ 。あとから変えられません'), field('表示名', name), field('親チーム', parent)], function () {
      return { kind: 'add_team', id: id.value, name: name.value, parent: parent.value };
    });
  }
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    flash.textContent = '';
    if (b.hasAttribute('data-member')) editMember(b.getAttribute('data-member'));
    else if (b.hasAttribute('data-team')) editTeam(b.getAttribute('data-team'));
    else if (b.hasAttribute('data-add-team')) addTeam();
    else if (b.hasAttribute('data-merge')) merge();
    else if (b.hasAttribute('data-unmerge')) unmerge(b.getAttribute('data-unmerge'));
  });
  dlg.querySelector('[data-cancel]').addEventListener('click', function () { dlg.close(); });
})();
`;

function renderPage_(v) {
  var tabs = [{ id: 'projects', label: '案件', html: projectPanel_(v.projects || []) }];
  (v.teams || []).forEach(function (t) { tabs.push({ id: 'team-' + t.id, label: t.name, html: teamPanel_(t, v.cards) }); });
  var self = v.cards[v.self];
  if (self) {
    tabs.push({ id: 'self', label: '自分', html: '<p class="lead">あなたの分です。管理者にはこの内容が見えます（自分のチャンネルの「管理者に届く内容」と同じ）。</p>' +
      '<div class="grid one">' + cardHtml_(self) + '</div>' });
  }
  var nav = tabs.length > 1 ? '<nav role="tablist">' + tabs.map(function (t, i) {
    return '<button role="tab" data-tab="' + esc_(t.id) + '" aria-selected="' + (i === 0) + '">' + esc_(t.label) + '</button>';
  }).join('') + '</nav>' : '';
  var panels = tabs.map(function (t, i) {
    return '<section role="tabpanel" id="' + esc_(t.id) + '"' + (i ? ' hidden' : '') + '>' + t.html + '</section>';
  }).join('');
  var problems = (v.problems || []).length ? '<div class="problems">' + v.problems.map(function (p) { return '<p>' + esc_(p) + '</p>'; }).join('') + '</div>' : '';
  var base = baseUrl_();
  var link = v.admin && base ? '<a href="' + esc_(base) + '?view=health" target="_top">動作状況（システム管理者）</a>' : '';
  return page_('<header class="top"><h1>ミエタスク</h1><span>' + esc_(v.viewer.name) + '　' + md_(v.today) + '時点</span>' + link + '</header>' +
    problems + nav + panels +
    '<footer>出どころは MTD（Notion）と、各自のミエタスクが毎朝送る案件ごとの状態です。タスクの題名・メールや DM の中身は入っていません。</footer>' +
    '<script>' + CLIENT_JS + '</script>');
}

function messagePage_(title, body, back) {
  return page_('<header class="top"><h1>ミエタスク</h1>' + (back ? '<a href="' + esc_(back) + '" target="_top">案件の状況へ</a>' : '') + '</header>' +
    '<div class="message"><h2>' + esc_(title) + '</h2><p>' + esc_(body) + '</p></div>');
}

// タブの切り替えと「気にすべきものだけ」。データは持たない（サーバーで作った HTML を出し分けるだけ）
var CLIENT_JS = [
  "document.querySelectorAll('[data-tab]').forEach(function(b){b.addEventListener('click',function(){",
  "document.querySelectorAll('[data-tab]').forEach(function(x){x.setAttribute('aria-selected',String(x===b));});",
  "document.querySelectorAll('[role=tabpanel]').forEach(function(p){p.hidden=p.id!==b.getAttribute('data-tab');});});});",
  "document.querySelectorAll('[data-filter]').forEach(function(f){f.addEventListener('change',function(){",
  "var panel=f.closest('section');var on=f.checked;var shown=0;",
  "panel.querySelectorAll('.card').forEach(function(c){var keep=!on||c.hasAttribute('data-attention');c.hidden=!keep;if(keep)shown++;",
  "c.querySelectorAll('[data-calm]').forEach(function(i){i.hidden=on;});});",
  "var e=panel.querySelector('.empty');if(e)e.hidden=shown>0;});});",
].join('');

function page_(body) {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ミエタスク</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}

var CSS = [
  ':root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--red:#c0392b;--red-bg:#fbeceb;',
  '--amber:#9a6700;--amber-bg:#fdf3dc;--blue:#2457a6;--blue-bg:#e9f0fb;--gray-bg:#efefec;--accent:#2457a6}',
  '@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;',
  '--red:#ef8a7f;--red-bg:#3a2321;--amber:#e8c06a;--amber-bg:#3a3020;--blue:#8db4ef;--blue-bg:#1f2b3d;--gray-bg:#2a2a27;--accent:#8db4ef}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;padding:16px;max-width:1200px;margin:0 auto}',
  '.top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}.top h1{font-size:20px;margin:0}.top span{color:var(--muted);font-size:13px}.top a{margin-left:auto;color:var(--accent);font-size:13px}',
  'nav{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:16px}',
  'nav button{font:inherit;background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;color:var(--muted);cursor:pointer}',
  'nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}',
  '.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;color:var(--muted);font-size:13px}',
  '.bar label{display:flex;gap:6px;align-items:center;color:var(--ink);cursor:pointer}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.grid.one{grid-template-columns:minmax(0,560px)}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}',
  '.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}.card h3{margin:0;font-size:16px}',
  '.count{color:var(--muted);font-size:13px}.notes{margin:6px 0 0;color:var(--muted);font-size:12px}',
  '.card ul{list-style:none;margin:10px 0 0;padding:0}.item{display:grid;grid-template-columns:auto 1fr;column-gap:8px;padding:6px 0;border-top:1px solid var(--line)}',
  '.item:first-child{border-top:0}.name{font-weight:500;overflow-wrap:anywhere}.state{grid-column:2;color:var(--muted);font-size:13px}',
  '.badge{grid-row:span 2;align-self:start;font-size:11px;padding:2px 6px;border-radius:4px;white-space:nowrap;background:var(--gray-bg);color:var(--muted)}',
  '.r0 .badge{background:var(--red-bg);color:var(--red)}.r1 .badge{background:var(--amber-bg);color:var(--amber)}.r4 .badge{background:var(--blue-bg);color:var(--blue)}',
  '.foot{margin-top:8px;color:var(--muted);font-size:12px}.lead{color:var(--muted);font-size:13px;margin:0 0 12px}.empty{color:var(--muted)}',
  '.problems{background:var(--amber-bg);color:var(--amber);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px}.problems p{margin:2px 0}',
  '.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--panel);font-size:13px}',
  'th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500}tr.stopped td{color:var(--muted)}',
  'footer{margin-top:24px;color:var(--muted);font-size:12px}.message{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}',
  '.message h2{font-size:16px;margin:0 0 6px}.message p{margin:0;color:var(--muted)}[hidden]{display:none!important}',
  'main h2{font-size:15px;margin:20px 0 8px}button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer}',
  'button.link{border:0;background:none;color:var(--accent);padding:0}button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}button:disabled{opacity:.5;cursor:default}',
  '.flash{color:var(--accent);font-size:13px;min-height:1em;margin:0 0 8px}',
  'dialog{border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);padding:16px 20px;width:min(520px,calc(100vw - 32px))}',
  'dialog::backdrop{background:rgba(0,0,0,.35)}dialog h2{font-size:16px;margin:0 0 12px}',
  '.field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.label{font-size:13px;color:var(--muted)}.note{font-size:12px;color:var(--muted)}',
  '.field input[type=text],.field select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}',
  '.checks{display:flex;flex-wrap:wrap;gap:6px 14px}.checks label{display:flex;gap:4px;align-items:center}',
  '.err{color:var(--red);font-size:13px;min-height:1em}.actions{display:flex;justify-content:flex-end;gap:8px}',
  '.project header .badge{grid-row:auto}.project.r0 .badge{background:var(--red-bg);color:var(--red)}.project.r1 .badge{background:var(--amber-bg);color:var(--amber)}',
  '.project.r4 .badge{background:var(--blue-bg);color:var(--blue)}.meta{margin:6px 0 0;font-size:13px}',
  '.progress{display:flex;align-items:center;gap:8px;margin-top:6px;color:var(--muted);font-size:12px}',
  '.track{flex:0 0 72px;height:6px;border-radius:3px;background:var(--gray-bg);overflow:hidden}.track i{display:block;height:100%;background:var(--accent)}',
  '.people{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0}',
  '.people li{font-size:13px;background:var(--gray-bg);border-radius:999px;padding:2px 10px}.people li span{color:var(--muted);margin-left:4px;font-size:12px}',
  '.people li.more{background:none;color:var(--muted)}',

].join('');
