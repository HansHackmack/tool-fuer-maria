'use strict';

/* ================================================================
   Redaktions-Webtool — editor.js
   ================================================================ */


/* ── Globaler Zustand ────────────────────────────────────────── */

let savedRange        = null;
let tableGridDims     = { rows: 0, cols: 0 };
let imageCounter      = 0;
let editingImageEl    = null;
let syncingFromSource = false;
let cm                = null;
let currentHoveredTable = null;
let currentHoveredSpan  = null;
let hideOverlayTimer    = null;


/* ── DOM-Referenzen ─────────────────────────────────────────── */

const editor          = document.getElementById('editor');
const sourceView      = document.getElementById('source-view');
const tableGridPicker = document.getElementById('table-grid-picker');
const tableGrid       = document.getElementById('table-grid');
const tableGridLabel  = document.getElementById('table-grid-label');
const tableDeleteBtn  = document.getElementById('table-delete-btn');
const spanRemoveBtn   = document.getElementById('span-remove-btn');


/* ================================================================
   Selection-Verwaltung
   ================================================================ */

function saveSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
  updateToolbarState();
}

function restoreSelection() {
  if (!savedRange) return false;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
  return true;
}

function isSelectionInEditor(range) {
  if (!range) return false;
  return editor.contains(range.commonAncestorContainer);
}

/** Gibt den HTML-Inhalt der gespeicherten Selection zurück. */
function getSelectionHTML() {
  if (!savedRange) return '';
  const div = document.createElement('div');
  div.appendChild(savedRange.cloneContents());
  return div.innerHTML;
}


/* ================================================================
   Kern-Insertions-Funktionen
   ================================================================ */

/**
 * Umschließt die gespeicherte Selection mit dem von createNode()
 * erzeugten Element. Funktioniert auch bei partialselektierten
 * Element-Grenzen.
 */
function wrapSelection(createNode) {
  if (!savedRange || savedRange.collapsed) return;
  if (!isSelectionInEditor(savedRange)) return;

  restoreSelection();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const wrapper = createNode();
  const fragment = range.extractContents();
  wrapper.appendChild(fragment);
  range.insertNode(wrapper);

  const newRange = document.createRange();
  newRange.setStartAfter(wrapper);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);

  updateSource();
  editor.focus();
}

/**
 * Ersetzt die gespeicherte Selection durch den übergebenen HTML-String.
 * Bei einer kollabierten Selection (nur Cursor) wird der HTML einfach
 * eingefügt.
 */
function replaceSelectionWithHTML(html) {
  editor.focus();

  const useRange = savedRange && isSelectionInEditor(savedRange) ? savedRange : null;

  if (useRange) {
    restoreSelection();
  }

  const sel = window.getSelection();
  let range;

  if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }

  const temp = document.createElement('div');
  temp.innerHTML = html;
  const fragment = document.createDocumentFragment();
  let lastNode = null;
  while (temp.firstChild) {
    lastNode = temp.firstChild;
    fragment.appendChild(temp.firstChild);
  }
  range.insertNode(fragment);

  if (lastNode) {
    const newRange = document.createRange();
    newRange.setStartAfter(lastNode);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  updateSource();
}


/* ================================================================
   Quellcode-Ansicht
   ================================================================ */

function updateSource() {
  if (!cm) return;
  const pretty = prettifyHTML(editor.innerHTML);
  cm.setValue(pretty);
}

editor.addEventListener('input', () => {
  if (syncingFromSource) return;
  normalizeParagraphs();
  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
});

/* ================================================================
   Paragraph-Normalisierung
   Stellt sicher, dass direkte Textkinder und <div>-Elemente des
   Editors immer in <p>-Tags liegen. DOM-Knoten werden verschoben
   (nicht kopiert), damit bestehende Selection-Referenzen gültig
   bleiben.
   ================================================================ */

function normalizeParagraphs() {
  // 1. Bare Textknoten → <p>
  for (const child of [...editor.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() !== '') {
      const p = document.createElement('p');
      editor.insertBefore(p, child);
      p.appendChild(child);
    }
  }

  // 2. Bare <br> → <p>
  for (const child of [...editor.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
      const p = document.createElement('p');
      editor.insertBefore(p, child);
      p.appendChild(child);
    }
  }

  // 3. Klassenlose <div> → <p> (vom Browser beim Enter erzeugt)
  //    Divs mit Klasse (Bild-Container, Modals) bleiben unberührt
  for (const div of [...editor.querySelectorAll(':scope > div:not([class])')]) {
    const p = document.createElement('p');
    while (div.firstChild) p.appendChild(div.firstChild);
    editor.replaceChild(p, div);
  }
}

/* ================================================================
   HTML-Prettifier (DOM-basiert)
   Block-Elemente mit Block-Kindern werden rekursiv eingerückt.
   Block-Elemente mit nur Inline-Inhalt bleiben einzeilig.
   ================================================================ */

