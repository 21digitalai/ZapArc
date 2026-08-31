const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  
  return {
    entry: {
      background: './src/background/background.ts',
      content: './src/content/content.ts',
      popup: './src/popup/popup.ts',
      settings: './src/settings/settings.ts'
    },
    
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },
    
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader']
        }
      ]
    },
    
    plugins: [
      new webpack.ProvidePlugin({
        Buffer: ['buffer', 'Buffer'],
        process: 'process/browser'
      }),

      new MiniCssExtractPlugin({
        filename: '[name].css'
      }),

      new HtmlWebpackPlugin({
        template: './src/popup/popup.html',
        filename: 'popup.html',
        chunks: ['popup']
      }),

      new HtmlWebpackPlugin({
        template: './src/settings/settings.html',
        filename: 'settings.html',
        chunks: ['settings']
      }),

      new HtmlWebpackPlugin({
        template: './src/legal/terms.html',
        filename: 'terms.html',
        chunks: []
      }),

      new CopyWebpackPlugin({
        patterns: [
          {
            from: 'manifest.json',
            to: 'manifest.json'
          },
          {
            from: 'assets/icons',
            to: 'icons',
            noErrorOnMissing: true
          },
          {
            from: 'src/legal/terms.css',
            to: 'terms.css'
          }
        ]
      })
    ],
    
    devtool: isProduction ? false : 'cheap-module-source-map',
    
    optimization: {
      minimize: isProduction
    },
    
    experiments: {
      asyncWebAssembly: true,
      topLevelAwait: true
    },
    
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.wasm'],
      fallback: {
        "crypto": require.resolve("crypto-browserify"),
        "stream": require.resolve("stream-browserify"),
        "buffer": require.resolve("buffer/"),
        "process": require.resolve("process/browser")
      }
    }
  };
};
