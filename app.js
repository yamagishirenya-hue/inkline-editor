// ===================== IndexedDB(状態の永続化) =====================
const DB_NAME = "inkline-db";
const STORE_NAME = "state";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error("dbSet failed", err);
  }
}

async function dbGet(key) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("dbGet failed", err);
    return undefined;
  }
}

// ===================== タブ管理 =====================
let tabs = [];
let activeTabId = null;
let saveTimer = null;
let sessionSaveTimer = null;
let tabCounter = 0;
let lastTitleClick = { id: null, time: 0 };

function makeTab(opts = {}) {
  tabCounter += 1;
  return {
    id: opts.id || `tab-${Date.now()}-${tabCounter}`,
    name: opts.name || "無題のファイル",
    content: opts.content || "",
    originalContent: opts.originalContent ?? opts.content ?? "",
    fileHandle: opts.fileHandle || null,
    isDirty: !!opts.isDirty,
    scrollTop: 0,
    selectionStart: 0,
    selectionEnd: 0,
    encoding: opts.encoding || "UTF-8",
    lastKnownModified: opts.lastKnownModified || null,
  };
}

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

// ===================== DOM =====================
const editor = document.getElementById("editor");
const gutter = document.getElementById("gutter");
const mdPreview = document.getElementById("mdPreview");
const tabbar = document.getElementById("tabbar");
const addTabBtn = document.getElementById("addTabBtn");
const statusMsg = document.getElementById("statusMsg");
const lineColEl = document.getElementById("lineCol");
const charCountEl = document.getElementById("charCount");
const wordCountEl = document.getElementById("wordCount");
const lineTotalEl = document.getElementById("lineTotal");
const selectionBox = document.getElementById("selectionBox");
const selectionInfo = document.getElementById("selectionInfo");
const bracketBox = document.getElementById("bracketBox");
const bracketInfo = document.getElementById("bracketInfo");

const openBtn = document.getElementById("openBtn");
const recentBtn = document.getElementById("recentBtn");
const recentMenu = document.getElementById("recentMenu");
const recentList = document.getElementById("recentList");
const newBtn = document.getElementById("newBtn");
const saveBtn = document.getElementById("saveBtn");
const saveAsBtn = document.getElementById("saveAsBtn");
const themeBtn = document.getElementById("themeBtn");
const findBtn = document.getElementById("findBtn");
const wrapBtn = document.getElementById("wrapBtn");
const mdPreviewBtn = document.getElementById("mdPreviewBtn");

const fontDownBtn = document.getElementById("fontDownBtn");
const fontUpBtn = document.getElementById("fontUpBtn");
const fontSizeLabel = document.getElementById("fontSizeLabel");

const encodingBtn = document.getElementById("encodingBtn");
const encodingMenu = document.getElementById("encodingMenu");
const encodingLabel = document.getElementById("encodingLabel");

const toolsBtn = document.getElementById("toolsBtn");
const toolsMenu = document.getElementById("toolsMenu");

const findPanel = document.getElementById("findPanel");
const findInput = document.getElementById("findInput");
const replaceInput = document.getElementById("replaceInput");
const regexToggle = document.getElementById("regexToggle");
const caseToggle = document.getElementById("caseToggle");
const findPrevBtn = document.getElementById("findPrevBtn");
const findNextBtn = document.getElementById("findNextBtn");
const replaceBtn = document.getElementById("replaceBtn");
const replaceAllBtn = document.getElementById("replaceAllBtn");
const findCloseBtn = document.getElementById("findCloseBtn");
const findCount = document.getElementById("findCount");

const gotoPanel = document.getElementById("gotoPanel");
const gotoInput = document.getElementById("gotoInput");
const gotoGoBtn = document.getElementById("gotoGoBtn");
const gotoCloseBtn = document.getElementById("gotoCloseBtn");

const columnPanel = document.getElementById("columnPanel");
const colStartLine = document.getElementById("colStartLine");
const colEndLine = document.getElementById("colEndLine");
const colIndex = document.getElementById("colIndex");
const colInsertText = document.getElementById("colInsertText");
const colDeleteCount = document.getElementById("colDeleteCount");
const colApplyBtn = document.getElementById("colApplyBtn");
const columnCloseBtn = document.getElementById("columnCloseBtn");

const externalChangeBar = document.getElementById("externalChangeBar");
const externalChangeMsg = document.getElementById("externalChangeMsg");
const externalReloadBtn = document.getElementById("externalReloadBtn");
const externalDismissBtn = document.getElementById("externalDismissBtn");

// ===================== 初期化 =====================
init();

let restorePromise = null;

