/**
 * dsh-peak-alert browser half — DeepSeek 峰谷定价提示插件（客户端）：
 *
 * 功能：
 * 1. 三档提示强度（设置 → 通用设置 → “峰谷定价提示强度”）：
 *    - 关闭：完全不提示（状态条与染色都隐藏），等同未安装；
 *    - 低：仅显示时段状态条 chip（高峰/空闲），输入卡片不染色；
 *    - 中：状态条 chip + 高峰时段输入卡片变淡红。
 *    强度持久化在 localStorage（`dsh-peak-alert:intensity`），刷新后保留。
 * 2. 自动识别当前是否为 DeepSeek 模型：匹配输入框右下角模型下拉按钮的
 *    aria-label/title（含“DeepSeek”字样即为 DeepSeek 模型）。仅当选择
 *    DeepSeek 模型时才启用峰谷提示；非 DeepSeek 模型时，仅在中档显示
 *    “当前非DeepSeek模型，不区分时段”提示（低档位状态条留空），输入卡片
 *    任何档位都不染色。检测时机：打开页面/切换会话（挂载时）、切换模型
 *    （MutationObserver 监听模型按钮）、窗口聚焦/标签页可见时。
 *
 * 纯客户端：`Intl.DateTimeFormat` 取北京时间，无需 API Key、零网络请求。
 * Bundle 格式遵循 dsh client-modules 加载器契约
 * （`window.__ModuleLoader__.load({ id, factory })`）。
 * @module dsh-peak-alert/client
 */

