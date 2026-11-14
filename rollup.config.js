import path from 'path'
import { fileURLToPath } from 'url'
import alias from '@rollup/plugin-alias'
import resolve from '@rollup/plugin-node-resolve'
import commonJS from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import babel from '@rollup/plugin-babel'
import typescript from '@rollup/plugin-typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensions = ['.mjs', '.js', '.ts', '.json']

export default {
  input: './src/main.ts',
  external: ['nakama-runtime'],
  plugins: [
    alias({
      entries: [
        { find: '@shared', replacement: path.join(__dirname, 'src/shared') },
        { find: '@lib', replacement: path.join(__dirname, 'src/lib') },
        { find: '@rpc', replacement: path.join(__dirname, 'src/rpc') },
      ],
    }),
    resolve({ extensions }),
    typescript(),
    json(),
    commonJS({ extensions }),
    babel({ extensions, babelHelpers: 'bundled' }),
  ],
  output: {
    file: 'build/main.js',
  },
}