async function init() {
  applyStoredTheme();
  applyStoredWrap();
  applyStoredFontSize();
  registerServiceWorker();
  bindStaticEvents();

  // 1. OSからのファイル受け取り(launchQueue)をアプリ起動時に最優先で登録
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;
      // セッション復元中の場合は完了を待ってからファイルを開く
      if (restorePromise) await restorePromise;
      for (const handle of launchParams.files) {
        await openFileHandleInNewTab(handle);
      }
    });
  }

  // 2. セッション復元を非同期で開始
  restorePromise = restoreSession();
  await restorePromise;
  renderRecentMenu();

  window.addEventListener("focus", () => {
    const tab = getActiveTab();
    if (tab && tab.fileHandle) checkExternalChange(tab);
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

// ===================== セッション復元 =====================
async function restoreSession() {
  const fileAlreadyLoaded = tabs.length > 0;
  const saved = await dbGet("tabs");
  const savedActiveId = await dbGet("activeTabId");

  if (Array.isArray(saved) && saved.length > 0) {
    const restoredTabs = saved.map((t) =>
      makeTab({
        id: t.id,
        name: t.name,
        content: t.content,
        originalContent: t.content,
        fileHandle: t.fileHandle || null,
        isDirty: false,
        encoding: t.encoding || "UTF-8",
        lastKnownModified: t.lastKnownModified || null,
      })
    );

    if (fileAlreadyLoaded) {
      // すでにファイルが開いている場合はバックグラウンドで過去タブを追加復元する
      tabs = [...tabs, ...restoredTabs];
      renderTabs();
    } else {
      tabs = restoredTabs;
      const target = tabs.find((t) => t.id === savedActiveId) || tabs[0];
      switchTab(target.id);
      setStatus("前回のタブを復元しました");
    }
  } else if (!fileAlreadyLoaded) {
    // ファイルが開かれておらず、復元データもない場合のみ空タブを作成
    const first = makeTab({});
    tabs.push(first);
    switchTab(first.id);
  }
}

function scheduleSaveSession() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 600);
}

async function saveSessionNow() {
  const current = getActiveTab();
  saveEditorStateToTab(current);
  const lightweight = tabs.map((t) => ({
    id: t.id,
    name: t.name,
    content: t.content,
    fileHandle: t.fileHandle,
    encoding: t.encoding,
    lastKnownModified: t.lastKnownModified,
  }));
  await dbSet("tabs", lightweight);
  await dbSet("activeTabId", activeTabId);
}

// ===================== テーマ / 折り返し / フォントサイズ =====================
function applyStoredTheme() {
  const saved = localStorage.getItem("inkline-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
}

function applyStoredWrap() {
  const on = localStorage.getItem("inkline-wrap") === "1";
  editor.classList.toggle("wrap-on", on);
}

function applyStoredFontSize() {
  const size = parseInt(localStorage.getItem("inkline-fontsize") || "13", 10);
  setFontSize(size);
}

function setFontSize(size) {
  const clamped = Math.min(28, Math.max(10, size));
  document.documentElement.style.setProperty("--editor-font-size", `${clamped}px`);
  fontSizeLabel.textContent = `${clamped}px`;
  localStorage.setItem("inkline-fontsize", String(clamped));
}

function currentFontSize() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size");
  return parseInt(raw, 10) || 13;
}

// ===================== タブ描画・切替 =====================
function renderTabs() {
  tabbar.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeTabId ? " active" : "");
    el.dataset.id = tab.id;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.name;
    title.title = "ダブルクリックで名前を変更";

    title.addEventListener("click", (e) => {
      e.stopPropagation();
      const now = Date.now();
      const isDoubleClick =
        lastTitleClick.id === tab.id && now - lastTitleClick.time < 400;

      if (isDoubleClick) {
        lastTitleClick = { id: null, time: 0 };
        startRenameTab(tab, el);
        return;
      }

      lastTitleClick = { id: tab.id, time: now };
      if (tab.id !== activeTabId) switchTab(tab.id);
    });

    el.appendChild(title);

    if (tab.isDirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty-dot";
      el.appendChild(dot);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.title = "閉じる";
    closeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => {
      if (tab.id !== activeTabId) switchTab(tab.id);
    });

    tabbar.appendChild(el);
  }
}

function startRenameTab(tab, tabEl) {
  const titleEl = tabEl.querySelector(".tab-title");
  if (!titleEl) return;

  const dotIdx = tab.name.lastIndexOf(".");
  const baseName = dotIdx > 0 ? tab.name.slice(0, dotIdx) : tab.name;
  const ext = dotIdx > 0 ? tab.name.slice(dotIdx) : "";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-input";
  input.value = baseName;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;

  const commit = async () => {
    if (committed) return;
    committed = true;
    const newBase = input.value.trim();
    if (newBase) {
      await renameTab(tab, newBase + ext);
    } else {
      renderTabs();
    }
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      committed = true;
      renderTabs();
    }
  });
  input.addEventListener("blur", commit);
}

async function renameTab(tab, newName) {
  const oldName = tab.name;
  tab.name = newName;

  if (tab.fileHandle) {
    if (typeof tab.fileHandle.move === "function") {
      try {
        await tab.fileHandle.move(newName);
        setStatus(`ファイル名を「${newName}」に変更しました`);
      } catch (err) {
        console.error(err);
        tab.name = oldName;
        setStatus("ファイル名の変更に失敗しました", true);
      }
    } else {
      setStatus("表示名を変更しました(実ファイル名は「名前を付けて保存」で変更してください)");
    }
  } else {
    setStatus("タブ名を変更しました");
  }

  renderTabs();
  scheduleSaveSession();
}

function saveEditorStateToTab(tab) {
  if (!tab) return;
  tab.content = editor.value;
  tab.scrollTop = editor.scrollTop;
  tab.selectionStart = editor.selectionStart;
  tab.selectionEnd = editor.selectionEnd;
}

