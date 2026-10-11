# 修改记录（CHANGELOG）

> 本文件记录「后台网课不断播（NoPause）」的每一次功能/代码改动。
> 约定：**以后所有删改都必须在本文件追加一条记录**，含版本号、日期、改动内容与影响范围。
> 每次改动版本号递增（manifest `version` 与 `version_name` 同步更新）。

## 文档变更：添加 MIT 许可证

**日期**：2026-10-11

**改动内容**：新增 MIT 许可证文件，并在 README 中注明许可证。纯文档与许可信息更新，不改变扩展功能，因此不递增版本号。

**影响范围**：`LICENSE`、`README.md`。

---

## 文档变更：同步 GitHub 仓库名称

**日期**：2026-10-11

**改动内容**：README 中的文件夹示例同步为 GitHub 仓库名称 `chaoxing-auto-extension`。纯文档更新，不递增版本号。

**影响范围**：`README.md`。

---

## v1.0.18

**日期**：2026-10-11

**缺陷**：关闭调试浮层后，视频结束仍可能不进入下一个视频。

**原因**：超星播放器常在跨域 iframe 中。注入到播放器帧的脚本能检测到视频结束，但受同源策略限制，外层页面不能读取该视频；而“下一节”按钮在外层页面时，播放器帧找不到可点击目标。打开调试浮层会扰动页面并促使平台更新任务点标记，因而掩盖了这个跨帧通信缺口。

**改动内容**：
- 播放器帧检测到结束且本帧无法推进时，通过 `postMessage` 把结束信号发给顶层页面；顶层验证消息来自自身后代帧，再查找并点击下一节。
- `ended` 事件与结尾时间轮询共用该转发逻辑；重复消息在推进成功后去重，按钮尚未出现时允许后续轮询重试。

**影响范围**：`injected.js`、`manifest.json`、`README.md`。

**验证**：本次未运行测试；按项目说明，安装后需刷新扩展并刷新网课页面。

---

## v1.0.17

**日期**：本次改动

**上报缺陷**：「打开调试日志窗口时，'自动播放下一个视频'才生效；不开浮层就不生效」，
并要求排查是否还有其它功能隐式依赖调试窗口。

**排查结论（两件事）**：
1. **功能路径没有直接读 `debugLog` 开关**：全文只有 3 处使用——控制台输出、浮层渲染、
   一条焦点日志；`content.js` 只在关闭时删除浮层；面板的「运行记录」始终可见。
   所以不存在"直接耦合"。
2. **真实的间接耦合在这里**：此前"进入下一个视频"只有两个触发源——
   ① 平台标记（`aria-label=任务点已完成` / `ans-job-finished`）；② `ended` 事件。
   而开启浮层后，每次 `log()` 都会改写浮层 DOM，**持续触发超星页面自身的
   MutationObserver / 布局重算**，平台因此刷新任务点状态，我的轮询便看到了"已完成"→ 推进。
   换句话说：**我一直在等平台的标记，而平台的标记要靠页面被"惊动"才更新**——
   浮层恰好充当了那个"惊动者"。这是设计缺陷（依赖外部副作用），不是开关本身的问题。
3. 另发现两处**结构性隐患**：`step()` 静默吞掉安装异常（装了没装成功无从得知）；
   `installAutoPlay` 复用 `installAutoNext` 暴露的 `S.collectVideos`（一旦那一步失败，
   自动播放会连带失效）。

**改动内容**：
- **新增独立触发源：视频播到结尾即推进**（`mediaFinished()` + `advanceIfFinished()`）——
  判据为 `ended` 或 `currentTime >= duration - 1.2`，**不看平台标记、不看浮层**；
  按 `src|duration` 去重，同一个视频只推进一次。
- **安装失败不再静默**：`step()` 记录 `⚠ 安装失败: 组件 → 原因`，并在启动日志里汇总。
- **消除跨功能耦合**：`installAutoPlay` 自带 `localVideos()` 收集媒体，
  「下一节」组件缺失时自动播放照常工作。
- **常驻心跳诊断**（每 10 秒一条，与浮层开关无关，面板可见）：
  `心跳: 媒体=…(播放/暂停/结束) | 任务类型=… | 任务点=… | 自动播放=开/关 | 下一节=开/关 | 日志浮层=开/关`。
- **浮层重绘节流**（`repaintHud()`，首次立即、之后最多 300ms 一次）：
  把"开日志"对页面的 DOM 扰动降到最低，功能不再依赖它。

**影响范围**：`injected.js`（log/repaintHud、step、poll/心跳、mediaFinished/advanceIfFinished、
installAutoPlay.localVideos）、`tests/smoke-test.js`（新增 [10] 与浮层无关性/播完即推进 4 项）、
`tests/consistency-check.js`（新增 5 项断言）。