window.__ModuleLoader__.load({
	id: "dsh-peak-alert",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { useState, useEffect, useSyncExternalStore } = react;
		const { jsx } = react_jsx_runtime;
		// Shell 静态注册表词：DSH 应用自身的 UI 原语（Menu 下拉等），与内置设置面板同款样式
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Menu, IconChevronDownOutline14 } = primitives;

		/**
		 * Official DeepSeek 峰谷定价 schedule (Beijing time, since 2026-08-17):
		 * peak 09:00-12:00 and 14:00-18:00; off-peak is priced at half of peak,
		 * i.e. peak = 2× off-peak.
		 */
		const DAY_MINUTES = 24 * 60;

		/** Style tag identity + the peak-tint rules (scoped to the composer input card). */
		const PEAK_CSS_ID = "dsh-peak-alert/peak-tint";
		const PEAK_CSS = [
			`[data-composer-card]{transition:box-shadow .25s ease,border-color .25s ease;}`,
			// Inset overlay keeps the card's own theme background (var(--dsw-specific-input-major))
			// and shadow while layering a light-red tint over the whole input card.
			`html[data-dsh-peak-alert="on"] [data-composer-card]{box-shadow:var(--dsw-shadow-lv2, 0 0 0 transparent), inset 0 0 0 9999px rgba(229,83,75,.14) !important;}`,
			`html[data-dsh-peak-alert="on"] [data-composer-card]{border-color:rgba(229,83,75,.5) !important;}`,
		].join("\n");

		/** Inject the peak-tint stylesheet once (idempotent). */
		function ensurePeakStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${PEAK_CSS_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-peak-alert";
			tag.dataset.pluginCss = PEAK_CSS_ID;
			tag.textContent = PEAK_CSS;
			document.head.appendChild(tag);
		}

		/** Toggle the peak state on the document root (drives the CSS tint). */
		function setPeakState(on) {
			if (typeof document === "undefined") return;
			const root = document.documentElement;
			if (on) root.dataset.dshPeakAlert = "on";
			else delete root.dataset.dshPeakAlert;
		}

		// ===================== 强度设置（localStorage 持久化） =====================

		const INTENSITY_KEY = "dsh-peak-alert:intensity";
		const INTENSITIES = ["off", "low", "medium"];
		const DEFAULT_INTENSITY = "medium";
		const intensityListeners = new Set();
		let intensity = DEFAULT_INTENSITY;

		function loadIntensity() {
			try {
				const stored = localStorage.getItem(INTENSITY_KEY);
				if (stored !== null && INTENSITIES.includes(stored)) intensity = stored;
			} catch {
				/* storage unavailable: keep default */
			}
		}
		function getIntensity() { return intensity; }
		function setIntensity(value) {
			if (!INTENSITIES.includes(value) || value === intensity) return;
			intensity = value;
			try { localStorage.setItem(INTENSITY_KEY, value); } catch { /* ignore */ }
			for (const fn of [...intensityListeners]) fn();
		}
		function subscribeIntensity(listener) {
			intensityListeners.add(listener);
			return () => { intensityListeners.delete(listener); };
		}
		loadIntensity();

		// ===================== 模型检测（非实时轮询） =====================

		const modelListeners = new Set();
		// 快照必须是稳定引用：useSyncExternalStore 按 Object.is 比较快照，
		// 每次返回新对象会导致无限重渲染、组件崩溃（状态条/染色随之消失）。
		const modelState = { snapshot: { name: undefined, isDeepSeek: false } };

		function setModel(name) {
			const isDeepSeek = typeof name === "string" && /deepseek/i.test(name);
			if (modelState.snapshot.name === name && modelState.snapshot.isDeepSeek === isDeepSeek) return;
			modelState.snapshot = { name, isDeepSeek };
			for (const fn of [...modelListeners]) fn();
		}
		function getModel() { return modelState.snapshot; }
		function subscribeModel(listener) {
			modelListeners.add(listener);
			return () => { modelListeners.delete(listener); };
		}

		/** 模型下拉触发按钮的 aria-label 前缀（zh/en）。 */
		const MODEL_ARIA_RE = /^(选择模型|Select model)/;

		/** 在 composer 内定位模型下拉按钮（唯一：aria-label 以“选择模型/Select model”开头）。 */
		function findModelButton() {
			const seat = document.querySelector("[data-composer-seat]");
			if (!seat) return undefined;
			const buttons = seat.querySelectorAll('button[aria-haspopup="menu"]');
			for (const button of buttons) {
				if (MODEL_ARIA_RE.test(button.getAttribute("aria-label") ?? "")) return button;
			}
			return undefined;
		}

		/** 读取当前模型名（title 取“·”前的部分；无 title 时取首个 span 文本）。 */
		function readModelName() {
			const button = findModelButton();
			if (!button) return undefined;
			const title = (button.getAttribute("title") ?? "").trim();
			if (title !== "") return title.split("·")[0].trim();
			const span = button.querySelector("span");
			return span !== null ? (span.textContent ?? "").trim() : undefined;
		}

		/** 模型按钮 MutationObserver：切换模型/按钮重挂时重新检测（事件驱动，非轮询）。 */
		let modelObserver = undefined;

		function armModelDetection() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
				setModel(readModelName());
				return;
			}
			if (modelObserver !== undefined) modelObserver.disconnect();
			modelObserver = undefined;
			const seat = document.querySelector("[data-composer-seat]");
			if (seat === null) {
				setModel(readModelName());
				return;
			}
			modelObserver = new MutationObserver(() => setModel(readModelName()));
			// 只监听属性（aria-label/title）与节点增删，不监听文本（避免打字触发）
			modelObserver.observe(seat, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ["aria-label", "title"],
			});
			setModel(readModelName());
		}

		// ===================== 峰谷时段 =====================

		/** Current hour (0-23) in Beijing time; falls back to local time. */
		function beijingHour(now) {
			try {
				const parts = new Intl.DateTimeFormat("en-US", {
					timeZone: "Asia/Shanghai",
					hour: "numeric",
					hour12: false,
				}).formatToParts(now);
				const hour = Number(parts.find((p) => p.type === "hour")?.value);
				if (!Number.isNaN(hour)) return hour % 24;
			} catch {
				/* fall through to local time */
			}
			return now.getHours();
		}

		/** Beijing-time minutes since midnight (0-1439). */
		function beijingMinutes(now) {
			return beijingHour(now) * 60 + now.getMinutes();
		}

		/**
		 * Peak/off-peak snapshot for a moment.
		 * @param now - the moment to classify.
		 * @returns period info: `peak`, plus the next transition as
		 *   `nextLabel` (e.g. "12:00 切空闲") and `remaining` minutes.
		 */
		function periodInfo(now) {
			const mins = beijingMinutes(now);
			const hh = Math.floor(mins / 60);
			const mm = mins % 60;
			const peak = (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 14 * 60 && mins < 18 * 60);

			let next;
			if (peak) {
				next = mins < 12 * 60 ? 12 * 60 : 18 * 60;
			} else {
				if (mins < 9 * 60) next = 9 * 60;
				else if (mins >= 12 * 60 && mins < 14 * 60) next = 14 * 60;
				else next = 9 * 60 + DAY_MINUTES; // after 18:00 → tomorrow 09:00
			}
			const remaining = next - mins;
			const nextHour = Math.floor((next % DAY_MINUTES) / 60);
			const nextMin = next % 60;
			const nextHh = String(nextHour).padStart(2, "0");
			const nextMm = String(nextMin).padStart(2, "0");
			const nextLabel = peak
				? `${nextHh}:${nextMm} 切空闲`
				: `${nextHh}:${nextMm} 切高峰`;

			return {
				peak,
				next,
				remaining,
				nextLabel,
				nowLabel: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
			};
		}

		// ===================== UI =====================

		/** Chip 通用内联样式（颜色由调用方覆盖）。 */
		const chipBaseStyle = {
			height: "22px",
			borderRadius: "999px",
			alignItems: "center",
			gap: "6px",
			padding: "0 8px",
			fontSize: "12px",
			lineHeight: "1",
			display: "inline-flex",
			position: "relative",
			cursor: "default",
			whiteSpace: "nowrap",
		};

		/**
		 * 状态条 chip + 输入卡片染色驱动。根据强度档位、模型与时段渲染：
		 * - 关闭：不渲染任何内容，不染色；
		 * - 低 + DeepSeek：渲染高峰/空闲 chip，不染色；
		 * - 低 + 非 DeepSeek：状态条留空，不染色；
		 * - 中 + DeepSeek：chip + 高峰时输入卡片变红；
		 * - 中 + 非 DeepSeek：渲染“当前非DeepSeek模型，不区分时段”中性 chip，不染色。
		 * @param props - slot-injected props（sessionId 用于会话切换时重新检测模型）。
		 */
		function PeakDockEntry(props) {
			const sessionId = props.sessionId;
			const [now, setNow] = useState(() => new Date());
			const level = useSyncExternalStore(subscribeIntensity, getIntensity);
			const model = useSyncExternalStore(subscribeModel, getModel);

			useEffect(() => {
				ensurePeakStyles();
				const timer = window.setInterval(() => setNow(new Date()), 10_000);
				const resync = () => {
					setNow(new Date());
					if (modelState.name === undefined) setModel(readModelName()); // 初次兜底
				};
				document.addEventListener("visibilitychange", resync);
				window.addEventListener("focus", resync);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", resync);
					window.removeEventListener("focus", resync);
				};
			}, []);

			// 打开页面 / 切换会话时重新挂载模型检测（observer 跟随当前 seat）
			useEffect(() => {
				armModelDetection();
			}, [sessionId]);

			const info = periodInfo(now);

			// 染色仅在“中档 + DeepSeek 模型 + 高峰时段”时开启
			const tintOn = level === "medium" && model.isDeepSeek && info.peak;
			useEffect(() => {
				setPeakState(tintOn);
				return () => setPeakState(false);
			}, [tintOn]);

			if (level === "off") return null;

			const danger = "var(--dsh-color-danger, #e5534b)";
			const success = "var(--dsh-color-success, #2da44e)";
			const neutral = "var(--dsh-color-text-secondary, #8b949e)";

			// 非 DeepSeek 模型：仅中档显示中性提示，任何档位不染色
			if (!model.isDeepSeek) {
				if (level !== "medium") return null;
				return jsx("button", {
					type: "button",
					style: {
						...chipBaseStyle,
						border: `1px solid ${neutral}55`,
						background: "transparent",
						color: "var(--dsh-color-text, inherit)",
					},
					title: model.name !== undefined
						? `当前模型：${model.name}（非 DeepSeek，不区分时段）`
						: "未检测到模型选择",
					"data-testid": "peak-alert-non-deepseek",
					children: [
						jsx("span", {
							style: {
								width: 7,
								height: 7,
								borderRadius: "50%",
								background: neutral,
								flex: "none",
								display: "inline-block",
							},
						}),
						jsx("span", { children: "当前非DeepSeek模型，不区分时段" }),
					],
				});
			}

			// DeepSeek 模型：高峰/空闲 chip
			const color = info.peak ? danger : success;
			const label = info.peak ? "⚠ 高峰时段 · 价格×2" : "空闲时段 · 价格×1";
			const title = info.peak
				? `DeepSeek 峰谷定价：当前为高峰时段（北京 ${info.nowLabel}），价格约为空闲时段的 2 倍。高峰时段：北京 09:00-12:00 / 14:00-18:00。约 ${info.remaining} 分钟后（${info.nextLabel}）。`
				: `DeepSeek 峰谷定价：当前为空闲时段（北京 ${info.nowLabel}），价格为高峰时段的一半。高峰时段：北京 09:00-12:00 / 14:00-18:00。约 ${info.remaining} 分钟后（${info.nextLabel}）。`;

			return jsx("button", {
				type: "button",
				style: {
					...chipBaseStyle,
					border: `1px solid ${color}66`,
					background: `${color}1a`,
					color: "var(--dsh-color-text, inherit)",
				},
				title,
				"data-testid": "peak-alert-chip",
				children: [
					jsx("span", {
						style: {
							width: 7,
							height: 7,
							borderRadius: "50%",
							background: color,
							flex: "none",
							display: "inline-block",
						},
					}),
					jsx("span", { children: label }),
					jsx("span", { style: { opacity: 0.65, fontSize: 11 }, children: info.nextLabel }),
				],
			});
		}

		/**
		 * 通用设置里的“峰谷定价提示强度”下拉行（关闭 / 低 / 中）。
		 * 使用 DSH 自身的 Menu 下拉组件（与设置面板其它选项同款样式），
		 * 读取/写入 localStorage 持久化的强度，React 响应式同步。
		 * @param props - slot-injected props（未使用）。
		 */
		function IntensitySettingsRow(props) {
			const level = useSyncExternalStore(subscribeIntensity, getIntensity);
			const [open, setOpen] = useState(false);
			const levelLabel = { off: "关闭", low: "低", medium: "中" };
			const triggerStyle = {
				height: "28px",
				borderRadius: "8px",
				border: "1px solid var(--dsh-color-border, #80808059)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				padding: "0 10px",
				cursor: "pointer",
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				whiteSpace: "nowrap",
			};
			return jsx("div", {
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "16px",
					width: "100%",
					padding: "6px 0",
				},
				children: [
					jsx("div", {
						children: [
							jsx("div", {
								style: { fontSize: 14, color: "var(--dsw-alias-label-primary, inherit)" },
								children: "峰谷定价提示强度",
							}),
							jsx("div", {
								style: { fontSize: 12, opacity: 0.72, color: "var(--dsw-alias-label-secondary, inherit)" },
								children: "关闭：完全禁用；低：仅显示时段状态条；中：状态条 + 高峰时输入卡片变红（仅 DeepSeek 模型生效）",
							}),
						],
					}),
					jsx(Menu, {
						open,
						onClose: () => { setOpen(false); },
						items: [
							{ id: "off", label: "关闭" },
							{ id: "low", label: "低" },
							{ id: "medium", label: "中" },
						],
						selectedId: level,
						onSelect: (id) => {
							setOpen(false);
							setIntensity(id);
						},
						align: "end",
						portal: true,
						anchor: jsx("button", {
							type: "button",
							style: triggerStyle,
							"aria-haspopup": "menu",
							"aria-expanded": open,
							onClick: () => { setOpen((value) => !value); },
							children: [levelLabel[level] ?? level, jsx(IconChevronDownOutline14, {})],
						}),
					}),
				],
			});
		}

		/** Required services: slots for the composer-dock + settings rows. */
		const inject = ["slots"];

		/**
		 * Register the peak-pricing chip into the composer dock band (order 110,
		 * just before the balance chip at 120) and the intensity dropdown into
		 * General settings.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.inject(["slots", "conversation"], (scope) => {
				scope.effect(() => scope.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-peak-alert",
					order: 110,
					inject: () => ({}),
				}, PeakDockEntry), "dsh-peak-alert: dock registration");

				scope.effect(() => scope.slots.register({
					name: "settings.general.item",
					id: "dsh-peak-alert-intensity",
					order: 30,
					inject: () => ({}),
				}, IntensitySettingsRow), "dsh-peak-alert: settings registration");
			});
		}

		exports.PeakDockEntry = PeakDockEntry;
		exports.IntensitySettingsRow = IntensitySettingsRow;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
