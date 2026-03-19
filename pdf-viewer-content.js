(() => {
    const initKey = '__canvascopePdfViewerOverlayInitialized';
    const DEBUG = true;

    function debug(message, details = undefined) {
        if (!DEBUG) return;
        const prefix = '[Canvascope PDF Viewer][Content]';
        if (details === undefined) {
            console.log(prefix, message);
            return;
        }
        console.log(prefix, message, details);
    }

    if (globalThis[initKey]) {
        debug('Skipping init because overlay script already ran once');
        return;
    }
    globalThis[initKey] = true;
    debug('Overlay script booted', {
        href: window.location.href,
        title: document.title
    });

    const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
        enableSendToLectra: false
    });
    const BUTTON_POSITION_STORAGE_KEY = 'lectraSendButtonPositions';
    const BUTTON_POSITION_SLOT = 'pdfViewer';
    const BUTTON_HOLD_TO_DRAG_MS = 350;
    const BUTTON_DRAG_CANCEL_DISTANCE_PX = 12;
    const BUTTON_DEFAULT_RIGHT_PX = 20;
    const BUTTON_DEFAULT_BOTTOM_PX = 96;
    const BUTTON_EDGE_PADDING_PX = 12;
    const BUTTON_DEFAULT_TRANSITION = 'transform 0.15s ease, opacity 0.2s ease';

    let viewerExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
    let overlayContext = null;
    let sendButton = null;
    let sendButtonBusy = false;
    let refreshTimer = null;
    let sendButtonPosition = null;
    let sendButtonDragState = null;
    let suppressNextSendButtonClick = false;

    function normalizeExtensionSettings(rawSettings) {
        const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
        return {
            ...DEFAULT_EXTENSION_SETTINGS,
            ...source
        };
    }

    function isSendToLectraEnabled() {
        return Boolean(viewerExtensionSettings.enableSendToLectra);
    }

    function normalizeStoredButtonPosition(rawValue) {
        if (!rawValue || typeof rawValue !== 'object') return null;
        const left = Number(rawValue.left);
        const top = Number(rawValue.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) {
            return null;
        }
        return {
            left: Math.round(left),
            top: Math.round(top)
        };
    }

    function clampButtonPosition(position, button = sendButton) {
        if (!position || !button) return null;
        const rect = button.getBoundingClientRect();
        const maxLeft = Math.max(BUTTON_EDGE_PADDING_PX, window.innerWidth - rect.width - BUTTON_EDGE_PADDING_PX);
        const maxTop = Math.max(BUTTON_EDGE_PADDING_PX, window.innerHeight - rect.height - BUTTON_EDGE_PADDING_PX);
        return {
            left: Math.min(Math.max(BUTTON_EDGE_PADDING_PX, Math.round(position.left)), Math.round(maxLeft)),
            top: Math.min(Math.max(BUTTON_EDGE_PADDING_PX, Math.round(position.top)), Math.round(maxTop))
        };
    }

    function applySendButtonPosition(button = sendButton) {
        if (!button) return;

        if (!sendButtonPosition) {
            button.style.left = 'auto';
            button.style.top = 'auto';
            button.style.right = `${BUTTON_DEFAULT_RIGHT_PX}px`;
            button.style.bottom = `${BUTTON_DEFAULT_BOTTOM_PX}px`;
            return;
        }

        const clamped = clampButtonPosition(sendButtonPosition, button);
        if (!clamped) return;
        sendButtonPosition = clamped;
        button.style.left = `${clamped.left}px`;
        button.style.top = `${clamped.top}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
    }

    async function persistSendButtonPosition(position) {
        try {
            const stored = await chrome.storage.local.get([BUTTON_POSITION_STORAGE_KEY]);
            const positions = stored?.[BUTTON_POSITION_STORAGE_KEY] && typeof stored[BUTTON_POSITION_STORAGE_KEY] === 'object'
                ? { ...stored[BUTTON_POSITION_STORAGE_KEY] }
                : {};
            positions[BUTTON_POSITION_SLOT] = position;
            await chrome.storage.local.set({ [BUTTON_POSITION_STORAGE_KEY]: positions });
            debug('Persisted button position', position);
        } catch (error) {
            debug('Failed to persist button position', error?.message || 'unknown');
        }
    }

    function clearPendingDragHold() {
        if (sendButtonDragState?.holdTimer) {
            clearTimeout(sendButtonDragState.holdTimer);
            sendButtonDragState.holdTimer = null;
        }
    }

    function beginSendButtonDrag() {
        if (!sendButton || !sendButtonDragState || sendButtonBusy) return;

        const rect = sendButton.getBoundingClientRect();
        sendButtonDragState.dragging = true;
        sendButtonDragState.startLeft = rect.left;
        sendButtonDragState.startTop = rect.top;
        suppressNextSendButtonClick = true;

        sendButton.style.transition = 'none';
        sendButton.style.transform = 'translateY(0)';
        sendButton.style.cursor = 'grabbing';
        sendButton.style.left = `${Math.round(rect.left)}px`;
        sendButton.style.top = `${Math.round(rect.top)}px`;
        sendButton.style.right = 'auto';
        sendButton.style.bottom = 'auto';
        document.documentElement.style.userSelect = 'none';
        debug('Button drag started', {
            left: rect.left,
            top: rect.top
        });
    }

    function finishSendButtonDrag({ persist = true } = {}) {
        if (!sendButtonDragState) return;
        clearPendingDragHold();

        if (sendButton && sendButtonDragState.dragging) {
            const finalPosition = clampButtonPosition({
                left: sendButtonDragState.currentLeft,
                top: sendButtonDragState.currentTop
            }, sendButton);
            if (finalPosition) {
                sendButtonPosition = finalPosition;
                applySendButtonPosition(sendButton);
                if (persist) {
                    void persistSendButtonPosition(finalPosition);
                }
            }
            sendButton.style.transition = BUTTON_DEFAULT_TRANSITION;
            sendButton.style.cursor = sendButtonBusy ? 'default' : 'pointer';
        }

        document.documentElement.style.userSelect = '';
        sendButtonDragState = null;
    }

    function handleSendButtonPointerDown(event) {
        if (!sendButton || sendButtonBusy) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        const rect = sendButton.getBoundingClientRect();
        sendButtonDragState = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            currentLeft: rect.left,
            currentTop: rect.top,
            dragging: false,
            holdTimer: null
        };

        sendButtonDragState.holdTimer = setTimeout(() => {
            beginSendButtonDrag();
        }, BUTTON_HOLD_TO_DRAG_MS);

        try {
            sendButton.setPointerCapture(event.pointerId);
        } catch {
            // Ignore browsers that reject pointer capture for this element.
        }
    }

    function handleSendButtonPointerMove(event) {
        if (!sendButton || !sendButtonDragState || sendButtonDragState.pointerId !== event.pointerId) {
            return;
        }

        const deltaX = event.clientX - sendButtonDragState.startClientX;
        const deltaY = event.clientY - sendButtonDragState.startClientY;
        if (!sendButtonDragState.dragging) {
            if (Math.hypot(deltaX, deltaY) > BUTTON_DRAG_CANCEL_DISTANCE_PX) {
                clearPendingDragHold();
            }
            return;
        }

        event.preventDefault();
        const nextPosition = clampButtonPosition({
            left: sendButtonDragState.startLeft + deltaX,
            top: sendButtonDragState.startTop + deltaY
        }, sendButton);
        if (!nextPosition) return;
        sendButtonDragState.currentLeft = nextPosition.left;
        sendButtonDragState.currentTop = nextPosition.top;
        sendButton.style.left = `${nextPosition.left}px`;
        sendButton.style.top = `${nextPosition.top}px`;
    }

    function handleSendButtonPointerEnd(event) {
        if (!sendButtonDragState || sendButtonDragState.pointerId !== event.pointerId) {
            return;
        }

        if (sendButtonDragState.dragging) {
            event.preventDefault();
        }

        try {
            sendButton?.releasePointerCapture?.(event.pointerId);
        } catch {
            // Ignore pointer-capture cleanup failures.
        }

        finishSendButtonDrag({ persist: true });
    }

    function ensureSendButton() {
        if (sendButton && sendButton.isConnected) {
            return sendButton;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'canvascope-send-to-lectra-btn';
        button.textContent = 'Send to Lectra';
        button.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 96px;
            z-index: 2147483000;
            padding: 10px 14px;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.24);
            background: linear-gradient(135deg, #d43c3c 0%, #b72c2c 100%);
            color: #fff;
            font-size: 13px;
            font-weight: 600;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
            cursor: pointer;
            transition: ${BUTTON_DEFAULT_TRANSITION};
            touch-action: none;
        `;
        button.title = 'Send to Lectra. Press and hold to move.';
        button.addEventListener('mouseenter', () => {
            if (!sendButtonBusy && !sendButtonDragState?.dragging) {
                button.style.transform = 'translateY(-1px)';
            }
        });
        button.addEventListener('mouseleave', () => {
            if (!sendButtonDragState?.dragging) {
                button.style.transform = 'translateY(0)';
            }
        });
        button.addEventListener('pointerdown', handleSendButtonPointerDown);
        button.addEventListener('pointermove', handleSendButtonPointerMove);
        button.addEventListener('pointerup', handleSendButtonPointerEnd);
        button.addEventListener('pointercancel', handleSendButtonPointerEnd);
        button.addEventListener('click', handleSendButtonClick);

        (document.body || document.documentElement).appendChild(button);
        sendButton = button;
        applySendButtonPosition(button);
        debug('Created floating Send to Lectra button');
        return button;
    }

    function removeSendButton() {
        if (sendButton && sendButton.parentNode) {
            sendButton.parentNode.removeChild(sendButton);
            debug('Removed floating Send to Lectra button');
        }
        clearPendingDragHold();
        document.documentElement.style.userSelect = '';
        sendButton = null;
        sendButtonBusy = false;
        sendButtonDragState = null;
    }

    function setSendButtonState(text, state = 'idle') {
        const button = ensureSendButton();
        button.textContent = text;

        if (state === 'sending') {
            sendButtonBusy = true;
            button.disabled = true;
            button.style.opacity = '0.8';
            button.style.cursor = 'default';
            return;
        }

        sendButtonBusy = false;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';

        if (state === 'success') {
            button.style.background = 'linear-gradient(135deg, #1f9f5a 0%, #187a45 100%)';
            return;
        }

        if (state === 'error') {
            button.style.background = 'linear-gradient(135deg, #a43b3b 0%, #7f2a2a 100%)';
            return;
        }

        button.style.background = 'linear-gradient(135deg, #d43c3c 0%, #b72c2c 100%)';
    }

    function scheduleOverlayRefresh(delayMs = 0) {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        debug('Scheduling overlay refresh', { delayMs });
        refreshTimer = setTimeout(refreshOverlayContext, delayMs);
    }

    function refreshOverlayContext() {
        debug('Refreshing overlay context', {
            enabled: isSendToLectraEnabled(),
            href: window.location.href
        });
        if (!isSendToLectraEnabled()) {
            overlayContext = null;
            removeSendButton();
            debug('Overlay disabled by settings');
            return;
        }

        chrome.runtime.sendMessage({ action: 'resolvePdfViewerOverlayContext' }, (response) => {
            if (chrome.runtime.lastError) {
                debug('resolvePdfViewerOverlayContext runtime error', chrome.runtime.lastError.message || 'unknown');
                overlayContext = null;
                removeSendButton();
                return;
            }

            overlayContext = response || null;
            debug('resolvePdfViewerOverlayContext response', overlayContext);
            if (!response?.showButton || !response?.candidateUrl) {
                removeSendButton();
                debug('Not showing button because resolver did not approve this tab');
                return;
            }

            setSendButtonState('Send to Lectra', 'idle');
            debug('Button should now be visible', {
                candidateUrl: response.candidateUrl,
                sourcePageUrl: response.sourcePageUrl
            });
        });
    }

    function handleSendButtonClick() {
        if (suppressNextSendButtonClick) {
            suppressNextSendButtonClick = false;
            debug('Suppressing click after button drag');
            return;
        }
        debug('Floating button clicked', {
            busy: sendButtonBusy,
            candidateUrl: overlayContext?.candidateUrl || null
        });
        if (sendButtonBusy) return;
        if (!isSendToLectraEnabled()) {
            removeSendButton();
            return;
        }

        if (!overlayContext?.candidateUrl) {
            scheduleOverlayRefresh(0);
            return;
        }

        const confirmed = window.confirm('Send this PDF to Lectra?');
        if (!confirmed) return;

        setSendButtonState('Sending…', 'sending');
        chrome.runtime.sendMessage({
            action: 'sendPdfToLectra',
            trigger: 'pdf_viewer_overlay',
            candidateUrl: overlayContext.candidateUrl,
            sourcePageUrl: overlayContext.sourcePageUrl || window.location.href,
            titleHint: overlayContext.titleHint || document.title || ''
        }, (response) => {
            if (chrome.runtime.lastError) {
                debug('sendPdfToLectra runtime error', chrome.runtime.lastError.message || 'unknown');
                setSendButtonState('Failed', 'error');
                const runtimeMessage = chrome.runtime.lastError.message || 'Send failed.';
                if (runtimeMessage) {
                    window.alert(runtimeMessage);
                }
                setTimeout(() => {
                    if (sendButton) {
                        setSendButtonState('Send to Lectra', 'idle');
                    }
                }, 1800);
                return;
            }

            debug('sendPdfToLectra response', response);
            if (response?.success) {
                setSendButtonState('Sent ✓', 'success');
                setTimeout(() => {
                    if (sendButton) {
                        setSendButtonState('Send to Lectra', 'idle');
                    }
                }, 1800);
                return;
            }

            setSendButtonState('Failed', 'error');
            if (response?.message) {
                window.alert(String(response.message));
            }
            setTimeout(() => {
                if (sendButton) {
                    setSendButtonState('Send to Lectra', 'idle');
                }
            }, 2200);
        });
    }

    try {
        chrome.storage.local.get(['settings', BUTTON_POSITION_STORAGE_KEY]).then((data) => {
            viewerExtensionSettings = normalizeExtensionSettings(data.settings);
            sendButtonPosition = normalizeStoredButtonPosition(data?.[BUTTON_POSITION_STORAGE_KEY]?.[BUTTON_POSITION_SLOT]);
            debug('Loaded settings from storage', {
                settings: viewerExtensionSettings,
                buttonPosition: sendButtonPosition
            });
            scheduleOverlayRefresh(0);
            setTimeout(() => scheduleOverlayRefresh(0), 160);
            setTimeout(() => scheduleOverlayRefresh(0), 900);
        });
    } catch {
        debug('Storage.get failed during boot, refreshing anyway');
        scheduleOverlayRefresh(0);
    }

    try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;

            if (changes.settings) {
                viewerExtensionSettings = normalizeExtensionSettings(changes.settings.newValue);
                debug('Observed settings change', viewerExtensionSettings);
                if (!isSendToLectraEnabled()) {
                    overlayContext = null;
                    removeSendButton();
                    return;
                }
                scheduleOverlayRefresh(0);
            }

            if (changes[BUTTON_POSITION_STORAGE_KEY]) {
                sendButtonPosition = normalizeStoredButtonPosition(
                    changes[BUTTON_POSITION_STORAGE_KEY]?.newValue?.[BUTTON_POSITION_SLOT]
                );
                debug('Observed button position change', sendButtonPosition);
                if (sendButton && sendButton.isConnected) {
                    applySendButtonPosition(sendButton);
                }
            }
        });
    } catch {
        // Storage access can fail on teardown. Ignore and keep the current button state.
    }

    window.addEventListener('pageshow', () => scheduleOverlayRefresh(0));
    window.addEventListener('resize', () => {
        if (sendButton && sendButton.isConnected && sendButtonPosition) {
            applySendButtonPosition(sendButton);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            debug('Document became visible again, refreshing');
            scheduleOverlayRefresh(0);
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action !== 'canvascopePdfViewerDebugPing') {
            return false;
        }

        const payload = {
            success: true,
            href: window.location.href,
            title: document.title,
            sendButtonPresent: Boolean(sendButton && sendButton.isConnected),
            overlayContext,
            settings: viewerExtensionSettings
        };
        debug('Received debug ping', payload);
        sendResponse(payload);
        return true;
    });
})();
