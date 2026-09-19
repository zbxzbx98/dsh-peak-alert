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
 * 3. 法定节假日：官方规则是“周一至周五（不含中国法定节假日）9:00-12:00、
 *    14:00-18:00 为高峰”，所以法定节假日全天按低谷计价；调休上班的周六/周日
 *    依旧是周末 → 依旧是低谷。节假日表来自 apisbo 法定节假日接口
 *    （`https://api.apisbo.com/holidays/year/<年>`，只取 type === "holiday"），
 *    按年缓存进 localStorage（`dsh-peak-alert:holidays:v1`，正常数据 30 天），
 *    拉不到时静默退回“仅按周一至周五”的旧规则并提示数据不可用。
 *
 * 时段计算全部在浏览器完成（`Intl.DateTimeFormat` 取北京时间）；唯一的外部
 * 请求是按年拉取上述第三方节假日表（不带 cookie，只发年份，无任何用户数据）。
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

		/** 星期名 → 数字（0=周日 … 6=周六）。 */
		const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
		/** 数字 → 中文星期名。 */
		const WEEKDAY_NUM_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

		/** 高峰时段边界（当日分钟数）：09:00-12:00、14:00-18:00。 */
		const PEAK_START_AM = 9 * 60;
		const PEAK_END_AM = 12 * 60;
		const PEAK_START_PM = 14 * 60;
		const PEAK_END_PM = 18 * 60;

		const MS_PER_DAY = 86_400_000;
		/**
		 * 向后搜索下一个高峰日的天数上限。正常最多十几天（春节/国庆长假），
		 * 留足余量的同时防止节假日数据异常时死循环。
		 */
		const NEXT_PEAK_MAX_DAYS = 45;

		/** 两位补零。 */
		function pad2(value) { return String(value).padStart(2, "0"); }

		/**
		 * 北京时间的日期/星期/时刻。判定价时段的唯一权威来源：
		 * 一次 formatToParts 取齐，避免跨字段不一致。
		 * @param now - the moment to classify.
		 * @returns 北京时间的年/月/日、`iso`（YYYY-MM-DD）、星期数字（0=周日）、
		 *   小时、分钟与是否周末。
		 */
		function beijingDateParts(now) {
			const names = WEEKDAY_NUM;
			let year = now.getFullYear();
			let month = now.getMonth() + 1;
			let day = now.getDate();
			let weekdayNum = now.getDay();
			let hour = now.getHours();
			let minute = now.getMinutes();
			try {
				const parts = new Intl.DateTimeFormat("en-CA", {
					timeZone: "Asia/Shanghai",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					weekday: "short",
					hour: "numeric",
					hour12: false,
					minute: "2-digit",
				}).formatToParts(now);
				const get = (type) => parts.find((p) => p.type === type)?.value;
				const y = Number(get("year"));
				if (!Number.isNaN(y)) year = y;
				const mo = Number(get("month"));
				if (!Number.isNaN(mo)) month = mo;
				const da = Number(get("day"));
				if (!Number.isNaN(da)) day = da;
				const wd = get("weekday");
				if (wd !== void 0 && names[wd] !== void 0) weekdayNum = names[wd];
				const h = Number(get("hour"));
				if (!Number.isNaN(h)) hour = h;
				const m = Number(get("minute"));
				if (!Number.isNaN(m)) minute = m;
			} catch {
				/* fall through to local time */
			}
			hour = ((hour % 24) + 24) % 24;
			const isWeekend = weekdayNum === 0 || weekdayNum === 6; // 周日或周六
			const iso = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
			return { year, month, day, iso, hour, minute, weekdayNum, isWeekend };
		}

		/** 把“当日分钟”格式化为 HH:MM。 */
		function toHHMM(mins) {
			return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
		}

		/** 民用日 → UTC 天序号（纯整数运算，不受本地时区/夏令时影响）。 */
		function dayIndex(year, month, day) {
			return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
		}

		/** UTC 天序号 → 该日的年/月/日、星期数字与 ISO 字符串。 */
		function dayFromIndex(index) {
			const dt = new Date(index * MS_PER_DAY);
			const year = dt.getUTCFullYear();
			const month = dt.getUTCMonth() + 1;
			const day = dt.getUTCDate();
			return {
				year,
				month,
				day,
				weekdayNum: dt.getUTCDay(),
				iso: `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
			};
		}

		/**
		 * 从今天起找下一个高峰日（09:00 起算）：跳过周六/周日（含调休上班的
		 * 周末）与法定节假日；今天已是工作日但 09:00 已过则顺延到之后。
		 * @param p - 北京时间日期部件（beijingDateParts 的结果）。
		 * @param mins - 当前时刻的当日分钟数。
		 * @param holidayOf - (isoDate) => 节假日名 | undefined。
		 * @returns 目标日部件 + `days`（距今天的天数，0 = 今天）。
		 */
		function nextPeakDay(p, mins, holidayOf) {
			const base = dayIndex(p.year, p.month, p.day);
			for (let d = 0; d <= NEXT_PEAK_MAX_DAYS; d += 1) {
				const cand = dayFromIndex(base + d);
				if (cand.weekdayNum === 0 || cand.weekdayNum === 6) continue; // 周末整天低谷
				if (holidayOf(cand.iso) !== undefined) continue; // 法定节假日整天低谷
				if (d === 0 && mins >= PEAK_START_AM) continue; // 今天 09:00 已过
				return { ...cand, days: d };
			}
			// 兜底：节假日数据异常（例如整年都被标成假日）时退回纯工作日规则。
			for (let d = 0; d <= 7; d += 1) {
				const cand = dayFromIndex(base + d);
				if (cand.weekdayNum === 0 || cand.weekdayNum === 6) continue;
				if (d === 0 && mins >= PEAK_START_AM) continue;
				return { ...cand, days: d };
			}
			return { ...dayFromIndex(base + 1), days: 1 };
		}

		/**
		 * Peak/off-peak snapshot for a moment，符合最新定价策略：
		 * - 高峰时段：北京周一至周五（法定节假日除外）09:00-12:00、14:00-18:00；
		 * - 其余（工作日空闲 + 周六/周日全天 + 法定节假日全天）都是低谷（空闲）；
		 * - 空闲时段价格为高峰的一半（高峰 ≈ 空闲 ×2）。
		 * @param p - 北京时间日期部件。
		 * @param holidayOf - (isoDate) => 节假日名 | undefined。
		 * @returns period info: `peak`、是否 `weekend`、`holiday`（法定节假日名，
		 *   非节假日为 undefined）、`remaining`（分钟）、`nowLabel`、`nowIso`、
		 *   `nextLabel`（下次切换，跨天带星期与日期）与 `nextIso`。
		 */
		function computePeriod(p, holidayOf) {
			const mins = p.hour * 60 + p.minute;
			const holidayName = holidayOf(p.iso);
			// 工作日 = 周一至周五且非法定节假日。调休上班的周六/周日不算工作日：
			// 官方规则以“周一至周五”定义高峰，所以调休的周末依旧按低谷计价。
			const isWorkday = !p.isWeekend && holidayName === undefined;

			if (isWorkday && ((p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18))) {
				const endMins = p.hour < 12 ? PEAK_END_AM : PEAK_END_PM;
				return {
					peak: true,
					weekend: false,
					holiday: undefined,
					remaining: endMins - mins,
					nextLabel: `${toHHMM(endMins)} 切空闲`,
					nextIso: p.iso,
					nowLabel: toHHMM(mins),
					nowIso: p.iso,
				};
			}

			// 空闲状态：找下一个高峰起点
			let remaining, nextLabel, nextIso;
			if (isWorkday && p.hour >= 12 && p.hour < 14) {
				// 工作日午休段 → 当天下午 14:00 起高峰（节假日没有这一档）
				remaining = PEAK_START_PM - mins;
				nextLabel = `${toHHMM(PEAK_START_PM)} 切高峰`;
				nextIso = p.iso;
			} else {
				// 下一个“工作日 09:00”（跳过周末与法定节假日；今天 09:00 已过则顺延）
				const target = nextPeakDay(p, mins, holidayOf);
				remaining = target.days * DAY_MINUTES + (PEAK_START_AM - mins);
				nextIso = target.iso;
				nextLabel = target.days === 0
					? `${toHHMM(PEAK_START_AM)} 切高峰`
					: `${WEEKDAY_NUM_ZH[target.weekdayNum]} ${target.month}/${target.day} ${toHHMM(PEAK_START_AM)} 切高峰`;
			}

			return {
				peak: false,
				weekend: p.isWeekend,
				holiday: holidayName,
				remaining,
				nextLabel,
				nextIso,
				nowLabel: toHHMM(mins),
				nowIso: p.iso,
			};
		}

		/** 把剩余分钟格式化为易读文本（跨天时用“天/小时”，避免“10020 分钟”）。 */
		function formatRemaining(mins) {
			if (mins < 60) return `${mins} 分钟`;
			if (mins < DAY_MINUTES) {
				const hours = Math.floor(mins / 60);
				const rest = mins % 60;
				return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
			}
			const days = Math.floor(mins / DAY_MINUTES);
			const hours = Math.floor((mins % DAY_MINUTES) / 60);
			return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`;
		}

		/**
		 * 当前时刻的峰谷快照。默认查模块级节假日缓存（由 ensureHolidays 维护），
		 * 离线测试可传入自定义 holidayOf。
		 * @param now - the moment to classify.
		 * @param holidayOf - 可选的自定义节假日判定，缺省用缓存。
		 */
		function periodInfo(now, holidayOf) {
			return computePeriod(beijingDateParts(now), holidayOf ?? holidayNameOf);
		}

		// ===================== 法定节假日（第三方接口 + localStorage 缓存） =====================

		/**
		 * 官方规则：高峰 = 周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00。
		 * 所以只需要“哪些日期是法定节假日”；接口里 type === "workday" 的调休上班日
		 * 一律忽略——调休只是把周末改成上班日，而周末本身按规则就不是高峰。
		 * 数据源：https://api.apisbo.com/holidays/year/<年>（返回 {date,name,type} 数组）。
		 */
		const HOLIDAY_API_BASE = "https://api.apisbo.com/holidays/year/";
		const HOLIDAY_CACHE_KEY = "dsh-peak-alert:holidays:v1";
		const HOLIDAY_CACHE_VERSION = 1;
		/** 缓存有效期：正常数据 30 天；空数据（次年尚未公布）1 天后再试。 */
		const HOLIDAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
		const HOLIDAY_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;
		/** 拉取失败后的重试间隔。 */
		const HOLIDAY_RETRY_MS = 5 * 60 * 1000;
		const HOLIDAY_TIMEOUT_MS = 12 * 1000;
		/** 距年末多少天内提前拉取次年数据（跨年时判断“下一个高峰”要用）。 */
		const HOLIDAY_LOOKAHEAD_DAYS = 45;
		const HOLIDAY_MAX_NAME_LENGTH = 16;
		const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

		/**
		 * 年 → `{ at: 拉取时间戳, count: 节假日数, days: { ISO 日期: 名称 } }`。
		 * days 用无原型对象，避免外部数据的键与 Object.prototype 撞名。
		 */
		const holidayCache = { version: HOLIDAY_CACHE_VERSION, years: Object.create(null) };
		const holidayInflight = new Map();
		const holidayLastAttempt = new Map();
		const holidayListeners = new Set();
		let holidayRevision = 0;
		/** 最近一次拉取失败的原因（仅供 UI 提示，不影响计算）。 */
		let holidayError = undefined;

		/** 清洗接口返回的节假日名（外部数据，收敛后才渲染/存储）。 */
		function sanitizeHolidayName(value) {
			if (typeof value !== "string") return undefined;
			const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
			if (cleaned === "") return undefined;
			return cleaned.length > HOLIDAY_MAX_NAME_LENGTH ? cleaned.slice(0, HOLIDAY_MAX_NAME_LENGTH) : cleaned;
		}

		/**
		 * 解析接口响应，只保留 `year` 年内 type === "holiday" 的条目。
		 * 同时接受 `{ code, msg, data: [...] }` 与裸数组两种形态；
		 * 结构异常按“无数据”处理，不抛错（接口不可信，坏数据不能影响时段计算）。
		 * @param payload - 接口 JSON。
		 * @param year - 请求的年份（只收该年日期，避免污染其它年份的缓存）。
		 * @returns `{ days, count }`。
		 */
		function parseHolidayPayload(payload, year) {
			const rows = Array.isArray(payload)
				? payload
				: (payload !== null && typeof payload === "object" && Array.isArray(payload.data) ? payload.data : undefined);
			const days = Object.create(null);
			let count = 0;
			if (rows === undefined) return { days, count };
			const prefix = `${year}-`;
			for (const row of rows) {
				if (row === null || typeof row !== "object") continue;
				if (row.type !== "holiday") continue; // 调休上班日忽略
				const date = typeof row.date === "string" ? row.date : "";
				if (!ISO_DATE_RE.test(date) || !date.startsWith(prefix)) continue;
				const name = sanitizeHolidayName(row.name) ?? "法定节假日";
				if (days[date] === undefined) count += 1;
				days[date] = name;
			}
			return { days, count };
		}

		/** 某日是否为法定节假日：返回节假日名，非节假日/无数据返回 undefined。 */
		function holidayNameOf(iso) {
			const entry = holidayCache.years[iso.slice(0, 4)];
			if (entry === undefined) return undefined;
			return Object.prototype.hasOwnProperty.call(entry.days, iso) ? entry.days[iso] : undefined;
		}

		/** 该年是否已有节假日数据（决定 UI 是否提示“按周一至周五估算”）。 */
		function hasHolidayData(year) {
			return holidayCache.years[String(year)] !== undefined;
		}

		/** 读取 localStorage 缓存；键与值都做校验，坏数据直接忽略。 */
		function loadHolidayCache() {
			let raw;
			try {
				raw = localStorage.getItem(HOLIDAY_CACHE_KEY);
			} catch {
				return; // storage unavailable
			}
			if (raw === null || raw === "") return;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return;
			}
			if (parsed === null || typeof parsed !== "object" || parsed.version !== HOLIDAY_CACHE_VERSION) return;
			const years = parsed.years;
			if (years === null || typeof years !== "object") return;
			for (const key of Object.keys(years)) {
				if (!/^\d{4}$/.test(key)) continue;
				const entry = years[key];
				if (entry === null || typeof entry !== "object") continue;
				const at = Number(entry.at);
				if (!Number.isFinite(at) || at <= 0) continue;
				const days = Object.create(null);
				let count = 0;
				if (entry.days !== null && typeof entry.days === "object") {
					for (const iso of Object.keys(entry.days)) {
						if (!ISO_DATE_RE.test(iso) || !iso.startsWith(`${key}-`)) continue;
						const name = sanitizeHolidayName(entry.days[iso]);
						if (name === undefined) continue;
						days[iso] = name;
						count += 1;
					}
				}
				holidayCache.years[key] = { at, count, days };
			}
		}

		/** 写回 localStorage 缓存；失败静默（内存缓存照常生效）。 */
		function saveHolidayCache() {
			try {
				localStorage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify({
					version: HOLIDAY_CACHE_VERSION,
					years: holidayCache.years,
				}));
			} catch {
				/* storage unavailable / quota exceeded: keep the in-memory cache */
			}
		}

		/** 通知订阅者（节假日数据或拉取状态变化）。 */
		function bumpHolidayRevision() {
			holidayRevision += 1;
			for (const listener of [...holidayListeners]) listener();
		}
		function subscribeHolidays(listener) {
			holidayListeners.add(listener);
			return () => { holidayListeners.delete(listener); };
		}
		function getHolidayRevision() { return holidayRevision; }

		/** 该年的节假日数据是否需要（重新）拉取。 */
		function holidayNeedsFetch(year) {
			if (holidayInflight.has(year)) return false;
			const last = holidayLastAttempt.get(year);
			if (last !== undefined && Date.now() - last < HOLIDAY_RETRY_MS) return false; // 失败退避
			const entry = holidayCache.years[String(year)];
			if (entry === undefined) return true;
			return Date.now() - entry.at > (entry.count === 0 ? HOLIDAY_EMPTY_TTL_MS : HOLIDAY_TTL_MS);
		}

		/** 拉取并解析某年的法定节假日表。 */
		function fetchHolidayYear(year) {
			const controller = typeof AbortController === "function" ? new AbortController() : undefined;
			const timer = controller === undefined
				? undefined
				: setTimeout(() => { controller.abort(); }, HOLIDAY_TIMEOUT_MS);
			return fetch(`${HOLIDAY_API_BASE}${year}`, {
				method: "GET",
				headers: { accept: "application/json" },
				credentials: "omit", // 不向第三方接口携带 cookie
				signal: controller === undefined ? undefined : controller.signal,
			}).then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json();
			}).then((payload) => parseHolidayPayload(payload, year)).finally(() => {
				if (timer !== undefined) clearTimeout(timer);
			});
		}

		/**
		 * 确保“当前北京年（年末 45 天内再加次年）”的节假日数据可用：
		 * 命中缓存不发请求，否则后台拉取；失败静默退化为“仅按周一至周五”。
		 * 幂等且带退避，可以安全地周期性调用。
		 * @param now - 用于确定当前北京年份的时刻。
		 */
		function ensureHolidays(now) {
			if (typeof fetch !== "function") return;
			const p = beijingDateParts(now);
			const years = [p.year];
			if (dayIndex(p.year, 12, 31) - dayIndex(p.year, p.month, p.day) <= HOLIDAY_LOOKAHEAD_DAYS) {
				years.push(p.year + 1); // 跨年判断“下一个高峰”需要次年数据
			}
			for (const year of years) {
				if (!holidayNeedsFetch(year)) continue;
				holidayLastAttempt.set(year, Date.now());
				holidayError = undefined;
				const task = fetchHolidayYear(year).then((result) => {
					holidayCache.years[String(year)] = { at: Date.now(), count: result.count, days: result.days };
					saveHolidayCache();
					bumpHolidayRevision();
				}, (error) => {
					holidayError = error instanceof Error ? error.message : String(error);
					bumpHolidayRevision(); // 让 UI 提示“节假日数据暂不可用”
				}).finally(() => {
					holidayInflight.delete(year);
				});
				holidayInflight.set(year, task);
			}
		}

		/** 是否已有当前年的节假日数据（供 UI 提示）。 */
		function holidayDataStatus(now) {
			if (holidayError !== undefined) return "error";
			return hasHolidayData(beijingDateParts(now).year) ? "ready" : "loading";
		}

		loadHolidayCache();

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
			// 订阅节假日数据版本：拉到/刷新节假日表后触发重算（值本身不参与渲染）
			const holidayRevision = useSyncExternalStore(subscribeHolidays, getHolidayRevision);
			void holidayRevision;

			useEffect(() => {
				ensurePeakStyles();
				const refresh = () => {
					setNow(new Date());
					// 关闭档位时不做任何节假日请求
					if (getIntensity() !== "off") ensureHolidays(new Date());
				};
				refresh();
				const timer = window.setInterval(refresh, 10_000);
				const resync = () => {
					refresh();
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

			// DeepSeek 模型：高峰/空闲 chip（周末与法定节假日全天低谷）
			const color = info.peak ? danger : success;
			const label = info.peak
				? "⚠ 高峰时段 · 价格×2"
				: info.holiday !== undefined
					? `空闲时段（${info.holiday}）· 价格×1`
					: info.weekend
						? "空闲时段（周末）· 价格×1"
						: "空闲时段 · 价格×1";
			const scheduleText = "高峰时段（不含法定节假日）：北京周一至周五 09:00-12:00 / 14:00-18:00；其余时段（含周末及法定节假日全天）按低谷价收取";
			const holidayNote = holidayDataStatus(now) === "ready"
				? ""
				: "；法定节假日数据暂不可用，当前按“周一至周五”估算";
			const nowText = `北京 ${info.nowIso} ${info.nowLabel}`;
			const remainingText = `约 ${formatRemaining(info.remaining)}后（${info.nextLabel}）`;
			const title = info.peak
				? `DeepSeek 峰谷定价：当前为高峰时段（${nowText}），价格约为空闲时段的 2 倍。${scheduleText}。${remainingText}${holidayNote}。`
				: info.holiday !== undefined
					? `DeepSeek 峰谷定价：当前为法定节假日低谷时段（${info.holiday}，${nowText}），全天按低谷价收取。${scheduleText}。${remainingText}${holidayNote}。`
					: info.weekend
						? `DeepSeek 峰谷定价：当前为周末低谷时段（${nowText}），全天按低谷价收取。${scheduleText}。${remainingText}${holidayNote}。`
						: `DeepSeek 峰谷定价：当前为空闲时段（${nowText}），价格为高峰时段的一半。${scheduleText}。${remainingText}${holidayNote}。`;

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
		/**
		 * 纯逻辑出口，只给离线测试脚本（lib/_holidaytest.mjs）用：
		 * 这些函数不碰 DOM、可脱离浏览器环境校验峰谷/节假日计算。
		 */
		exports.__test = {
			WEEKDAY_NUM_ZH,
			PEAK_START_AM,
			PEAK_END_AM,
			PEAK_START_PM,
			PEAK_END_PM,
			HOLIDAY_CACHE_KEY,
			beijingDateParts,
			dayIndex,
			dayFromIndex,
			nextPeakDay,
			computePeriod,
			periodInfo,
			formatRemaining,
			parseHolidayPayload,
			sanitizeHolidayName,
			holidayNameOf,
			hasHolidayData,
			holidayDataStatus,
			loadHolidayCache,
			ensureHolidays,
		};
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