function prettifyHTML(html) {
  const INDENT = '  ';

  const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div',
    'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'ul'
  ]);
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  function makeOpenTag(node) {
    const tag  = node.tagName.toLowerCase();
    const ats  = [...node.attributes]
      .map(a => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
      .join('');
    return `<${tag}${ats}>`;
  }

  function encodeText(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/ /g, '&nbsp;');
  }

  function serialize(node, depth) {
    const pad = INDENT.repeat(depth);

    if (node.nodeType === Node.TEXT_NODE) {
      const t = encodeText(node.textContent.trim());
      return t ? `${pad}${t}\n` : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();

    // eval-tag: kein Wrapper im Output, nur Rohtext
    if (tag === 'div' && node.classList.contains('eval-tag')) {
      return `${pad}${node.textContent}\n`;
    }

    if (VOID.has(tag)) return `${pad}${makeOpenTag(node)}\n`;

    if (!BLOCK.has(tag)) {
      // Inline-Element: einzeilig mit innerHTML (Browser-Encoding korrekt)
      return `${pad}${makeOpenTag(node)}${node.innerHTML}</${tag}>\n`;
    }

    // Block-Element: hat es Block-Kinder?
    const hasBlockChild = [...node.childNodes].some(
      c => c.nodeType === Node.ELEMENT_NODE && BLOCK.has(c.tagName.toLowerCase())
    );

    if (!hasBlockChild) {
      // Nur Inline-Inhalt → einzeilig; trailing <br> (Browser-Platzhalter) weglassen
      const inner = node.innerHTML.trim().replace(/<br\s*\/?>\s*$/i, '').trim();
      return inner
        ? `${pad}${makeOpenTag(node)}${inner}</${tag}>\n`
        : `${pad}${makeOpenTag(node)}</${tag}>\n`;
    }

    // Gemischter/Block-Inhalt → rekursiv einrücken
    const kids = [...node.childNodes].map(c => serialize(c, depth + 1)).join('');
    return `${pad}${makeOpenTag(node)}\n${kids}${pad}</${tag}>\n`;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return [...tmp.childNodes].map(n => serialize(n, 0)).join('').trim();
}


/* ================================================================
   Hilfsfunktionen
   ================================================================ */

function escAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escText(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function openModal(id) {
  document.getElementById(id).removeAttribute('hidden');
}

function closeModal(id) {
  document.getElementById(id).setAttribute('hidden', '');
  editor.focus();
}


/* ================================================================
   Kopieren
   ================================================================ */

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Wirklich alles löschen?')) return;
  editor.innerHTML = '<p><br></p>';
  localStorage.removeItem('editor-content');
  updateSource();
  editor.focus();
});

document.getElementById('btn-copy').addEventListener('click', () => {
  const text = cm ? cm.getValue() : '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy');
    const prev = btn.textContent;
    btn.textContent = 'Kopiert!';
    setTimeout(() => { btn.textContent = prev; }, 1600);
  });
});


/* ================================================================
   Selection-Tracking im Editor
   ================================================================ */

editor.addEventListener('mouseup', saveSelection);
editor.addEventListener('keyup',   saveSelection);

// Heading-Buttons aktiv markieren wenn Cursor in Überschrift steht
editor.addEventListener('keyup',   updateHeadingButtons);
editor.addEventListener('mouseup', updateHeadingButtons);

// Toolbar-Buttons kontextsensitiv en-/disablen
document.addEventListener('selectionchange', updateToolbarState);

function updateToolbarState() {
  const sel = window.getSelection();
  const inEditor = sel && sel.rangeCount > 0
    && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
  const hasSelection = inEditor && !sel.getRangeAt(0).collapsed;

  ['btn-bold','btn-italic','btn-strike','btn-link','btn-apply-class'].forEach(id => {
    document.getElementById(id).disabled = !hasSelection;
  });
  document.getElementById('class-select').disabled = !hasSelection;
  document.getElementById('class-custom').disabled = !hasSelection;

  ['btn-image','btn-eval','btn-table'].forEach(id => {
    document.getElementById(id).disabled = !!hasSelection;
  });
}

function updateHeadingButtons() {
  const sel = window.getSelection();
  let tag = '';
  if (sel && sel.rangeCount > 0) {
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const block = node.closest && node.closest('h1,h2,h3,h4');
    if (block && editor.contains(block)) tag = block.tagName.toLowerCase();
  }
  document.querySelectorAll('.tb-heading').forEach(btn => {
    btn.classList.toggle('tb-active', btn.dataset.tag === tag);
  });
}


/* ================================================================
   Einfügen aus Zwischenablage: Word-HTML bereinigen
   ================================================================ */

