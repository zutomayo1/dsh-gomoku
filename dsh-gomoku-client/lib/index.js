/**
 * 五子棋插件（Host 半侧占位）。**本文件刻意什么都不做。**
 *
 * ## 为什么它必须存在且为空
 *
 * 一个包要作为 Loader 条目出现在 profile 的插件树里，就必须有一个可 import 的
 * 宿主入口（package.json 的 main）。而浏览器半侧由 exports["./client"] 提供，
 * 经 `dsh.client` 声明被 `@deepseek-ai/dsh-client-modules` 扫描、作为 `/plugins`
 * bundle 下发。两者是同一个包的两张脸。
 *
 * 但实测（A/B/C 对照，见 cordis.patch.yml）表明：**只要包里出现 `dsh.client`
 * 字段，宿主半侧就不会激活**。换句话说，本包即便在这里写上真正的宿主逻辑，那段
 * 逻辑也不会被执行——所以真正干活的宿主半侧放在独立的 `dsh-gomoku-host` 包里，
 * 本文件保持空 apply。
 *
 * 这个"空 apply"不是敷衍：它让本包在插件树里有一个健康的、立即可 active 的
 * fiber，从而不影响客户端组合。参考实现是本机长期稳定的
 * `dsh-plugin-account-balance`（同为纯客户端插件，lib/index.js 只有 18 行、零 import、
 * apply 为空函数）。
 */

/** Host 插件体——本界面插件没有任何 Host 侧行为。 */
function apply() {}

export { apply };
