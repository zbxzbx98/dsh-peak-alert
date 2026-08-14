# dsh-peak-alert

DeepSeek 峰谷定价提示插件（DSH Web 客户端插件，纯前端，无后端依赖）。

## 功能

**1. 输入卡片高峰染色（醒目提醒）**

高峰时段（北京时间 09:00-12:00 / 14:00-18:00），**整个输入卡片（composer card，输入框及其附属区域）背景自动变为淡红色**（带红色描边），空闲时段自动恢复原样。通过稳定的 `[data-composer-card]` 选择器定位，用 inset 阴影叠加淡红层（保留主题背景与阴影），只影响输入卡片本身；React 重渲染、页面刷新均不影响，跨时段切换即时变色。

**2. 时段 chip**

输入框下方状态条（composer dock）显示一个彩色 chip：

- **高峰时段**：红色 `⚠ 高峰时段 · 价格×2`
- **空闲时段**：绿色 `空闲时段 · 价格×1`（价格为高峰的一半）

chip 上同时显示当前北京时间和下次切换时间（如 `12:00 切空闲`），悬停可查看完整时段说明。每 10 秒自动刷新。

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

## 卸载

```sh
dsh plugin --profile web remove dsh-peak-alert
```

## 说明

- 时段规则来自 DeepSeek 官方 2026-08-17 生效的峰谷定价方案：高峰 = 北京 09:00-12:00、14:00-18:00，空闲时段价格为高峰的一半（即高峰 ≈ 空闲 ×2）。
- 纯浏览器端计算（`Intl.DateTimeFormat` 取北京时间），无需 API Key、不发起任何网络请求。
- 结构：`dsh.client` 客户端插件 + `dsh.bundle.patch`（cordis.patch.yml 注册 `dsh-peak-alert` 行），node 半端为无操作占位。

## 许可

MIT