editor.addEventListener('paste', e => {
  e.preventDefault();

  const html  = e.clipboardData.getData('text/html');
  const plain = e.clipboardData.getData('text/plain');

  const cleanHTML = html ? cleanPastedHTML(html) : plainToHTML(plain);

  // Leeren Absatz am Cursor ersetzen statt einfügen
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const block = node.closest('p,h1,h2,h3,h4');
    if (block && editor.contains(block) && block.textContent.trim() === '') {
      const range = document.createRange();
      range.selectNode(block);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  savedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

  replaceSelectionWithHTML(cleanHTML);
  trimEditorEdges();
});

function trimEditorEdges() {
  const isEmpty = node =>
    node.nodeType === Node.ELEMENT_NODE &&
    /^(p|h[1-6])$/i.test(node.tagName) &&
    node.textContent.trim() === '' &&
    !node.querySelector('img');

  while (editor.firstChild && isEmpty(editor.firstChild))
    editor.removeChild(editor.firstChild);
  while (editor.lastChild && isEmpty(editor.lastChild))
    editor.removeChild(editor.lastChild);
  if (!editor.firstChild) editor.innerHTML = '<p><br></p>';

  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
}

function cleanPastedHTML(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script, style').forEach(el => el.remove());

  const lines = [];
  const walker = document.createTreeWalker(
    tmp,
    NodeFilter.SHOW_ELEMENT,
    { acceptNode: node =>
        /^(p|li|h[1-6])$/i.test(node.tagName)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
    }
  );
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/ /g, ' ').trim();
    if (text) lines.push(`<p>${escText(text)}</p>`);
  }

  return lines.length ? lines.join('\n') : plainToHTML(tmp.textContent);
}

function plainToHTML(text) {
  const lines = text.split(/\n\n+/).map(s => s.replace(/\n/g, ' ').trim()).filter(Boolean);
  return lines.length
    ? lines.map(t => `<p>${escText(t)}</p>`).join('\n')
    : '<p><br></p>';
}


/* ================================================================
   Überschriften
   ================================================================ */

function setBlockType(targetTag) {
  restoreSelection();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const block = node.closest('p,h1,h2,h3,h4,h5,h6');
  if (!block || !editor.contains(block)) return;

  const newTag = block.tagName.toLowerCase() === targetTag ? 'p' : targetTag;
  const newEl  = document.createElement(newTag);
  while (block.firstChild) newEl.appendChild(block.firstChild);
  block.parentNode.replaceChild(newEl, block);

  // Cursor ans Ende des neuen Elements
  const range = document.createRange();
  range.selectNodeContents(newEl);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  saveSelection();

  updateSource();
  updateHeadingButtons();
  localStorage.setItem('editor-content', editor.innerHTML);
}

document.querySelectorAll('.tb-heading').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    saveSelection();
    setBlockType(btn.dataset.tag);
  });
});


/* ================================================================
   Textformatierung: Fett / Kursiv / Durchgestrichen
   ================================================================ */

/** Sucht nächsten Vorfahren-Span mit passendem Inline-Style. */
function getFormattingSpan(styleProp, styleValue) {
  if (!savedRange) return null;
  let node = savedRange.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== editor) {
    if (node.tagName === 'SPAN' && node.style[styleProp] === styleValue) return node;
    node = node.parentNode;
  }
  return null;
}

/** Hebt einen Span auf und setzt seinen Inhalt an dessen Stelle. */
function unwrapSpan(span) {
  const parent = span.parentNode;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
  editor.focus();
}

document.getElementById('btn-bold').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  const existing = getFormattingSpan('fontWeight', 'bold');
  if (existing) { unwrapSpan(existing); return; }
  wrapSelection(() => {
    const span = document.createElement('span');
    span.style.fontWeight = 'bold';
    return span;
  });
});

document.getElementById('btn-italic').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  const existing = getFormattingSpan('fontStyle', 'italic');
  if (existing) { unwrapSpan(existing); return; }
  wrapSelection(() => {
    const span = document.createElement('span');
    span.style.fontStyle = 'italic';
    return span;
  });
});

document.getElementById('btn-strike').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  const existing = getFormattingSpan('textDecoration', 'line-through');
  if (existing) { unwrapSpan(existing); return; }
  wrapSelection(() => {
    const span = document.createElement('span');
    span.style.textDecoration = 'line-through';
    return span;
  });
});


/* ================================================================
   Klassen-Zuweisung
   ================================================================ */

/**
 * Gibt das Block-Element zurück, wenn die Selection dessen
 * gesamten Inhalt umfasst — sonst null.
 */
function getFullySelectedBlock(range) {
  if (!range || range.collapsed) return null;

  let startNode = range.startContainer;
  if (startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentNode;
  const startBlock = startNode.closest('p,h1,h2,h3,h4,h5,h6,li');
  if (!startBlock || !editor.contains(startBlock)) return null;

  // Textvergleich: Ist der selektierte Text identisch mit dem Block-Inhalt?
  // Das funktioniert unabhängig davon, wo Browser das Range-Ende genau setzen
  // (z.B. offset 0 des Folgeelements bei Triple-Click).
  const selectedText = range.toString().trim();
  const blockText    = startBlock.textContent.trim();
  return (blockText && selectedText === blockText) ? startBlock : null;
}

document.getElementById('btn-apply-class').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  const custom = document.getElementById('class-custom').value.trim();
  const select = document.getElementById('class-select').value;
  const cls    = custom || select;
  if (!cls) return;

  // Ist ein kompletter Block selektiert? → Klasse direkt ans Block-Element
  const block = getFullySelectedBlock(savedRange);
  if (block) {
    cls.split(/\s+/).filter(Boolean).forEach(c => block.classList.add(c));
    updateSource();
    localStorage.setItem('editor-content', editor.innerHTML);
    editor.focus();
    return;
  }

  // Sonst: Selection in <span class="..."> einwickeln
  wrapSelection(() => {
    const span = document.createElement('span');
    span.className = cls;
    return span;
  });
});

