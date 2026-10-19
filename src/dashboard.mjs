/**
 * aipool · 运维控制台
 *
 * renderDashboard() 返回一整份自包含 HTML（内联 CSS + 内联 JS），由守护进程在 GET / 提供。
 * 无外部请求、无 CDN、无构建步骤、无框架。所有服务端字符串一律走 textContent / createElement。
 */

const HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>aipool · 控制台</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg:#0a0d12;--panel:#111823;--panel-2:#0d131c;--line:#1f2a39;--line-soft:#18212d;--text:#e8eef8;--dim:#a3b1c6;--muted:#7b8aa3;--accent:#6aa9ff;--green:#3ddc97;--amber:#f5b942;--red:#ff6b6b;--darkred:#ffb4a8;--grey:#8a97ab;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--radius:10px;--max:1280px}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,h3,p,pre,table{margin:0}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.dim{color:var(--muted)}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* sticky header */
.top{position:sticky;top:0;z-index:30;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(10,13,18,.98),rgba(10,13,18,.9));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.top-inner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 20px;max-width:var(--max);margin:0 auto;padding:10px 16px}
.brand{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-width:0}
.logo{font-family:var(--mono);font-size:17px;font-weight:700;letter-spacing:-.02em}
.logo .a{color:var(--accent)}
.tagline{color:var(--muted);font-size:12px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;min-width:0;font-size:12px;color:var(--dim)}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--text)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--grey);flex:none}
.dot.green{background:var(--green);box-shadow:0 0 0 3px rgba(61,220,151,.14)}
.dot.amber{background:var(--amber);box-shadow:0 0 0 3px rgba(245,185,66,.14)}
.dot.red{background:var(--red);box-shadow:0 0 0 3px rgba(255,107,107,.16)}
.base{font-family:var(--mono);font-size:12px;color:var(--dim);max-width:100%;overflow-wrap:anywhere}