async function switchTab(id) {
  const current = getActiveTab();
  
  // 【修正点】別のタブへ切替える時のみ現在の画面状態を保存する（同じタブの場合は上書き保存をスキップ）
  if (current && current.id !== id) {
    saveEditorStateToTab(current);
  }

  activeTabId = id;
  const next = getActiveTab();
  if (!next) return;

  editor.value = next.content;
  editor.scrollTop = next.scrollTop;
  editor.setSelectionRange(next.selectionStart, next.selectionEnd);
  gutter.scrollTop = next.scrollTop;

  renderTabs();
  updateGutter();
  updateCounters();
  updateEncodingLabel();
  updateMdPreview();
  hideExternalChangeBar();
  editor.focus();

  if (next.fileHandle) {
    try {
      const granted = await verifyPermission(next.fileHandle);
      if (granted) {
        checkExternalChange(next);
      } else {
        setStatus("このファイルへのアクセス許可が必要です(保存時に再度確認されます)", true);
      }
    } catch {
      // 権限確認エラー時は無視
    }
  }
}

// ===================== タブ閉じる =====================
function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  if (tab.id === activeTabId) saveEditorStateToTab(tab);

  if (tab.isDirty && !confirm(`「${tab.name}」の変更を保存せずに閉じますか?`)) {
    return;
  }

  // 最後の1つのタブを閉じる場合
  if (tabs.length === 1) {
    tab.isDirty = false;
    tabs = [];
    renderTabs();
    editor.value = "";
    updateGutter();
    updateCounters();
    
    // セッション状態をクリア
    dbSet("tabs", []);
    dbSet("activeTabId", null);

    // ウィンドウを閉じる
    window.close();

    // OSやブラウザのセキュリティ制限で window.close() がブロックされた場合のみメッセージ表示
    setTimeout(() => {
      setStatus("ウィンドウを閉じるには右上の「×」ボタンを押してください", true);
    }, 300);
    return;
  }

  const idx = tabs.findIndex((t) => t.id === id);
  tabs.splice(idx, 1);

  if (activeTabId === id) {
    const nextIdx = Math.min(idx, tabs.length - 1);
    switchTab(tabs[nextIdx].id);
  } else {
    renderTabs();
  }
  scheduleSaveSession();
}

  const idx = tabs.findIndex((t) => t.id === id);
  tabs.splice(idx, 1);

  if (activeTabId === id) {
    const nextIdx = Math.min(idx, tabs.length - 1);
    switchTab(tabs[nextIdx].id);
  } else {
    renderTabs();
  }
  scheduleSaveSession();
}
addTabBtn.addEventListener("click", createNewTab);
newBtn.addEventListener("click", createNewTab);

function createNewTab() {
  const tab = makeTab({});
  tabs.push(tab);
  switchTab(tab.id);
  setStatus("新規タブを作成しました");
  scheduleSaveSession();
}

// ===================== 汎用: メニュー開閉 =====================
function setupMenuToggle(btn, menu) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willShow = menu.hidden;
    document.querySelectorAll(".menu").forEach((m) => {
      m.hidden = true;
      m.style.transform = "";
      m.style.maxHeight = "";
      m.querySelectorAll(".menu-category.open").forEach((c) => c.classList.remove("open"));
    });
    if (willShow) {
      menu.hidden = false;
      clampMenuPosition(menu);
    }
  });
}

function clampMenuPosition(menu) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();

  let dx = 0;
  if (rect.right > window.innerWidth - margin) {
    dx = window.innerWidth - margin - rect.right;
  }
  if (rect.left + dx < margin) {
    dx = margin - rect.left;
  }
  menu.style.transform = dx ? `translateX(${dx}px)` : "";

  const availableHeight = window.innerHeight - rect.top - margin;
  if (rect.height > availableHeight) {
    menu.style.maxHeight = `${Math.max(160, availableHeight)}px`;
    menu.style.overflowY = "auto";
  } else {
    menu.style.maxHeight = "";
    menu.style.overflowY = "";
  }
}

function setupToolsCategories() {
  const categories = toolsMenu.querySelectorAll(".menu-category");
  categories.forEach((cat) => {
    let hoverTimer = null;
    const submenu = cat.querySelector(".submenu");

    cat.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      categories.forEach((c) => {
        if (c !== cat) c.classList.remove("open");
      });
      cat.classList.add("open");
      positionSubmenu(cat, submenu);
    });

    cat.addEventListener("mouseleave", () => {
      hoverTimer = setTimeout(() => cat.classList.remove("open"), 200);
    });

    cat.addEventListener("click", (e) => {
      if (e.target.closest(".menu-item")) return;
      const isOpen = cat.classList.contains("open");
      categories.forEach((c) => c.classList.remove("open"));
      if (!isOpen) {
        cat.classList.add("open");
        positionSubmenu(cat, submenu);
      }
    });
  });
}

function positionSubmenu(cat, submenu) {
  const margin = 8;
  const catRect = cat.getBoundingClientRect();

  submenu.style.top = `${catRect.top - 6}px`;
  submenu.style.left = `${catRect.right + 6}px`;
  const rect = submenu.getBoundingClientRect();

  let left = catRect.right + 6;
  if (left + rect.width > window.innerWidth - margin) {
    left = catRect.left - rect.width - 6;
  }
  if (left < margin) left = margin;

  let top = catRect.top - 6;
  if (top + rect.height > window.innerHeight - margin) {
    top = window.innerHeight - margin - rect.height;
  }
  if (top < margin) top = margin;

  submenu.style.left = `${left}px`;
  submenu.style.top = `${top}px`;
}

