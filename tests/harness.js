const tests = [];
let failed = 0;

export function test(name, fn) {
    tests.push({name, fn});
}

export function assertEqual(actual, expected, label = 'values') {
    if (actual !== expected)
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertDeepEqual(actual, expected, label = 'values') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${label}: expected ${b}, got ${a}`);
}

export function assertThrows(fn, label = 'throws') {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error(`${label}: expected an exception`);
}

export async function run() {
    for (const {name, fn} of tests) {
        try {
            await fn();
            console.log(`ok ${name}`);
        } catch (error) {
            failed++;
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failed > 0) {
        console.error(`${failed} test(s) failed`);
        throw new Error(`${failed} test(s) failed`);
    }
    console.log(`${tests.length} test(s) passed`);
}
