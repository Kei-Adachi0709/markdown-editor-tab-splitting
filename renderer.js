/**
 * Markdown IDE - Main Renderer Process
 * Integrated layout with full Markdown functionality (CodeMirror 6) and Terminal Support
 * Refactored LayoutManager for robust split/merge behavior.
 */

// renderer.js の先頭に追加
window.addEventListener('error', (event) => {
    console.error("🔥 [Global Error]:", event.error);
});
window.addEventListener('unhandledrejection', (event) => {
    console.error("🔥 [Unhandled Rejection]:", event.reason);
});
console.log("🚀 [Debug] Renderer script loaded. Logging enabled.");

const path = require('path');
const { EditorState, Prec, Compartment, Annotation } = require("@codemirror/state");
const { EditorView, keymap, highlightActiveLine, lineNumbers } = require("@codemirror/view");
const { defaultKeymap, history, historyKeymap, undo, redo, indentMore, indentLess } = require("@codemirror/commands");
const { markdown, markdownLanguage } = require("@codemirror/lang-markdown");
const { syntaxHighlighting, defaultHighlightStyle, LanguageDescription, indentUnit } = require("@codemirror/language");
const { javascript } = require("@codemirror/lang-javascript");
const { oneDark } = require("@codemirror/theme-one-dark");
const { livePreviewPlugin } = require("./livePreviewPlugin.js");
const { tablePlugin } = require("./tablePlugin.js");

// プログラムによる変更を識別するためのアノテーション
const ExternalChange = Annotation.define();

console.log('[Renderer] Script started');

// ========== DOM要素取得 ==========
const ideContainer = document.getElementById('ide-container');
const leftPane = document.getElementById('left-pane');
const rightPane = document.getElementById('right-pane');
const rightActivityBar = document.querySelector('.right-activity-bar');
const bottomPane = document.getElementById('bottom-pane');
const centerPane = document.getElementById('center-pane');

// トップバー操作
const btnToggleLeftPane = document.getElementById('btn-toggle-leftpane');
const topSideSwitchButtons = document.querySelectorAll('.side-switch');

// ウィンドウコントロール
const btnToggleRightActivity = document.getElementById('btn-toggle-right-activity');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');

// 左ペイン
const leftPaneHeader = document.getElementById('left-pane-header');
const leftPaneContents = document.querySelectorAll('.left-pane-content');
const btnTerminalRight = document.getElementById('btn-terminal-right');
const btnTogglePosition = document.getElementById('btn-toggle-position');

// 左アクティビティバー
const btnZen = document.getElementById('btn-zen');
const btnSettings = document.getElementById('btn-settings');
const btnPdfPreview = document.getElementById('btn-pdf-preview');
const btnRightMarkdown = document.getElementById('btn-right-markdown'); // ★ここに追加

// エディタコンテナ (マルチペイン対応のためルートコンテナ)
const paneRoot = document.getElementById('pane-root');
const dropOverlay = document.getElementById('drop-overlay');
const dropIndicator = document.getElementById('drop-indicator');

// ターミナルコンテナ
const terminalContainer = document.getElementById('terminal-container');
const terminalBottomContainer = document.getElementById('terminal-bottom-container');

// 設定画面
const contentSettings = document.getElementById('content-settings');

// ファイルタイトル入力
const fileTitleBar = document.getElementById('file-title-bar');
const fileTitleInput = document.getElementById('file-title-input');

// ファイル統計情報
const fileStatsElement = document.getElementById('file-stats');

// ツールバーボタン
const headingSelector = document.getElementById('heading-selector');
const btnBulletList = document.getElementById('btn-bullet-list');
const btnNumberList = document.getElementById('btn-number-list');
const btnCheckList = document.getElementById('btn-check-list');

// ========== 状態管理 ==========
let isPositionRight = true;
let isTerminalVisible = false;
let isRightActivityBarVisible = true;
let isRightMarkdownVisible = false; // ★ここに追加
let isMaximized = false;
let savedRightActivityBarState = true;
let activeLayoutManager = null; // ★追加
let mainLayoutManager = null;   // ★追加
let rightLayoutManager = null;  // ★追加


// 設定管理
let appSettings = {
    fontSize: '16px',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    theme: 'light',
    autoSave: true
};

// CodeMirror Compartments for dynamic reconfiguration
const themeCompartment = new Compartment();
const editorStyleCompartment = new Compartment();

// ========== PDF Preview State ==========
let isPdfPreviewVisible = false;
let pdfDocument = null;
let pdfjsLib = null; // Dynamically loaded

// PDF.js loading logic
async function loadPdfJs() {
    if (pdfjsLib) return pdfjsLib;

    try {
        const pdfjsPath = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs');
        const workerPath = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
        
        const pdfjsUrl = 'file:///' + pdfjsPath.replace(/\\/g, '/');
        const workerUrl = 'file:///' + workerPath.replace(/\\/g, '/');

        const loadedLib = await import(pdfjsUrl);
        loadedLib.GlobalWorkerOptions.workerSrc = workerUrl;
        pdfjsLib = loadedLib;
        return pdfjsLib;
    } catch (e) {
        console.error("Failed to load PDF.js:", e);
        return null;
    }
}

// ========== Terminal Integration State ==========
const terminals = new Map();
let activeTerminalId = null;
let terminalConfig = null;
let availableShells = [];

// Terminal DOM Elements
const terminalTabsList = document.getElementById('terminal-tabs-list');
const newTerminalBtn = document.getElementById('new-terminal-btn');
const dropdownToggle = document.getElementById('dropdown-toggle');
const shellDropdown = document.getElementById('shell-dropdown');

// File System State
let currentDirectoryPath = null;
let openedFiles = new Map(); // Map<filePath, {content: string, fileName: string}>
let fileModificationState = new Map();
let currentSortOrder = 'asc';


// ========== CodeMirror Helpers & Keymaps ==========

const codeLanguages = (info) => {
    const lang = String(info).trim().toLowerCase();
    if (!lang) return null;

    if (lang === 'js' || lang === 'javascript' || lang === 'node') return LanguageDescription.of({ name: 'javascript', support: javascript() });
    if (lang === 'html' || lang === 'htm') return LanguageDescription.of({ name: 'html', support: require("@codemirror/lang-html").html() });
    if (lang === 'css' || lang === 'scss') return LanguageDescription.of({ name: 'css', support: require("@codemirror/lang-css").css() });
    if (lang === 'py' || lang === 'python') return LanguageDescription.of({ name: 'python', support: require("@codemirror/lang-python").python() });
    if (lang === 'md' || lang === 'markdown') return LanguageDescription.of({ name: 'markdown', support: require("@codemirror/lang-markdown").markdown() });

    return null;
};

// リスト操作ロジック
const LIST_RE = /^(\s*)((- \[[ xX]\])|(?:[-*+]|\d+(?:-\d+)*\.))\s+/;
const ORDERED_RE = /^(\s*)(\d+(?:-\d+)*)\.\s/;

function incrementOrderedNumber(currentNum) {
    const parts = currentNum.split('-');
    const lastPart = parts.pop();
    if (!isNaN(lastPart)) {
        parts.push(String(parseInt(lastPart, 10) + 1));
        return parts.join('-');
    }
    return currentNum;
}

const handleListNewline = (view) => {
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection.main;
    if (!empty) return false;

    const line = state.doc.lineAt(from);
    const text = line.text;

    const match = text.match(LIST_RE);
    if (!match) return false;

    const fullMatch = match[0];
    const indent = match[1];
    const marker = match[2];

    if (from < line.from + fullMatch.length) return false;

    if (text.trim().length === fullMatch.trim().length) {
        dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
        return true;
    }

    let nextMarker = marker;

    const orderedMatch = text.match(ORDERED_RE);
    if (orderedMatch) {
        const currentNum = orderedMatch[2];
        nextMarker = incrementOrderedNumber(currentNum) + ".";
    } else if (marker.startsWith("- [")) {
        nextMarker = "- [ ]";
    }

    const insertText = `\n${indent}${nextMarker} `;
    dispatch({ changes: { from: to, insert: insertText }, selection: { anchor: to + insertText.length } });
    return true;
};

const handleListIndent = (view) => {
    const { state, dispatch } = view;
    const { from, empty } = state.selection.main;

    if (!empty && state.selection.ranges.some(r => !r.empty)) {
        return indentMore(view);
    }

    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(ORDERED_RE);

    if (match) {
        const currentIndent = match[1];
        const currentNum = match[2];

        let prevLineNumStr = "";
        if (line.number > 1) {
            const prevLine = state.doc.line(line.number - 1);
            const prevMatch = prevLine.text.match(ORDERED_RE);
            if (prevMatch) {
                prevLineNumStr = prevMatch[2];
            }
        }

        const newNum = prevLineNumStr ? `${prevLineNumStr}-1` : `${currentNum}-1`;
        const newMarker = `${newNum}.`;

        const indentUnitText = "    ";
        const changes = [
            { from: line.from, insert: indentUnitText },
            { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker }
        ];

        dispatch({ changes });
        return true;
    }

    return indentMore(view);
};

const handleListDedent = (view) => {
    const { state, dispatch } = view;
    const { from, empty } = state.selection.main;

    if (!empty && state.selection.ranges.some(r => !r.empty)) {
        return indentLess(view);
    }

    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(ORDERED_RE);

    if (match) {
        const currentIndent = match[1];
        if (currentIndent.length === 0) return indentLess(view);

        let targetIndentLen = Math.max(0, currentIndent.length - 4);
        let nextNum = "1";

        for (let i = line.number - 1; i >= 1; i--) {
            const prevLine = state.doc.line(i);
            const prevMatch = prevLine.text.match(ORDERED_RE);

            if (prevMatch) {
                const prevIndent = prevMatch[1];
                if (prevIndent.length <= targetIndentLen) {
                    nextNum = incrementOrderedNumber(prevMatch[2]);
                    break;
                }
            }
        }

        const newMarker = `${nextNum}.`;

        let deleteLen = 0;
        if (text.startsWith("\t")) deleteLen = 1;
        else if (text.startsWith("    ")) deleteLen = 4;
        else if (text.startsWith(" ")) deleteLen = currentIndent.length;

        if (deleteLen > 0) {
            const changes = [
                { from: line.from, to: line.from + deleteLen, insert: "" },
                { from: line.from + match[1].length, to: line.from + match[1].length + match[2].length + 1, insert: newMarker }
            ];
            dispatch({ changes });
            return true;
        }
    }

    return indentLess(view);
};

const obsidianLikeListKeymap = [
    { key: "Enter", run: handleListNewline },
    { key: "Tab", run: handleListIndent },
    { key: "Shift-Tab", run: handleListDedent }
];

// ペースト処理
function showPasteOptionModal(url, view) {
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = '400px';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = `URLが検出されました: ${url}\nどのように貼り付けますか？`;
    message.style.whiteSpace = 'pre-wrap';
    message.style.wordBreak = 'break-all';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';

    const plainBtn = document.createElement('button');
    plainBtn.className = 'modal-btn';
    plainBtn.textContent = '通常のURL';

    const linkBtn = document.createElement('button');
    linkBtn.className = 'modal-btn';
    linkBtn.textContent = 'リンク';

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'modal-btn primary';
    bookmarkBtn.textContent = 'ブックマーク';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(plainBtn);
    buttons.appendChild(linkBtn);
    buttons.appendChild(bookmarkBtn);

    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const closeModal = () => {
        overlay.remove();
        if (view) view.focus();
    };

    cancelBtn.addEventListener('click', closeModal);

    plainBtn.addEventListener('click', () => {
        view.dispatch(view.state.replaceSelection(url));
        closeModal();
    });

    linkBtn.addEventListener('click', async () => {
        linkBtn.disabled = true;
        linkBtn.textContent = '取得中...';

        try {
            let title = url;
            if (window.electronAPI && window.electronAPI.fetchUrlTitle) {
                title = await window.electronAPI.fetchUrlTitle(url);
            }
            view.dispatch(view.state.replaceSelection(`[${title}](${url})`));
            showNotification('リンクを作成しました', 'success');
        } catch (e) {
            console.error('Failed to fetch title', e);
            view.dispatch(view.state.replaceSelection(`[${url}](${url})`));
            showNotification('タイトルの取得に失敗しました', 'error');
        }
        closeModal();
    });

    bookmarkBtn.addEventListener('click', () => {
        const state = view.state;
        const doc = state.doc;
        const selection = state.selection.main;

        const hasNewlineBefore = selection.from === 0 || doc.sliceString(selection.from - 1, selection.from) === '\n';
        const hasNewlineAfter = selection.to === doc.length || doc.sliceString(selection.to, selection.to + 1) === '\n';

        let insertText = `@card ${url}`;

        if (!hasNewlineBefore) insertText = '\n' + insertText;
        if (!hasNewlineAfter) insertText = insertText + '\n';

        view.dispatch(view.state.replaceSelection(insertText));

        showNotification('ブックマークを作成しました', 'success');
        closeModal();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

const pasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
        const text = event.clipboardData.getData("text/plain");
        const urlRegex = /^(http|https):\/\/[^ "]+$/;

        if (urlRegex.test(text)) {
            event.preventDefault();
            showPasteOptionModal(text, view);
            return true;
        }
        return false;
    }
});

// ドロップ時のデフォルト動作防止
const dropHandler = EditorView.domEventHandlers({
    drop(event, view) {
        // タブ移動のデータが含まれているかチェック
        const data = event.dataTransfer.getData('text/plain');
        try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.paneId && parsed.filePath) {
                // LayoutManagerに任せる
                return true; 
            }
        } catch (e) {}
        return false;
    }
});