document.getElementById('class-select').addEventListener('change', () => {
  document.getElementById('class-custom').value = '';
});

document.getElementById('class-custom').addEventListener('input', () => {
  document.getElementById('class-select').value = '';
});

document.getElementById('btn-remove-class').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();

  let node = savedRange
    ? savedRange.commonAncestorContainer
    : (window.getSelection()?.rangeCount > 0 ? window.getSelection().getRangeAt(0).commonAncestorContainer : null);
  if (!node) return;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;

  // 1. Span mit Klasse aufheben
  const span = node.closest('span[class]');
  if (span && editor.contains(span)) {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    updateSource();
    localStorage.setItem('editor-content', editor.innerHTML);
    editor.focus();
    return;
  }

  // 2. Klasse direkt vom Block-Element entfernen
  const block = node.closest('p[class],h1[class],h2[class],h3[class],h4[class],li[class]');
  if (block && editor.contains(block)) {
    block.removeAttribute('class');
    updateSource();
    localStorage.setItem('editor-content', editor.innerHTML);
    editor.focus();
  }
});


/* ================================================================
   Modal-Infrastruktur
   ================================================================ */

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.modal === 'modal-image') editingImageEl = null;
    closeModal(btn.dataset.modal);
  });
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      overlay.setAttribute('hidden', '');
      editor.focus();
    }
  });
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => {
    m.setAttribute('hidden', '');
  });
  editingImageEl = null;
  editor.focus();
});


/* ================================================================
   Link-Modal
   ================================================================ */

document.getElementById('btn-link').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  document.getElementById('link-href').value   = '';
  document.getElementById('link-title').value  = '';
  document.getElementById('link-target').value = '_blank';
  openModal('modal-link');
  setTimeout(() => document.getElementById('link-href').focus(), 40);
});

document.getElementById('btn-link-cancel').addEventListener('click', () => closeModal('modal-link'));

document.getElementById('btn-link-ok').addEventListener('click', () => {
  const href = document.getElementById('link-href').value.trim();
  if (!href) { document.getElementById('link-href').focus(); return; }

  const title  = document.getElementById('link-title').value.trim();
  const target = document.getElementById('link-target').value;
  const inner  = getSelectionHTML() || '';

  const titleAttr = title ? ` title="${escAttr(title)}"` : '';
  const html = `<a href="${escAttr(href)}" target="${escAttr(target)}" rel="nofollow"${titleAttr}>${inner}</a>`;

  closeModal('modal-link');
  replaceSelectionWithHTML(html);
});


/* ================================================================
   Block-Level-Einfügungen
   ================================================================ */

/** Fügt HTML immer NACH dem direkten Editor-Kind ein, das den Cursor enthält. */
function insertAfterCurrentBlock(html) {
  editor.focus();

  let insertRef = null;
  if (savedRange && isSelectionInEditor(savedRange)) {
    let node = savedRange.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node.parentNode !== editor) node = node.parentNode;
    if (node && node !== editor) insertRef = node.nextSibling;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  while (tmp.firstChild) editor.insertBefore(tmp.firstChild, insertRef);

  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
}