**测试**：`node tests/smoke-test.js` → 62 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## 文档变更（版本号不变）

**日期**：本次改动

**改动内容**：新增 **`SUMMARY.md`（阶段性总结）**——汇总 1.0.0 → 1.0.16 各版本的缺陷、
根因归类、修正方式、仍未闭环的问题与流程改进；并给出"人工验收清单"。
属纯文档变更，不影响插件行为，因此**不递增插件版本号**。

**影响范围**：新增 `SUMMARY.md`；`README.md` 文件结构补充该项；
`tests/consistency-check.js` 新增"SUMMARY.md 存在"断言。

---

## v1.0.16（当前）

**日期**：本次改动

**改动来源**：用户要求（1）全程静音，不要恢复声音；（2）再次研读完整油猴脚本，修复题目页仍无法跳过。

**改动内容**：
- **全程静音**：删除 `scheduleUnmute()`（不再恢复声音）。自动播放只负责"静音播放并保持"：
  暂停的就静音播起来；已经在播但被网站解除静音的，再按回静音。
- **题目页识别改用 iframe 的 src（借鉴成熟脚本的关键做法）**：
  新增 `taskKind()`——`api/work` → 作业/测验（题目）、`video|audio` → 视频音频、
  `modules/ppt|doc|pdf` → 文档；含一层嵌套 iframe。
  判定顺序调整为：**视频"在用"且当前不是可见的题目 iframe → 视频任务**；
  **可见的题目 iframe（api/work）→ 直接跳过**；其余按原逻辑。
  这样题目页不会再因为"页面上存在（残留的）视频元素"而被当成视频任务。
- **"下一步"按钮允许"置灰也点"**：`tryNextBySelector()` 两轮尝试——先用正常可点的，
  再试"看起来置灰"的（超星常只是样式变灰，实际仍可点），并在记录里注明。

**影响范围**：`injected.js`（taskKind、tryNextBySelector、poll 判定顺序、installAutoPlay 静音化、
prepareAutoplay/autoPlayVideos 去静音恢复）、`popup.html`（选项说明改为"全程静音"）、
`tests/smoke-test.js`（新增"题目 iframe 优先跳过"场景）、`tests/consistency-check.js`。

**测试**：`node tests/smoke-test.js` → 57 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.15

**日期**：上一轮改动

**改动来源**：用户提供了完整可用的油猴脚本（超星/智慧树网课小助手 0.2.7），逐段研读后借鉴其可靠做法。

**改动内容**：
- **新增独立选项「自动播放并保持」（`autoPlay`，默认开启）**：不再依赖「下一节」开关。
  只要这个选项开着（默认就是开的），扩展每 2 秒检查一次，把暂停中的视频播起来。
- **自动播放改用参考脚本的做法**：`pause()` 归位 → `muted = true` → `play()`。
  先静音是关键（静音自动播放不受浏览器策略限制），播放后再恢复声音。
- **借鉴到超星的真实选择器**：
  - 「下一章」按钮：`.nextChapter` / `.jb_btn_92` / `#prevNextFocusNext`（此前只按文字找，容易落空）；
  - 任务完成标记：`ans-job-finished`（class，从视频 iframe 沿祖先链向上找，只判断当前视频任务）。
- 自动播放遇到题目弹题时不抢播放（参考脚本的 `hasActiveQuiz()` 判断）。

**影响范围**：`injected.js`（新增 installAutoPlay/playOne，NEXT_SELECTORS/tryNextBySelector，
videoTaskFinished，poll 完成判定）、`content.js`、`background.js`、`popup.js`、`popup.html`
（新增开关）、`tests/smoke-test.js`（新增 [9] 自动播放独立选项 4 项断言）、`tests/consistency-check.js`。

**测试**：`node tests/smoke-test.js` → 56 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.14

**日期**：上一轮改动

**改动来源**：用户提供了一段成熟油猴脚本的自动播放实现，借鉴其中两个关键做法。

**改动内容**：
- **静音自动播放（关键）**：`play()` 之前先把视频 `muted = true`——静音播放不受浏览器
  自动播放策略限制；播放起来后再（在页面有过用户交互时）恢复声音。
  - 新增 `prepareAutoplay()`：把所有暂停中的视频临时静音并安排 800ms 后恢复声音；
  - 新增 `scheduleUnmute()`：恢复声音；若恢复导致视频又暂停，则再次 `play()`；
  - `clickPlayButton()` 点击播放器按钮前也先临时静音（播放器内部的 `play()` 同样受限）；
  - 全程用 `internalCall` 包裹，避免被扩展自己的"静音守卫"拦下。
