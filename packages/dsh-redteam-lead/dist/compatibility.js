/**
 * 项目副本兼容性指纹（SEAMS 第 4 节 `compatibility`、DECISIONS D8）。
 *
 * 产出三个内容摘要：
 *
 * | 摘要 | 覆盖内容 |
 * |---|---|
 * | `ruleDigest` | 项目 skill 副本的 `SKILL.md` + `references/**` + `assets/**` 的 Markdown |
 * | `scriptDigest` | 副本 `scripts/**`（`project.py` 及其 sibling 模块，排除 `__pycache__`） |
 * | `catalogDigest` | 岗位目录（默认取包内 `src/catalog.data.json`，退化到仓库 `docs/specs/roster-catalog.json`） |
 *
 * 摘要算法：把每个文件的相对路径与小写 sha256 按 `path<TAB>sha256` 行排序后拼接，再取 sha256。
 * 因此它对文件枚举顺序、盘符、时间戳都不敏感，只对**内容与相对路径**敏感。
 *
 * **重要限制**：这些摘要是内容指纹，**不是**独立可信签名，也不证明来源。它们只能回答
 * 「项目副本是否与上次绑定时是同一份内容」，不能证明副本没有被同时篡改。真正的信任来自
 * 版本控制与人工复核（D8）。
 *
 * 摘要与 `re/team/binding.json` 里保存的值不一致时，本模块只给出「需要重新做兼容性检查」的
 * 信号（`REBIND_REQUIRED`），**不会**用全局副本或新规则静默替换项目副本。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, thrownCode } from './guards.js';
/** 适配器契约版本（binding.json 的 `adapter.contract_version`）。 */
export const CONTRACT_VERSION = 1;
/** 项目内 skill 副本的相对路径（skill 自己的规则：只用副本，不用全局路径）。 */
export const SKILL_COPY_RELATIVE = '.agents/skills/reverse-project-management';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SKIP_DIRECTORIES = new Set(['__pycache__', '.git', 'node_modules']);
/** 三个摘要键的固定顺序（原来用 `Object.keys(BINDING_KEYS)`，顺序必须一致）。 */
const DIGEST_KEYS = ['ruleDigest', 'scriptDigest', 'catalogDigest'];
/** @param {Buffer} buffer 字节 */
function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
async function isDirectory(target) {
    try {
        return (await stat(target)).isDirectory();
    }
    catch {
        return false;
    }
}
async function isFile(target) {
    try {
        return (await stat(target)).isFile();
    }
    catch {
        return false;
    }
}
/**
 * 递归列出目录下的文件（相对路径统一用 `/`）。
 * @param {string} root 绝对目录
 * @param {string} [prefix] 相对前缀
 * @param {(relative: string) => boolean} [accept] 过滤
 */
async function walk(root, prefix = '', accept = () => true) {
    let entries;
    try {
        entries = await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true });
    }
    catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name))
                continue;
            files.push(...await walk(root, prefix === '' ? entry.name : `${prefix}/${entry.name}`, accept));
            continue;
        }
        if (!entry.isFile())
            continue;
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (accept(relative))
            files.push(relative);
    }
    return files;
}
async function hashFiles(root, relatives) {
    const rows = [];
    for (const relative of [...relatives].sort()) {
        const absolute = path.join(root, ...relative.split('/'));
        try {
            rows.push({ path: relative, sha256: sha256(await readFile(absolute)) });
        }
        catch {
            // 读不到就跳过：摘要只覆盖实际读到的内容，缺口由调用方从 files 里看出来
        }
    }
    return rows;
}
function digestOfRows(rows) {
    if (rows.length === 0)
        return null;
    const text = rows.map((row) => `${row.path}\t${row.sha256}\n`).join('');
    return sha256(Buffer.from(text, 'utf8'));
}
async function resolveCatalog(catalogPath) {
    const candidates = [];
    if (typeof catalogPath === 'string' && catalogPath.length > 0)
        candidates.push(catalogPath);
    candidates.push(path.join(PACKAGE_ROOT, 'src', 'catalog.data.json'));
    candidates.push(path.join(REPO_ROOT, 'docs', 'specs', 'roster-catalog.json'));
    for (const candidate of candidates) {
        if (await isFile(candidate))
            return candidate;
    }
    return null;
}
/**
 * 计算三个内容摘要。缺文件不抛：摘要置 null 并给出 gap。
 * @param {{projectRoot: string, catalogPath?: string, skillRoot?: string}} input
 */