function bindStaticEvents() {
  setupMenuToggle(toolsBtn, toolsMenu);
  setupMenuToggle(recentBtn, recentMenu);
  setupMenuToggle(encodingBtn, encodingMenu);
  setupToolsCategories();

  document.addEventListener("click", (e) => {
    document.querySelectorAll(".menu").forEach((m) => {
      const owner = m.previousElementSibling;
      if (!m.hidden && !m.contains(e.target) && e.target !== owner && !owner?.contains(e.target)) {
        m.hidden = true;
        m.style.transform = "";
        m.style.maxHeight = "";
        m.querySelectorAll(".menu-category.open").forEach((c) => c.classList.remove("open"));
      }
    });
  });

  toolsMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".menu-item");
    if (!btn) return;
    const action = btn.dataset.action;
    toolsMenu.hidden = true;
    toolsMenu.querySelectorAll(".menu-category.open").forEach((c) => c.classList.remove("open"));
    if (action === "gotoLine") {
      setGotoPanel(true);
    } else if (action === "insertTimestamp") {
      insertTimestamp();
    } else if (action === "columnEdit") {
      openColumnPanel();
    } else {
      runTool(action);
    }
  });

  encodingMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".menu-item[data-enc]");
    if (!btn) return;
    encodingMenu.hidden = true;
    reDecodeCurrentTab(btn.dataset.enc);
  });

  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("inkline-theme", next);
  });

  wrapBtn.addEventListener("click", () => {
    const on = editor.classList.toggle("wrap-on");
    localStorage.setItem("inkline-wrap", on ? "1" : "0");
    setStatus(on ? "折り返し: ON" : "折り返し: OFF");
  });

  fontDownBtn.addEventListener("click", () => setFontSize(currentFontSize() - 1));
  fontUpBtn.addEventListener("click", () => setFontSize(currentFontSize() + 1));

  mdPreviewBtn.addEventListener("click", toggleMdPreview);

  externalReloadBtn.addEventListener("click", async () => {
    const tab = getActiveTab();
    if (!tab || !tab.fileHandle) return;
    await reloadTabFromDisk(tab);
    hideExternalChangeBar();
  });
  externalDismissBtn.addEventListener("click", async () => {
    const tab = getActiveTab();
    hideExternalChangeBar();
    if (!tab || !tab.fileHandle) return;
    try {
      const file = await tab.fileHandle.getFile();
      tab.lastKnownModified = file.lastModified;
      scheduleSaveSession();
    } catch {
      // 無視
    }
  });

  gotoCloseBtn.addEventListener("click", () => setGotoPanel(false));
  gotoGoBtn.addEventListener("click", goToLine);
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToLine();
    if (e.key === "Escape") setGotoPanel(false);
  });

  columnCloseBtn.addEventListener("click", () => (columnPanel.hidden = true));
  colApplyBtn.addEventListener("click", applyColumnEdit);

  // ドラッグ＆ドロップによるファイル読み込み対応
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;

    if (e.dataTransfer.items) {
      for (const item of e.dataTransfer.items) {
        if (item.kind === "file") {
          if (typeof item.getAsFileSystemHandle === "function") {
            const handle = await item.getAsFileSystemHandle();
            if (handle && handle.kind === "file") {
              await openFileHandleInNewTab(handle);
              continue;
            }
          }
          const file = item.getAsFile();
          if (file) await openRawFileInNewTab(file);
        }
      }
    }
  });
}

// ===================== ツール(文字変換・行操作) =====================
function runTool(action) {
  const text = editor.value;
  const lines = text.split(/\r\n|\n/);
  let result = text;

  switch (action) {
    case "upper":
      result = text.toUpperCase();
      break;
    case "lower":
      result = text.toLowerCase();
      break;
    case "title":
      result = text.replace(/\b\w/g, (c) => c.toUpperCase());
      break;
    case "sortAsc":
      result = lines.slice().sort((a, b) => a.localeCompare(b, "ja")).join("\n");
      break;
    case "sortDesc":
      result = lines.slice().sort((a, b) => b.localeCompare(a, "ja")).join("\n");
      break;
    case "reverseLines":
      result = lines.slice().reverse().join("\n");
      break;
    case "dedupe": {
      const seen = new Set();
      const out = [];
      for (const l of lines) {
        if (!seen.has(l)) {
          seen.add(l);
          out.push(l);
        }
      }
      result = out.join("\n");
      setStatus(`${lines.length - out.length} 行の重複を削除しました`);
      break;
    }
    case "removeBlank":
      result = lines.filter((l) => l.trim() !== "").join("\n");
      break;
    case "trimTrailing":
      result = lines.map((l) => l.replace(/[ \t]+$/, "")).join("\n");
      break;
    case "insertLineNumbers":
      result = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
      break;
    case "tabToSpace":
      result = text.replace(/\t/g, "    ");
      break;
    case "spaceToTab":
      result = lines.map((l) => l.replace(/^( {4})+/g, (m) => "\t".repeat(m.length / 4))).join("\n");
      break;
    case "eolToLF":
      result = text.replace(/\r\n/g, "\n");
      setStatus("改行コードをLFに統一しました");
      break;
    case "eolToCRLF":
      result = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      setStatus("改行コードをCRLFに統一しました");
      break;
  }

  if (result !== text) {
    const pos = editor.selectionStart;
    editor.value = result;
    editor.selectionStart = editor.selectionEnd = Math.min(pos, result.length);
    editor.dispatchEvent(new Event("input"));
    if (!statusMsg.textContent.includes("削除") && !statusMsg.textContent.includes("統一")) {
      setStatus("変換しました");
    }
  }
}

