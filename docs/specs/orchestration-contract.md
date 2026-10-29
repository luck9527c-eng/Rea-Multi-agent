# v0 编排工具与恢复契约

> 状态：设计已定义，插件尚未实现。配合[主规格](rea-multi-agent.md)、[项目管理协作契约](project-management-integration.md)阅读。
> 本文定义工具参数、编排状态与错误恢复；路线/RUN 的语义仍以项目 skill 为准。

## 版本、角色与通用返回

三工具在 `redteam-lead` preset 内注册。`rt_roster(action=inspect)` 为只读诊断，允许 Lead 和真实 teammate；bind/takeover、rt_dispatch、rt_conclude 仅 Lead。普通裸子代理均拒绝。身份来自可信执行上下文，不接受参数中的自报角色。工具契约版本为 1；未知字段、未知枚举、空白必填文本、重复 ID、非法路径均返回 INVALID_ARGUMENT，在产生副作用前检查。

工具输入输出的字段与条件约束见 [JSON Schema](rt-tools.schema.json)。schema 管形状，本文管跨字段、身份、路径、状态和恢复语义；它们共同构成 interface。JSON Schema 的字符串长度不用于代替宿主 UTF-16 或信封字节限制。

实时工具参数使用 schema 中对应的 rosterInput/dispatchInput/concludeInput；顶层 tool/input 仅用于保存请求样例。输出使用 result 信封，并按工具选择对应的成功 data；失败 data 只用 failureData/rosterData/null。处理器显式填默认值，schema 的 default 注解不自行改参数。

所有返回含 `schema_version=1`、`status=ok|blocked|partial|error`、`code`、`operation_id`、`replayed`、`retryable`、`diagnostics[]` 和 `data`。每条诊断含原因及具体下一步。ok 的 code 为 null；其余必须有稳定错误码。partial 表示副作用可能已发生，data 返回已有 dispatch/task/member/阶段，不能作为成功派发或验收。retryable 只表示允许以同一 operation ID 重入，不代表自动重试实验。

## 工具输入与输出

| 工具 | 必填输入 | 可选输入及默认值 | ok 的 data |
|---|---|---|---|
| rt_roster | project_root | action=inspect；target_kinds=[]（仅诊断）；max_posts=6；reserved_member_slots=1；reserved_activations=2；bind/takeover 时另需 operation_id、proposal_hash，takeover 需 recovery_ref | action、project/session/team、compatibility、posts、gaps、capacity、recommended_members、proposal_hash；变更时含 binding_ref |
| rt_dispatch | project_root、operation_id、post_id、route_id、target_ids、objective、evidence_required、prohibited | capability_needs=[]（只追加）；depends_on_tasks=[]；resource_needs=[]（与配置合并）；timebox_ms=1800000；delivery_timeout_ms=60000；retry_of=null | dispatch/attempt/task/member/route、revision、phase=delivered、contract_ref、work_dir、started_at=null 或实际开始时间 |
| rt_conclude | project_root、operation_id、dispatch_id、attempt_id、task_id、expected_revision、submission_ref、submission_sha256、review | 无其他隐式默认 | identities、phase=completed、outcome、route_status、receipt_ref、checks、audit_written |

roster inspect 不落盘，不创建成员/任务或运行实验；没有 target_kinds 时只检查环境，不臆测项目类别。bind 仅建立项目/session 绑定与 roster，不批量烧掉席位；成员在首次真实派发时按需创建。proposal_hash 绑定提议内容、能力映射版本、预算及当前绑定；宿主计数在锁内重读，资源不足则重新提议，不能沿旧快照超配。bind 要有已确认的班底授权；本会话已覆盖的授权不重复询问。takeover 的恢复依据见后文。

工具发现、验证、清单/MD 发布及提醒归工程管理 skill；插件只读消费，不增加刷新 action。inspect 不因缺清单就隐式扫描或写入，发现缺口后由 Lead 按 skill 补齐，详见[工具发现与文档](tool-discovery.md)。