function insertAtBlockLevel(html) {
  editor.focus();

  let block = null;
  if (savedRange && isSelectionInEditor(savedRange)) {
    let node = savedRange.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    block = node.closest('p,h1,h2,h3,h4,li');
    if (block && !editor.contains(block)) block = null;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  if (block) {
    const isEmpty = block.textContent.trim() === '' && !block.querySelector('img');
    if (isEmpty) {
      while (tmp.firstChild) block.parentNode.insertBefore(tmp.firstChild, block);
      block.parentNode.removeChild(block);
    } else {
      const ref = block.nextSibling;
      while (tmp.firstChild) block.parentNode.insertBefore(tmp.firstChild, ref);
    }
  } else {
    while (tmp.firstChild) editor.appendChild(tmp.firstChild);
  }

  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
}


/* ================================================================
   Bild-Modal
   ================================================================ */

function buildImageHTML(src, alt, title, copyright, type) {
  const ta = title ? ` title="${escAttr(title)}"` : '';
  if (type === 'simple') {
    return `<img src="${escAttr(src)}" alt="${escAttr(alt)}"${ta} class="w-100 rounded">\n` +
           `<p class="text-muted">© ${escText(copyright)}</p>`;
  }
  imageCounter++;
  const N = imageCounter;
  return (
    `<div class="nl-imagebox-left">\n` +
    `  <a href="#imgzoom${N}" data-toggle="modal">\n` +
    `    <img src="${escAttr(src)}" alt="${escAttr(alt)}"${ta} style="max-width:100%;">\n` +
    `  </a>\n` +
    `  <p class="bu">\n` +
    `    © ${escText(copyright)}; für Großansicht bitte anklicken\n` +
    `  </p>\n` +
    `</div>\n` +
    `<div class="modal fade" id="imgzoom${N}" style="display: none;" aria-hidden="true">\n` +
    `  <div class="modal-dialog modal-lg nl-imagebox-modal">\n` +
    `    <div class="modal-content">\n` +
    `      <div class="modal-header">\n` +
    `        <button aria-hidden="true" data-dismiss="modal" class="close" type="button">x</button>\n` +
    `      </div>\n` +
    `      <div class="modal-body">\n` +
    `        <div class="row">\n` +
    `          <img src="${escAttr(src)}" alt="${escAttr(alt)}"${ta} style="max-width:100%;">\n` +
    `          <p class="bu">© ${escText(copyright)}</p>\n` +
    `        </div>\n` +
    `      </div>\n` +
    `    </div>\n` +
    `  </div>\n` +
    `</div>`
  );
}

// Bild im Editor anklicken → Modal mit vorhandenen Werten öffnen
editor.addEventListener('click', e => {
  if (e.target.tagName !== 'IMG') return;
  if (e.target.closest('.modal.fade')) return; // Zoom-Modal-Bild ignorieren
  editingImageEl = e.target;

  const isZoom = !!editingImageEl.closest('.nl-imagebox-left');
  document.getElementById('img-src').value         = editingImageEl.getAttribute('src') || '';
  document.getElementById('img-alt').value         = editingImageEl.getAttribute('alt') || '';
  document.getElementById('img-title-field').value = editingImageEl.getAttribute('title') || '';

  let copyright = '';
  if (isZoom) {
    const bu = editingImageEl.closest('.nl-imagebox-left').querySelector('.bu');
    if (bu) copyright = bu.textContent
      .replace(/;\s*für Großansicht bitte anklicken\s*$/i, '')
      .replace(/^©\s*/, '').trim();
  } else {
    const next = editingImageEl.nextElementSibling;
    if (next && next.classList.contains('text-muted'))
      copyright = next.textContent.replace(/^©\s*/, '').trim();
  }
  document.getElementById('img-copyright').value = copyright;
  document.querySelector(`input[name="img-type"][value="${isZoom ? 'zoom' : 'simple'}"]`).checked = true;

  openModal('modal-image');
  setTimeout(() => document.getElementById('img-src').focus(), 40);
});

document.getElementById('btn-image').addEventListener('mousedown', e => {
  e.preventDefault();
  editingImageEl = null;
  saveSelection();
  document.getElementById('img-src').value         = '';
  document.getElementById('img-alt').value         = '';
  document.getElementById('img-title-field').value = '';
  document.getElementById('img-copyright').value   = '';
  document.querySelector('input[name="img-type"][value="simple"]').checked = true;
  openModal('modal-image');
  setTimeout(() => document.getElementById('img-src').focus(), 40);
});

document.getElementById('btn-image-cancel').addEventListener('click', () => {
  editingImageEl = null;
  closeModal('modal-image');
});

document.getElementById('btn-image-ok').addEventListener('click', () => {
  const src       = document.getElementById('img-src').value.trim();
  if (!src) { document.getElementById('img-src').focus(); return; }

  const alt       = document.getElementById('img-alt').value.trim();
  const title     = document.getElementById('img-title-field').value.trim();
  const copyright = document.getElementById('img-copyright').value.trim();
  const type      = document.querySelector('input[name="img-type"]:checked').value;

  if (editingImageEl) {
    // ── Bestehendes Bild ersetzen ──────────────────────────────
    const isZoom = !!editingImageEl.closest('.nl-imagebox-left');

    // Alle zu entfernenden Elemente sammeln
    const toRemove = [];
    if (isZoom) {
      const container = editingImageEl.closest('.nl-imagebox-left');
      toRemove.push(container);
      const href = container.querySelector('a[href^="#imgzoom"]')?.getAttribute('href');
      if (href) {
        const oldModal = editor.querySelector(href);
        if (oldModal) toRemove.push(oldModal);
      }
    } else {
      toRemove.push(editingImageEl);
      const next = editingImageEl.nextElementSibling;
      if (next && next.classList.contains('text-muted')) toRemove.push(next);
    }

    // Neues HTML vor dem ersten zu entfernenden Element einfügen
    const anchor = toRemove[0];
    const parent = anchor.parentNode;
    const tmp = document.createElement('div');
    tmp.innerHTML = buildImageHTML(src, alt, title, copyright, type);
    while (tmp.firstChild) parent.insertBefore(tmp.firstChild, anchor);
    toRemove.forEach(el => el.parentNode?.removeChild(el));

    editingImageEl = null;
    closeModal('modal-image');
    updateSource();
    localStorage.setItem('editor-content', editor.innerHTML);
  } else {
    // ── Neues Bild einfügen ────────────────────────────────────
    closeModal('modal-image');
    const imgHTML = buildImageHTML(src, alt, title, copyright, type);
    if (type === 'simple') {
      insertAtBlockLevel(imgHTML);
    } else {
      replaceSelectionWithHTML(imgHTML);
    }
  }
});


/* ================================================================
   Hover-Overlays: Tabelle löschen / Klassen-Span entfernen
   ================================================================ */

function positionOverlay(btn, targetEl) {
  const panelRect  = editor.parentElement.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  // Button liegt innerhalb des Elements (oben rechts, leicht eingerückt)
  btn.style.top  = (targetRect.top  - panelRect.top  + 3) + 'px';
  btn.style.left = (targetRect.right - panelRect.left - 19) + 'px';
  btn.hidden = false;
}

function scheduleHideOverlays() {
  hideOverlayTimer = setTimeout(() => {
    tableDeleteBtn.hidden = true;
    spanRemoveBtn.hidden  = true;
    currentHoveredTable   = null;
    currentHoveredSpan    = null;
  }, 2000);
}

function cancelHideOverlays() { clearTimeout(hideOverlayTimer); }

editor.addEventListener('mouseover', e => {
  cancelHideOverlays();

  const table   = e.target.closest('table');
  const span    = e.target.closest('span[class]');
  const evalTag = e.target.closest('div.eval-tag');
  const block   = e.target.closest('p[class],h1[class],h2[class],h3[class],h4[class],li[class]');

  if (table && editor.contains(table)) {
    currentHoveredTable = table;
    positionOverlay(tableDeleteBtn, table);
    spanRemoveBtn.hidden = true;
  } else if (span && editor.contains(span)) {
    currentHoveredSpan = span;
    positionOverlay(spanRemoveBtn, span);
    tableDeleteBtn.hidden = true;
  } else if (evalTag && editor.contains(evalTag)) {
    currentHoveredSpan = evalTag;
    positionOverlay(spanRemoveBtn, evalTag);
    tableDeleteBtn.hidden = true;
  } else if (block && editor.contains(block)) {
    currentHoveredSpan = block;
    positionOverlay(spanRemoveBtn, block);
    tableDeleteBtn.hidden = true;
  } else {
    scheduleHideOverlays();
  }
});

editor.addEventListener('mouseleave', scheduleHideOverlays);

[tableDeleteBtn, spanRemoveBtn].forEach(btn => {
  btn.addEventListener('mouseenter', cancelHideOverlays);
  btn.addEventListener('mouseleave', scheduleHideOverlays);
});

tableDeleteBtn.addEventListener('click', () => {
  if (!currentHoveredTable) return;
  currentHoveredTable.remove();
  tableDeleteBtn.hidden = true;
  currentHoveredTable = null;
  updateSource();
});

spanRemoveBtn.addEventListener('click', () => {
  if (!currentHoveredSpan) return;
  const el = currentHoveredSpan;
  if (el.tagName === 'SPAN') {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  } else if (el.tagName === 'DIV' && el.classList.contains('eval-tag')) {
    el.parentNode.removeChild(el);
  } else {
    el.removeAttribute('class');
  }
  spanRemoveBtn.hidden = true;
  currentHoveredSpan = null;
  updateSource();
});


/* ================================================================
   Typografie
   ================================================================ */

function convertTypography(text) {
  // ... → …
  text = text.replace(/\.\.\./g, '…');
  // " - " und " -- " → " – " (nur zwischen Leerzeichen, nicht in 4-5 o.ä.)
  text = text.replace(/ -+ /g, ' – ');
  // Anführungszeichen: öffnendes " nach Leerzeichen/Satzanfang/Klammer → „
  text = text.replace(/(^|[\s([{–—])"(?=\S)/g, '$1„');
  // verbleibende " → schließendes "
  text = text.replace(/"/g, '“');
  return text;
}

function applyTypographyToRoot(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    node.textContent = convertTypography(node.textContent);
  }
}

function applyTypographyInRange(range) {
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) {
      node.textContent = convertTypography(node.textContent);
    }
  }
}

document.getElementById('btn-typography').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();

  if (savedRange && !savedRange.collapsed && isSelectionInEditor(savedRange)) {
    applyTypographyInRange(savedRange);
  } else {
    applyTypographyToRoot(editor);
  }

  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
  editor.focus();
});


/* ================================================================
   Listen
   ================================================================ */

function extractListItems(html) {
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'li', 'blockquote']);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  const hasBlocks = [...tmp.childNodes].some(
    n => n.nodeType === Node.ELEMENT_NODE && BLOCK.has(n.tagName.toLowerCase())
  );

  if (hasBlocks) {
    const items = [];
    for (const node of tmp.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) items.push(t);
      } else if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(node.tagName.toLowerCase())) {
        const inner = node.innerHTML.trim();
        const byBR = inner.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
        if (byBR.length > 1) {
          items.push(...byBR);
        } else if (inner) {
          items.push(inner);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.textContent.trim()) items.push(node.outerHTML);
      }
    }
    return items.length ? items : [''];
  } else {
    return tmp.innerHTML.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
  }
}

