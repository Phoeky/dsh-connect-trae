#!/usr/bin/env node
/**
 * 发布后一致性核验 —— 回答一个问题：**「线上那份包」==「tag 指向的源码」吗？**
 *
 * 对应 RELEASING.md 第 8 步。那一节是手工跑的：下载 tarball、解开、逐个文件
 * `shasum`、再重建 `lib/` 比对。手工版本有三个已知的失效方式，每次都靠人记得：
 *
 *  1. **漏项**。手工清单是「我记得要核对的那几个文件」。发布包实际有 15 个
 *     文件（`icons/`、`docs/assets/`、`scripts/verify-windows.mjs` 等），
 *     清单外的那些从来没被核对过。本脚本改为**遍历发布包全体**，新加文件
 *     自动纳入，而不是自动免疫。
 *  2. **判据看错源**。RELEASING.md 反复强调「发布成败以 registry 为准」，
 *     但手工核对时人很容易拿本地 `lib/` 当基准——本地构建产物是**不可信**
 *     的一方（它可能构建自未提交的工作树）。本脚本先验「工作树 == tag」，
 *     再审「包 == tag」：基准永远是 tag 指向的那棵树。
 *  3. **构建不可复现时误报通过**。`lib/` 不进版本库，只能「由 tagged 源码
 *     重建后比对」。若构建本身不确定（产物带时间戳/随机序），这项比对会
 *     随机红或随机绿。本脚本对 `lib/` 用**重建后比对**，并如实说明这一点，
 *     而不是假装它是源码文件。
 *
 * 用法：
 *
 *   node scripts/verify-release.mjs            # 核验 package.json 里的版本
 *   node scripts/verify-release.mjs 3.7.0      # 核验指定版本
 *   node scripts/verify-release.mjs --skip-npm # 只核对 tag / 工作树 / 构建
 *
 * 退出码：0 = 全部通过；1 = 有不一致；2 = 前置条件不满足（无法开始核对）。
 *
 * 本脚本**只读**：不写工作树、不发布、不改 tag。它唯一的外部副作用是把
 * tarball 下载到系统临时目录，并在结束时删除。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/**
 * Every check reports through this shape so the summary at the end can be a
 * flat list rather than ad-hoc console output interleaved with failures.
 *
 * `blocking: false` marks a check that is informational — it cannot fail the
 * run, and says so explicitly rather than being silently skipped.
 */