// ========== Pane System (Multi-Tab, Split View) ==========

class Pane {
    // ★変更: manager引数を受け取るように修正
    // class Pane 内
    constructor(id, parentContainer, manager) {
        console.log(`🔨 [Pane:${id}] Constructor called.`);
        this.id = id;
        this.files = []; 
        this.activeFilePath = null;
        this.editorView = null;
        this.manager = manager; 
        
        try {
            this.element = document.createElement('div');
            this.element.className = 'pane';
            this.element.dataset.id = id;
            this.element.style.flex = '1';

            // ... (中略: ヘッダー作成など既存コードと同じ) ...
            
            this.header = document.createElement('div');
            this.header.className = 'pane-header';
            this.tabsContainer = document.createElement('div');
            this.tabsContainer.className = 'pane-tabs-container';
            this.body = document.createElement('div');
            this.body.className = 'pane-body';

            this.header.appendChild(this.tabsContainer);
            this.element.appendChild(this.header);
            this.element.appendChild(this.body);
            
            parentContainer.appendChild(this.element);
            
            // イベントリスナー
            this.element.addEventListener('click', () => {
                if (this.manager) this.manager.setActivePane(this.id);
            });

            console.log(`👉 [Pane:${id}] Calling initEditor...`);
            this.initEditor();
            console.log(`✅ [Pane:${id}] initEditor finished.`);

        } catch (e) {
            console.error(`❌ [Pane:${id}] Error in constructor:`, e);
        }
    }

    // ...以下、initEditor() などのメソッドは既存のまま維持...
    initEditor() {
        // (省略なしで既存コードを維持してください)
        const initialTheme = appSettings.theme === 'dark' ? oneDark : [];
        const initialStyle = EditorView.theme({
            ".cm-content": {
                fontSize: appSettings.fontSize,
                fontFamily: appSettings.fontFamily
            },
            ".cm-gutters": {
                fontSize: appSettings.fontSize,
                fontFamily: appSettings.fontFamily
            },
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: 'inherit' }
        });

        const state = EditorState.create({
            doc: "",
            extensions: [
                themeCompartment.of(initialTheme),
                editorStyleCompartment.of(initialStyle),
                indentUnit.of("    "),
                Prec.highest(keymap.of(obsidianLikeListKeymap)),
                pasteHandler,
                dropHandler,
                history(),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    { key: "Mod-s", run: () => { saveCurrentFile(false); return true; } }
                ]),
                syntaxHighlighting(defaultHighlightStyle),
                markdown({ base: markdownLanguage, codeLanguages: codeLanguages }),
                livePreviewPlugin,
                tablePlugin,
                EditorView.lineWrapping,
                highlightActiveLine(),
                lineNumbers(),
                EditorView.updateListener.of(update => {
                    if (update.docChanged) {
                        const isExternal = update.transactions.some(tr => tr.annotation(ExternalChange));
                        onEditorInput(!isExternal);
                    }
                    if (update.focusChanged && update.view.hasFocus) {
                        // ★変更: this.managerを使用
                        if (this.manager) {
                            this.manager.setActivePane(this.id);
                        }
                    }
                })
            ],
        });

        this.editorView = new EditorView({
            state: state,
            parent: this.body,
        });
    }

    destroy() {
        console.log(`[Pane] Destroying pane ${this.id}`);
        if (this.editorView) {
            this.editorView.destroy();
            this.editorView = null;
        }
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
    }

    updateTabs() {
        this.tabsContainer.innerHTML = '';
        this.files.forEach(filePath => {
            const fileData = openedFiles.get(filePath);
            const fileName = fileData ? fileData.fileName : path.basename(filePath);
            const isActive = filePath === this.activeFilePath;
            const isDirty = fileModificationState.has(filePath);

            const tab = document.createElement('div');
            tab.className = `editor-tab ${isActive ? 'active' : ''}`;
            tab.dataset.filepath = filePath;
            tab.draggable = true;
            
            tab.innerHTML = `
                <span class="tab-title">${fileName} ${isDirty ? '●' : ''}</span>
                <span class="close-tab">×</span>
            `;

            tab.addEventListener('click', (e) => {
                if (e.target.classList.contains('close-tab')) {
                    e.stopPropagation();
                    this.closeFile(filePath);
                } else {
                    this.switchToFile(filePath);
                }
            });

            // Drag Start
            tab.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    paneId: this.id,
                    filePath: filePath
                }));
                tab.classList.add('dragging');
                // ★変更: this.managerを使用
                if (this.manager) {
                    this.manager.setDragSource(this.id, filePath);
                }
            });

            tab.addEventListener('dragend', (e) => {
                tab.classList.remove('dragging');
                // ★変更: this.managerを使用
                if (this.manager) {
                    this.manager.clearDragSource();
                    this.manager.hideDropOverlay();
                }
            });

            this.tabsContainer.appendChild(tab);
        });
    }

    openFile(filePath) {
        if (!this.files.includes(filePath)) {
            this.files.push(filePath);
        }
        this.switchToFile(filePath);
        this.updateTabs();
    }

    // ファイルを閉じる。isMoving=trueならタブ移動中なので削除しない
    closeFile(filePath, isMoving = false) {
        const index = this.files.indexOf(filePath);
        if (index > -1) {
            this.files.splice(index, 1);
            if (this.activeFilePath === filePath) {
                const nextFile = this.files[index] || this.files[index - 1];
                if (nextFile) {
                    this.switchToFile(nextFile);
                } else {
                    this.activeFilePath = null;
                    this.setEditorContent("");
                }
            }
            this.updateTabs();
        }

        if (!isMoving) {
            // ★変更: メインと右側の両方のマネージャーをチェックして、他で開かれていなければopenedFilesから削除
            let isOpenedElsewhere = false;
            const managers = [mainLayoutManager, rightLayoutManager].filter(m => m);
            
            managers.forEach(mgr => {
                mgr.panes.forEach(pane => {
                    // 自分自身(this)も含めてチェックしても良いが、既にspliceされているので問題ない
                    if (pane.files.includes(filePath)) isOpenedElsewhere = true;
                });
            });

            if (!isOpenedElsewhere) {
                openedFiles.delete(filePath);
                fileModificationState.delete(filePath);
            }
        }

        // ファイルが空になったらペイン自体を削除する（ただし最後の1つを除く）
        if (this.files.length === 0) {
            console.log(`[Pane] Pane ${this.id} is now empty.`);
            // ★変更: this.managerを使用
            if (this.manager) {
                this.manager.removePane(this.id);
            }
        }
    }

    switchToFile(filePath) {
        this.activeFilePath = filePath;
        const fileData = openedFiles.get(filePath);
        const content = fileData ? fileData.content : "";
        this.setEditorContent(content);
        this.updateTabs();
        
        // タイトルバー更新は、メインマネージャーのアクティブペインの時だけに行うのが理想だが、
        // 簡易的に activeLayoutManager と照合してもよい
        if (activeLayoutManager === this.manager && fileTitleInput) {
            const fileName = fileData ? fileData.fileName : path.basename(filePath);
            const extIndex = fileName.lastIndexOf('.');
            const nameNoExt = extIndex > 0 ? fileName.substring(0, extIndex) : fileName;
            fileTitleInput.value = nameNoExt;
        }
        
        // 統計情報の更新なども同様
        if (activeLayoutManager === this.manager) {
            updateFileStats();
            updateOutline();
        }
        
        if (isPdfPreviewVisible) generatePdfPreview();
        
        if (fileData) {
            document.title = `${fileData.fileName} - Markdown IDE`;
        }
    }

    setEditorContent(content) {
        if (!this.editorView) return;
        this.editorView.dispatch({
            changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
            annotations: ExternalChange.of(true)
        });
    }

    isActive() {
        // ★変更: this.managerを使用
        return this.manager && this.manager.activePaneId === this.id;
    }
}

// ========== Layout Manager (Refactored) ==========

class LayoutManager {
    constructor(rootId, dropZoneId) {
        this.panes = new Map();
        this.activePaneId = null;
        this.paneCounter = 0;
        this.rootId = rootId;
        this.dropZoneId = dropZoneId;
        this.rootContainer = document.getElementById(rootId);
        this.dragSource = null;
        this.currentDropZone = null;
    }

    // class LayoutManager 内
    init() {
        console.log(`🔍 [LayoutManager:${this.rootId}] init() started.`);
        this.rootContainer = document.getElementById(this.rootId);
        
        if (!this.rootContainer) {
            console.error(`❌ [LayoutManager:${this.rootId}] Root container (#${this.rootId}) NOT FOUND!`);
            return;
        }
        console.log(`✅ [LayoutManager:${this.rootId}] Root container found.`);

        this.rootContainer.innerHTML = '';
        this.panes.clear();
        
        try {
            console.log(`👉 [LayoutManager:${this.rootId}] Creating initial pane...`);
            const initialPaneId = this.createPane(this.rootContainer);
            console.log(`✅ [LayoutManager:${this.rootId}] Initial pane created: ${initialPaneId}`);
            this.setActivePane(initialPaneId);
        } catch (e) {
            console.error(`❌ [LayoutManager:${this.rootId}] Error during pane creation:`, e);
        }
        
        this.setupDragDrop();
    }

    createPane(container) {
        const id = `pane-${this.rootId}-${++this.paneCounter}`;
        console.log(`👉 [LayoutManager] createPane called. New ID: ${id}`);
        
        try {
            const pane = new Pane(id, container, this);
            this.panes.set(id, pane);
            return id;
        } catch (e) {
            console.error(`❌ [LayoutManager] Failed to instantiate Pane class:`, e);
            throw e;
        }
    }

    removePane(id) {
        if (this.panes.has(id)) {
            const pane = this.panes.get(id);
            pane.destroy();
            this.panes.delete(id);
            
            if (this.panes.size > 0) {
                const keys = Array.from(this.panes.keys());
                this.setActivePane(keys[keys.length - 1]);
            } else if (this.panes.size === 0) {
                // 全て閉じた場合でも、最低1つは維持する（または空状態にする）
                // ここでは再度作成する例
                const newId = this.createPane(this.rootContainer);
                this.setActivePane(newId);
            }
        }
    }

    setActivePane(id) {
        if (this.activePaneId) {
            const prevPane = this.panes.get(this.activePaneId);
            if (prevPane && prevPane.element) prevPane.element.classList.remove('active');
        }
        this.activePaneId = id;
        const nextPane = this.panes.get(id);
        if (nextPane) {
            nextPane.element.classList.add('active');
            activeLayoutManager = this; // グローバルを更新

            // UI更新関連
            if (nextPane.activeFilePath) {
                const fileData = openedFiles.get(nextPane.activeFilePath);
                if (fileTitleInput && fileData) {
                     const fileName = fileData.fileName;
                     const extIndex = fileName.lastIndexOf('.');
                     fileTitleInput.value = extIndex > 0 ? fileName.substring(0, extIndex) : fileName;
                }
            } else {
                if(fileTitleInput) fileTitleInput.value = "";
            }
            if (typeof updateFileStats === 'function') updateFileStats();
            if (typeof updateOutline === 'function') updateOutline();
        }
    }

    get activePane() {
        return this.panes.get(this.activePaneId);
    }

    refreshAllEditors() {
        this.panes.forEach(pane => {
            if (pane.editorView) {
                pane.editorView.requestMeasure();
            }
        });
    }

    // ★追加: Paneから呼ばれるドラッグ管理メソッド
    setDragSource(paneId, filePath) {
        this.dragSource = { paneId, filePath };
    }

