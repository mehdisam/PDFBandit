// Single app context — replaces the implicit globals in main.js.
// Every extracted module imports this instead of reaching into module scope.
import { History } from './editor/history.js';
import { PdfViewer } from './pdf/viewer.js';
import { StageTransform } from './overlay/canvas.js';
import { Overlay } from './overlay/region_item.js';
import { ToolController } from './editor/tools.js';

// DOM element helper
export const $ = (id) => document.getElementById(id);

// All DOM element refs, populated at startup in main.js
export const els = {
  pdfCanvas: null, viewCanvas: null, svg: null,
  textLayer: null, stage: null, stageWrap: null, inlineEdit: null,
  textModal: null, textSource: null, textSourceImg: null, textSourceResize: null,
  textDone: null, textCancel: null,
  thumbs: null, zoomLabel: null, status: null,
  filePdf: null, filePmap: null, fileItemImage: null, fileContentVariant: null,
  propsEmpty: null, propsForm: null,
  fId: null, fBg: null, fOcr: null, fKind: null,
  regionTools: null, regionAddTools: null, imageTools: null,
  itemTools: null,
  btnAddText: null, btnAddImage: null,
  btnItemFitText: null, btnItemFront: null, btnItemBack: null, btnItemDelete: null,
  textTools: null, ttBold: null, ttItalic: null, ttUnderline: null, ttColor: null, ttFont: null,
  ttSize: null, ttAlign: null, ttDir: null, ttLine: null,
  itemsList: null, itemEditor: null,
  tableTools: null,
  tblBorderColor: null, tblBorderWidth: null, tblColW: null, tblRowH: null, tblWidth: null,
  ttTable: null, ttUl: null, ttOl: null, ttHead: null,
  fItemSource: null, fItemFit: null,
  mapInfo: null,
  fTargetLang: null, fSourceLang: null,
  dlProgress: null, dlProgressLabel: null,
  statusProgress: null, statusCoverage: null,
  menubar: null, btnColoringMode: null,
  reviewSection: null, reviewHeading: null, reviewList: null,
  findModal: null, findScope: null, findText: null, replaceText: null, findRegex: null, findCase: null,
  findStatus: null, findReplaceAll: null, findClose: null,
  eyedropperMag: null,
};

// The single mutable app state object
export const appState = {
  pdfBytes: null, pdfName: '', sha256: '',
  pdfLanguage: null,
  pmap: null, page: 1, zoom: 1.2,
  project: null, dirtySides: { map: false, content: false },
  savedMap: null, mapModified: '', mapMeta: null,
  variants: [],
  selected: new Set(),
  itemSelection: new Set(),
  awaitingOcr: new Set(),
  tool: 'select', mode: 'region', itemIndex: 0,
  itemSelected: false,
  draft: [], splitPts: [], cursor: null, marquee: null, marqueeBase: null, marqueeAdditive: false,
  marqueeItems: false,
  dragPreview: null,
  selectedVertex: null,
  overlayVisible: true,
  showDigital: true,
  coloringMode: false,
  eyedropper: null,
  bgPreview: false,
};

// Module-level mutable state that was at file scope in main.js
// Each extracted module will own its piece; we keep them here for now and will
// move them into their respective modules during extraction.
export const moduleState = {
  // background.js
  bgSnapshot: null,
  bgRegions: null,

  // inline-editor.js
  inlineState: null,
  capturedSel: null,
  textDialogDrag: null,
  editorSourceToken: 0,
  editorSourceUrl: null,
  sourceResize: null,

  // render.js / thumbs
  docGen: 0,
  thumbsForGen: -1,
  lastPdfRender: { page: 0, zoom: 0 },
  renderQueue: Promise.resolve(),

  // detection.js
  choicePreviewToken: 0,

  // find-replace.js
  findUpdateTimer: null,

  // session.js
  sessionActive: false,
  sessionGen: 0,

  // settings.js / chrome-ai
  chromeAiStatusToken: 0,

  // geometry/coloring
  lastVertexClick: null,
  lastRegionClick: null,
  lastItemClick: null,
  lastHover: null,
  eyedropperKey: false,
};

// Core instances
export const viewer = new PdfViewer();
export const stage = new StageTransform();
export const history = new History(() => { /* bound in main.js after imports */ });

// LANGUAGES array (used by many modules)
export const LANGUAGES = [
  ['en','English'], ['ar','Arabic'], ['az','Azerbaijani'], ['bg','Bulgarian'], ['bn','Bengali'],
  ['ca','Catalan'], ['cs','Czech'], ['da','Danish'], ['de','German'], ['el','Greek'],
  ['es','Spanish'], ['et','Estonian'], ['fa','Persian'], ['fi','Finnish'], ['fr','French'],
  ['ga','Irish'], ['he','Hebrew'], ['hi','Hindi'], ['hu','Hungarian'], ['id','Indonesian'],
  ['it','Italian'], ['ja','Japanese'], ['ko','Korean'], ['lt','Lithuanian'], ['lv','Latvian'],
  ['ms','Malay'], ['nb','Norwegian'], ['nl','Dutch'], ['pl','Polish'], ['pt','Portuguese'],
  ['ro','Romanian'], ['ru','Russian'], ['sk','Slovak'], ['sl','Slovenian'], ['sq','Albanian'],
  ['sr','Serbian'], ['sv','Swedish'], ['th','Thai'], ['tr','Turkish'], ['uk','Ukrainian'],
  ['ur','Urdu'], ['vi','Vietnamese'], ['zh','Chinese'],
];