dispatch 的 route 必须已由 Lead 按 skill 建立为可执行问题；工具不接受自由形状的路线草稿，不在能力缺失时留下半条正式路线。target_ids 必须是该路线目标集合的非空子集，额外目标需先按 skill 建新路线。旧 context=fresh|fork 字段删除：v0 新成员一律使用 bootstrap，新任务通过契约引用交付，不提供未定义的上下文复制承诺。

retry_of 只恢复尚未收口的同一 dispatch/task，要求引用当前旧 attempt 及真实恢复记录，先撤销旧尝试、再新增尝试并重新指派；route/目标/问题与原契约保持一致。已收口或问题改变时另发新 dispatch，不重开宿主 completed 任务。任务依赖 ID 仅在当前绑定 team/session 解析，跨团队引用拒绝。

review 明确含 outcome、summary、reason、proposed_route_status、evidence_run_ids、anchor_refs、limitations、next_step。路线状态来自 skill 枚举，本次收口允许的子集由结果表限定。前提、条件或争议需要变更时，Lead 先按 skill 更新相关正式记录并记录原因；工具再读 impact 校验，不接受任意 JSON patch 更改事实。review 是 Lead 的审阅判断，校验器只检查其依据和状态门槛。

evidence_required 与 prohibited 也只追加到目录默认要求，不能以短数组删除岗位约束。结果分类决定实际提交门槛：成功/反证型交付检查合并后的锚点要求；未开始即阻塞/取消适用下表的诊断依据，不被强制补造成功锚点。

具体宿主 API 与本地源码版本核对见[接口记录](../reviews/2026-10-29-dsh-interface-check.md)：执行身份使用 exec.agent + membership；任务操作使用 createTask/updateTask（action=reassign/complete），不要按本文语义名臆造独立 reassign/complete 服务方法。

## 岗位目录与预算裁剪

[岗位目录](roster-catalog.json)是四模板、默认能力、优先级、锚点类别和禁止事项的唯一数据源。priority 越小越先保留，同值按 post_id 排序；缺省 enabled=true。environment 按需加入，不因默认模板自动建岗；web-attack 为显式 disabled，不参与可用岗位计数。

mixed 必须给至少两个不同 target_kinds，取相应模板岗位的并集，按 post_id 去重。先展示所有候选岗位及其状态，再选出工具需求可满足且在预算内的岗位；裁掉的标 deferred 并返回覆盖缺口，缺工具的标 vacant，disabled 单列。不为凑 ≥4 岗创建空任务。没有可用岗位时 recommended_members=0，不写空岗任务。

成员席位余额与 activation 余额分别从宿主快照读取，不能把二者都推定为 8；历史失败成员计入已用席位。可新增成员数受 `remaining_member_slots - reserved_member_slots` 与 `remaining_activations - reserved_activations` 共同限制，再与 max_posts 和可复用岗位结合；负值按 0。复用仍需检查宿主的实际启动额度，不假定 inactive 自动释放名额。无法取得或保守确定可用额度时返回 CAPACITY_UNKNOWN，不估计后盲目创建。当前文档未公开统一的剩余席位/activation 余额查询方法；实现 adapter 前必须确定可验证的配置/计数来源与并发限制，不能臆造 getCapacity 或读取宿主私有字段。此接入仍待解决，不能因此声称现有接口已满足全部派发前置条件。

默认预算为最多六岗、至少一席失败替换预留和两个 activation 供零碎活/恢复；这是部署值均为 8 且无既有占用时的建议上限，不是所有环境都能创建六人。主规格不再用一个常数等式替代运行时计数。

按排序逐岗选择时，已运行的岗位保留为 assigned 并计入 max_posts，不因降低预算取消它；空闲已有成员按宿主报告的本次 activation 增量计费，不再扣一个新席位；新成员扣一席及其启动额度。任一增量未知则该岗 deferred 并报告 CAPACITY_UNKNOWN。recommended_members 只计本提议需要新建的成员，不把复用人数再加进去。

## 能力绑定与就绪判定

岗位 required 与任务 capability_needs 作并集；optional 不阻止派发。能力表达只有 AND（需求列表）及每族明确的 any_tool/any_provider/all_capabilities，不支持调用者传正则或删除模板需求。未知族返回 UNKNOWN_CAPABILITY，保留族 reserved 不再作为可执行能力。

