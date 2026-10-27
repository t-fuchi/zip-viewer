const path = require('path');
const fs = require('fs');

// Copy pdf.js runtime files into media/ so the PDF preview webview can load them.
(function copyPdfjs() {
    const src = path.resolve(__dirname, 'node_modules/pdfjs-dist');
    const dest = path.resolve(__dirname, 'media');
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
        fs.copyFileSync(path.join(src, 'build', f), path.join(dest, f));
    }
    for (const d of ['cmaps', 'standard_fonts']) {
        fs.cpSync(path.join(src, d), path.join(dest, d), { recursive: true });
    }
})();

module.exports = {
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2'
    },
    externals: {
        vscode: 'commonjs vscode',
        '@mongodb-js/zstd': 'commonjs @mongodb-js/zstd',
        'lzma-native': 'commonjs lzma-native',
        '7zip-bin': 'commonjs 7zip-bin',
        // Keep these out of the bundle so the cold-start parse is small.
        // They are require()'d lazily on first use only.
        'tar': 'commonjs tar',
        'node-7z': 'commonjs node-7z',
        'unbzip2-stream': 'commonjs unbzip2-stream',
        'unzipper': 'commonjs unzipper',
        'mammoth': 'commonjs mammoth',
        'jszip': 'commonjs jszip'
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader'
                    }
                ]
            }
        ]
    },
    devtool: 'nosources-source-map',
    infrastructureLogging: {
        level: "log"
    }
};
