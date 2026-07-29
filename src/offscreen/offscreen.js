(function () {
    const OFFSCREEN_LOG_PREFIX = '[Canvascope Offscreen]';
    const DROPBRIDGE_GET_CONTEXT_ACTION = 'dropbridgeGetReceiverContext';
    const DROPBRIDGE_WAKE_ACTION = 'dropbridgeReceiverWake';
    const DROPBRIDGE_STATUS_ACTION = 'dropbridgeReceiverStatus';
    const DROPBRIDGE_CONNECT_ACTION = 'dropbridgeReceiverConnect';
    const DROPBRIDGE_DISCONNECT_ACTION = 'dropbridgeReceiverDisconnect';
    const DROPBRIDGE_WAKE_EVENT = 'upload_queued';
    const RECONNECT_DELAY_MS = 2000;
    const RECONNECT_MAX_DELAY_MS = 60000;

    let supabaseClient = null;
    let currentContextKey = '';
    let currentTopic = null;
    let currentChannel = null;
    let connectPromise = null;
    let reconnectTimer = null;
    let reconnectDelayMs = RECONNECT_DELAY_MS;
    // The offscreen document is shared with the embeddings host. Background
    // parks the DropBridge receiver (latch off) instead of closing the doc
    // when embeddings are still loaded; TRUE default means a doc created by
    // either owner self-connects and then parks itself via the no-context
    // path when Lectra is off — crash-recreated docs self-heal.
    let receiverEnabled = true;

    function log(message, details = undefined) {
        if (details === undefined) {
            console.log(`${OFFSCREEN_LOG_PREFIX} ${message}`);
            return;
        }
        console.log(`${OFFSCREEN_LOG_PREFIX} ${message}`, details);
    }

    function parseErrorMessage(error) {
        if (!error) return 'Unknown error';
        if (typeof error === 'string') return error;
        if (typeof error.message === 'string' && error.message) return error.message;
        return String(error);
    }

    function sendRuntimeMessage(message) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        resolve({ success: false, error: lastError.message || 'Runtime message failed.' });
                        return;
                    }
                    resolve(response || { success: true });
                });
            } catch (error) {
                resolve({ success: false, error: parseErrorMessage(error) });
            }
        });
    }

    async function getReceiverContext() {
        const response = await sendRuntimeMessage({ action: DROPBRIDGE_GET_CONTEXT_ACTION });
        if (!response?.success) {
            throw new Error(response?.error || 'Unable to get DropBridge receiver context.');
        }
        if (!response.enabled || !response.signedIn) {
            return null;
        }
        if (!response.accessToken || !response.userId || !response.deviceId || !response.topic || !response.supabaseUrl || !response.supabaseKey) {
            throw new Error('DropBridge receiver context is incomplete.');
        }
        return response;
    }

    async function getAccessToken() {
        const context = await getReceiverContext();
        if (!context?.accessToken) {
            throw new Error('No access token available for DropBridge receiver.');
        }
        return context.accessToken;
    }

    function buildContextKey(context) {
        return [
            context.supabaseUrl,
            context.supabaseKey,
            context.userId,
            context.deviceId,
            context.topic
        ].join('|');
    }

    function normalizeWakeUpload(payload) {
        const customPayload = payload?.payload && typeof payload.payload === 'object'
            ? payload.payload
            : null;
        const row = customPayload
            || (payload?.new && typeof payload.new === 'object'
            ? payload.new
            : (payload && typeof payload === 'object' ? payload : {}));
        const uploadId = row.uploadId || row.id || null;
        return {
            uploadId,
            fileName: row.fileName || row.file_name || null,
            sizeBytes: row.sizeBytes ?? row.size_bytes ?? null,
            mimeType: row.mimeType || row.mime_type || null,
            createdAt: row.createdAt || row.created_at || null
        };
    }

    async function reportStatus(status, details = {}) {
        await sendRuntimeMessage({
            action: DROPBRIDGE_STATUS_ACTION,
            status,
            ...details
        });
    }

    async function notifyWake(reason, details = {}) {
        await sendRuntimeMessage({
            action: DROPBRIDGE_WAKE_ACTION,
            reason,
            ...details
        });
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function scheduleReconnect(reason) {
        if (!receiverEnabled) return;
        if (reconnectTimer) return;
        // Exponential backoff (2s → 60s cap) so an extended outage doesn't
        // turn into a constant retry loop; reset to the base delay once a
        // subscription succeeds.
        const delayMs = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            ensureReceiverConnected(reason).catch((error) => {
                log('Reconnect failed', parseErrorMessage(error));
                scheduleReconnect(`${reason}-retry`);
            });
        }, delayMs);
    }

    async function ensureSupabaseClient(context) {
        if (supabaseClient) {
            return supabaseClient;
        }

        if (!globalThis.supabase || typeof globalThis.supabase.createClient !== 'function') {
            throw new Error('Supabase client is unavailable in offscreen receiver.');
        }

        supabaseClient = globalThis.supabase.createClient(context.supabaseUrl, context.supabaseKey, {
            accessToken: getAccessToken,
            realtime: {
                worker: true
            }
        });
        return supabaseClient;
    }

    async function disconnectReceiver(reason = 'disconnect', shouldReport = true) {
        clearReconnectTimer();

        const channel = currentChannel;
        currentChannel = null;
        currentTopic = null;
        currentContextKey = '';

        if (supabaseClient && channel) {
            try {
                await supabaseClient.removeChannel(channel);
            } catch (error) {
                log('removeChannel failed', parseErrorMessage(error));
            }
        }

        if (shouldReport) {
            await reportStatus('closed', {
                reason,
                topic: channel?.topic || null
            });
        }
    }

    async function connectReceiver(reason = 'startup') {
        if (!receiverEnabled) return false;
        let context = null;
        try {
            context = await getReceiverContext();
        } catch (error) {
            const message = parseErrorMessage(error);
            await reportStatus('error', { reason, error: message, topic: currentTopic });
            scheduleReconnect('context-error');
            throw error;
        }

        if (!context) {
            await disconnectReceiver('no-context');
            return false;
        }

        const nextContextKey = buildContextKey(context);
        if (currentChannel && currentContextKey === nextContextKey) {
            return true;
        }

        await ensureSupabaseClient(context);

        if (currentChannel) {
            await disconnectReceiver('rebind', false);
        }

        currentContextKey = nextContextKey;
        currentTopic = context.topic;

        await reportStatus('connecting', {
            reason,
            topic: context.topic
        });

        if (!receiverEnabled) return false;

        const wakeEvent = context.wakeEvent || DROPBRIDGE_WAKE_EVENT;
        const channel = supabaseClient.channel(context.topic, {
            config: {
                private: true
            }
        });

        channel.on('broadcast', { event: wakeEvent }, (payload) => {
            const upload = normalizeWakeUpload(payload);
            const uploadId = upload.uploadId || null;
            const realtimeReceivedAt = new Date().toISOString();
            log('Wake event received', {
                topic: context.topic,
                uploadId,
                fileName: upload.fileName,
                sizeBytes: upload.sizeBytes
            });
            void notifyWake('upload_queued', {
                topic: context.topic,
                uploadId,
                upload,
                realtimeReceivedAt
            });
        });

        currentChannel = channel;

        channel.subscribe((status, error) => {
            if (channel !== currentChannel) {
                return;
            }

            const errorMessage = error ? parseErrorMessage(error) : null;
            log('Realtime subscribe status', {
                status,
                topic: context.topic,
                error: errorMessage
            });

            if (status === 'SUBSCRIBED') {
                clearReconnectTimer();
                reconnectDelayMs = RECONNECT_DELAY_MS;
                void reportStatus('subscribed', {
                    reason,
                    topic: context.topic
                });
                void notifyWake('realtime_subscribed', {
                    topic: context.topic
                });
                return;
            }

            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                const normalizedStatus = status === 'TIMED_OUT' ? 'timed_out' : 'error';
                void reportStatus(normalizedStatus, {
                    reason,
                    topic: context.topic,
                    error: errorMessage || status
                });
                scheduleReconnect(status.toLowerCase());
                return;
            }

            if (status === 'CLOSED') {
                void reportStatus('closed', {
                    reason,
                    topic: context.topic,
                    error: errorMessage
                });
                scheduleReconnect('closed');
            }
        });

        return true;
    }

    function ensureReceiverConnected(reason = 'startup') {
        if (connectPromise) {
            return connectPromise;
        }
        connectPromise = (async () => {
            try {
                return await connectReceiver(reason);
            } finally {
                connectPromise = null;
            }
        })();
        return connectPromise;
    }

    // Background ↔ receiver control channel. The embeddings host registers
    // its own listener filtered on message.target === 'cs-embeddings';
    // everything else falls through both listeners untouched.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.target === 'cs-embeddings') return false;

        if (message.action === DROPBRIDGE_CONNECT_ACTION) {
            receiverEnabled = true;
            clearReconnectTimer();
            reconnectDelayMs = RECONNECT_DELAY_MS;
            ensureReceiverConnected(message.reason || 'connect-message')
                .then((connected) => sendResponse({ success: true, connected: Boolean(connected) }))
                .catch((error) => sendResponse({ success: false, error: parseErrorMessage(error) }));
            return true;
        }

        if (message.action === DROPBRIDGE_DISCONNECT_ACTION) {
            (async () => {
                const wasIdle = !receiverEnabled && !currentChannel && !connectPromise;
                receiverEnabled = false;
                if (connectPromise) {
                    try { await connectPromise; } catch (_) { /* reported upstream */ }
                }
                // A connect message that arrived during the await re-armed the
                // latch; it wins — tearing down now would leave an armed latch
                // with no channel and no reconnect timer (a dead receiver).
                if (receiverEnabled) {
                    sendResponse({ success: true, superseded: true });
                    return;
                }
                clearReconnectTimer();
                if (!wasIdle) {
                    await disconnectReceiver('receiver-disabled', true);
                }
                sendResponse({ success: true });
            })();
            return true;
        }

        return false;
    });

    window.addEventListener('pagehide', () => {
        void disconnectReceiver('pagehide');
    });

    if (receiverEnabled) {
        void ensureReceiverConnected('startup').catch((error) => {
            log('Initial connection failed', parseErrorMessage(error));
            scheduleReconnect('startup-failed');
        });
    }
})();