// ===================== 現在日時の挿入 =====================
function insertTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(stamp, start, end, "end");
  editor.dispatchEvent(new Event("input"));
  editor.focus();
  setStatus("現在日時を挿入しました");
}

// ===================== 行へ移動 =====================
function setGotoPanel(show) {
  gotoPanel.hidden = !show;
  if (show) {
    gotoInput.value = "";
    gotoInput.focus();
  }
}

function goToLine() {
  const n = parseInt(gotoInput.value, 10);
  if (!n || n < 1) return;
  const lines = editor.value.split("\n");
  const targetLine = Math.min(n, lines.length);
  let index = 0;
  for (let i = 0; i < targetLine - 1; i++) {
    index += lines[i].length + 1;
  }
  editor.focus();
  editor.setSelectionRange(index, index + (lines[targetLine - 1]?.length || 0));
  scrollSelectionIntoView();
  updateCursorPos();
  setGotoPanel(false);
  setStatus(`${targetLine} 行目へ移動しました`);
}

// ===================== 簡易矩形編集(列指定 挿入/削除) =====================
function openColumnPanel() {
  const lines = editor.value.split("\n");
  const startPos = editor.selectionStart;
  const endPos = editor.selectionEnd;
  const startLine = editor.value.slice(0, startPos).split("\n").length;
  const endLine = editor.value.slice(0, endPos).split("\n").length;

  colStartLine.value = startLine;
  colEndLine.value = endLine;
  colIndex.value = 1;
  colInsertText.value = "";
  colDeleteCount.value = 0;
  colStartLine.max = lines.length;
  colEndLine.max = lines.length;

  columnPanel.hidden = false;
  colInsertText.focus();
}

function applyColumnEdit() {
  const lines = editor.value.split("\n");
  const s = Math.max(1, parseInt(colStartLine.value, 10) || 1);
  const e = Math.min(lines.length, parseInt(colEndLine.value, 10) || 1);
  const col = Math.max(1, parseInt(colIndex.value, 10) || 1);
  const insertText = colInsertText.value;
  const delCount = Math.max(0, parseInt(colDeleteCount.value, 10) || 0);

  if (s > e) {
    setStatus("開始行が終了行より後になっています", true);
    return;
  }

  for (let i = s - 1; i <= e - 1; i++) {
    const line = lines[i] ?? "";
    const idx = Math.min(col - 1, line.length);
    const before = line.slice(0, idx);
    const afterDeleted = line.slice(idx + delCount);
    lines[i] = before + insertText + afterDeleted;
  }

  editor.value = lines.join("\n");
  editor.dispatchEvent(new Event("input"));
  columnPanel.hidden = true;
  setStatus(`${s}〜${e}行目の${col}列目を編集しました`);
}

// ===================== 文字コード(エンコーディング) =====================
function decodeBuffer(buffer) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" };
  } catch {
    try {
      return { text: new TextDecoder("shift_jis").decode(buffer), encoding: "Shift_JIS" };
    } catch {
      return { text: new TextDecoder("utf-8").decode(buffer), encoding: "UTF-8" };
    }
  }
}

function updateEncodingLabel() {
  const tab = getActiveTab();
  encodingLabel.textContent = tab ? tab.encoding : "UTF-8";
}

async function reDecodeCurrentTab(encoding) {
  const tab = getActiveTab();
  if (!tab || !tab.fileHandle) {
    setStatus("保存済みファイルのみ再読み込みできます", true);
    return;
  }
  try {
    const file = await tab.fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    const text =
      encoding === "Shift_JIS"
        ? new TextDecoder("shift_jis").decode(buffer)
        : new TextDecoder("utf-8").decode(buffer);

    tab.content = text;
    tab.originalContent = text;
    tab.encoding = encoding;
    tab.isDirty = false;

    if (tab.id === activeTabId) {
      editor.value = text;
      updateGutter();
      updateCounters();
      updateMdPreview();
    }
    updateEncodingLabel();
    renderTabs();
    setStatus(`${encoding} として読み込み直しました`);
    scheduleSaveSession();
  } catch (err) {
    console.error(err);
    setStatus("読み込み直しに失敗しました", true);
  }
}

// ===================== 権限確認 =====================
async function verifyPermission(handle, mode = "readwrite") {
  try {
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  } catch {
    return false;
  }
}

// ===================== ファイル操作 =====================
openBtn.addEventListener("click", async () => {
  if (!("showOpenFilePicker" in window)) {
    setStatus("このブラウザはファイル直接読み込みに対応していません", true);
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: "サポートしているファイル",
          accept: {
            "text/plain": [".txt", ".md", ".log", ".csv", ".json"],
            "text/html": [".html", ".htm"],
            "text/javascript": [".js"],
            "text/css": [".css"]
          },
        },
      ],
    });
    for (const handle of handles) {
      await openFileHandleInNewTab(handle);
    }
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  }
});

