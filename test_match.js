
function escapeRegex(s) {
    // Double escaping for write_to_file: \\\\ becomes \\ in file
    return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}

function globToRegExp(glob) {
    const escaped = escapeRegex(glob).replace(/\\\*/g, '.*');
    return new RegExp('^' + escaped + '$');
}

function patternMatchesHost(pattern, host) {
    if (!pattern || !host) return false;
    pattern = pattern.toLowerCase();
    host = host.toLowerCase();
    if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host.endsWith('.' + base);
    }
    return host === pattern;
}

function patternMatchesUrl(pattern, host, pathname) {
    if (!pattern || !host) return false;
    const slashIdx = pattern.indexOf('/');
    const hostPattern = slashIdx >= 0 ? pattern.slice(0, slashIdx) : pattern;
    let pathPattern = slashIdx >= 0 ? pattern.slice(slashIdx) : null; // includes leading '/'
    if (!patternMatchesHost(hostPattern, host)) return false;
    if (!pathPattern) return true;

    // Implicit wildcard: if no wildcard, treat as prefix match
    if (!pathPattern.includes('*')) {
        pathPattern += '*';
    }

    const path = pathname || '/';
    if (pathPattern.includes('*')) {
        return globToRegExp(pathPattern).test(path);
    }
    return path === pathPattern;
}

// Tests
const tests = [
    { pattern: 'example.com/foo', host: 'example.com', path: '/foo', expected: true },
    { pattern: 'example.com/foo', host: 'example.com', path: '/foo/bar', expected: true }, // Should pass with fix
    { pattern: 'example.com/foo*', host: 'example.com', path: '/foo/bar', expected: true },
];

let failed = false;
tests.forEach((t, i) => {
    const result = patternMatchesUrl(t.pattern, t.host, t.path);
    if (result !== t.expected) {
        console.error(`Test ${i} failed: pattern="${t.pattern}" url="${t.host}${t.path}" expected=${t.expected} got=${result}`);
        failed = true;
    } else {
        console.log(`Test ${i} passed`);
    }
});

if (failed) process.exit(1);