目录中的 shell/fs/search/jobs/web/skill 是能力族，按列出的**完整工具名**或组合子能力匹配，区分大小写，不做子串或宽泛前缀猜测。当前默认名按目标 0.2.1-rc.3 tag 文档修正为 read/write、glob/grep、job_list/job_output/job_kill、web_fetch/web_search 等；不能直接匹配 fs、fs_search、jobs、web 这些族名或插件 ID。它们仍是可覆盖的默认别名，不证明部署会话实际暴露了这些工具。项目配置可绑定真实别名，保存到 `re/team/capabilities.json`；工具目录变化即重新计算注册表指纹并复验。

binary-static/binary-dynamic/browser/db 无通用工具名默认映射，接入时由 Lead 根据当前真实工具描述及最小检查登记精确绑定；未登记即缺口，不能仅凭某个 REA/MCP 工具存在就认定所有 provider 就绪。`mcp:<server>` 是动态命名空间，server 和工具集合必须显式登记；不根据名字中包含 server 判断归属。

绑定记录的字段：schema_version、revision、registry_sha256、families。每族恰选 any_tool（至少一个完整注册名）、any_provider（已验证清单入口）或 all_capabilities，并保存 source_ref、readiness_ref；替代默认映射需要保留理由。any_provider 支持本地程序经 shell/Python 使用，记录工具/入口 ID、清单 revision/不可变快照/哈希、调用配方、实际 transport_tools 与资源要求，具体结构见[工具发现与文档](tool-discovery.md)。capabilities.json 只作能力映射，工具状态由 tools.json 管理，不维护第二份清单。只接受已登记且可追溯的项目绑定，不接受本次 dispatch 自报“能力已满足”。组合能力图必须无环。

匹配纯函数接收注册名、清单快照及绑定，输出 matched/missing 与 provider 引用。readiness_ref 引用 skill 的不可变环境快照，按执行者/当前 session、target、工具/provider 配置分别判断 session_ready 与 target_ready。已知必要就绪失败先返回 CAPABILITY_NOT_READY，或另派 environment 任务；不能把“已注册”输出成“可运行”。只能在新成员验证的项允许进入 bootstrap 无害预检，验证前不派正式实验；预检失败保存阻塞与已用席位，返回 partial，不自动再创建成员。

## 交付、开始和结果分类

成员 bootstrap 只载入项目规则并等待，不运行正式任务。任务指派完成后发送交付信封，内含 dispatch/attempt/task/revision、契约引用及 SHA256。完整文本只存文件；契约可大于 64 KiB，消息不得截断。发送失败/长度拒绝记 DELIVERY_FAILED，保留已经创建的身份。同一信封重发时成员按 dispatch/attempt 去重，一次任务最多启动一次。

delivered 只表示消息被宿主接收，不冒充执行者已开始。成员先验证契约摘要、身份、资源分配和就绪状态，再在工作区写 start.json，含 attempt、at、target/environment/resource 引用；Lead 下次读回后记录 started_at。timebox 从该时间算；尚无开始确认时走 delivery_timeout，超时返回待核查交付，不能把它记作实验超时或释放资源。

提交统一为 submission.json：schema_version、dispatch/attempt/task、contract_sha256、outcome、summary、run_ids、artifacts（path/sha256）、anchor_refs、blocker、state_recovery_ref、submitted_at。开始过的 RUN 必须有真实终态与保留产物；未开始即阻塞可以 run_ids=[]，但须有保存的就绪检查或中断核查。临时提交先写独立文件再原子发布；发布后停止改写该版本。更正另交新提交，旧稿保留。

