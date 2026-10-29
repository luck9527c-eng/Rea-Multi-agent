# Rea-Multi-agent

给 DeepSeek Harness 加一套**逆向团队的指挥架构**：主 agent 当指挥，负责拆路线、派任务、核对事实、写文档；一组常驻工兵专门干活，各自守一条路线，干完带着可复跑的证据回来。工兵不能继续派发。

构建在 DSH 的实验性「智能体团队」插件之上——名册、共享任务板、看板 UI 直接复用，本包只补逆向专用的那一半。

## 状态

**规格阶段。** 还没有可安装的产物。

设计与取舍记在 [docs/specs/rea-multi-agent.md](docs/specs/rea-multi-agent.md)，包括被平台事实定死的三条约束（席位终身不回收、任务完成不唤醒 Lead、团队工具按成员身份注册）和测试的两层接缝。

## 安装（待实现）

本地 `link:` 安装进 profile 的 `dsh.profile.bundles`，与 `@local/dsh-rea-plugin` 同形态。选「红队指挥」preset 进入团队模式；现有「红队逆向」preset 保持不动。
