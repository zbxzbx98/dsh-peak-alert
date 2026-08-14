/**
 * dsh-peak-alert browser half — DeepSeek 峰谷定价提示：
 *
 * 1. 输入卡片高峰染色：高峰时段（北京 09:00-12:00 / 14:00-18:00）把整个输入
 *    卡片（composer card，即 uV2eYG_card 所在元素）染成淡红色。实现为全局
 *    样式 + <html data-dsh-peak-alert> 属性切换，通过稳定的
 *    `[data-composer-card]` 选择器定位卡片（inset box-shadow 叠加淡红层，
 *    保留主题背景色与阴影），React 重渲染不影响，重启/刷新后自动恢复。
 * 2. composer dock 里的时段 chip：显示当前高峰/空闲、价格倍率与下次切换时间。
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
		const { useState, useEffect } = react;
		const { jsx } = react_jsx_runtime;

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

		/**
		 * The composer dock chip + the input-card peak tint driver. Renders the
		 * period chip, and its effect syncs `data-dsh-peak-alert` on <html> so
		 * the whole composer card turns light red during peak hours.
		 * @param props - slot-injected props (unused beyond stability).
		 */
		function PeakDockEntry(props) {
			const [now, setNow] = useState(() => new Date());

			useEffect(() => {
				ensurePeakStyles();
				const timer = window.setInterval(() => setNow(new Date()), 10_000);
				const resync = () => setNow(new Date());
				document.addEventListener("visibilitychange", resync);
				window.addEventListener("focus", resync);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", resync);
					window.removeEventListener("focus", resync);
				};
			}, []);

			const info = periodInfo(now);

			// Drive the input tint: apply on mount / period flip, clear on unmount.
			useEffect(() => {
				setPeakState(info.peak);
				return () => setPeakState(false);
			}, [info.peak]);

			const danger = "var(--dsh-color-danger, #e5534b)";
			const success = "var(--dsh-color-success, #2da44e)";
			const color = info.peak ? danger : success;
			const label = info.peak ? "⚠ 高峰时段 · 价格×2" : "空闲时段 · 价格×1";
			const title = info.peak
				? `DeepSeek 峰谷定价：当前为高峰时段（北京 ${info.nowLabel}），价格约为空闲时段的 2 倍。高峰时段：北京 09:00-12:00 / 14:00-18:00。约 ${info.remaining} 分钟后（${info.nextLabel}）。`
				: `DeepSeek 峰谷定价：当前为空闲时段（北京 ${info.nowLabel}），价格为高峰时段的一半。高峰时段：北京 09:00-12:00 / 14:00-18:00。约 ${info.remaining} 分钟后（${info.nextLabel}）。`;

			return jsx(
				"button",
				{
					type: "button",
					style: {
						border: `1px solid ${color}66`,
						background: `${color}1a`,
						color: "var(--dsh-color-text, inherit)",
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
				},
			);
		}

		/** Required services: slots for the composer-dock entry. */
		const inject = ["slots"];

		/**
		 * Register the peak-pricing chip into the composer dock band, ordered
		 * just before the balance chip (order 120).
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
			});
		}

		exports.PeakDockEntry = PeakDockEntry;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
