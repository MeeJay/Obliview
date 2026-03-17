package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	webview "github.com/webview/webview_go"
)

// ── Localhost shell server ────────────────────────────────────────────────────
// The shell tab-bar HTML is served over http://127.0.0.1 so that WebView2
// reliably executes its inline <script> tags (WebView2 silently blocks scripts
// on about:, data: and file:// pages in many configurations).

var (
	shellServeURL  string
	shellMu        sync.Mutex
	shellHTMLStore string
	shellNavSeq    int
)

// defaultW / defaultH — initial window content size on first launch.
const defaultW, defaultH = 1280, 800

// appVersion is injected via -ldflags "-X main.appVersion=x.y.z" at build time.
var appVersion = "1.0.0"

// ── AppView ───────────────────────────────────────────────────────────────────
// Each registered application gets its own native OS window (WebView2 instance)
// so every app has an independent cookie store and persistent socket connections.

type AppView struct {
	Entry AppEntry
	mu    sync.Mutex
	view  webview.WebView
	hwnd  uintptr // Win32 HWND; 0 until launchAppView sets it
}

func (av *AppView) getHWND() uintptr {
	av.mu.Lock()
	defer av.mu.Unlock()
	return av.hwnd
}

func (av *AppView) getView() webview.WebView {
	av.mu.Lock()
	defer av.mu.Unlock()
	return av.view
}

func (av *AppView) setViewAndHWND(v webview.WebView, h uintptr) {
	av.mu.Lock()
	av.view = v
	av.hwnd = h
	av.mu.Unlock()
}

// ── Global multi-app state ───────────────────────────────────────────────────

var (
	appViewsMu   sync.Mutex
	allAppViews  []*AppView
	activeAppIdx atomic.Int32 // index into allAppViews / cfg.Apps

	// shellHWND is the shell window's native handle; set once in main() after
	// webview.New() returns.  Read-only after that — no mutex needed.
	shellHWND uintptr

	// shellView is the shell WebView; goroutines use it for Dispatch/Eval calls.
	shellView webview.WebView
)

// ── overlayJS ─────────────────────────────────────────────────────────────────
// Injected via v.Init() into every app WebView on every page load.
//
// Guards:
//   - Skips non-http(s) pages (setup page, about:blank, etc.)
//   - Skips 127.0.0.1 / localhost (the shell tab-bar page)
//   - Idempotent: __ov_injected flag prevents double-injection
//
// Provides:
//   - Native-app flags recognised by all Obli* React apps
//   - Notification sounds for 'obliview:notify' CustomEvents
//   - Last-URL tracking via history patching → __go_saveAppLastURL
//   - Alert count reporting → __go_reportAlertCount (feeds tab-bar badges)
//   - Cross-app navigation intercept: location.replace/assign with a cross-origin
//     URL calls __go_openInAppTab instead of navigating the current window away
//   - Manifest auto-discovery → __go_proposeLinkedApps (adds new app tabs)
const overlayJS = `(function(){
  if(!/^https?:/.test(location.protocol))return;
  if(location.hostname==='127.0.0.1'||location.hostname==='localhost')return;
  if(window.__ov_injected)return;
  window.__ov_injected=true;

  /* Native-app flags — recognised by all Obli* apps to hide download banners. */
  window.__obliview_is_native_app=window.__obliance_is_native_app=
    window.__oblimap_is_native_app=window.__obliguard_is_native_app=true;

  /* ── Notification sounds ──────────────────────────────────────────────── */
  function tone(f,t,d,v){
    try{
      var c=new(window.AudioContext||window.webkitAudioContext)();
      var o=c.createOscillator(),g=c.createGain();
      o.connect(g);g.connect(c.destination);
      o.type=t||'sine';o.frequency.value=f;
      g.gain.setValueAtTime(v||.12,c.currentTime);
      g.gain.exponentialRampToValueAtTime(.001,c.currentTime+d);
      o.start(c.currentTime);o.stop(c.currentTime+d);
    }catch(e){}
  }
  var S={
    probe_down:function(){
      tone(440,'square',.12,.13);
      setTimeout(function(){tone(290,'square',.24,.13);},115);
    },
    probe_up:function(){
      tone(440,'sine',.12,.09);
      setTimeout(function(){tone(660,'sine',.2,.09);},125);
    },
    agent_alert:function(){
      tone(880,'triangle',.09,.11);
      setTimeout(function(){tone(880,'triangle',.09,.11);},145);
      setTimeout(function(){tone(1100,'triangle',.15,.11);},290);
    },
    agent_fixed:function(){
      tone(523,'sine',.1,.08);
      setTimeout(function(){tone(659,'sine',.13,.08);},115);
      setTimeout(function(){tone(784,'sine',.2,.08);},230);
    }
  };
  window.addEventListener('obliview:notify',function(e){
    var f=S[e.detail&&e.detail.type];
    if(f)f();
  });

  /* ── Last-URL tracking ────────────────────────────────────────────────── */
  /* Persists the current page path after every SPA navigation so that
     switching back to this app tab restores the exact last page visited.
     /auth/* paths are excluded to avoid persisting SSO callback URLs.     */
  function reportURL(){
    var p=location.pathname+location.search+location.hash;
    if(!p||/^\/auth\//.test(p))return;
    if(typeof window.__go_saveAppLastURL==='function')
      window.__go_saveAppLastURL(location.origin,p).catch(function(){});
  }
  var _ps=history.pushState.bind(history),_rs=history.replaceState.bind(history);
  history.pushState=function(){_ps.apply(this,arguments);setTimeout(reportURL,0);};
  history.replaceState=function(){_rs.apply(this,arguments);setTimeout(reportURL,0);};
  window.addEventListener('popstate',reportURL);
  if(document.readyState!=='loading')reportURL();
  else document.addEventListener('DOMContentLoaded',reportURL,{once:true});

  /* ── Alert count reporting ────────────────────────────────────────────── */
  /* Keeps the Go badge-cache fresh so the shell tab bar shows live counts.  */
  function reportAlerts(){
    fetch('/api/live-alerts/all',{credentials:'include'})
      .then(function(r){return r.json();})
      .then(function(d){
        var items=Array.isArray(d.data)?d.data:(Array.isArray(d)?d:(d.alerts||[]));
        var n=items.filter(function(a){return !a.read_at&&!a.readAt&&!a.read;}).length;
        if(typeof window.__go_reportAlertCount==='function')
          window.__go_reportAlertCount(location.origin,n).catch(function(){});
      }).catch(function(){});
  }
  setTimeout(function(){reportAlerts();setInterval(reportAlerts,30000);},4000);

  /* ── Cross-app navigation intercept ──────────────────────────────────── */
  /* When React calls location.replace/assign with a cross-origin URL (e.g.
     "Open this agent in Obliguard"), route to the target app's native window
     instead of navigating the current WebView away.                         */
  var _loc=window.location;
  var _origReplace=_loc.replace.bind(_loc);
  var _origAssign=_loc.assign.bind(_loc);
  function maybeIntercept(href){
    if(!href)return false;
    try{
      var u=new URL(String(href),location.href);
      if(u.origin!==location.origin&&/^https?:$/.test(u.protocol)){
        if(typeof window.__go_openInAppTab==='function')
          window.__go_openInAppTab(u.href).catch(function(){});
        return true;
      }
    }catch(e){}
    return false;
  }
  try{
    window.location.replace=function(href){if(!maybeIntercept(href))_origReplace(href);};
    window.location.assign=function(href){if(!maybeIntercept(href))_origAssign(href);};
  }catch(e){}

  /* ── Manifest auto-discovery ──────────────────────────────────────────── */
  /* After login, fetch /api/oblitools/manifest and propose any linked apps
     that are not yet in the apps list.  Non-admin users are supported because
     the endpoint only requires session auth (requireAuth, not requireAdmin).  */
  setTimeout(function(){
    fetch('/api/oblitools/manifest',{credentials:'include'})
      .then(function(r){if(!r.ok)throw r;return r.json();})
      .then(function(d){
        var linked=d&&d.data&&d.data.linkedApps;
        if(!Array.isArray(linked)||!linked.length)return;
        if(typeof window.__go_proposeLinkedApps==='function')
          window.__go_proposeLinkedApps(linked).catch(function(){});
      }).catch(function(){});
  },4000);
})();`