    clearDragSource() {
        this.dragSource = null;
    }

    // ★修正: 完全なドラッグ＆ドロップロジック
    setupDragDrop() {
        const container = document.getElementById(this.dropZoneId);
        if (!container) return;
        
        // オーバーレイ要素の取得（なければ作成）
        let dropOverlay = document.getElementById(`drop-overlay-${this.rootId}`);
        if (!dropOverlay) {
            dropOverlay = document.createElement('div');
            dropOverlay.id = `drop-overlay-${this.rootId}`;
            dropOverlay.className = 'drop-overlay hidden';
            // CSSで .drop-overlay { position: absolute; pointer-events: none; ... } が必要
            // 既存の #drop-overlay があればそれを使い回す実装も可
            if (document.getElementById('drop-overlay')) {
                dropOverlay = document.getElementById('drop-overlay');
            } else {
                document.body.appendChild(dropOverlay);
            }
        }

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const w = rect.width;
            const h = rect.height;
            
            // 領域判定 (Zoneの定義)
            let zone = 'center';
            const threshold = 50; // 端からのピクセル数

            if (x < threshold) zone = 'left';
            else if (x > w - threshold) zone = 'right';
            else if (y < threshold) zone = 'top';
            else if (y > h - threshold) zone = 'bottom';

            this.currentDropZone = zone;
            this.showDropOverlay(zone, rect, dropOverlay);
        });

        container.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // オーバーレイ自体からのleaveは無視したいが、簡易的に隠す
            this.hideDropOverlay(dropOverlay);
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideDropOverlay(dropOverlay);

            // ファイルドロップまたはタブ移動の処理
            if (this.dragSource) {
                // タブ移動ロジック（簡易実装: 同じペインなら何もしない、違うなら開く）
                if (this.activePane) {
                     this.activePane.openFile(this.dragSource.filePath);
                }
            } else if (e.dataTransfer.files.length > 0) {
                // 外部ファイルドロップ
                // (実装に合わせて openFileFromPath 等を呼ぶ)
            }
            
            this.clearDragSource();
        });
    }

    showDropOverlay(zone, rect, overlayElement) {
        if (!overlayElement) return;
        
        overlayElement.classList.remove('hidden');
        overlayElement.style.top = `${rect.top}px`;
        overlayElement.style.left = `${rect.left}px`;
        overlayElement.style.width = `${rect.width}px`;
        overlayElement.style.height = `${rect.height}px`;

        // ゾーンに応じたハイライト表示（CSSクラス切り替え等）
        // ここでは簡易的に全画面をハイライト
        overlayElement.style.opacity = '0.3';
        overlayElement.style.backgroundColor = 'var(--accent-color)';
    }

    hideDropOverlay(overlayElement) {
        if (!overlayElement) overlayElement = document.getElementById(`drop-overlay-${this.rootId}`) || document.getElementById('drop-overlay');
        if (overlayElement) overlayElement.classList.add('hidden');
        this.currentDropZone = null;
    }
}


// グローバルスコープへの露出（既存コード互換）
Object.defineProperty(window, 'globalEditorView', {
    get: () => layoutManager.activePane ? layoutManager.activePane.editorView : null
});


// ========== 左ペイン幅の動的制御用変数更新関数 ==========
function updateLeftPaneWidthVariable() {
    const isHidden = leftPane.classList.contains('hidden');
    const width = isHidden ? '0px' : '240px';
    document.documentElement.style.setProperty('--current-left-pane-width', width);
}

// ========== ビュー切り替えロジック ==========

function switchMainView(targetId) {
    const contentIds = ['content-readme', 'content-settings'];
    contentIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('content-hidden');
    });

    const targetEl = document.getElementById(targetId);
    if (targetEl) {
        targetEl.classList.remove('content-hidden');
    }

    if (targetId === 'content-settings') {
        if (fileTitleBar) fileTitleBar.classList.add('hidden');
    } else {
        if (layoutManager.activePane && layoutManager.activePane.activeFilePath) {
             if (fileTitleBar) fileTitleBar.classList.remove('hidden');
        } else {
             if (fileTitleBar) fileTitleBar.classList.add('hidden');
        }
    }
}

// ========== 設定関連の関数 ==========

async function loadSettings() {
    try {
        const settings = await window.electronAPI.loadAppSettings();
        if (settings) {
            appSettings = { ...appSettings, ...settings };
        }
        applySettingsToUI();
        updateEditorSettings();
    } catch (e) {
        console.error("Failed to load settings", e);
    }
}

async function saveSettings() {
    try {
        await window.electronAPI.saveAppSettings(appSettings);
    } catch (e) {
        console.error("Failed to save settings", e);
    }
}

function applySettingsToUI() {
    const fontSizeInput = document.getElementById('font-size');
    const fontFamilyInput = document.getElementById('font-family');
    const themeInput = document.getElementById('theme');
    const autoSaveInput = document.getElementById('auto-save');

    if (fontSizeInput) fontSizeInput.value = appSettings.fontSize;
    if (fontFamilyInput) fontFamilyInput.value = appSettings.fontFamily;
    if (themeInput) themeInput.value = appSettings.theme;
    if (autoSaveInput) autoSaveInput.checked = appSettings.autoSave;

    if (appSettings.theme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
    } else {
        document.body.removeAttribute('data-theme');
    }

    document.documentElement.style.setProperty('--editor-font-size', appSettings.fontSize);
    document.documentElement.style.setProperty('--editor-font-family', appSettings.fontFamily);
}

function updateEditorSettings() {
    layoutManager.panes.forEach(pane => {
        if (pane.editorView) {
            pane.editorView.dispatch({
                effects: [
                    themeCompartment.reconfigure(appSettings.theme === 'dark' ? oneDark : []),
                    editorStyleCompartment.reconfigure(EditorView.theme({
                        ".cm-content": {
                            fontSize: appSettings.fontSize,
                            fontFamily: appSettings.fontFamily
                        },
                        ".cm-gutters": {
                            fontSize: appSettings.fontSize,
                            fontFamily: appSettings.fontFamily
                        }
                    }))
                ]
            });
        }
    });
}

function setupSettingsListeners() {
    document.getElementById('font-size')?.addEventListener('change', (e) => {
        appSettings.fontSize = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('font-family')?.addEventListener('change', (e) => {
        appSettings.fontFamily = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('theme')?.addEventListener('change', (e) => {
        appSettings.theme = e.target.value;
        saveSettings();
        applySettingsToUI();
        updateEditorSettings();
    });

    document.getElementById('auto-save')?.addEventListener('change', (e) => {
        appSettings.autoSave = e.target.checked;
        saveSettings();
    });
}

function openSettingsTab() {
    switchMainView('content-settings');
}

// ========== Initialization Helpers (StartDoc) ==========

const startDoc = `# Markdown IDE の使い方

このエディタは、Markdown記法をリアルタイムでプレビューしながら記述できるIDEです。
上部のツールバーを使って、簡単に装飾や要素を挿入できます。

## 🚀 新機能: タブ分割
タブをドラッグして画面端（上下左右）にドロップすると、画面を分割して複数のファイルを同時に編集できます！

## 🛠 ツールバー機能

### 基本操作
- 💾 **保存**: \`Ctrl + S\`
- 📤 **PDFエクスポート**: 記述した内容をPDFとして保存します。
- ↩/↪ **元に戻す/やり直し**: \`Ctrl + Z\` / \`Ctrl + Y\`

### テキスト装飾
ツールバーのボタンで以下の装飾が可能です。
- **太字**: \`**Bold**\`
- *斜体*: \`*Italic*\`
- ~~取り消し線~~: \`~~Strike~~\`
- ==ハイライト==: \`==Highlight==\`

## ✨ 高度な機能

### テーブル（表）
ツールバーのボタンで挿入できます。
`;

// ========== エディタ操作ヘルパー (Active Paneに対して実行) ==========
function getActiveView() {
    // ★変更: activeLayoutManagerを参照する
    if (activeLayoutManager && activeLayoutManager.activePane) {
        return activeLayoutManager.activePane.editorView;
    }
    // フォールバック: メインレイアウトのアクティブペイン
    return mainLayoutManager && mainLayoutManager.activePane ? mainLayoutManager.activePane.editorView : null;
}

// 互換性のため window.layoutManager も維持する場合（必要に応じて）
Object.defineProperty(window, 'layoutManager', {
    get: () => mainLayoutManager
});

function toggleLinePrefix(view, prefix) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    const match = line.text.match(/^\s*(#+\s*|>\s*)/);

    let changes;
    let newCursorPos;

    if (match && match[1].trim() === prefix.trim()) {
        const matchLen = match[0].length;
        changes = { from: line.from, to: line.from + matchLen, insert: "" };
        newCursorPos = line.to - matchLen;
    } else {
        const insertText = prefix.endsWith(' ') ? prefix : prefix + ' ';
        if (match) {
            const matchLen = match[0].length;
            changes = { from: line.from, to: line.from + matchLen, insert: insertText };
            newCursorPos = line.to - matchLen + insertText.length;
        } else {
            changes = { from: line.from, to: line.from, insert: insertText };
            newCursorPos = line.to + insertText.length;
        }
    }

    dispatch({
        changes: changes,
        selection: { anchor: newCursorPos, head: newCursorPos }
    });
    view.focus();
}

function toggleMark(view, mark) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to, empty } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const extendedFrom = Math.max(0, from - mark.length);
    const extendedTo = Math.min(state.doc.length, to + mark.length);

    if (extendedFrom >= 0 && extendedTo <= state.doc.length) {
        const surroundingText = state.sliceDoc(extendedFrom, extendedTo);
        if (surroundingText.startsWith(mark) && surroundingText.endsWith(mark)) {
            dispatch({
                changes: { from: extendedFrom, to: extendedTo, insert: selectedText },
                selection: { anchor: extendedFrom, head: extendedFrom + selectedText.length }
            });
            view.focus(); return;
        }
    }

    dispatch({
        changes: { from: from, to: to, insert: `${mark}${selectedText}${mark}` },
        selection: empty
            ? { anchor: from + mark.length, head: from + mark.length }
            : { anchor: to + mark.length * 2, head: to + mark.length * 2 }
    });
    view.focus();
}

function toggleList(view, type) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const startLine = state.doc.lineAt(from);
    const endLine = state.doc.lineAt(to);
    let changes = [];
    let totalChangeLength = 0;

    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = state.doc.line(i);
        const text = line.text;
        const bulletMatch = text.match(/^(\s*)([-*+] )\s*/);
        const orderedMatch = text.match(/^(\s*)(\d+(?:-\d+)*\. )\s*/);
        const checkMatch = text.match(/^(\s*)(- \[[ x]\] )\s*/);

        let diff = 0;

        if (type === 'ul') {
            if (bulletMatch) {
                const delLen = bulletMatch[0].length - bulletMatch[1].length;
                changes.push({ from: line.from + bulletMatch[1].length, to: line.from + bulletMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "- " });
                diff = 2;
            }
        } else if (type === 'ol') {
            if (orderedMatch) {
                const delLen = orderedMatch[0].length - orderedMatch[1].length;
                changes.push({ from: line.from + orderedMatch[1].length, to: line.from + orderedMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "1. " });
                diff = 3;
            }
        } else if (type === 'task') {
            if (checkMatch) {
                const delLen = checkMatch[0].length - checkMatch[1].length;
                changes.push({ from: line.from + checkMatch[1].length, to: line.from + checkMatch[0].length, insert: "" });
                diff = -delLen;
            } else {
                changes.push({ from: line.from, insert: "- [ ] " });
                diff = 6;
            }
        }
        totalChangeLength += diff;
    }

    const newHead = endLine.to + totalChangeLength;

    dispatch({
        changes: changes,
        selection: { anchor: newHead, head: newHead }
    });
    view.focus();
}

function insertLink(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "link";
    dispatch({ changes: { from: from, to: to, insert: `[${text}](url)` }, selection: { anchor: from + text.length + 3, head: from + text.length + 6 } });
    view.focus();
}

function insertImage(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "Image";
    dispatch({
        changes: { from: from, to: to, insert: `![${text}](url)` },
        selection: { anchor: from + 2 + text.length + 2, head: from + 2 + text.length + 5 }
    });
    view.focus();
}

function insertTable(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;

    const table =
        `| Col 1 | Col 2 | Col 3 |
| :--- | :--- | :--- |
|  |  |  |
|  |  |  |
`;

    const lineStart = state.doc.lineAt(from).from;
    const needsNewline = from !== lineStart;
    const insertText = (needsNewline ? "\n" : "") + table;

    dispatch({
        changes: { from: from, to: to, insert: insertText },
        selection: { anchor: from + (needsNewline ? 1 : 0) + 2 }
    });
    view.focus();
}

function insertHorizontalRule(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);
    const insert = `\n---\n`;
    const newPos = line.to + insert.length;
    dispatch({
        changes: { from: line.to, insert: insert },
        selection: { anchor: newPos, head: newPos }
    });
    view.focus();
}

