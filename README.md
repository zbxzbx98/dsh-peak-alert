# dsh-peak-alert

DeepSeek 峰谷定价提示插件（DSH 客户端插件，纯前端，无后端依赖）。同一份代码同时兼容 DSH **0.1.x（`dsh web`）** 与 **0.2.x（桌面端 DeepSeek Harness）**。

时段规则（官方口径）：**北京时间周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天，均为空闲时段**。空闲时段价格为高峰的一半（高峰 ≈ 空闲 ×2）。

## 功能

**1. 三档提示强度（设置 → 通用设置 →「峰谷定价提示强度」）**

| 档位 | 时段状态条 chip | 输入卡片染色 |
|---|---|---|
| 关闭 | 不显示 | 无 |
| 低 | 显示（仅 DeepSeek 模型） | 无 |
| 中 | 显示 | 高峰时段变淡红 |

强度设置持久化在浏览器 `localStorage`（`dsh-peak-alert:intensity`，默认中），刷新/重启后保留。

**2. 输入卡片高峰染色（中档，DeepSeek 模型 + 高峰时段）**

高峰时段（北京时间周一至周五（**法定节假日除外**）09:00-12:00 / 14:00-18:00），**整个输入卡片（composer card）背景自动变为淡红色**（带红色描边），其他时间自动恢复原样。通过稳定的 `[data-composer-card]` 选择器定位，用 inset 阴影叠加淡红层（保留主题背景与阴影），只影响输入卡片本身；跨时段切换即时变色。

**3. 时段 chip**

输入框下方状态条（composer dock）显示彩色 chip：

- **高峰时段**：红色 `⚠ 高峰时段 · 价格×2`
- **空闲时段**：绿色 `空闲时段 · 价格×1`（价格为高峰的一半）
- **周末（周六、周日）**：`空闲时段（周末）· 价格×1`（全天按低谷价收取）
- **法定节假日**：`空闲时段（春节）· 价格×1`（带节假日名，全天按低谷价收取）

chip 上同时显示当前北京时间和下次切换时间。**下次切换会跳过周末与法定节假日**，并带上星期与日期避免歧义，例如：

- 普通工作日午休：`14:00 切高峰`
- 周五晚上：`周一 9/21 09:00 切高峰`
- 国庆假期中：`周四 10/8 09:00 切高峰`
- 春节假期前：`周二 2/24 09:00 切高峰`

悬停可查看完整时段说明与剩余时间（跨天显示为“2 天 23 小时后”）。每 10 秒自动刷新。

**4. 法定节假日识别（自动拉取 + 本地缓存）**