// Constant defaults that were defined in main.js (not from model/region.js)
export const DEFAULT_TEXT_PADDING = 4;
export const DEFAULT_DETECT_OVERLAP = 0.5;
export const FIT_MIN_SIZE = 6;
export const FIT_SIZE_STEP = 0.5;
export const FIT_WIDTH_SAMPLES = 12;
export const CLIP_WARN_TOL = 0.6;

export const MODE_ORDER = ['region', 'content', 'view', 'text'];
export const EDIT_MODES = new Set(['region', 'content']);
export const isEditMode = () => EDIT_MODES.has(appState.mode);
export const inRegion = () => appState.mode === 'region';
export const inContent = () => appState.mode === 'content';

// Helpers that were inline in main.js and used across modules
export const $q = (id) => document.getElementById(id); // alias for $ used in some places

// Initialize els refs from DOM (called once at startup from main.js)
export function initEls() {
  els.pdfCanvas = $('pdf-canvas');
  els.viewCanvas = $('view-canvas');
  els.svg = $('overlay');
  els.textLayer = $('textLayer');
  els.stage = $('stage');
  els.stageWrap = $('stage-wrap');
  els.inlineEdit = $('inline-edit');
  els.textModal = $('text-modal');
  els.textSource = $('text-modal-source');
  els.textSourceImg = $('text-modal-source-img');
  els.textSourceResize = $('text-modal-source-resize');
  els.textDone = $('text-done');
  els.textCancel = $('text-cancel');
  els.thumbs = $('thumbs');
  els.zoomLabel = $('zoom-label');
  els.status = $('status-msg');
  els.statusBar2 = $('status-bar-2');
  els.filePdf = $('file-pdf');
  els.filePmap = $('file-pmap');
  els.fileItemImage = $('file-item-image');
  els.fileContentVariant = $('file-content-variant');
  els.propsEmpty = $('props-empty');
  els.propsForm = $('props-form');
  els.fId = $('f-id');
  els.fBg = $('f-bg');
  els.fOcr = $('f-ocr');
  els.fKind = $('f-kind');
  els.regionTools = $('region-tools');
  els.regionAddTools = $('region-add-tools');
  els.imageTools = $('image-tools');
  els.itemTools = $('item-tools');
  els.btnAddText = $('btn-add-text');
  els.btnAddImage = $('btn-add-image');
  els.btnItemFitText = $('btn-item-fit-text');
  els.btnItemFront = $('btn-item-front');
  els.btnItemBack = $('btn-item-back');
  els.btnItemDelete = $('btn-item-delete');
  els.textTools = $('text-tools');
  els.tmFullscreen = $('tm-fullscreen');
  // Text toolbar row 1: direction, font, size, table
  els.ttDirLtr = $('tt-dir-ltr');
  els.ttDirRtl = $('tt-dir-rtl');
  els.ttFont = $('tt-font');
  els.ttSize = $('tt-size');
  els.ttSizeWrapper = $('tt-size-wrapper');
  els.ttTable = $('tt-table');
  els.ttTableAddRow = $('tt-table-add-row');
  els.ttTableAddCol = $('tt-table-add-col');
  els.ttTableDelRow = $('tt-table-del-row');
  els.ttTableDelCol = $('tt-table-del-col');
  // Table border tools (now in toolbar row 1)
  els.tblBorder = $('tbl-border');
  els.tblBorderSwatch = $('tbl-border-swatch');
  els.tblBorderColor = $('tbl-border-color');
  els.tblBorderWidth = $('tbl-border-width');
  // Text toolbar row 2: formatting, colors, alignment, spacing, lists
  els.ttBold = $('tt-bold');
  els.ttItalic = $('tt-italic');
  els.ttUnderline = $('tt-underline');
  els.ttColor = $('tt-color');
  els.ttColorInput = $('tt-color-input');
  els.ttAlignLeft = $('tt-align-left');
  els.ttAlignCenter = $('tt-align-center');
  els.ttAlignRight = $('tt-align-right');
  els.ttAlignJustify = $('tt-align-justify');
  els.ttLine = $('tt-line');
  els.ttLineWrapper = $('tt-line-wrapper');
  els.ttUl = $('tt-ul');
  els.ttOl = $('tt-ol');
  els.itemsList = $('items-list');
  els.itemEditor = $('item-editor');
  els.tblBorderColor = $('tbl-border-color');
  els.tblBorderWidth = $('tbl-border-width');
  els.tblColW = $('tbl-col-w');
  els.tblRowH = $('tbl-row-height');
  els.tblWidth = $('tbl-width');
  els.ttTable = $('tt-table');
  els.ttUl = $('tt-ul');
  els.ttOl = $('tt-ol');
  els.ttHead = $('tt-head');
  els.fItemSource = $('f-item-source');
  els.fItemFit = $('f-item-fit');
  els.mapInfo = $('map-info');
  els.fTargetLang = $('f-target-lang');
  els.fSourceLang = $('f-source-lang');
  els.dlProgress = $('dl-progress');
  els.dlProgressLabel = $('dl-progress-label');
  els.statusProgress = $('status-progress');
  els.statusCoverage = $('status-coverage');
  els.menubar = $('menubar');
  els.btnColoringMode = $('btn-coloring-mode');
  els.reviewSection = $('review-section');
  els.reviewHeading = $('review-heading');
  els.reviewList = $('review-list');
  els.findModal = $('find-modal');
  els.findScope = $('find-scope');
  els.findText = $('find-text');
  els.replaceText = $('replace-text');
  els.findRegex = $('find-regex');
  els.findCase = $('find-case');
  els.findStatus = $('find-status');
  els.findReplaceAll = $('find-replace-all');
  els.findClose = $('find-close');
  els.eyedropperMag = $('eyedropper-magnifier');
}