- **题目弹题时不抢播放**：检测到题目弹题（`quizPageVisible()`）时不再强推播放，
  避免和"暂停视频让你答题"的平台行为打架（借鉴参考脚本的 `hasActiveQuiz()` 判断），
  并在运行记录里写一条说明。
- 抽出 `collectVideos()` 供多处复用（当前文档 + 同源子 iframe）。

**影响范围**：`injected.js`（collectVideos/prepareAutoplay/scheduleUnmute/autoPlayVideos/clickPlayButton）、
`tests/smoke-test.js`（新增"点击播放前先临时静音""自动播放先静音再播"两个断言）、
`tests/consistency-check.js`。

**测试**：`node tests/smoke-test.js` → 52 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.13

**日期**：上一轮改动

**改动内容**：
- **修复 v1.0.12 引入的回归：未完成的视频被误跳过**。原因是两处叠加：
  1. 我把"题目页"放到了最高优先级 → 视频页上只要有一点点题目特征就会被当成题目页跳过；
  2. 我把 `hasVideo()` 收得过紧（要求视频可见/在播）→ 真实视频页可能被判成"无视频"而跳过。
- 现在的判定顺序与分层：
  - `videoActive()`（**严格**）：视频正在播放 / 可见且未播完 / 存在超星播放器 iframe（按 URL）
    → 认定为**视频任务**，按完成与否处理（已完成→下一步；未完成→点播放按钮）；
  - 若视频"没在用"，才看是不是**题目页**（严格判定）→ 直接跳过，不判断完成；
  - 有视频元素但没在用、也不是题目页 → **保守当视频任务**（宁可等，也不误跳）；
  - 完全没有视频 → 非视频任务，直接点下一步。
  - `hasVideo()`（**宽松**）：只要存在 video/audio 元素或播放器 iframe 就算有视频。
- 题目页判定加严，避免视频页误判：题目容器必须有**实际尺寸**（≥120×60），
  题目特征文字需要**至少出现 2 个**，并去掉含义模糊的 `.mark_item`。

**影响范围**：`injected.js`（hasVideo/activeVideoIn/eachFrameDoc/videoActive/quizPageVisibleIn/poll）、
`tests/smoke-test.js`（新增"题目页（视频没在用）跳过"与"视频在用时不被题目元素误跳"两个场景）、
`tests/consistency-check.js`（新增判定顺序断言）。

**测试**：`node tests/smoke-test.js` → 50 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.12

**日期**：上一轮改动

**改动内容**：
- 修复"未完成的题目页仍然不能自动跳过"，三处改动：
  1. **题目页优先判定**：状态机第一优先级改为"页面是不是题目页"（超星题目容器
     `.TiMu`/`.questionLi`/`[class*="TiMu"]` 等 + 题目类型文字"单选题/多选题/判断题…"），
     命中就**直接跳过、不判断完成**——即使页面上同时存在视频也不会被当成视频任务；
  2. **视频判定更严格**：只有"正在播放"或"可见且未播完"的视频才算视频；
     隐藏的/残留的 `<video>`、以及不可见的播放器 iframe 不再算，避免题目页被误判成视频页；
     播放器 iframe 改为按 URL（`ananas/modules/video`、`video-js`、`.m3u8`、`.mp4`）判断。
  3. **找不到按钮时给出诊断**：运行记录里列出页面上可见的候选按钮（文字 + class），
     便于确定"下一步"到底是什么，而不必再靠猜。
- 附带改进：候选搜索扩展到同源子 iframe；新增按 class/id（`next`/`nextBtn`/`nextStep`…）
  匹配无文字按钮；跳过词表新增"跳过本题/不做"，下一步词表新增"下一题/继续观看/继续"。

**影响范围**：`injected.js`（installAutoNext 大范围调整）、`tests/smoke-test.js`
（新增"题目页有视频也跳过"场景）。

**测试**：`node tests/smoke-test.js` → 49 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.11

**日期**：上一轮改动

**改动内容**：
- 修正「下一节」状态机：**先判断有没有视频，再判断是否完成**。
  - 无视频（题目/阅读等非视频任务）→ 直接点下一步/跳过，**不判断任务点是否完成**；
  - 有视频 → 才判断：已完成 → 点下一步；未完成 → 点击播放按钮播放。
- 修正运行记录措辞，明确"非视频任务直接跳过、不判断完成"。

**影响范围**：`injected.js`（poll 判断顺序）、`tests/smoke-test.js`、`tests/consistency-check.js`。

