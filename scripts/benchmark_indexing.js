/**
 * Benchmark simulator for Canvas API Indexing
 * Compares sequential layout (baseline) vs bounded concurrent layout (optimized).
 */

const NUM_COURSES = 12;
const ENDPOINT_LATENCY_MS = {
    assignments: 120,
    pages: 150,
    quizzes: 100,
    discussions: 90,
    folders: 200, // Heavy
    files: 300,   // Heavy
    modules: 250, // Heavy
    media: 200    // Heavy
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Simulated fetch
async function mockFetch(endpointName) {
    const latency = ENDPOINT_LATENCY_MS[endpointName] || 100;
    // adding jitter
    const jitter = Math.random() * 40 - 20;
    await sleep(latency + jitter);
    return [{ id: Math.random() }];
}

// ============================================
// BASELINE (Sequential)
// ============================================

async function runBaseline() {
    console.log('--- Running Baseline ---');
    let totalItems = 0;
    const start = performance.now();

    for (let i = 0; i < NUM_COURSES; i++) {
        totalItems += (await mockFetch('assignments')).length;
        totalItems += (await mockFetch('folders')).length;
        totalItems += (await mockFetch('files')).length;
        totalItems += (await mockFetch('pages')).length;
        totalItems += (await mockFetch('modules')).length;
        totalItems += (await mockFetch('quizzes')).length;
        totalItems += (await mockFetch('discussions')).length;
        totalItems += (await mockFetch('media')).length;

        await sleep(50); // Original fixed sleep
    }

    const duration = performance.now() - start;
    return { duration, totalItems };
}

// ============================================
// OPTIMIZED (Concurrent Two-Phase)
// ============================================

async function fetchFastEndpoints(courseId) {
    const results = await Promise.allSettled([
        mockFetch('assignments'),
        mockFetch('pages'),
        mockFetch('quizzes'),
        mockFetch('discussions')
    ]);
    return results.filter(r => r.status === 'fulfilled').map(r => r.value).flat();
}

async function fetchHeavyEndpoints(courseId) {
    const results = await Promise.allSettled([
        mockFetch('folders').then(() => mockFetch('files')), // files depend on folders
        mockFetch('modules'),
        mockFetch('media')
    ]);
    return results.filter(r => r.status === 'fulfilled').map(r => r.value).flat();
}

async function runOptimized() {
    console.log('--- Running Optimized ---');
    const start = performance.now();
    let totalItems = 0;
    const SCAN_COURSE_CONCURRENCY = 3;

    // Simulate course list
    const courses = Array.from({ length: NUM_COURSES }, (_, i) => ({ id: i }));

    // Helper: promise pool
    async function processPool(tasks, concurrency) {
        const results = [];
        const pool = new Set();
        for (const task of tasks) {
            const p = task().then(res => {
                pool.delete(p);
                return res;
            });
            pool.add(p);
            results.push(p);
            if (pool.size >= concurrency) {
                await Promise.race(pool);
            }
        }
        return Promise.all(results);
    }

    // Phase 1: Fast Pass
    const fastStart = performance.now();
    const fastTasks = courses.map(c => () => fetchFastEndpoints(c.id));
    const fastResults = await processPool(fastTasks, SCAN_COURSE_CONCURRENCY);
    totalItems += fastResults.flat().length;
    const fastDuration = performance.now() - fastStart;

    // Phase 2: Deep Pass
    const deepStart = performance.now();
    const deepTasks = courses.map(c => () => fetchHeavyEndpoints(c.id));
    const deepResults = await processPool(deepTasks, SCAN_COURSE_CONCURRENCY);
    totalItems += deepResults.flat().length;
    const deepDuration = performance.now() - deepStart;

    const duration = performance.now() - start;
    return { duration, fastDuration, deepDuration, totalItems };
}

// ============================================
// MAIN
// ============================================

async function main() {
    const baseline = await runBaseline();
    const optimized = await runOptimized();

    console.log('\\n=== Benchmark Results ===');
    console.table({
        'Baseline (Sequential)': {
            'Total Time (ms)': Math.round(baseline.duration),
            'Fast Pass (ms)': 'N/A',
            'Deep Pass (ms)': 'N/A',
            'Speedup': '1.0x',
            'Items': baseline.totalItems
        },
        'Optimized (Concurrent)': {
            'Total Time (ms)': Math.round(optimized.duration),
            'Fast Pass (ms)': Math.round(optimized.fastDuration),
            'Deep Pass (ms)': Math.round(optimized.deepDuration),
            'Speedup': `${(baseline.duration / optimized.duration).toFixed(2)}x`,
            'Items': optimized.totalItems
        }
    });

    console.log('\\nAcceptance Criteria Validations:');
    console.log(`- Time to first searchable index: ${Math.round(optimized.fastDuration)}ms (vs ${Math.round(baseline.duration)}ms previously)`);
}

main().catch(console.error);
