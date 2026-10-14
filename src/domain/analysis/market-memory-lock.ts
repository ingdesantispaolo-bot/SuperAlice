import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, open, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const ownerSchema = z.object({ owner: z.string().uuid(), pid: z.number().int().positive(), machine: z.string().min(1), at: z.string() }).strict()
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const newOwner = () => ({ owner: randomUUID(), pid: process.pid, machine: hostname(), at: new Date().toISOString() })
function requireDead(owner: z.infer<typeof ownerSchema>) {
  if (owner.machine !== hostname()) throw new Error('Memory lock belongs to another or unknown machine')
  try { process.kill(owner.pid, 0); throw new Error('Memory lock owner is still alive; refusing recovery') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}
async function guard(root: string) {
  const path = join(root, '.lock-control'), owner = newOwner()
  await mkdir(path)
  await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { flag: 'wx' })
  return async () => {
    const current = ownerSchema.parse(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')))
    if (current.owner !== owner.owner) throw new Error('Memory lock control owner changed')
    await unlink(join(path, 'owner.json')); await rmdir(path)
  }
}
export async function acquireMemoryLock(root: string, kind: 'writer' | 'index') {
  const unlock = await guard(root), path = join(root, `.${kind}.lock`)
  const owner = newOwner()
  try {
    const file = await open(path, 'wx')
    try { await file.writeFile(JSON.stringify(owner)) } finally { await file.close() }
  } finally { await unlock() }
  return { owner: owner.owner, release: async () => {
    const current = ownerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (current.owner !== owner.owner) throw new Error('Memory lock owner changed')
    await unlink(path)
  } }
}
/** Operator recovery only. An age, an inaccessible PID or an unknown machine is never sufficient. */
export async function recoverMemoryLock(root: string, kind: 'writer' | 'index' | 'control') {
  if (kind === 'control') {
    const dir = join(root, '.lock-control')
    let info
    try { info = await lstat(dir) } catch (e) { if (missing(e)) return { recovered: false, reason: 'No lock' }; throw e }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe or unknown memory lock control')
    const path = join(dir, 'owner.json')
    const ownerInfo = await lstat(path)
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 1024) throw new Error('Unsafe or unknown memory lock control owner')
    const owner = ownerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    requireDead(owner)
    // The existing directory blocks new normal acquisitions. Only one recovery
    // can claim it; unknown/interrupted recovery claims require operator review.
    const claim = join(dir, 'recovery.json'), file = await open(claim, 'wx')
    try { await file.writeFile(JSON.stringify(newOwner())) } finally { await file.close() }
    try {
      const current = ownerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (current.owner !== owner.owner) throw new Error('Memory lock control owner changed')
      requireDead(current)
      await unlink(path)
    } finally { await unlink(claim) }
    await rmdir(dir)
    return { recovered: true, kind, previousOwner: owner.owner, previousPid: owner.pid }
  }
  const unlock = await guard(root), path = join(root, `.${kind}.lock`)
  try {
    let info
    try { info = await lstat(path) } catch (error) { if (missing(error)) return { recovered: false, reason: 'No lock' }; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Unsafe or unknown memory lock')
    const owner = ownerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    requireDead(owner)
    await unlink(path)
    return { recovered: true, kind, previousOwner: owner.owner, previousPid: owner.pid }
  } finally { await unlock() }
}
