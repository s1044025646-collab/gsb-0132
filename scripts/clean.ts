import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

for (const dir of ['data', 'tmp']) {
  rmSync(resolve(dir), { recursive: true, force: true })
}
console.log('removed project-local data/ and tmp/')