async function openFileHandleInNewTab(handle) {
  try {
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    const { text, encoding } = decodeBuffer(buffer);

    // 未編集の空タブがあればそれを上書き利用する
    const activeTab = getActiveTab();
    const activeIsBlank = activeTab && !activeTab.fileHandle && !activeTab.isDirty && activeTab.content === "";
    const unusedBlankTab = tabs.find((t) => !t.fileHandle && !t.isDirty && t.content === "");

    let tab;
    if (activeIsBlank) {
      tab = activeTab;
    } else if (unusedBlankTab) {
      tab = unusedBlankTab;
    } else {
      tab = makeTab({ name: file.name });
      tabs.push(tab);
    }

    tab.name = file.name;
    tab.content = text;
    tab.originalContent = text;
    tab.fileHandle = handle;
    tab.isDirty = false;
    tab.encoding = encoding;
    tab.lastKnownModified = file.lastModified;

    switchTab(tab.id);
    setStatus(`「${file.name}」を開きました(${encoding})`);
    await addRecent(file.name, handle);
    renderRecentMenu();
    scheduleSaveSession();
  } catch (err) {
    console.error(err);
    setStatus("ファイルを開けませんでした", true);
  }
}

// 通常のFileオブジェクトから新規タブで開く処理（Drag & Drop用）
async function openRawFileInNewTab(file) {
  try {
    const buffer = await file.arrayBuffer();
    const { text, encoding } = decodeBuffer(buffer);

    const blank = tabs.find((t) => !t.fileHandle && !t.isDirty && t.content === "" && t.id !== activeTabId);
    const activeIsBlank = getActiveTab() && !getActiveTab().fileHandle && !getActiveTab().isDirty && getActiveTab().content === "" && tabs.length === 1;

    let tab = activeIsBlank ? getActiveTab() : (blank || makeTab({ name: file.name }));
    if (!activeIsBlank && !blank) tabs.push(tab);

    tab.name = file.name;
    tab.content = text;
    tab.originalContent = text;
    tab.fileHandle = null;
    tab.isDirty = false;
    tab.encoding = encoding;

    switchTab(tab.id);
    setStatus(`「${file.name}」を開きました(${encoding})`);
    scheduleSaveSession();
  } catch (err) {
    console.error(err);
    setStatus("ファイルを開けませんでした", true);
  }
}

saveBtn.addEventListener("click", () => saveFile(false));
saveAsBtn.addEventListener("click", () => saveFile(true));

// ===================== ファイル保存 =====================
async function saveFile(forceSaveAs) {
  const tab = getActiveTab();
  if (!tab) return;
  saveEditorStateToTab(tab);
  const text = tab.content;

  if (!("showSaveFilePicker" in window)) {
    downloadFallback(tab, text);
    return;
  }

  try {
    if (!tab.fileHandle || forceSaveAs) {
      // 拡張子が含まれていない場合は自動で .txt を付与
      let suggestedName = tab.name || "無題のファイル.txt";
      if (!suggestedName.includes(".")) {
        suggestedName += ".txt";
      }

      const ext = suggestedName.split(".").pop().toLowerCase();
      const mimeTypes = {
        js: { "text/javascript": [".js"] },
        html: { "text/html": [".html", ".htm"] },
        css: { "text/css": [".css"] },
        json: { "application/json": [".json"] },
        txt: { "text/plain": [".txt"] },
        md: { "text/markdown": [".md"] }
      };
      const acceptObj = mimeTypes[ext] || { "text/plain": [`.${ext}`] };

      tab.fileHandle = await window.showSaveFilePicker({
        suggestedName: suggestedName,
        types: [{ description: "ファイル", accept: acceptObj }],
      });
    }
    const writable = await tab.fileHandle.createWritable();
    await writable.write(text);
    await writable.close();

    const savedFile = await tab.fileHandle.getFile();
    tab.originalContent = text;
    tab.name = tab.fileHandle.name;
    tab.lastKnownModified = savedFile.lastModified;
    const wasNonUtf8 = tab.encoding !== "UTF-8";
    tab.encoding = "UTF-8";

    setTabDirty(tab, false);
    updateEncodingLabel();
    hideExternalChangeBar();
    setStatus(wasNonUtf8 ? "保存しました(UTF-8に変換されました)" : "保存しました");
    await addRecent(tab.name, tab.fileHandle);
    renderRecentMenu();
    scheduleSaveSession();
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      setStatus("保存に失敗しました", true);
    }
  }
}

