/**
 * 跨模块共享的**类型**（本文件不产生任何运行时代码）。
 *
 * 只放那些真正横跨模块边界的东西：
 * - 契约 wire shape：`Diagnostic` / `Envelope`（`$defs.diagnostic` / `$defs.result`）；
 * - 装配接缝：`Deps` / `HandlerCtx`（SEAMS §1，键名逐字一致）；
 * - 由测试注入、但生产上是真实现的薄接口：`Clock` / `FsLike`。
 *
 * 各模块自己的内部形状仍写在该模块里的局部 `interface` —— 共享层只收「多方都要认识」的那几个。
 */
export {};
