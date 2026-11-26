/*
 * iパス毎日10問 — アプリ本体
 * ------------------------------------------------------------
 * ・データはすべて端末内（localStorage）に保存。サーバ不要。
 * ・画面は URL の # 部分（#home / #review / #stats / #settings / #quiz）で切り替える
 *   「シングルページアプリ（SPA）」方式。
 */
(() => {
  'use strict';

  // ---------- 定数 ----------
  const STORE_KEY = 'ipass.v1';
  const DAILY_N = 10;                 // 1日の出題数
  const MAX_REVIEW_IN_DAILY = 4;      // 毎日の10問に混ぜる復習問題の上限
  const INTERVALS = [0, 1, 3, 7, 14, 30]; // 正解を重ねるごとに次の出題までの日数を伸ばす（間隔反復）
  const KANA = ['ア', 'イ', 'ウ', 'エ'];
  const CATS = window.IPASS_CATEGORIES;
  const FIELDS = ['S', 'M', 'T'];
  const PASS_TOTAL = 600, PASS_FIELD = 300;

  // ---------- 保存データ ----------
  const defaultState = () => ({
    settings: { examDate: '', reminderTime: '20:00', pool: 'all' },
    qs: {},      // 問題ごとの学習状況 { [id]: {n, ok, streak, box, due, wrong, last, lastOk, flag} }
    days: {},    // 日ごとの記録 { 'YYYY-MM-DD': {n, ok, done} }
    daily: null, // 今日の10問 { date, ids, results:[{id, ok, choice}] }
    custom: [],  // 利用者が追加した問題
  });

  let S = load();
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      const s = Object.assign(defaultState(), raw || {});
      s.settings = Object.assign(defaultState().settings, s.settings || {});
      return s;
    } catch (e) {
      return defaultState();
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast('保存に失敗しました（容量不足の可能性）'); }
  }

  // ---------- 問題 ----------
  let QMAP = new Map();
  const PAST = window.IPASS_PAST || [];
  function everyQ() { return [...window.IPASS_QUESTIONS, ...PAST, ...S.custom]; }
  // 出題範囲（設定）に応じた問題の一覧。出題・集計はこの範囲で行う
  function allQ() {
    const pool = S.settings.pool || 'all';
    if (pool === 'past') return [...PAST, ...S.custom];
    if (pool === 'orig') return [...window.IPASS_QUESTIONS, ...S.custom];
    return everyQ();
  }
  function rebuildMap() { QMAP = new Map(everyQ().map(q => [q.id, q])); }
  rebuildMap();
  const getQ = id => QMAP.get(id);

  function st(id) {
    return S.qs[id] || { n: 0, ok: 0, streak: 0, box: 0, due: null, wrong: 0, last: null, lastOk: null, flag: false };
  }
  // 苦手問題：苦手マーク付き、または間違えたことがあり、まだ2回連続正解していない
  function isWeak(s) { return !!s && (s.flag || (s.wrong > 0 && (s.box < 3 || s.lastOk === false))); }

  // ---------- 日付 ----------
  const pad = n => String(n).padStart(2, '0');
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function today() { return ymd(new Date()); }
  function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function diffDays(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
  }
  function fmtDate(s) {
    const d = parseYmd(s);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`;
  }

  // ---------- 乱数（日付から毎日同じ並びを作る「シード付き乱数」） ----------
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  // 重み付きランダム抽出（重みが大きい問題ほど選ばれやすい）
  function weightedSample(items, weightFn, k, rng) {
    return items
      .map(it => ({ it, key: Math.pow(rng(), 1 / Math.max(weightFn(it), 1e-6)) }))
      .sort((a, b) => b.key - a.key)
      .slice(0, k)
      .map(x => x.it);
  }

  // 選択肢の表示順：毎回シャッフルして「位置で覚える」のを防ぐ。
  // ただし計算問題など数値の選択肢は小さい順のまま表示する。
  function choiceOrder(q) {
    const idx = q.ch.map((_, i) => i);
    const numeric = q.ch.every(c => /^[0-9０-９.,，／/]+/.test(String(c).trim()));
    // 過去問は本番どおりの順番（解説が「アは…」と記号で説明しているため）
    return q.keep || numeric ? idx : shuffle(idx);
  }

  // ---------- 統計 ----------
  // 問題の習得度: 未回答0 / 直近1回正解0.5 / 2回以上連続正解1
  function mastery(s) { return !s || s.n === 0 ? 0 : s.streak >= 2 ? 1 : s.streak === 1 ? 0.5 : 0; }

  function computeStats() {
    const qs = allQ();
    const byCat = {}, byField = {};
    FIELDS.forEach(f => {
      byField[f] = { total: 0, seen: 0, m: 0, n: 0, ok: 0, lastOkSum: 0 };
      CATS[f].cats.forEach(c => { byCat[c] = { f, total: 0, seen: 0, m: 0, n: 0, ok: 0 }; });
    });
    qs.forEach(q => {
      const s = S.qs[q.id];
      const fc = byField[q.f]; if (!fc) return;
      const cc = byCat[q.c] || (byCat[q.c] = { f: q.f, total: 0, seen: 0, m: 0, n: 0, ok: 0 });
      [fc, cc].forEach(o => { o.total++; });
      if (s && s.n > 0) {
        const m = mastery(s);
        [fc, cc].forEach(o => { o.seen++; o.m += m; o.n += s.n; o.ok += s.ok; });
        if (s.lastOk) fc.lastOkSum++;
      }
    });
    Object.values(byCat).forEach(o => { o.reach = o.total ? o.m / o.total : 0; o.acc = o.n ? o.ok / o.n : null; });
    // 予想スコア：各分野の「直近の正誤」から推定した正答率（回答数が少ないうちは50%に寄せる）× 1000
    const PRIOR = 5;
    let total = 0;
    FIELDS.forEach(f => {
      const o = byField[f];
      o.reach = o.total ? o.m / o.total : 0;
      o.acc = o.n ? o.ok / o.n : null;
      const p = (o.lastOkSum + PRIOR * 0.5) / (o.seen + PRIOR);
      o.score = Math.round(p * 1000);
      total += CATS[f].exam * p;
    });
    const totalScore = Math.round(total / 100 * 1000);
    const seenAll = FIELDS.reduce((a, f) => a + byField[f].seen, 0);
    const passed = totalScore >= PASS_TOTAL && FIELDS.every(f => byField[f].score >= PASS_FIELD);
    const confidence = seenAll < 20 ? '低' : seenAll < 60 ? '中' : '高';
    return { byCat, byField, totalScore, passed, seenAll, totalQ: qs.length, confidence };
  }

  // ---------- 今日の10問を作る ----------
  function buildDaily(date) {
    const rng = mulberry32(hashStr('ipass:' + date));
    const qs = allQ();
    const stats = computeStats();
    // ① 復習期限が来た苦手問題を優先（最大4問）
    const due = qs.filter(q => { const s = S.qs[q.id]; return s && isWeak(s) && s.due && s.due <= date; });
    shuffle(due, rng).sort((a, b) => S.qs[a.id].due.localeCompare(S.qs[b.id].due));
    const picked = due.slice(0, MAX_REVIEW_IN_DAILY);
    const used = new Set(picked.map(q => q.id));
    // ② 残りは重み付きランダム（本番の出題比率 35:20:45、苦手分野・未回答を優先）
    const fieldCount = {}; qs.forEach(q => { fieldCount[q.f] = (fieldCount[q.f] || 0) + 1; });
    const weight = q => {
      const s = S.qs[q.id];
      let w = (CATS[q.f] ? CATS[q.f].exam : 30) / (fieldCount[q.f] || 1);
      const cat = stats.byCat[q.c];
      w *= 1 + 1.5 * (1 - (cat ? cat.reach : 0));
      if (!s || s.n === 0) w *= 2;               // 未回答
      else if (isWeak(s)) w *= 1.5;               // 苦手（期限前）
      else if (s.due && s.due <= date) w *= 1.2;  // 定着確認の時期
      else w *= 0.25;                             // 習得済みは控えめに
      return w;
    };
    const rest = weightedSample(qs.filter(q => !used.has(q.id)), weight, DAILY_N - picked.length, rng);
    const ids = shuffle([...picked, ...rest].map(q => q.id), rng);
    return { date, ids, results: [] };
  }
  function ensureDaily() {
    const d = today();
    if (!S.daily || S.daily.date !== d) { S.daily = buildDaily(d); save(); }
    // 問題データの変更で消えたIDを除外
    S.daily.ids = S.daily.ids.filter(id => getQ(id));
    return S.daily;
  }

  // ---------- 解答の記録（間隔反復） ----------
  function record(id, ok) {
    const d = today();
    const s = Object.assign({}, st(id));
    s.n++; s.last = d; s.lastOk = ok;
    if (ok) {
      s.ok++; s.streak++;
      s.box = Math.min(s.box + 1, INTERVALS.length - 1);
      s.due = addDays(d, INTERVALS[s.box]);
    } else {
      s.wrong++; s.streak = 0; s.box = 1;
      s.due = addDays(d, 1); // 間違えた問題は翌日に再出題
    }
    S.qs[id] = s;
    const day = S.days[d] || (S.days[d] = { n: 0, ok: 0, done: false });
    day.n++; if (ok) day.ok++;
  }

  function streakDays() {
    let n = 0, d = today();
    if (!(S.days[d] && S.days[d].done)) d = addDays(d, -1); // 今日まだなら昨日から数える
    while (S.days[d] && S.days[d].done) { n++; d = addDays(d, -1); }
    return n;
  }

  // ---------- 画面の共通部品 ----------
  const $view = document.getElementById('view');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const fieldDot = f => `<span class="dot-f" style="background:var(--field-${f})" aria-hidden="true"></span>`;
  function meter(label, value01, right, opts = {}) {
    const pct = Math.max(0, Math.min(100, value01 * 100));
    const line = opts.line != null ? `<span class="line" style="left:${opts.line * 100}%" title="合格ライン"></span>` : '';
    const color = opts.color ? `background:${opts.color}` : '';
    return `<div class="meter">
      <div class="lbl"><span>${label}</span><span class="num">${right}</span></div>
      <div class="bar" role="img" aria-label="${esc(String(label).replace(/<[^>]+>/g, ''))} ${Math.round(pct)}%"><i style="width:${pct}%;${color}"></i>${line}</div>
    </div>`;
  }
  function scoreStatus(score, line) {
    if (score >= line + 100) return '<span class="status-pill good">✓ 合格圏</span>';
    if (score >= line) return '<span class="status-pill warn">△ ボーダー</span>';
    return '<span class="status-pill bad">✕ 要強化</span>';
  }

  // ---------- ホーム ----------
  function viewHome() {
    const daily = ensureDaily();
    const done = daily.results.length >= daily.ids.length;
    const answered = daily.results.length;
    const correct = daily.results.filter(r => r.ok).length;
    const stats = computeStats();
    const weakCount = allQ().filter(q => isWeak(S.qs[q.id])).length;

    // カウントダウン
    let cd;
    if (S.settings.examDate) {
      const left = diffDays(today(), S.settings.examDate);
      if (left > 0) {
        const unseen = stats.totalQ - stats.seenAll;
        cd = `<div class="sub">${fmtDate(S.settings.examDate)} の試験まで</div>
          <div class="countdown"><span>あと</span><span class="big num">${left}</span><span>日</span></div>
          <div class="sub" style="margin-top:6px">未回答 ${unseen}問 ／ 1日 ${Math.max(1, Math.ceil(unseen / left))}問ペースで全問に到達</div>`;
      } else if (left === 0) {
        cd = `<div class="countdown"><span class="big">今日</span><span>が試験日！</span></div><div class="sub">落ち着いて、いってらっしゃい。</div>`;
      } else {
        cd = `<div class="sub">試験日（${fmtDate(S.settings.examDate)}）は過ぎました。</div><a class="btn small" style="margin-top:8px" href="#settings">次の受験日を設定</a>`;
      }
    } else {
      cd = `<div class="sub">受験日を設定するとカウントダウンが表示されます</div>
        <a class="btn small" style="margin-top:8px;background:var(--surface);color:var(--text)" href="#settings">受験日を設定する</a>`;
    }

    // リマインド（アプリを開いたとき、設定時刻を過ぎても未完了なら表示）
    const now = new Date();
    const remindAt = (S.settings.reminderTime || '20:00').split(':').map(Number);
    const past = now.getHours() * 60 + now.getMinutes() >= remindAt[0] * 60 + remindAt[1];
    const banner = !done && past
      ? `<div class="banner"><span class="ic">⏰</span><div><b>リマインド：</b>今日の10問がまだ${answered ? `途中（${answered}/${daily.ids.length}）` : '未着手'}です。寝る前にサクッと解きましょう！</div></div>` : '';

    // 14日間の学習カレンダー
    let week = '';
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today(), -i), rec = S.days[d];
      const cls = rec && rec.done ? 'on' : rec && rec.n ? 'part' : '';
      week += `<div class="d ${cls} ${i === 0 ? 'today' : ''}" title="${d}：${rec ? rec.n + '問' : '未学習'}">${parseYmd(d).getDate()}</div>`;
    }

    const dailyBtn = done
      ? `<div class="row between"><div><span class="status-pill good">✓ 完了</span> <b class="num">${correct}/${daily.ids.length}</b> 正解</div></div>
         <div class="btn-row" style="margin-top:12px">
           <button class="btn" data-act="daily-result">結果と解説</button>
           <button class="btn primary" data-act="extra">もう10問</button>
         </div>`
      : `<button class="btn primary block" data-act="daily">${answered ? `続きから（${answered}/${daily.ids.length}）` : '今日の10問をはじめる'}</button>`;

    $view.innerHTML = `
      <h1>iパス毎日10問</h1>
      ${banner}
      <section class="card hero">${cd}</section>
      <section class="card">
        <div class="row between"><h2 style="margin:0">今日の10問</h2><span class="sub">${fmtDate(today())}</span></div>
        <p class="sub" style="margin:6px 0 12px">過去問の出題テーマから毎日ランダムに出題。間違えた問題は翌日以降に自動で再出題されます。</p>
        ${dailyBtn}
      </section>
      <section class="card">
        <div class="row between"><h2 style="margin:0">連続学習</h2><b class="num">${streakDays()} 日</b></div>
        <div class="week">${week}</div>
        <div class="legend"><span><i class="dot-f" style="background:var(--accent)"></i>10問完了</span><span><i class="dot-f" style="background:var(--accent-soft)"></i>途中</span></div>
      </section>
      <section class="card">
        <div class="row between"><h2 style="margin:0">予想スコア</h2>${scoreStatus(stats.totalScore, PASS_TOTAL)}</div>
        <div class="score-big" style="margin-top:8px"><span class="v num">${stats.totalScore}</span><span class="sub">/ 1000（合格 600）</span></div>
        ${FIELDS.map(f => meter(`${fieldDot(f)}${CATS[f].name}`, stats.byField[f].score / 1000, `${stats.byField[f].score}`, { line: PASS_FIELD / 1000, color: `var(--field-${f})` })).join('')}
        <a class="btn small block" href="#stats">分野別の到達率を見る</a>
      </section>
      <section class="card">
        <div class="row between"><h2 style="margin:0">苦手問題</h2><b class="num">${weakCount} 問</b></div>
        <p class="sub" style="margin:6px 0 10px">間違えた問題は、2回連続で正解すると「克服」になります。</p>
        <div class="btn-row">
          <button class="btn" data-act="weak" ${weakCount ? '' : 'disabled'}>苦手を解き直す</button>
          <a class="btn" href="#review">解説を読む</a>
        </div>
      </section>`;
  }

  // ---------- クイズ ----------
  // session: { mode: 'daily'|'extra'|'weak'|'cat'|'retry', title, ids, idx, results, answered }
  let session = null;

  function startSession(mode, ids, title) {
    if (!ids.length) { toast('出題できる問題がありません'); return; }
    session = { mode, title, ids, idx: 0, results: [], answered: null, order: null };
    if (mode === 'daily') {
      session.results = S.daily.results.slice();
      session.idx = session.results.length;
    }
    if (location.hash !== '#quiz') location.hash = '#quiz'; // 画面切替イベントで描画される
    else render();
  }

  function pickExtra() {
    const rng = Math.random;
    const exclude = new Set(S.daily ? S.daily.ids : []);
    const qs = allQ().filter(q => !exclude.has(q.id));
    const w = q => { const s = S.qs[q.id]; return !s || !s.n ? 3 : isWeak(s) ? 2 : 0.5; };
    return weightedSample(qs, w, DAILY_N, rng).map(q => q.id);
  }
  function pickWeak() {
    return shuffle(allQ().filter(q => isWeak(S.qs[q.id])).map(q => q.id)).slice(0, DAILY_N);
  }
  function pickCat(c) {
    const qs = allQ().filter(q => q.c === c);
    const w = q => { const s = S.qs[q.id]; return !s || !s.n ? 3 : isWeak(s) ? 2 : 1; };
    return weightedSample(qs, w, DAILY_N, Math.random).map(q => q.id);
  }

  function viewQuiz() {
    if (!session) {
      const d = ensureDaily();
      if (d.results.length < d.ids.length) { startSession('daily', d.ids, '今日の10問'); return; }
      location.hash = '#home'; return;
    }
    if (session.idx >= session.ids.length) return viewResult();
    const id = session.ids[session.idx];
    const q = getQ(id);
    if (!q) { session.idx++; return viewQuiz(); }
    const n = session.ids.length;
    const ans = session.answered; // 回答済みならその選択番号
    const s = st(id);
    if (!session.order || session.order.id !== id) session.order = { id, idx: choiceOrder(q) };
    const order = session.order.idx; // order[表示位置] = 元の選択肢番号
    const choicesHtml = order.map((i, pos) => {
      let cls = '', mark = '';
      if (ans != null) {
        if (i === q.a) { cls = 'correct'; mark = '○'; }
        else if (i === ans) { cls = 'wrong'; mark = '×'; }
      }
      return `<button class="choice ${cls}" data-act="answer" data-i="${i}" ${ans != null ? 'disabled' : ''}>
        <span class="k">${KANA[pos]}</span><span>${esc(q.ch[i])}</span><span class="mark">${mark}</span></button>`;
    }).join('');

    let after = '';
    if (ans != null) {
      const ok = ans === q.a;
      after = `
        <div class="verdict ${ok ? 'good' : 'bad'}">${ok ? '○ 正解！' : `× 不正解　<span style="font-weight:600">正解は「${KANA[order.indexOf(q.a)]}」${esc(q.ch[q.a])}</span>`}</div>
        <div class="explain"><div class="t">解説</div>${esc(q.ex)}</div>
        <label class="flag-toggle"><input type="checkbox" data-act="flag" ${s.flag ? 'checked' : ''}> 苦手マークを付ける（自信がなかった問題に）</label>
        <div class="next-wrap"><button class="btn primary block" data-act="next">${session.idx + 1 >= n ? '結果を見る' : '次の問題へ →'}</button></div>`;
    }
    const prevSeen = s.n ? `<span class="chip">${s.wrong ? `過去に${s.wrong}回ミス` : `正解${s.ok}回`}</span>` : '<span class="chip">初出題</span>';

    $view.innerHTML = `
      <div class="quiz-top">
        <div class="row">
          <button class="icon-btn" data-act="quit" aria-label="中断してホームへ">✕</button>
          <div style="flex:1"><div class="sub" style="text-align:center">${esc(session.title)}</div></div>
          <div class="num" style="min-width:44px;text-align:right;font-weight:700">${session.idx + 1}/${n}</div>
        </div>
        <div class="progress"><i style="width:${(session.idx + (ans != null ? 1 : 0)) / n * 100}%"></i></div>
      </div>
      <div class="chips">
        <span class="chip f">${fieldDot(q.f)}${esc(CATS[q.f] ? CATS[q.f].name : q.f)}</span>
        <span class="chip">${esc(q.c)}</span>
        ${prevSeen}
        <span class="chip">${esc(q.src || 'オリジナル類似問題')}</span>
      </div>
      <div class="qtext">${esc(q.q)}</div>
      ${figure(q)}
      <div class="choices">${choicesHtml}</div>
      ${after}`;
    if (ans != null) {
      const v = $view.querySelector('.verdict');
      if (v) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo(0, 0);
    }
  }

  function answer(i) {
    if (!session || session.answered != null) return;
    const id = session.ids[session.idx];
    const q = getQ(id);
    const ok = i === q.a;
    session.answered = i;
    session.results.push({ id, ok, choice: i });
    record(id, ok);
    if (session.mode === 'daily' && S.daily) {
      S.daily.results = session.results.slice();
      if (S.daily.results.length >= S.daily.ids.length) {
        const d = S.days[today()] || (S.days[today()] = { n: 0, ok: 0, done: false });
        d.done = true;
        clearBadge();
      }
    }
    save();
    if (navigator.vibrate) { try { navigator.vibrate(ok ? 15 : [30, 40, 30]); } catch (e) { /* noop */ } }
    viewQuiz();
  }

  function viewResult() {
    const res = session.results;
    const ok = res.filter(r => r.ok).length;
    const wrongIds = res.filter(r => !r.ok).map(r => r.id);
    const msg = ok === res.length ? 'パーフェクト！🎉' : ok >= res.length * 0.6 ? 'いい調子です！' : '解説を読んで、明日もう一度！';
    $view.innerHTML = `
      <h1>${esc(session.title)} の結果</h1>
      <section class="card" style="text-align:center">
        <div class="score-big" style="justify-content:center"><span class="v num">${ok}</span><span class="sub">/ ${res.length} 正解</span></div>
        <p style="margin-top:8px">${msg}</p>
        <div class="btn-row">
          ${wrongIds.length ? `<button class="btn primary" data-act="retry">間違えた${wrongIds.length}問を解き直す</button>` : ''}
          <a class="btn" href="#home">ホームへ</a>
        </div>
      </section>
      <section class="card">
        <h2>振り返り</h2>
        <p class="sub">タップすると解説が開きます。</p>
        ${res.map((r, i) => qItem(getQ(r.id), { idx: i + 1, ok: r.ok, choice: r.choice })).join('')}
      </section>`;
    window.scrollTo(0, 0);
  }

  // 図表の画像（タップで別タブに拡大表示）
  function figure(q) {
    if (!q.img) return '';
    return `<a class="qimg" href="${esc(q.img)}" target="_blank" rel="noopener"><img src="${esc(q.img)}" alt="問題の図表" loading="lazy" style="${q.iw ? `width:min(100%, ${Number(q.iw)}px)` : ''}"><span>タップで拡大</span></a>`;
  }

  // 問題の解説カード（復習・結果画面で共通）
  function qItem(q, o = {}) {
    if (!q) return '';
    const s = st(q.id);
    const head = o.ok != null
      ? `<span class="status-pill ${o.ok ? 'good' : 'bad'}">${o.ok ? '○' : '×'}</span>`
      : `<span class="status-pill ${s.wrong ? 'bad' : ''}">ミス${s.wrong}回</span>`;
    return `<details class="qitem">
      <summary><div class="row" style="align-items:flex-start">${head}<div style="flex:1">
        <div class="sub">${o.idx ? `問${o.idx} ・ ` : ''}${esc(q.c)}${s.flag ? ' ・ ★苦手マーク' : ''}</div>
        <div class="snip">${esc(q.q.split('\n')[0].slice(0, 70))}${q.q.length > 70 ? '…' : ''}</div></div></div></summary>
      <div class="body">
        <div class="qtext" style="font-size:.92rem">${esc(q.q)}</div>
        ${figure(q)}
        <ol>${q.ch.map((c, i) => `<li class="${i === q.a ? 'ans' : ''}">${KANA[i]}　${esc(c)}${i === q.a ? '　✓ 正解' : ''}${o.choice === i && i !== q.a ? '　← あなたの解答' : ''}</li>`).join('')}</ol>
        <div class="explain"><div class="t">解説</div>${esc(q.ex)}</div>
        <div class="sub" style="margin-top:8px">回答${s.n}回 ／ 正解${s.ok}回 ${s.due && isWeak(s) ? `／ 次回出題予定 ${s.due}` : ''}</div>
        <label class="flag-toggle"><input type="checkbox" data-act="flag-id" data-id="${esc(q.id)}" ${s.flag ? 'checked' : ''}> 苦手マーク</label>
      </div>
    </details>`;
  }

  // ---------- 復習 ----------
  let reviewTab = 'weak';
  function viewReview() {
    const qs = allQ();
    const lists = {
      weak: qs.filter(q => isWeak(S.qs[q.id])),
      flag: qs.filter(q => S.qs[q.id] && S.qs[q.id].flag),
      missed: qs.filter(q => S.qs[q.id] && S.qs[q.id].wrong > 0),
    };
    const list = lists[reviewTab].slice().sort((a, b) => st(b.id).wrong - st(a.id).wrong);
    const stats = computeStats();
    const empty = {
      weak: '苦手問題はありません。毎日の10問で間違えた問題がここに表示されます。',
      flag: '苦手マークを付けた問題はありません。',
      missed: 'まだ間違えた問題はありません。',
    }[reviewTab];
    $view.innerHTML = `
      <h1>復習</h1>
      <section class="card">
        <h2>苦手問題を解き直す</h2>
        <p class="sub">間違えた問題・苦手マークの問題から最大10問を出題します。</p>
        <button class="btn primary block" data-act="weak" ${lists.weak.length ? '' : 'disabled'}>苦手問題に挑戦（${Math.min(lists.weak.length, DAILY_N)}問）</button>
      </section>
      <div class="seg" role="tablist">
        <button class="${reviewTab === 'weak' ? 'on' : ''}" data-act="rtab" data-tab="weak">苦手 ${lists.weak.length}</button>
        <button class="${reviewTab === 'flag' ? 'on' : ''}" data-act="rtab" data-tab="flag">★マーク ${lists.flag.length}</button>
        <button class="${reviewTab === 'missed' ? 'on' : ''}" data-act="rtab" data-tab="missed">ミス履歴 ${lists.missed.length}</button>
      </div>
      ${list.length ? list.map(q => qItem(q)).join('') : `<div class="empty">${empty}</div>`}
      <section class="card" style="margin-top:18px">
        <h2>分野別に演習</h2>
        <p class="sub">苦手な分野を集中的に10問。到達率が低い分野から取り組むのがおすすめです。</p>
        ${FIELDS.map(f => `<h3>${fieldDot(f)}${CATS[f].name}</h3><ul class="cat-list">${CATS[f].cats.map(c => {
          const o = stats.byCat[c] || { reach: 0, total: 0 };
          return `<li><div><div>${esc(c)}</div><div class="sub">到達率 ${Math.round(o.reach * 100)}% ・ ${o.total}問</div></div>
            <button class="btn small" data-act="cat" data-cat="${esc(c)}">10問</button></li>`;
        }).join('')}</ul>`).join('')}
      </section>`;
  }

  // ---------- 分析 ----------
  function viewStats() {
    const s = computeStats();
    // 14日間の回答数
    const days = []; let maxN = 1;
    for (let i = 13; i >= 0; i--) { const d = addDays(today(), -i); const r = S.days[d] || { n: 0, ok: 0 }; days.push({ d, ...r }); maxN = Math.max(maxN, r.n); }
    const bars = days.map(x => {
      const okH = x.ok / maxN * 100, ngH = (x.n - x.ok) / maxN * 100;
      return `<div class="c" title="${x.d}：${x.n}問中${x.ok}問正解" aria-label="${x.d} ${x.n}問中${x.ok}問正解">
        <i class="ng" style="height:${ngH}%"></i><i class="ok" style="height:${okH}%"></i></div>`;
    }).join('');
    const labels = days.map(x => `<span>${parseYmd(x.d).getDate()}</span>`).join('');
    const totalAns = Object.values(S.days).reduce((a, d) => a + d.n, 0);
    const totalOk = Object.values(S.days).reduce((a, d) => a + d.ok, 0);

    $view.innerHTML = `
      <h1>分析</h1>
      <section class="card">
        <div class="row between"><h2 style="margin:0">予想スコア</h2>${s.passed ? '<span class="status-pill good">✓ 合格ライン到達</span>' : '<span class="status-pill bad">✕ 合格ライン未到達</span>'}</div>
        <div class="score-big" style="margin-top:8px"><span class="v num">${s.totalScore}</span><span class="sub">/ 1000</span></div>
        ${meter('総合評価点', s.totalScore / 1000, `${s.totalScore} / 合格 ${PASS_TOTAL}`, { line: PASS_TOTAL / 1000 })}
        ${FIELDS.map(f => meter(`${fieldDot(f)}${CATS[f].name}（本番${CATS[f].exam}問）`, s.byField[f].score / 1000,
          `${s.byField[f].score} ${scoreStatus(s.byField[f].score, PASS_FIELD)}`, { line: PASS_FIELD / 1000, color: `var(--field-${f})` })).join('')}
        <div class="legend"><span><i class="ln"></i>合格ライン（総合600・各分野300）</span></div>
        <p class="note" style="margin-top:10px">信頼度：<b>${s.confidence}</b>（回答済み ${s.seenAll} / ${s.totalQ} 問）。<br>
        各分野の「直近の正誤」から正答率を推定し、本番の出題数（ストラテジ35・マネジメント20・テクノロジ45）で重み付けして1000点満点に換算した参考値です。回答が少ないうちは50%付近に寄せて表示します。</p>
      </section>

      <section class="card">
        <h2>分野別の到達率</h2>
        <p class="note">到達率＝その分野の全問題のうち、どれだけ身についたか。2回連続正解で1問分、直近1回正解で0.5問分として計算します。</p>
        ${FIELDS.map(f => {
          const fo = s.byField[f];
          return `<h3>${fieldDot(f)}${CATS[f].name}　<span class="num">${Math.round(fo.reach * 100)}%</span></h3>
          ${CATS[f].cats.map(c => {
            const o = s.byCat[c] || { reach: 0, acc: null, n: 0, total: 0, seen: 0 };
            return meter(esc(c), o.reach, `${Math.round(o.reach * 100)}% <span class="sub">(${o.seen}/${o.total}問・正答率${o.acc == null ? '—' : Math.round(o.acc * 100) + '%'})</span>`, { color: `var(--field-${f})` });
          }).join('')}`;
        }).join('')}
      </section>

      <section class="card">
        <h2>直近14日の学習量</h2>
        <div class="daybars" role="img" aria-label="直近14日の回答数">${bars}</div>
        <div class="daylabels">${labels}</div>
        <div class="legend"><span><i class="dot-f" style="background:var(--accent)"></i>正解</span><span><i class="dot-f" style="background:var(--accent-soft)"></i>不正解</span></div>
        <table class="data" style="margin-top:12px">
          <tr><th>累計回答数</th><td class="r num">${totalAns} 問</td></tr>
          <tr><th>累計正答率</th><td class="r num">${totalAns ? Math.round(totalOk / totalAns * 100) : 0}%</td></tr>
          <tr><th>連続学習日数</th><td class="r num">${streakDays()} 日</td></tr>
        </table>
      </section>`;
  }

  // ---------- 設定 ----------
  function viewSettings() {
    const appUrl = location.href.split('#')[0];
    $view.innerHTML = `
      <h1>設定</h1>
      <section class="card">
        <h2>受験日</h2>
        <label class="field"><span>受験予定日</span><input type="date" id="examDate" value="${esc(S.settings.examDate)}" min="${today()}"></label>
      </section>

      <section class="card">
        <h2>出題範囲</h2>
        <label class="field"><span>毎日の10問・演習に使う問題</span>
          <select id="pool">
            <option value="all" ${S.settings.pool === 'all' ? 'selected' : ''}>すべて（${everyQ().length}問）</option>
            <option value="past" ${S.settings.pool === 'past' ? 'selected' : ''}>IPA公開の過去問だけ（${PAST.length}問）</option>
            <option value="orig" ${S.settings.pool === 'orig' ? 'selected' : ''}>オリジナル類似問題だけ（${window.IPASS_QUESTIONS.length}問）</option>
          </select></label>
        <p class="note">変更は明日の10問から反映されます（「もう10問」や分野別演習にはすぐ反映）。予想スコアと到達率も、この範囲の問題で計算します。</p>
      </section>

      <section class="card">
        <h2>毎日のリマインド</h2>
        <label class="field"><span>通知してほしい時刻</span><input type="time" id="reminderTime" value="${esc(S.settings.reminderTime)}"></label>
        <p class="note">Webアプリは閉じている間に自分で通知を出せないため、スマホの<b>カレンダーの通知機能</b>を使って毎日リマインドします。下のボタンで「毎日この時刻に繰り返す予定」を登録してください（受験日まで）。</p>
        <div class="stack">
          <button class="btn block" data-act="ics">📅 カレンダーに登録（iPhone / Android）</button>
          <button class="btn block" data-act="gcal">Googleカレンダーに登録</button>
        </div>
        <p class="note" style="margin-top:10px">アプリを開いたときに、設定時刻を過ぎても今日の10問が終わっていなければホームにリマインドを表示します。</p>
      </section>

      <section class="card">
        <h2>ホーム画面に追加（推奨）</h2>
        <p class="note"><b>iPhone</b>：Safariの共有ボタン →「ホーム画面に追加」<br><b>Android</b>：Chromeのメニュー →「ホーム画面に追加」/「アプリをインストール」<br>
        アプリのように全画面で使え、オフラインでも動きます。iPhoneでは、ホーム画面に追加しておくと学習データが自動削除されにくくなります。</p>
      </section>

      <section class="card">
        <h2>学習データのバックアップ</h2>
        <p class="note">学習記録はこのスマホのブラウザ内だけに保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出しておくと安心です。</p>
        <div class="btn-row">
          <button class="btn" data-act="export">書き出し</button>
          <label class="btn file-btn">読み込み<input type="file" accept="application/json,.json" id="importFile"></label>
        </div>
      </section>

      <section class="card">
        <h2>問題を追加する</h2>
        <p class="note">IPA公開の過去問題などを、決められた形式（JSON）で追加できます。形式はREADMEを参照してください。現在の追加問題：<b>${S.custom.length}問</b>（収録済み：過去問 ${PAST.length}問・オリジナル ${window.IPASS_QUESTIONS.length}問）</p>
        <div class="btn-row">
          <label class="btn file-btn">JSONファイルを追加<input type="file" accept="application/json,.json" id="addQFile"></label>
          ${S.custom.length ? '<button class="btn danger" data-act="clear-custom">追加問題を削除</button>' : ''}
        </div>
      </section>

      <section class="card">
        <h2>リセット</h2>
        <p class="note">すべての学習記録を消去します（受験日などの設定と追加問題は残ります）。</p>
        <button class="btn danger block" data-act="reset">学習記録をリセット</button>
      </section>
      <p class="sub" style="text-align:center">iパス毎日10問 ・ <a href="${esc(appUrl)}">${esc(appUrl.replace(/^https?:\/\//, ''))}</a></p>`;

    document.getElementById('examDate').addEventListener('change', e => { S.settings.examDate = e.target.value; save(); toast('受験日を保存しました'); });
    document.getElementById('pool').addEventListener('change', e => { S.settings.pool = e.target.value; save(); toast('出題範囲を保存しました'); render(); });
    document.getElementById('reminderTime').addEventListener('change', e => { S.settings.reminderTime = e.target.value || '20:00'; save(); toast('時刻を保存しました'); });
    document.getElementById('importFile').addEventListener('change', importBackup);
    document.getElementById('addQFile').addEventListener('change', importQuestions);
  }

  // ---------- カレンダー連携 ----------
  function reminderStart() {
    const [hh, mm] = (S.settings.reminderTime || '20:00').split(':').map(Number);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
    if (start <= now) start.setDate(start.getDate() + 1);
    return start;
  }
  const icsDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  function untilRule() {
    if (!S.settings.examDate || S.settings.examDate < today()) return '';
    return `;UNTIL=${S.settings.examDate.replace(/-/g, '')}T235959`;
  }
  function downloadICS() {
    const start = reminderStart();
    const end = new Date(start.getTime() + 15 * 60000);
    const url = location.href.split('#')[0];
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ipass-daily10//JA', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:ipass-daily10-${Date.now()}@ipass`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
      `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      `RRULE:FREQ=DAILY${untilRule()}`,
      'SUMMARY:📝 iパス 今日の10問',
      `DESCRIPTION:ITパスポートの今日の10問を解こう！\\n${url}`,
      `URL:${url}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:iパス 今日の10問', 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    downloadBlob(blob, 'ipass-reminder.ics');
    toast('カレンダーファイルを作成しました');
  }
  function openGCal() {
    const start = reminderStart();
    const end = new Date(start.getTime() + 15 * 60000);
    const url = location.href.split('#')[0];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const p = new URLSearchParams({
      action: 'TEMPLATE',
      text: '📝 iパス 今日の10問',
      details: `ITパスポートの今日の10問を解こう！\n${url}`,
      dates: `${icsDate(start)}/${icsDate(end)}`,
      ctz: tz,
      recur: `RRULE:FREQ=DAILY${untilRule()}`,
    });
    window.open(`https://calendar.google.com/calendar/render?${p}`, '_blank', 'noopener');
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- バックアップ・問題追加 ----------
  function exportBackup() {
    const blob = new Blob([JSON.stringify({ app: 'ipass-daily10', version: 1, exportedAt: new Date().toISOString(), state: S }, null, 1)], { type: 'application/json' });
    downloadBlob(blob, `ipass-backup-${today()}.json`);
  }
  function readJsonFile(e, cb) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { cb(JSON.parse(r.result)); } catch (err) { toast('JSONの読み込みに失敗しました'); } e.target.value = ''; };
    r.readAsText(f);
  }
  function importBackup(e) {
    readJsonFile(e, data => {
      const st2 = data && data.state;
      if (!st2 || typeof st2 !== 'object' || !st2.qs) { toast('バックアップファイルではありません'); return; }
      if (!confirm('現在の学習記録を、読み込んだデータで上書きしますか？')) return;
      S = Object.assign(defaultState(), st2); rebuildMap(); save(); toast('読み込みました'); render();
    });
  }
  function validQ(q) {
    return q && typeof q.id === 'string' && ['S', 'M', 'T'].includes(q.f) && typeof q.c === 'string' && typeof q.q === 'string'
      && Array.isArray(q.ch) && q.ch.length >= 2 && q.ch.length <= 4 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.ch.length;
  }
  function importQuestions(e) {
    readJsonFile(e, data => {
      const arr = Array.isArray(data) ? data : data && data.questions;
      if (!Array.isArray(arr)) { toast('問題の配列が見つかりません'); return; }
      const base = new Set([...window.IPASS_QUESTIONS, ...PAST].map(q => q.id));
      const ok = [], ng = [];
      arr.forEach(q => (validQ(q) && !base.has(q.id) ? ok : ng).push(q));
      const map = new Map(S.custom.map(q => [q.id, q]));
      ok.forEach(q => map.set(q.id, { id: q.id, f: q.f, c: q.c, q: q.q, ch: q.ch.map(String), a: q.a, ex: String(q.ex || '解説は登録されていません。'), src: q.src ? String(q.src) : undefined }));
      S.custom = [...map.values()]; rebuildMap(); save();
      toast(`${ok.length}問を追加しました${ng.length ? `（${ng.length}件は形式エラー）` : ''}`);
      render();
    });
  }

  // ---------- アプリアイコンのバッジ（対応端末のみ） ----------
  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    const d = ensureDaily();
    const left = d.ids.length - d.results.length;
    try { left > 0 ? navigator.setAppBadge(left) : navigator.clearAppBadge(); } catch (e) { /* noop */ }
  }
  function clearBadge() { if ('clearAppBadge' in navigator) { try { navigator.clearAppBadge(); } catch (e) { /* noop */ } } }

  // ---------- 画面切り替え（ルーティング） ----------
  function render() {
    const route = (location.hash || '#home').slice(1);
    document.body.classList.toggle('quiz-mode', route === 'quiz');
    document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === route));
    ({ home: viewHome, quiz: viewQuiz, review: viewReview, stats: viewStats, settings: viewSettings }[route] || viewHome)();
    if (route !== 'quiz') window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#quiz' && session && session.idx >= session.ids.length) session = null;
    render();
  });

  // ボタン操作をまとめて受け取る（イベント委譲）
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case 'daily': { const d = ensureDaily(); startSession('daily', d.ids, '今日の10問'); break; }
      case 'daily-result': {
        const d = ensureDaily();
        session = { mode: 'daily', title: '今日の10問', ids: d.ids, idx: d.ids.length, results: d.results.slice(), answered: null };
        location.hash = '#quiz'; break;
      }
      case 'extra': startSession('extra', pickExtra(), '追加の10問'); break;
      case 'weak': startSession('weak', pickWeak(), '苦手問題'); break;
      case 'cat': startSession('cat', pickCat(el.dataset.cat), el.dataset.cat); break;
      case 'retry': {
        const ids = session.results.filter(r => !r.ok).map(r => r.id);
        startSession('retry', shuffle(ids), '解き直し'); break;
      }
      case 'answer': answer(Number(el.dataset.i)); break;
      case 'next': session.idx++; session.answered = null; viewQuiz(); break;
      case 'quit': session = null; location.hash = '#home'; break;
      case 'rtab': reviewTab = el.dataset.tab; viewReview(); break;
      case 'ics': downloadICS(); break;
      case 'gcal': openGCal(); break;
      case 'export': exportBackup(); break;
      case 'clear-custom':
        if (confirm('追加した問題をすべて削除しますか？')) { S.custom = []; rebuildMap(); save(); render(); }
        break;
      case 'reset':
        if (confirm('学習記録をすべて消去します。よろしいですか？')) {
          S = Object.assign(defaultState(), { settings: S.settings, custom: S.custom });
          save(); toast('リセットしました'); location.hash = '#home'; render();
        }
        break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.act === 'flag' || el.dataset.act === 'flag-id') {
      const id = el.dataset.id || (session && session.ids[session.idx]);
      if (!id) return;
      S.qs[id] = Object.assign(st(id), { flag: el.checked });
      if (el.checked && !S.qs[id].due) S.qs[id].due = addDays(today(), 1);
      save();
      toast(el.checked ? '苦手マークを付けました' : '苦手マークを外しました');
    }
  });

  // 日付が変わったら（アプリを開きっぱなしでも）新しい10問に
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.daily && S.daily.date !== today() && location.hash !== '#quiz') render();
      updateBadge();
    }
  });

  // ---------- 起動 ----------
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  render();
  updateBadge();
})();