function buildListFromSelection(tag) {
  if (!savedRange || savedRange.collapsed) {
    return `<${tag}>\n  <li>Listenpunkt</li>\n</${tag}>`;
  }
  const items = extractListItems(getSelectionHTML());
  if (!items.length || (items.length === 1 && items[0] === '')) {
    return `<${tag}>\n  <li>Listenpunkt</li>\n</${tag}>`;
  }
  const lis = items.map(c => `  <li>${c}</li>`).join('\n');
  return `<${tag}>\n${lis}\n</${tag}>`;
}

document.getElementById('btn-ul').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  replaceSelectionWithHTML(buildListFromSelection('ul'));
});

document.getElementById('btn-ol').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  replaceSelectionWithHTML(buildListFromSelection('ol'));
});

/** Tab = Einrücken, Enter = Klassen-Span verlassen, Shift+Tab = Ausrücken */
editor.addEventListener('keydown', e => {

  // ── Enter: Cursor aus span[class] herausführen ──────────────
  if (e.key === 'Enter' && !e.shiftKey) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const span = node.closest('span[class]');
    if (!span || !editor.contains(span)) return;

    e.preventDefault();

    // Inhalt vom Cursor bis Ende des Spans extrahieren
    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEnd(span, span.childNodes.length);
    const tail = afterRange.extractContents();

    // Neuen Absatz ohne Klasse einfügen
    const block = span.closest('p, li, h1, h2, h3, h4, h5, h6') || span.parentElement;
    const newP  = document.createElement('p');
    newP.appendChild(tail);
    if (!newP.textContent.trim() && !newP.querySelector('img')) newP.innerHTML = '<br>';
    block.parentNode.insertBefore(newP, block.nextSibling);

    // Cursor an Anfang des neuen Absatzes
    const newRange = document.createRange();
    newRange.setStart(newP, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    saveSelection();
    updateSource();
    localStorage.setItem('editor-content', editor.innerHTML);
    return;
  }

  // ── Tab: Listen einrücken / ausrücken ───────────────────────
  if (e.key !== 'Tab') return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let anchor = sel.getRangeAt(0).startContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  const li = anchor.closest('li');
  if (!li) return;

  e.preventDefault();

  if (!e.shiftKey) {
    const prevLi = li.previousElementSibling;
    if (!prevLi) return;
    const parentTag = li.parentElement.tagName.toLowerCase();
    let subList = prevLi.querySelector(':scope > ' + parentTag);
    if (!subList) {
      subList = document.createElement(parentTag);
      prevLi.appendChild(subList);
    }
    subList.appendChild(li);
  } else {
    const parentList  = li.parentElement;
    const grandParent = parentList.parentElement;
    if (!grandParent || grandParent.tagName !== 'LI') return;
    grandParent.parentElement.insertBefore(li, grandParent.nextSibling);
    if (parentList.children.length === 0) parentList.remove();
  }

  const r = document.createRange();
  r.selectNodeContents(li);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  saveSelection();
  updateSource();
});


