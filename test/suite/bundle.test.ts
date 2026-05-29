/**
 * Smoke tests for the webpack-bundled extension (dist/extension.js).
 *
 * These catch issues that ONLY manifest after bundling. The most common one:
 * a module uses __dirname to locate sibling files. If webpack inlines such a
 * module, __dirname at runtime becomes the bundle output directory (dist/),
 * not the module's own directory — and file lookups silently break.
 *
 * Such modules MUST be marked as externals in webpack.config.js.
 *
 * Categories covered:
 *  - bundle artifact exists and looks reasonable
 *  - modules that rely on __dirname (7zip-bin) are NOT inlined
 *  - declared externals in webpack.config.js
 *  - paths returned by externalized modules resolve to real files
 *  - native binaries have execute permission
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.join(__dirname, '../..');
const DIST_BUNDLE = path.join(PROJECT_ROOT, 'dist/extension.js');
const WEBPACK_CONFIG = path.join(PROJECT_ROOT, 'webpack.config.js');

describe('Bundle: artifact', () => {
    it('dist/extension.js exists (run `npm run compile` first)', () => {
        assert.ok(fs.existsSync(DIST_BUNDLE), `missing: ${DIST_BUNDLE}`);
    });

    it('dist/extension.js is a non-trivial file', () => {
        const stats = fs.statSync(DIST_BUNDLE);
        assert.ok(stats.size > 10_000, `bundle suspiciously small: ${stats.size} bytes`);
    });
});

describe('Bundle: modules with __dirname dependencies must be external', () => {
    let bundle: string;
    before(() => { bundle = fs.readFileSync(DIST_BUNDLE, 'utf8'); });

    it('7zip-bin is NOT inlined into the bundle', () => {
        // 7zip-bin's getPath() reads process.env.USE_SYSTEM_7ZA. If the module
        // is bundled, this distinctive string will appear in dist/extension.js.
        assert.ok(
            !bundle.includes('USE_SYSTEM_7ZA'),
            '7zip-bin appears inlined in the bundle. ' +
            'It uses __dirname and must be added to webpack externals — otherwise ' +
            'path7za points to dist/mac/<arch>/7za, which does not exist at runtime.'
        );
    });
});

describe('Bundle: webpack externals declarations', () => {
    let config: string;
    before(() => { config = fs.readFileSync(WEBPACK_CONFIG, 'utf8'); });

    function declaresExternal(name: string): boolean {
        // Match e.g. vscode: 'commonjs vscode' (bare key) or 'name': 'commonjs name' (quoted)
        const escaped = name.replace(/[/\\]/g, '\\$&');
        const re = new RegExp(`['"\`]?${escaped}['"\`]?\\s*:\\s*['"\`]commonjs ${escaped}['"\`]`);
        return re.test(config);
    }

    it('vscode is external (required: VS Code API is provided by host)', () => {
        assert.ok(declaresExternal('vscode'));
    });

    it('7zip-bin is external (uses __dirname for binary path)', () => {
        assert.ok(declaresExternal('7zip-bin'),
            'add "7zip-bin": "commonjs 7zip-bin" to webpack.config.js externals');
    });

    it('lzma-native is external (native binding)', () => {
        assert.ok(declaresExternal('lzma-native'));
    });

    it('@mongodb-js/zstd is external (native binding)', () => {
        assert.ok(declaresExternal('@mongodb-js/zstd'));
    });
});

describe('Bundle: externalized modules resolve correctly at runtime', () => {
    it('require("7zip-bin").path7za points to an existing file', () => {
        // Re-require to bypass any stale cache from earlier tests.
        delete require.cache[require.resolve('7zip-bin')];
        const { path7za } = require('7zip-bin');
        assert.ok(typeof path7za === 'string' && path7za.length > 0, 'path7za must be a non-empty string');
        assert.ok(fs.existsSync(path7za), `7z binary not found at: ${path7za}`);
    });

    it('the 7z binary for the current arch has execute permission', () => {
        const { path7za } = require('7zip-bin');
        // accessSync throws if the file is not executable
        fs.accessSync(path7za, fs.constants.X_OK);
    });

    it('require("lzma-native") loads without throwing', () => {
        assert.doesNotThrow(() => require('lzma-native'));
    });

    it('require("@mongodb-js/zstd") loads without throwing', () => {
        assert.doesNotThrow(() => require('@mongodb-js/zstd'));
    });
});

describe('Bundle: all platform 7z binaries shipped in node_modules', () => {
    // These are the platforms the extension currently lists as supported.
    // If a binary is missing, the .vsix may still package but fail on that OS.
    const required: Array<{ os: string; arch: string; file: string }> = [
        { os: 'mac',   arch: 'arm64', file: '7za' },
        { os: 'mac',   arch: 'x64',   file: '7za' },
        { os: 'linux', arch: 'arm64', file: '7za' },
        { os: 'linux', arch: 'x64',   file: '7za' },
        { os: 'win',   arch: 'x64',   file: '7za.exe' },
    ];

    for (const { os, arch, file } of required) {
        it(`${os}/${arch}/${file} is present in node_modules/7zip-bin`, () => {
            const p = path.join(PROJECT_ROOT, 'node_modules/7zip-bin', os, arch, file);
            assert.ok(fs.existsSync(p), `missing: ${p}`);
        });

        if (os !== 'win') {
            it(`${os}/${arch}/${file} is executable in node_modules/7zip-bin`, () => {
                const p = path.join(PROJECT_ROOT, 'node_modules/7zip-bin', os, arch, file);
                fs.accessSync(p, fs.constants.X_OK);
            });
        }
    }
});