| outcome | 至少交回 | 对路线的允许影响 | 是否满足路线成功依赖 |
|---|---|---|---|
| finding | 支持结论的已完成运行与定位；区分观察/推断 | 判据已达才 validated，否则 active | 仅当前有效 validated 且无阻断复查/争议时 |
| no_finding | 指定搜索/观察范围、有效运行与局限；不等于证死 | active；预算耗尽 paused；若预先判据确为“确认无命中”可有据 validated | 同上，不能仅凭 outcome 判断 |
| refuted | 有效观测/对照链、预先反证条件、skill 完整 closure | 仅满足证死门槛才 falsified | 否；其发现可另支持共享条件 |
| blocked | 具体缺口、检查依据、恢复条件；可能没有 RUN | blocked | 否 |
| budget_exhausted | 已花预算、停止依据、部分结果和恢复条件 | paused | 否 |
| failed | failed/timed_out/interrupted 运行及真实诊断、恢复状态 | blocked 或 paused；不能自动 falsified | 否 |
| cancelled | 取消原因、已执行范围、残留与处置；如未开始可无 RUN | paused；问题确被替代时按 skill 留 superseded 原因 | 否 |

任务 completed 只在交付按上述要求处理且检查通过后发生；不要求所有路线都转终态。关键恢复尚未完成时结果可记录，但保留资源 quarantine 及恢复待办，后继实验不能开工。旧原生 complete 没有验收回执时走补验；模板的成功锚点要求不强加给“没有开始实验”的阻塞/取消交付。

## 锚点与封存绑定

每个 anchor_ref 指向 `run_id/path/locator`，path 必须登记在该 RUN 的 artifacts；完整类型信息记录在所指产物中，插件读取校验，不复制一套与 skill 竞争的证据记录：

| kind | 产物内的最低定位内容 |
|---|---|
| binary_location | target_id、目标 sha256、module、va/rva/file_offset 值及类型；va 另含基址和进程实例/捕获时间；函数名不能作唯一定位 |
| source_location | 内容文件 sha256、文件路径、行号或字节范围；可附函数名；source map 映射须保留源/映射产物身份 |
| web_capture | 捕获时间、URL/方法、保存响应或会话导出的 path/sha256，以及请求/响应内定位；URL 单独不成立 |
| runtime_event | 目标身份、进程实例、事件/时间位置、触发与观测窗口、已保存日志身份 |
| evidence_export | 服务/版本、原会话、原 evidence ID、导出包 path/sha256 和包内定位 |
| artifact_locator | 文件 sha256 与具体行/事件/偏移，适用于文档、工具诊断或协议记录 |

派发前冻结本次目标 ID/字节哈希、相关已有 seal 的路径和字节哈希，以及所依赖产物的身份，保存为 contract 的 baseline_ref。首次目标尚无 seal 时明确 preexisting_seals=[]，仍须有真实目标哈希；不能拿空清单代替目标身份。收口先与该快照比较，再用项目 skill 校验当前记录/已有 seal。其他路线正常新增 seal 不使旧快照失效；既存项删除、读取失败或内容变化必须报错，不能因遍历当前目录时“没找到”而漏过。

未封存的新 RUN 由 Lead 核对来源后一次性 seal；旧项不重封存。零字节原始输出可以是真实空结果，须保留命令、范围、有效对照和局限，不人为添加内容或把它当成功/反证。此机制不提供抵抗同时重写契约快照、基线和校验器的独立防篡改保证。

## 路径、锁与资源

project_root 必须是已选择的本地分析目录，规范化为真实绝对根并核对项目绑定。插件生成的项目内路径统一用 `/`；拒绝绝对/盘符/UNC、空段、`.`/`..`、反斜杠、控制字符和 Windows ADS。每次写入检查所有祖先及现有目标，不能穿过 symlink/junction/reparse point；新文件父目录也须在根内。目标注册中明确的外部样本只允许读，不因记录 path 就取得写入权。大小写折叠后的 ID/路径碰撞拒绝。

写入仅限契约生成的工作区、编排目录及 skill 约定的正式位置；传入 submission_ref 必须位于当前 attempt，artifacts 只能指其分配目录；归档目标由 RUN ID 生成，不接受任意 deliverable_path。JSON/提交/回执使用同目录临时文件加原子替换；对不可变文件使用独占创建，已有内容不一致则冲突。读取提交与复制时重新核对哈希，防止校验后换内容。