function insertPageBreak(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from } = state.selection.main;
    const line = state.doc.lineAt(from);

    const insert = `\n<div class="page-break"></div>\n`;
    const newPos = line.to + insert.length;

    dispatch({
        changes: { from: line.to, insert: insert },
        selection: { anchor: newPos, head: newPos }
    });
    view.focus();
}

function insertCodeBlock(view) {
    if (!view) return;
    const { state, dispatch } = view;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);
    const text = selectedText || "";
    const insert = `\`\`\`\n${text}\n\`\`\`\n`;

    dispatch({
        changes: { from: from, to: to, insert: insert },
        selection: { anchor: from + 4, head: from + 4 }
    });
    view.focus();
}

// ========== ツールバーボタン イベントリスナー ==========
document.getElementById('btn-save')?.addEventListener('click', () => saveCurrentFile(false));
document.getElementById('toolbar-undo')?.addEventListener('click', () => { const v = getActiveView(); if (v) { undo(v); v.focus(); } });
document.getElementById('toolbar-redo')?.addEventListener('click', () => { const v = getActiveView(); if (v) { redo(v); v.focus(); } });

document.getElementById('btn-h2')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), "##"));
document.getElementById('btn-h3')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), "###"));

document.querySelectorAll('.dropdown-item[data-action^="h"]').forEach(item => {
    item.addEventListener('click', (e) => {
        const level = parseInt(e.target.dataset.action.replace('h', ''));
        const hashes = "#".repeat(level);
        toggleLinePrefix(getActiveView(), hashes);
    });
});

document.getElementById('bold-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "**"));
document.getElementById('italic-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "*"));
document.getElementById('strike-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "~~"));
document.getElementById('highlight-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "=="));

document.getElementById('link-btn')?.addEventListener('click', () => insertLink(getActiveView()));
document.getElementById('image-btn')?.addEventListener('click', () => insertImage(getActiveView()));
document.getElementById('btn-table')?.addEventListener('click', () => insertTable(getActiveView()));

document.getElementById('code-btn')?.addEventListener('click', () => insertCodeBlock(getActiveView()));
document.getElementById('inline-code-btn')?.addEventListener('click', () => toggleMark(getActiveView(), "`"));
document.getElementById('quote-btn')?.addEventListener('click', () => toggleLinePrefix(getActiveView(), ">"));
document.getElementById('hr-btn')?.addEventListener('click', () => insertHorizontalRule(getActiveView()));
document.getElementById('btn-page-break')?.addEventListener('click', () => insertPageBreak(getActiveView()));

if (btnBulletList) btnBulletList.addEventListener('click', () => toggleList(getActiveView(), 'ul'));
if (btnNumberList) btnNumberList.addEventListener('click', () => toggleList(getActiveView(), 'ol'));
if (btnCheckList) btnCheckList.addEventListener('click', () => toggleList(getActiveView(), 'task'));

document.getElementById('btn-close-file-toolbar')?.addEventListener('click', () => {
    if (layoutManager.activePane && layoutManager.activePane.activeFilePath) {
        layoutManager.activePane.closeFile(layoutManager.activePane.activeFilePath);
    }
});

const btnExportPdf = document.getElementById('btn-export-pdf');
if (btnExportPdf) {
    btnExportPdf.addEventListener('click', async () => {
        const view = getActiveView();
        if (!view) return;
        const markdownContent = view.state.doc.toString();

        if (!markdownContent.trim()) {
            showNotification('エクスポートするコンテンツがありません。', 'error');
            return;
        }

        try {
            const processedMarkdown = await processMarkdownForExport(markdownContent);
            const htmlContent = marked.parse(processedMarkdown, { breaks: true, gfm: true });

            if (typeof window.electronAPI?.exportPdf === 'function') {
                const result = await window.electronAPI.exportPdf(htmlContent);
                if (result.success) {
                    showNotification(`PDFの保存が完了しました: ${result.path}`, 'success');
                } else if (!result.canceled) {
                    showNotification(`PDFの保存に失敗しました: ${result.error}`, 'error');
                }
            } else {
                showNotification('PDFエクスポート機能は利用できません。', 'error');
            }
        } catch (e) {
            console.error('PDF Export Error:', e);
            showNotification('予期せぬエラーが発生しました: ' + e.message, 'error');
        }
    });
}

// ========== ツールバーのレスポンシブ対応 ==========
const toolbarLeft = document.getElementById('toolbar-left');
const toolbarMoreBtn = document.getElementById('btn-toolbar-more');
const toolbarOverflowMenu = document.getElementById('toolbar-overflow-menu');

let originalToolbarItems = [];

function initToolbarOverflow() {
    if (!toolbarLeft || !toolbarMoreBtn) return;

    originalToolbarItems = Array.from(toolbarLeft.children).filter(el => el !== toolbarMoreBtn);

    const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
            handleToolbarResize();
        });
    });
    resizeObserver.observe(toolbarLeft);

    toolbarMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toolbarOverflowMenu.classList.toggle('hidden');

        const rect = toolbarMoreBtn.getBoundingClientRect();
        const toolbarRect = toolbarLeft.parentElement.getBoundingClientRect();

        const rightOffset = toolbarRect.right - rect.right;
        toolbarOverflowMenu.style.right = rightOffset + 'px';
        toolbarOverflowMenu.style.left = 'auto';
    });

    document.addEventListener('click', (e) => {
        if (!toolbarOverflowMenu.contains(e.target) && e.target !== toolbarMoreBtn) {
            toolbarOverflowMenu.classList.add('hidden');
        }
    });
}

function handleToolbarResize() {
    if (!toolbarLeft || originalToolbarItems.length === 0) return;

    const currentChildren = Array.from(toolbarLeft.children);
    const itemsInMenu = Array.from(toolbarOverflowMenu.children);

    itemsInMenu.forEach(item => {
        toolbarLeft.insertBefore(item, toolbarMoreBtn);
    });

    originalToolbarItems.forEach(item => {
        if (item.parentElement !== toolbarLeft) {
            toolbarLeft.insertBefore(item, toolbarMoreBtn);
        }
    });

    toolbarMoreBtn.classList.add('hidden');

    const containerWidth = toolbarLeft.clientWidth;
    const moreBtnWidth = 32;

    let currentWidth = 0;
    let overflowStartIndex = -1;

    for (let i = 0; i < originalToolbarItems.length; i++) {
        const item = originalToolbarItems[i];
        const itemWidth = item.offsetWidth + 4;

        if (currentWidth + itemWidth > containerWidth - moreBtnWidth - 10) {
            overflowStartIndex = i;
            break;
        }
        currentWidth += itemWidth;
    }

    if (overflowStartIndex !== -1) {
        toolbarMoreBtn.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        for (let i = overflowStartIndex; i < originalToolbarItems.length; i++) {
            fragment.appendChild(originalToolbarItems[i]);
        }
        toolbarOverflowMenu.appendChild(fragment);
    }
}

// ========== 基本機能 ==========
function onEditorInput(markAsDirty = true) {
    const pane = layoutManager.activePane;
    if (!pane) return;
    
    if (markAsDirty && pane.activeFilePath && pane.activeFilePath !== 'README.md') {
        fileModificationState.set(pane.activeFilePath, true);
        const fileData = openedFiles.get(pane.activeFilePath);
        if (fileData) {
            fileData.content = pane.editorView.state.doc.toString();
        }
        pane.updateTabs();
    }

    if (window.outlineUpdateTimeout) clearTimeout(window.outlineUpdateTimeout);
    window.outlineUpdateTimeout = setTimeout(() => {
        updateOutline();
    }, 500);

    if (isPdfPreviewVisible) {
        if (window.pdfUpdateTimeout) clearTimeout(window.pdfUpdateTimeout);
        window.pdfUpdateTimeout = setTimeout(() => {
            generatePdfPreview();
        }, 1000);
    }

    updateFileStats();
}

function updateFileStats() {
    const view = getActiveView();
    if (!fileStatsElement || !view) {
        if(fileStatsElement) fileStatsElement.textContent = "文字数: 0 | 行数: 0";
        return;
    }
    const text = view.state.doc.toString();
    const charCount = text.length;
    const lineCount = view.state.doc.lines;
    fileStatsElement.textContent = `文字数: ${charCount} | 行数: ${lineCount}`;
}

// ========== Terminal Logic (Integrated) ==========

async function initializeTerminal() {
    if (terminals.size > 0) return;

    console.log('Initializing Integrated Terminal...');
    try {
        terminalConfig = await window.electronAPI.getTerminalConfig();
        availableShells = await window.electronAPI.getAvailableShells();
    } catch (e) {
        console.error("Failed to load terminal config/shells:", e);
    }

    renderShellDropdown();

    if (newTerminalBtn) {
        const newBtn = newTerminalBtn.cloneNode(true);
        newTerminalBtn.parentNode.replaceChild(newBtn, newTerminalBtn);
        newBtn.addEventListener('click', () => createTerminalSession());
    }
    if (dropdownToggle) {
        const newToggle = dropdownToggle.cloneNode(true);
        dropdownToggle.parentNode.replaceChild(newToggle, dropdownToggle);

        newToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = newToggle.getBoundingClientRect();
            if (shellDropdown) {
                shellDropdown.style.top = `${rect.bottom + 2}px`;
                shellDropdown.style.bottom = 'auto';

                const rightGap = window.innerWidth - rect.right;
                shellDropdown.style.right = `${Math.max(0, rightGap)}px`;
                shellDropdown.style.left = 'auto';

                shellDropdown.classList.toggle('hidden');
            }
        });
    }
    document.addEventListener('click', () => {
        if (shellDropdown) shellDropdown.classList.add('hidden');
    });

    window.electronAPI.onTerminalData(({ terminalId, data }) => {
        const term = terminals.get(terminalId);
        if (term) term.xterm.write(data);
    });

    window.electronAPI.onTerminalExit(({ terminalId }) => {
        closeTerminalSession(terminalId);
    });

    window.electronAPI.onRestoreState(async (state) => {
        if (state.terminals && state.terminals.length > 0) {
            for (const t of state.terminals) {
                await createTerminalSession(t.shellProfile);
            }
        }
    });

    if (isTerminalVisible && terminals.size === 0) {
        setTimeout(() => {
            if (terminals.size === 0) createTerminalSession();
        }, 300);
    }

    setupTerminalResizeObserver();
}

function setupTerminalResizeObserver() {
    const observer = new ResizeObserver(() => {
        if (activeTerminalId && isTerminalVisible) {
            requestAnimationFrame(() => {
                fitTerminal(activeTerminalId);
            });
        }
    });

    if (terminalContainer) observer.observe(terminalContainer);
    if (terminalBottomContainer) observer.observe(terminalBottomContainer);
}

function renderShellDropdown() {
    if (!shellDropdown) return;
    shellDropdown.innerHTML = '';
    if (availableShells.length === 0) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = 'No shells detected';
        shellDropdown.appendChild(item);
        return;
    }
    availableShells.forEach(shell => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = shell.displayName;
        item.addEventListener('click', () => {
            createTerminalSession(shell.name);
        });
        shellDropdown.appendChild(item);
    });
}

function fitTerminal(terminalId) {
    if (document.body.classList.contains('is-layout-changing')) return;

    const term = terminals.get(terminalId);
    if (!term || !term.xterm || !term.fitAddon) return;

    if (term.element.offsetParent === null || term.element.clientWidth === 0 || term.element.clientHeight === 0) return;

    try {
        term.fitAddon.fit();
        const newCols = term.xterm.cols;
        const newRows = term.xterm.rows;

        if (newCols <= 0 || newRows <= 0) return;
        if (term.lastCols === newCols && term.lastRows === newRows) return;

        if (term.resizeTimeout) clearTimeout(term.resizeTimeout);

        term.resizeTimeout = setTimeout(() => {
            window.electronAPI.resizeTerminal(terminalId, newCols, newRows);
            term.lastCols = newCols;
            term.lastRows = newRows;

            term.xterm.refresh(0, newRows - 1);
        }, 50);

    } catch (e) {
        console.warn(`Fit terminal ${terminalId} failed:`, e);
    }
}