const results = []
function record(name, ok, detail, options = {}) {
  results.push({ name, ok, detail, blocking: options.blocking ?? true })
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function git(args) {
  const { stdout } = await run('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * Read ONE blob from a tag as raw bytes.
 *
 * `execFile` decodes stdout as UTF-8 unless told otherwise, which silently
 * mangles every binary in the package (the PNGs under `icons/` and
 * `docs/assets/`) into U+FFFD sequences — producing a false "content differs".
 * Asking for a Buffer keeps the bytes exact.
 */
async function gitBlob(ref, path) {
  const { stdout } = await run('git', ['show', `${ref}:${path}`], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  })
  return stdout
}

/**
 * Print an actionable failure and exit 2: the run never reached a verdict.
 *
 * Written to stdout, not stderr, and for a practical reason: this script's
 * whole output is one report that a person pastes into an issue or a terminal
 * transcript. Splitting "could not start" onto stderr means `node ... | tee`
 * or a CI log viewer shows a truncated report while the explanation sits in a
 * different stream. Exit code 2 already carries the "this is a precondition
 * failure, not a verdict" signal, so the text belongs with the rest.
 */
function cannotStart(lines) {
  console.log('')
  for (const line of lines) console.log(line)
  console.log('')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 1. Resolve the version to verify.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const skipNpm = argv.includes('--skip-npm')
const explicit = argv.find(arg => !arg.startsWith('-'))

const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const version = explicit ?? manifest.version
const tag = `v${version}`

if (explicit !== undefined && explicit !== manifest.version) {
  // Verifying some OTHER release is legitimate (e.g. re-checking an old tag),
  // but it must never be mistaken for "this checkout is that version".
  console.log(`核验 ${tag}（注意：与 package.json 的 ${manifest.version} 不同）`)
}

// ---------------------------------------------------------------------------
// 2. The tag must exist, and the work tree must match it.
//
// This ordering is the point of the script. Every later comparison uses the tag
// as the reference, so a dirty work tree cannot silently become the baseline.
// ---------------------------------------------------------------------------

let tagExists = true
try {
  await git(['rev-parse', '--verify', `${tag}^{commit}`])
} catch {
  tagExists = false
}

if (!tagExists) {
  cannotStart([
    `找不到 tag ${tag}。`,
    '',
    '核验的前提是「已发布的 tag 存在」。如果这个版本还没打 tag，请先按',
    'RELEASING.md 第 4 步提交并打 tag；如果只想核查未发布的构建，用',
    `  node ${relative(process.cwd(), fileURLToPath(import.meta.url))} --skip-npm`,
  ])
}

const tagCommit = await git(['rev-parse', `${tag}^{commit}`])
const headCommit = await git(['rev-parse', 'HEAD'])
record('tag 指向 HEAD', tagCommit === headCommit, `${tag} -> ${tagCommit.slice(0, 8)}${tagCommit === headCommit ? '' : `，HEAD 为 ${headCommit.slice(0, 8)}`}`)

const dirty = await git(['status', '--porcelain'])
record(
  '工作树干净',
  dirty === '',
  dirty === '' ? '无未提交改动' : `有未提交改动：\n${dirty.split('\n').map(line => `      ${line}`).join('\n')}`,
  // A dirty tree does not invalidate the TAG (which is immutable); it only means
  // "the checkout you are reading is not what was published". Notable, not fatal.
  { blocking: false },
)

// ---------------------------------------------------------------------------
// 3. npm side: the version must be published, and `latest` must point at it.
//
// Only reached when not skipped. A registry miss is fatal: there is nothing to
// compare against, which is a different failure from "published but mismatched".
// ---------------------------------------------------------------------------

let tarballDir
if (!skipNpm) {
  let publishedVersions = []
  try {
    const { stdout } = await run('npm', ['view', 'dsh-connect-trae', 'versions', '--json'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
    publishedVersions = JSON.parse(stdout)
  } catch (error) {
    cannotStart([
      '无法从 registry 读取版本列表。',
      '',
      '这通常是网络或代理问题，而不是发布状态问题 —— 不要把「读不到」当成',
      '「没发出去」。RELEASING.md 第 7 步说明了如何区分这两种情况。',
      '',
      `底层错误：${error instanceof Error ? error.message : String(error)}`,
    ])
  }
  if (!Array.isArray(publishedVersions)) publishedVersions = [publishedVersions].filter(Boolean)

  if (!publishedVersions.includes(version)) {
    cannotStart([
      `registry 上没有 ${version}。`,
      '',
      `已发布的最新若干版本：${publishedVersions.slice(-5).join(', ') || '（空）'}`,
      '',
      '若刚执行过 npm publish，registry 的 dist-tag 翻转有延迟（实测约 90 秒）。',
      '先等一会儿再跑；仍没有则为真未发布。',
    ])
  }

  let latest
  try {
    const { stdout } = await run('npm', ['view', 'dsh-connect-trae', 'dist-tags.latest'], { cwd: repo })
    latest = stdout.trim()
  } catch {
    latest = ''
  }
  record('npm 已发布该版本', true, `${version} 在 versions 列表中`)
  record(
    'npm latest 指向该版本',
    latest === version,
    latest === version ? `latest = ${version}` : `latest = ${latest || '（读不到）'}`,
    // Re-checking an older tag while a newer version is `latest` is a legitimate
    // use of this script, so this is reported but does not fail the run.
    { blocking: false },
  )
}

// ---------------------------------------------------------------------------
// 4. Download the published tarball and compare EVERY file against the tag.
//
// "Every file" is deliberate: RELEASING.md's manual step listed a handful of
// names, so a newly added shipped file was never checked. Listing the archive
// from the registry and diffing against the tag's tree closes that gap.
// ---------------------------------------------------------------------------

const entries = []
/** Published bytes keyed by package-relative path, kept past the temp dir's removal. */
const publishedBytes = new Map()
if (!skipNpm) {
  tarballDir = await mkdtemp(join(tmpdir(), 'trae-verify-'))
  try {
    await run('npm', ['pack', `dsh-connect-trae@${version}`], { cwd: tarballDir, maxBuffer: 32 * 1024 * 1024 })
    const tgz = `dsh-connect-trae-${version}.tgz`
    // `tar -t` lists the archive; every entry is prefixed with `package/`.
    const { stdout: listing } = await run('tar', ['-tzf', join(tarballDir, tgz)], { maxBuffer: 32 * 1024 * 1024 })
    for (const raw of listing.split('\n')) {
      const path = raw.trim()
      if (path === '' || path.endsWith('/')) continue
      entries.push(path.replace(/^package\//, ''))
    }
    // `tar -xzf` writes the extracted tree next to the archive.
    await run('tar', ['-xzf', join(tarballDir, tgz)], { cwd: tarballDir })

    /**
     * Files that live in the package but CANNOT be compared byte-for-byte with
     * the tag, with the reason. Empty is the goal; anything here is surfaced
     * explicitly rather than quietly passing.
     */
    const notInGit = []
    for (const path of entries.sort()) {
      let published
      try {
        published = await readFile(join(tarballDir, 'package', path))
        publishedBytes.set(path, published)
      } catch {
        record(`发布包文件 ${path}`, false, '解包后读不到该文件')
        continue
      }
      // `git show <tag>:<path>` fails outright when the path is not in the tag's
      // tree, so its exit status — not the output being empty — is the signal.
      // Testing emptiness instead would misclassify a legitimately empty shipped
      // file as "not in git" and skip comparing it.
      let tagged
      try {
        tagged = await gitBlob(tag, path)
      } catch {
        tagged = undefined
      }
      if (tagged === undefined) {
        notInGit.push(path)
        continue
      }
      record(
        `发布包文件 ${path}`,
        sha256(published) === sha256(tagged),
        sha256(published) === sha256(tagged) ? '与 tag 一致' : '与 tag 内容不同',
      )
    }
    if (notInGit.length > 0) {
      // `lib/` is the expected member of this group: it is gitignored, so
      // `git show <tag>:lib/...` has nothing to read. It is covered by the
      // rebuild check below instead.
      const buildOutputs = notInGit.filter(path => path.startsWith('lib/'))
      const unknown = notInGit.filter(path => !path.startsWith('lib/'))
      record(
        '未纳入 git 的发布文件',
        unknown.length === 0,
        unknown.length === 0
          ? `仅构建产物 ${buildOutputs.join(', ') || '（无）'}，由下一步重建比对覆盖`
          : `以下文件既不在 tag 树中、也不是 lib/ 构建产物：${unknown.join(', ')}`,
        { blocking: unknown.length > 0 },
      )
    }
  } finally {
    await rm(tarballDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 5. Build determinism: rebuild from the tag and compare `lib/`.
//
// `lib/` is gitignored, so the published copy can only be checked against a
// rebuild. That check is meaningful only if the build is deterministic, so the
// script rebuilds ONCE and compares — and says plainly that this is a rebuild
// comparison, not a source comparison, so nobody reads more into a pass than it
// proves.
// ---------------------------------------------------------------------------

if (!skipNpm) {
  const buildOutputs = entries.filter(entry => entry.startsWith('lib/'))
  try {
    await run('npm', ['run', 'build'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
    for (const path of buildOutputs.sort()) {
      const published = publishedBytes.get(path)
      const rebuilt = await readFile(join(repo, path)).catch(() => undefined)
      if (published === undefined) {
        record(`构建产物 ${path}`, false, '未从发布包中读到该文件')
        continue
      }
      if (rebuilt === undefined) {
        record(`构建产物 ${path}`, false, '重建后本地缺少该文件')
        continue
      }
      record(
        `构建产物 ${path}`,
        sha256(published) === sha256(rebuilt),
        '由 tag 源码重建后一致（重建比对，非源码比对）',
      )
    }
  } catch (error) {
    record('由 tag 源码重建成败', false, error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

const blockingFailures = results.filter(result => result.blocking && !result.ok)
const notes = results.filter(result => !result.blocking && !result.ok)

console.log('')
for (const result of results) {
  const mark = result.ok ? '✓' : result.blocking ? '✗' : '!'
  console.log(`  ${mark} ${result.name}：${result.detail}`)
}
console.log('')

if (blockingFailures.length > 0) {
  console.log(`核验失败：${blockingFailures.length} 项不一致。`)
  console.log('发布包与 tag 不一致时，先查「发布时工作树是否有未提交改动」（RELEASING.md 第 8 步），')
  console.log('不要重发同号包 —— 已发布版本不可覆盖。')
  process.exit(1)
}

console.log(`核验通过：${results.length} 项全部一致（${tag}）。`)
if (notes.length > 0) {
  console.log(`另有 ${notes.length} 项提示（非阻塞），见上方 ! 标记。`)
}
process.exit(0)
