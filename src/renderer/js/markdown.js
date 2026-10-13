'use strict';

// Small, safe Markdown renderer. All text is HTML-escaped first; only a fixed set
// of tags is produced, and links are restricted to http(s).
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------ syntax highlight

  const KEYWORDS = new Set(
    (
      'abstract as async await break case catch class const continue def default del do elif else enum except export extends ' +
      'false final finally fn for from func function go if impl implements import in instanceof interface is lambda let loop match ' +
      'mod module mut new nil none null nonlocal not or and package pass private protected pub public raise return self static ' +
      'struct super switch this throw throws trait true try type typeof undefined union use using var void while with yield ' +
      'True False None int float str bool string char boolean long double byte short unsigned signed record val when object'
    ).split(' '),
  );
  const TOKEN_RE = /(\/\/[^\n]*|#(?![{\[])[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const HASH_COMMENT_LANGS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'r', 'ps1', 'powershell', 'dockerfile', 'makefile', 'perl', 'conf', 'ini', 'properties', 'sk', 'skript']);

  function highlight(code, lang) {
    lang = (lang || '').toLowerCase();
    if (['', 'text', 'txt', 'plain', 'output', 'console', 'log', 'diff'].includes(lang) || code.length > 60000) {
      if (lang === 'diff') {
        return code
          .split('\n')
          .map((l) => {
            const e = escapeHtml(l);
            if (l.startsWith('+')) return `<span class="hl-add">${e}</span>`;
            if (l.startsWith('-')) return `<span class="hl-del">${e}</span>`;
            if (l.startsWith('@@')) return `<span class="hl-meta">${e}</span>`;
            return e;
          })
          .join('\n');
      }
      return escapeHtml(code);
    }
    const hashComments = HASH_COMMENT_LANGS.has(lang);
    let out = '';
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(code))) {
      out += escapeHtml(code.slice(last, m.index));
      last = TOKEN_RE.lastIndex;
      const [tok, comment, str, num, word] = m;
      if (comment) {
        if (comment.startsWith('#') && !hashComments) {
          // not a comment in this language: re-scan after the '#'
          out += escapeHtml('#');
          TOKEN_RE.lastIndex = m.index + 1;
          last = m.index + 1;
          continue;
        }
        out += `<span class="hl-com">${escapeHtml(comment)}</span>`;
      } else if (str) out += `<span class="hl-str">${escapeHtml(str)}</span>`;
      else if (num) out += `<span class="hl-num">${num}</span>`;
      else if (word && KEYWORDS.has(word)) out += `<span class="hl-kw">${word}</span>`;
      else if (word && code[TOKEN_RE.lastIndex] === '(') out += `<span class="hl-fn">${word}</span>`;
      else out += escapeHtml(tok);
    }
    return out + escapeHtml(code.slice(last));
  }

  // ---------------------------------------------------------------- inline

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = escapeHtml(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" class="ext-link" title="${url}">${label}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) => `${pre}<a href="${url}" class="ext-link">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    return s;
  }

  // ----------------------------------------------------------------- block

  function codeBlock(code, lang) {
    const label = escapeHtml(lang || 'code');
    return `<div class="code-block"><div class="code-head"><span>${label}</span><button class="code-copy" type="button" title="Copy">Copy</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
  }

  function render(src) {
    const text = String(src || '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flushPara();
        const marker = fence[1];
        const lang = fence[2];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) buf.push(lines[i++]);
        i++; // closing fence (or end of text while streaming)
        out.push(codeBlock(buf.join('\n'), lang));
        continue;
      }
      if (!line.trim()) {
        flushPara();
        i++;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const level = Math.min(h[1].length + 1, 6);
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = row(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) {
            if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
              items[items.length - 1] += '\n' + lines[i].trim();
              i++;
              continue;
            }
            break;
          }
          const indent = m[1].length;
          let content = m[3];
          if (indent >= 2 && items.length) {
            items[items.length - 1] += `\n${m[2]} ${content}`;
          } else {
            const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
            if (task) content = `<span class="task ${task[1] === ' ' ? '' : 'done'}"></span>${task[2]}`;
            items.push(content);
          }
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(
          `<${tag}>${items
            .map((it) => {
              const [first, ...rest] = it.split('\n');
              const head = first.startsWith('<span class="task') ? first.replace(/^(<span[^>]*><\/span>)(.*)$/, (_, s, t) => s + inline(t)) : inline(first);
              return `<li>${head}${rest.length ? render(rest.join('\n')) : ''}</li>`;
            })
            .join('')}</${tag}>`,
        );
        continue;
      }
      para.push(line);
      i++;
    }
    flushPara();
    return out.join('\n');
  }

  window.LA = window.LA || {};
  window.LA.markdown = render;
  window.LA.escapeHtml = escapeHtml;
  window.LA.highlight = highlight;
})();