async function createTerminalSession(profileName = null) {
    try {
        const { terminalId, shellName } = await window.electronAPI.createTerminal({ profileName });

        const container = isPositionRight ? terminalContainer : terminalBottomContainer;
        if (!container) return;

        const xterm = new Terminal({
            cursorBlink: terminalConfig?.cursorBlink ?? true,
            fontSize: terminalConfig?.fontSize || 14,
            fontFamily: terminalConfig?.fontFamily || 'Consolas, "Courier New", monospace',
            theme: terminalConfig?.theme || { background: '#1e1e1e' },
            allowTransparency: true,
            windowsMode: navigator.platform.indexOf('Win') > -1
        });

        const fitAddon = new FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);

        if (typeof WebLinksAddon !== 'undefined') {
            xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
        }

        const el = document.createElement('div');
        el.className = 'terminal-instance';
        el.id = `term-${terminalId}`;
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        container.appendChild(el);

        xterm.open(el);

        xterm.onData(data => window.electronAPI.writeToTerminal(terminalId, data));

        terminals.set(terminalId, {
            xterm,
            fitAddon,
            element: el,
            lastCols: 0,
            lastRows: 0,
            resizeTimeout: null
        });

        const tab = document.createElement('div');
        tab.className = 'terminal-tab';
        tab.dataset.id = terminalId;
        tab.innerHTML = `<span class="terminal-tab-title">${shellName}</span><button class="terminal-tab-close">×</button>`;

        tab.addEventListener('click', () => switchTerminal(terminalId));
        tab.querySelector('.terminal-tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTerminalSession(terminalId);
        });

        if (terminalTabsList) {
            terminalTabsList.appendChild(tab);
        }

        setTimeout(() => {
            switchTerminal(terminalId);
        }, 100);

    } catch (e) {
        console.error('Failed to create terminal', e);
    }
}

function switchTerminal(terminalId) {
    activeTerminalId = terminalId;

    if (terminalTabsList) {
        Array.from(terminalTabsList.children).forEach(tab => {
            tab.classList.toggle('active', tab.dataset.id == terminalId);
        });
    }

    terminals.forEach((term, id) => {
        const isActive = id === terminalId;

        if (isActive) {
            term.element.style.visibility = 'visible';
            term.element.style.opacity = '1';
            term.element.style.zIndex = '10';

            const targetContainer = isPositionRight ? terminalContainer : terminalBottomContainer;
            if (term.element.parentElement !== targetContainer) {
                targetContainer.appendChild(term.element);
            }

            setTimeout(() => {
                fitTerminal(id);
                term.xterm.focus();
            }, 5);
        } else {
            term.element.style.visibility = 'hidden';
            term.element.style.opacity = '0';
            term.element.style.zIndex = '0';
        }
    });
}

async function closeTerminalSession(terminalId) {
    const term = terminals.get(terminalId);
    if (!term) return;

    if (term.resizeTimeout) clearTimeout(term.resizeTimeout);
    if (term.xterm) term.xterm.dispose();
    if (term.element) term.element.remove();
    terminals.delete(terminalId);

    if (terminalTabsList) {
        const tab = terminalTabsList.querySelector(`.terminal-tab[data-id="${terminalId}"]`);
        if (tab) tab.remove();
    }

    await window.electronAPI.closeTerminal(terminalId);

    if (activeTerminalId === terminalId) {
        activeTerminalId = null;
        if (terminals.size > 0) {
            switchTerminal(terminals.keys().next().value);
        }
    }
}

// ========== ターミナル・右ペイン表示状態更新 ==========
function updateTerminalVisibility() {
    const terminalHeader = document.getElementById('terminal-header');
    const terminalContainer = document.getElementById('terminal-container');
    const pdfPreviewHeader = document.getElementById('pdf-preview-header');
    const pdfPreviewContainer = document.getElementById('pdf-preview-container');
    const rightMarkdownContainer = document.getElementById('right-markdown-container');
    const rightPane = document.getElementById('right-pane');
    const resizerRight = document.getElementById('resizer-right');

    const btnTerminalRight = document.getElementById('btn-terminal-right');
    const btnPdfPreview = document.getElementById('btn-pdf-preview');
    const btnRightMarkdown = document.getElementById('btn-right-markdown');

    // 表示条件のロジック
    const showPdf = isPdfPreviewVisible;
    const showRightMarkdown = isRightMarkdownVisible;
    // ターミナルは「右配置」かつ「表示ON」のとき
    const showTerminalRight = isTerminalVisible && isPositionRight;
    
    // いずれかがONなら右ペインを表示
    const needRightPane = (showPdf || showTerminalRight || showRightMarkdown) && isRightActivityBarVisible;

    // 定数: サイドバー幅など
    const activityBarWidth = 40; 
    const minWidth = 150; // 最小幅

    if (needRightPane) {
        if (rightPane) rightPane.classList.remove('hidden');
        if (resizerRight) resizerRight.classList.remove('hidden');

        // 排他表示制御
        if (showPdf) {
            // PDF
            toggleVisibility(terminalHeader, false);
            toggleVisibility(terminalContainer, false);
            toggleVisibility(pdfPreviewHeader, true);
            toggleVisibility(pdfPreviewContainer, true);
            toggleVisibility(rightMarkdownContainer, false);
        } else if (showRightMarkdown) {
            // Markdown
            toggleVisibility(terminalHeader, false);
            toggleVisibility(terminalContainer, false);
            toggleVisibility(pdfPreviewHeader, false);
            toggleVisibility(pdfPreviewContainer, false);
            toggleVisibility(rightMarkdownContainer, true);
            
            // レイアウト再計算
            if (rightLayoutManager) rightLayoutManager.refreshAllEditors();
        } else {
            // Terminal
            toggleVisibility(terminalHeader, true);
            toggleVisibility(terminalContainer, true);
            toggleVisibility(pdfPreviewHeader, false);
            toggleVisibility(pdfPreviewContainer, false);
            toggleVisibility(rightMarkdownContainer, false);
        }
        
        // CSS変数で幅制御（必要であれば）
        // document.documentElement.style.setProperty('--right-pane-width', '...');

    } else {
        if (rightPane) rightPane.classList.add('hidden');
        if (resizerRight) resizerRight.classList.add('hidden');
    }

    // ボタンのアクティブ状態更新
    if (btnTerminalRight) btnTerminalRight.classList.toggle('active', showTerminalRight);
    if (btnPdfPreview) btnPdfPreview.classList.toggle('active', showPdf);
    if (btnRightMarkdown) btnRightMarkdown.classList.toggle('active', showRightMarkdown);
}



// ========== ヘッダーボタン切り替え ==========
function switchHeaderButtons(targetId) {
    const headerButtonsFiles = document.getElementById('header-buttons-files');
    const headerButtonsGit = document.getElementById('header-buttons-git');
    const headerButtonsOutline = document.getElementById('header-buttons-outline');

    if (headerButtonsFiles) headerButtonsFiles.classList.add('content-hidden');
    if (headerButtonsGit) headerButtonsGit.classList.add('content-hidden');
    if (headerButtonsOutline) headerButtonsOutline.classList.add('content-hidden');

    if (targetId === 'files' && headerButtonsFiles) {
        headerButtonsFiles.classList.remove('content-hidden');
    } else if (targetId === 'git' && headerButtonsGit) {
        headerButtonsGit.classList.remove('content-hidden');
    } else if (targetId === 'outline' && headerButtonsOutline) {
        headerButtonsOutline.classList.remove('content-hidden');
    }
}

// ========== イベントリスナー設定 ==========

if (btnTerminalRight) {
    btnTerminalRight.addEventListener('click', () => {
        if (isTerminalVisible && isPositionRight) {
            isTerminalVisible = false; // 閉じる
        } else {
            isTerminalVisible = true;
            isPdfPreviewVisible = false;
            isRightMarkdownVisible = false; // 他をOFF
        }
        updateTerminalVisibility();
    });
}

if (btnTogglePosition) {
    btnTogglePosition.addEventListener('click', () => {
        isPositionRight = !isPositionRight;
        requestAnimationFrame(() => {
            updateTerminalVisibility();
        });
    });
}

if (btnToggleLeftPane) {
    btnToggleLeftPane.addEventListener('click', () => {
        const willHide = !leftPane.classList.contains('hidden');

        document.body.classList.add('is-layout-changing');

        leftPane.classList.toggle('hidden', willHide);
        ideContainer.classList.toggle('left-pane-hidden', willHide);

        updateLeftPaneWidthVariable();

        leftPane.addEventListener('transitionend', () => {
            document.body.classList.remove('is-layout-changing');

            if (isTerminalVisible && !isPositionRight && activeTerminalId) {
                fitTerminal(activeTerminalId);
            }
        }, { once: true });

        setTimeout(() => {
            document.body.classList.remove('is-layout-changing');
        }, 300);
    });
}

topSideSwitchButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        if (!targetId) return;

        leftPane.classList.remove('hidden');
        ideContainer.classList.remove('left-pane-hidden');
        updateLeftPaneWidthVariable();

        topSideSwitchButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        leftPaneContents.forEach(content => content.classList.add('content-hidden'));

        const fileContentContainer = document.getElementById('content-files');
        if (fileContentContainer) {
            if (targetId === 'files') {
                fileContentContainer.classList.remove('content-hidden');
            } else {
                fileContentContainer.classList.add('content-hidden');
            }
        }

        const targetContent = document.getElementById('content-' + targetId);
        if (targetContent) {
            targetContent.classList.remove('content-hidden');
            if (targetId === 'outline') {
                updateOutline();
            }
        }

        switchHeaderButtons(targetId);
    });
});

if (btnZen) {
    btnZen.addEventListener('click', () => {
        const enteringZenMode = !ideContainer.classList.contains('zen-mode-active');

        if (enteringZenMode) {
            savedRightActivityBarState = isRightActivityBarVisible;
            isTerminalVisible = false;
            isPdfPreviewVisible = false;
            isRightActivityBarVisible = false;
            updateTerminalVisibility();
        }

        ideContainer.classList.toggle('zen-mode-active');
    });
}

if (btnPdfPreview) {
    btnPdfPreview.addEventListener('click', () => {
        togglePdfPreview();
    });
}

function togglePdfPreview() {
    if (isPdfPreviewVisible) {
        isPdfPreviewVisible = false;
    } else {
        isPdfPreviewVisible = true;
        isTerminalVisible = false;
        isRightMarkdownVisible = false; // 他をOFF
        generatePdfPreview();
    }
    updateTerminalVisibility();
}

// ★新規追加
if (btnRightMarkdown) {
    btnRightMarkdown.addEventListener('click', () => {
        if (isRightMarkdownVisible) {
            isRightMarkdownVisible = false;
        } else {
            isRightMarkdownVisible = true;
            isPdfPreviewVisible = false;
            if (isPositionRight) isTerminalVisible = false; // 右位置ならターミナルOFF
            
            // 右ペインが初期化されていなければファイルを1つ開く等の処理を入れても良い
            // 例: rightLayoutManager.activePane.openFile('README.md');
        }
        updateTerminalVisibility();
    });
}

