export const APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>GitGuard</title>
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js" defer></script>
</head>
<body data-token="__TOKEN__" data-initial-cwd="__INITIAL_CWD__" data-native-picker="__NATIVE_PICKER__" data-mcp-command="__MCP_COMMAND__">
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">G</span><strong>GitGuard</strong></div>
      <div class="repo-control"><label for="cwdInput">仓库</label><input id="cwdInput" type="text" spellcheck="false" autocomplete="off" placeholder="Git 仓库绝对路径"><button id="connectBtn" type="button">连接</button></div>
      <div class="top-actions"><button id="chooseBtn" type="button">选择目录</button><button id="createConfigBtn" type="button" hidden>创建配置</button><select id="langSelect" aria-label="语言"><option value="zh">中文</option><option value="en">English</option></select></div>
      <div id="repoStatus" class="repo-status">待连接</div>
    </header>

    <main>
      <nav class="command-nav" aria-label="CLI 命令">
        <button class="active" data-command="inspect" type="button">Inspect<span>改动</span></button>
        <button data-command="check" type="button">Check<span>检查</span></button>
        <button data-command="findings" type="button">Findings<span>问题</span></button>
        <button data-command="verify" type="button">Verify<span>复验</span></button>
        <button data-command="mcp" type="button">MCP<span>连接</span></button>
      </nav>

      <div class="layout">
        <section class="controls panel" aria-labelledby="commandTitle">
          <header class="panel-header"><div><h1 id="commandTitle">Inspect</h1><p id="commandSubtitle">查看指定范围的文件改动</p></div><span class="command-tag" id="commandTag">gitguard inspect</span></header>

          <div id="commonFields">
            <div class="form-grid">
              <label id="scopeField">范围
                <select id="scopeSelect">
                  <option value="all">全部未提交改动</option>
                  <option value="staged">已暂存</option>
                  <option value="working">未暂存</option>
                  <option value="commit">指定提交</option>
                  <option value="range">提交范围</option>
                </select>
              </label>
              <label id="targetField" hidden>目标提交 / 范围<input id="targetInput" type="text" spellcheck="false" placeholder="HEAD 或 HEAD~1..HEAD"></label>
              <label id="taskField">任务描述<input id="taskInput" type="text" maxlength="2000" placeholder="可选"></label>
              <label id="configField">配置文件<input id="configInput" type="text" spellcheck="false" placeholder="默认读取仓库 .gitguard.yml"></label>
            </div>
          </div>

          <div id="inspectFields" class="option-block">
            <label class="check-option"><input id="checkDeterministic" type="checkbox">运行初步确定性检查</label>
          </div>

          <div id="checkFields" class="option-block" hidden>
            <p class="field-note" data-online-note>仅使用 TypeSafe 在线判断；需设置 TYPESAFE_API_KEY。</p>
            <label>限定问题 ID<input id="checkFindingIds" type="text" spellcheck="false" placeholder="可选，多个 ID 用逗号分隔"></label>
            <div class="check-grid">
              <label class="check-option"><input id="strict" type="checkbox">严格模式 (--strict)</label>
              <label class="check-option"><input id="failOnWarn" type="checkbox">WARN 返回失败 (--fail-on-warn)</label>
            </div>
          </div>

          <div id="findingsFields" class="option-block" hidden>
            <div class="form-grid">
              <label>状态<select id="filterStatus"><option value="">全部</option><option value="warn">warn</option><option value="review">review</option><option value="block">block</option></select></label>
              <label>严重程度<select id="filterSeverity"><option value="">全部</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option><option value="CRITICAL">CRITICAL</option></select></label>
              <label>生命周期<select id="filterLifecycle"><option value="">全部</option><option value="active">active</option><option value="resolved">resolved</option><option value="suppressed">suppressed</option></select></label>
              <label>文件<input id="filterFile" type="text" spellcheck="false" placeholder="精确路径"></label>
              <label>规则 ID<input id="filterRule" type="text" spellcheck="false" placeholder="精确规则 ID"></label>
            </div>
          </div>

          <div id="verifyFields" class="option-block" hidden>
            <p class="field-note" data-online-note>仅使用 TypeSafe 在线判断；需设置 TYPESAFE_API_KEY。</p>
            <label>问题 ID<input id="verifyFindingIds" type="text" spellcheck="false" placeholder="留空复验全部活跃问题；多个 ID 用逗号分隔"></label>
            <label class="check-option"><input id="targetOnly" type="checkbox">只判断指定问题 (--target-only)</label>
          </div>

          <div id="mcpFields" class="option-block" hidden>
            <label class="check-option"><input id="mcpDebug" type="checkbox">调试日志 (--debug)</label>
            <label>在 MCP 客户端中使用以下启动命令<input id="mcpCommand" type="text" readonly></label>
            <button id="copyMcp" class="button secondary" type="button">复制 MCP 命令</button>
            <p class="field-note">MCP 由客户端启动；语义检查仅在线。</p>
          </div>

          <div id="actionRow" class="action-row"><button id="runBtn" class="button primary" type="button">运行 Inspect</button><span id="actionNote">默认只读取改动；初步检查会执行仓库配置命令。</span></div>
        </section>

        <section id="resultPanel" class="results panel" aria-labelledby="resultTitle">
          <header class="result-header"><div><span id="resultBadge" class="badge neutral">待运行</span><h2 id="resultTitle">无结果</h2><p id="resultSummary">选择命令并运行。</p></div><span id="resultTime"></span></header>
          <div id="metrics" class="metrics" hidden></div>
          <div class="output-bar"><div class="output-tabs" role="tablist" aria-label="输出格式"><button class="active" data-output="visual" role="tab" aria-selected="true" type="button">可视化</button><button data-output="text" role="tab" aria-selected="false" type="button">文本</button><button data-output="json" role="tab" aria-selected="false" type="button">JSON</button></div><button id="copyOutput" type="button">复制输出</button></div>
          <div id="visualOutput" class="output-content"></div>
          <pre id="textOutput" class="raw-output" hidden></pre>
          <pre id="jsonOutput" class="raw-output" hidden></pre>
        </section>
      </div>
    </main>
  </div>

  <dialog id="directoryDialog" class="dialog">
    <div class="dialog-head"><h2 id="directoryTitle">选择项目目录</h2><button id="closeDirectory" type="button" aria-label="关闭">×</button></div>
    <div class="directory-bar"><input id="directoryPath" type="text" spellcheck="false" aria-label="目录路径"><button id="browseGo" type="button">打开</button><button id="browseUp" type="button">上级</button><button id="nativeChoose" type="button" hidden>用系统文件管理器选择</button></div>
    <div id="directoryGroups" class="directory-groups"></div>
  </dialog>
  <dialog id="configDialog" class="dialog config-dialog">
    <div class="dialog-head"><h2 id="configTitle">创建 .gitguard.yml</h2><button id="closeConfig" type="button" aria-label="关闭">×</button></div>
    <p id="configProject" class="config-project"></p>
    <p id="configHint" class="config-hint">命令留空时对应检查禁用；密钥扫描始终启用。</p>
    <label>测试命令<input id="testCommand" type="text" spellcheck="false" placeholder="例如 pnpm test"></label>
    <label>Lint 命令<input id="lintCommand" type="text" spellcheck="false" placeholder="例如 pnpm lint"></label>
    <label>类型检查命令<input id="typecheckCommand" type="text" spellcheck="false" placeholder="例如 pnpm tsc --noEmit"></label>
    <div class="dialog-actions"><button id="cancelConfig" class="button secondary" type="button">取消</button><button id="saveConfig" class="button primary" type="button">创建配置</button></div>
  </dialog>
  <div id="progress" class="progress" role="status" aria-live="polite" hidden><span class="spinner"></span><span id="progressText">运行中</span></div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;

