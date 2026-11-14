// Общая логика с прототипом: копирует CTG-Proto/src/core и src/data в src/shared.
// Сервер исполняет тот же код, что и клиент, — правила не пишутся второй раз.
//   node scripts/sync-core.mjs [путь к CTG-Proto]           — скопировать
//   node scripts/sync-core.mjs --check [путь к CTG-Proto]   — только проверить расхождение (код выхода 1)
// src/shared руками не правится: изменения — в прототипе, потом sync.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const check = args.includes('--check')
const proto = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? path.join(root, '..', 'CTG-Proto'))
const dest = path.join(root, 'src', 'shared')

const SKIP = [/__tests__/, /README\.md$/, /core[\\/]save\.ts$/]
const DIRS = ['core', 'data']

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (SKIP.some((re) => re.test(full))) return []
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

const normalize = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n')
const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex')

if (!fs.existsSync(path.join(proto, 'src', 'core'))) {
  console.error(`Не найден прототип: ${proto}`)
  process.exit(2)
}

const source = new Map()
for (const dir of DIRS) {
  for (const rel of listFiles(path.join(proto, 'src', dir))) {
    source.set(`${dir}/${rel}`, normalize(fs.readFileSync(path.join(proto, 'src', dir, rel))))
  }
}
const protoVersion = JSON.parse(fs.readFileSync(path.join(proto, 'package.json'), 'utf8')).version
const digest = hashOf([...source.entries()].sort().map(([rel, text]) => `${rel}:${hashOf(text)}`).join('\n')).slice(0, 12)
source.set('version.json', `${JSON.stringify({ proto: protoVersion, digest }, null, 2)}\n`)

const existing = new Set(DIRS.flatMap((dir) => listFiles(path.join(dest, dir)).map((rel) => `${dir}/${rel}`)))
if (fs.existsSync(path.join(dest, 'version.json'))) existing.add('version.json')

const changed = [...source.keys()].filter(
  (rel) => !existing.has(rel) || normalize(fs.readFileSync(path.join(dest, rel))) !== source.get(rel),
)
const extra = [...existing].filter((rel) => !source.has(rel))

if (check) {
  if (changed.length || extra.length) {
    console.error(`src/shared расходится с прототипом ${protoVersion}:`)
    for (const rel of changed) console.error(`  изменён или отсутствует: ${rel}`)
    for (const rel of extra) console.error(`  лишний: ${rel}`)
    console.error('Запусти: npm run sync-core')
    process.exit(1)
  }
  console.log(`src/shared совпадает с прототипом ${protoVersion} (${digest})`)
  process.exit(0)
}

for (const rel of changed) {
  const target = path.join(dest, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, source.get(rel))
}
for (const rel of extra) fs.rmSync(path.join(dest, rel))
console.log(`Прототип ${protoVersion} (${digest}): обновлено ${changed.length}, удалено ${extra.length}, всего ${source.size}`)