`re/team/lock` 用原子独占创建，内容含 project/session、owner nonce、PID/进程启动身份和 operation。每次变更和正式整合持有同一项目锁；冲突返回 PROJECT_BUSY。过期时间不作为自动解锁理由；核实原进程/Lead 不再写、恢复记录已保存后显式清理。崩溃后未完成操作先恢复，不能抢锁后跳过半写入状态。锁只协调遵守协议的插件/Lead，不声称限制通用 shell 或文件工具。

资源记录放 `re/team/resources.json`，每项含 resource_key、physical_identity、mode=shared_read|exclusive、owner dispatch/attempt、generation、state=reserved|held|quarantined|released、recovery_ref。检查和租用在项目锁内完成；相同物理实例的别名映射为同一 resource_key。默认独占；只有登记为不可变读取且无状态写操作才 shared_read。零碎子代理如使用同一分析资源，也须通过 Lead 使用相同租用记录。

静态目标字节可 shared_read；分析数据库/调试器/浏览器/进程默认独占。任务的最终资源需求为岗位/能力绑定规则与附加需求的并集，不能省略 resource_needs 绕过；未知实例或缺必要映射返回 RESOURCE_BINDING_MISSING。v0 资源协调范围为本分析项目，跨项目共用实例须外部隔离，不宣称全机互斥。

正常结束并核对副作用后释放；失败/中断/失联置 quarantined，直到恢复依据证明目标/端口/后台任务已结束或可安全使用。改 owner 或中断 agent 都不自动释放。重派先撤销旧 generation 的提交资格、保存部分输出并核查共享资源，再分配新 attempt；旧提交只能入历史，不更新当前结果。

## 操作阶段与部分失败

operation ID 在项目内唯一，绑定规范化输入的哈希；相同 ID/相同输入恢复或重放，改变输入报 OPERATION_CONFLICT。不同 operation ID 指向相同 dispatch/attempt 的并发 conclude 还须按该业务身份去重，不能重复封存或追加 history。

规范化先拒绝重复集合项，再填默认值、规范化项目根，对语义为集合的数组排序，最后将 tool、action、project/session/epoch 与输入按键排序编码成 UTF-8 JSON 求 SHA256；正文文本保留实际内容。响应丢失后的调用保持原输入和 expected_revision，工具结合已保存阶段恢复，不要求调用者改输入冒充新请求。

project/session/epoch 使用该操作首次捕获的授权上下文；查询到已有 operation 时先核对当前调用身份及绑定，再按原上下文比较输入，不能因为 bind/takeover 已改变 epoch 就把同请求重放误判冲突。旧会话/旧 epoch 的其他操作仍拒绝跨越新绑定继续执行。

| 操作阶段 | 已保存内容与可见状态 | 重入行为 |
|---|---|---|
| prepared | 契约/基准/尝试身份与资源预留；尚无成功派发 | 读当前绑定/容量/资源后续做未完成步骤 |
| member_ready | 成员身份及就绪结果；创建失败也记已用席位 | 复用已知成员，不再 spawn；就绪失败交回阻塞 |
| task_created | task_id，任务可暂时 pending | 继续该任务的指派，不创建第二个 task |
| assigned | task owner/revision，in_progress；信封未确认接收 | 只交付同一信封，实验不得提前开始 |
| delivered | 宿主接收信封；等待开始/提交 | 读 start/submission，不重新派一个实验 |
| integrating | 原提交摘要、归档清单和已完成步骤 | 校验已归档项，继续缺少的 seal/history/check，不重复添加 |
| facts_committed | 已验收事实与预备回执，task 可能仍 in_progress | 重新核对 owner/attempt；一致才补 complete，冲突人工恢复 |
| completed | 最终回执与完成态已核对 | 返回原回执，replayed=true |
| needs_recovery | 已知身份、失败点、未确认副作用 | 无法确认的步骤不重试；Lead 核实后以同一 ID 恢复 |

每次宿主变更前保存意图，变更后尽快保存实际 ID；响应丢失时按确定的成员名、任务描述中的 operation/dispatch 标记及宿主快照关联。宿主缺少足够可查询标记时返回 RECOVERY_REQUIRED，不假定 exactly-once。完成态确认的响应丢失可用任务快照核对；业务回执未落盘前禁止报告 ok。