export async function computeDigests(input = {}) {
    const projectRoot = typeof input.projectRoot === 'string' ? input.projectRoot : undefined;
    const gaps = [];
    const skillRoot = input.skillRoot ?? (projectRoot === undefined
        ? undefined
        : path.join(projectRoot, ...SKILL_COPY_RELATIVE.split('/')));
    let ruleFiles = [];
    let scriptFiles = [];
    if (skillRoot === undefined || !await isDirectory(skillRoot)) {
        gaps.push({
            code: 'SKILL_COPY_MISSING',
            detail: skillRoot === undefined
                ? '没有项目根，定位不到 .agents/skills/reverse-project-management'
                : `没有找到项目内的 skill 副本 ${skillRoot}`,
            nextStep: '用项目 skill 的 init 建副本，或按团队规则把副本合并进项目；不要用全局副本代替项目副本（D8）',
        });
    }
    else {
        const markdown = (relative) => relative.toLowerCase().endsWith('.md');
        const ruleRelatives = [];
        if (await isFile(path.join(skillRoot, 'SKILL.md')))
            ruleRelatives.push('SKILL.md');
        ruleRelatives.push(...await walk(skillRoot, 'references', markdown));
        ruleRelatives.push(...await walk(skillRoot, 'assets', markdown));
        ruleFiles = await hashFiles(skillRoot, ruleRelatives);
        scriptFiles = await hashFiles(skillRoot, await walk(skillRoot, 'scripts'));
    }
    let catalog = null;
    const catalogFile = await resolveCatalog(input.catalogPath);
    if (catalogFile === null) {
        gaps.push({
            code: 'CATALOG_MISSING',
            detail: '找不到岗位目录（包内 src/catalog.data.json 与 docs/specs/roster-catalog.json 都不存在）',
            nextStep: '确认本包安装完整（src/catalog.data.json 随包发布），或显式传入 catalogPath',
        });
    }
    else {
        catalog = { path: catalogFile, sha256: sha256(await readFile(catalogFile)) };
    }
    return {
        ruleDigest: digestOfRows(ruleFiles),
        scriptDigest: digestOfRows(scriptFiles),
        catalogDigest: catalog === null ? null : catalog.sha256,
        files: { rule: ruleFiles, script: scriptFiles, catalog },
        gaps,
    };
}
/**
 * 读 `re/team/binding.json`。缺失或坏 JSON 都返回 `present:false`，不抛。
 * @param {string} projectRoot
 */
export async function readBinding(projectRoot) {
    const relative = 're/team/binding.json';
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
        return { present: false, binding: null, path: relative, reason: '没有项目根' };
    }
    const file = path.join(projectRoot, 're', 'team', 'binding.json');
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        const missing = thrownCode(error) === 'ENOENT';
        return {
            present: false,
            binding: null,
            path: relative,
            reason: missing ? `${relative} 不存在（尚未 bind）` : `读不了 ${relative}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    try {
        const binding = JSON.parse(text);
        if (!isRecord(binding) || Array.isArray(binding)) {
            return { present: false, binding: null, path: relative, reason: `${relative} 不是 JSON 对象` };
        }
        return { present: true, binding, path: relative };
    }
    catch (error) {
        return {
            present: false,
            binding: null,
            path: relative,
            reason: `${relative} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/** binding 里可能用 camelCase 或 snake_case 存摘要，两种都认。 */
const BINDING_KEYS = {
    ruleDigest: ['ruleDigest', 'rule_digest'],
    scriptDigest: ['scriptDigest', 'script_digest'],
    catalogDigest: ['catalogDigest', 'catalog_digest'],
};
function declaredValue(binding, key) {
    for (const candidate of BINDING_KEYS[key]) {
        if (binding[candidate] !== undefined)
            return binding[candidate];
    }
    return undefined;
}
/**
 * 计算摘要并与 binding 比对。
 *
 * - 没有 binding → `BINDING_MISSING`（首次 bind 之前的正常状态）；
 * - 摘要一致 → `BINDING_MATCH`，`needsReview:false`；
 * - 任一摘要不一致或缺失 → `REBIND_REQUIRED`，`needsReview:true`，并列出差异。
 *
 * 不一致时**只报告信号**，不改项目副本、不换规则（D8：报告缺口，不静默替换）。
 *
 * @param {{projectRoot: string, binding?: object, catalogPath?: string}} input
 */
export async function checkCompatibility(input = {}) {
    const projectRoot = typeof input.projectRoot === 'string' ? input.projectRoot : undefined;
    const digests = await computeDigests({ projectRoot, catalogPath: input.catalogPath });
    const loaded = input.binding === undefined
        ? await readBinding(projectRoot)
        : { present: true, binding: input.binding, path: 're/team/binding.json' };
    // `present:true` 的定义就是 `binding` 是对象，所以这里可以按已收窄读 `adapter`；
    // 与原实现 `loaded.present && loaded.binding.adapter` 的判断顺序一致。
    const adapterView = loaded.present ? loaded.binding.adapter : undefined;
    const adapterContractVersion = isRecord(adapterView) ? (adapterView.contract_version ?? null) : null;
    const noDifferences = [];
    const base = {
        contract_version: CONTRACT_VERSION,
        digests,
        gaps: digests.gaps,
        binding: {
            present: loaded.present,
            path: loaded.path,
            matched: false,
            differences: noDifferences,
            ...(loaded.reason === undefined ? {} : { reason: loaded.reason }),
            adapter_contract_version: adapterContractVersion,
        },
    };
    if (!loaded.present) {
        return {
            ...base,
            needsReview: true,
            signal: 'BINDING_MISSING',
            nextStep: '先 rt_roster action=bind 建立项目/会话绑定并写入 rule/script/catalog 摘要',
        };
    }
    const differences = [];
    for (const key of DIGEST_KEYS) {
        const declared = declaredValue(loaded.binding, key);
        const actual = digests[key];
        if (declared === undefined || declared === null || declared !== actual) {
            differences.push({
                key,
                declared: declared === undefined ? null : declared,
                actual,
            });
        }
    }
    if (differences.length === 0) {
        return {
            ...base,
            binding: { ...base.binding, matched: true },
            differences: [],
            needsReview: false,
            signal: 'BINDING_MATCH',
        };
    }
    return {
        ...base,
        binding: { ...base.binding, matched: false, differences },
        differences,
        needsReview: true,
        signal: 'REBIND_REQUIRED',
        nextStep: '项目副本的规则/脚本/岗位目录摘要与 binding 不一致：重做兼容性检查（rt_roster action=inspect），'
            + '由 Lead 核对差异后重新 bind；不要用全局副本覆盖项目副本，也不要静默换规则（D8）。',
    };
}
