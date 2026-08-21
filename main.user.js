// ==UserScript==
// @name         哔哩哔哩 URL 自动链接化
// @name:zh-CN   哔哩哔哩 URL 自动链接化
// @name:en      Bilibili URL Auto-Linkify
// @namespace    bililinkfix
// @version      1.1.0
// @description  动态识别 bilibili.com 各站点页面（www、直播、动态、专栏等）中未被标记为超链接的 URL 文本，自动替换为可点击的超链接，支持页面动态加载的内容（评论、动态、视频简介、弹幕等）。
// @description:zh-CN 动态识别 B 站各站点页面中未被标记为超链接的 URL 文本，自动替换为可点击的超链接，支持页面动态加载的内容（评论、动态、视频简介、弹幕等）。
// @author       DeepSeek v4 Flash
// @match        https://www.bilibili.com/*
// @match        http://www.bilibili.com/*
// @match        https://bilibili.com/*
// @match        http://bilibili.com/*
// @match        https://*.bilibili.com/*
// @match        http://*.bilibili.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 配置区：按需修改
     * ============================================================ */
    const CONFIG = {
        // 跳过这些标签内的文本，不进行链接化
        skipTags: ['A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
                   'CODE', 'PRE', 'KBD', 'SAMP', 'TT', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'TEMPLATE'],
        // 白名单模式：若此处非空，则只处理这些标签内的文本
        allowTags: [],
        // 生成链接的 class
        linkClass: 'bililinkfix-link',
        // 是否在新标签页打开
        openInNewTab: true,
        // 是否添加 rel="nofollow"
        addNoFollow: true,
        // 例外 URL 模式（glob 风格，* 为通配符，大小写不敏感）：
        // 文本中匹配这些模式的 URL 不会被转换为超链接，原样保留
        excludeUrlPatterns: [
            'https://www.nicovideo.jp/watch/*',
            'https://www.acfun.cn/v/*',
            'https://*.bilibili.com/*',
        ],
    };

    /* ============================================================
     * URL 匹配
     * ============================================================ */
    // URL 允许出现的字符：排除空白、尖括号、引号以及常见中文标点
    // （避免把中文标点吞进链接，也避免多个链接被合并成一个）
    const URL_CHARS = "[^\\s<>\"'`，。；：！？、（）【】《》〈〉「」『』“”‘’…]";

    // 匹配三类 URL：
    //   1. http(s)://... 或 ftp://...
    //   2. www.xxx.yyy...（www 开头，且至少包含两级域名，避免误伤 www.abc 之类的文本）
    //   3. B 站短链 b23.tv/xxx 或 bili2233.tv/xxx
    const URL_PATTERN = new RegExp(
        '(?:https?|ftp)://' + URL_CHARS + '+' +
        '|www\\.[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+' + URL_CHARS + '*' +
        '|(?:b23|bili2233)\\.tv/' + URL_CHARS + '+',
        'gi'
    );

    // 链接末尾不应包含的标点（会从链接中剥离，保留为普通文本）
    const TRAILING_PUNCT = /[.,;:!?。，；：！？…、"'`“”‘’）】》〉」』\]\)\}]+$/;

    /* ---------------- 例外 URL 匹配 ---------------- */
    // 把 glob 风格模式（* 通配符）转成正则：先按 * 切分并转义各段，再用 .* 连接
    function globToRegExp(glob) {
        const parts = String(glob).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
        return new RegExp('^' + parts.join('.*') + '$', 'i');
    }

    const EXCLUDE_PATTERNS = CONFIG.excludeUrlPatterns.map(globToRegExp);

    // 判断某个带协议的 URL 是否命中例外列表（http/https 变体都会比对）
    function isExcludedUrl(href) {
        if (!EXCLUDE_PATTERNS.length) return false;
        const variants = [href];
        if (/^https?:\/\//i.test(href)) {
            variants.push(href.replace(/^http(s?):\/\//i, (_, s) => (s ? 'http://' : 'https://')));
        }
        return EXCLUDE_PATTERNS.some((re) => variants.some((v) => re.test(v)));
    }

    const SKIP_TAGS = new Set(CONFIG.skipTags.map((t) => t.toUpperCase()));
    const ALLOW_TAGS = new Set(CONFIG.allowTags.map((t) => t.toUpperCase()));

    function shouldSkipTag(tagName) {
        if (ALLOW_TAGS.size) return !ALLOW_TAGS.has(tagName); // 白名单模式
        return SKIP_TAGS.has(tagName);
    }

    /* ============================================================
     * 核心：把一段纯文本拆分成 [文本 | 链接] 片段（纯函数，便于测试）
     * ============================================================ */
    function splitTextWithLinks(text) {
        const segments = [];
        URL_PATTERN.lastIndex = 0;
        let lastIndex = 0;
        let match;

        // 追加文本片段；若上一段也是文本则合并，避免产生相邻的文本段
        function pushText(value) {
            if (!value) return;
            const last = segments[segments.length - 1];
            if (last && last.type === 'text') {
                last.value += value;
            } else {
                segments.push({ type: 'text', value });
            }
        }

        while ((match = URL_PATTERN.exec(text)) !== null) {
            // 防御：零宽匹配不可能发生（各分支都要求至少 1 个字符），但保留保护
            if (match[0].length === 0) {
                URL_PATTERN.lastIndex++;
                continue;
            }

            const start = match.index;
            const raw = match[0];

            // 剥离结尾标点
            let url = raw;
            let punct = '';
            const pm = url.match(TRAILING_PUNCT);
            if (pm && pm.index > 0) {
                punct = pm[0];
                url = url.slice(0, pm.index);
            }

            // 链接前的普通文本
            if (start > lastIndex) {
                pushText(text.slice(lastIndex, start));
            }

            // 补全协议（www. / b23.tv 开头的链接默认走 https）
            let href = url;
            if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
                href = 'https://' + href;
            }

            // 例外 URL：不转换为超链接，原样保留为普通文本（含结尾标点）
            if (isExcludedUrl(href)) {
                pushText(raw);
                lastIndex = start + raw.length;
                continue;
            }

            segments.push({ type: 'link', value: url, href: href });

            // 结尾标点保留为普通文本
            pushText(punct);

            lastIndex = start + raw.length;
        }

        if (lastIndex < text.length) {
            pushText(text.slice(lastIndex));
        }

        return segments;
    }

    /* ============================================================
     * DOM 相关
     * ============================================================ */
    function isEditableNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const parent = node.parentElement;
        if (!parent) return false;
        if (typeof SVGElement !== 'undefined' && parent instanceof SVGElement) return false; // SVG 文本不处理

        let el = parent;
        while (el && el.nodeType === Node.ELEMENT_NODE) {
            if (shouldSkipTag(el.tagName)) return false;       // 指定跳过标签（含 A）
            if (el.isContentEditable) return false;            // 可编辑区域（输入框、评论编辑器等）
            if (el.hasAttribute('data-bililinkfix-ignore')) return false; // 手动忽略
            el = el.parentElement;
        }
        return true;
    }

    function processTextNode(textNode) {
        try {
            if (!isEditableNode(textNode)) return;
            const text = textNode.nodeValue;
            const segments = splitTextWithLinks(text);
            const hasLink = segments.some((s) => s.type === 'link');
            if (!hasLink) return;

            const frag = document.createDocumentFragment();
            for (const seg of segments) {
                if (seg.type === 'text') {
                    frag.appendChild(document.createTextNode(seg.value));
                } else {
                    const a = document.createElement('a');
                    a.href = seg.href;
                    a.textContent = seg.value;
                    if (CONFIG.openInNewTab) {
                        a.target = '_blank';
                        a.rel = 'noopener noreferrer' + (CONFIG.addNoFollow ? ' nofollow' : '');
                    } else if (CONFIG.addNoFollow) {
                        a.rel = 'nofollow';
                    }
                    if (CONFIG.linkClass) a.className = CONFIG.linkClass;
                    frag.appendChild(a);
                }
            }
            textNode.parentNode.replaceChild(frag, textNode);
        } catch (err) {
            console.warn('[BiliLinkFix] 处理文本节点失败:', err);
        }
    }

    function scanElement(root) {
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isEditableNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });
        // 先收集再处理，避免遍历过程中 DOM 被修改而漏掉节点
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(processTextNode);
    }

    /* ============================================================
     * 动态监听：处理页面异步加载 / 更新的内容
     * ============================================================ */
    let batchRoots = []; // 同一批次中已扫描过的根，避免重复扫描

    function processAddedNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            processTextNode(node);
            return;
        }
        if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            for (const child of node.childNodes) processAddedNode(child);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        // 若该节点位于本批次已扫描的子树内，则跳过
        for (const root of batchRoots) {
            if (root.contains(node)) return;
        }
        batchRoots.push(node);
        scanElement(node);
    }

    function startObserving() {
        const observer = new MutationObserver((mutations) => {
            batchRoots.length = 0; // 只对当前批次去重
            for (const m of mutations) {
                if (m.type === 'characterData') {
                    // 文本内容被直接改写
                    processTextNode(m.target);
                } else if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        processAddedNode(node);
                    }
                }
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    /* ============================================================
     * 样式：让生成的链接看起来像链接
     * ============================================================ */
    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            a.${CONFIG.linkClass} {
                color: #00aeec !important;
                text-decoration: underline !important;
                cursor: pointer !important;
            }
            a.${CONFIG.linkClass}:hover {
                color: #fb7299 !important;
            }
        `;
        document.head.appendChild(style);
    }

    /* ============================================================
     * 启动
     * ============================================================ */
    function init() {
        if (!document.body) return;
        injectStyle();
        // 先扫描一次现有内容（此时 observer 尚未挂载，不会收到自己造成的变更）
        scanElement(document.body);
        // 再监听后续所有变化（挂在 documentElement 上更稳健）
        startObserving();
        console.debug('[BiliLinkFix] 已启动，开始监听动态内容…');
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    /* ============================================================
     * 便于单元测试（浏览器中 module 未定义，此段不会执行）
     * ============================================================ */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { splitTextWithLinks, URL_PATTERN };
    }
})();