/* ================================================================
   Tabellen-Grid-Picker
   ================================================================ */

const GRID_ROWS = 10;
const GRID_COLS = 10;

// Grid-Zellen aufbauen
for (let r = 1; r <= GRID_ROWS; r++) {
  for (let c = 1; c <= GRID_COLS; c++) {
    const cell = document.createElement('div');
    cell.className = 'tg-cell';
    cell.dataset.row = r;
    cell.dataset.col = c;
    tableGrid.appendChild(cell);
  }
}

document.getElementById('btn-table').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  const wasHidden = tableGridPicker.hidden;
  tableGridPicker.hidden = !wasHidden;
  if (!tableGridPicker.hidden) highlightGrid(0, 0);
});

tableGrid.addEventListener('mousemove', e => {
  const cell = e.target.closest('.tg-cell');
  if (!cell) return;
  highlightGrid(+cell.dataset.row, +cell.dataset.col);
});

tableGrid.addEventListener('mouseleave', () => {
  highlightGrid(tableGridDims.rows, tableGridDims.cols);
});

tableGrid.addEventListener('click', e => {
  const cell = e.target.closest('.tg-cell');
  if (!cell) return;
  tableGridDims = { rows: +cell.dataset.row, cols: +cell.dataset.col };
  tableGridPicker.hidden = true;
  openModal('modal-table');
});

function highlightGrid(rows, cols) {
  tableGrid.querySelectorAll('.tg-cell').forEach(cell => {
    cell.classList.toggle('tg-active', +cell.dataset.row <= rows && +cell.dataset.col <= cols);
  });
  tableGridLabel.textContent = rows > 0 ? `${rows} × ${cols}` : '0 × 0';
}

document.addEventListener('click', e => {
  const anchor = document.getElementById('table-picker-anchor');
  if (!anchor.contains(e.target)) tableGridPicker.hidden = true;
});


/* ================================================================
   Tabellen-Modal
   ================================================================ */

document.getElementById('btn-table-cancel').addEventListener('click', () => closeModal('modal-table'));

document.getElementById('btn-table-ok').addEventListener('click', () => {
  const style = document.querySelector('input[name="table-style"]:checked').value;
  const { rows, cols } = tableGridDims;
  const html = style === 'striped'     ? buildStripedTable(rows, cols)
             : style === 'rahmen'     ? buildRahmenTable(rows, cols)
             : style === 'borderless' ? buildSimpleTable(rows, cols, 'table table-borderless')
             :                         buildSimpleTable(rows, cols, 'table table-sm');
  closeModal('modal-table');
  replaceSelectionWithHTML(html);
});

function buildStripedTable(rows, cols) {
  const td  = tag => `      <td>&nbsp;</td>`;
  const th  = tag => `      <th>&nbsp;</th>`;
  const row = (cells, tag) => `    <tr>\n${Array(cols).fill(tag()).join('\n')}\n    </tr>`;

  let html = `<table class="table-striped" border="0" cellpadding="10" cellspacing="0">\n`;

  if (rows === 1) {
    html += `  <tbody>\n${row(cols, td)}\n  </tbody>\n`;
  } else {
    html += `  <thead>\n${row(cols, th)}\n  </thead>\n`;

    if (rows > 2) {
      html += `  <tbody>\n`;
      for (let r = 1; r < rows - 1; r++) html += `${row(cols, td)}\n`;
      html += `  </tbody>\n`;
    }

    html += `  <tfoot>\n${row(cols, td)}\n  </tfoot>\n`;
  }

  return html + `</table>`;
}

