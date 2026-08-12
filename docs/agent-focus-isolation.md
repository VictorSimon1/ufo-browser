# Agent 焦点与页面呈现隔离

UFO-Browser 的 Agent 控制必须是后台事务，不能成为 macOS 前台 Presentation 的隐式路由。Agent 可以导航、输入、点击和截图，但这些动作不得切换前台应用、移动系统鼠标或把后台页面挂到用户主窗口。

## 不变量

1. `bootstrapTaskSpace`、`useTaskSpace`、`Target.activateTarget` 和所有 Agent RPC 只改变连接选择、Space lease 或 Space 内 active tab，不调用 `showSpace()`、`window.show()`、`window.focus()` 或 `app.focus()`。
2. 主窗口的唯一产品状态仍是 `Presentation = overview | space(id)`。Agent 命令执行前后 Presentation 必须相同。
3. Overview 模式下，主窗口 native child tree 不能出现任何 page `WebContentsView`。后台页面只在需要 compositor 的时间内挂到共享 capture window。
4. capture window 必须保持透明、`opacity: 0`、不可聚焦、鼠标穿透、无阴影、不可缩放/最小化/最大化/全屏，并隐藏于 Mission Control；没有挂载页面时立即隐藏。
5. Agent 鼠标和键盘输入只通过目标页面 debugger 的 CDP `Input.*` 发送。不得使用系统级事件、Electron `sendInputEvent` 或移动 macOS cursor。
6. Agent ownership/进度广播可以更新 App 内 overlay 状态，但只有主窗口已经是 macOS focused window 时，overlay/page 才能成为 first responder。用户主动切回 UFO-Browser 时由窗口 `focus` 事件恢复 overlay 拦截。
7. 后台 surface attach、input/capture 和 detach 继续通过共享 surface queue 串行，并使用 per-view generation 防止旧异步任务重新挂载前台页面。

## 关于 CDP focus emulation

`Emulation.setFocusEmulationEnabled` 是 Chromium renderer 生命周期兼容手段，不是 macOS 窗口聚焦 API。UFO-Browser 仍在首次后台挂载时执行一次有界 `true → false` pulse，并在连续 `Input.*` 手势窗口内短暂启用它，以保持 Turnstile、OOPIF hit-test、`visibilityState` 和动画页面的兼容性。

不能仅凭名称推断它会抢系统焦点，也不应无证据移除。系统级回归已经同时记录 macOS foreground application、系统 cursor、Presentation 和 native view tree，证明当前 CDP focus emulation 不改变前台应用或鼠标位置。

## `update.md` 审阅结论

`.x-browser-test/update.md` 是历史实现说明和架构方法论参考，不是可直接覆盖当前代码的规范。当前采纳其中经过代码与实测支持的观点：

- Agent selection 与前台 Presentation 解耦；
- 后台页面使用不可聚焦、不可交互的 native compositor surface；
- Agent 输入只走 CDP；
- 共享 native surface 有界串行，Space 业务仍可独立并行；
- 验收直接比较系统焦点、cursor、Presentation 和 native attach 状态。

没有直接采纳的内容包括旧 `X-Browser` 命名、当前仓库不存在的模块/路径、未落地能力的完成声明，以及“为了避免系统焦点而一律关闭 renderer focus emulation”的推断。后者已被真实 macOS 证据否定；移除它还会增加 Turnstile/OOPIF 回退风险。

## 可重复验收

```bash
npm run verify:agent-focus-isolation
```

测试启动隔离 Profile，并验证两个场景：

1. 用户停留在 Overview，Agent 在后台 Space 导航、填写、点击和截图；主窗口始终只有 Overview，页面只存在于透明 capture surface。
2. UFO-Browser 已呈现 Agent Space，但用户切到另一个 macOS App；Agent 更新页面和 overlay 时，外部 App 仍保持前台。

两个场景都要求：

- 前台进程 PID 与 bundle id 完全不变；
- `CGEvent` 读取的系统 cursor 坐标完全不变；
- Presentation 前后完全一致；
- UFO-Browser 主窗口保持 unfocused；
- CDP 输入真实生效，截图有效且页面 viewport 非零；
- capture surface 的不可聚焦和透明属性与 native child 数量符合预期。

测试只在 macOS 运行，并在结束后恢复测试前的前台应用。
