import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('docs/specs/rt-tools.schema.json', 'utf8'))
const d = j.$defs
for (const k of ['anchorKind', 'kinds', 'id', 'sha256', 'path', 'root', 'text', 'strings', 'errorCode', 'routeStatus', 'outcome']) {
  if (!d[k]) { console.log('MISSING', k); continue }
  console.log(`=== ${k} ===`)
  console.log(JSON.stringify(d[k]))
}
