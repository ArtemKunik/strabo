import fs from 'node:fs';

// The HTML reporter and screenshot step write here, so make sure it exists before the
// runner opens its output stream.
fs.mkdirSync('test/acceptance/reports/screenshots', { recursive: true });
fs.mkdirSync('test/acceptance/reports/cache', { recursive: true });
