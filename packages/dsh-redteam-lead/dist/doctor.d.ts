/**
 * `bin/doctor.mjs` 的共享实现：**只读**、不加载插件、不依赖团队服务、不需要 Cordis。
 *
 * 入口（契约「自检、会话接管与 Lead 循环」固定）：
 *
 * ```
 * node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>
 * ```
 *
 * 输出与三个 rt 工具一致的信封形状（八字段 + 每条诊断带 code/reason/next_step），
 * 并且**只报配置状态**：`configuration_ready` 来自本文件的结构检查，
 * `runtime_ready` 恒为 `unknown` —— 离线不可能知道团队服务是否在跑，也不许假装知道。
 * 退出码：有硬阻塞 → 1，否则 0。
 *
 * 依赖纪律：只用 `node:*` 内建。故意**不** import `src/envelope.mjs` 或任何适配器 ——
 * 自检工具要在「兄弟模块坏了/还没合入」时照样能跑；`test/doctor.test.mjs` 用源码级断言钉住这条。
 *
 * @module @local/dsh-redteam-lead/doctor
 */
/** 契约诊断：恰好三字段（`$defs.diagnostic`，DECISIONS D21）。 */
interface Diagnostic {
    code: string;
    reason: string;
    next_step: string;
}
/** 四种信封状态。 */
type ResultStatus = 'ok' | 'blocked' | 'partial' | 'error';
/** 八字段信封（`$defs.result`）。 */
interface Envelope {
    schema_version: number;
    status: ResultStatus;
    code: string | null;
    operation_id: string | null;
    replayed: boolean;
    retryable: boolean;
    diagnostics: Diagnostic[];
    data: object | null;
}
/** 本包包名（profile 的 `dsh.profile.bundles` 与 `dependencies` 里必须出现）。 */
export declare const BUNDLE_NAME = "@local/dsh-redteam-lead";
/** 团队服务随这个 profile bundle 一起启用（D7：只能靠 bundle 成员资格开启）。 */
export declare const TEAM_PROFILE_BUNDLE = "@deepseek-ai/dsh-experimental-agent-team-profile";
/** 项目内项目 skill 副本的相对位置（SEAMS §4：脚本必须从项目副本内调用）。 */
export declare const SKILL_COPY_DIR: string;
/** 离线诊断永远只能说 runtime 未知。 */
export declare const RUNTIME_READY = "unknown";
/** 命令行用法（`--profile` 必填；`--project` 可省略；`--bundle` 仅用于校验打包/临时副本）。 */
export declare const USAGE: string;
/** `parseDoctorArgs` 的结果。 */
interface DoctorArgs {
    profileRoot?: string;
    projectRoot?: string;
    bundleRoot?: string;
    help?: boolean;
    problems: string[];
}
/**
 * 解析命令行参数。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ profileRoot?: string, projectRoot?: string, bundleRoot?: string, help?: boolean, problems: string[] }}
 */
export declare function parseDoctorArgs(argv: string[]): DoctorArgs;
/** 一条检查记录：`pass` / `skip` / `fail`，只有 hard fail 才阻止 configuration_ready。 */
interface CheckEntry {
    id: string;
    status: 'pass' | 'skip' | 'fail';
    severity: 'hard' | 'soft';
    detail: string;
}
/** 本包检查的事实（进 `data.bundle`）。 */
interface BundleFacts {
    root: string;
    name: string | null;
    version: string | null;
    manifest_ok: boolean;
    entry_present: boolean;
    patch_files: Array<{
        path: string;
        exists: boolean;
    }>;
    dependencies: string[];
}
/** profile 检查的事实（进 `data.profile`）。 */
interface ProfileFacts {
    root: string;
    exists: boolean;
    manifest_ok: boolean;
    bundles: string[];
    team_profile_enabled: boolean;
    bundle_listed: boolean;
    bundle_declared: boolean;
    bundle_linked: boolean;
    declared_local: string[];
    linked_local: string[];
}
/** 项目检查的事实（进 `data.project`）。 */
interface ProjectFacts {
    root: string;
    exists: boolean;
    index_present: boolean;
    config_present: boolean;
    skill_copy_present: boolean;
    team_rules_present: boolean;
    project_py_present: boolean;
    python: {
        interpreter: string | null;
        source: string | null;
        ok: boolean;
        version: string | null;
    };
}
/** `runDoctor` 的入参（由 `bin/doctor.mjs` 或测试给）。 */
interface DoctorOptions {
    profileRoot?: string;
    projectRoot?: string;
    bundleRoot?: string;
    problems?: string[];
    help?: boolean;
}
/**
 * 跑一次只读自检。
 *
 * @param {{
 *   profileRoot?: string,
 *   projectRoot?: string,
 *   bundleRoot?: string,
 *   problems?: string[],
 *   help?: boolean,
 * }} options `bundleRoot` 省略时用本包根目录（`bin/` 的上一级）
 * @returns {{ envelope: object, exitCode: number, report: object | null }}
 */
export declare function runDoctor(options?: DoctorOptions): {
    envelope: Envelope;
    exitCode: number;
    report: null;
} | {
    envelope: Envelope;
    exitCode: number;
    report: {
        configuration_ready: boolean;
        runtime_ready: string;
        bundle: BundleFacts;
        profile: ProfileFacts;
        project: ProjectFacts | null;
        checks: CheckEntry[];
    };
};
export {};