**测试**：`node tests/smoke-test.js` → 47 通过 / 0 失败。

---

## v1.0.10

**日期**：上一轮改动

**改动内容**：
- 「下一节」自动播放改为**点击播放器中央的播放按钮**（`.vjs-big-play-button` / `[class*="big-play"]`），
  而不是只调 `video.play()`——没播过的新页面里 `video.play()` 常被浏览器自动播放策略拦截，
  点真实按钮更可靠；找不到按钮时再退回 `video.play()`。
- 状态机消息更新为：任务点已完成 → 点下一步；任务点未完成且有视频 → 点播放按钮；
  任务点未完成且无视频 → 点下一步找未完成视频（去掉"等播到 90%"的表述，90% 是平台自己的完成条件）。

**影响范围**：`injected.js`（clickPlayButton/clickPlayButtonsIn + poll）、`tests/smoke-test.js`
（新增播放按钮点击与回落 video.play 两场景）。

**测试**：`node tests/smoke-test.js` → 47 通过 / 0 失败。

---

## v1.0.9

**日期**：上一轮改动

**改动内容**：
- 诊断浮窗：
  - 拖动位置**持久化**（`S.hudPos`），浮窗被页面重渲染移除后重建时恢复原位置，不再跳回左上角；
  - 移除"每 2 秒重新 append 置顶"的定时器（这是拖动后跳回的诱因），改为纯 `position:fixed` + 最高 `z-index`；
  - 标题栏新增 **「清空日志」** 按钮，一键清空运行记录并插入分隔线，方便区分本次/上次运行。
- 修复顶层判定：`isTopFrame()` 用 try/catch 处理跨域 iframe，跨域子框架不再误画浮窗。
- **新增自动播放**：状态机在"有视频且任务点未完成"时，自动 `play()` 当前/子 iframe 里的暂停视频
  （点"下一步"落到新视频后常停在 0%，不自动播就到不了 90%、永远完不成）。
- 修复「任务点已完成」检测：`taskCompleted()` 现在也检查**同源子 iframe** 里的任务列表，
  并保留 `aria-label` 精确/前缀/子串 + `.ans-job-icon`/`role="option"` 的放宽匹配。

**影响范围**：`injected.js`（renderDebug/makeDraggable/taskCompleted/autoPlayVideos/poll）、
`tests/smoke-test.js`（新增自动播放与日志断言）。

**测试**：`node tests/smoke-test.js` → 46 通过 / 0 失败；
`node tests/consistency-check.js` → 一致性校验全部通过。

---

## v1.0.8

**日期**：上一轮改动

**改动内容**：
- 诊断浮窗重构：
  - 只在**顶层页面**画一个浮窗（此前每个 iframe 各画一个，叠成"多层"、有的跟随页面滚动）；
  - 改为**可拖动**的自由窗口（标题栏按住可拖到任意位置，`position:fixed` 不随页面滚动）；
  - 右侧**滚动条**浏览历史记录（保留最近 200 条；用户向上翻阅时不强制跳到底部，靠近底部才跟随最新）。
- 修复「任务点已完成」检测不到：`taskCompleted()` 之前对元素做了可见性过滤
  （`getBoundingClientRect` 0×0 就跳过），而超星的任务图标恰好是 0×0 渲染，导致误判。
  现在只认 `aria-label`（含 `任务点已完成`/`已完成` 前缀、子串、`.ans-job-icon`、`role="option"`），
  不再过滤可见性；文本兜底同步放宽。

**影响范围**：`injected.js`（renderDebug 重写 + makeDraggable + taskCompleted）、
`tests/smoke-test.js`（DOM 替身补齐 addEventListener/iframe 等）。

**测试**：`node tests/smoke-test.js` → 44 通过 / 0 失败。

---

## v1.0.7

**日期**：上一轮改动

**改动内容**：
- 修复「下一节」误判"无视频"：`hasVideo()` 现在连同**子 iframe** 一起检查——
  超星把播放器放在 iframe 里，父页面没有 `<video>`，此前父页面因此一直判定"无视频"
  而反复点下一步。现在：同源 iframe 直接查其 `contentDocument` 里的 video/audio；
  跨源 iframe 按 `src/id/class` 含 `video|player|ananas|m3u8|.mp4` 且可见来推断。
- 新增运行记录（日志）：
  - 状态变化时记录："检测到页面存在视频，等待播放完成" / "检测到任务点已完成" /
    "页面无视频元素"（只记状态切换，不刷屏）；
  - 执行每个步骤时记录：调用播放器 API、点击「跳过」、点击「下一步」，并注明触发原因；
  - "未找到下一步"按原因去重，避免每 2 秒刷一条。

