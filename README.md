# dsh-peak-alert

DeepSeek 峰谷定价提示插件（DSH Web 客户端插件，纯前端，无后端依赖）。

## 功能

**1. 三档提示强度（设置 → 通用设置 →「峰谷定价提示强度」）**

| 档位 | 时段状态条 chip | 输入卡片染色 |
|---|---|---|
| 关闭 | 不显示 | 无 |
| 低 | 显示（仅 DeepSeek 模型） | 无 |
| 中 | 显示 | 高峰时段变淡红 |

强度设置持久化在浏览器 `localStorage`（`dsh-peak-alert:intensity`，默认中），刷新/重启后保留。

**2. 输入卡片高峰染色（中档，DeepSeek 模型 + 高峰时段）**

高峰时段（仅工作日，北京时间 09:00-12:00 / 14:00-18:00），**整个输入卡片（composer card）背景自动变为淡红色**（带红色描边），其他时间自动恢复原样。通过稳定的 `[data-composer-card]` 选择器定位，用 inset 阴影叠加淡红层（保留主题背景与阴影），只影响输入卡片本身；跨时段切换即时变色。

**3. 时段 chip**

输入框下方状态条（composer dock）显示彩色 chip：

- **高峰时段（仅工作日）**：红色 `⚠ 高峰时段 · 价格×2`
- **空闲时段**：绿色 `空闲时段 · 价格×1`（价格为高峰的一半）
- **周末（周六、周日）**：绿色 `空闲时段（周末）· 价格×1`（全天按低谷价收取，不再区分峰谷）

chip 上同时显示当前北京时间和下次切换时间（如 `12:00 切空闲` / `周一 09:00 切高峰`，跨天会带星期），悬停可查看完整时段说明。每 10 秒自动刷新。

**4. DeepSeek 模型自动识别**

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

安装后**重启 `dsh web` 并刷新页面**：高峰时段输入卡片变淡红，输入框下方状态条出现时段 chip。

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

- 时段规则来自 DeepSeek 官方峰谷定价方案：高峰（仅工作日）= 北京 09:00-12:00、14:00-18:00，空闲时段价格为高峰的一半（即高峰 ≈ 空闲 ×2）；**周末（周六、周日）全天不再区分峰谷，统一按低谷价收取**。
- 纯浏览器端计算（`Intl.DateTimeFormat` 取北京时间），无需 API Key、不发起任何网络请求。
- 结构：`dsh.client` 客户端插件 + `dsh.bundle.patch`（cordis.patch.yml 注册 `dsh-peak-alert` 行），node 半端为无操作占位。
- 强度设置存于浏览器 `localStorage`（非 DSH 设置文档），换浏览器/清缓存后会恢复默认（中档）。

## 许可

MIT