function downloadFallback(tab, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = tab.name.includes(".") ? tab.name : `${tab.name}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  tab.originalContent = text;
  setTabDirty(tab, false);
  setStatus("ダウンロードしました(このブラウザは直接保存に非対応です)");
}

// ===================== 外部変更の検知 =====================
async function checkExternalChange(tab) {
  if (!tab || !tab.fileHandle) return;
  try {
    const granted = await verifyPermission(tab.fileHandle, "read");
    if (!granted) return;
    const file = await tab.fileHandle.getFile();
    if (tab.lastKnownModified && file.lastModified !== tab.lastKnownModified) {
      if (tab.isDirty) {
        showExternalChangeBar(tab);
      } else {
        await reloadTabFromDisk(tab, true);
      }
    }
  } catch {
    // 静かに無視
  }
}

async function reloadTabFromDisk(tab, silent) {
  try {
    const file = await tab.fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    const { text, encoding } = decodeBuffer(buffer);
    tab.content = text;
    tab.originalContent = text;
    tab.encoding = encoding;
    tab.lastKnownModified = file.lastModified;
    setTabDirty(tab, false);

    if (tab.id === activeTabId) {
      editor.value = text;
      updateGutter();
      updateCounters();
      updateMdPreview();
      updateEncodingLabel();
    }
    if (!silent) setStatus("最新の内容を読み込みました");
    scheduleSaveSession();
  } catch (err) {
    console.error(err);
  }
}

function showExternalChangeBar(tab) {
  externalChangeMsg.textContent = `「${tab.name}」は他の場所で更新されています。現在の編集内容を残しますか、最新の内容を読み込みますか?`;
  externalChangeBar.hidden = false;
}

function hideExternalChangeBar() {
  externalChangeBar.hidden = true;
}

// ===================== 最近使ったファイル =====================
async function addRecent(name, handle) {
  let list = (await dbGet("recent")) || [];
  list = list.filter((r) => r.name !== name);
  list.unshift({ name, handle, lastOpened: Date.now() });
  list = list.slice(0, 8);
  await dbSet("recent", list);
}

async function renderRecentMenu() {
  const list = (await dbGet("recent")) || [];
  recentList.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "まだ履歴がありません";
    recentList.appendChild(empty);
    return;
  }
  for (const item of list) {
    const btn = document.createElement("button");
    btn.className = "menu-item";
    btn.textContent = item.name;
    btn.title = item.name;
    btn.addEventListener("click", async () => {
      recentMenu.hidden = true;
      const granted = await verifyPermission(item.handle);
      if (!granted) {
        setStatus("このファイルへのアクセスが許可されませんでした", true);
        return;
      }
      await openFileHandleInNewTab(item.handle);
    });
    recentList.appendChild(btn);
  }
}

// ===================== 自動保存 & 入力監視 =====================
editor.addEventListener("input", () => {
  const tab = getActiveTab();
  if (!tab) return;
  tab.content = editor.value;
  setTabDirty(tab, tab.content !== tab.originalContent);
  updateGutter();
  updateCounters();
  updateMdPreview();
  scheduleSaveSession();

  if (tab.fileHandle) {
    clearTimeout(saveTimer);
    setStatus("自動保存を待機中…");
    saveTimer = setTimeout(() => saveFile(false), 900);
  }
});

editor.addEventListener("keyup", () => {
  updateCursorPos();
  updateSelectionInfo();
  updateBracketInfo();
});
editor.addEventListener("click", () => {
  updateCursorPos();
  updateSelectionInfo();
  updateBracketInfo();
});
editor.addEventListener("select", updateSelectionInfo);
editor.addEventListener("scroll", () => {
  gutter.scrollTop = editor.scrollTop;
});

function setTabDirty(tab, dirty) {
  tab.isDirty = dirty;
  renderTabs();
}

function setStatus(msg, isError) {
  statusMsg.textContent = msg;
  statusMsg.style.color = isError ? "var(--danger)" : "var(--text-dim)";
}

// ===================== 行番号ガター =====================
function updateGutter() {
  const lines = editor.value.split("\n").length;
  let out = "";
  for (let i = 1; i <= lines; i++) out += i + "\n";
  gutter.textContent = out;
}

// ===================== カウンター類 =====================
function updateCounters() {
  const text = editor.value;
  charCountEl.textContent = text.length.toLocaleString();
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  wordCountEl.textContent = words.toLocaleString();
  lineTotalEl.textContent = text.split("\n").length.toLocaleString();
  updateCursorPos();
  updateSelectionInfo();
  updateBracketInfo();
}

function updateCursorPos() {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  lineColEl.textContent = `${line}:${col}`;
}

function updateSelectionInfo() {
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  if (s === e) {
    selectionBox.hidden = true;
    return;
  }
  const selected = editor.value.slice(s, e);
  const lineCount = selected.split("\n").length;
  selectionInfo.textContent = `${selected.length}文字 / ${lineCount}行`;
  selectionBox.hidden = false;
}

// ===================== 対応する括弧の表示 =====================
const OPEN_BRACKETS = { "(": ")", "[": "]", "{": "}" };
const CLOSE_BRACKETS = { ")": "(", "]": "[", "}": "{" };

function updateBracketInfo() {
  const pos = editor.selectionStart;
  const text = editor.value;
  const charAfter = text[pos];
  const charBefore = text[pos - 1];

  let matchIndex = -1;

  if (charAfter && OPEN_BRACKETS[charAfter]) {
    matchIndex = findMatchingBracket(text, pos, charAfter, OPEN_BRACKETS[charAfter], 1);
  } else if (charBefore && CLOSE_BRACKETS[charBefore]) {
    matchIndex = findMatchingBracket(text, pos - 1, charBefore, CLOSE_BRACKETS[charBefore], -1);
  }

  if (matchIndex === -1) {
    bracketBox.hidden = true;
    return;
  }

  const before = text.slice(0, matchIndex);
  const line = before.split("\n").length;
  const col = matchIndex - before.lastIndexOf("\n");
  bracketInfo.textContent = `${line}:${col}`;
  bracketBox.hidden = false;
}

function findMatchingBracket(text, startIndex, openChar, closeChar, dir) {
  let depth = 0;
  let i = startIndex;
  while (i >= 0 && i < text.length) {
    if (text[i] === openChar) depth += 1;
    else if (text[i] === closeChar) depth -= 1;
    if (depth === 0 && i !== startIndex) return i;
    i += dir;
  }
  return -1;
}

// ===================== Markdownプレビュー =====================
let mdPreviewOn = false;

function toggleMdPreview() {
  mdPreviewOn = !mdPreviewOn;
  mdPreview.hidden = !mdPreviewOn;
  mdPreviewBtn.style.color = mdPreviewOn ? "var(--accent)" : "";
  if (mdPreviewOn) updateMdPreview();
}

function updateMdPreview() {
  if (!mdPreviewOn) return;
  if (typeof marked === "undefined") {
    mdPreview.textContent = "プレビューライブラリの読み込みに失敗しました(オフラインの可能性があります)";
    return;
  }
  try {
    mdPreview.innerHTML = marked.parse(editor.value || "");
  } catch (err) {
    mdPreview.textContent = "プレビューの表示に失敗しました";
  }
}

// ===================== 検索・置換 =====================
findBtn.addEventListener("click", toggleFindPanel);
findCloseBtn.addEventListener("click", () => setFindPanel(false));

function toggleFindPanel() {
  setFindPanel(findPanel.hidden);
}

function setFindPanel(show) {
  findPanel.hidden = !show;
  if (show) {
    findInput.focus();
    findInput.select();
    countMatches();
  }
}

function buildRegex(query) {
  if (!query) return null;
  const flags = "g" + (caseToggle.checked ? "" : "i");
  if (regexToggle.checked) {
    try {
      return new RegExp(query, flags);
    } catch {
      return null;
    }
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, flags);
}

findInput.addEventListener("input", countMatches);
regexToggle.addEventListener("change", countMatches);
caseToggle.addEventListener("change", countMatches);

function countMatches() {
  const re = buildRegex(findInput.value);
  if (!re) {
    findCount.textContent = regexToggle.checked && findInput.value ? "正規表現エラー" : "";
    return;
  }
  const matches = editor.value.match(re);
  findCount.textContent = matches ? `${matches.length} 件` : "0 件";
}

findNextBtn.addEventListener("click", () => jumpToMatch(1));
findPrevBtn.addEventListener("click", () => jumpToMatch(-1));

function jumpToMatch(dir) {
  const re = buildRegex(findInput.value);
  if (!re) return;
  const text = editor.value;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) {
    setStatus("見つかりませんでした", true);
    return;
  }

  const cur = editor.selectionEnd;
  let target;
  if (dir === 1) {
    target = matches.find((m) => m.index >= cur) || matches[0];
  } else {
    const before = matches.filter((m) => m.index < editor.selectionStart);
    target = before.length ? before[before.length - 1] : matches[matches.length - 1];
  }

  editor.focus();
  editor.setSelectionRange(target.index, target.index + target[0].length);
  scrollSelectionIntoView();
  updateSelectionInfo();
}

function scrollSelectionIntoView() {
  const lineHeight = currentFontSize() * 1.7;
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split("\n").length;
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  gutter.scrollTop = editor.scrollTop;
}

replaceBtn.addEventListener("click", () => {
  const re = buildRegex(findInput.value);
  if (!re) return;
  const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const singleRe = new RegExp(re.source, re.flags.replace("g", ""));
  if (singleRe.test(sel)) {
    const start = editor.selectionStart;
    const replaced = sel.replace(singleRe, replaceInput.value);
    editor.setRangeText(replaced, start, start + sel.length, "end");
    editor.dispatchEvent(new Event("input"));
  }
  jumpToMatch(1);
});

replaceAllBtn.addEventListener("click", () => {
  const re = buildRegex(findInput.value);
  if (!re) return;
  const matches = editor.value.match(re);
  const count = matches ? matches.length : 0;
  editor.value = editor.value.replace(re, replaceInput.value);
  editor.dispatchEvent(new Event("input"));
  setStatus(`${count} 件を置換しました`);
  countMatches();
});

// ===================== キーボードショートカット =====================
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveFile(e.shiftKey);
  } else if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openBtn.click();
  } else if (mod && e.key.toLowerCase() === "n") {
    e.preventDefault();
    createNewTab();
  } else if (mod && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  } else if (mod && e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    setFindPanel(true);
  } else if (mod && e.key.toLowerCase() === "g") {
    e.preventDefault();
    setGotoPanel(true);
  } else if (mod && (e.key === "+" || e.key === "=")) {
    e.preventDefault();
    setFontSize(currentFontSize() + 1);
  } else if (mod && e.key === "-") {
    e.preventDefault();
    setFontSize(currentFontSize() - 1);
  } else if (e.key === "Escape") {
    if (!findPanel.hidden) setFindPanel(false);
    if (!gotoPanel.hidden) setGotoPanel(false);
    if (!columnPanel.hidden) columnPanel.hidden = true;
    if (!toolsMenu.hidden) toolsMenu.hidden = true;
  }
});

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const nextIdx = (idx + dir + tabs.length) % tabs.length;
  switchTab(tabs[nextIdx].id);
}

// ===================== 離脱前の警告 =====================
window.addEventListener("beforeunload", (e) => {
  saveEditorStateToTab(getActiveTab());
  saveSessionNow();
  if (tabs.some((t) => t.isDirty)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
