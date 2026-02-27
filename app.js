/**
 * GIF Editor — 메인 애플리케이션
 * 브라우저 기반 GIF 편집 도구
 */

(function () {
    'use strict';

    // ==============================
    // State (Multi-Document)
    // ==============================
    const documents = []; // 각 문서 = 독립적인 state 객체
    let activeDocIndex = -1;

    function createDocState(name) {
        return {
            frames: [],
            selectedFrames: new Set(),
            currentFrame: 0,
            originalWidth: 0,
            originalHeight: 0,
            outputWidth: 0,
            outputHeight: 0,
            playing: false,
            playTimer: null,
            fileName: name || 'edited.gif',
            gifBuffer: null,
            tags: []
        };
    }

    // Active document shortcut
    let state = createDocState('untitled');

    // Cross-tab frame clipboard
    let frameClipboard = []; // { imageData, delay, width, height }

    // Zoom state
    let zoomLevel = 1;
    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 16;
    const ZOOM_STEP = 1.2; // multiply/divide per step

    // Panning state (middle-click hand tool)
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;

    // Drawing tool state
    let currentTool = 'none'; // 'none' | 'pencil' | 'eraser'
    let brushSize = 1;
    let brushColor = '#000000';
    let isDrawing = false;
    let lastDrawPos = null; // { x, y } for Bresenham line interpolation
    let palette = [];

    // ==============================
    // DOM References
    // ==============================
    const $ = id => document.getElementById(id);
    const dom = {
        fileInput: $('file-input'),
        btnOpen: $('btn-open'),
        btnDelete: $('btn-delete'),
        btnDuplicate: $('btn-duplicate'),
        btnSelectAll: $('btn-select-all'),
        btnSelectOdd: $('btn-select-odd'),
        btnSelectEven: $('btn-select-even'),
        selectSize: $('select-size'),
        inputCustomSize: $('input-custom-size'),
        selectSpeed: $('select-speed'),
        inputCustomSpeed: $('input-custom-speed'),
        frameList: $('frame-list'),
        frameCount: $('frame-count'),
        dropZone: $('drop-zone'),
        canvasContainer: $('canvas-container'),
        previewCanvas: $('preview-canvas'),
        canvasInfo: $('canvas-info'),
        infoSize: $('info-size'),
        infoFrame: $('info-frame'),
        btnPlay: $('btn-play'),
        iconPlay: $('icon-play'),
        iconPause: $('icon-pause'),
        progressBar: $('progress-bar'),
        progressFill: $('progress-fill'),
        frameIndicator: $('frame-indicator'),
        btnDownload: $('btn-download'),
        dropBrowse: $('drop-browse'),
        inputTargetFrames: $('input-target-frames'),
        btnAutoReduce: $('btn-auto-reduce'),
        // v2 elements
        btnAppend: $('btn-append'),
        btnBlank: $('btn-blank'),
        btnCreateTag: $('btn-create-tag'),
        btnExportAse: $('btn-export-ase'),
        fileInputAppend: $('file-input-append'),
        tagBar: $('tag-bar'),
        tagModal: $('tag-modal'),
        tagModalClose: $('tag-modal-close'),
        tagModalCancel: $('tag-modal-cancel'),
        tagModalConfirm: $('tag-modal-confirm'),
        tagModalInfo: $('tag-modal-info'),
        tagNameInput: $('tag-name-input'),
        tagPresets: $('tag-presets'),
        tagColors: $('tag-colors'),
        // Tab bar
        tabBarEl: $('tab-bar'),
        // Drawing tools
        btnPencil: $('btn-pencil'),
        btnEraser: $('btn-eraser'),
        inputBrushSize: $('input-brush-size'),
        paletteBar: $('palette-bar'),
        currentColor: $('current-color'),
        paletteSwatches: $('palette-swatches')
    };

    // ==============================
    // Initialization
    // ==============================
    function init() {
        bindEvents();
    }

    function bindEvents() {
        // File open
        dom.btnOpen.addEventListener('click', () => dom.fileInput.click());
        dom.dropBrowse.addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', handleFileSelect);

        // Drag and drop
        const dropTarget = dom.dropZone;
        ['dragenter', 'dragover'].forEach(evt => {
            dropTarget.addEventListener(evt, e => {
                e.preventDefault();
                dropTarget.classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropTarget.addEventListener(evt, e => {
                e.preventDefault();
                dropTarget.classList.remove('drag-over');
            });
        });
        dropTarget.addEventListener('drop', handleDrop);

        // Also allow drop on the whole app when GIF is loaded
        document.addEventListener('dragover', e => e.preventDefault());
        document.addEventListener('drop', e => {
            e.preventDefault();
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file.type === 'image/gif') loadGifFile(file);
            }
        });

        // Frame actions
        dom.btnDelete.addEventListener('click', deleteSelectedFrames);
        dom.btnDuplicate.addEventListener('click', duplicateSelectedFrames);
        dom.btnSelectAll.addEventListener('click', selectAllFrames);
        dom.btnSelectOdd.addEventListener('click', () => selectPattern('odd'));
        dom.btnSelectEven.addEventListener('click', () => selectPattern('even'));

        // Auto frame reduction
        dom.btnAutoReduce.addEventListener('click', autoReduceFrames);
        dom.inputTargetFrames.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') autoReduceFrames();
        });

        // Size change
        dom.selectSize.addEventListener('change', handleSizeChange);
        dom.inputCustomSize.addEventListener('change', handleCustomSizeChange);

        // Speed change
        dom.selectSpeed.addEventListener('change', handleSpeedChange);
        dom.inputCustomSpeed.addEventListener('change', handleCustomSpeedChange);

        // Playback
        dom.btnPlay.addEventListener('click', togglePlay);
        dom.progressBar.addEventListener('click', handleProgressClick);

        // Download
        dom.btnDownload.addEventListener('click', downloadGif);

        // v2: Append GIF
        dom.btnAppend.addEventListener('click', () => dom.fileInputAppend.click());
        dom.fileInputAppend.addEventListener('change', handleAppendFiles);

        // v2: Blank frame
        dom.btnBlank.addEventListener('click', insertBlankFrame);

        // v2: Tag system
        dom.btnCreateTag.addEventListener('click', openTagModal);
        dom.tagModalClose.addEventListener('click', closeTagModal);
        dom.tagModalCancel.addEventListener('click', closeTagModal);
        dom.tagModalConfirm.addEventListener('click', confirmCreateTag);
        dom.tagModal.addEventListener('click', (e) => {
            if (e.target === dom.tagModal) closeTagModal();
        });

        // Tag presets with auto-color mapping
        const TAG_PRESET_COLORS = {
            idle: '#4fc3f7', attack: '#e57373', run: '#81c784', walk: '#ffb74d',
            die: '#ba68c8', hit: '#f06292', cast: '#4dd0e1', jump: '#fff176',
            skill: '#ff8a65', dash: '#aed581', guard: '#90a4ae', stun: '#ce93d8'
        };
        dom.tagPresets.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-preset-btn')) {
                const name = e.target.dataset.name;
                dom.tagNameInput.value = name;
                dom.tagPresets.querySelectorAll('.tag-preset-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');

                // Auto-select matching color
                const autoColor = TAG_PRESET_COLORS[name];
                if (autoColor) {
                    dom.tagColors.querySelectorAll('.tag-color-btn').forEach(b => {
                        b.classList.toggle('selected', b.dataset.color === autoColor);
                    });
                }
            }
        });

        // Tag colors
        dom.tagColors.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-color-btn')) {
                dom.tagColors.querySelectorAll('.tag-color-btn').forEach(b => b.classList.remove('selected'));
                e.target.classList.add('selected');
            }
        });

        // v2: Aseprite export
        dom.btnExportAse.addEventListener('click', exportAseprite);

        // Drawing tools
        dom.btnPencil.addEventListener('click', () => setTool(currentTool === 'pencil' ? 'none' : 'pencil'));
        dom.btnEraser.addEventListener('click', () => setTool(currentTool === 'eraser' ? 'none' : 'eraser'));
        dom.inputBrushSize.addEventListener('change', () => {
            brushSize = Math.max(1, Math.min(32, parseInt(dom.inputBrushSize.value) || 1));
            dom.inputBrushSize.value = brushSize;
        });

        // Canvas zoom (mouse wheel on entire preview area)
        document.getElementById('preview-area').addEventListener('wheel', onCanvasWheel, { passive: false });

        // Canvas drawing events
        dom.previewCanvas.addEventListener('mousedown', onCanvasMouseDown);
        dom.previewCanvas.addEventListener('mousemove', onCanvasMouseMove);
        dom.previewCanvas.addEventListener('mouseup', onCanvasMouseUp);
        dom.previewCanvas.addEventListener('mouseleave', (e) => {
            onCanvasMouseUp(e);
            clearBrushOverlay();
            stopPanning();
        });
        dom.previewCanvas.addEventListener('contextmenu', e => {
            if (currentTool !== 'none') e.preventDefault();
        });

        // Middle-click panning (hand tool)
        const previewArea = document.getElementById('preview-area');
        previewArea.addEventListener('mousedown', onPanMouseDown);
        document.addEventListener('mousemove', onPanMouseMove);
        document.addEventListener('mouseup', onPanMouseUp);

        // Palette swatch click
        dom.paletteSwatches.addEventListener('click', (e) => {
            const swatch = e.target.closest('.palette-swatch');
            if (!swatch) return;
            brushColor = swatch.dataset.color;
            dom.currentColor.style.background = brushColor;
            dom.paletteSwatches.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', handleKeyboard);
    }

    // ==============================
    // File Loading
    // ==============================
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) loadGifFile(file);
        e.target.value = '';
    }

    function handleDrop(e) {
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'image/gif') {
            loadGifFile(file);
        } else {
            showToast('GIF 파일만 지원됩니다', 'error');
        }
    }

    function loadGifFile(file) {
        // Create a new document tab
        const docName = file.name.replace(/\.gif$/i, '');
        const newDoc = createDocState(docName + '_edited.gif');
        newDoc._tabName = docName;
        documents.push(newDoc);
        activeDocIndex = documents.length - 1;
        state = documents[activeDocIndex];

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const buffer = new Uint8Array(e.target.result);
                state.gifBuffer = buffer;
                parseGif(buffer);
                renderTabs();
                showToast(`${file.name} 로드 완료 (${state.frames.length}프레임)`, 'success');
            } catch (err) {
                showToast('GIF 파싱 실패: ' + err.message, 'error');
                // Remove failed doc
                documents.pop();
                if (documents.length > 0) {
                    activeDocIndex = documents.length - 1;
                    state = documents[activeDocIndex];
                    restoreDocState();
                } else {
                    activeDocIndex = -1;
                    state = createDocState('untitled');
                }
                renderTabs();
                console.error(err);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function parseGif(buffer) {
        stopPlay();
        zoomLevel = 1;
        state.frames = [];
        state.selectedFrames.clear();
        state.currentFrame = 0;

        const reader = new GifReader(buffer);
        const w = reader.width;
        const h = reader.height;
        state.originalWidth = w;
        state.originalHeight = h;

        // Check if user has set a custom output size
        const sizeVal = parseInt(dom.selectSize.value);
        if (sizeVal > 0) {
            state.outputWidth = sizeVal;
            state.outputHeight = sizeVal;
        } else {
            state.outputWidth = w;
            state.outputHeight = h;
        }

        const numFrames = reader.numFrames();

        // We need to composite frames properly to handle disposal methods
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = w;
        compositeCanvas.height = h;
        const compositeCtx = compositeCanvas.getContext('2d', { willReadFrequently: true });

        // Previous frame data for disposal method 3 (restore to previous)
        let previousImageData = null;

        for (let i = 0; i < numFrames; i++) {
            const frameInfo = reader.frameInfo(i);
            const delay = frameInfo.delay * 10; // GIF delay is in centiseconds, convert to ms

            // Save previous state for disposal method 3
            if (frameInfo.disposal === 3) {
                previousImageData = compositeCtx.getImageData(0, 0, w, h);
            }

            // Decode frame pixels
            const framePixels = new Uint8Array(w * h * 4);
            reader.decodeAndBlitFrameRGBA(i, framePixels);

            // Create temporary ImageData for this frame
            const frameImageData = new ImageData(new Uint8ClampedArray(framePixels), w, h);

            // Create a temp canvas for the frame
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(frameImageData, 0, 0);

            // Composite onto the main canvas
            // For frames with transparency, we need to only draw non-transparent pixels
            if (frameInfo.transparent_index !== null) {
                // Draw the frame on top, preserving existing content
                compositeCtx.drawImage(tempCanvas, 0, 0);
            } else {
                // No transparency, just draw on top
                compositeCtx.drawImage(tempCanvas, 0, 0);
            }

            // Capture the composited result
            const resultImageData = compositeCtx.getImageData(0, 0, w, h);

            // Create a final canvas for this frame
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = w;
            frameCanvas.height = h;
            const frameCtx = frameCanvas.getContext('2d');
            frameCtx.putImageData(resultImageData, 0, 0);

            state.frames.push({
                imageData: resultImageData,
                delay: delay || 100,  // Default 100ms if no delay
                canvas: frameCanvas
            });

            // Handle disposal
            switch (frameInfo.disposal) {
                case 2: // Restore to background
                    compositeCtx.clearRect(frameInfo.x, frameInfo.y, frameInfo.width, frameInfo.height);
                    break;
                case 3: // Restore to previous
                    if (previousImageData) {
                        compositeCtx.putImageData(previousImageData, 0, 0);
                    }
                    break;
                // 0 and 1: do not dispose (leave as is)
            }
        }

        // Show UI
        dom.dropZone.style.display = 'none';
        dom.canvasContainer.style.display = 'block';
        dom.canvasInfo.style.display = 'flex';
        enableControls(true);

        renderFrameList();
        fitZoomToContainer();
        showFrame(0);
        updateInfo();
        extractPalette();
    }

    // ==============================
    // Frame List Rendering
    // ==============================
    function renderFrameList() {
        dom.frameList.innerHTML = '';

        state.frames.forEach((frame, i) => {
            // Find tag for this frame
            const tag = state.tags.find(t => i >= t.from && i <= t.to);

            // Insert inline tag header before the first frame of each tag
            if (tag && i === tag.from) {
                const tagIdx = state.tags.indexOf(tag);
                const header = document.createElement('div');
                header.className = 'frame-tag-header';
                header.style.background = tag.color;

                const nameSpan = document.createElement('span');
                nameSpan.textContent = tag.name;

                const rangeSpan = document.createElement('span');
                rangeSpan.className = 'tag-range';
                rangeSpan.textContent = `${tag.from + 1}~${tag.to + 1}`;

                const delBtn = document.createElement('button');
                delBtn.className = 'tag-delete';
                delBtn.textContent = '\u00d7';
                delBtn.addEventListener('click', () => {
                    deleteTag(tagIdx);
                    renderFrameList();
                });

                header.appendChild(nameSpan);
                header.appendChild(rangeSpan);
                header.appendChild(delBtn);
                dom.frameList.appendChild(header);
            }

            const item = document.createElement('div');
            item.className = 'frame-item fade-in';
            item.dataset.index = i;
            item.style.animationDelay = `${Math.min(i * 20, 300)}ms`;

            if (tag) {
                // Determine position in tag
                if (i === tag.from && i === tag.to) {
                    item.classList.add('tag-start', 'tag-end');
                } else if (i === tag.from) {
                    item.classList.add('tag-start');
                } else if (i === tag.to) {
                    item.classList.add('tag-end');
                } else {
                    item.classList.add('tag-mid');
                }

                // Color indicator bar (2px left stripe)
                const indicator = document.createElement('div');
                indicator.className = 'tag-indicator';
                indicator.style.backgroundColor = tag.color;
                item.appendChild(indicator);
            }

            // Number
            const numEl = document.createElement('span');
            numEl.className = 'frame-number';
            numEl.textContent = i + 1;
            if (tag) numEl.style.color = tag.color;

            // Thumbnail
            const thumbEl = document.createElement('div');
            thumbEl.className = 'frame-thumb';
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 36;
            thumbCanvas.height = 36;
            const tCtx = thumbCanvas.getContext('2d');

            // Draw thumbnail with aspect ratio
            const srcW = frame.canvas.width;
            const srcH = frame.canvas.height;
            const scale = Math.min(36 / srcW, 36 / srcH);
            const dw = srcW * scale;
            const dh = srcH * scale;
            tCtx.imageSmoothingEnabled = false;
            tCtx.drawImage(frame.canvas, (36 - dw) / 2, (36 - dh) / 2, dw, dh);

            thumbEl.appendChild(thumbCanvas);

            // Delay
            const delayEl = document.createElement('span');
            delayEl.className = 'frame-delay';
            delayEl.textContent = (frame.delay / 1000).toFixed(2) + 's';

            item.appendChild(numEl);
            item.appendChild(thumbEl);
            item.appendChild(delayEl);

            // Click handler
            item.addEventListener('click', (e) => handleFrameClick(i, e));

            dom.frameList.appendChild(item);
        });

        dom.frameCount.textContent = state.frames.length + '개';
        updateSelectionUI();
    }

    function handleFrameClick(index, e) {
        if (e.ctrlKey || e.metaKey) {
            // Toggle selection
            if (state.selectedFrames.has(index)) {
                state.selectedFrames.delete(index);
            } else {
                state.selectedFrames.add(index);
            }
        } else if (e.shiftKey && state.selectedFrames.size > 0) {
            // Range selection
            const lastSelected = Math.max(...state.selectedFrames);
            const start = Math.min(lastSelected, index);
            const end = Math.max(lastSelected, index);
            for (let i = start; i <= end; i++) {
                state.selectedFrames.add(i);
            }
        } else {
            // Single selection
            state.selectedFrames.clear();
            state.selectedFrames.add(index);
        }

        state.currentFrame = index;
        showFrame(index);
        updateSelectionUI();
    }

    function updateSelectionUI() {
        const items = dom.frameList.querySelectorAll('.frame-item');
        items.forEach((item, i) => {
            item.classList.toggle('selected', state.selectedFrames.has(i));
            item.classList.toggle('active', i === state.currentFrame);
        });

        const hasSelection = state.selectedFrames.size > 0;
        dom.btnDelete.disabled = !hasSelection;
        dom.btnDuplicate.disabled = !hasSelection;
    }

    // ==============================
    // Frame Display
    // ==============================
    function showFrame(index) {
        if (index < 0 || index >= state.frames.length) return;

        state.currentFrame = index;
        const frame = state.frames[index];
        const canvas = dom.previewCanvas;
        const ctx = canvas.getContext('2d');

        canvas.width = state.outputWidth;
        canvas.height = state.outputHeight;

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawCheckerboard(ctx, canvas.width, canvas.height);
        ctx.drawImage(frame.canvas, 0, 0, state.outputWidth, state.outputHeight);

        // Apply zoom via CSS width/height
        applyZoomStyle();
        syncOverlaySize();

        updateInfo();
        updateProgress();

        // Scroll current frame into view in the list
        const item = dom.frameList.querySelector(`.frame-item[data-index="${index}"]`);
        if (item) {
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        // Update active state
        const items = dom.frameList.querySelectorAll('.frame-item');
        items.forEach((el, i) => el.classList.toggle('active', i === index));
    }

    function updateInfo() {
        const zoomPct = Math.round(zoomLevel * 100);
        dom.infoSize.textContent = `${state.outputWidth} × ${state.outputHeight} (${zoomPct}%)`;
        dom.infoFrame.textContent = `프레임 ${state.currentFrame + 1} / ${state.frames.length}`;
        dom.frameIndicator.textContent = `${state.currentFrame + 1} / ${state.frames.length}`;
    }

    function updateProgress() {
        const pct = state.frames.length > 1
            ? (state.currentFrame / (state.frames.length - 1)) * 100
            : 0;
        dom.progressFill.style.width = pct + '%';
    }

    // ==============================
    // Frame Operations
    // ==============================
    function deleteSelectedFrames() {
        if (state.selectedFrames.size === 0) return;
        if (state.selectedFrames.size >= state.frames.length) {
            showToast('최소 1개의 프레임은 남겨야 합니다', 'error');
            return;
        }

        stopPlay();

        const toDelete = Array.from(state.selectedFrames).sort((a, b) => b - a);
        toDelete.forEach(i => state.frames.splice(i, 1));

        // Update tag indices after deletion
        const deleteSet = new Set(toDelete);
        state.tags = state.tags.map(tag => {
            let { name, color } = tag;
            let from = tag.from, to = tag.to;
            let shiftFrom = 0, shiftTo = 0;
            for (const d of deleteSet) {
                if (d < from) shiftFrom++;
                if (d <= to) shiftTo++;
            }
            from -= shiftFrom;
            to -= shiftTo;
            if (from > to || from < 0) return null;
            return { name, from, to, color };
        }).filter(t => t !== null);

        state.selectedFrames.clear();
        state.currentFrame = Math.min(state.currentFrame, state.frames.length - 1);

        renderFrameList();
        showFrame(state.currentFrame);
        showToast(`${toDelete.length}개 프레임 삭제됨`);
    }

    function duplicateSelectedFrames() {
        if (state.selectedFrames.size === 0) return;
        stopPlay();

        const indices = Array.from(state.selectedFrames).sort((a, b) => a - b);
        let offset = 0;

        indices.forEach(i => {
            const src = state.frames[i + offset];
            const newCanvas = document.createElement('canvas');
            newCanvas.width = src.canvas.width;
            newCanvas.height = src.canvas.height;
            const ctx = newCanvas.getContext('2d');
            ctx.drawImage(src.canvas, 0, 0);

            const clone = {
                imageData: ctx.getImageData(0, 0, newCanvas.width, newCanvas.height),
                delay: src.delay,
                canvas: newCanvas
            };
            state.frames.splice(i + offset + 1, 0, clone);
            offset++;
        });

        state.selectedFrames.clear();
        renderFrameList();
        showFrame(state.currentFrame);
        showToast(`${indices.length}개 프레임 복사됨`);
    }

    function selectAllFrames() {
        state.selectedFrames.clear();
        for (let i = 0; i < state.frames.length; i++) {
            state.selectedFrames.add(i);
        }
        updateSelectionUI();
    }

    function selectPattern(pattern) {
        state.selectedFrames.clear();
        for (let i = 0; i < state.frames.length; i++) {
            if (pattern === 'odd' && i % 2 === 0) state.selectedFrames.add(i);
            if (pattern === 'even' && i % 2 === 1) state.selectedFrames.add(i);
        }
        updateSelectionUI();
        showToast(`${pattern === 'odd' ? '홀수' : '짝수'} 프레임 선택 (${state.selectedFrames.size}개)`);
    }

    // ==============================
    // Auto Frame Reduction
    // ==============================
    function autoReduceFrames() {
        if (state.frames.length === 0) return;

        const target = parseInt(dom.inputTargetFrames.value);
        if (!target || target < 1) {
            showToast('목표 프레임 수를 입력하세요', 'error');
            return;
        }
        if (target >= state.frames.length) {
            showToast(`현재 ${state.frames.length}프레임입니다. 더 작은 수를 입력하세요`, 'error');
            return;
        }

        stopPlay();

        // Pick frames at even intervals
        // e.g., 20 frames -> 8 frames: pick indices [0, 2, 5, 7, 10, 12, 15, 17]
        const total = state.frames.length;
        const keepIndices = new Set();
        for (let i = 0; i < target; i++) {
            const idx = Math.round(i * (total - 1) / (target - 1));
            keepIndices.add(idx);
        }

        // Handle edge case: target is 1
        if (target === 1) {
            keepIndices.clear();
            keepIndices.add(0);
        }

        const prevCount = state.frames.length;
        state.frames = state.frames.filter((_, i) => keepIndices.has(i));
        state.selectedFrames.clear();
        state.currentFrame = 0;

        renderFrameList();
        showFrame(0);
        showToast(`${prevCount}프레임 → ${state.frames.length}프레임으로 축소 완료`, 'success');
    }

    // ==============================
    // Size Change
    // ==============================
    function handleSizeChange() {
        const val = dom.selectSize.value;
        if (val === 'custom') {
            dom.inputCustomSize.style.display = 'block';
            dom.inputCustomSize.focus();
            return;
        }
        dom.inputCustomSize.style.display = 'none';

        const size = parseInt(val);
        if (size > 0) {
            state.outputWidth = size;
            state.outputHeight = size;
        } else {
            state.outputWidth = state.originalWidth;
            state.outputHeight = state.originalHeight;
        }

        showFrame(state.currentFrame);
    }

    function handleCustomSizeChange() {
        const size = parseInt(dom.inputCustomSize.value);
        if (size > 0 && size <= 4096) {
            state.outputWidth = size;
            state.outputHeight = size;
            showFrame(state.currentFrame);
        }
    }

    // ==============================
    // Speed Change
    // ==============================
    function handleSpeedChange() {
        const val = dom.selectSpeed.value;
        if (val === 'custom') {
            dom.inputCustomSpeed.style.display = 'block';
            dom.inputCustomSpeed.focus();
            return;
        }
        dom.inputCustomSpeed.style.display = 'none';

        const speed = parseInt(val);
        if (speed > 0) {
            state.frames.forEach(f => f.delay = speed);
            renderFrameList();
            showToast(`전체 프레임 속도: ${(speed / 1000).toFixed(2)}초`);
        }
        // if 0 (원본), no change
    }

    function handleCustomSpeedChange() {
        const speed = parseInt(dom.inputCustomSpeed.value);
        if (speed >= 10 && speed <= 10000) {
            state.frames.forEach(f => f.delay = speed);
            renderFrameList();
            showToast(`전체 프레임 속도: ${(speed / 1000).toFixed(2)}초`);
        }
    }

    // ==============================
    // Playback
    // ==============================
    function togglePlay() {
        if (state.frames.length === 0) return;
        if (state.playing) {
            stopPlay();
        } else {
            startPlay();
        }
    }

    function startPlay() {
        state.playing = true;
        dom.iconPlay.style.display = 'none';
        dom.iconPause.style.display = 'block';

        function playNext() {
            if (!state.playing) return;
            const frame = state.frames[state.currentFrame];
            showFrame(state.currentFrame);

            state.currentFrame = (state.currentFrame + 1) % state.frames.length;
            state.playTimer = setTimeout(playNext, frame.delay);
        }
        playNext();
    }

    function stopPlay() {
        state.playing = false;
        dom.iconPlay.style.display = 'block';
        dom.iconPause.style.display = 'none';
        if (state.playTimer) {
            clearTimeout(state.playTimer);
            state.playTimer = null;
        }
    }

    function handleProgressClick(e) {
        if (state.frames.length === 0) return;
        const rect = dom.progressBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const index = Math.round(pct * (state.frames.length - 1));
        state.currentFrame = Math.max(0, Math.min(index, state.frames.length - 1));
        showFrame(state.currentFrame);
    }

    // ==============================
    // GIF Encoding & Download
    // ==============================
    function downloadGif() {
        if (state.frames.length === 0) return;
        showToast('GIF 생성 중...', 'info');

        // Use setTimeout to allow toast to render
        setTimeout(() => {
            try {
                const w = state.outputWidth;
                const h = state.outputHeight;

                // Build color palette from all frames
                // We need to quantize colors to 256 max for GIF
                const allFrameData = [];

                for (const frame of state.frames) {
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = w;
                    tempCanvas.height = h;
                    const ctx = tempCanvas.getContext('2d');
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(frame.canvas, 0, 0, w, h);
                    const data = ctx.getImageData(0, 0, w, h);
                    allFrameData.push(data);
                }

                // Build a global palette using median-cut-like quantization
                const palette = buildGlobalPalette(allFrameData);

                // Create GIF buffer (generous size)
                const bufSize = w * h * state.frames.length * 2 + 1024;
                const buf = new Uint8Array(bufSize);
                const gifWriter = new GifWriter(buf, w, h, { loop: 0, palette: palette });

                for (let i = 0; i < state.frames.length; i++) {
                    const data = allFrameData[i];
                    const pixels = data.data;
                    const indexed = new Uint8Array(w * h);

                    // Find transparency
                    let hasTransparency = false;
                    const transparentIndex = palette.length - 1;

                    for (let j = 0; j < w * h; j++) {
                        const r = pixels[j * 4];
                        const g = pixels[j * 4 + 1];
                        const b = pixels[j * 4 + 2];
                        const a = pixels[j * 4 + 3];

                        if (a < 128) {
                            indexed[j] = transparentIndex;
                            hasTransparency = true;
                        } else {
                            indexed[j] = findClosestColor(palette, r, g, b, transparentIndex);
                        }
                    }

                    const delay = Math.round(state.frames[i].delay / 10); // Convert ms to centiseconds
                    const opts = {
                        delay: delay,
                        disposal: 2  // Restore to background
                    };
                    if (hasTransparency) {
                        opts.transparent = transparentIndex;
                    }

                    gifWriter.addFrame(0, 0, w, h, indexed, opts);
                }

                const endPos = gifWriter.end();
                const output = buf.slice(0, endPos);

                // Download
                const blob = new Blob([output], { type: 'image/gif' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = state.fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showToast(`${state.fileName} 다운로드 완료!`, 'success');
            } catch (err) {
                showToast('GIF 생성 실패: ' + err.message, 'error');
                console.error(err);
            }
        }, 50);
    }

    // ==============================
    // Color Quantization
    // ==============================
    function buildGlobalPalette(framesData) {
        // Collect unique colors (sampling for performance)
        const colorMap = new Map();
        const sampleRate = Math.max(1, Math.floor(framesData.length * framesData[0].width * framesData[0].height / 100000));

        for (const data of framesData) {
            const pixels = data.data;
            for (let i = 0; i < pixels.length; i += 4 * sampleRate) {
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                const a = pixels[i + 3];
                if (a < 128) continue; // Skip transparent

                // Reduce to 5-bit per channel for grouping
                const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                if (!colorMap.has(key)) {
                    colorMap.set(key, { r, g, b, count: 1 });
                } else {
                    colorMap.get(key).count++;
                }
            }
        }

        // Sort by frequency, take top 255 colors (reserve 1 for transparency)
        const colors = Array.from(colorMap.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 255);

        // Build palette array (RGB integers)
        const palette = colors.map(c => (c.r << 16) | (c.g << 8) | c.b);

        // Pad to power of 2 (minimum 256)
        while (palette.length < 256) {
            palette.push(0x000000);
        }

        return palette;
    }

    function findClosestColor(palette, r, g, b, skipIndex) {
        let minDist = Infinity;
        let bestIdx = 0;

        for (let i = 0; i < palette.length; i++) {
            if (i === skipIndex) continue;
            const pr = (palette[i] >> 16) & 0xff;
            const pg = (palette[i] >> 8) & 0xff;
            const pb = palette[i] & 0xff;

            const dr = r - pr;
            const dg = g - pg;
            const db = b - pb;
            const dist = dr * dr + dg * dg + db * db;

            if (dist === 0) return i;
            if (dist < minDist) {
                minDist = dist;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    // ==============================
    // Keyboard Shortcuts
    // ==============================
    function handleKeyboard(e) {
        if (state.frames.length === 0) return;

        // Ignore if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        // Handle Ctrl+ shortcuts first (case-insensitive)
        if (e.ctrlKey || e.metaKey) {
            const k = e.key.toLowerCase();
            if (k === 'a') { e.preventDefault(); selectAllFrames(); return; }
            if (k === 'c') { e.preventDefault(); copyFramesToClipboard(); return; }
            if (k === 'v') { e.preventDefault(); pasteFramesFromClipboard(); return; }
            if (k === 'd') { e.preventDefault(); duplicateSelectedFrames(); return; }
            if (k === '=' || k === '+') { e.preventDefault(); applyZoom(zoomLevel * ZOOM_STEP); return; }
            if (k === '-') { e.preventDefault(); applyZoom(zoomLevel / ZOOM_STEP); return; }
            if (k === '0') { e.preventDefault(); applyZoom(1); return; }
        }

        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'Delete':
                deleteSelectedFrames();
                break;
            case 'p':
            case 'P':
                setTool(currentTool === 'pencil' ? 'none' : 'pencil');
                break;
            case 'e':
            case 'E':
                setTool(currentTool === 'eraser' ? 'none' : 'eraser');
                break;
            case '[':
                brushSize = Math.max(1, brushSize - 1);
                dom.inputBrushSize.value = brushSize;
                updateBrushCursor();
                break;
            case ']':
                brushSize = Math.min(32, brushSize + 1);
                dom.inputBrushSize.value = brushSize;
                updateBrushCursor();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (state.currentFrame > 0) {
                    state.currentFrame--;
                    showFrame(state.currentFrame);
                    if (!e.shiftKey) {
                        state.selectedFrames.clear();
                        state.selectedFrames.add(state.currentFrame);
                    } else {
                        state.selectedFrames.add(state.currentFrame);
                    }
                    updateSelectionUI();
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (state.currentFrame < state.frames.length - 1) {
                    state.currentFrame++;
                    showFrame(state.currentFrame);
                    if (!e.shiftKey) {
                        state.selectedFrames.clear();
                        state.selectedFrames.add(state.currentFrame);
                    } else {
                        state.selectedFrames.add(state.currentFrame);
                    }
                    updateSelectionUI();
                }
                break;
        }
    }

    // ==============================
    // Tab Management
    // ==============================
    function renderTabs() {
        dom.tabBarEl.innerHTML = '';
        documents.forEach((doc, i) => {
            const tab = document.createElement('div');
            tab.className = 'tab-item' + (i === activeDocIndex ? ' active' : '');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'tab-name';
            nameSpan.textContent = doc._tabName || doc.fileName;

            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-close';
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeDoc(i);
            });

            tab.appendChild(nameSpan);
            tab.appendChild(closeBtn);
            tab.addEventListener('click', () => switchToDoc(i));
            dom.tabBarEl.appendChild(tab);
        });
    }

    function switchToDoc(index) {
        if (index === activeDocIndex || index < 0 || index >= documents.length) return;

        // Stop playback on current doc
        stopPlay();

        activeDocIndex = index;
        state = documents[index];

        restoreDocState();
        renderTabs();
    }

    function closeDoc(index) {
        if (index < 0 || index >= documents.length) return;

        // Stop playback
        if (documents[index].playTimer) {
            clearTimeout(documents[index].playTimer);
        }

        documents.splice(index, 1);

        if (documents.length === 0) {
            // No docs left — reset to empty state
            activeDocIndex = -1;
            state = createDocState('untitled');
            dom.dropZone.style.display = 'flex';
            dom.canvasContainer.style.display = 'none';
            dom.canvasInfo.style.display = 'none';
            dom.frameList.innerHTML = '';
            dom.tagBar.innerHTML = '';
            dom.frameCount.textContent = '0개';
            dom.frameIndicator.textContent = '- / -';
            dom.progressFill.style.width = '0%';
            enableControls(false);
        } else {
            // Switch to the closest remaining tab
            if (activeDocIndex >= documents.length) {
                activeDocIndex = documents.length - 1;
            } else if (activeDocIndex > index) {
                activeDocIndex--;
            } else if (activeDocIndex === index) {
                activeDocIndex = Math.min(index, documents.length - 1);
            }
            state = documents[activeDocIndex];
            restoreDocState();
        }

        renderTabs();
    }

    function restoreDocState() {
        // Restore the full UI from the active document's state
        if (state.frames.length > 0) {
            dom.dropZone.style.display = 'none';
            dom.canvasContainer.style.display = 'block';
            dom.canvasInfo.style.display = 'flex';
            enableControls(true);
            renderFrameList();
            showFrame(state.currentFrame);
        } else {
            dom.dropZone.style.display = 'flex';
            dom.canvasContainer.style.display = 'none';
            dom.canvasInfo.style.display = 'none';
            dom.frameList.innerHTML = '';
            dom.tagBar.innerHTML = '';
            enableControls(false);
        }
    }

    // ==============================
    // v2: Append GIF
    // ==============================
    function handleAppendFiles(e) {
        const files = Array.from(e.target.files).filter(f => f.type === 'image/gif');
        if (files.length === 0) return;

        let loaded = 0;
        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    const buffer = new Uint8Array(ev.target.result);
                    appendGifBuffer(buffer);
                    loaded++;
                    if (loaded === files.length) {
                        renderFrameList();
                        showFrame(state.currentFrame);
                        showToast(`${files.length}개 GIF 추가 완료 (총 ${state.frames.length}프레임)`, 'success');
                    }
                } catch (err) {
                    showToast('GIF 추가 실패: ' + err.message, 'error');
                }
            };
            reader.readAsArrayBuffer(file);
        });
        // Reset so same files can be selected again
        e.target.value = '';
    }

    function appendGifBuffer(buffer) {
        const reader = new GifReader(buffer);
        const w = reader.width;
        const h = reader.height;

        // If no frames exist yet, set dimensions
        if (state.frames.length === 0) {
            state.originalWidth = w;
            state.originalHeight = h;
            const sizeVal = parseInt(dom.selectSize.value);
            if (sizeVal > 0) {
                state.outputWidth = sizeVal;
                state.outputHeight = sizeVal;
            } else {
                state.outputWidth = w;
                state.outputHeight = h;
            }
            dom.dropZone.style.display = 'none';
            dom.canvasContainer.style.display = 'block';
            dom.canvasInfo.style.display = 'flex';
            enableControls(true);
        }

        const numFrames = reader.numFrames();
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = w;
        compositeCanvas.height = h;
        const compositeCtx = compositeCanvas.getContext('2d');
        let previousImageData = null;

        for (let i = 0; i < numFrames; i++) {
            const frameInfo = reader.frameInfo(i);
            const delay = frameInfo.delay * 10;

            if (frameInfo.disposal === 3) {
                previousImageData = compositeCtx.getImageData(0, 0, w, h);
            }

            const framePixels = new Uint8Array(w * h * 4);
            reader.decodeAndBlitFrameRGBA(i, framePixels);
            const frameImageData = new ImageData(new Uint8ClampedArray(framePixels), w, h);
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(frameImageData, 0, 0);
            compositeCtx.drawImage(tempCanvas, 0, 0);

            const resultImageData = compositeCtx.getImageData(0, 0, w, h);
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = w;
            frameCanvas.height = h;
            const frameCtx = frameCanvas.getContext('2d');
            frameCtx.putImageData(resultImageData, 0, 0);

            state.frames.push({
                imageData: resultImageData,
                delay: delay || 100,
                canvas: frameCanvas
            });

            switch (frameInfo.disposal) {
                case 2:
                    compositeCtx.clearRect(frameInfo.x, frameInfo.y, frameInfo.width, frameInfo.height);
                    break;
                case 3:
                    if (previousImageData) compositeCtx.putImageData(previousImageData, 0, 0);
                    break;
            }
        }
    }

    // ==============================
    // v2: Blank Frame
    // ==============================
    function insertBlankFrame() {
        if (state.frames.length === 0) return;
        stopPlay();

        const w = state.originalWidth;
        const h = state.originalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        // Canvas is transparent by default

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, w, h);

        const insertAt = state.currentFrame + 1;
        state.frames.splice(insertAt, 0, {
            imageData: imageData,
            delay: 100,
            canvas: canvas
        });

        // Update tags that are after the insertion point
        state.tags.forEach(tag => {
            if (tag.from >= insertAt) tag.from++;
            if (tag.to >= insertAt) tag.to++;
        });

        state.selectedFrames.clear();
        state.currentFrame = insertAt;
        renderFrameList();
        showFrame(insertAt);
        showToast(`빈 프레임 삽입 (#${insertAt + 1})`, 'success');
    }

    // ==============================
    // v2: Tag System
    // ==============================
    function openTagModal() {
        if (state.selectedFrames.size === 0) {
            showToast('태그를 만들 프레임을 먼저 선택하세요', 'error');
            return;
        }

        const indices = Array.from(state.selectedFrames).sort((a, b) => a - b);
        const from = indices[0];
        const to = indices[indices.length - 1];

        dom.tagModalInfo.textContent = `프레임 ${from + 1} ~ ${to + 1} (${to - from + 1}개)`;
        dom.tagNameInput.value = '';
        dom.tagPresets.querySelectorAll('.tag-preset-btn').forEach(b => b.classList.remove('active'));

        // Reset color to first
        dom.tagColors.querySelectorAll('.tag-color-btn').forEach(b => b.classList.remove('selected'));
        dom.tagColors.querySelector('.tag-color-btn').classList.add('selected');

        dom.tagModal.style.display = 'flex';
        dom.tagNameInput.focus();
    }

    function closeTagModal() {
        dom.tagModal.style.display = 'none';
    }

    function confirmCreateTag() {
        const name = dom.tagNameInput.value.trim();
        if (!name) {
            showToast('태그 이름을 입력하세요', 'error');
            return;
        }

        const indices = Array.from(state.selectedFrames).sort((a, b) => a - b);
        const from = indices[0];
        const to = indices[indices.length - 1];

        // Check for overlapping tags
        const overlap = state.tags.find(t => {
            return (from <= t.to && to >= t.from);
        });
        if (overlap) {
            showToast(`프레임 범위가 기존 태그 "${overlap.name}" (${overlap.from + 1}~${overlap.to + 1})과 겨칩니다`, 'error');
            return;
        }

        const colorBtn = dom.tagColors.querySelector('.tag-color-btn.selected');
        const color = colorBtn ? colorBtn.dataset.color : '#4fc3f7';

        state.tags.push({ name, from, to, color });
        closeTagModal();
        renderFrameList();
        showToast(`태그 "${name}" 생성 (프레임 ${from + 1}~${to + 1})`, 'success');
    }

    function deleteTag(index) {
        const tag = state.tags[index];
        state.tags.splice(index, 1);
        renderFrameList();
        showToast(`태그 "${tag.name}" 삭제됨`);
    }

    function renderTagBar() {
        dom.tagBar.innerHTML = '';
        state.tags.forEach((tag, i) => {
            const el = document.createElement('div');
            el.className = 'tag-bar-item';
            el.style.background = tag.color;

            const nameSpan = document.createElement('span');
            nameSpan.textContent = tag.name;

            const rangeSpan = document.createElement('span');
            rangeSpan.className = 'tag-range';
            rangeSpan.textContent = `${tag.from + 1}~${tag.to + 1}`;

            const delBtn = document.createElement('button');
            delBtn.className = 'tag-delete';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', () => deleteTag(i));

            el.appendChild(nameSpan);
            el.appendChild(rangeSpan);
            el.appendChild(delBtn);
            dom.tagBar.appendChild(el);
        });
    }

    // ==============================
    // v2: Aseprite Export
    // ==============================
    async function exportAseprite() {
        if (state.frames.length === 0) return;
        showToast('Aseprite 파일 생성 중...', 'info');

        try {
            const w = state.outputWidth;
            const h = state.outputHeight;

            // Collect frame data
            const frameDataList = [];
            const delays = [];
            for (const frame of state.frames) {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = w;
                tempCanvas.height = h;
                const ctx = tempCanvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(frame.canvas, 0, 0, w, h);
                const data = ctx.getImageData(0, 0, w, h);
                frameDataList.push(data.data);
                delays.push(frame.delay);
            }

            const aseData = await AsepriteEncoder.encode({
                width: w,
                height: h,
                frames: frameDataList,
                delays: delays,
                tags: state.tags
            });

            const blob = new Blob([aseData], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.(gif|aseprite|ase)$/i, '') + '.aseprite';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('Aseprite 파일 다운로드 완료!', 'success');
        } catch (err) {
            showToast('Aseprite 생성 실패: ' + err.message, 'error');
            console.error(err);
        }
    }

    // ==============================
    // Frame Clipboard (Cross-Tab)
    // ==============================
    function copyFramesToClipboard() {
        if (state.selectedFrames.size === 0) {
            showToast('복사할 프레임을 선택하세요', 'error');
            return;
        }

        const indices = Array.from(state.selectedFrames).sort((a, b) => a - b);
        frameClipboard = indices.map(i => {
            const frame = state.frames[i];
            // Deep copy canvas
            const canvas = document.createElement('canvas');
            canvas.width = frame.canvas.width;
            canvas.height = frame.canvas.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(frame.canvas, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            return {
                imageData: imageData,
                delay: frame.delay,
                canvas: canvas,
                srcWidth: frame.canvas.width,
                srcHeight: frame.canvas.height
            };
        });

        showToast(`${frameClipboard.length}개 프레임 복사됨 (Ctrl+V로 붙여넣기)`, 'success');
    }

    function pasteFramesFromClipboard() {
        if (frameClipboard.length === 0) {
            showToast('클립보드가 비어있습니다 (먼저 Ctrl+C로 복사)', 'error');
            return;
        }
        if (state.frames.length === 0) {
            showToast('먼저 GIF 파일을 열어주세요', 'error');
            return;
        }

        stopPlay();

        const insertAt = state.currentFrame + 1;
        const w = state.originalWidth;
        const h = state.originalHeight;

        const newFrames = frameClipboard.map(clipFrame => {
            // Resize if source dimensions differ from current document
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(clipFrame.canvas, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);

            return {
                imageData: imageData,
                delay: clipFrame.delay,
                canvas: canvas
            };
        });

        // Insert pasted frames
        state.frames.splice(insertAt, 0, ...newFrames);

        // Update tag indices
        state.tags.forEach(tag => {
            if (tag.from >= insertAt) tag.from += newFrames.length;
            if (tag.to >= insertAt) tag.to += newFrames.length;
        });

        state.selectedFrames.clear();
        state.currentFrame = insertAt;
        renderFrameList();
        showFrame(insertAt);
        showToast(`${newFrames.length}개 프레임 붙여넣기 완료 (#${insertAt + 1}~)`, 'success');
    }

    // ==============================
    // UI Helpers
    // ==============================
    function enableControls(enabled) {
        dom.btnSelectAll.disabled = !enabled;
        dom.btnSelectOdd.disabled = !enabled;
        dom.btnSelectEven.disabled = !enabled;
        dom.selectSize.disabled = !enabled;
        dom.selectSpeed.disabled = !enabled;
        dom.btnPlay.disabled = !enabled;
        dom.btnDownload.disabled = !enabled;
        dom.inputTargetFrames.disabled = !enabled;
        dom.btnAutoReduce.disabled = !enabled;
        dom.btnAppend.disabled = !enabled;
        dom.btnBlank.disabled = !enabled;
        dom.btnCreateTag.disabled = !enabled;
        dom.btnExportAse.disabled = !enabled;
        dom.btnPencil.disabled = !enabled;
        dom.btnEraser.disabled = !enabled;
        dom.inputBrushSize.disabled = !enabled;
    }

    // ==============================
    // Checkerboard Background
    // ==============================
    let checkerPattern = null;

    function drawCheckerboard(ctx, w, h) {
        if (!checkerPattern) {
            const size = 8;
            const pCanvas = document.createElement('canvas');
            pCanvas.width = size * 2;
            pCanvas.height = size * 2;
            const pCtx = pCanvas.getContext('2d');
            pCtx.fillStyle = '#c0c0c0';
            pCtx.fillRect(0, 0, size * 2, size * 2);
            pCtx.fillStyle = '#808080';
            pCtx.fillRect(0, 0, size, size);
            pCtx.fillRect(size, size, size, size);
            checkerPattern = ctx.createPattern(pCanvas, 'repeat');
        }
        ctx.fillStyle = checkerPattern;
        ctx.fillRect(0, 0, w, h);
    }

    // ==============================
    // Zoom
    // ==============================
    function fitZoomToContainer() {
        const container = dom.canvasContainer;
        const padX = 40, padY = 120;
        const availW = container.clientWidth - padX;
        const availH = container.clientHeight - padY;
        if (availW <= 0 || availH <= 0) { zoomLevel = 1; return; }
        zoomLevel = Math.min(availW / state.outputWidth, availH / state.outputHeight, ZOOM_MAX);
        zoomLevel = Math.max(zoomLevel, ZOOM_MIN);
    }

    function applyZoomStyle() {
        const canvas = dom.previewCanvas;
        const displayW = Math.round(state.outputWidth * zoomLevel);
        const displayH = Math.round(state.outputHeight * zoomLevel);
        canvas.style.width = displayW + 'px';
        canvas.style.height = displayH + 'px';
        canvas.style.maxWidth = 'none';
        canvas.style.maxHeight = 'none';
        canvas.style.transform = 'none';

        // Add padding so edges can be centered on screen
        const container = dom.canvasContainer;
        const padX = Math.max(0, Math.floor(container.clientWidth / 2));
        const padY = Math.max(0, Math.floor(container.clientHeight / 2));
        canvas.style.margin = `${padY}px ${padX}px`;
    }

    function applyZoom(newZoom) {
        zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        applyZoomStyle();
        updateInfo();
        updateBrushCursor();
    }

    function onCanvasWheel(e) {
        if (state.frames.length === 0) return;
        e.preventDefault();
        if (e.deltaY < 0) {
            applyZoom(zoomLevel * ZOOM_STEP);
        } else {
            applyZoom(zoomLevel / ZOOM_STEP);
        }
    }

    // ==============================
    // Panning (Middle-click Hand Tool)
    // ==============================
    function onPanMouseDown(e) {
        if (e.button !== 1) return; // Middle click only
        e.preventDefault();
        isPanning = true;
        const container = dom.canvasContainer;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panScrollLeft = container.scrollLeft;
        panScrollTop = container.scrollTop;
        dom.previewCanvas.style.cursor = 'grabbing';
    }

    function onPanMouseMove(e) {
        if (!isPanning) return;
        e.preventDefault();
        const dx = e.clientX - panStartX;
        const dy = e.clientY - panStartY;
        dom.canvasContainer.scrollLeft = panScrollLeft - dx;
        dom.canvasContainer.scrollTop = panScrollTop - dy;
    }

    function onPanMouseUp(e) {
        if (!isPanning) return;
        if (e.button !== 1) return;
        stopPanning();
    }

    function stopPanning() {
        if (!isPanning) return;
        isPanning = false;
        dom.previewCanvas.style.cursor = currentTool === 'none' ? 'default' : 'none';
    }

    // ==============================
    // Drawing Tools
    // ==============================
    // Brush overlay canvas (pixel-perfect cursor)
    let cursorOverlay = null;

    function ensureCursorOverlay() {
        if (cursorOverlay) return cursorOverlay;
        cursorOverlay = document.createElement('canvas');
        cursorOverlay.id = 'cursor-overlay';
        cursorOverlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;image-rendering:pixelated;';
        dom.canvasContainer.style.position = 'relative';
        dom.canvasContainer.appendChild(cursorOverlay);
        return cursorOverlay;
    }

    function syncOverlaySize() {
        if (!cursorOverlay) return;
        const pc = dom.previewCanvas;
        cursorOverlay.width = pc.width;
        cursorOverlay.height = pc.height;
        cursorOverlay.style.width = pc.style.width;
        cursorOverlay.style.height = pc.style.height;
        // Match position of preview canvas
        cursorOverlay.style.left = pc.offsetLeft + 'px';
        cursorOverlay.style.top = pc.offsetTop + 'px';
    }

    function drawBrushOverlay(e) {
        if (currentTool === 'none' || !cursorOverlay) return;
        const oc = cursorOverlay;
        const ctx = oc.getContext('2d');
        ctx.clearRect(0, 0, oc.width, oc.height);

        const rect = dom.previewCanvas.getBoundingClientRect();
        const scaleX = state.outputWidth / rect.width;
        const scaleY = state.outputHeight / rect.height;
        // Pixel coordinate on preview canvas (output resolution)
        const canvasX = Math.floor((e.clientX - rect.left) * scaleX);
        const canvasY = Math.floor((e.clientY - rect.top) * scaleY);

        // Brush size in output pixels
        const brushW = Math.round(brushSize * state.outputWidth / state.originalWidth);
        const brushH = Math.round(brushSize * state.outputHeight / state.originalHeight);
        const offsetX = Math.floor(brushW / 2);
        const offsetY = Math.floor(brushH / 2);
        const px = canvasX - offsetX;
        const py = canvasY - offsetY;

        // Draw outline
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, brushW - 1, brushH - 1);
        ctx.strokeStyle = '#000';
        ctx.strokeRect(px - 0.5, py - 0.5, brushW + 1, brushH + 1);
    }

    function clearBrushOverlay() {
        if (!cursorOverlay) return;
        const ctx = cursorOverlay.getContext('2d');
        ctx.clearRect(0, 0, cursorOverlay.width, cursorOverlay.height);
    }

    function setTool(tool) {
        currentTool = tool;
        dom.btnPencil.classList.toggle('tool-active', tool === 'pencil');
        dom.btnEraser.classList.toggle('tool-active', tool === 'eraser');

        if (tool === 'none') {
            dom.previewCanvas.style.cursor = 'default';
            clearBrushOverlay();
        } else {
            ensureCursorOverlay();
            syncOverlaySize();
            dom.previewCanvas.style.cursor = 'none';
        }

        // Show/hide palette bar
        if (dom.paletteBar) {
            dom.paletteBar.style.display = (tool === 'pencil') ? 'flex' : 'none';
        }
    }

    function updateBrushCursor() {
        // Sync overlay size on zoom/brush change
        if (currentTool !== 'none' && cursorOverlay) {
            syncOverlaySize();
        }
    }

    function extractPalette() {
        const colorSet = new Set();
        const maxSample = Math.min(state.frames.length, 10); // Sample up to 10 frames
        const step = Math.max(1, Math.floor(state.frames.length / maxSample));

        for (let fi = 0; fi < state.frames.length; fi += step) {
            const data = state.frames[fi].imageData.data;
            // Sample every 4th pixel for performance
            for (let i = 0; i < data.length; i += 16) {
                const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
                if (a < 128) continue; // Skip transparent
                // Quantize to reduce similar colors (round to nearest 8)
                const qr = (r >> 3) << 3;
                const qg = (g >> 3) << 3;
                const qb = (b >> 3) << 3;
                colorSet.add(`${qr},${qg},${qb}`);
            }
        }

        // Convert to hex and limit
        palette = [];
        for (const c of colorSet) {
            if (palette.length >= 128) break;
            const [r, g, b] = c.split(',').map(Number);
            const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
            palette.push(hex);
        }

        // Sort by luminance
        palette.sort((a, b) => {
            const lumA = colorLuminance(a);
            const lumB = colorLuminance(b);
            return lumA - lumB;
        });

        renderPalette();
    }

    function colorLuminance(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    function renderPalette() {
        dom.paletteSwatches.innerHTML = '';

        palette.forEach((color, i) => {
            const swatch = document.createElement('div');
            swatch.className = 'palette-swatch';
            if (i === 0) {
                swatch.classList.add('selected');
                brushColor = color;
                dom.currentColor.style.background = color;
            }
            swatch.style.background = color;
            swatch.dataset.color = color;
            swatch.title = color;
            dom.paletteSwatches.appendChild(swatch);
        });
    }

    function getFramePixelCoords(e) {
        const canvas = dom.previewCanvas;
        const rect = canvas.getBoundingClientRect();
        const scaleX = state.originalWidth / rect.width;
        const scaleY = state.originalHeight / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        return { x, y };
    }

    function drawPixel(frame, x, y) {
        const ctx = frame.canvas.getContext('2d');
        const offset = Math.floor(brushSize / 2);
        const px = x - offset;
        const py = y - offset;
        if (currentTool === 'pencil') {
            ctx.fillStyle = brushColor;
            ctx.fillRect(px, py, brushSize, brushSize);
        } else if (currentTool === 'eraser') {
            ctx.clearRect(px, py, brushSize, brushSize);
        }
    }

    function drawLine(frame, x0, y0, x1, y1) {
        // Bresenham's line algorithm for smooth strokes
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;

        while (true) {
            drawPixel(frame, x0, y0);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
    }

    function finishDrawStroke() {
        if (!isDrawing) return;
        isDrawing = false;
        lastDrawPos = null;

        // Update frame imageData and thumbnail
        const frame = state.frames[state.currentFrame];
        const ctx = frame.canvas.getContext('2d');
        frame.imageData = ctx.getImageData(0, 0, frame.canvas.width, frame.canvas.height);

        // Refresh the thumbnail in frame list
        updateFrameThumbnail(state.currentFrame);
    }

    function updateFrameThumbnail(index) {
        const item = dom.frameList.querySelector(`.frame-item[data-index="${index}"]`);
        if (!item) return;
        const thumbCanvas = item.querySelector('.frame-thumb canvas');
        if (!thumbCanvas) return;

        const frame = state.frames[index];
        const tCtx = thumbCanvas.getContext('2d');
        tCtx.clearRect(0, 0, 36, 36);
        const srcW = frame.canvas.width;
        const srcH = frame.canvas.height;
        const scale = Math.min(36 / srcW, 36 / srcH);
        const dw = srcW * scale;
        const dh = srcH * scale;
        tCtx.imageSmoothingEnabled = false;
        tCtx.drawImage(frame.canvas, (36 - dw) / 2, (36 - dh) / 2, dw, dh);
    }

    function onCanvasMouseDown(e) {
        if (currentTool === 'none' || state.frames.length === 0) return;
        if (e.button !== 0) return; // Left click only

        isDrawing = true;
        const pos = getFramePixelCoords(e);
        lastDrawPos = pos;

        const frame = state.frames[state.currentFrame];
        drawPixel(frame, pos.x, pos.y);
        showFrame(state.currentFrame);
    }

    function onCanvasMouseMove(e) {
        // Always update brush overlay
        drawBrushOverlay(e);

        if (!isDrawing || currentTool === 'none') return;

        const pos = getFramePixelCoords(e);
        const frame = state.frames[state.currentFrame];

        if (lastDrawPos) {
            drawLine(frame, lastDrawPos.x, lastDrawPos.y, pos.x, pos.y);
        } else {
            drawPixel(frame, pos.x, pos.y);
        }

        lastDrawPos = pos;
        showFrame(state.currentFrame);
    }

    function onCanvasMouseUp(e) {
        finishDrawStroke();
    }

    function showToast(message, type = 'info') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // ==============================
    // Start
    // ==============================
    document.addEventListener('DOMContentLoaded', init);
})();
