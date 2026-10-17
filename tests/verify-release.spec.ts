/**
 * `scripts/verify-release.mjs` 必须证明两件事，而这两件事互相独立：
 *
 *  1. **能通过**——在真实已发布版本上给出「一致」的结论。
 *  2. **会失败**——发布包与 tag 内容不同时，它必须报红并以退出码 1 结束。
 *
 * 只测 (1) 的核验脚本比没有更糟：它会把「我没查出来」显示成「一切都对」。
 * 本文件的存在理由就是把 (2) 钉住。
 *
 * WHY A CHILD PROCESS AND PATH SHIMS：脚本的核心输入是 **registry 上的 tarball**，
 * 而单元测试绝不能依赖真实 npm（慢、需要网络、且已发布版本是不可变的历史——
 * 不能用它来构造「内容不一致」这个用例）。所以这里用 PATH 上的假 `npm`/`tar`
 * 提供一份**受控的**发布包，让脚本真实跑完它的启动、解析与比对路径。
 *
 * 这一点很关键：脚本的比对逻辑如果只对着 mock 断言内部函数，那么「读文件时
 * 用 UTF-8 解码二进制」这类 bug 依然会漏（本脚本的第一版就踩了——PNG 被当文本
 * 读，三个图片文件全部误报不一致）。只有端到端跑真实字节流才能抓到它。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

interface ScriptRun { code: number, stdout: string, stderr: string }

/** Execute a copy of the real script inside a throwaway repo fixture. */
async function runScript(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<ScriptRun> {
  const child = spawn(process.execPath, [join(root, 'scripts', 'verify-release.mjs'), ...args], {
    cwd: root,
    // `stdio: ['ignore', 'pipe', 'pipe']` is explicit because the default
    // `'pipe'` for all three makes the overload's type collapse to `never`.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
  const code = await new Promise<number>(resolve => child.on('close', (value: number | null) => { resolve(value ?? -1) }))
  return { code, stdout, stderr }
}

/**
 * Build a fixture repo with a real git tag, plus PATH shims that serve a
 * caller-supplied package tree as if it came from the registry.
 *
 * The shims are the whole trick: `--skip-npm` would bypass the comparison this
 * test exists to exercise, so the registry side must be faked rather than
 * skipped.
 */
async function fixtureRepo(
  files: Record<string, string | Buffer>,
  packaged: Record<string, string | Buffer>,
  options: { postTagFiles?: Record<string, string | Buffer> } = {},
): Promise<{ root: string, env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'trae-verify-release-')); cleanup.push(root)
  await mkdir(join(root, 'scripts'), { recursive: true })

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  // The script under test, copied verbatim.
  const scriptUrl = new URL('../scripts/verify-release.mjs', import.meta.url)
  await writeFile(join(root, 'scripts', 'verify-release.mjs'), await readFile(fileURLToPath(scriptUrl), 'utf8'))

  // package.json is what the script reads for the default version.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-connect-trae', version: '9.9.9', scripts: { build: 'true' } }, null, 2))

  // git repo + tag. Committing every fixture file keeps `git show <tag>:<path>`
  // meaningful, which is the baseline the script compares against.
  const git = async (args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: 'ignore' })
    child.on('close', code => { code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`)) })
  })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'fixture@example.test'])
  await git(['config', 'user.name', 'fixture'])
  await git(['add', '-A'])
  await git(['commit', '-qm', 'fixture'])
  await git(['tag', '-a', 'v9.9.9', '-m', 'v9.9.9'])

  // Commits AFTER the tag are the normal case for post-release docs/CI fixes.
  if (options.postTagFiles !== undefined) {
    for (const [path, content] of Object.entries(options.postTagFiles)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await git(['add', '-A'])
    await git(['commit', '-qm', 'post-tag'])
  }

  // The "published" tree, served by the shims below.
  const servedRoot = join(root, '.served')
  for (const [path, content] of Object.entries(packaged)) {
    await mkdir(join(servedRoot, path, '..'), { recursive: true })
    await writeFile(join(servedRoot, path), content)
  }

  const shimDir = join(root, '.shim')
  await mkdir(shimDir, { recursive: true })

  // `versions` / `dist-tags.latest` are answered locally, `pack` materialises
  // the served tree, and `run build` is a no-op.
  //
  // `run build` MUST NOT fall through to the real npm: the fixture lives in a
  // temp directory with no node_modules, so a real build either fails slowly or
  // hangs (measured: a 120s timeout before this shim existed). The build step
  // is exercised by the real-repo run documented in RELEASING.md, not here.
  const npmShim = [
    '#!/bin/bash',
    'if [ "$1" = "view" ]; then',
    '  if [ "$3" = "versions" ]; then echo \'["9.9.9"]\'; exit 0; fi',
    '  if [ "$3" = "dist-tags.latest" ]; then echo "9.9.9"; exit 0; fi',
    'fi',
    'if [ "$1" = "pack" ]; then mkdir -p package; cp -R "$SERVED"/* package/ 2>/dev/null; touch dsh-connect-trae-9.9.9.tgz; exit 0; fi',
    'if [ "$1" = "run" ]; then exit 0; fi',
    'exit 0',
  ].join('\n')
  const tarShim = [
    '#!/bin/bash',
    // `-tzf` lists the served tree with the `package/` prefix; extraction is a
    // no-op because `pack` already materialised it in place.
    'if [ "$1" = "-tzf" ]; then cd "$SERVED" && find . -type f | sed "s|^\\./|package/|"; exit 0; fi',
    'exit 0',
  ].join('\n')
  await writeFile(join(shimDir, 'npm'), npmShim)
  await writeFile(join(shimDir, 'tar'), tarShim)
  await chmod(join(shimDir, 'npm'), 0o755)
  await chmod(join(shimDir, 'tar'), 0o755)

  return { root, env: { PATH: `${shimDir}:${process.env.PATH ?? ''}`, SERVED: servedRoot } }
}

describe('verify-release: a matching release passes', () => {
  it('reports every file consistent and exits 0', async () => {
    const text = '# fixture\n'
    const { root, env } = await fixtureRepo(
      { 'README.md': text, 'icons/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]) },
      { 'README.md': text, 'icons/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]) },
    )
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('核验通过')
    expect(result.code).toBe(0)
  })

  it('compares BINARY package files byte-for-byte', async () => {
    // The regression this pins: decoding `git show` output as UTF-8 turned every
    // PNG into U+FFFD and reported a false mismatch. Non-UTF-8 bytes are the
    // only way to make that mistake visible.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])
    const { root, env } = await fixtureRepo({ 'icons/logo.png': binary }, { 'icons/logo.png': binary })
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('发布包文件 icons/logo.png：与 tag 一致')
    expect(result.code).toBe(0)
  })
})

describe('verify-release: a mismatched release fails', () => {
  it('flags a tampered shipped file and exits 1', async () => {
    const { root, env } = await fixtureRepo(
      { 'README.md': '# original\n' },
      // Same file NAME, different bytes: exactly the "published from a dirty
      // work tree" failure RELEASING.md warns about.
      { 'README.md': '# original\nTAMPERED\n' },
    )
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('与 tag 内容不同')
    expect(result.stdout).toContain('核验失败')
    expect(result.code).toBe(1)
  })

  it('fails when the package ships a file the tag does not have', async () => {
    // A file present only in the package cannot be traced to any commit. The
    // script must name it rather than pass over a path it cannot resolve.
    const { root, env } = await fixtureRepo(
      { 'README.md': '# ok\n' },
      { 'README.md': '# ok\n', 'extra.txt': 'smuggled\n' },
    )
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('extra.txt')
    expect(result.code).toBe(1)
  })
})

describe('verify-release: preconditions are distinguished from verdicts', () => {
  it('exits 2 when the tag does not exist', async () => {
    const { root, env } = await fixtureRepo({ 'README.md': '# ok\n' }, { 'README.md': '# ok\n' })
    const result = await runScript(root, ['1.2.3'], env)
    expect(result.stdout).toContain('找不到 tag v1.2.3')
    // 2 means "could not start", which must never be confused with "found a
    // mismatch" (1) or "all clear" (0).
    expect(result.code).toBe(2)
  })

  it('still passes when commits land AFTER the tag', async () => {
    // RELEASING.md: post-release docs/CI fixes do not move an already-pushed
    // tag. An earlier version of this script required `tag == HEAD` and failed
    // here — a false alarm that would have sent someone hunting for a
    // corruption that does not exist. A non-shipped file (RELEASING.md itself)
    // is the realistic shape of such a commit.
    const text = '# ok\n'
    const { root, env } = await fixtureRepo(
      { 'README.md': text },
      { 'README.md': text },
      { postTagFiles: { 'RELEASING.md': '# release flow\n' } },
    )
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('核验通过')
    expect(result.code).toBe(0)
  })

  it('exits 2 when the version is not on the registry', async () => {
    const { root, env } = await fixtureRepo({ 'README.md': '# ok\n' }, { 'README.md': '# ok\n' })
    // The shim serves only 9.9.9, so any other version is unpublished.
    const shimDir = join(root, '.shim')
    await writeFile(join(shimDir, 'npm'), [
      '#!/bin/bash',
      'if [ "$1" = "view" ] && [ "$3" = "versions" ]; then echo \'["9.9.8"]\'; exit 0; fi',
      'if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then echo "9.9.8"; exit 0; fi',
      'exit 0',
    ].join('\n'))
    await chmod(join(shimDir, 'npm'), 0o755)
    const result = await runScript(root, [], env)
    expect(result.stdout).toContain('registry 上没有 9.9.9')
    expect(result.code).toBe(2)
  })
})
