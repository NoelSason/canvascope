import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tiny config stub instead of the real embeddings-config.js: 4-dim vectors
// and a 60ms idle window keep the state-machine tests fast and deterministic.
globalThis.CanvascopeEmbeddingsConfig = {
    MODEL_ID: 'test-model',
    DIMS: 4,
    QUERY_PREFIX: 'QP: ',
    IDLE_UNLOAD_MS: 60
};

const messageListeners = [];
const sentMessages = [];
globalThis.chrome = {
    runtime: {
        onMessage: {
            addListener: (fn) => messageListeners.push(fn)
        },
        sendMessage: (message, callback) => {
            sentMessages.push(message);
            if (callback) callback();
        },
        getURL: (p) => `chrome-extension://test/${p}`,
        lastError: null
    }
};

const hostCode = readFileSync(join(__dirname, '..', 'src', 'offscreen', 'embeddings-host.js'), 'utf8');
new Function(hostCode)();
const Host = globalThis.CanvascopeEmbeddingsHost;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function makeMockPipeline({ loadDelay = 0, disposeDelay = 0, onTexts = null } = {}) {
    const record = { loads: 0, disposes: 0, texts: [] };
    record.loadPipeline = async () => {
        record.loads++;
        if (loadDelay) await sleep(loadDelay);
        const pipe = async (texts) => {
            record.texts.push(...texts);
            if (onTexts) onTexts(texts);
            const data = new Float32Array(texts.length * 4);
            for (let i = 0; i < data.length; i++) data[i] = (i % 4) + 1;
            return { data };
        };
        pipe.dispose = async () => {
            record.disposes++;
            if (disposeDelay) await sleep(disposeDelay);
        };
        return pipe;
    };
    return record;
}

test('protocol shapes: embedText/embedBatch/status/unknown op', async () => {
    const mock = makeMockPipeline();
    Host.setLoadPipeline(mock.loadPipeline);

    const single = await Host.handleMessage({ op: 'embedText', text: 'hello', kind: 'passage' });
    assert.equal(single.success, true);
    assert.equal(single.vector.length, 4);

    const batch = await Host.handleMessage({ op: 'embedBatch', texts: ['a', 'b', 'c'], kind: 'passage' });
    assert.equal(batch.success, true);
    assert.equal(batch.vectors.length, 3);
    assert.equal(batch.vectors[1].length, 4);

    const status = await Host.handleMessage({ op: 'status' });
    assert.equal(status.success, true);
    assert.equal(status.state, 'ready');
    assert.equal(status.modelId, 'test-model');

    const bogus = await Host.handleMessage({ op: 'reticulate' });
    assert.equal(bogus.success, false);
    await Host.handleMessage({ op: 'unload' });
});

test('query prefix applied host-side for kind query only', async () => {
    const mock = makeMockPipeline();
    Host.setLoadPipeline(mock.loadPipeline);

    await Host.handleMessage({ op: 'embedText', text: 'find hw', kind: 'query' });
    await Host.handleMessage({ op: 'embedText', text: 'passage body', kind: 'passage' });

    assert.ok(mock.texts.includes('QP: find hw'));
    assert.ok(mock.texts.includes('passage body'));
    assert.ok(!mock.texts.includes('find hw'), 'bare query never reaches the pipeline');
    assert.ok(!mock.texts.includes('QP: passage body'), 'passages are never prefixed');
    await Host.handleMessage({ op: 'unload' });
});

test('onMessage listener filters on target and ignores other traffic', () => {
    assert.equal(messageListeners.length, 1);
    const listener = messageListeners[0];
    assert.equal(listener({ action: 'dropbridgeReceiverWake' }, {}, () => {}), false);
    assert.equal(listener(null, {}, () => {}), false);
    assert.equal(listener({ target: 'cs-embeddings', op: 'status' }, {}, () => {}), true);
});

test('idle dispose fires after IDLE_UNLOAD_MS and notifies background; status polls do not keep it alive', async () => {
    const mock = makeMockPipeline();
    Host.setLoadPipeline(mock.loadPipeline);
    sentMessages.length = 0;

    await Host.handleMessage({ op: 'embedText', text: 'x', kind: 'passage' });
    assert.equal(Host.getState(), 'ready');

    // Poll status repeatedly through the idle window — the probe must not be
    // a keep-alive, or background's close decision would livelock.
    for (let i = 0; i < 5; i++) {
        await sleep(20);
        await Host.handleMessage({ op: 'status' });
    }

    await sleep(40);
    assert.equal(Host.getState(), 'unloaded');
    assert.equal(mock.disposes, 1);
    const notify = sentMessages.find(m => m.action === 'csEmbeddingsIdleUnloaded');
    assert.ok(notify, 'background notified after idle dispose');
    assert.equal(notify.reason, 'idle');
});

test('jobs arriving mid-dispose are queued and re-enter loading after dispose settles', async () => {
    const mock = makeMockPipeline({ disposeDelay: 50 });
    Host.setLoadPipeline(mock.loadPipeline);

    await Host.handleMessage({ op: 'warmup' });
    assert.equal(Host.getState(), 'ready');

    const unloadPromise = Host.handleMessage({ op: 'unload' });
    await sleep(10);
    assert.equal(Host.getState(), 'disposing');

    const midDispose = Host.handleMessage({ op: 'embedText', text: 'late arrival', kind: 'passage' });
    await unloadPromise;
    const response = await midDispose;
    assert.equal(response.success, true);
    assert.equal(response.vector.length, 4);
    assert.equal(Host.getState(), 'ready');
    assert.equal(mock.loads, 2, 'pipeline reloaded for the mid-dispose job');
    await Host.handleMessage({ op: 'unload' });
});

test('load failure rejects the queue; a later job retries fresh', async () => {
    let shouldFail = true;
    const mock = makeMockPipeline();
    Host.setLoadPipeline(async () => {
        if (shouldFail) throw new Error('model dir missing');
        return mock.loadPipeline();
    });

    const first = Host.handleMessage({ op: 'embedText', text: 'a', kind: 'passage' });
    const second = Host.handleMessage({ op: 'embedText', text: 'b', kind: 'passage' });
    const r1 = await first;
    const r2 = await second;
    assert.equal(r1.success, false);
    assert.equal(r2.success, false, 'queued job fails fast with the load error');
    assert.equal(Host.getState(), 'unloaded');

    const status = await Host.handleMessage({ op: 'status' });
    assert.match(String(status.lastError), /model dir missing/);

    shouldFail = false;
    const retry = await Host.handleMessage({ op: 'embedText', text: 'c', kind: 'passage' });
    assert.equal(retry.success, true);
    await Host.handleMessage({ op: 'unload' });
});

test('unload with no pipeline loaded is a safe no-op', async () => {
    const response = await Host.handleMessage({ op: 'unload' });
    assert.equal(response.success, true);
    assert.equal(Host.getState(), 'unloaded');
});

test('loadPipeline enables local models — the web build defaults it to false', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/offscreen/embeddings-host.js', import.meta.url), 'utf8');
    // transformers.js sets allowLocalModels=false in the WEB build (true only
    // in Node). Setting allowRemoteModels=false without this leaves both
    // sources disabled and pipeline() throws — verified in a real browser.
    assert.match(src, /env\.allowLocalModels\s*=\s*true/);
    assert.match(src, /env\.allowRemoteModels\s*=\s*false/);
    // Model is bundled; caching it again just duplicates 34MB.
    assert.match(src, /env\.useBrowserCache\s*=\s*false/);
});