async function generatePdfPreview() {
    try {
        const view = getActiveView();
        if (!view) return;
        const markdownContent = view.state.doc.toString();

        if (!markdownContent.trim()) {
            const canvas = document.getElementById('pdf-canvas');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        const processedMarkdown = await processMarkdownForExport(markdownContent);
        const htmlContent = marked.parse(processedMarkdown, { breaks: true, gfm: true });

        if (typeof window.electronAPI?.generatePdf === 'function') {
            await renderHtmlToPdf(htmlContent);
        } else {
            console.warn('PDF generation API not available, using fallback');
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlContent;
            await createCanvasBasedPreview(tempDiv);
        }
    } catch (error) {
        console.error('Failed to generate PDF preview:', error);
    }
}

async function processMarkdownForExport(markdown) {
    let processed = markdown.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    processed = processed.replace(/^(\s+)(\d+(?:-\d+)+\.)/gm, (match, indent, marker) => {
        return '&nbsp;'.repeat(indent.length) + marker;
    });

    const bookmarkRegex = /^@card\s+(https?:\/\/[^\s]+)$/gm;
    const matches = [...processed.matchAll(bookmarkRegex)];

    if (matches.length === 0) return processed;

    const replacements = await Promise.all(matches.map(async (match) => {
        const url = match[1];
        let data = null;

        if (!window.pdfMetadataCache) window.pdfMetadataCache = new Map();

        if (window.pdfMetadataCache.has(url)) {
            data = window.pdfMetadataCache.get(url);
        } else {
            try {
                const result = await window.electronAPI.fetchUrlMetadata(url);
                if (result.success) {
                    data = result.data;
                    window.pdfMetadataCache.set(url, data);
                }
            } catch (e) {
                console.error(e);
            }
        }

        if (!data) {
            return {
                original: match[0],
                replacement: `<div class="cm-bookmark-widget"><div class="cm-bookmark-content"><div class="cm-bookmark-title"><a href="${url}">${url}</a></div></div></div>`
            };
        }

        const faviconUrl = `https://www.google.com/s2/favicons?domain=${data.domain}&sz=32`;

        const html = `<a href="${data.url}" class="cm-bookmark-widget" target="_blank" rel="noopener noreferrer">
    <div class="cm-bookmark-content">
        <div class="cm-bookmark-title">${data.title}</div>
        <div class="cm-bookmark-desc">${data.description}</div>
        <div class="cm-bookmark-meta">
            <img src="${faviconUrl}" class="cm-bookmark-favicon">
            <span class="cm-bookmark-domain">${data.domain}</span>
        </div>
    </div>
    ${data.image ? `<div class="cm-bookmark-cover"><img src="${data.image}" class="cm-bookmark-image"></div>` : ''}
</a>`;

        return {
            original: match[0],
            replacement: html
        };
    }));

    for (const item of replacements) {
        processed = processed.replaceAll(item.original, item.replacement);
    }

    return processed;
}

async function renderHtmlToPdf(htmlContent) {
    try {
        const pdfData = await window.electronAPI.generatePdf(htmlContent);
        if (pdfData) {
            await displayPdfFromData(pdfData);
        }
    } catch (error) {
        console.error('Error rendering HTML to PDF:', error);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        await createCanvasBasedPreview(tempDiv);
    }
}

async function createCanvasBasedPreview(htmlElement) {
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = 794;
    canvas.height = 1123;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'black';
    ctx.font = '14px Arial';

    const text = htmlElement.textContent;
    const lines = text.split('\n');
    const lineHeight = 20;
    const maxLines = Math.floor((canvas.height - 80) / lineHeight);
    const currentPageLines = lines.slice(0, maxLines);

    let y = 50;
    currentPageLines.forEach(line => {
        const words = line.split(' ');
        let currentLine = '';
        const maxWidth = canvas.width - 100;

        words.forEach(word => {
            const testLine = currentLine + word + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine !== '') {
                ctx.fillText(currentLine, 50, y);
                currentLine = word + ' ';
                y += lineHeight;
            } else {
                currentLine = testLine;
            }
        });
        ctx.fillText(currentLine, 50, y);
        y += lineHeight;
    });
}

async function displayPdfFromData(pdfData) {
    try {
        // Ensure PDF.js is loaded
        await loadPdfJs();
        
        if (!pdfjsLib) {
            console.error('PDF.js library not loaded');
            return;
        }

        const pdfDataArray = Uint8Array.from(atob(pdfData), c => c.charCodeAt(0));
        const loadingTask = pdfjsLib.getDocument({ data: pdfDataArray });
        pdfDocument = await loadingTask.promise;

        const pageInfo = document.getElementById('pdf-page-info');
        if (pageInfo) {
            pageInfo.textContent = `全 ${pdfDocument.numPages} ページ`;
        }

        const container = document.getElementById('pdf-preview-container');
        if (!container) return;
        container.innerHTML = '';

        for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
            await renderPageToContainer(pageNum, container);
        }

    } catch (error) {
        console.error('Error displaying PDF:', error);
    }
}

async function renderPageToContainer(pageNumber, container) {
    try {
        const page = await pdfDocument.getPage(pageNumber);
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        container.appendChild(canvas);

        const context = canvas.getContext('2d');
        const viewport = page.getViewport({ scale: 1.5 });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
            canvasContext: context,
            viewport: viewport
        };

        await page.render(renderContext).promise;

    } catch (error) {
        console.error(`Error rendering page ${pageNumber}:`, error);
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (ideContainer.classList.contains('zen-mode-active')) {
            ideContainer.classList.remove('zen-mode-active');
            isRightActivityBarVisible = savedRightActivityBarState;
            updateTerminalVisibility();
        }
    }
});

if (btnSettings) {
    btnSettings.addEventListener('click', () => {
        openSettingsTab();
    });
}

if (btnToggleRightActivity) {
    btnToggleRightActivity.addEventListener('click', () => {
        isRightActivityBarVisible = !isRightActivityBarVisible;
        updateTerminalVisibility();
    });
}

if (btnMinimize) {
    btnMinimize.addEventListener('click', () => {
        window.electronAPI.minimizeWindow();
    });
}

if (btnMaximize) {
    btnMaximize.addEventListener('click', () => {
        window.electronAPI.maximizeWindow();
        isMaximized = !isMaximized;

        const iconMax = btnMaximize.querySelector('.icon-maximize');
        const iconRestore = btnMaximize.querySelector('.icon-restore');

        if (isMaximized) {
            if (iconMax) iconMax.classList.add('hidden');
            if (iconRestore) iconRestore.classList.remove('hidden');
            btnMaximize.title = "元に戻す";
        } else {
            if (iconMax) iconMax.classList.remove('hidden');
            if (iconRestore) iconRestore.classList.add('hidden');
            btnMaximize.title = "最大化";
        }
    });
}

if (btnClose) {
    btnClose.addEventListener('click', () => {
        window.electronAPI.closeWindow();
    });
}

const btnSortAsc = document.getElementById('btn-sort-asc');
const btnSortDesc = document.getElementById('btn-sort-desc');

if (btnSortAsc) {
    btnSortAsc.addEventListener('click', () => {
        currentSortOrder = 'asc';
        initializeFileTree();
    });
}

if (btnSortDesc) {
    btnSortDesc.addEventListener('click', () => {
        currentSortOrder = 'desc';
        initializeFileTree();
    });
}

const btnGitStage = document.getElementById('btn-git-stage');
const btnGitUnstage = document.getElementById('btn-git-unstage');
const btnGitRefresh = document.getElementById('btn-git-refresh');

if (btnGitStage) {
    btnGitStage.addEventListener('click', () => {
        console.log('すべての変更をステージングしました。(処理未実装)');
    });
}

if (btnGitUnstage) {
    btnGitUnstage.addEventListener('click', () => {
        console.log('すべての変更をアンステージングしました。(処理未実装)');
    });
}

if (btnGitRefresh) {
    btnGitRefresh.addEventListener('click', () => {
        console.log('Gitの状態を更新しました。(処理未実装)');
    });
}

const outlineTree = document.getElementById('outline-tree');
const btnOutlineCollapse = document.getElementById('btn-outline-collapse');
const btnOutlineExpand = document.getElementById('btn-outline-expand');

function updateOutline() {
    const view = getActiveView();
    const outlineTree = document.getElementById('outline-tree');
    if (!outlineTree || !view) {
        if(outlineTree) outlineTree.innerHTML = '<li style="color: #999; padding: 5px;">見出しがありません</li>';
        return;
    }

    const content = view.state.doc.toString();
    const headers = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        const match = line.match(/^(#{1,6})\s+(.*)/);
        if (match) {
            headers.push({
                level: match[1].length,
                text: match[2],
                lineNumber: index
            });
        }
    });

    if (headers.length === 0) {
        outlineTree.innerHTML = '<li style="color: #999; padding: 5px;">見出しがありません</li>';
        return;
    }

    let html = '';
    headers.forEach((header, i) => {
        const paddingLeft = (header.level - 1) * 15 + 5;
        const fontSize = Math.max(14 - (header.level - 1), 11);

        html += `<li class="outline-item" data-line="${header.lineNumber}" data-level="${header.level}" style="padding-left: ${paddingLeft}px; font-size: ${fontSize}px;">
            <span class="outline-text">${header.text}</span>
        </li>`;
    });

    outlineTree.innerHTML = html;

    const items = outlineTree.querySelectorAll('.outline-item');
    items.forEach(item => {
        item.addEventListener('click', () => {
            const lineNum = parseInt(item.dataset.line);
            scrollToLine(lineNum);
            items.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

function scrollToLine(lineNumber) {
    const view = getActiveView();
    if (!view) return;
    const line = view.state.doc.line(lineNumber + 1);

    view.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true
    });
    view.focus();
}

if (btnOutlineCollapse) {
    btnOutlineCollapse.addEventListener('click', () => {
        const items = outlineTree.querySelectorAll('.outline-item');
        items.forEach(item => {
            const level = parseInt(item.dataset.level);
            if (level > 1) {
                item.classList.add('hidden-outline-item');
            } else {
                item.classList.remove('hidden-outline-item');
            }
        });
    });
}

if (btnOutlineExpand) {
    btnOutlineExpand.addEventListener('click', () => {
        const items = outlineTree.querySelectorAll('.outline-item');
        items.forEach(item => {
            item.classList.remove('hidden-outline-item');
        });
    });
}

const resizerRight = document.getElementById('resizer-right');
const resizerBottom = document.getElementById('resizer-bottom');
let isResizingRight = false;
let isResizingBottom = false;

if (resizerRight) {
    resizerRight.addEventListener('mousedown', () => {
        isResizingRight = true;
        resizerRight.classList.add('resizing');
        document.body.classList.add('is-resizing-col');
    });
}

if (resizerBottom) {
    resizerBottom.addEventListener('mousedown', () => {
        isResizingBottom = true;
        resizerBottom.classList.add('resizing');
        document.body.classList.add('is-resizing-row');
    });
}

document.addEventListener('mousemove', (e) => {
    if (isResizingRight && resizerRight) {
        const rightActivityBarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--activitybar-width')) || 50;
        const newWidth = window.innerWidth - e.clientX - rightActivityBarWidth;

        if (newWidth > 100 && newWidth < 800) {
            rightPane.style.width = newWidth + 'px';
            resizerRight.style.right = (newWidth + rightActivityBarWidth) + 'px';
            document.documentElement.style.setProperty('--right-pane-width', newWidth + 'px');
            const mainContent = centerPane.parentElement;
            mainContent.style.marginRight = (newWidth + rightActivityBarWidth) + 'px';

            if (activeTerminalId) {
                requestAnimationFrame(() => fitTerminal(activeTerminalId));
            }
        }
    }

    if (isResizingBottom && resizerBottom) {
        const newHeight = window.innerHeight - e.clientY - 24;

        if (newHeight > 50 && newHeight < window.innerHeight - 200) {
            bottomPane.style.height = newHeight + 'px';
            resizerBottom.style.top = (window.innerHeight - newHeight - 24) + 'px';

            centerPane.style.marginBottom = newHeight + 'px';

            if (activeTerminalId) {
                requestAnimationFrame(() => fitTerminal(activeTerminalId));
            }
        }
    }
});

document.addEventListener('mouseup', () => {
    if (isResizingRight) {
        isResizingRight = false;
        if (resizerRight) resizerRight.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');
        if (activeTerminalId) setTimeout(() => fitTerminal(activeTerminalId), 50);
    }
    if (isResizingBottom) {
        isResizingBottom = false;
        if (resizerBottom) resizerBottom.classList.remove('resizing');
        document.body.classList.remove('is-resizing-row');
        if (activeTerminalId) setTimeout(() => fitTerminal(activeTerminalId), 50);
    }
});

if (fileTitleInput) {
    fileTitleInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fileTitleInput.blur();
        }
    });

    fileTitleInput.addEventListener('blur', async () => {
        const newName = fileTitleInput.value.trim();
        const activePane = layoutManager.activePane;
        if (!activePane || !activePane.activeFilePath) return;
        
        const currentFilePath = activePane.activeFilePath;

        const separator = currentFilePath.includes('\\') ? '\\' : '/';
        const currentFileName = currentFilePath.split(separator).pop();
        const currentExt = currentFileName.includes('.') ? '.' + currentFileName.split('.').pop() : '';
        const currentNameWithoutExt = currentFileName.replace(currentExt, '');

        if (newName === currentNameWithoutExt) return;

        try {
            if (typeof window.electronAPI?.renameFile === 'function') {
                const result = await window.electronAPI.renameFile(currentFilePath, newName);

                if (result.success) {
                    const oldPath = currentFilePath;
                    const newPath = result.path;
                    const newFileName = newPath.split(separator).pop();

                    const fileData = openedFiles.get(oldPath);
                    if (fileData) {
                        fileData.fileName = newFileName;
                        openedFiles.set(newPath, fileData);
                        openedFiles.delete(oldPath);
                    }

                    if (fileModificationState.has(oldPath)) {
                        fileModificationState.set(newPath, fileModificationState.get(oldPath));
                        fileModificationState.delete(oldPath);
                    }

                    // Update all panes
                    layoutManager.panes.forEach(pane => {
                        const idx = pane.files.indexOf(oldPath);
                        if (idx !== -1) {
                            pane.files[idx] = newPath;
                            if (pane.activeFilePath === oldPath) {
                                pane.activeFilePath = newPath;
                            }
                            pane.updateTabs();
                        }
                    });

                    document.title = `${newFileName} - Markdown IDE`;
                    initializeFileTreeWithState();

                    console.log(`Renamed ${oldPath} to ${newPath}`);
                } else {
                    console.error('Rename failed:', result.error);
                    alert(`ファイル名の変更に失敗しました: ${result.error}`);
                    fileTitleInput.value = currentNameWithoutExt;
                }
            }
        } catch (e) {
            console.error('Error during rename:', e);
            fileTitleInput.value = currentNameWithoutExt;
        }
    });
}