export const APP_CSS = String.raw`
:root{--bg:#0c151b;--panel:#15232b;--panel2:#192a33;--line:#31434d;--text:#edf0eb;--muted:#9cafb5;--dim:#718790;--accent:#ed936c;--accent-hover:#f6aa85;--green:#8dd0b7;--yellow:#dfbf7f;--red:#e79991}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 "Microsoft YaHei UI","Segoe UI",sans-serif}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.52;cursor:not-allowed}[hidden]{display:none!important}::selection{background:var(--accent);color:#0c151b}
.app{min-height:100vh}.topbar{display:flex;align-items:center;gap:24px;min-height:72px;padding:13px clamp(20px,3vw,48px);border-bottom:1px solid var(--line);background:#101d24}.brand{display:flex;align-items:center;gap:9px;white-space:nowrap;font-family:Bahnschrift,"Microsoft YaHei UI",sans-serif;font-size:20px;letter-spacing:-.04em}.brand-mark{display:grid;place-items:center;width:30px;height:32px;clip-path:polygon(50% 0,100% 20%,100% 74%,50% 100%,0 74%,0 20%);background:var(--accent);color:#15212a;font-family:Georgia,serif;font-size:21px;font-weight:bold}.repo-control{display:flex;align-items:center;gap:8px;min-width:300px;max-width:720px;flex:1}.repo-control label{color:var(--muted);white-space:nowrap}.repo-control input{min-width:0;flex:1}.repo-status{max-width:260px;color:var(--dim);font:11px/1.4 Consolas,"Microsoft YaHei UI",monospace;overflow-wrap:anywhere;text-align:right}.repo-status.connected{color:var(--green)}.repo-status.failed{color:var(--red)}
main{max-width:1600px;margin:0 auto;padding:22px clamp(20px,3vw,48px) 48px}.command-nav{display:flex;gap:6px;margin-bottom:15px;border-bottom:1px solid var(--line)}.command-nav button{position:relative;display:flex;align-items:baseline;gap:7px;padding:11px 17px 15px;border:0;background:transparent;color:var(--muted);font-family:Bahnschrift,"Microsoft YaHei UI",sans-serif;font-size:16px}.command-nav button:hover{color:var(--text)}.command-nav button.active{color:var(--text)}.command-nav button.active:after{content:"";position:absolute;left:13px;right:13px;bottom:-1px;height:2px;background:var(--accent)}.command-nav span{font-size:11px;color:var(--dim)}.layout{display:grid;grid-template-columns:minmax(355px,440px) minmax(0,1fr);gap:15px;align-items:start}.panel{min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 14px 35px rgba(0,0,0,.13)}.controls{padding:19px}.panel-header{display:flex;align-items:start;justify-content:space-between;gap:8px;padding-bottom:16px;border-bottom:1px solid var(--line)}.panel-header h1{margin:0;font-family:Bahnschrift,"Microsoft YaHei UI",sans-serif;font-size:24px;letter-spacing:-.02em}.panel-header p{margin:2px 0 0;color:var(--dim);font-size:11px}.command-tag{margin-top:5px;color:var(--accent);font:10px Consolas,monospace;white-space:nowrap}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px 10px}.form-grid label:first-child:nth-last-child(1){grid-column:1/-1}.form-grid label:nth-child(3),.form-grid label:nth-child(4){grid-column:1/-1}.controls label:not(.check-option){display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:11px}.controls #commonFields{padding-top:17px}.controls input[type=text],.controls select,.repo-control input{height:35px;padding:0 10px;border:1px solid #405660;border-radius:5px;outline:none;background:#0f1c23;color:var(--text);font-size:12px}.controls input[type=text]:focus,.controls select:focus,.repo-control input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(237,147,108,.11)}input::placeholder{color:#657d87}.controls input[type=text][readonly]{color:var(--green)}.repo-control button,.button{height:35px;padding:0 15px;border:1px solid #566d75;border-radius:5px;background:#263b45;color:var(--text);font-size:12px;font-weight:600;white-space:nowrap}.repo-control button:hover,.button.secondary:hover{background:#334d58}.button.primary{border-color:var(--accent);background:var(--accent);color:#172329}.button.primary:hover{background:var(--accent-hover)}.button.secondary{background:#243740}.option-block{display:grid;gap:13px;margin-top:17px;padding-top:17px;border-top:1px solid var(--line)}.check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.check-option{display:flex;align-items:center;gap:7px;color:var(--text);font-size:11px;cursor:pointer}.check-option input{width:14px;height:14px;margin:0;accent-color:var(--accent)}.field-note{margin:0;color:var(--dim);font-size:11px}.action-row{display:flex;align-items:center;gap:12px;margin-top:18px;padding-top:17px;border-top:1px solid var(--line)}.action-row span{color:var(--dim);font-size:10px;line-height:1.4}
.results{min-height:575px;overflow:hidden}.result-header{display:flex;justify-content:space-between;align-items:start;gap:10px;padding:19px 21px 15px}.badge{display:inline-block;padding:2px 7px;border:1px solid #697b81;border-radius:3px;color:var(--muted);font:10px Consolas,"Microsoft YaHei UI",monospace}.badge.pass{border-color:#6baa96;color:var(--green)}.badge.warn{border-color:#b99b60;color:var(--yellow)}.badge.review{border-color:#c4866b;color:var(--accent)}.badge.block{border-color:#bd7773;color:var(--red)}.result-header h2{margin:9px 0 2px;font-size:18px;font-weight:600}.result-header p{margin:0;color:var(--muted);font-size:11px;max-width:580px;overflow-wrap:anywhere}.result-header>span{color:var(--dim);font:10px Consolas,monospace;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--line)}.metric{padding:11px 15px;background:#172832}.metric small{display:block;color:var(--dim);font-size:10px}.metric strong{display:block;margin-top:2px;font-family:Bahnschrift,"Microsoft YaHei UI",sans-serif;font-size:20px;font-weight:600}.output-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 15px;border-bottom:1px solid var(--line)}.output-tabs{display:flex;gap:3px}.output-tabs button{position:relative;height:41px;padding:0 12px;border:0;background:transparent;color:var(--dim);font-size:11px}.output-tabs button.active{color:var(--text)}.output-tabs button.active:after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;background:var(--accent)}#copyOutput{border:0;background:transparent;color:var(--accent);font-size:11px}#copyOutput:hover{text-decoration:underline}.output-content,.raw-output{min-height:350px;max-height:calc(100vh - 300px);overflow:auto;margin:0;padding:17px 21px}.raw-output{white-space:pre-wrap;overflow-wrap:anywhere;background:#101d24;color:#c9d7d4;font:11px/1.7 Consolas,"Microsoft YaHei UI",monospace}.empty{display:grid;place-items:center;min-height:240px;color:var(--dim);font-size:12px}.section-title{margin:14px 0 8px;font-size:12px;color:var(--text);font-weight:650}.section-title:first-child{margin-top:0}.result-list{border:1px solid var(--line);border-radius:5px;overflow:hidden}.result-row{display:grid;grid-template-columns:95px minmax(0,1fr) 63px 63px;gap:9px;padding:9px 11px;border-bottom:1px solid var(--line);font-size:11px}.result-row:last-child{border-bottom:0}.result-row.head{background:#1f323c;color:var(--dim);font-size:10px}.result-row .path{font-family:Consolas,"Microsoft YaHei UI",monospace;overflow-wrap:anywhere}.result-row .added{color:var(--green)}.result-row .deleted{color:var(--red)}.info-row{display:grid;grid-template-columns:120px 95px minmax(0,1fr);gap:10px;padding:10px 11px;border-bottom:1px solid var(--line);font-size:11px}.info-row:last-child{border-bottom:0}.info-row .code{font-family:Consolas,monospace;overflow-wrap:anywhere}.info-row .muted{color:var(--dim)}.finding{display:grid;grid-template-columns:16px minmax(0,1fr);gap:11px;padding:13px 10px;border-bottom:1px solid var(--line)}.finding:last-child{border-bottom:0}.finding input{margin:4px 0 0;accent-color:var(--accent)}.finding strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.finding .tags{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:5px;color:var(--accent);font:10px Consolas,"Microsoft YaHei UI",monospace}.finding .id,.finding .paths{margin-top:4px;color:var(--dim);font:10px/1.5 Consolas,"Microsoft YaHei UI",monospace;overflow-wrap:anywhere}.finding details{margin-top:6px;color:var(--muted);font-size:10px}.finding summary{cursor:pointer;color:var(--accent)}.finding ul{margin:5px 0 0;padding-left:17px;overflow-wrap:anywhere}.finding-action{margin:10px 0 4px}.finding-action button{height:30px;border:1px solid #536974;border-radius:4px;background:#21343e;color:var(--text);font-size:11px}.finding-action button:disabled{opacity:.5}.plain-list{margin:0;padding:0;list-style:none}.plain-list li{padding:8px 10px;border-bottom:1px solid var(--line);font:11px/1.5 Consolas,"Microsoft YaHei UI",monospace;overflow-wrap:anywhere}.plain-list li:last-child{border-bottom:0}
.progress{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;gap:9px;padding:10px 14px;border:1px solid #607782;border-radius:5px;background:#223640;box-shadow:0 8px 24px #0006;font-size:11px}.spinner{width:13px;height:13px;border:2px solid #ffffff30;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,16px);padding:9px 12px;border:1px solid #617984;border-radius:5px;background:#263c46;color:var(--text);font-size:11px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}.toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:1100px){.layout{grid-template-columns:1fr}.results{min-height:440px}.output-content,.raw-output{max-height:none}.repo-status{display:none}}
@media(max-width:670px){.topbar{flex-wrap:wrap;gap:9px;padding:12px 16px}.brand{width:100%}.repo-control{min-width:0;width:100%}main{padding:13px 12px 30px}.command-nav{overflow-x:auto}.command-nav button{padding:10px 12px 13px;font-size:14px}.command-nav span{display:none}.form-grid,.check-grid{grid-template-columns:1fr}.form-grid label:nth-child(n){grid-column:1/-1}.result-header{padding:16px}.metrics{grid-template-columns:repeat(2,1fr)}.result-row{grid-template-columns:66px minmax(0,1fr) 40px 40px;gap:5px;padding:7px;font-size:10px}.info-row{grid-template-columns:90px 70px minmax(0,1fr);gap:6px}.output-content,.raw-output{padding:12px}.action-row{display:block}.action-row span{display:block;margin-top:6px}}

.top-actions{display:flex;align-items:center;gap:6px}.top-actions button,.top-actions select{height:34px;padding:0 9px;border:1px solid #506670;border-radius:5px;background:#22343e;color:var(--text);font-size:11px;white-space:nowrap}.top-actions button:hover{background:#304a55}.top-actions #createConfigBtn{border-color:var(--accent);color:var(--accent)}.dialog{width:min(760px,calc(100vw - 30px));max-height:min(80vh,760px);padding:0;border:1px solid #58717a;border-radius:9px;background:#14232b;color:var(--text);box-shadow:0 28px 80px #0009}.dialog::backdrop{background:#041017ba}.dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 19px;border-bottom:1px solid var(--line)}.dialog-head h2{margin:0;font-size:17px}.dialog-head button{border:0;background:transparent;color:var(--muted);font-size:22px}.directory-bar{display:flex;gap:7px;padding:13px 19px;border-bottom:1px solid var(--line)}.directory-bar input{flex:1;min-width:0;height:34px;padding:0 9px;border:1px solid #4b626c;border-radius:4px;outline:none;background:#0d1c23;color:var(--text);font:11px Consolas,"Microsoft YaHei UI",monospace}.directory-bar button,.directory-row button{height:34px;padding:0 10px;border:1px solid #526b75;border-radius:4px;background:#243943;color:var(--text);font-size:11px}.directory-bar button:hover,.directory-row button:hover{background:#344e59}.directory-groups{max-height:490px;overflow:auto;padding:10px 19px 20px}.directory-group{margin:10px 0 17px}.directory-group h3{margin:0 0 7px;color:var(--accent);font-size:11px;font-weight:600}.directory-row{display:flex;align-items:center;gap:8px;min-height:42px;padding:5px 7px;border-bottom:1px solid var(--line)}.directory-row .folder-name{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:var(--text);font:11px Consolas,"Microsoft YaHei UI",monospace}.directory-row .folder-name:hover{color:var(--accent)}.directory-row .folder-meta{color:var(--dim);font-size:10px;white-space:nowrap}.directory-empty{padding:14px 7px;color:var(--dim);font-size:11px}.config-dialog{width:min(540px,calc(100vw - 30px));padding-bottom:18px}.config-project,.config-hint{margin:12px 19px 0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.config-dialog label{display:flex;flex-direction:column;gap:5px;margin:12px 19px 0;color:var(--text);font-size:11px}.config-dialog label input{height:35px;padding:0 10px;border:1px solid #4b626c;border-radius:4px;background:#0d1c23;color:var(--text)}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin:18px 19px 0}
@media(max-width:670px){.top-actions{width:100%;justify-content:flex-end}.directory-bar{flex-wrap:wrap}.directory-bar input{flex-basis:100%}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

export const APP_JS = String.raw`
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  let initialLanguage = 'zh';
  try { if (localStorage.getItem('gitguard.language') === 'en') initialLanguage = 'en'; } catch {}
  const state = {
    language: initialLanguage, command: 'inspect', cwd: body.dataset.initialCwd || '',
    status: null, results: {}, output: 'visual', selected: new Set(), busy: false, browse: null
  };
  const words = {
    zh: {
      repo:'仓库',connect:'连接',choose:'选择目录',create:'创建配置',pending:'待连接',
      commandsLabel:'命令',outputLabel:'输出格式',languageLabel:'语言',targetExample:'HEAD 或 HEAD~1..HEAD',
      configured:'已配置',unconfigured:'未配置',disconnected:'连接失败',
      commandInspect:'查看指定范围的文件改动',commandCheck:'运行完整检查',
      commandFindings:'查看已保存的问题',commandVerify:'复验问题',commandMcp:'MCP 启动命令',
      scope:'范围',target:'目标提交 / 范围',task:'任务描述',config:'配置文件',
      allChanges:'全部未提交改动',staged:'已暂存',working:'未暂存',
      commit:'指定提交',range:'提交范围',optional:'可选',
      defaultConfig:'默认读取仓库 .gitguard.yml',precheck:'运行初步确定性检查',
      onlineOnlyNote:'仅使用 TypeSafe 在线判断；需设置 TYPESAFE_API_KEY。',
      findingIds:'限定问题 ID',verifyIds:'问题 ID',
      checkIdsPlaceholder:'可选，多个 ID 用逗号分隔',
      verifyIdsPlaceholder:'留空复验全部活跃问题；多个 ID 用逗号分隔',
      strict:'严格模式 (--strict)',failOnWarn:'警告时返回失败 (--fail-on-warn)',
      targetOnly:'只判断指定问题 (--target-only)',status:'状态',severity:'严重程度',
      lifecycle:'生命周期',file:'文件',rule:'规则 ID',all:'全部',
      exactPath:'精确路径',exactRule:'精确规则 ID',mcpDebug:'调试日志 (--debug)',
      mcpHint:'在 MCP 客户端中使用以下启动命令',copyMcp:'复制 MCP 命令',
      mcpNote:'MCP 由客户端启动；语义检查仅在线，需设置 TYPESAFE_API_KEY。',
      run:'运行',inspectNote:'默认只读取改动；初步检查会执行仓库配置命令。',
      checkNote:'检查可能执行仓库配置的命令，并保存问题记录。',
      findingsNote:'从当前仓库读取已保存的问题。',
      verifyNote:'复验可能执行仓库配置的命令，并更新问题状态。',
      noResult:'无结果',chooseRun:'选择命令并运行。',ready:'待运行',
      visual:'可视化',text:'文本',copyOutput:'复制输出',
      directoryTitle:'选择项目目录',nativeChoose:'用系统文件管理器选择',open:'打开',up:'上级',close:'关闭',
      configTitle:'创建 .gitguard.yml',
      configHint:'命令留空时对应检查禁用；密钥扫描始终启用。',
      testCommand:'测试命令',lintCommand:'代码规范命令',typecheckCommand:'类型检查命令',
      cancel:'取消',saveConfig:'创建配置',running:'运行中',
      configuredProjects:'已建立 .gitguard.yml',unconfiguredProjects:'未建立 .gitguard.yml',
      otherFolders:'其他文件夹',select:'选择',enter:'进入',emptyGroup:'无',
      truncated:'仅显示前 300 个文件夹。',useSelected:'用所选 ID 复验',
      noItems:'没有结果',changedFiles:'改动文件',findings:'问题',
      checks:'确定性检查',decisions:'语义判断',resolved:'已解决',
      remaining:'仍存在',unknown:'未找到',files:'文件数',insertions:'新增行',
      deletions:'删除行',statusMetric:'结论',path:'路径',added:'新增',
      deleted:'删除',change:'变更',id:'ID',message:'说明',evidence:'证据',
      expected:'解决依据',summary:'摘要',showDetails:'查看详情',
      copied:'已复制',created:'配置已创建',selectRoot:'请选择 Git 仓库目录。',
      noCwd:'请输入仓库绝对路径。',targetNeeded:'请填写目标提交或范围。',
      inspectNav:'改动',checkNav:'检查',findingsNav:'问题',verifyNav:'复验',mcpNav:'连接',
      browseError:'无法读取目录',connectError:'无法连接仓库',
      configExampleTest:'例如 pnpm test',configExampleLint:'例如 pnpm lint',
      configExampleType:'例如 pnpm tsc --noEmit',directoryPath:'目录路径',
      repoPath:'Git 仓库绝对路径',selectFirst:'请先勾选问题。',
      noCheck:'没有确定性检查结果',noDecisions:'没有语义判断结果',
      inspectTitle:'改动',checkTitle:'检查',findingsTitle:'问题',verifyTitle:'复验',mcpTitle:'MCP',
      pass:'通过',warn:'警告',review:'待复核',block:'阻止',info:'信息',error:'错误',critical:'严重',
      active:'未解决',resolvedState:'已解决',suppressed:'已忽略',
      passed:'通过',failed:'失败',skipped:'跳过',
      addedStatus:'新增',modifiedStatus:'修改',deletedStatus:'删除',renamedStatus:'重命名',
      copiedStatus:'复制',untrackedStatus:'未跟踪',
      secretScan:'密钥扫描',testCheck:'测试',lintCheck:'代码规范',typecheckCheck:'类型检查',
      secretFinding:'改动中检测到疑似密钥或凭据',checkFailed:'检查失败',semanticRule:'语义规则触发',
      verdict:'结论',findingCount:'问题数',
      probability:'概率',score:'评分',confidence:'置信度',exitCode:'退出码',line:'行',
      task_completed:'任务完成',task_scope_match:'任务范围匹配',unrelated_changes:'无关改动',
      tests_required:'需要测试',tests_present:'测试覆盖',security_sensitive_change:'安全敏感改动',
      security_sensitive:'安全敏感改动',regression_risk:'回归风险',change_type:'改动类型',
      behavior_change:'行为变化',breaking_change:'破坏性变更',debug_leftovers:'调试残留',
      negligible:'极低',low:'低',medium:'中',high:'高',
      expectedFix:'请修复问题后重新运行复验。',operationFailed:'操作失败，请检查仓库路径、配置或终端日志。',
      missingOnlineKey:'未配置 TypeSafe API 密钥，请设置 TYPESAFE_API_KEY。',
      invalidOnlineAnswer:'在线服务返回的语义答案不完整或无效，本次检查未通过。',
      onlineRequestFailed:'在线语义服务请求失败，本次检查未通过。',
      mockPolicyRejected:'仓库配置启用了本地模拟，请改为 TypeSafe 在线提供方。',
      notRepo:'所选目录不是 Git 仓库。',missingTarget:'请填写目标提交或范围。',
      textHeader:'GitGuard 结果',fileStatus:'文件状态'
    },
    en: {
      repo:'Repository',connect:'Connect',choose:'Choose folder',create:'Create config',pending:'Not connected',
      commandsLabel:'Commands',outputLabel:'Output format',languageLabel:'Language',targetExample:'HEAD or HEAD~1..HEAD',
      configured:'Configured',unconfigured:'No config',disconnected:'Connection failed',
      commandInspect:'Inspect changed files in the selected scope',commandCheck:'Run the full check',
      commandFindings:'View saved findings',commandVerify:'Verify findings',commandMcp:'MCP launch command',
      scope:'Scope',target:'Commit / range',task:'Task',config:'Config file',
      allChanges:'All uncommitted',staged:'Staged',working:'Working tree',
      commit:'Commit',range:'Commit range',optional:'Optional',
      defaultConfig:'Defaults to repository .gitguard.yml',precheck:'Run preliminary deterministic checks',
      onlineOnlyNote:'TypeSafe online only. Set TYPESAFE_API_KEY before checking.',
      findingIds:'Finding IDs',verifyIds:'Finding IDs',
      checkIdsPlaceholder:'Optional; separate IDs with commas',
      verifyIdsPlaceholder:'Blank verifies all active findings; separate IDs with commas',
      strict:'Strict mode (--strict)',failOnWarn:'Fail on WARN (--fail-on-warn)',
      targetOnly:'Only evaluate selected findings (--target-only)',status:'Status',severity:'Severity',
      lifecycle:'Lifecycle',file:'File',rule:'Rule ID',all:'All',
      exactPath:'Exact path',exactRule:'Exact rule ID',mcpDebug:'Debug logs (--debug)',
      mcpHint:'Use this launch command in your MCP client',copyMcp:'Copy MCP command',
      mcpNote:'Start MCP in your client. Semantic checks require online TypeSafe and TYPESAFE_API_KEY.',
      run:'Run',inspectNote:'Reads changes by default; preliminary checks run repository commands.',
      checkNote:'Checks may run configured commands and save findings.',
      findingsNote:'Reads saved findings from this repository.',
      verifyNote:'Verification may run configured commands and update finding status.',
      noResult:'No result',chooseRun:'Choose a command and run it.',ready:'Ready',
      visual:'Visual',text:'Text',copyOutput:'Copy output',
      directoryTitle:'Choose project folder',nativeChoose:'Choose in File Explorer',open:'Open',up:'Up',close:'Close',
      configTitle:'Create .gitguard.yml',
      configHint:'Blank commands disable their checks; secret scanning stays enabled.',
      testCommand:'Test command',lintCommand:'Lint command',typecheckCommand:'Typecheck command',
      cancel:'Cancel',saveConfig:'Create config',running:'Running',
      configuredProjects:'With .gitguard.yml',unconfiguredProjects:'Without .gitguard.yml',
      otherFolders:'Other folders',select:'Select',enter:'Open',emptyGroup:'None',
      truncated:'Showing only the first 300 folders.',useSelected:'Verify selected IDs',
      noItems:'No results',changedFiles:'Changed files',findings:'Findings',
      checks:'Deterministic checks',decisions:'Semantic decisions',resolved:'Resolved',
      remaining:'Remaining',unknown:'Unknown IDs',files:'Files',insertions:'Insertions',
      deletions:'Deletions',statusMetric:'Verdict',path:'Path',added:'Added',
      deleted:'Deleted',change:'Change',id:'ID',message:'Message',evidence:'Evidence',
      expected:'Resolution evidence',summary:'Summary',showDetails:'Details',
      copied:'Copied',created:'Config created',selectRoot:'Select a Git repository folder.',
      noCwd:'Enter an absolute repository path.',targetNeeded:'Enter a commit or range.',
      inspectNav:'Changes',checkNav:'Check',findingsNav:'Findings',verifyNav:'Verify',mcpNav:'Connect',
      browseError:'Cannot read folder',connectError:'Cannot connect to repository',
      configExampleTest:'For example: pnpm test',configExampleLint:'For example: pnpm lint',
      configExampleType:'For example: pnpm tsc --noEmit',directoryPath:'Folder path',
      repoPath:'Absolute Git repository path',selectFirst:'Select at least one finding.',
      noCheck:'No deterministic results',noDecisions:'No semantic decisions',
      inspectTitle:'Inspect',checkTitle:'Check',findingsTitle:'Findings',verifyTitle:'Verify',mcpTitle:'MCP',
      pass:'Pass',warn:'Warning',review:'Review',block:'Blocked',info:'Info',error:'Error',critical:'Critical',
      active:'Active',resolvedState:'Resolved',suppressed:'Suppressed',
      passed:'Passed',failed:'Failed',skipped:'Skipped',
      addedStatus:'Added',modifiedStatus:'Modified',deletedStatus:'Deleted',renamedStatus:'Renamed',
      copiedStatus:'Copied',untrackedStatus:'Untracked',
      secretScan:'Secret scan',testCheck:'Tests',lintCheck:'Lint',typecheckCheck:'Typecheck',
      secretFinding:'Potential secret or credential detected in changes',checkFailed:'Check failed',
      semanticRule:'Semantic rule triggered',verdict:'Verdict',findingCount:'Findings',
      probability:'Probability',score:'Score',confidence:'Confidence',exitCode:'Exit code',line:'Line',
      task_completed:'Task completion',task_scope_match:'Task scope',unrelated_changes:'Unrelated changes',
      tests_required:'Tests required',tests_present:'Tests present',security_sensitive_change:'Security sensitive change',
      security_sensitive:'Security sensitive change',regression_risk:'Regression risk',change_type:'Change type',
      behavior_change:'Behavior change',breaking_change:'Breaking change',debug_leftovers:'Debug leftovers',
      negligible:'Negligible',low:'Low',medium:'Medium',high:'High',
      expectedFix:'Resolve the finding, then run verification again.',
      operationFailed:'Operation failed. Check the repository path, configuration, or terminal logs.',
      notRepo:'The selected folder is not a Git repository.',missingTarget:'Enter a commit or range.',
      textHeader:'GitGuard result',fileStatus:'File status'
    }
  };
  function t(key) { return words[state.language][key] || key; }
  function displayVerdict(raw) { return t(String(raw || '').toLowerCase()); }
  function displayStatus(raw) { return t(String(raw || '').toLowerCase()); }
  function displaySeverity(raw) { return t(String(raw || '').toLowerCase()); }
  function displayFileStatus(raw) { return t(String(raw || '').toLowerCase() + 'Status'); }
  function checkName(id) { return t({secret_scan:'secretScan',test:'testCheck',lint:'lintCheck',typecheck:'typecheckCheck'}[id] || id); }
  function ruleName(id) { return t(id || 'semanticRule'); }
  function decisionValue(decision) {
    if (typeof decision.probability === 'number') return t('probability') + ' ' + decision.probability;
    const parts = [];
    if (decision.value !== undefined && decision.value !== null) parts.push(ruleName(String(decision.value)));
    if (typeof decision.score === 'number') parts.push(t('score') + ' ' + decision.score);
    else if (typeof decision.score === 'string' && !decision.value) parts.push(ruleName(decision.score));
    return parts.join(' · ') || decision.decision || decision.answer || '';
  }
  function displayedRationale(decision) {
    const rationale = decision.rationale || decision.reason || '';
    return state.language === 'en' || /[\u3400-\u9fff]/.test(rationale) ? rationale : '';
  }
  function findingMessage(finding) {
    if (state.language === 'en') return finding.message || finding.id;
    if (finding.ruleId === 'deterministic.secret_scan') return t('secretFinding');
    if (finding.ruleId && finding.ruleId.startsWith('deterministic.')) return checkName(finding.ruleId.slice(14)) + t('checkFailed');
    const metric = decisionValue({...finding, score:finding.metadata && finding.metadata.score});
    return ruleName(finding.ruleId) + (metric ? ' · ' + metric : '');
  }
  function evidenceText(item) {
    if (typeof item === 'string') return item;
    const parts = [];
    if (item.path) parts.push(item.path);
    if (item.lines || item.lineRange) parts.push(t('line') + ' ' + (item.lines || item.lineRange));
    if (item.command) parts.push(item.command);
    if (item.exitCode !== undefined) parts.push(t('exitCode') + ' ' + item.exitCode);
    if (item.details) {
      const metric = decisionValue(item.details);
      if (metric) parts.push(metric);
      if (typeof item.details.confidence === 'number') parts.push(t('confidence') + ' ' + item.details.confidence);
    }
    if (item.message && (state.language === 'en' || item.type !== 'behavior_change' || /[\u3400-\u9fff]/.test(item.message))) {
      parts.push(item.message);
    }
    return parts.join(' · ');
  }
  function friendlyError(error) {
    const message = String(error && error.message || error);
    if (state.language === 'zh') {
      if (/^[\u3400-\u9fff]/.test(message)) return message;
      if (/not a git repository/i.test(message)) return t('notRepo');
      if (/TypeSafe API key is not configured|MISSING_API_KEY/i.test(message)) return t('missingOnlineKey');
      if (/offline or mock mode is unavailable/i.test(message)) return t('mockPolicyRejected');
      if (/Malformed System One|missing answer for required question/i.test(message)) return t('invalidOnlineAnswer');
      if (/TypeSafe System One API request failed|fetch failed|timeout/i.test(message)) return t('onlineRequestFailed');
      return t('operationFailed');
    }
    if (!/[^\x00-\x7f]/.test(message)) return message;
    if (message.includes('Git 仓库')) return t('notRepo');
    if (message.includes('目标')) return t('missingTarget');
    return t('operationFailed');
  }
  function setText(id, value) { $(id).textContent = value; }
  function setLabel(id, value) {
    const node = $(id);
    const label = node && (node.tagName === 'LABEL' ? node : node.closest('label'));
    const textNode = label && [...label.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = value;
  }
  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }
  function append(parent, child) { parent.appendChild(child); return child; }
  function toast(message) {
    setText('toast', message);
    $('toast').classList.add('shown');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => $('toast').classList.remove('shown'), 3600);
  }
  async function api(route, payload) {
    const response = await fetch(route, {
      method: 'POST',
      headers: {'Content-Type':'application/json','X-GitGuard-Token':body.dataset.token},
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
    return result;
  }
  function setBusy(value) {
    state.busy = value;
    $('progress').hidden = !value;
    setText('progressText', t('running'));
    for (const id of ['connectBtn','runBtn','browseGo','browseUp','nativeChoose','saveConfig']) $(id).disabled = value;
  }
  function value(id) { return $(id).value.trim(); }
  function ids(id) {
    const raw = value(id);
    return raw ? [...new Set(raw.split(/[\s,]+/).filter(Boolean))] : undefined;
  }
  function updateScope() {
    const isTarget = ['commit','range'].includes(value('scopeSelect'));
    $('targetField').hidden = !isTarget || state.command === 'verify';
  }
  function updateMcp() {
    $('mcpCommand').value = (body.dataset.mcpCommand || 'gitguard mcp') + ($('mcpDebug').checked ? ' --debug' : '');
  }
  function setCommand(command) {
    state.command = command;
    for (const button of document.querySelectorAll('[data-command]')) button.classList.toggle('active', button.dataset.command === command);
    setText('commandTitle', t(command + 'Title'));
    setText('commandSubtitle', t('command' + command.charAt(0).toUpperCase() + command.slice(1)));
    setText('commandTag', command === 'mcp' ? 'gitguard mcp' : 'gitguard ' + command);
    $('commonFields').hidden = command === 'findings' || command === 'mcp';
    for (const name of ['inspect','check','findings','verify','mcp']) $(name + 'Fields').hidden = name !== command;
    $('actionRow').hidden = command === 'mcp';
    $('resultPanel').hidden = command === 'mcp';
    $('scopeSelect').querySelectorAll('option[value="commit"],option[value="range"]').forEach(option => {
      option.hidden = command === 'verify';
    });
    if (command === 'verify' && ['commit','range'].includes(value('scopeSelect'))) $('scopeSelect').value = 'all';
    updateScope();
    if (command !== 'mcp') {
      setText('runBtn', t('run') + ' ' + t(command + 'Title'));
      setText('actionNote', t(command + 'Note'));
      renderResult();
    } else updateMcp();
  }
  function translate() {
    document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
    document.querySelector('.repo-control label').textContent = t('repo');
    setText('connectBtn', t('connect')); setText('chooseBtn', t('choose'));
    setText('createConfigBtn', t('create'));
    $('cwdInput').placeholder = t('repoPath');
    $('targetInput').placeholder = t('targetExample');
    document.querySelector('.command-nav').setAttribute('aria-label',t('commandsLabel'));
    document.querySelector('.output-tabs').setAttribute('aria-label',t('outputLabel'));
    $('langSelect').setAttribute('aria-label',t('languageLabel'));
    $('closeDirectory').setAttribute('aria-label',t('close'));
    $('closeConfig').setAttribute('aria-label',t('close'));
    setText('progressText',t('running'));
    setText('toast','');
    $('toast').classList.remove('shown');
    for (const [command,key] of Object.entries({inspect:'inspectNav',check:'checkNav',findings:'findingsNav',verify:'verifyNav',mcp:'mcpNav'})) {
      const button = document.querySelector('[data-command="' + command + '"]');
      button.firstChild.textContent = t(key);
      button.querySelector('span').textContent = '';
      button.querySelector('span').hidden = true;
    }
    for (const [id,key] of Object.entries({
      scopeField:'scope',targetField:'target',taskField:'task',configField:'config',
      checkDeterministic:'precheck',checkFindingIds:'findingIds',
      strict:'strict',failOnWarn:'failOnWarn',
      filterStatus:'status',filterSeverity:'severity',filterLifecycle:'lifecycle',filterFile:'file',
      filterRule:'rule',verifyFindingIds:'verifyIds',targetOnly:'targetOnly',
      mcpDebug:'mcpDebug',mcpCommand:'mcpHint',
      testCommand:'testCommand',lintCommand:'lintCommand',typecheckCommand:'typecheckCommand'
    })) {
      const label = $(id).closest('label');
      if (label) setLabel(label.id || id, t(key));
    }
    for (const [id,key] of Object.entries({taskInput:'optional',configInput:'defaultConfig',
      checkFindingIds:'checkIdsPlaceholder',verifyFindingIds:'verifyIdsPlaceholder',
      filterFile:'exactPath',filterRule:'exactRule',testCommand:'configExampleTest',
      lintCommand:'configExampleLint',typecheckCommand:'configExampleType'})) $(id).placeholder = t(key);
    const scopeKeys = ['allChanges','staged','working','commit','range'];
    [...$('scopeSelect').options].forEach((option,i) => option.textContent = t(scopeKeys[i]));
    document.querySelectorAll('[data-online-note]').forEach(node => node.textContent = t('onlineOnlyNote'));
    for (const id of ['filterStatus','filterSeverity','filterLifecycle']) $(id).options[0].textContent = t('all');
    [...$('filterStatus').options].slice(1).forEach(option => option.textContent = displayStatus(option.value));
    [...$('filterSeverity').options].slice(1).forEach(option => option.textContent = displaySeverity(option.value));
    [...$('filterLifecycle').options].slice(1).forEach(option => option.textContent = t(option.value === 'resolved' ? 'resolvedState' : option.value));
    setText('copyMcp',t('copyMcp')); document.querySelector('#mcpFields .field-note').textContent = t('mcpNote');
    for (const [id,key] of Object.entries({copyOutput:'copyOutput',directoryTitle:'directoryTitle',
      browseGo:'open',browseUp:'up',nativeChoose:'nativeChoose',configTitle:'configTitle',configHint:'configHint',
      cancelConfig:'cancel',saveConfig:'saveConfig'})) setText(id,t(key));
    $('directoryPath').setAttribute('aria-label',t('directoryPath'));
    for (const [name,key] of Object.entries({visual:'visual',text:'text',json:'JSON'}))
      document.querySelector('[data-output="' + name + '"]').textContent = key === 'JSON' ? 'JSON' : t(key);
    updateStatus();
    setCommand(state.command);
    renderBrowse();
  }
  function updateStatus() {
    const status = $('repoStatus');
    status.classList.toggle('connected', Boolean(state.status));
    status.classList.toggle('failed', !state.status && Boolean(state.cwd));
    if (!state.status) {
      status.textContent = state.cwd ? t('disconnected') : t('pending');
      $('createConfigBtn').hidden = true;
      return;
    }
    const branch = state.status.currentBranch || '';
    const sha = state.status.headSha || state.status.head || '';
    status.textContent = [branch, sha ? String(sha).slice(0,8) : '',
      state.status.configFile ? t('configured') : t('unconfigured')].filter(Boolean).join(' · ');
    $('createConfigBtn').hidden = Boolean(state.status.configFile);
  }
  async function connect() {
    if (state.busy) return;
    const cwd = value('cwdInput');
    if (!cwd) return toast(t('noCwd'));
    setBusy(true);
    try {
      const result = await api('/api/status',{cwd});
      state.cwd = result.data.rootPath || cwd;
      $('cwdInput').value = state.cwd;
      state.status = result.data;
      state.results = {};
      state.selected.clear();
      updateStatus();
      if (state.command !== 'mcp') await runCurrent(true);
    } catch(error) {
      state.cwd = cwd;
      state.status = null;
      updateStatus();
      toast(t('connectError') + ': ' + friendlyError(error));
    } finally { setBusy(false); }
  }
  function commonPayload() {
    const scope = value('scopeSelect');
    const payload = {cwd:state.cwd,scope,task:value('taskInput'),configPath:value('configInput')};
    if (['commit','range'].includes(scope)) {
      payload.target = value('targetInput');
      if (!payload.target) throw new Error(t('targetNeeded'));
    }
    return payload;
  }
  async function runCurrent(fromConnect) {
    if (state.busy && !fromConnect) return;
    if (!state.status) return toast(t('selectRoot'));
    const command = fromConnect ? 'inspect' : state.command;
    if (command === 'mcp') return;
    if (!fromConnect) setBusy(true);
    try {
      let payload;
      if (command === 'findings') {
        payload = {cwd:state.cwd,filterStatus:value('filterStatus'),
          filterSeverity:value('filterSeverity'),filterLifecycle:value('filterLifecycle'),
          filterFile:value('filterFile'),filterRule:value('filterRule')};
      } else {
        payload = commonPayload();
        if (command === 'inspect') payload.checkDeterministic = $('checkDeterministic').checked;
        if (command === 'check') Object.assign(payload,{
          strict:$('strict').checked,failOnWarn:$('failOnWarn').checked,
          findingIds:ids('checkFindingIds')
        });
        if (command === 'verify') Object.assign(payload,{
          findingIds:ids('verifyFindingIds'),targetOnly:$('targetOnly').checked
        });
      }
      const result = await api('/api/' + command,payload);
      state.results[command] = {data:result.data,text:result.text || '',time:new Date()};
      if (state.command === command) renderResult();
    } catch(error) {
      state.results[command] = {error:String(error && error.message || error),time:new Date()};
      if (state.command === command) renderResult();
      toast(friendlyError(error));
    }
    finally { if (!fromConnect) setBusy(false); }
  }
  function section(parent,title) { return append(parent,el('h3','section-title',title)); }
  function metric(parent,label,value) {
    const box = append(parent,el('div','metric'));
    append(box,el('small','',label));
    append(box,el('strong','',value));
  }
  function metricSummary(data, command) {
    const holder = $('metrics');
    holder.replaceChildren();
    if (command === 'findings') {
      metric(holder,t('findings'),Array.isArray(data) ? data.length : 0);
      holder.hidden = false;
      return;
    }
    const summary = data.summary || data.diffSummary || {};
    metric(holder,t('files'),summary.filesChanged ?? 0);
    metric(holder,t('insertions'),summary.insertions ?? 0);
    metric(holder,t('deletions'),summary.deletions ?? 0);
    metric(holder,t('statusMetric'),displayVerdict(data.status));
    holder.hidden = false;
  }
  function listBox(parent) { return append(parent,el('div','result-list')); }
  function renderFiles(parent,files) {
    section(parent,t('changedFiles'));
    if (!files.length) return append(parent,el('div','empty',t('noItems')));
    const box = listBox(parent);
    const head = append(box,el('div','result-row head'));
    for (const label of [t('status'),t('path'),t('added'),t('deleted')]) append(head,el('span','',label));
    for (const file of files) {
      const row = append(box,el('div','result-row'));
      append(row,el('span','',displayFileStatus(file.status)));
      append(row,el('span','path',file.path || ''));
      append(row,el('span','added','+' + (file.additions ?? 0)));
      append(row,el('span','deleted','-' + (file.deletions ?? 0)));
    }
  }
  function renderFindings(parent,findings) {
    if (!findings.length) return;
    section(parent,t('findings') + ' (' + findings.length + ')');
    const box = listBox(parent);
    for (const finding of findings) {
      const row = append(box,el('div','finding'));
      const checkbox = append(row,el('input'));
      checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(finding.id);
      checkbox.addEventListener('change',() => {
        if (checkbox.checked) state.selected.add(finding.id); else state.selected.delete(finding.id);
        const button = parent.querySelector('.finding-action button');
        if (button) button.disabled = state.selected.size === 0;
      });
      const details = append(row,el('div'));
      append(details,el('div','tags',[displayStatus(finding.status),displaySeverity(finding.severity),t(finding.lifecycle === 'resolved' ? 'resolvedState' : finding.lifecycle),ruleName(finding.ruleId)].filter(Boolean).join(' · ')));
      append(details,el('strong','',findingMessage(finding)));
      append(details,el('div','id',finding.id));
      if (finding.affectedFiles && finding.affectedFiles.length) append(details,el('div','paths',finding.affectedFiles.join(', ')));
      if ((finding.evidence && finding.evidence.length) || (finding.expectedEvidence && finding.expectedEvidence.length)) {
        const more = append(details,el('details'));
        append(more,el('summary','',t('showDetails')));
        for (const [name,items] of [[t('evidence'),finding.evidence],[t('expected'),finding.expectedEvidence]]) {
          if (!items || !items.length) continue;
          append(more,el('div','',name));
          const ul = append(more,el('ul'));
          for (const item of items) {
            append(ul,el('li','',evidenceText(item)));
          }
        }
      }
    }
    const action = append(parent,el('div','finding-action'));
    const button = append(action,el('button','',t('useSelected')));
    button.type = 'button'; button.disabled = state.selected.size === 0;
    button.addEventListener('click',() => {
      if (!state.selected.size) return toast(t('selectFirst'));
      $('verifyFindingIds').value = [...state.selected].join(', ');
      setCommand('verify');
    });
  }
  function renderChecks(parent,checks) {
    if (!checks.length) return;
    section(parent,t('checks'));
    const box = listBox(parent);
    for (const check of checks) {
      const row = append(box,el('div','info-row'));
      append(row,el('span','code',checkName(check.id)));
      append(row,el('span','',displayStatus(check.status)));
      append(row,el('span','muted',state.language === 'zh' ? (check.durationMs ? check.durationMs + ' 毫秒' : '') : (check.summary || '')));
    }
  }
  function renderDecisions(parent,decisions) {
    const entries = Object.entries(decisions || {});
    if (!entries.length) return;
    section(parent,t('decisions'));
    const box = listBox(parent);
    for (const [id,decision] of entries) {
      const row = append(box,el('div','info-row'));
      append(row,el('span','code',ruleName(id)));
      append(row,el('span','',decisionValue(decision)));
      append(row,el('span','muted',displayedRationale(decision) ||
        (typeof decision.confidence === 'number' ? t('confidence') + ' ' + decision.confidence : '')));
    }
  }
  function renderPlainList(parent,title,items) {
    if (!items || !items.length) return;
    section(parent,title + ' (' + items.length + ')');
    const list = append(parent,el('ul','plain-list'));
    for (const item of items) append(list,el('li','',item));
  }
  function renderVisual(parent,data,command) {
    if (command === 'findings') { renderFindings(parent,Array.isArray(data) ? data : []); return; }
    if (command === 'inspect') {
      renderFiles(parent,data.changedFiles || []);
      if (data.findings && data.findings.length) renderFindings(parent,data.findings);
      return;
    }
    renderChecks(parent,data.deterministicResults || []);
    renderDecisions(parent,data.semanticDecisions || {});
    renderFindings(parent,data.findings || []);
    if (command === 'verify') {
      renderPlainList(parent,t('resolved'),data.resolved || []);
      renderPlainList(parent,t('remaining'),data.remaining || []);
      renderPlainList(parent,t('unknown'),data.unknownFindings || []);
    }
  }
  function localizedText(data,command) {
    const lines = [t('textHeader'),t(command + 'Title')];
    if (command === 'findings') {
      lines.push(t('findingCount') + ': ' + data.length);
    } else {
      const summary = data.summary || data.diffSummary || {};
      lines.push(t('verdict') + ': ' + displayVerdict(data.status));
      lines.push(t('files') + ': ' + (summary.filesChanged ?? 0) + '  +' + (summary.insertions ?? 0) + ' / -' + (summary.deletions ?? 0));
    }
    if (command === 'inspect' && data.changedFiles && data.changedFiles.length) {
      lines.push('',t('changedFiles') + ':');
      for (const file of data.changedFiles) lines.push('  ' + displayFileStatus(file.status) + '  ' + file.path + '  +' + (file.additions ?? 0) + '/-' + (file.deletions ?? 0));
    }
    if (data.deterministicResults && data.deterministicResults.length) {
      lines.push('',t('checks') + ':');
      for (const check of data.deterministicResults) lines.push('  ' + checkName(check.id) + ': ' + displayStatus(check.status));
    }
    if (data.semanticDecisions && Object.keys(data.semanticDecisions).length) {
      lines.push('',t('decisions') + ':');
      for (const [id,decision] of Object.entries(data.semanticDecisions)) lines.push('  ' + ruleName(id) + ': ' + decisionValue(decision) +
        (displayedRationale(decision) ? ' · ' + displayedRationale(decision) : ''));
    }
    const findings = command === 'findings' ? data : (data.findings || []);
    if (findings.length) {
      lines.push('',t('findings') + ':');
      for (const finding of findings) lines.push('  ' + displayStatus(finding.status) + '  ' + finding.id + '  ' + findingMessage(finding));
    }
    if (command === 'verify') for (const [key,items] of [[t('resolved'),data.resolved],[t('remaining'),data.remaining],[t('unknown'),data.unknownFindings]]) {
      lines.push('',key + ':');
      for (const id of items || []) lines.push('  ' + id);
    }
    return lines.join('\n');
  }
  function renderResult() {
    const result = state.results[state.command];
    $('visualOutput').replaceChildren();
    $('metrics').hidden = true;
    setText('resultTime',result ? result.time.toLocaleTimeString(state.language === 'zh' ? 'zh-CN' : 'en-US') : '');
    if (!result) {
      setText('resultBadge',t('ready')); $('resultBadge').className = 'badge neutral';
      setText('resultTitle',t('noResult')); setText('resultSummary',t('chooseRun'));
      append($('visualOutput'),el('div','empty',t('noResult')));
      setText('textOutput',''); setText('jsonOutput','');
    } else if (result.error) {
      const message = friendlyError(result.error);
      setText('resultBadge',t('error')); $('resultBadge').className = 'badge block';
      setText('resultTitle',t(state.command + 'Title'));
      setText('resultSummary',message);
      append($('visualOutput'),el('div','empty',message));
      setText('textOutput',message);
      setText('jsonOutput',JSON.stringify({error:result.error},null,2));
    } else {
      const data = result.data;
      const verdict = state.command === 'findings' ? (data.length ? 'FINDINGS' : 'PASS') : (data.status || 'PASS');
      setText('resultBadge',verdict === 'FINDINGS' ? t('findings') : displayVerdict(verdict));
      $('resultBadge').className = 'badge ' + (verdict === 'PASS' ? 'pass' : verdict === 'BLOCK' ? 'block' : verdict === 'WARN' ? 'warn' : 'review');
      setText('resultTitle',t(state.command + 'Title'));
      setText('resultSummary',state.command === 'findings' ? t('findingCount') + ': ' + data.length :
        t('verdict') + ': ' + displayVerdict(data.status) + ' · ' + t('files') + ': ' + ((data.summary || data.diffSummary || {}).filesChanged ?? 0));
      metricSummary(data,state.command);
      renderVisual($('visualOutput'),data,state.command);
      setText('textOutput',state.language === 'zh' ? localizedText(data,state.command) : result.text);
      setText('jsonOutput',JSON.stringify(data,null,2));
    }
    setOutput(state.output);
  }
  function setOutput(output) {
    state.output = output;
    for (const button of document.querySelectorAll('[data-output]')) {
      const active = button.dataset.output === output;
      button.classList.toggle('active',active);
      button.setAttribute('aria-selected',String(active));
    }
    $('visualOutput').hidden = output !== 'visual';
    $('textOutput').hidden = output !== 'text';
    $('jsonOutput').hidden = output !== 'json';
  }
  function groupDirectory(parent,title,entries) {
    const group = append(parent,el('section','directory-group'));
    append(group,el('h3','',title + ' (' + entries.length + ')'));
    if (!entries.length) return append(group,el('p','empty-group',t('emptyGroup')));
    for (const entry of entries) {
      const row = append(group,el('div','directory-row'));
      const name = append(row,el('button','directory-name',entry.name));
      name.type = 'button'; name.title = entry.path;
      name.addEventListener('click',() => browse(entry.path));
      const action = append(row,el('button','directory-select',entry.isGitRoot ? t('select') : t('enter')));
      action.type = 'button';
      action.addEventListener('click',() => {
        if (!entry.isGitRoot) return browse(entry.path);
        $('cwdInput').value = entry.path;
        $('directoryDialog').close();
        connect();
      });
    }
  }
  function renderBrowse() {
    const holder = $('directoryGroups');
    holder.replaceChildren();
    if (!state.browse) return;
    $('directoryPath').value = state.browse.path;
    const items = state.browse.children || [];
    groupDirectory(holder,t('configuredProjects'),items.filter(item => item.isGitRoot && item.configFile));
    groupDirectory(holder,t('unconfiguredProjects'),items.filter(item => item.isGitRoot && !item.configFile));
    groupDirectory(holder,t('otherFolders'),items.filter(item => !item.isGitRoot));
    if (state.browse.truncated) append(holder,el('p','field-note',t('truncated')));
  }
  async function browse(path) {
    try {
      const result = await api('/api/directories',{path});
      state.browse = result.data;
      renderBrowse();
    } catch(error) { toast(t('browseError') + ': ' + friendlyError(error)); }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('copied')); }
    catch(error) { toast(friendlyError(error)); }
  }
  document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click',() => setCommand(button.dataset.command)));
  document.querySelectorAll('[data-output]').forEach(button => button.addEventListener('click',() => setOutput(button.dataset.output)));
  $('langSelect').addEventListener('change',event => {
    state.language = event.target.value;
    try { localStorage.setItem('gitguard.language',state.language); } catch {}
    translate();
  });
  $('scopeSelect').addEventListener('change',updateScope);
  $('connectBtn').addEventListener('click',connect);
  $('cwdInput').addEventListener('keydown',event => { if (event.key === 'Enter') connect(); });
  $('runBtn').addEventListener('click',() => runCurrent(false));
  $('chooseBtn').addEventListener('click',() => {
    $('directoryDialog').showModal();
    browse(state.cwd || value('cwdInput') || body.dataset.initialCwd);
  });
  $('nativeChoose').hidden = body.dataset.nativePicker !== 'true';
  $('nativeChoose').addEventListener('click',async () => {
    if (state.busy) return;
    setBusy(true);
    let selected;
    try { selected = (await api('/api/pick-directory',{})).data; }
    catch(error) { toast(friendlyError(error)); }
    finally { setBusy(false); }
    if (!selected || !selected.path) return;
    if (!selected.repositoryRoot) return browse(selected.path);
    $('cwdInput').value = selected.repositoryRoot;
    $('directoryDialog').close();
    await connect();
  });
  $('closeDirectory').addEventListener('click',() => $('directoryDialog').close());
  $('browseGo').addEventListener('click',() => browse(value('directoryPath')));
  $('browseUp').addEventListener('click',() => { if (state.browse) browse(state.browse.parent); });
  $('directoryPath').addEventListener('keydown',event => { if (event.key === 'Enter') browse(value('directoryPath')); });
  $('createConfigBtn').addEventListener('click',() => { setText('configProject',state.cwd); $('configDialog').showModal(); });
  $('closeConfig').addEventListener('click',() => $('configDialog').close());
  $('cancelConfig').addEventListener('click',() => $('configDialog').close());
  $('saveConfig').addEventListener('click',async () => {
    if (state.busy || !state.status) return;
    setBusy(true);
    try {
      await api('/api/create-config',{cwd:state.cwd,testCommand:value('testCommand'),
        lintCommand:value('lintCommand'),typecheckCommand:value('typecheckCommand')});
      $('configDialog').close();
      const result = await api('/api/status',{cwd:state.cwd});
      state.status = result.data;
      updateStatus();
      if (state.browse) await browse(state.browse.path);
      toast(t('created'));
    } catch(error) { toast(friendlyError(error)); }
    finally { setBusy(false); }
  });
  $('mcpDebug').addEventListener('change',updateMcp);
  $('copyMcp').addEventListener('click',() => copy(value('mcpCommand')));
  $('copyOutput').addEventListener('click',() => {
    const result = state.results[state.command];
    if (!result) return;
    copy(state.output === 'json' ? JSON.stringify(result.data,null,2) : $('textOutput').textContent);
  });
  $('cwdInput').value = state.cwd;
  $('langSelect').value = state.language;
  translate();
  connect();
}());
`;