**影响范围**：`injected.js`（hasVideo + poll/advance 日志）、`tests/smoke-test.js`
（新增 iframe 视频检测场景，共 8 场景）。

**测试**：`node tests/smoke-test.js` → 44 通过 / 0 失败。

---

## v1.0.6

**日期**：上一轮改动

**改动内容**：
- 重写「下一节」功能为**状态机轮询**，按超星任务点真实结构实现：
  - 任务点完成判定：`[aria-label="任务点已完成"]`（含 `aria-label*` 前缀匹配），
    文本兜底扫描 `.ans-job-icon`；
  - 轮询循环（每 2s）：任务点已完成 → 点"下一步"；否则无视频元素 → 直接点"下一步"
    （跨过答题/阅读等非视频页）；有视频且未完成 → 不动，等视频继续播放；
  - "下一步"匹配词表新增 `下一步`（原来只有 下一节/下一集/…）；
  - 推进节流：两次点击最小间隔 2500ms，避免页面跳转期间重复点击；
  - 点击目标过滤 `disabled`/`aria-disabled="true"`/含 `disabled|disable|gray|grey` 类的元素；
  - 答题页仍走"跳过/稍后/暂不"按钮，绝不替你作答；
  - 保留视频 `ended` 事件触发 + 播放器 API（`ananas.next` 等）兜底。
- 新增本文档（`CHANGELOG.md`）。

**影响范围**：`injected.js`（installAutoNext 整体重写）、`tests/smoke-test.js`
（[8] 用例改为任务点/无视频/跳过/关闭/播完六场景）、`tests/consistency-check.js`
（新增 CHANGELOG 存在性与版本号一致性断言）。

**测试**：`node tests/smoke-test.js` → 42 通过 / 0 失败。

---

## v1.0.5

**日期**：上一轮改动

**改动内容**：
- 新增「下一节」选项（`autoNext`）：视频 `ended` 后按 API → 跳过答题 → 文字匹配点下一节；
- 修复配置刷新 bug：改为共享配置对象（`S.cfg`）**就地刷新**，
  解决"切换开关未作用到已安装守卫"的问题；
- 面板新增「下一节」开关（含风险提示：跳过的答题不计分、可能被判不良行为）。

**影响范围**：`injected.js`、`content.js`、`background.js`、`popup.js`、`popup.html`、
`tests/*`、`README.md`。

---

## v1.0.4

**日期**：上一轮改动

**改动内容**：
- 修复关闭「调试日志」后左下角浮层不消失：主世界重注入时无条件 `renderDebug()`；
  内容脚本 `hideHudFromIsolatedWorld()` 兜底删除浮层 DOM；浮层重建时检测"脱离 DOM"。

**影响范围**：`injected.js`、`content.js`、`tests/smoke-test.js`（新增浮层开关回归用例）。

---

## v1.0.3

**日期**：上一轮改动

**改动内容**：
- 主世界运行状态验证从"读跨世界 window 变量"改为**读 DOM 属性**
  （主世界写 `data-nopause-installed`，内容脚本据此判定），消除"守卫在跑却显示未运行"的误报；
- 注入结果写 `data-nopause-verdict`；验证页支持 http 方式打开（file:// 不注入）。

**影响范围**：`injected.js`、`content.js`、`popup.js`、`tests/test-page.html`、`tests/serve.js`。

---

## v1.0.2

**日期**：上一轮改动

**改动内容**：
- **修复致命问题**：补上 MV3 的 `web_accessible_resources` 声明（此前主世界脚本从未在浏览器加载）；
- 注入自检：内容脚本确认主世界安装、失败原因写入日志。

**影响范围**：`manifest.json`、`content.js`、`popup.js`、`popup.html`、`tests/*`。

---

## v1.0.1

**日期**：上一轮改动

**改动内容**：
- 新增鼠标移出类事件拦截（`mouseout`/`mouseleave`/`pointerout`/`pointerleave`）；
- 新增超星 `window.ananas` / `ans` 播放器 API 守卫；
- 新增 `freeze`（Page Lifecycle）事件拦截；
- 新增焦点伪装（`hasFocus` 恒真、`activeElement` 兜底）；
- 面板内诊断日志（含调用栈来源）。

**影响范围**：`injected.js`、`content.js`、`popup.js`、`popup.html`、`README.md`。

---

## v1.0.0

**日期**：初版

**改动内容**：
- 初始版本：可见性伪装、事件拦截（`visibilitychange`/`blur`/`focusout`/`pagehide`）、
  暂停守卫、静音守卫、巡检抢救、图标与 README。

**影响范围**：全部初始文件。