// tabBarJS is injected via v.Init() on every app WebView page load, AFTER overlayJS.
// It detects multi-tenant logins and injects a 40 px fixed tab bar at the
// top of the window with one tab per tenant (with per-tenant unread badges),
// a cross-tenant Alerts panel, and an auto-cycling settings dialog.
// Single-tenant installs are unaffected.
//
// Key behaviours:
//   - Hides the React TenantSwitcher dropdown (sets window.__ov_native_tabs)
//   - Adjusts #root CSS so the React app starts 40 px below the bar
//   - Alert panel fetches GET /api/live-alerts/all (cross-tenant, no requireTenant)
//   - Mark-read uses PATCH /api/live-alerts/:id/read
//   - switchTo() navigates to '/' so in-flight alerts are NOT marked read by the app
//   - Cross-tenant alert click in panel: stores navigateTo in __ov_pnav localStorage,
//     switches tenant -> '/' ; on next load the pending nav is consumed to deep-link
//   - Two independent cycling modes (both can be active at the same time):
//       autoCycle   : round-robin every autoCycleIntervalS seconds
//       followAlerts: switch when a new unread alert from another tenant appears
//     When both are on and followAlerts fires, it cancels the autoCycle timer;
//     the page reload caused by switchTo() restarts both timers from 0.
//   - Per-tenant unread badges next to each tenant name in the tab bar
//   - Alerts button: text-only "Alerts" label (no bell icon)
//   - Tenant name badge shown for every alert in the panel (not just cross-tenant)
const tabBarJS = `(function(){
  if(!/^https?:/.test(location.protocol))return;
  /* Shell page is always served from 127.0.0.1 — skip before DOM is parsed. */
  if(location.hostname==='127.0.0.1'||location.hostname==='localhost')return;
  if(document.documentElement&&document.documentElement.dataset.oblitoolsShell)return;
  if(window.__ov_tabs_injected)return;
  if(/^\/(login|enrollment|forgot-password|reset-password|reset)/.test(location.pathname))return;
  /* Inside an ObliTools iframe: skip entirely.  The shell handles app switching;
     tenant auto-cycle / pnav navigation inside an iframe would break state. */
  var _inFrame=false;try{_inFrame=window!==window.top;}catch(e){_inFrame=true;}
  if(_inFrame)return;

  /* Post-switch navigation -- consume before tab bar init */
  var _pnav=localStorage.getItem('__ov_pnav');
  if(_pnav&&/^\//.test(_pnav)){
    localStorage.removeItem('__ov_pnav');
    setTimeout(function(){window.location.href=_pnav;},30);
    return;
  }

  /* ── Bootstrap (async) ──────────────────────────────────────────────── */
  (async function(){
    var tenants=[],currentTenantId=null;
    try{
      var res=await Promise.all([
        fetch('/api/tenants',{credentials:'include'}),
        fetch('/api/auth/me',{credentials:'include'})
      ]);
      if(res[0].ok){var da=await res[0].json();tenants=da.data||[];}
      if(res[1].ok){var db=await res[1].json();currentTenantId=(db.data&&db.data.currentTenantId)||null;}
    }catch(e){
      console.warn('[obliview-tabs] bootstrap fetch error:',e);
      return;
    }
    if(tenants.length<=1)return;

    window.__ov_tabs_injected=true;
    window.__ov_native_tabs=true;

    var tabCfg={autoCycleEnabled:false,autoCycleIntervalS:30,followAlertsEnabled:false};
    try{tabCfg=await window.__go_getTabConfig();}catch(e){}
    if(!tabCfg||!tabCfg.autoCycleIntervalS){
      tabCfg={autoCycleEnabled:false,autoCycleIntervalS:30,followAlertsEnabled:false};
    }

    function __ov_domReady(fn){
      if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded',fn,{once:true});
      }else{fn();}
    }
    __ov_domReady(function(){
      try{
        injectBar(tenants,currentTenantId,tabCfg);
        startCyclers(tenants,currentTenantId,tabCfg);
      }catch(e){
        console.error('[obliview-tabs] injectBar error:',e);
      }
    });
  })();

  /* ── Helpers ──────────────────────────────────────────────────────── */
  function mk(tag,css){var e=document.createElement(tag);if(css)e.style.cssText=css;return e;}

  function timeAgo(iso){
    try{
      var ms=Date.now()-new Date(iso).getTime();
      if(ms<60000)return'Just now';
      if(ms<3600000)return Math.floor(ms/60000)+'m ago';
      if(ms<86400000)return Math.floor(ms/3600000)+'h ago';
      return Math.floor(ms/86400000)+'d ago';
    }catch(e){return'';}
  }

  /* switchTo: POST switch then navigate to / (dashboard).
     Going to / keeps alerts unread so follow-alerts can detect them later. */
  async function switchTo(tenantId){
    try{
      await fetch('/api/tenant/switch',{
        method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({tenantId:tenantId})
      });
    }catch(e){}
    window.location.href='/';
  }

  /* fetchTenantCounts: returns {tenantId: unreadCount} map */
  async function fetchTenantCounts(){
    try{
      var r=await fetch('/api/live-alerts/all',{credentials:'include'});
      var d=await r.json();
      var counts={};
      (d.alerts||[]).forEach(function(a){
        if(!a.read)counts[a.tenantId]=(counts[a.tenantId]||0)+1;
      });
      return counts;
    }catch(e){return{};}
  }

  /* updateBadges: refreshes the global Alerts badge + per-tenant tab badges */
  function updateBadges(counts,tenants){
    var total=0;
    var keys=Object.keys(counts);
    for(var i=0;i<keys.length;i++)total+=(counts[keys[i]]||0);
    var nb=document.getElementById('__ov_nb');
    if(nb){
      nb.style.display=total>0?'inline-flex':'none';
      nb.textContent=total>9?'9+':String(total);
    }
    tenants.forEach(function(t){
      var b=document.getElementById('__ov_tb_'+t.id);
      if(!b)return;
      var n=counts[t.id]||0;
      b.style.display=n>0?'inline-flex':'none';
      b.textContent=n>9?'9+':String(n);
    });
  }

  /* ── Tab bar injection ────────────────────────────────────────────── */
  function injectBar(tenants,currentTenantId,tabCfg){
    /* AH = app bar height (set by appBarJS; 0 for single-app users) */
    var AH=window.__ov_app_bar_height||0;
    var st=mk('style');
    st.textContent=
      '#root{margin-top:'+(40+AH)+'px!important;height:calc(100vh - '+(40+AH)+'px)!important;overflow:hidden!important}'
      +'#root>div{height:100%!important}'
      +'#__ov_bar *{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}';
    document.head.appendChild(st);

    var bar=mk('div',
      'position:fixed;top:'+AH+'px;left:0;right:0;z-index:2147483640;height:40px;'
      +'background:#0a0a13;border-bottom:1px solid rgba(255,255,255,.09);'
      +'display:flex;align-items:stretch;user-select:none');
    bar.id='__ov_bar';

    /* Eye logo */
    var logo=mk('div',
      'display:flex;align-items:center;padding:0 13px;'
      +'border-right:1px solid rgba(255,255,255,.07);flex-shrink:0');
    logo.innerHTML='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M20.188 10.934C21.212 11.604 21.212 12.396 20.188 13.066C18.768 14.009 16.026 16 12 16C7.974 16 5.232 14.009 3.812 13.066C2.788 12.396 2.788 11.604 3.812 10.934C5.232 9.991 7.974 8 12 8C16.026 8 18.768 9.991 20.188 10.934Z"/></svg>';
    bar.appendChild(logo);

    /* Tenant tabs -- each has a per-tenant unread badge */
    var tabsWrap=mk('div','display:flex;align-items:stretch;flex:1;overflow:hidden');
    tenants.forEach(function(t){
      var active=t.id===currentTenantId;
      var tab=mk('button',
        'padding:0 14px;border:none;border-bottom:2px solid '+(active?'#6366f1':'transparent')+';'
        +'background:none;color:'+(active?'#e0e0e0':'#56566a')+';'
        +'font-size:13px;font-weight:'+(active?'600':'400')+';'
        +'cursor:pointer;white-space:nowrap;flex-shrink:0;transition:color .15s,border-color .15s;'
        +'display:flex;align-items:center;gap:5px');
      tab.title=t.name+(t.role==='admin'?' (admin)':'');

      var nm=mk('span','');nm.textContent=t.name;
      var bdg=mk('span',
        'display:none;background:#ef4444;color:#fff;border-radius:8px;font-size:10px;'
        +'font-weight:700;padding:1px 4px;min-width:15px;text-align:center;'
        +'line-height:1.5;align-items:center;justify-content:center');
      bdg.id='__ov_tb_'+t.id;
      tab.appendChild(nm);tab.appendChild(bdg);

      if(!active){
        tab.onmouseenter=function(){tab.style.color='#aaa';};
        tab.onmouseleave=function(){tab.style.color='#56566a';};
      }
      tab.onclick=function(){if(!active)switchTo(t.id);};
      tabsWrap.appendChild(tab);
    });
    bar.appendChild(tabsWrap);

    /* Alerts button -- text-only label, no bell icon */
    var alertBtn=mk('button',
      'padding:0 14px;border:none;border-left:1px solid rgba(255,255,255,.07);'
      +'background:none;color:#56566a;font-size:13px;cursor:pointer;flex-shrink:0;'
      +'display:flex;align-items:center;gap:5px;transition:color .15s');
    alertBtn.title='All notifications';
    var alertTxt=mk('span','');alertTxt.textContent='Alerts';
    var globalBadge=mk('span',
      'display:none;background:#ef4444;color:#fff;border-radius:8px;font-size:10px;'
      +'font-weight:700;padding:1px 4px;min-width:15px;text-align:center;'
      +'line-height:1.5;align-items:center;justify-content:center');
    globalBadge.id='__ov_nb';
    alertBtn.appendChild(alertTxt);alertBtn.appendChild(globalBadge);
    alertBtn.onmouseenter=function(){alertBtn.style.color='#bbb';};
    alertBtn.onmouseleave=function(){alertBtn.style.color='#56566a';};
    alertBtn.onclick=function(){toggleAlertPanel(tenants,currentTenantId);};
    bar.appendChild(alertBtn);

    /* Auto-cycling settings button -- accent colour when EITHER mode is active */
    var cycleBtn=mk('button',
      'padding:0 12px;border:none;border-left:1px solid rgba(255,255,255,.07);'
      +'background:none;cursor:pointer;flex-shrink:0;'
      +'display:flex;align-items:center;justify-content:center;transition:color .15s');
    cycleBtn.id='__ov_cb';
    cycleBtn.title='Auto-cycling settings';
    cycleBtn.innerHTML=
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
      +'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>'
      +'<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    /* Hover uses tabCfg which is mutated by the dialog Save, keeping state fresh */
    cycleBtn.onmouseenter=function(){
      if(!(tabCfg.autoCycleEnabled||tabCfg.followAlertsEnabled))cycleBtn.style.color='#aaa';
    };
    cycleBtn.onmouseleave=function(){
      cycleBtn.style.color=(tabCfg.autoCycleEnabled||tabCfg.followAlertsEnabled)?'#6366f1':'#56566a';
    };
    cycleBtn.style.color=(tabCfg.autoCycleEnabled||tabCfg.followAlertsEnabled)?'#6366f1':'#56566a';
    cycleBtn.onclick=function(){openCycleDlg(tabCfg,tenants,currentTenantId);};
    bar.appendChild(cycleBtn);

    document.body.insertBefore(bar,document.body.firstChild);

    /* Initial badge fetch + refresh every 20 s */
    fetchTenantCounts().then(function(c){updateBadges(c,tenants);});
    setInterval(function(){fetchTenantCounts().then(function(c){updateBadges(c,tenants);});},20000);
  }

  /* ── Alert panel ─────────────────────────────────────────────────── */
  async function toggleAlertPanel(tenants,currentTenantId){
    var ex=document.getElementById('__ov_ap');
    if(ex){ex.remove();return;}

    var panel=mk('div',
      'position:fixed;top:'+(40+(window.__ov_app_bar_height||0))+'px;right:0;z-index:2147483639;width:370px;'
      +'height:calc(100vh - 40px);background:#0e0e18;'
      +'border-left:1px solid rgba(255,255,255,.09);'
      +'display:flex;flex-direction:column;'
      +'box-shadow:-12px 0 50px rgba(0,0,0,.7);'
      +'font-family:system-ui,-apple-system,sans-serif');
    panel.id='__ov_ap';

    var hdr=mk('div',
      'padding:12px 15px;border-bottom:1px solid rgba(255,255,255,.07);'
      +'display:flex;align-items:center;justify-content:space-between;flex-shrink:0');
    var htitle=mk('span','font-size:13px;font-weight:600;color:#d0d0d8');
    htitle.textContent='All notifications';
    var xbtn=mk('button',
      'background:none;border:none;color:#555;cursor:pointer;font-size:20px;'
      +'line-height:1;padding:0;width:24px;height:24px;display:flex;'
      +'align-items:center;justify-content:center;border-radius:4px;transition:color .15s');
    xbtn.innerHTML='&times;';
    xbtn.onmouseenter=function(){xbtn.style.color='#aaa';};
    xbtn.onmouseleave=function(){xbtn.style.color='#555';};
    xbtn.onclick=function(){panel.remove();};
    hdr.appendChild(htitle);hdr.appendChild(xbtn);
    panel.appendChild(hdr);

    var loading=mk('div','padding:48px 16px;text-align:center;color:#444;font-size:13px');
    loading.textContent='Loading\u2026';
    panel.appendChild(loading);
    document.body.appendChild(panel);

    try{
      var r=await fetch('/api/live-alerts/all',{credentials:'include'});
      var d=await r.json();
      var alerts=(d.alerts||[]).slice(0,80);
      var tmap={};
      (d.tenants||tenants).forEach(function(t){tmap[t.id]=t.name;});
      loading.remove();

      if(!alerts.length){
        var em=mk('div','padding:56px 16px;text-align:center;color:#444;font-size:13px');
        em.textContent='No notifications yet';
        panel.appendChild(em);
      }else{
        var list=mk('div','overflow-y:auto;flex:1');
        alerts.forEach(function(al){
          var unread=!al.read;
          var sc={down:'#ef4444',up:'#22c55e',warning:'#f59e0b',info:'#818cf8'}[al.severity]||'#6366f1';
          var row=mk('div',
            'padding:10px 15px;border-bottom:1px solid rgba(255,255,255,.05);'
            +'cursor:pointer;display:flex;align-items:flex-start;gap:9px;'
            +'transition:background .1s;'+(unread?'background:rgba(99,102,241,.05);':''));
          row.onmouseenter=function(){row.style.background='rgba(255,255,255,.04)';};
          row.onmouseleave=function(){row.style.background=unread?'rgba(99,102,241,.05)':'transparent';};

          var dot=mk('div','width:7px;height:7px;border-radius:50%;background:'+sc+';flex-shrink:0;margin-top:5px');
          row.appendChild(dot);

          var body=mk('div','flex:1;min-width:0');
          var top=mk('div','display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:2px');
          var ttl=mk('span',
            'font-size:13px;font-weight:'+(unread?'600':'400')+';color:#c8c8d4;'
            +'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0');
          ttl.textContent=al.title;
          top.appendChild(ttl);

          /* Tenant badge -- always shown for every alert */
          var tb=mk('span',
            'font-size:10px;font-weight:500;background:rgba(99,102,241,.15);'
            +'color:#818cf8;border-radius:4px;padding:1px 5px;flex-shrink:0;white-space:nowrap');
          tb.textContent=tmap[al.tenantId]||('T#'+al.tenantId);
          top.appendChild(tb);

          body.appendChild(top);

          var msg=mk('div',
            'font-size:11px;color:#52525e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:3px');
          msg.textContent=al.message;
          body.appendChild(msg);

          var ts=mk('div','font-size:10px;color:#38383f');
          ts.textContent=timeAgo(al.createdAt);
          body.appendChild(ts);

          row.appendChild(body);
          row.onclick=async function(){
            try{await fetch('/api/live-alerts/'+al.id+'/read',{method:'PATCH',credentials:'include'});}catch(e){}
            unread=false;row.style.background='transparent';
            fetchTenantCounts().then(function(c){updateBadges(c,tenants);});
            if(al.tenantId!==currentTenantId){
              if(al.navigateTo)localStorage.setItem('__ov_pnav',al.navigateTo);
              await switchTo(al.tenantId);
            }else if(al.navigateTo){
              panel.remove();
              window.location.href=al.navigateTo;
            }
          };
          list.appendChild(row);
        });
        panel.appendChild(list);

        var ft=mk('div','padding:10px 15px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0');
        var mar=mk('button',
          'width:100%;padding:7px;border-radius:7px;border:1px solid rgba(255,255,255,.1);'
          +'background:none;color:#666;font-size:12px;cursor:pointer;transition:all .12s');
        mar.textContent='Mark all as read';
        mar.onmouseenter=function(){mar.style.background='rgba(255,255,255,.05)';mar.style.color='#aaa';};
        mar.onmouseleave=function(){mar.style.background='none';mar.style.color='#666';};
        mar.onclick=async function(){
          var unreadList=alerts.filter(function(a){return!a.read;});
          try{
            await Promise.all(unreadList.map(function(a){
              return fetch('/api/live-alerts/'+a.id+'/read',{method:'PATCH',credentials:'include'});
            }));
          }catch(e){}
          fetchTenantCounts().then(function(c){updateBadges(c,tenants);});
          panel.remove();
        };
        ft.appendChild(mar);panel.appendChild(ft);
      }
    }catch(e){
      loading.textContent='Failed to load notifications';
    }
    fetchTenantCounts().then(function(c){updateBadges(c,tenants);});
  }

  /* ── Auto-cycling settings dialog ───────────────────────────────────── */
  /* Two fully independent toggles:
       1. Changement automatique  -- round-robin every N seconds
       2. Suivre les nouvelles alertes -- switch on new unread from another tenant
     Both can be active simultaneously. */
  function openCycleDlg(tabCfg,tenants,currentTenantId){
    var ex=document.getElementById('__ov_cd');
    if(ex){ex.remove();return;}

    var ov=mk('div',
      'position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;'
      +'justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(10px);'
      +'font-family:system-ui,-apple-system,sans-serif');
    ov.id='__ov_cd';

    var bx=mk('div',
      'background:#13131f;border:1px solid rgba(255,255,255,.12);border-radius:14px;'
      +'padding:28px 30px;width:400px;color:#e0e0e0');

    var bxtitle=mk('h3','margin:0 0 5px;font-size:15px;font-weight:700;color:#fff');
    bxtitle.textContent='Basculement automatique';
    var bxdesc=mk('p','margin:0 0 22px;font-size:12px;color:#555;line-height:1.6');
    bxdesc.textContent='Les deux modes peuvent etre actifs simultanement. Parametres sauvegardes par appareil.';
    bx.appendChild(bxtitle);bx.appendChild(bxdesc);

    /* Helper: build a toggle row. Returns {row, get()} */
    function mkToggleRow(title,desc,initial){
      var en=initial;
      var row=mk('div',
        'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;'
        +'padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid rgba(255,255,255,.07)');
      var lbl=mk('div','flex:1;min-width:0');
      var lt=mk('div','font-size:13px;font-weight:500;color:#d0d0d0');lt.textContent=title;
      var ld=mk('div','font-size:11px;color:#555;margin-top:3px;line-height:1.5');ld.textContent=desc;
      lbl.appendChild(lt);lbl.appendChild(ld);row.appendChild(lbl);
      var tog=mk('button',
        'position:relative;width:42px;height:24px;border-radius:12px;border:none;'
        +'cursor:pointer;transition:background .2s;flex-shrink:0;margin-top:2px;background:'+(en?'#6366f1':'#2a2a3a'));
      var kn=mk('div',
        'position:absolute;top:4px;width:16px;height:16px;border-radius:8px;'
        +'background:#fff;transition:left .2s;left:'+(en?'22px':'4px'));
      tog.appendChild(kn);
      tog.onclick=function(){
        en=!en;
        tog.style.background=en?'#6366f1':'#2a2a3a';
        kn.style.left=en?'22px':'4px';
      };
      row.appendChild(tog);
      return{row:row,get:function(){return en;}};
    }

    /* Toggle 1: Changement automatique */
    var t1=mkToggleRow(
      'Changement automatique',
      'Bascule vers le workspace suivant en round-robin toutes les N secondes.',
      tabCfg.autoCycleEnabled
    );
    bx.appendChild(t1.row);

    /* Interval selector (for auto-cycle) */
    var ir=mk('div','margin-bottom:20px');
    var irlbl=mk('label',
      'display:block;font-size:11px;font-weight:600;letter-spacing:.5px;'
      +'color:#666;text-transform:uppercase;margin-bottom:8px');
    irlbl.textContent='Intervalle';
    ir.appendChild(irlbl);
    var sel=mk('select',
      'width:100%;padding:9px 11px;background:#1c1c2a;border:1px solid rgba(255,255,255,.1);'
      +'border-radius:8px;color:#d0d0d0;font-size:13px;outline:none;cursor:pointer;'
      +'appearance:none;-webkit-appearance:none');
    [[15,'15 secondes'],[30,'30 secondes'],[60,'1 minute'],[120,'2 minutes'],[300,'5 minutes'],[600,'10 minutes']].forEach(function(o){
      var op=document.createElement('option');
      op.value=o[0];op.textContent=o[1];
      op.selected=(tabCfg.autoCycleIntervalS===o[0]);
      sel.appendChild(op);
    });
    ir.appendChild(sel);bx.appendChild(ir);

    /* Toggle 2: Suivre les nouvelles alertes */
    var t2=mkToggleRow(
      'Suivre les nouvelles alertes',
      'Bascule immediatement vers le workspace qui recoit une nouvelle alerte non lue.',
      tabCfg.followAlertsEnabled
    );
    /* Remove divider from last row */
    t2.row.style.borderBottom='none';
    t2.row.style.paddingBottom='0';
    t2.row.style.marginBottom='26px';
    bx.appendChild(t2.row);

    /* Buttons */
    var bs=mk('div','display:flex;gap:8px;justify-content:flex-end');
    var cb2=mk('button',
      'padding:8px 18px;border-radius:8px;border:1px solid rgba(255,255,255,.12);'
      +'background:none;color:#888;cursor:pointer;font-size:13px;transition:all .12s');
    cb2.textContent='Annuler';
    cb2.onmouseenter=function(){cb2.style.color='#ccc';cb2.style.borderColor='rgba(255,255,255,.2)';};
    cb2.onmouseleave=function(){cb2.style.color='#888';cb2.style.borderColor='rgba(255,255,255,.12)';};
    cb2.onclick=function(){ov.remove();};
    var sb=mk('button',
      'padding:8px 18px;border-radius:8px;border:none;background:#6366f1;'
      +'color:#fff;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .15s');
    sb.textContent='Enregistrer';
    sb.onmouseenter=function(){sb.style.opacity='.85';};
    sb.onmouseleave=function(){sb.style.opacity='1';};
    sb.onclick=async function(){
      var autoCycleEnabled=t1.get();
      var autoCycleIntervalS=parseInt(sel.value)||30;
      var followAlertsEnabled=t2.get();
      try{await window.__go_saveTabConfig(autoCycleEnabled,autoCycleIntervalS,followAlertsEnabled);}catch(e){}
      /* Update shared tabCfg (read by hover handlers) */
      tabCfg.autoCycleEnabled=autoCycleEnabled;
      tabCfg.autoCycleIntervalS=autoCycleIntervalS;
      tabCfg.followAlertsEnabled=followAlertsEnabled;
      ov.remove();
      /* Refresh cycling-button colour */
      var btn=document.getElementById('__ov_cb');
      if(btn)btn.style.color=(autoCycleEnabled||followAlertsEnabled)?'#6366f1':'#56566a';
      /* Restart cyclers with new config */
      startCyclers(tenants,currentTenantId,tabCfg);
    };
    bs.appendChild(cb2);bs.appendChild(sb);bx.appendChild(bs);

    ov.appendChild(bx);
    ov.onclick=function(e){if(e.target===ov)ov.remove();};
    document.body.appendChild(ov);
  }

  /* ── Auto-cycling -- two independent timers ──────────────────────── */
  window.__ov_act=null; /* auto-cycle setTimeout handle */
  window.__ov_fat=null; /* follow-alerts setTimeout handle */

  function startCyclers(tenants,currentTenantId,tabCfg){
    clearTimeout(window.__ov_act);
    clearTimeout(window.__ov_fat);
    window.__ov_act=null;
    window.__ov_fat=null;

    /* Mode 1: Round-robin auto-cycle */
    if(tabCfg.autoCycleEnabled){
      var ms=(tabCfg.autoCycleIntervalS||30)*1000;
      window.__ov_act=setTimeout(function(){
        var idx=tenants.findIndex(function(t){return t.id===currentTenantId;});
        var next=tenants[(idx+1)%tenants.length];
        switchTo(next.id); /* navigates to / -- page reload restarts both timers */
      },ms);
    }

    /* Mode 2: Follow new unread alerts from other tenants.
       Algorithm:
         5 s after page load  -> take a baseline snapshot of current unread IDs.
         Every 15 s after that -> fetch again; if any new unread ID from another
         tenant is found, cancel auto-cycle and switchTo() that tenant immediately.
         Already-seen IDs are added to the baseline so they never re-trigger. */
    if(tabCfg.followAlertsEnabled){
      var seenIds=null; /* null = baseline not yet taken */

      function poll(){
        fetch('/api/live-alerts/all',{credentials:'include'}).then(function(r){
          return r.json();
        }).then(function(d){
          var unread=(d.alerts||[]).filter(function(a){return!a.read;});
          if(seenIds===null){
            /* First invocation: take baseline, schedule next poll */
            seenIds=new Set(unread.map(function(a){return a.id;}));
            window.__ov_fat=setTimeout(poll,15000);
            return;
          }
          /* Look for new unread alerts from a different tenant */
          var newOther=unread.filter(function(a){
            return a.tenantId!==currentTenantId&&!seenIds.has(a.id);
          });
          if(newOther.length>0){
            clearTimeout(window.__ov_act); /* cancel round-robin if running */
            switchTo(newOther[0].tenantId); /* navigates to / -- timers restart on reload */
            return;
          }
          /* Extend baseline with all currently-seen IDs */
          unread.forEach(function(a){seenIds.add(a.id);});
          window.__ov_fat=setTimeout(poll,15000);
        }).catch(function(){
          window.__ov_fat=setTimeout(poll,15000);
        });
      }

      /* Take baseline 5 s after page load to avoid false-positives
         from alerts that were already unread before the switch */
      window.__ov_fat=setTimeout(poll,5000);
    }
  }
})();`

