import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('docs/specs/rt-tools.schema.json', 'utf8'))
const d = j.$defs
for (const k of ['rosterInput', 'rosterData', 'post', 'result', 'failureData', 'diagnostic', 'capacity']) {
  if (!d[k]) { console.log('MISSING', k); continue }
  console.log(`=== ${k} ===`)
  console.log(JSON.stringify(d[k], null, 2))
}
console.log('=== top-level tools ===')
console.log(JSON.stringify(Object.keys(j), null, 2))