CAS 冲突返回 REVISION_CONFLICT，并带实际 revision；读取实际 owner/attempt 对照后才续做，不自动用新 revision 覆盖别人决策。任何不完整整合均阻止其他正式变更；不回滚或删除已经保留的证据，只前向修复。seal 前先按事实解除会令全项目校验失败的旧状态（例如受争议的 active 路线），不得降低校验门槛。

审计 best-effort，失败不逆转已有证据判定，但最终回执 audit_written=false 并有诊断。回执/恢复记录是恢复必需项，写不成时返回 partial，不能等同审计失败后继续报成功。实验重跑只由 Lead 决定；恢复一次宿主交付与重跑目标实验是不同操作。

## 自检、会话接管与 Lead 循环

缺团队服务时的保证入口固定为包内只读命令 `node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>`，不依赖插件已挂载，不新增第四个 agent 工具。它检查本包/项目副本、Python、profile 配置及可见缺口，输出与工具一致的诊断信封。离线配置正确只报 configuration_ready；runtime_ready=unknown，不能假称团队服务已运行。实际挂载后的 rt_roster 检查真实团队服务。可选注入诊断可以优化体验，但不是唯一验收入口。

binding 至少含 schema_version、project_id、canonical_root、session_id、team_id、epoch、rule/script/catalog/binding 摘要。每个 task 引用都同时带 team/session；同会话重载根据宿主快照和本地操作记录恢复，不重复建岗。不同会话只读 inspect 可返回缺口，任何变更在显式 takeover 前拒绝。

takeover 需 recovery_ref 指向旧 Lead/执行者已停止或隔离、遗留进程/资源处置与剩余风险的真实核查记录。取得项目锁后归档旧 binding/roster/资源记录，保留 dispatch 与事实，增加 epoch 并建立新团队映射。旧 epoch 的提交不进入新结果；未知是否仍在写时保持阻塞，不靠用户点击一个布尔值替代恢复核查。新事实仍按 skill 记录，接管不迁移旧宿主句柄。

Lead 每轮先回读状态、start/submission、过期时间和 impact，再处理交付/复查/阻塞，随后派已有独立任务。最多执行三项独立动作或经过 30 秒后，在下一个可控制点回读；无独立工作时 wait 最多 30 秒再回读。timebox 与 delivery_timeout 由 Lead 下次回读判断，不承诺后台回调或硬实时中断。

有未收口任务时维持此循环；全部任务已处理后只在已有问题与预算下继续。项目完成走 skill 的完整验收；无可执行问题、预算耗尽、所需信息缺失或用户要求停止时，保存真实阻塞/暂停和恢复点后结束 Lead turn，不为填空新开路线。结束 turn 后插件不承诺自动唤醒。

## 稳定错误码

| 类别 | code |
|---|---|
| 输入与权限 | INVALID_ARGUMENT、ROLE_REQUIRED、PATH_INVALID |
| 接入 | TEAM_SERVICE_UNAVAILABLE、PROJECT_NOT_CONFIGURED、SKILL_INCOMPATIBLE、PROJECT_SESSION_MISMATCH、PROJECT_BUSY |
| 派发前置 | UNKNOWN_CAPABILITY、CAPABILITY_MISSING、CAPABILITY_NOT_READY、CAPACITY_UNKNOWN、CAPACITY_EXHAUSTED、POST_DISABLED、MEMBER_BUSY、DEPENDENCY_BLOCKED、RESOURCE_BINDING_MISSING、RESOURCE_BUSY |
| 交付与恢复 | DELIVERY_FAILED、START_ACK_TIMEOUT、RECOVERY_REQUIRED、OPERATION_CONFLICT、REVISION_CONFLICT、STALE_ATTEMPT |
| 收口 | SUBMISSION_INVALID、BASELINE_MISMATCH、CHECK_FAILED、UNREVIEWED_COMPLETION |

前置拒绝 status=blocked 且无新成员/任务/正式路线变更；非法参数/角色 status=error；已持久化或触及宿主后失败 status=partial。审计失败作为 ok 的诊断，不伪称没有实际副作用。所有码必须给出具体对象与下一步，不只透传栈或宿主异常。
