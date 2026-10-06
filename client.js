/**
 * Conversation screenshot — Client half.
 *
 * Adds two capture entries. The composer tool row keeps the whole-conversation
 * control: it renders the loaded transcript to a single full-length PNG and
 * writes that PNG to the system clipboard, falling back to a file download
 * when the browser refuses the clipboard write. Each finalized reply's action
 * row gains a per-turn control that captures exactly one Q&A turn — the user
 * message that opens it plus the model's reply up to the next user message.
 *
 * The picture is produced by cloning the loaded transcript, reading the
 * browser's own layout for every box and text line, and painting that clone
 * onto one canvas. No third-party rasterizer is involved.
 */

window.__ModuleLoader__.load({
  id: 'dsh-conversation-screenshot',
  factory(require) {
    const React = require('react');

    /* ------------------------------------------------------------------ *
     * Canvas painter
     * ------------------------------------------------------------------ */

    /**
     * The transcript is painted straight onto a canvas from the browser's own
     * layout: boxes come from `getBoundingClientRect`, and each text node's
     * exact line boxes come from `Range.getClientRects`. That keeps the whole
     * pipeline quick, avoids re-implementing layout, and — unlike an SVG
     * `foreignObject` capture, which taints the canvas in Chromium — leaves the
     * canvas exportable.
     */

    const MAX_AREA = 44_000_000;
    const MAX_SIDE = 16_000;

    /** Scale that keeps the canvas inside browser texture limits. */
    function captureScale(width, height) {
      let scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      if (width * height * scale * scale > MAX_AREA) {
        scale = Math.max(0.3, Math.sqrt(MAX_AREA / (width * height)));
      }
      if (width * scale > MAX_SIDE) scale = MAX_SIDE / width;
      if (height * scale > MAX_SIDE) scale = Math.min(scale, MAX_SIDE / height);
      return scale;
    }

    /** Wait for one paint, but never depend on a throttled animation frame. */
    function nextFrame() {
      return Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => resolve())),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }

    function waitForImages(root, timeout) {
      const pending = [...root.querySelectorAll('img')].filter((image) => !image.complete);
      if (pending.length === 0) return Promise.resolve();
      return Promise.race([
        Promise.all(
          pending.map(
            (image) =>
              new Promise((resolve) => {
                const done = () => resolve();
                image.addEventListener('load', done, { once: true });
                image.addEventListener('error', done, { once: true });
              }),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    }

    function roundedPath(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      const r = Math.min(radius, width / 2, height / 2);
      if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, r);
      else ctx.rect(x, y, width, height);
    }

    function pushClip(ctx, clip) {
      if (clip === null) return false;
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      return true;
    }

    /**
     * Split one text node into the lines the browser actually laid out, using
     * a caret rect per code point. Painting these runs at the browser's own
     * pen positions keeps every break point exact — re-fitting lines with
     * `measureText` drifts by a character on long nodes and drops the tail.
     */
    function collectTextLines(node, origin) {
      const lines = [];
      let current = null;
      let offset = 0;
      const range = document.createRange();
      for (const part of node.nodeValue) {
        const start = offset;
        offset += part.length;
        range.setStart(node, start);
        range.setEnd(node, offset);
        const rects = range.getClientRects();
        if (rects.length === 0) continue;
        const rect = rects[0];
        if (Math.abs(rect.top - (current === null ? -Infinity : current.rawTop)) <= 2) {
          current.text += part;
          if (rect.bottom - origin.top > current.bottom) current.bottom = rect.bottom - origin.top;
          continue;
        }
        // A zero-width box that does not continue the current line is a
        // collapsed space at a wrap boundary. A zero-width non-space that
        // does continue it shares a glyph with the previous part (ligature,
        // emoji sequence) and must still reach the painted text.
        if (rect.width === 0 || rect.height === 0) {
          if (current !== null && !/\s/u.test(part)) current.text += part;
          continue;
        }
        current = {
          rawTop: rect.top,
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          bottom: rect.bottom - origin.top,
          height: rect.height,
          text: part,
        };
        lines.push(current);
      }
      return lines;
    }

    /**
     * Walk the staged clone once, collecting boxes, text lines and images.
     */
    function collectScene(root, origin) {
      const boxes = [];
      const texts = [];
      const images = [];

      const collect = (node, clip) => {
        if (node.nodeType === 3) {
          const value = node.nodeValue;
          if (value === null || value.trim() === '') return;
          const parent = node.parentElement;
          if (parent === null) return;
          const style = getComputedStyle(parent);
          if (style.visibility !== 'visible') return;
          const lines = collectTextLines(node, origin);
          if (lines.length === 0) return;
          texts.push({
            lines,
            clip,
            font: style.font,
            color: style.color,
            letterSpacing: style.letterSpacing,
            direction: style.direction,
          });
          return;
        }
        if (node.nodeType !== 1) return;
        const element = node;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility !== 'visible') return;
        if (style.contentVisibility === 'hidden') return;
        const rect = element.getBoundingClientRect();
        const x = rect.left - origin.left;
        const y = rect.top - origin.top;
        const width = rect.width;
        const height = rect.height;
        let nextClip = clip;
        if (width > 0 && height > 0) {
          const background = style.backgroundColor;
          const radius = parseFloat(style.borderTopLeftRadius) || 0;
          const borderWidth = parseFloat(style.borderTopWidth) || 0;
          const borderStyle = style.borderTopStyle;
          const hasBorder =
            borderWidth > 0 &&
            borderStyle !== 'none' &&
            borderStyle !== 'hidden' &&
            borderStyle !== 'dashed' &&
            borderStyle !== 'dotted';
          if (
            (background !== '' && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') ||
            hasBorder ||
            radius > 0
          ) {
            boxes.push({
              x,
              y,
              width,
              height,
              background: background === 'rgba(0, 0, 0, 0)' ? null : background,
              radius,
              border: hasBorder ? { width: borderWidth, color: style.borderTopColor } : null,
              clip,
              opacity: Number(style.opacity === '' ? 1 : style.opacity),
            });
          }
          if (
            style.overflowX === 'hidden' ||
            style.overflowX === 'clip' ||
            style.overflowY === 'hidden' ||
            style.overflowY === 'clip'
          ) {
            nextClip = { x, y, w: width, h: height };
          }
        }
        if (element.tagName === 'IMG' && width > 0 && height > 0) {
          images.push({ element, x, y, width, height, radius: parseFloat(style.borderTopLeftRadius) || 0, clip: nextClip });
        }
        for (const child of node.childNodes) collect(child, nextClip);
      };

      collect(root, null);
      return { boxes, texts, images };
    }

    function paintBoxes(ctx, boxes, limit) {
      for (const box of boxes) {
        if (box.y > limit) continue;
        const clipped = pushClip(ctx, box.clip);
        ctx.globalAlpha = box.opacity > 0 ? Math.min(1, box.opacity) : 1;
        if (box.background !== null) {
          ctx.fillStyle = box.background;
          roundedPath(ctx, box.x, box.y, box.width, box.height, box.radius);
          ctx.fill();
        }
        if (box.border !== null) {
          ctx.strokeStyle = box.border.color;
          ctx.lineWidth = box.border.width;
          roundedPath(
            ctx,
            box.x + box.border.width / 2,
            box.y + box.border.width / 2,
            box.width - box.border.width,
            box.height - box.border.width,
            Math.max(0, box.radius - box.border.width / 2),
          );
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (clipped) ctx.restore();
      }
    }

    function paintTexts(ctx, texts, limit) {
      ctx.textBaseline = 'alphabetic';
      for (const item of texts) {
        if (item.lines.length === 0 || item.lines[0].top > limit) continue;
        const clipped = pushClip(ctx, item.clip);
        ctx.font = item.font;
        if (item.letterSpacing !== 'normal' && 'letterSpacing' in ctx) {
          ctx.letterSpacing = item.letterSpacing;
        }
        if (item.direction === 'rtl' && 'direction' in ctx) ctx.direction = 'rtl';
        ctx.fillStyle = item.color === 'rgba(0, 0, 0, 0)' ? 'transparent' : item.color;
        for (const line of item.lines) {
          if (line.top > limit) continue;
          if (line.text.trim() !== '') {
            ctx.fillText(line.text, line.left, line.bottom - Math.max(1, line.height * 0.22));
          }
        }
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        if ('direction' in ctx) ctx.direction = 'ltr';
        if (clipped) ctx.restore();
      }
    }

    function paintImages(ctx, images, limit) {
      for (const image of images) {
        if (image.y > limit) continue;
        try {
          const clipped = pushClip(ctx, image.clip);
          const rounded = image.radius > 0;
          if (rounded) {
            ctx.save();
            roundedPath(ctx, image.x, image.y, image.width, image.height, image.radius);
            ctx.clip();
          }
          ctx.drawImage(image.element, image.x, image.y, image.width, image.height);
          if (rounded) ctx.restore();
          if (clipped) ctx.restore();
        } catch {
          /* an undecodable image simply stays blank */
        }
      }
    }

    /**
     * Paint a staged clone into a PNG.
     * @returns the blob plus its pixel dimensions.
     */
    async function paintStage(stage, clone, { width, height, background, scale }) {
      await waitForImages(clone, 6000);
      await nextFrame();
      await nextFrame();

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('canvas is unavailable');

      const origin = stage.getBoundingClientRect();
      const scene = collectScene(clone, origin);
      ctx.save();
      ctx.scale(scale, scale);
      // Start from the resolved page background so translucent layers composite
      // onto the same colour the user sees.
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      paintBoxes(ctx, scene.boxes, height);
      paintTexts(ctx, scene.texts, height);
      paintImages(ctx, scene.images, height);
      ctx.restore();

      const blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
      if (blob === null) throw new Error('PNG encoding failed');
      return { blob, width: canvas.width, height: canvas.height, scale, elements: scene.boxes.length + scene.texts.length };
    }

    /* ------------------------------------------------------------------ *
     * Locale
     * ------------------------------------------------------------------ */

    const DICTS = {
      zh: {
        action: '对话截图',
        actionHint: '把整段对话长截图并复制到剪贴板',
        turnAction: '本轮截图',
        turnHint: '把这一轮问答截图并复制到剪贴板',
        preparing: '正在准备截图…',
        loadingHistory: '正在载入更早的对话…',
        rendering: '正在生成图片…',
        copied: '已复制长截图（{width}×{height}）',
        turnCopied: '已复制本轮截图（{width}×{height}）',
        copiedPartial: '已复制截图（仅含已加载的对话轮次）',
        downloaded: '剪贴板不可用，已改为下载 PNG',
        downloadedPartial: '剪贴板不可用，已改为下载 PNG（仅含已加载的轮次）',
        empty: '当前会话还没有可截图的内容',
        turnMissing: '没有找到这一轮的范围，刷新页面后重试',
        failed: '截图失败：{message}',
        scaled: '内容过长，已按 {scale} 倍缩放以避开画布上限',
      },
      en: {
        action: 'Conversation screenshot',
        actionHint: 'Copy a full-length screenshot of this conversation',
        turnAction: 'Turn screenshot',
        turnHint: 'Copy a screenshot of this question and its reply',
        preparing: 'Preparing screenshot…',
        loadingHistory: 'Loading earlier messages…',
        rendering: 'Rendering image…',
        copied: 'Long screenshot copied ({width}×{height})',
        turnCopied: 'Turn screenshot copied ({width}×{height})',
        copiedPartial: 'Screenshot copied (loaded turns only)',
        downloaded: 'Clipboard unavailable — PNG downloaded instead',
        downloadedPartial: 'Clipboard unavailable — PNG downloaded (loaded turns only)',
        empty: 'Nothing to capture in this conversation yet',
        turnMissing: 'Could not resolve this turn — reload the page and try again',
        failed: 'Screenshot failed: {message}',
        scaled: 'Very long content — scaled to {scale}× to stay within canvas limits',
      },
    };

    /** Set by `apply`; read lazily so a late locale service still works. */
    let localeRuntime = null;

    function activeLanguage() {
      if (localeRuntime === null) return 'zh';
      try {
        const snapshot = localeRuntime.getSnapshot();
        return /^zh(?:-|$)/i.test(String(snapshot?.active ?? '')) ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    function translate(key, vars) {
      const dict = DICTS[activeLanguage()] ?? DICTS.zh;
      let text = dict[key] ?? DICTS.zh[key] ?? key;
      if (vars !== undefined) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    }

    const localeListeners = new Set();

    function subscribeLocale(listener) {
      localeListeners.add(listener);
      const off = localeRuntime?.subscribe?.(listener);
      return () => {
        localeListeners.delete(listener);
        if (typeof off === 'function') off();
      };
    }

    function useTranslate() {
      React.useSyncExternalStore(subscribeLocale, activeLanguage, activeLanguage);
      return translate;
    }

    /* ------------------------------------------------------------------ *
     * History paging
     * ------------------------------------------------------------------ */

    /** Live subtrees that must never reach the picture. */
    function isSkipped(node) {
      return (
        node.hasAttribute('data-composer-seat') ||
        node.hasAttribute('data-composer-stats') ||
        node.hasAttribute('data-dsh-screenshot-skip') ||
        node.getAttribute('role') === 'navigation'
      );
    }

    /**
     * Prune skipped descendants from the clone. The painter reads the clone, so
     * the live elements — including the composer the user may be typing in —
     * are never touched.
     */
    function dropSkipped(clone, depth) {
      for (const child of [...clone.children]) {
        if (isSkipped(child)) child.remove();
        else if (depth > 0) dropSkipped(child, depth - 1);
      }
    }

    /** Replace media the canvas cannot paint and drop the ones it must not. */
    function sanitizeClone(live, clone) {
      const liveChildren = live.children;
      const cloneChildren = clone.children;
      for (let index = 0; index < cloneChildren.length; index += 1) {
        const child = cloneChildren[index];
        const source = liveChildren[index];
        if (child.tagName === 'IMG') {
          child.removeAttribute('loading');
          child.removeAttribute('decoding');
          child.removeAttribute('srcset');
          child.removeAttribute('sizes');
          continue;
        }
        if (
          child.tagName === 'VIDEO' ||
          child.tagName === 'AUDIO' ||
          child.tagName === 'IFRAME' ||
          child.tagName === 'OBJECT'
        ) {
          child.remove();
          continue;
        }
        if (source !== undefined) sanitizeClone(source, child);
      }
    }

    const LOAD_OLDER_LABELS = [
      '加载更早',
      '载入更早',
      '加载历史',
      'load older',
      'load earlier',
      'older messages',
      'earlier messages',
    ];

    /**
     * The paging control, never transcript prose that merely mentions paging:
     * one real control whose own label is essentially the paging wording.
     */
    function findLoadOlder(root) {
      for (const candidate of root.querySelectorAll('button, [role="button"]')) {
        const own = `${candidate.textContent ?? ''} ${candidate.getAttribute('aria-label') ?? ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (own === '' || own.length > 24) continue;
        if (LOAD_OLDER_LABELS.some((needle) => own === needle || own.startsWith(needle))) return candidate;
      }
      return null;
    }

    /** Resolve once the scrollport stops changing, or the budget runs out. */
    function waitForStableHeight(scroller, timeout) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeout;
        let previous = scroller.scrollHeight;
        let stable = 0;
        const tick = () => {
          const current = scroller.scrollHeight;
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 4 || Date.now() > deadline) {
            resolve(current);
            return;
          }
          setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
      });
    }

    /**
     * Wait for one paging click to take effect: the transcript grows or the
     * app unmounts the control to report nothing older. The chat view can take
     * several seconds to land a page from the host — far longer than any
     * layout-settling window, so a stability wait alone reads "still loading"
     * as "no more pages".
     * @returns 'grown' | 'exhausted' | 'timeout'
     */
    async function waitForPageEffect(root, scroller, heightBefore, timeout) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (findLoadOlder(root) === null) {
          await waitForStableHeight(scroller, 4000);
          return 'exhausted';
        }
        if (scroller.scrollHeight > heightBefore) return 'grown';
        if (Date.now() > deadline) return 'timeout';
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    /**
     * Pull in every older page so the picture covers the whole loaded session.
     *
     * Paging is driven from the chat view's own control. A page can take
     * several seconds to land and the host's prepend pipeline can fail one
     * fetch while later ones succeed, so the control is re-clicked every few
     * seconds — the way a person drains the history — until it unmounts.
     *
     * @returns true when no older page remains and the transcript is fully
     *   loaded; false when paging stopped early.
     */
    async function loadFullHistory(root, onProgress) {
      const scroller = root.closest('[data-conversation-scroll]') ?? root;
      const restoreTop = scroller.scrollTop;
      const deadline = Date.now() + 150_000;
      let rounds = 0;
      try {
        while (Date.now() < deadline) {
          const control = findLoadOlder(root);
          if (control === null) return true;
          const before = scroller.scrollHeight;
          control.click();
          const effect = await waitForPageEffect(root, scroller, before, 6_000);
          if (effect === 'exhausted') return true;
          if (effect === 'grown') {
            rounds += 1;
            onProgress?.(rounds);
            // Let the prepended page settle before pulling the next one.
            await waitForStableHeight(scroller, 3000);
          }
        }
        return false;
      } finally {
        scroller.scrollTop = restoreTop;
      }
    }

    /* ------------------------------------------------------------------ *
     * Capture
     * ------------------------------------------------------------------ */

    const BACKGROUND_TOKENS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1'];

    function resolveBackground(element) {
      const view = element.ownerDocument.defaultView;
      const computed = view.getComputedStyle(element);
      if (computed.backgroundColor !== '' && computed.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        return computed.backgroundColor;
      }
      for (const token of BACKGROUND_TOKENS) {
        const value = computed.getPropertyValue(token).trim();
        if (value !== '') return value;
      }
      return view.getComputedStyle(element.ownerDocument.documentElement).backgroundColor || '#ffffff';
    }

    /**
     * The transcript body, excluding the composer seat that shares the scroller.
     * Session and view slots are layout-transparent wrappers with no area of
     * their own, so descend to the largest box that does have one.
     */
    function sizedDescendant(element, depth) {
      if (element.clientWidth > 0 || element.scrollHeight > 1) return element;
      if (depth <= 0) return null;
      let best = null;
      for (const child of element.children) {
        const candidate = sizedDescendant(child, depth - 1);
        if (candidate === null) continue;
        if (
          best === null ||
          candidate.scrollHeight > best.scrollHeight
        ) {
          best = candidate;
        }
      }
      return best;
    }

    function conversationRoot(anchor) {
      const scroller = anchor.closest('[data-conversation-scroll]');
      if (scroller === null) return null;
      let best = null;
      for (const child of scroller.children) {
        if (child.hasAttribute('data-composer-seat')) continue;
        if (child.querySelector('[data-composer-seat]') !== null) continue;
        const sized = sizedDescendant(child, 6);
        if (sized === null || sized.clientWidth <= 0) continue;
        if (best === null || sized.scrollHeight > best.scrollHeight) best = sized;
      }
      if (best !== null) return best;
      // No sized transcript box yet: capture the whole scroller rather than fail.
      return scroller.clientWidth > 0 ? scroller : null;
    }

    /**
     * Render the loaded conversation to one full-length PNG, or to just the
     * band of flow items pruned by `pruneClone` (one Q&A turn).
     * @param anchor - any element inside the conversation subtree.
     */
    async function captureConversation(anchor, pruneClone) {
      const content = conversationRoot(anchor);
      if (content === null) throw new Error('conversation not found');
      const document = content.ownerDocument;

      const width = Math.max(320, Math.round(content.clientWidth));
      const height = Math.max(1, Math.round(content.scrollHeight));
      if (height <= 1) throw new Error('empty');

      const background = resolveBackground(content);
      const contentStyles = document.defaultView.getComputedStyle(content);

      // The stage is painted behind the application so layout stays cheap (a far
      // off-screen box costs seconds), and it holds a clone, so the live
      // transcript and the composer the user may be typing in are untouched.
      const stage = document.createElement('div');
      stage.setAttribute('data-dsh-screenshot-stage', 'true');
      stage.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:0;' +
        `width:${width}px;height:${height}px;overflow:hidden;background:${background};` +
        `font-family:${contentStyles.fontFamily};color:${contentStyles.color};`;

      // The clone loses the transcript's ancestors, and with them every custom
      // property they define — chat column widths, paddings and theme tokens
      // hang off `var()` and would fall back to nothing. Re-export the whole
      // inherited set onto the stage so the clone resolves the same values.
      for (const name of contentStyles) {
        if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
          const value = contentStyles.getPropertyValue(name);
          if (value !== '') stage.style.setProperty(name, value);
        }
      }

      const clone = content.cloneNode(true);
      stage.appendChild(clone);
      document.body.appendChild(stage);

      try {
        dropSkipped(clone, 1);
        if (pruneClone !== undefined) pruneClone(clone);
        clone.style.setProperty('width', `${width}px`);
        clone.style.setProperty('height', 'auto');
        clone.style.setProperty('min-height', '0');
        clone.style.setProperty('max-height', 'none');
        clone.style.setProperty('overflow', 'visible');
        clone.style.setProperty('flex', 'none');
        clone.style.setProperty('background', background);
        sanitizeClone(content, clone);

        // A pruned band lays out far shorter than the live transcript, so the
        // final height always comes from the clone itself; the live height is
        // only a floor for the unpruned capture.
        const cloneHeight = Math.max(1, Math.round(clone.getBoundingClientRect().height));
        const measured = pruneClone === undefined ? Math.max(height, cloneHeight) : cloneHeight;
        stage.style.height = `${measured}px`;
        const scale = captureScale(width, measured);

        return await paintStage(stage, clone, { width, height: measured, background, scale });
      } finally {
        stage.remove();
      }
    }

    /* ------------------------------------------------------------------ *
     * Turn band
     * ------------------------------------------------------------------ */

    function precedes(a, b) {
      return a !== b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    function deepestCommonAncestor(a, b) {
      for (let node = a.parentElement; node !== null; node = node.parentElement) {
        if (node.contains(b)) return node;
      }
      return null;
    }

    /**
     * One Q&A turn spans the flow items from the user message that opens it
     * through the turn tail that owns the control, stopping before the next
     * user message. Returns the container plus the units to keep, or null
     * when the marks do not line up.
     */
    function turnBand(turnEl, root) {
      const marks = [...root.querySelectorAll('[data-chat-flow-kind="user"]')];
      let startMark = null;
      let endMark = null;
      for (const mark of marks) {
        if (startMark === null || precedes(mark, turnEl)) {
          if (startMark === null || precedes(startMark, mark)) startMark = mark;
        } else if (precedes(turnEl, mark)) {
          endMark = mark;
          break;
        }
      }
      if (startMark === null) return null;
      const container = deepestCommonAncestor(startMark, turnEl);
      if (container === null) return null;
      const units = [...container.children];
      const unitOf = (el) => {
        for (let node = el; node !== null && node.parentElement !== null; node = node.parentElement) {
          if (node.parentElement === container) return units.indexOf(node);
        }
        return -1;
      };
      const start = unitOf(startMark);
      let end = unitOf(turnEl);
      if (start < 0 || end < 0) return null;
      if (endMark !== null) {
        const stop = unitOf(endMark);
        if (stop > start) end = Math.max(end, stop - 1);
      }
      return { container, keep: new Set(units.slice(start, end + 1)) };
    }

    /**
     * Render one Q&A turn to a PNG. The band is resolved independently in the
     * clone (same structure, same mark order), keyed by the clicked tail's
     * index among the turn tails.
     * @param turnEl - the `[data-turn-tail]` wrapper that owns the control.
     */
    async function captureTurn(turnEl) {
      const root = conversationRoot(turnEl);
      if (root === null) throw new Error('conversation not found');
      const tailIndex = [...root.querySelectorAll('[data-turn-tail]')].indexOf(turnEl);
      if (tailIndex < 0) throw new Error('turn not found');
      if (turnBand(turnEl, root) === null) throw new Error('turn not found');
      return captureConversation(turnEl, (clone) => {
        const cloneTurn = [...clone.querySelectorAll('[data-turn-tail]')][tailIndex] ?? null;
        const band = cloneTurn === null ? null : turnBand(cloneTurn, clone);
        if (band === null) throw new Error('turn not found');
        for (const unit of [...band.container.children]) {
          if (!band.keep.has(unit)) unit.remove();
        }
      });
    }

    /* ------------------------------------------------------------------ *
     * Output
     * ------------------------------------------------------------------ */

    const canWriteClipboard =
      typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write !== undefined;

    /**
     * Write the PNG to the system clipboard.
     *
     * A browser whose document is not focused can leave `clipboard.write()`
     * pending forever instead of rejecting, so the write is raced against a
     * timeout: the caller always gets an answer and can fall back to a download.
     */
    async function copyPng(blob, timeout = 9000) {
      if (!canWriteClipboard) return false;
      try {
        const write = navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return await Promise.race([
          write.then(
            () => true,
            () => false,
          ),
          new Promise((resolve) => setTimeout(() => resolve(false), timeout)),
        ]);
      } catch {
        return false;
      }
    }

    function downloadPng(blob, sessionId) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const short = String(sessionId ?? 'session').slice(0, 8);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dsh-conversation-${short}-${stamp}.png`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }

    /** Shared plumbing behind the two capture entries. */
    function useCaptureStatus() {
      const t = useTranslate();
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const anchorRef = React.useRef(null);
      const timerRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      React.useEffect(
        () => () => {
          aliveRef.current = false;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
      );

      const announce = React.useCallback((next, hold) => {
        if (!aliveRef.current) return;
        setStatus(next);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        if (hold !== true) timerRef.current = setTimeout(() => setStatus(null), 4200);
      }, []);

      const run = React.useCallback(
        (produce) => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          setBusy(true);
          Promise.resolve()
            .then(() => produce(anchor, announce))
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              announce(
                message === 'empty'
                  ? t('empty')
                  : message === 'turn not found'
                    ? t('turnMissing')
                    : t('failed', { message }),
              );
            })
            .finally(() => {
              if (aliveRef.current) setBusy(false);
            });
        },
        [announce, t],
      );

      return { t, busy, status, anchorRef, announce, run };
    }

    /** Copy the picture to the clipboard, falling back to a download. */
    async function deliver(shot, { announce, t, sessionId, copiedKey = 'copied', partial = false }) {
      const copied = await copyPng(shot.blob);
      if (copied) {
        announce(
          partial
            ? t('copiedPartial')
            : t(copiedKey, { width: shot.width, height: shot.height }),
        );
      } else {
        downloadPng(shot.blob, sessionId);
        announce(partial ? t('downloadedPartial') : t('downloaded'));
      }
      if (shot.scale < 0.999) {
        setTimeout(() => announce(t('scaled', { scale: shot.scale.toFixed(2) })), 4300);
      }
    }

    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    function CameraIcon() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 15,
          height: 15,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        React.createElement('path', {
          d: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2a1 1 0 0 0 .83-.45l.94-1.4A1 1 0 0 1 10.3 3.7h3.4a1 1 0 0 1 .83.45l.94 1.4A1 1 0 0 0 16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z',
        }),
        React.createElement('circle', { cx: 12, cy: 13, r: 3.4 }),
      );
    }

    function ScreenshotButton({ sessionId }) {
      const { t, busy, status, anchorRef, announce, run } = useCaptureStatus();

      const produce = React.useCallback(
        async (anchor, announce) => {
          const root = conversationRoot(anchor);
          if (root === null) throw new Error('conversation not found');
          if (root.scrollHeight <= 1) throw new Error('empty');

          let historyComplete = true;
          if (findLoadOlder(root) !== null) {
            announce(t('loadingHistory'), true);
            historyComplete = await loadFullHistory(root);
          }

          announce(t('rendering'), true);
          const shot = await captureConversation(anchor);
          await deliver(shot, { announce, t, sessionId, partial: !historyComplete });
        },
        [announce, sessionId, t],
      );

      return React.createElement(
        'div',
        { className: 'cs-root', ref: anchorRef },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'cs-btn',
            disabled: busy,
            title: t('actionHint'),
            'aria-label': t('action'),
            'aria-busy': busy ? 'true' : undefined,
            onMouseDown: (event) => event.preventDefault(),
            onClick: (event) => {
              event.preventDefault();
              run(produce);
            },
          },
          busy ? React.createElement('span', { className: 'cs-spinner' }) : React.createElement(CameraIcon),
        ),
        status !== null &&
          React.createElement(
            'div',
            { className: 'cs-toast', role: 'status', 'aria-live': 'polite' },
            status,
          ),
      );
    }

    /**
     * Per-turn entry: lives in each finalized reply's action row and captures
     * exactly that turn — the user message that opens it plus everything the
     * model produced before the next user message.
     */
    function TurnScreenshotButton({ sessionId }) {
      const { t, busy, status, anchorRef, announce, run } = useCaptureStatus();

      const produce = React.useCallback(
        async (anchor, announce) => {
          const turnEl = anchor.closest('[data-turn-tail]');
          if (turnEl === null) throw new Error('turn not found');
          // Keep the action row (and this toast) on screen even when the row
          // is hover-revealed and the pointer wanders off mid-capture.
          const reveal = turnEl.getAttribute('data-actions-reveal');
          if (reveal === 'hover') turnEl.setAttribute('data-actions-reveal', 'always');
          try {
            announce(t('rendering'), true);
            const shot = await captureTurn(turnEl);
            await deliver(shot, { announce, t, sessionId, copiedKey: 'turnCopied' });
          } finally {
            if (reveal === 'hover') turnEl.setAttribute('data-actions-reveal', reveal);
          }
        },
        [announce, sessionId, t],
      );

      return React.createElement(
        'div',
        { className: 'cs-root', ref: anchorRef },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'cs-btn',
            disabled: busy,
            title: t('turnHint'),
            'aria-label': t('turnAction'),
            'aria-busy': busy ? 'true' : undefined,
            onMouseDown: (event) => event.preventDefault(),
            onClick: (event) => {
              event.preventDefault();
              run(produce);
            },
          },
          busy ? React.createElement('span', { className: 'cs-spinner' }) : React.createElement(CameraIcon),
        ),
        status !== null &&
          React.createElement(
            'div',
            { className: 'cs-toast', role: 'status', 'aria-live': 'polite' },
            status,
          ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only)
     * ------------------------------------------------------------------ */

    const STYLES = String.raw`
.cs-root { position: relative; display: flex; align-items: center; }
.cs-btn {
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  padding: 0;
}
.cs-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.cs-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.cs-btn:disabled { cursor: progress; color: var(--dsw-alias-state-idle-primary); }
.cs-spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.6px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: cs-spin .7s linear infinite;
}
@keyframes cs-spin { to { transform: rotate(360deg); } }
.cs-toast {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 320px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  white-space: normal;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
  z-index: 30;
  pointer-events: none;
}
`;

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const locale = ctx.locale;
      if (locale !== undefined && locale !== null) {
        localeRuntime = locale;
        ctx.effect(() => {
          const off = locale.subscribe(() => {
            for (const listener of [...localeListeners]) {
              try {
                listener();
              } catch {
                /* one bad listener must not break the rest */
              }
            }
          });
          return () => {
            off?.();
            if (localeRuntime === locale) localeRuntime = null;
          };
        }, 'conversation-screenshot: locale');
      }

      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-conversation-screenshot';
      style.textContent = STYLES;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'conversation-screenshot: styles');

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'conversation-screenshot',
            order: -10,
          },
          ScreenshotButton,
        ),
      );

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'conversation-screenshot-turn',
            order: 0,
          },
          TurnScreenshotButton,
        ),
      );
    }

    return { apply, inject };
  },
});