function buildSimpleTable(rows, cols, cls) {
  const td = () => `      <td>&nbsp;</td>`;
  const th = () => `      <th>&nbsp;</th>`;
  const row = (fn) => `    <tr>\n${Array(cols).fill(0).map(fn).join('\n')}\n    </tr>`;

  let html = `<table class="${cls}">\n`;
  if (rows === 1) {
    html += `  <tbody>\n${row(td)}\n  </tbody>\n`;
  } else {
    html += `  <thead>\n${row(th)}\n  </thead>\n`;
    html += `  <tbody>\n`;
    for (let r = 1; r < rows; r++) html += `${row(td)}\n`;
    html += `  </tbody>\n`;
  }
  return html + `</table>`;
}

function buildRahmenTable(rows, cols) {
  const td = () => `    <td>&nbsp;</td>`;
  let html = `<table style="width: 100%;" class="tabelle-rahmen">\n`;
  for (let r = 0; r < rows; r++) {
    const cls = r === 0 ? ' class="tabelle-rahmen-kopf"' : '';
    html += `  <tr${cls}>\n`;
    for (let c = 0; c < cols; c++) html += `    <td>&nbsp;</td>\n`;
    html += `  </tr>\n`;
  }
  return html + `</table>`;
}


/* ================================================================
   Changelog
   ================================================================ */

document.getElementById('version-badge').addEventListener('click', () => {
  openModal('modal-changelog');
});


/* ================================================================
   Eval-Tag einfügen
   ================================================================ */

document.getElementById('btn-eval').addEventListener('mousedown', e => {
  e.preventDefault();
  saveSelection();
  editor.focus();

  // Direktes Kind des Editors ermitteln, das den Cursor enthält
  let insertRef = null;
  if (savedRange && isSelectionInEditor(savedRange)) {
    let node = savedRange.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node.parentNode !== editor) node = node.parentNode;
    if (node && node !== editor) insertRef = node.nextSibling;
  }

  const evalDiv = document.createElement('div');
  evalDiv.className = 'eval-tag';
  evalDiv.setAttribute('contenteditable', 'false');
  evalDiv.textContent = '{eval $ad}';
  editor.insertBefore(evalDiv, insertRef);

  // Sicherstellen, dass danach ein editierbarer Absatz folgt
  const after = evalDiv.nextSibling;
  let focusTarget;
  if (!after || after.getAttribute?.('contenteditable') === 'false') {
    focusTarget = document.createElement('p');
    focusTarget.innerHTML = '<br>';
    editor.insertBefore(focusTarget, evalDiv.nextSibling);
  } else {
    focusTarget = after;
  }

  // Cursor an den Anfang des folgenden Absatzes setzen
  const range = document.createRange();
  range.setStart(focusTarget, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  saveSelection();

  updateSource();
  localStorage.setItem('editor-content', editor.innerHTML);
});


/* ================================================================
   Initialisierung
   ================================================================ */

// Enter-Taste erzeugt <p> statt <div> (funktioniert in Chrome/Edge/Firefox)
document.execCommand('defaultParagraphSeparator', false, 'p');

// Gespeicherten Inhalt wiederherstellen oder leerem Absatz starten
const _saved = localStorage.getItem('editor-content');
if (_saved && _saved.trim() !== '' && _saved !== '<p><br></p>') {
  editor.innerHTML = _saved;
  normalizeParagraphs();
} else {
  editor.innerHTML = '<p><br></p>';
}

// Cursor ans Ende setzen
const _lastChild = editor.lastChild || editor;
const _initRange = document.createRange();
_initRange.selectNodeContents(_lastChild);
_initRange.collapse(false);
window.getSelection().removeAllRanges();
window.getSelection().addRange(_initRange);

// CodeMirror initialisieren
cm = CodeMirror(sourceView, {
  mode: 'xml',
  theme: 'monokai',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentWithTabs: false,
  autofocus: false,
});

// source → editor Sync (mit Debounce, 300ms)
let _sourceUpdateTimer = null;
cm.on('change', (instance, changeObj) => {
  if (changeObj.origin === 'setValue') return;
  clearTimeout(_sourceUpdateTimer);
  _sourceUpdateTimer = setTimeout(() => {
    syncingFromSource = true;
    editor.innerHTML = cm.getValue();
    localStorage.setItem('editor-content', editor.innerHTML);
    syncingFromSource = false;
  }, 300);
});

updateSource();
updateToolbarState();

// localStorage-Autosave: alle 100ms speichern wenn sich Inhalt geändert hat
let _lastSavedContent = editor.innerHTML;
setInterval(() => {
  const current = editor.innerHTML;
  if (current !== _lastSavedContent) {
    _lastSavedContent = current;
    localStorage.setItem('editor-content', current);
  }
}, 100);
