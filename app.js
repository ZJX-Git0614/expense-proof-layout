const state = {
  files: [],
  selected: new Set(),
  layout: 'A4',
  ocr: true,
  summary: true,
  result: false,
  processing: false,
  mergedPdfUrl: '',
  mergedPdfBlob: null,
  mergedPdfPages: 0,
  summaryRows: [
    { type: '往返交通', amount: '', days: '', note: '' },
    { type: '住宿', amount: '', days: '', note: '' },
    { type: '市内交通', amount: '', days: '', note: '' },
  ],
};

const $ = (selector) => document.querySelector(selector);
const fileInput = $('#fileInput');
const dropzone = $('#dropzone');
const fileList = $('#fileList');
const previewBoard = $('#previewBoard');
const modalRoot = $('#modalRoot');
const toastRegion = $('#toastRegion');
const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:4173' : '';
const WORKSPACE_DB = 'expense-proof-layout-workspace-v1';
const WORKSPACE_STORE = 'workspace';
const FILE_STORE = 'files';
let workspaceDbPromise = null;
let persistTimer = 0;
let persistenceReady = false;

function openWorkspaceDb() {
  if (workspaceDbPromise) return workspaceDbPromise;
  workspaceDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKSPACE_STORE)) database.createObjectStore(WORKSPACE_STORE);
      if (!database.objectStoreNames.contains(FILE_STORE)) database.createObjectStore(FILE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return workspaceDbPromise;
}

function runIdbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function workspaceSnapshot() {
  return {
    layout: state.layout,
    ocr: state.ocr,
    summary: state.summary,
    summaryRows: state.summaryRows,
    selected: [...state.selected],
  };
}

async function persistWorkspace() {
  if (!persistenceReady) return;
  const database = await openWorkspaceDb();
  const transaction = database.transaction([WORKSPACE_STORE, FILE_STORE], 'readwrite');
  const workspace = transaction.objectStore(WORKSPACE_STORE);
  const files = transaction.objectStore(FILE_STORE);
  workspace.put(workspaceSnapshot(), 'current');
  files.clear();
  state.files.forEach((file) => {
    files.put({
      id: file.id, name: file.name, ext: file.ext, size: file.size, pages: file.pages,
      category: file.category, dimensions: file.dimensions, ocrStatus: file.ocrStatus,
      crop: file.crop, sequence: file.sequence, blob: file.source,
    });
  });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function schedulePersist() {
  if (!persistenceReady) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistWorkspace().catch((error) => console.warn('Unable to save workspace:', error));
  }, 250);
}