// setupHTML is shown on first launch when no URL has been saved yet.
// It is loaded via w.SetHtml(), so window.location.protocol will NOT be http/https.
// The overlayJS guard (!/^https?:/.test(location.protocol)) skips injection here.
const setupHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Obliview</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f17;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a2e;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:40px 44px;width:420px;box-shadow:0 24px 80px rgba(0,0,0,.6)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:28px}
.ico{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:22px}
.name{font-size:22px;font-weight:700;color:#fff;letter-spacing:-.3px}
h2{font-size:17px;font-weight:600;color:#fff;margin-bottom:8px}
p{font-size:13px;color:#888;margin-bottom:24px;line-height:1.6}
label{display:block;font-size:11px;font-weight:600;color:#999;margin-bottom:7px;letter-spacing:.6px;text-transform:uppercase}
input{width:100%;padding:10px 14px;background:#252538;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e0e0e0;font-size:14px;outline:none;transition:border-color .15s;margin-bottom:18px}
input:focus{border-color:#6366f1}
input::placeholder{color:#555}
button{width:100%;padding:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s;letter-spacing:.1px}
button:hover{opacity:.88}
.err{font-size:12px;color:#f87171;margin-top:12px;min-height:16px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="ico">&#x1F441;</div>
    <div class="name">Obli.tools</div>
  </div>
  <h2>Welcome</h2>
  <p>Enter the URL of your app instance to connect. You can change it at any time using the &#x2699; icon.</p>
  <label>Server URL</label>
  <input id="u" type="url" placeholder="https://my-app.example.com" autocomplete="off">
  <button onclick="go()">Connect &#x2192;</button>
  <div class="err" id="e"></div>
</div>
<script>
document.getElementById('u').focus();
document.getElementById('u').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
function go(){
  var u=document.getElementById('u').value.trim();
  if(!u){err('Please enter a URL');return;}
  if(!/^https?:\/\//i.test(u))u='https://'+u;
  try{new URL(u);}catch(e){err('Please enter a valid URL');return;}
  /* Go handler calls w.SetHtml(shell) via Dispatch — no JS-side navigation needed. */
  var btn=document.querySelector('button');
  if(btn){btn.textContent='Connecting\u2026';btn.disabled=true;}
  window.__go_saveURL(u).catch(function(){
    err('Failed to connect');
    if(btn){btn.textContent='Connect \u2192';btn.disabled=false;}
  });
}
function err(m){
  var e=document.getElementById('e');
  e.textContent=m;
  setTimeout(function(){e.textContent='';},3000);
}
</script>
</body>
</html>`

// ── URL / app utilities ───────────────────────────────────────────────────────

// appNameFromURL guesses a friendly app name from the URL.
func appNameFromURL(rawURL string) string {
	lower := strings.ToLower(rawURL)
	switch {
	case strings.Contains(lower, "obliance"):
		return "Obliance"
	case strings.Contains(lower, "oblimap"):
		return "Oblimap"
	case strings.Contains(lower, "obliguard"):
		return "Obliguard"
	case strings.Contains(lower, "obliview"):
		return "Obliview"
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return "App"
	}
	h := u.Hostname()
	if idx := strings.Index(h, "."); idx > 0 {
		h = h[:idx]
	}
	if h != "" {
		return strings.ToUpper(h[:1]) + h[1:]
	}
	return "App"
}

// appColorFromURL returns the brand colour for a known Obli* app.
func appColorFromURL(rawURL string) string {
	lower := strings.ToLower(rawURL)
	switch {
	case strings.Contains(lower, "obliance"):
		return "#a78bfa"
	case strings.Contains(lower, "oblimap"):
		return "#10b981"
	case strings.Contains(lower, "obliguard"):
		return "#fb923c"
	default:
		return "#6366f1"
	}
}

// originOf returns "scheme://host" for rawURL, or "" on parse error.
func originOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// sameOrigin reports whether a and b share the same URL origin.
func sameOrigin(a, b string) bool {
	oa := originOf(a)
	return oa != "" && oa == originOf(b)
}

// ── Shell navigation ──────────────────────────────────────────────────────────

// navigateShell stores html in the localhost server and triggers a fresh
// navigation of the shell WebView.  Must be called from the shell UI thread
// (i.e. directly in main() or via shellView.Dispatch).
func navigateShell(html string) {
	shellMu.Lock()
	shellHTMLStore = html
	shellNavSeq++
	seq := shellNavSeq
	shellMu.Unlock()

	if shellServeURL != "" {
		shellView.Navigate(fmt.Sprintf("%s?v=%d", shellServeURL, seq))
	} else {
		shellView.SetHtml(html)
	}
}

// generateTabBarHTML returns the shell tab-bar HTML with apps and active index
// embedded as JSON so the inline script can build tabs without extra round-trips.
func generateTabBarHTML(cfg Config, activeIdx int) string {
	appsJSON, _ := json.Marshal(cfg.Apps)
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en" data-oblitools-shell="1">
<head><meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%%;height:100%%;overflow:hidden;background:#060610;font-family:system-ui,-apple-system,sans-serif}
#ot-bar{
  position:fixed;top:0;left:0;right:0;height:40px;z-index:9999;
  background:#060610;border-bottom:1px solid rgba(255,255,255,.07);
  display:flex;align-items:stretch;user-select:none;-webkit-user-select:none}
#ot-tabs{display:flex;align-items:stretch;flex:1;overflow:hidden}
.ot-tab{
  padding:0 14px;border:none;background:none;cursor:pointer;
  font-size:12px;white-space:nowrap;flex-shrink:0;
  display:flex;align-items:center;gap:6px;
  transition:color .15s,border-color .15s;border-bottom:2px solid transparent}
.ot-tab.active{color:#e0e0e0;cursor:default}
.ot-tab:not(.active){color:#4a4a5a}
.ot-tab:not(.active):hover{color:#9090a4}
.ot-dot{width:6px;height:6px;border-radius:50%%;flex-shrink:0}
.ot-tab.active .ot-dot{opacity:1}
.ot-tab:not(.active) .ot-dot{opacity:.35}
.ot-tab:not(.active):hover .ot-dot{opacity:1}
.ot-tab.active .ot-name{font-weight:600}
.ot-bdg{
  display:none;background:#ef4444;color:#fff;
  border-radius:8px;font-size:10px;font-weight:700;
  padding:1px 4px;min-width:15px;text-align:center;line-height:1.5;
  align-items:center;justify-content:center}
.ot-bdg.on{display:inline-flex}
#ot-manage{
  flex-shrink:0;width:36px;height:40px;border:none;background:none;cursor:pointer;
  color:#4a4a5a;font-size:16px;display:flex;align-items:center;justify-content:center;
  transition:color .15s;border-left:1px solid rgba(255,255,255,.05)}
#ot-manage:hover{color:#9090a4}
#ot-overlay{
  display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);
  align-items:flex-start;justify-content:flex-end}
#ot-overlay.open{display:flex}
#ot-panel{
  margin:44px 8px 0 0;background:#13141a;border:1px solid rgba(255,255,255,.1);
  border-radius:12px;padding:16px;width:300px;
  font-family:system-ui,-apple-system,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.6)}
#ot-panel h3{font-size:13px;font-weight:600;color:#ccc;margin:0 0 12px;
  letter-spacing:.04em;text-transform:uppercase}
.ot-row{display:flex;align-items:center;gap:8px;padding:6px 0;
  border-bottom:1px solid rgba(255,255,255,.05)}
.ot-row:last-child{border-bottom:none}
.ot-rdot{width:8px;height:8px;border-radius:50%%;flex-shrink:0}
.ot-rinfo{flex:1;min-width:0}
.ot-rname{font-size:13px;color:#ccc}
.ot-rurl{font-size:10px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ot-del{background:none;border:none;color:#444;cursor:pointer;font-size:14px;
  padding:2px 4px;border-radius:4px;transition:color .15s}
.ot-del:hover{color:#f87171}
#ot-add-row{display:flex;gap:6px;margin-top:12px}
#ot-add-input{flex:1;background:#1e1e28;border:1px solid rgba(255,255,255,.1);
  border-radius:6px;color:#ccc;font-size:12px;padding:6px 10px;outline:none}
#ot-add-input:focus{border-color:#6366f1}
#ot-add-btn{background:#6366f1;border:none;border-radius:6px;color:#fff;
  font-size:12px;padding:6px 12px;cursor:pointer;white-space:nowrap;transition:opacity .15s}
#ot-add-btn:hover{opacity:.85}
</style>
</head><body>
<div id="ot-bar">
  <div id="ot-tabs"></div>
  <button id="ot-manage" title="Manage apps">&#x2699;</button>
</div>
<div id="ot-overlay">
  <div id="ot-panel">
    <h3>Apps</h3>
    <div id="ot-app-list"></div>
    <div id="ot-add-row">
      <input id="ot-add-input" type="url" placeholder="https://my-app.example.com">
      <button id="ot-add-btn">Add</button>
    </div>
  </div>
</div>
<script>
(function(){
  var APPS=%s;
  var activeIdx=%d;
  var tabs=document.getElementById('ot-tabs');

  function buildTabs(){
    tabs.innerHTML='';
    APPS.forEach(function(app,i){
      var col=app.color||'#6366f1';
      var btn=document.createElement('button');
      btn.className='ot-tab'+(i===activeIdx?' active':'');
      btn.style.borderBottomColor=i===activeIdx?col:'transparent';

      var dot=document.createElement('span');
      dot.className='ot-dot';dot.style.background=col;

      var nm=document.createElement('span');
      nm.className='ot-name';nm.textContent=app.name;

      var bdg=document.createElement('span');
      bdg.className='ot-bdg';bdg.dataset.url=app.url;

      btn.appendChild(dot);btn.appendChild(nm);btn.appendChild(bdg);
      btn.addEventListener('click',(function(idx){
        return function(){if(idx!==activeIdx)switchTo(idx);};
      })(i));
      tabs.appendChild(btn);
    });
  }

  function setActiveTab(idx){
    activeIdx=idx;
    document.querySelectorAll('.ot-tab').forEach(function(b,j){
      var col=APPS[j]?APPS[j].color||'#6366f1':'#6366f1';
      b.classList.toggle('active',j===idx);
      b.style.borderBottomColor=j===idx?col:'transparent';
    });
  }

  function switchTo(idx){
    setActiveTab(idx);
    if(typeof window.__go_switchTab==='function')
      window.__go_switchTab(idx).catch(function(){});
  }

  /* Called from Go via Eval when active tab changes (e.g. cross-app nav). */
  window.__ot_setActiveTab=function(idx){setActiveTab(idx);};

  /* Called from Go via Eval after apps list changes (add/remove/propose). */
  window.__ot_rebuildTabs=function(apps,idx){APPS=apps;activeIdx=idx;buildTabs();};

  /* Badge update */
  function updateBadges(counts){
    document.querySelectorAll('.ot-bdg').forEach(function(b){
      var n=counts[b.dataset.url]||0;
      b.textContent=n>9?'9+':String(n);
      b.classList.toggle('on',n>0);
    });
  }
  setInterval(function(){
    if(typeof window.__go_getAlertCounts==='function')
      window.__go_getAlertCounts().then(updateBadges).catch(function(){});
  },15000);
  setTimeout(function(){
    if(typeof window.__go_getAlertCounts==='function')
      window.__go_getAlertCounts().then(updateBadges).catch(function(){});
  },3000);

  /* Window resize → persist size */
  var _rs=null;
  window.addEventListener('resize',function(){
    clearTimeout(_rs);
    _rs=setTimeout(function(){
      if(typeof window.__go_saveSize==='function')
        window.__go_saveSize(window.innerWidth,window.innerHeight).catch(function(){});
    },600);
  });

  /* Manage overlay */
  var overlay=document.getElementById('ot-overlay');
  document.getElementById('ot-manage').addEventListener('click',function(e){
    e.stopPropagation();
    refreshList();
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click',function(e){
    if(e.target===overlay)overlay.classList.remove('open');
  });

  function refreshList(){
    var list=document.getElementById('ot-app-list');
    list.innerHTML='';
    APPS.forEach(function(app,i){
      var row=document.createElement('div');row.className='ot-row';
      var dot=document.createElement('span');dot.className='ot-rdot';
      dot.style.background=app.color||'#6366f1';
      var info=document.createElement('div');info.className='ot-rinfo';
      var nm=document.createElement('div');nm.className='ot-rname';nm.textContent=app.name;
      var ul=document.createElement('div');ul.className='ot-rurl';ul.textContent=app.url;
      info.appendChild(nm);info.appendChild(ul);
      var del=document.createElement('button');del.className='ot-del';del.textContent='\u2715';
      del.title='Remove';
      del.addEventListener('click',(function(idx){
        return function(){
          APPS.splice(idx,1);
          if(typeof window.__go_saveApps==='function')
            window.__go_saveApps(APPS.slice()).catch(function(){});
          refreshList();
        };
      })(i));
      row.appendChild(dot);row.appendChild(info);row.appendChild(del);
      list.appendChild(row);
    });
  }

  document.getElementById('ot-add-btn').addEventListener('click',function(){
    var u=document.getElementById('ot-add-input').value.trim();
    if(!u)return;
    if(!/^https?:\/\//i.test(u))u='https://'+u;
    try{new URL(u);}catch(e){return;}
    var lower=u.toLowerCase();
    var name=u.replace(/^https?:\/\//,'').replace(/\/.*/,'');
    var color='#6366f1';
    if(lower.indexOf('obliance')>=0)color='#a78bfa';
    else if(lower.indexOf('oblimap')>=0)color='#10b981';
    else if(lower.indexOf('obliguard')>=0)color='#fb923c';
    APPS.push({name:name,url:u,color:color,lastUrl:''});
    if(typeof window.__go_saveApps==='function')
      window.__go_saveApps(APPS.slice()).catch(function(){});
    document.getElementById('ot-add-input').value='';
    refreshList();
  });
  document.getElementById('ot-add-input').addEventListener('keydown',function(e){
    if(e.key==='Enter')document.getElementById('ot-add-btn').click();
  });

  buildTabs();
})();
</script>
</body></html>`, string(appsJSON), activeIdx)
}

// ── Localhost shell HTTP server ───────────────────────────────────────────────

func startLocalServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		shellMu.Lock()
		content := shellHTMLStore
		shellMu.Unlock()
		rw.Header().Set("Content-Type", "text/html; charset=utf-8")
		rw.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(rw, content)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("[oblitools] failed to start local server:", err)
		return
	}
	shellServeURL = fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)
	go func() { _ = http.Serve(ln, mux) }()
}

// ── Shell WebView bindings ────────────────────────────────────────────────────

func setupShellBindings(w webview.WebView, cfg *Config) {
	// __go_saveURL: called from the setup page when user enters a server URL.
	// Seeds the first app entry and transitions the shell to the tab-bar view.
	if err := w.Bind("__go_saveURL", func(rawURL string) {
		rawURL = strings.TrimRight(rawURL, "/")
		cfg.URL = rawURL
		found := false
		for _, a := range cfg.Apps {
			if sameOrigin(a.URL, rawURL) {
				found = true
				break
			}
		}
		if !found {
			entry := AppEntry{
				Name:  appNameFromURL(rawURL),
				URL:   rawURL,
				Color: appColorFromURL(rawURL),
			}
			cfg.Apps = append([]AppEntry{entry}, cfg.Apps...)
		}
		if err := saveConfig(cfg); err != nil {
			fmt.Println("[oblitools] error saving config:", err)
		}
		reconcileAppViews(cfg.Apps, cfg)
		w.Dispatch(func() {
			navigateShell(generateTabBarHTML(*cfg, int(activeAppIdx.Load())))
		})
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_saveURL:", err)
	}

	// __go_switchTab: called from the shell tab-bar JS when the user clicks a tab.
	// Shows the target app window and hides all others.
	if err := w.Bind("__go_switchTab", func(idxFloat float64) {
		idx := int(idxFloat)

		appViewsMu.Lock()
		views := make([]*AppView, len(allAppViews))
		copy(views, allAppViews)
		appViewsMu.Unlock()

		if idx < 0 || idx >= len(views) {
			return
		}
		activeAppIdx.Store(int32(idx))
		if idx < len(cfg.Apps) {
			cfg.URL = cfg.Apps[idx].URL
		}
		for i, av := range views {
			h := av.getHWND()
			if h == 0 {
				continue
			}
			if i == idx {
				positionAppWindow(h, shellHWND, 0, 0, true)
			} else {
				hideAppWindow(h)
			}
		}
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_switchTab:", err)
	}

	// __go_saveApps: called from the shell manage dialog when apps are added/removed.
	if err := w.Bind("__go_saveApps", func(apps []AppEntry) {
		cfg.Apps = apps
		if len(apps) > 0 {
			cfg.URL = apps[0].URL
		} else {
			cfg.URL = ""
		}
		if err := saveConfig(cfg); err != nil {
			fmt.Println("[oblitools] error saving apps:", err)
		}
		reconcileAppViews(apps, cfg)
		w.Dispatch(func() {
			if len(cfg.Apps) == 0 {
				w.SetHtml(setupHTML)
			} else {
				navigateShell(generateTabBarHTML(*cfg, int(activeAppIdx.Load())))
			}
		})
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_saveApps:", err)
	}

	// __go_getAlertCounts: returns badge-cache snapshot for the tab-bar JS.
	if err := w.Bind("__go_getAlertCounts", func() map[string]int {
		alertCacheMu.Lock()
		defer alertCacheMu.Unlock()
		cp := make(map[string]int, len(alertCache))
		for k, v := range alertCache {
			cp[k] = v
		}
		return cp
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_getAlertCounts:", err)
	}

	// __go_saveSize: debounced resize listener in the shell HTML calls this.
	if err := w.Bind("__go_saveSize", func(width, height float64) {
		if width >= 400 && height >= 100 {
			cfg.Width = int(width)
			cfg.Height = int(height)
		}
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_saveSize:", err)
	}
}

// ── App WebView bindings ──────────────────────────────────────────────────────

func setupAppBindings(v webview.WebView, av *AppView, cfg *Config) {
	// __go_saveAppLastURL: track last-visited page path per app (from overlayJS).
	if err := v.Bind("__go_saveAppLastURL", func(appOrigin, path string) {
		for i := range cfg.Apps {
			if sameOrigin(cfg.Apps[i].URL, appOrigin) {
				cfg.Apps[i].LastURL = path
				if err := saveConfig(cfg); err != nil {
					fmt.Println("[oblitools] error saving last url:", err)
				}
				break
			}
		}
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_saveAppLastURL:", err)
	}

	// __go_reportAlertCount: update badge cache for this app (from overlayJS).
	if err := v.Bind("__go_reportAlertCount", func(appOrigin string, count float64) {
		alertCacheMu.Lock()
		alertCache[appOrigin] = int(count)
		alertCacheMu.Unlock()
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_reportAlertCount:", err)
	}

	// __go_openInAppTab: cross-app deep-link navigation (from overlayJS intercept).
	// Instead of navigating the current WebView away, the target app WebView is
	// navigated to the specific URL and its tab is made active.
	if err := v.Bind("__go_openInAppTab", func(rawURL string) {
		u, err := url.Parse(rawURL)
		if err != nil {
			return
		}

		appViewsMu.Lock()
		var targetAV *AppView
		targetIdx := -1
		for i, x := range allAppViews {
			if sameOrigin(x.Entry.URL, u.Scheme+"://"+u.Host) {
				targetAV = x
				targetIdx = i
				break
			}
		}
		appViewsMu.Unlock()

		if targetAV == nil || targetIdx < 0 {
			return
		}

		// Navigate target app to the full URL.
		if tv := targetAV.getView(); tv != nil {
			navURL := rawURL
			tv.Dispatch(func() { tv.Navigate(navURL) })
		}

		// Switch active tab.
		activeAppIdx.Store(int32(targetIdx))
		if targetIdx < len(cfg.Apps) {
			cfg.URL = cfg.Apps[targetIdx].URL
		}

		// Update shell tab-bar highlight.
		shellView.Dispatch(func() {
			shellView.Eval(fmt.Sprintf(
				"if(typeof window.__ot_setActiveTab==='function')window.__ot_setActiveTab(%d);",
				targetIdx,
			))
		})

		// Show/hide app windows immediately.
		appViewsMu.Lock()
		for i, x := range allAppViews {
			h := x.getHWND()
			if h == 0 {
				continue
			}
			if i == targetIdx {
				positionAppWindow(h, shellHWND, 0, 0, true)
			} else {
				hideAppWindow(h)
			}
		}
		appViewsMu.Unlock()
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_openInAppTab:", err)
	}

	// __go_proposeLinkedApps: manifest auto-discovery from overlayJS.
	// Merges proposed apps into cfg.Apps without replacing existing entries.
	if err := v.Bind("__go_proposeLinkedApps", func(proposed []AppEntry) {
		appViewsMu.Lock()
		changed := false
		for _, p := range proposed {
			found := false
			for _, e := range cfg.Apps {
				if sameOrigin(e.URL, p.URL) {
					found = true
					break
				}
			}
			if !found {
				cfg.Apps = append(cfg.Apps, AppEntry{
					Name:  p.Name,
					URL:   p.URL,
					Color: p.Color,
				})
				changed = true
			}
		}
		appViewsMu.Unlock()

		if !changed {
			return
		}
		if err := saveConfig(cfg); err != nil {
			fmt.Println("[oblitools] error saving proposed apps:", err)
		}
		reconcileAppViews(cfg.Apps, cfg)
		shellView.Dispatch(func() {
			navigateShell(generateTabBarHTML(*cfg, int(activeAppIdx.Load())))
		})
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_proposeLinkedApps:", err)
	}

	// __go_getTabConfig: multi-tenant auto-cycling config (read by tabBarJS).
	if err := v.Bind("__go_getTabConfig", func() TabConfig {
		return cfg.TabConfig
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_getTabConfig:", err)
	}

	// __go_saveTabConfig: persist auto-cycling preferences (written by tabBarJS).
	if err := v.Bind("__go_saveTabConfig", func(autoCycleEnabled bool, autoCycleIntervalS float64, followAlertsEnabled bool) {
		cfg.TabConfig.AutoCycleEnabled = autoCycleEnabled
		cfg.TabConfig.AutoCycleIntervalS = int(autoCycleIntervalS)
		cfg.TabConfig.FollowAlertsEnabled = followAlertsEnabled
		if err := saveConfig(cfg); err != nil {
			fmt.Println("[oblitools] error saving tab config:", err)
		}
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_saveTabConfig:", err)
	}

	// __go_getDownloadDir: current download folder path.
	if err := v.Bind("__go_getDownloadDir", func() string {
		return cfg.DownloadDir
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_getDownloadDir:", err)
	}

	// __go_chooseDownloadDir: open native folder-picker dialog.
	if err := v.Bind("__go_chooseDownloadDir", func() (string, error) {
		dir, err := chooseFolder()
		if err != nil {
			return "", err
		}
		cfg.DownloadDir = dir
		if saveErr := saveConfig(cfg); saveErr != nil {
			fmt.Println("[oblitools] error saving config:", saveErr)
		}
		return dir, nil
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_chooseDownloadDir:", err)
	}

	// __go_downloadFile: download a server asset to the configured download dir.
	if err := v.Bind("__go_downloadFile", func(relURL, filename string) (string, error) {
		dir := cfg.DownloadDir
		if dir == "" {
			chosen, err := chooseFolder()
			if err != nil {
				return "", err
			}
			cfg.DownloadDir = chosen
			if saveErr := saveConfig(cfg); saveErr != nil {
				fmt.Println("[oblitools] error saving config:", saveErr)
			}
			dir = chosen
		}
		av.mu.Lock()
		base := av.Entry.URL
		av.mu.Unlock()
		absURL := buildAbsoluteURL(base, relURL)
		dest, err := downloadFile(absURL, dir, filename)
		if err != nil {
			return "", err
		}
		revealFile(dest)
		return dest, nil
	}); err != nil {
		fmt.Println("[oblitools] bind error __go_downloadFile:", err)
	}
}

// ── App WebView launcher ──────────────────────────────────────────────────────

// launchAppView runs on a dedicated goroutine (one per app).
// It creates a native OS window, strips its chrome, sets the shell as owner,
// binds all per-app Go functions, injects scripts, navigates to the app URL,
// and then blocks in v.Run() until the window is destroyed.
func launchAppView(av *AppView, cfg *Config) {
	// Each WebView needs its own OS thread for the Win32 message pump.
	runtime.LockOSThread()

	v := webview.New(false)
	hwnd := uintptr(v.Window())

	av.setViewAndHWND(v, hwnd)

	// Strip OS title bar / borders and set the shell as Win32 owner so the
	// app window has no taskbar entry and moves with the shell.
	// These are no-ops on non-Windows platforms.
	stripWindowChrome(hwnd)
	setWindowOwner(hwnd, shellHWND)

	// Determine whether this app should be visible on launch.
	appViewsMu.Lock()
	myIdx := -1
	for i, x := range allAppViews {
		if x == av {
			myIdx = i
			break
		}
	}
	appViewsMu.Unlock()

	showNow := myIdx >= 0 && int32(myIdx) == activeAppIdx.Load()
	positionAppWindow(hwnd, shellHWND, 0, 0, showNow)

	// Apply the app icon (title-bar / Alt-Tab thumbnail).
	applyWindowIcon(v.Window())

	// Bind per-app Go functions (URL tracking, badge cache, cross-app nav, etc.).
	setupAppBindings(v, av, cfg)

	// Inject scripts into every page load inside this WebView.
	// Guards in each script skip 127.0.0.1 / non-https pages automatically.
	v.Init(overlayJS)
	v.Init(tabBarJS)
	v.Init(fmt.Sprintf(
		"window.__obliview_app_version=window.__obliguard_app_version=window.__oblimap_app_version=window.__obliance_app_version=%q;",
		appVersion,
	))

	// Navigate to the app.  Restore the last-visited page when available.
	av.mu.Lock()
	entry := av.Entry
	av.mu.Unlock()

	dest := strings.TrimRight(entry.URL, "/")
	if entry.LastURL != "" &&
		strings.HasPrefix(entry.LastURL, "/") &&
		!strings.HasPrefix(entry.LastURL, "/auth/") {
		dest += entry.LastURL
	}
	v.Navigate(dest)

	v.Run() // blocks until window is destroyed (shell close cascades via ownership)

	av.setViewAndHWND(nil, 0)
}

// ── App-view reconciliation ───────────────────────────────────────────────────

// reconcileAppViews diffs newApps against the current allAppViews slice.
//   - Existing views whose URL origin is still present: entry is updated in-place.
//   - New URLs: a fresh AppView goroutine is launched.
//   - Removed URLs: the WebView is destroyed (v.Run() returns, goroutine exits).
func reconcileAppViews(newApps []AppEntry, cfg *Config) {
	appViewsMu.Lock()
	defer appViewsMu.Unlock()

	// Index existing views by origin.
	byOrigin := make(map[string]*AppView, len(allAppViews))
	for _, av := range allAppViews {
		if org := originOf(av.Entry.URL); org != "" {
			byOrigin[org] = av
		}
	}

	next := make([]*AppView, 0, len(newApps))
	for _, app := range newApps {
		org := originOf(app.URL)
		if av, ok := byOrigin[org]; ok {
			// Update metadata; keep existing WebView running.
			av.mu.Lock()
			av.Entry = app
			av.mu.Unlock()
			next = append(next, av)
			delete(byOrigin, org)
		} else {
			// New app — launch a WebView on a fresh goroutine.
			av = &AppView{Entry: app}
			next = append(next, av)
			go launchAppView(av, cfg)
		}
	}

	// Destroy removed views (Destroy causes Run() to return).
	for _, av := range byOrigin {
		if tv := av.getView(); tv != nil {
			tv.Dispatch(func() { tv.Destroy() })
		}
	}

	allAppViews = next
}

// ── Position sync loop ────────────────────────────────────────────────────────

// startPositionSyncLoop polls every 50 ms and repositions all app windows to
// stay flush below the shell tab bar.  When the shell is minimised, all app
// windows are hidden; when restored they reappear automatically.
//
// Platform note: positionAppWindow / hideAppWindow / isWindowMinimized are
// no-ops on non-Windows platforms — the loop is harmless everywhere.
func startPositionSyncLoop() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		h := shellHWND
		if h == 0 {
			continue
		}

		minimized := isWindowMinimized(h)
		curActive := int(activeAppIdx.Load())

		appViewsMu.Lock()
		views := make([]*AppView, len(allAppViews))
		copy(views, allAppViews)
		appViewsMu.Unlock()

		for i, av := range views {
			hwnd := av.getHWND()
			if hwnd == 0 {
				continue
			}
			if minimized {
				hideAppWindow(hwnd)
			} else if i == curActive {
				positionAppWindow(hwnd, h, 0, 0, true)
			} else {
				hideAppWindow(hwnd)
			}
		}
	}
}

// ── main ──────────────────────────────────────────────────────────────────────

func main() {
	cfg, _ := loadConfig()

	// Restore saved content-area dimensions, falling back to defaults on first run.
	winW, winH := defaultW, defaultH
	if cfg.Width >= 400 && cfg.Height >= 100 {
		winW, winH = cfg.Width, cfg.Height
	} else {
		cfg.Width, cfg.Height = defaultW, defaultH
	}

	// Find the initial active app index (matches cfg.URL).
	initialActive := 0
	for i, app := range cfg.Apps {
		if sameOrigin(app.URL, cfg.URL) {
			initialActive = i
			break
		}
	}
	activeAppIdx.Store(int32(initialActive))

	// Create the shell WebView on the main goroutine (= shell UI thread).
	w := webview.New(false)
	defer w.Destroy()

	shellView = w
	shellHWND = uintptr(w.Window())

	w.SetTitle("Obli.tools")
	w.SetSize(winW, winH, webview.HintNone)

	// Apply the app icon (title bar on Windows, Dock on macOS).
	applyWindowIcon(w.Window())

	// Bind shell Go functions (setup page URL entry, tab switching, manage dialog).
	setupShellBindings(w, cfg)

	// Start the localhost HTTP server that serves the shell tab-bar HTML.
	startLocalServer()

	// Launch one WebView goroutine per configured app (all start hidden except
	// the initially active one; the position sync loop manages visibility).
	appViewsMu.Lock()
	for _, app := range cfg.Apps {
		av := &AppView{Entry: app}
		allAppViews = append(allAppViews, av)
		go launchAppView(av, cfg)
	}
	appViewsMu.Unlock()

	// Start the 50 ms position-sync loop that keeps app windows aligned.
	go startPositionSyncLoop()

	// Navigate the shell to the setup page (no apps) or the tab bar.
	if len(cfg.Apps) == 0 {
		w.SetHtml(setupHTML)
	} else {
		navigateShell(generateTabBarHTML(*cfg, initialActive))
	}

	w.Run() // blocks until the shell window is closed

	// Persist the final config (window size + last-known active URL).
	if err := saveConfig(cfg); err != nil {
		fmt.Println("[oblitools] error saving config on exit:", err)
	}
}
