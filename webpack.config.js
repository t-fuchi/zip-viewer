const path = require('path');

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
        'unzipper': 'commonjs unzipper'
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