/* shell / banner / gate */
.shell{max-width:var(--max);margin:0 auto;padding:12px 16px 44px}
.banner{margin:0 0 12px;padding:8px 12px;border:1px solid rgba(255,107,107,.4);border-radius:8px;background:rgba(255,107,107,.09);color:#ffb4b4;font-size:12px}
.banner[hidden],.gate[hidden]{display:none}
.gate{padding:14px;margin:0 0 12px;border:1px solid rgba(106,169,255,.35);border-radius:var(--radius);background:rgba(106,169,255,.06)}
.gate h2{font-size:14px;margin-bottom:4px}
.gate p{margin:0 0 10px;color:var(--dim);font-size:12px}
.gate form{display:flex;flex-wrap:wrap;gap:8px}
.gate input{flex:1 1 240px;min-width:0;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:#0a0f16;color:var(--text);font:12px var(--mono)}
.gate input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

/* counters */
.counters{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:0 0 16px}
.stat{min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
.stat-label{font-size:11px;color:var(--muted);letter-spacing:.02em}
.stat-value{margin-top:2px;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:19px;line-height:1.25;overflow-wrap:anywhere}
.stat-sub{font-size:11px;color:var(--muted);font-family:var(--mono);font-variant-numeric:tabular-nums}

/* cards */
.section-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:18px 0 8px}
.section-head h2{font-size:13px;letter-spacing:.02em}
.section-head .hint{font-size:12px;color:var(--muted)}
.card{margin-bottom:12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden}
.card-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 12px;padding:10px 12px;border-bottom:1px solid var(--line-soft);background:var(--panel-2)}
.p-left{min-width:0}
.p-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.p-name{font-size:14px;font-weight:650}
.p-id{margin-top:2px;font-size:11px}
.p-right{display:flex;align-items:center;gap:8px;flex:none}
.card-body{padding:10px 12px 12px}
.hint{color:var(--muted);font-size:12px}
.panel{padding:12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
.panel.empty{color:var(--muted);font-size:12px;margin-bottom:12px}
.badge{display:inline-block;padding:0 6px;border:1px solid var(--line);border-radius:5px;background:rgba(255,255,255,.02);color:var(--dim);font-size:11px;font-family:var(--mono);line-height:1.7;white-space:nowrap}
.badge.bad{color:#ffb4b4;border-color:rgba(255,107,107,.32)}
.pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border:1px solid transparent;border-radius:999px;font-size:11px;font-weight:600;line-height:1.7;white-space:nowrap}
.pill.healthy{color:#7cf0bd;background:rgba(61,220,151,.12);border-color:rgba(61,220,151,.3)}
.pill.cooldown{color:#ffd083;background:rgba(245,185,66,.12);border-color:rgba(245,185,66,.32)}
.pill.exhausted,.pill.down{color:#ff9f9f;background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.34)}
.pill.invalid{color:var(--darkred);background:rgba(150,40,32,.32);border-color:rgba(190,60,48,.5)}
.pill.disabled,.pill.unknown{color:#a3afc2;background:rgba(138,151,171,.12);border-color:rgba(138,151,171,.28)}
.models{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.chip{padding:0 6px;border:1px solid var(--line-soft);border-radius:5px;background:rgba(255,255,255,.02);color:var(--dim);font-size:11px;line-height:1.8}
.chip.more{color:var(--muted)}

/* tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:6px 10px;border-bottom:1px solid var(--line);background:var(--panel-2);color:var(--muted);font-size:11px;font-weight:600;text-align:left;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
td .cell{min-width:0}
.empty-cell{color:var(--muted);padding:14px 10px}
table.keys{table-layout:fixed;min-width:760px}
.k-ident{width:20%}.k-state{width:11%}.k-quota{width:22%}.k-traffic{width:15%}.k-err{width:15%}.k-actions-cell{width:17%}
.k-label{font-weight:600;overflow-wrap:anywhere}
.k-sub{margin-top:2px;font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.k-weight{color:var(--muted)}
table.tokens{table-layout:fixed;min-width:660px}
.t-name{width:22%}.t-id{width:18%}.t-created{width:14%}.t-used{width:14%}.t-req{width:10%}.t-actions{width:16%}

/* quota bars */
.q{display:flex;align-items:center;gap:6px;min-width:0;margin:3px 0}
.q-scope{flex:none;width:20px;font-family:var(--mono);font-size:10px;color:var(--muted)}
.q-bar{position:relative;flex:1 1 auto;min-width:40px;height:5px;border-radius:3px;background:#1a2330;overflow:hidden}
.q-fill{position:absolute;top:0;bottom:0;left:0;background:var(--accent)}
.q-fill.none{background:#26303e;width:100%;opacity:.35}
.q-fill.ok{background:var(--green)}
.q-fill.warn{background:var(--amber)}
.q-fill.danger{background:var(--red)}
.q-pct{flex:none;width:42px;text-align:right;font-size:11px;color:var(--text)}
.q-reset{flex:0 0 auto;min-width:0;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:10px;white-space:nowrap}
.err-code{font-size:11px;color:#ff9f9f;font-weight:600;overflow-wrap:anywhere}
.err-msg{font-size:11px;color:var(--dim);overflow-wrap:anywhere;max-width:100%}

/* buttons / probe */
.btn{padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:#18212e;color:var(--dim);font:11px/1.4 var(--sans);white-space:nowrap;cursor:pointer}
.btn:hover{border-color:#33445c;color:var(--text)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn.danger{color:#ff9b9b;border-color:rgba(255,107,107,.3);background:rgba(255,107,107,.08)}
.btn.primary{color:#bcd8ff;border-color:rgba(106,169,255,.34);background:rgba(106,169,255,.1)}
.k-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px}
.probe{flex-basis:100%;margin-top:2px;font-family:var(--mono);font-size:10px;color:var(--muted)}
.probe.good{color:var(--green)}
.probe.bad{color:#ff9b9b}

/* recent */
table.recent{table-layout:fixed}
.c-time{width:112px}.c-route{width:18%}.c-attempts{width:64px}.c-ms{width:82px}.c-err{width:22%}
.sdot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px}
.sdot.ok{background:var(--green)}
.sdot.err{background:var(--red)}
.c-time .cell{display:flex;align-items:center;white-space:nowrap}
.c-time .rel{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;color:var(--dim)}
.err-text{color:#ff9b9b;font-size:11px}
.ok-text{color:var(--green);font-size:11px}
.c-ms .num{white-space:nowrap}
tr.row-err td{background:rgba(255,107,107,.035)}

/* footer / toast */
.foot{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}
.foot-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px}
.foot-label{font-size:11px;color:var(--muted);letter-spacing:.04em;margin-bottom:6px}
.curl{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--text);font-size:11.5px;line-height:1.7;overflow-x:auto;white-space:pre}
.note{color:var(--dim);font-size:12px;margin-bottom:8px}
.note code{color:var(--accent);font-size:11px}
.toast{position:fixed;right:16px;bottom:16px;z-index:60;max-width:min(420px,calc(100vw - 32px));padding:9px 12px;border:1px solid rgba(255,107,107,.4);border-radius:8px;background:#1a1013;color:#ffc2c2;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.toast[hidden]{display:none}

/* responsive */
@media (max-width:1040px){.counters{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){
  table.keys,table.keys thead,table.keys tbody,table.keys tr,table.keys td,
  table.tokens,table.tokens thead,table.tokens tbody,table.tokens tr,table.tokens td{display:block;width:100%;min-width:0}
  table.keys,table.tokens{min-width:0}
  table.keys thead,table.tokens thead{display:none}
  table.keys tr,table.tokens tr{padding:8px 0;border-bottom:1px solid var(--line)}
  tbody tr:last-child{border-bottom:0}
  table.keys td,table.tokens td{border:0;padding:4px 12px}
  table.keys td::before,table.tokens td::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--muted);font-family:var(--sans);font-size:10px;letter-spacing:.05em}
  .section-head{margin-top:16px}
}
@media (max-width:640px){
  .c-route,.c-attempts{display:none}
  .c-time{width:92px}.c-ms{width:74px}.c-err{width:26%}
  .foot-grid{grid-template-columns:1fr}
  .curl{white-space:pre-wrap;overflow-wrap:anywhere}
}
@media (max-width:620px){
  /* Stacked key rows are narrow: let the reset countdown drop to its own line
     instead of pushing the bar and percent past the card edge. */
  .q{flex-wrap:wrap;row-gap:2px}
  .q-reset{flex:1 0 100%;padding-left:26px;text-align:right}
}
@media (max-width:520px){
  .shell{padding:10px 10px 36px}
  .top-inner{padding:8px 10px}
  .counters{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card-head,.card-body{padding:9px 10px}
  .stat-value{font-size:17px}
}
</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div class="brand"><span class="logo">ai<span class="a">pool</span></span><span class="tagline">多把上游密钥，一个局域网 OpenAI 兼容入口</span></div>
    <div class="meta">
      <span class="live"><span id="daemon-dot" class="dot"></span><span id="daemon-state">连接中…</span></span>
      <span>运行 <span id="uptime" class="mono">—</span></span>
      <span>v<span id="version" class="mono">—</span></span>
      <span id="base-url" class="base">http://—:—/v1</span>
    </div>
  </div>
</header>
<main class="shell">
  <div id="banner" class="banner" role="status" hidden></div>
  <section id="gate" class="gate" hidden>
    <h2>需要管理员令牌</h2>
    <p>控制台用 Bearer 令牌读取 /admin/status 并执行重置、停用、探活等操作。</p>
    <form id="gate-form" autocomplete="off">
      <input id="gate-token" type="password" placeholder="ADMIN_TOKEN" aria-label="管理员令牌" spellcheck="false">
      <button class="btn primary" type="submit">连接</button>
    </form>
    <p id="gate-hint" class="dim" style="margin:8px 0 0">令牌只保存在本机 localStorage。</p>
  </section>
  <section class="counters" id="counters" aria-label="流量计数"></section>
  <div class="section-head"><h2>上游 provider</h2><span class="hint">冷却中的密钥不会接流量；探活会真实请求一次上游。</span></div>
  <div id="providers"></div>
  <section class="card" id="tokens-card">
    <div class="card-head"><div class="p-left">
      <div class="p-title"><h2 class="p-name">客户端令牌</h2><span class="badge mono" id="token-count">—</span></div>
      <div class="p-id hint">发给局域网客户端的 Bearer 令牌，不是管理员令牌</div>
    </div></div>
    <div class="table-wrap">
      <table class="tokens">
        <thead><tr>
          <th scope="col">名称</th><th scope="col">令牌 ID</th><th scope="col">创建</th>
          <th scope="col">最近使用</th><th scope="col">请求</th><th scope="col">操作</th>
        </tr></thead>
        <tbody id="token-body"></tbody>
      </table>
    </div>
  </section>
  <section class="card" id="recent-card">
    <div class="card-head"><div class="p-left">
      <div class="p-title"><h2 class="p-name">最近请求</h2><span class="hint">最新在前，最多 50 条</span></div>
    </div></div>
    <div class="table-wrap">
      <table class="recent">
        <thead><tr>
          <th scope="col" class="c-time">时间</th><th scope="col">模型</th><th scope="col" class="c-route">路由</th>
          <th scope="col" class="c-attempts">尝试</th><th scope="col" class="c-ms">延迟</th><th scope="col" class="c-err">错误</th>
        </tr></thead>
        <tbody id="recent-body"></tbody>
      </table>
    </div>
  </section>
  <footer class="foot">
    <div class="foot-grid">
      <div>
        <div class="foot-label">局域网调用示例</div>
        <pre id="curl" class="curl mono">curl http://127.0.0.1:8787/v1/chat/completions</pre>
      </div>
      <div>
        <div class="foot-label">说明</div>
        <p class="note">上面的 <code>aipool-xxxxxxxxxxxxxxxx</code> 是客户端令牌；本控制台用的是管理员令牌（ADMIN_TOKEN），两者不要混用。</p>
        <p class="note">聚合入口 <code id="foot-addr" class="mono">/v1</code> 由 config.host / config.port 推导；本页每 2 秒轮询一次 /admin/status。</p>
      </div>
    </div>
  </footer>
</main>
<div id="toast" class="toast" role="alert" hidden></div>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'aipool.token', POLL_MS = 2000, STALE_MS = 5000;
  var STATE_LABEL = { healthy: '健康', cooldown: '冷却中', exhausted: '额度用尽', invalid: '密钥失效', disabled: '已停用' };
  var STATE_CLASS = { healthy: 'healthy', cooldown: 'cooldown', exhausted: 'exhausted', invalid: 'invalid', disabled: 'disabled' };
  var S = { token: '', data: null, lastOkAt: 0, failed: false, polling: false, queued: false, unauth: false, sig: '', probes: Object.create(null) };
  var toastTimer = 0;
  /* ---------- DOM helpers：只建节点、只写 textContent ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function sval(v) { return (v === null || v === undefined) ? '' : String(v); }
  function nval(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function pad2(v) { return v < 10 ? '0' + v : String(v); }
  /* ---------- 时间 / 数字格式化 ---------- */
  function parseTs(iso) { if (!iso) return 0; var t = Date.parse(String(iso)); return isNaN(t) ? 0 : t; }
  function fmtRel(iso) {
    var t = parseTs(iso);
    if (!t) return '—';
    var d = Math.floor((Date.now() - t) / 1000);
    if (d < 0) d = 0;
    if (d < 5) return '刚刚';
    if (d < 60) return d + ' 秒前';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }
  function fmtUntil(iso) {
    var t = parseTs(iso);
    if (!t) return '';
    var s = Math.floor((t - Date.now()) / 1000);
    if (s <= 0) return '即将到点';
    if (s < 60) return s + ' 秒后';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + pad2(s % 60) + ' 秒后';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分后';
    return Math.floor(s / 86400) + ' 天 ' + Math.floor((s % 86400) / 3600) + ' 小时后';
  }
  function fmtShort(iso) {
    var t = parseTs(iso);
    if (!t) return '';
    var s = Math.floor((t - Date.now()) / 1000);
    if (s <= 0) return '已到期';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h' + pad2(Math.floor((s % 3600) / 60)) + 'm';
    return Math.floor(s / 86400) + 'd' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function fmtDur(sec) {
    var s = nval(sec);
    if (s === null) return '—';
    s = Math.max(0, Math.floor(s));
    var rest = s % 86400;
    var hms = pad2(Math.floor(rest / 3600)) + ':' + pad2(Math.floor((rest % 3600) / 60)) + ':' + pad2(rest % 60);
    return s >= 86400 ? Math.floor(s / 86400) + ' 天 ' + hms : hms;
  }
  function num(v) {
    var x = nval(v);
    if (x === null) return '—';
    try { return x.toLocaleString('en-US'); } catch (e) { return String(x); }
  }
  function compact(v) {
    var x = nval(v);
    if (x === null) return '—';
    var a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (x / 1e3).toFixed(1) + 'k';
    return num(x);
  }
  function msText(v) { var x = nval(v); return x === null ? '—' : Math.round(x) + ' ms'; }
  function relNode(iso, cls) {
    var raw = sval(iso);
    var node = el('span', cls || 'rel', fmtRel(raw));
    if (raw) { node.setAttribute('data-rel', raw); node.title = raw; }
    return node;
  }
  function untilNode(iso, prefix, mode) {
    var raw = sval(iso), pre = prefix || '', short = mode === 'short';
    var text = short ? fmtShort(raw) : fmtUntil(raw);
    var node = el('span', 'until', pre ? pre + text : text);
    if (raw) { node.setAttribute('data-until', raw); node.title = raw; }
    if (pre) node.setAttribute('data-prefix', pre);
    if (short) node.setAttribute('data-mode', 'short');
    return node;
  }
  function button(label, cls, onClick) {
    var b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = String(msg);
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 6000);
  }
  /* ---------- 头部状态 / 实时倒计时 ---------- */
  function updateDaemon() {
    var dot = $('daemon-dot'), label = $('daemon-state');
    if (!dot || !label) return;
    var cls = 'dot', text = '连接中…';
    if (S.unauth) { cls += ' red'; text = '需要令牌'; }
    else if (S.failed) { cls += ' red'; text = '连接断开'; }
    else if (!S.lastOkAt) { cls += ' amber'; text = '连接中…'; }
    else if (Date.now() - S.lastOkAt > STALE_MS) { cls += ' amber'; text = '数据滞后'; }
    else { cls += ' green'; text = '运行中'; }
    dot.className = cls;
    label.textContent = text;
  }
  function updateUptime() {
    var node = $('uptime');
    if (!node) return;
    var base = nval((S.data || {}).uptimeSec);
    if (base === null) { node.textContent = '—'; return; }
    var extra = S.lastOkAt ? Math.max(0, Math.floor((Date.now() - S.lastOkAt) / 1000)) : 0;
    node.textContent = fmtDur(base + extra);
  }
  function tick() {
    var i, nodes = document.querySelectorAll('[data-rel]');
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = fmtRel(nodes[i].getAttribute('data-rel'));
    nodes = document.querySelectorAll('[data-until]');
    for (i = 0; i < nodes.length; i++) {
      var pre = nodes[i].getAttribute('data-prefix') || '';
      var mode = nodes[i].getAttribute('data-mode');
      var v = (mode === 'short' ? fmtShort : fmtUntil)(nodes[i].getAttribute('data-until'));
      nodes[i].textContent = pre ? (v ? pre + v : '') : v;
    }
    updateDaemon();
    updateUptime();
  }
  /* ---------- 计数器 ---------- */
  function addStat(label, value, sub, title) {
    var card = el('div', 'stat');
    card.appendChild(el('div', 'stat-label', label));
    var v = el('div', 'stat-value', value);
    if (title) v.title = title;
    card.appendChild(v);
    if (sub) card.appendChild(el('div', 'stat-sub', sub));
    $('counters').appendChild(card);
  }
  function renderCounters(d) {
    var root = $('counters');
    clear(root);
    var c = (d && d.counters && typeof d.counters === 'object') ? d.counters : {};
    var req = nval(c.requests), ok = nval(c.ok), failed = nval(c.failed);
    var rate = (ok !== null && req !== null && req > 0) ? Math.round(ok / req * 1000) / 10 : null;
    addStat('请求', num(req), '失败 ' + num(failed === null ? 0 : failed));
    addStat('成功率', rate === null ? '—' : rate + '%', ok === null ? '' : '成功 ' + num(ok));
    addStat('重试', num(c.retries), '');
    addStat('活跃流', num(c.activeStreams), '');
    addStat('输入 token', compact(c.tokensIn), nval(c.tokensIn) === null ? '' : num(c.tokensIn));
    addStat('输出 token', compact(c.tokensOut), nval(c.tokensOut) === null ? '' : num(c.tokensOut));
  }
  /* ---------- provider / key 表 ---------- */
  function cellTd(label, cls, child) {
    var td = el('td', cls || '');
    td.setAttribute('data-label', label);
    var box = el('div', 'cell');
    if (child) box.appendChild(child);
    td.appendChild(box);
    return td;
  }
  function emptyRow(cols, message) {
    var tr = el('tr'), td = el('td', 'empty-cell', message);
    td.colSpan = cols;
    tr.appendChild(td);
    return tr;
  }
  function quotaRow(scope, q) {
    var row = el('div', 'q');
    row.appendChild(el('span', 'q-scope', scope));
    var pct = (q && typeof q === 'object') ? nval(q.percent) : null;
    var bar = el('span', 'q-bar'), fill = el('span', 'q-fill');
    fill.style.width = (pct === null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
    fill.className = 'q-fill ' + (pct === null ? 'none' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'q-pct num', pct === null ? '—' : (Math.round(pct * 10) / 10) + '%'));
    var reset = el('span', 'q-reset dim');
    if (q && q.resetsAt) {
      reset.appendChild(untilNode(q.resetsAt, '重置 ', 'short'));
      row.title = '重置时间 ' + sval(q.resetsAt);
    }
    row.appendChild(reset);
    return row;
  }
  function renderProbe(slot, rec) {
    if (!slot || !rec) return;
    var ok = rec.ok === true;
    var text = 'HTTP ' + (rec.status === undefined || rec.status === null ? '—' : rec.status);
    if (typeof rec.ms === 'number') text += ' · ' + rec.ms + ' ms';
    if (rec.error) text += ' · ' + String(rec.error);
    slot.className = 'probe ' + (ok ? 'good' : 'bad');
    slot.textContent = text;
    slot.title = rec.error ? String(rec.error) : '';
  }
  function keyRow(p, k) {
    var pid = sval(p.id), kid = sval(k.id);
    var stateKey = sval(k.state) || (k.enabled === false ? 'disabled' : '');
    var tr = el('tr');
    var idBox = el('div');
    idBox.appendChild(el('div', 'k-label', sval(k.label) || kid || '未命名密钥'));
    var mask = el('div', 'k-sub mono dim', sval(k.apiKeyMasked) || '—');
    if (nval(k.weight) !== null) mask.appendChild(el('span', 'k-weight', ' · 权重 ' + k.weight));
    idBox.appendChild(mask);
    tr.appendChild(cellTd('密钥', 'k-ident', idBox));
    var stBox = el('div');
    stBox.appendChild(el('span', 'pill ' + (STATE_CLASS[stateKey] || 'unknown'), STATE_LABEL[stateKey] || stateKey || '未知'));
    if (stateKey === 'cooldown') {
      var cool = el('div', 'k-sub');
      if (k.cooldownUntil) {
        cool.appendChild(untilNode(k.cooldownUntil, ''));
        cool.appendChild(el('span', 'dim', ' 恢复'));
      } else {
        cool.appendChild(el('span', 'dim', '等待上游恢复'));
      }
      stBox.appendChild(cool);
    }
    var streak = nval(k.failureStreak);
    if (streak !== null && streak > 0) stBox.appendChild(el('div', 'k-sub dim', '连续失败 ' + streak + ' 次'));
    tr.appendChild(cellTd('状态', 'k-state', stBox));
    var qBox = el('div');
    var quota = (k.quota && typeof k.quota === 'object') ? k.quota : null;
    qBox.appendChild(quotaRow('5h', quota ? quota.rolling : null));
    qBox.appendChild(quotaRow('周', quota ? quota.weekly : null));
    qBox.appendChild(quotaRow('月', quota ? quota.monthly : null));
    tr.appendChild(cellTd('配额 5h / 周 / 月', 'k-quota', qBox));
    var tBox = el('div');
    tBox.appendChild(el('div', 'num', '请求 ' + num(k.requests) + ' · 错误 ' + num(k.errors)));
    tBox.appendChild(el('div', 'k-sub num dim', '重试 ' + num(k.retries)));
    tBox.appendChild(el('div', 'k-sub num dim', '延迟 ' + msText(k.latencyMsAvg)));
    tr.appendChild(cellTd('流量 / 延迟', 'k-traffic', tBox));
    var le = (k.lastError && typeof k.lastError === 'object') ? k.lastError : null;
    var eBox = el('div');
    if (le) {
      eBox.appendChild(el('div', 'err-code mono', sval(le.code) || 'ERROR'));
      if (le.message) {
        var msg = el('div', 'err-msg truncate', sval(le.message));
        msg.title = sval(le.message);
        eBox.appendChild(msg);
      }
      if (le.at) {
        var atBox = el('div', 'k-sub dim');
        atBox.appendChild(relNode(le.at));
        eBox.appendChild(atBox);
      }
    } else {
      eBox.appendChild(el('span', 'dim', '—'));
    }
    tr.appendChild(cellTd('最近错误', 'k-err', eBox));
    var disabled = (k.enabled === false) || stateKey === 'disabled';
    var aBox = el('div', 'k-actions'), probeSlot = el('div', 'probe');
    var resetBtn = button('重置冷却', '', function () { act(pid, kid, 'resetKey', resetBtn); });
    var toggleBtn = button(disabled ? '启用' : '停用', disabled ? 'primary' : 'danger',
      function () { act(pid, kid, disabled ? 'enableKey' : 'disableKey', toggleBtn); });
    var probeBtn = button('探活', '', function () { probe(pid, kid, probeBtn, probeSlot); });
    aBox.appendChild(resetBtn);
    aBox.appendChild(toggleBtn);
    aBox.appendChild(probeBtn);
    var prev = S.probes[pid + '/' + kid];
    if (prev) renderProbe(probeSlot, prev);
    aBox.appendChild(probeSlot);
    tr.appendChild(cellTd('操作', 'k-actions-cell', aBox));
    return tr;
  }
  function keysTable(p) {
    var wrap = el('div', 'table-wrap'), table = el('table', 'keys');
    var thead = el('thead'), htr = el('tr');
    var cols = ['密钥', '状态', '配额', '流量 / 延迟', '最近错误', '操作'];
    for (var i = 0; i < cols.length; i++) {
      var th = el('th', '', cols[i]);
      th.scope = 'col';
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    var keys = Array.isArray(p.keys) ? p.keys : [];
    if (!keys.length) tbody.appendChild(emptyRow(cols.length, '该 provider 还没有配置密钥。'));
    else for (var j = 0; j < keys.length; j++) tbody.appendChild(keyRow(p, keys[j] || {}));
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  function providerCard(p) {
    var card = el('section', 'card provider');
    var head = el('div', 'card-head'), left = el('div', 'p-left'), titleRow = el('div', 'p-title');
    titleRow.appendChild(el('h2', 'p-name', sval(p.name) || sval(p.id) || '未命名 provider'));
    titleRow.appendChild(el('span', 'badge mono', sval(p.type) || 'unknown'));
    titleRow.appendChild(el('span', 'badge mono', '优先级 ' + (nval(p.priority) === null ? '—' : p.priority)));
    var models = Array.isArray(p.models) ? p.models : [];
    titleRow.appendChild(el('span', 'badge mono', models.length + ' 个模型'));
    if (p.enabled === false) titleRow.appendChild(el('span', 'badge bad', '已停用'));
    left.appendChild(titleRow);
    if (sval(p.id)) left.appendChild(el('div', 'p-id mono dim', sval(p.id)));
    head.appendChild(left);
    var right = el('div', 'p-right');
    var keyRows = Array.isArray(p.keys) ? p.keys : [];
    var liveKeys = keyRows.filter(function (k) { return k && k.enabled !== false; }).length;
    var h = (typeof p.healthy === 'boolean') ? p.healthy : null;
    // "no keys yet" and "every key disabled" are setup states, not failures.
    if (!keyRows.length) {
      right.appendChild(el('span', 'pill unknown', '未配置'));
    } else if (!liveKeys) {
      right.appendChild(el('span', 'pill unknown', '已停用'));
    } else {
      right.appendChild(el('span', 'pill ' + (h === true ? 'healthy' : h === false ? 'down' : 'unknown'),
        h === true ? '健康' : h === false ? '异常' : '未知'));
    }
    head.appendChild(right);
    card.appendChild(head);
    var body = el('div', 'card-body');
    if (models.length) {
      var chips = el('div', 'models'), limit = 16, used = Math.min(models.length, limit);
      for (var i = 0; i < used; i++) chips.appendChild(el('span', 'chip mono', sval(models[i])));
      if (models.length > limit) chips.appendChild(el('span', 'chip more', '+' + (models.length - limit)));
      body.appendChild(chips);
    } else {
      body.appendChild(el('div', 'models dim', '未声明模型'));
    }
    body.appendChild(keysTable(p));
    card.appendChild(body);
    return card;
  }
  function renderProviders(d) {
    var root = $('providers'), list = Array.isArray(d.providers) ? d.providers : [];
    clear(root);
    if (!list.length) {
      root.appendChild(el('div', 'panel empty', '还没有配置任何上游 provider。编辑 config 里的 providers 后重启。'));
      return;
    }
    for (var i = 0; i < list.length; i++) root.appendChild(providerCard(list[i] || {}));
  }
  /* ---------- 客户端令牌 ---------- */
  function tokenRow(tk) {
    var tr = el('tr');
    var nameBox = el('div');
    nameBox.appendChild(el('div', 'k-label', sval(tk.name) || sval(tk.id) || '未命名令牌'));
    if (tk.disabled === true) {
      var pillRow = el('div', 'k-sub');
      pillRow.appendChild(el('span', 'pill disabled', '已停用'));
      nameBox.appendChild(pillRow);
    }
    tr.appendChild(cellTd('名称', 't-name', nameBox));
    tr.appendChild(cellTd('令牌 ID', 't-id', el('div', 'mono dim', sval(tk.id) || '—')));
    var created = el('div');
    if (tk.createdAt) created.appendChild(relNode(tk.createdAt));
    else created.appendChild(el('span', 'dim', '—'));
    tr.appendChild(cellTd('创建', 't-created', created));
    var used = el('div');
    if (tk.lastUsedAt) used.appendChild(relNode(tk.lastUsedAt));
    else used.appendChild(el('span', 'dim', '从未使用'));
    tr.appendChild(cellTd('最近使用', 't-used', used));
    tr.appendChild(cellTd('请求', 't-req', el('div', 'num', num(tk.requests))));
    var disabled = tk.disabled === true, aBox = el('div', 'k-actions');
    var b = button(disabled ? '启用' : '停用', disabled ? 'primary' : 'danger', function () {
      b.disabled = true;
      postAction({ action: disabled ? 'enableToken' : 'disableToken', token: sval(tk.id) }).then(function (j) {
        if (j && j.ok === false && j.error) toast(j.error);
        refreshSoon();
      }).then(function () { b.disabled = false; });
    });
    aBox.appendChild(b);
    tr.appendChild(cellTd('操作', 't-actions', aBox));
    return tr;
  }
  function renderTokens(d) {
    var body = $('token-body'), list = Array.isArray(d.tokens) ? d.tokens : [];
    clear(body);
    $('token-count').textContent = list.length + ' 个';
    if (!list.length) { body.appendChild(emptyRow(6, '还没有客户端令牌。创建后作为 Bearer 令牌发给局域网客户端。')); return; }
    for (var i = 0; i < list.length; i++) body.appendChild(tokenRow(list[i] || {}));
  }
  /* ---------- 最近请求 ---------- */
  function recentRow(r) {
    var ok = sval(r.status) !== 'error';
    var tr = el('tr', ok ? '' : 'row-err');
    var timeBox = el('div');
    timeBox.appendChild(el('span', 'sdot ' + (ok ? 'ok' : 'err')));
    timeBox.appendChild(relNode(r.at));
    tr.appendChild(cellTd('时间', 'c-time', timeBox));
    var modelBox = el('div', 'truncate mono', sval(r.model) || '—');
    modelBox.title = sval(r.model);
    tr.appendChild(cellTd('模型', 'c-model', modelBox));
    var routeBox = el('div', 'truncate mono dim', sval(r.route) || '—');
    routeBox.title = sval(r.route);
    tr.appendChild(cellTd('路由', 'c-route', routeBox));
    tr.appendChild(cellTd('尝试', 'c-attempts', el('div', 'num', nval(r.attempts) === null ? '—' : String(r.attempts))));
    tr.appendChild(cellTd('延迟', 'c-ms', el('div', 'num', typeof r.ms === 'number' ? r.ms + ' ms' : '—')));
    var errBox = el('div', 'truncate dim');
    if (r.error) {
      errBox.className = 'truncate mono err-text';
      errBox.textContent = String(r.error);
      errBox.title = String(r.error);
    } else if (!ok) {
      errBox.className = 'err-text';
      errBox.textContent = '错误';
    } else {
      errBox.className = 'ok-text mono';
      errBox.textContent = 'ok';
    }
    tr.appendChild(cellTd('错误', 'c-err', errBox));
    return tr;
  }
  function renderRecent(d) {
    var body = $('recent-body'), rows = Array.isArray(d.recent) ? d.recent : [];
    clear(body);
    if (!rows.length) { body.appendChild(emptyRow(6, '还没有请求记录。')); return; }
    for (var i = 0; i < rows.length; i++) body.appendChild(recentRow(rows[i] || {}));
  }
  /* ---------- 头部 / 页脚 ---------- */
  function configBits(d) {
    var cfg = (d && d.config && typeof d.config === 'object') ? d.config : {};
    var host = sval(cfg.host) || '0.0.0.0';
    var port = nval(cfg.port) === null ? 8787 : cfg.port;
    var wildcard = (host === '0.0.0.0' || host === '::' || host === '[::]');
    // A wildcard bind is not a dialable address: show the address this very
    // browser used to reach the box, which is by definition the LAN IP.
    var browserHost = (typeof location !== 'undefined' && sval(location.hostname)) ? location.hostname : '127.0.0.1';
    var dial = wildcard ? browserHost : host;
    return { host: host, port: port, dial: dial, wildcard: wildcard };
  }
  function updateMeta(d) {
    var b = configBits(d), node = $('base-url');
    if (node) {
      node.textContent = 'http://' + b.dial + ':' + b.port + '/v1';
      node.title = b.wildcard
        ? '监听所有网卡：0.0.0.0 表示局域网内任何 IP 都能访问，客户端请换成这台 Mac mini 的实际 IP'
        : '聚合入口，OpenAI 兼容';
    }
    var v = $('version');
    if (v) v.textContent = sval(d && d.version) || '—';
    updateUptime();
  }
  function renderFooter(d) {
    var b = configBits(d);
    var lines = [
      'curl http://' + b.dial + ':' + b.port + '/v1/chat/completions \\',
      '  -H "Authorization: Bearer aipool-xxxxxxxxxxxxxxxx" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model":"auto","messages":[{"role":"user","content":"ping"}]}\''
    ];
    var pre = $('curl');
    if (pre) pre.textContent = lines.join('\n');
    var addr = $('foot-addr');
    if (addr) addr.textContent = 'http://' + b.dial + ':' + b.port + '/v1';
  }
  function applyStatus(d) {
    S.data = d;
    var sig = '';
    try {
      sig = JSON.stringify({ v: d.version, st: d.startedAt, c: d.counters, p: d.providers, t: d.tokens, r: d.recent, cfg: d.config });
    } catch (e) {
      sig = String(Math.random());
    }
    updateMeta(d);
    if (sig !== S.sig) {
      S.sig = sig;
      renderCounters(d);
      renderProviders(d);
      renderTokens(d);
      renderRecent(d);
      renderFooter(d);
    }
    tick();
  }
  /* ---------- 鉴权 ---------- */
  function readToken() {
    var stored = '';
    try { stored = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { stored = ''; }
    var qs = null;
    try { qs = new URLSearchParams(window.location.search); } catch (e2) { qs = null; }
    var fromUrl = qs ? qs.get('token') : null;
    if (fromUrl) {
      stored = fromUrl;
      try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (e3) { /* 隐私模式忽略 */ }
      try {
        qs.delete('token');
        var rest = qs.toString();
        window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
      } catch (e4) { /* 忽略 */ }
    }
    return stored;
  }
  function showGate(hint) {
    var g = $('gate');
    if (!g) return;
    g.hidden = false;
    var h = $('gate-hint');
    if (h) h.textContent = hint || '令牌只保存在本机 localStorage。';
    var inp = $('gate-token');
    if (inp && document.activeElement !== inp) { try { inp.focus(); } catch (e) { /* 忽略 */ } }
  }
  function hideGate() { var g = $('gate'); if (g) g.hidden = true; }
  /* ---------- actions / polling ---------- */
  function refreshSoon() {
    if (S.polling) { S.queued = true; return; }
    setTimeout(poll, 0);
  }
  function postAction(body) {
    return fetch('/admin/action', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + S.token, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) {
        S.unauth = true;
        showGate('令牌无效或已轮换，请重新输入管理员令牌。');
        updateDaemon();
        return { ok: false, error: '401 未认证' };
      }
      return res.json().then(function (j) {
        return (j && typeof j === 'object') ? j : { ok: false, error: '响应格式异常' };
      }, function () {
        return { ok: false, error: '响应不是合法 JSON（HTTP ' + res.status + '）' };
      });
    }).catch(function (err) {
      return { ok: false, error: '请求失败：' + (err && err.message ? err.message : String(err)) };
    });
  }
  function act(pid, kid, action, btn) {
    if (btn) btn.disabled = true;
    postAction({ action: action, provider: pid, key: kid }).then(function (j) {
      if (j && j.ok === false && j.error) toast(j.error);
      refreshSoon();
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function probe(pid, kid, btn, slot) {
    if (btn) btn.disabled = true;
    if (slot) { slot.className = 'probe'; slot.textContent = '探活中…'; }
    postAction({ action: 'probeKey', provider: pid, key: kid }).then(function (j) {
      if (j && (j.status !== undefined || j.ok === true)) {
        var rec = {
          ok: (typeof j.status === 'number') ? (j.status >= 200 && j.status < 300) : (j.ok === true),
          status: j.status, ms: j.ms, error: j.error
        };
        S.probes[pid + '/' + kid] = rec;
        renderProbe(slot, rec);
      } else if (slot) {
        slot.className = 'probe bad';
        slot.textContent = '探活失败：' + (j && j.error ? j.error : '未知错误');
      }
      refreshSoon();
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function poll() {
    if (!S.token) { S.unauth = true; showGate(''); updateDaemon(); return; }
    if (S.unauth) return;
    if (S.polling) { S.queued = true; return; }
    if (document.visibilityState === 'hidden') return;
    S.polling = true;
    fetch('/admin/status', { headers: { 'Authorization': 'Bearer ' + S.token }, cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401) {
          S.unauth = true;
          S.lastOkAt = 0;
          showGate('令牌无效或已轮换，请重新输入管理员令牌。');
          updateDaemon();
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (d) {
        if (!d) return;
        S.unauth = false;
        S.failed = false;
        S.lastOkAt = Date.now();
        hideGate();
        var banner = $('banner');
        if (banner) banner.hidden = true;
        applyStatus(d);
        updateDaemon();
        updateUptime();
      })
      .catch(function (err) {
        S.failed = true;
        var banner = $('banner');
        if (banner) {
          banner.textContent = '连接断开 · 已保留上次数据，每 2 秒自动重试'
            + (err && err.message ? '（' + err.message + '）' : '');
          banner.hidden = false;
        }
        updateDaemon();
      })
      .then(function () {
        S.polling = false;
        if (S.queued) { S.queued = false; setTimeout(poll, 0); }
      });
  }
  function onVisibility() {
    if (document.visibilityState === 'visible' && S.token && !S.unauth) poll();
  }

  function renderIdle() {
    clear($('providers'));
    $('providers').appendChild(el('div', 'panel empty', '等待 /admin/status 数据…'));
    [['token-body', '等待状态数据…'], ['recent-body', '等待状态数据…']].forEach(function (pair) {
      clear($(pair[0]));
      $(pair[0]).appendChild(emptyRow(6, pair[1]));
    });
    $('token-count').textContent = '—';
  }
  /* ---------- 启动 ---------- */
  function boot() {
    S.token = readToken();
    var form = $('gate-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var v = sval($('gate-token').value).trim();
        if (!v) { $('gate-hint').textContent = '请先填入管理员令牌。'; return; }
        S.token = v;
        try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { /* 忽略 */ }
        $('gate-token').value = '';
        S.unauth = false;
        S.lastOkAt = 0;
        hideGate();
        updateDaemon();
        poll();
      });
    }
    document.addEventListener('visibilitychange', onVisibility);
    updateDaemon();
    updateMeta(null);
    tick();
    renderCounters({});
    renderIdle();

    if (S.token) poll();
    else {
      S.unauth = true;
      showGate('在地址后加上 ?token=ADMIN_TOKEN，或直接在下面输入。');
      updateDaemon();
    }
    setInterval(function () { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
    setInterval(tick, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
</body>
</html>`;

export function renderDashboard() {
  return HTML;
}