function startRenaming(treeItem) {
    const labelSpan = treeItem.querySelector('.tree-label');
    if (!labelSpan) return;

    const originalName = treeItem.dataset.name;
    const originalPath = treeItem.dataset.path;

    labelSpan.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = originalName;

    treeItem.appendChild(input);
    input.focus();

    const lastDotIndex = originalName.lastIndexOf('.');
    if (lastDotIndex > 0) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    let isCommitted = false;

    const finish = async (shouldCommit) => {
        if (isCommitted) return;
        isCommitted = true;

        const newName = input.value.trim();

        input.remove();
        labelSpan.style.display = '';

        if (shouldCommit && newName && newName !== originalName) {
            try {
                if (typeof window.electronAPI?.renameFile === 'function') {
                    const result = await window.electronAPI.renameFile(originalPath, newName);
                    if (result.success) {
                        showNotification(`名前を変更しました: ${newName}`, 'success');
                        
                        // Update global openedFiles map
                        const fileData = openedFiles.get(originalPath);
                        if (fileData) {
                            fileData.fileName = newName;
                            openedFiles.set(result.path, fileData);
                            openedFiles.delete(originalPath);
                        }
                        
                        // Update tabs in all panes
                        layoutManager.panes.forEach(pane => {
                            const idx = pane.files.indexOf(originalPath);
                            if (idx !== -1) {
                                pane.files[idx] = result.path;
                                if (pane.activeFilePath === originalPath) pane.activeFilePath = result.path;
                                pane.updateTabs();
                            }
                        });

                        initializeFileTreeWithState();
                    } else {
                        showNotification(`名前の変更に失敗しました: ${result.error}`, 'error');
                    }
                }
            } catch (e) {
                console.error(e);
                showNotification(`エラー: ${e.message}`, 'error');
            }
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
        }
    });

    input.addEventListener('blur', () => {
        finish(true);
    });

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('dragstart', (e) => e.stopPropagation());
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            toast.remove();
        });
    }, 3000);
}

function setupFileExplorerEvents() {
    const fileContentContainer = document.getElementById('content-files');
    if (fileContentContainer) {
        fileContentContainer.addEventListener('click', (e) => {
            if (e.target.closest('.tree-item')) return;

            const container = document.getElementById('content-files');
            if (container) {
                container.focus();
                const selectedItems = container.querySelectorAll('.tree-item.selected');
                selectedItems.forEach(el => el.classList.remove('selected'));
            }
        });
    }
}

// ========== ファイルシステム操作 ==========

async function openFile(filePath, fileName) {
    const normalizedPath = path.resolve(filePath);

    try {
        if (openedFiles.has('README.md')) {
            // Check if we should close readme (if untouchend)
        }

        let fileContent = '';
        if (openedFiles.has(normalizedPath)) {
            fileContent = openedFiles.get(normalizedPath).content;
        } else {
            if (typeof window.electronAPI?.loadFile === 'function') {
                try {
                    fileContent = await window.electronAPI.loadFile(normalizedPath);
                } catch (error) {
                    console.error('Failed to load file content:', error);
                    fileContent = `ファイルを読み込めません: ${error.message}`;
                }
            } else {
                fileContent = `ファイル: ${fileName}\n(内容は読み込めません)`;
            }
            openedFiles.set(normalizedPath, { content: fileContent, fileName: fileName });
        }

        if (layoutManager.activePane) {
            layoutManager.activePane.openFile(normalizedPath);
        } else {
            console.warn("No active pane to open file");
        }

    } catch (error) {
        console.error('Failed to open file:', error);
    }
}

function showWelcomeReadme() {
    const readmePath = 'README.md';
    if (openedFiles.has(readmePath)) return;

    openedFiles.set(readmePath, {
        content: startDoc,
        fileName: 'README.md'
    });

    if (layoutManager.activePane) {
        layoutManager.activePane.openFile(readmePath);
    }
}

async function saveCurrentFile(isSaveAs = false) {
    const pane = layoutManager.activePane;
    if (!pane || !pane.activeFilePath) {
        console.warn('ファイルが選択されていません');
        return;
    }
    if (pane.activeFilePath === 'README.md') return;

    try {
        const content = pane.editorView.state.doc.toString();
        if (typeof window.electronAPI?.saveFile === 'function') {
            await window.electronAPI.saveFile(pane.activeFilePath, content);

            const fileData = openedFiles.get(pane.activeFilePath);
            if (fileData) {
                fileData.content = content;
            }
            fileModificationState.delete(pane.activeFilePath);
            pane.updateTabs();
            
            console.log(`✅ ファイルを保存しました: ${pane.activeFilePath}`);
        }
    } catch (error) {
        console.error('Failed to save file:', error);
    }
}

// ========== File Tree Helpers ==========

async function initializeFileTreeWithState() {
    const fileTreeContainer = document.getElementById('file-tree-container');
    if (!fileTreeContainer) return;

    const expandedPaths = new Set();
    const items = fileTreeContainer.querySelectorAll('.tree-item');
    items.forEach(item => {
        const toggle = item.querySelector('.tree-toggle');
        if (toggle && toggle.textContent === '▼' && item.nextElementSibling && item.nextElementSibling.style.display !== 'none') {
            expandedPaths.add(item.dataset.path);
        }
    });
    if (currentDirectoryPath) expandedPaths.add(currentDirectoryPath);

    await initializeFileTree();

    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);

    const newContainer = document.getElementById('file-tree-container');
    if (!newContainer) return;

    for (const path of sortedPaths) {
        const item = newContainer.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
        if (item) {
            const toggle = item.querySelector('.tree-toggle');
            if (toggle && toggle.textContent === '▶') {
                await toggleFolder(item);
            }
        }
    }
}

async function initializeFileTree() {
    try {
        if (typeof window.electronAPI?.getCurrentDirectory === 'function') {
            currentDirectoryPath = await window.electronAPI.getCurrentDirectory();
        } else {
            currentDirectoryPath = '.';
        }

        const fileTreeContainer = document.getElementById('file-tree-container');
        if (!fileTreeContainer) return;

        const newFileTreeContainer = fileTreeContainer.cloneNode(true);
        fileTreeContainer.parentNode.replaceChild(newFileTreeContainer, fileTreeContainer);

        const rootItem = newFileTreeContainer.querySelector('.tree-item.expanded');

        if (rootItem) {
            rootItem.dataset.path = currentDirectoryPath;
            const rootLabel = rootItem.querySelector('.tree-label');
            if (rootLabel) {
                const folderName = currentDirectoryPath.split(/[/\\]/).pop() || currentDirectoryPath;
                rootLabel.textContent = folderName;
            }
            const rootChildren = rootItem.nextElementSibling;
            if (rootChildren) rootChildren.innerHTML = '';
            await loadDirectoryTreeContents(rootItem, currentDirectoryPath);

            rootItem.addEventListener('dragover', handleDragOver);
            rootItem.addEventListener('dragleave', handleDragLeave);
            rootItem.addEventListener('drop', handleDrop);
        }

        newFileTreeContainer.addEventListener('dragover', handleDragOver);
        newFileTreeContainer.addEventListener('drop', handleDrop);

        newFileTreeContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.tree-item');

            if (!item) {
                return;
            }

            if (item.classList.contains('creation-mode')) return;
            if (e.target.tagName.toLowerCase() === 'input') return;

            e.stopPropagation();

            newFileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            if (item.classList.contains('file')) {
                openFile(item.dataset.path, item.dataset.name);
            } else {
                toggleFolder(item);
            }
        });

        newFileTreeContainer.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;
            if (item.classList.contains('creation-mode')) return;
            if (item.querySelector('input')) return;

            e.preventDefault();
            e.stopPropagation();

            newFileTreeContainer.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            showContextMenu(e.pageX, e.pageY, item.dataset.path, item.dataset.name);
        });

    } catch (error) {
        console.error('Failed to initialize file tree:', error);
    }
}

async function loadDirectoryTreeContents(folderElement, dirPath) {
    let childrenContainer = folderElement.nextElementSibling;
    if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
    }

    childrenContainer.innerHTML = '';

    const items = await getSortedDirectoryContents(dirPath);
    if (items && items.length > 0) {
        items.forEach(item => {
            const element = createTreeElement(item, dirPath);
            childrenContainer.appendChild(element);
        });
    }
}

async function toggleFolder(folderElement) {
    const toggle = folderElement.querySelector('.tree-toggle');
    if (!toggle) return;

    const folderPath = folderElement.dataset.path;
    const isExpanded = toggle.textContent === '▼';

    if (isExpanded) {
        toggle.textContent = '▶';
        const childrenContainer = folderElement.nextElementSibling;
        if (childrenContainer && childrenContainer.classList.contains('tree-children')) {
            childrenContainer.style.display = 'none';
        }
    } else {
        toggle.textContent = '▼';
        let childrenContainer = folderElement.nextElementSibling;
        if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) {
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            folderElement.parentNode.insertBefore(childrenContainer, folderElement.nextSibling);
        }

        childrenContainer.style.display = 'block';

        await loadDirectoryTreeContents(folderElement, folderPath);
    }
}

async function reloadContainer(container, path) {
    container.innerHTML = '';
    const items = await getSortedDirectoryContents(path);
    items.forEach(item => {
        const element = createTreeElement(item, path);
        container.appendChild(element);
    });
}

async function getSortedDirectoryContents(dirPath) {
    let items = await readDirectory(dirPath);
    return items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return b.isDirectory ? 1 : -1;
        }
        const comparison = a.name.localeCompare(b.name);
        return currentSortOrder === 'asc' ? comparison : -comparison;
    });
}

async function readDirectory(dirPath) {
    try {
        if (typeof window.electronAPI?.readDirectory === 'function') {
            return await window.electronAPI.readDirectory(dirPath);
        } else {
            return [];
        }
    } catch (error) {
        console.error('Failed to read directory:', error);
        return [];
    }
}

function getFileIconData(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        'md': { text: 'M↓', color: '#519aba' },
        'markdown': { text: 'M↓', color: '#519aba' },
        'js': { text: 'JS', color: '#f1e05a' },
        'ts': { text: 'TS', color: '#2b7489' },
        'html': { text: '<>', color: '#e34c26' },
        'css': { text: '#', color: '#563d7c' },
        'json': { text: '{}', color: '#cbcb41' },
        'py': { text: 'Py', color: '#3572a5' },
        'java': { text: 'J', color: '#b07219' },
        'c': { text: 'C', color: '#555555' },
        'cpp': { text: '++', color: '#f34b7d' },
        'txt': { text: '≡', color: '#d4d4d4' },
        'gitignore': { text: 'git', color: '#f44d27' },
        'png': { text: 'img', color: '#b07219' },
        'jpg': { text: 'img', color: '#b07219' },
        'svg': { text: 'SVG', color: '#ff9900' }
    };
    return iconMap[ext] || { text: '📄', color: '#90a4ae' };
}

// ========== ドラッグ&ドロップ処理 ==========

function handleDragStart(e) {
    const item = e.target.closest('.tree-item');

    if (!item || !item.dataset.path || item.dataset.path === currentDirectoryPath) {
        e.preventDefault();
        return;
    }

    e.dataTransfer.setData('text/plain', item.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
}

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        if (!targetItem.classList.contains('file')) {
            targetItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    } else {
        e.dataTransfer.dropEffect = 'move';
    }
}

function handleDragLeave(e) {
    const targetItem = e.target.closest('.tree-item');
    if (targetItem) {
        targetItem.classList.remove('drag-over');
    }
}