async function clearPersistedWorkspace() {
  const database = await openWorkspaceDb();
  const transaction = database.transaction([WORKSPACE_STORE, FILE_STORE], 'readwrite');
  transaction.objectStore(WORKSPACE_STORE).delete('current');
  transaction.objectStore(FILE_STORE).clear();
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function restoreWorkspace() {
  try {
    const database = await openWorkspaceDb();
    const transaction = database.transaction([WORKSPACE_STORE, FILE_STORE], 'readonly');
    const workspace = await runIdbRequest(transaction.objectStore(WORKSPACE_STORE).get('current'));
    const files = await runIdbRequest(transaction.objectStore(FILE_STORE).getAll());
    if (workspace) {
      state.layout = layoutMeta[workspace.layout] ? workspace.layout : state.layout;
      state.ocr = Boolean(workspace.ocr);
      state.summary = Boolean(workspace.summary);
      state.summaryRows = Array.isArray(workspace.summaryRows) && workspace.summaryRows.length ? workspace.summaryRows : state.summaryRows;
      state.selected = new Set(Array.isArray(workspace.selected) ? workspace.selected : []);
      $('#ocrToggle').checked = state.ocr;
      $('#summaryToggle').checked = state.summary;
    }
    state.files = files.sort((a, b) => a.sequence - b.sequence).map((file) => {
      const source = new File([file.blob], file.name, { type: file.blob.type || (file.ext === 'pdf' ? 'application/pdf' : 'image/jpeg') });
      const url = URL.createObjectURL(source);
      return { ...file, source, url, previewUrl: file.ext === 'pdf' ? '' : url };
    });
    state.selected = new Set([...state.selected].filter((id) => state.files.some((file) => file.id === id)));
    persistenceReady = true;
    render();
    state.files.filter((file) => file.ext === 'pdf').forEach((file) => requestPdfPreview(file.source, file));
    if (state.files.length) showToast(`已恢复 ${state.files.length} 个本地缓存文件`, 'success');
  } catch (error) {
    persistenceReady = true;
    console.warn('Unable to restore workspace:', error);
    render();
  }
}


const layoutMeta = {
  A5: { label: 'A5 顺序', short: 'A5', hint: '适合装订归档', description: '每张凭证独立落在一张 A5 页面', className: 'a5-stack' },
  A4: { label: 'A4 排版', short: 'A4', hint: '适合打印归档', description: '每张 A4 页面排列 2 张凭证', className: 'a4-stack' },
  OA: { label: 'OA 上传版', short: 'OA', hint: '适合系统逐页上传', description: 'OA 模式按单页纵向整理', className: 'oa-stack' },
};

const expenseTypes = [
  '机票/火车票', '机票专票', '机票普票', '保险', '机票/火车票付款截图',
  '住宿专票', '住宿普票', '住宿费截图', '打车发票', '行程单', '打车费截图',
  '打车申请单', '招待费专票', '招待普票', '招待费截图', '招待申请单',
  '其他费用发票', '其他费用截图', '出差申请单', '加班申请单',
];

const typeSortOrder = ['机票/火车票', '机票专票', '机票普票', '住宿专票', '住宿普票', '打车发票', '行程单', '打车申请单', '其他费用', '出差申请单', '加班申请单'];

function idForFile() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function totalPages() {
  return state.files.reduce((sum, file) => sum + file.pages, 0);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function inferDocumentMeta(name) {
  if (/机票|飞猪/.test(name)) return { category: '机票普票', dimensions: '210×140mm' };
  if (/住宿/.test(name)) return { category: '住宿普票', dimensions: '210×140mm' };
  if (/打车电子发票|打车.*发票/.test(name)) return { category: '打车发票', dimensions: '210×184mm' };
  if (/打车申请/.test(name)) return { category: '打车申请单', dimensions: '210×297mm' };
  if (/行程单/.test(name)) return { category: '行程单', dimensions: '210×297mm' };
  if (/高速|通行费/.test(name)) return { category: '其他费用', dimensions: '190×127mm' };
  if (/出差申请/.test(name)) return { category: '出差申请单', dimensions: '210×297mm' };
  return { category: '其他费用', dimensions: '210×140mm' };
}

function dimensionsForType(type, fallback) {
  if (/行程单|申请单/.test(type)) return '210×297mm';
  if (/打车发票|打车费/.test(type)) return '210×184mm';
  if (/住宿|机票/.test(type)) return '210×140mm';
  return fallback || '210×140mm';
}

function sortFilesByType() {
  state.files.sort((a, b) => {
    const rankA = typeSortOrder.indexOf(a.category);
    const rankB = typeSortOrder.indexOf(b.category);
    return (rankA < 0 ? typeSortOrder.length : rankA) - (rankB < 0 ? typeSortOrder.length : rankB) || a.sequence - b.sequence;
  });
}

function typeLabel(file) {
  if (file.ocrStatus === 'done') return { text: file.category, className: 'success' };
  if (file.ocrStatus === 'working') return { text: '识别中', className: 'warning' };
  return { text: file.category, className: file.category === '其他费用' ? 'warning' : '' };
}

function showToast(message, tone = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function addFiles(fileArray) {
  const accepted = [];
  let rejected = 0;
  fileArray.forEach((file) => {
    const isImage = /^image\/(jpeg|png)$/.test(file.type);
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isImage && !isPdf) {
      rejected += 1;
      return;
    }
    const isPdfFile = isPdf && !isImage;
    const objectUrl = URL.createObjectURL(file);
    const meta = inferDocumentMeta(file.name);
    const item = {
      id: idForFile(),
      name: file.name,
      ext: isPdfFile ? 'pdf' : file.name.split('.').pop() || 'jpg',
      size: formatSize(file.size),
      pages: 1,
      url: objectUrl,
      previewUrl: isPdfFile ? '' : objectUrl,
      source: file,
      category: isPdfFile ? meta.category : '待识别',
      dimensions: meta.dimensions,
      ocrStatus: state.ocr && !isPdfFile ? 'working' : 'idle',
      crop: state.layout === 'A5' ? 'A5' : 'A4',
      sequence: state.files.length,
    };
    state.files.push(item);
    accepted.push(item);
    if (isPdfFile) requestPdfPreview(file, item);
  });
  sortFilesByType();
  if (rejected) showToast(`${rejected} 个文件格式不支持，请选择 PDF / JPG / PNG`, 'warning');
  if (!accepted.length) return;
  render();
  schedulePersist();
  showToast(`已添加 ${accepted.length} 个文件`, 'success');
  accepted.forEach((file, index) => {
    if (file.ocrStatus !== 'working') return;
    window.setTimeout(() => {
      const target = state.files.find((item) => item.id === file.id);
      if (!target) return;
      target.ocrStatus = 'done';
      target.category = ['打车发票', '住宿普票', '招待普票', '其他费用'][index % 4];
      target.dimensions = inferDocumentMeta(target.name).dimensions;
      sortFilesByType();
      refreshSummaryRows();
      render();
    }, 850 + index * 260);
  });
}

async function requestPdfPreview(source, item) {
  const formData = new FormData();
  formData.append('file', source, source.name);
  try {
    const response = await fetch(`${API_BASE}/api/preview`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`preview ${response.status}`);
    const payload = await response.json();
    const target = state.files.find((file) => file.id === item.id);
    if (!target || !payload.dataUrl) return;
    target.previewUrl = payload.dataUrl;
    target.pages = payload.pages || target.pages;
    target.dimensions = payload.dimensions || target.dimensions;
    render();
  } catch (error) {
    console.info('PDF preview fallback:', error.message);
  }
}

function layoutSheetCount() {
  return state.layout === 'A4' ? Math.ceil(state.files.length / 2) : state.files.length;
}

function revokeMergedPdf() {
  if (state.mergedPdfUrl) URL.revokeObjectURL(state.mergedPdfUrl);
  state.mergedPdfUrl = '';
  state.mergedPdfBlob = null;
  state.mergedPdfPages = 0;
}

function mergeFormData() {
  const formData = new FormData();
  formData.append('layout', state.layout);
  state.files.forEach((file) => formData.append('files', file.source, file.name));
  return formData;
}

async function requestMergedPdf() {
  const response = await fetch(`${API_BASE}/api/merge`, { method: 'POST', body: mergeFormData() });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `merge ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.type && !blob.type.includes('pdf')) throw new Error('服务端没有返回 PDF');
  revokeMergedPdf();
  state.mergedPdfBlob = blob;
  state.mergedPdfUrl = URL.createObjectURL(blob);
  state.mergedPdfPages = Number(response.headers.get('X-PDF-Pages')) || layoutSheetCount();
  return blob;
}

async function ensureMergedPdf() {
  if (state.mergedPdfBlob && state.mergedPdfUrl) return state.mergedPdfBlob;
  return requestMergedPdf();
}

function fileThumb(file, extraClass = '') {
  if (file.ext !== 'pdf' && file.previewUrl) return `<div class="file-thumb ${extraClass}" style="background-image:url('${file.previewUrl}')"></div>`;
  return `<div class="file-thumb pdf ${extraClass}">PDF</div>`;
}

function typeOptions(selected) {
  return expenseTypes.map((type) => `<option value="${escapeHtml(type)}" ${type === selected ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('');
}

function layoutItem(file, index, resultMode = false) {
  const media = file.previewUrl
    ? `<img src="${file.previewUrl}" alt="${escapeHtml(file.name)} 预览" />`
    : `<iframe class="pdf-frame" src="${file.url}#toolbar=0&navpanes=0&scrollbar=0" title="${escapeHtml(file.name)} PDF 预览" loading="lazy"></iframe>`;
  const cropAction = resultMode ? '' : `<button class="crop-button" data-action="crop" data-id="${file.id}" type="button">裁剪</button>`;
  return `<article class="layout-item" draggable="${!resultMode}" data-id="${file.id}" style="animation-delay:${Math.min(index, 10) * 35}ms">
    <div class="layout-item-top"><span class="page-number">P${index + 1}</span><span class="layout-item-type">${escapeHtml(file.category)} · ${escapeHtml(file.dimensions)}</span></div>
    <div class="layout-item-media ${file.ext === 'pdf' ? 'pdf-media' : ''}">${media}</div>
    <div class="layout-item-footer"><span class="layout-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>${cropAction}</div>
  </article>`;
}

function renderLayoutPreview(files, resultMode = false) {
  if (state.layout === 'A4') {
    const sheets = [];
    for (let index = 0; index < files.length; index += 2) sheets.push(files.slice(index, index + 2));
    return `<div class="paper-stack a4-stack">${sheets.map((group, sheetIndex) => `<section class="paper-sheet a4-sheet"><div class="paper-sheet-heading"><strong>A4 拼版 ${sheetIndex + 1}</strong><span>2-up · ${group.length} 张凭证</span></div><div class="paper-slots">${group.map((file) => `<div class="sheet-slot">${layoutItem(file, files.indexOf(file), resultMode)}</div>`).join('')}${group.length === 1 ? '<div class="sheet-slot empty-slot">空白区域</div>' : ''}</div></section>`).join('')}</div>`;
  }
  if (state.layout === 'A5') {
    return `<div class="paper-stack a5-stack">${files.map((file, index) => `<section class="paper-sheet a5-sheet"><div class="paper-sheet-heading"><strong>A5 页面 ${index + 1}</strong><span>单页顺序</span></div>${layoutItem(file, index, resultMode)}</section>`).join('')}</div>`;
  }
  return `<div class="paper-stack oa-stack">${files.map((file, index) => `<section class="paper-sheet oa-sheet"><div class="paper-sheet-heading"><strong>OA 页面 ${index + 1}</strong><span>逐页上传</span></div>${layoutItem(file, index, resultMode)}</section>`).join('')}</div>`;
}

function renderFileList() {
  if (!state.files.length) {
    fileList.innerHTML = `<div class="empty-file-state"><div class="empty-icon">🗂</div><div>暂无文件，请上传</div><div>支持多选，也可以直接拖进上方区域</div></div>`;
    return;
  }
  fileList.innerHTML = state.files.map((file) => {
    const badge = typeLabel(file);
    const selected = state.selected.has(file.id);
    return `<div class="file-card ${selected ? 'selected' : ''}" draggable="true" data-id="${file.id}">
      <label class="file-select"><input type="checkbox" data-action="select" data-id="${file.id}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(file.name)}" /></label>
      ${fileThumb(file)}
      <div class="file-info"><div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="file-meta"><span>${file.pages} 页 · ${escapeHtml(file.dimensions)} · ${file.size}</span><span class="type-badge ${badge.className}">${escapeHtml(badge.text)}</span></div>
        <select class="type-select" data-action="type" data-id="${file.id}" aria-label="选择 ${escapeHtml(file.name)} 的文件类型">${typeOptions(file.category)}</select>
      </div>
      <div class="file-card-actions"><button class="mini-action" data-action="move-up" data-id="${file.id}" type="button" title="上移">↑</button><button class="mini-action" data-action="move-down" data-id="${file.id}" type="button" title="下移">↓</button></div>
    </div>`;
  }).join('');
}

function renderPreview() {
  if (!state.files.length) {
    previewBoard.innerHTML = `<div class="preview-empty"><div class="preview-empty-icon">▧</div><strong>上传文件后这里显示页面预览</strong><span>拖拽左侧文件或点击上传，即可开始整理</span></div>`;
    return;
  }
  previewBoard.innerHTML = renderLayoutPreview(state.files);
}

function renderResult() {
  const meta = layoutMeta[state.layout];
  $('#resultLayout').textContent = meta.label;
  $('#resultLayoutShort').textContent = meta.short;
  $('#resultLayoutHint').textContent = meta.hint;
  $('#resultFileCount').textContent = state.files.length;
  $('#resultPageCount').textContent = totalPages();
  $('#resultPreviewCount').textContent = state.mergedPdfPages || layoutSheetCount();
  $('#resultPreview').innerHTML = state.mergedPdfUrl
    ? `<iframe class="merged-pdf-frame" src="${escapeHtml(state.mergedPdfUrl)}" title="最终合并 PDF 预览"></iframe><p class="result-preview-note">这里显示的就是下载和打印使用的最终合并 PDF。</p>`
    : renderLayoutPreview(state.files, true);
}

function render() {
  $('#pageCount').textContent = totalPages();
  $('.brand-mode').innerHTML = state.result ? '<span class="status-dot"></span>结果预览' : '<span class="status-dot"></span>编辑模式';
  $('#fileCount').textContent = `${state.files.length} 个文件`;
  $('#selectAll').checked = state.files.length > 0 && state.selected.size === state.files.length;
  $('#deleteSelectedBtn').disabled = state.selected.size === 0 || state.processing;
  $('#clearBtn').disabled = state.files.length === 0 || state.processing;
  $('#mergeBtn').disabled = state.files.length === 0 || state.processing;
  $('#mergeBtn').textContent = state.result ? '✏️ 返回编辑' : (state.processing ? '处理中…' : '⚙️ 合并 PDF');
  document.querySelectorAll('.layout-tab').forEach((tab) => {
    const active = tab.dataset.layout === state.layout;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#layoutDescription').textContent = layoutMeta[state.layout].description;
  $('#editorView').hidden = state.result;
  $('#resultView').hidden = !state.result;
  renderFileList();
  renderPreview();
  if (state.result) renderResult();
}

function moveFile(id, direction) {
  const index = state.files.findIndex((file) => file.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= state.files.length) return;
  [state.files[index], state.files[next]] = [state.files[next], state.files[index]];
  state.files.forEach((file, sequence) => { file.sequence = sequence; });
  schedulePersist();
  render();
}

function deleteSelected() {
  if (!state.selected.size) return;
  const deleted = state.files.filter((file) => state.selected.has(file.id));
  deleted.forEach((file) => file.url && URL.revokeObjectURL(file.url));
  state.files = state.files.filter((file) => !state.selected.has(file.id));
  state.selected.clear();
  render();
  showToast(`已删除 ${deleted.length} 个文件`);
}

function deleteOne(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  if (file.url) URL.revokeObjectURL(file.url);
  state.files = state.files.filter((item) => item.id !== id);
  state.selected.delete(id);
  render();
}

function handleFiles(files) {
  addFiles([...files]);
  fileInput.value = '';
}

function closeModal() {
  modalRoot.hidden = true;
  modalRoot.innerHTML = '';
}

function openModal(content, className = '') {
  modalRoot.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">${content}</div>`;
  modalRoot.hidden = false;
  modalRoot.querySelector('.modal-close')?.focus();
}

function openHelp() {
  openModal(`<div class="modal-header"><div><h2>使用帮助</h2><p>按 3 步整理你的报销凭证，所有文件都只在本机处理。</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div>
    <div class="help-layout"><nav class="help-nav" aria-label="帮助目录">
      <button class="active" data-help="upload" type="button">📤 上传文件</button><button data-help="type" type="button">🏷️ 设置文件类型</button><button data-help="card" type="button">🃏 卡片操作</button><button data-help="merge" type="button">⚙️ 合并与排版</button><button data-help="faq" type="button">❓ 常见问题</button>
    </nav><div class="help-copy" id="helpCopy"></div></div>`,'wide');
  const copy = {
    upload: { title: '上传文件', body: `<div class="help-step"><b>1</b><div><strong>选择或拖拽凭证</strong><p>支持 PDF、JPG、PNG，可以一次选择多份文件。文件会按照添加顺序出现在预览区。</p></div></div><div class="help-step"><b>2</b><div><strong>等待识别完成</strong><p>打开 OCR 后，图片会自动出现费用类型标签。识别结果仅供参考，请以原始票据为准。</p></div></div>` },
    type: { title: '设置文件类型', body: `<p>图片 OCR 会尝试标记“差旅交通、住宿发票、餐饮招待、日常采购”等类型。预览和 PDF 生成只会请求本机的 server.py，不会上传到互联网。</p><ul><li>打开开关：新添加的图片进入“识别中”状态。</li><li>关闭开关：文件仅保留格式标签，适合不需要自动识别的材料。</li></ul>` },
    card: { title: '卡片操作', body: `<p>在左侧文件列表中可以全选、删除或使用箭头微调顺序；在右侧预览卡片上可以拖拽排序，也可以为单个页面选择 A5/A4 比例裁剪。</p><p>手机或触控设备上推荐使用卡片右下方的裁剪入口与左侧的上移/下移按钮。</p>` },
    merge: { title: '合并与排版', body: `<p>先选择一种排版模式，再点击右上角“合并 PDF”。A4 适合打印归档，A5 适合小册装订，OA 上传版会按单页纵向整理。</p><div class="notice-box">开启“汇总信息页”时，合并前会先打开汇总审核窗口；确认后会生成最终 PDF。</div>` },
    faq: { title: '常见问题', body: `<ul><li><strong>文件会上传到哪里？</strong><br />不会上传到互联网；预览和最终 PDF 生成都由本机 server.py 处理。</li><li><strong>为什么编辑区只显示一张预览？</strong><br />编辑区显示源文件首页缩略图；合并导出会处理每个源 PDF 的全部页面。</li><li><strong>下载是什么格式？</strong><br />下载按钮生成按当前排版完成的 PDF，打印按钮打开同一份最终 PDF 预览。</li></ul>` },
  };
  const setHelp = (key) => {
    const data = copy[key];
    $('#helpCopy').innerHTML = `<h3>${data.title}</h3>${data.body}`;
    modalRoot.querySelectorAll('[data-help]').forEach((button) => button.classList.toggle('active', button.dataset.help === key));
  };
  setHelp('upload');
  modalRoot.querySelectorAll('[data-help]').forEach((button) => button.addEventListener('click', () => setHelp(button.dataset.help)));
}

function inferSummaryRows() {
  const groups = [
    { type: '往返交通', match: /机票|火车|高铁|行程单|交通/, days: false },
    { type: '住宿', match: /住宿/, days: true },
    { type: '市内交通', match: /打车|出租|网约车|滴滴|交通/, days: false },
  ];
  return groups.map((group) => {
    const matched = state.files.filter((file) => group.match.test(`${file.category} ${file.name}`));
    const amounts = matched.map((file) => {
      const match = file.name.match(/(?:¥|￥|金额|含税)[\s_-]*([0-9]+(?:\.[0-9]{1,2})?)/i) || file.name.match(/[_-]([0-9]+(?:\.[0-9]{1,2})?)(?:元|rmb)?(?:[_-]|\.)/i);
      return match ? Number(match[1]) : 0;
    });
    const amount = amounts.some(Boolean) ? amounts.reduce((total, value) => total + value, 0).toFixed(2) : '';
    const inferredDays = group.days ? Math.max(0, ...matched.map((file) => Number((file.name.match(/([1-9][0-9]?)\s*天/) || [])[1] || 0)) ) : 0;
    const existing = state.summaryRows.find((row) => row.type === group.type) || {};
    return {
      type: group.type,
      amount: existing.amount || amount,
      days: existing.days || (inferredDays ? String(inferredDays) : ''),
      note: existing.note || (matched.length ? `已识别 ${matched.length} 份凭证` : ''),
    };
  }).filter((row) => row.note || row.amount || row.days);
}

function refreshSummaryRows() {
  const inferred = inferSummaryRows();
  if (inferred.length) state.summaryRows = inferred;
  schedulePersist();
}

function openSummary() {
  refreshSummaryRows();
  const rows = state.summaryRows.map((row, index) => `<tr data-row="${index}"><td><input data-summary="type" value="${escapeHtml(row.type)}" aria-label="费用类型" /></td><td><input data-summary="amount" inputmode="decimal" placeholder="元" value="${escapeHtml(row.amount)}" aria-label="金额" /></td><td><input data-summary="days" placeholder="天" value="${escapeHtml(row.days)}" aria-label="天数" /></td><td><input data-summary="note" placeholder="备注" value="${escapeHtml(row.note)}" aria-label="备注" /></td><td><button class="sum-remove" data-remove-row type="button" aria-label="删除此行">×</button></td></tr>`).join('');
  openModal(`<div class="modal-header"><div><h2>编辑汇总信息</h2><p>自动提取的信息仅供参考，请核对金额与天数后再生成。</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div>
    <div class="modal-body"><div class="notice-box">汇总信息用于生成前审核；确认后将按当前排版生成最终 PDF。OA 上传版不生成汇总信息页。</div><table class="summary-table"><thead><tr><th>费用类型</th><th>金额</th><th>天数</th><th>备注</th><th></th></tr></thead><tbody id="summaryRows">${rows}</tbody></table><button class="sum-add" id="addSummaryRow" type="button">+ 添加一行</button></div>
    <div class="modal-footer"><button class="btn btn-secondary" data-close type="button">取消</button><button class="btn btn-primary" id="confirmSummary" type="button">✓ 确认生成</button></div>`);
  const syncRows = () => {
    state.summaryRows = [...modalRoot.querySelectorAll('#summaryRows tr')].map((tr) => ({
      type: tr.querySelector('[data-summary="type"]').value,
      amount: tr.querySelector('[data-summary="amount"]').value,
      days: tr.querySelector('[data-summary="days"]').value,
      note: tr.querySelector('[data-summary="note"]').value,
    }));
  };
  modalRoot.querySelector('#summaryRows').addEventListener('input', syncRows);
  modalRoot.querySelector('#summaryRows').addEventListener('click', (event) => {
    if (!event.target.closest('[data-remove-row]')) return;
    event.target.closest('tr').remove();
    syncRows();
  });
  modalRoot.querySelector('#addSummaryRow').addEventListener('click', () => {
    const row = document.createElement('tr');
    row.innerHTML = '<td><input data-summary="type" placeholder="费用类型" aria-label="费用类型" /></td><td><input data-summary="amount" placeholder="元" aria-label="金额" /></td><td><input data-summary="days" placeholder="天" aria-label="天数" /></td><td><input data-summary="note" placeholder="备注" aria-label="备注" /></td><td><button class="sum-remove" data-remove-row type="button" aria-label="删除此行">×</button></td>';
    modalRoot.querySelector('#summaryRows').appendChild(row);
  });
  modalRoot.querySelector('#confirmSummary').addEventListener('click', () => {
    syncRows();
    closeModal();
    beginMerge();
  });
}

function openFeedback() {
  openModal(`<div class="modal-header"><div><h2>问题反馈</h2><p>告诉我们遇到的问题或希望增加的功能。</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div>
    <div class="modal-body"><textarea id="feedbackText" class="feedback-field" placeholder="请描述你遇到的问题…"></textarea><div class="feedback-input"><label for="feedbackContact">联系方式（选填，方便我们回复你）</label><input id="feedbackContact" placeholder="邮箱或其他联系方式" /></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" data-close type="button">取消</button><button class="btn btn-primary" id="submitFeedback" type="button">📨 提交反馈</button></div>`);
  modalRoot.querySelector('#submitFeedback').addEventListener('click', () => {
    const message = modalRoot.querySelector('#feedbackText').value.trim();
    if (!message) {
      showToast('请先填写反馈内容', 'warning');
      modalRoot.querySelector('#feedbackText').focus();
      return;
    }
    closeModal();
    showToast('反馈已记录，感谢你的建议', 'success');
  });
}

function openPrintHelp() {
  openModal(`<div class="modal-header"><div><h2>打印说明</h2><p>打印最终合并 PDF</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div><div class="modal-body"><div class="print-timeline"><div class="timeline-item"><b>1</b><span>打开最终 PDF</span></div><div class="timeline-item"><b>2</b><span>检查合并预览</span></div><div class="timeline-item"><b>3</b><span>按实际大小打印</span></div><div class="timeline-item"><b>4</b><span>裁剪并叠放</span></div></div><div class="notice-box" style="margin-top:24px">打印按钮会打开与下载完全相同的最终合并 PDF。打印前请确认设置为“实际大小”，关闭“适合页面”缩放，避免凭证比例发生变化。</div></div>`);
}

async function openFinalPdfPrintPreview() {
  const embeddedPdf = $('#resultPreview iframe');
  if (state.mergedPdfUrl && embeddedPdf?.contentWindow) {
    embeddedPdf.contentWindow.focus();
    embeddedPdf.contentWindow.print();
    showToast('已调用最终合并 PDF 的打印预览', 'success');
    return;
  }
  const printWindow = window.open(state.mergedPdfUrl || '', '_blank');
  if (!printWindow) {
    showToast('浏览器阻止了新窗口，请允许弹窗后重试', 'warning');
    return;
  }
  try {
    await ensureMergedPdf();
    if (!printWindow.closed) printWindow.location.href = state.mergedPdfUrl;
    showToast('已打开最终合并 PDF，请在 PDF 预览中点击打印', 'success');
  } catch (error) {
    if (!printWindow.closed) printWindow.close();
    showToast(`生成 PDF 失败：${error.message}`, 'warning');
  }
}

function openPrintModal() {
  openModal(`<div class="modal-header"><div><h2>选择打印方式</h2><p>打印时将打开最终合并 PDF 预览。</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div><div class="modal-body"><div class="print-options"><div class="print-option"><input id="localPrint" name="printType" type="radio" value="local" checked /><label for="localPrint"><strong>🖨️ 本地打印机</strong><span>打开最终 PDF 后打印</span></label></div><div class="print-option"><input id="companyPrint" name="printType" type="radio" value="company" /><label for="companyPrint"><strong>🏢 公司打印机</strong><span>远程接口未配置，仍打开最终 PDF</span></label></div></div></div><div class="modal-footer"><button class="btn btn-secondary" data-close type="button">取消</button><button class="btn btn-primary" id="confirmPrint" type="button">🖨️ 打开 PDF 预览</button></div>`);
  modalRoot.querySelector('#confirmPrint').addEventListener('click', () => {
    const type = modalRoot.querySelector('input[name="printType"]:checked').value;
    closeModal();
    if (type === 'company') {
      showToast('公司打印机接口尚未配置，将打开最终 PDF 预览', 'warning');
    }
    openFinalPdfPrintPreview();
  });
}

function openCropModal(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  let ratio = file.crop || 'A4';
  const renderCrop = () => {
    const frameClass = ratio === 'A5' ? 'style="height:170px;width:122px"' : 'style="height:200px;width:150px"';
    modalRoot.querySelector('#cropInner').setAttribute('style', frameClass.match(/style="([^"]+)"/)?.[1] || '');
    modalRoot.querySelectorAll('[data-ratio]').forEach((button) => button.classList.toggle('active', button.dataset.ratio === ratio));
  };
  const cropMedia = file.previewUrl
    ? `<img src="${file.previewUrl}" alt="裁剪预览" />`
    : `<iframe class="pdf-frame" src="${file.url}#toolbar=0&navpanes=0&scrollbar=0" title="裁剪预览"></iframe>`;
  openModal(`<div class="modal-header"><div><h2>裁剪页面</h2><p>${escapeHtml(file.name)} · 选择页面比例后确认。</p></div><button class="modal-close" data-close type="button" aria-label="关闭">×</button></div><div class="modal-body crop-modal-body"><div class="crop-preview"><div class="crop-preview-inner" id="cropInner">${cropMedia}</div></div><div class="crop-controls"><strong>页面比例</strong><div class="crop-ratios"><button class="ratio-button" data-ratio="A5" type="button">A5比例</button><button class="ratio-button" data-ratio="A4" type="button">A4比例</button></div><p>裁剪只影响当前页面的展示比例，不会修改原始文件。</p><button class="text-button" id="resetCrop" type="button">重置</button></div></div><div class="modal-footer"><button class="btn btn-secondary" data-close type="button">取消</button><button class="btn btn-primary" id="confirmCrop" type="button">确定</button></div>`);
  renderCrop();
  modalRoot.querySelectorAll('[data-ratio]').forEach((button) => button.addEventListener('click', () => { ratio = button.dataset.ratio; renderCrop(); }));
  modalRoot.querySelector('#resetCrop').addEventListener('click', () => { ratio = state.layout; renderCrop(); });
  modalRoot.querySelector('#confirmCrop').addEventListener('click', () => { file.crop = ratio; closeModal(); showToast(`已将「${file.name}」设置为 ${ratio} 比例`, 'success'); });
}

async function beginMerge() {
  state.processing = true;
  render();
  openModal(`<div class="processing-modal"><div class="processing-orbit"></div><h2>正在整理凭证</h2><p>正在按 ${layoutMeta[state.layout].label} 生成最终 PDF，请稍候…</p><div class="progress-track"></div></div>`);
  try {
    await requestMergedPdf();
    state.processing = false;
    state.result = true;
    closeModal();
    render();
    showToast('拼版完成，可以下载或打印了', 'success');
  } catch (error) {
    state.processing = false;
    closeModal();
    render();
    showToast(`生成 PDF 失败：${error.message}`, 'warning');
  }
}

function requestMerge() {
  if (!state.files.length) {
    showToast('请先上传至少一个凭证文件', 'warning');
    return;
  }
  if (state.summary && state.layout !== 'OA') {
    openSummary();
    return;
  }
  beginMerge();
}

async function downloadResult() {
  try {
    await ensureMergedPdf();
    const link = document.createElement('a');
    link.href = state.mergedPdfUrl;
    link.download = `报销凭证拼版-${state.layout}-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('已下载排版后的 PDF', 'success');
  } catch (error) {
    showToast(`下载 PDF 失败：${error.message}`, 'warning');
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));
fileInput.addEventListener('change', (event) => handleFiles(event.target.files));

$('#ocrToggle').addEventListener('change', (event) => {
  state.ocr = event.target.checked;
  if (!state.ocr) {
    state.files.forEach((file) => { if (file.ocrStatus === 'working') file.ocrStatus = 'idle'; });
  }
  render();
  showToast(state.ocr ? '已开启图片 OCR 自动识别' : '已关闭图片 OCR 自动识别');
});
$('#summaryToggle').addEventListener('change', (event) => { state.summary = event.target.checked; showToast(state.summary ? '合并前将显示汇总信息页' : '已关闭汇总信息页'); });
$('#selectAll').addEventListener('change', (event) => { state.files.forEach((file) => event.target.checked ? state.selected.add(file.id) : state.selected.delete(file.id)); render(); });
$('#deleteSelectedBtn').addEventListener('click', deleteSelected);
$('#clearBtn').addEventListener('click', () => { state.selected = new Set(state.files.map((file) => file.id)); deleteSelected(); });
$('#mergeBtn').addEventListener('click', () => { if (state.result) { state.result = false; render(); } else requestMerge(); });
$('#helpBtn').addEventListener('click', openHelp);
$('#feedbackBtn').addEventListener('click', openFeedback);
document.querySelectorAll('.layout-tab').forEach((tab) => tab.addEventListener('click', () => { state.layout = tab.dataset.layout; render(); }));

fileList.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-action="select"]');
  if (checkbox) {
    if (checkbox.checked) state.selected.add(checkbox.dataset.id); else state.selected.delete(checkbox.dataset.id);
    render();
    return;
  }
  const typeSelect = event.target.closest('[data-action="type"]');
  if (!typeSelect) return;
  const file = state.files.find((item) => item.id === typeSelect.dataset.id);
  if (!file) return;
  file.category = typeSelect.value;
  file.dimensions = dimensionsForType(file.category, file.dimensions);
  sortFilesByType();
  render();
  showToast(`已将「${file.name}」标记为 ${file.category}`);
});
fileList.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const { id } = action.dataset;
  if (action.dataset.action === 'move-up') moveFile(id, -1);
  if (action.dataset.action === 'move-down') moveFile(id, 1);
  if (action.dataset.action === 'crop') openCropModal(id);
});
let draggedId = '';
fileList.addEventListener('dragstart', (event) => { const card = event.target.closest('.file-card'); if (!card) return; draggedId = card.dataset.id; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
fileList.addEventListener('dragend', (event) => event.target.closest('.file-card')?.classList.remove('dragging'));
fileList.addEventListener('dragover', (event) => { if (event.target.closest('.file-card')) event.preventDefault(); });
fileList.addEventListener('drop', (event) => {
  event.preventDefault();
  const card = event.target.closest('.file-card');
  if (!card || !draggedId || card.dataset.id === draggedId) return;
  const from = state.files.findIndex((file) => file.id === draggedId);
  const to = state.files.findIndex((file) => file.id === card.dataset.id);
  const [moved] = state.files.splice(from, 1);
  state.files.splice(to, 0, moved);
  draggedId = '';
  render();
  showToast('顺序已调整');
});

previewBoard.addEventListener('dragstart', (event) => { const tile = event.target.closest('.layout-item'); if (!tile) return; draggedId = tile.dataset.id; tile.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
previewBoard.addEventListener('dragend', (event) => event.target.closest('.layout-item')?.classList.remove('dragging'));
previewBoard.addEventListener('dragover', (event) => { if (event.target.closest('.layout-item')) event.preventDefault(); });
previewBoard.addEventListener('drop', (event) => {
  event.preventDefault();
  const tile = event.target.closest('.layout-item');
  if (!tile || !draggedId || tile.dataset.id === draggedId) return;
  const from = state.files.findIndex((file) => file.id === draggedId);
  const to = state.files.findIndex((file) => file.id === tile.dataset.id);
  const [moved] = state.files.splice(from, 1);
  state.files.splice(to, 0, moved);
  draggedId = '';
  render();
  showToast('预览顺序已调整');
});
previewBoard.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'crop') openCropModal(action.dataset.id);
});

$('#backToEditBtn').addEventListener('click', () => { state.result = false; render(); });
$('#editSummaryBtn').addEventListener('click', openSummary);
$('#printBtn').addEventListener('click', openPrintModal);
$('#printHelpBtn').addEventListener('click', openPrintHelp);
$('#downloadBtn').addEventListener('click', downloadResult);
modalRoot.addEventListener('click', (event) => { if (event.target === modalRoot || event.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modalRoot.hidden) closeModal(); });

render();