节假日表来自 [apisbo 法定节假日接口](https://api.apisbo.com/holidays/year/2026)（`https://api.apisbo.com/holidays/year/<年>`）：

- 只取 `type === "holiday"` 的条目作为法定节假日；`type === "workday"` 的**调休上班日一律忽略**——调休只是把周末改成上班日，而按官方口径周末本身就不是高峰，所以调休的周六/周日仍按低谷计价。
- 按年缓存到 `localStorage`（`dsh-peak-alert:holidays:v1`，正常数据 30 天；次年数据尚未公布时 1 天后再试）。命中缓存不发请求，并会在距年末 45 天时提前拉取次年数据，保证跨年时“下一个高峰”判断正确。
- **接口不可用（离线 / 被拦截 / 接口异常）时静默退化为“仅按周一至周五”判断**，chip 正常显示，悬停提示里会注明“法定节假日数据暂不可用，当前按周一至周五估算”。
- 请求为简单 GET（`credentials: omit`），只发送年份，不携带 cookie 与任何用户数据；返回内容按不可信外部数据处理（校验日期格式、过滤其它年份、清洗名称并限长）。

**5. DeepSeek 模型自动识别**

自动匹配输入框右下角模型下拉框当前模型名（含 "DeepSeek" 字样即判定为 DeepSeek 模型）：

- **DeepSeek 模型**：按档位正常显示时段提示与染色；
- **非 DeepSeek 模型**：仅在中档显示 `当前非DeepSeek模型，不区分时段`（灰色中性 chip），低档状态条留空；任何档位输入卡片都不染色。

检测时机：打开页面 / 切换会话（挂载时）、切换模型（MutationObserver 监听模型按钮）、窗口聚焦 / 标签页可见时，无需实时轮询。

## 安装

需要先确保 `pnpm` 在 PATH 中（`dsh plugin` 内部转发给 pnpm）。

**方式 A：从 GitHub 安装（推荐，无需 npm 账号）**

```sh
dsh plugin --profile web add https://github.com/zbxzbx98/dsh-peak-alert
```

**方式 B：本地开发（改代码后重启 dsh web 即生效）**

```sh
git clone https://github.com/zbxzbx98/dsh-peak-alert.git
dsh plugin --profile web add link:<绝对路径>/dsh-peak-alert
```

**桌面端（DeepSeek Harness）**：命令相同，把 `--profile web` 换成 `--profile desktop` 即可（桌面端 profile 与 Web profile 相互独立）：

```sh
dsh plugin --profile desktop add link:<绝对路径>/dsh-peak-alert
```

桌面端 `0.2.0-rc.2` 起图标命名与 `peerDependencies` 范围都变了，插件自 `0.2.1` 起同时兼容两代运行时；更早的插件版本（≤ `0.2.0`）在桌面端会被安装前检查拒绝（`incompatible-version`），并会在打开「设置 → 通用设置」时因图标改名而报错。

安装后**重启 `dsh web` 并刷新页面**（桌面端则退出并重新打开应用）：高峰时段输入卡片变淡红，输入框下方状态条出现时段 chip。

## 更新

**安装方式 A（GitHub）的用户**，拉取最新提交：

```sh
dsh plugin --profile web update dsh-peak-alert
```

若未能拉到最新（例如之前按 commit/tag 固定过版本），先移除再重装：

```sh
dsh plugin --profile web remove dsh-peak-alert
dsh plugin --profile web add https://github.com/zbxzbx98/dsh-peak-alert
```

更新后**重启 `dsh web` 并刷新页面**（客户端 bundle 按启动时的哈希加载，必须重启才生效）。

**安装方式 B（link: 本地开发）**无需以上操作，改源码后重启即生效。

想固定某个版本时，作者发布 tag（`git tag v0.1.0 && git push --tags`），用户可装指定版本：
`dsh plugin --profile web add github:zbxzbx98/dsh-peak-alert#v0.1.0`

## 卸载

```sh
dsh plugin --profile web remove dsh-peak-alert
```

## 说明

- 时段规则来自 DeepSeek 官方峰谷定价方案：高峰 = 北京**周一至周五（不含中国法定节假日）**09:00-12:00、14:00-18:00，空闲时段价格为高峰的一半（即高峰 ≈ 空闲 ×2）；**周末（周六、周日）与中国法定节假日全天不再区分峰谷，统一按低谷价收取**。
- 时段计算全部在浏览器完成（`Intl.DateTimeFormat` 取北京时间，不依赖本机时区）；唯一的外部请求是按年拉取第三方法定节假日表（见上文「法定节假日识别」）。
- 结构：`dsh.client` 客户端插件 + `dsh.bundle.patch`（cordis.patch.yml 注册 `dsh-peak-alert` 行），node 半端为无操作占位。
- 强度设置与节假日缓存存于浏览器 `localStorage`（非 DSH 设置文档），换浏览器/清缓存后会恢复默认（中档）并重新拉取节假日表。
- **多版本兼容**：插件依赖的两代运行时都保留的契约——DOM 钩子 `[data-composer-card]` / `[data-composer-seat]` / 模型按钮 `aria-haspopup="menu"` 与 aria-label、slot `conversation.composer.dock` 与 `settings.general.item`、`Menu` 的 `items[].id` / `selectedId` / `onSelect(id)` 语义、`window.__ModuleLoader__.load({ id, factory })` 加载协议。**唯一差异是图标命名**：0.1.x 用尺寸后缀（`IconChevronDownOutline14`），0.2.x 用字重后缀（`IconChevronDownOutlineRegular`），插件按「新名优先 → 旧名兜底 → 都没有就不渲染该装饰性图标」处理，避免 React 收到 `undefined` 组件直接抛错。
- **`peerDependencies` 的版本范围**：DSH 在安装前会用**运行时版本**去匹配这些范围（只检查名为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项），不匹配就报 `incompatible-version`。因此本插件声明为 `^0.1.0-rc.6 || ^0.2.0-rc.2`。将来出现新的运行时版本（如 0.3.x）需要同步放宽，或逐版本豁免：`dsh plugin --profile <profile> allow-version <包名@版本> --dsh-version <运行时版本> --accept-risk`（豁免按精确版本记录，插件升级与 DSH 升级都不继承）。

## 许可

MIT