async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    const targetItem = e.target.closest('.tree-item');
    if (targetItem) targetItem.classList.remove('drag-over');

    const srcPath = e.dataTransfer.getData('text/plain');
    if (!srcPath) return;

    try {
        const jsonData = JSON.parse(srcPath);
        if (jsonData.paneId) return; 
    } catch(e) {}

    let destFolderPath;

    if (targetItem) {
        if (targetItem.classList.contains('file')) return;
        destFolderPath = targetItem.dataset.path;
    } else {
        destFolderPath = currentDirectoryPath;
    }

    if (!destFolderPath) return;

    if (srcPath === destFolderPath) return;

    const fileName = srcPath.split(/[/\\]/).pop();

    const destSep = destFolderPath.includes('\\') ? '\\' : '/';

    let destPath = destFolderPath;
    if (!destPath.endsWith(destSep)) {
        destPath += destSep;
    }
    destPath += fileName;

    if (srcPath !== destPath) {
        try {
            if (typeof window.electronAPI?.moveFile === 'function') {
                const result = await window.electronAPI.moveFile(srcPath, destPath);
                if (result.success) {
                    showNotification(`移動しました: ${fileName}`, 'success');
                } else {
                    showNotification(`移動に失敗しました: ${result.error}`, 'error');
                }
            }
        } catch (error) {
            console.error('Move failed:', error);
            showNotification(`エラーが発生しました: ${error.message}`, 'error');
        }
    }
}

function createTreeElement(item, parentPath) {
    const itemPath = item.path || `${parentPath}/${item.name}`;

    const container = document.createElement('div');
    container.className = 'tree-item' + (item.isDirectory ? '' : ' file');
    container.dataset.path = itemPath;
    container.dataset.name = item.name;

    container.draggable = true;
    container.addEventListener('dragstart', handleDragStart);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('drop', handleDrop);

    if (item.isDirectory) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = '▶';
        container.appendChild(toggle);
    }

    const icon = document.createElement('span');
    icon.className = 'tree-icon';

    if (item.isDirectory) {
        icon.textContent = '📁';
        icon.style.color = '#dcb67a';
    } else {
        const iconData = getFileIconData(item.name);
        icon.textContent = iconData.text;
        icon.style.color = iconData.color;
        icon.classList.add('file-icon-styled');
    }

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = item.name;

    container.appendChild(icon);
    container.appendChild(label);

    return container;
}

// ========== 新規作成機能 ==========
async function showCreationInput(isFolder) {
    const fileTree = document.getElementById('file-tree-container');
    let targetContainer = null;
    let targetPath = currentDirectoryPath;

    const selectedItem = fileTree.querySelector('.tree-item.selected');

    if (selectedItem) {
        const path = selectedItem.dataset.path;
        const isDir = !selectedItem.classList.contains('file');

        if (isDir) {
            targetPath = path;
            const toggle = selectedItem.querySelector('.tree-toggle');
            if (toggle.textContent === '▶') {
                await toggleFolder(selectedItem);
            }
            targetContainer = selectedItem.nextElementSibling;
        } else {
            targetContainer = selectedItem.parentNode;
            const parentFolderItem = targetContainer.previousElementSibling;
            if (parentFolderItem && parentFolderItem.classList.contains('tree-item')) {
                targetPath = parentFolderItem.dataset.path;
            }
        }
    } else {
        const rootItem = fileTree.querySelector('.tree-item.expanded');
        if (rootItem) {
            targetPath = rootItem.dataset.path;
            targetContainer = rootItem.nextElementSibling;
        }
    }

    if (!targetContainer) return;

    const inputDiv = document.createElement('div');
    inputDiv.className = 'tree-item creation-mode';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'tree-icon';
    iconSpan.textContent = isFolder ? '📁' : '📄';

    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.className = 'creation-input';
    inputField.placeholder = isFolder ? 'フォルダ名' : 'ファイル名.md';

    inputDiv.appendChild(iconSpan);
    inputDiv.appendChild(inputField);

    if (targetContainer.firstChild) {
        targetContainer.insertBefore(inputDiv, targetContainer.firstChild);
    } else {
        targetContainer.appendChild(inputDiv);
    }

    inputField.focus();

    let isCreating = false;

    const safeRemove = () => {
        if (inputDiv && inputDiv.parentNode) {
            inputDiv.remove();
        }
    };

    const finishCreation = async () => {
        if (isCreating) return;
        isCreating = true;

        const name = inputField.value.trim();
        if (!name) {
            safeRemove();
            isCreating = false;
            return;
        }

        const newPath = path.join(targetPath, name);

        try {
            if (isFolder) {
                if (typeof window.electronAPI?.createDirectory === 'function') {
                    await window.electronAPI.createDirectory(newPath);
                }
            } else {
                if (typeof window.electronAPI?.saveFile === 'function') {
                    await window.electronAPI.saveFile(newPath, '');
                }
            }

            safeRemove();
            await reloadContainer(targetContainer, targetPath);

            if (!isFolder) {
                openFile(newPath, name);
            }

        } catch (e) {
            console.error(e);
            safeRemove();
        } finally {
            isCreating = false;
        }
    };

    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishCreation();
        } else if (e.key === 'Escape') {
            if (!isCreating) safeRemove();
        }
    });

    inputField.addEventListener('blur', () => {
        if (!isCreating) {
            setTimeout(safeRemove, 100);
        }
    });
}

const btnOpenFolder = document.getElementById('btn-open-folder');
if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
        try {
            if (typeof window.electronAPI?.selectFolder !== 'function') return;
            const result = await window.electronAPI.selectFolder();
            if (result.success && result.path) {
                await initializeFileTree();
            }
        } catch (error) {
            console.error('Failed to open folder:', error);
        }
    });
}

if (document.getElementById('btn-new-file')) {
    document.getElementById('btn-new-file').addEventListener('click', () => showCreationInput(false));
}

if (document.getElementById('btn-new-folder')) {
    document.getElementById('btn-new-folder').addEventListener('click', () => showCreationInput(true));
}

// ========== ショートカットキーと削除機能 ==========
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }

    // Ctrl+W: Close Tab
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (layoutManager.activePane && layoutManager.activePane.activeFilePath) {
            layoutManager.activePane.closeFile(layoutManager.activePane.activeFilePath);
        }
    }

    if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (activeTag === 'input' || activeTag === 'textarea' || document.activeElement.classList.contains('cm-content')) return;

        const selectedItem = document.getElementById('file-tree-container')?.querySelector('.tree-item.selected');
        if (selectedItem) {
            if (selectedItem.classList.contains('creation-mode')) return;

            const path = selectedItem.dataset.path;
            const name = selectedItem.dataset.name;
            if (path && name) {
                showModalConfirm(name, () => {
                    confirmAndDelete(path);
                });
            }
        }
    }
});

function showModalConfirm(itemName, onConfirm) {
    const existingModal = document.querySelector('.modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = `「${itemName}」を本当に削除しますか？\n（フォルダの場合は中身も削除されます）`;

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'キャンセル';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'modal-btn primary';
    deleteBtn.textContent = '削除';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(deleteBtn);
    content.appendChild(message);
    content.appendChild(buttons);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const closeModal = () => {
        overlay.remove();
    };

    cancelBtn.addEventListener('click', closeModal);

    deleteBtn.addEventListener('click', () => {
        onConfirm();
        closeModal();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

async function confirmAndDelete(path) {
    try {
        if (typeof window.electronAPI?.deleteFile === 'function') {
            const success = await window.electronAPI.deleteFile(path);

            if (success) {
                layoutManager.panes.forEach(pane => {
                    const filesToClose = pane.files.filter(fp => fp === path || fp.startsWith(path + '\\') || fp.startsWith(path + '/'));
                    filesToClose.forEach(fp => pane.closeFile(fp));
                });

                for (const [filePath, _] of openedFiles) {
                    if (filePath === path || filePath.startsWith(path + '\\') || filePath.startsWith(path + '/')) {
                        openedFiles.delete(filePath);
                        fileModificationState.delete(filePath);
                    }
                }

                showNotification('削除しました', 'success');
            } else {
                showNotification('ファイルの削除に失敗しました（ファイルが見つからない可能性があります）', 'error');
            }
        }
    } catch (error) {
        console.error('Delete failed:', error);
        showNotification(`削除エラー: ${error.message}`, 'error');
    }
}

let activeContextMenu = null;

function showContextMenu(x, y, path, name) {
    if (activeContextMenu) activeContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const renameOption = document.createElement('div');
    renameOption.className = 'context-menu-item';
    renameOption.textContent = '名前の変更';
    renameOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
        if (treeItem) {
            startRenaming(treeItem);
        }
    });

    const deleteOption = document.createElement('div');
    deleteOption.className = 'context-menu-item';
    deleteOption.textContent = '削除';
    deleteOption.addEventListener('click', () => {
        menu.remove();
        activeContextMenu = null;
        showModalConfirm(name, () => {
            confirmAndDelete(path);
        });
    });

    menu.appendChild(renameOption);
    menu.appendChild(deleteOption);
    document.body.appendChild(menu);
    activeContextMenu = menu;
}

document.addEventListener('click', () => {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
});

// ヘルパー: 要素の表示切り替え（これを追加してください）
function toggleVisibility(element, isVisible) {
    if (!element) return;
    if (isVisible) element.classList.remove('hidden');
    else element.classList.add('hidden');
}

// renderer.js の末尾付近に追加
function toggleVisibility(element, isVisible) {
    if (!element) return;
    if (isVisible) element.classList.remove('hidden');
    else element.classList.add('hidden');
}

// ★新規追加: サイドバーのボタンイベントを登録する関数
function setupSideBarEvents() {
    console.log("🔍 [Debug] setupSideBarEvents started.");

    const btnTerminalRight = document.getElementById('btn-terminal-right');
    const btnPdfPreview = document.getElementById('btn-pdf-preview');
    const btnRightMarkdown = document.getElementById('btn-right-markdown');

    console.log(`   - btnTerminalRight found: ${!!btnTerminalRight}`);
    console.log(`   - btnPdfPreview found: ${!!btnPdfPreview}`);
    console.log(`   - btnRightMarkdown found: ${!!btnRightMarkdown}`);

    if (btnTerminalRight) {
        btnTerminalRight.onclick = () => {
            console.log("🖱️ [Click] btnTerminalRight clicked.");
            if (isTerminalVisible && isPositionRight) {
                isTerminalVisible = false; 
            } else {
                isTerminalVisible = true;
                isPdfPreviewVisible = false;
                isRightMarkdownVisible = false; 
            }
            updateTerminalVisibility();
        };
    }

    if (btnPdfPreview) {
        btnPdfPreview.onclick = () => {
            console.log("🖱️ [Click] btnPdfPreview clicked.");
            togglePdfPreview();
        };
    }

    if (btnRightMarkdown) {
        btnRightMarkdown.onclick = () => {
            console.log("🖱️ [Click] btnRightMarkdown clicked.");
            if (isRightMarkdownVisible) {
                isRightMarkdownVisible = false;
            } else {
                isRightMarkdownVisible = true;
                isPdfPreviewVisible = false;
                if (isPositionRight) isTerminalVisible = false; 
            }
            updateTerminalVisibility();
        };
    }
}

// ========== Initialization ==========

// renderer.js の最後の window.load イベント内
window.addEventListener('load', async () => {
    console.log("🚀 [Debug] window.load event fired.");
    // ... (既存のコード: appSettings読み込みなど) ...

    // ★変更: LayoutManagerの初期化
    if (typeof LayoutManager !== 'undefined') {
        // 1. メインのLayoutManager初期化
        console.log("👉 [Debug] Initializing Main LayoutManager...");
        mainLayoutManager = new LayoutManager('pane-root', 'content-readme');
        mainLayoutManager.init();
        activeLayoutManager = mainLayoutManager; 

        // 2. 右側のLayoutManager初期化
        console.log("👉 [Debug] Initializing Right LayoutManager...");
        rightLayoutManager = new LayoutManager('right-pane-root', 'right-markdown-container');
        rightLayoutManager.init();
    } else {
        console.error('Critical Error: LayoutManager class is undefined');
    }

    // ★追加: サイドバーのボタンイベントをセットアップ
    setupSideBarEvents();
    
    // ... (既存のコード: fileSystem.init() など) ...
    console.log("👉 [Debug] Setting up sidebar events...");
    setupSideBarEvents();
    
    console.log("✅ [Debug] Initialization sequence completed.");
    
});

